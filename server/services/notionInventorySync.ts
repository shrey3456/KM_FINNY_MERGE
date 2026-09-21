import { Client } from '@notionhq/client';
import { storage } from '../storage';
import { pool } from '../db';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import crypto from 'crypto';
import sharp from 'sharp';
import {
  extractText, extractInteger, extractMultiSelect, multiSelectToText, extractFileUrl, firstOf,
} from '../lib/notionProperties';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const notion = new Client({
  auth: (process.env.NOTION_INTEGRATION_SECRET ?? process.env.NOTION_API_KEY ?? '').trim(),
});

export const NOTION_INVENTORY_DATABASE_ID = (process.env.NOTION_INVENTORY_DATABASE_ID ?? '').trim() || undefined;

// Local disk cache for product images — never stores the raw Notion URL (Notion-hosted
// files expire after ~1 hour). Downloaded once per sync, resized down, and reused across
// every scan afterward; product_image_hash lets re-syncs skip untouched images entirely.
export const PRODUCT_IMAGE_DIR = path.join(__dirname, '..', 'uploads', 'product-images');
if (!fs.existsSync(PRODUCT_IMAGE_DIR)) {
  fs.mkdirSync(PRODUCT_IMAGE_DIR, { recursive: true });
}

// Runs an async task over each item with a bounded number in flight at once. The image
// sync has to download every product's picture from Notion to hash-check it (Notion's file
// URLs are presigned and rotate, so they can't be compared without downloading) — doing
// that one-at-a-time serialised ~120 network round-trips on every startup/scheduled sync,
// which was the real slowdown. Running a handful concurrently cuts the wall-clock time to
// roughly (total / limit) without hammering Notion.
async function mapWithConcurrency<T>(
  items: T[],
  limit: number,
  task: (item: T) => Promise<void>,
): Promise<void> {
  let cursor = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (cursor < items.length) {
      const idx = cursor++;
      await task(items[idx]);
    }
  });
  await Promise.all(workers);
}

// Downloads a product image from Notion, resizes it down (scan-dialog thumbnails don't
// need full-resolution photography), and caches it to disk keyed by product id. Skips the
// download's disk write when the content hash matches what's already cached, so repeat
// syncs of unchanged images cost a hash compare, not a disk write. Returns the fields to
// persist on the product row, or null if there's nothing to update.
async function syncProductImage(
  productId: number,
  imageUrl: string,
  existingHash: string | null | undefined,
): Promise<{ productImage: string; productImageHash: string } | null> {
  const response = await fetch(imageUrl);
  if (!response.ok) throw new Error(`Image download failed (${response.status})`);
  const original = Buffer.from(await response.arrayBuffer());
  const hash = crypto.createHash('sha256').update(original).digest('hex');

  // Unchanged — skip silently. (No per-product log: with ~120 products this floods the
  // console with blocking synchronous stdout writes on every startup/scheduled sync. The
  // caller logs a single summary line instead.)
  if (hash === existingHash) return null;

  const resized = await sharp(original)
    .resize({ width: 600, height: 600, fit: 'inside', withoutEnlargement: true })
    .jpeg({ quality: 82 })
    .toBuffer();

  const filename = `${productId}.jpg`;
  await fs.promises.writeFile(path.join(PRODUCT_IMAGE_DIR, filename), resized);
  console.log(`[Notion Inventory Sync] Cached image for product ${productId} → ${filename} (${resized.length} bytes, was ${original.length})`);

  return { productImage: filename, productImageHash: hash };
}

let isSyncing = false;

export const FIELD_LABELS: Record<string, string> = {
  notionPageId: 'Notion Page ID',
  name: 'Product Name', notionWiseName: 'Notion Wise Name', brand: 'Brand',
  category: 'Category', saleCategory: 'Sale Category', plant: 'Plant', type: 'Type',
  productImage: 'Product Image', volumeInCuFt: 'Volume (cu ft)',
  itemsPerPallet: 'Items Per Pallet', mpPlt: 'MP PLT', gjPlt: 'GJ PLT',
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
  hsnCode: 'HSN Code', sapCode: 'SAP Code', newSr: 'New Sr.',
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
  newSr: string | null;
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
  triggeredBy: string;
  changedProducts: ProductChange[];
  createdProducts: CreatedProduct[];
  errors: string[];
  imagesCached: number;
}

const syncHistory: SyncReport[] = [];
const MAX_HISTORY = 10;

let pendingReport: SyncReport | null = null;
const pendingUpdates = new Map<number, Record<string, any>>();
const pendingCreates: any[] = [];
const pendingImageUrlByProductId = new Map<number, string>();
const pendingImageUrlByCreateIndex = new Map<number, string>();
// Whether the detect run that produced the current pending batch was a "Sync Photos"
// (syncImages=true) run. Apply only ever touches images when this is true — a "Sync Notion"
// (syncImages=false) detect still records image URLs above (new products need them once
// created), but Apply must not silently download/check photos the user never asked for.
let pendingSyncImages = false;

// ─── Notion property helpers ──────────────────────────────────────────────────
// Moved to server/lib/notionProperties.ts so Vehicle Master's sync service can reuse the same
// property-type handling instead of duplicating it — see that file for extractText etc.

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
    brand:           firstOf(p, 'Brand :', 'Brand:', 'Brand', 'brand :', 'brand:', 'brand', 'BRAND'),
    category:        multiSelectToText(extractMultiSelect(p['Category :'] ?? p['Category'] ?? p['category'] ?? p['Categories'])),
    saleCategory:    firstOf(p, 'Sale Category'),
    plant:           firstOf(p, 'Plant :', 'Plant', 'plant'),
    type:            firstOf(p, 'Type :', 'Type', 'type'),
    productImageUrl: extractFileUrl(p['Product Image']), // raw Notion URL — download immediately, never persist as-is
    volumeInCuFt:    firstOf(p, 'Vol Master :', 'Vol Master', 'Volume'),
    itemsPerPallet:  extractInteger(p['Packets :']) ?? extractInteger(p['Packets']) ?? extractInteger(p['Items Per Pallet']),
    // Notion's own property names are unchanged (still named after the plant, IND/VAL) — only
    // where we store the value changed, since pallet size is really a per-state fact. See
    // products.mpPlt/gjPlt and plants.state.
    mpPlt:           extractInteger(p['IND PLT :']),
    gjPlt:           extractInteger(p['VAL PLT :']),
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
    newSr:           firstOf(p, 'New Sr.'),
    sellingPrice:    gjSaleRate || firstOf(p, 'Selling Price', 'Sale Rate'),
  };
}

// Build a full product insert object from mapped Notion fields
function buildProductData(fields: ReturnType<typeof mapNotionPageToFields>): Record<string, any> {
  const data: Record<string, any> = {
    barcode:   fields.barcode || '',
    name:      fields.name || '',
    notionPageId: fields.notionPageId,
    lastUpdated: new Date(),
    purchased: 0, sold: 0, inStock: 0, pallets: 0,
    status: 'in stock',
  };
  const optional = [
    'notionWiseName', 'brand', 'category', 'saleCategory', 'plant', 'type',
    'newSr', 'volumeInCuFt', 'itemsPerPallet', 'mpPlt', 'gjPlt',
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

async function computeChanges(notionPages: any[], allProducts: any[], triggeredBy = 'system') {
  const byNotionPageId = new Map(allProducts.filter(p => p.notionPageId).map(p => [p.notionPageId!, p]));

  const changedProducts: ProductChange[] = [];
  const toCreate: ReturnType<typeof buildProductData>[] = [];
  const createdProducts: CreatedProduct[] = [];
  const updatesMap = new Map<number, Record<string, any>>();
  // Notion image URL per pending change — keyed by existing product id for updates, or by
  // index into `toCreate` for brand-new products (which have no id until after insert).
  const imageUrlByProductId = new Map<number, string>();
  const imageUrlByCreateIndex = new Map<number, string>();
  const errors: string[] = [];
  let skipped = 0, notFound = 0;

  for (const page of notionPages) {
    try {
      const fields = mapNotionPageToFields(page);
      if (!fields.barcode && !fields.name) { notFound++; continue; }

      const product = byNotionPageId.get(fields.notionPageId);

      if (!product) {
        const data = { ...buildProductData(fields), lastChangedBy: triggeredBy };
        if (fields.productImageUrl) imageUrlByCreateIndex.set(toCreate.length, fields.productImageUrl);
        toCreate.push(data);
        createdProducts.push({ productName: fields.name || '', barcode: fields.barcode || '', notionPageId: fields.notionPageId });
        continue;
      }

      if (fields.productImageUrl) imageUrlByProductId.set(product.id, fields.productImageUrl);

      const updates: Record<string, any> = {};
      const fieldChanges: FieldChange[] = [];

      const comparable = (value: unknown): string => {
        if (value === null || value === undefined) return '';
        if (typeof value === 'number') return String(value);
        return String(value).trim().replace(/\s+/g, ' ');
      };

      const check = (key: string, notionVal: string | number | null | undefined, localVal: any) => {
        const notionNorm = (notionVal == null || notionVal === '') ? '' : notionVal;
        if (comparable(notionNorm) !== comparable(localVal)) {
          updates[key] = notionNorm === '' ? null : notionVal;
          const change = { field: key, label: FIELD_LABELS[key] ?? key, oldValue: localVal ?? null, newValue: notionNorm === '' ? null : notionVal };
          fieldChanges.push(change);

          // Log ₹ symbol changes explicitly
          const oldStr = String(localVal ?? '');
          const newStr = String(notionNorm);
          const oldHasRupee = oldStr.includes('₹');
          const newHasRupee = newStr.includes('₹');
          if (oldHasRupee !== newHasRupee) {
            console.log(`[₹ Symbol Change] ${product.name} | field: ${key} | "${oldStr}" → "${newStr}"`);
          }
        }
      };

      check('notionPageId',    fields.notionPageId    || null, product.notionPageId);
      // Never let a blank Notion barcode clear out an existing one — a page going blank
      // usually means it was archived/discontinued in Notion (e.g. category "ZCLOSED",
      // Sr "ZI028"), not a genuine request to unset the barcode. products.barcode is
      // NOT NULL, so trying to null it out used to make this product's update fail on
      // every single sync run, forever, with no way to resolve it.
      if (fields.barcode || !product.barcode) {
        check('barcode', fields.barcode || null, product.barcode);
      }
      check('name',            fields.name            || null, product.name);
      check('notionWiseName',  fields.notionWiseName  || null, product.notionWiseName);
      check('brand',           fields.brand           || null, product.brand);
      check('category',        fields.category        || null, product.category);
      check('saleCategory',    fields.saleCategory    || null, product.saleCategory);
      check('plant',           fields.plant           || null, product.plant);
      check('type',            fields.type            || null, product.type);
      // productImage/productImageHash are never diffed as text — Notion's file URL changes
      // on every fetch even when the underlying image doesn't. Image updates are detected
      // separately by content hash (see syncProductImage) and applied outside this loop.
      check('volumeInCuFt',    fields.volumeInCuFt    || null, product.volumeInCuFt);
      check('itemsPerPallet',  fields.itemsPerPallet  ?? null, product.itemsPerPallet ?? null);
      check('mpPlt',           fields.mpPlt           ?? null, product.mpPlt ?? null);
      check('gjPlt',           fields.gjPlt           ?? null, product.gjPlt ?? null);
      check('gjSr',            fields.gjSr            || null, product.gjSr);
      check('gjHsn',           fields.gjHsn           || null, product.gjHsn);
      check('gjSap',           fields.gjSap           || null, product.gjSap);
      check('gjSaleRate',      fields.gjSaleRate      || null, product.gjSaleRate);
      check('gjIgst',          fields.gjIgst          || null, product.gjIgst);
      check('gjGaPur',         fields.gjGaPur         || null, product.gjGaPur);
      check('gjMhPur',         fields.gjMhPur         || null, product.gjMhPur);
      check('gjNagarPur',      fields.gjNagarPur      || null, product.gjNagarPur);
      check('forGjOrderForm',  fields.forGjOrderForm  || null, product.forGjOrderForm);
      check('mpSr',            fields.mpSr            || null, product.mpSr);
      check('mpHsn',           fields.mpHsn           || null, product.mpHsn);
      check('mpSap',           fields.mpSap           || null, product.mpSap);
      check('mpJhPur',         fields.mpJhPur         || null, product.mpJhPur);
      check('mpMhPur',         fields.mpMhPur         || null, product.mpMhPur);
      check('mpMpPurJabalpur', fields.mpMpPurJabalpur || null, product.mpMpPurJabalpur);
      check('mpMpPurKhargone', fields.mpMpPurKhargone || null, product.mpMpPurKhargone);
      check('mpWbPur',         fields.mpWbPur         || null, product.mpWbPur);
      check('saleMpJh',        fields.saleMpJh        || null, product.saleMpJh);
      check('saleMpMh',        fields.saleMpMh        || null, product.saleMpMh);
      check('saleMpMp',        fields.saleMpMp        || null, product.saleMpMp);
      check('mpJhIgst',        fields.mpJhIgst        || null, product.mpJhIgst);
      check('mpMhIgst',        fields.mpMhIgst        || null, product.mpMhIgst);
      check('mpMpCgst',        fields.mpMpCgst        || null, product.mpMpCgst);
      check('mpMpSgst',        fields.mpMpSgst        || null, product.mpMpSgst);
      check('mpWbIgst',        fields.mpWbIgst        || null, product.mpWbIgst);
      check('mpWbSale',        fields.mpWbSale        || null, product.mpWbSale);
      check('forMpOrderForm',  fields.forMpOrderForm  || null, product.forMpOrderForm);
      check('upSr',            fields.upSr            || null, product.upSr);
      check('upHsn',           fields.upHsn           || null, product.upHsn);
      check('upSap',           fields.upSap           || null, product.upSap);
      check('upRate',          fields.upRate          || null, product.upRate);
      check('upIgst',          fields.upIgst          || null, product.upIgst);
      check('forUpOrderForm',  fields.forUpOrderForm  || null, product.forUpOrderForm);
      check('hsnCode',         fields.hsnCode         || null, product.hsnCode);
      check('sapCode',         fields.sapCode         || null, product.sapCode);
      check('newSr',           fields.newSr           || null, product.newSr);
      check('sellingPrice',    fields.sellingPrice    || null, product.sellingPrice);

      if (fieldChanges.length === 0 && product.notionPageId) { skipped++; continue; }

      updates.lastUpdated = new Date();
      updates.lastChangedBy = triggeredBy;
      updatesMap.set(product.id, updates);

      if (fieldChanges.length > 0) {
        changedProducts.push({ productId: product.id, productName: product.name, barcode: product.barcode || '', newSr: product.newSr || null, changes: fieldChanges });
      } else {
        skipped++;
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      errors.push(msg);
      console.error('[Notion Inventory Sync] Error processing page:', err);
    }
  }

  return { changedProducts, toCreate, createdProducts, updatesMap, errors, skipped, notFound, imageUrlByProductId, imageUrlByCreateIndex };
}

// ─── Detect-only (dry-run): stores pending, no DB writes ─────────────────────

export async function detectChangesFromNotion(triggeredBy = 'system', syncImages = true): Promise<SyncReport> {
  if (!NOTION_INVENTORY_DATABASE_ID) throw new Error('NOTION_INVENTORY_DATABASE_ID is not set');
  if (isSyncing) throw new Error('A sync is already in progress — please wait');

  isSyncing = true;
  try {
    console.log('[Notion Inventory Sync] Detecting changes (dry-run)...');
    const notionPages = await fetchAllNotionPages();
    const allProducts = await storage.getAllProducts();
    const { changedProducts, toCreate, createdProducts, updatesMap, errors, skipped, notFound, imageUrlByProductId, imageUrlByCreateIndex } =
      await computeChanges(notionPages, allProducts, triggeredBy);

    const report: SyncReport = {
      syncTime: new Date(), total: notionPages.length,
      created: toCreate.length, updated: changedProducts.length,
      skipped, notFound, triggeredBy, changedProducts, createdProducts, errors,
      imagesCached: 0, // filled in below once the image loop runs
    };

    pendingReport = report;
    pendingSyncImages = syncImages;
    pendingUpdates.clear();
    pendingCreates.length = 0;
    pendingImageUrlByProductId.clear();
    pendingImageUrlByCreateIndex.clear();
    for (const [id, upd] of updatesMap.entries()) pendingUpdates.set(id, upd);
    pendingCreates.push(...toCreate);
    for (const [id, url] of imageUrlByProductId.entries()) pendingImageUrlByProductId.set(id, url);
    for (const [idx, url] of imageUrlByCreateIndex.entries()) pendingImageUrlByCreateIndex.set(idx, url);

    // Images are never part of the reviewable field-level diff (nobody approves/rejects a
    // picture), so they can't wait on the Apply button — a product whose ONLY pending thing
    // is an uncached image would otherwise have hasPendingChanges stay false forever and the
    // Apply button would never even become clickable. Cache images for EXISTING products
    // right here, regardless of whether they also have a field-level change to review.
    // New (not-yet-created) products still wait for Apply, since they need a real id first.
    // Image caching downloads every product's picture from Notion to hash-check it, which is
    // the slow part. Skipped entirely when syncImages is false — the automatic startup /
    // 24-hour scheduled sync passes false so boot stays fast, since images rarely change and
    // a manual "Check Sync" (syncImages=true, the default) still refreshes them on demand.
    let imagesSynced = 0;
    if (syncImages) {
      await mapWithConcurrency(
        [...imageUrlByProductId.entries()],
        8,
        async ([productId, imageUrl]) => {
          try {
            const current = allProducts.find((p) => p.id === productId);
            const result = await syncProductImage(productId, imageUrl, current?.productImageHash);
            if (result) {
              await storage.updateProduct(productId, result);
              imagesSynced++;
            }
          } catch (err) {
            errors.push(`Image for product ${productId}: ${err instanceof Error ? err.message : String(err)}`);
          }
        },
      );
      if (imagesSynced > 0) console.log(`[Notion Inventory Sync] Cached ${imagesSynced} product image(s) during detect`);
    }

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
    const syncImages = pendingSyncImages;

    // Field updates first — plain DB writes, no network calls, so sequential is fine (and
    // keeps error attribution simple). Image work is collected separately below and run
    // concurrently, and ONLY when this pending batch came from a "Sync Photos" detect run —
    // a "Sync Notion" (fast, no photos) detect must stay photo-free all the way through Apply.
    for (const [productId, updates] of pendingUpdates.entries()) {
      try {
        await storage.updateProduct(productId, updates);
        updated++;
      } catch (err) {
        errors.push(`Update product ${productId}: ${err instanceof Error ? err.message : String(err)}`);
      }
    }

    let imagesSynced = 0;
    if (syncImages) {
      // Every tracked image URL for an EXISTING product — whether or not it also had a field
      // update above — checked/downloaded 8 at a time instead of one at a time (mirrors the
      // same concurrency fix already used in detectChangesFromNotion's image loop).
      await mapWithConcurrency(
        [...pendingImageUrlByProductId.entries()],
        8,
        async ([productId, imageUrl]) => {
          try {
            const current = await storage.getProduct(productId);
            const result = await syncProductImage(productId, imageUrl, current?.productImageHash);
            if (result) {
              await storage.updateProduct(productId, result);
              imagesSynced++;
            }
          } catch (err) {
            errors.push(`Image for product ${productId}: ${err instanceof Error ? err.message : String(err)}`);
          }
        },
      );
      if (imagesSynced > 0) console.log(`[Notion Inventory Sync] Cached ${imagesSynced} product image(s) on apply`);
    }

    // Creates are sequential (each needs a real id before its image can be synced), but the
    // image downloads for the newly-created products are then batched concurrently below —
    // same skip-when-not-syncImages rule as existing products.
    const createdImageWork: { productId: number; imageUrl: string }[] = [];
    for (let i = 0; i < pendingCreates.length; i++) {
      const data = pendingCreates[i];
      try {
        const newProduct = await storage.createProduct(data as any);
        created++;
        const imageUrl = pendingImageUrlByCreateIndex.get(i);
        if (imageUrl && syncImages) createdImageWork.push({ productId: newProduct.id, imageUrl });
      } catch (createErr) {
        // Most commonly a barcode conflict with a prior import that has no Notion ID —
        // surfaced now (was silently swallowed before) so a "detected but not applied"
        // change is actually explainable instead of just vanishing.
        const label = data?.name || data?.barcode || `row ${i + 1}`;
        errors.push(`Create "${label}": ${createErr instanceof Error ? createErr.message : String(createErr)}`);
      }
    }
    if (createdImageWork.length > 0) {
      await mapWithConcurrency(createdImageWork, 8, async ({ productId, imageUrl }) => {
        try {
          const result = await syncProductImage(productId, imageUrl, null);
          if (result) {
            await storage.updateProduct(productId, result);
            imagesSynced++;
          }
        } catch (err) {
          errors.push(`Image for new product ${productId}: ${err instanceof Error ? err.message : String(err)}`);
        }
      });
    }

    const report: SyncReport = { ...pendingReport, updated, created, errors, imagesCached: (pendingReport.imagesCached ?? 0) + imagesSynced };
    syncHistory.unshift(report);
    if (syncHistory.length > MAX_HISTORY) syncHistory.splice(MAX_HISTORY);
    pendingReport = null;
    pendingUpdates.clear();
    pendingCreates.length = 0;
    pendingImageUrlByProductId.clear();
    pendingImageUrlByCreateIndex.clear();
    pendingSyncImages = false;

    console.log(`[Notion Inventory Sync] Applied — updated: ${updated}, created: ${created}${syncImages ? `, images: ${imagesSynced}` : ' (photos skipped — Sync Notion run)'}`);
    return report;
  } finally {
    isSyncing = false;
  }
}

// ─── Full sync: clear inventory → import everything from Notion ───────────────

export async function fullSyncFromNotion(triggeredBy = 'system'): Promise<SyncReport> {
  if (!NOTION_INVENTORY_DATABASE_ID) throw new Error('NOTION_INVENTORY_DATABASE_ID is not set');
  if (isSyncing) throw new Error('A sync is already in progress — please wait');

  isSyncing = true;
  const errors: string[] = [];
  let created = 0;
  let imagesCached = 0;
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
        if (!fields.barcode && !fields.name) continue;
        const data = { ...buildProductData(fields), lastChangedBy: triggeredBy };
        const newProduct = await storage.createProduct(data as any);
        created++;
        createdProducts.push({ productName: fields.name, barcode: fields.barcode, notionPageId: fields.notionPageId });
        if (fields.productImageUrl) {
          try {
            const result = await syncProductImage(newProduct.id, fields.productImageUrl, null);
            if (result) { await storage.updateProduct(newProduct.id, result); imagesCached++; }
          } catch (imgErr) {
            errors.push(`Image for product ${newProduct.id}: ${imgErr instanceof Error ? imgErr.message : String(imgErr)}`);
          }
        }
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
      triggeredBy, changedProducts: [], createdProducts, errors, imagesCached,
    };
    syncHistory.unshift(report);
    if (syncHistory.length > MAX_HISTORY) syncHistory.splice(MAX_HISTORY);
    pendingReport = null;
    pendingUpdates.clear();
    pendingCreates.length = 0;
    pendingSyncImages = false;

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

// ─── Auto-apply toggle (server-persisted, shared across everyone) ─────────────
// Gates whether the 24-hour scheduled sync (server/routes.ts) is allowed to apply detected
// changes on its own. Off by default — the scheduled job then only detects and leaves changes
// pending for an admin to review via the UI.
export async function getAutoApplyEnabled(): Promise<boolean> {
  const { rows } = await pool.query(`SELECT auto_apply_enabled AS "autoApplyEnabled" FROM notion_inventory_sync_config WHERE id = 1`);
  return rows[0]?.autoApplyEnabled === true;
}

export async function setAutoApplyEnabled(enabled: boolean, updatedBy: string): Promise<void> {
  await pool.query(
    `INSERT INTO notion_inventory_sync_config (id, auto_apply_enabled, updated_by, updated_at)
     VALUES (1, $1, $2, NOW())
     ON CONFLICT (id) DO UPDATE SET auto_apply_enabled = EXCLUDED.auto_apply_enabled, updated_by = EXCLUDED.updated_by, updated_at = NOW()`,
    [enabled, updatedBy],
  );
}

// ─── Webhook: apply ONE changed Notion page straight away ────────────────────
// Called by the Notion webhook (server/routes/notion-webhook.ts) the moment a Product Master page
// changes in Notion — the same field mapping and matching as a full detect + apply, just for that
// single page, including its photo (only re-downloaded when the image content actually changed).
// 'busy' means a full sync is running right now; the webhook retries the page a little later.
export type WebhookApplyResult = 'updated' | 'created' | 'unchanged' | 'skipped' | 'busy';

export async function applyProductPageFromNotionWebhook(page: any): Promise<WebhookApplyResult> {
  if (isSyncing) return 'busy';
  const { rows } = await pool.query(`SELECT id FROM products WHERE notion_page_id = $1 LIMIT 1`, [page.id]);
  const existing = rows[0] ? await storage.getProduct(rows[0].id) : undefined;
  const result = await computeChanges([page], existing ? [existing] : [], 'notion-webhook');
  if (result.errors.length) throw new Error(result.errors.join('; '));
  if (result.notFound > 0) return 'skipped'; // no barcode and no name — the full sync skips these too

  let outcome: WebhookApplyResult = 'unchanged';
  for (const [productId, updates] of Array.from(result.updatesMap.entries())) {
    await storage.updateProduct(productId, updates);
    outcome = 'updated';
  }
  for (const [productId, imageUrl] of Array.from(result.imageUrlByProductId.entries())) {
    const current = await storage.getProduct(productId);
    const image = await syncProductImage(productId, imageUrl, current?.productImageHash);
    if (image) {
      await storage.updateProduct(productId, image);
      outcome = 'updated';
    }
  }
  if (result.toCreate.length > 0) {
    const created = await storage.createProduct(result.toCreate[0] as any);
    const imageUrl = result.imageUrlByCreateIndex.get(0);
    if (imageUrl) {
      const image = await syncProductImage(created.id, imageUrl, null);
      if (image) await storage.updateProduct(created.id, image);
    }
    return 'created';
  }
  return outcome;
}
