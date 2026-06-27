import { Router, Request, Response, NextFunction } from 'express';
import {
  detectChangesFromNotion,
  applyPendingChanges,
  fullSyncFromNotion,
  getPendingReport,
  getSyncStatus,
  getSyncHistory,
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
