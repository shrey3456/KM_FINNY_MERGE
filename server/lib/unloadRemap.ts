import type { PoolClient } from 'pg';

// Splits a total qty into {pallets, looseQty} — mirrors splitPallets in server/lib/
// orderScanRemap.ts.
export function splitPallets(qty: number, itemsPerPallet: number) {
  return {
    pallets: itemsPerPallet > 0 ? Math.floor(qty / itemsPerPallet) : qty,
    looseQty: itemsPerPallet > 0 ? qty % itemsPerPallet : 0,
  };
}

export type UnloadRemapSummary = {
  deletedSessionId: number;
  newSessionId: number;
  barcodesCarriedForward: number;
  qtyCarriedForward: number;
};

// Carries forward all physical scan work already recorded against a deleted unload session (D)
// onto its replacement (S) — same "replace" delete idea as remapDeletedSessionScans (server/lib/
// orderScanRemap.ts), simplified: Unloading has no separate scan_items progress table (progress
// is summed live from unload_scan_events against unload_import_items — see withProgress in
// server/routes/unloading.ts), so there's nothing to re-point but the events themselves. For
// each barcode D has non-voided scan history for, its events are moved onto S (session_id =
// newSessionId) and re-split regular/extra against S's expected quantity for that barcode —
// same boundary-split convention as resplitEventsExtraFlag, since events carry a fixed is_extra
// flag decided at scan time, not something withProgress recomputes after the fact.
export async function remapDeletedUnloadSessionEvents(
  client: PoolClient,
  deletedSessionId: number,
  newSessionId: number,
): Promise<UnloadRemapSummary> {
  const summary: UnloadRemapSummary = {
    deletedSessionId, newSessionId, barcodesCarriedForward: 0, qtyCarriedForward: 0,
  };

  // Lock D and re-check it hasn't already been claimed by a concurrent replacement upload.
  const { rows: lockRows } = await client.query(
    `SELECT remapped_to_session_id AS "remappedToSessionId" FROM unload_import_sessions WHERE id = $1 FOR UPDATE`,
    [deletedSessionId],
  );
  if (!lockRows[0] || lockRows[0].remappedToSessionId != null) return summary;

  const { rows: newItems } = await client.query(
    `SELECT barcode, quantity FROM unload_import_items WHERE session_id = $1`,
    [newSessionId],
  );
  const newExpectedByBarcode = new Map<string, number>();
  for (const it of newItems) {
    if (!it.barcode) continue;
    newExpectedByBarcode.set(it.barcode, (newExpectedByBarcode.get(it.barcode) ?? 0) + Number(it.quantity ?? 0));
  }

  const { rows: barcodeGroups } = await client.query(
    `SELECT barcode, SUM(total_qty)::int AS "physicalQty"
     FROM unload_scan_events WHERE session_id = $1 AND voided IS NOT TRUE AND barcode IS NOT NULL
     GROUP BY barcode`,
    [deletedSessionId],
  );

  for (const grp of barcodeGroups) {
    const physicalQty = Number(grp.physicalQty ?? 0);
    if (physicalQty <= 0) continue;
    const newExpectedQty = newExpectedByBarcode.get(grp.barcode) ?? 0;
    const newOrderQty = Math.min(physicalQty, newExpectedQty);

    const { rows: eventRows } = await client.query(
      `SELECT id, total_qty, is_extra FROM unload_scan_events
       WHERE session_id = $1 AND barcode = $2 AND voided IS NOT TRUE ORDER BY id ASC`,
      [deletedSessionId, grp.barcode],
    );
    await client.query(
      `UPDATE unload_scan_events SET session_id = $1 WHERE session_id = $2 AND barcode = $3 AND voided IS NOT TRUE`,
      [newSessionId, deletedSessionId, grp.barcode],
    );

    // Same itemsPerPallet for every row of this barcode — pull it from a product lookup rather
    // than trusting any single event's stored pallets/looseQty split (a straddling row needs a
    // fresh split anyway).
    const { rows: prodRows } = await client.query(
      `SELECT items_per_pallet AS "itemsPerPallet" FROM products WHERE LOWER(barcode) = LOWER($1) LIMIT 1`,
      [grp.barcode],
    );
    const itemsPerPallet = Number(prodRows[0]?.itemsPerPallet ?? 0);
    await resplitUnloadEventsExtraFlag(client, eventRows, newOrderQty, itemsPerPallet);

    summary.barcodesCarriedForward += 1;
    summary.qtyCarriedForward += newOrderQty;
  }

  await client.query(
    `UPDATE unload_import_sessions SET remapped_to_session_id = $1, remapped_at = NOW() WHERE id = $2`,
    [newSessionId, deletedSessionId],
  );
  await client.query(
    `UPDATE unload_import_sessions SET replaces_session_id = $1 WHERE id = $2`,
    [deletedSessionId, newSessionId],
  );

  return summary;
}

// Re-splits a barcode's already-repointed events so SUM(total_qty WHERE is_extra) equals the
// overflow beyond newOrderQty. eventRows must already be ordered chronologically (id ASC).
// Mirrors resplitEventsExtraFlag in server/lib/orderScanRemap.ts.
export async function resplitUnloadEventsExtraFlag(
  client: PoolClient,
  eventRows: Array<{ id: number; total_qty: number; is_extra: boolean }>,
  newOrderQty: number,
  itemsPerPallet: number,
) {
  let cumulative = 0;
  for (const ev of eventRows) {
    const qty = Number(ev.total_qty ?? 0);
    const startsAt = cumulative;
    const endsAt = cumulative + qty;
    cumulative = endsAt;

    if (endsAt <= newOrderQty) {
      if (ev.is_extra) await client.query(`UPDATE unload_scan_events SET is_extra = false WHERE id = $1`, [ev.id]);
    } else if (startsAt >= newOrderQty) {
      if (!ev.is_extra) await client.query(`UPDATE unload_scan_events SET is_extra = true WHERE id = $1`, [ev.id]);
    } else {
      const orderPortion = newOrderQty - startsAt;
      const extraPortion = qty - orderPortion;
      const orderSplit = splitPallets(orderPortion, itemsPerPallet);
      const extraSplit = splitPallets(extraPortion, itemsPerPallet);

      await client.query(
        `UPDATE unload_scan_events SET total_qty = $1, pallets = $2, loose_qty = $3, is_extra = false WHERE id = $4`,
        [orderPortion, orderSplit.pallets, orderSplit.looseQty, ev.id],
      );
      await client.query(
        `INSERT INTO unload_scan_events
           (session_id, barcode, item_name, sap_code, pallets, loose_qty, total_qty, is_extra, plant, vehicle_number, scanned_by_code, scanned_by_name, scanned_at)
         SELECT session_id, barcode, item_name, sap_code, $2, $3, $4, true, plant, vehicle_number, scanned_by_code, scanned_by_name, scanned_at
         FROM unload_scan_events WHERE id = $1`,
        [ev.id, extraSplit.pallets, extraSplit.looseQty, extraPortion],
      );
    }
  }
}
