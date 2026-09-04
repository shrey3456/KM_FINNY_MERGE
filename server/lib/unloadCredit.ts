import type { PoolClient } from 'pg';

// Makes the "already covered by an earlier part" credit real, mirroring reconcileCredits
// (server/lib/orderGroupReport.ts) — see its comment for the full rationale. Called once, right
// when a vehicle+date group's part completes (POST /scan's completion path, or manual
// /complete): for every un-consumed extra event on the just-completed part, walks forward
// through later (higher partIndex, not-yet-completed) parts of the SAME group and, for any real
// shortfall on the same barcode, writes the credit for real — a system-generated scan event on
// the later part (isCredit=true) — instead of leaving it a display-only estimate.
//
// Simpler than order_scan_events' version: Unloading has no separate scan_items progress row to
// update (progress is summed live from unload_scan_events against unload_import_items — see
// withProgress in server/routes/unloading.ts), so crediting a later part is just inserting one
// more (non-extra) scan event there; the live sum picks it up automatically. Never touches
// stock — the physical stock for these boxes was already added when the original extra was
// scanned.
export async function reconcileUnloadCredits(
  client: PoolClient,
  completedSessionId: number,
  groupId: number,
): Promise<void> {
  const { rows: parts } = await client.query(
    `SELECT id, part_index AS "partIndex", scan_status AS "scanStatus"
     FROM unload_import_sessions
     WHERE group_id = $1 AND is_deleted = false
     ORDER BY part_index ASC, id ASC`,
    [groupId],
  );
  const completedPart = parts.find((p: any) => p.id === completedSessionId);
  if (!completedPart) return;

  const laterParts = parts.filter(
    (p: any) => (p.partIndex ?? 0) > (completedPart.partIndex ?? 0) && p.scanStatus !== 'completed',
  );
  if (laterParts.length === 0) return;

  const { rows: extraEvents } = await client.query(
    `SELECT id, barcode, item_name, sap_code, total_qty, credited_qty
     FROM unload_scan_events
     WHERE session_id = $1 AND is_extra = true AND voided IS NOT TRUE
       AND total_qty > COALESCE(credited_qty, 0)
     ORDER BY scanned_at ASC, id ASC
     FOR UPDATE`,
    [completedSessionId],
  );
  if (extraEvents.length === 0) return;

  for (const ev of extraEvents) {
    let remaining = Number(ev.total_qty) - Number(ev.credited_qty ?? 0);
    if (remaining <= 0) continue;

    for (const part of laterParts) {
      if (remaining <= 0) break;

      const { rows: itemRows } = await client.query(
        `SELECT COALESCE(SUM(quantity), 0)::int AS expected FROM unload_import_items WHERE session_id = $1 AND barcode = $2`,
        [part.id, ev.barcode],
      );
      const expected = itemRows[0]?.expected ?? 0;
      if (expected <= 0) continue; // this later part doesn't expect this barcode at all

      // No single row to FOR UPDATE lock here (progress is a live SUM, not a stored row like
      // order_scan_items) — the source extra event's own FOR UPDATE lock above is what prevents
      // the same physical boxes from being credited twice; a race between two different parts
      // completing at the exact same instant and crediting the same third part is not guarded
      // against, same residual risk as any other live-summed read in this app.
      const { rows: scannedRows } = await client.query(
        `SELECT COALESCE(SUM(total_qty), 0)::int AS scanned FROM unload_scan_events
         WHERE session_id = $1 AND barcode = $2 AND voided IS NOT TRUE`,
        [part.id, ev.barcode],
      );
      const shortfall = Math.max(0, expected - (scannedRows[0]?.scanned ?? 0));
      if (shortfall <= 0) continue;

      const take = Math.min(remaining, shortfall);

      await client.query(
        `INSERT INTO unload_scan_events
           (session_id, barcode, item_name, sap_code, pallets, loose_qty, total_qty, is_extra, plant, vehicle_number, scanned_by_name, is_credit, credit_source_event_id)
         SELECT $1, $2, $3, $4, 0, $5, $5, false, plant, vehicle_number, $6, true, $7
         FROM unload_import_sessions WHERE id = $1`,
        [part.id, ev.barcode, ev.item_name, ev.sap_code, take, `System (credited from Part ${completedPart.partIndex})`, ev.id],
      );

      await client.query(
        `UPDATE unload_scan_events SET credited_qty = COALESCE(credited_qty, 0) + $1 WHERE id = $2`,
        [take, ev.id],
      );

      remaining -= take;
    }
  }
}
