import { Router, Request, Response } from 'express';
import { storage } from '../storage';
import { pool } from '../db';
import { requireAdminRole } from '../lib/pageAccess';
import { checkStock, recalculateStock, StockBusyError } from '../lib/stockRecalc';

// Settings > Data Management > "Clear Stock" — an admin-only action that resets stock numbers
// for a chosen plant (or every plant), optionally scoped further to only orders/slips dated on
// or before a chosen Order Date. Touches ONLY product_plant_stock (+ its stock_movements audit
// trail and the products legacy mirror) — it does NOT touch Order Import/Loading/Unloading scan
// history, sessions, or records in any way. (It used to also void-or-delete that scan history;
// that behavior was deliberately removed — Clear Stock is stock-only now.)
//   - No date scope (the original, still-default behavior): product_plant_stock.in_stock/
//     extra_qty -> 0 outright for the plant scope. Exact and simple, since everything in that
//     scope is being cleared — nothing is left behind that stock could still legitimately
//     belong to.
//   - Date scope: setting to 0 would be WRONG here — it would also wipe out stock earned by
//     transactions dated AFTER the cutoff, which aren't being cleared. Instead this computes
//     the precise delta the in-scope (date-filtered) transactions contributed — sum of
//     receiving (Order Import + Unloading, both add stock) minus sum of dispatch (Loading,
//     removes stock) for each barcode+plant — and subtracts only that, the same "reverse
//     exactly what this scope contributed" idea the per-CSV delete/edit flows already use, just
//     at the scale of a whole date range. This is a best-effort reversal: it assumes stock
//     equals the sum of tracked events for the in-scope period (true in normal operation, but
//     an Opening Stock bulk-set or an untracked manual adjustment inside that period would
//     throw it off) — full historical ledger replay isn't feasible here. Reading that delta
//     still requires looking at order_scan_events/unload_scan_events/loading_scan_events (joined
//     to their sessions/proforma slip for the date filter) — those reads are how the delta gets
//     computed, not a write; none of those rows are modified.
//   Either way: a stock_movements 'adjust' audit row per affected barcode+plant, and
//   products.in_stock (the legacy cross-plant mirror) recomputed as the live sum of
//   product_plant_stock so clearing one plant never wipes out a product's stock that still
//   legitimately exists elsewhere.
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
      `SELECT COUNT(*)::int AS n FROM product_plant_stock
       WHERE (in_stock <> 0 OR extra_qty <> 0) AND ($1::text IS NULL OR plant = $1)`,
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
      const { rows: stockRows } = await client.query(
        `SELECT barcode, product_id, plant, in_stock, extra_qty FROM product_plant_stock
         WHERE (in_stock <> 0 OR extra_qty <> 0) AND ($1::text IS NULL OR plant = $1)
         FOR UPDATE`,
        [plant],
      );
      stockRowsAffectedCount = stockRows.length;
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
        await client.query(
          `INSERT INTO stock_movements (barcode, product_id, plant, qty, extra_qty, type, reason, created_by_code)
           VALUES ($1,$2,$3,$4,$5,'adjust',$6,$7)`,
          [d.barcode, updated[0]?.product_id ?? null, d.plant, d.inStockDelta, d.extraQtyDelta, `Clear Stock (Settings) — orders up to ${dateParam}`, userCode ?? null],
        );
      }
    }

    // Recompute the legacy cross-plant mirror from the live per-plant table so clearing one
    // plant doesn't erase a product's stock that still exists in another plant.
    await client.query(
      `UPDATE products p
       SET in_stock = COALESCE((SELECT SUM(pps.in_stock) FROM product_plant_stock pps WHERE pps.barcode = p.barcode), 0)
       WHERE EXISTS (SELECT 1 FROM product_plant_stock pps WHERE pps.barcode = p.barcode)`,
    );

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

// Settings > Data Management > Recalculate Stock — see server/lib/stockRecalc.ts.
// GET  .../preview : read-only; lists every stored total that doesn't match the history (capped
//                    for display, with the full counts alongside).
// POST             : corrects those stored totals. History, scans, CSVs and proforma slips are
//                    never changed.
const RECALC_PREVIEW_LIMIT = 500;

router.get('/settings/recalculate-stock/preview', requireAdminRole, async (_req: Request, res: Response) => {
  try {
    const { plantRows, productRows } = await checkStock(pool);
    res.json({
      plantCount: plantRows.length,
      productCount: productRows.length,
      plantRows: plantRows.slice(0, RECALC_PREVIEW_LIMIT),
      productRows: productRows.slice(0, RECALC_PREVIEW_LIMIT),
    });
  } catch (error) {
    console.error('Error checking stock:', error);
    res.status(500).json({ message: 'Failed to check stock' });
  }
});

router.post('/settings/recalculate-stock', requireAdminRole, async (req: Request, res: Response) => {
  const { userCode, userName } = actor(req);
  try {
    const result = await recalculateStock(pool);
    if (userCode) {
      await storage.logActivity({
        pageName: 'Settings',
        action: 'update',
        entityType: 'plant_stock',
        entityId: 'recalculate-stock',
        details: `Recalculated stock from history by ${userName ?? userCode}: ${result.plantRowsFixed} plant row(s) corrected`
          + `${result.duplicateRowsCleared ? `, ${result.duplicateRowsCleared} duplicate row(s) set to 0` : ''}`
          + `, ${result.productTotalsFixed} product total(s) corrected.`,
        userCode,
        userName,
      });
    }
    res.json({ success: true, ...result });
  } catch (error) {
    if (error instanceof StockBusyError) return res.status(409).json({ message: error.message });
    console.error('Error recalculating stock:', error);
    res.status(500).json({ message: 'Failed to recalculate stock' });
  }
});

export default router;
