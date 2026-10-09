import { Router, Request, Response } from 'express';
import { pool } from '../db';
import { requireAdminRole, requirePageAccess } from '../lib/pageAccess';
import { getUserPlants } from './order-scan';
import { rebuildStockV2 } from '../lib/stockV2Backfill';
import { getOpeningState, startFresh, setOpening, loadingUsesV2, setLoadingUsesV2 } from '../lib/stockV2';

// Stock (New) — read side: the report behind the Stock (New) page, the line drill-down, and the Compare
// view that sets it beside the old Stock Overview while both are kept in step. Admin-only Rebuild redoes
// the one-time conversion. Writes from the operations go through server/lib/stockV2.ts.
const router = Router();
const PAGE = 'overall-stock-v2';

const isoDay = (v: unknown) => (typeof v === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(v) ? v : null);

// GET /api/stock-v2/report?plant=&state=&search=&from=&to=
// Opening = everything before `from` (no date: nothing before, so Opening is 0 and the figures are all-time);
// Closing = Opening + Purchase − Sale + Adjust + Transfer In − Transfer Out. Purchase / Sale already contain
// their Extra; the Extra columns only show how much of them was extra.
router.get('/stock-v2/report', requirePageAccess(PAGE), async (req: Request, res: Response) => {
  try {
    const allowed = getUserPlants(req.user);
    if (allowed !== null && allowed.length === 0) return res.json({ items: [], total: 0, plants: [] });
    const plant = typeof req.query.plant === 'string' ? req.query.plant.trim().toLowerCase() : '';
    const state = typeof req.query.state === 'string' ? req.query.state.trim().toUpperCase() : '';
    const search = typeof req.query.search === 'string' ? req.query.search.trim().toLowerCase() : '';
    const from = isoDay(req.query.from);
    const to = isoDay(req.query.to);

    const params: any[] = [from, to];
    const where: string[] = [];
    if (allowed !== null) { params.push(allowed.map((p: string) => p.toLowerCase())); where.push(`LOWER(l.plant) = ANY($${params.length}::text[])`); }
    if (plant) { params.push(plant); where.push(`LOWER(l.plant) = $${params.length}`); }
    if (state) { params.push(state); where.push(`UPPER(COALESCE(l.state,'')) = $${params.length}`); }
    if (search) {
      params.push(`%${search}%`);
      const n = params.length;
      where.push(`(LOWER(l.item_name) LIKE $${n} OR LOWER(l.barcode) LIKE $${n} OR LOWER(COALESCE(l.sap_code,'')) LIKE $${n} OR LOWER(COALESCE(l.sr_no,'')) LIKE $${n})`);
    }

    const { rows } = await pool.query(
      `SELECT l.id, l.plant, l.state, l.barcode, l.item_name AS "itemName", l.sap_code AS "sapCode",
              l.sap_is_fallback AS "sapIsFallback", l.sr_no AS "srNo", l.brand, l.category,
              l.pallet_size AS "palletSize", l.stock_qty AS "stock",
              COALESCE(d.opening,0)::int + COALESCE(a.opening,0)::int AS "openingStock",
              COALESCE(d.purchase,0)::int AS "purchaseQty", COALESCE(d.xpurchase,0)::int AS "extraPurchaseQty",
              COALESCE(d.sale,0)::int AS "saleQty", COALESCE(d.xsale,0)::int AS "extraSaleQty",
              COALESCE(d.tin,0)::int AS "transferIn", COALESCE(d.tout,0)::int AS "transferOut",
              COALESCE(a.adj,0)::int AS "adjustQty"
         FROM stock_v2_lines l
         LEFT JOIN LATERAL (
           SELECT SUM(CASE WHEN $1::date IS NOT NULL AND stock_date < $1::date THEN purchase_qty - sale_qty + transfer_in_qty - transfer_out_qty ELSE 0 END) AS opening,
                  SUM(CASE WHEN ($1::date IS NULL OR stock_date >= $1::date) AND ($2::date IS NULL OR stock_date <= $2::date) THEN purchase_qty END) AS purchase,
                  SUM(CASE WHEN ($1::date IS NULL OR stock_date >= $1::date) AND ($2::date IS NULL OR stock_date <= $2::date) THEN extra_purchase_qty END) AS xpurchase,
                  SUM(CASE WHEN ($1::date IS NULL OR stock_date >= $1::date) AND ($2::date IS NULL OR stock_date <= $2::date) THEN sale_qty END) AS sale,
                  SUM(CASE WHEN ($1::date IS NULL OR stock_date >= $1::date) AND ($2::date IS NULL OR stock_date <= $2::date) THEN extra_sale_qty END) AS xsale,
                  SUM(CASE WHEN ($1::date IS NULL OR stock_date >= $1::date) AND ($2::date IS NULL OR stock_date <= $2::date) THEN transfer_in_qty END) AS tin,
                  SUM(CASE WHEN ($1::date IS NULL OR stock_date >= $1::date) AND ($2::date IS NULL OR stock_date <= $2::date) THEN transfer_out_qty END) AS tout
             FROM stock_v2_daily WHERE line_id = l.id
         ) d ON true
         LEFT JOIN LATERAL (
           SELECT SUM(CASE WHEN $1::date IS NOT NULL AND stock_date < $1::date THEN qty ELSE 0 END) AS opening,
                  SUM(CASE WHEN ($1::date IS NULL OR stock_date >= $1::date) AND ($2::date IS NULL OR stock_date <= $2::date) THEN qty END) AS adj
             FROM stock_v2_ledger WHERE line_id = l.id
         ) a ON true
        ${where.length ? 'WHERE ' + where.join(' AND ') : ''}
        ORDER BY l.plant, l.item_name`,
      params,
    );
    const items = rows
      .map((r: any) => {
        const pallet = r.palletSize && r.palletSize > 0 ? r.palletSize : 0;
        const closingStock = r.openingStock + r.purchaseQty - r.saleQty + r.adjustQty + r.transferIn - r.transferOut;
        return { ...r, closingStock, closingPallets: pallet ? Math.round((closingStock / pallet) * 100) / 100 : 0 };
      })
      .filter((r: any) => r.closingStock !== 0 || r.saleQty !== 0 || r.purchaseQty !== 0 || r.adjustQty !== 0 || r.transferIn !== 0 || r.transferOut !== 0 || r.stock !== 0);
    res.json({ items, total: items.length, plants: allowed, from, to });
  } catch (e) {
    console.error('[StockV2] report failed:', e);
    res.status(500).json({ message: 'Could not load Stock (New)' });
  }
});

// GET /api/stock-v2/line/:id/days — the day-by-day book and corrections behind one line.
router.get('/stock-v2/line/:id/days', requirePageAccess(PAGE), async (req: Request, res: Response) => {
  try {
    const id = Number(req.params.id);
    if (!Number.isInteger(id)) return res.status(400).json({ message: 'Bad line id' });
    const allowed = getUserPlants(req.user);
    const line = await pool.query(`SELECT id, plant FROM stock_v2_lines WHERE id = $1`, [id]);
    if (!line.rows[0]) return res.status(404).json({ message: 'Line not found' });
    if (allowed !== null && !allowed.map((p: string) => p.toLowerCase()).includes(String(line.rows[0].plant).toLowerCase())) {
      return res.status(403).json({ message: 'No access to this plant' });
    }
    const [days, ledger] = await Promise.all([
      pool.query(
        `SELECT stock_date::text AS date, purchase_qty AS "purchaseQty", extra_purchase_qty AS "extraPurchaseQty", sale_qty AS "saleQty",
                extra_sale_qty AS "extraSaleQty", transfer_in_qty AS "transferIn", transfer_out_qty AS "transferOut"
           FROM stock_v2_daily WHERE line_id = $1 ORDER BY stock_date DESC`, [id]),
      pool.query(
        `SELECT id, stock_date::text AS date, kind, qty, reason, origin, source, created_by_code AS "by", created_at AS "at"
           FROM stock_v2_ledger WHERE line_id = $1 ORDER BY stock_date DESC, id DESC`, [id]),
    ]);
    res.json({ days: days.rows, ledger: ledger.rows });
  } catch (e) {
    console.error('[StockV2] line days failed:', e);
    res.status(500).json({ message: 'Could not load this line' });
  }
});

// GET /api/stock-v2/compare — old live count vs the new line's Stock, per plant + barcode; only mismatches.
router.get('/stock-v2/compare', requireAdminRole, async (_req: Request, res: Response) => {
  try {
    const { rows } = await pool.query(
      `WITH old AS (
         SELECT LOWER(plant) AS plant, LOWER(barcode) AS barcode, MAX(plant) AS plant_name, MAX(barcode) AS barcode_raw, SUM(in_stock)::int AS qty
           FROM product_plant_stock GROUP BY 1,2
       ), nw AS (
         SELECT LOWER(plant) AS plant, LOWER(barcode) AS barcode, MAX(item_name) AS item_name, SUM(stock_qty)::int AS qty
           FROM stock_v2_lines GROUP BY 1,2
       )
       SELECT COALESCE(old.plant_name, nw.plant) AS plant, COALESCE(old.barcode_raw, nw.barcode) AS barcode, nw.item_name AS "itemName",
              COALESCE(old.qty,0) AS "oldQty", COALESCE(nw.qty,0) AS "newQty", COALESCE(nw.qty,0) - COALESCE(old.qty,0) AS diff
         FROM old FULL JOIN nw ON old.plant = nw.plant AND old.barcode = nw.barcode
        WHERE COALESCE(old.qty,0) <> COALESCE(nw.qty,0)
        ORDER BY 1, 2`,
    );
    const totals = await pool.query(
      `SELECT (SELECT COUNT(*) FROM stock_v2_lines)::int AS lines, (SELECT COUNT(*) FROM product_plant_stock)::int AS "oldRows",
              (SELECT last_rebuild_at FROM stock_v2_config WHERE id = 1) AS "lastRebuildAt"`,
    );
    res.json({ mismatches: rows, ...totals.rows[0], loadingUsesV2: await loadingUsesV2(pool) });
  } catch (e) {
    console.error('[StockV2] compare failed:', e);
    res.status(500).json({ message: 'Could not compare' });
  }
});

// POST /api/stock-v2/rebuild — admin: redo the one-time conversion from the old stock.
router.post('/stock-v2/rebuild', requireAdminRole, async (req: Request, res: Response) => {
  try {
    const result = await rebuildStockV2((req.user as any)?.userCode ?? null);
    res.json(result);
  } catch (e) {
    console.error('[StockV2] rebuild failed:', e);
    res.status(500).json({ message: 'Rebuild failed — nothing was changed' });
  }
});

// ── Opening stock: only at a fresh start ──
// Normally closed. Start fresh clears Stock (New) and opens a window dated D; entries set each line's
// opening figure (re-entering an item replaces it); Lock closes the window until the next fresh start.
router.get('/stock-v2/opening', requirePageAccess(PAGE), async (_req: Request, res: Response) => {
  try { res.json(await getOpeningState(pool)); } catch (e) { res.status(500).json({ message: 'Could not read opening state' }); }
});

router.post('/stock-v2/opening/start', requireAdminRole, async (req: Request, res: Response) => {
  try {
    const date = isoDay(req.body?.date);
    if (!date) return res.status(400).json({ message: 'Pick the opening date' });
    await startFresh(date);
    res.json(await getOpeningState(pool));
  } catch (e) { console.error('[StockV2] start fresh failed:', e); res.status(500).json({ message: 'Could not start fresh' }); }
});

// body: { entries: [{ plant, barcode, qty }] } — only while the window is open.
router.post('/stock-v2/opening/set', requireAdminRole, async (req: Request, res: Response) => {
  const client = await pool.connect();
  try {
    const st = await getOpeningState(client);
    if (!st.open || !st.date) return res.status(409).json({ message: 'Opening stock is closed. It can only be entered right after Start fresh.' });
    const entries: any[] = Array.isArray(req.body?.entries) ? req.body.entries : [];
    const userCode = (req.user as any)?.userCode ?? null;
    const done: number[] = []; const failed: Array<{ plant: string; barcode: string; reason: string }> = [];
    await client.query('BEGIN');
    for (const e of entries) {
      const plant = String(e?.plant ?? '').trim(); const barcode = String(e?.barcode ?? '').trim(); const qty = Math.round(Number(e?.qty));
      if (!plant || !barcode || !Number.isFinite(qty) || qty < 0) { failed.push({ plant, barcode, reason: 'Needs plant, barcode and a quantity of 0 or more' }); continue; }
      const line = await setOpening(client, plant, barcode, qty, st.date, userCode);
      if (!line) failed.push({ plant, barcode, reason: 'Barcode is not in the Product Master' }); else done.push(line.id);
    }
    await client.query('COMMIT');
    res.json({ set: done.length, failed });
  } catch (e) { await client.query('ROLLBACK').catch(() => {}); console.error('[StockV2] opening set failed:', e); res.status(500).json({ message: 'Could not save opening stock' }); }
  finally { client.release(); }
});

router.post('/stock-v2/opening/lock', requireAdminRole, async (_req: Request, res: Response) => {
  try { await pool.query(`UPDATE stock_v2_config SET opening_open = false WHERE id = 1`); res.json(await getOpeningState(pool)); }
  catch (e) { res.status(500).json({ message: 'Could not lock' }); }
});

// POST /api/stock-v2/loading-source — body { useV2: boolean }: which stock Loading draws from. Admin only.
// Stock (New) is always kept in step, so this can be flipped back at any time.
router.post('/stock-v2/loading-source', requireAdminRole, async (req: Request, res: Response) => {
  try {
    await setLoadingUsesV2(req.body?.useV2 === true);
    res.json({ loadingUsesV2: await loadingUsesV2(pool) });
  } catch (e) { res.status(500).json({ message: 'Could not change the Loading stock source' }); }
});

export default router;
