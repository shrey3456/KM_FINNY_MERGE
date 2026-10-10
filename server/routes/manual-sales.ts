import { Router, Request, Response } from 'express';
import { storage } from '../storage';
import { pool } from '../db';
import { requireAdminRole } from '../lib/pageAccess';
import { ensureManualSalesTables } from '../lib/manualSalesSchema';
import { getPooledStock, debitStatePool, creditStatePool, type StockPullContribution } from '../lib/statePool';

// Settings > Data Management > "Manual Sales" — a day's sales for dates that have no Load Operation. A CSV
// (Barcode, Item Name, Quantity, mapped in the dialog) is uploaded for ONE sale date and ONE plant. Stock is
// taken from the plant's whole STATE pool exactly like a Loading scan (own plant first, then the others),
// each take is kept per plant (manual_sale_pulls) so a reversal gives it back where it came from, and the
// sale is dated sale_date in Stock Overview's Sale column (see sale_rows in scan-sessions.ts).
//
// A row is matched on its BARCODE; the name is the check. Same barcode + same name = fine. Same barcode but a
// different name = "name differs": nothing is applied until the person confirms the popup. A barcode that is
// not in the Product Master is skipped (with the product that has that exact name suggested, if there is one),
// and so is a row the pool cannot cover.
const router = Router();
// Every manual-sales route makes sure its tables exist first (see server/lib/manualSalesSchema.ts).
router.use('/manual-sales', async (_req, res, next) => {
  try { await ensureManualSalesTables(); next(); } catch (e) { console.error('[Manual Sales] tables unavailable:', e); res.status(500).json({ message: 'Manual Sales is not available — its tables could not be created.' }); }
});

function actor(req: Request): { userCode?: string; userName?: string } {
  const u = req.user as any;
  return { userCode: u?.userCode, userName: u?.name || u?.username || u?.userCode };
}

type InRow = { barcode?: string; itemName?: string | null; quantity?: number };
type RowStatus = 'ok' | 'name_differs' | 'not_found' | 'bad_qty' | 'short';
type Evaluated = {
  barcode: string;            // as in the CSV
  canonicalBarcode: string | null; // as in the Product Master
  productId: number | null;
  csvName: string | null;
  masterName: string | null;
  qty: number;
  status: RowStatus;
  available: number | null;
  suggestion: { barcode: string; name: string } | null;
};

const normName = (s: string | null | undefined) => String(s ?? '').toLowerCase().replace(/[^a-z0-9]/g, '');

async function evaluate(plant: string, items: InRow[]): Promise<Evaluated[]> {
  // The same barcode on several CSV lines is one sale of the summed quantity.
  const merged = new Map<string, { barcode: string; csvName: string | null; qty: number }>();
  for (const it of items) {
    const barcode = String(it.barcode ?? '').trim();
    if (!barcode) continue;
    const key = barcode.toLowerCase();
    const qty = Math.round(Number(it.quantity) || 0);
    const cur = merged.get(key);
    if (cur) { cur.qty += qty; if (!cur.csvName && it.itemName) cur.csvName = String(it.itemName).trim() || null; }
    else merged.set(key, { barcode, csvName: it.itemName ? String(it.itemName).trim() || null : null, qty });
  }

  const { rows: products } = await pool.query(`SELECT id, barcode, name FROM products WHERE barcode IS NOT NULL ORDER BY id`);
  const byBarcode = new Map<string, { id: number; barcode: string; name: string }[]>();
  const byName = new Map<string, { barcode: string; name: string }[]>();
  for (const p of products as any[]) {
    const k = String(p.barcode).trim().toLowerCase();
    if (!byBarcode.has(k)) byBarcode.set(k, []);
    byBarcode.get(k)!.push({ id: p.id, barcode: String(p.barcode).trim(), name: p.name });
    const nk = normName(p.name);
    if (nk) { if (!byName.has(nk)) byName.set(nk, []); byName.get(nk)!.push({ barcode: String(p.barcode).trim(), name: p.name }); }
  }

  const out: Evaluated[] = [];
  for (const [key, m] of merged) {
    const matches = byBarcode.get(key);
    if (!matches || matches.length === 0) {
      const sug = m.csvName ? byName.get(normName(m.csvName)) : undefined;
      out.push({ barcode: m.barcode, canonicalBarcode: null, productId: null, csvName: m.csvName, masterName: null, qty: m.qty, status: 'not_found', available: null, suggestion: sug && sug.length === 1 ? sug[0] : null });
      continue;
    }
    const p = matches[0];
    const nameMatches = !m.csvName || matches.some((x) => normName(x.name) === normName(m.csvName));
    if (m.qty <= 0) {
      out.push({ barcode: m.barcode, canonicalBarcode: p.barcode, productId: p.id, csvName: m.csvName, masterName: p.name, qty: m.qty, status: 'bad_qty', available: null, suggestion: null });
      continue;
    }
    const pooled = await getPooledStock(pool, p.barcode, plant);
    const status: RowStatus = pooled.total < m.qty ? 'short' : nameMatches ? 'ok' : 'name_differs';
    out.push({ barcode: m.barcode, canonicalBarcode: p.barcode, productId: p.id, csvName: m.csvName, masterName: p.name, qty: m.qty, status, available: pooled.total, suggestion: null });
  }
  return out;
}

async function validateCommon(req: Request, res: Response): Promise<{ plant: string; saleDate: string } | null> {
  const plant = String(req.body?.plant ?? '').trim();
  const saleDate = String(req.body?.saleDate ?? '').trim();
  if (!plant) { res.status(400).json({ message: 'Plant is required' }); return null; }
  if (!/^\d{4}-\d{2}-\d{2}$/.test(saleDate)) { res.status(400).json({ message: 'Pick the sale date' }); return null; }
  const { rows } = await pool.query(`SELECT name FROM plants WHERE LOWER(name) = LOWER($1) LIMIT 1`, [plant]);
  if (!rows[0]) { res.status(400).json({ message: `Unknown plant "${plant}"` }); return null; }
  return { plant: rows[0].name, saleDate };
}

const countOf = (rows: Evaluated[]) => ({
  ok: rows.filter((r) => r.status === 'ok').length,
  nameDiffers: rows.filter((r) => r.status === 'name_differs').length,
  notFound: rows.filter((r) => r.status === 'not_found').length,
  short: rows.filter((r) => r.status === 'short').length,
  badQty: rows.filter((r) => r.status === 'bad_qty').length,
});

// POST /api/manual-sales/preview — body { plant, saleDate, items } — every row's status, nothing is changed.
router.post('/manual-sales/preview', requireAdminRole, async (req: Request, res: Response) => {
  try {
    const common = await validateCommon(req, res);
    if (!common) return;
    const items: InRow[] = Array.isArray(req.body?.items) ? req.body.items : [];
    if (items.length === 0) return res.status(400).json({ message: 'CSV has no rows' });
    const rows = await evaluate(common.plant, items);
    res.json({ rows, counts: countOf(rows), totalQty: rows.filter((r) => r.status === 'ok' || r.status === 'name_differs').reduce((s, r) => s + r.qty, 0) });
  } catch (error) {
    console.error('Error previewing manual sales:', error);
    res.status(500).json({ message: 'Failed to preview manual sales' });
  }
});

// POST /api/manual-sales/apply — body { plant, saleDate, csvFileName, items, confirmNameDiffers }
router.post('/manual-sales/apply', requireAdminRole, async (req: Request, res: Response) => {
  const common = await validateCommon(req, res);
  if (!common) return;
  const items: InRow[] = Array.isArray(req.body?.items) ? req.body.items : [];
  if (items.length === 0) return res.status(400).json({ message: 'CSV has no rows' });
  const csvFileName = String(req.body?.csvFileName ?? '').trim() || null;
  const { userCode, userName } = actor(req);

  const evaluated = await evaluate(common.plant, items);
  const counts = countOf(evaluated);
  if (counts.nameDiffers > 0 && req.body?.confirmNameDiffers !== true) {
    return res.status(409).json({ needsConfirm: true, message: `${counts.nameDiffers} row(s) have a different name than the Product Master — confirm to add them by barcode.`, counts });
  }
  const applicable = evaluated.filter((r) => r.status === 'ok' || r.status === 'name_differs');
  if (applicable.length === 0) return res.status(400).json({ message: 'Nothing can be added — every row was skipped.', counts });

  // Do not let the same file + date + plant go in twice by accident.
  if (csvFileName && req.body?.allowDuplicate !== true) {
    const dup = await pool.query(
      `SELECT id FROM manual_sale_batches WHERE status = 'active' AND csv_file_name = $1 AND sale_date = $2::date AND LOWER(plant) = LOWER($3) LIMIT 1`,
      [csvFileName, common.saleDate, common.plant],
    );
    if (dup.rows[0]) return res.status(409).json({ duplicate: true, message: `"${csvFileName}" was already added for ${common.saleDate} at ${common.plant} (batch #${dup.rows[0].id}).` });
  }

  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const totalQty = applicable.reduce((s, r) => s + r.qty, 0);
    const { rows: batchRows } = await client.query(
      `INSERT INTO manual_sale_batches (sale_date, plant, csv_file_name, row_count, total_qty, created_by_code, created_by_name)
       VALUES ($1::date, $2, $3, $4, $5, $6, $7) RETURNING id`,
      [common.saleDate, common.plant, csvFileName, applicable.length, totalQty, userCode ?? null, userName ?? null],
    );
    const batchId: number = batchRows[0].id;

    for (const r of applicable) {
      const barcode = r.canonicalBarcode!;
      const contributions = await debitStatePool(client, barcode, common.plant, r.qty, r.productId);
      const { rows: rowIns } = await client.query(
        `INSERT INTO manual_sale_rows (batch_id, barcode, item_name, product_id, qty, name_differs) VALUES ($1,$2,$3,$4,$5,$6) RETURNING id`,
        [batchId, barcode, r.masterName, r.productId, r.qty, r.status === 'name_differs'],
      );
      const rowId: number = rowIns[0].id;
      for (const c of contributions) {
        await client.query(`INSERT INTO manual_sale_pulls (row_id, source_plant, qty) VALUES ($1,$2,$3)`, [rowId, c.plant, c.qty]);
        // Audit trail only — Stock Overview takes Sale from manual_sale_pulls and ignores 'dispatch' ledger rows.
        await client.query(
          `INSERT INTO stock_movements (barcode, product_id, plant, qty, extra_qty, type, reason, created_by_code, source)
           VALUES ($1,$2,$3,$4,0,'dispatch',$5,$6,'manual-sale')`,
          [barcode, r.productId, c.plant, -c.qty,
            c.plant.toLowerCase() === common.plant.toLowerCase()
              ? `Manual sale ${common.saleDate} (${csvFileName ?? 'CSV'})`
              : `Manual sale ${common.saleDate} (${csvFileName ?? 'CSV'}) — pooled from ${c.plant} for ${common.plant}`,
            userCode ?? null],
        );
      }
      await client.query(
        `UPDATE products p SET in_stock = COALESCE((SELECT SUM(pps.in_stock) FROM product_plant_stock pps WHERE LOWER(pps.barcode) = LOWER(p.barcode)), 0) WHERE LOWER(p.barcode) = LOWER($1)`,
        [barcode],
      );
    }
    await client.query('COMMIT');

    try {
      await storage.logActivity({
        pageName: 'Settings', action: 'create', entityType: 'manual_sale_batch', entityId: String(batchId),
        details: `Manual sales added for ${common.saleDate} at ${common.plant} from ${csvFileName ?? 'a CSV'}: ${applicable.length} item(s), ${totalQty} boxes.`,
        userCode, userName,
      });
    } catch { /* the sale matters more than its log line */ }

    res.json({
      success: true, batchId, rowsAdded: applicable.length, totalQty,
      skipped: evaluated.filter((r) => r.status !== 'ok' && r.status !== 'name_differs').map((r) => ({ barcode: r.barcode, status: r.status, name: r.csvName })),
    });
  } catch (error: any) {
    await client.query('ROLLBACK').catch(() => {});
    console.error('Error adding manual sales:', error);
    res.status(error?.status ?? 500).json({ message: error?.message || 'Failed to add manual sales — nothing was changed.' });
  } finally {
    client.release();
  }
});

// GET /api/manual-sales/batches — recent batches, newest first.
router.get('/manual-sales/batches', requireAdminRole, async (_req: Request, res: Response) => {
  try {
    const { rows } = await pool.query(
      `SELECT id, sale_date::text AS "saleDate", plant, csv_file_name AS "csvFileName", row_count AS "rowCount", total_qty AS "totalQty",
              status, created_by_name AS "createdByName", created_by_code AS "createdByCode", created_at AS "createdAt", reversed_at AS "reversedAt"
         FROM manual_sale_batches ORDER BY id DESC LIMIT 50`,
    );
    res.json({ batches: rows });
  } catch (error) {
    console.error('Error listing manual sale batches:', error);
    res.status(500).json({ message: 'Failed to load manual sale batches' });
  }
});

// POST /api/manual-sales/batches/:id/reverse — gives every box back to the plant it came from and takes the
// batch out of Sale. The batch stays in the list as "reversed".
router.post('/manual-sales/batches/:id/reverse', requireAdminRole, async (req: Request, res: Response) => {
  const id = Number(req.params.id);
  if (!Number.isInteger(id)) return res.status(400).json({ message: 'Bad batch id' });
  const { userCode, userName } = actor(req);
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const { rows: b } = await client.query(`SELECT * FROM manual_sale_batches WHERE id = $1 FOR UPDATE`, [id]);
    if (!b[0]) { await client.query('ROLLBACK'); return res.status(404).json({ message: 'Batch not found' }); }
    if (b[0].status !== 'active') { await client.query('ROLLBACK'); return res.status(409).json({ message: 'This batch was already reversed.' }); }
    const { rows: rows } = await client.query(`SELECT id, barcode, product_id FROM manual_sale_rows WHERE batch_id = $1`, [id]);
    for (const r of rows) {
      const { rows: pulls } = await client.query(`SELECT source_plant AS plant, qty FROM manual_sale_pulls WHERE row_id = $1`, [r.id]);
      const contributions = pulls as StockPullContribution[];
      await creditStatePool(client, r.barcode, contributions);
      for (const c of contributions) {
        await client.query(
          `INSERT INTO stock_movements (barcode, product_id, plant, qty, extra_qty, type, reason, created_by_code, source)
           VALUES ($1,$2,$3,$4,0,'dispatch',$5,$6,'manual-sale')`,
          [r.barcode, r.product_id, c.plant, c.qty, `Manual sale batch #${id} reversed`, userCode ?? null],
        );
      }
      await client.query(
        `UPDATE products p SET in_stock = COALESCE((SELECT SUM(pps.in_stock) FROM product_plant_stock pps WHERE LOWER(pps.barcode) = LOWER(p.barcode)), 0) WHERE LOWER(p.barcode) = LOWER($1)`,
        [r.barcode],
      );
    }
    await client.query(`UPDATE manual_sale_batches SET status = 'reversed', reversed_at = NOW(), reversed_by_code = $2 WHERE id = $1`, [id, userCode ?? null]);
    await client.query('COMMIT');
    try {
      await storage.logActivity({
        pageName: 'Settings', action: 'delete', entityType: 'manual_sale_batch', entityId: String(id),
        details: `Manual sale batch #${id} (${b[0].csv_file_name ?? 'CSV'}, ${b[0].sale_date}) reversed — ${b[0].total_qty} boxes returned to stock.`,
        userCode, userName,
      });
    } catch { /* ignore */ }
    res.json({ success: true });
  } catch (error) {
    await client.query('ROLLBACK').catch(() => {});
    console.error('Error reversing manual sale batch:', error);
    res.status(500).json({ message: 'Failed to reverse the batch — nothing was changed.' });
  } finally {
    client.release();
  }
});

export default router;
