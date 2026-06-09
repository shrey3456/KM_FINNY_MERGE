import { Client } from '@notionhq/client';
import { storage } from '../storage';

const notion = new Client({
  auth: (process.env.NOTION_INTEGRATION_SECRET ?? process.env.NOTION_API_KEY ?? '').trim(),
});

export const NOTION_INVENTORY_DATABASE_ID = (process.env.NOTION_INVENTORY_DATABASE_ID ?? '').trim() || undefined;

let isSyncing = false;

export const FIELD_LABELS: Record<string, string> = {
  notionPageId: 'Notion Page ID',
  name: 'Product Name', notionWiseName: 'Notion Wise Name', brand: 'Brand',
  category: 'Category', saleCategory: 'Sale Category', plant: 'Plant', type: 'Type',
  productImage: 'Product Image', volumeInCuFt: 'Volume (cu ft)',
  itemsPerPallet: 'Items Per Pallet', indPlt: 'IND PLT', valPlt: 'VAL PLT',
  gjSr: 'GJ Sr', gjHsn: 'GJ HSN', gjSap: 'GJ SAP', gjSaleRate: 'GJ Sale Rate',
  gjIgst: 'GJ IGST', gjGaPur: 'GJ-GA PUR', gjMhPur: 'GJ-MH PUR', gjNagarPur: 'GJ-NAGAR PUR',
  forGjOrderForm: 'For GJ Order Form',
  mpSr: 'MP Sr', mpHsn: 'MP HSN', mpSap: 'MP SAP',
  mpJhPur: 'MP-JH PUR', mpMhPur: 'MP-MH PUR', mpMpPurJabalpur: 'MP-MP PUR Jabalpur',
  mpMpPurKhargone: 'MP-MP PUR Khargone', mpWbPur: 'MP-WB PUR',
  saleMpJh: 'Sale MP-JH', saleMpMh: 'Sale MP-MH', saleMpMp: 'Sale MP-MP',
  mpJhIgst: 'MP-JH IGST', mpMhIgst: 'MP-MH IGST', mpMpCgst: 'MP-MP CGST',
  mpMpSgst: 'MP-MP SGST', mpWbIgst: 'MP-WB IGST', mpWbSale: 'MP-WB Sale',
  forMpOrderForm: 'For MP Order Form',
  upSr: 'UP Sr', upHsn: 'UP HSN', upSap: 'UP SAP', upRate: 'UP Rate', upIgst: 'UP IGST',
  forUpOrderForm: 'For UP Order Form',
  hsnCode: 'HSN Code', sapCode: 'SAP Code', srNo: 'Sr. No.', newSr: 'New Sr.',
  sellingPrice: 'Selling Price',
};

export interface FieldChange {
  field: string;
  label: string;
  oldValue: string | number | null | undefined;
  newValue: string | number | null | undefined;
}

export interface ProductChange {
  productId: number;
  productName: string;
  barcode: string;
  srNo: string | null;
  changes: FieldChange[];
}

export interface CreatedProduct {
  productName: string;
  barcode: string;
  notionPageId: string;
}

export interface SyncReport {
  syncTime: Date;
  total: number;
  created: number;
  updated: number;
  skipped: number;
  notFound: number;
  changedProducts: ProductChange[];
  createdProducts: CreatedProduct[];
  errors: string[];
}

const syncHistory: SyncReport[] = [];
const MAX_HISTORY = 10;

let pendingReport: SyncReport | null = null;
const pendingUpdates = new Map<number, Record<string, any>>();
const pendingCreates: any[] = [];

// ─── Notion property helpers ──────────────────────────────────────────────────

function extractText(prop: any): string {
  if (!prop) return '';
  switch (prop.type) {
    case 'title':       return prop.title?.map((t: any) => t.plain_text).join('') || '';
    case 'rich_text':   return prop.rich_text?.map((t: any) => t.plain_text).join('') || '';
    case 'select':      return prop.select?.name || '';
    case 'status':      return prop.status?.name || '';
    case 'multi_select':return prop.multi_select?.map((s: any) => s.name).join(', ') || '';
    case 'number':      return prop.number != null ? String(prop.number) : '';
    case 'formula':
      if (prop.formula?.type === 'string') return prop.formula.string || '';
      if (prop.formula?.type === 'number') return prop.formula.number != null ? String(prop.formula.number) : '';
      return '';
    case 'rollup':
      if (prop.rollup?.type === 'number') return prop.rollup.number != null ? String(prop.rollup.number) : '';
      if (prop.rollup?.type === 'array')
        return prop.rollup.array?.map((i: any) => extractText(i)).filter(Boolean).join(', ') || '';
      return '';
    default: return '';
  }
}

function extractInteger(prop: any): number | undefined {
  if (!prop) return undefined;
  if (prop.type === 'number' && prop.number != null && prop.number > 0) return Math.round(prop.number);
  const text = extractText(prop);
  if (!text) return undefined;
  const n = parseFloat(text.replace(/[₹,\s]/g, ''));
  return Number.isFinite(n) && n > 0 ? Math.round(n) : undefined;
}

function extractMultiSelect(prop: any): string[] {
  if (!prop) return [];
  if (prop.type === 'multi_select') return (prop.multi_select ?? []).map((s: any) => String(s.name)).filter(Boolean);
  if (prop.type === 'status')  return prop.status?.name  ? [String(prop.status.name)]  : [];
  if (prop.type === 'select')  return prop.select?.name  ? [String(prop.select.name)]  : [];
  return [];
}

function multiSelectToText(values: string[]): string | null {
  return values.length > 0 ? values.join(', ') : null;
}

function firstOf(props: any, ...keys: string[]): string {
  for (const key of keys) {
    const val = extractText(props[key]);
    if (val.trim()) return val.trim();
  }
  return '';
}

// ─── Map Notion page → all fields ────────────────────────────────────────────

function mapNotionPageToFields(page: any) {
  const p = page.properties;

  const gjSaleRate = firstOf(p, 'GJ Sale Rate :');
  const gjHsnVal   = firstOf(p, 'GJ HSN :');
  const gjSapVal   = firstOf(p, 'GJ SAP :');

  return {
    notionPageId:    page.id as string,
    barcode:         firstOf(p, 'SKU', 'Barcode', 'barcode'),
    name:            firstOf(p, 'Products Name {DMS}', 'new name', 'Name', 'Product Name'),
    notionWiseName:  firstOf(p, 'Products - Notion Wise'),
    brand:           firstOf(p, 'Brand', 'brand'),
    category:        multiSelectToText(extractMultiSelect(p['Category :'] ?? p['Category'] ?? p['category'] ?? p['Categories'])),
    saleCategory:    firstOf(p, 'Sale Category'),
    plant:           firstOf(p, 'Plant :', 'Plant', 'plant'),
    type:            firstOf(p, 'Type :', 'Type', 'type'),
    productImage:    firstOf(p, 'Product Image'),
    volumeInCuFt:    firstOf(p, 'Vol Master :', 'Vol Master', 'Volume'),
    itemsPerPallet:  extractInteger(p['Packets :']) ?? extractInteger(p['Packets']) ?? extractInteger(p['Items Per Pallet']),
    indPlt:          extractInteger(p['IND PLT :']),
    valPlt:          extractInteger(p['VAL PLT :']),
    gjSr:            firstOf(p, 'GJ Sr :'),
    gjHsn:           gjHsnVal,
    gjSap:           gjSapVal,
    gjSaleRate,
    gjIgst:          firstOf(p, 'GJ IGST :'),
    gjGaPur:         firstOf(p, 'GJ-GA PUR'),
    gjMhPur:         firstOf(p, 'GJ-MH PUR'),
    gjNagarPur:      firstOf(p, 'GJ-NAGAR PUR'),
    forGjOrderForm:  firstOf(p, 'For GJ Order Form :'),
    mpSr:            firstOf(p, 'MP Sr :'),
    mpHsn:           firstOf(p, 'MP HSN :  ', 'MP HSN :'),
    mpSap:           firstOf(p, 'MP SAP :'),
    mpJhPur:         firstOf(p, 'MP-JH PUR'),
    mpMhPur:         firstOf(p, 'MP-MH PUR'),
    mpMpPurJabalpur: firstOf(p, 'MP-MP PUR JABALPUR'),
    mpMpPurKhargone: firstOf(p, 'MP-MP PUR KHARGONE'),
    mpWbPur:         firstOf(p, 'MP-WB PUR'),
    saleMpJh:        firstOf(p, 'Sale {MP - JH}:'),
    saleMpMh:        firstOf(p, 'Sale {MP - MH} :'),
    saleMpMp:        firstOf(p, 'Sale {MP-MP} :'),
    mpJhIgst:        firstOf(p, '{MP - JH} IGST :'),
    mpMhIgst:        firstOf(p, '{MP - MH} IGST :'),
    mpMpCgst:        firstOf(p, '{MP - MP} CGST :'),
    mpMpSgst:        firstOf(p, '{MP - MP} SGST :'),
    mpWbIgst:        firstOf(p, '{MP-WB} IGST'),
    mpWbSale:        firstOf(p, '{MP-WB} SALE'),
    forMpOrderForm:  firstOf(p, 'For MP Order Form :'),
    upSr:            firstOf(p, 'UP Sr :'),
    upHsn:           firstOf(p, 'UP HSN :'),
    upSap:           firstOf(p, 'UP SAP :'),
    upRate:          firstOf(p, 'UP Rate :'),
    upIgst:          firstOf(p, 'UP IGST :'),
    forUpOrderForm:  firstOf(p, 'For UP Order Form :'),
    hsnCode:         gjHsnVal || firstOf(p, 'HSN Code', 'HSN'),
    sapCode:         gjSapVal || firstOf(p, 'SAP Code', 'SAP'),
    srNo:            firstOf(p, 'New Sr.', 'GJ Sr :', 'MP Sr :', 'UP Sr :'),
    newSr:           firstOf(p, 'New Sr.'),
    sellingPrice:    gjSaleRate || firstOf(p, 'Selling Price', 'Sale Rate'),
  };
}

// Build a full product insert object from mapped Notion fields
function buildProductData(fields: ReturnType<typeof mapNotionPageToFields>): Record<string, any> {
  const data: Record<string, any> = {
    barcode:   fields.barcode,
    name:      fields.name,
    notionPageId: fields.notionPageId,
    lastUpdated: new Date(),
    purchased: 0, sold: 0, inStock: 0, pallets: 0,
    status: 'in stock',
  };
  const optional = [
    'notionWiseName', 'brand', 'category', 'saleCategory', 'plant', 'type', 'productImage',
    'newSr', 'srNo', 'volumeInCuFt', 'itemsPerPallet', 'indPlt', 'valPlt',
    'gjSr', 'gjHsn', 'gjSap', 'gjSaleRate', 'gjIgst', 'gjGaPur', 'gjMhPur', 'gjNagarPur', 'forGjOrderForm',
    'mpSr', 'mpHsn', 'mpSap', 'mpJhPur', 'mpMhPur', 'mpMpPurJabalpur', 'mpMpPurKhargone', 'mpWbPur',
    'saleMpJh', 'saleMpMh', 'saleMpMp', 'mpJhIgst', 'mpMhIgst', 'mpMpCgst', 'mpMpSgst', 'mpWbIgst', 'mpWbSale', 'forMpOrderForm',
    'upSr', 'upHsn', 'upSap', 'upRate', 'upIgst', 'forUpOrderForm',
    'hsnCode', 'sapCode', 'sellingPrice',
  ];
  for (const key of optional) {
    const val = (fields as any)[key];
    if (val !== undefined && val !== null && val !== '') data[key] = val;
  }
  return data;
}

async function fetchAllNotionPages(): Promise<any[]> {
  const pages: any[] = [];
  let cursor: string | undefined;
  do {
    const response: any = await notion.databases.query({
      database_id: NOTION_INVENTORY_DATABASE_ID!,
      page_size: 100,
      ...(cursor ? { start_cursor: cursor } : {}),
    });
    pages.push(...response.results);
    cursor = response.has_more ? response.next_cursor ?? undefined : undefined;
  } while (cursor);
  return pages;
}

// ─── Core change-detection (shared by all sync modes) ────────────────────────

async function computeChanges(notionPages: any[], allProducts: any[]) {
  const byNotionPageId = new Map(allProducts.filter(p => p.notionPageId).map(p => [p.notionPageId!, p]));
  // Fallback: match products that have no notionPageId yet by barcode
  const byBarcode = new Map(allProducts.filter(p => !p.notionPageId && p.barcode).map(p => [p.barcode!, p]));

  const changedProducts: ProductChange[] = [];
  const toCreate: ReturnType<typeof buildProductData>[] = [];
  const createdProducts: CreatedProduct[] = [];
  const updatesMap = new Map<number, Record<string, any>>();
  const errors: string[] = [];
  let skipped = 0, notFound = 0;

  for (const page of notionPages) {
    try {
      const fields = mapNotionPageToFields(page);
      if (!fields.barcode && !fields.name) { notFound++; continue; }

      // Match by notionPageId first; fall back to barcode for products not yet linked
      const product = byNotionPageId.get(fields.notionPageId) ?? (fields.barcode ? byBarcode.get(fields.barcode) ?? null : null);

      // ── Product not in DB → create it ────────────────────────────────────
      if (!product) {
        if (!fields.barcode || !fields.name) { notFound++; continue; }
        const data = buildProductData(fields);
        toCreate.push(data);
        createdProducts.push({ productName: fields.name, barcode: fields.barcode, notionPageId: fields.notionPageId });
        continue;
      }

      // ── Product exists → check for field changes ──────────────────────────
      const updates: Record<string, any> = {};
      const fieldChanges: FieldChange[] = [];

      const comparable = (value: unknown) => {
        if (value === null || value === undefined) return '';
        if (typeof value === 'number') return String(value);
        const text = String(value).trim();
        const numeric = Number(text);
        if (text !== '' && Number.isFinite(numeric) && /^-?\d+(\.\d+)?$/.test(text)) {
          return String(numeric);
        }
        return text.replace(/\s+/g, ' ');
      };

      const check = (key: string, notionVal: string | number | undefined, localVal: any) => {
        if (notionVal !== undefined && notionVal !== '' && comparable(notionVal) !== comparable(localVal)) {
          updates[key] = notionVal;
          fieldChanges.push({ field: key, label: FIELD_LABELS[key] ?? key, oldValue: localVal ?? null, newValue: notionVal });
        }
      };

      check('notionPageId',    fields.notionPageId    || undefined, product.notionPageId);
      check('name',            fields.name            || undefined, product.name);
      check('notionWiseName',  fields.notionWiseName  || undefined, product.notionWiseName);
      check('brand',           fields.brand           || undefined, product.brand);
      check('category',        fields.category        || undefined, product.category);
      check('saleCategory',    fields.saleCategory    || undefined, product.saleCategory);
      check('plant',           fields.plant           || undefined, product.plant);
      check('type',            fields.type            || undefined, product.type);
      check('productImage',    fields.productImage    || undefined, product.productImage);
      check('volumeInCuFt',    fields.volumeInCuFt    || undefined, product.volumeInCuFt);
      check('itemsPerPallet',  fields.itemsPerPallet,               product.itemsPerPallet ?? undefined);
      check('indPlt',          fields.indPlt,                       product.indPlt ?? undefined);
      check('valPlt',          fields.valPlt,                       product.valPlt ?? undefined);
      check('gjSr',            fields.gjSr            || undefined, product.gjSr);
      check('gjHsn',           fields.gjHsn           || undefined, product.gjHsn);
      check('gjSap',           fields.gjSap           || undefined, product.gjSap);
      check('gjSaleRate',      fields.gjSaleRate      || undefined, product.gjSaleRate);
      check('gjIgst',          fields.gjIgst          || undefined, product.gjIgst);
      check('gjGaPur',         fields.gjGaPur         || undefined, product.gjGaPur);
      check('gjMhPur',         fields.gjMhPur         || undefined, product.gjMhPur);
      check('gjNagarPur',      fields.gjNagarPur      || undefined, product.gjNagarPur);
      check('forGjOrderForm',  fields.forGjOrderForm  || undefined, product.forGjOrderForm);
      check('mpSr',            fields.mpSr            || undefined, product.mpSr);
      check('mpHsn',           fields.mpHsn           || undefined, product.mpHsn);
      check('mpSap',           fields.mpSap           || undefined, product.mpSap);
      check('mpJhPur',         fields.mpJhPur         || undefined, product.mpJhPur);
      check('mpMhPur',         fields.mpMhPur         || undefined, product.mpMhPur);
      check('mpMpPurJabalpur', fields.mpMpPurJabalpur || undefined, product.mpMpPurJabalpur);
      check('mpMpPurKhargone', fields.mpMpPurKhargone || undefined, product.mpMpPurKhargone);
      check('mpWbPur',         fields.mpWbPur         || undefined, product.mpWbPur);
      check('saleMpJh',        fields.saleMpJh        || undefined, product.saleMpJh);
      check('saleMpMh',        fields.saleMpMh        || undefined, product.saleMpMh);
      check('saleMpMp',        fields.saleMpMp        || undefined, product.saleMpMp);
      check('mpJhIgst',        fields.mpJhIgst        || undefined, product.mpJhIgst);
      check('mpMhIgst',        fields.mpMhIgst        || undefined, product.mpMhIgst);
      check('mpMpCgst',        fields.mpMpCgst        || undefined, product.mpMpCgst);
      check('mpMpSgst',        fields.mpMpSgst        || undefined, product.mpMpSgst);
      check('mpWbIgst',        fields.mpWbIgst        || undefined, product.mpWbIgst);
      check('mpWbSale',        fields.mpWbSale        || undefined, product.mpWbSale);
      check('forMpOrderForm',  fields.forMpOrderForm  || undefined, product.forMpOrderForm);
      check('upSr',            fields.upSr            || undefined, product.upSr);
      check('upHsn',           fields.upHsn           || undefined, product.upHsn);
      check('upSap',           fields.upSap           || undefined, product.upSap);
      check('upRate',          fields.upRate          || undefined, product.upRate);
      check('upIgst',          fields.upIgst          || undefined, product.upIgst);
      check('forUpOrderForm',  fields.forUpOrderForm  || undefined, product.forUpOrderForm);
      check('hsnCode',         fields.hsnCode         || undefined, product.hsnCode);
      check('sapCode',         fields.sapCode         || undefined, product.sapCode);
      check('srNo',            fields.srNo            || undefined, product.srNo);
      check('newSr',           fields.newSr           || undefined, product.newSr);
      check('sellingPrice',    fields.sellingPrice    || undefined, product.sellingPrice);

      if (fieldChanges.length === 0 && product.notionPageId) { skipped++; continue; }

      updates.lastUpdated = new Date();
      updatesMap.set(product.id, updates);

      if (fieldChanges.length > 0) {
        changedProducts.push({ productId: product.id, productName: product.name, barcode: product.barcode || '', srNo: product.srNo || null, changes: fieldChanges });
      } else {
        skipped++;
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      errors.push(msg);
      console.error('[Notion Inventory Sync] Error processing page:', err);
    }
  }

  return { changedProducts, toCreate, createdProducts, updatesMap, errors, skipped, notFound };
}

// ─── Detect-only (dry-run): stores pending, no DB writes ─────────────────────

export async function detectChangesFromNotion(): Promise<SyncReport> {
  if (!NOTION_INVENTORY_DATABASE_ID) throw new Error('NOTION_INVENTORY_DATABASE_ID is not set');
  if (isSyncing) throw new Error('A sync is already in progress — please wait');

  isSyncing = true;
  try {
    console.log('[Notion Inventory Sync] Detecting changes (dry-run)...');
    const notionPages = await fetchAllNotionPages();
    const allProducts = await storage.getAllProducts();
    const { changedProducts, toCreate, createdProducts, updatesMap, errors, skipped, notFound } =
      await computeChanges(notionPages, allProducts);

    const report: SyncReport = {
      syncTime: new Date(), total: notionPages.length,
      created: toCreate.length, updated: changedProducts.length,
      skipped, notFound, changedProducts, createdProducts, errors,
    };

    pendingReport = report;
    pendingUpdates.clear();
    pendingCreates.length = 0;
    for (const [id, upd] of updatesMap.entries()) pendingUpdates.set(id, upd);
    pendingCreates.push(...toCreate);

    console.log(`[Notion Inventory Sync] Detected — new: ${toCreate.length}, changed: ${changedProducts.length}, unchanged: ${skipped}`);
    return report;
  } finally {
    isSyncing = false;
  }
}

// ─── Apply pending (detected) changes ────────────────────────────────────────

export async function applyPendingChanges(): Promise<SyncReport> {
  if (!pendingReport) throw new Error('No pending changes. Run detection first.');
  if (isSyncing) throw new Error('A sync is already in progress — please wait');

  isSyncing = true;
  try {
    const errors: string[] = [...pendingReport.errors];
    let updated = 0, created = 0;

    for (const [productId, updates] of pendingUpdates.entries()) {
      try { await storage.updateProduct(productId, updates); updated++; }
      catch (err) { errors.push(`Update product ${productId}: ${err instanceof Error ? err.message : String(err)}`); }
    }
    for (const data of pendingCreates) {
      try {
        await storage.createProduct(data as any);
        created++;
      } catch (createErr) {
        // Insert failed (e.g. barcode conflict from a prior import without a Notion ID).
        // Fall back to finding the existing row by barcode and patching it instead.
        if (data.barcode) {
          try {
            const existing = await storage.getProductByBarcode(data.barcode);
            if (existing) {
              // Don't overwrite stock counters that belong to the existing record.
              const { purchased: _p, sold: _s, inStock: _i, pallets: _pl, ...safeData } = data as any;
              await storage.updateProduct(existing.id, safeData);
              updated++;
            } else {
              errors.push(`Create ${data.barcode}: ${createErr instanceof Error ? createErr.message : String(createErr)}`);
            }
          } catch (fallbackErr) {
            errors.push(`Create ${data.barcode}: ${fallbackErr instanceof Error ? fallbackErr.message : String(fallbackErr)}`);
          }
        } else {
          errors.push(`Create (no barcode): ${createErr instanceof Error ? createErr.message : String(createErr)}`);
        }
      }
    }

    const report: SyncReport = { ...pendingReport, updated, created, errors };
    syncHistory.unshift(report);
    if (syncHistory.length > MAX_HISTORY) syncHistory.splice(MAX_HISTORY);
    pendingReport = null;
    pendingUpdates.clear();
    pendingCreates.length = 0;

    console.log(`[Notion Inventory Sync] Applied — updated: ${updated}, created: ${created}`);
    return report;
  } finally {
    isSyncing = false;
  }
}

// ─── Full sync: clear inventory → import everything from Notion ───────────────

export async function fullSyncFromNotion(): Promise<SyncReport> {
  if (!NOTION_INVENTORY_DATABASE_ID) throw new Error('NOTION_INVENTORY_DATABASE_ID is not set');
  if (isSyncing) throw new Error('A sync is already in progress — please wait');

  isSyncing = true;
  const errors: string[] = [];
  let created = 0;
  const createdProducts: CreatedProduct[] = [];

  try {
    console.log('[Notion Inventory Sync] Full sync — clearing inventory...');
    const notionPages = await fetchAllNotionPages();
    console.log(`[Notion Inventory Sync] Fetched ${notionPages.length} pages from Notion`);

    await storage.clearInventory();
    console.log('[Notion Inventory Sync] Inventory cleared');

    for (const page of notionPages) {
      try {
        const fields = mapNotionPageToFields(page);
        if (!fields.barcode || !fields.name) continue;
        const data = buildProductData(fields);
        await storage.createProduct(data as any);
        created++;
        createdProducts.push({ productName: fields.name, barcode: fields.barcode, notionPageId: fields.notionPageId });
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        errors.push(msg);
        console.error('[Notion Inventory Sync] Error creating product:', err);
      }
    }

    const report: SyncReport = {
      syncTime: new Date(), total: notionPages.length,
      created, updated: 0, skipped: 0,
      notFound: notionPages.length - created - errors.length,
      changedProducts: [], createdProducts, errors,
    };
    syncHistory.unshift(report);
    if (syncHistory.length > MAX_HISTORY) syncHistory.splice(MAX_HISTORY);
    pendingReport = null;
    pendingUpdates.clear();
    pendingCreates.length = 0;

    console.log(`[Notion Inventory Sync] Full sync done — created: ${created}, errors: ${errors.length}`);
    return report;
  } finally {
    isSyncing = false;
  }
}

// ─── Status & history ─────────────────────────────────────────────────────────

export function getSyncStatus() {
  return {
    isSyncing,
    lastSyncTime:      syncHistory[0]?.syncTime ?? null,
    lastReport:        syncHistory[0] ?? null,
    configured:        !!NOTION_INVENTORY_DATABASE_ID,
    hasPendingChanges: pendingReport !== null && (pendingReport.updated > 0 || pendingReport.created > 0),
    pendingCount:      (pendingReport?.updated ?? 0) + (pendingReport?.created ?? 0),
    pendingDetectedAt: pendingReport?.syncTime ?? null,
  };
}

export function getSyncHistory(): SyncReport[] { return syncHistory; }
export function getPendingReport(): SyncReport | null { return pendingReport; }

// ─── Debug helper ─────────────────────────────────────────────────────────────

export async function debugNotionProps() {
  if (!NOTION_INVENTORY_DATABASE_ID) throw new Error('NOTION_INVENTORY_DATABASE_ID is not set');
  const response: any = await notion.databases.query({
    database_id: NOTION_INVENTORY_DATABASE_ID,
    page_size: 1,
  });
  const page = response.results[0];
  if (!page) return { error: 'No pages found in database' };
  const props = page.properties as Record<string, any>;
  return {
    pageId: page.id,
    properties: Object.fromEntries(
      Object.entries(props).map(([key, val]) => [key, { type: val.type, sample: val[val.type] }])
    ),
  };
}
