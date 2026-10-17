import { pool } from '../db';
import { resolveLineProduct } from './productSap';
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
  // Two products can share one barcode (35GM / 37GM salted peanuts); the item is the barcode AND its product.
  productId: number | null; sapCode: string | null;
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
    `SELECT proforma_slip_id AS "slipId", barcode, item_name AS "itemName", quantity, product_id AS "productId", sap_code AS "sapCode"
     FROM proforma_slip_items WHERE proforma_slip_id = ANY($1::int[])`,
    [slipIds],
  );
  // Received/extra keyed by orderNumber (loading_scan_events has no proformaSlipId reliably set
  // on every historical row — orderNumber is the column every /scan write has always populated).
  const { rows: receivedRows } = await pool.query(
    `SELECT order_number AS "orderNumber", barcode, product_id AS "productId", MAX(sap_code) AS "sapCode", COALESCE(SUM(total_qty), 0)::int AS "receivedQty"
     FROM loading_scan_events WHERE order_number = ANY($1::text[]) AND is_extra = false AND voided IS NOT TRUE
     GROUP BY order_number, barcode, product_id`,
    [orderNumbers],
  );
  const { rows: extraRows } = await pool.query(
    `SELECT order_number AS "orderNumber", barcode, product_id AS "productId", MAX(sap_code) AS "sapCode", COALESCE(SUM(total_qty), 0)::int AS "extraQty"
     FROM loading_scan_events WHERE order_number = ANY($1::text[]) AND is_extra = true AND voided IS NOT TRUE
     GROUP BY order_number, barcode, product_id`,
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

  // The product a line / scan means: the one stored on it, else found from its barcode + SAP (the same rule the Loading page uses).
  const productRowCache = new Map<number, any>();
  async function productRowById(id: number): Promise<any | null> {
    if (productRowCache.has(id)) return productRowCache.get(id);
    const { rows } = await pool.query(`SELECT * FROM products WHERE id = $1`, [id]);
    productRowCache.set(id, rows[0] ?? null);
    return rows[0] ?? null;
  }
  async function productOf(barcode: string, productId: number | null, sap: string | null): Promise<{ id: number | null; row: any | null }> {
    if (productId != null) return { id: Number(productId), row: await productRowById(Number(productId)) };
    const lp = await resolveLineProduct(pool, barcode, sap, state);
    return { id: lp.productId, row: lp.row };
  }
  const lineKey = (barcode: string, productId: number | null) => `${barcode}|${productId ?? ''}`;

  // Scan totals per slip line: key = barcode + product.
  type Tot = { received: number; extra: number };
  const totalsByOrder = new Map<string, Map<string, Tot & { barcode: string; productId: number | null; sapCode: string | null }>>();
  const addTotal = async (r: any, field: 'received' | 'extra', qty: number) => {
    const p = await productOf(r.barcode, r.productId ?? null, r.sapCode ?? null);
    if (!totalsByOrder.has(r.orderNumber)) totalsByOrder.set(r.orderNumber, new Map());
    const m = totalsByOrder.get(r.orderNumber)!;
    const k = lineKey(r.barcode, p.id);
    const cur = m.get(k) ?? { received: 0, extra: 0, barcode: r.barcode, productId: p.id, sapCode: r.sapCode ?? null };
    cur[field] += qty;
    m.set(k, cur);
  };
  for (const r of receivedRows as any[]) await addTotal(r, 'received', r.receivedQty);
  for (const r of extraRows as any[]) await addTotal(r, 'extra', r.extraQty);
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
    // Lines of the SAME product (same barcode and product) on one slip are summed into one item row, like the live Items table does; two products that
    // share a barcode stay two rows.
    type Line = { barcode: string; productId: number | null; sapCode: string | null; itemName: string; expectedQty: number; row: any | null };
    const lines = new Map<string, Line>();
    for (const it of rawItems) {
      const p = await productOf(it.barcode, it.productId ?? null, it.sapCode ?? null);
      const k = lineKey(it.barcode, p.id);
      const existing = lines.get(k);
      if (existing) existing.expectedQty += it.quantity ?? 0;
      else lines.set(k, { barcode: it.barcode, productId: p.id, sapCode: it.sapCode ?? null, itemName: it.itemName ?? it.barcode, expectedQty: it.quantity ?? 0, row: p.row });
    }
    // Scans of a barcode that is not on this slip at all (a pure Extra) still need a row.
    const totals = totalsByOrder.get(slip.orderNumber) ?? new Map();
    // A scan with no known product joins the first slip line that has the same barcode.
    const landing = (t: { barcode: string; productId: number | null }) => {
      const exact = lineKey(t.barcode, t.productId);
      if (lines.has(exact)) return exact;
      if (t.productId == null) { for (const [k, l] of lines) if (l.barcode === t.barcode) return k; }
      return exact;
    };
    const perLine = new Map<string, Tot>();
    for (const t of totals.values()) {
      const k = landing(t);
      if (!lines.has(k)) {
        const p = await productOf(t.barcode, t.productId, t.sapCode);
        lines.set(k, { barcode: t.barcode, productId: t.productId, sapCode: t.sapCode, itemName: p.row?.name ?? t.barcode, expectedQty: 0, row: p.row });
      }
      const cur = perLine.get(k) ?? { received: 0, extra: 0 };
      cur.received += t.received; cur.extra += t.extra;
      perLine.set(k, cur);
    }

    const items: LoadDateReportItem[] = [];
    for (const [k, line] of lines.entries()) {
      const t = perLine.get(k) ?? { received: 0, extra: 0 };
      items.push({
        barcode: line.barcode, itemName: line.itemName, productId: line.productId, sapCode: line.sapCode,
        itemsPerPallet: resolvePalletSizeOrQty(line.row, state, line.expectedQty),
        expectedQty: line.expectedQty, receivedQty: t.received, extraQty: t.extra,
        missingQty: Math.max(0, line.expectedQty - t.received),
      });
    }
    items.sort((a, b) => a.barcode.localeCompare(b.barcode) || (a.productId ?? 0) - (b.productId ?? 0));

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
