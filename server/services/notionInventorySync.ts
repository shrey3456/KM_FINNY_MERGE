import { Client } from '@notionhq/client';
import { storage } from '../storage';

const notion = new Client({
  auth: (process.env.NOTION_INTEGRATION_SECRET ?? process.env.NOTION_API_KEY ?? '').trim(),
});

export const NOTION_INVENTORY_DATABASE_ID = (process.env.NOTION_INVENTORY_DATABASE_ID ?? '').trim() || undefined;

let isSyncing = false;

// Human-readable labels for each synced field
export const FIELD_LABELS: Record<string, string> = {
  name: 'Product Name',
  category: 'Category',
  hsnCode: 'HSN Code',
  sapCode: 'SAP Code',
  srNo: 'Sr. No.',
  volumeInCuFt: 'Volume (cu ft)',
  sellingPrice: 'Selling Price',
  itemsPerPallet: 'Items Per Pallet',
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

export interface SyncReport {
  syncTime: Date;
  total: number;          // pages fetched from Notion
  updated: number;        // products actually changed
  skipped: number;        // products with no changes
  notFound: number;       // Notion entries with no local match
  changedProducts: ProductChange[];
  errors: string[];
}

// Rolling history — last 10 sync reports, newest first
const syncHistory: SyncReport[] = [];
const MAX_HISTORY = 10;

// ─── Notion property helpers ──────────────────────────────────────────────────

function extractText(prop: any): string {
  if (!prop) return '';
  switch (prop.type) {
    case 'title':
      return prop.title?.map((t: any) => t.plain_text).join('') || '';
    case 'rich_text':
      return prop.rich_text?.map((t: any) => t.plain_text).join('') || '';
    case 'select':
      return prop.select?.name || '';
    case 'multi_select':
      return prop.multi_select?.map((s: any) => s.name).join(', ') || '';
    case 'number':
      return prop.number != null ? String(prop.number) : '';
    case 'formula':
      if (prop.formula?.type === 'string') return prop.formula.string || '';
      if (prop.formula?.type === 'number') return prop.formula.number != null ? String(prop.formula.number) : '';
      return '';
    case 'rollup':
      if (prop.rollup?.type === 'number') return prop.rollup.number != null ? String(prop.rollup.number) : '';
      if (prop.rollup?.type === 'array') {
        return prop.rollup.array?.map((item: any) => extractText(item)).filter(Boolean).join(', ') || '';
      }
      return '';
    default:
      return '';
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

function firstOf(props: any, ...keys: string[]): string {
  for (const key of keys) {
    const val = extractText(props[key]);
    if (val.trim()) return val.trim();
  }
  return '';
}

function mapNotionPageToFields(page: any) {
  const p = page.properties;
  return {
    barcode:      firstOf(p, 'SKU', 'Barcode', 'barcode'),
    name:         firstOf(p, 'Products Name {DMS}', 'new name', 'Name', 'Product Name'),
    category:     firstOf(p, 'Category', 'category', 'Sale Category'),
    hsnCode:      firstOf(p, 'GJ HSN :', 'MP HSN :  ', 'MP HSN :', 'UP HSN :', 'HSN Code', 'HSN'),
    sapCode:      firstOf(p, 'GJ SAP :', 'MP SAP :', 'UP SAP :', 'SAP Code', 'SAP'),
    srNo:         firstOf(p, 'New Sr.', 'GJ Sr :', 'MP Sr :', 'UP Sr :', 'Sr No', 'Sr.No.'),
    volumeInCuFt: firstOf(p, 'Vol Master :', 'Volume', 'Vol', 'Vol Master'),
    sellingPrice: firstOf(p, 'GJ Sale Rate :', 'Sale Rate', 'Selling Price', 'Sale Price'),
    itemsPerPallet:
      extractInteger(p['Packets :']) ??
      extractInteger(p['Packets']) ??
      extractInteger(p['Items Per Pallet']),
  };
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

// ─── Main sync function ───────────────────────────────────────────────────────

export async function syncInventoryFromNotion(): Promise<SyncReport> {
  if (!NOTION_INVENTORY_DATABASE_ID) {
    throw new Error('NOTION_INVENTORY_DATABASE_ID is not set in environment variables');
  }
  if (isSyncing) {
    throw new Error('A sync is already in progress — please wait for it to finish');
  }

  isSyncing = true;
  const changedProducts: ProductChange[] = [];
  const errors: string[] = [];
  let updated = 0, skipped = 0, notFound = 0;

  try {
    console.log('[Notion Inventory Sync] Starting sync...');

    const notionPages = await fetchAllNotionPages();
    console.log(`[Notion Inventory Sync] Fetched ${notionPages.length} pages from Notion`);

    const allProducts = await storage.getAllProducts();
    const byBarcode = new Map(allProducts.filter(p => p.barcode).map(p => [p.barcode!.trim(), p]));
    const bySapCode = new Map(allProducts.filter(p => p.sapCode).map(p => [p.sapCode!.trim(), p]));
    const byName    = new Map(allProducts.filter(p => p.name).map(p => [p.name.trim().toLowerCase(), p]));

    for (const page of notionPages) {
      try {
        const fields = mapNotionPageToFields(page);
        if (!fields.barcode && !fields.sapCode && !fields.name) continue;

        const product =
          (fields.barcode && byBarcode.get(fields.barcode)) ||
          (fields.sapCode && bySapCode.get(fields.sapCode)) ||
          (fields.name   && byName.get(fields.name.toLowerCase())) ||
          null;

        if (!product) { notFound++; continue; }

        // Build updates and record old→new for the report
        const updates: Record<string, any> = {};
        const fieldChanges: FieldChange[] = [];

        const check = (key: string, notionVal: string | number | undefined, localVal: any) => {
          if (notionVal !== undefined && notionVal !== '' && String(notionVal) !== String(localVal ?? '')) {
            updates[key] = notionVal;
            fieldChanges.push({
              field: key,
              label: FIELD_LABELS[key] ?? key,
              oldValue: localVal ?? null,
              newValue: notionVal,
            });
          }
        };

        check('name',          fields.name          || undefined, product.name);
        check('category',      fields.category      || undefined, product.category);
        check('hsnCode',       fields.hsnCode       || undefined, product.hsnCode);
        check('sapCode',       fields.sapCode       || undefined, product.sapCode);
        check('srNo',          fields.srNo          || undefined, product.srNo);
        check('volumeInCuFt',  fields.volumeInCuFt  || undefined, product.volumeInCuFt);
        check('sellingPrice',  fields.sellingPrice  || undefined, product.sellingPrice);
        check('itemsPerPallet', fields.itemsPerPallet,            product.itemsPerPallet ?? undefined);

        if (fieldChanges.length === 0) { skipped++; continue; }

        updates.lastUpdated = new Date().toISOString();
        await storage.updateProduct(product.id, updates);
        updated++;

        changedProducts.push({
          productId:   product.id,
          productName: product.name,
          barcode:     product.barcode || '',
          srNo:        product.srNo || null,
          changes:     fieldChanges,
        });

        console.log(`[Notion Inventory Sync] Updated "${product.name}" — ${fieldChanges.map(c => c.label).join(', ')}`);
      } catch (pageErr) {
        const msg = pageErr instanceof Error ? pageErr.message : String(pageErr);
        errors.push(msg);
        console.error('[Notion Inventory Sync] Error on page:', pageErr);
      }
    }

    const report: SyncReport = {
      syncTime: new Date(),
      total: notionPages.length,
      updated,
      skipped,
      notFound,
      changedProducts,
      errors,
    };

    // Prepend to history, keep only the last MAX_HISTORY entries
    syncHistory.unshift(report);
    if (syncHistory.length > MAX_HISTORY) syncHistory.splice(MAX_HISTORY);

    console.log(`[Notion Inventory Sync] Done — updated: ${updated}, unchanged: ${skipped}, unmatched: ${notFound}, errors: ${errors.length}`);
    return report;
  } finally {
    isSyncing = false;
  }
}

// ─── Status & history accessors ───────────────────────────────────────────────

export function getSyncStatus() {
  return {
    isSyncing,
    lastSyncTime: syncHistory[0]?.syncTime ?? null,
    lastReport:   syncHistory[0] ?? null,
    configured:   !!NOTION_INVENTORY_DATABASE_ID,
  };
}

export function getSyncHistory(): SyncReport[] {
  return syncHistory;
}
