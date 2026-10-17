import type { VehiclePlanningOrderEntry } from '@shared/schema';

// Vehicle Planning - the date rules, kept free of the database and Notion so they can be tested on their own.
//
// A trip is one order on one vehicle. Its days are counted from the ORDER DATE, and the order date counts as day 1:
//   planned last day = order date + trip days - 1        (order 17 Oct, 3 days -> 19 Oct; Notion's "Trip Completes On" is the same day)
// Three dates can say when the vehicle is really back, strongest first:
//   arrivedOn    - a person recorded the real arrival (the Arrived button)
//   expectedEnd  - a person stretched the bar to a new expected last day
//   planned      - from Notion's trip days
// The vehicle's last busy day is the strongest one that exists, and it is FREE FROM THE NEXT DAY.

export type TripState = 'planned' | 'on_trip' | 'awaiting' | 'arrived' | 'closed' | 'cancelled';

export type Trip = {
  orderNumber: string;
  proformaSlipId: number | null;
  partyName: string | null;
  plant: string | null;
  status: string | null;
  driver: string | null;
  driverNotionId: string | null;
  notionNote: string | null;   // the last push to Notion did not go through (shown as "Notion not updated" with a Retry button)
  notInSystem: boolean;
  tripDays: number;
  startDay: string;            // the order date, YYYY-MM-DD
  plannedLastDay: string;
  expectedEnd: string | null;
  arrivedOn: string | null;
  lastBusyDay: string;         // arrival, else expected end, else planned
  state: TripState;
  assumed: boolean;            // closed quietly on its planned last day (older than ASSUMED_AFTER_DAYS with no arrival)
};

export type TripConflict = { orderNumber: string; startDay: string; withOrderNumber: string; withLastBusyDay: string };

export type VehicleTrips = {
  trips: Trip[];
  freeFrom: string | null;                       // the day after the vehicle's last busy day; null when it has no trips
  vehicleState: 'free' | 'busy' | 'awaiting';    // busy = a trip is running today; awaiting = a trip is past its end with no arrival recorded
  conflicts: TripConflict[];
};

// A trip whose last day passed more than this many days ago with no arrival is treated as arrived on its planned last day, so old trips do not
// fill the board with warnings.
export const ASSUMED_AFTER_DAYS = 7;

const DAY_RE = /^\d{4}-\d{2}-\d{2}$/;
const toUtc = (day: string) => { const [y, m, d] = day.split('-').map(Number); return Date.UTC(y, m - 1, d); };
export const isDay = (v: unknown): v is string => typeof v === 'string' && DAY_RE.test(v);
export function addDays(day: string, n: number): string { return new Date(toUtc(day) + n * 86400000).toISOString().slice(0, 10); }
export function daysBetween(a: string, b: string): number { return Math.round((toUtc(b) - toUtc(a)) / 86400000); }
export const todayIst = (now: Date = new Date()) => now.toLocaleDateString('en-CA', { timeZone: 'Asia/Kolkata' });

// Notion prints "Trip Completes On" as DD/MM/YYYY.
export function parseDmy(raw: string | null | undefined): string | null {
  const m = /^(\d{1,2})\/(\d{1,2})\/(\d{4})$/.exec(String(raw ?? '').trim());
  if (!m) return null;
  return `${m[3]}-${m[2].padStart(2, '0')}-${m[1].padStart(2, '0')}`;
}
export function toDmy(day: string): string { const [y, m, d] = day.split('-'); return `${d}/${m}/${y}`; }

type Entry = Pick<VehiclePlanningOrderEntry, 'orderNumber' | 'orderDate' | 'tripDays' | 'tripCompletesOn' | 'status' | 'partyName' | 'plant' | 'driver' | 'proformaSlipId'>
  & { notInSystem?: boolean; arrivedOn?: string | null; expectedEnd?: string | null; driverNotionId?: string | null; notionNote?: string | null };

export function plannedLastDayOf(e: Pick<Entry, 'orderDate' | 'tripDays' | 'tripCompletesOn'>): { start: string; last: string; days: number } | null {
  const start = String(e.orderDate ?? '').slice(0, 10);
  if (!isDay(start)) return null;
  const n = parseInt(String(e.tripDays ?? ''), 10);
  if (Number.isFinite(n) && n >= 1) return { start, last: addDays(start, n - 1), days: n };
  const fromNotion = parseDmy(e.tripCompletesOn);
  if (fromNotion && fromNotion >= start) return { start, last: fromNotion, days: daysBetween(start, fromNotion) + 1 };
  return { start, last: start, days: 1 };
}

export function computeVehicleTrips(history: Entry[], today: string = todayIst()): VehicleTrips {
  const trips: Trip[] = [];
  for (const e of history) {
    const p = plannedLastDayOf(e);
    if (!p) continue;
    const arrivedOn = isDay(e.arrivedOn) ? e.arrivedOn : null;
    const expectedEnd = isDay(e.expectedEnd) && e.expectedEnd >= p.start ? e.expectedEnd : null;
    const cancelled = String(e.status ?? '').trim().toUpperCase() === 'CANCELLED';
    let lastBusyDay = arrivedOn ?? expectedEnd ?? p.last;
    let state: TripState;
    let assumed = false;
    if (cancelled) state = 'cancelled';
    else if (arrivedOn) state = 'arrived';
    else if (p.start > today) state = 'planned';
    else if (lastBusyDay >= today) state = 'on_trip';
    else if (daysBetween(lastBusyDay, today) > ASSUMED_AFTER_DAYS) { state = 'closed'; assumed = true; }
    else state = 'awaiting';
    trips.push({
      orderNumber: e.orderNumber, proformaSlipId: e.proformaSlipId ?? null, partyName: e.partyName ?? null, plant: e.plant ?? null,
      status: e.status ?? null, driver: e.driver ?? null, driverNotionId: e.driverNotionId ?? null, notionNote: e.notionNote ?? null, notInSystem: !!e.notInSystem,
      tripDays: p.days, startDay: p.start, plannedLastDay: p.last, expectedEnd, arrivedOn, lastBusyDay, state, assumed,
    });
  }
  trips.sort((a, b) => a.startDay.localeCompare(b.startDay) || a.orderNumber.localeCompare(b.orderNumber));

  const live = trips.filter((t) => t.state !== 'cancelled');
  const freeFrom = live.length ? addDays(live.reduce((m, t) => (t.lastBusyDay > m ? t.lastBusyDay : m), live[0].lastBusyDay), 1) : null;
  const vehicleState: VehicleTrips['vehicleState'] = live.some((t) => t.state === 'on_trip') ? 'busy' : live.some((t) => t.state === 'awaiting') ? 'awaiting' : 'free';

  // A trip that starts on or before the previous trip's last busy day cannot happen: the vehicle is not back yet.
  const conflicts: TripConflict[] = [];
  for (let i = 1; i < live.length; i++) {
    const t = live[i];
    if (t.state === 'arrived' || t.state === 'closed') continue;
    for (let j = i - 1; j >= 0; j--) {
      const prev = live[j];
      if (t.startDay <= prev.lastBusyDay) { conflicts.push({ orderNumber: t.orderNumber, startDay: t.startDay, withOrderNumber: prev.orderNumber, withLastBusyDay: prev.lastBusyDay }); break; }
    }
  }
  return { trips, freeFrom, vehicleState, conflicts };
}

// The fields only a person sets on a trip. A Refresh from Notion rebuilds the trip from Notion's data; these must survive it.
const LOCAL_TRIP_FIELDS = ['arrivedOn', 'arrivedByCode', 'arrivedByName', 'arrivedAt', 'arrivalNote', 'expectedEnd', 'expectedEndByCode', 'expectedEndAt'] as const;
export function mergeLocalTripFields<T extends Record<string, any>>(previous: Record<string, any> | undefined, next: T): T {
  if (!previous) return next;
  for (const k of LOCAL_TRIP_FIELDS) if (previous[k] != null && next[k] == null) (next as any)[k] = previous[k];
  return next;
}

// ── Checks for the two things a person records ───────────────────────────────────────────────────────────────

export function checkArrival(entry: Entry, day: unknown, today: string = todayIst()): string | null {
  const p = plannedLastDayOf(entry);
  if (!p) return 'This trip has no order date.';
  if (!isDay(day)) return 'Pick the arrival date.';
  if (day < p.start) return `The vehicle cannot arrive before the order date (${p.start}).`;
  if (day > today) return 'The arrival date cannot be in the future.';
  return null;
}

export function checkExpectedEnd(entry: Entry, day: unknown): string | null {
  const p = plannedLastDayOf(entry);
  if (!p) return 'This trip has no order date.';
  if (entry.arrivedOn) return 'This trip is already marked arrived. Undo the arrival first.';
  if (!isDay(day)) return 'Pick the expected last day.';
  if (day < p.start) return `The last day cannot be before the order date (${p.start}).`;
  if (daysBetween(p.start, day) > 60) return 'A trip cannot be stretched past 60 days.';
  return null;
}
