import { Router, Request, Response, NextFunction } from 'express';
import {
  detectChangesFromNotion,
  applyPendingChanges,
  fullSyncFromNotion,
  getPendingReport,
  getSyncStatus,
  getSyncHistory,
  debugNotionProps,
} from '../services/notionInventorySync';

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

// POST /api/notion-inventory-sync/detect
router.post('/notion-inventory-sync/detect', async (_req, res) => {
  try {
    const report = await detectChangesFromNotion();
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
router.post('/notion-inventory-sync/full-sync', async (_req, res) => {
  try {
    const report = await fullSyncFromNotion();
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

// GET /api/notion-inventory-sync/debug-props
// Returns raw property names + types from the first Notion page — used to verify field mapping.
router.get('/notion-inventory-sync/debug-props', async (_req, res) => {
  try {
    const result = await debugNotionProps();
    res.json(result);
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Unknown error';
    res.status(500).json({ success: false, message });
  }
});

export default router;
