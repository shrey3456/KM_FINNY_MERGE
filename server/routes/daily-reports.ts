import { Router, Request, Response } from 'express';
import { pool } from '../db';
import { requirePageAccess } from '../lib/pageAccess';
import { getUserPlants } from './order-scan';

// Daily Reports — one date-scoped report per operation (Loading / Unloading / Scan), each with
// the same shape: a Total Summary (planned vs actual quantity for every order/session whose OWN
// order date falls on the picked day), an Activities Summary (first/last scan event of that day,
// across everything), and a per-vehicle (Loading/Unloading) or per-session (Scan — it has no
// vehicle concept, see below) breakdown.
//
// The one rule every query here follows: bucket by the order's own order_date column, never by
// when a scan/load/unload actually happened (scannedAt/createdAt) — an order dated the 20th that
// gets scanned on the 22nd must still show up under the 20th. This mirrors what the app already
// does elsewhere (Order Import's own tabs filter on orderDate, not createdAt — see the comment in
// server/routes/order-scan.ts) and deliberately avoids the one existing endpoint that filters the
// wrong way (GET /order-scan/sessions?date=, which filters createdAt).
//
// Times returned here come from raw pool.query() (not Drizzle's db.select()), which is what every
// other route reading these same *_scan_events tables already does — verified live that this path
// returns the correct absolute instant for a naive `timestamp` column on this server, unlike
// Drizzle's own reader (see shared/schema.ts's comment on activities.createdAt for that bug and
// why it doesn't apply here).
const router = Router();

// "Today" as the operator sees it, in IST — not the server process's own local date — matching
// the app-wide Asia/Kolkata convention used for every other date/time display in this app.
function todayIST(): string {
  return new Date().toLocaleDateString('en-CA', { timeZone: 'Asia/Kolkata' }); // en-CA -> YYYY-MM-DD
}

function parseDate(req: Request): string {
  const raw = String(req.query.date ?? '').trim();
  return /^\d{4}-\d{2}-\d{2}$/.test(raw) ? raw : todayIST();
}

// Appends a plant restriction to a raw SQL WHERE clause for the given column, plant-scoping the
// same way every other report in this app does (getUserPlants: null = admin, sees everything).
function plantClause(req: Request, column: string, params: unknown[]): string {
  const userPlants = getUserPlants(req.user);
  const requested = String(req.query.plant ?? '').trim().toLowerCase();
  if (userPlants !== null && userPlants.length === 0) return ' AND FALSE';
  if (requested && userPlants !== null && !userPlants.includes(requested)) return ' AND FALSE';

  const clauses: string[] = [];
  if (userPlants !== null) {
    params.push(userPlants);
    clauses.push(`LOWER(${column}) = ANY($${params.length})`);
  }
  if (requested) {
    params.push(requested);
    clauses.push(`LOWER(${column}) = $${params.length}`);
  }
  return clauses.length ? ` AND ${clauses.join(' AND ')}` : '';
}

type Row = {
  key: string;
  label: string;
  plant: string | null;
  orderCount: number;
  expectedQty: number;
  actualQty: number;
  eventCount: number;
  startTime: string | null;
  endTime: string | null;
};

function minDate(a: string | null, b: string | null): string | null {
  if (!a) return b;
  if (!b) return a;
  return new Date(a).getTime() <= new Date(b).getTime() ? a : b;
}
function maxDate(a: string | null, b: string | null): string | null {
  if (!a) return b;
  if (!b) return a;
  return new Date(a).getTime() >= new Date(b).getTime() ? a : b;
}

function buildReport(date: string, rows: Row[]) {
  const totalSummary = rows.reduce(
    (acc, r) => ({
      orderCount: acc.orderCount + r.orderCount,
      expectedQty: acc.expectedQty + r.expectedQty,
      actualQty: acc.actualQty + r.actualQty,
      vehicleCount: acc.vehicleCount + (r.key !== '—' ? 1 : 0),
    }),
    { orderCount: 0, expectedQty: 0, actualQty: 0, vehicleCount: 0 },
  );
  const activitySummary = rows.reduce(
    (acc, r) => ({
      eventCount: acc.eventCount + r.eventCount,
      startTime: minDate(acc.startTime, r.startTime),
      endTime: maxDate(acc.endTime, r.endTime),
    }),
    { eventCount: 0, startTime: null as string | null, endTime: null as string | null },
  );
  return { date, totalSummary, activitySummary, breakdown: rows };
}

// GET /api/daily-reports/loading?date=YYYY-MM-DD — proforma_slips.order_date is a real Postgres
// `date` column (distinct from proforma_slips.createdAt, the import timestamp), so the incoming
// YYYY-MM-DD is cast to ::date rather than compared as text.
router.get('/daily-reports/loading', requirePageAccess('daily-reports'), async (req: Request, res: Response) => {
  try {
    const date = parseDate(req);
    const params: unknown[] = [date];
    const clause = plantClause(req, 'ps.plant', params);

    const { rows: orderRows } = await pool.query(
      `SELECT ps.order_number AS "orderNumber", ps.party_name AS "partyName", ps.plant,
              COALESCE(ps.vehicle_number, '') AS "vehicleNumber",
              COALESCE((SELECT SUM(quantity) FROM proforma_slip_items WHERE proforma_slip_id = ps.id), 0)::int AS "expectedQty"
         FROM proforma_slips ps
        WHERE ps.order_date = $1::date ${clause}`,
      params,
    );

    const orderNumbers = orderRows.map((r) => r.orderNumber);
    const eventsByOrder = new Map<string, { actualQty: number; startTime: string | null; endTime: string | null; eventCount: number }>();
    let activities: Array<{ barcode: string; itemName: string | null; qty: number; pallets: number; stv: string | null; isExtra: boolean; scannedByName: string | null; scannedAt: string }> = [];
    if (orderNumbers.length > 0) {
      const [eventSummaryRes, activityRes] = await Promise.all([
        pool.query(
          `SELECT order_number AS "orderNumber",
                  COALESCE(SUM(total_qty), 0)::int AS "actualQty",
                  MIN(scanned_at) AS "startTime", MAX(scanned_at) AS "endTime",
                  COUNT(*)::int AS "eventCount"
             FROM loading_scan_events
            WHERE order_number = ANY($1) AND NOT voided
            GROUP BY order_number`,
          [orderNumbers],
        ),
        pool.query(
            `SELECT order_number AS "groupKey", order_number AS "groupLabel",
              barcode, item_name AS "itemName", total_qty AS "qty", pallets, stv,
                  is_extra AS "isExtra", scanned_by_name AS "scannedByName", scanned_at AS "scannedAt"
             FROM loading_scan_events
            WHERE order_number = ANY($1) AND NOT voided
            ORDER BY scanned_at ASC`,
          [orderNumbers],
        ),
      ]);
      const eventRows = eventSummaryRes.rows;
      for (const r of eventRows) eventsByOrder.set(r.orderNumber, r);
      activities = activityRes.rows;
    }

    // Summary rows are one row per loading slip/order. Vehicle is useful context, but it is
    // not the report's identity: multiple slips can legitimately share a vehicle on one date.
    const rows: Row[] = orderRows.map((o) => {
      const ev = eventsByOrder.get(o.orderNumber);
      return {
        key: o.orderNumber,
        label: o.orderNumber,
        plant: o.plant,
        orderCount: 1,
        expectedQty: o.expectedQty,
        actualQty: ev?.actualQty ?? 0,
        eventCount: ev?.eventCount ?? 0,
        startTime: ev?.startTime ?? null,
        endTime: ev?.endTime ?? null,
      };
    });

    res.json({ ...buildReport(date, rows.sort((a, b) => a.key.localeCompare(b.key))), activities });
  } catch (error) {
    console.error('[Daily Reports] loading failed:', error);
    res.status(500).json({ message: error instanceof Error ? error.message : 'Failed to build the loading report' });
  }
});

// GET /api/daily-reports/loading/slip?date=YYYY-MM-DD&order=<order number> — the drill-down
// behind a Loading Summary row. It returns the slip's item totals and every loading event.
router.get('/daily-reports/loading/slip', requirePageAccess('daily-reports'), async (req: Request, res: Response) => {
  try {
    const date = parseDate(req);
    const order = String(req.query.order ?? '').trim();
    if (!order) return res.status(400).json({ message: 'An order number is required' });

    const params: unknown[] = [date, order];
    const clause = plantClause(req, 'ps.plant', params);
    const { rows: slipRows } = await pool.query(
      `SELECT ps.id, ps.order_number AS "orderNumber", ps.party_name AS "partyName", ps.plant,
              ps.vehicle_number AS "vehicleNumber", ps.loading_completed_at AS "completedAt"
         FROM proforma_slips ps
        WHERE ps.order_date = $1::date AND ps.order_number = $2 ${clause}`,
      params,
    );
    if (slipRows.length === 0) {
      return res.json({ date, order, partyName: null, plant: null, vehicleNumber: null, startTime: null, endTime: null, itemTotals: [], activities: [] });
    }

    const slip = slipRows[0];
    const [expectedRes, actualRes, activityRes] = await Promise.all([
      pool.query(
        `SELECT barcode, item_name AS "itemName", COALESCE(SUM(quantity), 0)::int AS "expectedQty"
           FROM proforma_slip_items WHERE proforma_slip_id = $1 GROUP BY barcode, item_name`,
        [slip.id],
      ),
      pool.query(
        `SELECT barcode,
                COALESCE(SUM(total_qty) FILTER (WHERE NOT is_extra), 0)::int AS "actualQty",
                COALESCE(SUM(total_qty) FILTER (WHERE is_extra), 0)::int AS "extraQty",
                COALESCE(SUM(pallets), 0)::real AS "pallets"
           FROM loading_scan_events WHERE order_number = $1 AND NOT voided GROUP BY barcode`,
        [order],
      ),
      pool.query(
        `SELECT barcode, item_name AS "itemName", total_qty AS "qty", pallets, stv,
                is_extra AS "isExtra", scanned_by_name AS "scannedByName", scanned_at AS "scannedAt"
           FROM loading_scan_events WHERE order_number = $1 AND NOT voided ORDER BY scanned_at ASC`,
        [order],
      ),
    ]);

    const actualByBarcode = new Map(actualRes.rows.map((r: any) => [r.barcode, r]));
    const itemTotals = expectedRes.rows.map((r: any) => {
      const actual = actualByBarcode.get(r.barcode);
      return {
        barcode: r.barcode, itemName: r.itemName, expectedQty: r.expectedQty,
        actualQty: actual?.actualQty ?? 0, extraQty: actual?.extraQty ?? 0, pallets: actual?.pallets ?? 0,
      };
    });
    const startTime = activityRes.rows.length > 0 ? activityRes.rows[0].scannedAt : null;
    res.json({
      date, order, partyName: slip.partyName, plant: slip.plant, vehicleNumber: slip.vehicleNumber,
      startTime, endTime: slip.completedAt, itemTotals, activities: activityRes.rows,
    });
  } catch (error) {
    console.error('[Daily Reports] loading slip detail failed:', error);
    res.status(500).json({ message: error instanceof Error ? error.message : 'Failed to build the loading slip report' });
  }
});

// GET /api/daily-reports/unloading?date=YYYY-MM-DD — unload_import_sessions.order_date/
// vehicle_number are both required (NOT NULL) columns there, so every session groups cleanly.
router.get('/daily-reports/unloading', requirePageAccess('daily-reports'), async (req: Request, res: Response) => {
  try {
    const date = parseDate(req);
    const params: unknown[] = [date];
    const clause = plantClause(req, 'uis.plant', params);

    const { rows: sessionRows } = await pool.query(
      `SELECT uis.id, uis.vehicle_number AS "vehicleNumber", uis.plant, uis.scan_completed_at AS "scanCompletedAt",
              COALESCE((SELECT SUM(quantity) FROM unload_import_items WHERE session_id = uis.id), 0)::int AS "expectedQty"
         FROM unload_import_sessions uis
        WHERE uis.order_date = $1 AND NOT uis.is_deleted ${clause}`,
      params,
    );

    const sessionIds = sessionRows.map((r) => r.id);
    // Start = first scan entry, still from the events themselves. End = when the session was
    // actually marked Complete (scanCompletedAt on the session row) — NOT the last scan event,
    // which can predate the operator pressing Complete by any amount of time.
    const eventsBySession = new Map<number, { actualQty: number; startTime: string | null; eventCount: number }>();
    let activities: Array<{ barcode: string; itemName: string | null; qty: number; pallets: number; stv: string | null; isExtra: boolean; scannedByName: string | null; scannedAt: string }> = [];
    if (sessionIds.length > 0) {
      const [eventSummaryRes, activityRes] = await Promise.all([
        pool.query(
          `SELECT session_id AS "sessionId",
                  COALESCE(SUM(total_qty), 0)::int AS "actualQty",
                  MIN(scanned_at) AS "startTime",
                  COUNT(*)::int AS "eventCount"
             FROM unload_scan_events
            WHERE session_id = ANY($1) AND NOT voided
            GROUP BY session_id`,
          [sessionIds],
        ),
        pool.query(
            `SELECT vehicle_number AS "groupKey", vehicle_number AS "groupLabel",
              barcode, item_name AS "itemName", total_qty AS "qty", pallets, stv,
                  is_extra AS "isExtra", scanned_by_name AS "scannedByName", scanned_at AS "scannedAt"
             FROM unload_scan_events
            WHERE session_id = ANY($1) AND NOT voided
            ORDER BY scanned_at ASC`,
          [sessionIds],
        ),
      ]);
      const eventRows = eventSummaryRes.rows;
      for (const r of eventRows) eventsBySession.set(r.sessionId, r);
      activities = activityRes.rows;
    }

    const byVehicle = new Map<string, Row>();
    for (const s of sessionRows) {
      const key = s.vehicleNumber || '—';
      const ev = eventsBySession.get(s.id);
      const row = byVehicle.get(key) ?? {
        key, label: key, plant: s.plant,
        orderCount: 0, expectedQty: 0, actualQty: 0, eventCount: 0, startTime: null, endTime: null,
      };
      row.orderCount += 1;
      row.expectedQty += s.expectedQty;
      row.actualQty += ev?.actualQty ?? 0;
      row.eventCount += ev?.eventCount ?? 0;
      row.startTime = minDate(row.startTime, ev?.startTime ?? null);
      row.endTime = maxDate(row.endTime, s.scanCompletedAt ?? null);
      byVehicle.set(key, row);
    }

    res.json({ ...buildReport(date, Array.from(byVehicle.values()).sort((a, b) => a.key.localeCompare(b.key))), activities });
  } catch (error) {
    console.error('[Daily Reports] unloading failed:', error);
    res.status(500).json({ message: error instanceof Error ? error.message : 'Failed to build the unloading report' });
  }
});

// GET /api/daily-reports/unloading/vehicle?date=YYYY-MM-DD&vehicle=AF8225 — the drill-down behind
// clicking one row of the vehicle breakdown above: that vehicle's own Start/End time, an
// item-wise total (Expected/Extra/Pallets per barcode, across every session this vehicle had on
// this date), and the full list of individual scan events, each downloadable separately from the
// summary report on the main page.
router.get('/daily-reports/unloading/vehicle', requirePageAccess('daily-reports'), async (req: Request, res: Response) => {
  try {
    const date = parseDate(req);
    const vehicle = String(req.query.vehicle ?? '').trim();
    if (!vehicle) return res.status(400).json({ message: 'A vehicle number is required' });

    const params: unknown[] = [date, vehicle];
    const clause = plantClause(req, 'uis.plant', params);
    const { rows: sessionRows } = await pool.query(
      `SELECT uis.id, uis.plant, uis.scan_completed_at AS "scanCompletedAt"
         FROM unload_import_sessions uis
        WHERE uis.order_date = $1 AND uis.vehicle_number = $2 AND NOT uis.is_deleted ${clause}`,
      params,
    );
    if (sessionRows.length === 0) {
      return res.json({ date, vehicle, plant: null, startTime: null, endTime: null, itemTotals: [], activities: [] });
    }
    const sessionIds = sessionRows.map((r) => r.id);
    const plant = sessionRows[0].plant;
    const endTime = sessionRows.reduce((acc: string | null, r) => maxDate(acc, r.scanCompletedAt), null as string | null);

    const [expectedRes, actualRes, activityRes] = await Promise.all([
      pool.query(
        `SELECT barcode, item_name AS "itemName", COALESCE(SUM(quantity), 0)::int AS "expectedQty"
           FROM unload_import_items WHERE session_id = ANY($1) GROUP BY barcode, item_name`,
        [sessionIds],
      ),
      pool.query(
        `SELECT barcode,
                COALESCE(SUM(total_qty) FILTER (WHERE NOT is_extra), 0)::int AS "actualQty",
                COALESCE(SUM(total_qty) FILTER (WHERE is_extra), 0)::int AS "extraQty",
                COALESCE(SUM(pallets), 0)::real AS "pallets"
           FROM unload_scan_events WHERE session_id = ANY($1) AND NOT voided GROUP BY barcode`,
        [sessionIds],
      ),
      pool.query(
        `SELECT barcode, item_name AS "itemName", total_qty AS "qty", is_extra AS "isExtra",
                scanned_by_name AS "scannedByName", scanned_at AS "scannedAt"
           FROM unload_scan_events WHERE session_id = ANY($1) AND NOT voided
          ORDER BY scanned_at ASC`,
        [sessionIds],
      ),
    ]);

    const actualByBarcode = new Map(actualRes.rows.map((r: any) => [r.barcode, r]));
    const itemTotals = expectedRes.rows.map((r: any) => {
      const a = actualByBarcode.get(r.barcode);
      return {
        barcode: r.barcode, itemName: r.itemName, expectedQty: r.expectedQty,
        actualQty: a?.actualQty ?? 0, extraQty: a?.extraQty ?? 0, pallets: a?.pallets ?? 0,
      };
    });
    const startTime = activityRes.rows.length > 0 ? activityRes.rows[0].scannedAt : null;

    res.json({ date, vehicle, plant, startTime, endTime, itemTotals, activities: activityRes.rows });
  } catch (error) {
    console.error('[Daily Reports] unloading vehicle detail failed:', error);
    res.status(500).json({ message: error instanceof Error ? error.message : 'Failed to build the vehicle report' });
  }
});

// GET /api/daily-reports/scan?date=YYYY-MM-DD — Order Scan has no vehicle concept anywhere in its
// schema (it's the scanning phase of order_import_sessions, a CSV/order, not a vehicle). The
// breakdown groups by CSV/session instead, the natural grouping it does have.
router.get('/daily-reports/scan', requirePageAccess('daily-reports'), async (req: Request, res: Response) => {
  try {
    const date = parseDate(req);
    const params: unknown[] = [date];
    const clause = plantClause(req, 'ois.plant', params);

    const { rows: sessionRows } = await pool.query(
      `SELECT ois.id, ois.csv_file_name AS "csvFileName", ois.plant, ois.scan_completed_at AS "scanCompletedAt",
              COALESCE((SELECT SUM(expected_qty) FROM order_scan_items WHERE session_id = ois.id), 0)::int AS "expectedQty"
         FROM order_import_sessions ois
        WHERE ois.order_date = $1 AND NOT ois.is_deleted ${clause}`,
      params,
    );

    const sessionIds = sessionRows.map((r) => r.id);
    // Start = first scan entry, from the events themselves. End = when the session was actually
    // marked Complete (scanCompletedAt on the session row), not the last scan event — same
    // correction applied to Unloading, for the same reason.
    const eventsBySession = new Map<number, { actualQty: number; startTime: string | null; eventCount: number }>();
    if (sessionIds.length > 0) {
      const { rows: eventRows } = await pool.query(
        `SELECT session_id AS "sessionId",
                COALESCE(SUM(total_qty), 0)::int AS "actualQty",
                MIN(scanned_at) AS "startTime",
                COUNT(*)::int AS "eventCount"
           FROM order_scan_events
          WHERE session_id = ANY($1) AND NOT voided
          GROUP BY session_id`,
        [sessionIds],
      );
      for (const r of eventRows) eventsBySession.set(r.sessionId, r);
    }

    const breakdown: Row[] = sessionRows.map((s) => {
      const ev = eventsBySession.get(s.id);
      return {
        key: s.csvFileName, label: s.csvFileName, plant: s.plant,
        orderCount: 1, expectedQty: s.expectedQty, actualQty: ev?.actualQty ?? 0,
        eventCount: ev?.eventCount ?? 0, startTime: ev?.startTime ?? null, endTime: s.scanCompletedAt ?? null,
      };
    });

    // Day-wide item totals and activity list — across EVERY session for this date, not just one
    // CSV/order. Same shape as Unloading's per-vehicle drill-down, just aggregated over the
    // whole day instead of one vehicle.
    let itemTotals: Array<{ barcode: string; itemName: string | null; expectedQty: number; actualQty: number; extraQty: number; pallets: number }> = [];
    let activities: Array<{ barcode: string; itemName: string | null; qty: number; pallets: number; stv: string | null; isExtra: boolean; scannedByName: string | null; scannedAt: string }> = [];
    if (sessionIds.length > 0) {
      const [expectedRes, actualRes, activityRes] = await Promise.all([
        pool.query(
          `SELECT barcode, item_name AS "itemName", COALESCE(SUM(expected_qty), 0)::int AS "expectedQty"
             FROM order_scan_items WHERE session_id = ANY($1) GROUP BY barcode, item_name`,
          [sessionIds],
        ),
        pool.query(
          `SELECT barcode,
                  COALESCE(SUM(total_qty) FILTER (WHERE NOT is_extra), 0)::int AS "actualQty",
                  COALESCE(SUM(total_qty) FILTER (WHERE is_extra), 0)::int AS "extraQty",
                  COALESCE(SUM(pallets), 0)::real AS "pallets"
             FROM order_scan_events WHERE session_id = ANY($1) AND NOT voided GROUP BY barcode`,
          [sessionIds],
        ),
        pool.query(
          `SELECT barcode, item_name AS "itemName", total_qty AS "qty", pallets, stv, is_extra AS "isExtra",
                  scanned_by_name AS "scannedByName", scanned_at AS "scannedAt"
             FROM order_scan_events WHERE session_id = ANY($1) AND NOT voided
            ORDER BY scanned_at ASC`,
          [sessionIds],
        ),
      ]);
      const actualByBarcode = new Map(actualRes.rows.map((r: any) => [r.barcode, r]));
      itemTotals = expectedRes.rows.map((r: any) => {
        const a = actualByBarcode.get(r.barcode);
        return {
          barcode: r.barcode, itemName: r.itemName, expectedQty: r.expectedQty,
          actualQty: a?.actualQty ?? 0, extraQty: a?.extraQty ?? 0, pallets: a?.pallets ?? 0,
        };
      });
      activities = activityRes.rows;
    }

    res.json({
      ...buildReport(date, breakdown.sort((a, b) => a.key.localeCompare(b.key))),
      itemTotals, activities,
    });
  } catch (error) {
    console.error('[Daily Reports] scan failed:', error);
    res.status(500).json({ message: error instanceof Error ? error.message : 'Failed to build the scan report' });
  }
});

// GET /api/daily-reports/scan/csv?date=YYYY-MM-DD&csv=<csvFileName> — the drill-down behind
// clicking one row of the CSV/Order breakdown above: that CSV's own Start/End time, item-wise
// total, and full activity list (with pallets/STV), downloadable on its own.
router.get('/daily-reports/scan/csv', requirePageAccess('daily-reports'), async (req: Request, res: Response) => {
  try {
    const date = parseDate(req);
    const csv = String(req.query.csv ?? '').trim();
    if (!csv) return res.status(400).json({ message: 'A CSV file name is required' });

    const params: unknown[] = [date, csv];
    const clause = plantClause(req, 'ois.plant', params);
    const { rows: sessionRows } = await pool.query(
      `SELECT ois.id, ois.plant, ois.scan_completed_at AS "scanCompletedAt"
         FROM order_import_sessions ois
        WHERE ois.order_date = $1 AND ois.csv_file_name = $2 AND NOT ois.is_deleted ${clause}`,
      params,
    );
    if (sessionRows.length === 0) {
      return res.json({ date, csv, plant: null, startTime: null, endTime: null, itemTotals: [], activities: [] });
    }
    const sessionIds = sessionRows.map((r) => r.id);
    const plant = sessionRows[0].plant;
    const endTime = sessionRows.reduce((acc: string | null, r) => maxDate(acc, r.scanCompletedAt), null as string | null);

    const [expectedRes, actualRes, activityRes] = await Promise.all([
      pool.query(
        `SELECT barcode, item_name AS "itemName", COALESCE(SUM(expected_qty), 0)::int AS "expectedQty"
           FROM order_scan_items WHERE session_id = ANY($1) GROUP BY barcode, item_name`,
        [sessionIds],
      ),
      pool.query(
        `SELECT barcode,
                COALESCE(SUM(total_qty) FILTER (WHERE NOT is_extra), 0)::int AS "actualQty",
                COALESCE(SUM(total_qty) FILTER (WHERE is_extra), 0)::int AS "extraQty",
                COALESCE(SUM(pallets), 0)::real AS "pallets"
           FROM order_scan_events WHERE session_id = ANY($1) AND NOT voided GROUP BY barcode`,
        [sessionIds],
      ),
      pool.query(
        `SELECT barcode, item_name AS "itemName", total_qty AS "qty", pallets, stv, is_extra AS "isExtra",
                scanned_by_name AS "scannedByName", scanned_at AS "scannedAt"
           FROM order_scan_events WHERE session_id = ANY($1) AND NOT voided
          ORDER BY scanned_at ASC`,
        [sessionIds],
      ),
    ]);

    const actualByBarcode = new Map(actualRes.rows.map((r: any) => [r.barcode, r]));
    const itemTotals = expectedRes.rows.map((r: any) => {
      const a = actualByBarcode.get(r.barcode);
      return {
        barcode: r.barcode, itemName: r.itemName, expectedQty: r.expectedQty,
        actualQty: a?.actualQty ?? 0, extraQty: a?.extraQty ?? 0, pallets: a?.pallets ?? 0,
      };
    });
    const startTime = activityRes.rows.length > 0 ? activityRes.rows[0].scannedAt : null;

    res.json({ date, csv, plant, startTime, endTime, itemTotals, activities: activityRes.rows });
  } catch (error) {
    console.error('[Daily Reports] scan csv detail failed:', error);
    res.status(500).json({ message: error instanceof Error ? error.message : 'Failed to build the CSV report' });
  }
});

export default router;
