import { pool } from '../db';
import { storage } from '../storage';
import { getPlantStateCode, resolvePalletSizeOrQty } from '../routes/order-scan';

// Read-time FIFO-netted report for a vehicle+date's unload group, mirroring
// computeGroupReport/computePartReport (server/lib/orderGroupReport.ts) — see that file's
// comment for the full FIFO-netting rationale; this is the same computation against unload_*
// tables instead of order_*. Two structural differences from the Order Import version:
//   1. Unloading has no cached "scan items" progress table (order_scan_items) — received/extra
//      per (part, barcode) are summed live from unload_scan_events instead (regular vs is_extra),
//      same source withProgress in unloading.ts already reads from.
//   2. Every unload session always belongs to a group, even a "group of one" (group_id falls back
//      to the session's own id at creation time — see POST /unloading/sessions) — so there's no
//      standalone/no-group case to special-case, unlike Order Import's nullable receivingSessionId.

export type UnloadGroupReportEntry = {
  partId: number; sequence: number; csvFileName: string; barcode: string; itemName: string;
  itemsPerPallet: number;
  expectedQty: number; receivedQty: number; extraQty: number; missingQty: number;
  adjustedTo: { toPartId: number; toCsvFileName: string; qty: number }[];
  adjustedFrom: { fromPartId: number; fromCsvFileName: string; qty: number }[];
  remainingExtra: number; remainingMissing: number;
};

export type UnloadGroupReport = {
  groupId: number; plant: string; vehicleNumber: string;
  parts: Array<{
    id: number; partIndex: number; csvFileName: string; plant: string;
    scanStatus: string | null; rowCount: number | null;
    scanActivatedAt: string | null; scanCompletedAt: string | null;
    items: UnloadGroupReportEntry[];
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

export async function computeUnloadGroupReport(groupId: number): Promise<UnloadGroupReport | null> {
  const { rows: parts } = await pool.query(
    `SELECT id, plant, vehicle_number AS "vehicleNumber", part_index AS "partIndex", csv_file_name AS "csvFileName",
            row_count AS "rowCount", scan_status AS "scanStatus",
            scan_activated_at AS "scanActivatedAt", scan_completed_at AS "scanCompletedAt"
     FROM unload_import_sessions
     WHERE group_id = $1 AND is_deleted = false
     ORDER BY part_index ASC, id ASC`,
    [groupId],
  );
  if (parts.length === 0) return null;

  const partIds = parts.map((p: any) => p.id);
  const { rows: importItems } = await pool.query(
    `SELECT session_id AS "sessionId", barcode, item_name AS "itemName", sap_code AS "sapCode", quantity
     FROM unload_import_items WHERE session_id = ANY($1::int[])`,
    [partIds],
  );

  // Received (order-portion) per (partId, barcode) — regular scans AND credit rows (both
  // is_extra=false; see unload_scan_events' isCredit comment in shared/schema.ts), same source
  // withProgress sums for the live item table.
  const { rows: receivedRows } = await pool.query(
    `SELECT session_id AS "sessionId", barcode, COALESCE(SUM(total_qty), 0)::int AS "receivedQty"
     FROM unload_scan_events
     WHERE session_id = ANY($1::int[]) AND is_extra = false AND voided IS NOT TRUE
     GROUP BY session_id, barcode`,
    [partIds],
  );
  // Extra (over-order) per (partId, barcode).
  const { rows: extraRows } = await pool.query(
    `SELECT session_id AS "sessionId", barcode, MAX(item_name) AS "itemName", COALESCE(SUM(total_qty), 0)::int AS "extraQty"
     FROM unload_scan_events
     WHERE session_id = ANY($1::int[]) AND is_extra = true AND voided IS NOT TRUE
     GROUP BY session_id, barcode`,
    [partIds],
  );

  const sequenceByPartId = new Map(parts.map((p: any, idx: number) => [p.id, idx]));
  const plant = parts[0].plant;
  const state = await getPlantStateCode(pool, plant ?? '');

  const expectedMap = new Map<string, { expectedQty: number; itemName: string; sapCode: string | null; barcode: string }>();
  for (const item of importItems) {
    if (!item.barcode) continue;
    const key = `${item.sessionId}::${item.barcode}`;
    const existing = expectedMap.get(key);
    if (existing) existing.expectedQty += item.quantity ?? 0;
    else expectedMap.set(key, { expectedQty: item.quantity ?? 0, itemName: item.itemName ?? item.barcode, sapCode: item.sapCode ?? null, barcode: item.barcode });
  }
  const receivedMap = new Map<string, number>();
  for (const row of receivedRows as any[]) {
    if (!row.barcode) continue;
    receivedMap.set(`${row.sessionId}::${row.barcode}`, row.receivedQty);
  }
  const extraMap = new Map<string, number>();
  const extraItemNameMap = new Map<string, string>();
  for (const row of extraRows as any[]) {
    if (!row.barcode) continue;
    const key = `${row.sessionId}::${row.barcode}`;
    extraMap.set(key, row.extraQty);
    if (row.itemName) extraItemNameMap.set(key, row.itemName);
  }

  // items-per-pallet resolved the same way the live item table does (per barcode, state-based
  // GJ/MP-PLT lookup, falling back to that barcode's own expected qty as a single pallet) — a
  // real per-product lookup, not derived from any CSV column (unload_import_items has none).
  // Cached by barcode: pallet size is a per-product/state fact, doesn't vary by part.
  const ippByBarcode = new Map<string, number>();
  async function ippFor(barcode: string, fallbackQty: number): Promise<number> {
    if (ippByBarcode.has(barcode)) return ippByBarcode.get(barcode)!;
    const product = await storage.getProductByBarcode(barcode, plant);
    const ipp = resolvePalletSizeOrQty(product ?? null, state, fallbackQty);
    ippByBarcode.set(barcode, ipp);
    return ipp;
  }

  const entriesByBarcode = new Map<string, UnloadGroupReportEntry[]>();

  for (const part of parts) {
    const partBarcodes = new Set<string>();
    importItems.forEach((i: any) => { if (i.sessionId === part.id && i.barcode) partBarcodes.add(i.barcode); });
    extraRows.forEach((r: any) => { if (r.sessionId === part.id && r.barcode) partBarcodes.add(r.barcode); });
    for (const barcode of partBarcodes) {
      const key = `${part.id}::${barcode}`;
      const expected = expectedMap.get(key)?.expectedQty ?? 0;
      const itemName = expectedMap.get(key)?.itemName ?? extraItemNameMap.get(key) ?? barcode;
      const received = receivedMap.get(key) ?? 0;
      const extra = extraMap.get(key) ?? 0;
      const entry: UnloadGroupReportEntry = {
        partId: part.id, sequence: sequenceByPartId.get(part.id) ?? 0, csvFileName: part.csvFileName, barcode, itemName,
        itemsPerPallet: await ippFor(barcode, expected),
        expectedQty: expected, receivedQty: received,
        extraQty: extra,
        missingQty: Math.max(0, expected - received),
        adjustedTo: [], adjustedFrom: [],
        remainingExtra: 0, remainingMissing: 0,
      };
      if (!entriesByBarcode.has(barcode)) entriesByBarcode.set(barcode, []);
      entriesByBarcode.get(barcode)!.push(entry);
    }
  }

  // FIFO netting per barcode — identical algorithm to computeGroupReport (an earlier part's
  // extra offsets a later part's missing), a live read-time view independent of whether
  // reconcileUnloadCredits has actually run yet for this group.
  for (const entries of entriesByBarcode.values()) {
    entries.sort((a, b) => a.sequence - b.sequence);
    const pool_: { entry: UnloadGroupReportEntry; qty: number }[] = [];
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

  const partReports = parts.map((part: any) => {
    const items = allEntries
      .filter((e) => e.partId === part.id)
      .sort((a, b) => a.barcode.localeCompare(b.barcode));
    const totalAdjustedTo = items.reduce((s, e) => s + e.adjustedTo.reduce((s2, a) => s2 + a.qty, 0), 0);
    const totalAdjustedFrom = items.reduce((s, e) => s + e.adjustedFrom.reduce((s2, a) => s2 + a.qty, 0), 0);
    return {
      id: part.id, partIndex: (sequenceByPartId.get(part.id) ?? 0) + 1, csvFileName: part.csvFileName, plant: part.plant,
      scanStatus: part.scanStatus, rowCount: part.rowCount,
      scanActivatedAt: part.scanActivatedAt ? new Date(part.scanActivatedAt).toISOString() : null,
      scanCompletedAt: part.scanCompletedAt ? new Date(part.scanCompletedAt).toISOString() : null,
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
    allComplete: parts.every((p: any) => p.scanStatus === 'completed'),
    productWise,
  };

  return { groupId, plant: parts[0].plant, vehicleNumber: parts[0].vehicleNumber, parts: partReports, consolidated };
}

export async function resolveUnloadGroupId(sessionId: number): Promise<number | null> {
  const { rows } = await pool.query(`SELECT group_id AS "groupId" FROM unload_import_sessions WHERE id = $1`, [sessionId]);
  return rows[0]?.groupId ?? null;
}

export type UnloadPartReport = UnloadGroupReport['parts'][number] & { groupId: number };

// Every unload session always has a group_id (self-id fallback set at creation — see POST
// /unloading/sessions), so this can always go through computeUnloadGroupReport; there's no
// standalone/no-group case to special-case here the way Order Import's nullable
// receivingSessionId needs.
export async function computeUnloadPartReport(sessionId: number): Promise<UnloadPartReport | null> {
  const groupId = await resolveUnloadGroupId(sessionId);
  if (!groupId) return null;
  const report = await computeUnloadGroupReport(groupId);
  const part = report?.parts.find((p) => p.id === sessionId);
  return part ? { ...part, groupId } : null;
}

// A group (computeUnloadGroupReport) is already scoped to one vehicle + one order date — it's
// the vehicle's own FIFO chain of CSV uploads. But on a busy day several DIFFERENT vehicles all
// unload against the same order date, each getting its own separate group_id (grouping is keyed
// by plant+vehicle+date — see unloadImportSessions.groupId in shared/schema.ts). Nothing existing
// ties those sibling vehicles together for one "how did today go" view — this does, purely at
// read time, by finding every group_id that shares this plant+orderDate and running the existing
// per-vehicle group report for each.
export type UnloadDateReportVehicle = {
  vehicleNumber: string; groupId: number;
  // Earliest scanActivatedAt across this vehicle's parts, and latest scanCompletedAt — but only
  // once EVERY part is completed; a vehicle still mid-unload has no real "end" yet.
  startTime: string | null; endTime: string | null; allComplete: boolean;
  parts: UnloadGroupReport['parts']; consolidated: UnloadGroupReport['consolidated'];
};
export type UnloadDateReport = {
  plant: string; orderDate: string;
  vehicles: UnloadDateReportVehicle[];
  grand: { totalExpected: number; totalReceived: number; totalExtra: number; totalMissing: number; netExtraAfterAdjustment: number; netMissingAfterAdjustment: number };
};

export async function computeUnloadDateReport(plant: string, orderDate: string): Promise<UnloadDateReport | null> {
  const { rows: groupRows } = await pool.query(
    `SELECT DISTINCT group_id AS "groupId" FROM unload_import_sessions
     WHERE plant = $1 AND order_date = $2 AND is_deleted = false AND group_id IS NOT NULL`,
    [plant, orderDate],
  );
  if (groupRows.length === 0) return null;

  const vehicles: UnloadDateReportVehicle[] = [];
  for (const { groupId } of groupRows as { groupId: number }[]) {
    const report = await computeUnloadGroupReport(groupId);
    if (!report) continue;
    const starts = report.parts.map((p) => p.scanActivatedAt).filter((t): t is string => !!t);
    const allComplete = report.parts.every((p) => p.scanStatus === 'completed');
    const ends = report.parts.map((p) => p.scanCompletedAt).filter((t): t is string => !!t);
    vehicles.push({
      vehicleNumber: report.vehicleNumber, groupId,
      startTime: starts.length > 0 ? starts.reduce((a, b) => (a < b ? a : b)) : null,
      endTime: allComplete && ends.length === report.parts.length ? ends.reduce((a, b) => (a > b ? a : b)) : null,
      allComplete,
      parts: report.parts, consolidated: report.consolidated,
    });
  }
  // Earliest-starting vehicle first — the order they'd have actually arrived/unloaded in.
  vehicles.sort((a, b) => (a.startTime ?? '').localeCompare(b.startTime ?? ''));

  const grand = vehicles.reduce((acc, v) => ({
    totalExpected: acc.totalExpected + v.consolidated.totalExpected,
    totalReceived: acc.totalReceived + v.consolidated.totalReceived,
    totalExtra: acc.totalExtra + v.consolidated.totalExtra,
    totalMissing: acc.totalMissing + v.consolidated.totalMissing,
    netExtraAfterAdjustment: acc.netExtraAfterAdjustment + v.consolidated.netExtraAfterAdjustment,
    netMissingAfterAdjustment: acc.netMissingAfterAdjustment + v.consolidated.netMissingAfterAdjustment,
  }), { totalExpected: 0, totalReceived: 0, totalExtra: 0, totalMissing: 0, netExtraAfterAdjustment: 0, netMissingAfterAdjustment: 0 });

  return { plant, orderDate, vehicles, grand };
}

// Same plant+orderDate scope as computeUnloadDateReport, but the raw scan-event log per vehicle
// instead of the netted summary — mirrors what GET .../scan-activity?scope=group returns for one
// vehicle, just fanned out across every vehicle that touched this order date.
export type UnloadDateActivityVehicle = {
  vehicleNumber: string; groupId: number;
  sessions: { id: number; partIndex: number | null; csvFileName: string | null; scanActivatedAt: string | null; scanCompletedAt: string | null }[];
  events: ScanActivityEventRow[];
};
export type UnloadDateActivity = { plant: string; orderDate: string; vehicles: UnloadDateActivityVehicle[] };

export type ScanActivityEventRow = {
  sessionId: number; barcode: string | null; itemName: string | null; sapCode: string | null;
  pallets: number | null; looseQty: number | null; totalQty: number | null;
  isExtra: boolean | null; stv: string | null;
  scannedByCode: string | null; scannedByName: string | null; scannedAt: string | null;
  voided: boolean | null; voidedAt: string | null; voidReason: string | null; isCredit: boolean | null;
  partIndex: number | null; csvFileName: string | null;
};

export async function computeUnloadDateActivity(plant: string, orderDate: string): Promise<UnloadDateActivity | null> {
  const { rows: sessionRows } = await pool.query(
    `SELECT id, group_id AS "groupId", vehicle_number AS "vehicleNumber", part_index AS "partIndex", csv_file_name AS "csvFileName",
            scan_activated_at AS "scanActivatedAt", scan_completed_at AS "scanCompletedAt"
     FROM unload_import_sessions
     WHERE plant = $1 AND order_date = $2 AND is_deleted = false
     ORDER BY vehicle_number ASC, part_index ASC, id ASC`,
    [plant, orderDate],
  );
  if (sessionRows.length === 0) return null;

  const sessionIds = sessionRows.map((r: any) => r.id);
  const { rows: eventRows } = await pool.query(
    `SELECT session_id AS "sessionId", barcode, item_name AS "itemName", sap_code AS "sapCode",
            pallets, loose_qty AS "looseQty", total_qty AS "totalQty",
            is_extra AS "isExtra", stv, scanned_by_code AS "scannedByCode",
            scanned_by_name AS "scannedByName", scanned_at AS "scannedAt",
            voided, voided_at AS "voidedAt", void_reason AS "voidReason", is_credit AS "isCredit"
     FROM unload_scan_events WHERE session_id = ANY($1::int[]) ORDER BY scanned_at ASC, id ASC`,
    [sessionIds],
  );

  const sessionMeta = new Map(sessionRows.map((r: any) => [r.id, r]));
  const byGroup = new Map<number, UnloadDateActivityVehicle>();
  for (const r of sessionRows as any[]) {
    if (!byGroup.has(r.groupId)) byGroup.set(r.groupId, { vehicleNumber: r.vehicleNumber, groupId: r.groupId, sessions: [], events: [] });
    byGroup.get(r.groupId)!.sessions.push({
      id: r.id, partIndex: r.partIndex, csvFileName: r.csvFileName,
      scanActivatedAt: r.scanActivatedAt ? new Date(r.scanActivatedAt).toISOString() : null,
      scanCompletedAt: r.scanCompletedAt ? new Date(r.scanCompletedAt).toISOString() : null,
    });
  }
  for (const e of eventRows as any[]) {
    const meta = sessionMeta.get(e.sessionId);
    const bucket = meta ? byGroup.get(meta.groupId) : undefined;
    if (!bucket) continue;
    bucket.events.push({ ...e, partIndex: meta.partIndex, csvFileName: meta.csvFileName });
  }

  const vehicles = Array.from(byGroup.values()).sort((a, b) => {
    const aStart = a.sessions.map((s) => s.scanActivatedAt).filter((t): t is string => !!t).sort()[0] ?? '';
    const bStart = b.sessions.map((s) => s.scanActivatedAt).filter((t): t is string => !!t).sort()[0] ?? '';
    return aStart.localeCompare(bStart);
  });

  return { plant, orderDate, vehicles };
}
