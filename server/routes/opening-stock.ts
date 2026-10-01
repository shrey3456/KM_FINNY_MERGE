import { Router, Request, Response } from 'express';
import { storage } from '../storage';
import { pool } from '../db';
import { requireAdminRole } from '../lib/pageAccess';
import { reconcileProductPlantStockBarcode } from '../lib/stockBarcodeReconcile';

// Settings > Data Management > "Opening Stock" — ADDS each barcode's quantity onto the plant's
// CURRENT stock (product_plant_stock.in_stock), exactly like a real receipt would, but tagged so
// Stock Overview's own ledger (server/routes/scan-sessions.ts) attributes it to Opening Stock
// instead of Purchase. This is additive, never an absolute override — re-importing adds MORE on
// top of whatever's already there, it never resets a barcode to a fixed number (Order Scan/
// Unloading add via scan events the exact same way; Clear Stock, which zeroes everything, is the
// one actually-destructive action in this group). Dated "as of" whichever day was actually
// counted (defaults to today) — each stock_movements row (origin='opening') is dated the day
// BEFORE that pick (see dayBefore below), the same way a plain accounting Opening Balance works,
// so the report picks it up as Opening for any period starting on or after that date. Admin-only,
// same severity class as Clear Stock.
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

function todayDateStr(): string {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

// "Opening Stock as of 1 Oct" means the count going INTO 1 Oct — the same thing a plain
// accounting Opening Balance means — so it needs to land in the ledger one day EARLIER than the
// date picked, exactly like Closing(30 Sep) = Opening(1 Oct). Stock Overview's own period math
// (server/routes/scan-sessions.ts) treats anything dated strictly before a viewed period's start
// as Opening — this is what makes a report whose period STARTS on 1 Oct actually pick this
// figure up as Opening, instead of as a same-day Adjust.
function dayBefore(dateStr: string): string {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(dateStr);
  if (!m) return dateStr;
  const d = new Date(Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3])));
  d.setUTCDate(d.getUTCDate() - 1);
  return d.toISOString().slice(0, 10);
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

// POST /api/opening-stock/import — body: { plant, items, asOfDate } — commits the addition.
// asOfDate ("YYYY-MM-DD", defaults to today) is the date this physical count was taken ON — the
// stock going INTO that date, same meaning as a plain accounting Opening Balance.
router.post('/opening-stock/import', requireAdminRole, async (req: Request, res: Response) => {
  const { plant, items, asOfDate: asOfDateRaw } = req.body as { plant: string; items: OpeningStockRow[]; asOfDate?: string };
  if (!plant || !String(plant).trim()) return res.status(400).json({ message: 'Plant is required' });
  if (!Array.isArray(items) || items.length === 0) return res.status(400).json({ message: 'CSV has no rows' });
  const asOfDate = typeof asOfDateRaw === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(asOfDateRaw) ? asOfDateRaw : todayDateStr();
  const effectiveDate = dayBefore(asOfDate);

  const rows = normalizeRows(items);
  if (rows.length === 0) return res.status(400).json({ message: 'No valid barcodes in this CSV' });

  const { userCode, userName } = actor(req);
  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    let rowsSet = 0;
    for (const row of rows) {
      const product = await storage.getProductByBarcode(row.barcode, plant);
      // Fold any stock still parked under a stale (old) barcode for this product into the
      // current one first — otherwise an addition below would land on the old barcode's row
      // while everything else already reads the new one. See stockBarcodeReconcile.ts.
      await reconcileProductPlantStockBarcode(client, product?.id, plant, row.barcode);

      // Additive — same as a real receipt (Order Scan/Unloading): ADDS row.quantity onto
      // whatever is already here, never resets it to an absolute number.
      await client.query(
        `INSERT INTO product_plant_stock (barcode, product_id, plant, in_stock, extra_qty)
         VALUES ($1,$2,$3,$4,0)
         ON CONFLICT (barcode, plant) DO UPDATE
           SET in_stock = product_plant_stock.in_stock + $4,
               product_id = COALESCE(product_plant_stock.product_id, $2), updated_at = NOW()`,
        [row.barcode, product?.id ?? null, plant, row.quantity],
      );
      // Same addition, recorded on the ledger — origin='opening', qty is a plain additive delta
      // like every other stock_movements row, dated effectiveDate so Stock Overview's period
      // math attributes it to Opening Stock instead of Purchase/Adjust.
      await client.query(
        `INSERT INTO stock_movements (barcode, product_id, plant, qty, extra_qty, type, reason, created_by_code, origin, created_at)
         VALUES ($1,$2,$3,$4,0,'adjust',$5,$6,'opening',$7::date)`,
        [row.barcode, product?.id ?? null, plant, row.quantity, 'Opening stock import (Settings)', userCode ?? null, effectiveDate],
      );
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
        details: `Opening stock added for ${plant} by ${userName ?? userCode} — ${rowsSet} barcode(s), as of ${asOfDate}.`,
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
