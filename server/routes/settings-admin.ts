import { Router, Request, Response } from 'express';
import { storage } from '../storage';
import { pool } from '../db';
import { requireAdminRole } from '../lib/pageAccess';

// Settings > Data Management > "Clear Stock" — a highly destructive admin-only action that
// zeroes plant stock and removes receiving (Order Import/Scan Order), Loading dispatch, and
// Unloading scan history for a chosen plant (or every plant). Two things happen, always in one
// transaction:
//   1. Stock: product_plant_stock.in_stock/extra_qty -> 0 for the scope, a stock_movements
//      'adjust' audit row per affected barcode+plant, and products.in_stock (the legacy
//      cross-plant mirror) recomputed as the live sum of product_plant_stock so clearing one
//      plant never wipes out a product's stock that still legitimately exists elsewhere.
//   2. Scan history, in one of two modes the caller picks:
//      - 'void': mark rows voided (order_scan_events, loading_scan_events, unload_scan_events —
//        existing void columns) and soft-delete order_import_sessions/unload_import_sessions
//        (existing isDeleted columns). Rows are never physically touched — same audit-preserving
//        pattern used everywhere else in the app. loading_records is left alone; it's a link-log,
//        not scan history.
//      - 'remove': hard DELETE. Deleting order_import_sessions cascades (verified live FK
//        constraints, not just declared in schema.ts) to order_import_items, order_scan_items,
//        and order_scan_events automatically; deleting unload_import_sessions likewise cascades
//        to unload_import_items and unload_scan_events. loading_scan_events/loading_records have
//        no FK relationship to anything else, so they're deleted directly.
// proforma_slips, product master, and vehicle master are never touched by this — they aren't
// scan history.
const router = Router();

function actor(req: Request): { userCode?: string; userName?: string } {
  const u = req.user as any;
  return { userCode: u?.userCode, userName: u?.name || u?.username || u?.userCode };
}

// GET /api/settings/clear-stock/preview?plant=<name|all> — impact counts shown in the dialog
// before the user can type the confirm phrase.
router.get('/settings/clear-stock/preview', requireAdminRole, async (req: Request, res: Response) => {
  try {
    const plantParam = typeof req.query.plant === 'string' ? req.query.plant.trim() : '';
    const plant = plantParam && plantParam.toLowerCase() !== 'all' ? plantParam : null;

    const stockRes = await pool.query(
      `SELECT COUNT(*)::int AS n FROM product_plant_stock
       WHERE (in_stock <> 0 OR extra_qty <> 0) AND ($1::text IS NULL OR plant = $1)`,
      [plant],
    );
    const sessionsRes = await pool.query(
      `SELECT COUNT(*)::int AS n FROM order_import_sessions
       WHERE is_deleted IS NOT TRUE AND ($1::text IS NULL OR plant = $1)`,
      [plant],
    );
    const receivingEventsRes = await pool.query(
      `SELECT COUNT(*)::int AS n FROM order_scan_events e
       JOIN order_import_sessions s ON s.id = e.session_id
       WHERE e.voided IS NOT TRUE AND ($1::text IS NULL OR s.plant = $1)`,
      [plant],
    );
    const loadingEventsRes = await pool.query(
      `SELECT COUNT(*)::int AS n FROM loading_scan_events
       WHERE voided IS NOT TRUE AND ($1::text IS NULL OR plant = $1)`,
      [plant],
    );
    const loadingRecordsRes = await pool.query(
      `SELECT COUNT(*)::int AS n FROM loading_records
       WHERE $1::text IS NULL OR plant = $1`,
      [plant],
    );
    const unloadSessionsRes = await pool.query(
      `SELECT COUNT(*)::int AS n FROM unload_import_sessions
       WHERE is_deleted IS NOT TRUE AND ($1::text IS NULL OR plant = $1)`,
      [plant],
    );
    const unloadEventsRes = await pool.query(
      `SELECT COUNT(*)::int AS n FROM unload_scan_events
       WHERE voided IS NOT TRUE AND ($1::text IS NULL OR plant = $1)`,
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
    });
  } catch (error) {
    console.error('Error building clear-stock preview:', error);
    res.status(500).json({ message: 'Failed to load impact preview' });
  }
});

// POST /api/settings/clear-stock — body: { plant: string | 'all', mode: 'void' | 'remove' }
router.post('/settings/clear-stock', requireAdminRole, async (req: Request, res: Response) => {
  const plantParam = typeof req.body?.plant === 'string' ? req.body.plant.trim() : '';
  const mode = req.body?.mode;
  if (!plantParam) return res.status(400).json({ message: 'Plant is required' });
  if (mode !== 'void' && mode !== 'remove') {
    return res.status(400).json({ message: 'Mode must be "void" or "remove"' });
  }
  const plant = plantParam.toLowerCase() === 'all' ? null : plantParam;
  const { userCode, userName } = actor(req);

  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    // --- Step 1: stock ---
    const { rows: stockRows } = await client.query(
      `SELECT barcode, product_id, plant, in_stock, extra_qty FROM product_plant_stock
       WHERE (in_stock <> 0 OR extra_qty <> 0) AND ($1::text IS NULL OR plant = $1)
       FOR UPDATE`,
      [plant],
    );
    for (const row of stockRows) {
      const qty = Number(row.in_stock ?? 0) + Number(row.extra_qty ?? 0);
      if (qty <= 0) continue;
      await client.query(
        `INSERT INTO stock_movements (barcode, product_id, plant, qty, extra_qty, type, reason, created_by_code)
         VALUES ($1,$2,$3,$4,$5,'adjust',$6,$7)`,
        [row.barcode, row.product_id, row.plant, -qty, -Number(row.extra_qty ?? 0), 'Clear Stock (Settings)', userCode ?? null],
      );
    }
    await client.query(
      `UPDATE product_plant_stock SET in_stock = 0, extra_qty = 0, updated_at = NOW()
       WHERE (in_stock <> 0 OR extra_qty <> 0) AND ($1::text IS NULL OR plant = $1)`,
      [plant],
    );
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

    if (mode === 'void') {
      const receivingRes = await client.query(
        `UPDATE order_scan_events e SET voided = true, voided_by_code = $1, voided_at = NOW(), void_reason = $2
         FROM order_import_sessions s
         WHERE e.session_id = s.id AND e.voided IS NOT TRUE AND ($3::text IS NULL OR s.plant = $3)
         RETURNING e.id`,
        [userCode ?? null, 'Cleared via Settings > Clear Stock', plant],
      );
      receivingEventsAffected = receivingRes.rowCount ?? 0;

      const sessionsRes = await client.query(
        `UPDATE order_import_sessions SET is_deleted = true, deleted_at = NOW(), deleted_by_code = $1
         WHERE is_deleted IS NOT TRUE AND ($2::text IS NULL OR plant = $2)
         RETURNING id`,
        [userCode ?? null, plant],
      );
      importSessionsAffected = sessionsRes.rowCount ?? 0;

      const loadingRes = await client.query(
        `UPDATE loading_scan_events SET voided = true, voided_by_code = $1, voided_at = NOW(), void_reason = $2
         WHERE voided IS NOT TRUE AND ($3::text IS NULL OR plant = $3)
         RETURNING id`,
        [userCode ?? null, 'Cleared via Settings > Clear Stock', plant],
      );
      loadingEventsAffected = loadingRes.rowCount ?? 0;

      const unloadEventsRes = await client.query(
        `UPDATE unload_scan_events SET voided = true, voided_by_code = $1, voided_at = NOW(), void_reason = $2
         WHERE voided IS NOT TRUE AND ($3::text IS NULL OR plant = $3)
         RETURNING id`,
        [userCode ?? null, 'Cleared via Settings > Clear Stock', plant],
      );
      unloadingEventsAffected = unloadEventsRes.rowCount ?? 0;

      const unloadSessionsRes = await client.query(
        `UPDATE unload_import_sessions SET is_deleted = true, deleted_at = NOW(), deleted_by_code = $1
         WHERE is_deleted IS NOT TRUE AND ($2::text IS NULL OR plant = $2)
         RETURNING id`,
        [userCode ?? null, plant],
      );
      unloadingSessionsAffected = unloadSessionsRes.rowCount ?? 0;
    } else {
      // Cascades (verified live FK constraints): order_import_sessions -> order_import_items,
      // order_scan_items, order_scan_events.
      const countRes = await client.query(
        `SELECT
           (SELECT COUNT(*)::int FROM order_scan_events e JOIN order_import_sessions s ON s.id = e.session_id WHERE $1::text IS NULL OR s.plant = $1) AS events,
           (SELECT COUNT(*)::int FROM order_import_sessions WHERE $1::text IS NULL OR plant = $1) AS sessions`,
        [plant],
      );
      receivingEventsAffected = countRes.rows[0]?.events ?? 0;
      importSessionsAffected = countRes.rows[0]?.sessions ?? 0;

      await client.query(
        `DELETE FROM order_import_sessions WHERE $1::text IS NULL OR plant = $1`,
        [plant],
      );

      const loadingEventsRes = await client.query(
        `DELETE FROM loading_scan_events WHERE $1::text IS NULL OR plant = $1 RETURNING id`,
        [plant],
      );
      loadingEventsAffected = loadingEventsRes.rowCount ?? 0;

      const loadingRecordsRes = await client.query(
        `DELETE FROM loading_records WHERE $1::text IS NULL OR plant = $1 RETURNING id`,
        [plant],
      );
      loadingRecordsAffected = loadingRecordsRes.rowCount ?? 0;

      // Cascades (declared FK, same ON DELETE CASCADE pattern as order_import_sessions):
      // unload_import_sessions -> unload_import_items, unload_scan_events.
      const unloadCountRes = await client.query(
        `SELECT
           (SELECT COUNT(*)::int FROM unload_scan_events WHERE $1::text IS NULL OR plant = $1) AS events,
           (SELECT COUNT(*)::int FROM unload_import_sessions WHERE $1::text IS NULL OR plant = $1) AS sessions`,
        [plant],
      );
      unloadingEventsAffected = unloadCountRes.rows[0]?.events ?? 0;
      unloadingSessionsAffected = unloadCountRes.rows[0]?.sessions ?? 0;

      await client.query(
        `DELETE FROM unload_import_sessions WHERE $1::text IS NULL OR plant = $1`,
        [plant],
      );
    }

    await client.query('COMMIT');

    if (userCode) {
      await storage.logActivity({
        pageName: 'Settings',
        action: 'delete',
        entityType: 'clear_stock',
        entityId: plant ?? 'all',
        details: `Clear Stock run by ${userName ?? userCode} — plant: ${plant ?? 'All Plants'}, mode: ${mode}. `
          + `${stockRows.length} stock row(s) zeroed, ${importSessionsAffected} import session(s), `
          + `${receivingEventsAffected} receiving scan event(s), ${loadingEventsAffected} loading scan event(s), `
          + `${unloadingSessionsAffected} unloading session(s), ${unloadingEventsAffected} unloading scan event(s)`
          + (mode === 'remove' ? `, ${loadingRecordsAffected} loading record(s) deleted` : '') + '.',
        userCode,
        userName,
      });
    }

    res.json({
      success: true,
      plant: plant ?? 'all',
      mode,
      stockRowsCleared: stockRows.length,
      importSessionsAffected,
      receivingEventsAffected,
      loadingEventsAffected,
      loadingRecordsAffected,
      unloadingSessionsAffected,
      unloadingEventsAffected,
    });
  } catch (error) {
    await client.query('ROLLBACK');
    console.error('Error clearing stock:', error);
    res.status(500).json({ message: 'Failed to clear stock' });
  } finally {
    client.release();
  }
});

export default router;
