import type { PoolClient } from 'pg';

// Splits a total qty into {pallets, looseQty} — the same convention used by /scan's
// splitPallets in order-scan.ts.
export function splitPallets(qty: number, itemsPerPallet: number) {
  return {
    pallets: itemsPerPallet > 0 ? Math.floor(qty / itemsPerPallet) : qty,
    looseQty: itemsPerPallet > 0 ? qty % itemsPerPallet : 0,
  };
}

export type RemapSummary = {
  deletedSessionId: number;
  newSessionId: number;
  itemsCarriedForward: number;
  qtyCarriedForward: number;
  extraQtyCreated: number;
};

// Carries forward all physical scan work already recorded against a deleted session (D) onto
// its replacement (S) instead of forcing a rescan — see the "remap" design in
// shared/schema.ts's orderImportSessions.remappedToSessionId comment. Runs on the caller's
// transaction client (the upload handler's own BEGIN/COMMIT).
//
// For each barcode D has scan history for:
//   - matches an item on S's CSV  -> carried forward, capped at S's expected qty; any
//     overflow becomes an Extra against S (same convention as a normal live over-scan).
//   - doesn't match anything on S -> still carried forward, kept as an Extra against S
//     (never dropped/reverted — the box was physically received).
export async function remapDeletedSessionScans(
  client: PoolClient,
  deletedSessionId: number,
  newSessionId: number,
): Promise<RemapSummary> {
  const summary: RemapSummary = {
    deletedSessionId, newSessionId, itemsCarriedForward: 0, qtyCarriedForward: 0, extraQtyCreated: 0,
  };

  // Lock D and re-check it hasn't already been claimed by a concurrent replacement upload —
  // the caller's own "find an unresolved deleted session" lookup runs outside this
  // transaction, so two uploads racing for the same slot could both reach here for the same
  // D. Whichever gets the lock first wins; the loser sees remapped_to_session_id already set
  // and no-ops instead of double-moving D's scan items/events onto two different sessions.
  const { rows: lockRows } = await client.query(
    `SELECT remapped_to_session_id AS "remappedToSessionId" FROM order_import_sessions WHERE id = $1 FOR UPDATE`,
    [deletedSessionId],
  );
  if (!lockRows[0] || lockRows[0].remappedToSessionId != null) return summary;

  const { rows: newItems } = await client.query(
    `SELECT id, barcode, quantity FROM order_import_items WHERE session_id = $1`,
    [newSessionId],
  );
  const newItemByBarcode = new Map<string, { id: number; quantity: number }>();
  for (const it of newItems) {
    if (!it.barcode || newItemByBarcode.has(it.barcode)) continue;
    newItemByBarcode.set(it.barcode, { id: it.id, quantity: Number(it.quantity ?? 0) });
  }

  // ── Case A: D's own order_scan_items rows (barcode was on D's CSV) ─────────────────────
  const { rows: oldScanItems } = await client.query(
    `SELECT * FROM order_scan_items WHERE session_id = $1`,
    [deletedSessionId],
  );

  for (const osi of oldScanItems) {
    if (!osi.barcode) continue;

    const { rows: eventRows } = await client.query(
      `SELECT id, total_qty, is_extra FROM order_scan_events
       WHERE scan_item_id = $1 AND voided IS NOT TRUE ORDER BY id ASC`,
      [osi.id],
    );
    // Ground truth is the total physical count, regardless of the old order/extra split.
    const physicalQty = eventRows.reduce((s: number, e: any) => s + Number(e.total_qty ?? 0), 0);
    if (physicalQty <= 0) continue; // nothing physically scanned — leave as pure history

    const match = newItemByBarcode.get(osi.barcode);
    const newExpectedQty = match ? match.quantity : 0;
    const newOrderQty = match ? Math.min(physicalQty, newExpectedQty) : 0;
    const overflow = physicalQty - newOrderQty;
    const itemsPerPallet = Number(osi.items_per_pallet ?? 0);
    const { pallets, looseQty } = splitPallets(newOrderQty, itemsPerPallet);
    const status = !match ? 'pending'
      : newOrderQty >= newExpectedQty && newExpectedQty > 0 ? 'complete'
      : newOrderQty > 0 ? 'partial' : 'pending';

    await client.query(
      `UPDATE order_scan_items
       SET session_id = $1, order_import_item_id = $2, expected_qty = $3,
           total_scanned_qty = $4, scanned_pallets = $5, scanned_loose_qty = $6, status = $7
       WHERE id = $8`,
      [newSessionId, match ? match.id : null, newExpectedQty, newOrderQty, pallets, looseQty, status, osi.id],
    );
    await client.query(`UPDATE order_scan_events SET session_id = $1 WHERE scan_item_id = $2`, [newSessionId, osi.id]);

    if (match) {
      await resplitEventsExtraFlag(client, eventRows, newOrderQty, itemsPerPallet);
    } else {
      // No match at all (barcode absent from S's CSV): the whole physical qty becomes Extra
      // against S. Force is_extra=true on every event — some may still carry is_extra=false
      // from D (where the barcode WAS on D's own CSV and covered part of its order), and
      // group-report/master-view read "extra" strictly from SUM(total_qty) WHERE is_extra=true,
      // so leaving them false would make this qty vanish from both the regular and extra totals.
      await client.query(
        `UPDATE order_scan_events SET is_extra = true WHERE scan_item_id = $1 AND is_extra = false`,
        [osi.id],
      );
    }

    summary.itemsCarriedForward += 1;
    summary.qtyCarriedForward += newOrderQty;
    summary.extraQtyCreated += overflow;
  }

  // ── Case B/C: D's "pure extra" events — scanned but never on D's own CSV at all ────────
  const { rows: pureExtraGroups } = await client.query(
    `SELECT barcode, MAX(item_name) AS item_name, SUM(total_qty)::int AS total_qty
     FROM order_scan_events
     WHERE session_id = $1 AND scan_item_id IS NULL AND is_extra = true AND voided IS NOT TRUE AND barcode IS NOT NULL
     GROUP BY barcode`,
    [deletedSessionId],
  );

  for (const grp of pureExtraGroups) {
    const physicalQty = Number(grp.total_qty ?? 0);
    if (physicalQty <= 0) continue;
    const match = newItemByBarcode.get(grp.barcode);

    if (!match) {
      // Case C: still no home for it — move the events over, stays a pure extra against S.
      await client.query(
        `UPDATE order_scan_events SET session_id = $1
         WHERE session_id = $2 AND scan_item_id IS NULL AND is_extra = true AND barcode = $3 AND voided IS NOT TRUE`,
        [newSessionId, deletedSessionId, grp.barcode],
      );
      summary.extraQtyCreated += physicalQty;
      continue;
    }

    // Case B: barcode now has a home on S — give it a scan item and split like Case A.
    const newExpectedQty = match.quantity;
    const newOrderQty = Math.min(physicalQty, newExpectedQty);
    const overflow = physicalQty - newOrderQty;

    const { rows: prodRows } = await client.query(
      `SELECT items_per_pallet FROM products WHERE LOWER(barcode) = LOWER($1) LIMIT 1`,
      [grp.barcode],
    );
    const itemsPerPallet = Number(prodRows[0]?.items_per_pallet ?? 0);
    const { pallets, looseQty } = splitPallets(newOrderQty, itemsPerPallet);
    const status = newOrderQty >= newExpectedQty && newExpectedQty > 0 ? 'complete' : newOrderQty > 0 ? 'partial' : 'pending';

    const { rows: inserted } = await client.query(
      `INSERT INTO order_scan_items
         (session_id, order_import_item_id, barcode, item_name, expected_qty, items_per_pallet,
          total_scanned_qty, scanned_pallets, scanned_loose_qty, status)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) RETURNING id`,
      [newSessionId, match.id, grp.barcode, grp.item_name, newExpectedQty, itemsPerPallet, newOrderQty, pallets, looseQty, status],
    );
    const newScanItemId = inserted[0].id;

    const { rows: eventRows } = await client.query(
      `SELECT id, total_qty, is_extra FROM order_scan_events
       WHERE session_id = $1 AND scan_item_id IS NULL AND is_extra = true AND barcode = $2 AND voided IS NOT TRUE
       ORDER BY id ASC`,
      [deletedSessionId, grp.barcode],
    );
    await client.query(
      `UPDATE order_scan_events SET session_id = $1, scan_item_id = $2
       WHERE session_id = $3 AND scan_item_id IS NULL AND is_extra = true AND barcode = $4 AND voided IS NOT TRUE`,
      [newSessionId, newScanItemId, deletedSessionId, grp.barcode],
    );
    await resplitEventsExtraFlag(client, eventRows, newOrderQty, itemsPerPallet);

    summary.itemsCarriedForward += 1;
    summary.qtyCarriedForward += newOrderQty;
    summary.extraQtyCreated += overflow;
  }

  await client.query(
    `UPDATE order_import_sessions SET remapped_to_session_id = $1, remapped_at = NOW() WHERE id = $2`,
    [newSessionId, deletedSessionId],
  );
  await client.query(
    `UPDATE order_import_sessions SET replaces_session_id = $1 WHERE id = $2`,
    [deletedSessionId, newSessionId],
  );

  return summary;
}

// Re-splits a set of already-repointed events' is_extra flag so SUM(total_qty WHERE is_extra)
// equals the overflow beyond newOrderQty — group-report/master-view read the extra total from
// events, not from the item row (see orderGroupReport.ts). Mirrors the split-at-boundary logic
// in /scan (order-scan.ts). eventRows must already be ordered chronologically (id ASC).
export async function resplitEventsExtraFlag(
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
      if (ev.is_extra) await client.query(`UPDATE order_scan_events SET is_extra = false WHERE id = $1`, [ev.id]);
    } else if (startsAt >= newOrderQty) {
      if (!ev.is_extra) await client.query(`UPDATE order_scan_events SET is_extra = true WHERE id = $1`, [ev.id]);
    } else {
      // Straddles the boundary — split into an order-portion (this row, updated in place)
      // and a new extra-portion row, matching the /scan split-at-boundary convention.
      const orderPortion = newOrderQty - startsAt;
      const extraPortion = qty - orderPortion;
      const orderSplit = splitPallets(orderPortion, itemsPerPallet);
      const extraSplit = splitPallets(extraPortion, itemsPerPallet);

      await client.query(
        `UPDATE order_scan_events SET total_qty = $1, pallets = $2, loose_qty = $3, is_extra = false WHERE id = $4`,
        [orderPortion, orderSplit.pallets, orderSplit.looseQty, ev.id],
      );
      await client.query(
        `INSERT INTO order_scan_events
           (session_id, scan_item_id, barcode, item_name, pallets, loose_qty, total_qty,
            items_per_pallet, is_extra, stv, scanned_by_code, scanned_by_name, scanned_at)
         SELECT session_id, scan_item_id, barcode, item_name, $2, $3, $4,
                items_per_pallet, true, stv, scanned_by_code, scanned_by_name, scanned_at
         FROM order_scan_events WHERE id = $1`,
        [ev.id, extraSplit.pallets, extraSplit.looseQty, extraPortion],
      );
    }
  }
}
