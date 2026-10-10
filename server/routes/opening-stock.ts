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
  const { plant, items, asOfDate: asOfDateRaw, mode: modeRaw } = req.body as { plant: string; items: OpeningStockRow[]; asOfDate?: string; mode?: string };
  // 'add' (the default, as always): the CSV's quantities are added on top. 'set': each item's opening for this date becomes the
  // CSV's quantity — re-importing a corrected file replaces what an earlier import wrote instead of adding to it.
  const mode: 'add' | 'set' = modeRaw === 'set' ? 'set' : 'add';
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
      if (mode === 'set') {
        const cur = await currentOpening(client, plant, row.barcode, effectiveDate);
        const delta = row.quantity - cur;
        if (delta !== 0) {
          await applyOpeningDelta(client, { plant, barcode: row.barcode, productId: product?.id ?? null, delta, ledgerDate: effectiveDate, reason: `Opening stock import (Settings) — set to ${row.quantity} (was ${cur})`, userCode });
        }
        rowsSet++;
        continue;
      }
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
        details: `Opening stock ${mode === 'set' ? 'set' : 'added'} for ${plant} by ${userName ?? userCode} — ${rowsSet} barcode(s), as of ${asOfDate}.`,
        userCode, userName,
      });
    }

    res.json({ success: true, rowsSet });
  } catch (error) {
    await client.query('ROLLBACK');
    if ((error as any)?.status) return res.status((error as any).status).json({ message: (error as any).message });
    console.error('Error importing opening stock:', error);
    res.status(500).json({ message: 'Failed to import opening stock' });
  } finally {
    client.release();
  }
});

// ── Editing what an Opening Stock import wrote ────────────────────────────────────────────────────────────────
// An import adds ledger rows (origin = 'opening', dated the day BEFORE the "as of" date) and adds the same boxes to the
// live stock. The editor below changes the opening quantity of one item at one plant for one "as of" date: it works
// out the difference to what the ledger already holds for that date and writes ONE correcting row for it (the ledger
// stays append-only, so the history of edits is kept), and moves the live stock by the same difference. Live stock
// is never taken below zero by an edit. Stock Overview reads Opening from these rows, so it follows at once.
type Q = { query: (sql: string, params?: any[]) => Promise<{ rows: any[]; rowCount: number | null }> };

function dayAfter(dateStr: string): string {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(dateStr);
  if (!m) return dateStr;
  const d = new Date(Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3])));
  d.setUTCDate(d.getUTCDate() + 1);
  return d.toISOString().slice(0, 10);
}

// What the ledger currently holds as Opening for this item + plant + ledger date.
async function currentOpening(q: Q, plant: string, barcode: string, ledgerDate: string): Promise<number> {
  const { rows } = await q.query(
    `SELECT COALESCE(SUM(qty), 0)::int AS qty FROM stock_movements
      WHERE origin = 'opening' AND LOWER(TRIM(plant)) = LOWER(TRIM($1)) AND LOWER(TRIM(barcode)) = LOWER(TRIM($2)) AND created_at::date = $3::date`,
    [plant, barcode, ledgerDate],
  );
  return Number(rows[0]?.qty ?? 0);
}

// Moves the opening of one item by `delta`: the live stock and one ledger row. Refuses to take live stock below zero.
async function applyOpeningDelta(
  client: Q,
  p: { plant: string; barcode: string; productId: number | null; delta: number; ledgerDate: string; reason: string; userCode?: string },
): Promise<void> {
  await reconcileProductPlantStockBarcode(client as any, p.productId, p.plant, p.barcode);
  const { rows: live } = await client.query(
    `SELECT in_stock FROM product_plant_stock WHERE LOWER(TRIM(barcode)) = LOWER(TRIM($1)) AND LOWER(TRIM(plant)) = LOWER(TRIM($2)) FOR UPDATE`,
    [p.barcode, p.plant],
  );
  const inStock = Number(live[0]?.in_stock ?? 0);
  if (inStock + p.delta < 0) {
    throw Object.assign(
      new Error(`Live stock of ${p.barcode} at ${p.plant} is ${inStock}. Lowering the opening by ${-p.delta} would take it below zero — change the opening to at least ${(await currentOpening(client, p.plant, p.barcode, p.ledgerDate)) - inStock}.`),
      { status: 409 },
    );
  }
  await client.query(
    `INSERT INTO product_plant_stock (barcode, product_id, plant, in_stock, extra_qty)
     VALUES ($1,$2,$3,$4,0)
     ON CONFLICT (barcode, plant) DO UPDATE
       SET in_stock = product_plant_stock.in_stock + $4, product_id = COALESCE(product_plant_stock.product_id, $2), updated_at = NOW()`,
    [p.barcode, p.productId, p.plant, p.delta],
  );
  await client.query(
    `INSERT INTO stock_movements (barcode, product_id, plant, qty, extra_qty, type, reason, created_by_code, origin, created_at)
     VALUES ($1,$2,$3,$4,0,'adjust',$5,$6,'opening',$7::date)`,
    [p.barcode, p.productId, p.plant, p.delta, p.reason, p.userCode ?? null, p.ledgerDate],
  );
  await client.query(
    `UPDATE products pr SET in_stock = COALESCE((SELECT SUM(pps.in_stock) FROM product_plant_stock pps WHERE LOWER(pps.barcode) = LOWER(pr.barcode)), 0) WHERE LOWER(pr.barcode) = LOWER($1)`,
    [p.barcode],
  );
}

// GET /api/opening-stock/entries?plant=&asOf=&search= — one line per item + plant + "as of" date that has opening stock.
router.get('/opening-stock/entries', requireAdminRole, async (req: Request, res: Response) => {
  try {
    const plant = typeof req.query.plant === 'string' ? req.query.plant.trim() : '';
    const asOf = typeof req.query.asOf === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(req.query.asOf) ? req.query.asOf : '';
    const search = typeof req.query.search === 'string' ? req.query.search.trim().toLowerCase() : '';
    const params: any[] = [];
    const where: string[] = [`sm.origin = 'opening'`];
    if (plant) { params.push(plant); where.push(`LOWER(TRIM(sm.plant)) = LOWER(TRIM($${params.length}))`); }
    if (asOf) { params.push(asOf); where.push(`sm.created_at::date = ($${params.length}::date - 1)`); }
    const { rows } = await pool.query(
      `SELECT MIN(sm.plant) AS plant, MIN(sm.barcode) AS barcode, sm.created_at::date::text AS "ledgerDate", SUM(sm.qty)::int AS qty, COUNT(*)::int AS entries,
              (SELECT pr.name FROM products pr WHERE LOWER(TRIM(pr.barcode)) = LOWER(TRIM(MIN(sm.barcode))) ORDER BY pr.id LIMIT 1) AS "itemName",
              (SELECT COALESCE(SUM(pps.in_stock), 0)::int FROM product_plant_stock pps WHERE LOWER(TRIM(pps.barcode)) = LOWER(TRIM(MIN(sm.barcode))) AND LOWER(TRIM(pps.plant)) = LOWER(TRIM(MIN(sm.plant)))) AS "liveStock"
         FROM stock_movements sm
        WHERE ${where.join(' AND ')}
        GROUP BY LOWER(TRIM(sm.plant)), LOWER(TRIM(sm.barcode)), sm.created_at::date
        ORDER BY sm.created_at::date DESC, MIN(sm.plant), MIN(sm.barcode)`,
      params,
    );
    const items = rows
      .map((r: any) => ({ ...r, asOfDate: dayAfter(r.ledgerDate) }))
      .filter((r: any) => !search || String(r.barcode).toLowerCase().includes(search) || String(r.itemName ?? '').toLowerCase().includes(search));
    const dates = Array.from(new Set(rows.map((r: any) => dayAfter(r.ledgerDate)))).sort().reverse();
    const plants = Array.from(new Set(rows.map((r: any) => String(r.plant)))).sort();
    res.json({ items: items.slice(0, 600), total: items.length, dates, plants, sumQty: items.reduce((a: number, r: any) => a + Number(r.qty), 0) });
  } catch (error) {
    console.error('Error listing opening stock entries:', error);
    res.status(500).json({ message: 'Failed to load the opening stock' });
  }
});

// POST /api/opening-stock/entry — body { plant, barcode, asOfDate, quantity } — sets this item's opening for that date to
// `quantity` (also adds an item that has none yet). Quantity 0 takes the item's opening out.
router.post('/opening-stock/entry', requireAdminRole, async (req: Request, res: Response) => {
  const plantIn = String(req.body?.plant ?? '').trim();
  const barcode = String(req.body?.barcode ?? '').trim();
  const asOfDate = String(req.body?.asOfDate ?? '').trim();
  const quantity = Math.round(Number(req.body?.quantity));
  if (!plantIn || !barcode) return res.status(400).json({ message: 'Plant and barcode are required' });
  if (!/^\d{4}-\d{2}-\d{2}$/.test(asOfDate)) return res.status(400).json({ message: 'Pick the "as of" date' });
  if (!Number.isFinite(quantity) || quantity < 0) return res.status(400).json({ message: 'Quantity must be 0 or more' });
  const { userCode, userName } = actor(req);

  const { rows: plantRows } = await pool.query(`SELECT name FROM plants WHERE LOWER(name) = LOWER($1) LIMIT 1`, [plantIn]);
  if (!plantRows[0]) return res.status(400).json({ message: `Unknown plant "${plantIn}"` });
  const plant: string = plantRows[0].name;
  const product = await storage.getProductByBarcode(barcode, plant);
  if (!product) return res.status(400).json({ message: `Barcode ${barcode} is not in the Product Master` });

  const ledgerDate = dayBefore(asOfDate);
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const current = await currentOpening(client, plant, product.barcode ?? barcode, ledgerDate);
    const delta = quantity - current;
    if (delta !== 0) {
      await applyOpeningDelta(client, {
        plant, barcode: product.barcode ?? barcode, productId: product.id, delta, ledgerDate,
        reason: `Opening stock edited (Settings): ${current} -> ${quantity}`, userCode,
      });
    }
    await client.query('COMMIT');
    if (userCode && delta !== 0) {
      await storage.logActivity({
        pageName: 'Settings', action: 'update', entityType: 'opening_stock', entityId: `${product.barcode ?? barcode}@${plant}`,
        details: `Opening stock of ${product.barcode ?? barcode} at ${plant} (as of ${asOfDate}) changed from ${current} to ${quantity} by ${userName ?? userCode}.`,
        userCode, userName,
      });
    }
    res.json({ success: true, previous: current, quantity, delta });
  } catch (error: any) {
    await client.query('ROLLBACK').catch(() => {});
    if (error?.status) return res.status(error.status).json({ message: error.message });
    console.error('Error editing opening stock:', error);
    res.status(500).json({ message: 'Failed to change the opening stock — nothing was changed.' });
  } finally {
    client.release();
  }
});

export default router;
