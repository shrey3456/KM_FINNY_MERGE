import { Router } from 'express';
import { syncInventoryFromNotion, getSyncStatus, getSyncHistory } from '../services/notionInventorySync';

const router = Router();

// POST /api/notion-inventory-sync/trigger — run a sync immediately, returns full report
router.post('/notion-inventory-sync/trigger', async (req, res) => {
  try {
    const report = await syncInventoryFromNotion();
    res.json({ success: true, ...report });
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Unknown error';
    const status = message.includes('already in progress') ? 409 : 500;
    res.status(status).json({ success: false, message });
  }
});

// GET /api/notion-inventory-sync/status — current sync state + last report
router.get('/notion-inventory-sync/status', (_req, res) => {
  res.json(getSyncStatus());
});

// GET /api/notion-inventory-sync/history — last 10 sync reports
router.get('/notion-inventory-sync/history', (_req, res) => {
  res.json(getSyncHistory());
});

export default router;
