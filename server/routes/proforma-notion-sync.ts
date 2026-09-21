import { Router, Request, Response } from 'express';
import {
  detectProformaChanges,
  getPendingProformaReport,
  applyPendingProformaChanges,
  clearPendingProformaChanges,
} from '../services/proformaNotionSync';
import { requirePageWrite } from '../lib/pageAccess';

const router = Router();

// Same rule as the Proforma Slips page itself: anyone with write access to 'proforma' can
// check and apply Notion changes (admins always pass). It used to be admin-only here while the
// page showed "Sync from Notion" to every write user, so for them the button just failed with
// "Admin access required".
router.use('/proforma-notion-sync', requirePageWrite('proforma'));

function callerName(req: Request): string {
  const u = req.user as any;
  return u?.name || u?.username || u?.userCode || 'unknown';
}

// POST /api/proforma-notion-sync/detect — body: { startDate, endDate }
// Dry-run: fetches Notion for the given range and diffs it against what's already imported,
// without writing anything. Returns a report; the actual changes are held in memory until
// /apply is called (or another /detect replaces them).
router.post('/proforma-notion-sync/detect', async (req: Request, res: Response) => {
  try {
    const { startDate, endDate } = req.body;
    if (!startDate || !endDate) {
      return res.status(400).json({ success: false, message: 'Start date and end date are required' });
    }
    const report = await detectProformaChanges(startDate, endDate, callerName(req));
    res.json({ success: true, report });
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Unknown error';
    const status = message.includes('already in progress') ? 409 : 500;
    res.status(status).json({ success: false, message });
  }
});

// GET /api/proforma-notion-sync/pending — whatever the last /detect found, if not yet applied.
router.get('/proforma-notion-sync/pending', (_req: Request, res: Response) => {
  const report = getPendingProformaReport();
  res.json({ hasPending: !!report && (report.newCount > 0 || report.changedCount > 0), report });
});

// POST /api/proforma-notion-sync/apply — writes the pending changes from the last /detect.
// body: { orderNumbers?: string[] } — the orders the user checked in the review UI. Omit to
// apply everything still pending.
router.post('/proforma-notion-sync/apply', async (req: Request, res: Response) => {
  try {
    const orderNumbers = Array.isArray(req.body?.orderNumbers) ? req.body.orderNumbers : undefined;
    const result = await applyPendingProformaChanges(orderNumbers);
    res.json({ success: true, ...result });
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Unknown error';
    const status = message.includes('No orders selected')
      ? 400
      : message.includes('already in progress') || message.includes('No pending changes')
        ? 409
        : 500;
    res.status(status).json({ success: false, message });
  }
});

// POST /api/proforma-notion-sync/discard — drops the pending report without applying it.
router.post('/proforma-notion-sync/discard', (_req: Request, res: Response) => {
  clearPendingProformaChanges();
  res.json({ success: true });
});

export default router;
