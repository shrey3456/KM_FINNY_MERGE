import { db, pool } from '../db';
import { orderImportSessions, orderImportItems } from '../../shared/schema';
import { eq, and, asc, inArray } from 'drizzle-orm';

// Shared by order-import.ts (the report endpoint) and order-scan.ts (the live
// "already covered by an earlier part" credit shown while scanning) — kept in its
// own module so neither route file has to import the other just for this.

export type GroupReportEntry = {
  partId: number; sequence: number; csvFileName: string; barcode: string; itemName: string;
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
    productWise: Array<{ barcode: string; itemName: string; totalExpected: number; totalReceived: number; totalExtra: number; totalMissing: number; totalAdjusted: number }>;
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

  const { rows: scanItemRows } = await pool.query(
    `SELECT session_id AS "sessionId", barcode, total_scanned_qty AS "totalScannedQty"
     FROM order_scan_items WHERE session_id = ANY($1::int[])`,
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

  // Received qty per (partId, barcode) — from order_scan_items.total_scanned_qty, which
  // already includes any over-scan beyond that part's own expected qty (see order-scan.ts's
  // /scan handler — it keeps incrementing total_scanned_qty past expected_qty on purpose).
  // extraQty is derived from this same number (received - expected), NOT re-summed from
  // order_scan_events, so a single over-scanned box is never counted as both "received"
  // and a second time as "extra available to adjust elsewhere".
  const receivedMap = new Map<string, number>();
  for (const row of scanItemRows as any[]) {
    if (!row.barcode) continue;
    const key = `${row.sessionId}::${row.barcode}`;
    receivedMap.set(key, (receivedMap.get(key) ?? 0) + Number(row.totalScannedQty ?? 0));
  }

  const entriesByBarcode = new Map<string, GroupReportEntry[]>();

  for (const part of parts) {
    const partBarcodes = new Set<string>();
    importItems.forEach((i) => { if (i.sessionId === part.id && i.barcode) partBarcodes.add(i.barcode); });
    for (const barcode of partBarcodes) {
      const key = `${part.id}::${barcode}`;
      const expected = expectedMap.get(key)?.expectedQty ?? 0;
      const itemName = expectedMap.get(key)?.itemName ?? barcode;
      const received = receivedMap.get(key) ?? 0;
      const entry: GroupReportEntry = {
        partId: part.id, sequence: sequenceByPartId.get(part.id) ?? 0, csvFileName: part.csvFileName, barcode, itemName,
        expectedQty: expected, receivedQty: received,
        extraQty: Math.max(0, received - expected),
        missingQty: Math.max(0, expected - received),
        adjustedTo: [], adjustedFrom: [],
        remainingExtra: 0, remainingMissing: 0,
      };
      if (!entriesByBarcode.has(barcode)) entriesByBarcode.set(barcode, []);
      entriesByBarcode.get(barcode)!.push(entry);
    }
  }

  // A part's over-scan only becomes available to credit later parts once that part is
  // COMPLETED — while it's still being scanned the "extra" isn't final (more of its own
  // boxes may still arrive), so it must not yet be moved onto another part.
  const completedByPartId = new Map(parts.map((p) => [p.id, p.scanStatus === 'completed']));

  // FIFO netting per barcode: an earlier COMPLETED part's extra offsets a LATER part's missing.
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
      if (entry.extraQty > 0 && completedByPartId.get(entry.partId)) pool_.push({ entry, qty: entry.extraQty });
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
  const { rows: scanItemRows } = await pool.query(
    `SELECT barcode, total_scanned_qty AS "totalScannedQty" FROM order_scan_items WHERE session_id = $1`,
    [sessionId],
  );
  const receivedMap = new Map<string, number>();
  for (const row of scanItemRows as any[]) {
    if (!row.barcode) continue;
    receivedMap.set(row.barcode, (receivedMap.get(row.barcode) ?? 0) + Number(row.totalScannedQty ?? 0));
  }
  const expectedMap = new Map<string, { expectedQty: number; itemName: string }>();
  for (const item of importItems) {
    if (!item.barcode) continue;
    const existing = expectedMap.get(item.barcode);
    if (existing) existing.expectedQty += item.quantity ?? 0;
    else expectedMap.set(item.barcode, { expectedQty: item.quantity ?? 0, itemName: item.itemName ?? item.barcode });
  }

  const items: GroupReportEntry[] = Array.from(expectedMap.entries()).map(([barcode, { expectedQty, itemName }]) => {
    const received = receivedMap.get(barcode) ?? 0;
    const extraQty = Math.max(0, received - expectedQty);
    const missingQty = Math.max(0, expectedQty - received);
    return {
      partId: session.id, sequence: 0, csvFileName: session.csvFileName, barcode, itemName,
      expectedQty, receivedQty: received, extraQty, missingQty,
      adjustedTo: [], adjustedFrom: [], remainingExtra: extraQty, remainingMissing: missingQty,
    };
  }).sort((a, b) => a.barcode.localeCompare(b.barcode));

  return {
    id: session.id, partIndex: session.partIndex ?? 1, csvFileName: session.csvFileName, plant: session.plant,
    scanStatus: session.scanStatus, rowCount: session.rowCount,
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

// Adds a completed session's physically-received boxes to products.in_stock, exactly once.
// "Received" = SUM(order_scan_events.total_qty) per barcode for that session, which covers
// both CSV lines (incl. over-scan) and pure extras. Guarded by stock_applied_at + a row lock
// so a retried /complete (or two racing clicks) can't double-count. Barcodes with no matching
// product row are simply skipped (an extra that isn't in inventory adds nothing). Runs on the
// caller's transaction client so it commits atomically with the completion.
// Returns the number of stock-adjusted barcodes (0 if already applied / nothing scanned).
export async function applySessionStock(client: import('pg').PoolClient, sessionId: number): Promise<number> {
  // Lock the session row and re-check the guard inside the lock.
  const guard = await client.query(
    'SELECT stock_applied_at FROM order_import_sessions WHERE id = $1 FOR UPDATE',
    [sessionId],
  );
  if (guard.rows.length === 0 || guard.rows[0].stock_applied_at != null) return 0;

  const result = await client.query(
    `WITH received AS (
       SELECT LOWER(barcode) AS bc, SUM(total_qty)::int AS qty
       FROM order_scan_events
       WHERE session_id = $1 AND barcode IS NOT NULL AND voided IS NOT TRUE
       GROUP BY LOWER(barcode)
     )
     UPDATE products p
     SET in_stock = COALESCE(p.in_stock, 0) + r.qty
     FROM received r
     WHERE LOWER(p.barcode) = r.bc AND r.qty <> 0`,
    [sessionId],
  );

  await client.query(
    'UPDATE order_import_sessions SET stock_applied_at = $1 WHERE id = $2',
    [new Date(), sessionId],
  );
  return result.rowCount ?? 0;
}
