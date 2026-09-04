import { Router, Request, Response } from 'express';
import { storage } from '../storage';
import { pool } from '../db';
import { requireAdminRole } from '../lib/pageAccess';

// Settings > Data Management > "Clear Stock" — a highly destructive admin-only action that
// removes receiving (Order Import/Scan Order), Loading dispatch, and Unloading scan history for
// a chosen plant (or every plant), optionally scoped further to only orders/slips dated on or
// before a chosen Order Date. Two things happen, always in one transaction:
//   1. Stock:
//      - No date scope (the original, still-default behavior): product_plant_stock.in_stock/
//        extra_qty -> 0 outright for the plant scope. Exact and simple, since everything in that
//        scope is being cleared — nothing is left behind that stock could still legitimately
//        belong to.
//      - Date scope: setting to 0 would be WRONG here — it would also wipe out stock earned by
//        transactions dated AFTER the cutoff, which aren't being cleared. Instead this computes
//        the precise delta the in-scope (date-filtered) transactions contributed — sum of
//        receiving (Order Import + Unloading, both add stock) minus sum of dispatch (Loading,
//        removes stock) for each barcode+plant — and subtracts only that, the same "reverse
//        exactly what this scope contributed" idea the per-CSV delete/edit flows already use, just
//        at the scale of a whole date range. This is a best-effort reversal: it assumes stock
//        equals the sum of tracked events for the in-scope period (true in normal operation, but
//        an Opening Stock bulk-set or an untracked manual adjustment inside that period would
//        throw it off) — full historical ledger replay isn't feasible here.
//      Either way: a stock_movements 'adjust' audit row per affected barcode+plant, and
//      products.in_stock (the legacy cross-plant mirror) recomputed as the live sum of
//      product_plant_stock so clearing one plant never wipes out a product's stock that still
//      legitimately exists elsewhere.
//   2. Scan history, in one of two modes the caller picks, each now scoped by order date too when
//      one is given (Order Import/Unloading via their own order_date column; Loading via a join to
//      proforma_slips.order_date, since loading_scan_events/loading_records don't carry a date of
//      their own):
//      - 'void': mark rows voided (order_scan_events, loading_scan_events, unload_scan_events —
//        existing void columns) and soft-delete order_import_sessions/unload_import_sessions
//        (existing isDeleted columns). Rows are never physically touched — same audit-preserving
//        pattern used everywhere else in the app. loading_records is left alone; it's a link-log,
//        not scan history.
//      - 'remove': hard DELETE. Deleting order_import_sessions cascades (verified live FK
//        constraints, not just declared in schema.ts) to order_import_items, order_scan_items,
//        and order_scan_events automatically; deleting unload_import_sessions likewise cascades
//        to unload_import_items and unload_scan_events. loading_scan_events/loading_records have
//        no FK relationship to anything else, so they're deleted directly (via a join to
//        proforma_slips when date-scoped, since they carry no date of their own). stock_movements
//        — the append-only ledger Overall Stock's "click a product" drill-down reads straight from
//        (see /reports/stock-movements in scan-sessions.ts) — has NO FK link to any of the above:
//        with no date scope, every row for the plant is deleted unconditionally (any type — an
//        'adjust' row includes a scan VOID's stock reversal too, not just Opening Stock, so a type
//        carve-out left history behind before this was fixed). With a date scope, only rows whose
//        session_id matches an in-scope Order Import/Unloading session are deleted — Loading's own
//        dispatch movements carry no session_id linking them back to a proforma slip's order date,
//        so a date-scoped "Completely remove" leaves those specific rows behind rather than risk
//        deleting ones outside the intended scope; a plant-wide (no date) remove still deletes them
//        along with everything else. Step 1's own 'adjust' audit row is skipped in 'remove' mode
//        for the same reason as before — no point logging a row about to be deleted anyway.
// proforma_slips, product master, and vehicle master are never touched by this — they aren't
// scan history.
const router = Router();

function actor(req: Request): { userCode?: string; userName?: string } {
  const u = req.user as any;
  return { userCode: u?.userCode, userName: u?.name || u?.username || u?.userCode };
}

// GET /api/settings/clear-stock/preview?plant=<name|all>&orderDateUpTo=<YYYY-MM-DD> — impact
// counts shown in the dialog before the user can type the confirm phrase. orderDateUpTo is
// optional — omitted, this behaves exactly as before (every session/event for the plant scope).
router.get('/settings/clear-stock/preview', requireAdminRole, async (req: Request, res: Response) => {
  try {
    const plantParam = typeof req.query.plant === 'string' ? req.query.plant.trim() : '';
    const plant = plantParam && plantParam.toLowerCase() !== 'all' ? plantParam : null;
    const dateParam = typeof req.query.orderDateUpTo === 'string' && req.query.orderDateUpTo.trim() ? req.query.orderDateUpTo.trim() : null;

    // Stock row count is never date-scoped — a stock row has no order date of its own (it's a
    // running total); the date filter narrows WHICH transactions get reversed, not which rows
    // show up here at all.
    const stockRes = await pool.query(
      `SELECT COUNT(*)::int AS n FROM product_plant_stock
       WHERE (in_stock <> 0 OR extra_qty <> 0) AND ($1::text IS NULL OR plant = $1)`,
      [plant],
    );
    const sessionsRes = await pool.query(
      `SELECT COUNT(*)::int AS n FROM order_import_sessions
       WHERE is_deleted IS NOT TRUE AND ($1::text IS NULL OR plant = $1) AND ($2::text IS NULL OR order_date <= $2)`,
      [plant, dateParam],
    );
    const receivingEventsRes = await pool.query(
      `SELECT COUNT(*)::int AS n FROM order_scan_events e
       JOIN order_import_sessions s ON s.id = e.session_id
       WHERE e.voided IS NOT TRUE AND ($1::text IS NULL OR s.plant = $1) AND ($2::text IS NULL OR s.order_date <= $2)`,
      [plant, dateParam],
    );
    // Loading has no order date of its own — joined to the proforma slip it's against for that.
    // A loading event/record whose order_number matches no slip at all (shouldn't happen in
    // normal operation) has no date to check against, so it's excluded once a date filter is
    // active rather than guessed at.
    const loadingEventsRes = await pool.query(
      `SELECT COUNT(*)::int AS n FROM loading_scan_events lse
       LEFT JOIN proforma_slips ps ON ps.order_number = lse.order_number
       WHERE lse.voided IS NOT TRUE AND ($1::text IS NULL OR lse.plant = $1) AND ($2::text IS NULL OR ps.order_date <= $2::date)`,
      [plant, dateParam],
    );
    const loadingRecordsRes = await pool.query(
      `SELECT COUNT(*)::int AS n FROM loading_records lr
       LEFT JOIN proforma_slips ps ON ps.id = lr.proforma_slip_id
       WHERE ($1::text IS NULL OR lr.plant = $1) AND ($2::text IS NULL OR ps.order_date <= $2::date)`,
      [plant, dateParam],
    );
    const unloadSessionsRes = await pool.query(
      `SELECT COUNT(*)::int AS n FROM unload_import_sessions
       WHERE is_deleted IS NOT TRUE AND ($1::text IS NULL OR plant = $1) AND ($2::text IS NULL OR order_date <= $2)`,
      [plant, dateParam],
    );
    const unloadEventsRes = await pool.query(
      `SELECT COUNT(*)::int AS n FROM unload_scan_events e
       JOIN unload_import_sessions s ON s.id = e.session_id
       WHERE e.voided IS NOT TRUE AND ($1::text IS NULL OR e.plant = $1) AND ($2::text IS NULL OR s.order_date <= $2)`,
      [plant, dateParam],
    );
    // Only counted here for information — 'void' mode never touches stock_movements (it's an
    // append-only ledger, nothing to "void"); only 'Completely remove' deletes these rows, and
    // (see the header comment) not precisely by date for Loading's own rows either way — shown
    // here unscoped by date regardless, informational only.
    const stockMovementsRes = await pool.query(
      `SELECT COUNT(*)::int AS n FROM stock_movements
       WHERE $1::text IS NULL OR plant = $1`,
      [plant],
    );

    res.json({
      productsWithStock: stockRes.rows[0]?.n ?? 0,
      importSessions: sessionsRes.rows[0]?.n ?? 0,
      receivingScanEvents: receivingEventsRes.rows[0]?.n ?? 0,
      loadingScanEvents: loadingEventsRes.rows[0]?.n ?? 0,
      loadingRecords: loadingRecordsRes.rows[0]?.n ?? 0,
      unloadingSessions: unloadSessionsRes.rows[0]?.n ?? 0,
      unloadingScanEvents: unloadEventsRes.rows[0]?.n ?? 0,
      stockMovements: stockMovementsRes.rows[0]?.n ?? 0,
      dateScoped: dateParam != null,
    });
  } catch (error) {
    console.error('Error building clear-stock preview:', error);
    res.status(500).json({ message: 'Failed to load impact preview' });
  }
});

// POST /api/settings/clear-stock — body: { plant: string | 'all', mode: 'void' | 'remove', orderDateUpTo?: 'YYYY-MM-DD' }
router.post('/settings/clear-stock', requireAdminRole, async (req: Request, res: Response) => {
  const plantParam = typeof req.body?.plant === 'string' ? req.body.plant.trim() : '';
  const mode = req.body?.mode;
  if (!plantParam) return res.status(400).json({ message: 'Plant is required' });
  if (mode !== 'void' && mode !== 'remove') {
    return res.status(400).json({ message: 'Mode must be "void" or "remove"' });
  }
  const plant = plantParam.toLowerCase() === 'all' ? null : plantParam;
  const dateParam = typeof req.body?.orderDateUpTo === 'string' && req.body.orderDateUpTo.trim() ? req.body.orderDateUpTo.trim() : null;
  const { userCode, userName } = actor(req);

  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    // --- Step 1: stock ---
    let stockRowsAffectedCount = 0;
    if (!dateParam) {
      // No date scope — original behavior, exact and simple: everything in the plant scope is
      // being cleared, so nothing is left behind that stock could still legitimately belong to.
      const { rows: stockRows } = await client.query(
        `SELECT barcode, product_id, plant, in_stock, extra_qty FROM product_plant_stock
         WHERE (in_stock <> 0 OR extra_qty <> 0) AND ($1::text IS NULL OR plant = $1)
         FOR UPDATE`,
        [plant],
      );
      stockRowsAffectedCount = stockRows.length;
      // Only logged in 'void' mode — stock_movements is wiped clean below for 'remove' mode, so
      // inserting a fresh row here would just leave exactly one row behind, defeating the point.
      if (mode === 'void') {
        for (const row of stockRows) {
          const qty = Number(row.in_stock ?? 0) + Number(row.extra_qty ?? 0);
          if (qty <= 0) continue;
          await client.query(
            `INSERT INTO stock_movements (barcode, product_id, plant, qty, extra_qty, type, reason, created_by_code)
             VALUES ($1,$2,$3,$4,$5,'adjust',$6,$7)`,
            [row.barcode, row.product_id, row.plant, -qty, -Number(row.extra_qty ?? 0), 'Clear Stock (Settings)', userCode ?? null],
          );
        }
      }
      await client.query(
        `UPDATE product_plant_stock SET in_stock = 0, extra_qty = 0, updated_at = NOW()
         WHERE (in_stock <> 0 OR extra_qty <> 0) AND ($1::text IS NULL OR plant = $1)`,
        [plant],
      );
    } else {
      // Date scope — set-to-0 would be wrong (see header comment). Compute the precise delta the
      // in-scope transactions contributed and reverse only that: receiving (Order Import +
      // Unloading) added stock, so it subtracts; Loading (dispatch) removed stock, so it adds
      // back. extra_qty on product_plant_stock is only ever touched by Order Import's receiving
      // side (see applyLiveScanStock) — Unloading and Loading never adjust it.
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
        if (d.inStockDelta === 0 && d.extraQtyDelta === 0) continue;
        const { rows: updated } = await client.query(
          `UPDATE product_plant_stock
           SET in_stock = GREATEST(0, in_stock + $1), extra_qty = GREATEST(0, extra_qty + $2), updated_at = NOW()
           WHERE barcode = $3 AND plant = $4
           RETURNING product_id`,
          [d.inStockDelta, d.extraQtyDelta, d.barcode, d.plant],
        );
        if (updated.length === 0) continue;
        stockRowsAffectedCount += updated.length;
        if (mode === 'void') {
          await client.query(
            `INSERT INTO stock_movements (barcode, product_id, plant, qty, extra_qty, type, reason, created_by_code)
             VALUES ($1,$2,$3,$4,$5,'adjust',$6,$7)`,
            [d.barcode, updated[0]?.product_id ?? null, d.plant, d.inStockDelta, d.extraQtyDelta, `Clear Stock (Settings) — orders up to ${dateParam}`, userCode ?? null],
          );
        }
      }
    }

    // Recompute the legacy cross-plant mirror from the live per-plant table so clearing one
    // plant doesn't erase a product's stock that still exists in another plant.
    await client.query(
      `UPDATE products p
       SET in_stock = COALESCE((SELECT SUM(pps.in_stock) FROM product_plant_stock pps WHERE pps.barcode = p.barcode), 0)
       WHERE EXISTS (SELECT 1 FROM product_plant_stock pps WHERE pps.barcode = p.barcode)`,
    );

    // --- Step 2: scan history ---
    let importSessionsAffected = 0;
    let receivingEventsAffected = 0;
    let loadingEventsAffected = 0;
    let loadingRecordsAffected = 0;
    let unloadingSessionsAffected = 0;
    let unloadingEventsAffected = 0;
    let stockMovementsAffected = 0;

    if (mode === 'void') {
      const receivingRes = await client.query(
        `UPDATE order_scan_events e SET voided = true, voided_by_code = $1, voided_at = NOW(), void_reason = $2
         FROM order_import_sessions s
         WHERE e.session_id = s.id AND e.voided IS NOT TRUE
           AND ($3::text IS NULL OR s.plant = $3) AND ($4::text IS NULL OR s.order_date <= $4)
         RETURNING e.id`,
        [userCode ?? null, 'Cleared via Settings > Clear Stock', plant, dateParam],
      );
      receivingEventsAffected = receivingRes.rowCount ?? 0;

      const sessionsRes = await client.query(
        `UPDATE order_import_sessions SET is_deleted = true, deleted_at = NOW(), deleted_by_code = $1
         WHERE is_deleted IS NOT TRUE AND ($2::text IS NULL OR plant = $2) AND ($3::text IS NULL OR order_date <= $3)
         RETURNING id`,
        [userCode ?? null, plant, dateParam],
      );
      importSessionsAffected = sessionsRes.rowCount ?? 0;

      // No date of its own — joined to the proforma slip it's against for that (see header
      // comment). A loading event whose order_number matches no slip is excluded once a date
      // filter is active, same reasoning as the preview endpoint above.
      const loadingRes = await client.query(
        `UPDATE loading_scan_events lse SET voided = true, voided_by_code = $1, voided_at = NOW(), void_reason = $2
         FROM proforma_slips ps
         WHERE ps.order_number = lse.order_number AND lse.voided IS NOT TRUE
           AND ($3::text IS NULL OR lse.plant = $3) AND ($4::text IS NULL OR ps.order_date <= $4::date)
         RETURNING lse.id`,
        [userCode ?? null, 'Cleared via Settings > Clear Stock', plant, dateParam],
      );
      loadingEventsAffected = loadingRes.rowCount ?? 0;

      const unloadEventsRes = await client.query(
        `UPDATE unload_scan_events e SET voided = true, voided_by_code = $1, voided_at = NOW(), void_reason = $2
         FROM unload_import_sessions s
         WHERE e.session_id = s.id AND e.voided IS NOT TRUE
           AND ($3::text IS NULL OR e.plant = $3) AND ($4::text IS NULL OR s.order_date <= $4)
         RETURNING e.id`,
        [userCode ?? null, 'Cleared via Settings > Clear Stock', plant, dateParam],
      );
      unloadingEventsAffected = unloadEventsRes.rowCount ?? 0;

      const unloadSessionsRes = await client.query(
        `UPDATE unload_import_sessions SET is_deleted = true, deleted_at = NOW(), deleted_by_code = $1
         WHERE is_deleted IS NOT TRUE AND ($2::text IS NULL OR plant = $2) AND ($3::text IS NULL OR order_date <= $3)
         RETURNING id`,
        [userCode ?? null, plant, dateParam],
      );
      unloadingSessionsAffected = unloadSessionsRes.rowCount ?? 0;
    } else {
      // Cascades (verified live FK constraints): order_import_sessions -> order_import_items,
      // order_scan_items, order_scan_events.
      const countRes = await client.query(
        `SELECT
           (SELECT COUNT(*)::int FROM order_scan_events e JOIN order_import_sessions s ON s.id = e.session_id
             WHERE ($1::text IS NULL OR s.plant = $1) AND ($2::text IS NULL OR s.order_date <= $2)) AS events,
           (SELECT COUNT(*)::int FROM order_import_sessions WHERE ($1::text IS NULL OR plant = $1) AND ($2::text IS NULL OR order_date <= $2)) AS sessions`,
        [plant, dateParam],
      );
      receivingEventsAffected = countRes.rows[0]?.events ?? 0;
      importSessionsAffected = countRes.rows[0]?.sessions ?? 0;

      // stock_movements tied to the receiving/unloading sessions about to be removed — gathered
      // BEFORE the deletes below (their FK-cascaded children would otherwise take these ids with
      // them). Loading's own dispatch movements carry no session_id at all (see header comment),
      // so they're never included here even when date-scoped. Note: stock_movements.session_id
      // doesn't record WHICH sessions table it points to, so this combines both tables' in-scope
      // ids into one set — a false-positive match is possible only if an order_import_sessions id
      // and an unrelated, out-of-scope unload_import_sessions id (or vice versa) happen to be the
      // same number, an edge case narrow enough (and limited to an audit-trail row, never actual
      // stock or session data) to accept rather than adding a source-discriminator column.
      let sessionScopedMovementIds: number[] = [];
      if (dateParam) {
        const { rows: idRows } = await client.query(
          `SELECT sm.id FROM stock_movements sm
           WHERE ($1::text IS NULL OR sm.plant = $1) AND sm.session_id IN (
             SELECT id FROM order_import_sessions WHERE ($1::text IS NULL OR plant = $1) AND order_date <= $2
             UNION ALL
             SELECT id FROM unload_import_sessions WHERE ($1::text IS NULL OR plant = $1) AND order_date <= $2
           )`,
          [plant, dateParam],
        );
        sessionScopedMovementIds = idRows.map((r: any) => r.id);
      }

      await client.query(
        `DELETE FROM order_import_sessions WHERE ($1::text IS NULL OR plant = $1) AND ($2::text IS NULL OR order_date <= $2)`,
        [plant, dateParam],
      );

      const loadingEventsRes = await client.query(
        `DELETE FROM loading_scan_events WHERE id IN (
           SELECT lse.id FROM loading_scan_events lse
           LEFT JOIN proforma_slips ps ON ps.order_number = lse.order_number
           WHERE ($1::text IS NULL OR lse.plant = $1) AND ($2::text IS NULL OR ps.order_date <= $2::date)
         ) RETURNING id`,
        [plant, dateParam],
      );
      loadingEventsAffected = loadingEventsRes.rowCount ?? 0;

      const loadingRecordsRes = await client.query(
        `DELETE FROM loading_records WHERE id IN (
           SELECT lr.id FROM loading_records lr
           LEFT JOIN proforma_slips ps ON ps.id = lr.proforma_slip_id
           WHERE ($1::text IS NULL OR lr.plant = $1) AND ($2::text IS NULL OR ps.order_date <= $2::date)
         ) RETURNING id`,
        [plant, dateParam],
      );
      loadingRecordsAffected = loadingRecordsRes.rowCount ?? 0;

      // Cascades (declared FK, same ON DELETE CASCADE pattern as order_import_sessions):
      // unload_import_sessions -> unload_import_items, unload_scan_events.
      const unloadCountRes = await client.query(
        `SELECT
           (SELECT COUNT(*)::int FROM unload_scan_events e JOIN unload_import_sessions s ON s.id = e.session_id
             WHERE ($1::text IS NULL OR e.plant = $1) AND ($2::text IS NULL OR s.order_date <= $2)) AS events,
           (SELECT COUNT(*)::int FROM unload_import_sessions WHERE ($1::text IS NULL OR plant = $1) AND ($2::text IS NULL OR order_date <= $2)) AS sessions`,
        [plant, dateParam],
      );
      unloadingEventsAffected = unloadCountRes.rows[0]?.events ?? 0;
      unloadingSessionsAffected = unloadCountRes.rows[0]?.sessions ?? 0;

      await client.query(
        `DELETE FROM unload_import_sessions WHERE ($1::text IS NULL OR plant = $1) AND ($2::text IS NULL OR order_date <= $2)`,
        [plant, dateParam],
      );

      if (!dateParam) {
        // No date scope — original behavior: every stock_movements row for the plant, any type.
        const stockMovementsRes = await client.query(
          `DELETE FROM stock_movements WHERE $1::text IS NULL OR plant = $1 RETURNING id`,
          [plant],
        );
        stockMovementsAffected = stockMovementsRes.rowCount ?? 0;
      } else if (sessionScopedMovementIds.length > 0) {
        const stockMovementsRes = await client.query(
          `DELETE FROM stock_movements WHERE id = ANY($1::int[]) RETURNING id`,
          [sessionScopedMovementIds],
        );
        stockMovementsAffected = stockMovementsRes.rowCount ?? 0;
      }
    }

    await client.query('COMMIT');

    if (userCode) {
      await storage.logActivity({
        pageName: 'Settings',
        action: 'delete',
        entityType: 'clear_stock',
        entityId: plant ?? 'all',
        details: `Clear Stock run by ${userName ?? userCode} — plant: ${plant ?? 'All Plants'}, mode: ${mode}`
          + (dateParam ? `, orders up to ${dateParam}` : '') + `. `
          + `${stockRowsAffectedCount} stock row(s) adjusted, ${importSessionsAffected} import session(s), `
          + `${receivingEventsAffected} receiving scan event(s), ${loadingEventsAffected} loading scan event(s), `
          + `${unloadingSessionsAffected} unloading session(s), ${unloadingEventsAffected} unloading scan event(s)`
          + (mode === 'remove' ? `, ${loadingRecordsAffected} loading record(s), ${stockMovementsAffected} stock movement(s) deleted` : '') + '.',
        userCode,
        userName,
      });
    }

    res.json({
      success: true,
      plant: plant ?? 'all',
      mode,
      orderDateUpTo: dateParam,
      stockRowsCleared: stockRowsAffectedCount,
      importSessionsAffected,
      receivingEventsAffected,
      loadingEventsAffected,
      loadingRecordsAffected,
      unloadingSessionsAffected,
      unloadingEventsAffected,
      stockMovementsAffected,
    });
  } catch (error) {
    await client.query('ROLLBACK');
    console.error('Error clearing stock:', error);
    res.status(500).json({ message: 'Failed to clear stock' });
  } finally {
    client.release();
  }
});

// GET /api/settings/sales-tracking-start — the date Overall Stock's ledger starts summing Sale
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

export default router;
