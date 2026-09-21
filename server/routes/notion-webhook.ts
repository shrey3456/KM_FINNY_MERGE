import { Router, Request, Response } from 'express';
import crypto from 'crypto';
import { Client } from '@notionhq/client';
import { pool } from '../db';
import { extractText } from '../lib/notionProperties';
import { requireAdminRole } from '../lib/pageAccess';
import { applyVehiclePageFromNotionWebhook } from '../services/notionVehicleSync';
import { applyProductPageFromNotionWebhook } from '../services/notionInventorySync';

// ─────────────────────────────────────────────────────────────────────────────────────────────────
// Notion webhook — Notion calls this the moment a page changes, so the app follows Notion directly
// instead of waiting for a scheduled or manual sync.
//
//   ORDER database          → only proforma_slips.notion_status ("Finny Status :") is updated
//   Vehicle Master database → the vehicle_info row is updated / created (same mapping as the sync)
//   Product Master database → the products row is updated / created (same mapping as the sync)
//
// How a request is handled:
//   1. Verification (once, when the subscription is created in Notion): Notion posts
//      { verification_token }. It's written to the server log so it can be pasted back into Notion
//      and saved as NOTION_WEBHOOK_VERIFICATION_TOKEN.
//   2. Every real event carries X-Notion-Signature = "sha256=" + HMAC-SHA256(raw body, that token).
//      Anything that doesn't match is refused, so nobody else can post fake changes here.
//   3. Notion gets its 200 straight away; the work happens after. The event only says WHICH page
//      changed, never the new values, so that page is read back from Notion and routed by the
//      database it belongs to.
//   4. Several events for the same page within a few seconds (a person editing a few fields) are
//      collapsed into one read of the page.
// Public on purpose (Notion has no login) — the signature is the protection.
// ─────────────────────────────────────────────────────────────────────────────────────────────────

const router = Router();

const notion = new Client({
  auth: (process.env.NOTION_INTEGRATION_SECRET ?? process.env.NOTION_API_KEY ?? '').trim(),
});

const normalizeId = (id: string | null | undefined) => String(id ?? '').replace(/-/g, '').trim().toLowerCase();

const DATABASES = {
  order: normalizeId(process.env.ORDER_DATABASE_ID),
  vehicle: normalizeId(process.env.NOTION_VEHICLE_DATABASE_ID),
  product: normalizeId(process.env.NOTION_INVENTORY_DATABASE_ID),
};

// Page events worth reading the page back for. Deletions are only logged: removing a vehicle or a
// product here because a page was trashed in Notion is not something to do silently.
const PAGE_EVENTS = new Set(['page.created', 'page.properties_updated', 'page.content_updated', 'page.undeleted', 'page.moved']);

const COALESCE_MS = 3000;       // wait this long after the last event for a page before reading it
const BUSY_RETRY_MS = 30000;    // a full sync was running — try the page again after this
const MAX_BUSY_RETRIES = 10;

// ── Recent activity, for the admin status endpoint (in memory, newest first) ──────────────────────
type ActivityEntry = { at: string; type: string; pageId?: string; database?: string; result: string; detail?: string };
const recentActivity: ActivityEntry[] = [];
let lastVerificationAt: string | null = null;
function logActivity(entry: Omit<ActivityEntry, 'at'>) {
  recentActivity.unshift({ at: new Date().toISOString(), ...entry });
  if (recentActivity.length > 100) recentActivity.length = 100;
  const tail = [entry.database, entry.pageId, entry.detail].filter(Boolean).join(' · ');
  console.log(`[Notion webhook] ${entry.type} → ${entry.result}${tail ? ` (${tail})` : ''}`);
}

function signatureIsValid(rawBody: Buffer | undefined, header: string | undefined, token: string): boolean {
  if (!rawBody || !header) return false;
  const expected = `sha256=${crypto.createHmac('sha256', token).update(rawBody).digest('hex')}`;
  const a = Buffer.from(expected);
  const b = Buffer.from(header.trim());
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

// ── Order database: only the Finny Status ─────────────────────────────────────────────────────────
async function applyOrderStatus(page: any): Promise<string> {
  const orderNumber = extractText(page.properties?.['Order No. :']).trim();
  if (!orderNumber) return 'skipped (no order number)';
  const status = extractText(page.properties?.['Finny Status :']).trim() || null;
  const { rowCount } = await pool.query(
    `UPDATE proforma_slips SET notion_status = $1
     WHERE order_number = $2 AND notion_status IS DISTINCT FROM $1`,
    [status, orderNumber],
  );
  // A change the app itself pushed to Notion comes back here as an event too — it already matches,
  // so it's simply "unchanged", which also means the two never loop.
  return rowCount ? `updated (#${orderNumber} → ${status ?? 'empty'})` : `unchanged (#${orderNumber})`;
}

// ── One page: read it back, route it by its database ──────────────────────────────────────────────
async function processPage(pageId: string, eventType: string, attempt = 0): Promise<void> {
  let page: any;
  try {
    page = await notion.pages.retrieve({ page_id: pageId });
  } catch (error) {
    logActivity({ type: eventType, pageId, result: 'error', detail: `could not read page: ${error instanceof Error ? error.message : String(error)}` });
    return;
  }

  const parentId = normalizeId(page?.parent?.database_id);
  const database =
    parentId && parentId === DATABASES.order ? 'order'
    : parentId && parentId === DATABASES.vehicle ? 'vehicle'
    : parentId && parentId === DATABASES.product ? 'product'
    : null;
  if (!database) {
    logActivity({ type: eventType, pageId, result: 'ignored', detail: 'page is not in the order, vehicle or product database' });
    return;
  }

  try {
    if (database === 'order') {
      logActivity({ type: eventType, pageId, database, result: await applyOrderStatus(page) });
      return;
    }
    const result = database === 'vehicle'
      ? await applyVehiclePageFromNotionWebhook(page)
      : await applyProductPageFromNotionWebhook(page);
    if (result === 'busy') {
      if (attempt < MAX_BUSY_RETRIES) {
        setTimeout(() => { void processPage(pageId, eventType, attempt + 1); }, BUSY_RETRY_MS);
        logActivity({ type: eventType, pageId, database, result: 'waiting', detail: 'a full sync is running — will retry' });
      } else {
        logActivity({ type: eventType, pageId, database, result: 'gave up', detail: 'a full sync kept running' });
      }
      return;
    }
    logActivity({ type: eventType, pageId, database, result });
  } catch (error) {
    logActivity({ type: eventType, pageId, database, result: 'error', detail: error instanceof Error ? error.message : String(error) });
  }
}

const pendingPages = new Map<string, { timer: ReturnType<typeof setTimeout>; eventType: string }>();
function schedulePage(pageId: string, eventType: string) {
  const existing = pendingPages.get(pageId);
  if (existing) clearTimeout(existing.timer);
  const timer = setTimeout(() => {
    pendingPages.delete(pageId);
    void processPage(pageId, eventType);
  }, COALESCE_MS);
  pendingPages.set(pageId, { timer, eventType });
}

// POST /api/webhooks/notion — the URL registered in Notion.
router.post('/webhooks/notion', (req: Request, res: Response) => {
  const body = req.body ?? {};

  // 1. One-time verification when the subscription is created.
  if (typeof body.verification_token === 'string' && !req.headers['x-notion-signature']) {
    lastVerificationAt = new Date().toISOString();
    console.log('\n[Notion webhook] ================================================================');
    console.log('[Notion webhook] Verification token received. Paste it into Notion (Webhooks → Verify)');
    console.log('[Notion webhook] and save it on the server as NOTION_WEBHOOK_VERIFICATION_TOKEN:');
    console.log(`[Notion webhook] ${body.verification_token}`);
    console.log('[Notion webhook] ================================================================\n');
    return res.status(200).json({ ok: true });
  }

  // 2. Real events must be signed with that token.
  const token = (process.env.NOTION_WEBHOOK_VERIFICATION_TOKEN ?? '').trim();
  if (!token) {
    logActivity({ type: String(body.type ?? 'event'), result: 'ignored', detail: 'NOTION_WEBHOOK_VERIFICATION_TOKEN is not set on the server' });
    return res.status(200).json({ ok: true });
  }
  const signature = req.headers['x-notion-signature'];
  if (!signatureIsValid((req as any).rawBody, Array.isArray(signature) ? signature[0] : signature, token)) {
    logActivity({ type: String(body.type ?? 'event'), result: 'rejected', detail: 'signature did not match' });
    return res.status(401).json({ message: 'Invalid signature' });
  }

  // 3. Acknowledge immediately, then do the work.
  res.status(200).json({ ok: true });

  const type = String(body.type ?? '');
  const pageId = body.entity?.type === 'page' ? String(body.entity.id ?? '') : '';
  if (!pageId) {
    logActivity({ type: type || 'event', result: 'ignored', detail: 'not a page event' });
    return;
  }
  if (type === 'page.deleted') {
    logActivity({ type, pageId, result: 'ignored', detail: 'page moved to trash in Notion — nothing is deleted in the app' });
    return;
  }
  if (!PAGE_EVENTS.has(type)) {
    logActivity({ type, pageId, result: 'ignored', detail: 'event type not used' });
    return;
  }
  schedulePage(pageId, type);
});

// GET /api/webhooks/notion/status-link — the address the Settings page's "Open status" button opens.
// Taken from NOTION_WEBHOOK_STATUS_URL in .env (e.g. http://localhost:5000/api/webhooks/notion/status
// locally, https://yourdomain.com/api/webhooks/notion/status live); without it, this app's own status page.
router.get('/webhooks/notion/status-link', requireAdminRole, (_req: Request, res: Response) => {
  const configured = (process.env.NOTION_WEBHOOK_STATUS_URL ?? '').trim();
  res.json({ url: configured || '/api/webhooks/notion/status', fromEnv: !!configured });
});

// GET /api/webhooks/notion/status — admins: is it set up, and what has arrived recently.
router.get('/webhooks/notion/status', requireAdminRole, (_req: Request, res: Response) => {
  res.json({
    tokenConfigured: !!(process.env.NOTION_WEBHOOK_VERIFICATION_TOKEN ?? '').trim(),
    databasesConfigured: {
      order: !!DATABASES.order,
      vehicle: !!DATABASES.vehicle,
      product: !!DATABASES.product,
    },
    lastVerificationAt,
    pendingPages: pendingPages.size,
    recentActivity,
  });
});

export default router;
