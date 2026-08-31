import { Router, Request, Response } from 'express';
import { storage } from '../storage';
import { pool } from '../db';
import { requireAdminRole } from '../lib/pageAccess';
import { reconcileProductPlantStockBarcode } from '../lib/stockBarcodeReconcile';

// Settings > Data Management > "Opening Stock" — bulk-SETS (not adds) a plant's baseline stock
// from a CSV, for seeding real-world physical counts into the system. Distinct from every other
// stock-affecting feature in the app (Order Scan/Unloading ADD via scan events, Loading
// SUBTRACTS via scan events, Clear Stock ZEROES) — this one directly overwrites
// product_plant_stock.in_stock to whatever the CSV says, since "opening stock" is a baseline
// snapshot, not an incremental event. Still fully audited: one stock_movements 'adjust' row per
// barcode capturing the delta from whatever was there before, same ledger convention as
// everywhere else. Admin-only, same severity class as Clear Stock.
const router = Router();

function actor(req: Request): { userCode?: string; userName?: string } {
  const u = req.user as any;
  return { userCode: u?.userCode, userName: u?.name || u?.username || u?.userCode };
}

type OpeningStockRow = { barcode?: string; itemName?: string; quantity?: number };

function normalizeRows(items: OpeningStockRow[]) {
  return items
    .map((it) => ({ barcode: (it.barcode ?? '').trim(), quantity: Math.max(0, Math.round(Number(it.quantity) || 0)) }))
    .filter((it) => it.barcode);
}

// POST /api/opening-stock/preview — body: { plant, items } — impact counts for the confirm dialog.
router.post('/opening-stock/preview', requireAdminRole, async (req: Request, res: Response) => {
  try {
    const { plant, items } = req.body as { plant: string; items: OpeningStockRow[] };
    if (!plant || !String(plant).trim()) return res.status(400).json({ message: 'Plant is required' });
    if (!Array.isArray(items) || items.length === 0) return res.status(400).json({ message: 'CSV has no rows' });

    const rows = normalizeRows(items);
    if (rows.length === 0) return res.status(400).json({ message: 'No valid barcodes in this CSV' });

    const barcodes = [...new Set(rows.map((r) => r.barcode))];
    const { rows: existingRows } = await pool.query(
      `SELECT barcode, in_stock FROM product_plant_stock WHERE plant = $1 AND barcode = ANY($2::text[])`,
      [plant, barcodes],
    );
    const existingByBarcode = new Map<string, number>(existingRows.map((r: any) => [r.barcode, Number(r.in_stock ?? 0)]));
    const barcodesWithExistingStock = barcodes.filter((b) => (existingByBarcode.get(b) ?? 0) > 0).length;

    res.json({
      totalRows: rows.length,
      distinctBarcodes: barcodes.length,
      barcodesWithExistingStock,
      totalQtyToSet: rows.reduce((s, r) => s + r.quantity, 0),
    });
  } catch (error) {
    console.error('Error building opening-stock preview:', error);
    res.status(500).json({ message: 'Failed to load preview' });
  }
});

// POST /api/opening-stock/import — body: { plant, items } — commits the overwrite.
router.post('/opening-stock/import', requireAdminRole, async (req: Request, res: Response) => {
  const { plant, items } = req.body as { plant: string; items: OpeningStockRow[] };
  if (!plant || !String(plant).trim()) return res.status(400).json({ message: 'Plant is required' });
  if (!Array.isArray(items) || items.length === 0) return res.status(400).json({ message: 'CSV has no rows' });

  const rows = normalizeRows(items);
  if (rows.length === 0) return res.status(400).json({ message: 'No valid barcodes in this CSV' });

  const { userCode, userName } = actor(req);
  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    let rowsSet = 0;
    for (const row of rows) {
      const product = await storage.getProductByBarcode(row.barcode);
      // Fold any stock still parked under a stale (old) barcode for this product into the
      // current one first — otherwise it's left behind as an orphaned phantom row once this
      // import overwrites the current barcode's own value. See stockBarcodeReconcile.ts.
      await reconcileProductPlantStockBarcode(client, product?.id, plant, row.barcode);
      const { rows: existingRows } = await client.query(
        `SELECT in_stock FROM product_plant_stock WHERE barcode = $1 AND plant = $2 FOR UPDATE`,
        [row.barcode, plant],
      );
      const previousQty = Number(existingRows[0]?.in_stock ?? 0);
      const delta = row.quantity - previousQty;

      await client.query(
        `INSERT INTO product_plant_stock (barcode, product_id, plant, in_stock, extra_qty)
         VALUES ($1,$2,$3,$4,0)
         ON CONFLICT (barcode, plant) DO UPDATE
           SET in_stock = $4, product_id = COALESCE(product_plant_stock.product_id, $2), updated_at = NOW()`,
        [row.barcode, product?.id ?? null, plant, row.quantity],
      );
      if (delta !== 0) {
        await client.query(
          `INSERT INTO stock_movements (barcode, product_id, plant, qty, extra_qty, type, reason, created_by_code)
           VALUES ($1,$2,$3,$4,0,'adjust',$5,$6)`,
          [row.barcode, product?.id ?? null, plant, delta, 'Opening stock import (Settings)', userCode ?? null],
        );
      }
      rowsSet++;
    }

    // Recompute the legacy cross-plant mirror, same convention as Clear Stock.
    await client.query(
      `UPDATE products p
       SET in_stock = COALESCE((SELECT SUM(pps.in_stock) FROM product_plant_stock pps WHERE pps.barcode = p.barcode), 0)
       WHERE EXISTS (SELECT 1 FROM product_plant_stock pps WHERE pps.barcode = p.barcode)`,
    );

    await client.query('COMMIT');

    if (userCode) {
      await storage.logActivity({
        pageName: 'Settings', action: 'create', entityType: 'opening_stock', entityId: plant,
        details: `Opening stock imported for ${plant} by ${userName ?? userCode} — ${rowsSet} barcode(s) set.`,
        userCode, userName,
      });
    }

    res.json({ success: true, rowsSet });
  } catch (error) {
    await client.query('ROLLBACK');
    console.error('Error importing opening stock:', error);
    res.status(500).json({ message: 'Failed to import opening stock' });
  } finally {
    client.release();
  }
});

export default router;
