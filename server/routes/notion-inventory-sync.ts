import { Router, Request, Response, NextFunction } from 'express';
import path from 'path';
import {
  detectChangesFromNotion,
  applyPendingChanges,
  fullSyncFromNotion,
  getPendingReport,
  getSyncStatus,
  getSyncHistory,
  getAutoApplyEnabled,
  setAutoApplyEnabled,
  PRODUCT_IMAGE_DIR,
} from '../services/notionInventorySync';
import { storage } from '../storage';

const router = Router();

function requireAdminRole(req: Request, res: Response, next: NextFunction) {
  if (!req.isAuthenticated()) {
    return res.status(401).json({ success: false, message: 'Not authenticated' });
  }
  const user = req.user as any;
  const role = (user?.role ?? '').toLowerCase();
  if (role !== 'admin' && role !== 'super-admin') {
    return res.status(403).json({ success: false, message: 'Admin access required' });
  }
  next();
}

router.use('/notion-inventory-sync', requireAdminRole);

function callerName(req: Request): string {
  const u = req.user as any;
  return u?.name || u?.username || u?.userCode || 'unknown';
}

// POST /api/notion-inventory-sync/detect
router.post('/notion-inventory-sync/detect', async (req, res) => {
  try {
    const report = await detectChangesFromNotion(callerName(req));
    res.json({ success: true, ...report });
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Unknown error';
    const status = message.includes('already in progress') ? 409 : 500;
    res.status(status).json({ success: false, message });
  }
});

// GET /api/notion-inventory-sync/pending
router.get('/notion-inventory-sync/pending', (_req, res) => {
  const report = getPendingReport();
  if (!report) return res.json({ hasPending: false, report: null });
  res.json({ hasPending: report.updated > 0 || report.created > 0, report });
});

// POST /api/notion-inventory-sync/apply
router.post('/notion-inventory-sync/apply', async (_req, res) => {
  try {
    const report = await applyPendingChanges();
    res.json({ success: true, ...report });
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Unknown error';
    const status = message.includes('already in progress') ? 409 : 500;
    res.status(status).json({ success: false, message });
  }
});

// POST /api/notion-inventory-sync/full-sync
router.post('/notion-inventory-sync/full-sync', async (req, res) => {
  try {
    const report = await fullSyncFromNotion(callerName(req));
    res.json({ success: true, ...report });
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Unknown error';
    const status = message.includes('already in progress') ? 409 : 500;
    res.status(status).json({ success: false, message });
  }
});

// GET /api/notion-inventory-sync/status
router.get('/notion-inventory-sync/status', (_req, res) => {
  res.json(getSyncStatus());
});

// GET /api/notion-inventory-sync/auto-apply-config
// Whether the 24-hour scheduled sync is allowed to apply detected changes on its own.
// Shared across everyone (single server-side setting), not a per-browser preference — mounted
// under requireAdminRole above, so only admin/super-admin can read or change it.
router.get('/notion-inventory-sync/auto-apply-config', async (_req, res) => {
  try {
    res.json({ enabled: await getAutoApplyEnabled() });
  } catch (err) {
    res.status(500).json({ message: err instanceof Error ? err.message : 'Failed to read auto-apply setting' });
  }
});

router.post('/notion-inventory-sync/auto-apply-config', async (req, res) => {
  try {
    const enabled = req.body?.enabled === true;
    await setAutoApplyEnabled(enabled, callerName(req));
    res.json({ enabled });
  } catch (err) {
    res.status(500).json({ message: err instanceof Error ? err.message : 'Failed to save auto-apply setting' });
  }
});

// GET /api/notion-inventory-sync/inspect-properties
// Returns the actual Notion property names in the inventory DB + a sample record's values.
// Use this to debug why a field (e.g. brand) isn't syncing.
router.get('/notion-inventory-sync/inspect-properties', async (_req, res) => {
  try {
    const { Client } = await import('@notionhq/client');
    const notion = new Client({
      auth: (process.env.NOTION_INTEGRATION_SECRET ?? process.env.NOTION_API_KEY ?? '').trim(),
    });
    const dbId = (process.env.NOTION_INVENTORY_DATABASE_ID ?? '').trim();
    if (!dbId) return res.status(500).json({ error: 'NOTION_INVENTORY_DATABASE_ID not set' });

    const [schema, sample] = await Promise.all([
      notion.databases.retrieve({ database_id: dbId }),
      notion.databases.query({ database_id: dbId, page_size: 1 }),
    ]);

    const propertySchema = Object.entries(schema.properties).map(([name, prop]: [string, any]) => ({
      name,
      type: prop.type,
    }));

    let sampleValues: Record<string, any> = {};
    if (sample.results.length > 0) {
      const page: any = sample.results[0];
      for (const [key, prop] of Object.entries(page.properties) as [string, any][]) {
        let val: any = null;
        if (prop.type === 'title')        val = prop.title?.map((t: any) => t.plain_text).join('') || null;
        else if (prop.type === 'rich_text') val = prop.rich_text?.map((t: any) => t.plain_text).join('') || null;
        else if (prop.type === 'select')   val = prop.select?.name ?? null;
        else if (prop.type === 'multi_select') val = prop.multi_select?.map((s: any) => s.name).join(', ') || null;
        else if (prop.type === 'number')   val = prop.number;
        else if (prop.type === 'status')   val = prop.status?.name ?? null;
        else                              val = `(${prop.type})`;
        sampleValues[key] = val;
      }
    }

    res.json({ databaseId: dbId, properties: propertySchema, sampleRecord: sampleValues });
  } catch (err) {
    res.status(500).json({ error: err instanceof Error ? err.message : String(err) });
  }
});

// GET /api/notion-inventory-sync/history
router.get('/notion-inventory-sync/history', (_req, res) => {
  res.json(getSyncHistory());
});

// ── CSV column header → DB field mapping ─────────────────────────────────────
const CSV_HEADER_MAP: Record<string, string> = {
  "New Sr.": "newSr", "SKU": "barcode", "Products Name": "name",
  "Notion Wise Name": "notionWiseName", "Brand": "brand", "Category": "category",
  "Sale Category": "saleCategory", "Plant": "plant", "Type": "type",
  "Product Image": "productImage", "Vol Master": "volumeInCuFt", "Packets": "itemsPerPallet",
  "IND PLT": "indPlt", "VAL PLT": "valPlt",
  "GJ Sr": "gjSr", "GJ HSN": "gjHsn", "GJ SAP": "gjSap",
  "GJ Sale Rate": "gjSaleRate", "GJ IGST": "gjIgst",
  "GJ-GA PUR": "gjGaPur", "GJ-MH PUR": "gjMhPur", "GJ-NAGAR PUR": "gjNagarPur",
  "For GJ Order Form": "forGjOrderForm",
  "MP Sr": "mpSr", "MP HSN": "mpHsn", "MP SAP": "mpSap",
  "MP-JH PUR": "mpJhPur", "MP-MH PUR": "mpMhPur",
  "MP-MP Jabalpur": "mpMpPurJabalpur", "MP-MP Khargone": "mpMpPurKhargone",
  "MP-WB PUR": "mpWbPur", "Sale MP-JH": "saleMpJh", "Sale MP-MH": "saleMpMh",
  "Sale MP-MP": "saleMpMp", "MP-JH IGST": "mpJhIgst", "MP-MH IGST": "mpMhIgst",
  "MP-MP CGST": "mpMpCgst", "MP-MP SGST": "mpMpSgst",
  "MP-WB IGST": "mpWbIgst", "MP-WB Sale": "mpWbSale",
  "For MP Order Form": "forMpOrderForm",
  "UP Sr": "upSr", "UP HSN": "upHsn", "UP SAP": "upSap",
  "UP Rate": "upRate", "UP IGST": "upIgst", "For UP Order Form": "forUpOrderForm",
};
const INTEGER_FIELDS = new Set(["itemsPerPallet", "indPlt", "valPlt"]);

// GET /api/products/image-by-name?name=...
// Serves a product's locally-cached image (never the raw Notion URL — see
// notionInventorySync.ts for why). Looked up by name rather than barcode because the
// same barcode can be shared by multiple distinct products; the Scan page already
// resolves scans down to one exact item name before it needs the picture.
router.get('/products/image-by-name', async (req: Request, res: Response) => {
  try {
    if (!req.isAuthenticated || !req.isAuthenticated()) {
      return res.status(401).json({ message: 'Not authenticated' });
    }
    const name = typeof req.query.name === 'string' ? req.query.name.trim() : '';
    if (!name) return res.status(400).json({ message: 'name is required' });

    const product = await storage.getProductByName(name);
    if (!product?.productImage || !product.productImageHash) {
      return res.status(404).json({ message: 'No image for this product' });
    }

    res.set({
      'Cache-Control': 'public, max-age=3600',
      'ETag': product.productImageHash,
    });
    if (req.headers['if-none-match'] === product.productImageHash) {
      return res.status(304).end();
    }

    res.sendFile(path.join(PRODUCT_IMAGE_DIR, product.productImage), (err) => {
      if (err && !res.headersSent) res.status(404).json({ message: 'Image file missing' });
    });
  } catch (err) {
    res.status(500).json({ message: err instanceof Error ? err.message : 'Failed to serve product image' });
  }
});

// POST /api/products/csv-import
router.post('/products/csv-import', requireAdminRole, async (req: Request, res: Response) => {
  try {
    const rows: Record<string, string>[] = req.body.rows;
    if (!Array.isArray(rows) || rows.length === 0)
      return res.status(400).json({ message: 'No rows provided' });

    let created = 0, updated = 0, skipped = 0;
    const errors: string[] = [];

    for (let i = 0; i < rows.length; i++) {
      const raw = rows[i];
      try {
        const mapped: Record<string, any> = {};
        for (const [header, value] of Object.entries(raw)) {
          const field = CSV_HEADER_MAP[header.trim()] ?? null;
          if (!field || value === undefined || value === null) continue;
          const v = String(value).trim();
          if (v === '') continue;
          mapped[field] = INTEGER_FIELDS.has(field) ? (parseInt(v) || 0) : v;
        }

        const barcode: string = mapped.barcode || '';
        const name: string = mapped.name || '';
        if (!barcode && !name) { skipped++; continue; }

        const existing = barcode ? await storage.getProductByBarcode(barcode) : null;
        if (existing) {
          await storage.updateProduct(existing.id, mapped);
          updated++;
        } else {
          await storage.createProduct({ barcode: barcode || '', name: name || '', ...mapped });
          created++;
        }
      } catch (rowErr) {
        errors.push(`Row ${i + 2}: ${rowErr instanceof Error ? rowErr.message : String(rowErr)}`);
      }
    }

    res.json({ success: true, created, updated, skipped, errors, total: rows.length });
  } catch (err) {
    res.status(500).json({ message: err instanceof Error ? err.message : 'CSV import failed' });
  }
});

export default router;
