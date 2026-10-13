import { pool } from '../db';
import { storage } from '../storage';
import { NOTION_LOADING_COMPLETE_STATUS, syncOrderToNotion } from './notionOrderStatusSync';

// Auto Dispatch — a load created after this went live becomes DISPATCHED by itself once it has been Ready for Dispatch for
// AUTO_DISPATCH_AFTER_MINUTES (default 60), counted from the moment it was marked complete. The slip is updated first (so the
// app is always right), then Notion is told through the usual push-and-retry path.
//
// Only slips flagged auto_dispatch (set at Create Operation) are touched: every load that existed before stays as it was.
// Slips made from the Sales Orders file are never touched (they are not written to Notion at all).
// The job reads the database every few minutes instead of holding a timer per slip, so a server restart never loses a dispatch,
// and running it twice does nothing the second time (the slip is no longer Ready for Dispatch).

export const NOTION_DISPATCHED_STATUS = 'DISPATCHED';

// Statuses that come AFTER Ready for Dispatch. A load in one of these cannot be reopened, and it sits outside the Loading and
// Ready for Dispatch tabs (Dispatched has its own tab, the others share "Other").
export const DISPATCHED_STATUS_LIST = [NOTION_DISPATCHED_STATUS];
export const OTHER_LATER_STATUS_LIST = ['DELIVERED', 'UNLOADING', 'SHORTAGE', 'CANCELLED'];
export const LATER_STAGE_STATUS_LIST = [...DISPATCHED_STATUS_LIST, ...OTHER_LATER_STATUS_LIST];

export function isLaterStage(status: string | null | undefined): boolean {
  return LATER_STAGE_STATUS_LIST.includes(String(status ?? '').trim().toUpperCase());
}

export function autoDispatchAfterMinutes(): number {
  const n = Number(process.env.AUTO_DISPATCH_AFTER_MINUTES);
  return Number.isFinite(n) && n > 0 ? n : 60;
}

let running = false;

export async function runAutoDispatch(): Promise<{ dispatched: number }> {
  if (running) return { dispatched: 0 };
  running = true;
  try {
    const minutes = autoDispatchAfterMinutes();
    // loading_completed_at holds UTC wall-clock digits (it is a plain timestamp written from a JS Date), so it is compared with
    // the UTC clock, not NOW() in the server's own time zone.
    const { rows } = await pool.query(
      `UPDATE proforma_slips
          SET notion_status = $1, dispatched_at = NOW() AT TIME ZONE 'UTC'
        WHERE auto_dispatch = true
          AND system_generated = false
          AND dispatched_at IS NULL
          AND loading_completed_at IS NOT NULL
          AND loading_completed_at <= (NOW() AT TIME ZONE 'UTC') - make_interval(mins => $2::int)
          AND UPPER(TRIM(COALESCE(notion_status, ''))) = $3
      RETURNING id, order_number AS "orderNumber"`,
      [NOTION_DISPATCHED_STATUS, Math.round(minutes), NOTION_LOADING_COMPLETE_STATUS],
    );
    for (const row of rows) {
      try {
        await storage.logActivity({
          pageName: 'Loading', action: 'update', entityType: 'proforma_slip', entityId: row.id,
          details: `Order ${row.orderNumber} dispatched automatically ${minutes} minute(s) after loading was completed`,
          userName: 'System',
        });
      } catch (err) {
        console.error('[Auto Dispatch] Could not write the activity for', row.orderNumber, err instanceof Error ? err.message : err);
      }
      // Best effort and retried inside syncOrderToNotion; the app already shows Dispatched whatever Notion says.
      void syncOrderToNotion(row.orderNumber, { status: NOTION_DISPATCHED_STATUS }, { userCode: null, userName: 'System' })
        .catch((err) => console.error('[Auto Dispatch] Notion update failed for', row.orderNumber, err instanceof Error ? err.message : err));
    }
    if (rows.length > 0) console.log(`[Auto Dispatch] Dispatched ${rows.length} load(s) (completed more than ${minutes} minute(s) ago)`);
    return { dispatched: rows.length };
  } finally {
    running = false;
  }
}

const CHECK_EVERY_MS = 5 * 60 * 1000;

export function startAutoDispatchScheduler(): void {
  const tick = () => { runAutoDispatch().catch((err) => console.error('[Auto Dispatch] Run failed:', err instanceof Error ? err.message : err)); };
  setInterval(tick, CHECK_EVERY_MS);
  setTimeout(tick, 30 * 1000);
  console.log(`[Auto Dispatch] scheduler registered — loads are dispatched ${autoDispatchAfterMinutes()} minute(s) after completion (checks every 5 minutes)`);
}
