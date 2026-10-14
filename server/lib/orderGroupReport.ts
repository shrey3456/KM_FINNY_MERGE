import { db, pool } from '../db';
import { v2Purchase } from './stockV2';
import { orderImportSessions, orderImportItems } from '../../shared/schema';
import { eq, and, asc, inArray } from 'drizzle-orm';

// Shared by order-import.ts (the report endpoint) and order-scan.ts (the live
// "already covered by an earlier part" credit shown while scanning) — kept in its
// own module so neither route file has to import the other just for this.

export type GroupReportEntry = {
  partId: number; sequence: number; csvFileName: string; barcode: string; itemName: string;
  itemsPerPallet: number;
  expectedQty: number; receivedQty: number; extraQty: number; missingQty: number;
  adjustedTo: { toPartId: number; toCsvFileName: string; qty: number }[];
  adjustedFrom: { fromPartId: number; fromCsvFileName: string; qty: number }[];
  remainingExtra: number; remainingMissing: number;
};

export type GroupReport = {
  groupId: number; plant: string;
  parts: Array<{
    id: number; partIndex: number; csvFileName: string; plant: string;
    scanStatus: string | null; rowCount: number | null;
    scanActivatedAt: string | null; scanCompletedAt: string | null;
    items: GroupReportEntry[];
    summary: {
      totalExpected: number; totalReceived: number; totalExtra: number; totalMissing: number;
      totalAdjustedTo: number; totalAdjustedFrom: number;
      netExtraAfterAdjustment: number; netMissingAfterAdjustment: number;
    };
  }>;
  consolidated: {
    totalExpected: number; totalReceived: number; totalExtra: number; totalMissing: number;
    totalAdjustments: number; finalStockAdded: number;
    netExtraAfterAdjustment: number; netMissingAfterAdjustment: number;
    allComplete: boolean;
    productWise: Array<{ barcode: string; itemName: string; itemsPerPallet: number; totalExpected: number; totalReceived: number; totalExtra: number; totalMissing: number; totalAdjusted: number }>;
  };
};

// Computes the FIFO-netted report for one receiving-session group (a multi-CSV batch
// upload). An earlier part's over-scan (extra) automatically offsets a later part's
// shortfall for the SAME barcode — e.g. a box that arrived early and got scanned
// against Part 1 even though Part 1's CSV was already full for that barcode, and the
// same barcode is short in Part 2, nets out here instead of showing as two separate
// discrepancies. Purely a read-time computation — order_scan_items / order_scan_events
// are the ground truth and are never modified by this.
export async function computeGroupReport(groupId: number): Promise<GroupReport | null> {
  const parts = await db
    .select()
    .from(orderImportSessions)
    .where(and(
      eq(orderImportSessions.receivingSessionId, groupId),
      eq(orderImportSessions.isDeleted, false),
    ))
    .orderBy(asc(orderImportSessions.partIndex), asc(orderImportSessions.id));

  if (parts.length === 0) return null;

  const partIds = parts.map((p) => p.id);
  const importItems = await db.select().from(orderImportItems).where(inArray(orderImportItems.sessionId, partIds));

  // Items-per-pallet per barcode, derived from the CSV rows already loaded above
  // (quantity ÷ expectedPallets) — so the report can carry a pallet count under each qty
  // without any product lookup. First non-zero value per barcode wins.
  const ippByBarcode = new Map<string, number>();
  for (const item of importItems) {
    if (!item.barcode || ippByBarcode.has(item.barcode)) continue;
    const q = item.quantity ?? 0;
    const ep = item.expectedPallets ?? 0;
    if (q > 0 && ep > 0) ippByBarcode.set(item.barcode, Math.round(q / ep));
  }

  const { rows: scanItemRows } = await pool.query(
    `SELECT session_id AS "sessionId", barcode, total_scanned_qty AS "totalScannedQty"
     FROM order_scan_items WHERE session_id = ANY($1::int[])`,
    [partIds],
  );

  // Extra (over-order) qty per (partId, barcode) — sourced from order_scan_events, NOT
  // derived from order_scan_items.total_scanned_qty. The /scan handler caps
  // total_scanned_qty at expected_qty and logs anything beyond it as a separate
  // is_extra=true event (see order-scan.ts's split-at-boundary logic), so "received -
  // expected" can never be positive anymore — it would always compute zero extra here.
  const { rows: extraEventRows } = await pool.query(
    `SELECT session_id AS "sessionId", barcode, MAX(item_name) AS "itemName", SUM(total_qty)::int AS "extraQty"
     FROM order_scan_events
     WHERE session_id = ANY($1::int[]) AND is_extra = true AND voided IS NOT TRUE
     GROUP BY session_id, barcode`,
    [partIds],
  );

  const sequenceByPartId = new Map(parts.map((p, idx) => [p.id, idx]));

  // Expected qty per (partId, barcode) — summed in case a CSV lists the same barcode twice.
  const expectedMap = new Map<string, { expectedQty: number; itemName: string }>();
  for (const item of importItems) {
    if (!item.barcode) continue;
    const key = `${item.sessionId}::${item.barcode}`;
    const existing = expectedMap.get(key);
    if (existing) existing.expectedQty += item.quantity ?? 0;
    else expectedMap.set(key, { expectedQty: item.quantity ?? 0, itemName: item.itemName ?? item.barcode });
  }

  // Received (order-portion) qty per (partId, barcode) — from order_scan_items.total_scanned_qty,
  // which the /scan handler caps at expected_qty (never goes above it — see the split-at-
  // boundary comment above the extraEventRows query). This is ONLY the order-covering
  // portion; the extra portion lives entirely in extraMap below.
  const receivedMap = new Map<string, number>();
  for (const row of scanItemRows as any[]) {
    if (!row.barcode) continue;
    const key = `${row.sessionId}::${row.barcode}`;
    receivedMap.set(key, (receivedMap.get(key) ?? 0) + Number(row.totalScannedQty ?? 0));
  }

  // Extra qty per (partId, barcode), from order_scan_events (is_extra=true). Also carries
  // an item-name fallback for barcodes that were scanned as extra but never appeared in
  // that part's own CSV at all (so expectedMap has no entry for them).
  const extraMap = new Map<string, number>();
  const extraItemNameMap = new Map<string, string>();
  for (const row of extraEventRows as any[]) {
    if (!row.barcode) continue;
    const key = `${row.sessionId}::${row.barcode}`;
    extraMap.set(key, (extraMap.get(key) ?? 0) + Number(row.extraQty ?? 0));
    if (row.itemName) extraItemNameMap.set(key, row.itemName);
  }

  const entriesByBarcode = new Map<string, GroupReportEntry[]>();

  for (const part of parts) {
    const partBarcodes = new Set<string>();
    importItems.forEach((i) => { if (i.sessionId === part.id && i.barcode) partBarcodes.add(i.barcode); });
    // A barcode scanned as extra on this part but absent from its own CSV entirely still
    // needs an entry here (expectedQty 0) so that extra is available to credit a LATER
    // part that does expect this barcode.
    extraEventRows.forEach((r: any) => { if (r.sessionId === part.id && r.barcode) partBarcodes.add(r.barcode); });
    for (const barcode of partBarcodes) {
      const key = `${part.id}::${barcode}`;
      const expected = expectedMap.get(key)?.expectedQty ?? 0;
      const itemName = expectedMap.get(key)?.itemName ?? extraItemNameMap.get(key) ?? barcode;
      const received = receivedMap.get(key) ?? 0;
      const extra = extraMap.get(key) ?? 0;
      const entry: GroupReportEntry = {
        partId: part.id, sequence: sequenceByPartId.get(part.id) ?? 0, csvFileName: part.csvFileName, barcode, itemName,
        itemsPerPallet: ippByBarcode.get(barcode) ?? 0,
        expectedQty: expected, receivedQty: received + extra,
        extraQty: extra,
        missingQty: Math.max(0, expected - received),
        adjustedTo: [], adjustedFrom: [],
        remainingExtra: 0, remainingMissing: 0,
      };
      if (!entriesByBarcode.has(barcode)) entriesByBarcode.set(barcode, []);
      entriesByBarcode.get(barcode)!.push(entry);
    }
  }

  // FIFO netting per barcode: an earlier part's extra offsets a LATER part's missing, live —
  // this is purely a read-time view (nothing here writes to the database), so an in-progress
  // part's extra is included too, not just an already-completed part's. That's deliberately
  // different from reconcileCredits (server/lib/orderGroupReport.ts below), which is the
  // PERMANENT write and still only ever runs once a part is actually marked completed — this
  // computation just lets Master View / the Scan tab / this report show the same "here's what
  // it'll net out to" picture live, before that write happens, instead of showing a false
  // shortfall for stock that already physically arrived.
  for (const entries of entriesByBarcode.values()) {
    entries.sort((a, b) => a.sequence - b.sequence);
    const pool_: { entry: GroupReportEntry; qty: number }[] = [];
    for (const entry of entries) {
      let remainingMissing = entry.missingQty;
      while (remainingMissing > 0 && pool_.length > 0) {
        const src = pool_[0];
        const take = Math.min(src.qty, remainingMissing);
        src.qty -= take;
        remainingMissing -= take;
        src.entry.adjustedTo.push({ toPartId: entry.partId, toCsvFileName: entry.csvFileName, qty: take });
        entry.adjustedFrom.push({ fromPartId: src.entry.partId, fromCsvFileName: src.entry.csvFileName, qty: take });
        if (src.qty === 0) pool_.shift();
      }
      if (entry.extraQty > 0) pool_.push({ entry, qty: entry.extraQty });
    }
  }

  const allEntries = Array.from(entriesByBarcode.values()).flat();
  allEntries.forEach((e) => {
    e.remainingExtra = Math.max(0, e.extraQty - e.adjustedTo.reduce((s, a) => s + a.qty, 0));
    e.remainingMissing = Math.max(0, e.missingQty - e.adjustedFrom.reduce((s, a) => s + a.qty, 0));
  });

  const partReports = parts.map((part) => {
    const items = allEntries
      .filter((e) => e.partId === part.id)
      .sort((a, b) => a.barcode.localeCompare(b.barcode));
    const totalAdjustedTo = items.reduce((s, e) => s + e.adjustedTo.reduce((s2, a) => s2 + a.qty, 0), 0);
    const totalAdjustedFrom = items.reduce((s, e) => s + e.adjustedFrom.reduce((s2, a) => s2 + a.qty, 0), 0);
    return {
      id: part.id, partIndex: (sequenceByPartId.get(part.id) ?? 0) + 1, csvFileName: part.csvFileName, plant: part.plant,
      scanStatus: part.scanStatus, rowCount: part.rowCount,
      // When this part's scanning actually started/finished (order_import_sessions.scan_
      // activated_at/scan_completed_at) — set once each, at /activate and /complete. Carried
      // through to the report/export layer so Start/End/duration can show there too.
      scanActivatedAt: part.scanActivatedAt ? part.scanActivatedAt.toISOString() : null,
      scanCompletedAt: part.scanCompletedAt ? part.scanCompletedAt.toISOString() : null,
      items,
      summary: {
        totalExpected: items.reduce((s, e) => s + e.expectedQty, 0),
        totalReceived: items.reduce((s, e) => s + e.receivedQty, 0),
        totalExtra: items.reduce((s, e) => s + e.extraQty, 0),
        totalMissing: items.reduce((s, e) => s + e.missingQty, 0),
        totalAdjustedTo, totalAdjustedFrom,
        netExtraAfterAdjustment: items.reduce((s, e) => s + e.remainingExtra, 0),
        netMissingAfterAdjustment: items.reduce((s, e) => s + e.remainingMissing, 0),
      },
    };
  });

  const productWise = Array.from(entriesByBarcode.entries())
    .map(([barcode, entries]) => ({
      barcode,
      itemName: entries[0]?.itemName ?? barcode,
      itemsPerPallet: ippByBarcode.get(barcode) ?? 0,
      totalExpected: entries.reduce((s, e) => s + e.expectedQty, 0),
      totalReceived: entries.reduce((s, e) => s + e.receivedQty, 0),
      totalExtra: entries.reduce((s, e) => s + e.extraQty, 0),
      totalMissing: entries.reduce((s, e) => s + e.missingQty, 0),
      totalAdjusted: entries.reduce((s, e) => s + e.adjustedTo.reduce((s2, a) => s2 + a.qty, 0), 0),
    }))
    .sort((a, b) => a.barcode.localeCompare(b.barcode));

  const consolidated = {
    totalExpected: partReports.reduce((s, p) => s + p.summary.totalExpected, 0),
    totalReceived: partReports.reduce((s, p) => s + p.summary.totalReceived, 0),
    totalExtra: partReports.reduce((s, p) => s + p.summary.totalExtra, 0),
    totalMissing: partReports.reduce((s, p) => s + p.summary.totalMissing, 0),
    totalAdjustments: partReports.reduce((s, p) => s + p.summary.totalAdjustedTo, 0),
    finalStockAdded: partReports.reduce((s, p) => s + p.summary.totalReceived, 0),
    netExtraAfterAdjustment: partReports.reduce((s, p) => s + p.summary.netExtraAfterAdjustment, 0),
    netMissingAfterAdjustment: partReports.reduce((s, p) => s + p.summary.netMissingAfterAdjustment, 0),
    allComplete: parts.every((p) => p.scanStatus === 'completed'),
    productWise,
  };

  return { groupId, plant: parts[0].plant, parts: partReports, consolidated };
}

// Resolves the group id for a given part: a part's group id is its own receivingSessionId
// if set, else — for a standalone (non-batch) import — there is no group at all.
export async function resolveGroupId(sessionId: number): Promise<number | null> {
  const [session] = await db.select({ receivingSessionId: orderImportSessions.receivingSessionId })
    .from(orderImportSessions)
    .where(eq(orderImportSessions.id, sessionId));
  return session?.receivingSessionId ?? null;
}

export type PartReport = GroupReport['parts'][number] & { groupId: number | null };

// Single-CSV report, downloadable per part without waiting for the whole group. For a
// part of a FIFO group it slices that part out of the full group report (so its cross-part
// adjustments from/to other parts are included). For a standalone import it computes just
// that one CSV's expected/received/extra/missing (no adjustments — there's nothing to net
// against). Returns null if the session doesn't exist.
export async function computePartReport(sessionId: number): Promise<PartReport | null> {
  const groupId = await resolveGroupId(sessionId);
  if (groupId) {
    const report = await computeGroupReport(groupId);
    const part = report?.parts.find((p) => p.id === sessionId);
    return part ? { ...part, groupId } : null;
  }

  // Standalone: build the same part shape from this one session's items alone.
  const [session] = await db.select().from(orderImportSessions).where(eq(orderImportSessions.id, sessionId));
  if (!session) return null;

  const importItems = await db.select().from(orderImportItems).where(eq(orderImportItems.sessionId, sessionId));
  // Items-per-pallet per barcode from the CSV rows (quantity ÷ expectedPallets) — no lookup.
  const ippByBarcode = new Map<string, number>();
  for (const item of importItems) {
    if (!item.barcode || ippByBarcode.has(item.barcode)) continue;
    const q = item.quantity ?? 0;
    const ep = item.expectedPallets ?? 0;
    if (q > 0 && ep > 0) ippByBarcode.set(item.barcode, Math.round(q / ep));
  }
  const { rows: scanItemRows } = await pool.query(
    `SELECT barcode, total_scanned_qty AS "totalScannedQty" FROM order_scan_items WHERE session_id = $1`,
    [sessionId],
  );
  const receivedMap = new Map<string, number>();
  for (const row of scanItemRows as any[]) {
    if (!row.barcode) continue;
    receivedMap.set(row.barcode, (receivedMap.get(row.barcode) ?? 0) + Number(row.totalScannedQty ?? 0));
  }
  // Same reasoning as the group-report path above: total_scanned_qty is capped at
  // expected_qty, so extra has to come from order_scan_events, not from over-received math.
  const { rows: extraEventRows } = await pool.query(
    `SELECT barcode, MAX(item_name) AS "itemName", SUM(total_qty)::int AS "extraQty"
     FROM order_scan_events
     WHERE session_id = $1 AND is_extra = true AND voided IS NOT TRUE
     GROUP BY barcode`,
    [sessionId],
  );
  const extraMap = new Map<string, number>();
  const extraItemNameMap = new Map<string, string>();
  for (const row of extraEventRows as any[]) {
    if (!row.barcode) continue;
    extraMap.set(row.barcode, (extraMap.get(row.barcode) ?? 0) + Number(row.extraQty ?? 0));
    if (row.itemName) extraItemNameMap.set(row.barcode, row.itemName);
  }
  const expectedMap = new Map<string, { expectedQty: number; itemName: string }>();
  for (const item of importItems) {
    if (!item.barcode) continue;
    const existing = expectedMap.get(item.barcode);
    if (existing) existing.expectedQty += item.quantity ?? 0;
    else expectedMap.set(item.barcode, { expectedQty: item.quantity ?? 0, itemName: item.itemName ?? item.barcode });
  }
  // Union of CSV barcodes and extra-only barcodes (scanned but never on this CSV at all).
  const allBarcodes = new Set<string>([...expectedMap.keys(), ...extraMap.keys()]);

  const items: GroupReportEntry[] = Array.from(allBarcodes).map((barcode) => {
    const expectedQty = expectedMap.get(barcode)?.expectedQty ?? 0;
    const itemName = expectedMap.get(barcode)?.itemName ?? extraItemNameMap.get(barcode) ?? barcode;
    const received = receivedMap.get(barcode) ?? 0;
    const extraQty = extraMap.get(barcode) ?? 0;
    const missingQty = Math.max(0, expectedQty - received);
    return {
      partId: session.id, sequence: 0, csvFileName: session.csvFileName, barcode, itemName,
      itemsPerPallet: ippByBarcode.get(barcode) ?? 0,
      expectedQty, receivedQty: received + extraQty, extraQty, missingQty,
      adjustedTo: [], adjustedFrom: [], remainingExtra: extraQty, remainingMissing: missingQty,
    };
  }).sort((a, b) => a.barcode.localeCompare(b.barcode));

  return {
    id: session.id, partIndex: session.partIndex ?? 1, csvFileName: session.csvFileName, plant: session.plant,
    scanStatus: session.scanStatus, rowCount: session.rowCount,
    scanActivatedAt: session.scanActivatedAt ? session.scanActivatedAt.toISOString() : null,
    scanCompletedAt: session.scanCompletedAt ? session.scanCompletedAt.toISOString() : null,
    items,
    summary: {
      totalExpected: items.reduce((s, e) => s + e.expectedQty, 0),
      totalReceived: items.reduce((s, e) => s + e.receivedQty, 0),
      totalExtra: items.reduce((s, e) => s + e.extraQty, 0),
      totalMissing: items.reduce((s, e) => s + e.missingQty, 0),
      totalAdjustedTo: 0, totalAdjustedFrom: 0,
      netExtraAfterAdjustment: items.reduce((s, e) => s + e.extraQty, 0),
      netMissingAfterAdjustment: items.reduce((s, e) => s + e.missingQty, 0),
    },
    groupId: null,
  };
}

// Applies ONE physical scan's stock delta immediately, instead of waiting for the session to complete. Called once per scan request with the real
// order/extra split determined by the sequential cross-part resolver in order-scan.ts's /scan handler - never once per bookkeeping event. That
// distinction matters because a single scan can generate TWO report-level events (an Extra logged against the current "front" part plus a Scanned
// logged against whichever later part actually matched); both describe the same physical box, so stock must only move once for it.
// The stock is Stock Overview: a purchase at the plant's line for the barcode, on the CSV's day. `sessionId` picks the CSV (its day and its SAP code).
export async function applyLiveScanStock(
  client: import('pg').PoolClient,
  plant: string,
  barcode: string,
  orderQty: number,
  extraQty: number,
  sessionId: number,
): Promise<void> {
  barcode = barcode.trim();
  const totalQty = orderQty + extraQty;
  if (totalQty <= 0) return;
  await v2Purchase(client, { source: 'order', sessionId, plant, barcode, qty: totalQty, extraQty });
}

// Reverses applyLiveScanStock - used when an admin voids a mistaken scan. Takes back out of the same day's purchase exactly what the original scan
// added. Callers check the boxes are still in stock first (see the void / edit handlers in order-scan.ts).
export async function reverseLiveScanStock(
  client: import('pg').PoolClient,
  plant: string,
  barcode: string,
  orderQty: number,
  extraQty: number,
  sessionId: number,
): Promise<void> {
  barcode = barcode.trim();
  const totalQty = orderQty + extraQty;
  if (totalQty <= 0) return;
  await v2Purchase(client, { source: 'order', sessionId, plant, barcode, qty: -totalQty, extraQty: -extraQty });
}

// Makes the "already covered by an earlier part" credit REAL instead of a display-only
// number. Previously, the Scan tab computed `totalScannedQty + creditQty` purely client-side
// to decide what to show — nothing was ever written back, so Master View and Auto Complete
// (which both read the real order_scan_items.status) never agreed with what the Scan tab
// displayed, and a part containing a "credited" item could never satisfy Auto Complete's
// "all items scanned" check since its real status stayed 'partial' forever.
//
// Called once, right when a part is marked completed (manual Complete, auto-complete-on-
// scan, or the stale-part sweep) — the same moment computeGroupReport's read-time netting
// already considers this part's extra "available" to credit later parts. For every
// un-consumed extra event on the just-completed part, walks forward through later
// (higher-partIndex, not-yet-completed) parts in the same group and, for any real shortfall
// on the same barcode, writes the credit for real: bumps the later part's total_scanned_qty
// and status, and logs a distinctly-tagged scan event there for visibility in history.
// Never touches stock — the physical stock for these boxes was already added when the
// original extra was scanned. `credited_qty` on the source event is incremented so the same
// physical boxes can never be handed out as a credit twice.
export async function reconcileCredits(
  client: import('pg').PoolClient,
  completedSessionId: number,
  groupId: number,
): Promise<void> {
  const { rows: parts } = await client.query(
    `SELECT id, part_index AS "partIndex", scan_status AS "scanStatus"
     FROM order_import_sessions
     WHERE (receiving_session_id = $1 OR id = $1) AND is_deleted = false
     ORDER BY part_index ASC, id ASC`,
    [groupId],
  );
  const completedPart = parts.find((p: any) => p.id === completedSessionId);
  if (!completedPart) return;

  const laterParts = parts.filter(
    (p: any) => (p.partIndex ?? 0) > (completedPart.partIndex ?? 0) && p.scanStatus !== 'completed',
  );
  if (laterParts.length === 0) return;

  // Un-consumed extra events on the just-completed part, oldest first (FIFO), locked so a
  // concurrent reconciliation run can never hand out the same boxes twice.
  const { rows: extraEvents } = await client.query(
    `SELECT id, barcode, item_name, total_qty, credited_qty
     FROM order_scan_events
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
        `SELECT * FROM order_scan_items WHERE session_id = $1 AND barcode = $2 FOR UPDATE`,
        [part.id, ev.barcode],
      );
      const item = itemRows[0];
      if (!item) continue; // this later part doesn't expect this barcode at all
      const shortfall = Math.max(0, Number(item.expected_qty ?? 0) - Number(item.total_scanned_qty ?? 0));
      if (shortfall <= 0) continue;

      const take = Math.min(remaining, shortfall);

      await client.query(
        `UPDATE order_scan_items
         SET total_scanned_qty = COALESCE(total_scanned_qty, 0) + $1,
             status = CASE
               WHEN COALESCE(total_scanned_qty, 0) + $1 >= expected_qty THEN 'complete'
               WHEN COALESCE(total_scanned_qty, 0) + $1 > 0             THEN 'partial'
               ELSE 'pending'
             END,
             last_scanned_at = NOW()
         WHERE id = $2`,
        [take, item.id],
      );

      await client.query(
        `INSERT INTO order_scan_events
           (session_id, scan_item_id, barcode, item_name, pallets, loose_qty, total_qty,
            items_per_pallet, is_extra, scanned_by_name, is_credit, credit_source_event_id)
         VALUES ($1,$2,$3,$4,0,0,$5,0,false,$6,true,$7)`,
        [part.id, item.id, ev.barcode, ev.item_name, take, `System (credited from Part ${completedPart.partIndex})`, ev.id],
      );

      await client.query(
        `UPDATE order_scan_events SET credited_qty = COALESCE(credited_qty, 0) + $1 WHERE id = $2`,
        [take, ev.id],
      );

      remaining -= take;
    }
  }
}
