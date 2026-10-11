import { Router, Request, Response } from 'express';
import type { Pool, PoolClient } from 'pg';
import { storage } from '../storage';
import { pool } from '../db';
import { requireAdminRole } from '../lib/pageAccess';
import { ensureStockResetTables } from '../lib/stockResetSchema';
import { ensureManualSalesTables } from '../lib/manualSalesSchema';

// Settings > Data Management > "Reset Stock to Count" (the fresh start).
//
// One step does what Clear Stock + Opening Stock import did, and keeps whatever was already scanned on or after the start
// day. For one plant, from the counted stock of the end of the day BEFORE "as of":
//     live stock  =  counted stock  +  purchases on/after as-of  -  sales on/after as-of
// (purchases and sales dated exactly as Stock Overview dates them, so the report's Closing equals the live stock). An item that
// is not in the count starts at 0. The count is saved as the opening-stock ledger line (origin 'opening', dated the day before
// as-of); the change to the live number is saved as a Clear-Stock-style "System" line, which the report leaves out. Every item's
// stock before and after is kept in stock_reset_rows, so the run can be undone and the old numbers are a backup.
// Optionally sets Settings > Stock Tracking Start to the as-of day, from which Stock Overview counts.
const router = Router();
router.use('/stock-reset', async (_req, res, next) => {
  try { await ensureStockResetTables(); await ensureManualSalesTables(); next(); }
  catch (e) { console.error('[Stock reset] tables unavailable:', e); res.status(500).json({ message: 'This tool is not available — its tables could not be created.' }); }
});

type Db = Pool | PoolClient;
const actor = (req: Request) => { const u = req.user as any; return { userCode: u?.userCode as string | undefined, userName: (u?.name || u?.username || u?.userCode) as string | undefined }; };
const isDate = (s: unknown): s is string => typeof s === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(s);
const low = (s: unknown) => String(s ?? '').trim().toLowerCase();
const todayStr = () => { const d = new Date(); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`; };
const dayBefore = (d: string) => { const [y, m, dd] = d.split('-').map(Number); const x = new Date(Date.UTC(y, m - 1, dd)); x.setUTCDate(x.getUTCDate() - 1); return x.toISOString().slice(0, 10); };

type CountItem = { barcode?: string; quantity?: number };
type PlanRow = { barcode: string; productId: number | null; name: string | null; count: number; liveBefore: number; extraBefore: number; since: number; target: number; extraTarget: number };

async function computePlan(db: Db, plant: string, asOf: string, items: CountItem[], lock: boolean, keepSince = true) {
  // the count, per product (duplicate barcodes in the file add up)
  const { rows: prods } = await db.query(`SELECT id, TRIM(barcode) AS barcode, name FROM products WHERE barcode IS NOT NULL AND TRIM(barcode) <> '' ORDER BY id`);
  const prodByBarcode = new Map<string, { id: number; barcode: string; name: string | null }>();
  for (const p of prods as any[]) if (!prodByBarcode.has(low(p.barcode))) prodByBarcode.set(low(p.barcode), p);
  const count = new Map<string, number>(); const unknown: { barcode: string; quantity: number }[] = [];
  for (const it of items) {
    const raw = String(it.barcode ?? '').trim(); const q = Math.max(0, Math.round(Number(it.quantity) || 0));
    if (!raw) continue;
    const p = prodByBarcode.get(low(raw));
    if (!p) { unknown.push({ barcode: raw, quantity: q }); continue; }
    count.set(low(p.barcode), (count.get(low(p.barcode)) ?? 0) + q);
  }

  const { rows: live } = await db.query(
    `SELECT barcode, product_id, plant, in_stock, extra_qty FROM product_plant_stock WHERE LOWER(TRIM(plant)) = LOWER(TRIM($1)) ${lock ? 'FOR UPDATE' : ''}`, [plant]);
  const liveBy = new Map<string, any>(); for (const r of live as any[]) liveBy.set(low(r.barcode), r);
  const plantName = (live as any[])[0]?.plant ?? plant;

  // what was already done on/after the as-of day, dated the way Stock Overview dates it
  const { rows: pur } = await db.query(
    `SELECT LOWER(TRIM(sm.barcode)) AS b, SUM(sm.qty)::int AS q, COALESCE(SUM(sm.extra_qty),0)::int AS x
       FROM stock_movements sm
       LEFT JOIN order_import_sessions ois ON sm.source IS DISTINCT FROM 'unloading' AND ois.id = sm.session_id
      WHERE sm.source IS DISTINCT FROM 'loading' AND sm.type <> 'dispatch' AND COALESCE(sm.origin,'') NOT IN ('settings','opening')
        AND LOWER(TRIM(sm.plant)) = LOWER(TRIM($1))
        AND COALESCE(sm.effective_date, CASE WHEN sm.source = 'unloading' THEN sm.created_at::date ELSE COALESCE(ois.order_date::date, sm.created_at::date) END) >= $2::date
        AND ($3::boolean OR sm.type = 'receive' OR sm.origin = 'void')
      GROUP BY 1`, [plant, asOf, keepSince]);
  const { rows: sal } = await db.query(
    `SELECT LOWER(TRIM(x.barcode)) AS b, SUM(x.q)::int AS q FROM (
        SELECT lse.barcode, COALESCE(sp.source_plant, lse.plant) AS plant, COALESCE(sp.qty, lse.total_qty) AS q, COALESCE(ps.order_date::date, lse.scanned_at::date) AS d
          FROM loading_scan_events lse
          LEFT JOIN proforma_slips ps ON ps.order_number = lse.order_number
          LEFT JOIN loading_stock_pulls sp ON sp.loading_scan_event_id = lse.id
         WHERE lse.voided IS NOT TRUE AND lse.barcode IS NOT NULL AND lse.plant IS NOT NULL
        UNION ALL
        SELECT mr.barcode, mp.source_plant, mp.qty, mb.sale_date
          FROM manual_sale_pulls mp JOIN manual_sale_rows mr ON mr.id = mp.row_id JOIN manual_sale_batches mb ON mb.id = mr.batch_id WHERE mb.status = 'active'
      ) x WHERE LOWER(TRIM(x.plant)) = LOWER(TRIM($1)) AND x.d >= $2::date GROUP BY 1`, [plant, asOf]);
  const purBy = new Map<string, { q: number; x: number }>(); for (const r of pur as any[]) purBy.set(r.b, { q: Number(r.q), x: Number(r.x) });
  const salBy = new Map<string, number>(); for (const r of sal as any[]) salBy.set(r.b, Number(r.q));

  const keys = new Set<string>([...count.keys(), ...liveBy.keys(), ...purBy.keys(), ...salBy.keys()]);
  const rows: PlanRow[] = [];
  for (const k of keys) {
    const lr = liveBy.get(k); const prod = prodByBarcode.get(k);
    const c = count.get(k) ?? 0; const p = purBy.get(k); const sold = salBy.get(k) ?? 0;
    const since = (p?.q ?? 0) - sold;
    const target = Math.max(0, c + since);
    const extraTarget = Math.min(target, Math.max(0, p?.x ?? 0));
    const liveBefore = Number(lr?.in_stock ?? 0); const extraBefore = Number(lr?.extra_qty ?? 0);
    if (!lr && c === 0 && target === 0) continue;
    rows.push({ barcode: lr?.barcode ?? prod?.barcode ?? k, productId: lr?.product_id ?? prod?.id ?? null, name: prod?.name ?? null, count: c, liveBefore, extraBefore, since, target, extraTarget });
  }
  rows.sort((a, b) => Math.abs(b.target - b.liveBefore) - Math.abs(a.target - a.liveBefore));

  // things still open that belong to days before the start — they will move stock later without showing in the report
  const { rows: openScan } = await db.query(
    `SELECT COUNT(*)::int AS n FROM order_import_sessions WHERE is_deleted IS NOT TRUE AND scan_status <> 'completed' AND LOWER(TRIM(plant)) = LOWER(TRIM($1)) AND order_date < $2`, [plant, asOf]);
  const { rows: openLoad } = await db.query(
    `SELECT COUNT(*)::int AS n FROM proforma_slips WHERE vehicle_assigned_by_code IS NOT NULL AND loading_completed_at IS NULL AND LOWER(TRIM(plant)) = LOWER(TRIM($1)) AND order_date < $2::date`, [plant, asOf]);
  const { rows: openUnload } = await db.query(
    `SELECT vehicle_number, order_date::text AS d FROM unload_import_sessions WHERE is_deleted IS NOT TRUE AND scan_status <> 'completed' AND LOWER(TRIM(plant)) = LOWER(TRIM($1)) ORDER BY order_date LIMIT 20`, [plant]);

  return {
    plantName, rows, unknown,
    warnings: {
      openOrderScans: Number((openScan as any[])[0]?.n ?? 0),
      openLoadSlips: Number((openLoad as any[])[0]?.n ?? 0),
      openUnloadVehicles: (openUnload as any[]).map((r) => `${r.vehicle_number} (${r.d})`),
      futureDate: asOf > todayStr(),
      salesInScope: 0,
    },
  };
}

const summarise = (plan: Awaited<ReturnType<typeof computePlan>>) => {
  const r = plan.rows;
  return {
    itemsInCount: r.filter((x) => x.count > 0).length,
    countTotal: r.reduce((n, x) => n + x.count, 0),
    liveBefore: r.reduce((n, x) => n + x.liveBefore, 0),
    liveAfter: r.reduce((n, x) => n + x.target, 0),
    toZero: r.filter((x) => x.liveBefore > 0 && x.target === 0).length,
    changed: r.filter((x) => x.target !== x.liveBefore || x.extraTarget !== x.extraBefore).length,
    keptSince: r.reduce((n, x) => n + x.since, 0),
    unknown: plan.unknown.length,
  };
};

// A plant name, or 'all' / '__all__' (zero-only mode) for every plant that has stock or is on the Plant list.
const isAll = (p: string) => ['all', '__all__'].includes(low(p));
async function plantsFor(db: Db, plant: string): Promise<string[]> {
  if (!isAll(plant)) return [plant];
  const { rows } = await db.query(`SELECT TRIM(plant) AS p FROM product_plant_stock WHERE plant IS NOT NULL AND TRIM(plant) <> '' UNION SELECT TRIM(name) FROM plants WHERE name IS NOT NULL AND TRIM(name) <> ''`);
  const seen = new Set<string>(); const out: string[] = [];
  for (const r of rows as any[]) { const k = low(r.p); if (k && !seen.has(k)) { seen.add(k); out.push(r.p); } }
  return out.sort((x, y) => x.localeCompare(y));
}
const zeroOnlyOf = (req: Request) => req.body?.zeroOnly === true;
// Default: the manual adjustments (Adjust column) already made on/after the start day are thrown away; the scans (purchases) and loads of that day stay. Only an explicit keepSince:true keeps the adjustments too.
const keepSinceOf = (req: Request) => req.body?.keepSince === true;

// POST /api/stock-reset/preview — { plant | 'all', asOfDate, zeroOnly?, items?:[{barcode, quantity}] }. Nothing is changed.
// zeroOnly = no count file: every item goes to what was already scanned on/after the day (usually 0); the opening stock is
// imported afterwards with the normal Opening Stock import.
router.post('/stock-reset/preview', requireAdminRole, async (req: Request, res: Response) => {
  try {
    const plant = String(req.body?.plant ?? '').trim(); const asOf = req.body?.asOfDate; const zeroOnly = zeroOnlyOf(req);
    const items: CountItem[] = Array.isArray(req.body?.items) ? req.body.items : [];
    if (!plant) return res.status(400).json({ message: 'Plant is required' });
    if (!isDate(asOf)) return res.status(400).json({ message: 'Pick the day the stock starts from' });
    if (!zeroOnly && items.length === 0) return res.status(400).json({ message: 'The count file has no rows' });
    if (!zeroOnly && isAll(plant)) return res.status(400).json({ message: 'A count file is for one plant — pick the plant, or use "zero only" for all plants.' });
    const plants = await plantsFor(pool, plant);
    const keepSince = keepSinceOf(req);
    const plans = []; for (const p of plants) plans.push(await computePlan(pool, p, asOf, zeroOnly ? [] : items, false, keepSince));
    const sums = plans.map(summarise);
    const add = (k: keyof ReturnType<typeof summarise>) => sums.reduce((n, x) => n + (x[k] as number), 0);
    res.json({
      summary: { itemsInCount: add('itemsInCount'), countTotal: add('countTotal'), liveBefore: add('liveBefore'), liveAfter: add('liveAfter'), toZero: add('toZero'), changed: add('changed'), keptSince: add('keptSince'), unknown: add('unknown') },
      warnings: {
        openOrderScans: plans.reduce((n, p) => n + p.warnings.openOrderScans, 0),
        openLoadSlips: plans.reduce((n, p) => n + p.warnings.openLoadSlips, 0),
        openUnloadVehicles: [...new Set(plans.flatMap((p) => p.warnings.openUnloadVehicles))].slice(0, 30),
        futureDate: asOf > todayStr(),
        salesInScope: plans.reduce((n, p) => n + p.warnings.salesInScope, 0),
      },
      unknown: plans.flatMap((p) => p.unknown).slice(0, 100),
      rows: plans.flatMap((p) => p.rows.map((x) => ({ plant: p.plantName, barcode: x.barcode, name: x.name, count: x.count, liveBefore: x.liveBefore, since: x.since, after: x.target })))
        .sort((x, y) => Math.abs(y.after - y.liveBefore) - Math.abs(x.after - x.liveBefore)).slice(0, 400),
      rowsTotal: plans.reduce((n, p) => n + p.rows.length, 0), plants,
    });
  } catch (e) { console.error('Stock reset preview failed:', e); res.status(500).json({ message: 'Could not check the count' }); }
});

// GET /api/stock-reset/current-stock?plant=<name|all> — the live stock, for the backup CSV.
router.get('/stock-reset/current-stock', requireAdminRole, async (req: Request, res: Response) => {
  try {
    const plant = String(req.query.plant ?? '').trim();
    if (!plant) return res.status(400).json({ message: 'Plant is required' });
    const { rows } = await pool.query(
      `SELECT pps.barcode, pr.name, pps.plant, pps.in_stock::int AS "inStock", pps.extra_qty::int AS "extraQty"
         FROM product_plant_stock pps LEFT JOIN products pr ON pr.id = pps.product_id
        WHERE ($2::boolean OR LOWER(TRIM(pps.plant)) = LOWER(TRIM($1))) AND (pps.in_stock <> 0 OR pps.extra_qty <> 0) ORDER BY pps.plant, pps.barcode`, [plant, isAll(plant)]);
    res.json({ items: rows });
  } catch (e) { console.error('Stock reset backup list failed:', e); res.status(500).json({ message: 'Could not read the stock' }); }
});

// POST /api/stock-reset/apply — { plant | 'all', asOfDate, zeroOnly?, items?, csvFileName, setTrackingStart, confirm:'RESET STOCK' }
router.post('/stock-reset/apply', requireAdminRole, async (req: Request, res: Response) => {
  const plant = String(req.body?.plant ?? '').trim(); const asOf = req.body?.asOfDate; const zeroOnly = zeroOnlyOf(req);
  const items: CountItem[] = Array.isArray(req.body?.items) ? req.body.items : [];
  const setTracking = req.body?.setTrackingStart !== false;
  if (String(req.body?.confirm ?? '').trim().toUpperCase() !== 'RESET STOCK') return res.status(400).json({ message: 'Type RESET STOCK to confirm.' });
  if (!plant) return res.status(400).json({ message: 'Plant is required' });
  if (!isDate(asOf)) return res.status(400).json({ message: 'Pick the day the stock starts from' });
  if (!zeroOnly && items.length === 0) return res.status(400).json({ message: 'The count file has no rows' });
  if (!zeroOnly && isAll(plant)) return res.status(400).json({ message: 'A count file is for one plant — pick the plant, or use "zero only" for all plants.' });
  const { userCode, userName } = actor(req);
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const { rows: ts } = await client.query(`SELECT sales_tracking_start_date::text AS d FROM sales_settings ORDER BY id LIMIT 1`);
    const prevTracking: string | null = ts[0]?.d ?? null;
    const ledgerDay = dayBefore(asOf);
    const keepSince = keepSinceOf(req);
    const plants = await plantsFor(client, plant);
    const batchIds: number[] = []; const total = { itemsInCount: 0, countTotal: 0, liveBefore: 0, liveAfter: 0, changed: 0 };

    for (const p of plants) {
      const plan = await computePlan(client, p, asOf, zeroOnly ? [] : items, true, keepSince);
      const sum = summarise(plan);
      if (plan.rows.length === 0) continue; // a plant with no stock and no count — nothing to do
      const { rows: b } = await client.query(
        `INSERT INTO stock_reset_batches (plant, as_of_date, item_count, count_total, live_before_total, live_after_total, csv_file_name, prev_tracking_start, set_tracking_start, created_by_code, created_by_name)
         VALUES ($1,$2::date,$3,$4,$5,$6,$7,$8::date,$9,$10,$11) RETURNING id`,
        [plan.plantName, asOf, sum.itemsInCount, sum.countTotal, sum.liveBefore, sum.liveAfter, zeroOnly ? '(zero only — no count file)' : (String(req.body?.csvFileName ?? '').trim() || null), prevTracking, setTracking, userCode ?? null, userName ?? null]);
      const batchId: number = b[0].id; batchIds.push(batchId);
      if (!keepSince) {
        // throw away what was already done on/after the start day for this plant: move those ledger lines to the day before the start
        await client.query(
          `INSERT INTO stock_reset_discards (batch_id, movement_id, prev_effective_date)
           SELECT $1, sm.id, sm.effective_date FROM stock_movements sm
             LEFT JOIN order_import_sessions ois ON sm.source IS DISTINCT FROM 'unloading' AND ois.id = sm.session_id
            WHERE sm.source IS DISTINCT FROM 'loading' AND sm.type <> 'dispatch' AND COALESCE(sm.origin,'') NOT IN ('settings','opening','void') AND sm.type <> 'receive'
              AND LOWER(TRIM(sm.plant)) = LOWER(TRIM($2))
              AND COALESCE(sm.effective_date, CASE WHEN sm.source = 'unloading' THEN sm.created_at::date ELSE COALESCE(ois.order_date::date, sm.created_at::date) END) >= $3::date`,
          [batchId, plan.plantName, asOf]);
        await client.query(`UPDATE stock_movements SET effective_date = $2::date WHERE id IN (SELECT movement_id FROM stock_reset_discards WHERE batch_id = $1)`, [batchId, ledgerDay]);
      }
      for (const r of plan.rows) {
        await client.query(
          `INSERT INTO product_plant_stock (barcode, product_id, plant, in_stock, extra_qty, updated_at) VALUES ($1,$2,$3,$4,$5,NOW())
           ON CONFLICT (barcode, plant) DO UPDATE SET in_stock = EXCLUDED.in_stock, extra_qty = EXCLUDED.extra_qty, product_id = COALESCE(product_plant_stock.product_id, EXCLUDED.product_id), updated_at = NOW()`,
          [r.barcode, r.productId, plan.plantName, r.target, r.extraTarget]);
        await client.query(
          `INSERT INTO stock_reset_rows (batch_id, barcode, product_id, plant, count_qty, live_before, extra_before, live_after, extra_after) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
          [batchId, r.barcode, r.productId, plan.plantName, r.count, r.liveBefore, r.extraBefore, r.target, r.extraTarget]);
        if (r.count > 0) {
          await client.query(
            `INSERT INTO stock_movements (barcode, product_id, plant, qty, extra_qty, type, reason, created_by_code, origin, created_at)
             VALUES ($1,$2,$3,$4,0,'adjust',$5,$6,'opening',$7::date)`,
            [r.barcode, r.productId, plan.plantName, r.count, `Stock reset #${batchId} — opening count as of ${asOf}`, userCode ?? null, ledgerDay]);
        }
        const liveChange = r.target - r.liveBefore;
        if (liveChange !== 0 || r.extraTarget !== r.extraBefore) {
          await client.query(
            // dated the day BEFORE the start (effective_date) so Stock Overview's System column starts at 0 too — this line is only the audit of the zeroing
            `INSERT INTO stock_movements (barcode, product_id, plant, qty, extra_qty, type, reason, created_by_code, hidden_in_history, origin, effective_date)
             VALUES ($1,$2,$3,$4,$5,'adjust',$6,$7,true,'settings',$8::date)`,
            [r.barcode, r.productId, plan.plantName, liveChange, r.extraTarget - r.extraBefore, `Stock reset #${batchId} — ${zeroOnly ? 'live stock zeroed' : 'live stock set to the count'}`, userCode ?? null, ledgerDay]);
        }
      }
      await client.query(
        `UPDATE products p SET in_stock = COALESCE((SELECT SUM(pps.in_stock) FROM product_plant_stock pps WHERE pps.barcode = p.barcode), 0)
          WHERE LOWER(TRIM(p.barcode)) IN (SELECT LOWER(TRIM(x)) FROM unnest($1::text[]) AS x)`, [plan.rows.map((r) => r.barcode)]);
      total.itemsInCount += sum.itemsInCount; total.countTotal += sum.countTotal; total.liveBefore += sum.liveBefore; total.liveAfter += sum.liveAfter; total.changed += sum.changed;
    }
    if (isAll(plant)) {
      // every plant at once: also bring the product-level total in line (a product with no plant row at all keeps an old number otherwise)
      await client.query(`UPDATE products p SET in_stock = COALESCE((SELECT SUM(pps.in_stock) FROM product_plant_stock pps WHERE LOWER(TRIM(pps.barcode)) = LOWER(TRIM(p.barcode))), 0)
                           WHERE p.in_stock IS DISTINCT FROM COALESCE((SELECT SUM(pps.in_stock) FROM product_plant_stock pps WHERE LOWER(TRIM(pps.barcode)) = LOWER(TRIM(p.barcode))), 0)`);
    }
    if (batchIds.length === 0) { await client.query('ROLLBACK'); return res.status(400).json({ message: 'Nothing to reset — there is no stock and no count.' }); }
    if (setTracking) {
      const up = await client.query(`UPDATE sales_settings SET sales_tracking_start_date = $1::date, updated_at = NOW(), updated_by_code = $2 WHERE id = (SELECT id FROM sales_settings ORDER BY id LIMIT 1)`, [asOf, userCode ?? null]);
      if (up.rowCount === 0) await client.query(`INSERT INTO sales_settings (sales_tracking_start_date, updated_by_code) VALUES ($1::date, $2)`, [asOf, userCode ?? null]);
    }
    await client.query('COMMIT');
    try {
      await storage.logActivity({
        pageName: 'Settings', action: 'update', entityType: 'stock_reset', entityId: batchIds.join(','),
        details: `Stock ${zeroOnly ? 'zeroed' : 'reset to a count'} for ${isAll(plant) ? 'all plants' : plant} from ${asOf} by ${userName ?? userCode}: live stock ${total.liveBefore} -> ${total.liveAfter}${setTracking ? `, tracking start set to ${asOf}` : ''}.`,
        userCode, userName,
      });
    } catch { /* the reset matters more than its log line */ }
    res.json({ success: true, batchId: batchIds[0], batchIds, summary: { ...total } });
  } catch (e) {
    await client.query('ROLLBACK').catch(() => {});
    console.error('Stock reset failed:', e);
    res.status(500).json({ message: 'Failed — nothing was changed.' });
  } finally { client.release(); }
});

router.get('/stock-reset/batches', requireAdminRole, async (_req: Request, res: Response) => {
  try {
    const { rows } = await pool.query(
      `SELECT id, plant, as_of_date::text AS "asOfDate", item_count AS "itemCount", count_total AS "countTotal", live_before_total AS "liveBefore", live_after_total AS "liveAfter",
              csv_file_name AS "csvFileName", set_tracking_start AS "setTrackingStart", prev_tracking_start::text AS "prevTrackingStart", status, created_by_name AS "createdByName", created_at AS "createdAt"
         FROM stock_reset_batches ORDER BY id DESC LIMIT 30`);
    res.json({ batches: rows });
  } catch (e) { console.error('Stock reset batches failed:', e); res.status(500).json({ message: 'Failed to load the resets' }); }
});

// POST /api/stock-reset/batches/:id/undo — takes back exactly what the reset changed (later scans are kept) and puts the old
// tracking start back. Newest reset of a plant first.
router.post('/stock-reset/batches/:id/undo', requireAdminRole, async (req: Request, res: Response) => {
  const id = Number(req.params.id);
  if (!Number.isInteger(id)) return res.status(400).json({ message: 'Bad id' });
  const { userCode, userName } = actor(req);
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const { rows: b } = await client.query(`SELECT * FROM stock_reset_batches WHERE id = $1 FOR UPDATE`, [id]);
    if (!b[0]) { await client.query('ROLLBACK'); return res.status(404).json({ message: 'Reset not found' }); }
    if (b[0].status !== 'active') { await client.query('ROLLBACK'); return res.status(409).json({ message: 'This reset was already undone.' }); }
    const { rows: later } = await client.query(`SELECT id FROM stock_reset_batches WHERE status = 'active' AND id > $1 AND LOWER(TRIM(plant)) = LOWER(TRIM($2)) LIMIT 1`, [id, b[0].plant]);
    if (later[0]) { await client.query('ROLLBACK'); return res.status(409).json({ message: `Undo reset #${later[0].id} (a newer reset of this plant) first.` }); }
    const { rows: rr } = await client.query(`SELECT * FROM stock_reset_rows WHERE batch_id = $1`, [id]);
    for (const r of rr as any[]) {
      await client.query(
        `UPDATE product_plant_stock SET in_stock = GREATEST(0, in_stock - $1), extra_qty = GREATEST(0, extra_qty - $2), updated_at = NOW()
          WHERE barcode = $3 AND LOWER(TRIM(plant)) = LOWER(TRIM($4))`,
        [Number(r.live_after) - Number(r.live_before), Number(r.extra_after) - Number(r.extra_before), r.barcode, r.plant]);
    }
    // ledger lines the reset threw away come back to the day they had
    await client.query(
      `UPDATE stock_movements sm SET effective_date = d.prev_effective_date FROM stock_reset_discards d WHERE d.batch_id = $1 AND d.movement_id = sm.id`, [id]);
    await client.query(`DELETE FROM stock_reset_discards WHERE batch_id = $1`, [id]);
    await client.query(`DELETE FROM stock_movements WHERE reason LIKE $1`, [`Stock reset #${id} —%`]);
    await client.query(
      `UPDATE products p SET in_stock = COALESCE((SELECT SUM(pps.in_stock) FROM product_plant_stock pps WHERE pps.barcode = p.barcode), 0)
        WHERE LOWER(TRIM(p.barcode)) IN (SELECT LOWER(TRIM(x)) FROM unnest($1::text[]) AS x)`, [(rr as any[]).map((r) => r.barcode)]);
    if (b[0].set_tracking_start && b[0].prev_tracking_start) {
      await client.query(`UPDATE sales_settings SET sales_tracking_start_date = $1::date, updated_at = NOW(), updated_by_code = $2 WHERE id = (SELECT id FROM sales_settings ORDER BY id LIMIT 1)`, [String(b[0].prev_tracking_start).slice(0, 10), userCode ?? null]);
    }
    await client.query(`UPDATE stock_reset_batches SET status = 'undone', undone_at = NOW(), undone_by_code = $2 WHERE id = $1`, [id, userCode ?? null]);
    await client.query('COMMIT');
    try { await storage.logActivity({ pageName: 'Settings', action: 'update', entityType: 'stock_reset', entityId: String(id), details: `Stock reset #${id} (${b[0].plant}, as of ${String(b[0].as_of_date).slice(0, 10)}) undone by ${userName ?? userCode}.`, userCode, userName }); } catch { /* ignore */ }
    res.json({ success: true });
  } catch (e) {
    await client.query('ROLLBACK').catch(() => {});
    console.error('Stock reset undo failed:', e);
    res.status(500).json({ message: 'Failed to undo — nothing was changed.' });
  } finally { client.release(); }
});

export default router;
