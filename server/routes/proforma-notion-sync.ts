import { Router, Request, Response } from 'express';
import {
  detectProformaChanges,
  getPendingProformaReport,
  applyPendingProformaChanges,
  clearPendingProformaChanges,
  getAutoApplyEnabled,
  setAutoApplyEnabled,
  logProformaSync,
} from '../services/proformaNotionSync';
import { requirePageWrite } from '../lib/pageAccess';

const router = Router();

// Same rule as the Proforma Slips page itself: anyone with write access to 'proforma' can
// check and apply Notion changes (admins always pass). It used to be admin-only here while the
// page showed "Sync from Notion" to every write user, so for them the button just failed with
// "Admin access required".
router.use('/proforma-notion-sync', requirePageWrite('proforma'));

function callerWho(req: Request) {
  const u = req.user as any;
  return { userCode: u?.userCode ?? null, userName: u?.name || u?.username || u?.userCode || null };
}

// "27 orders: 26 new, 1 changed" style list of order numbers, kept short for the Activities line.
const listOrders = (nums: string[], max = 30) => (nums.length === 0 ? '' : ` [${nums.slice(0, max).join(', ')}${nums.length > max ? `, +${nums.length - max} more` : ''}]`);

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
    void logProformaSync(
      `Notion check (Proforma Slips) by ${callerName(req)}: ${startDate} to ${endDate} — ${report.totalOrders} order(s) in Notion, ${report.newCount} new, ${report.changedCount} changed, ${report.unchangedCount} unchanged. Nothing was written; the changes wait for Apply.`,
      callerWho(req),
    );
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
    void logProformaSync(
      `Notion sync applied (Proforma Slips) by ${callerName(req)}: ${result.slipsCreated} slip(s) created${listOrders(result.createdOrderNumbers)}, ${result.slipsUpdated} updated${listOrders(result.updatedOrderNumbers)}, ${result.itemsCreated} item(s) written`,
      callerWho(req),
    );
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
router.post('/proforma-notion-sync/discard', (req: Request, res: Response) => {
  const pending = getPendingProformaReport();
  clearPendingProformaChanges();
  void logProformaSync(
    `Notion sync discarded (Proforma Slips) by ${callerName(req)}${pending ? `: ${pending.newCount} new and ${pending.changedCount} changed order(s) were dropped without being applied` : ''}`,
    callerWho(req),
  );
  res.json({ success: true });
});

// GET /api/proforma-notion-sync/auto-apply-config
// Whether the 5-hour scheduled sync (and a manual "Check for Changes") is allowed to apply
// detected changes on its own. Shared across everyone (single server-side setting) — readable by
// anyone with Proforma access, changeable only with write access (see the router gate above).
router.get('/proforma-notion-sync/auto-apply-config', async (_req: Request, res: Response) => {
  try {
    res.json({ enabled: await getAutoApplyEnabled() });
  } catch (err) {
    res.status(500).json({ message: err instanceof Error ? err.message : 'Failed to read auto-apply setting' });
  }
});

router.post('/proforma-notion-sync/auto-apply-config', async (req: Request, res: Response) => {
  try {
    const enabled = req.body?.enabled === true;
    await setAutoApplyEnabled(enabled, callerName(req));
    res.json({ enabled });
  } catch (err) {
    res.status(500).json({ message: err instanceof Error ? err.message : 'Failed to save auto-apply setting' });
  }
});

export default router;
