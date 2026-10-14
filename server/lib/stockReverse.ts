import type { PoolClient } from 'pg';
import { v2Purchase } from './stockV2';
import { postUnloadMovement } from './unloadStock';
import { giveBack } from './loadingStock';

// Takes the effect of whole operations back OFF Stock Overview when their data is removed in Settings (Remove Scan & Order Import Data / Remove All
// Operations Data). Each helper reads the entries that are about to be deleted and posts the opposite of what they posted - on the same day - so the
// book, not just the Stock figure, ends up as if the operation never happened. Run them BEFORE the entries are deleted.

// Order Scan CSVs: per CSV and barcode, the boxes physically received (credit rows only re-assign boxes, they never added stock).
export async function reverseOrderSessions(client: PoolClient, sessionIds: number[]): Promise<{ lines: number; qty: number }> {
  if (!sessionIds.length) return { lines: 0, qty: 0 };
  const { rows } = await client.query(
    `SELECT e.session_id, s.plant, MAX(TRIM(e.barcode)) AS barcode, SUM(e.total_qty)::int AS qty,
            COALESCE(SUM(e.total_qty) FILTER (WHERE e.is_extra), 0)::int AS extra
       FROM order_scan_events e JOIN order_import_sessions s ON s.id = e.session_id
      WHERE e.session_id = ANY($1::int[]) AND e.voided IS NOT TRUE AND e.is_credit IS NOT TRUE
        AND e.barcode IS NOT NULL AND e.barcode <> 'EMPTY_BOX'
      GROUP BY e.session_id, s.plant, LOWER(TRIM(e.barcode))
     HAVING SUM(e.total_qty) <> 0`,
    [sessionIds],
  );
  let qty = 0;
  for (const r of rows) {
    await v2Purchase(client, { source: 'order', sessionId: r.session_id, plant: r.plant, barcode: r.barcode, qty: -Number(r.qty), extraQty: -Number(r.extra) });
    qty += Number(r.qty);
  }
  return { lines: rows.length, qty };
}

// Unloading batches: per batch, barcode and booked day (a scan with no booked day keeps the CSV's date).
export async function reverseUnloadSessions(client: PoolClient, sessionIds: number[]): Promise<{ lines: number; qty: number }> {
  if (!sessionIds.length) return { lines: 0, qty: 0 };
  const { rows } = await client.query(
    `SELECT session_id, MAX(TRIM(barcode)) AS barcode, to_char(booked_day, 'YYYY-MM-DD') AS day, SUM(total_qty)::int AS qty,
            COALESCE(SUM(total_qty) FILTER (WHERE is_extra), 0)::int AS extra
       FROM unload_scan_events
      WHERE session_id = ANY($1::int[]) AND voided IS NOT TRUE AND barcode IS NOT NULL
      GROUP BY session_id, LOWER(TRIM(barcode)), to_char(booked_day, 'YYYY-MM-DD')
     HAVING SUM(total_qty) <> 0`,
    [sessionIds],
  );
  let qty = 0;
  for (const r of rows) {
    await postUnloadMovement(client, {
      sessionId: r.session_id, barcode: r.barcode, qty: -Number(r.qty), extraQty: -Number(r.extra), type: 'adjust',
      reason: 'Operations data removed (Settings)', day: r.day ?? null,
    });
    qty += Number(r.qty);
  }
  return { lines: rows.length, qty };
}

// Loading: gives every live entry of these slips back to the line it took from.
export async function reverseLoadingOrders(client: PoolClient, orderNumbers: string[]): Promise<{ entries: number }> {
  if (!orderNumbers.length) return { entries: 0 };
  const { rows } = await client.query(
    `SELECT id FROM loading_scan_events WHERE order_number = ANY($1::text[]) AND voided IS NOT TRUE AND total_qty <> 0 AND barcode IS NOT NULL AND plant IS NOT NULL`,
    [orderNumbers],
  );
  for (const r of rows) await giveBack(client, r.id);
  return { entries: rows.length };
}
