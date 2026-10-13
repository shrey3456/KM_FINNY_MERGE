import { pool } from '../db';
import { storage } from '../storage';
import { getPlantStateCode, resolvePalletSizeOrQty } from '../routes/order-scan';
import { isSharedBarcode, lineForEvent, linesForBarcode } from './loadingLines';

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
  /** Set when the barcode is shared by two products on the slip (two lines): this row is that product's own line. */
  productId?: number | null;
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
    `SELECT id, proforma_slip_id AS "slipId", barcode, item_name AS "itemName", quantity, product_id AS "productId"
     FROM proforma_slip_items WHERE proforma_slip_id = ANY($1::int[])`,
    [slipIds],
  );
  // Received/extra keyed by orderNumber (loading_scan_events has no proformaSlipId reliably set
  // on every historical row — orderNumber is the column every /scan write has always populated).
  const { rows: receivedRows } = await pool.query(
    `SELECT order_number AS "orderNumber", barcode, product_id AS "productId", COALESCE(SUM(total_qty), 0)::int AS "receivedQty"
     FROM loading_scan_events WHERE order_number = ANY($1::text[]) AND is_extra = false AND voided IS NOT TRUE
     GROUP BY order_number, barcode, product_id`,
    [orderNumbers],
  );
  const { rows: extraRows } = await pool.query(
    `SELECT order_number AS "orderNumber", barcode, product_id AS "productId", COALESCE(SUM(total_qty), 0)::int AS "extraQty"
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
  const ippByBarcode = new Map<string, number>();
  async function ippFor(barcode: string, fallbackQty: number): Promise<number> {
    if (ippByBarcode.has(barcode)) return ippByBarcode.get(barcode)!;
    const product = await storage.getProductByBarcode(barcode, plantForState);
    const ipp = resolvePalletSizeOrQty(product ?? null, state, fallbackQty);
    ippByBarcode.set(barcode, ipp);
    return ipp;
  }

  // Received / extra entries per order+barcode, kept per PRODUCT: two products that share a barcode are two lines of a slip (lib/loadingLines.ts).
  type Grp = { productId: number | null; qty: number };
  const receivedGroups = new Map<string, Grp[]>();
  for (const r of receivedRows as any[]) {
    const k = `${r.orderNumber}::${r.barcode}`;
    if (!receivedGroups.has(k)) receivedGroups.set(k, []);
    receivedGroups.get(k)!.push({ productId: r.productId ?? null, qty: Number(r.receivedQty) });
  }
  const extraGroups = new Map<string, Grp[]>();
  for (const r of extraRows as any[]) {
    const k = `${r.orderNumber}::${r.barcode}`;
    if (!extraGroups.has(k)) extraGroups.set(k, []);
    extraGroups.get(k)!.push({ productId: r.productId ?? null, qty: Number(r.extraQty) });
  }
  const sumGroups = (groups: Grp[], pick: (g: Grp) => boolean) => groups.filter(pick).reduce((t, g) => t + g.qty, 0);
  const startTimeMap = new Map<string, string>();
  for (const r of timingRows as any[]) if (r.startTime) startTimeMap.set(r.orderNumber, new Date(r.startTime).toISOString());

  const itemsBySlip = new Map<number, any[]>();
  for (const i of itemRows as any[]) {
    if (!i.barcode) continue;
    if (!itemsBySlip.has(i.slipId)) itemsBySlip.set(i.slipId, []);
    itemsBySlip.get(i.slipId)!.push(i);
  }
  const productNameCache = new Map<number, string>();
  async function productName(id: number, fallback: string): Promise<string> {
    if (productNameCache.has(id)) return productNameCache.get(id)!;
    const { rows } = await pool.query(`SELECT name FROM products WHERE id = $1`, [id]);
    const name = rows[0]?.name ?? fallback;
    productNameCache.set(id, name);
    return name;
  }

  const slips: LoadDateReportSlip[] = [];
  for (const slip of slipRows as any[]) {
    const rawItems = itemsBySlip.get(slip.id) ?? [];
    const slipLines = rawItems.map((i: any) => ({ id: i.id as number, barcode: i.barcode as string, productId: (i.productId ?? null) as number | null, quantity: i.quantity as number | null, itemName: i.itemName as string | null }));
    const barcodes = Array.from(new Set(slipLines.map((l) => l.barcode)));

    type Row = { barcode: string; itemName: string; expectedQty: number; received: number; extra: number; productId: number | null; shared: boolean };
    const rows: Row[] = [];
    for (const bc of barcodes) {
      const bl = linesForBarcode(slipLines, bc);
      const rGroups = receivedGroups.get(`${slip.orderNumber}::${bc}`) ?? [];
      const eGroups = extraGroups.get(`${slip.orderNumber}::${bc}`) ?? [];
      if (isSharedBarcode(bl)) {
        // Shared barcode: each product is its own line with its own numbers — never merged.
        for (const line of bl) {
          const mine = (g: Grp) => lineForEvent(bl, g.productId)?.id === line.id;
          rows.push({ barcode: bc, itemName: line.itemName ?? bc, expectedQty: line.quantity ?? 0, received: sumGroups(rGroups, mine), extra: sumGroups(eGroups, mine), productId: line.productId, shared: true });
        }
      } else {
        // One product behind the barcode: lines are summed into one row, as before (an Extra for a product that is not on the slip is a row of its own, below).
        const onSlip = (g: Grp) => lineForEvent(bl, g.productId) != null;
        rows.push({ barcode: bc, itemName: bl[0].itemName ?? bc, expectedQty: bl.reduce((t, l) => t + (l.quantity ?? 0), 0), received: sumGroups(rGroups, onSlip), extra: sumGroups(eGroups, onSlip), productId: null, shared: false });
      }
      // entries for a product that shares this barcode but is not on the slip at all
      const strangers = new Map<number, { received: number; extra: number }>();
      for (const g of rGroups) if (g.productId != null && !lineForEvent(bl, g.productId)) strangers.set(g.productId, { received: (strangers.get(g.productId)?.received ?? 0) + g.qty, extra: strangers.get(g.productId)?.extra ?? 0 });
      for (const g of eGroups) if (g.productId != null && !lineForEvent(bl, g.productId)) strangers.set(g.productId, { received: strangers.get(g.productId)?.received ?? 0, extra: (strangers.get(g.productId)?.extra ?? 0) + g.qty });
      for (const [pid, v] of strangers) rows.push({ barcode: bc, itemName: await productName(pid, bc), expectedQty: 0, received: v.received, extra: v.extra, productId: pid, shared: true });
    }
    // A barcode scanned as a pure Extra (not on this slip's manifest at all) still needs a row.
    for (const [key, groups] of extraGroups.entries()) {
      const [orderNumber, barcode] = key.split('::');
      if (orderNumber === slip.orderNumber && !barcodes.includes(barcode)) {
        rows.push({ barcode, itemName: barcode, expectedQty: 0, received: sumGroups(receivedGroups.get(key) ?? [], () => true), extra: sumGroups(groups, () => true), productId: null, shared: false });
      }
    }

    const items: LoadDateReportItem[] = [];
    for (const r of rows) {
      items.push({
        barcode: r.barcode, itemName: r.itemName,
        itemsPerPallet: await ippFor(r.barcode, r.expectedQty),
        expectedQty: r.expectedQty, receivedQty: r.received, extraQty: r.extra,
        missingQty: Math.max(0, r.expectedQty - r.received),
        ...(r.shared ? { productId: r.productId } : {}),
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
