import { Router, Request, Response } from 'express';
import { pool } from '../db';
import { storage } from '../storage';
import { requireAdminRole, requirePageAccess } from '../lib/pageAccess';
import { getUserPlants } from './order-scan';
import { getOpeningState, startFresh, setOpening, postAdjust, lockLineStock, todayIst } from '../lib/stockV2';

// Stock - the report behind the Stock page, the line drill-down, and the admin actions on one line (Adjust, Clear, Delete). Writes from the
// operations (Order Scan, Unloading, Loading) go through server/lib/stockV2.ts.
const router = Router();
const PAGE = 'overall-stock';

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
              l.sap_is_fallback AS "sapIsFallback", COALESCE(NULLIF(TRIM(pm.new_sr), ''), l.sr_no) AS "srNo", l.brand, l.category,
              l.pallet_size AS "palletSize", l.stock_qty AS "stock",
              COALESCE(d.opening,0)::int + COALESCE(a.opening,0)::int AS "openingStock",
              COALESCE(d.purchase,0)::int AS "purchaseQty", COALESCE(d.xpurchase,0)::int AS "extraPurchaseQty",
              COALESCE(d.sale,0)::int AS "saleQty", COALESCE(d.xsale,0)::int AS "extraSaleQty",
              COALESCE(d.tin,0)::int AS "transferIn", COALESCE(d.tout,0)::int AS "transferOut",
              COALESCE(a.adj,0)::int AS "adjustQty"
         FROM stock_v2_lines l
         LEFT JOIN products pm ON pm.id = l.product_id
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
    // Expected Purchase = what the receiving CSVs and unloading CSVs say is coming (their Order Date in the
    // period); Expected Sale = what the proforma slips plan to send. Same rules as the old Stock Overview:
    // with no date picked the period starts at the Sales Tracking Start date.
    const ss = await pool.query(`SELECT sales_tracking_start_date AS d FROM sales_settings ORDER BY id LIMIT 1`);
    const periodStart = from || String(ss.rows[0]?.d ?? '2026-08-01').slice(0, 10);
    const periodEnd = to || null;
    const plantRows = await pool.query(`SELECT name, state FROM plants`);
    let plantList: string[] | null = null;
    if (plant) plantList = [plant];
    else if (state) plantList = plantRows.rows.filter((p: any) => String(p.state ?? '').toUpperCase() === state).map((p: any) => String(p.name).toLowerCase());
    const scope = (col: string, ps: any[]) => {
      const c: string[] = [];
      if (allowed !== null) { ps.push(allowed.map((p: string) => p.toLowerCase())); c.push(`LOWER(${col}) = ANY($${ps.length}::text[])`); }
      if (plantList) { ps.push(plantList); c.push(`LOWER(${col}) = ANY($${ps.length}::text[])`); }
      return c.length ? ' AND ' + c.join(' AND ') : '';
    };
    const dateCond = (col: string, ps: any[]) => {
      ps.push(periodStart);
      let c = `${col} >= $${ps.length}`;
      if (periodEnd) { ps.push(periodEnd); c += ` AND ${col} <= $${ps.length}`; }
      return c;
    };
    const expP: any[] = [];
    const expPC = dateCond('ois.order_date', expP);
    const e1 = await pool.query(
      `SELECT LOWER(oii.barcode) AS bc, LOWER(oii.plant) AS pl, SUM(oii.quantity)::int AS q
         FROM order_import_items oii JOIN order_import_sessions ois ON ois.id = oii.session_id
        WHERE ${expPC} AND ois.is_deleted = false${scope('oii.plant', expP)} GROUP BY 1,2`, expP);
    const expU: any[] = [];
    const expUC = dateCond('uis.order_date', expU);
    // An unloading CSV is expected at its PURCHASE plant (Baroda), not the plant its stock is added to (Valsad) —
    // the same plant its Purchase is booked at.
    const e2 = await pool.query(
      `SELECT LOWER(uii.barcode) AS bc, LOWER(COALESCE(NULLIF(TRIM(uis.purchase_plant), ''), uii.plant)) AS pl, SUM(uii.quantity)::int AS q
         FROM unload_import_items uii JOIN unload_import_sessions uis ON uis.id = uii.session_id
        WHERE ${expUC} AND uis.is_deleted = false${scope("COALESCE(NULLIF(TRIM(uis.purchase_plant), ''), uii.plant)", expU)} GROUP BY 1,2`, expU);
    const expS: any[] = [];
    const expSC = dateCond('ps.order_date', expS);
    const e3 = await pool.query(
      `SELECT LOWER(psi.barcode) AS bc, LOWER(ps.plant) AS pl, SUM(psi.quantity)::int AS q
         FROM proforma_slip_items psi JOIN proforma_slips ps ON ps.id = psi.proforma_slip_id
        WHERE ${expSC} AND psi.barcode IS NOT NULL AND ps.plant IS NOT NULL${scope('ps.plant', expS)} GROUP BY 1,2`, expS);
    const expPurchase = new Map<string, number>();
    const expSale = new Map<string, number>();
    const keyOf = (r: any) => `${r.pl}|${r.bc}`;
    for (const r of [...e1.rows, ...e2.rows]) expPurchase.set(keyOf(r), (expPurchase.get(keyOf(r)) ?? 0) + Number(r.q));
    for (const r of e3.rows) expSale.set(keyOf(r), (expSale.get(keyOf(r)) ?? 0) + Number(r.q));

    // A CSV / slip item with no stock line yet (nothing scanned, no stock) still shows, with Stock 0 —
    // its details come from the Product Master.
    const have = new Set(rows.map((r: any) => `${String(r.plant).toLowerCase()}|${String(r.barcode).toLowerCase()}`));
    const missing = [...new Set([...expPurchase.keys(), ...expSale.keys()])].filter((k) => !have.has(k));
    const extraRows: any[] = [];
    if (missing.length) {
      const bcs = [...new Set(missing.map((k) => k.split('|')[1]))];
      const pr = await pool.query(
        `SELECT DISTINCT ON (LOWER(barcode)) LOWER(barcode) AS bc, barcode, name, brand, category, new_sr, COALESCE(gj_sap, mp_sap, sap_code) AS sap
           FROM products WHERE LOWER(barcode) = ANY($1::text[]) ORDER BY LOWER(barcode), id`, [bcs]);
      const byBc = new Map<string, any>(pr.rows.map((r: any) => [r.bc, r]));
      const nameOf = new Map<string, any>(plantRows.rows.map((p: any) => [String(p.name).toLowerCase(), p]));
      for (const k of missing) {
        const [pl, bc] = k.split('|');
        const p = byBc.get(bc);
        const pt = nameOf.get(pl);
        if (!p || !pt) continue;
        extraRows.push({
          id: null, plant: pt.name, state: pt.state, barcode: p.barcode, itemName: p.name, sapCode: p.sap, sapIsFallback: false,
          srNo: p.new_sr, brand: p.brand, category: p.category, palletSize: null, stock: 0, openingStock: 0, purchaseQty: 0,
          extraPurchaseQty: 0, saleQty: 0, extraSaleQty: 0, transferIn: 0, transferOut: 0, adjustQty: 0,
        });
      }
    }
    const items = [...rows, ...extraRows]
      .map((r: any) => {
        const pallet = r.palletSize && r.palletSize > 0 ? r.palletSize : 0;
        const closingStock = r.openingStock + r.purchaseQty - r.saleQty + r.adjustQty + r.transferIn - r.transferOut;
        const k = `${String(r.plant).toLowerCase()}|${String(r.barcode).toLowerCase()}`;
        return {
          ...r, closingStock, closingPallets: pallet ? Math.round((closingStock / pallet) * 100) / 100 : 0,
          expectedPurchase: expPurchase.get(k) ?? 0, expectedSale: expSale.get(k) ?? 0,
        };
      })
      .filter((r: any) => r.closingStock !== 0 || r.saleQty !== 0 || r.purchaseQty !== 0 || r.adjustQty !== 0 || r.transferIn !== 0
        || r.transferOut !== 0 || r.stock !== 0 || r.expectedPurchase !== 0 || r.expectedSale !== 0);
    res.json({ items, total: items.length, plants: allowed, from, to });
  } catch (e) {
    console.error('[StockV2] report failed:', e);
    res.status(500).json({ message: 'Could not load Stock Overview' });
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
        `SELECT id, stock_date::text AS date, kind, qty, reason, origin, source, created_by_code AS "by", (SELECT u.name FROM users u WHERE u.user_code = stock_v2_ledger.created_by_code LIMIT 1) AS "byName", created_at AS "at"
           FROM stock_v2_ledger WHERE line_id = $1 ORDER BY stock_date DESC, id DESC`, [id]),
    ]);
    res.json({ days: days.rows, ledger: ledger.rows });
  } catch (e) {
    console.error('[StockV2] line days failed:', e);
    res.status(500).json({ message: 'Could not load this line' });
  }
});

// DELETE /api/stock-v2/ledger/:id — admin: removes ONE correction (Adjust / Opening / Clear / Exchange) from the book, like the Delete entry on the
// Stock Overview's Adjustments list. It only edits the ledger: the line's Stock (stock_qty) is NOT changed, so a stray or duplicate entry stops
// counting toward Opening / Adjust / Total P & O without moving the stock that has already moved on since.
router.delete('/stock-v2/ledger/:id', requireAdminRole, async (req: Request, res: Response) => {
  const id = Number(req.params.id);
  if (!Number.isInteger(id)) return res.status(400).json({ message: 'Invalid entry id' });
  try {
    const { rows } = await pool.query(
      `DELETE FROM stock_v2_ledger d USING stock_v2_lines l
        WHERE d.id = $1 AND l.id = d.line_id
        RETURNING l.plant, l.barcode, l.item_name AS "itemName", d.qty, d.kind, d.reason`,
      [id],
    );
    const gone = rows[0];
    if (!gone) return res.status(404).json({ message: 'Entry not found' });
    const u = req.user as any;
    const userCode = u?.userCode ?? undefined;
    if (userCode) {
      await storage.logActivity({
        pageName: 'Stock Overview', action: 'delete', entityType: 'stock_v2_ledger', entityId: String(id),
        details: `Deleted a ${gone.kind} entry for ${gone.itemName} (${gone.barcode}) at ${gone.plant} by ${u?.name ?? userCode}: ${gone.qty >= 0 ? '+' : ''}${gone.qty} (${gone.reason ?? 'no reason recorded'}). Stock was not changed.`,
        userCode, userName: u?.name ?? userCode,
      });
    }
    res.json({ success: true });
  } catch (e) {
    console.error('[StockV2] delete ledger entry failed:', e);
    res.status(500).json({ message: 'Could not delete this entry' });
  }
});

// The line an admin action is about (locked), with its plant checked against the caller's plants.
async function lockedLine(client: any, req: Request, id: number) {
  const r = await client.query(`SELECT id, plant, barcode, item_name AS "itemName", stock_qty AS "stockQty" FROM stock_v2_lines WHERE id = $1 FOR UPDATE`, [id]);
  const line = r.rows[0];
  if (!line) return { error: { status: 404, message: 'Stock line not found' } };
  const allowed = getUserPlants(req.user);
  if (allowed !== null && !allowed.includes(String(line.plant).toLowerCase())) return { error: { status: 403, message: 'Access denied for this plant' } };
  return { line };
}
const actorOf = (req: Request) => { const u = req.user as any; return { userCode: u?.userCode as string | undefined, userName: (u?.name || u?.username || u?.userCode) as string | undefined }; };

// POST /api/stock-v2/line/:id/adjust — admin. body: { mode: 'add' | 'remove' | 'set', qty, expectedCurrentQty?, reason? }
//   add / remove: qty is a positive amount; set: qty is the new Stock. expectedCurrentQty is the Stock the dialog showed - if it moved since
//   (someone scanned meanwhile) the change is refused with 409 instead of applying a different one than previewed.
//   Written as an 'adjust' correction on the book (shows in the Adjust column and as a Stock Adjust row in Scan History).
router.post('/stock-v2/line/:id/adjust', requireAdminRole, async (req: Request, res: Response) => {
  const id = Number(req.params.id);
  const mode: 'add' | 'remove' | 'set' = req.body?.mode === 'add' || req.body?.mode === 'remove' ? req.body.mode : 'set';
  const qty = Math.round(Number(req.body?.qty));
  const rawExpected = req.body?.expectedCurrentQty;
  const expected = rawExpected === undefined || rawExpected === null || rawExpected === '' ? null : Math.round(Number(rawExpected));
  const reason = (typeof req.body?.reason === 'string' ? req.body.reason.trim() : '') || 'Manual adjustment (Stock)';
  if (!Number.isInteger(id)) return res.status(400).json({ message: 'Invalid line' });
  if (!Number.isFinite(qty) || qty < 0) return res.status(400).json({ message: 'Quantity must be a non-negative number' });
  if (mode !== 'set' && qty === 0) return res.status(400).json({ message: 'Enter a quantity greater than 0' });
  const { userCode, userName } = actorOf(req);
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const got: any = await lockedLine(client, req, id);
    if (got.error) { await client.query('ROLLBACK'); return res.status(got.error.status).json({ message: got.error.message }); }
    const { line } = got;
    const current = await lockLineStock(client, id);
    if (expected !== null && Number.isFinite(expected) && expected !== current) {
      await client.query('ROLLBACK');
      return res.status(409).json({ message: `Stock for ${line.itemName} at ${line.plant} is now ${current} (it was ${expected} when you opened this). Check the new number and try again.`, currentTotal: current });
    }
    const next = mode === 'add' ? current + qty : mode === 'remove' ? current - qty : qty;
    if (next < 0) { await client.query('ROLLBACK'); return res.status(400).json({ message: `Can't remove ${qty} — only ${current} in stock at ${line.plant}.` }); }
    const delta = next - current;
    await postAdjust(client, id, todayIst(), delta, { kind: 'adjust', source: 'manual', origin: 'page', reason, userCode: userCode ?? null });
    await client.query('COMMIT');
    if (userCode && delta !== 0) {
      await storage.logActivity({
        pageName: 'Stock Overview', action: 'update', entityType: 'stock_v2_line', entityId: String(id),
        details: `Adjusted ${line.itemName} (${line.barcode}) at ${line.plant} by ${userName ?? userCode} (${mode}): ${current} -> ${next} (${delta >= 0 ? '+' : ''}${delta}). Reason: ${reason}`,
        userCode, userName,
      });
    }
    res.json({ success: true, previousQty: current, newQty: next, delta, plant: line.plant });
  } catch (e) {
    await client.query('ROLLBACK').catch(() => {});
    console.error('[Stock] adjust failed:', e);
    res.status(500).json({ message: 'Failed to adjust stock' });
  } finally { client.release(); }
});

// POST /api/stock-v2/line/:id/clear — admin: takes this line's Stock to 0 with a 'clear' correction (the book keeps its history).
router.post('/stock-v2/line/:id/clear', requireAdminRole, async (req: Request, res: Response) => {
  const id = Number(req.params.id);
  if (!Number.isInteger(id)) return res.status(400).json({ message: 'Invalid line' });
  const { userCode, userName } = actorOf(req);
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const got: any = await lockedLine(client, req, id);
    if (got.error) { await client.query('ROLLBACK'); return res.status(got.error.status).json({ message: got.error.message }); }
    const { line } = got;
    const current = await lockLineStock(client, id);
    await postAdjust(client, id, todayIst(), -current, { kind: 'clear', source: 'clear', origin: 'page', reason: 'Clear Stock (Stock page)', userCode: userCode ?? null });
    await client.query('COMMIT');
    if (userCode && current !== 0) {
      await storage.logActivity({
        pageName: 'Stock Overview', action: 'update', entityType: 'stock_v2_line', entityId: String(id),
        details: `Cleared ${line.itemName} (${line.barcode}) at ${line.plant} by ${userName ?? userCode}: ${current} -> 0.`, userCode, userName,
      });
    }
    res.json({ success: true, previousQty: current, newQty: 0 });
  } catch (e) {
    await client.query('ROLLBACK').catch(() => {});
    console.error('[Stock] clear failed:', e);
    res.status(500).json({ message: 'Failed to clear stock' });
  } finally { client.release(); }
});

// DELETE /api/stock-v2/line/:id — admin: forgets the line completely - its days, its corrections and its links - and zeroes it. Scan entries
// (Order Scan, Unloading, Loading) are NOT touched; their own void / reset flows own them. The line is made again, empty, the next time the item moves.
router.delete('/stock-v2/line/:id', requireAdminRole, async (req: Request, res: Response) => {
  const id = Number(req.params.id);
  if (!Number.isInteger(id)) return res.status(400).json({ message: 'Invalid line' });
  const { userCode, userName } = actorOf(req);
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const got: any = await lockedLine(client, req, id);
    if (got.error) { await client.query('ROLLBACK'); return res.status(got.error.status).json({ message: got.error.message }); }
    const { line } = got;
    const days = await client.query(`DELETE FROM stock_v2_daily WHERE line_id = $1`, [id]);
    const ledger = await client.query(`DELETE FROM stock_v2_ledger WHERE line_id = $1`, [id]);
    await client.query(`DELETE FROM stock_v2_links WHERE line_id = $1`, [id]);
    await client.query(`UPDATE stock_v2_lines SET stock_qty = 0, updated_at = now() WHERE id = $1`, [id]);
    await client.query('COMMIT');
    if (userCode) {
      await storage.logActivity({
        pageName: 'Stock Overview', action: 'delete', entityType: 'stock_v2_line', entityId: String(id),
        details: `Deleted the stock history of ${line.itemName} (${line.barcode}) at ${line.plant} by ${userName ?? userCode} — ${days.rowCount ?? 0} day row(s) and ${ledger.rowCount ?? 0} correction(s) removed; Stock was ${line.stockQty}.`,
        userCode, userName,
      });
    }
    res.json({ success: true, daysRemoved: days.rowCount ?? 0, correctionsRemoved: ledger.rowCount ?? 0 });
  } catch (e) {
    await client.query('ROLLBACK').catch(() => {});
    console.error('[Stock] delete line failed:', e);
    res.status(500).json({ message: 'Failed to delete this item' });
  } finally { client.release(); }
});

// ── Opening stock: only at a fresh start ──
// Normally closed. Start fresh clears Stock Overview and opens a window dated D; entries set each line's
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

export default router;
