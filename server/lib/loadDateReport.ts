import { pool } from '../db';
import { storage } from '../storage';
import { getPlantStateCode, resolvePalletSizeOrQty } from '../routes/order-scan';

// Read-time report across every proforma slip loaded against one plant+order date — the
// Loading-page equivalent of computeUnloadDateReport (server/lib/unloadGroupReport.ts). Loading
// has no FIFO part/group concept at all (each proforma slip is its own independent order), so
// this is simpler than the Unloading version: no cross-slip credit/adjustment netting, just each
// slip's own expected/received/extra/missing, rolled up under one plant+date.
//
// Loading has no "activated at" column on proforma_slips (unlike Unloading's scan_activated_at)
// — a slip's own start time is derived here as the EARLIEST loading_scan_events.scanned_at
// recorded against it; its end time is the existing loadingCompletedAt column, so "in progress"
// vs "done" reads exactly the same as everywhere else this page already shows completion.

export type LoadDateReportItem = {
  barcode: string; itemName: string; itemsPerPallet: number;
  expectedQty: number; receivedQty: number; extraQty: number; missingQty: number;
};
export type LoadDateReportSlip = {
  slipId: number; orderNumber: string; partyName: string; vehicleNumber: string | null;
  startTime: string | null; endTime: string | null; allComplete: boolean;
  items: LoadDateReportItem[];
  summary: { totalExpected: number; totalReceived: number; totalExtra: number; totalMissing: number };
};
export type LoadDateReport = {
  plant: string; orderDate: string;
  slips: LoadDateReportSlip[];
  grand: { totalExpected: number; totalReceived: number; totalExtra: number; totalMissing: number };
};

export async function computeLoadDateReport(plant: string, orderDate: string): Promise<LoadDateReport | null> {
  const { rows: slipRows } = await pool.query(
    `SELECT id, order_number AS "orderNumber", party_name AS "partyName", vehicle_number AS "vehicleNumber",
            loading_completed_at AS "loadingCompletedAt"
     FROM proforma_slips WHERE plant = $1 AND order_date = $2
     ORDER BY order_number ASC, id ASC`,
    [plant, orderDate],
  );
  if (slipRows.length === 0) return null;

  const slipIds = slipRows.map((s: any) => s.id);
  const orderNumbers = slipRows.map((s: any) => s.orderNumber);

  const { rows: itemRows } = await pool.query(
    `SELECT proforma_slip_id AS "slipId", barcode, item_name AS "itemName", quantity
     FROM proforma_slip_items WHERE proforma_slip_id = ANY($1::int[])`,
    [slipIds],
  );
  // Received/extra keyed by orderNumber (loading_scan_events has no proformaSlipId reliably set
  // on every historical row — orderNumber is the column every /scan write has always populated).
  const { rows: receivedRows } = await pool.query(
    `SELECT order_number AS "orderNumber", barcode, COALESCE(SUM(total_qty), 0)::int AS "receivedQty"
     FROM loading_scan_events WHERE order_number = ANY($1::text[]) AND is_extra = false AND voided IS NOT TRUE
     GROUP BY order_number, barcode`,
    [orderNumbers],
  );
  const { rows: extraRows } = await pool.query(
    `SELECT order_number AS "orderNumber", barcode, COALESCE(SUM(total_qty), 0)::int AS "extraQty"
     FROM loading_scan_events WHERE order_number = ANY($1::text[]) AND is_extra = true AND voided IS NOT TRUE
     GROUP BY order_number, barcode`,
    [orderNumbers],
  );
  const { rows: timingRows } = await pool.query(
    `SELECT order_number AS "orderNumber", MIN(scanned_at) AS "startTime"
     FROM loading_scan_events WHERE order_number = ANY($1::text[]) AND voided IS NOT TRUE
     GROUP BY order_number`,
    [orderNumbers],
  );

  const plantForState = slipRows[0].plant ?? plant;
  const state = await getPlantStateCode(pool, plantForState);
  const ippByBarcode = new Map<string, number>();
  async function ippFor(barcode: string, fallbackQty: number): Promise<number> {
    if (ippByBarcode.has(barcode)) return ippByBarcode.get(barcode)!;
    const product = await storage.getProductByBarcode(barcode, plantForState);
    const ipp = resolvePalletSizeOrQty(product ?? null, state, fallbackQty);
    ippByBarcode.set(barcode, ipp);
    return ipp;
  }

  const receivedMap = new Map<string, number>();
  for (const r of receivedRows as any[]) receivedMap.set(`${r.orderNumber}::${r.barcode}`, r.receivedQty);
  const extraMap = new Map<string, number>();
  for (const r of extraRows as any[]) extraMap.set(`${r.orderNumber}::${r.barcode}`, r.extraQty);
  const startTimeMap = new Map<string, string>();
  for (const r of timingRows as any[]) if (r.startTime) startTimeMap.set(r.orderNumber, new Date(r.startTime).toISOString());

  const itemsBySlip = new Map<number, any[]>();
  for (const i of itemRows as any[]) {
    if (!i.barcode) continue;
    if (!itemsBySlip.has(i.slipId)) itemsBySlip.set(i.slipId, []);
    itemsBySlip.get(i.slipId)!.push(i);
  }

  const slips: LoadDateReportSlip[] = [];
  for (const slip of slipRows as any[]) {
    const rawItems = itemsBySlip.get(slip.id) ?? [];
    // Same-barcode lines on one slip are summed into a single item row, same as the live Items
    // table (withProgress in loading.ts) does.
    const expectedByBarcode = new Map<string, { itemName: string; expectedQty: number }>();
    for (const it of rawItems) {
      const existing = expectedByBarcode.get(it.barcode);
      if (existing) existing.expectedQty += it.quantity ?? 0;
      else expectedByBarcode.set(it.barcode, { itemName: it.itemName ?? it.barcode, expectedQty: it.quantity ?? 0 });
    }
    // A barcode scanned as a pure Extra (not on this slip's manifest at all) still needs a row.
    for (const key of extraMap.keys()) {
      const [orderNumber, barcode] = key.split('::');
      if (orderNumber === slip.orderNumber && !expectedByBarcode.has(barcode)) {
        expectedByBarcode.set(barcode, { itemName: barcode, expectedQty: 0 });
      }
    }

    const items: LoadDateReportItem[] = [];
    for (const [barcode, info] of expectedByBarcode.entries()) {
      const key = `${slip.orderNumber}::${barcode}`;
      const received = receivedMap.get(key) ?? 0;
      const extra = extraMap.get(key) ?? 0;
      items.push({
        barcode, itemName: info.itemName,
        itemsPerPallet: await ippFor(barcode, info.expectedQty),
        expectedQty: info.expectedQty, receivedQty: received, extraQty: extra,
        missingQty: Math.max(0, info.expectedQty - received),
      });
    }
    items.sort((a, b) => a.barcode.localeCompare(b.barcode));

    slips.push({
      slipId: slip.id, orderNumber: slip.orderNumber, partyName: slip.partyName, vehicleNumber: slip.vehicleNumber,
      startTime: startTimeMap.get(slip.orderNumber) ?? null,
      endTime: slip.loadingCompletedAt ? new Date(slip.loadingCompletedAt).toISOString() : null,
      allComplete: !!slip.loadingCompletedAt,
      items,
      summary: {
        totalExpected: items.reduce((s, i) => s + i.expectedQty, 0),
        totalReceived: items.reduce((s, i) => s + i.receivedQty, 0),
        totalExtra: items.reduce((s, i) => s + i.extraQty, 0),
        totalMissing: items.reduce((s, i) => s + i.missingQty, 0),
      },
    });
  }
  slips.sort((a, b) => (a.startTime ?? '').localeCompare(b.startTime ?? ''));

  const grand = slips.reduce((acc, s) => ({
    totalExpected: acc.totalExpected + s.summary.totalExpected,
    totalReceived: acc.totalReceived + s.summary.totalReceived,
    totalExtra: acc.totalExtra + s.summary.totalExtra,
    totalMissing: acc.totalMissing + s.summary.totalMissing,
  }), { totalExpected: 0, totalReceived: 0, totalExtra: 0, totalMissing: 0 });

  return { plant, orderDate, slips, grand };
}

// Same plant+orderDate scope, raw scan-event log per slip instead of the netted summary —
// mirrors computeUnloadDateActivity.
export type LoadDateActivityEvent = {
  orderNumber: string; barcode: string | null; itemName: string | null; sapCode: string | null;
  pallets: number | null; looseQty: number | null; totalQty: number | null;
  isExtra: boolean | null; isAdjust: boolean | null; stv: string | null;
  scannedByCode: string | null; scannedByName: string | null; scannedAt: string | null;
  voided: boolean | null; voidedAt: string | null; voidReason: string | null;
};
export type LoadDateActivitySlip = {
  slipId: number; orderNumber: string; partyName: string; vehicleNumber: string | null;
  startTime: string | null; endTime: string | null;
  events: LoadDateActivityEvent[];
};
export type LoadDateActivity = { plant: string; orderDate: string; slips: LoadDateActivitySlip[] };

export async function computeLoadDateActivity(plant: string, orderDate: string): Promise<LoadDateActivity | null> {
  const { rows: slipRows } = await pool.query(
    `SELECT id, order_number AS "orderNumber", party_name AS "partyName", vehicle_number AS "vehicleNumber",
            loading_completed_at AS "loadingCompletedAt"
     FROM proforma_slips WHERE plant = $1 AND order_date = $2
     ORDER BY order_number ASC, id ASC`,
    [plant, orderDate],
  );
  if (slipRows.length === 0) return null;

  const orderNumbers = slipRows.map((s: any) => s.orderNumber);
  const { rows: eventRows } = await pool.query(
    `SELECT order_number AS "orderNumber", barcode, item_name AS "itemName", sap_code AS "sapCode",
            pallets, loose_qty AS "looseQty", total_qty AS "totalQty",
            is_extra AS "isExtra", is_adjust AS "isAdjust", stv, scanned_by_code AS "scannedByCode",
            scanned_by_name AS "scannedByName", scanned_at AS "scannedAt",
            voided, voided_at AS "voidedAt", void_reason AS "voidReason"
     FROM loading_scan_events WHERE order_number = ANY($1::text[]) ORDER BY scanned_at ASC, id ASC`,
    [orderNumbers],
  );

  const eventsByOrder = new Map<string, LoadDateActivityEvent[]>();
  for (const e of eventRows as any[]) {
    if (!eventsByOrder.has(e.orderNumber)) eventsByOrder.set(e.orderNumber, []);
    eventsByOrder.get(e.orderNumber)!.push(e);
  }
  const startTimeMap = new Map<string, string>();
  for (const e of eventRows as any[]) {
    if (!e.scannedAt || e.voided) continue;
    const existing = startTimeMap.get(e.orderNumber);
    const t = new Date(e.scannedAt).toISOString();
    if (!existing || t < existing) startTimeMap.set(e.orderNumber, t);
  }

  const slips: LoadDateActivitySlip[] = slipRows.map((s: any) => ({
    slipId: s.id, orderNumber: s.orderNumber, partyName: s.partyName, vehicleNumber: s.vehicleNumber,
    startTime: startTimeMap.get(s.orderNumber) ?? null,
    endTime: s.loadingCompletedAt ? new Date(s.loadingCompletedAt).toISOString() : null,
    events: eventsByOrder.get(s.orderNumber) ?? [],
  }));
  slips.sort((a, b) => (a.startTime ?? '').localeCompare(b.startTime ?? ''));

  return { plant, orderDate, slips };
}
