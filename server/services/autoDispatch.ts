import { NOTION_LOADING_COMPLETE_STATUS } from './notionOrderStatusSync';

// Dispatched is not set by the app: like Delivered, Unloading and Shortage it is the order's status in Notion, copied onto the slip by the
// Notion webhook (live) and the admin "sync status from Notion". There is no timer. This file holds the status lists and the lock/reopen rules.

export const NOTION_DISPATCHED_STATUS = 'DISPATCHED';

// Statuses that come AFTER Ready for Dispatch. A load in one of these cannot be reopened, and it sits outside the Loading and
// Ready for Dispatch tabs (Dispatched has its own tab, the others share "Other").
export const DISPATCHED_STATUS_LIST = [NOTION_DISPATCHED_STATUS];
export const OTHER_LATER_STATUS_LIST = ['DELIVERED', 'UNLOADING', 'SHORTAGE', 'CANCELLED'];
export const LATER_STAGE_STATUS_LIST = [...DISPATCHED_STATUS_LIST, ...OTHER_LATER_STATUS_LIST];

export function isLaterStage(status: string | null | undefined): boolean {
  return LATER_STAGE_STATUS_LIST.includes(String(status ?? '').trim().toUpperCase());
}

// A load that had gone out (it has a dispatched time, or its status is a later stage) and that Notion now moves BACK to Ready for Dispatch or to
// Loading is being taken back on purpose: the dispatch lock goes (dispatched time cleared, Auto Dispatch off for this load), so an admin - or the
// owner / a Supervisor - can reopen it again and the 1-hour auto-dispatch does not send it out a second time behind their back. Any other status
// change (and the app's own normal Loading -> Ready for Dispatch step on a fresh load) leaves the load as it is.
export function dispatchUnlockPatch(
  current: { notionStatus?: string | null; dispatchedAt?: unknown } | null | undefined,
  newStatus: string | null | undefined,
): { dispatchedAt: null; autoDispatch: false } | null {
  const next = String(newStatus ?? '').trim().toUpperCase();
  if (next !== NOTION_LOADING_COMPLETE_STATUS && next !== 'LOADING') return null;
  if (!current || !(current.dispatchedAt || isLaterStage(current.notionStatus))) return null;
  return { dispatchedAt: null, autoDispatch: false };
}

// An admin can reopen a load that has already gone out (Dispatched, Delivered, Unloading, Shortage, Cancelled ...) from any of those statuses, but
// only while its slip is recent: the slip's order date must be within the last REOPEN_WINDOW_DAYS days (India time, today counts).
export const REOPEN_WINDOW_DAYS = 3;
export function isWithinReopenWindow(orderDate: unknown, now: Date = new Date()): boolean {
  const day = orderDate instanceof Date
    ? orderDate.toLocaleDateString('en-CA', { timeZone: 'Asia/Kolkata' })
    : String(orderDate ?? '').slice(0, 10);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(day)) return false;
  const today = now.toLocaleDateString('en-CA', { timeZone: 'Asia/Kolkata' });
  const cutoff = new Date(`${today}T00:00:00Z`);
  cutoff.setUTCDate(cutoff.getUTCDate() - REOPEN_WINDOW_DAYS);
  return day >= cutoff.toISOString().slice(0, 10);
}
