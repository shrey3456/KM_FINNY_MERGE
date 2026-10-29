import type { VehiclePlanningOrderEntry } from '@shared/schema';

// Vehicle Planning - the date rules, kept free of the database and Notion so they can be tested on their own.
//
// A trip is one order on one vehicle. Its days are counted from the ORDER DATE, and the order date counts as day 1:
//   planned last day = order date + trip days - 1        (order 17 Oct, 3 days -> 19 Oct; Notion's "Trip Completes On" is the same day)
// Three dates can say when the vehicle is really back, strongest first:
//   arrivedOn    - a person recorded the real arrival (the Arrived button)
//   expectedEnd  - a person stretched the bar to a new expected last day
//   planned      - from Notion's trip days
// The vehicle's last busy day is the strongest one that exists, and the vehicle is AVAILABLE ON THAT DAY ITSELF (a 4-day trip from day 1 frees it on day 4): it
// comes back that day, so an order starting then does not clash. Two exceptions hold the vehicle until the NEXT day: a ONE-day trip that has no arrival recorded
// (it goes out and comes back the same day, so that day is taken), and an arrival recorded with "can go out again the same day" UNTICKED.

export type TripState = 'planned' | 'on_trip' | 'awaiting' | 'arrived' | 'closed' | 'cancelled';

// One order inside a trip. A trip is usually one order; a SHARED load (two parties on one vehicle at the same time) is one trip with several members.
export type TripMember = {
  orderNumber: string; proformaSlipId: number | null; partyName: string | null; plant: string | null; status: string | null;
  driver: string | null; driverNotionId: string | null; notionNote: string | null; notInSystem: boolean;
  startDay: string; plannedLastDay: string; tripDays: number;
};

export type Trip = {
  orderNumber: string;           // for a shared load: the PRIMARY order (the one the others say "same trip as")
  members: TripMember[];         // every order in the trip (the primary first); one entry for an ordinary trip
  freeSameDay: boolean;          // arrived with "can go out again the same day": the vehicle is free from the arrival day itself
  freeFromDay: string;           // the first day this trip no longer keeps the vehicle busy
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
  expectedEndReason: string | null;   // why it was stretched (set with the expected end)
  arrivedOn: string | null;
  lastBusyDay: string;         // arrival, else expected end, else planned
  state: TripState;
  lockedReason?: string | null;  // set by the route: why Free is not allowed (Loading has taken the order over)
  assumed: boolean;            // closed quietly on its planned last day (older than ASSUMED_AFTER_DAYS with no arrival)
};

export type TripConflict = { orderNumber: string; startDay: string; withOrderNumber: string; withLastBusyDay: string };

export type VehicleTrips = {
  trips: Trip[];
  freeFrom: string | null;                       // the day after the vehicle's last busy day; null when it has no trips
  vehicleState: 'free' | 'busy' | 'awaiting';    // busy = a trip is running today; awaiting = a trip is due back (its last day has come) with no arrival recorded
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
  & { notInSystem?: boolean; arrivedOn?: string | null; expectedEnd?: string | null; driverNotionId?: string | null; notionNote?: string | null; freeSameDay?: boolean | null; sameTripAs?: string | null; expectedEndReason?: string | null };

export function plannedLastDayOf(e: Pick<Entry, 'orderDate' | 'tripDays' | 'tripCompletesOn'>): { start: string; last: string; days: number } | null {
  const start = String(e.orderDate ?? '').slice(0, 10);
  if (!isDay(start)) return null;
  const n = parseInt(String(e.tripDays ?? ''), 10);
  if (Number.isFinite(n) && n >= 1) return { start, last: addDays(start, n - 1), days: n };
  const fromNotion = parseDmy(e.tripCompletesOn);
  if (fromNotion && fromNotion >= start) return { start, last: fromNotion, days: daysBetween(start, fromNotion) + 1 };
  return { start, last: start, days: 1 };
}

// The order a "same trip as" chain leads to (followed a few steps; an entry whose target is not on this vehicle stands alone).
export function groupPrimaryOf(history: Pick<Entry, 'orderNumber' | 'sameTripAs'>[], orderNumber: string): string {
  const byNo = new Map(history.map((e) => [e.orderNumber, e] as const));
  let cur = orderNumber;
  for (let i = 0; i < 4; i++) {
    const next = byNo.get(cur)?.sameTripAs;
    if (!next || next === cur || !byNo.has(next)) break;
    cur = next;
  }
  return cur;
}
// Every history entry of the trip an order belongs to (the primary and the orders that say "same trip as" it).
export function groupEntries<T extends Pick<Entry, 'orderNumber' | 'sameTripAs'>>(history: T[], orderNumber: string): T[] {
  const primary = groupPrimaryOf(history, orderNumber);
  return history.filter((e) => groupPrimaryOf(history, e.orderNumber) === primary);
}

export function computeVehicleTrips(history: Entry[], today: string = todayIst()): VehicleTrips {
  // 1. Each entry with an order date, grouped into trips (a shared load is several entries under one primary).
  type Built = { e: Entry; p: NonNullable<ReturnType<typeof plannedLastDayOf>> };
  const built: Built[] = [];
  for (const e of history) { const p = plannedLastDayOf(e); if (p) built.push({ e, p }); }
  const builtEntries = built.map((b) => b.e);
  const groups = new Map<string, Built[]>();
  for (const b of built) {
    const key = groupPrimaryOf(builtEntries, b.e.orderNumber);
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key)!.push(b);
  }

  const trips: Trip[] = [];
  for (const [primaryNo, all] of groups) {
    const isCancelled = (b: Built) => String(b.e.status ?? '').trim().toUpperCase() === 'CANCELLED';
    const liveMembers = all.filter((b) => !isCancelled(b));
    const cancelled = liveMembers.length === 0;
    const used = cancelled ? all : liveMembers;
    const primary = all.find((b) => b.e.orderNumber === primaryNo) ?? used[0];
    const head = (used.find((b) => b.e.orderNumber === primaryNo) ?? used[0]).e;
    const startDay = used.reduce((m, b) => (b.p.start < m ? b.p.start : m), used[0].p.start);
    const plannedLastDay = used.reduce((m, b) => (b.p.last > m ? b.p.last : m), used[0].p.last);
    // What a person recorded is stored on every member of the trip; the primary's copy wins.
    const arrivedRaw = primary.e.arrivedOn ?? all.find((b) => b.e.arrivedOn)?.e.arrivedOn ?? null;
    const arrivedOn = isDay(arrivedRaw) ? arrivedRaw : null;
    const endRaw = primary.e.expectedEnd ?? all.find((b) => b.e.expectedEnd)?.e.expectedEnd ?? null;
    const expectedEnd = isDay(endRaw) && endRaw >= startDay ? endRaw : null;
    const expectedEndReason = expectedEnd ? (primary.e.expectedEndReason ?? all.find((b) => b.e.expectedEndReason)?.e.expectedEndReason ?? null) : null;
    const lastBusyDay = arrivedOn ?? expectedEnd ?? plannedLastDay;
    let state: TripState;
    let assumed = false;
    if (cancelled) state = 'cancelled';
    else if (arrivedOn) state = 'arrived';
    else if (startDay > today) state = 'planned';
    else if (lastBusyDay < today && daysBetween(lastBusyDay, today) > ASSUMED_AFTER_DAYS) { state = 'closed'; assumed = true; }
    // Yellow from the trip's last day: a multi-day trip is due back that day; a one-day trip keeps the vehicle busy the whole day, so it is due the next day.
    else if (startDay < lastBusyDay ? lastBusyDay <= today : lastBusyDay < today) state = 'awaiting';
    else state = 'on_trip';
    // Free on the last day, unless an arrival was recorded with the same-day box explicitly unticked.
    const heldTillNextDay = !!arrivedOn && (primary.e.freeSameDay ?? all.find((b) => b.e.freeSameDay != null)?.e.freeSameDay) === false;
    const freeSameDay = !heldTillNextDay;
    // A one-day trip (it starts and ends on the same day) keeps the vehicle busy that whole day, so it is free the next day - unless an arrival is recorded, which
    // then follows the same-day box.
    const oneDayTrip = !arrivedOn && startDay >= lastBusyDay;
    const members: TripMember[] = [...used]
      .sort((a, b) => Number(b.e.orderNumber === primaryNo) - Number(a.e.orderNumber === primaryNo) || a.p.start.localeCompare(b.p.start))
      .map((b) => ({
        orderNumber: b.e.orderNumber, proformaSlipId: b.e.proformaSlipId ?? null, partyName: b.e.partyName ?? null, plant: b.e.plant ?? null, status: b.e.status ?? null,
        driver: b.e.driver ?? null, driverNotionId: b.e.driverNotionId ?? null, notionNote: b.e.notionNote ?? null, notInSystem: !!b.e.notInSystem,
        startDay: b.p.start, plannedLastDay: b.p.last, tripDays: b.p.days,
      }));
    trips.push({
      orderNumber: head.orderNumber, members, freeSameDay, freeFromDay: addDays(lastBusyDay, heldTillNextDay || oneDayTrip ? 1 : 0),
      proformaSlipId: head.proformaSlipId ?? null, partyName: head.partyName ?? null, plant: head.plant ?? null,
      status: head.status ?? null, driver: head.driver ?? null, driverNotionId: head.driverNotionId ?? null,
      notionNote: members.find((m) => m.notionNote)?.notionNote ?? null,
      notInSystem: members.every((m) => m.notInSystem),
      tripDays: daysBetween(startDay, plannedLastDay) + 1, startDay, plannedLastDay, expectedEnd, expectedEndReason, arrivedOn, lastBusyDay, state, assumed,
    });
  }
  trips.sort((a, b) => a.startDay.localeCompare(b.startDay) || a.orderNumber.localeCompare(b.orderNumber));

  const live = trips.filter((t) => t.state !== 'cancelled');
  const freeFrom = live.length ? live.reduce((m, t) => (t.freeFromDay > m ? t.freeFromDay : m), live[0].freeFromDay) : null;
  const vehicleState: VehicleTrips['vehicleState'] = live.some((t) => t.state === 'on_trip') ? 'busy' : live.some((t) => t.state === 'awaiting') ? 'awaiting' : 'free';

  // A trip that starts before the previous trip frees the vehicle cannot happen: the vehicle is not back yet. (Arrived with "can go out again the same day"
  // frees the vehicle on the arrival day itself, so an order starting that day is fine.)
  const conflicts: TripConflict[] = [];
  for (let i = 1; i < live.length; i++) {
    const t = live[i];
    if (t.state === 'arrived' || t.state === 'closed') continue;
    for (let j = i - 1; j >= 0; j--) {
      const prev = live[j];
      if (t.startDay < prev.freeFromDay) { conflicts.push({ orderNumber: t.orderNumber, startDay: t.startDay, withOrderNumber: prev.orderNumber, withLastBusyDay: prev.lastBusyDay }); break; }
    }
  }
  return { trips, freeFrom, vehicleState, conflicts };
}

// The fields only a person sets on a trip. A Refresh from Notion rebuilds the trip from Notion's data; these must survive it.
const LOCAL_TRIP_FIELDS = ['arrivedOn', 'arrivedByCode', 'arrivedByName', 'arrivedAt', 'arrivalNote', 'freeSameDay', 'sameTripAs', 'expectedEnd', 'expectedEndByCode', 'expectedEndAt', 'expectedEndReason'] as const;
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
