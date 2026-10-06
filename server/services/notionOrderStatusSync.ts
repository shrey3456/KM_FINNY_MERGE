// Pushes Loading-page status changes back to Notion's ORDER database "Finny Status :" property
// — the same field server/services/proformaNotionSync.ts already reads FROM Notion into
// proforma_slips.notionStatus, so this keeps that field a real two-way sync instead of one-way.
//
// Best-effort by design: every call catches and logs its own errors rather than throwing, so a
// slow/unreachable Notion API never blocks or fails the actual Loading action (linking a
// vehicle, completing a load) that triggered it — the local DB write always wins; Notion is a
// mirror, not the source of truth for the app's own state.

import { Client } from '@notionhq/client';
import { pool } from '../db';

// "Finny Status :" is a Notion status property with a fixed set of options (confirmed live
// against the database): LOADING is used while loading is in progress; READY≈DESP ("Ready for
// Despatch") once loading finishes — the vehicle is loaded and ready to leave, but hasn't
// necessarily left yet, which is what DISPATCHED would otherwise (mis)imply.
export const NOTION_LOADING_STATUS = 'LOADING';
export const NOTION_LOADING_COMPLETE_STATUS = 'READY≈DESP';

// The status options with the colour Notion gives each one, so the app can show a status in the
// same colour as Notion does. Read from the database schema and cached; if Notion can't be
// reached (or the property changes shape) the last known list — or the colours confirmed against
// the live database — is used instead, so a badge is never left uncoloured.
export type FinnyStatusOption = { name: string; color: string };
const FALLBACK_STATUS_OPTIONS: FinnyStatusOption[] = [
  { name: 'ORDER≈GENR', color: 'yellow' }, { name: 'HI-PRIORITY', color: 'red' },
  { name: 'VEHI≈ASSGN', color: 'orange' }, { name: 'VEHI≈ARRIV', color: 'green' },
  { name: 'ON HOLD', color: 'red' }, { name: 'IN-PROCESS', color: 'green' },
  { name: 'SORTING', color: 'pink' }, { name: 'READY≈LOAD', color: 'blue' },
  { name: 'LOADING', color: 'green' }, { name: 'UNLOADING', color: 'orange' },
  { name: 'SHORTAGE', color: 'blue' }, { name: 'CANCELLED', color: 'red' },
  { name: 'READY≈DESP', color: 'brown' }, { name: 'DISPATCHED', color: 'purple' },
  { name: 'DELIVERED', color: 'default' },
];
let statusOptionCache: { options: FinnyStatusOption[]; at: number } | null = null;
const STATUS_OPTION_TTL_MS = 10 * 60 * 1000;

export async function getFinnyStatusOptions(): Promise<FinnyStatusOption[]> {
  if (statusOptionCache && Date.now() - statusOptionCache.at < STATUS_OPTION_TTL_MS) return statusOptionCache.options;
  try {
    const orderDatabaseId = process.env.ORDER_DATABASE_ID;
    if (!orderDatabaseId || !process.env.NOTION_INTEGRATION_SECRET) throw new Error('Notion is not configured');
    const notion = new Client({ auth: process.env.NOTION_INTEGRATION_SECRET });
    const db: any = await notion.databases.retrieve({ database_id: orderDatabaseId });
    const prop = db?.properties?.['Finny Status :'];
    const raw: any[] = prop?.status?.options ?? prop?.select?.options ?? [];
    const options = raw.map((o) => ({ name: String(o.name), color: String(o.color ?? 'default') }));
    if (options.length === 0) throw new Error('No status options found');
    statusOptionCache = { options, at: Date.now() };
    return options;
  } catch (error) {
    console.error('Could not read Finny Status colours from Notion:', error);
    return statusOptionCache?.options ?? FALLBACK_STATUS_OPTIONS;
  }
}

async function findOrderPageIds(notion: Client, orderDatabaseId: string, orderNumber: string): Promise<string[]> {
  const response = await notion.databases.query({
    database_id: orderDatabaseId,
    filter: { property: 'Order No. :', rich_text: { equals: orderNumber } },
  });
  return response.results.map((page: any) => page.id);
}

// "StoreKeeper & Platform info :" is a MULTI-SELECT in Notion (confirmed against the database), not
// text: the "YASH, RAHUL, PLT-05" the app stores is one tag per comma-separated part.
const STORE_KEEPER_PROPERTY = 'StoreKeeper & Platform info :';

// Existing tags on that property, cached briefly so a burst of loads doesn't re-read the database
// schema for every push.
let storeKeeperTagCache: { names: string[]; at: number } | null = null;
const STORE_KEEPER_TAG_TTL_MS = 10 * 60 * 1000;

async function existingStoreKeeperTags(notion: Client, orderDatabaseId: string): Promise<string[]> {
  if (storeKeeperTagCache && Date.now() - storeKeeperTagCache.at < STORE_KEEPER_TAG_TTL_MS) return storeKeeperTagCache.names;
  const db: any = await notion.databases.retrieve({ database_id: orderDatabaseId });
  const names: string[] = (db?.properties?.[STORE_KEEPER_PROPERTY]?.multi_select?.options ?? []).map((o: any) => String(o.name));
  storeKeeperTagCache = { names, at: Date.now() };
  return names;
}

// Uses a tag Notion already has wherever one fits, so the app doesn't pile up near-duplicates:
//   - a name ("YASH") or any part matching an existing tag, ignoring case and stray spaces, uses
//     that tag's exact spelling (some existing tags carry a trailing space, e.g. "pt: 1 ");
//   - failing that, the same comparison again with ALL whitespace/hyphens/colons stripped first
//     (not just trimmed) — "PLT 8", "PLT-8" and "PLT8" are all the same platform, so this is what
//     stops a locally-typed "PLT 8" from creating a brand-new "PLT 8" tag next to an existing
//     "PLT8" or "PLT-8" one just because the spacing/punctuation didn't match byte-for-byte;
//   - the STV (always the last part) is also matched BY ITS NUMBER to the platform tags Notion
//     already uses: "PLT-05", "PLT 05" or "STV-05" -> the existing "pt: 5". Only a plain
//     code-and-number is matched; something like "STV-01&02" is left as it is.
// Anything with no existing match is sent as-is, and Notion creates that tag.
function resolveStoreKeeperTags(parts: string[], existing: string[]): string[] {
  const norm = (value: string) => value.trim().toUpperCase();
  // Collapses "PLT 8", "PLT-8", "PLT_8" and "PLT8" to the same key — whitespace, hyphens,
  // underscores and colons are all just formatting noise for a platform/STV code, never a
  // meaningful difference between two tags.
  const normCompact = (value: string) => norm(value).replace(/[\s\-_:]+/g, '');
  const byName = new Map(existing.map((name) => [norm(name), name]));
  const byCompactName = new Map(existing.map((name) => [normCompact(name), name]));
  const platformByNumber = new Map<number, string>();
  for (const name of existing) {
    const m = /^\s*pt\s*:\s*0*(\d+)\s*$/i.exec(name);
    if (m && !platformByNumber.has(Number(m[1]))) platformByNumber.set(Number(m[1]), name);
  }
  return parts.map((part, index) => {
    const exact = byName.get(norm(part)) ?? byCompactName.get(normCompact(part));
    if (exact) return exact;
    if (index === parts.length - 1) {
      const code = /^[A-Za-z]+[\s\-_]*0*(\d+)$/.exec(part.trim());
      const platform = code ? platformByNumber.get(Number(code[1])) : undefined;
      if (platform) return platform;
    }
    return part;
  });
}

// Replaces the StoreKeeper tags on every ORDER-database page for this order with the app's current
// value. Same best-effort rules as the status push below: never throws, a Notion failure never
// blocks the Loading action that triggered it.
export async function pushStoreKeeperInfoToNotion(orderNumber: string, storeKeeperInfo: string | null | undefined): Promise<void> {
  try {
    const ORDER_DATABASE_ID = process.env.ORDER_DATABASE_ID;
    if (!ORDER_DATABASE_ID) {
      console.warn('[Notion storekeeper sync] ORDER_DATABASE_ID not set — skipping push');
      return;
    }
    const notion = new Client({ auth: process.env.NOTION_INTEGRATION_SECRET });
    // Tag names can't contain commas (Notion rejects them) and are capped at 100 characters.
    const parts = String(storeKeeperInfo ?? '')
      .split(',')
      .map((part) => part.trim().slice(0, 100))
      .filter(Boolean);
    const tags = resolveStoreKeeperTags(parts, await existingStoreKeeperTags(notion, ORDER_DATABASE_ID.trim()))
      .map((name) => ({ name }));
    const pageIds = await findOrderPageIds(notion, ORDER_DATABASE_ID.trim(), orderNumber);
    if (pageIds.length === 0) {
      console.warn(`[Notion storekeeper sync] No Order DB page found for order ${orderNumber} — skipping push`);
      return;
    }
    await Promise.all(
      pageIds.map((pageId) =>
        notion.pages.update({
          page_id: pageId,
          properties: { [STORE_KEEPER_PROPERTY]: { multi_select: tags } } as any,
        }),
      ),
    );
    console.log(`[Notion storekeeper sync] Order ${orderNumber} -> "${tags.map((t) => t.name).join(', ')}" (${pageIds.length} page(s))`);
  } catch (error) {
    console.error(`[Notion storekeeper sync] Failed to push StoreKeeper Info for order ${orderNumber}:`, error instanceof Error ? error.message : error);
  }
}

// Sets "Finny Status :" to statusName on every ORDER-database page matching this order number
// (an order number can have more than one row there) — never throws; logs and returns silently
// on any failure (missing env vars, Notion API error, no matching page, etc).
export async function pushOrderStatusToNotion(orderNumber: string, statusName: string): Promise<void> {
  try {
    const ORDER_DATABASE_ID = process.env.ORDER_DATABASE_ID;
    if (!ORDER_DATABASE_ID) {
      console.warn('[Notion status sync] ORDER_DATABASE_ID not set — skipping status push');
      return;
    }
    const notion = new Client({ auth: process.env.NOTION_INTEGRATION_SECRET });
    const pageIds = await findOrderPageIds(notion, ORDER_DATABASE_ID.trim(), orderNumber);
    if (pageIds.length === 0) {
      console.warn(`[Notion status sync] No Order DB page found for order ${orderNumber} — skipping status push to "${statusName}"`);
      return;
    }
    await Promise.all(
      pageIds.map((pageId) =>
        notion.pages.update({
          page_id: pageId,
          properties: {
            'Finny Status :': { status: { name: statusName } },
          } as any,
        }),
      ),
    );
    console.log(`[Notion status sync] Order ${orderNumber} -> "${statusName}" (${pageIds.length} page(s))`);
  } catch (error) {
    console.error(`[Notion status sync] Failed to push status "${statusName}" for order ${orderNumber}:`, error instanceof Error ? error.message : error);
  }
}

// ───────────────────────────────────────────────────────────────────────────────────────────────
// Keeping Notion in step with the app — vehicle and status.
//
// The app always saves its own change first; this then updates Notion:
//   1. read the Notion order page and compare (nothing is written when it already matches),
//   2. write what differs, then read it back to confirm Notion kept it,
//   3. if that fails, try again — up to MAX_TRIES tries in total, RETRY_WAIT_MS apart.
// The waiting is a one-off timer for that single change (kept in memory — no table, no standing
// timer). A newer change for the same order replaces a waiting one, so it always sends the latest.
// If the server restarts mid-wait the remaining tries are lost; opening, completing or pressing
// "Sync to Notion" on the load re-checks it (reconcileOrderWithNotion below).
// ───────────────────────────────────────────────────────────────────────────────────────────────

export type NotionSyncOutcome = {
  state: 'ok' | 'retrying' | 'skipped' | 'failed';
  message: string;
};
type NotionWanted = { status?: string; vehiclePageId?: string };
type NotionWho = { userCode?: string | null; userName?: string | null };

const VEHICLE_RELATION_PROPERTY = 'Vehi  No. :'; // two spaces — that is how the Order database names it
// A status further along than Loading / Ready for Dispatch — never pushed back by the app.
const LATER_STAGES = new Set(['DISPATCHED', 'DELIVERED', 'UNLOADING', 'SHORTAGE', 'CANCELLED']);
const NOTION_MAX_TRIES = 5;
const NOTION_RETRY_WAIT_MS = 2 * 60 * 1000;
const NOTION_ATTEMPT_TIMEOUT_MS = 20 * 1000;
const normalizeName = (value: string) => value.trim().toUpperCase();
const compactId = (value: string) => String(value).replace(/-/g, '').toLowerCase();

type TryResult = { ok: boolean; permanent?: boolean; skipped?: boolean; reason?: string };

async function tryNotionOnce(orderNumber: string, want: NotionWanted): Promise<TryResult> {
  const orderDatabaseId = process.env.ORDER_DATABASE_ID?.trim();
  if (!orderDatabaseId || !process.env.NOTION_INTEGRATION_SECRET) {
    return { ok: false, permanent: true, reason: 'Notion is not configured' };
  }
  const notion = new Client({ auth: process.env.NOTION_INTEGRATION_SECRET });
  const pageIds = await findOrderPageIds(notion, orderDatabaseId, orderNumber);
  if (pageIds.length === 0) return { ok: false, permanent: true, reason: 'No Notion page found for this order' };

  let skippedReason: string | undefined;
  for (const pageId of pageIds) {
    const page: any = await notion.pages.retrieve({ page_id: pageId });
    const updates: Record<string, unknown> = {};

    if (want.status) {
      const current = String(page.properties?.['Finny Status :']?.status?.name ?? '');
      if (normalizeName(current) !== normalizeName(want.status)) {
        if (LATER_STAGES.has(normalizeName(current))) skippedReason = `Notion already shows ${current}`;
        else updates['Finny Status :'] = { status: { name: want.status } };
      }
    }
    if (want.vehiclePageId) {
      const currentIds: string[] = (page.properties?.[VEHICLE_RELATION_PROPERTY]?.relation ?? []).map((r: any) => compactId(r.id));
      if (!(currentIds.length === 1 && currentIds[0] === compactId(want.vehiclePageId))) {
        updates[VEHICLE_RELATION_PROPERTY] = { relation: [{ id: want.vehiclePageId }] };
      }
    }

    if (Object.keys(updates).length > 0) {
      await notion.pages.update({ page_id: pageId, properties: updates as any });
      // Read it back — Notion must really be showing it now.
      const after: any = await notion.pages.retrieve({ page_id: pageId });
      if (updates['Finny Status :'] && normalizeName(String(after.properties?.['Finny Status :']?.status?.name ?? '')) !== normalizeName(want.status!)) {
        return { ok: false, reason: 'Notion did not keep the status change' };
      }
      if (updates[VEHICLE_RELATION_PROPERTY]) {
        const ids: string[] = (after.properties?.[VEHICLE_RELATION_PROPERTY]?.relation ?? []).map((r: any) => compactId(r.id));
        if (!(ids.length === 1 && ids[0] === compactId(want.vehiclePageId!))) {
          return { ok: false, reason: 'Notion did not keep the vehicle change' };
        }
      }
    }
  }
  return { ok: true, skipped: !!skippedReason, reason: skippedReason };
}

async function logNotionSync(orderNumber: string, details: string, who?: NotionWho) {
  try {
    const { storage } = await import('../storage');
    await storage.logActivity({
      pageName: 'Loading', action: 'update', entityType: 'notion_sync', entityId: orderNumber, details,
      userCode: who?.userCode ?? undefined, userName: who?.userName ?? undefined,
    });
  } catch (error) {
    console.error('[Notion sync] Could not write the Activity log entry:', error instanceof Error ? error.message : error);
  }
}

type PendingNotionSync = { timer?: NodeJS.Timeout; want: NotionWanted; tries: number; who?: NotionWho };
const pendingNotionSyncs = new Map<string, PendingNotionSync>();

async function runNotionAttempt(orderNumber: string, entry: PendingNotionSync): Promise<NotionSyncOutcome> {
  entry.tries += 1;
  let result: TryResult;
  try {
    result = await Promise.race([
      tryNotionOnce(orderNumber, entry.want),
      new Promise<TryResult>((resolve) => setTimeout(() => resolve({ ok: false, reason: 'Notion did not answer in time' }), NOTION_ATTEMPT_TIMEOUT_MS)),
    ]);
  } catch (error) {
    result = { ok: false, reason: error instanceof Error ? error.message : String(error) };
  }
  const stillCurrent = pendingNotionSyncs.get(orderNumber) === entry;

  if (result.ok) {
    if (stillCurrent) pendingNotionSyncs.delete(orderNumber);
    return result.skipped
      ? { state: 'skipped', message: `${result.reason} — left as it is.` }
      : { state: 'ok', message: 'Notion is up to date.' };
  }

  if (result.permanent || entry.tries >= NOTION_MAX_TRIES) {
    if (stillCurrent) pendingNotionSyncs.delete(orderNumber);
    const message = result.permanent
      ? `Notion was not updated: ${result.reason}.`
      : `Notion was not updated after ${NOTION_MAX_TRIES} tries: ${result.reason}.`;
    console.error(`[Notion sync] Order ${orderNumber}: ${message}`);
    await logNotionSync(orderNumber, `Notion update failed for order ${orderNumber}. ${message}`, entry.who);
    return { state: 'failed', message };
  }

  console.warn(`[Notion sync] Order ${orderNumber}: try ${entry.tries}/${NOTION_MAX_TRIES} failed (${result.reason}) — trying again in 2 minutes`);
  if (entry.tries === 1) {
    await logNotionSync(orderNumber, `Notion update for order ${orderNumber} failed (${result.reason}); trying again every 2 minutes, up to ${NOTION_MAX_TRIES} tries.`, entry.who);
  }
  if (stillCurrent) {
    entry.timer = setTimeout(() => {
      if (pendingNotionSyncs.get(orderNumber) !== entry) return; // replaced by a newer change
      void runNotionAttempt(orderNumber, entry);
    }, NOTION_RETRY_WAIT_MS);
    entry.timer.unref?.();
  }
  return { state: 'retrying', message: `Saved here, but Notion was not updated (${result.reason}). Trying again in 2 minutes.` };
}

// Update Notion with what the app now has. Resolves after the FIRST try (so the screen can say how
// it went); any later tries carry on in the background. Never throws.
export async function syncOrderToNotion(orderNumber: string, want: NotionWanted, who?: NotionWho): Promise<NotionSyncOutcome> {
  try {
    const previous = pendingNotionSyncs.get(orderNumber);
    if (previous?.timer) clearTimeout(previous.timer);
    const entry: PendingNotionSync = { want: { ...(previous?.want ?? {}), ...want }, tries: 0, who };
    pendingNotionSyncs.set(orderNumber, entry);
    return await runNotionAttempt(orderNumber, entry);
  } catch (error) {
    return { state: 'failed', message: `Notion was not updated: ${error instanceof Error ? error.message : String(error)}` };
  }
}

// How long a request waits for the first try before answering "still trying in the background".
export async function settleNotionSync(outcome: Promise<NotionSyncOutcome>, ms = 8000): Promise<NotionSyncOutcome> {
  return Promise.race([
    outcome,
    new Promise<NotionSyncOutcome>((resolve) => setTimeout(
      () => resolve({ state: 'retrying', message: 'Notion is slow — still updating it in the background.' }), ms)),
  ]);
}

// Re-check ONE load against Notion and fix what differs. Only for loads the app is in charge of:
// the status when the load was started here and is Loading / Ready for Dispatch, and the vehicle
// when it was assigned here (and has a Notion page). Used when a load is opened (throttled, so the
// page's own refresh doesn't hammer Notion), when it's completed, and by the "Sync to Notion" button.
const lastReconcileAt = new Map<string, number>();
export async function reconcileOrderWithNotion(
  orderNumber: string, who?: NotionWho, opts?: { throttleMs?: number },
): Promise<NotionSyncOutcome | null> {
  try {
    if (opts?.throttleMs) {
      const last = lastReconcileAt.get(orderNumber) ?? 0;
      if (Date.now() - last < opts.throttleMs) return null;
    }
    const { rows } = await pool.query(
      `SELECT ps.notion_status AS status, ps.loading_stv AS stv, ps.loading_completed_at AS "completedAt",
              ps.vehicle_assigned_by_code AS assigned, v.notion_page_id AS "vehiclePage"
         FROM proforma_slips ps LEFT JOIN vehicle_info v ON v.id = ps.vehicle_info_id
        WHERE ps.order_number = $1`,
      [orderNumber],
    );
    const row = rows[0];
    if (!row) return null;
    const want: NotionWanted = {};
    if (row.stv) {
      // A load started here has a known real state: not completed = Loading, completed = Ready for
      // Dispatch. If this app's status was overwritten with something else (Notion's automation
      // after a vehicle change), put it back — unless it has genuinely moved on to a later stage.
      const expected = row.completedAt ? NOTION_LOADING_COMPLETE_STATUS : NOTION_LOADING_STATUS;
      const current = String(row.status ?? '').trim();
      if (normalizeName(current) !== normalizeName(expected) && !LATER_STAGES.has(normalizeName(current))) {
        await pool.query(`UPDATE proforma_slips SET notion_status = $1 WHERE order_number = $2`, [expected, orderNumber]);
      }
      if (!LATER_STAGES.has(normalizeName(current))) want.status = expected;
    }
    if (row.assigned && row.vehiclePage) want.vehiclePageId = row.vehiclePage;
    if (!want.status && !want.vehiclePageId) return null;
    lastReconcileAt.set(orderNumber, Date.now());
    return await syncOrderToNotion(orderNumber, want, who);
  } catch (error) {
    return { state: 'failed', message: `Could not check Notion: ${error instanceof Error ? error.message : String(error)}` };
  }
}

// ───────────────────────────────────────────────────────────────────────────────────────────────
// After a vehicle change: Notion's automation may change the order's status by itself (e.g. to
// "VEHI≈ASSGN"). Two minutes after the vehicle is assigned, the status of a load that was started
// here is put back — Loading, or Ready for Dispatch once completed — in the app and in Notion.
// While waiting, a status arriving from Notion's webhook does not overwrite the app's status
// (a later stage — Dispatched, Delivered ... — always still goes through). The wait is a one-off
// timer in memory; if the server restarts during it, opening/completing the load or "Sync to
// Notion" does the same thing (reconcileOrderWithNotion above).
// ───────────────────────────────────────────────────────────────────────────────────────────────
const STATUS_WATCH_WAIT_MS = 2 * 60 * 1000;
const statusWatches = new Map<string, { until: number; timer: NodeJS.Timeout }>();

export function isLaterStageStatus(status: string | null | undefined): boolean {
  return LATER_STAGES.has(normalizeName(String(status ?? '')));
}

// True while a watch is waiting for this order — the webhook skips non-later-stage status changes.
export function isNotionStatusGuarded(orderNumber: string): boolean {
  const watch = statusWatches.get(orderNumber);
  return !!watch && watch.until > Date.now();
}

export async function watchStatusAfterVehicleChange(orderNumber: string, who?: NotionWho): Promise<void> {
  try {
    const { rows } = await pool.query(`SELECT loading_stv AS stv FROM proforma_slips WHERE order_number = $1`, [orderNumber]);
    if (!rows[0]?.stv) return; // not a load started here — nothing of ours to keep Loading
    const previous = statusWatches.get(orderNumber);
    if (previous) clearTimeout(previous.timer);
    const timer = setTimeout(() => {
      // Put the status back (app + Notion) and only then lift the guard.
      void reconcileOrderWithNotion(orderNumber, who)
        .catch(() => null)
        .finally(() => { if (statusWatches.get(orderNumber)?.timer === timer) statusWatches.delete(orderNumber); });
    }, STATUS_WATCH_WAIT_MS);
    timer.unref?.();
    statusWatches.set(orderNumber, { until: Date.now() + STATUS_WATCH_WAIT_MS + 60 * 1000, timer });
  } catch (error) {
    console.error('[Notion sync] Could not start the status watch:', error instanceof Error ? error.message : error);
  }
}
