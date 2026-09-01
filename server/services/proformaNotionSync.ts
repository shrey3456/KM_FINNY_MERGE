// Shared logic for pulling proforma slip data out of Notion (dispatch DB + order DB), used by
// both the direct "Import from Notion" flow (server/routes/fast-notion-import.ts — fetch and
// write immediately) and the "Sync from Notion" detect/apply flow (server/routes/proforma-
// notion-sync.ts — fetch, diff against what's already in the DB, let the user review, then
// write only on confirmation). Pulling this into one place means both flows always read Notion
// the same way instead of drifting apart like the two Notion-import routes previously did.

import { Client } from '@notionhq/client';
import { storage } from '../storage';
import { extractText } from '../lib/notionProperties';
import type { InsertProformaSlip } from '@shared/schema';

export interface OrderItemData {
  productId: number;
  productSrNo: string | null;
  productName: string;
  quantity: number;
}

export interface OrderData {
  orderNumber: string;
  orderDate: string; // "YYYY-MM-DD"
  partyName: string;
  plant: string;
  vehicleNumber: string;
  invoiceNumber: string;
  partyState: string;
  notionStatus: string;
  storeKeeperInfo: string;
  authoritativeQty: number | undefined;
  notionRawData: Record<string, string>;
  items: Map<string, OrderItemData>;
}

function getDatabaseId(): string {
  const notionPageUrl = process.env.NOTION_PAGE_URL!;
  const match = notionPageUrl.match(/([a-f0-9]{32})/);
  if (!match) throw new Error('Invalid Notion page URL - could not extract database ID');
  return match[1];
}

// Normalizes a date string of unknown origin (Notion ISO rollup, Notion "DD/MM/YY" formula
// text, or the request's own "YYYY-MM-DD" startDate) into "YYYY-MM-DD" for the Postgres `date`
// column. Deliberately does NOT use `new Date(dateString)` on slash-separated input — that
// parses as MM/DD/YY, which either silently gives the wrong date or throws when the "day"
// isn't a valid month (e.g. "26/08/2026" -> month 26).
function normalizeToISODate(dateString: string, fallback: string): string {
  if (/^\d{4}-\d{2}-\d{2}/.test(dateString)) {
    return dateString.slice(0, 10);
  }
  const slashMatch = dateString.match(/^(\d{1,2})\/(\d{1,2})\/(\d{2,4})$/);
  if (slashMatch) {
    const [, d, m, y] = slashMatch;
    const year = y.length === 2 ? `20${y}` : y;
    const day = d.padStart(2, '0');
    const month = m.padStart(2, '0');
    if (Number(day) >= 1 && Number(day) <= 31 && Number(month) >= 1 && Number(month) <= 12) {
      return `${year}-${month}-${day}`;
    }
  }
  return fallback;
}

// Fetches every order in [startDate, endDate] from the dispatch DB, cross-referenced with the
// (much larger, separately-paged) ORDER database for the fields authoritative there — Plant,
// Status, and total Quantity. See server/routes/fast-notion-import.ts's original comments for
// why those three specifically come from the Order DB rather than the dispatch DB.
export async function fetchProformaOrdersFromNotion(
  startDate: string,
  endDate: string,
): Promise<Map<string, OrderData>> {
  const notion = new Client({ auth: process.env.NOTION_INTEGRATION_SECRET });
  const databaseId = getDatabaseId();

  const allProducts = await storage.getAllProducts();
  const productBySrNo = new Map<string, (typeof allProducts)[number]>();
  for (const product of allProducts) {
    if (product.newSr) productBySrNo.set(product.newSr.toLowerCase(), product);
  }

  const ORDER_DATABASE_ID = process.env.ORDER_DATABASE_ID;
  if (!ORDER_DATABASE_ID) throw new Error('ORDER_DATABASE_ID environment variable is not set');

  // STEP 1: Order DB — Plant / Status / Quantity, filtered by its own plain "Ord Date :" property.
  const orderInfoMap = new Map<string, { plant: string; status: string; qty: number | undefined }>();
  {
    let cursor: string | undefined = undefined;
    let hasMore = true;
    while (hasMore) {
      const orderResponse = await notion.databases.query({
        database_id: ORDER_DATABASE_ID,
        page_size: 100,
        start_cursor: cursor,
        filter: {
          and: [
            { property: 'Ord Date :', date: { on_or_after: startDate } },
            { property: 'Ord Date :', date: { on_or_before: endDate } },
          ],
        },
      });

      orderResponse.results.forEach((orderPage: any) => {
        if (!('properties' in orderPage)) return;
        const orderProps = orderPage.properties;
        const orderNumber = extractText(orderProps['Order No. :']);
        if (!orderNumber) return;
        const plantValue = extractText(orderProps['Stk Plant :']);
        const statusValue = extractText(orderProps['Finny Status :']);
        const qty = orderProps['Proforma Qty :']?.rollup?.number ?? orderProps['For Qty :']?.formula?.number ?? undefined;
        orderInfoMap.set(orderNumber, { plant: plantValue, status: statusValue, qty });
      });

      hasMore = orderResponse.has_more;
      cursor = orderResponse.next_cursor ?? undefined;
    }
  }

  // STEP 2: Dispatch DB — everything else, filtered by its own "Ord Date :" rollup.
  const ordersMap = new Map<string, OrderData>();
  {
    let cursor: string | undefined = undefined;
    let hasMore = true;
    while (hasMore) {
      const response = await notion.databases.query({
        database_id: databaseId,
        page_size: 100,
        start_cursor: cursor,
        filter: {
          and: [
            { property: 'Ord Date :', rollup: { date: { on_or_after: startDate } } },
            { property: 'Ord Date :', rollup: { date: { on_or_before: endDate } } },
          ],
        },
      });

      for (const page of response.results) {
        if (!('properties' in page)) continue;
        const properties = page.properties as Record<string, any>;

        const row: Record<string, string> = {};
        const numericCols: Record<string, number> = {};
        for (const [key, value] of Object.entries(properties)) {
          const prop = value as any;
          const text = extractText(prop);
          if (text) row[key] = text;
          if (prop.type === 'number' && prop.number != null) {
            numericCols[key] = prop.number;
          }
        }

        const orderNo = row['Order No. :'] || row['For Order No. :'] || row['For Ord No. :'] || row['Order No.'] || '';
        if (!orderNo) continue;

        const rawOrderDate = row['Ord Date :'] || row['For Ord Date :'] || startDate;
        const ordDate = normalizeToISODate(rawOrderDate, startDate);
        const partyName = row['For Party Name '] || row['For Party Name'] || row['For Party Name :'] || 'Unknown Party';
        const orderInfo = orderInfoMap.get(orderNo);
        const plant = orderInfo?.plant || row['Plant :'] || row['Plant'] || 'VALSAD';
        const notionStatus = orderInfo?.status || row['+ / - Status :'] || '';
        const vehicleNumber = row['Vehi No:'] || row['Vehi No :'] || row['Vehicle No.'] || '';
        const invoiceNumber = row['Invoice No. :'] || row['For Invoice No. :'] || '';
        const partyState = row['Party State :'] || row['For State :'] || '';
        const storeKeeperInfo = row['StoreKeeper & Platform info :'] || '';

        if (!ordersMap.has(orderNo)) {
          ordersMap.set(orderNo, {
            orderNumber: orderNo,
            orderDate: ordDate,
            partyName,
            plant,
            vehicleNumber,
            invoiceNumber,
            partyState,
            notionStatus,
            storeKeeperInfo,
            authoritativeQty: orderInfo?.qty,
            notionRawData: row,
            items: new Map(),
          });
        }

        const order = ordersMap.get(orderNo)!;

        for (const [key, value] of Object.entries(numericCols)) {
          if (value > 0) {
            let srNo = '';
            if (/^[A-Z]\d+/.test(key)) {
              srNo = key.split(' ')[0] || key.split('{')[0] || key;
            }
            if (srNo) {
              const matchedProduct = productBySrNo.get(srNo.toLowerCase());
              if (matchedProduct) {
                if (order.items.has(srNo)) {
                  order.items.get(srNo)!.quantity += value;
                } else {
                  order.items.set(srNo, {
                    productId: matchedProduct.id,
                    productSrNo: matchedProduct.newSr,
                    productName: matchedProduct.name,
                    quantity: value,
                  });
                }
              }
            }
          }
        }
      }

      hasMore = response.has_more;
      cursor = response.next_cursor ?? undefined;
    }
  }

  return ordersMap;
}

// Writes one order's data to the DB: creates a new slip or updates the existing one (matched by
// order number — never creates a duplicate slip for the same order), replaces its items, and
// recomputes totals. Returns what actually happened, for reporting to the caller.
export async function writeOrderToDb(orderData: OrderData): Promise<{
  created: boolean;
  itemsCreated: number;
  totalQuantity: number;
  totalVolume: string;
}> {
  const existingSlip = await storage.getProformaSlipByOrderNumber(orderData.orderNumber);

  const notionFields: Partial<InsertProformaSlip> = {
    orderNumber: orderData.orderNumber,
    orderDate: orderData.orderDate,
    partyName: orderData.partyName,
    plant: orderData.plant,
    vehicleNumber: orderData.vehicleNumber || undefined,
    invoiceNumber: orderData.invoiceNumber || undefined,
    partyState: orderData.partyState || undefined,
    notionStatus: orderData.notionStatus || undefined,
    storeKeeperInfo: orderData.storeKeeperInfo || undefined,
    notionRawData: orderData.notionRawData,
  };

  let slipId: number;
  let created = false;

  if (existingSlip) {
    slipId = existingSlip.id;
    const existingItems = await storage.getProformaSlipItems(slipId);
    for (const item of existingItems) {
      await storage.deleteProformaSlipItem(item.id);
    }
    await storage.updateProformaSlip(slipId, notionFields);
  } else {
    const newSlip = await storage.createProformaSlip({
      ...(notionFields as InsertProformaSlip),
      totalQuantity: 0,
      totalVolume: '0.00',
      notes: 'Fast Import from Notion',
    });
    slipId = newSlip.id;
    created = true;
  }

  let itemsCreated = 0;
  let totalQuantity = 0;
  let totalVolume = 0;
  for (const [, itemData] of Array.from(orderData.items.entries())) {
    const product = await storage.getProduct(itemData.productId);
    if (product) {
      await storage.createProformaSlipItem({
        proformaSlipId: slipId,
        productId: product.id,
        quantity: itemData.quantity,
        srNo: product.newSr || '',
        itemNo: product.itemNo || '',
        barcode: product.barcode || '',
        itemName: product.name || '',
        category: product.category || '',
        volumeInCuFt: product.volumeInCuFt || '',
        hsnCode: product.hsnCode || '',
        sapCode: product.sapCode || '',
        description: product.description || '',
        purchasePrice: product.purchasePrice || '',
        sellingPrice: product.sellingPrice || '',
      });
      itemsCreated++;
      totalQuantity += itemData.quantity;
      const volumePerUnit = parseFloat(product.volumeInCuFt || '0');
      if (Number.isFinite(volumePerUnit)) {
        totalVolume += volumePerUnit * itemData.quantity;
      }
    }
  }

  const finalTotalQuantity = orderData.authoritativeQty ?? totalQuantity;
  const finalTotalVolume = totalVolume.toFixed(2);

  await storage.updateProformaSlip(slipId, {
    totalQuantity: finalTotalQuantity,
    totalVolume: finalTotalVolume,
  });

  return { created, itemsCreated, totalQuantity: finalTotalQuantity, totalVolume: finalTotalVolume };
}

// ─── Detect / diff for the "Sync from Notion" review flow ─────────────────────

export interface FieldChange {
  field: string;
  from: string;
  to: string;
}

export interface OrderDiff {
  orderNumber: string;
  partyName: string;
  isNew: boolean;
  fieldChanges: FieldChange[];
  itemChanges: string[]; // human-readable lines, e.g. "C058: 10 -> 15", "+ New SKU C036: 30", "- Removed SKU C099"
}

export interface SyncReport {
  syncTime: Date;
  startDate: string;
  endDate: string;
  totalOrders: number;
  newCount: number;
  changedCount: number;
  unchangedCount: number;
  diffs: OrderDiff[]; // new + changed orders only, unchanged omitted from detail
  triggeredBy: string;
}

let isSyncing = false;
let pendingOrders: Map<string, OrderData> | null = null;
let pendingReport: SyncReport | null = null;

function fieldDiff(field: string, from: string | number | null | undefined, to: string | number | null | undefined): FieldChange | null {
  const fromStr = from == null ? '' : String(from);
  const toStr = to == null ? '' : String(to);
  if (fromStr === toStr) return null;
  return { field, from: fromStr || '(empty)', to: toStr || '(empty)' };
}

async function diffOrder(orderData: OrderData): Promise<OrderDiff> {
  const existingSlip = await storage.getProformaSlipByOrderNumber(orderData.orderNumber);

  if (!existingSlip) {
    return {
      orderNumber: orderData.orderNumber,
      partyName: orderData.partyName,
      isNew: true,
      fieldChanges: [],
      itemChanges: Array.from(orderData.items.values()).map((i) => `+ ${i.productSrNo || '?'}: ${i.quantity}`),
    };
  }

  const fieldChanges: FieldChange[] = [];
  const push = (field: string, from: unknown, to: unknown) => {
    const d = fieldDiff(field, from as any, to as any);
    if (d) fieldChanges.push(d);
  };

  push('Party Name', existingSlip.partyName, orderData.partyName);
  push('Plant', existingSlip.plant, orderData.plant);
  push('Vehicle No.', existingSlip.vehicleNumber, orderData.vehicleNumber || null);
  push('Invoice No.', existingSlip.invoiceNumber, orderData.invoiceNumber || null);
  push('State', existingSlip.partyState, orderData.partyState || null);
  push('Notion Status', existingSlip.notionStatus, orderData.notionStatus || null);
  push('StoreKeeper Info', existingSlip.storeKeeperInfo, orderData.storeKeeperInfo || null);
  const newTotalQty = orderData.authoritativeQty ?? Array.from(orderData.items.values()).reduce((s, i) => s + i.quantity, 0);
  push('Total Quantity', existingSlip.totalQuantity, newTotalQty);

  const existingItems = await storage.getProformaSlipItems(existingSlip.id);
  const existingBySr = new Map(existingItems.map((i) => [i.srNo || '', i]));
  const itemChanges: string[] = [];

  for (const [srNo, itemData] of Array.from(orderData.items.entries())) {
    const existingItem = existingBySr.get(itemData.productSrNo || srNo);
    if (!existingItem) {
      itemChanges.push(`+ ${itemData.productSrNo || srNo}: ${itemData.quantity}`);
    } else if (existingItem.quantity !== itemData.quantity) {
      itemChanges.push(`${itemData.productSrNo || srNo}: ${existingItem.quantity ?? 0} -> ${itemData.quantity}`);
    }
    existingBySr.delete(itemData.productSrNo || srNo);
  }
  for (const [srNo] of Array.from(existingBySr.entries())) {
    if (srNo) itemChanges.push(`- Removed ${srNo}`);
  }

  return {
    orderNumber: orderData.orderNumber,
    partyName: orderData.partyName,
    isNew: false,
    fieldChanges,
    itemChanges,
  };
}

export async function detectProformaChanges(startDate: string, endDate: string, triggeredBy: string): Promise<SyncReport> {
  if (isSyncing) throw new Error('A sync is already in progress — please wait');
  isSyncing = true;
  try {
    const ordersMap = await fetchProformaOrdersFromNotion(startDate, endDate);
    const diffs: OrderDiff[] = [];
    let newCount = 0;
    let changedCount = 0;
    let unchangedCount = 0;

    for (const [, orderData] of Array.from(ordersMap.entries())) {
      const diff = await diffOrder(orderData);
      if (diff.isNew) {
        newCount++;
        diffs.push(diff);
      } else if (diff.fieldChanges.length > 0 || diff.itemChanges.length > 0) {
        changedCount++;
        diffs.push(diff);
      } else {
        unchangedCount++;
      }
    }

    const report: SyncReport = {
      syncTime: new Date(),
      startDate,
      endDate,
      totalOrders: ordersMap.size,
      newCount,
      changedCount,
      unchangedCount,
      diffs,
      triggeredBy,
    };

    pendingOrders = ordersMap;
    pendingReport = report;
    return report;
  } finally {
    isSyncing = false;
  }
}

export function getPendingProformaReport(): SyncReport | null {
  return pendingReport;
}

// selectedOrderNumbers: when provided, only these orders (checked by the user in the review UI)
// are written — everything else from the last /detect stays pending so it can be applied later
// (or discarded). Omit it (or pass every order number from the report) to apply everything, same
// as before checkbox selection existed.
export async function applyPendingProformaChanges(
  selectedOrderNumbers?: string[],
): Promise<{ slipsCreated: number; slipsUpdated: number; itemsCreated: number }> {
  if (!pendingOrders || !pendingReport) throw new Error('No pending changes. Run detection first.');
  if (isSyncing) throw new Error('A sync is already in progress — please wait');

  isSyncing = true;
  try {
    const selection = selectedOrderNumbers ? new Set(selectedOrderNumbers) : null;
    if (selection && selection.size === 0) {
      throw new Error('No orders selected to apply');
    }

    let slipsCreated = 0;
    let slipsUpdated = 0;
    let itemsCreated = 0;
    const appliedOrderNumbers = new Set<string>();

    for (const [orderNo, orderData] of Array.from(pendingOrders.entries())) {
      if (selection && !selection.has(orderNo)) continue;
      try {
        const result = await writeOrderToDb(orderData);
        if (result.created) slipsCreated++;
        else slipsUpdated++;
        itemsCreated += result.itemsCreated;
        appliedOrderNumbers.add(orderNo);
      } catch (error) {
        console.error(`Error applying sync for order ${orderNo}:`, error);
      }
    }

    // Drop only what was actually applied — anything left unchecked stays pending so the user
    // can come back and apply (or discard) it separately.
    for (const orderNo of Array.from(appliedOrderNumbers)) {
      pendingOrders.delete(orderNo);
    }
    pendingReport.diffs = pendingReport.diffs.filter((d) => !appliedOrderNumbers.has(d.orderNumber));
    pendingReport.newCount = pendingReport.diffs.filter((d) => d.isNew).length;
    pendingReport.changedCount = pendingReport.diffs.filter((d) => !d.isNew).length;

    if (pendingOrders.size === 0 || pendingReport.diffs.length === 0) {
      pendingOrders = null;
      pendingReport = null;
    }

    return { slipsCreated, slipsUpdated, itemsCreated };
  } finally {
    isSyncing = false;
  }
}

export function clearPendingProformaChanges(): void {
  pendingOrders = null;
  pendingReport = null;
}
