import { pool } from '../db';
import { storage } from '../storage';
import { detectChangesFromNotion, applyPendingChanges } from './notionInventorySync';
import { syncDateAndApply } from './proformaNotionSync';

// Daily Notion sync - once a day, at the time an admin sets in Settings (India time), when switched on:
//   1. Product Master: read Notion and apply the changes (same functions as the 24-hour product sync).
//   2. Wait 5 minutes.
//   3. Proforma Slips for TOMORROW's order date only: read Notion and apply, new slips and changed ones (same read / compare / write as the
//      "Sync from Notion" button, but with a private list, so it never touches a review someone has open on that screen).
//
// Kept apart from the 5-hour Proforma scheduler (server/routes.ts), which is not changed. There is NO polling: when the switch is on, exactly one
// timer is set for the next occurrence of the set time and re-set after each run; when it is off there is no timer at all. The run date is saved
// (last_run_date) so a restart or a changed time can never run it twice on one day, and the current step is saved so a restart during the
// 5-minute wait still finishes step 3.

const IST_OFFSET_MIN = 330;
const WAIT_BETWEEN_STEPS_MS = 5 * 60 * 1000;
const GRACE_MS = 2 * 60 * 60 * 1000;      // a run the server missed (it was down at the set time) is still made up for this long
const RETRY_WAIT_MS = 60 * 1000;           // a manual sync was running: wait a minute and try again, up to RETRIES times
const RETRIES = 3;
const DEFAULT_TIME = '06:00';

export type DailySyncConfig = {
  enabled: boolean;
  runTime: string;
  lastRunDate: string | null;
  lastRunAt: string | null;
  lastRunStatus: string | null;
  lastRunSummary: string | null;
  phase: string | null;
  phaseDueAt: string | null;
};

export async function ensureDailyNotionSyncSchema(): Promise<void> {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS daily_notion_sync_config (
      id INTEGER PRIMARY KEY DEFAULT 1,
      enabled BOOLEAN NOT NULL DEFAULT false,
      run_time TEXT NOT NULL DEFAULT '${DEFAULT_TIME}',
      last_run_date DATE,
      last_run_at TIMESTAMP,
      last_run_status TEXT,
      last_run_summary TEXT,
      phase TEXT,
      phase_due_at TIMESTAMP,
      updated_by TEXT,
      updated_at TIMESTAMP DEFAULT NOW()
    )`);
  await pool.query(`INSERT INTO daily_notion_sync_config (id) VALUES (1) ON CONFLICT (id) DO NOTHING`);
}

export async function getDailySyncConfig(): Promise<DailySyncConfig> {
  const { rows } = await pool.query(
    `SELECT enabled, run_time AS "runTime", to_char(last_run_date, 'YYYY-MM-DD') AS "lastRunDate",
            last_run_at AS "lastRunAt", last_run_status AS "lastRunStatus", last_run_summary AS "lastRunSummary",
            phase, phase_due_at AS "phaseDueAt"
       FROM daily_notion_sync_config WHERE id = 1`,
  );
  const r = rows[0];
  return r
    ? { ...r, enabled: r.enabled === true }
    : { enabled: false, runTime: DEFAULT_TIME, lastRunDate: null, lastRunAt: null, lastRunStatus: null, lastRunSummary: null, phase: null, phaseDueAt: null };
}

// ── India time helpers (IST has no daylight saving, so a fixed +05:30 offset is exact) ────────────────
const istDay = (d: Date = new Date()): string => new Date(d.getTime() + IST_OFFSET_MIN * 60000).toISOString().slice(0, 10);
export function addDays(day: string, n: number): string {
  const d = new Date(`${day}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}
// The moment (UTC ms) the given India day + HH:MM happens.
function istMoment(day: string, runTime: string): number {
  const [hh, mm] = runTime.split(':').map(Number);
  const [y, m, d] = day.split('-').map(Number);
  return Date.UTC(y, m - 1, d, hh, mm) - IST_OFFSET_MIN * 60000;
}
// Milliseconds until the next occurrence of runTime (today if still ahead, else tomorrow).
export function msUntilNextRun(runTime: string, now: Date = new Date()): number {
  let at = istMoment(istDay(now), runTime);
  if (at <= now.getTime()) at = istMoment(addDays(istDay(now), 1), runTime);
  return at - now.getTime();
}
// True when today's run time has passed by no more than the grace window (a run the server missed).
export function isMissedWithinGrace(runTime: string, now: Date = new Date()): boolean {
  const at = istMoment(istDay(now), runTime);
  return now.getTime() > at && now.getTime() - at <= GRACE_MS;
}

// ── One run ─────────────────────────────────────────────────────────────────────────────────────────────
let timer: NodeJS.Timeout | null = null;       // the single "next run" timer
let waitTimer: NodeJS.Timeout | null = null;   // the 5-minute pause between the two steps
let running = false;

let waitResolve: (() => void) | null = null;
const sleep = (ms: number) => new Promise<void>((resolve) => {
  waitResolve = resolve;
  waitTimer = setTimeout(() => { waitTimer = null; waitResolve = null; resolve(); }, ms);
});

async function withRetry<T>(fn: () => Promise<T>): Promise<T> {
  for (let attempt = 1; ; attempt++) {
    try { return await fn(); }
    catch (err) {
      const busy = err instanceof Error && err.message.includes('already in progress');
      if (!busy || attempt >= RETRIES) throw err;
      await sleep(RETRY_WAIT_MS);
    }
  }
}

async function log(details: string): Promise<void> {
  try {
    await storage.logActivity({ pageName: 'Settings', action: 'update', entityType: 'notion_sync', entityId: 'daily-notion-sync', details, userName: 'System' });
  } catch (err) {
    console.error('[Daily Notion Sync] Could not write the Activity entry:', err instanceof Error ? err.message : err);
  }
}

async function save(patch: Record<string, unknown>): Promise<void> {
  const cols = Object.keys(patch);
  if (!cols.length) return;
  await pool.query(
    `UPDATE daily_notion_sync_config SET ${cols.map((c, i) => `${c} = $${i + 1}`).join(', ')}, updated_at = NOW() WHERE id = 1`,
    cols.map((c) => patch[c]),
  );
}

async function productStep(): Promise<string> {
  if (!process.env.NOTION_INVENTORY_DATABASE_ID) return 'products: skipped (Notion product database is not set)';
  const report = await withRetry(() => detectChangesFromNotion('system', false));
  const created = report.created ?? 0;
  const updated = report.updated ?? 0;
  if (created + updated > 0) await withRetry(() => applyPendingChanges());
  return `products: ${created} new, ${updated} changed${created + updated > 0 ? ' - applied' : ''}`;
}

async function proformaStep(tomorrow: string): Promise<string> {
  if (!process.env.NOTION_PAGE_URL || !process.env.ORDER_DATABASE_ID) return 'proforma slips: skipped (Notion order database is not set)';
  const r = await withRetry(() => syncDateAndApply(tomorrow));
  return `proforma slips for ${tomorrow}: ${r.totalOrders} order(s) in Notion, ${r.created} new, ${r.updated} updated, ${r.unchanged} unchanged${r.failed ? `, ${r.failed} failed` : ''}`;
}

// scheduled = the real daily run (marks today as done); otherwise it is the Run now button (leaves the schedule alone and skips the 5-minute pause).
async function runSync(opts: { scheduled: boolean; skipWait?: boolean; resumeProformaOnly?: boolean; by?: string }): Promise<void> {
  if (running) throw new Error('The daily Notion sync is already running');
  running = true;
  const today = istDay();
  const tomorrow = addDays(today, 1);
  const parts: string[] = [];
  let failed = false;
  try {
    if (opts.scheduled) await save({ last_run_date: today });
    await save({ last_run_at: new Date(), last_run_status: 'running', last_run_summary: null });

    if (!opts.resumeProformaOnly) {
      await save({ phase: 'products', phase_due_at: null });
      try { parts.push(await productStep()); }
      catch (err) { failed = true; parts.push(`products failed: ${err instanceof Error ? err.message : String(err)}`); }
      await log(`Daily Notion sync${opts.by ? ` (run by ${opts.by})` : ''} - ${parts[parts.length - 1]}`);
    }

    if (!opts.skipWait && !opts.resumeProformaOnly) {
      await save({ phase: 'waiting', phase_due_at: new Date(Date.now() + WAIT_BETWEEN_STEPS_MS) });
      await sleep(WAIT_BETWEEN_STEPS_MS);
    }
    if (!(await getDailySyncConfig()).enabled && opts.scheduled) {
      await save({ phase: null, phase_due_at: null, last_run_status: 'cancelled', last_run_summary: `${parts.join(' | ')} | switched off before the proforma step` });
      return;
    }

    await save({ phase: 'proforma', phase_due_at: null });
    try { parts.push(await proformaStep(tomorrow)); }
    catch (err) { failed = true; parts.push(`proforma slips failed: ${err instanceof Error ? err.message : String(err)}`); }
    await log(`Daily Notion sync${opts.by ? ` (run by ${opts.by})` : ''} - ${parts[parts.length - 1]}`);

    await save({ phase: null, phase_due_at: null, last_run_at: new Date(), last_run_status: failed ? 'failed' : 'ok', last_run_summary: parts.join(' | ') });
  } catch (err) {
    await save({ phase: null, phase_due_at: null, last_run_status: 'failed', last_run_summary: `${parts.join(' | ')} | ${err instanceof Error ? err.message : String(err)}` }).catch(() => {});
    console.error('[Daily Notion Sync] Run failed:', err);
  } finally {
    running = false;
  }
}

// ── The single timer ────────────────────────────────────────────────────────────────────────────────────
function clearTimers(): void {
  if (timer) { clearTimeout(timer); timer = null; }
  // A pause in progress is cut short (not abandoned), so the run sees the switch is off and stops cleanly.
  if (waitTimer) { clearTimeout(waitTimer); waitTimer = null; const r = waitResolve; waitResolve = null; if (r) r(); }
}

async function arm(): Promise<void> {
  if (timer) { clearTimeout(timer); timer = null; }
  const cfg = await getDailySyncConfig();
  if (!cfg.enabled) return;
  const delay = msUntilNextRun(cfg.runTime);
  timer = setTimeout(() => {
    timer = null;
    void (async () => {
      const c = await getDailySyncConfig();
      if (c.enabled && c.lastRunDate !== istDay()) await runSync({ scheduled: true }).catch((e) => console.error('[Daily Notion Sync]', e));
      await arm();
    })();
  }, delay);
  console.log(`[Daily Notion Sync] next run at ${new Date(Date.now() + delay).toLocaleString('en-IN', { timeZone: 'Asia/Kolkata' })} IST (${cfg.runTime})`);
}

// Boot: one catch-up check (the server was down at the set time, or restarted between the two steps), then the single timer. Nothing repeats.
export async function startDailyNotionSync(): Promise<void> {
  await ensureDailyNotionSyncSchema();
  const cfg = await getDailySyncConfig();
  if (cfg.enabled) {
    const today = istDay();
    if (cfg.phase && cfg.lastRunDate === today) {
      // A run was cut off by a restart. Finish it: only the proforma step when the products step was already done.
      void runSync({ scheduled: true, resumeProformaOnly: cfg.phase === 'waiting' || cfg.phase === 'proforma' }).catch((e) => console.error('[Daily Notion Sync]', e));
    } else if (cfg.lastRunDate !== today && isMissedWithinGrace(cfg.runTime)) {
      void runSync({ scheduled: true }).catch((e) => console.error('[Daily Notion Sync]', e));
    }
  } else if (cfg.phase) {
    await save({ phase: null, phase_due_at: null });
  }
  await arm();
  console.log(`[Daily Notion Sync] ${cfg.enabled ? 'on' : 'off'}`);
}

export async function saveDailySyncConfig(patch: { enabled?: boolean; runTime?: string }, by: string): Promise<DailySyncConfig> {
  const cols: Record<string, unknown> = { updated_by: by };
  if (typeof patch.enabled === 'boolean') cols.enabled = patch.enabled;
  if (typeof patch.runTime === 'string') cols.run_time = patch.runTime;
  await save(cols);
  if (patch.enabled === false) clearTimers();   // switched off: no timer at all (a pause in progress is cancelled)
  await arm();                                   // on, or a new time: one fresh timer
  return getDailySyncConfig();
}

export const isValidRunTime = (v: unknown): v is string => typeof v === 'string' && /^([01]\d|2[0-3]):[0-5]\d$/.test(v);

export function isDailySyncRunning(): boolean { return running; }

// The Run now button: both steps back to back (no 5-minute pause), schedule untouched, runs in the background.
export function runDailySyncNow(by: string): void {
  if (running) throw new Error('The daily Notion sync is already running');
  void runSync({ scheduled: false, skipWait: true, by }).catch((e) => console.error('[Daily Notion Sync]', e));
}
