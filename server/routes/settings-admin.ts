import { Router, Request, Response } from 'express';
import { v2Adjust, postAdjust, todayIst } from '../lib/stockV2';
import { storage } from '../storage';
import { pool } from '../db';
import { requireAdminRole } from '../lib/pageAccess';
import { reverseOrderSessions, reverseUnloadSessions, reverseLoadingOrders } from '../lib/stockReverse';
import { runCsvBackup } from '../lib/csvBackup';
import { getDailySyncConfig, saveDailySyncConfig, isValidRunTime, isDailySyncRunning, runDailySyncNow, msUntilNextRun } from '../services/dailyNotionSync';

// Settings > Data Management > "Clear Stock" — an admin-only action that resets stock numbers
// for a chosen plant (or every plant), optionally scoped further to only orders/slips dated on
// or before a chosen Order Date. Works on Stock Overview only - it does NOT touch Order Import/Loading/Unloading scan
// history, sessions, or records in any way.
//   - No date scope: every stock line in the plant scope goes to 0, each with a 'clear' correction (Adjust) on the book.
//   - Date scope: setting to 0 would be WRONG here - it would also wipe out stock earned by transactions dated AFTER the cutoff. Instead it
//     computes what the in-scope (date-filtered) transactions contributed - receiving (Order Import + Unloading) minus dispatch (Loading) for each
//     barcode+plant - and takes only that off, as a 'clear' correction. Best-effort: it assumes stock equals the tracked events for the period.
const router = Router();

function actor(req: Request): { userCode?: string; userName?: string } {
  const u = req.user as any;
  return { userCode: u?.userCode, userName: u?.name || u?.username || u?.userCode };
}

type ActiveBlocker = { source: 'Order Import' | 'Unloading' | 'Loading'; plant: string; orderDate: string | null; label: string };

// A date-scoped clear reverses only what's already been scanned so far for the in-scope period —
// if a session/order in that same plant scope is still open (not yet completed), its numbers
// aren't final: clearing now would reverse a partial amount, and whatever gets scanned into it
// afterward would drift stock off with no way to catch it later. So a still-open session blocks
// the clear — but only one dated ON OR BEFORE the cutoff. The clear reverses exactly the scans of
// orders dated <= cutoff (see the three reversal queries in POST /settings/clear-stock), so an open
// session dated after it is never touched: its scans keep adding to stock normally whether or not
// it's finished. Blocking those too used to refuse a clear "up to 15 Sep" over sessions dated
// 16 and 17 Sep, while calling them "in scope". No-date (whole-plant) clears are unaffected by
// this — that mode already existed before Clear Stock became date-scopable and isn't part of it.
async function findActiveBlockers(queryable: { query: (sql: string, params?: any[]) => Promise<{ rows: any[] }> }, plant: string | null, orderDateUpTo: string): Promise<ActiveBlocker[]> {
  const blockers: ActiveBlocker[] = [];

  const oi = await queryable.query(
    `SELECT plant, order_date AS "orderDate", csv_file_name AS "csvFileName"
     FROM order_import_sessions
     WHERE is_deleted IS NOT TRUE AND scan_status <> 'completed' AND ($1::text IS NULL OR plant = $1)
       AND order_date <= $2`,
    [plant, orderDateUpTo],
  );
  for (const r of oi.rows) blockers.push({ source: 'Order Import', plant: r.plant, orderDate: r.orderDate, label: r.csvFileName });

  const ul = await queryable.query(
    `SELECT plant, order_date AS "orderDate", vehicle_number AS "vehicleNumber"
     FROM unload_import_sessions
     WHERE is_deleted IS NOT TRUE AND scan_status <> 'completed' AND ($1::text IS NULL OR plant = $1)
       AND order_date <= $2`,
    [plant, orderDateUpTo],
  );
  for (const r of ul.rows) blockers.push({ source: 'Unloading', plant: r.plant, orderDate: r.orderDate, label: r.vehicleNumber });

  // Loading has no scanStatus column — "still open" here means a vehicle was actually assigned
  // (loading genuinely started, not just a Notion-suggested vehicle nobody's confirmed) but the
  // load hasn't been marked complete yet.
  const ld = await queryable.query(
    `SELECT plant, order_date AS "orderDate", order_number AS "orderNumber"
     FROM proforma_slips
     WHERE vehicle_assigned_by_code IS NOT NULL AND loading_completed_at IS NULL AND ($1::text IS NULL OR plant = $1)
       AND order_date <= $2::date`,
    [plant, orderDateUpTo],
  );
  for (const r of ld.rows) blockers.push({ source: 'Loading', plant: r.plant, orderDate: r.orderDate, label: r.orderNumber });

  return blockers;
}

function describeBlockers(blockers: ActiveBlocker[]): string {
  return blockers
    .slice(0, 5)
    .map((b) => `${b.source} — ${b.label} (${b.plant}${b.orderDate ? `, ${b.orderDate}` : ''})`)
    .join('; ') + (blockers.length > 5 ? `; and ${blockers.length - 5} more` : '');
}

// GET /api/settings/clear-stock/preview?plant=<name|all>&orderDateUpTo=<YYYY-MM-DD> — impact
// count shown in the dialog before the user can type the confirm phrase. orderDateUpTo is
// optional — omitted, this behaves exactly as before (every stock row for the plant scope).
// Stock-only, matching what the action itself now does.
router.get('/settings/clear-stock/preview', requireAdminRole, async (req: Request, res: Response) => {
  try {
    const plantParam = typeof req.query.plant === 'string' ? req.query.plant.trim() : '';
    const plant = plantParam && plantParam.toLowerCase() !== 'all' ? plantParam : null;
    const dateParam = typeof req.query.orderDateUpTo === 'string' && req.query.orderDateUpTo.trim() ? req.query.orderDateUpTo.trim() : null;

    // Stock row count is never date-scoped — a stock row has no order date of its own (it's a
    // running total); the date filter narrows WHICH transactions get reversed, not which rows
    // show up here at all.
    const stockRes = await pool.query(
      `SELECT COUNT(*)::int AS n FROM stock_v2_lines
       WHERE stock_qty <> 0 AND ($1::text IS NULL OR LOWER(plant) = LOWER($1))`,
      [plant],
    );

    // Only relevant once a date is picked — a no-date clear is unaffected (see
    // findActiveBlockers's comment).
    const activeBlockers = dateParam ? await findActiveBlockers(pool, plant, dateParam) : [];

    res.json({
      productsWithStock: stockRes.rows[0]?.n ?? 0,
      dateScoped: dateParam != null,
      activeBlockers,
      canClear: activeBlockers.length === 0,
    });
  } catch (error) {
    console.error('Error building clear-stock preview:', error);
    res.status(500).json({ message: 'Failed to load impact preview' });
  }
});

// POST /api/settings/clear-stock — body: { plant: string | 'all', orderDateUpTo?: 'YYYY-MM-DD' }
// Stock-only (see header comment) — never touches Order Import/Loading/Unloading scan history.
router.post('/settings/clear-stock', requireAdminRole, async (req: Request, res: Response) => {
  const plantParam = typeof req.body?.plant === 'string' ? req.body.plant.trim() : '';
  if (!plantParam) return res.status(400).json({ message: 'Plant is required' });
  const plant = plantParam.toLowerCase() === 'all' ? null : plantParam;
  const dateParam = typeof req.body?.orderDateUpTo === 'string' && req.body.orderDateUpTo.trim() ? req.body.orderDateUpTo.trim() : null;
  const { userCode, userName } = actor(req);

  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    // Re-checked here, not just in the preview — never trust a client-only gate for something
    // this destructive. See findActiveBlockers's comment for why an open session anywhere in
    // the plant scope blocks a date-scoped clear outright.
    if (dateParam) {
      const activeBlockers = await findActiveBlockers(client, plant, dateParam);
      if (activeBlockers.length > 0) {
        await client.query('ROLLBACK');
        return res.status(409).json({
          message: `Cannot clear stock up to ${dateParam} — still-open session(s) in scope: ${describeBlockers(activeBlockers)}. Finish or complete these first.`,
        });
      }
    }

    let stockRowsAffectedCount = 0;
    if (!dateParam) {
      // No date scope — original behavior, exact and simple: everything in the plant scope is
      // being cleared, so nothing is left behind that stock could still legitimately belong to.
      const { rows: lines } = await client.query(
        `SELECT id, stock_qty FROM stock_v2_lines WHERE stock_qty <> 0 AND ($1::text IS NULL OR LOWER(plant) = LOWER($1)) FOR UPDATE`,
        [plant],
      );
      stockRowsAffectedCount = lines.length;
      for (const l of lines) {
        await postAdjust(client, l.id, todayIst(), -Number(l.stock_qty), { kind: 'clear', source: 'clear', origin: 'settings', reason: 'Clear Stock (Settings)', userCode: userCode ?? null });
      }
    } else {
      // Date scope — set-to-0 would be wrong (see header comment). Compute the precise delta the
      // in-scope transactions contributed and reverse only that: receiving (Order Import +
      // Unloading) added stock, so it subtracts; Loading (dispatch) removed stock, so it adds
      // back. extra_qty on product_plant_stock is only ever touched by Order Import's receiving
      // side (see applyLiveScanStock) — Unloading and Loading never adjust it. This only READS
      // those scan-event tables to compute the delta — nothing here writes to them.
      const { rows: receivingRows } = await client.query(
        `SELECT e.barcode, s.plant,
                SUM(e.total_qty)::int AS total,
                SUM(e.total_qty) FILTER (WHERE e.is_extra)::int AS extra
         FROM order_scan_events e JOIN order_import_sessions s ON s.id = e.session_id
         WHERE e.voided IS NOT TRUE AND ($1::text IS NULL OR s.plant = $1) AND s.order_date <= $2
         GROUP BY e.barcode, s.plant`,
        [plant, dateParam],
      );
      const { rows: unloadingRows } = await client.query(
        `SELECT e.barcode, e.plant, SUM(e.total_qty)::int AS total
         FROM unload_scan_events e JOIN unload_import_sessions s ON s.id = e.session_id
         WHERE e.voided IS NOT TRUE AND ($1::text IS NULL OR e.plant = $1) AND s.order_date <= $2
         GROUP BY e.barcode, e.plant`,
        [plant, dateParam],
      );
      const { rows: loadingRows } = await client.query(
        `SELECT lse.barcode, lse.plant, SUM(lse.total_qty)::int AS total
         FROM loading_scan_events lse JOIN proforma_slips ps ON ps.order_number = lse.order_number
         WHERE lse.voided IS NOT TRUE AND ($1::text IS NULL OR lse.plant = $1) AND ps.order_date <= $2::date
         GROUP BY lse.barcode, lse.plant`,
        [plant, dateParam],
      );

      const deltaByKey = new Map<string, { barcode: string; plant: string; inStockDelta: number; extraQtyDelta: number }>();
      const bump = (barcode: string, plantName: string, inStockDelta: number, extraQtyDelta: number) => {
        const key = `${barcode.toLowerCase()}::${plantName.toLowerCase()}`;
        const cur = deltaByKey.get(key) ?? { barcode, plant: plantName, inStockDelta: 0, extraQtyDelta: 0 };
        cur.inStockDelta += inStockDelta;
        cur.extraQtyDelta += extraQtyDelta;
        deltaByKey.set(key, cur);
      };
      for (const r of receivingRows as any[]) bump(r.barcode, r.plant, -Number(r.total ?? 0), -Number(r.extra ?? 0));
      for (const r of unloadingRows as any[]) bump(r.barcode, r.plant, -Number(r.total ?? 0), 0);
      for (const r of loadingRows as any[]) bump(r.barcode, r.plant, Number(r.total ?? 0), 0);

      for (const d of deltaByKey.values()) {
        if (d.inStockDelta === 0) continue;
        await v2Adjust(client, { plant: d.plant, barcode: d.barcode, qty: d.inStockDelta, kind: 'clear', reason: 'Clear Stock (Settings) — up to ' + dateParam, userCode });
        stockRowsAffectedCount += 1;
      }
    }

    await client.query('COMMIT');

    if (userCode) {
      await storage.logActivity({
        pageName: 'Settings',
        action: 'delete',
        entityType: 'clear_stock',
        entityId: plant ?? 'all',
        details: `Clear Stock run by ${userName ?? userCode} — plant: ${plant ?? 'All Plants'}`
          + (dateParam ? `, orders up to ${dateParam}` : '') + `. `
          + `${stockRowsAffectedCount} stock row(s) adjusted.`,
        userCode,
        userName,
      });
    }

    res.json({
      success: true,
      plant: plant ?? 'all',
      orderDateUpTo: dateParam,
      stockRowsCleared: stockRowsAffectedCount,
    });
  } catch (error) {
    await client.query('ROLLBACK');
    console.error('Error clearing stock:', error);
    res.status(500).json({ message: 'Failed to clear stock' });
  } finally {
    client.release();
  }
});

// ── Settings > Data Management > "Daily Notion sync" ─────────────────────────────────────────────────────
// Admin only. GET: the switch, the India-time run time, when it runs next and how the last run went. PUT { enabled?, runTime? }: change them
// (switching on or changing the time sets one fresh timer; switching off removes it). POST run-now: both steps back to back, once, in the
// background. See server/services/dailyNotionSync.ts.
async function dailySyncView() {
  const cfg = await getDailySyncConfig();
  return { ...cfg, running: isDailySyncRunning(), nextRunAt: cfg.enabled ? new Date(Date.now() + msUntilNextRun(cfg.runTime)).toISOString() : null };
}
router.get('/settings/daily-notion-sync', requireAdminRole, async (_req: Request, res: Response) => {
  try { res.json(await dailySyncView()); }
  catch (error) { console.error('Error reading the daily Notion sync setting:', error); res.status(500).json({ message: 'Failed to read the daily Notion sync setting' }); }
});
router.put('/settings/daily-notion-sync', requireAdminRole, async (req: Request, res: Response) => {
  try {
    const patch: { enabled?: boolean; runTime?: string } = {};
    if (req.body?.enabled !== undefined) {
      if (typeof req.body.enabled !== 'boolean') return res.status(400).json({ message: 'enabled must be true or false' });
      patch.enabled = req.body.enabled;
    }
    if (req.body?.runTime !== undefined) {
      if (!isValidRunTime(req.body.runTime)) return res.status(400).json({ message: 'runTime must be a time like 06:00' });
      patch.runTime = req.body.runTime;
    }
    const { userCode, userName } = actor(req);
    await saveDailySyncConfig(patch, userName ?? userCode ?? 'admin');
    if (userCode) {
      await storage.logActivity({
        pageName: 'Settings', action: 'update', entityType: 'daily_notion_sync', entityId: 'daily-notion-sync',
        details: `Daily Notion sync set by ${userName ?? userCode}:${patch.enabled !== undefined ? ` ${patch.enabled ? 'on' : 'off'}` : ''}${patch.runTime ? ` at ${patch.runTime} IST` : ''}`,
        userCode, userName,
      });
    }
    res.json(await dailySyncView());
  } catch (error) {
    console.error('Error saving the daily Notion sync setting:', error);
    res.status(500).json({ message: 'Failed to save the daily Notion sync setting' });
  }
});
router.post('/settings/daily-notion-sync/run-now', requireAdminRole, async (req: Request, res: Response) => {
  try {
    const { userCode, userName } = actor(req);
    runDailySyncNow(userName ?? userCode ?? 'admin');
    res.json({ started: true });
  } catch (error) {
    res.status(409).json({ message: error instanceof Error ? error.message : 'Could not start the sync' });
  }
});

// GET /api/settings/sales-tracking-start — the date Stock Overview's ledger starts summing Sale
// Qty from in its "all dates" view (proforma data before this date isn't reliable). Was a
// hardcoded constant in scan-sessions.ts; now a single admin-editable row (see sales_settings in
// server/index.ts's migration block / salesSettings in shared/schema.ts).
router.get('/settings/sales-tracking-start', requireAdminRole, async (_req: Request, res: Response) => {
  try {
    const { rows } = await pool.query(`SELECT sales_tracking_start_date AS "salesTrackingStartDate" FROM sales_settings ORDER BY id LIMIT 1`);
    res.json({ salesTrackingStartDate: rows[0]?.salesTrackingStartDate ?? '2026-08-01' });
  } catch (error) {
    console.error('Error fetching sales tracking start date:', error);
    res.status(500).json({ message: 'Failed to fetch sales tracking start date' });
  }
});

// PUT /api/settings/sales-tracking-start — body: { date: 'YYYY-MM-DD' }
router.put('/settings/sales-tracking-start', requireAdminRole, async (req: Request, res: Response) => {
  try {
    const date = typeof req.body?.date === 'string' ? req.body.date.trim() : '';
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) {
      return res.status(400).json({ message: 'date must be in YYYY-MM-DD format' });
    }
    const { userCode } = actor(req);
    const { rows } = await pool.query(
      `UPDATE sales_settings SET sales_tracking_start_date = $1, updated_at = NOW(), updated_by_code = $2
       WHERE id = (SELECT id FROM sales_settings ORDER BY id LIMIT 1)
       RETURNING sales_tracking_start_date AS "salesTrackingStartDate"`,
      [date, userCode ?? null],
    );
    if (!rows[0]) {
      // No row yet (shouldn't happen — server startup seeds one) — insert instead of failing.
      const inserted = await pool.query(
        `INSERT INTO sales_settings (sales_tracking_start_date, updated_by_code) VALUES ($1, $2)
         RETURNING sales_tracking_start_date AS "salesTrackingStartDate"`,
        [date, userCode ?? null],
      );
      return res.json({ salesTrackingStartDate: inserted.rows[0].salesTrackingStartDate });
    }
    res.json({ salesTrackingStartDate: rows[0].salesTrackingStartDate });
  } catch (error) {
    console.error('Error updating sales tracking start date:', error);
    res.status(500).json({ message: 'Failed to update sales tracking start date' });
  }
});

// ── Settings > Data Management > "Remove All Operations Data" ───────────────────────────────────
// Admin-only. Deletes the day-to-day WORK of a plant (or of every plant) from the database for
// good: order scanning (sessions, items, events), unloading (batches, items, events), loading
// (records, scan events, handoffs, load operations), stock (Stock Overview: the lines' book), and the legacy scan-history tables.
//
// Optionally scoped to an ORDER DATE: "remove everything up to 15 Sep" means everything belonging
// to orders DATED on or before 15 Sep — never the day someone happened to scan it. Each area has
// its own order date and every rule below uses that one:
//   Order scanning  → order_import_sessions.order_date  (the date picked when the CSV was uploaded)
//   Unloading       → unload_import_sessions.order_date
//   Loading         → the PROFORMA SLIP's order_date (records/scans/handoffs all hang off the slip)
//   Load operations → its own order_date column
//   Stock movements → the order date of the order the movement came from; a movement with no order
//                     (manual Adjust, Opening Stock, exchange, Clear Stock) uses the day it was
//                     made — the same rule the Stock Overview ledger already follows
//   Old scan history→ the slip's order_date
// Rows that have no order date at all (the activity log, the legacy scan_sessions tables) are only
// removed by a full, no-date reset; a date-scoped reset leaves them alone rather than guessing.
//
// Stock Overview needs its own treatment when a date is set: a line is a running TOTAL, so deleting it would also throw away stock that orders AFTER
// the cutoff brought in. With a date, the in-scope operations are therefore taken back off the book exactly - receiving and unloading are reversed
// on the day they posted, every loading entry is given back to its line. With no date every stock line in the plant scope is wiped (days, corrections,
// Stock back to 0).
//
// Deliberately KEPT either way: Product Master, Vehicle Master, proforma slips (only their loading
// progress is reset, so an order can be loaded again from scratch), users, plants and settings.
// Nothing here can be undone — the rows are deleted, not voided — so it is gated by an impact
// preview, a typed confirm phrase, the same still-open-session check Clear Stock uses, and every
// run is written to the activity log.
type ResetCounts = {
  orderSessions: number; orderItems: number; orderScanItems: number; orderScanEvents: number;
  unloadSessions: number; unloadItems: number; unloadScanEvents: number;
  loadingRecords: number; loadingScanEvents: number; loadingHandoffs: number;
  loadOperations: number; loadOperationItems: number;
  stockRows: number; stockMovements: number;
  scanHistory: number; legacyScanSessions: number;
  slipsLoadingReset: number; activities: number;
};
type ResetPart = { key: keyof ResetCounts; table: string; where: string };

// $1 = plant (NULL = every plant), $2 = order date cut-off as text (NULL = no cut-off).
const PLANT_MATCH = `($1::text IS NULL OR LOWER(TRIM(plant)) = LOWER(TRIM($1)))`;
// order_import_sessions.order_date and unload_import_sessions.order_date are TEXT in ISO form, so
// they compare as text; proforma_slips.order_date is a real date and load_operations.order_date a
// timestamp, so those get an explicit cast. Each statement casts $2 the one way it needs.
const ORDER_SESSIONS_IN_SCOPE = `SELECT id FROM order_import_sessions WHERE ${PLANT_MATCH} AND ($2::text IS NULL OR order_date <= $2::text)`;
const UNLOAD_SESSIONS_IN_SCOPE = `SELECT id FROM unload_import_sessions WHERE ${PLANT_MATCH} AND ($2::text IS NULL OR order_date <= $2::text)`;
const SLIP_NUMBERS_IN_SCOPE = `SELECT order_number FROM proforma_slips WHERE ${PLANT_MATCH} AND ($2::text IS NULL OR order_date <= $2::date)`;

function resetScope(dateScoped: boolean): ResetPart[] {
  const parts: ResetPart[] = [
    // Strictly by session. A scan row of a LATER part that points at an in-scope CSV row (this
    // happens after a remap) is left alone — its foreign key is ON DELETE SET NULL, so nothing
    // breaks, and that part's own scanning is not this removal's to take.
    { key: 'orderScanEvents', table: 'order_scan_events', where: `session_id IN (${ORDER_SESSIONS_IN_SCOPE})` },
    { key: 'orderScanItems', table: 'order_scan_items', where: `session_id IN (${ORDER_SESSIONS_IN_SCOPE})` },
    { key: 'orderItems', table: 'order_import_items', where: `session_id IN (${ORDER_SESSIONS_IN_SCOPE})` },
    { key: 'orderSessions', table: 'order_import_sessions', where: `id IN (${ORDER_SESSIONS_IN_SCOPE})` },
    { key: 'unloadScanEvents', table: 'unload_scan_events', where: `session_id IN (${UNLOAD_SESSIONS_IN_SCOPE})` },
    { key: 'unloadItems', table: 'unload_import_items', where: `session_id IN (${UNLOAD_SESSIONS_IN_SCOPE})` },
    { key: 'unloadSessions', table: 'unload_import_sessions', where: `id IN (${UNLOAD_SESSIONS_IN_SCOPE})` },
    // Loading is dated by its proforma slip, never by when the boxes were scanned onto the vehicle.
    { key: 'loadingScanEvents', table: 'loading_scan_events', where: `${PLANT_MATCH} AND ($2::text IS NULL OR order_number IN (${SLIP_NUMBERS_IN_SCOPE}))` },
    { key: 'loadingRecords', table: 'loading_records', where: `${PLANT_MATCH} AND ($2::text IS NULL OR order_number IN (${SLIP_NUMBERS_IN_SCOPE}))` },
    { key: 'loadingHandoffs', table: 'loading_handoffs', where: `order_number IN (${SLIP_NUMBERS_IN_SCOPE})` },
    { key: 'loadOperationItems', table: 'load_operations_items', where: `load_operations_id IN (SELECT id FROM load_operations WHERE ${PLANT_MATCH} AND ($2::text IS NULL OR order_date::date <= $2::date))` },
    { key: 'loadOperations', table: 'load_operations', where: `${PLANT_MATCH} AND ($2::text IS NULL OR order_date::date <= $2::date)` },
    { key: 'scanHistory', table: 'scan_history', where: `order_number IN (${SLIP_NUMBERS_IN_SCOPE})` },
  ];
  if (!dateScoped) {
    // Only a full reset deletes these: the legacy scan tables carry no order date to judge them by.
    parts.push({ key: 'legacyScanSessions', table: 'scan_sessions', where: `${PLANT_MATCH} AND $2::text IS NULL` });
  }
  return parts;
}

// Legacy per-session children of scan_sessions — emptied alongside it, counted under it.
const LEGACY_SCAN_CHILDREN = ['scan_session_pallet_scans', 'scan_session_items', 'scan_session_extras'];

const SLIPS_LOADING_WHERE = `${PLANT_MATCH} AND ($2::text IS NULL OR order_date <= $2::date)
  AND (vehicle_assigned_by_code IS NOT NULL OR loading_completed_at IS NOT NULL
       OR loading_owner_code IS NOT NULL OR loading_paused_at IS NOT NULL OR loading_stv IS NOT NULL)`;

const EMPTY_COUNTS: ResetCounts = {
  orderSessions: 0, orderItems: 0, orderScanItems: 0, orderScanEvents: 0,
  unloadSessions: 0, unloadItems: 0, unloadScanEvents: 0,
  loadingRecords: 0, loadingScanEvents: 0, loadingHandoffs: 0,
  loadOperations: 0, loadOperationItems: 0,
  stockRows: 0, stockMovements: 0,
  scanHistory: 0, legacyScanSessions: 0,
  slipsLoadingReset: 0, activities: 0,
};

const countedAsDeleted = (counts: ResetCounts) =>
  (Object.keys(counts) as (keyof ResetCounts)[])
    .filter((key) => key !== 'slipsLoadingReset')
    .reduce((sum, key) => sum + counts[key], 0);

async function countResetScope(plant: string | null, orderDateUpTo: string | null): Promise<ResetCounts> {
  const counts: ResetCounts = { ...EMPTY_COUNTS };
  for (const part of resetScope(!!orderDateUpTo)) {
    const { rows } = await pool.query(`SELECT COUNT(*)::int AS n FROM ${part.table} WHERE ${part.where}`, [plant, orderDateUpTo]);
    counts[part.key] = rows[0]?.n ?? 0;
  }
  const { rows: slipRows } = await pool.query(
    `SELECT COUNT(*)::int AS n FROM proforma_slips WHERE ${SLIPS_LOADING_WHERE}`, [plant, orderDateUpTo],
  );
  counts.slipsLoadingReset = slipRows[0]?.n ?? 0;
  // Stock Overview lines: wiped with no date; with a date, the lines that currently hold stock are the ones the reversal can move.
  const { rows: stockRows } = await pool.query(
    `SELECT COUNT(*)::int AS n FROM stock_v2_lines WHERE ${PLANT_MATCH} AND ($2::text IS NULL OR stock_qty <> 0)`,
    [plant, orderDateUpTo],
  );
  counts.stockRows = stockRows[0]?.n ?? 0;
  // Activity log: only ever in scope for a full all-plants reset (it has no plant and no order date).
  if (plant === null && !orderDateUpTo) {
    const { rows: actRows } = await pool.query(`SELECT COUNT(*)::int AS n FROM activities`);
    counts.activities = actRows[0]?.n ?? 0;
  }
  return counts;
}

// The phrase the person has to type, so a mis-click can never run this.
const resetConfirmPhrase = (plantParam: string) =>
  (plantParam.toLowerCase() === 'all' ? 'DELETE ALL' : `DELETE ${plantParam}`).toUpperCase();

// GET /api/settings/reset-operations/preview?plant=<name|all>&orderDateUpTo=<YYYY-MM-DD>
// Exactly what would be removed, plus any still-open session that blocks a date-scoped run.
router.get('/settings/reset-operations/preview', requireAdminRole, async (req: Request, res: Response) => {
  try {
    const plantParam = typeof req.query.plant === 'string' ? req.query.plant.trim() : '';
    if (!plantParam) return res.status(400).json({ message: 'Plant is required' });
    const plant = plantParam.toLowerCase() === 'all' ? null : plantParam;
    const orderDateUpTo = typeof req.query.orderDateUpTo === 'string' && req.query.orderDateUpTo.trim()
      ? req.query.orderDateUpTo.trim() : null;

    const counts = await countResetScope(plant, orderDateUpTo);
    // Same rule as Clear Stock: an unfinished session's numbers aren't final, so its stock can't be
    // reversed reliably. Only a date-scoped run reverses anything, so only it is blocked.
    const activeBlockers = orderDateUpTo ? await findActiveBlockers(pool, plant, orderDateUpTo) : [];
    res.json({
      counts,
      totalRows: countedAsDeleted(counts),
      dateScoped: !!orderDateUpTo,
      activeBlockers,
      canReset: activeBlockers.length === 0,
      confirmPhrase: resetConfirmPhrase(plantParam),
    });
  } catch (error) {
    console.error('Error building reset preview:', error);
    res.status(500).json({ message: 'Failed to build the reset preview' });
  }
});

// POST /api/settings/reset-operations { plant, orderDateUpTo?, confirm } — all or nothing.
router.post('/settings/reset-operations', requireAdminRole, async (req: Request, res: Response) => {
  const plantParam = typeof req.body?.plant === 'string' ? req.body.plant.trim() : '';
  if (!plantParam) return res.status(400).json({ message: 'Plant is required' });
  const confirm = typeof req.body?.confirm === 'string' ? req.body.confirm.trim().toUpperCase() : '';
  // Re-checked on the server, never trusted from the client alone — this cannot be undone.
  if (confirm !== resetConfirmPhrase(plantParam)) {
    return res.status(400).json({ message: `Type ${resetConfirmPhrase(plantParam)} to confirm this reset.` });
  }
  const plant = plantParam.toLowerCase() === 'all' ? null : plantParam;
  const orderDateUpTo = typeof req.body?.orderDateUpTo === 'string' && req.body.orderDateUpTo.trim()
    ? req.body.orderDateUpTo.trim() : null;
  const { userCode, userName } = actor(req);

  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    if (orderDateUpTo) {
      const activeBlockers = await findActiveBlockers(client, plant, orderDateUpTo);
      if (activeBlockers.length > 0) {
        await client.query('ROLLBACK');
        return res.status(409).json({
          message: `Cannot remove data up to ${orderDateUpTo} — still-open session(s) in scope: ${describeBlockers(activeBlockers)}. Finish or complete these first.`,
        });
      }
    }

    const counts: ResetCounts = { ...EMPTY_COUNTS };

    // 1. Stock Overview, before the entries are deleted: with a date, take the in-scope operations back off the book exactly (receiving and unloading
    //    on the day they posted, loading given back to its line); with no date, wipe every line in the plant scope.
    if (orderDateUpTo) {
      const orderIds = (await client.query(ORDER_SESSIONS_IN_SCOPE, [plant, orderDateUpTo])).rows.map((r) => r.id as number);
      const unloadIds = (await client.query(UNLOAD_SESSIONS_IN_SCOPE, [plant, orderDateUpTo])).rows.map((r) => r.id as number);
      const slipNumbers = (await client.query(SLIP_NUMBERS_IN_SCOPE, [plant, orderDateUpTo])).rows.map((r) => String(r.order_number));
      const a = await reverseOrderSessions(client, orderIds);
      const b = await reverseUnloadSessions(client, unloadIds);
      const c = await reverseLoadingOrders(client, slipNumbers);
      counts.stockRows = a.lines + b.lines + c.entries;
    } else {
      const lines = await client.query(`SELECT id FROM stock_v2_lines WHERE ${PLANT_MATCH}`, [plant]);
      const ids = lines.rows.map((r) => r.id as number);
      if (ids.length) {
        await client.query(`DELETE FROM stock_v2_daily WHERE line_id = ANY($1::int[])`, [ids]);
        await client.query(`DELETE FROM stock_v2_ledger WHERE line_id = ANY($1::int[])`, [ids]);
        await client.query(`DELETE FROM stock_v2_links WHERE line_id = ANY($1::int[])`, [ids]);
        await client.query(`UPDATE stock_v2_lines SET stock_qty = 0, updated_at = now() WHERE id = ANY($1::int[])`, [ids]);
      }
      counts.stockRows = ids.length;
    }

    // 2. The deletions. Children before parents, since a child's scope is defined by its parent.
    for (const part of resetScope(!!orderDateUpTo)) {
      if (part.key === 'legacyScanSessions') {
        for (const childTable of LEGACY_SCAN_CHILDREN) {
          await client.query(
            `DELETE FROM ${childTable} WHERE session_id IN (SELECT id FROM scan_sessions WHERE ${part.where})`,
            [plant, orderDateUpTo],
          );
        }
      }
      let result;
      try {
        result = await client.query(`DELETE FROM ${part.table} WHERE ${part.where}`, [plant, orderDateUpTo]);
      } catch (error) {
        throw new Error(`while clearing ${part.table}: ${error instanceof Error ? error.message : String(error)}`);
      }
      counts[part.key] = result.rowCount ?? 0;
    }

    // 3. Proforma slips themselves stay — only the loading progress on them is wiped, so each order
    //    can be loaded again from the beginning instead of looking half-loaded with no records.
    const slipReset = await client.query(
      `UPDATE proforma_slips SET
         loading_completed_at = NULL, loading_completed_by_code = NULL, vehicle_assigned_by_code = NULL,
         loading_owner_code = NULL, loading_owner_name = NULL, loading_paused_at = NULL, loading_stv = NULL
       WHERE ${SLIPS_LOADING_WHERE}`,
      [plant, orderDateUpTo],
    );
    counts.slipsLoadingReset = slipReset.rowCount ?? 0;

    if (plant === null && !orderDateUpTo) {
      const act = await client.query(`DELETE FROM activities`);
      counts.activities = act.rowCount ?? 0;
    }
    await client.query('COMMIT');

    const mirrorWarning: string | null = null;

    // Logged after the commit — for a full all-plants reset the log was just emptied, so this row is
    // the first entry of the fresh history, saying who did it and what went.
    const totalRows = countedAsDeleted(counts);
    await storage.createActivity({
      pageName: 'Settings',
      action: 'delete',
      entityType: 'reset_operations',
      entityId: plant ?? 'all',
      details: `Removed operations data for ${plant ?? 'all plants'}`
        + (orderDateUpTo ? `, orders up to ${orderDateUpTo}` : '')
        + ` by ${userName ?? userCode}: ${totalRows} row(s) deleted `
        + `(order scanning ${counts.orderSessions} CSV(s) / ${counts.orderScanEvents} scan(s), `
        + `unloading ${counts.unloadSessions} batch(es) / ${counts.unloadScanEvents} scan(s), `
        + `loading ${counts.loadingRecords} record(s) / ${counts.loadingScanEvents} scan(s), `
        + `${counts.stockRows} stock line(s) ${orderDateUpTo ? 'reduced by what was removed' : 'wiped'}); `
        + `${counts.slipsLoadingReset} proforma slip(s) reset for loading.`,
      userCode,
      userName,
    });

    res.json({ success: true, counts, totalRows, dateScoped: !!orderDateUpTo, orderDateUpTo, warning: mirrorWarning });
  } catch (error) {
    await client.query('ROLLBACK');
    console.error('Error resetting operations data:', error);
    // The real reason, not a generic line: this is an admin-only screen, the message names the
    // table that refused, and without it there is nothing to act on but the server log.
    res.status(500).json({
      message: `Failed to remove operations data — nothing was deleted (${error instanceof Error ? error.message : String(error)}).`,
    });
  } finally {
    client.release();
  }
});

// ── Settings > Data Management > "Backup CSV" ───────────────────────────────────────────────────
// Writes one <table>.csv per table into backups/<database>-csv-<date>_<time>/ on the server — the
// same folder layout scripts/backup-database-csv.ps1 produces, so scripts/restore-database-csv.ps1
// loads it back unchanged. Runs inside the app (no psql, no PowerShell), so a backup is one button
// instead of a terminal session.
//
// Only one at a time: the export walks every table, and two of them running together would just
// slow each other down and leave two half-written folders.
let csvBackupRunning = false;

router.post('/settings/backup-csv', requireAdminRole, async (req: Request, res: Response) => {
  if (csvBackupRunning) {
    return res.status(409).json({ message: 'A backup is already running — wait for it to finish.' });
  }
  csvBackupRunning = true;
  const { userCode, userName } = actor(req);
  try {
    const result = await runCsvBackup();
    const megabytes = result.totalBytes / (1024 * 1024);
    await storage.createActivity({
      pageName: 'Settings',
      action: 'create',
      entityType: 'backup_csv',
      entityId: result.folder,
      details: `CSV backup by ${userName ?? userCode}: ${result.tables.length} table(s), `
        + `${result.totalRows} row(s), ${megabytes.toFixed(1)} MB → ${result.folder}`,
      userCode,
      userName,
    });
    res.json({ success: true, ...result, megabytes });
  } catch (error) {
    console.error('Error running CSV backup:', error);
    res.status(500).json({ message: error instanceof Error ? error.message : 'Failed to write the CSV backup' });
  } finally {
    csvBackupRunning = false;
  }
});

// Operational-data-only backup — every table behind Scan History, Unloading, Loading, Product/
// Plant/Vehicle Master, User Management and Proforma Slip, explicitly WITHOUT the stock_v2_* stock tables or
// anything else. The list is fixed here, not taken from the request, so this can never be
// pointed at an arbitrary table. Shares csvBackupRunning with the full backup above — only one
// backup (of either kind) runs at a time.
const OPERATIONAL_BACKUP_TABLES = [
  // Scan History / Order Scan (receiving)
  'scan_history', 'order_import_sessions', 'order_import_items', 'order_scan_items', 'order_scan_events',
  // Unloading
  'unload_import_sessions', 'unload_import_items', 'unload_scan_events',
  // Loading
  'loading_records', 'loading_scan_events', 'loading_handoffs', 'load_operations', 'load_operations_items',
  // Masters
  'products', 'plants', 'plant_stvs', 'vehicle_info', 'users',
  // Proforma Slip
  'proforma_slips', 'proforma_slip_items',
  // Activity log
  'activities',
];

router.post('/settings/backup-csv-scoped', requireAdminRole, async (req: Request, res: Response) => {
  if (csvBackupRunning) {
    return res.status(409).json({ message: 'A backup is already running — wait for it to finish.' });
  }
  csvBackupRunning = true;
  const { userCode, userName } = actor(req);
  try {
    const result = await runCsvBackup(OPERATIONAL_BACKUP_TABLES);
    const megabytes = result.totalBytes / (1024 * 1024);
    await storage.createActivity({
      pageName: 'Settings',
      action: 'create',
      entityType: 'backup_csv_scoped',
      entityId: result.folder,
      details: `Operational-data CSV backup (no stock tables) by ${userName ?? userCode}: ${result.tables.length} table(s), `
        + `${result.totalRows} row(s), ${megabytes.toFixed(1)} MB → ${result.folder}`,
      userCode,
      userName,
    });
    res.json({ success: true, ...result, megabytes });
  } catch (error) {
    console.error('Error running scoped CSV backup:', error);
    res.status(500).json({ message: error instanceof Error ? error.message : 'Failed to write the CSV backup' });
  } finally {
    csvBackupRunning = false;
  }
});

// ── Settings > Data Management > "Remove Scan & Order Import Data" ──────────────────────────────
// The narrow counterpart to Remove All Operations Data: it touches ONLY the receiving side —
// Order Import CSVs and the Scan Operations work done against them.
//
//   Removed : order_import_sessions + their items, order_scan_items, order_scan_events (the scan
//             history itself, rows deleted outright). Stock Overview is taken back down by exactly what
//             those CSVs received, on the day it was booked.
//   Untouched: Loading and Unloading — their batches, scans, records and their own stock
//             movements all stay, including movements that merely happen to share a session id
//             number with a receiving session (they are told apart by `source`).
//
// Deliberately NO compensating "adjust" entry is written: the request is for these entries to be
// gone, not reversed, so the stock number is corrected in place and the ledger rows are deleted
// with everything else. That means Stock Overview will show this period as if the receiving never
// happened — which is the point — while Loading's own sale figures are left exactly as they are.
//
// Optional order-date cut-off: the date on the CSV (order_import_sessions.order_date), never the
// day someone scanned. Blank removes every receiving CSV for the plant scope.
type ScanResetCounts = {
  sessions: number; importItems: number; scanItems: number; scanEvents: number;
  stockMovements: number; stockRowsAdjusted: number; qtyRemoved: number;
};

const SCAN_SESSIONS_IN_SCOPE = `SELECT id FROM order_import_sessions
  WHERE ($1::text IS NULL OR LOWER(TRIM(plant)) = LOWER(TRIM($1)))
    AND ($2::text IS NULL OR order_date <= $2::text)`;

const scanResetConfirmPhrase = (plantParam: string) =>
  (plantParam.toLowerCase() === 'all' ? 'DELETE SCAN ALL' : `DELETE SCAN ${plantParam}`).toUpperCase();

async function countScanResetScope(plant: string | null, orderDateUpTo: string | null): Promise<ScanResetCounts> {
  const params = [plant, orderDateUpTo];
  const one = async (sql: string) => Number((await pool.query(sql, params)).rows[0]?.n ?? 0);
  const counts: ScanResetCounts = {
    sessions: await one(`SELECT COUNT(*)::int AS n FROM order_import_sessions WHERE id IN (${SCAN_SESSIONS_IN_SCOPE})`),
    importItems: await one(`SELECT COUNT(*)::int AS n FROM order_import_items WHERE session_id IN (${SCAN_SESSIONS_IN_SCOPE})`),
    scanItems: await one(`SELECT COUNT(*)::int AS n FROM order_scan_items WHERE session_id IN (${SCAN_SESSIONS_IN_SCOPE})`),
    scanEvents: await one(`SELECT COUNT(*)::int AS n FROM order_scan_events WHERE session_id IN (${SCAN_SESSIONS_IN_SCOPE})`),
    stockMovements: 0,
    stockRowsAdjusted: 0,
    qtyRemoved: 0,
  };
  // What taking these CSVs off the book would move: the physically received boxes, per CSV and barcode.
  const { rows } = await pool.query(
    `SELECT COUNT(*)::int AS rows, COALESCE(SUM(qty), 0)::int AS qty FROM (
       SELECT e.session_id, LOWER(TRIM(e.barcode)) AS b, SUM(e.total_qty)::int AS qty
         FROM order_scan_events e
        WHERE e.session_id IN (${SCAN_SESSIONS_IN_SCOPE}) AND e.voided IS NOT TRUE AND e.is_credit IS NOT TRUE
          AND e.barcode IS NOT NULL AND e.barcode <> 'EMPTY_BOX'
        GROUP BY 1, 2 HAVING SUM(e.total_qty) <> 0
     ) g`,
    params,
  );
  counts.stockRowsAdjusted = rows[0]?.rows ?? 0;
  counts.qtyRemoved = rows[0]?.qty ?? 0;
  return counts;
}

// GET /api/settings/reset-scan-data/preview?plant=<name|all>&orderDateUpTo=<YYYY-MM-DD>
router.get('/settings/reset-scan-data/preview', requireAdminRole, async (req: Request, res: Response) => {
  try {
    const plantParam = typeof req.query.plant === 'string' ? req.query.plant.trim() : '';
    if (!plantParam) return res.status(400).json({ message: 'Plant is required' });
    const plant = plantParam.toLowerCase() === 'all' ? null : plantParam;
    const orderDateUpTo = typeof req.query.orderDateUpTo === 'string' && req.query.orderDateUpTo.trim()
      ? req.query.orderDateUpTo.trim() : null;
    const counts = await countScanResetScope(plant, orderDateUpTo);
    res.json({
      counts,
      totalRows: counts.sessions + counts.importItems + counts.scanItems + counts.scanEvents + counts.stockMovements,
      dateScoped: !!orderDateUpTo,
      confirmPhrase: scanResetConfirmPhrase(plantParam),
    });
  } catch (error) {
    console.error('Error building the scan-data reset preview:', error);
    res.status(500).json({ message: 'Failed to build the preview' });
  }
});

// POST /api/settings/reset-scan-data { plant, orderDateUpTo?, confirm } — all or nothing.
router.post('/settings/reset-scan-data', requireAdminRole, async (req: Request, res: Response) => {
  const plantParam = typeof req.body?.plant === 'string' ? req.body.plant.trim() : '';
  if (!plantParam) return res.status(400).json({ message: 'Plant is required' });
  const confirm = typeof req.body?.confirm === 'string' ? req.body.confirm.trim().toUpperCase() : '';
  if (confirm !== scanResetConfirmPhrase(plantParam)) {
    return res.status(400).json({ message: `Type ${scanResetConfirmPhrase(plantParam)} to confirm.` });
  }
  const plant = plantParam.toLowerCase() === 'all' ? null : plantParam;
  const orderDateUpTo = typeof req.body?.orderDateUpTo === 'string' && req.body.orderDateUpTo.trim()
    ? req.body.orderDateUpTo.trim() : null;
  const { userCode, userName } = actor(req);
  const params = [plant, orderDateUpTo];

  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const counts: ScanResetCounts = {
      sessions: 0, importItems: 0, scanItems: 0, scanEvents: 0,
      stockMovements: 0, stockRowsAdjusted: 0, qtyRemoved: 0,
    };

    // 1. Take these CSVs back off Stock Overview - the physically received boxes, per CSV and barcode, on the day they were booked - BEFORE the
    //    scans are deleted. No adjust entry is written: these entries are being removed, not reversed.
    const scoped = (await client.query(SCAN_SESSIONS_IN_SCOPE, params)).rows.map((r) => r.id as number);
    const reversed = await reverseOrderSessions(client, scoped);
    counts.stockRowsAdjusted = reversed.lines;
    counts.qtyRemoved = reversed.qty;

    // 2. The deletions - the scanning work, then the CSVs themselves.
    const del = async (sql: string) => (await client.query(sql, params)).rowCount ?? 0;
    counts.scanEvents = await del(`DELETE FROM order_scan_events WHERE session_id IN (${SCAN_SESSIONS_IN_SCOPE})`);
    counts.scanItems = await del(`DELETE FROM order_scan_items WHERE session_id IN (${SCAN_SESSIONS_IN_SCOPE})`);
    counts.importItems = await del(`DELETE FROM order_import_items WHERE session_id IN (${SCAN_SESSIONS_IN_SCOPE})`);
    counts.sessions = await del(`DELETE FROM order_import_sessions WHERE id IN (${SCAN_SESSIONS_IN_SCOPE})`);

    await client.query('COMMIT');

    const mirrorWarning: string | null = null;

    const totalRows = counts.sessions + counts.importItems + counts.scanItems + counts.scanEvents + counts.stockMovements;
    await storage.createActivity({
      pageName: 'Settings',
      action: 'delete',
      entityType: 'reset_scan_data',
      entityId: plant ?? 'all',
      details: `Removed scan & order import data for ${plant ?? 'all plants'}`
        + (orderDateUpTo ? `, orders up to ${orderDateUpTo}` : '')
        + ` by ${userName ?? userCode}: ${counts.sessions} CSV(s), ${counts.importItems} item(s), `
        + `${counts.scanEvents} scan(s), ${counts.stockMovements} stock movement(s) deleted; `
        + `${counts.stockRowsAdjusted} stock row(s) reduced by ${counts.qtyRemoved} box(es). `
        + `Loading and Unloading untouched.`,
      userCode,
      userName,
    });

    res.json({ success: true, counts, totalRows, dateScoped: !!orderDateUpTo, orderDateUpTo, warning: mirrorWarning });
  } catch (error) {
    await client.query('ROLLBACK');
    console.error('Error removing scan & order import data:', error);
    res.status(500).json({
      message: `Failed to remove scan & order import data — nothing was deleted (${error instanceof Error ? error.message : String(error)}).`,
    });
  } finally {
    client.release();
  }
});

export default router;
