import { db, pool } from '../db';
import { v2Purchase } from './stockV2';
import { orderImportSessions, orderImportItems } from '../../shared/schema';
import { eq, and, asc, inArray } from 'drizzle-orm';

// Shared by order-import.ts (the report endpoint) and order-scan.ts (the live
// "already covered by an earlier part" credit shown while scanning) — kept in its
// own module so neither route file has to import the other just for this.

export type GroupReportEntry = {
  partId: number; sequence: number; csvFileName: string; barcode: string; itemName: string;
  // The PRODUCT of this line: two products can share a barcode (65 g / 60 g), and each is its own line with its own credits.
  productId: number | null;
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
    productWise: Array<{ barcode: string; productId: number | null; itemName: string; itemsPerPallet: number; totalExpected: number; totalReceived: number; totalExtra: number; totalMissing: number; totalAdjusted: number }>;
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

  const sequenceByPartId = new Map(parts.map((p, idx) => [p.id, idx]));

  // A line is a barcode + product. Each CSV row finds its product through the scan item seeded from it (order_scan_items.product_id).
  const { rows: scanItemRows } = await pool.query(
    `SELECT session_id AS "sessionId", order_import_item_id AS "importItemId", barcode, product_id AS "productId", total_scanned_qty AS "totalScannedQty"
     FROM order_scan_items WHERE session_id = ANY($1::int[])`,
    [partIds],
  );
  const pidByImportItem = new Map<number, number | null>();
  const productsOfBarcode = new Map<string, Set<number>>();
  for (const r of scanItemRows as any[]) {
    if (r.importItemId != null) pidByImportItem.set(r.importItemId, r.productId ?? null);
    if (r.barcode && r.productId != null) {
      const k = `${r.sessionId}::${r.barcode}`;
      if (!productsOfBarcode.has(k)) productsOfBarcode.set(k, new Set());
      productsOfBarcode.get(k)!.add(r.productId);
    }
  }
  // An entry with no product (an older scan) belongs to the barcode's only product on that part, when there is exactly one.
  const normPid = (sessionId: number, barcode: string, pid: number | null | undefined): number | null => {
    if (pid != null) return pid;
    const set = productsOfBarcode.get(`${sessionId}::${barcode}`);
    return set && set.size === 1 ? Array.from(set)[0] : null;
  };
  const lk = (sessionId: number, barcode: string, pid: number | null) => `${sessionId}::${barcode}::${pid ?? ''}`;
  const lineOf = (barcode: string, pid: number | null) => `${barcode}::${pid ?? ''}`;

  // Items-per-pallet per line, derived from the CSV rows already loaded above (quantity ÷ expectedPallets) - so the report can carry a pallet count
  // under each qty without any product lookup. First non-zero value per line wins.
  const ippByLine = new Map<string, number>();
  for (const item of importItems) {
    const k = item.barcode ? lineOf(item.barcode, pidByImportItem.get(item.id) ?? null) : null;
    if (!k || ippByLine.has(k)) continue;
    const q = item.quantity ?? 0;
    const ep = item.expectedPallets ?? 0;
    if (q > 0 && ep > 0) ippByLine.set(k, Math.round(q / ep));
  }

  // Extra (over-order) qty per (partId, barcode, product) - sourced from order_scan_events, NOT derived from order_scan_items.total_scanned_qty. The
  // /scan handler caps total_scanned_qty at expected_qty and logs anything beyond it as a separate is_extra=true event, so "received - expected" can
  // never be positive anymore - it would always compute zero extra here.
  const { rows: extraEventRows } = await pool.query(
    `SELECT session_id AS "sessionId", barcode, product_id AS "productId", MAX(item_name) AS "itemName", SUM(total_qty)::int AS "extraQty"
     FROM order_scan_events
     WHERE session_id = ANY($1::int[]) AND is_extra = true AND voided IS NOT TRUE
     GROUP BY session_id, barcode, product_id`,
    [partIds],
  );

  // Expected qty per (partId, barcode, product) - summed in case a CSV lists the same product twice.
  const expectedMap = new Map<string, { expectedQty: number; itemName: string }>();
  for (const item of importItems) {
    if (!item.barcode) continue;
    const key = lk(item.sessionId, item.barcode, pidByImportItem.get(item.id) ?? null);
    const existing = expectedMap.get(key);
    if (existing) existing.expectedQty += item.quantity ?? 0;
    else expectedMap.set(key, { expectedQty: item.quantity ?? 0, itemName: item.itemName ?? item.barcode });
  }

  // Received (order-portion) qty per (partId, barcode, product) - from order_scan_items.total_scanned_qty, which the /scan handler caps at expected_qty.
  // This is ONLY the order-covering portion; the extra portion lives entirely in extraMap below.
  const receivedMap = new Map<string, number>();
  for (const row of scanItemRows as any[]) {
    if (!row.barcode) continue;
    const key = lk(row.sessionId, row.barcode, row.productId ?? null);
    receivedMap.set(key, (receivedMap.get(key) ?? 0) + Number(row.totalScannedQty ?? 0));
  }

  // Extra qty per (partId, barcode, product), from order_scan_events (is_extra=true). Also carries an item-name fallback for products that were
  // scanned as extra but never appeared in that part's own CSV at all (so expectedMap has no entry for them).
  const extraMap = new Map<string, number>();
  const extraItemNameMap = new Map<string, string>();
  for (const row of extraEventRows as any[]) {
    if (!row.barcode) continue;
    const key = lk(row.sessionId, row.barcode, normPid(row.sessionId, row.barcode, row.productId));
    extraMap.set(key, (extraMap.get(key) ?? 0) + Number(row.extraQty ?? 0));
    if (row.itemName) extraItemNameMap.set(key, row.itemName);
  }

  const entriesByBarcode = new Map<string, GroupReportEntry[]>();

  for (const part of parts) {
    const partLines = new Map<string, { barcode: string; pid: number | null }>();
    importItems.forEach((i) => {
      if (i.sessionId !== part.id || !i.barcode) return;
      const pid = pidByImportItem.get(i.id) ?? null;
      partLines.set(lineOf(i.barcode, pid), { barcode: i.barcode, pid });
    });
    // A product scanned as extra on this part but absent from its own CSV entirely still needs an entry here (expectedQty 0) so that extra is
    // available to credit a LATER part that does expect it.
    extraEventRows.forEach((r: any) => {
      if (r.sessionId !== part.id || !r.barcode) return;
      const pid = normPid(r.sessionId, r.barcode, r.productId);
      partLines.set(lineOf(r.barcode, pid), { barcode: r.barcode, pid });
    });
    for (const { barcode, pid } of partLines.values()) {
      const key = lk(part.id, barcode, pid);
      const expected = expectedMap.get(key)?.expectedQty ?? 0;
      const itemName = expectedMap.get(key)?.itemName ?? extraItemNameMap.get(key) ?? barcode;
      const received = receivedMap.get(key) ?? 0;
      const extra = extraMap.get(key) ?? 0;
      const entry: GroupReportEntry = {
        partId: part.id, sequence: sequenceByPartId.get(part.id) ?? 0, csvFileName: part.csvFileName, barcode, productId: pid, itemName,
        itemsPerPallet: ippByLine.get(lineOf(barcode, pid)) ?? 0,
        expectedQty: expected, receivedQty: received + extra,
        extraQty: extra,
        missingQty: Math.max(0, expected - received),
        adjustedTo: [], adjustedFrom: [],
        remainingExtra: 0, remainingMissing: 0,
      };
      const lineKey = lineOf(barcode, pid);
      if (!entriesByBarcode.has(lineKey)) entriesByBarcode.set(lineKey, []);
      entriesByBarcode.get(lineKey)!.push(entry);
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
    .map(([lineKey, entries]) => ({
      barcode: entries[0].barcode,
      productId: entries[0].productId,
      itemName: entries[0]?.itemName ?? entries[0].barcode,
      itemsPerPallet: ippByLine.get(lineKey) ?? 0,
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
  // A line is a barcode + product (two products can share a barcode): each CSV row finds its product through the scan item seeded from it.
  const { rows: scanItemRows } = await pool.query(
    `SELECT order_import_item_id AS "importItemId", barcode, product_id AS "productId", total_scanned_qty AS "totalScannedQty" FROM order_scan_items WHERE session_id = $1`,
    [sessionId],
  );
  const pidByImportItem = new Map<number, number | null>();
  const soleProduct = new Map<string, Set<number>>();
  for (const r of scanItemRows as any[]) {
    if (r.importItemId != null) pidByImportItem.set(r.importItemId, r.productId ?? null);
    if (r.barcode && r.productId != null) {
      if (!soleProduct.has(r.barcode)) soleProduct.set(r.barcode, new Set());
      soleProduct.get(r.barcode)!.add(r.productId);
    }
  }
  const normPid = (barcode: string, pid: number | null | undefined): number | null => {
    if (pid != null) return pid;
    const set = soleProduct.get(barcode);
    return set && set.size === 1 ? Array.from(set)[0] : null;
  };
  const lineOf = (barcode: string, pid: number | null) => `${barcode}::${pid ?? ''}`;
  // Items-per-pallet per line from the CSV rows (quantity / expectedPallets) - no lookup.
  const ippByLine = new Map<string, number>();
  for (const item of importItems) {
    if (!item.barcode) continue;
    const k = lineOf(item.barcode, pidByImportItem.get(item.id) ?? null);
    if (ippByLine.has(k)) continue;
    const q = item.quantity ?? 0;
    const ep = item.expectedPallets ?? 0;
    if (q > 0 && ep > 0) ippByLine.set(k, Math.round(q / ep));
  }
  const receivedMap = new Map<string, number>();
  for (const row of scanItemRows as any[]) {
    if (!row.barcode) continue;
    const k = lineOf(row.barcode, row.productId ?? null);
    receivedMap.set(k, (receivedMap.get(k) ?? 0) + Number(row.totalScannedQty ?? 0));
  }
  // Same reasoning as the group-report path above: total_scanned_qty is capped at expected_qty, so extra has to come from order_scan_events.
  const { rows: extraEventRows } = await pool.query(
    `SELECT barcode, product_id AS "productId", MAX(item_name) AS "itemName", SUM(total_qty)::int AS "extraQty"
     FROM order_scan_events
     WHERE session_id = $1 AND is_extra = true AND voided IS NOT TRUE
     GROUP BY barcode, product_id`,
    [sessionId],
  );
  const extraMap = new Map<string, number>();
  const extraItemNameMap = new Map<string, string>();
  const lineInfo = new Map<string, { barcode: string; pid: number | null }>();
  for (const row of extraEventRows as any[]) {
    if (!row.barcode) continue;
    const pid = normPid(row.barcode, row.productId);
    const k = lineOf(row.barcode, pid);
    extraMap.set(k, (extraMap.get(k) ?? 0) + Number(row.extraQty ?? 0));
    if (row.itemName) extraItemNameMap.set(k, row.itemName);
    lineInfo.set(k, { barcode: row.barcode, pid });
  }
  const expectedMap = new Map<string, { expectedQty: number; itemName: string }>();
  for (const item of importItems) {
    if (!item.barcode) continue;
    const pid = pidByImportItem.get(item.id) ?? null;
    const k = lineOf(item.barcode, pid);
    lineInfo.set(k, { barcode: item.barcode, pid });
    const existing = expectedMap.get(k);
    if (existing) existing.expectedQty += item.quantity ?? 0;
    else expectedMap.set(k, { expectedQty: item.quantity ?? 0, itemName: item.itemName ?? item.barcode });
  }

  const items: GroupReportEntry[] = Array.from(lineInfo.entries()).map(([k, { barcode, pid }]) => {
    const expectedQty = expectedMap.get(k)?.expectedQty ?? 0;
    const itemName = expectedMap.get(k)?.itemName ?? extraItemNameMap.get(k) ?? barcode;
    const received = receivedMap.get(k) ?? 0;
    const extraQty = extraMap.get(k) ?? 0;
    const missingQty = Math.max(0, expectedQty - received);
    return {
      partId: session.id, sequence: 0, csvFileName: session.csvFileName, barcode, productId: pid, itemName,
      itemsPerPallet: ippByLine.get(k) ?? 0,
      expectedQty, receivedQty: received + extraQty, extraQty, missingQty,
      adjustedTo: [], adjustedFrom: [], remainingExtra: extraQty, remainingMissing: missingQty,
    };
  }).sort((a, b) => a.barcode.localeCompare(b.barcode) || (a.productId ?? 0) - (b.productId ?? 0));

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
  productId?: number | null,
): Promise<void> {
  barcode = barcode.trim();
  const totalQty = orderQty + extraQty;
  if (totalQty <= 0) return;
  await v2Purchase(client, { source: 'order', sessionId, plant, barcode, qty: totalQty, extraQty, productId: productId ?? null });
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
  productId?: number | null,
): Promise<void> {
  barcode = barcode.trim();
  const totalQty = orderQty + extraQty;
  if (totalQty <= 0) return;
  await v2Purchase(client, { source: 'order', sessionId, plant, barcode, qty: -totalQty, extraQty: -extraQty, productId: productId ?? null });
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
    `SELECT id, barcode, product_id, item_name, total_qty, credited_qty
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
        // The later part's line for the SAME PRODUCT (two products can share a barcode: an extra of the 65 g never covers a shortfall of the 60 g).
        `SELECT * FROM order_scan_items WHERE session_id = $1 AND barcode = $2 AND ($3::int IS NULL OR product_id IS NULL OR product_id = $3) ORDER BY id FOR UPDATE`,
        [part.id, ev.barcode, ev.product_id ?? null],
      );
      const item = itemRows.find((r: any) => Number(r.expected_qty ?? 0) - Number(r.total_scanned_qty ?? 0) > 0) ?? itemRows[0];
      if (!item) continue; // this later part doesn't expect this product at all
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
            items_per_pallet, is_extra, scanned_by_name, is_credit, credit_source_event_id, product_id)
         VALUES ($1,$2,$3,$4,0,0,$5,0,false,$6,true,$7,$8)`,
        [part.id, item.id, ev.barcode, ev.item_name, take, `System (credited from Part ${completedPart.partIndex})`, ev.id, item.product_id ?? ev.product_id ?? null],
      );

      await client.query(
        `UPDATE order_scan_events SET credited_qty = COALESCE(credited_qty, 0) + $1 WHERE id = $2`,
        [take, ev.id],
      );

      remaining -= take;
    }
  }
}
