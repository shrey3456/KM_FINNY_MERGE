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
      expectedQty, receivedQty: received + extraQty, extraQty, missingQty,
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

// Adds a completed session's physically-received boxes to stock, exactly once. Writes THREE
// places atomically (all on the caller's transaction client, guarded by stock_applied_at +
// a row lock so a retried /complete can't double-count):
//   1. products.in_stock          — global all-plants running total (backward compat).
//   2. product_plant_stock         — plant-wise running total for THIS session's plant, split
//                                    into in_stock (all boxes, extras included) + extra_qty
//                                    (the over-order portion, shown separately, never hidden).
//   3. stock_movements             — one append-only 'receive' ledger row per barcode.
// "Received" per barcode = SUM(total_qty) over all non-voided events (covers CSV lines incl.
// over-scan AND pure extras). "Extra" per barcode = SUM(total_qty) WHERE is_extra — because
// every scan is split at scan time into a regular event (is_extra=false, capped at the order
// qty) and an extra event (is_extra=true, the overflow), so is_extra already IS the raw extra.
// Barcodes with no matching product row still get plant stock + a movement (an extra that
// isn't in the catalogue is still a physical box), but are skipped for the global products
// update. Returns the number of barcodes that moved stock (0 if already applied / nothing scanned).
export async function applySessionStock(client: import('pg').PoolClient, sessionId: number): Promise<number> {
  // Lock the session row and re-check the guard inside the lock. Also grab the plant.
  const guard = await client.query(
    'SELECT stock_applied_at, plant FROM order_import_sessions WHERE id = $1 FOR UPDATE',
    [sessionId],
  );
  if (guard.rows.length === 0 || guard.rows[0].stock_applied_at != null) return 0;
  const plant: string = guard.rows[0].plant;

  // Per-barcode received + extra for this session. Barcodes are numeric here so the raw
  // string equals its lowercase — MAX(barcode) picks a canonical spelling per group.
  const { rows: received } = await client.query(
    `SELECT MAX(barcode) AS barcode,
            SUM(total_qty)::int AS qty,
            COALESCE(SUM(total_qty) FILTER (WHERE is_extra), 0)::int AS extra_qty
     FROM order_scan_events
     WHERE session_id = $1 AND barcode IS NOT NULL AND voided IS NOT TRUE
     GROUP BY LOWER(barcode)
     HAVING SUM(total_qty) <> 0`,
    [sessionId],
  );

  for (const r of received) {
    // 1. Global all-plants total (only for barcodes that exist in the catalogue).
    await client.query(
      `UPDATE products SET in_stock = COALESCE(in_stock, 0) + $1
       WHERE LOWER(barcode) = LOWER($2)`,
      [r.qty, r.barcode],
    );

    // 2. Plant-wise running total (upsert; extras tracked alongside the physical total).
    await client.query(
      `INSERT INTO product_plant_stock (barcode, plant, in_stock, extra_qty, updated_at)
       VALUES ($1, $2, $3, $4, NOW())
       ON CONFLICT (barcode, plant) DO UPDATE
         SET in_stock  = product_plant_stock.in_stock  + EXCLUDED.in_stock,
             extra_qty = product_plant_stock.extra_qty + EXCLUDED.extra_qty,
             updated_at = NOW()`,
      [r.barcode, plant, r.qty, r.extra_qty],
    );

    // 3. Append-only ledger row (positive = received). Future dispatch inserts negatives.
    await client.query(
      `INSERT INTO stock_movements (barcode, plant, qty, extra_qty, type, reason, session_id, created_at)
       VALUES ($1, $2, $3, $4, 'receive', 'Order scan completed', $5, NOW())`,
      [r.barcode, plant, r.qty, r.extra_qty, sessionId],
    );
  }

  await client.query(
    'UPDATE order_import_sessions SET stock_applied_at = $1 WHERE id = $2',
    [new Date(), sessionId],
  );
  return received.length;
}
