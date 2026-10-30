import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { useMutation, useQuery } from "@tanstack/react-query";
import { addDays, differenceInCalendarDays, format, isSameDay, parse, startOfDay } from "date-fns";
import {
  AlertTriangle, CalendarClock, CalendarDays, CheckCircle2, ChevronDown, ChevronLeft, ChevronRight, ChevronsLeft,
  ChevronsRight, ChevronUp, DatabaseZap, History, Loader2, MessageSquare, RefreshCw, RotateCcw, Search, SlidersHorizontal, Truck, Undo2, X,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle,
} from "@/components/ui/dialog";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { Checkbox } from "@/components/ui/checkbox";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { useToast } from "@/hooks/use-toast";
import { apiRequest, queryClient } from "@/lib/queryClient";
import { hasPageWriteAccess, isAdminOrSuperAdmin } from "@/lib/permissions";
import { parseApiErrorBody, parseApiErrorMessage } from "@/lib/apiError";
import { ToastAction } from "@/components/ui/toast";
import { usePersistentFilter } from "@/hooks/usePersistentFilter";
import { SectionSkeleton } from "@/components/ui/loading-skeletons";
import { SyncProgressDialog } from "@/components/SyncProgressDialog";
import { withNotionNotice } from "@/lib/notionSyncNotice";
import { AddColumnFilterButton, ColumnFilterChipView, ColumnHeaderFilterButton } from "@/components/filters/ColumnFilterChip";
import { type FilterableColumn, type FilterCondition, isConditionEmpty, matchAllConditions } from "@/lib/columnFilters";
import { ExtendReasonDialog, ResetBanner, ResetPlanningDialog, type LastReset } from "@/components/VehiclePlanningReset";

// Vehicle Planning: a Gantt-style fleet timeline (rows = Krupa's vehicles, columns = days) plus
// the assign-a-vehicle-to-an-order workflow. Each vehicle's bar spans its current order's start
// date to the calculated "free" date (Notion's own "Trip Complets on" formula, read server-side
// — see server/routes/vehicle-planning.ts); a vehicle with no bar in view, or past the end of
// its bar, is free and gets an Assign button.
//
// Assign accepts any order from our system: the picker lists the orders of a chosen order date.

type CurrentOrder = {
  orderNumber: string; partyName: string | null; plant: string | null;
  orderDate: string | null; notionStatus: string | null; tripCompletesOn: string | null;
  vehicleMismatch: boolean; mismatchProformaVehicleNumber: string | null;
  // Notion has this vehicle on this order but our system has no slip for it (Vehicle Planning never creates one by itself).
  notInSystem?: boolean;
} | null;

// One trip (an order on this vehicle) as the server works it out - server/lib/vehicleTrips.ts.
type TripState = "planned" | "on_trip" | "awaiting" | "arrived" | "closed" | "cancelled";
// One order inside a trip (a shared load is one trip with several of these).
type TripMember = {
  orderNumber: string; proformaSlipId: number | null; partyName: string | null; plant: string | null; status: string | null;
  driver: string | null; driverNotionId: string | null; notionNote: string | null; notInSystem: boolean; startDay: string; plannedLastDay: string; tripDays: number;
};
// The vehicle is not free for an order: the server says who overlaps (a shared load is possible) and which older trip could simply be marked arrived.
type NotFreeAsk = {
  message: string; orderNumber: string; destId: number;
  overlapping: { orderNumber: string; partyName: string | null }[];
  blocking: { orderNumber: string; partyName: string | null; suggestedArrival: string; canMarkArrived: boolean } | null;
};
type Trip = {
  orderNumber: string; members: TripMember[]; freeSameDay: boolean; freeFromDay: string; proformaSlipId: number | null; partyName: string | null; plant: string | null;
  status: string | null; driver: string | null; driverNotionId: string | null; notionNote: string | null; notInSystem: boolean; tripDays: number;
  startDay: string; plannedLastDay: string; expectedEnd: string | null; expectedEndReason?: string | null; arrivedOn: string | null;
  lastBusyDay: string; state: TripState; assumed: boolean;
  lockedReason?: string | null;   // why Free is not allowed (Loading has taken the order over)
};
// The vehicle's own status on this page (maintenance, breakdown ...): our system only. days >= 1 keeps it out of Available for that many days.
type ManualStatus = {
  status: string; startDay: string; days: number; endDay: string | null; blocks: boolean; comment: string | null; byName: string | null;
  daysLeft: number | null; availableFrom: string | null;
};
// One order a vehicle can be freed from (the Free box lists them; a locked one is greyed out with its reason).
type FreeOption = { orderNumber: string; partyName: string | null; startDay: string; lastBusyDay: string; notInSystem: boolean; locked: string | null };
type TripConflict = { orderNumber: string; startDay: string; withOrderNumber: string; withLastBusyDay: string };

type ReviewItem = {
  vehicleId: number; vehicleNumber: string | null; orderNumber: string; orderDate: string | null;
  partyName: string | null; plant: string | null; status: string | null; inSystem: boolean;
};

type VehicleRow = {
  id: number; vehicleNumber: string | null; rtoNumber: string | null; driver: string | null;
  state: string | null; company: string | null;
  currentOrder: CurrentOrder; busy: boolean; busyUntil: string | null; tripDays: string | null;
  hasHistory: boolean; lastSyncedAt: string | null;
  // The vehicle's company was added beyond the two defaults (for example DUMMY): listed even with no trips.
  showAlways?: boolean;
  dayNotes?: { day: string; text: string; byName: string | null; at: string }[];
  volume?: number | null; bodyType?: string | null; manualStatus?: ManualStatus | null;
  trips?: Trip[]; freeFrom?: string | null; vehicleState?: "free" | "busy" | "awaiting"; conflicts?: TripConflict[];
};

type AvailableOrder = {
  orderNumber: string; partyName: string | null; plant: string | null;
  orderDate: string | null; vehicleNumber: string | null; notionStatus: string | null;
  driverName?: string | null; beforeFree?: boolean;
};
type Suggestion = AvailableOrder & { tripDaysGuess: number; samePlant: boolean; fits: boolean; runsInto: string | null };
type AvailableOrdersResponse = {
  orders: AvailableOrder[]; date: string; suggestions: Suggestion[];
  // Free orders dated while this vehicle is busy, each with the trip it would join (a shared load).
  sharable?: (AvailableOrder & { joinOrder: string; joinParty: string | null })[];
  vehicle: { freeFrom: string | null; busyUntil: string | null; busyOrder: string | null; lastDriver: string | null; lastPlant: string | null } | null;
};
type NotionDriver = { id: string; name: string };

// One past order from a vehicle's local history (server/routes/vehicle-planning.ts's
// VehiclePlanningOrderEntry) — shown in the History dialog on a row click.
type HistoryEntry = {
  orderNumber: string; orderDate: string | null; status: string | null; driver: string | null;
  tripCompletesOn: string | null; tripDays: string | null; partyName: string | null; plant: string | null;
  actualCompletedAt: string | null;
};

// Fixed label columns before the timeline — narrower/denser than a first pass at this (was one
// wide "Vehicle" block with everything stacked in two lines) specifically so the timeline itself
// keeps most of the width instead of the labels eating into it. Party Name is NOT here — it's
// shown as a label on the busy bar itself now, not its own column (explicit request).
const LABEL_COLS: { key: string; label: string; width: number }[] = [
  { key: "vehicleNumber", label: "Vehicle", width: 78 },
  { key: "rtoNumber", label: "RTO No.", width: 96 },
  { key: "orderNumber", label: "Order No.", width: 100 },
  { key: "state", label: "Plant / State", width: 114 },
  { key: "driver", label: "Driver", width: 100 },
  { key: "tripDays", label: "Trip Days", width: 88 },
  { key: "status", label: "Status", width: 124 },
];
// Which filterable column each header's filter button belongs to (the same column filters the other pages have).
const HEADER_FILTER_IDS: Record<string, string> = {
  vehicleNumber: "vehicleNumber", rtoNumber: "rto", orderNumber: "order", state: "plantState", driver: "driver", tripDays: "tripDays", status: "status",
};
const ROW_MIN_HEIGHT = 64;   // label line, the dots, then the Assign / Extend buttons
// px per day for the three column sizes. The board scrolls sideways when the days do not fit, so a wider column never squeezes the labels.
const DAY_COL_MIN = 40, DAY_COL_MAX = 180, DAY_COL_DEFAULT = 90;
const ACTION_COL_WIDTH = 92; // the Free / Arrived buttons at the end of the pinned label columns
// Mouse-wheel / arrow-key nudge amount — fixed, no user-facing control for it. The full-window
// and single-day buttons stay as a discoverable fallback for anyone who'd rather click than
// scroll/use the keyboard.
const SCROLL_STEP_DAYS = 1;
// Sideways swipe / wheel over the board: pixels of travel for each day the dates move, and the most days one wheel event may move.
const WHEEL_PX_PER_DAY = 140;
const WHEEL_MAX_DAYS_PER_EVENT = 2;

// Notion's "Trip Complets on" formula prints as "DD/MM/YYYY" (confirmed live against the
// database) — not ISO, so it needs its own parse rather than `new Date(...)`.
function parseTripDate(raw: string | null): Date | null {
  if (!raw) return null;
  try {
    const d = parse(raw, "dd/MM/yyyy", new Date());
    return Number.isNaN(d.getTime()) ? null : startOfDay(d);
  } catch {
    return null;
  }
}

// Is the vehicle free on `day`? Not when a trip covers that day: it starts on or before it and does not free the vehicle until after it (a trip frees the vehicle on
// its last day). A vehicle planned to be back, or arrived, by that day counts as available.
function isAvailableOn(v: VehicleRow, day: string): boolean {
  const m = v.manualStatus;
  if (m?.blocks && m.endDay && m.startDay <= day && day <= m.endDay) return false;   // under maintenance / breakdown that day
  const live = (v.trips ?? []).filter((t) => t.state !== "cancelled");
  return !live.some((t) => t.startDay <= day && day < t.freeFromDay);
}

const MANUAL_STATUSES = ["Gone for passing", "Parking maintenance", "Road maintenance", "Showroom maintenance", "Breakdown"] as const;
const STATUS_TONES: Record<string, string> = {
  "Gone for passing": "bg-indigo-100 text-indigo-800", "Parcing": "bg-indigo-100 text-indigo-800", "Parking": "bg-slate-100 text-slate-700", "Parking maintenance": "bg-orange-100 text-orange-800", "Road maintenance": "bg-orange-100 text-orange-800",
  "Showroom maintenance": "bg-purple-100 text-purple-800", "Breakdown": "bg-red-100 text-red-700",
};
const isoDayDiff = (a: string, b: string) => Math.round((Date.parse(`${b}T00:00:00Z`) - Date.parse(`${a}T00:00:00Z`)) / 86400000);

// The day a member's dots stop: the slips that end with the trip follow its arrival / extension; a shorter slip of a shared load keeps its own last day.
function memberEnd(t: Trip, m: TripMember): string {
  if (m.plannedLastDay === t.plannedLastDay) return t.lastBusyDay;
  return m.plannedLastDay < t.lastBusyDay ? m.plannedLastDay : t.lastBusyDay;
}

function dotClass(state: TripState, conflict: boolean): string {
  if (conflict) return "bg-red-500";
  switch (state) {
    case "planned": return "border-2 border-dashed border-blue-600 bg-blue-100";   // new: not started yet
    case "awaiting": return "bg-amber-400";                                          // overdue: past its last day, no arrival
    case "arrived": return "bg-slate-400";                                           // past
    case "closed": return "bg-slate-300";                                            // past
    default: return "bg-emerald-600";                                                // current: on the trip now
  }
}

const fmtShort = (iso: string) => format(parse(iso, "yyyy-MM-dd", new Date()), "d MMM");
// What the Status and Days columns say about a vehicle today. A status set on this page wins; otherwise it follows the trips.
// The Days column is only filled for a status with days (days left) and for Overdue (days late) - everything else leaves it blank.
function computeStatus(v: VehicleRow, todayIso: string): { label: string; tone: string; daysText: string; title: string; note: string } {
  const m = v.manualStatus;
  if (m && (m.blocks || m.days === 0)) {
    return {
      label: m.status, tone: STATUS_TONES[m.status] ?? "bg-gray-100 text-gray-700", daysText: m.blocks ? `${m.daysLeft} d left` : "",
      title: `${m.status}${m.blocks && m.availableFrom ? ` - available again from ${fmtShort(m.availableFrom)}` : ""}${m.comment ? ` - ${m.comment}` : ""}`,
      note: [m.blocks && m.availableFrom ? `Available again from ${fmtShort(m.availableFrom)}` : "", m.comment ?? ""].filter(Boolean).join(" · "),
    };
  }
  const trips = (v.trips ?? []).filter((x) => x.state !== "cancelled");
  const covering = trips.find((x) => x.startDay <= todayIso && todayIso < x.freeFromDay);
  if (covering) return { label: "On trip", tone: "bg-emerald-100 text-emerald-800", daysText: "", title: `Free from ${fmtShort(covering.freeFromDay)}`, note: `Free from ${fmtShort(covering.freeFromDay)}` };
  const late = trips.find((x) => x.state === "awaiting");
  if (late) {
    const n = Math.max(1, isoDayDiff(late.lastBusyDay, todayIso));
    return { label: "Overdue", tone: "bg-amber-100 text-amber-800", daysText: `${n} d late`, title: `${n} day${n === 1 ? "" : "s"} past its last day with no arrival recorded - the vehicle is available`, note: `${n} day${n === 1 ? "" : "s"} past its last day, no arrival recorded - available` };
  }
  if (trips.some((x) => x.arrivedOn === todayIso)) return { label: "Free now", tone: "bg-emerald-600 text-white", daysText: "", title: "Arrived today - available now", note: "Arrived today - available now" };
  if (trips.some((x) => !x.arrivedOn && x.startDay < x.lastBusyDay && x.lastBusyDay === todayIso)) return { label: "Available", tone: "border border-emerald-400 bg-white text-emerald-700", daysText: "", title: "Today is the last day of the trip - the vehicle is available", note: "Last day of the trip - available" };
  if (trips.some((x) => x.startDay > todayIso)) return { label: "Planned", tone: "bg-blue-100 text-blue-800", daysText: "", title: "Free now; an order is planned", note: "Free now; an order is planned" };
  return { label: "Free", tone: "bg-emerald-50 text-emerald-700", daysText: "", title: "Free - available now", note: "Available now" };
}

// The day the vehicle can take its next order (its trips' last day, or the day after a maintenance / breakdown), and the trip an Extend would lengthen.
function computeAvailability(v: VehicleRow, todayIso: string): { day: string; extendTrip: Trip | null; blocked: ManualStatus | null } {
  let day = v.freeFrom && v.freeFrom > todayIso ? v.freeFrom : todayIso;
  const blocked = v.manualStatus?.blocks ? v.manualStatus : null;
  if (blocked?.availableFrom && blocked.availableFrom > day) day = blocked.availableFrom;
  // A trip that finished by itself (nobody marked an arrival) can still be extended for a week: the vehicle is late and still out.
  const justEnded = (x: Trip) => x.state === "closed" && x.assumed && isoDayDiff(x.lastBusyDay, todayIso) <= 7;
  const extendable = (v.trips ?? []).filter((x) => !x.arrivedOn && (((x.state === "on_trip" || x.state === "planned") && x.freeFromDay === day) || x.state === "awaiting" || justEnded(x)));
  const extendTrip = extendable.sort((a, b) => b.lastBusyDay.localeCompare(a.lastBusyDay))[0] ?? null;
  return { day, extendTrip, blocked };
}

// A layout preference kept in this browser (it survives a reload and a new session), unlike the filters, which only live while the browser stays open.
function useLocalPref<T>(key: string, initial: T): [T, (v: T | ((p: T) => T)) => void] {
  const [value, setValue] = useState<T>(() => { try { const raw = localStorage.getItem(key); return raw === null ? initial : (JSON.parse(raw) as T); } catch { return initial; } });
  const set = (v: T | ((p: T) => T)) => setValue((prev) => {
    const next = typeof v === "function" ? (v as (p: T) => T)(prev) : v;
    try { localStorage.setItem(key, JSON.stringify(next)); } catch { /* storage unavailable */ }
    return next;
  });
  return [value, set];
}

export default function VehiclePlanning() {
  const { toast } = useToast();
  const canWrite = hasPageWriteAccess("vehicle-planning");
  const [assignTarget, setAssignTarget] = useState<VehicleRow | null>(null);
  // Empty = the day the vehicle is free (the server decides); the planner can pick another day.
  const [assignDate, setAssignDate] = useState("");
  const [assignSearch, setAssignSearch] = useState("");
  const [assignPick, setAssignPick] = useState<AvailableOrder | null>(null);
  // null = untouched, so the box shows the vehicle's last driver; driverExtra remembers a driver read from Notion that is not in the list.
  const [driverText, setDriverText] = useState<string | null>(null);
  const [driverExtra, setDriverExtra] = useState<NotionDriver | null>(null);
  const [assignAsk, setAssignAsk] = useState<NotFreeAsk | null>(null);
  const [earlyAsk, setEarlyAsk] = useState<{ vehicle: VehicleRow; freeFrom: string; waiting: number } | null>(null);
  const isAdmin = (() => { try { return isAdminOrSuperAdmin(JSON.parse(localStorage.getItem("currentUser") || "{}").role ?? ""); } catch { return false; } })();
  const [mismatchTarget, setMismatchTarget] = useState<VehicleRow | null>(null);
  // Review: the orders Notion has on a vehicle that our system does not have; the planner ticks the ones to create.
  const [reviewOpen, setReviewOpen] = useState(false);
  const [reviewTicked, setReviewTicked] = useState<string[]>([]);
  const [reviewRun, setReviewRun] = useState<{ total: number; done: number; created: number; failed: { orderNumber: string; message: string }[]; finished: boolean } | null>(null);
  const [historyTarget, setHistoryTarget] = useState<VehicleRow | null>(null);
  // A trip dot that was clicked (its details + Arrived / Undo), and an extension that would run into the next trip.
  const [tripTarget, setTripTarget] = useState<{ vehicle: VehicleRow; trip: Trip } | null>(null);
  // The Status box of one vehicle (availability actions + a status set here: parking, maintenance, breakdown ...).
  const [statusTarget, setStatusTarget] = useState<VehicleRow | null>(null);
  const [stPick, setStPick] = useState("");
  const [stDays, setStDays] = useState("");
  const [stFrom, setStFrom] = useState("");   // the day the vehicle is available again (today + days)
  const [stComment, setStComment] = useState("");
  // The card that opens when a dot is clicked: the order and party of that assignment (and a Details button for the full box).
  const [dotCard, setDotCard] = useState<{ vehicle: VehicleRow; trip: Trip; member: TripMember; x: number; y: number } | null>(null);
  const assignStartRef = useRef<string | null>(null);   // the day the Assign box should open on (the day the vehicle is available)
  const [stretchAsk, setStretchAsk] = useState<{ vehicle: VehicleRow; trip: Trip; newEnd: string; clashes: Trip[]; reason?: string } | null>(null);
  // Moving a trip's last day LATER first asks why (ExtendReasonDialog); the clash question, when there is one, follows. And the admin's Reset planning dialog.
  const [extendAsk, setExtendAsk] = useState<{ vehicle: VehicleRow; trip: Trip; newEnd: string; clashes: Trip[] } | null>(null);
  const [resetOpen, setResetOpen] = useState(false);
  // Change plan on one trip: move it to another vehicle, change its driver, or take the vehicle off.
  const [changeTarget, setChangeTarget] = useState<{ vehicle: VehicleRow; trip: Trip } | null>(null);
  const [moveSearch, setMoveSearch] = useState("");
  const [moveDest, setMoveDest] = useState<VehicleRow | null>(null);
  const [moveAsk, setMoveAsk] = useState<NotFreeAsk | null>(null);
  // Which order of a shared trip the Change dialog works on: "" = the whole trip.
  const [changeOrder, setChangeOrder] = useState("");
  const [changeDriverText, setChangeDriverText] = useState<string | null>(null);
  const [changeDriverExtra, setChangeDriverExtra] = useState<NotionDriver | null>(null);
  const [removeSure, setRemoveSure] = useState(false);
  const [tripFilter, setTripFilter] = useState<"all" | "awaiting" | "conflicts">("all");
  // "Available" filter: only the vehicles that are free on a chosen day (planned to be back or arrived by then). "" = off.
  const [availableOn, setAvailableOn] = usePersistentFilter<string>("vehiclePlanning:availableOn", "");
  const [availableOpen, setAvailableOpen] = useState(false);
  const [filterOpen, setFilterOpen] = useState(false);
  const [refreshOpen, setRefreshOpen] = useState(false);
  const [refreshFrom, setRefreshFrom] = useState("");   // the day Refresh from Notion reads orders from (empty = each vehicle's latest order)
  // The blue "orders are in Notion but not in our system" line: closed with its X until the number changes.
  const [missingHidden, setMissingHidden] = usePersistentFilter<number>("vehiclePlanning:missingHidden", -1);
  // Which vehicles to list: only those with orders (default), all of them, or only those with no orders (the ones free to assign).
  const [orderView, setOrderView] = usePersistentFilter<"with" | "all" | "none">("vehiclePlanning:orderView", "with");
  const [search, setSearch] = useState("");
  // Excel-style column filters, the same as the other pages (Scan History, Stock Overview ...): a filter button on every column header and a "+ Filter" button.
  // Client-side; kept while the browser stays open.
  const [columnConditions, setColumnConditions] = usePersistentFilter<Record<string, FilterCondition>>("vehiclePlanning:columnFilters", {});
  const setColumnCondition = (columnId: string, condition: FilterCondition) => setColumnConditions((prev) => ({ ...prev, [columnId]: condition }));
  const clearColumnCondition = (columnId: string) => setColumnConditions((prev) => { const next = { ...prev }; delete next[columnId]; return next; });
  // Sort — click Vehicle or Order No. to toggle; switching to a column that wasn't already
  // sorted always starts ascending (never inherits whatever direction the other column was on),
  // clicking the same column again flips asc<->desc. null = whatever order the server returned.
  const [sortBy, setSortBy] = usePersistentFilter<"vehicleNumber" | "orderNumber" | null>("vehiclePlanning:sortBy", null);
  const [sortOrder, setSortOrder] = usePersistentFilter<"asc" | "desc">("vehiclePlanning:sortOrder", "asc");
  function toggleVpSort(column: "vehicleNumber" | "orderNumber") {
    if (sortBy === column) setSortOrder((p) => (p === "asc" ? "desc" : "asc"));
    else { setSortBy(column); setSortOrder("asc"); }
  }
  // Widened from the old 14|30 literal — picking a custom date range (below) sets this to
  // whatever span the user actually chose, not just one of the two presets. Both persisted
  // (sessionStorage, same pattern as every other filter on this page) so leaving the page and
  // coming back restores exactly the range you were last looking at, instead of resetting to
  // today every time.
  const [windowDays, setWindowDays] = usePersistentFilter<number>("vehiclePlanning:windowDays", 14);
  // How wide one day is: Compact (as before), Normal (default) or Large. Remembered for the session.
  const [dayColW, setDayColW] = useLocalPref<number>("vehiclePlanning:dayColW", DAY_COL_DEFAULT);
  // Column widths: hidden by default. The "Columns" button shows a drag handle on every heading (and one on the days); "Done" hides them again. Kept in this browser.
  const [colWidths, setColWidths] = useLocalPref<Record<string, number>>("vehiclePlanning:colWidths", {});
  const [adjustMode, setAdjustMode] = useState(false);
  const widthOf = (key: string): number => colWidths[key] ?? (key === "actions" ? ACTION_COL_WIDTH : LABEL_COLS.find((c) => c.key === key)?.width ?? 90);
  const labelTotal = LABEL_COLS.reduce((sum, c) => sum + widthOf(c.key), 0) + (canWrite ? widthOf("actions") : 0);
  const narrowDays = dayColW < 64; // too narrow for the full weekday and "29 Oct"
  // A day note being written / read: which vehicle and day, and the text in the box.
  const [noteTarget, setNoteTarget] = useState<{ vehicle: VehicleRow; day: string } | null>(null);
  const [noteText, setNoteText] = useState("");
  // Free a vehicle from an order (the row's Free button): which trip, and which order of a shared load.
  const [freeAsk, setFreeAsk] = useState<{ vehicle: VehicleRow; orders: string[]; options: FreeOption[] } | null>(null);
  const [freeBusy, setFreeBusy] = useState(false);
  const [windowStartIso, setWindowStartIso] = usePersistentFilter<string>(
    "vehiclePlanning:windowStart", startOfDay(new Date()).toISOString(),
  );
  const windowStart = useMemo(() => startOfDay(new Date(windowStartIso)), [windowStartIso]);
  const setWindowStart = (updater: Date | ((d: Date) => Date)) => {
    setWindowStartIso((prevIso) => {
      const prev = startOfDay(new Date(prevIso));
      const next = typeof updater === "function" ? (updater as (d: Date) => Date)(prev) : updater;
      return next.toISOString();
    });
  };
  // Whether the Gantt box has been clicked into — scroll/arrow-keys only move the date window
  // while this is true, so idly scrolling the page with the mouse over the table doesn't hijack
  // that scroll into a date change.
  const [ganttActive, setGanttActive] = useState(false);
  const ganttActiveRef = useRef(false);
  ganttActiveRef.current = ganttActive;
  const ganttRef = useRef<HTMLDivElement>(null);
  // Trackpad / magic-mouse two-finger sideways swipe slides the calendar directly — no click or
  // focus needed, since a sideways gesture can't be mistaken for scrolling the page. Deltas are
  // accumulated and converted at one day per WHEEL_PX_PER_DAY of finger travel, so a slow drag
  // moves smoothly day by day and a fast flick covers many days. Registered natively (non-
  // passive): React's onWheel is passive and can't preventDefault, which is what stops the
  // browser's own back/forward swipe navigation from firing on a sideways gesture.
  const wheelAccum = useRef(0);
  useEffect(() => {
    const el = ganttRef.current;
    if (!el) return;
    const onWheel = (e: WheelEvent) => {
      const horizontal = Math.abs(e.deltaX) > Math.abs(e.deltaY) || e.shiftKey;
      if (!horizontal) return; // vertical scroll is the board's own (the day header stays put); only a sideways gesture moves the dates
      const delta = Math.abs(e.deltaX) > Math.abs(e.deltaY) ? e.deltaX : e.deltaY;
      if (delta === 0) return;
      e.preventDefault();
      wheelAccum.current += delta;
      // One day per WHEEL_PX_PER_DAY of finger travel (a column is only 42 px wide, which made a sideways swipe race through dates), and never more than
      // WHEEL_MAX_DAYS_PER_EVENT days from one wheel event, so even a hard flick stays controllable.
      const raw = Math.trunc(wheelAccum.current / WHEEL_PX_PER_DAY);
      if (raw === 0) return;
      const days = Math.max(-WHEEL_MAX_DAYS_PER_EVENT, Math.min(WHEEL_MAX_DAYS_PER_EVENT, raw));
      wheelAccum.current = raw === days ? wheelAccum.current - days * WHEEL_PX_PER_DAY : 0;
      setWindowStart((d) => addDays(d, days));
    };
    el.addEventListener("wheel", onWheel, { passive: false });
    return () => el.removeEventListener("wheel", onWheel);
  });

  // Calendar date picker — single date or a from/to range, same single/range toggle pattern
  // Scan History's own date filter uses. A single date just moves the window's start (the
  // 14/30-day toggle still controls its length); a range sets BOTH the start and the exact
  // length, so the timeline shows precisely the days asked for, however many that is.
  const [dateOpen, setDateOpen] = useState(false);
  const [datePickMode, setDatePickMode] = useState<"single" | "range">("single");
  const isoOf = (d: Date) => format(d, "yyyy-MM-dd");
  const [customFrom, setCustomFrom] = useState(() => isoOf(startOfDay(new Date())));
  const [customTo, setCustomTo] = useState(() => isoOf(startOfDay(new Date())));
  const applyCustomSingle = (value: string) => {
    if (!value) return;
    const d = parse(value, "yyyy-MM-dd", new Date());
    if (Number.isNaN(d.getTime())) return;
    setCustomFrom(value);
    setCustomTo(value);
    setWindowStart(startOfDay(d));
    setDateOpen(false);
  };
  const applyCustomRange = (fromValue: string, toValue: string) => {
    setCustomFrom(fromValue);
    setCustomTo(toValue);
    if (!fromValue || !toValue) return;
    const from = parse(fromValue, "yyyy-MM-dd", new Date());
    const to = parse(toValue, "yyyy-MM-dd", new Date());
    if (Number.isNaN(from.getTime()) || Number.isNaN(to.getTime()) || to < from) return;
    setWindowStart(startOfDay(from));
    setWindowDays(Math.max(1, differenceInCalendarDays(to, from) + 1));
  };

  const fleetQuery = useQuery<{ vehicles: VehicleRow[]; companyFilters: string[]; lastRefreshedAt?: string | null; planningStartDate?: string | null; lastReset?: LastReset | null }>({
    queryKey: ["/api/vehicle-planning/vehicles"],
    queryFn: async () => (await apiRequest("GET", "/api/vehicle-planning/vehicles")).json(),
  });

  const historyQuery = useQuery<{ history: HistoryEntry[] }>({
    queryKey: ["/api/vehicle-planning/vehicles", historyTarget?.id, "history"],
    queryFn: async () => (await apiRequest("GET", `/api/vehicle-planning/vehicles/${historyTarget!.id}/history`)).json(),
    enabled: !!historyTarget,
  });

  const settingsQuery = useQuery<{ companyFilters: string[]; availableCompanies: string[] }>({
    queryKey: ["/api/vehicle-planning/settings"],
    queryFn: async () => (await apiRequest("GET", "/api/vehicle-planning/settings")).json(),
  });

  const availableOrdersQuery = useQuery<AvailableOrdersResponse>({
    queryKey: ["/api/vehicle-planning/available-orders", assignTarget?.id, assignDate, assignSearch],
    queryFn: async () => (await apiRequest("GET", `/api/vehicle-planning/available-orders?vehicleId=${assignTarget!.id}${assignDate ? `&date=${assignDate}` : ""}&q=${encodeURIComponent(assignSearch)}`)).json(),
    enabled: !!assignTarget,
  });

  // The driver list (name + Notion page id), read when the dialog opens. If Notion cannot be reached the driver can still be typed.
  const driversQuery = useQuery<{ drivers: NotionDriver[]; message?: string }>({
    queryKey: ["/api/vehicle-planning/drivers"],
    queryFn: async () => (await apiRequest("GET", "/api/vehicle-planning/drivers")).json(),
    enabled: !!assignTarget || !!changeTarget,
    staleTime: 5 * 60 * 1000,
  });
  const driverList = driversQuery.data?.drivers ?? [];
  const effectiveDriver = driverText ?? availableOrdersQuery.data?.vehicle?.lastDriver ?? "";
  const matchedDriverId = driverList.find((d) => d.name.trim().toLowerCase() === effectiveDriver.trim().toLowerCase())?.id
    ?? (driverExtra && driverExtra.name.trim().toLowerCase() === effectiveDriver.trim().toLowerCase() ? driverExtra.id : null);

  // "Get driver from Notion": the driver Notion already has on the picked order.
  const fetchDriverMutation = useMutation({
    mutationFn: async (orderNumber: string) => (await apiRequest("GET", `/api/vehicle-planning/order-driver?orderNumber=${encodeURIComponent(orderNumber)}`)).json() as Promise<{ found: boolean; driver: NotionDriver | null; message?: string }>,
    onSuccess: (data) => {
      if (data.driver) { setDriverText(data.driver.name); setDriverExtra(data.driver); }
      else toast({ title: data.found ? "Notion has no driver on this order" : "Could not read Notion", description: data.message });
    },
    onError: (err: any) => toast({ title: "Could not read Notion", description: parseApiErrorMessage(err), variant: "destructive" }),
  });

  const assignMutation = useMutation({
    mutationFn: async ({ orderNumber, force, sameTripAs }: { orderNumber: string; force?: boolean; sameTripAs?: string }) => {
      const res = await apiRequest("POST", "/api/vehicle-planning/assign", {
        orderNumber, vehicleId: assignTarget!.id, force: force || undefined, sameTripAs: sameTripAs || undefined,
        driverName: effectiveDriver.trim() || undefined, driverPageId: matchedDriverId || undefined,
      });
      return res.json();
    },
    onSuccess: (data, { orderNumber }) => {
      const notionBad = data?.notion?.state === "failed" || data?.notion?.state === "retrying";
      toast({
        ...withNotionNotice({ title: "Vehicle assigned", description: `${assignTarget?.vehicleNumber} → order ${orderNumber}` }, data),
        action: notionBad ? <ToastAction altText="Retry the Notion update" onClick={() => retryNotionMutation.mutate(orderNumber)}>Retry</ToastAction> : undefined,
      });
      queryClient.invalidateQueries({ queryKey: ["/api/vehicle-planning/vehicles"] });
      setAssignAsk(null);
      setAssignTarget(null);
    },
    onError: (err: any, vars) => {
      const body = parseApiErrorBody(err);
      if (body?.code === "BEFORE_FREE") { setAssignAsk({ message: body.message, orderNumber: vars.orderNumber, destId: assignTarget!.id, overlapping: body.overlapping ?? [], blocking: body.blocking ?? null }); return; }
      toast({ title: "Could not assign vehicle", description: parseApiErrorMessage(err), variant: "destructive" });
    },
  });

  // Arrived / Undo arrival on one trip.
  const arrivalMutation = useMutation({
    mutationFn: async (body: { vehicleId: number; orderNumber: string; arrivedOn?: string; note?: string; undo?: boolean; freeSameDay?: boolean }) => {
      const res = await apiRequest("POST", "/api/vehicle-planning/trips/arrival", body);
      if (!res.ok) throw new Error((await res.json().catch(() => ({})))?.message || "Failed to save the arrival");
      return res.json();
    },
    onSuccess: (data: any, body) => {
      const veh = allVehicles.find((x) => x.id === body.vehicleId);
      if (body.undo) toast({ title: "Arrival removed", description: `Order #${body.orderNumber}` });
      else toast({
        title: "Arrived - free now", description: `${veh?.vehicleNumber ?? "Vehicle"} · order #${body.orderNumber}`,
        action: <ToastAction altText="Undo the arrival" onClick={() => arrivalMutation.mutate({ vehicleId: body.vehicleId, orderNumber: body.orderNumber, undo: true })}>Undo</ToastAction>,
      });
      queryClient.invalidateQueries({ queryKey: ["/api/vehicle-planning/vehicles"] });
      // Back earlier than planned: say when it is free and how many orders are waiting for a vehicle.
      if (!body.undo && data?.early && data?.waiting > 0 && data?.freeFrom && veh) setEarlyAsk({ vehicle: veh, freeFrom: data.freeFrom, waiting: data.waiting });
      setTripTarget(null);
      setStatusTarget(null);
    },
    onError: (err: any) => toast({ title: "Could not save", description: parseApiErrorMessage(err), variant: "destructive" }),
  });

  // Stretch (or reset) the expected last day of a trip that has not arrived.
  const expectedEndMutation = useMutation({
    mutationFn: async (body: { vehicleId: number; orderNumber: string; expectedEnd: string | null; reason?: string }) => {
      const res = await apiRequest("POST", "/api/vehicle-planning/trips/expected-end", body);
      if (!res.ok) throw new Error((await res.json().catch(() => ({})))?.message || "Failed to change the end day");
      return res.json();
    },
    onSuccess: (_d, body) => {
      toast({ title: body.expectedEnd ? "Expected last day changed" : "Expected last day reset", description: `Order #${body.orderNumber}${body.expectedEnd ? ` → ${body.expectedEnd}` : ""}` });
      queryClient.invalidateQueries({ queryKey: ["/api/vehicle-planning/vehicles"] });
      setStretchAsk(null);
      setExtendAsk(null);
    },
    onError: (err: any) => toast({ title: "Could not change the end day", description: parseApiErrorMessage(err), variant: "destructive" }),
  });

  // Change plan. Moving a trip is the same call as assigning, with the new vehicle: the old vehicle's history and Notion's vehicle are replaced for us.
  const moveMutation = useMutation({
    mutationFn: async ({ destId, force, sameTripAs }: { destId: number; force?: boolean; sameTripAs?: string }) => {
      const t = changeTarget!.trip;
      // "" = the whole trip (all its orders go together); otherwise just the picked order of a shared trip.
      if (!changeOrder) {
        const res = await apiRequest("POST", "/api/vehicle-planning/trips/move-group", {
          vehicleId: changeTarget!.vehicle.id, orderNumber: t.orderNumber, toVehicleId: destId, force: force || undefined,
        });
        return res.json();
      }
      const m = t.members.find((x) => x.orderNumber === changeOrder);
      const res = await apiRequest("POST", "/api/vehicle-planning/assign", {
        orderNumber: changeOrder, vehicleId: destId, force: force || undefined, sameTripAs: sameTripAs || undefined, move: true,
        driverName: m?.driver || undefined, driverPageId: m?.driverNotionId || undefined,
      });
      return res.json();
    },
    onSuccess: (data, { destId }) => {
      const dest = allVehicles.find((x) => x.id === destId);
      toast(withNotionNotice({ title: "Moved to another vehicle", description: `Order${data?.moved?.length > 1 ? "s" : ""} #${(data?.moved ?? [changeOrder || changeTarget?.trip.orderNumber]).join(", #")} → ${dest?.vehicleNumber ?? destId}` }, data));
      queryClient.invalidateQueries({ queryKey: ["/api/vehicle-planning/vehicles"] });
      setMoveAsk(null);
      setChangeTarget(null);
    },
    onError: (err: any, vars) => {
      const body = parseApiErrorBody(err);
      if (body?.code === "BEFORE_FREE") {
        setMoveAsk({ message: body.message, orderNumber: changeOrder || changeTarget!.trip.orderNumber, destId: vars.destId, overlapping: body.overlapping ?? [], blocking: body.blocking ?? null });
        return;
      }
      toast({ title: "Could not move the order", description: parseApiErrorMessage(err), variant: "destructive" });
    },
  });

  const driverMutation = useMutation({
    mutationFn: async (body: { vehicleId: number; orderNumber: string; driverName: string; driverPageId?: string }) => {
      const res = await apiRequest("POST", "/api/vehicle-planning/trips/driver", body);
      return res.json();
    },
    onSuccess: (data, body) => {
      toast(withNotionNotice({ title: body.driverName ? "Driver changed" : "Driver removed", description: `Order #${body.orderNumber}${body.driverName ? ` → ${body.driverName}` : ""}` }, data));
      queryClient.invalidateQueries({ queryKey: ["/api/vehicle-planning/vehicles"] });
      setChangeTarget(null);
    },
    onError: (err: any) => toast({ title: "Could not change the driver", description: parseApiErrorMessage(err), variant: "destructive" }),
  });

  const removeMutation = useMutation({
    mutationFn: async (body: { vehicleId: number; orderNumber: string }) => {
      const res = await apiRequest("POST", "/api/vehicle-planning/trips/remove-vehicle", body);
      return res.json();
    },
    onSuccess: (data, body) => {
      toast(withNotionNotice({ title: "Vehicle removed", description: `Order #${body.orderNumber} has no vehicle and no driver now.` }, data));
      queryClient.invalidateQueries({ queryKey: ["/api/vehicle-planning/vehicles"] });
      queryClient.invalidateQueries({ queryKey: ["/api/vehicle-planning/available-orders"] });
      setChangeTarget(null);
      setFreeAsk(null);
    },
    onError: (err: any) => toast({ title: "Could not remove the vehicle", description: parseApiErrorMessage(err), variant: "destructive" }),
  });

  // The vehicle's own status (maintenance, breakdown ...): save, or clear with an empty status. Our system only.
  const statusMutation = useMutation({
    mutationFn: async (body: { vehicleId: number; status: string | null; days: number; comment: string }) => {
      const res = await apiRequest("POST", "/api/vehicle-planning/status", body);
      if (!res.ok) throw new Error((await res.json().catch(() => ({})))?.message || "Failed to save the status");
      return res.json();
    },
    onSuccess: (_d, body) => {
      toast({ title: body.status ? "Status saved" : "Status cleared" });
      queryClient.invalidateQueries({ queryKey: ["/api/vehicle-planning/vehicles"] });
      setStatusTarget(null);
    },
    onError: (err: any) => toast({ title: "Could not save the status", description: parseApiErrorMessage(err), variant: "destructive" }),
  });

  // A day note: save (or, with empty text, remove) the note for one vehicle on one day.
  const noteMutation = useMutation({
    mutationFn: async (body: { vehicleId: number; day: string; text: string }) => {
      const res = await apiRequest("POST", "/api/vehicle-planning/day-notes", body);
      if (!res.ok) throw new Error((await res.json().catch(() => ({})))?.message || "Failed to save the note");
      return res.json();
    },
    onSuccess: (_d, body) => {
      toast({ title: body.text.trim() ? "Note saved" : "Note removed" });
      queryClient.invalidateQueries({ queryKey: ["/api/vehicle-planning/vehicles"] });
      setNoteTarget(null);
    },
    onError: (err: any) => toast({ title: "Could not save the note", description: parseApiErrorMessage(err), variant: "destructive" }),
  });

  const retryNotionMutation = useMutation({
    mutationFn: async (orderNumber: string) => {
      const res = await apiRequest("POST", "/api/vehicle-planning/retry-notion", { orderNumber });
      return res.json();
    },
    onSuccess: (data) => {
      toast(withNotionNotice({ title: "Notion update retried" }, data));
      queryClient.invalidateQueries({ queryKey: ["/api/vehicle-planning/vehicles"] });
    },
    onError: (err: any) => toast({ title: "Could not retry", description: parseApiErrorMessage(err), variant: "destructive" }),
  });

  useEffect(() => {
    setAssignDate(assignStartRef.current ?? ""); assignStartRef.current = null; setAssignSearch(""); setAssignPick(null); setDriverText(null); setDriverExtra(null); setAssignAsk(null);
  }, [assignTarget?.id]);
  useEffect(() => {
    setChangeOrder(""); setMoveSearch(""); setMoveDest(null); setMoveAsk(null); setChangeDriverText(null); setChangeDriverExtra(null); setRemoveSure(false);
  }, [changeTarget?.trip.orderNumber, changeTarget?.vehicle.id]);


  const syncMutation = useMutation({
    mutationFn: async () => {
      const res = await apiRequest("POST", "/api/vehicle-planning/sync");
      if (!res.ok) throw new Error((await res.json().catch(() => ({})))?.message || "Failed to sync from Notion");
      return res.json() as Promise<{ syncedVehicles: number; mismatches: number; notInSystem: number; fetchedOrders?: number }>;
    },
    onSuccess: (result) => {
      toast({
        title: "Refreshed from Notion",
        description: `${result.syncedVehicles} vehicle(s) checked${result.fetchedOrders != null ? ` · ${result.fetchedOrders} order(s) read` : ""}${result.mismatches > 0 ? ` · ${result.mismatches} vehicle mismatch(es) found` : ""}${result.notInSystem > 0 ? ` · ${result.notInSystem} order(s) assigned in Notion but not in our system` : ""}`,
      });
      queryClient.invalidateQueries({ queryKey: ["/api/vehicle-planning/vehicles"] });
      if (result.notInSystem > 0) openReview();
    },
    onError: (err: any) => toast({ title: "Sync failed", description: parseApiErrorMessage(err), variant: "destructive" }),
  });

  // Review: what the last Refresh found, read from our own data (nothing is written and Notion is not called).
  const reviewQuery = useQuery<{ items: ReviewItem[]; missing: number }>({
    queryKey: ["/api/vehicle-planning/review"],
    queryFn: async () => (await apiRequest("GET", "/api/vehicle-planning/review")).json(),
    enabled: reviewOpen,
    staleTime: 0,
  });
  function openReview() {
    setReviewRun(null);
    setReviewTicked([]);
    setReviewOpen(true);
    queryClient.invalidateQueries({ queryKey: ["/api/vehicle-planning/review"] });
  }
  // Creates only the ticked slips, one at a time so the dialog can show how far it got. One failing does not stop the rest.
  async function createTicked() {
    const todo = [...reviewTicked];
    setReviewRun({ total: todo.length, done: 0, created: 0, failed: [], finished: false });
    let created = 0;
    const failed: { orderNumber: string; message: string }[] = [];
    for (let i = 0; i < todo.length; i++) {
      try {
        const res = await apiRequest("POST", "/api/vehicle-planning/fetch-slip", { orderNumber: todo[i] });
        await res.json();
        created++;
      } catch (err) {
        failed.push({ orderNumber: todo[i], message: parseApiErrorMessage(err) });
      }
      setReviewRun({ total: todo.length, done: i + 1, created, failed: [...failed], finished: i + 1 === todo.length });
    }
    setReviewTicked([]);
    queryClient.invalidateQueries({ queryKey: ["/api/vehicle-planning/vehicles"] });
    queryClient.invalidateQueries({ queryKey: ["/api/vehicle-planning/review"] });
    queryClient.invalidateQueries({ queryKey: ["/api/vehicle-planning/available-orders"] });
  }

  const settingsMutation = useMutation({
    mutationFn: async (companyFilters: string[]) => {
      const res = await apiRequest("POST", "/api/vehicle-planning/settings", { companyFilters });
      if (!res.ok) throw new Error((await res.json().catch(() => ({})))?.message || "Failed to save filter");
      return res.json();
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/vehicle-planning/settings"] });
      queryClient.invalidateQueries({ queryKey: ["/api/vehicle-planning/vehicles"] });
    },
    onError: (err: any) => {
      setPendingCompanies(null);
      toast({ title: "Could not save company filter", description: parseApiErrorMessage(err), variant: "destructive" });
    },
  });

  const resolveMismatchMutation = useMutation({
    mutationFn: async (keep: "notion" | "proforma") => {
      const res = await apiRequest("POST", "/api/vehicle-planning/resolve-mismatch", {
        vehicleId: mismatchTarget!.id, orderNumber: mismatchTarget!.currentOrder!.orderNumber, keep,
      });
      if (!res.ok) throw new Error((await res.json().catch(() => ({})))?.message || "Failed to resolve mismatch");
      return res.json();
    },
    onSuccess: () => {
      toast({ title: "Mismatch resolved" });
      queryClient.invalidateQueries({ queryKey: ["/api/vehicle-planning/vehicles"] });
      setMismatchTarget(null);
    },
    onError: (err: any) => toast({ title: "Could not resolve mismatch", description: parseApiErrorMessage(err), variant: "destructive" }),
  });

  const allVehicles = fleetQuery.data?.vehicles ?? [];
  const availableCompanies = settingsQuery.data?.availableCompanies ?? [];
  // What is saved (server) vs what the boxes show right now: the boxes follow a click straight away and
  // fall back to the saved list when it changes or a save fails.
  const savedCompanyFilters = fleetQuery.data?.companyFilters ?? [];
  const [pendingCompanies, setPendingCompanies] = useState<string[] | null>(null);
  useEffect(() => { setPendingCompanies(null); }, [savedCompanyFilters.join("|")]);
  const matchesFilter = (company: string, filters: string[]) => filters.some((f) => company.toLowerCase().includes(f.toLowerCase()));
  // The companies that are ticked, as exact names — a saved filter like "km" can cover several companies,
  // and unticking one of them has to leave the others ticked.
  const checkedCompanies = pendingCompanies ?? availableCompanies.filter((c) => matchesFilter(c, savedCompanyFilters));
  const activeCompanyFilters = checkedCompanies;
  function toggleCompany(company: string, next: boolean) {
    const nextChecked = next ? Array.from(new Set([...checkedCompanies, company])) : checkedCompanies.filter((c) => c !== company);
    if (nextChecked.length === 0) {
      toast({ title: "Keep at least one company", description: "Tick another company first, then untick this one." });
      return;
    }
    setPendingCompanies(nextChecked);
    settingsMutation.mutate(nextChecked.map((c) => c.toLowerCase()));
  }

  // The columns the filters can use. The Values checklist lists what is really in the current fleet.
  const filterableColumns: FilterableColumn<VehicleRow>[] = useMemo((): FilterableColumn<VehicleRow>[] => {
    const opts = (get: (v: VehicleRow) => string | null | undefined) =>
      Array.from(new Set(allVehicles.map(get).filter((x): x is string => !!x))).sort((a, b) => a.localeCompare(b, undefined, { numeric: true })).map((x) => ({ value: x, label: x }));
    const todayIso = isoOf(new Date());
    const plantState = (v: VehicleRow) => (v.currentOrder?.plant ? `${v.currentOrder.plant}${v.state ? `, ${v.state}` : ""}` : null);
    return [
      { id: "vehicleNumber", label: "Vehicle", filterType: "text", options: opts((v) => v.vehicleNumber), accessor: (v) => v.vehicleNumber },
      { id: "rto", label: "RTO No.", filterType: "text", options: opts((v) => v.rtoNumber), accessor: (v) => v.rtoNumber },
      { id: "order", label: "Order No.", filterType: "text", options: opts((v) => v.currentOrder?.orderNumber), accessor: (v) => v.currentOrder?.orderNumber },
      { id: "plantState", label: "Plant / State", filterType: "text", options: opts(plantState), accessor: plantState },
      { id: "driver", label: "Driver", filterType: "text", options: opts((v) => v.driver), accessor: (v) => v.driver },
      { id: "tripDays", label: "Trip Days", filterType: "number", options: [], disableValues: true, accessor: (v) => (v.tripDays != null && v.tripDays !== "" && !Number.isNaN(Number(v.tripDays)) ? Number(v.tripDays) : null) },
      { id: "status", label: "Status", filterType: "text", options: opts((v) => computeStatus(v, todayIso).label), accessor: (v) => computeStatus(v, todayIso).label },
    ];
  }, [allVehicles]);
  const conditionList = Object.values(columnConditions).filter((c) => !isConditionEmpty(c));

  // Hidden by default (no sync history yet for this vehicle) unless the toggle is on or the
  // vehicle itself matches an active search — so a search can still surface one on demand.
  const searchLower = search.trim().toLowerCase();
  const vehicles = allVehicles
    .filter((v) => {
      const matchesSearch = !searchLower
        || [v.vehicleNumber, v.driver, v.currentOrder?.orderNumber].some((f) => (f ?? "").toLowerCase().includes(searchLower));
      if (!matchesSearch) return false;
      if (conditionList.length > 0 && !matchAllConditions(v, conditionList, filterableColumns)) return false;
      if (tripFilter === "awaiting" && v.vehicleState !== "awaiting") return false;
      if (tripFilter === "conflicts" && !(v.conflicts?.length)) return false;
      if (availableOn && !isAvailableOn(v, availableOn)) return false;
      if (availableOn) return true;   // Available on a day lists EVERY vehicle free that day (with or without orders) - of the selected companies only
      // A vehicle with no orders is free on every day, so when the Available filter is on it is listed even with the switch off.
      if (orderView === "none") return !v.hasHistory;
      if (orderView === "all") return true;
      // Exactly what it says: only vehicles that have orders (a search can still surface one that has none).
      return v.hasHistory || !!searchLower;
    })
    .sort((a, b) => {
      if (!sortBy) return 0;
      const dir = sortOrder === "asc" ? 1 : -1;
      if (sortBy === "vehicleNumber") return dir * (a.vehicleNumber ?? "").localeCompare(b.vehicleNumber ?? "", undefined, { numeric: true });
      return dir * (parseInt(a.currentOrder?.orderNumber ?? "", 10) || 0) - dir * (parseInt(b.currentOrder?.orderNumber ?? "", 10) || 0);
    });
  const missingCount = allVehicles.filter((v) => v.currentOrder?.notInSystem).length;
  const awaitingCount = allVehicles.filter((v) => v.vehicleState === "awaiting").length;
  const conflictCount = allVehicles.filter((v) => (v.conflicts?.length ?? 0) > 0).length;
  const today = useMemo(() => startOfDay(new Date()), []);
  const days = useMemo(
    () => Array.from({ length: windowDays }, (_, i) => addDays(windowStart, i)),
    [windowStart, windowDays],
  );
  // Today's own column index, so its highlight can be drawn ON TOP of a busy row's bar too — the
  // background tint below is drawn first and a busy row's bar paints over it, which is why today
  // used to disappear the moment a vehicle had an active trip.
  const todayIdx = differenceInCalendarDays(today, windowStart);
  const todayInView = todayIdx >= 0 && todayIdx < windowDays;

  // A "YYYY-MM-DD" day as a day-index into `days` (0 = the first visible day).
  const dayIdx = (day: string) => differenceInCalendarDays(parse(day, "yyyy-MM-dd", new Date()), windowStart);
  const dayLabel = (day: string) => format(parse(day, "yyyy-MM-dd", new Date()), "d MMM");

  const stateText: Record<TripState, string> = {
    planned: "Planned", on_trip: "On the trip", awaiting: "Overdue - past its last day, no arrival recorded", arrived: "Arrived", closed: "Closed (no arrival recorded)", cancelled: "Cancelled",
  };

  // One dot per active order per day: a shared load shows two dots until its shorter slip ends. `labels` = where each trip's party name is written (above its first dot).
  function dotsFor(v: VehicleRow) {
    const byIdx: { trip: Trip; member: TripMember; conflict: boolean; extended: boolean }[][] = days.map(() => []);
    const labels: { trip: Trip; startIdx: number; endIdx: number }[] = [];
    // The days an extension added (after the planned last day, up to the extended end or the arrival): marked, with the reason written over them.
    const extLabels: { trip: Trip; startIdx: number; endIdx: number; reason: string | null }[] = [];
    const conflictSet = new Set((v.conflicts ?? []).map((c) => c.orderNumber));
    const shown = (v.trips ?? []).filter((x) => x.state !== "cancelled").sort((a, b) => a.startDay.localeCompare(b.startDay));
    for (const tr of shown) {
      let first = Number.POSITIVE_INFINITY, last = -1;
      const extFrom = dayIdx(tr.plannedLastDay) + 1;
      const extTo = tr.expectedEnd && tr.expectedEnd > tr.plannedLastDay ? dayIdx(tr.lastBusyDay < tr.expectedEnd ? tr.lastBusyDay : tr.expectedEnd) : -1;
      for (const m of tr.members) {
        const s = dayIdx(m.startDay), e = dayIdx(memberEnd(tr, m));
        const followsTrip = m.plannedLastDay === tr.plannedLastDay;
        for (let i = Math.max(0, s); i <= Math.min(windowDays - 1, e); i++) byIdx[i].push({ trip: tr, member: m, conflict: conflictSet.has(tr.orderNumber), extended: followsTrip && i >= extFrom && i <= extTo });
        first = Math.min(first, s); last = Math.max(last, e);
      }
      if (last >= 0 && first < windowDays) labels.push({ trip: tr, startIdx: Math.max(0, first), endIdx: Math.min(windowDays - 1, last) });
      if (extTo >= extFrom && extTo >= 0 && extFrom < windowDays) extLabels.push({ trip: tr, startIdx: Math.max(0, extFrom), endIdx: Math.min(windowDays - 1, extTo), reason: tr.expectedEndReason ?? null });
    }
    return { byIdx, labels, extLabels };
  }

  // The trips an extension to `newEnd` would run into (they start before the longer trip is back).
  function clashesFor(v: VehicleRow, trip: Trip, newEnd: string): Trip[] {
    return (v.trips ?? []).filter((x) => x.orderNumber !== trip.orderNumber && x.state !== "cancelled" && x.state !== "arrived" && x.state !== "closed"
      && x.startDay > trip.startDay && x.startDay <= newEnd);
  }
  // The Extend button: opens the box with +1 day chosen; the reason is asked there, then the clash question when the longer trip runs into the next one.
  function openExtend(v: VehicleRow, trip: Trip) {
    // A late vehicle (the trip already ended) is still out today, so the new last day starts at today; otherwise the day after the current end.
    const base = trip.lastBusyDay < isoOf(new Date()) ? format(addDays(new Date(), -1), "yyyy-MM-dd") : trip.lastBusyDay;
    const next = format(addDays(parse(base, "yyyy-MM-dd", new Date()), 1), "yyyy-MM-dd");
    setExtendAsk({ vehicle: v, trip, newEnd: next, clashes: [] });
  }
  // Arrived is only ever TODAY: one click, the vehicle is free now (and can go out again the same day). An Undo message follows.
  function arriveToday(v: VehicleRow, trip: Trip) {
    arrivalMutation.mutate({ vehicleId: v.id, orderNumber: trip.orderNumber, arrivedOn: isoOf(new Date()), freeSameDay: true });
  }
  function openAssign(v: VehicleRow, day?: string) { assignStartRef.current = day ?? null; setAssignTarget(v); }
  // Frees every ticked order of the vehicle (one after the other); a single one keeps the usual message.
  async function freeSelected() {
    if (!freeAsk || freeAsk.orders.length === 0) return;
    const { vehicle, orders } = freeAsk;
    if (orders.length === 1) { removeMutation.mutate({ vehicleId: vehicle.id, orderNumber: orders[0] }); return; }
    setFreeBusy(true);
    const failed: string[] = [];
    for (const no of orders) {
      try {
        const res = await apiRequest("POST", "/api/vehicle-planning/trips/remove-vehicle", { vehicleId: vehicle.id, orderNumber: no });
        if (!res.ok) throw new Error("failed");
      } catch { failed.push(`#${no}`); }
    }
    setFreeBusy(false);
    queryClient.invalidateQueries({ queryKey: ["/api/vehicle-planning/vehicles"] });
    queryClient.invalidateQueries({ queryKey: ["/api/vehicle-planning/available-orders"] });
    toast(failed.length
      ? { title: `${orders.length - failed.length} of ${orders.length} orders freed`, description: `Could not free ${failed.join(", ")} (it may already be dispatched or loading).`, variant: "destructive" }
      : { title: `${orders.length} orders freed`, description: `${vehicle.vehicleNumber} has no vehicle or driver on them any more.` });
    setFreeAsk(null);
  }
  // Drag the right edge of a heading: one label column, or (target "day") the width of every day column.
  function startResize(e: { clientX: number; preventDefault(): void; stopPropagation(): void }, target: string) {
    e.preventDefault(); e.stopPropagation();
    const x0 = e.clientX;
    const start = target === "day" ? dayColW : widthOf(target);
    const move = (ev: PointerEvent) => {
      const w = Math.round(start + ev.clientX - x0);
      if (target === "day") setDayColW(Math.max(DAY_COL_MIN, Math.min(DAY_COL_MAX, w)));
      else setColWidths((prev) => ({ ...prev, [target]: Math.max(40, Math.min(420, w)) }));
    };
    const up = () => { window.removeEventListener("pointermove", move); window.removeEventListener("pointerup", up); };
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", up);
  }

  // Refresh now: an admin's chosen day is saved as the start date first, then Notion is read.
  async function startRefresh() {
    const saved = (fleetQuery.data?.planningStartDate ?? "").slice(0, 10);
    if (canWrite && isAdmin && refreshFrom !== saved) {
      try {
        const res = await apiRequest("POST", "/api/vehicle-planning/start-date", { startDate: refreshFrom || null });
        if (!res.ok) throw new Error((await res.json().catch(() => ({})))?.message || "Could not save the day");
        await queryClient.invalidateQueries({ queryKey: ["/api/vehicle-planning/vehicles"] });
      } catch (err: any) {
        toast({ title: "Could not save the day", description: parseApiErrorMessage(err), variant: "destructive" });
        return;
      }
    }
    setRefreshOpen(false);
    syncMutation.mutate();
  }
  function openStatus(v: VehicleRow) {
    const n = v.manualStatus?.blocks ? Math.max(1, v.manualStatus.daysLeft ?? 1) : 0;
    setStatusTarget(v); setStPick(v.manualStatus?.status ?? ""); setStComment(v.manualStatus?.comment ?? "");
    setStDays(n ? String(n) : ""); setStFrom(n ? format(addDays(new Date(), n), "yyyy-MM-dd") : "");
  }
  // Days and the "available again" date are one setting: changing either updates the other (days counted from today).
  function changeStDays(value: string) {
    setStDays(value);
    const n = Math.floor(Number(value));
    setStFrom(n >= 1 && n <= 365 ? format(addDays(new Date(), n), "yyyy-MM-dd") : "");
  }
  function changeStFrom(value: string) {
    setStFrom(value);
    const n = value ? differenceInCalendarDays(parse(value, "yyyy-MM-dd", new Date()), startOfDay(new Date())) : 0;
    setStDays(n >= 1 ? String(n) : "");
  }

  const chipCls = (on: boolean) => `rounded-full px-3 py-1 text-xs font-medium ${on ? "bg-[#001d6e] text-white" : "border border-gray-200 bg-white text-gray-600 hover:bg-gray-50"}`;

  // What the row's Free / Arrived buttons act on. Both are there as soon as the vehicle has an order that has not arrived yet (assigned here or only in Notion).
  // Free: any of those orders (the box asks which when there are several). Arrived: the trip that is out - on the road, or due back - so an early return works
  // even when the next order is already assigned; with only a planned order there is nothing to arrive from yet.
  function actionTrips(v: VehicleRow): { live: Trip[]; out: Trip | null; planned: Trip | null } {
    const live = (v.trips ?? []).filter((x) => x.state !== "cancelled" && x.state !== "closed" && !x.arrivedOn);
    const byStart = (a: Trip, b: Trip) => a.startDay.localeCompare(b.startDay);
    const out = [...live].filter((x) => x.state === "on_trip" || x.state === "awaiting").sort(byStart)[0] ?? null;
    const planned = [...live].filter((x) => x.state === "planned").sort(byStart)[0] ?? null;
    return { live, out, planned };
  }
  function freeOptionsOf(trips: Trip[]): FreeOption[] {
    return trips.flatMap((x) => x.members.map((m) => ({
      orderNumber: m.orderNumber, partyName: m.partyName, startDay: x.startDay, lastBusyDay: x.lastBusyDay, notInSystem: m.notInSystem, locked: x.lockedReason ?? null,
    })));
  }
  function openFree(v: VehicleRow, trips: Trip[]) {
    const options = freeOptionsOf(trips);
    const open = options.filter((o) => !o.locked);
    setFreeAsk({ vehicle: v, options, orders: options.length === 1 ? [options[0].orderNumber] : open.length === 1 ? [open[0].orderNumber] : [] });
  }

  // The label over a trip's bar: one party, or for a shared load both names when there is room ("Party A + Party B") and the first with "+1" when there is not.
  function barLabel(t: Trip, labelDays: number): string {
    if (t.members.length <= 1) return t.partyName ?? "—";
    // Slips of different lengths on one trip show their days ("Party A (4d) + Party B (2d)"); equal lengths need no numbers.
    const sameLength = t.members.every((m) => m.tripDays === t.members[0].tripDays);
    const names = t.members.map((m) => `${m.partyName ?? "—"}${sameLength ? "" : ` (${m.tripDays}d)`}`);
    return labelDays * dayColW >= 200 ? names.join(" + ") : `${names[0]} +${names.length - 1}`;
  }

  // Marks the older trip that holds the vehicle as arrived (same day), then runs the assignment / move again.
  async function markBlockingArrivedThen(ask: NotFreeAsk, close: () => void, run: () => void) {
    if (!ask.blocking) return;
    try {
      const res = await apiRequest("POST", "/api/vehicle-planning/trips/arrival", {
        vehicleId: ask.destId, orderNumber: ask.blocking.orderNumber, arrivedOn: ask.blocking.suggestedArrival, freeSameDay: true,
      });
      await res.json();
      queryClient.invalidateQueries({ queryKey: ["/api/vehicle-planning/vehicles"] });
      close();
      run();
    } catch (err) {
      toast({ title: "Could not mark it arrived", description: parseApiErrorMessage(err), variant: "destructive" });
    }
  }

  // The dialog for "the vehicle is not free for this order". Options, in the order a planner wants them: ride along on a running trip (shared load), mark the
  // older trip arrived and carry on, or (an admin only) go ahead anyway.
  function renderNotFree(ask: NotFreeAsk | null, setAsk: (a: NotFreeAsk | null) => void, pending: boolean, run: (o: { force?: boolean; sameTripAs?: string }) => void, forceLabel: string, allowShare = true) {
    return (
      <Dialog open={!!ask} onOpenChange={(open) => { if (!open && !pending) setAsk(null); }}>
        <DialogContent className="sm:max-w-md max-w-[calc(100vw-1rem)] overflow-x-hidden [&>*]:min-w-0">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-1.5"><AlertTriangle className="h-4 w-4 text-amber-500" /> Vehicle is not free yet</DialogTitle>
            <DialogDescription>{ask?.message}</DialogDescription>
          </DialogHeader>
          {ask && canWrite && ((allowShare && ask.overlapping.length > 0) || ask.blocking?.canMarkArrived) && (
            <div className="space-y-2">
              {ask.blocking?.canMarkArrived && (
                <Button className="h-auto w-full justify-start whitespace-normal py-2 text-left" variant="outline" disabled={pending} onClick={() => markBlockingArrivedThen(ask, () => setAsk(null), () => run({}))}>
                  Mark #{ask.blocking.orderNumber} arrived on {dayLabel(ask.blocking.suggestedArrival)} and continue
                </Button>
              )}
              {allowShare && ask.overlapping.map((o) => (
                <Button key={o.orderNumber} className="h-auto w-full justify-start whitespace-normal py-2 text-left" variant="outline" disabled={pending} onClick={() => run({ sameTripAs: o.orderNumber })}>
                  Same trip as #{o.orderNumber}{o.partyName ? ` (${o.partyName})` : ""} - shared load
                </Button>
              ))}
            </div>
          )}
          <DialogFooter className="gap-2 sm:gap-2">
            <Button variant="outline" disabled={pending} onClick={() => setAsk(null)}>{isAdmin ? "No" : "Close"}</Button>
            {isAdmin && (
              <Button disabled={pending} onClick={() => run({ force: true })}>
                {pending ? <Loader2 className="h-4 w-4 animate-spin" /> : forceLabel}
              </Button>
            )}
          </DialogFooter>
        </DialogContent>
      </Dialog>
    );
  }

  return (
    <div className="mx-auto w-full max-w-none px-2 pb-3 pt-10 sm:px-3">
      {/* After a Reset planning: when, by whom, the day Refresh from Notion starts from, and Undo (7 days). */}
      <ResetBanner planningStartDate={fleetQuery.data?.planningStartDate ?? null} lastReset={fleetQuery.data?.lastReset ?? null} lastRefreshedAt={fleetQuery.data?.lastRefreshedAt ?? null} isAdmin={canWrite && isAdmin} onRefreshNow={() => syncMutation.mutate()} onResetAgain={() => setResetOpen(true)} />

      {/* Fleet controls - search at the left; Companies (with the planning settings); at the right Filter, Available and Refresh from Notion
          (the only thing that ever talks to Notion; the page itself just reads vehicle_planning_state). */}
      <div className="mb-2 flex flex-wrap items-center gap-2">
        <h2 className="mr-1 flex items-center gap-2 text-lg font-bold leading-none text-[#001d6e]">
          <span className="flex h-7 w-7 items-center justify-center rounded-lg bg-[#001d6e] text-white"><CalendarClock className="h-4 w-4" /></span>
          Vehicle Planning
        </h2>
        <div className="relative">
          <Search className="pointer-events-none absolute left-2.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-gray-400" />
          <Input
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="Search vehicle, driver, order…"
            className="h-8 w-56 rounded-full pl-8 text-xs"
          />
        </div>

        <Popover open={filterOpen} onOpenChange={setFilterOpen}>
          <PopoverTrigger asChild>
            <Button size="sm" variant="outline" className="h-8 rounded-full px-3 text-xs">
              Companies{activeCompanyFilters.length > 0 ? ` (${activeCompanyFilters.length})` : ""}
            </Button>
          </PopoverTrigger>
          <PopoverContent className="w-64 space-y-3" align="start">
            <div className="space-y-2">
              <div className="text-[11px] font-semibold uppercase tracking-wide text-gray-500">Include companies</div>
              <div className="max-h-56 space-y-1.5 overflow-y-auto">
                {availableCompanies.map((company) => {
                  const checked = checkedCompanies.includes(company);
                  return (
                    <label key={company} className="flex items-center gap-2 text-xs text-gray-700">
                      <Checkbox
                        checked={checked}
                        onCheckedChange={(next) => toggleCompany(company, next === true)}
                      />
                      {company}
                    </label>
                  );
                })}
                {availableCompanies.length === 0 && (
                  <div className="py-2 text-center text-xs text-gray-400">No companies found</div>
                )}
              </div>
            </div>
            {canWrite && isAdmin && (
              <div className="space-y-3 border-t pt-3">
                <Button size="sm" variant="outline" className="h-8 w-full rounded-full border-red-200 px-3 text-xs text-red-700 hover:bg-red-50 hover:text-red-800"
                  title="Clear our planning board and start again from a day. Notion is not changed."
                  onClick={() => { setFilterOpen(false); setResetOpen(true); }}>
                  <RotateCcw className="mr-1.5 h-3.5 w-3.5" /> Reset planning
                </Button>
              </div>
            )}
          </PopoverContent>
        </Popover>

        {/* Always visible for admins (it is also in the Companies settings and, right after a reset, in the yellow line). */}
        {canWrite && isAdmin && (
          <Button size="sm" variant="outline" className="h-8 rounded-full border-red-200 px-3 text-xs text-red-700 hover:bg-red-50 hover:text-red-800" onClick={() => setResetOpen(true)}
            title="Clear our planning board and start again from a day. Notion is not changed.">
            <RotateCcw className="mr-1.5 h-3.5 w-3.5" /> Reset planning
          </Button>
        )}

        <div className="ml-auto flex flex-wrap items-center gap-2">
          {/* "+ Filter": pick a column, then the same Values / Condition builder the other pages have. Every column header has its own filter button too. */}
          <AddColumnFilterButton
            columns={filterableColumns}
            conditions={columnConditions}
            onApply={setColumnCondition}
            onClear={clearColumnCondition}
            className="h-8 gap-1 rounded-full border-dashed border-[#001d6e]/40 bg-white px-3 text-xs font-medium text-[#001d6e] hover:bg-[#001d6e]/5 hover:text-[#001d6e]"
          />

          {/* Available: the vehicles that are free on a day you pick (by their arrival / trip end). */}
          <Popover open={availableOpen} onOpenChange={setAvailableOpen}>
            <PopoverTrigger asChild>
              <Button size="sm" variant="outline" className={`h-8 rounded-full px-3 text-xs ${availableOn ? "border-emerald-500 bg-emerald-50 text-emerald-800" : ""}`}>
                <Truck className="mr-1.5 h-3.5 w-3.5" />
                {availableOn ? `Available on ${dayLabel(availableOn)}` : "Available"}
              </Button>
            </PopoverTrigger>
            <PopoverContent className="w-72 space-y-3" align="end">
              <div className="text-[11px] font-semibold uppercase tracking-wide text-gray-500">Vehicles free on</div>
              <Input type="date" value={availableOn || format(new Date(), "yyyy-MM-dd")} onChange={(e) => setAvailableOn(e.target.value)} className="h-9" />
              <div className="flex flex-wrap gap-1.5">
                <button type="button" className={chipCls(availableOn === format(new Date(), "yyyy-MM-dd"))} onClick={() => setAvailableOn(format(new Date(), "yyyy-MM-dd"))}>Today</button>
                <button type="button" className={chipCls(availableOn === format(addDays(new Date(), 1), "yyyy-MM-dd"))} onClick={() => setAvailableOn(format(addDays(new Date(), 1), "yyyy-MM-dd"))}>Tomorrow</button>
              </div>
              <div className="flex items-center justify-between border-t pt-2 text-xs">
                <span className="text-gray-500">
                  {availableOn ? `${allVehicles.filter((v) => isAvailableOn(v, availableOn)).length} vehicle(s) free` : "Pick a day to filter"}
                </span>
                {availableOn && <button type="button" className="text-gray-400 hover:text-red-500" onClick={() => { setAvailableOn(""); setAvailableOpen(false); }}>Clear</button>}
              </div>
            </PopoverContent>
          </Popover>

          {/* Nothing refreshes this page by itself, so say how old the data is. */}
          <span className="text-[11px] text-gray-500" title="Vehicle Planning reads Notion only when you press Refresh">
            Last refreshed: {fleetQuery.data?.lastRefreshedAt
              ? new Date(fleetQuery.data.lastRefreshedAt).toLocaleString("en-IN", { timeZone: "Asia/Kolkata", day: "2-digit", month: "short", hour: "numeric", minute: "2-digit", hour12: true })
              : "never"}
          </span>
          {/* Refresh from Notion: press it to choose the day to read orders from (every order on or after that day, for the selected companies' vehicles; empty = each
              vehicle's latest order), then Refresh now. */}
          <Popover open={refreshOpen} onOpenChange={(open) => { setRefreshOpen(open); if (open) setRefreshFrom((fleetQuery.data?.planningStartDate ?? "").slice(0, 10)); }}>
            <PopoverTrigger asChild>
              <Button size="sm" variant="outline" className="h-8 rounded-full px-3 text-xs" disabled={syncMutation.isPending}>
                <RefreshCw className={`mr-1.5 h-3.5 w-3.5 ${syncMutation.isPending ? "animate-spin" : ""}`} />
                {syncMutation.isPending ? "Refreshing…" : "Refresh from Notion"}
              </Button>
            </PopoverTrigger>
            <PopoverContent className="w-72 space-y-2.5" align="end">
              <div className="text-[11px] font-semibold uppercase tracking-wide text-gray-500">Read orders from</div>
              {canWrite && isAdmin ? (
                <div className="flex items-center gap-2">
                  <Input type="date" value={refreshFrom} max={format(new Date(), "yyyy-MM-dd")} onChange={(e) => setRefreshFrom(e.target.value)} className="h-9" />
                  {refreshFrom && <button type="button" className="shrink-0 text-[11px] text-gray-500 underline decoration-dotted hover:text-gray-800" onClick={() => setRefreshFrom("")}>Latest only</button>}
                </div>
              ) : (
                <p className="text-xs text-gray-700">{fleetQuery.data?.planningStartDate ? dayLabel(fleetQuery.data.planningStartDate.slice(0, 10)) : "Each vehicle's latest order"} (an admin can change the day)</p>
              )}
              <p className="text-[11px] text-gray-500">Every order on or after that day is brought in for the selected companies' vehicles. With no day, only each vehicle's latest order is read.</p>
              <Button size="sm" className="w-full" disabled={syncMutation.isPending} onClick={() => void startRefresh()}>
                <RefreshCw className="mr-1.5 h-3.5 w-3.5" /> Refresh now
              </Button>
            </PopoverContent>
          </Popover>
        </div>
      </div>

      <div className="mb-2 flex flex-wrap items-center gap-2">
        {/* Which vehicles to list - same pill style as the 14 / 30 days switch. */}
        <div className="flex overflow-hidden rounded-full border border-gray-200 bg-white text-xs font-medium" role="group" aria-label="Vehicles to show">
          {([
            { key: "with" as const, label: "With orders" },
            { key: "all" as const, label: "All vehicles" },
            { key: "none" as const, label: `No orders (${allVehicles.filter((v) => !v.hasHistory).length})` },
          ]).map((o) => (
            <button
              key={o.key}
              type="button"
              onClick={() => setOrderView(o.key)}
              aria-pressed={orderView === o.key}
              className={`h-8 px-3 ${orderView === o.key ? "bg-[#001d6e] text-white" : "text-gray-600 hover:bg-gray-50"}`}
            >
              {o.label}
            </button>
          ))}
        </div>

        {/* Quick filters for the two things that need a person: a vehicle past its planned end with no arrival recorded,
            and a vehicle with two trips that cannot both happen. */}
        {([
          { key: "conflicts" as const, label: "Conflicts", count: conflictCount, on: "border-red-400 bg-red-50 text-red-700", off: "text-red-600" },
        ]).map((c) => (
          <button
            key={c.key}
            type="button"
            onClick={() => setTripFilter((p) => (p === c.key ? "all" : c.key))}
            className={`h-8 rounded-full border px-3 text-xs font-medium ${tripFilter === c.key ? c.on : `border-gray-200 bg-white ${c.off}`}`}
            title={tripFilter === c.key ? "Click to show all vehicles again" : `Show only vehicles with ${c.label.toLowerCase()}`}
          >
            {c.label}: {c.count}
          </button>
        ))}

        <div className="ml-auto flex flex-wrap items-center gap-1.5">
        <Button size="sm" variant="outline" className={`h-8 rounded-full px-3 text-xs ${adjustMode ? "border-[#001d6e] bg-[#001d6e]/5 text-[#001d6e]" : ""}`}
          onClick={() => setAdjustMode((p) => !p)} aria-pressed={adjustMode} title={adjustMode ? "Hide the column width handles" : "Show the column width handles"}>
          <SlidersHorizontal className="mr-1.5 h-3.5 w-3.5" /> {adjustMode ? "Done" : "Columns"}
        </Button>
        <Popover
          open={dateOpen}
          onOpenChange={(open) => {
            setDateOpen(open);
            // Seed the inputs from whatever's actually showing right now (the 14/30 toggle or
            // Prev/Today/Next may have moved the window since this was last opened), so reopening
            // it never shows a stale date.
            if (open) {
              setCustomFrom(isoOf(windowStart));
              setCustomTo(isoOf(addDays(windowStart, windowDays - 1)));
              setDatePickMode(windowDays <= 1 ? "single" : "range");
            }
          }}
        >
          <PopoverTrigger asChild>
            <Button size="sm" variant="outline" className="h-8 rounded-full px-3 text-xs">
              <CalendarDays className="mr-1.5 h-3.5 w-3.5" />
              {windowDays <= 1
                ? format(windowStart, "d MMM yyyy")
                : `${format(windowStart, "d MMM")} – ${format(addDays(windowStart, windowDays - 1), "d MMM yyyy")}`}
            </Button>
          </PopoverTrigger>
          <PopoverContent className="w-64 space-y-3" align="start">
            <div className="grid grid-cols-2 gap-1.5">
              {(["single", "range"] as const).map((m) => (
                <button
                  key={m}
                  type="button"
                  onClick={() => setDatePickMode(m)}
                  className={`rounded-md border px-2 py-1 text-xs font-medium ${
                    datePickMode === m ? "border-[#001d6e] bg-[#001d6e]/5 text-[#001d6e]" : "border-gray-300 text-gray-600 hover:bg-gray-50"
                  }`}
                >
                  {m === "single" ? "Single date" : "Date range"}
                </button>
              ))}
            </div>

            {datePickMode === "single" ? (
              <div className="space-y-1">
                <label className="text-[11px] font-semibold uppercase tracking-wide text-gray-500">Date</label>
                <input
                  type="date"
                  value={customFrom}
                  onChange={(e) => applyCustomSingle(e.target.value)}
                  className="h-8 w-full rounded-md border border-gray-300 bg-white px-2 text-xs"
                />
              </div>
            ) : (
              <div className="grid grid-cols-2 gap-2">
                <div className="space-y-1">
                  <label className="text-[11px] font-semibold uppercase tracking-wide text-gray-500">From</label>
                  <input
                    type="date"
                    value={customFrom}
                    max={customTo || undefined}
                    onChange={(e) => applyCustomRange(e.target.value, customTo)}
                    className="h-8 w-full rounded-md border border-gray-300 bg-white px-2 text-xs"
                  />
                </div>
                <div className="space-y-1">
                  <label className="text-[11px] font-semibold uppercase tracking-wide text-gray-500">To</label>
                  <input
                    type="date"
                    value={customTo}
                    min={customFrom || undefined}
                    onChange={(e) => applyCustomRange(customFrom, e.target.value)}
                    className="h-8 w-full rounded-md border border-gray-300 bg-white px-2 text-xs"
                  />
                </div>
              </div>
            )}
          </PopoverContent>
        </Popover>
        <div className="flex items-center gap-1">
          <Button size="sm" variant="outline" className="h-8 w-8 rounded-full p-0" onClick={() => setWindowStart((d) => addDays(d, -windowDays))} aria-label="Back a full window" title="Back a full window">
            <ChevronsLeft className="h-4 w-4" />
          </Button>
          <Button size="sm" variant="outline" className="h-8 w-8 rounded-full p-0" onClick={() => setWindowStart((d) => addDays(d, -SCROLL_STEP_DAYS))} aria-label="Back a day" title="Back a day (or scroll/arrow-key over the chart)">
            <ChevronLeft className="h-4 w-4" />
          </Button>
          <Button size="sm" variant="outline" className="h-8 rounded-full px-3 text-xs" onClick={() => setWindowStart(today)}>
            Today
          </Button>
          <Button size="sm" variant="outline" className="h-8 w-8 rounded-full p-0" onClick={() => setWindowStart((d) => addDays(d, SCROLL_STEP_DAYS))} aria-label="Forward a day" title="Forward a day (or scroll/arrow-key over the chart)">
            <ChevronRight className="h-4 w-4" />
          </Button>
          <Button size="sm" variant="outline" className="h-8 w-8 rounded-full p-0" onClick={() => setWindowStart((d) => addDays(d, windowDays))} aria-label="Forward a full window" title="Forward a full window">
            <ChevronsRight className="h-4 w-4" />
          </Button>
        </div>
        </div>
      </div>

      {conditionList.length > 0 && (
        <div className="mb-2 flex flex-wrap items-center gap-1.5">
          {Object.entries(columnConditions).filter(([, c]) => !isConditionEmpty(c)).map(([id, condition]) => (
            <ColumnFilterChipView key={id} columnId={id} condition={condition} columns={filterableColumns} onEdit={(c) => setColumnCondition(id, c)} onRemove={() => clearColumnCondition(id)} />
          ))}
          <button type="button" className="text-xs text-gray-500 underline decoration-dotted hover:text-red-600" onClick={() => setColumnConditions({})}>Clear all</button>
        </div>
      )}

      {adjustMode && (
        <div className="mb-2 flex flex-wrap items-center gap-x-4 gap-y-1 rounded-lg border border-[#001d6e]/20 bg-[#001d6e]/5 px-3 py-1.5 text-xs text-[#001d6e]">
          <span className="font-medium">Resize columns: drag the right edge of a heading (the light strip). Dragging a day heading changes every day.</span>
          <label className="flex items-center gap-2">
            Day width
            <input type="range" min={DAY_COL_MIN} max={DAY_COL_MAX} step={5} value={dayColW} onChange={(e) => setDayColW(Number(e.target.value))} aria-label="Day column width" className="h-1.5 w-28 cursor-pointer accent-[#001d6e]" />
            <span className="w-9 tabular-nums">{dayColW}px</span>
          </label>
          <button type="button" className="underline decoration-dotted hover:text-[#001d6e]/70" onClick={() => { setColWidths({}); setDayColW(DAY_COL_DEFAULT); }}>Reset widths</button>
          <Button size="sm" className="ml-auto h-7 px-3 text-xs" onClick={() => setAdjustMode(false)}>Done</Button>
        </div>
      )}

      {missingCount > 0 && missingHidden !== missingCount && (
        <div className="mb-2 flex flex-wrap items-center justify-between gap-2 rounded-lg border border-sky-200 bg-sky-50 px-3 py-1 text-xs text-sky-900">
          <span className="flex items-center gap-1.5"><DatabaseZap className="h-3.5 w-3.5" /> {missingCount} order{missingCount === 1 ? " is" : "s are"} in Notion but not in our system.</span>
          <span className="flex items-center gap-1">
            <Button size="sm" variant="outline" className="h-7 border-sky-300 px-3 text-xs" onClick={openReview}>Review</Button>
            <button type="button" onClick={() => setMissingHidden(missingCount)} className="flex h-6 w-6 items-center justify-center rounded text-sky-700 hover:bg-sky-100" aria-label="Close" title="Close (it comes back if the number changes)"><X className="h-4 w-4" /></button>
          </span>
        </div>
      )}

      {/* The conflicts, spelled out, while the Conflicts filter is on. */}
      {tripFilter === "conflicts" && (
        <div className="mb-3 space-y-1 rounded-lg border border-red-200 bg-red-50 px-3 py-2 text-xs text-red-800">
          {vehicles.flatMap((v) => (v.conflicts ?? []).map((c) => ({ v, c }))).map(({ v, c }) => {
            const trip = v.trips?.find((t) => t.orderNumber === c.orderNumber);
            return (
              <button key={`${v.id}-${c.orderNumber}`} type="button" className="block w-full text-left hover:underline" onClick={() => trip && setTripTarget({ vehicle: v, trip })}>
                <strong>{v.vehicleNumber}</strong>: order #{c.orderNumber} starts {dayLabel(c.startDay)}, but #{c.withOrderNumber} keeps the vehicle until {dayLabel(c.withLastBusyDay)}.
              </button>
            );
          })}
          {vehicles.every((v) => !(v.conflicts?.length)) && <span>No conflicts.</span>}
        </div>
      )}

      {fleetQuery.isLoading ? (
        <SectionSkeleton lines={6} />
      ) : (
        <div
          ref={ganttRef}
          className={`max-h-[calc(100vh-10rem)] overflow-auto overscroll-x-contain border bg-white shadow-sm focus:outline-none ${ganttActive ? "border-[#001d6e]/40 ring-2 ring-[#001d6e]/30" : "border-gray-200"}`}
          tabIndex={0}
          title={ganttActive ? "Swipe sideways or use the arrow keys to move the date range" : "Click, then swipe sideways or use the arrow keys to move the date range"}
          onFocus={() => setGanttActive(true)}
          onBlur={() => setGanttActive(false)}
          // A click anywhere inside the table (a row, a cell, empty space) bubbles up to here —
          // explicitly focusing the container itself is what actually fires onFocus above, since
          // a plain click on a non-focusable child div doesn't bubble FOCUS the way it bubbles
          // the click event itself.
          onClick={(e) => e.currentTarget.focus()}
          onKeyDown={(e) => {
            if (!ganttActive) return;
            if (e.key === "ArrowLeft") { e.preventDefault(); setWindowStart((d) => addDays(d, -SCROLL_STEP_DAYS)); }
            else if (e.key === "ArrowRight") { e.preventDefault(); setWindowStart((d) => addDays(d, SCROLL_STEP_DAYS)); }
          }}
        >
          <div style={{ minWidth: labelTotal + windowDays * dayColW }}>
            {/* Day header — one continuous bar with date ticks, not a row of separately
                bordered boxes (that read as "many small columns" rather than one timeline). */}
            <div className="sticky top-0 z-30 flex border-b border-gray-200 bg-[#001d6e] text-white">
              {/* Vehicle … Trip Days stay pinned to the left while the calendar scrolls under them. */}
              <div className="sticky left-0 z-20 flex shrink-0 bg-[#001d6e] shadow-[2px_0_4px_-1px_rgba(0,0,0,0.25)]">
              {LABEL_COLS.map((c) => {
                const sortKey = c.key === "vehicleNumber" || c.key === "orderNumber" ? c.key : null;
                const col = filterableColumns.find((f) => f.id === HEADER_FILTER_IDS[c.key]);
                return (
                  <div
                    key={c.key}
                    style={{ width: widthOf(c.key) }}
                    className="relative flex shrink-0 items-center gap-1 overflow-hidden border-r border-white/10 px-2 py-2.5 text-[10px] font-semibold uppercase tracking-wide"
                  >
                    <span className={`min-w-0 truncate ${sortKey ? "cursor-pointer select-none" : ""}`} onClick={sortKey ? () => toggleVpSort(sortKey) : undefined}>
                      {c.label}
                      {sortKey && sortBy === sortKey && (
                        sortOrder === "asc" ? <ChevronUp className="ml-0.5 inline h-3 w-3" /> : <ChevronDown className="ml-0.5 inline h-3 w-3" />
                      )}
                    </span>
                    {col && (
                      <ColumnHeaderFilterButton column={col} condition={columnConditions[col.id]} onChange={(cond) => setColumnCondition(col.id, cond)} onRemove={() => clearColumnCondition(col.id)} />
                    )}
                    {adjustMode && <span onPointerDown={(e) => startResize(e, c.key)} className="absolute right-0 top-0 z-10 h-full w-2 cursor-col-resize touch-none bg-white/30 hover:bg-white/70" title="Drag to resize this column" />}
                  </div>
                );
              })}
              {canWrite && (
                <div style={{ width: widthOf("actions") }} className="relative shrink-0 overflow-hidden border-r border-white/10 px-2 py-2.5 text-[10px] font-semibold uppercase tracking-wide">
                  Actions
                  {adjustMode && <span onPointerDown={(e) => startResize(e, "actions")} className="absolute right-0 top-0 z-10 h-full w-2 cursor-col-resize touch-none bg-white/30 hover:bg-white/70" title="Drag to resize this column" />}
                </div>
              )}
              </div>
              <div className="flex flex-1">
                {days.map((d, i) => (
                  <div
                    key={i}
                    style={{ width: `${100 / windowDays}%`, minWidth: dayColW }}
                    className={`relative shrink-0 border-l border-white/10 text-center ${narrowDays ? "py-1.5 text-[11px]" : "py-2 text-xs"} ${isSameDay(d, today) ? "bg-white/15 font-bold" : ""}`}
                  >
                    {adjustMode && <span onPointerDown={(e) => startResize(e, "day")} className="absolute right-0 top-0 z-10 h-full w-2 cursor-col-resize touch-none bg-white/25 hover:bg-white/60" title="Drag to change the width of every day" />}
                    <div className="opacity-70">{format(d, narrowDays ? "EEE" : "EEEE")}</div>
                    <div className={narrowDays ? "" : "text-sm font-semibold"}>{format(d, narrowDays ? "d/M" : "d MMM")}</div>
                  </div>
                ))}
              </div>
            </div>

            {/* Vehicle rows */}
            {vehicles.map((v, rowIdx) => {
              const { byIdx, labels, extLabels } = dotsFor(v);
              // Two (or more) orders on one day are stacked up and down: the row grows with the tallest stack and the Assign / Extend buttons sit below it.
              const maxStack = Math.max(1, ...byIdx.map((c) => c.length));
              const btnTop = Math.max(38, 22 + maxStack * 14 + (maxStack - 1) * 3 + 4);
              const rowH = btnTop + 26;
              const todayIso = isoOf(today);
              const av = computeAvailability(v, todayIso);
              const st = computeStatus(v, todayIso);
              const stripe = rowIdx % 2 === 1;
              return (
                <div key={v.id} className={`flex border-b border-gray-100 last:border-0 ${stripe ? "bg-slate-50/70" : "bg-white"}`}>
                  <div className={`sticky left-0 z-10 flex shrink-0 shadow-[2px_0_4px_-1px_rgba(0,0,0,0.08)] ${stripe ? "bg-slate-50" : "bg-white"}`}>
                  {([
                    { key: "vehicleNumber", value: v.vehicleNumber, bold: true },
                    { key: "rtoNumber", value: v.rtoNumber, bold: false },
                    { key: "orderNumber", value: v.currentOrder ? `#${v.currentOrder.orderNumber}` : null, bold: false },
                    {
                      key: "state",
                      // Current order's plant + Plant Master's state for it (e.g. "Valsad, GJ")
                      // — follows whichever order is active, never the order's own party/
                      // destination state (a different Notion field of the same name).
                      value: v.currentOrder?.plant
                        ? `${v.currentOrder.plant}${v.state ? `, ${v.state}` : ""}`
                        : null,
                      bold: false,
                    },
                    { key: "driver", value: v.driver, bold: false },
                    { key: "tripDays", value: v.tripDays, bold: false },
                  ] as const).map((c) => (
                    <div
                      key={c.key}
                      style={{ width: widthOf(c.key) }}
                      className={`shrink-0 cursor-pointer border-r border-gray-100 px-2 py-2.5 text-[11px] hover:bg-[#001d6e]/5 ${c.key === "driver" ? "" : "truncate"} ${c.bold ? "font-semibold text-[#001d6e]" : "text-gray-600"} ${c.key === "orderNumber" ? "flex items-center gap-1" : ""}`}
                      title={c.key === "orderNumber" ? "Click for this vehicle's order history" : (c.value ?? undefined)}
                      onClick={() => setHistoryTarget(v)}
                    >
                      {c.key === "orderNumber" && v.currentOrder?.vehicleMismatch && (
                        <button
                          type="button"
                          onClick={(e) => { e.stopPropagation(); setMismatchTarget(v); }}
                          title={`Vehicle mismatch — Notion says ${v.vehicleNumber}, proforma slip says ${v.currentOrder?.mismatchProformaVehicleNumber}`}
                          className="shrink-0 text-amber-500 hover:text-amber-600"
                        >
                          <AlertTriangle className="h-3 w-3" />
                        </button>
                      )}
                      {/* Driver names run longer than this column is wide — wraps onto 2 lines
                          instead of cutting off with an ellipsis like every other column here. */}
                      <span className={c.key === "driver" ? "line-clamp-2 break-words leading-tight" : "truncate"}>{c.value ?? "—"}</span>
                      {c.key === "vehicleNumber" && v.volume != null && <span className="block text-[9px] font-normal leading-none text-gray-400" title="Vehicle volume">Vol {v.volume}</span>}
                    </div>
                  ))}
                  <div style={{ width: widthOf("status") }} className="shrink-0 cursor-pointer border-r border-gray-100 px-1.5 py-2 hover:bg-[#001d6e]/5" title={st.title} onClick={() => openStatus(v)}>
                    <span className={`inline-block max-w-full truncate rounded-full px-2 py-0.5 align-middle text-[10px] font-semibold ${st.tone}`}>{st.label}</span>
                    {st.daysText && <div className={`mt-0.5 truncate text-[10px] ${st.label === "Overdue" ? "font-semibold text-amber-700" : "text-gray-500"}`}>{st.daysText}</div>}
                  </div>
                  {canWrite && (() => {
                    const at = actionTrips(v);
                    const freeable = at.live.filter((x) => !x.lockedReason);
                    const allLocked = at.live.length > 0 && freeable.length === 0;
                    const dueNow = at.out?.state === "awaiting";
                    return (
                      <div style={{ width: widthOf("actions") }} className="flex shrink-0 flex-col justify-center gap-1 border-r border-gray-100 px-1.5 py-1">
                        {at.live.length > 0 && (
                          <button type="button" disabled={allLocked} onClick={() => openFree(v, at.live)}
                            className="rounded-md border border-red-200 bg-white px-1.5 py-0.5 text-[11px] font-semibold leading-tight text-red-600 hover:bg-red-50 disabled:cursor-not-allowed disabled:border-gray-200 disabled:text-gray-400 disabled:hover:bg-white"
                            title={allLocked ? at.live[0].lockedReason ?? undefined : `Free ${v.vehicleNumber} from an order it was assigned to by mistake - the order goes back to "no vehicle"`}>
                            Free
                          </button>
                        )}
                        {at.live.length > 0 && (
                          <button type="button" disabled={!at.out} onClick={() => at.out && arriveToday(v, at.out)}
                            className={`rounded-md border px-1.5 py-0.5 text-[11px] font-semibold leading-tight disabled:cursor-not-allowed disabled:border-gray-200 disabled:bg-white disabled:text-gray-400 ${dueNow ? "border-amber-400 bg-amber-100 text-amber-900 hover:bg-amber-200" : "border-emerald-300 bg-white text-emerald-700 hover:bg-emerald-50"}`}
                            title={at.out ? `${v.vehicleNumber} came back today from order #${at.out.members.map((m) => m.orderNumber).join(" + #")} - free now` : at.planned ? `Order #${at.planned.orderNumber} starts on ${dayLabel(at.planned.startDay)}. Nothing is out yet.` : undefined}>
                            Arrived
                          </button>
                        )}
                      </div>
                    );
                  })()}
                  </div>
                  <div data-track className="relative flex-1" style={{ minHeight: Math.max(ROW_MIN_HEIGHT, rowH) }}>
                    {/* One continuous area. A thin, light vertical line at each day (a little firmer at the start of a week, Monday) lines the dots up
                        with the dates in the header; today keeps its faint tint. Each day a vehicle is out has one dot per order (a shared load: two). */}
                    <div className="absolute inset-0 flex">
                      {days.map((d, i) => {
                        const dayIso = isoOf(d);
                        const note = (v.dayNotes ?? []).find((n) => n.day === dayIso);
                        const clickable = canWrite || !!note;
                        const cellDots = byIdx[i] ?? [];
                        const ms = v.manualStatus;
                        const blockedDay = !!ms?.blocks && !!ms.endDay && ms.startDay <= dayIso && dayIso <= ms.endDay;
                        return (
                          <div
                            key={i}
                            style={{ width: `${100 / windowDays}%`, minWidth: dayColW }}
                            className={`relative shrink-0 border-l ${d.getDay() === 1 ? "border-gray-300" : "border-gray-200/70"} ${isSameDay(d, today) ? "bg-[#001d6e]/[0.04]" : ""} ${clickable ? "cursor-pointer hover:bg-[#001d6e]/[0.06]" : ""}`}
                            title={note ? `${note.text}${note.byName ? `\n— ${note.byName}` : ""}` : canWrite ? `Click to add a note for ${v.vehicleNumber} on ${format(d, "d MMM")}` : undefined}
                            onClick={clickable ? () => { setNoteTarget({ vehicle: v, day: dayIso }); setNoteText(note?.text ?? ""); } : undefined}
                          >
                            {(cellDots.length > 0 || blockedDay) && (
                              <div className="absolute inset-x-0 top-[22px] flex flex-col items-center justify-center gap-[3px]">
                                {cellDots.map((dd, k) => {
                                  const dotKey = `${dd.member.orderNumber}-${k}`;
                                  // A shared load: each slip's party is written next to its own dot (on the day that slip starts).
                                  const showName = dd.trip.members.length > 1 && !narrowDays && (dd.member.startDay === dayIso || (i === 0 && dd.member.startDay < dayIso));
                                  const dot = (
                                    <button
                                    key={dotKey}
                                    type="button"
                                    onClick={(e) => { e.stopPropagation(); const r = (e.currentTarget as HTMLElement).getBoundingClientRect(); setDotCard({ vehicle: v, trip: dd.trip, member: dd.member, x: r.left + r.width / 2, y: r.bottom }); }}
                                    className={`${cellDots.length > 2 ? "h-2.5 w-2.5" : "h-3.5 w-3.5"} shrink-0 rounded-full shadow-sm ${dotClass(dd.trip.state, dd.conflict)} ${dd.extended ? "ring-2 ring-violet-500 ring-offset-1" : ""}`}
                                    title={`#${dd.member.orderNumber} · ${dd.member.partyName ?? "—"} · ${dayLabel(dd.member.startDay)} to ${dayLabel(memberEnd(dd.trip, dd.member))} · ${dd.conflict ? "Vehicle not back yet" : stateText[dd.trip.state]}${dd.trip.notionNote ? " · Notion not updated" : ""}${dd.extended ? ` · Extended${dd.trip.expectedEndReason ? `: ${dd.trip.expectedEndReason}` : ""}` : ""}`}
                                  />
                                  );
                                  return showName ? (
                                    <div key={dotKey} className="flex w-full min-w-0 items-center gap-1 px-1">
                                      {dot}
                                      <span className="min-w-0 truncate text-[9px] font-medium leading-none text-gray-800" title={dd.member.partyName ?? undefined}>{dd.member.partyName ?? "—"}</span>
                                    </div>
                                  ) : dot;
                                })}
                                {blockedDay && cellDots.length === 0 && (
                                  <span className="h-3.5 w-3.5 shrink-0 rounded-full border-2 border-red-400 bg-white" title={`${ms!.status}${ms!.comment ? ` - ${ms!.comment}` : ""}`} />
                                )}
                              </div>
                            )}
                            {note && (
                              <span className="pointer-events-none absolute inset-x-0.5 bottom-0.5 flex items-center gap-0.5 truncate rounded bg-amber-100 px-1 text-[9px] leading-4 text-amber-900">
                                <MessageSquare className="h-2.5 w-2.5 shrink-0" />
                                {!narrowDays && <span className="truncate">{note.text}</span>}
                              </span>
                            )}
                          </div>
                        );
                      })}
                    </div>
                    {/* The party name of each trip, written once above its first dot (as wide as the room up to the next trip). */}
                    {labels.map((l, li) => {
                      const nextStart = labels[li + 1]?.startIdx ?? windowDays;
                      if (l.trip.members.length > 1 && !narrowDays) return null;   // a shared load: each party is written beside its own dot
                      const ext = extLabels.find((x) => x.trip === l.trip);
                      if (ext && ext.startIdx <= l.startIdx) return null;   // every visible day is an extended one: the extension label is written there
                      const spanDays = Math.max(1, Math.min(l.endIdx, nextStart - 1, ext ? ext.startIdx - 1 : windowDays) - l.startIdx + 1);
                      return (
                        <div key={l.trip.orderNumber} className="pointer-events-none absolute truncate text-[10px] font-medium leading-[1.15] text-black"
                          style={{ top: 4, left: `calc(${(l.startIdx / windowDays) * 100}% + 3px)`, width: `calc(${(spanDays / windowDays) * 100}% - 6px)` }}
                          title={l.trip.partyName ?? undefined}>
                          {barLabel(l.trip, spanDays)}
                        </div>
                      );
                    })}
                    {/* An extended trip: "Extended - reason" written over the days the extension added (their dots have a violet ring). */}
                    {extLabels.map((x) => (
                      <div key={`ext-${x.trip.orderNumber}`} className="pointer-events-none absolute truncate text-[10px] font-semibold leading-[1.15] text-violet-700"
                        style={{ top: 4, left: `calc(${(x.startIdx / windowDays) * 100}% + 3px)`, width: `calc(${((x.endIdx - x.startIdx + 1) / windowDays) * 100}% - 6px)` }}
                        title={`Extended${x.reason ? `: ${x.reason}` : ""}`}>
                        Extended{x.reason ? ` · ${x.reason}` : ""}
                      </div>
                    ))}
                    {/* A status set on this page (maintenance, breakdown ...): its name over the days it keeps the vehicle out. */}
                    {v.manualStatus?.blocks && v.manualStatus.endDay && (() => {
                      const s0 = Math.max(0, dayIdx(v.manualStatus!.startDay)), e0 = Math.min(windowDays - 1, dayIdx(v.manualStatus!.endDay!));
                      if (e0 < s0) return null;
                      return (
                        <div className="pointer-events-none absolute truncate text-[10px] font-semibold leading-[1.15] text-red-700"
                          style={{ top: 4, left: `calc(${(s0 / windowDays) * 100}% + 3px)`, width: `calc(${((e0 - s0 + 1) / windowDays) * 100}% - 6px)` }}>
                          {v.manualStatus!.status} · {v.manualStatus!.daysLeft} d left
                        </div>
                      );
                    })()}
                    {/* The day the vehicle becomes available (the trip's last day - automatic, no arrival needed): Assign opens on that day; Extend lengthens the trip. */}
                    {canWrite && (() => {
                      const idx = dayIdx(av.day);
                      if (idx >= windowDays) {
                        return <span className="pointer-events-none absolute right-1 rounded bg-white/80 px-1 text-[10px] text-gray-500" style={{ top: btnTop + 2 }}>Free from {dayLabel(av.day)} →</span>;
                      }
                      const at = Math.max(0, idx);
                      const style = at >= windowDays - 2 ? { right: 4, top: btnTop } : { left: `calc(${(at / windowDays) * 100}% + 4px)`, top: btnTop };
                      return (
                        <div className="absolute z-10 flex items-center gap-1" style={style}>
                          <button type="button" onClick={() => openAssign(v, av.day)}
                            className="rounded-md border border-emerald-300 bg-emerald-50 px-2 py-0.5 text-[11px] font-semibold leading-tight text-emerald-700 hover:bg-emerald-100"
                            title={av.day === todayIso ? "Available now - assign an order" : `Available from ${dayLabel(av.day)} - assign an order`}>
                            Assign
                          </button>
                          {av.extendTrip && (
                            <button type="button" onClick={() => openExtend(v, av.extendTrip!)}
                              className="rounded-md border border-amber-300 bg-white px-2 py-0.5 text-[11px] font-semibold leading-tight text-amber-800 hover:bg-amber-50"
                              title={`Extend order #${av.extendTrip.orderNumber} (a reason is asked)`}>
                              Extend
                            </button>
                          )}
                        </div>
                      );
                    })()}
                    {/* Today's highlight, drawn LAST so it sits on top of the dots instead of being hidden underneath - pointer-events-none so it never blocks a click. */}
                    {todayInView && (
                      <div
                        className="pointer-events-none absolute top-0 h-full border-l-2 border-blue-500/70 bg-[#001d6e]/[0.04]"
                        style={{ left: `${(todayIdx / windowDays) * 100}%`, width: `${100 / windowDays}%` }}
                      />
                    )}
                  </div>
                </div>
              );
            })}
            {vehicles.length === 0 && (
              <div className="px-4 py-10 text-center text-sm text-gray-400">No Krupa fleet vehicles found.</div>
            )}
          </div>
        </div>
      )}

      {/* Stays open until the Notion sync has finished; no progress count is available for this
          one, so it just says it's running. */}
      <SyncProgressDialog open={syncMutation.isPending} title="Refreshing from Notion…" />
      <ResetPlanningDialog open={resetOpen} onOpenChange={setResetOpen} onRefreshNow={() => syncMutation.mutate()} />

      <Dialog open={!!assignTarget} onOpenChange={(open) => { if (!open) setAssignTarget(null); }}>
        <DialogContent className="sm:max-w-lg max-w-[calc(100vw-1rem)] overflow-x-hidden [&>*]:min-w-0">
          {(() => {
            const data = availableOrdersQuery.data;
            const info = data?.vehicle;
            const shownDate = assignDate || data?.date || "";
            const rowButton = (o: AvailableOrder, extra?: ReactNode) => {
              const blocked = !!o.beforeFree && !isAdmin;
              const picked = assignPick?.orderNumber === o.orderNumber;
              return (
                <button
                  key={o.orderNumber}
                  type="button"
                  disabled={assignMutation.isPending || blocked}
                  onClick={() => setAssignPick(o)}
                  title={o.beforeFree ? (isAdmin ? "Starts before this vehicle is free - an admin can still assign it" : "Starts before this vehicle is free") : undefined}
                  className={`flex w-full items-center justify-between gap-2 rounded-lg border px-3 py-2 text-left ${picked ? "border-[#001d6e] bg-[#001d6e]/5" : "border-gray-200 hover:bg-[#001d6e]/5"} ${o.beforeFree ? "opacity-50" : ""} disabled:cursor-not-allowed`}
                >
                  <div className="min-w-0">
                    <div className="text-sm font-semibold text-[#001d6e]">#{o.orderNumber} <span className="text-xs font-normal text-gray-400">{o.orderDate ? dayLabel(o.orderDate.slice(0, 10)) : ""}</span></div>
                    <div className="truncate text-xs text-gray-500">
                      {o.partyName ?? "—"} · {o.plant ?? "—"}
                    </div>
                  </div>
                  {extra}
                </button>
              );
            };
            return (
              <>
                <DialogHeader>
                  <DialogTitle className="flex items-center gap-1.5"><Truck className="h-4 w-4" /> Assign {assignTarget?.vehicleNumber}</DialogTitle>
                  <DialogDescription>
                    {!data ? "Loading…" : info?.busyUntil
                      ? <>Busy until {dayLabel(info.busyUntil)}{info.busyOrder ? ` (order #${info.busyOrder})` : ""}. Free from {dayLabel(info.freeFrom!)}.</>
                      : "This vehicle is free."}
                  </DialogDescription>
                  {(assignTarget?.volume != null || assignTarget?.bodyType) && (
                    <p className="text-xs text-gray-500">{assignTarget?.volume != null ? `Volume ${assignTarget.volume}` : ""}{assignTarget?.bodyType ? `${assignTarget?.volume != null ? " · " : ""}Body type ${assignTarget.bodyType}` : ""}</p>
                  )}
                </DialogHeader>

                {(data?.suggestions?.length ?? 0) > 0 && (
                  <div className="space-y-1.5">
                    <div className="text-[11px] font-semibold uppercase tracking-wide text-gray-500">Suggested - not assigned yet, within 7 days of the free date</div>
                    <div className="max-h-40 space-y-1.5 overflow-y-auto">
                      {data!.suggestions.map((s) => rowButton(s,
                        <div className="shrink-0 text-right text-[10px] leading-tight">
                          {s.samePlant && <div className="text-sky-600">same plant</div>}
                          {s.fits ? <div className="text-emerald-600">fits</div> : <div className="text-red-600">runs into #{s.runsInto}</div>}
                        </div>))}
                    </div>
                  </div>
                )}

                {(data?.sharable?.length ?? 0) > 0 && (
                  <div className="space-y-1.5">
                    <div className="text-[11px] font-semibold uppercase tracking-wide text-gray-500">On the same dates as a trip on this vehicle - add it to that trip (shared load)</div>
                    <div className="max-h-44 space-y-1.5 overflow-y-auto">
                      {data!.sharable!.map((o) => (
                        <div key={o.orderNumber} className="flex items-center justify-between gap-2 rounded-lg border border-sky-200 bg-sky-50/60 px-3 py-2">
                          <div className="min-w-0">
                            <div className="text-sm font-semibold text-[#001d6e]">#{o.orderNumber} <span className="text-xs font-normal text-gray-400">{o.orderDate ? dayLabel(o.orderDate.slice(0, 10)) : ""}</span></div>
                            <div className="truncate text-xs text-gray-500">{o.partyName ?? "—"} · {o.plant ?? "—"}</div>
                            <div className="truncate text-[11px] text-sky-800">Joins #{o.joinOrder}{o.joinParty ? ` (${o.joinParty})` : ""}</div>
                          </div>
                          <Button size="sm" variant="outline" className="h-7 shrink-0 border-sky-300 px-2.5 text-xs" disabled={assignMutation.isPending}
                            onClick={() => assignMutation.mutate({ orderNumber: o.orderNumber, sameTripAs: o.joinOrder })}>
                            Add to trip
                          </Button>
                        </div>
                      ))}
                    </div>
                  </div>
                )}

                <div className="space-y-1.5">
                  <div className="text-[11px] font-semibold uppercase tracking-wide text-gray-500">Or pick another free order</div>
                  <div className="flex gap-2">
                    <Input type="date" value={shownDate} onChange={(e) => setAssignDate(e.target.value)} className="h-9 w-40" />
                    <Input value={assignSearch} onChange={(e) => setAssignSearch(e.target.value)} placeholder="Order no. or party" className="h-9 flex-1" />
                  </div>
                  <div className="max-h-44 space-y-1.5 overflow-y-auto">
                    {availableOrdersQuery.isLoading ? (
                      <SectionSkeleton lines={3} />
                    ) : (data?.orders ?? []).length === 0 ? (
                      <p className="py-4 text-center text-sm text-gray-400">No free orders for this date (an order already on a vehicle is not listed).</p>
                    ) : (
                      data!.orders.map((o) => rowButton(o, o.beforeFree ? <span className="shrink-0 text-[10px] text-gray-500">before free date</span> : undefined))
                    )}
                  </div>
                </div>

                {/* Driver: the vehicle's last driver unless changed. Written to our slip and to Notion's "Driver :". */}
                <div className="space-y-1">
                  <div className="text-[11px] font-semibold uppercase tracking-wide text-gray-500">Driver</div>
                  <div className="flex gap-2">
                    <Input
                      list="vp-driver-list"
                      value={effectiveDriver}
                      onChange={(e) => setDriverText(e.target.value)}
                      placeholder="Driver name"
                      className="h-9 flex-1"
                    />
                    <datalist id="vp-driver-list">{driverList.map((d) => <option key={d.id} value={d.name} />)}</datalist>
                    <Button
                      type="button" variant="outline" size="sm" className="h-9 shrink-0 text-xs"
                      disabled={!assignPick || fetchDriverMutation.isPending}
                      title={assignPick ? "Read the driver Notion already has on this order" : "Pick an order first"}
                      onClick={() => assignPick && fetchDriverMutation.mutate(assignPick.orderNumber)}
                    >
                      {fetchDriverMutation.isPending ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : "Get from Notion"}
                    </Button>
                  </div>
                  <p className="text-[11px] text-gray-400">
                    {effectiveDriver.trim() === "" ? "No driver will be set." : matchedDriverId ? "Will also be set on the Notion order." : driversQuery.data?.message ?? "Not in the Notion driver list - saved here only."}
                  </p>
                </div>

                <DialogFooter className="gap-2 sm:gap-2">
                  <Button variant="outline" onClick={() => setAssignTarget(null)} disabled={assignMutation.isPending}>Cancel</Button>
                  <Button disabled={!assignPick || assignMutation.isPending} onClick={() => assignPick && assignMutation.mutate({ orderNumber: assignPick.orderNumber })}>
                    {assignMutation.isPending ? <Loader2 className="h-4 w-4 animate-spin" /> : assignPick ? `Assign #${assignPick.orderNumber}` : "Assign"}
                  </Button>
                </DialogFooter>
              </>
            );
          })()}
        </DialogContent>
      </Dialog>

      {/* The order starts before the vehicle is back: join a running trip (shared load), mark the older trip arrived, or (an admin) go ahead anyway. */}
      {renderNotFree(assignAsk, setAssignAsk, assignMutation.isPending, (o) => assignAsk && assignMutation.mutate({ orderNumber: assignAsk.orderNumber, ...o }), "Assign anyway")}

      {/* A trip bar was clicked: its details, and Arrived / Undo arrival. */}
      <Dialog open={!!tripTarget} onOpenChange={(open) => { if (!open) setTripTarget(null); }}>
        <DialogContent className="sm:max-w-lg max-w-[calc(100vw-1rem)] overflow-x-hidden [&>*]:min-w-0">
          {tripTarget && (() => {
            const { vehicle: v, trip: t } = tripTarget;
            const inConflict = (v.conflicts ?? []).find((c) => c.orderNumber === t.orderNumber);
            return (
              <>
                <DialogHeader>
                  <DialogTitle className="flex items-center gap-1.5"><Truck className="h-4 w-4" /> {v.vehicleNumber} · order #{t.orderNumber}</DialogTitle>
                  <DialogDescription>{t.partyName ?? "—"}{t.plant ? ` · ${t.plant}` : ""}</DialogDescription>
                </DialogHeader>
                <div className="space-y-1.5 text-sm">
                  {inConflict && (
                    <div className="flex items-start gap-1.5 rounded-lg border border-red-200 bg-red-50 px-3 py-2 text-xs text-red-700">
                      <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0" />
                      <span>Vehicle not back yet: order #{inConflict.withOrderNumber} keeps it until {dayLabel(inConflict.withLastBusyDay)}, but this order starts {dayLabel(inConflict.startDay)}.</span>
                    </div>
                  )}
                  {t.members.length > 1 && (
                    <div className="rounded-lg border border-sky-200 bg-sky-50 px-3 py-2 text-xs text-sky-900">
                      <div className="mb-1 font-semibold">Shared load - {t.members.length} orders on one trip</div>
                      {t.members.map((m) => (
                        <div key={m.orderNumber} className="flex flex-wrap justify-between gap-x-3">
                          <span>#{m.orderNumber} · {m.partyName ?? "—"}{m.plant ? ` · ${m.plant}` : ""}</span>
                          <span className="whitespace-nowrap text-sky-800">{m.tripDays} day{m.tripDays === 1 ? "" : "s"} · ends {dayLabel(m.plannedLastDay)}</span>
                        </div>
                      ))}
                      <div className="mt-1 border-t border-sky-200 pt-1 font-medium">Vehicle free from {dayLabel(t.freeFromDay)} (when the last party is done)</div>
                    </div>
                  )}
                  {t.notionNote && (
                    <div className="flex items-start justify-between gap-2 rounded-lg border border-amber-200 bg-amber-50 px-3 py-2 text-xs text-amber-800">
                      <span>Notion not updated. {t.notionNote}</span>
                      {canWrite && (
                        <Button size="sm" variant="outline" className="h-7 shrink-0 px-2 text-xs" disabled={retryNotionMutation.isPending} onClick={() => retryNotionMutation.mutate(t.orderNumber)}>
                          {retryNotionMutation.isPending ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : "Retry"}
                        </Button>
                      )}
                    </div>
                  )}
                  <div className="grid grid-cols-2 gap-x-3 gap-y-1 text-xs text-gray-700">
                    <span className="text-gray-500">State</span><span>{stateText[t.state]}</span>
                    <span className="text-gray-500">Order date</span><span>{dayLabel(t.startDay)}</span>
                    <span className="text-gray-500">Trip days</span><span>{t.tripDays}</span>
                    <span className="text-gray-500">Planned last day</span><span>{dayLabel(t.plannedLastDay)}</span>
                    {t.members.length <= 1 && <><span className="text-gray-500">Vehicle free from</span><span>{dayLabel(t.freeFromDay)}</span></>}
                    {t.expectedEnd && <><span className="text-gray-500">Expected last day</span><span>{dayLabel(t.expectedEnd)}</span></>}
                    {t.expectedEnd && t.expectedEndReason && <><span className="text-gray-500">Extended because</span><span>{t.expectedEndReason}</span></>}
                    {t.arrivedOn && <><span className="text-gray-500">Arrived on</span><span>{dayLabel(t.arrivedOn)}{t.freeSameDay ? " (free the same day)" : ""}</span></>}
                    <span className="text-gray-500">Driver</span><span>{t.driver ?? "—"}</span>
                  </div>
                </div>
                <DialogFooter className="flex-wrap gap-2 sm:justify-end sm:gap-2 sm:space-x-0">
                  <Button variant="outline" onClick={() => setTripTarget(null)}>Close</Button>
                  {canWrite && t.arrivedOn && (
                    <Button variant="outline" disabled={arrivalMutation.isPending} onClick={() => arrivalMutation.mutate({ vehicleId: v.id, orderNumber: t.orderNumber, undo: true })}>
                      <Undo2 className="mr-1.5 h-4 w-4" /> Undo arrival
                    </Button>
                  )}
                  {canWrite && inConflict && (() => {
                    const blocker = v.trips?.find((x) => x.orderNumber === inConflict.withOrderNumber);
                    return blocker && !blocker.arrivedOn && (blocker.state === "on_trip" || blocker.state === "awaiting") ? (
                      <Button variant="outline" onClick={() => arriveToday(v, blocker)}>Mark #{blocker.orderNumber} arrived today</Button>
                    ) : null;
                  })()}
                  {canWrite && !t.arrivedOn && t.state !== "closed" && t.state !== "cancelled" && !t.notInSystem && (
                    <Button variant="outline" onClick={() => { setTripTarget(null); setChangeTarget({ vehicle: v, trip: t }); }}>Change</Button>
                  )}
                  {canWrite && !t.arrivedOn && t.state !== "closed" && t.state !== "cancelled" && (
                    <Button variant="outline" className="border-red-200 text-red-600 hover:bg-red-50 hover:text-red-700" disabled={!!t.lockedReason} title={t.lockedReason ?? undefined}
                      onClick={() => { setTripTarget(null); openFree(v, [t]); }}>Free</Button>
                  )}
                  {canWrite && !t.arrivedOn && (t.state === "on_trip" || t.state === "awaiting" || t.state === "planned" || (t.state === "closed" && t.assumed && isoDayDiff(t.lastBusyDay, isoOf(new Date())) <= 7)) && (
                    <Button variant="outline" onClick={() => { setTripTarget(null); openExtend(v, t); }}>{t.state === "closed" ? "Extend (still out)" : "Extend"}</Button>
                  )}
                  {canWrite && !t.arrivedOn && t.state !== "planned" && t.state !== "cancelled" && t.state !== "closed" && (
                    <Button disabled={arrivalMutation.isPending} onClick={() => arriveToday(v, t)}>
                      <CheckCircle2 className="mr-1.5 h-4 w-4" /> Arrived today
                    </Button>
                  )}
                </DialogFooter>
              </>
            );
          })()}
        </DialogContent>
      </Dialog>

      {/* Day note: what happens with this vehicle on this day. Our board only. */}
      <Dialog open={!!noteTarget} onOpenChange={(open) => { if (!open && !noteMutation.isPending) setNoteTarget(null); }}>
        <DialogContent className="sm:max-w-md max-w-[calc(100vw-1rem)] overflow-x-hidden [&>*]:min-w-0">
          {noteTarget && (() => {
            const existing = (noteTarget.vehicle.dayNotes ?? []).find((n) => n.day === noteTarget.day);
            return (
              <>
                <DialogHeader>
                  <DialogTitle className="flex items-center gap-1.5"><MessageSquare className="h-4 w-4" /> {noteTarget.vehicle.vehicleNumber} · {format(parse(noteTarget.day, "yyyy-MM-dd", new Date()), "EEEE d MMM")}</DialogTitle>
                  <DialogDescription>{canWrite ? "A note for this vehicle on this day. Only our board; Notion is not changed." : "Note for this vehicle on this day."}</DialogDescription>
                </DialogHeader>
                {canWrite ? (
                  <Textarea value={noteText} onChange={(e) => setNoteText(e.target.value)} maxLength={500} rows={4} autoFocus placeholder="For example: breakdown at Surat, driver on leave, service due" />
                ) : (
                  <div className="whitespace-pre-wrap rounded-lg border border-gray-200 bg-gray-50 px-3 py-2 text-sm">{existing?.text}</div>
                )}
                {existing && <div className="text-[11px] text-gray-500">Written by {existing.byName ?? "—"}, {new Date(existing.at).toLocaleString("en-IN", { timeZone: "Asia/Kolkata", day: "2-digit", month: "short", hour: "numeric", minute: "2-digit", hour12: true })}</div>}
                <DialogFooter className="gap-2 sm:gap-2">
                  {canWrite && existing && (
                    <Button variant="outline" className="mr-auto border-red-200 text-red-600 hover:bg-red-50 hover:text-red-700" disabled={noteMutation.isPending}
                      onClick={() => noteMutation.mutate({ vehicleId: noteTarget.vehicle.id, day: noteTarget.day, text: "" })}>Delete</Button>
                  )}
                  <Button variant="outline" disabled={noteMutation.isPending} onClick={() => setNoteTarget(null)}>{canWrite ? "Cancel" : "Close"}</Button>
                  {canWrite && (
                    <Button disabled={noteMutation.isPending || !noteText.trim() || noteText.trim() === (existing?.text ?? "")}
                      onClick={() => noteMutation.mutate({ vehicleId: noteTarget.vehicle.id, day: noteTarget.day, text: noteText })}>
                      {noteMutation.isPending ? <Loader2 className="h-4 w-4 animate-spin" /> : "Save note"}
                    </Button>
                  )}
                </DialogFooter>
              </>
            );
          })()}
        </DialogContent>
      </Dialog>

      {/* Free: take the vehicle off one or several orders (assigned by mistake). Each order goes back to "no vehicle"; the vehicle and driver are cleared on our slip
          (when we have one) and in Notion. An order Loading has taken over is greyed out with its reason. */}
      <Dialog open={!!freeAsk} onOpenChange={(open) => { if (!open && !removeMutation.isPending && !freeBusy) setFreeAsk(null); }}>
        <DialogContent className="sm:max-w-md max-w-[calc(100vw-1rem)] overflow-x-hidden [&>*]:min-w-0">
          {freeAsk && (() => {
            const single = freeAsk.options.length === 1 ? freeAsk.options[0] : null;
            const chosen = freeAsk.options.filter((o) => freeAsk.orders.includes(o.orderNumber));
            const unlocked = freeAsk.options.filter((o) => !o.locked);
            const busy = removeMutation.isPending || freeBusy;
            const toggle = (no: string) => setFreeAsk({ ...freeAsk, orders: freeAsk.orders.includes(no) ? freeAsk.orders.filter((x) => x !== no) : [...freeAsk.orders, no] });
            return (
              <>
                <DialogHeader>
                  <DialogTitle className="flex items-center gap-1.5"><Truck className="h-4 w-4" /> {single ? `Free ${freeAsk.vehicle.vehicleNumber}` : "Which order do you want to free?"}</DialogTitle>
                  <DialogDescription>
                    {single
                      ? `Take ${freeAsk.vehicle.vehicleNumber} off order #${single.orderNumber}${single.partyName ? ` (${single.partyName})` : ""}? Use this when it was assigned by mistake.`
                      : `${freeAsk.vehicle.vehicleNumber} has ${freeAsk.options.length} orders. Tick the one(s) to take it off - for example one assigned by mistake. The others stay.`}
                  </DialogDescription>
                </DialogHeader>
                {!single && (
                  <div className="space-y-1.5">
                    {unlocked.length > 1 && (
                      <div className="flex justify-end text-[11px]">
                        <button type="button" className="text-[#001d6e] underline decoration-dotted" onClick={() => setFreeAsk({ ...freeAsk, orders: freeAsk.orders.length === unlocked.length ? [] : unlocked.map((o) => o.orderNumber) })}>
                          {freeAsk.orders.length === unlocked.length ? "Clear" : "Select all"}
                        </button>
                      </div>
                    )}
                    {freeAsk.options.map((o) => {
                      const on = freeAsk.orders.includes(o.orderNumber);
                      return (
                        <button key={o.orderNumber} type="button" disabled={!!o.locked || busy} onClick={() => toggle(o.orderNumber)} aria-pressed={on}
                          className={`flex w-full items-start gap-2 rounded-lg border px-3 py-2 text-left text-xs disabled:cursor-not-allowed disabled:bg-gray-50 disabled:text-gray-400 ${on ? "border-red-400 bg-red-50 text-red-800" : "border-gray-200 hover:bg-gray-50"}`}>
                          <span className={`mt-0.5 flex h-4 w-4 shrink-0 items-center justify-center rounded border ${on ? "border-red-500 bg-red-500 text-white" : "border-gray-300 bg-white"}`}>{on && <CheckCircle2 className="h-3 w-3" />}</span>
                          <span className="min-w-0 flex-1">
                            <span className="flex items-center justify-between gap-2">
                              <span className="font-medium">#{o.orderNumber}</span>
                              <span className="truncate text-gray-600">{o.partyName ?? "—"}</span>
                            </span>
                            <span className="block text-[11px] text-gray-500">{dayLabel(o.startDay)} – {dayLabel(o.lastBusyDay)}{o.notInSystem ? " · only in Notion" : ""}</span>
                            {o.locked && <span className="block text-[11px] text-red-600">{o.locked}</span>}
                          </span>
                        </button>
                      );
                    })}
                  </div>
                )}
                {single?.locked && <div className="rounded-lg border border-red-200 bg-red-50 px-3 py-2 text-xs text-red-700">{single.locked}</div>}
                <div className="rounded-lg border border-blue-200 bg-blue-50 px-3 py-2 text-xs text-blue-800">
                  Each freed order goes back to "no vehicle" and its driver is cleared too. Notion's vehicle and driver are cleared to match; its status is not changed.
                  {chosen.some((o) => o.notInSystem) && " An order that is only in Notion (not in our system) is cleared in Notion as well - otherwise the next Refresh would bring it back."}
                </div>
                <DialogFooter className="gap-2 sm:gap-2">
                  <Button variant="outline" disabled={busy} onClick={() => setFreeAsk(null)}>No</Button>
                  <Button className="bg-red-600 hover:bg-red-700" disabled={busy || chosen.length === 0 || chosen.some((o) => !!o.locked)} onClick={() => void freeSelected()}>
                    {busy ? <Loader2 className="h-4 w-4 animate-spin" /> : chosen.length > 1 ? `Free selected (${chosen.length})` : "Yes, free the vehicle"}
                  </Button>
                </DialogFooter>
              </>
            );
          })()}
        </DialogContent>
      </Dialog>

      {/* A dot was clicked: the full details of that assignment (the whole party name, dates, days, status, driver ...), then Details for the actions. */}
      {dotCard && (() => {
        const { vehicle, trip, member } = dotCard;
        const row = (label: string, value: ReactNode, tone = "text-gray-700") => (
          <><span className="text-gray-400">{label}</span><span className={`min-w-0 break-words ${tone}`}>{value}</span></>
        );
        const extended = !!trip.expectedEnd && trip.expectedEnd > trip.plannedLastDay;
        return (
          <>
            <div className="fixed inset-0 z-40" onClick={() => setDotCard(null)} />
            <div
              className="fixed z-50 max-h-[80vh] w-80 overflow-y-auto rounded-lg border border-gray-200 bg-white p-3 text-xs shadow-xl"
              style={{ left: Math.max(8, Math.min(dotCard.x - 160, window.innerWidth - 328)), top: Math.max(8, Math.min(dotCard.y + 8, window.innerHeight - 420)) }}
            >
              <div className="flex items-start justify-between gap-2">
                <div className="min-w-0">
                  <div className="flex flex-wrap items-center gap-1.5">
                    <span className="text-sm font-semibold text-[#001d6e]">#{member.orderNumber}</span>
                    <span className="rounded-full bg-gray-100 px-2 py-0.5 text-[10px] font-semibold text-gray-700">{stateText[trip.state]}</span>
                  </div>
                  <div className="mt-1 break-words text-sm font-semibold leading-snug text-gray-900">{member.partyName ?? "—"}</div>
                </div>
                <button type="button" className="shrink-0 rounded p-0.5 text-gray-400 hover:bg-gray-100 hover:text-gray-700" aria-label="Close" onClick={() => setDotCard(null)}><X className="h-4 w-4" /></button>
              </div>
              <div className="mt-2.5 grid grid-cols-[6.5rem,1fr] gap-x-3 gap-y-1">
                {row("Vehicle", vehicle.vehicleNumber ?? "—")}
                {row("Plant", `${member.plant ?? "—"}${vehicle.state ? `, ${vehicle.state}` : ""}`)}
                {row("Order date", member.startDay ? dayLabel(member.startDay) : "—")}
                {row("Trip days", `${member.tripDays} day${member.tripDays === 1 ? "" : "s"}`)}
                {row("Planned last day", dayLabel(member.plannedLastDay))}
                {extended && row("Extended to", `${dayLabel(trip.expectedEnd!)}${trip.expectedEndReason ? ` · ${trip.expectedEndReason}` : ""}`, "font-medium text-violet-700")}
                {trip.arrivedOn && row("Arrived on", `${dayLabel(trip.arrivedOn)}${trip.freeSameDay ? " (can go out the same day)" : ""}`, "text-emerald-700")}
                {row("Vehicle free from", dayLabel(trip.freeFromDay))}
                {row("Notion status", member.status ?? "—")}
                {row("Driver", member.driver ?? trip.driver ?? "—")}
                {row("In our system", member.notInSystem ? "No - only in Notion (no slip here)" : "Yes", member.notInSystem ? "text-amber-700" : "text-gray-700")}
              </div>
              {trip.members.length > 1 && (
                <div className="mt-2 rounded bg-sky-50 px-2 py-1.5 text-[11px] text-sky-900">
                  <div className="font-semibold">Shared load - {trip.members.length} orders on one trip</div>
                  {trip.members.filter((m) => m.orderNumber !== member.orderNumber).map((m) => (
                    <div key={m.orderNumber} className="break-words">#{m.orderNumber} · {m.partyName ?? "—"} · {m.tripDays} day{m.tripDays === 1 ? "" : "s"}, ends {dayLabel(m.plannedLastDay)}</div>
                  ))}
                </div>
              )}
              {trip.lockedReason && <div className="mt-2 rounded bg-gray-50 px-2 py-1.5 text-[11px] text-gray-600">{trip.lockedReason}</div>}
              {trip.notionNote && <div className="mt-2 rounded bg-amber-50 px-2 py-1.5 text-[11px] text-amber-800">Notion not updated. {trip.notionNote}</div>}
              <div className="mt-3 flex justify-end">
                <Button size="sm" variant="outline" className="h-7 px-3 text-xs" onClick={() => { setDotCard(null); setTripTarget({ vehicle, trip }); }}>Details and actions</Button>
              </div>
            </div>
          </>
        );
      })()}

      {/* Vehicle status: what the board says about the vehicle today, one-click Arrived / Extend, and a status set here (parking, maintenance, breakdown). Our system only. */}
      <Dialog open={!!statusTarget} onOpenChange={(open) => { if (!open && !statusMutation.isPending) setStatusTarget(null); }}>
        <DialogContent className="sm:max-w-lg max-w-[calc(100vw-1rem)] overflow-x-hidden [&>*]:min-w-0">
          {statusTarget && (() => {
            const sv = allVehicles.find((x) => x.id === statusTarget.id) ?? statusTarget;
            const todayIso = isoOf(new Date());
            const cs = computeStatus(sv, todayIso);
            const av = computeAvailability(sv, todayIso);
            const at = actionTrips(sv);
            return (
              <>
                <DialogHeader>
                  <DialogTitle className="flex items-center gap-1.5"><Truck className="h-4 w-4" /> {sv.vehicleNumber} · status</DialogTitle>
                  <DialogDescription>
                    <span className={`inline-block rounded-full px-2 py-0.5 text-xs font-semibold ${cs.tone}`}>{cs.label}</span>
                    {cs.note && <span className="ml-2 text-xs text-gray-500">{cs.note}</span>}
                  </DialogDescription>
                  {(sv.volume != null || sv.bodyType) && (
                    <p className="text-xs text-gray-500">{sv.volume != null ? `Volume ${sv.volume}` : ""}{sv.bodyType ? `${sv.volume != null ? " · " : ""}Body type ${sv.bodyType}` : ""}</p>
                  )}
                </DialogHeader>
                {canWrite && (at.out || av.extendTrip) && (
                  <div className="flex flex-wrap gap-2">
                    {at.out && (
                      <Button size="sm" disabled={arrivalMutation.isPending} onClick={() => arriveToday(sv, at.out!)}>
                        <CheckCircle2 className="mr-1.5 h-4 w-4" /> Arrived today
                      </Button>
                    )}
                    {av.extendTrip && <Button size="sm" variant="outline" onClick={() => { setStatusTarget(null); openExtend(sv, av.extendTrip!); }}>Extend</Button>}
                  </div>
                )}
                {canWrite ? (
                  <div className="space-y-2.5">
                    <div className="text-[11px] font-semibold uppercase tracking-wide text-gray-500">Set a status</div>
                    <div className="flex flex-wrap gap-1.5">
                      {MANUAL_STATUSES.map((s) => (
                        <button key={s} type="button" onClick={() => setStPick(s)}
                          className={`rounded-full px-3 py-1 text-xs font-medium ${stPick === s ? "bg-[#001d6e] text-white" : "border border-gray-200 bg-white text-gray-600 hover:bg-gray-50"}`}>
                          {s}
                        </button>
                      ))}
                    </div>
                    <div className="flex flex-wrap items-end gap-3">
                      <div className="space-y-1">
                        <label className="text-xs font-semibold text-gray-700">Days <span className="text-red-500">*</span></label>
                        <Input type="number" min={1} max={365} value={stDays} onChange={(e) => changeStDays(e.target.value)} placeholder="e.g. 3" className="h-8 w-24 text-xs" />
                      </div>
                      <span className="pb-2 text-xs text-gray-400">or</span>
                      <div className="space-y-1">
                        <label className="text-xs font-semibold text-gray-700">Available again from</label>
                        <Input type="date" value={stFrom} min={format(addDays(new Date(), 1), "yyyy-MM-dd")} onChange={(e) => changeStFrom(e.target.value)} className="h-8 w-40 text-xs" />
                      </div>
                    </div>
                    <p className="text-[11px] text-gray-500">The vehicle is not available until then, and the Available filter leaves it out. Days count from today.</p>
                    <Textarea value={stComment} onChange={(e) => setStComment(e.target.value)} maxLength={300} rows={2} placeholder="Comment (for example: gearbox repair at the showroom)" />
                    <p className="text-[11px] text-gray-400">Only on this page. Notion is not changed.</p>
                  </div>
                ) : sv.manualStatus?.comment ? (
                  <div className="whitespace-pre-wrap rounded-lg border border-gray-200 bg-gray-50 px-3 py-2 text-sm">{sv.manualStatus.comment}</div>
                ) : null}
                <DialogFooter className="flex-wrap gap-2 sm:justify-end sm:gap-2 sm:space-x-0">
                  {canWrite && sv.manualStatus && (
                    <Button variant="outline" className="border-red-200 text-red-600 hover:bg-red-50 hover:text-red-700" disabled={statusMutation.isPending}
                      onClick={() => statusMutation.mutate({ vehicleId: sv.id, status: null, days: 0, comment: "" })}>Clear status</Button>
                  )}
                  {canWrite && isAdmin && av.blocked && (
                    <Button variant="outline" onClick={() => { setStatusTarget(null); openAssign(sv); }}>Assign anyway</Button>
                  )}
                  <Button variant="outline" disabled={statusMutation.isPending} onClick={() => setStatusTarget(null)}>{canWrite ? "Cancel" : "Close"}</Button>
                  {canWrite && (
                    <Button disabled={!stPick || !(Math.floor(Number(stDays)) >= 1) || statusMutation.isPending}
                      onClick={() => statusMutation.mutate({ vehicleId: sv.id, status: stPick, days: Math.floor(Number(stDays)), comment: stComment })}>
                      {statusMutation.isPending ? <Loader2 className="h-4 w-4 animate-spin" /> : "Save status"}
                    </Button>
                  )}
                </DialogFooter>
              </>
            );
          })()}
        </DialogContent>
      </Dialog>

      {/* Why is the trip extended? Asked whenever a trip's last day moves later; then the clash question below, if the longer trip runs into the next one. */}
      <ExtendReasonDialog
        ask={extendAsk ? {
          vehicleNumber: extendAsk.vehicle.vehicleNumber,
          orders: extendAsk.trip.members.map((m) => m.orderNumber),
          oldEnd: extendAsk.trip.lastBusyDay,
          newEnd: extendAsk.newEnd,
          extraDays: Math.max(1, differenceInCalendarDays(parse(extendAsk.newEnd, "yyyy-MM-dd", new Date()), parse(extendAsk.trip.lastBusyDay, "yyyy-MM-dd", new Date()))),
        } : null}
        pending={expectedEndMutation.isPending}
        onCancel={() => setExtendAsk(null)}
        onNewEnd={(day) => setExtendAsk((p) => (p ? { ...p, newEnd: day } : p))}
        onConfirm={(reason) => {
          if (!extendAsk) return;
          const { vehicle, trip, newEnd } = extendAsk;
          const clashes = clashesFor(vehicle, trip, newEnd);
          if (clashes.length > 0) { setExtendAsk(null); setStretchAsk({ vehicle, trip, newEnd, clashes, reason }); return; }
          expectedEndMutation.mutate({ vehicleId: vehicle.id, orderNumber: trip.orderNumber, expectedEnd: newEnd, reason });
        }}
      />

      {/* A stretch that runs into the next trip. Nothing is blocked: the planner decides. */}
      <Dialog open={!!stretchAsk} onOpenChange={(open) => { if (!open && !expectedEndMutation.isPending) setStretchAsk(null); }}>
        <DialogContent className="sm:max-w-md max-w-[calc(100vw-1rem)] overflow-x-hidden [&>*]:min-w-0">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-1.5"><AlertTriangle className="h-4 w-4 text-red-500" /> Vehicle not back in time</DialogTitle>
            <DialogDescription>
              {stretchAsk && (
                <>
                  If order #{stretchAsk.trip.orderNumber} runs until {dayLabel(stretchAsk.newEnd)}, {stretchAsk.vehicle.vehicleNumber} is still busy when{" "}
                  {stretchAsk.clashes.map((c) => `order #${c.orderNumber} (starts ${dayLabel(c.startDay)})`).join(", ")} start{stretchAsk.clashes.length === 1 ? "s" : ""}.
                </>
              )}
            </DialogDescription>
          </DialogHeader>
          {canWrite && stretchAsk && (
            <div className="flex flex-col gap-2 sm:flex-row">
              <Button variant="outline" className="flex-1 text-xs" disabled={expectedEndMutation.isPending || removeMutation.isPending}
                onClick={async () => {
                  const { vehicle, trip, newEnd, clashes, reason } = stretchAsk;
                  try {
                    await expectedEndMutation.mutateAsync({ vehicleId: vehicle.id, orderNumber: trip.orderNumber, expectedEnd: newEnd, reason });
                    removeMutation.mutate({ vehicleId: vehicle.id, orderNumber: clashes[0].orderNumber });
                  } catch { /* the mutation already showed its error */ }
                }}>
                Remove #{stretchAsk.clashes[0].orderNumber} from this vehicle
              </Button>
              <Button variant="outline" className="flex-1 text-xs" disabled={expectedEndMutation.isPending}
                onClick={async () => {
                  const { vehicle, trip, newEnd, clashes, reason } = stretchAsk;
                  try {
                    await expectedEndMutation.mutateAsync({ vehicleId: vehicle.id, orderNumber: trip.orderNumber, expectedEnd: newEnd, reason });
                    setChangeTarget({ vehicle, trip: clashes[0] });
                  } catch { /* the mutation already showed its error */ }
                }}>
                Move #{stretchAsk.clashes[0].orderNumber} to another vehicle
              </Button>
            </div>
          )}
          <DialogFooter className="gap-2 sm:gap-2">
            <Button variant="outline" disabled={expectedEndMutation.isPending} onClick={() => setStretchAsk(null)}>Cancel the stretch</Button>
            <Button
              disabled={expectedEndMutation.isPending}
              onClick={() => stretchAsk && expectedEndMutation.mutate({ vehicleId: stretchAsk.vehicle.id, orderNumber: stretchAsk.trip.orderNumber, expectedEnd: stretchAsk.newEnd, reason: stretchAsk.reason })}
            >
              {expectedEndMutation.isPending ? <Loader2 className="h-4 w-4 animate-spin" /> : "Keep it (stays red)"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Change plan: move to another vehicle, change the driver, or take the vehicle off. Loading's own orders are refused by the server. */}
      <Dialog open={!!changeTarget} onOpenChange={(open) => { if (!open) setChangeTarget(null); }}>
        <DialogContent className="sm:max-w-lg max-w-[calc(100vw-1rem)] overflow-x-hidden [&>*]:min-w-0">
          {changeTarget && (() => {
            const { vehicle: v, trip: t } = changeTarget;
            const q = moveSearch.trim().toLowerCase();
            const candidates = allVehicles
              .filter((x) => x.id !== v.id && !!x.vehicleNumber && (x.hasHistory || x.showAlways || !!q))
              .filter((x) => !q || [x.vehicleNumber, x.driver, x.rtoNumber].some((f) => (f ?? "").toLowerCase().includes(q)))
              .map((x) => ({ x, busyUntil: x.freeFrom && x.freeFrom > t.startDay ? format(addDays(parse(x.freeFrom, "yyyy-MM-dd", new Date()), -1), "yyyy-MM-dd") : null }))
              .sort((a, b) => Number(!!a.busyUntil) - Number(!!b.busyUntil) || (a.x.vehicleNumber ?? "").localeCompare(b.x.vehicleNumber ?? "", undefined, { numeric: true }))
              .slice(0, 40);
            const driverNow = changeDriverText ?? t.driver ?? "";
            const driverId = driverList.find((d) => d.name.trim().toLowerCase() === driverNow.trim().toLowerCase())?.id
              ?? (changeDriverExtra && changeDriverExtra.name.trim().toLowerCase() === driverNow.trim().toLowerCase() ? changeDriverExtra.id : null);
            const busy = moveMutation.isPending || driverMutation.isPending || removeMutation.isPending;
            return (
              <>
                <DialogHeader>
                  <DialogTitle className="flex items-center gap-1.5"><Truck className="h-4 w-4" /> Change plan · order #{t.orderNumber}</DialogTitle>
                  <DialogDescription>{v.vehicleNumber} · {t.members.map((m) => m.partyName ?? "—").join(" + ")} · starts {dayLabel(t.startDay)}</DialogDescription>
                  {t.members.length > 1 && (
                    <div className="flex flex-wrap items-center gap-1.5 pt-1 text-xs">
                      <span className="text-gray-500">Applies to:</span>
                      <button type="button" onClick={() => setChangeOrder("")} className={chipCls(changeOrder === "")}>Whole trip</button>
                      {t.members.map((m) => <button key={m.orderNumber} type="button" onClick={() => setChangeOrder(m.orderNumber)} className={chipCls(changeOrder === m.orderNumber)}>#{m.orderNumber}</button>)}
                    </div>
                  )}
                </DialogHeader>

                <div className="space-y-1.5">
                  <div className="text-[11px] font-semibold uppercase tracking-wide text-gray-500">Move to another vehicle</div>
                  <Input value={moveSearch} onChange={(e) => setMoveSearch(e.target.value)} placeholder="Search vehicle, driver, RTO" className="h-9" />
                  <div className="max-h-44 space-y-1 overflow-y-auto">
                    {candidates.map(({ x, busyUntil }) => (
                      <button
                        key={x.id} type="button" onClick={() => setMoveDest(x)}
                        className={`flex w-full items-center justify-between gap-2 rounded-lg border px-3 py-1.5 text-left text-xs ${moveDest?.id === x.id ? "border-[#001d6e] bg-[#001d6e]/5" : "border-gray-200 hover:bg-[#001d6e]/5"}`}
                      >
                        <span className="min-w-0 truncate font-semibold text-[#001d6e]">{x.vehicleNumber}<span className="ml-2 font-normal text-gray-500">{x.driver ?? ""}</span></span>
                        {busyUntil ? <span className="shrink-0 text-amber-600">Busy until {dayLabel(busyUntil)}</span> : <span className="text-emerald-600">Free</span>}
                      </button>
                    ))}
                    {candidates.length === 0 && <p className="py-3 text-center text-xs text-gray-400">No vehicles found.</p>}
                  </div>
                  <Button size="sm" disabled={!moveDest || busy} onClick={() => moveDest && moveMutation.mutate({ destId: moveDest.id })}>
                    {moveMutation.isPending ? <Loader2 className="h-4 w-4 animate-spin" /> : moveDest ? `Move ${t.members.length > 1 && !changeOrder ? "whole trip " : ""}to ${moveDest.vehicleNumber}` : "Pick a vehicle"}
                  </Button>
                </div>

                <div className="space-y-1.5 border-t pt-3">
                  <div className="text-[11px] font-semibold uppercase tracking-wide text-gray-500">Driver</div>
                  <div className="flex gap-2">
                    <Input list="vp-change-driver-list" value={driverNow} onChange={(e) => setChangeDriverText(e.target.value)} placeholder="Driver name" className="h-9 flex-1" />
                    <datalist id="vp-change-driver-list">{driverList.map((d) => <option key={d.id} value={d.name} />)}</datalist>
                    <Button
                      size="sm" variant="outline" className="h-9 shrink-0 text-xs" disabled={busy || fetchDriverMutation.isPending}
                      title="Read the driver Notion already has on this order"
                      onClick={async () => { const d = await fetchDriverMutation.mutateAsync(t.orderNumber).catch(() => null); if (d?.driver) { setChangeDriverText(d.driver.name); setChangeDriverExtra(d.driver); } }}
                    >
                      Get from Notion
                    </Button>
                    <Button size="sm" className="h-9 shrink-0" disabled={busy || driverNow.trim() === (t.driver ?? "")}
                      onClick={() => driverMutation.mutate({ vehicleId: v.id, orderNumber: t.orderNumber, driverName: driverNow.trim(), driverPageId: driverId ?? undefined })}>
                      {driverMutation.isPending ? <Loader2 className="h-4 w-4 animate-spin" /> : "Save"}
                    </Button>
                  </div>
                </div>

                <div className="space-y-1.5 border-t pt-3">
                  <div className="text-[11px] font-semibold uppercase tracking-wide text-gray-500">Remove the vehicle</div>
                  {!removeSure ? (
                    <Button size="sm" variant="outline" className="border-red-300 text-red-600 hover:bg-red-50" disabled={busy || (t.members.length > 1 && !changeOrder)} title={t.members.length > 1 && !changeOrder ? "Pick one order above first" : undefined} onClick={() => setRemoveSure(true)}>Remove {v.vehicleNumber} from {t.members.length > 1 ? `order #${changeOrder || "…"}` : "this order"}</Button>
                  ) : (
                    <div className="space-y-2 rounded-lg border border-red-200 bg-red-50 p-3 text-xs text-red-700">
                      <p>This clears the vehicle and the driver on order #{t.orderNumber}, here and in Notion. The order goes back to "no vehicle".</p>
                      <div className="flex gap-2">
                        <Button size="sm" variant="outline" disabled={busy} onClick={() => setRemoveSure(false)}>No</Button>
                        <Button size="sm" className="bg-red-600 hover:bg-red-700" disabled={busy} onClick={() => removeMutation.mutate({ vehicleId: v.id, orderNumber: changeOrder || t.orderNumber })}>
                          {removeMutation.isPending ? <Loader2 className="h-4 w-4 animate-spin" /> : "Yes, remove"}
                        </Button>
                      </div>
                    </div>
                  )}
                </div>

                <DialogFooter><Button variant="outline" onClick={() => setChangeTarget(null)} disabled={busy}>Close</Button></DialogFooter>
              </>
            );
          })()}
        </DialogContent>
      </Dialog>

      {/* The move target is not free before this order starts. */}
      {renderNotFree(moveAsk, setMoveAsk, moveMutation.isPending, (o) => moveAsk && moveMutation.mutate({ destId: moveAsk.destId, ...o }), "Move anyway", !!changeOrder)}

      {/* The vehicle came back earlier than planned. */}
      <Dialog open={!!earlyAsk} onOpenChange={(open) => { if (!open) setEarlyAsk(null); }}>
        <DialogContent className="sm:max-w-sm max-w-[calc(100vw-1rem)] overflow-x-hidden [&>*]:min-w-0">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-1.5"><Truck className="h-4 w-4" /> {earlyAsk?.vehicle.vehicleNumber} is free early</DialogTitle>
            <DialogDescription>
              {earlyAsk?.vehicle.vehicleNumber} is free from {earlyAsk ? dayLabel(earlyAsk.freeFrom) : ""}. {earlyAsk?.waiting} order{earlyAsk?.waiting === 1 ? " is" : "s are"} waiting for a vehicle. Assign?
            </DialogDescription>
          </DialogHeader>
          <DialogFooter className="gap-2 sm:gap-2">
            <Button variant="outline" onClick={() => setEarlyAsk(null)}>Not now</Button>
            <Button onClick={() => { const v = earlyAsk!.vehicle; setEarlyAsk(null); setAssignTarget(v); }}>Assign</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Review: every vehicle's latest order, with whether our system has its slip. Only the ticked ones are created. */}
      <Dialog open={reviewOpen} onOpenChange={(open) => { if (!open && !(reviewRun && !reviewRun.finished)) setReviewOpen(false); }}>
        <DialogContent className="sm:max-w-2xl max-w-[calc(100vw-1rem)] overflow-x-hidden [&>*]:min-w-0">
          {(() => {
            const items = reviewQuery.data?.items ?? [];
            const missing = items.filter((i) => !i.inSystem);
            const running = !!reviewRun && !reviewRun.finished;
            return (
              <>
                <DialogHeader>
                  <DialogTitle className="flex items-center gap-1.5"><DatabaseZap className="h-4 w-4 text-sky-600" /> Review orders from Notion</DialogTitle>
                  <DialogDescription>
                    Each vehicle's latest order as the last Refresh found it. Orders that are not in our system can be created here; only the ones you tick are created, and nothing else is changed.
                  </DialogDescription>
                </DialogHeader>

                {reviewRun ? (
                  <div className="space-y-2 py-2 text-sm">
                    <div className="h-2 overflow-hidden rounded-full bg-gray-100">
                      <div className="h-full bg-emerald-500 transition-all" style={{ width: `${(reviewRun.done / Math.max(1, reviewRun.total)) * 100}%` }} />
                    </div>
                    <p className="font-medium text-gray-800">
                      {reviewRun.finished
                        ? `${reviewRun.created} created${reviewRun.failed.length ? `, ${reviewRun.failed.length} failed` : ""}`
                        : `Creating ${reviewRun.done + 1} of ${reviewRun.total}…`}
                    </p>
                    {reviewRun.failed.map((f) => (
                      <p key={f.orderNumber} className="text-xs text-red-600">#{f.orderNumber}: {f.message}</p>
                    ))}
                  </div>
                ) : (
                  <div className="max-h-[50vh] overflow-auto rounded-lg border border-gray-200">
                    {reviewQuery.isLoading ? <SectionSkeleton lines={4} /> : items.length === 0 ? (
                      <p className="py-8 text-center text-sm text-gray-400">No orders yet. Press Refresh from Notion first.</p>
                    ) : (
                      <table className="w-full text-xs">
                        <thead className="sticky top-0 bg-gray-50 text-left text-[10px] uppercase tracking-wide text-gray-500">
                          <tr>
                            <th className="w-8 px-2 py-1.5">
                              <Checkbox
                                checked={missing.length > 0 && reviewTicked.length === missing.length}
                                disabled={missing.length === 0}
                                onCheckedChange={(on) => setReviewTicked(on === true ? missing.map((m) => m.orderNumber) : [])}
                                aria-label="Tick every order that is not in our system"
                              />
                            </th>
                            <th className="px-2 py-1.5">Vehicle</th><th className="px-2 py-1.5">Order</th><th className="px-2 py-1.5">Party</th><th className="px-2 py-1.5">Date</th><th className="px-2 py-1.5">Our system</th>
                          </tr>
                        </thead>
                        <tbody>
                          {items.map((i) => (
                            <tr key={`${i.vehicleId}-${i.orderNumber}`} className="border-t border-gray-100">
                              <td className="px-2 py-1.5">
                                {!i.inSystem && (
                                  <Checkbox
                                    checked={reviewTicked.includes(i.orderNumber)}
                                    onCheckedChange={(on) => setReviewTicked((p) => (on === true ? Array.from(new Set([...p, i.orderNumber])) : p.filter((x) => x !== i.orderNumber)))}
                                    aria-label={`Create the slip for order ${i.orderNumber}`}
                                  />
                                )}
                              </td>
                              <td className="px-2 py-1.5 font-semibold text-[#001d6e]">{i.vehicleNumber}</td>
                              <td className="px-2 py-1.5">#{i.orderNumber}</td>
                              <td className="max-w-[180px] truncate px-2 py-1.5" title={i.partyName ?? undefined}>{i.partyName ?? "—"}</td>
                              <td className="px-2 py-1.5">{i.orderDate ? dayLabel(i.orderDate.slice(0, 10)) : "—"}</td>
                              <td className="px-2 py-1.5">
                                {i.inSystem
                                  ? <span className="rounded-full bg-emerald-50 px-2 py-0.5 text-[10px] font-medium text-emerald-700">In system</span>
                                  : <span className="rounded-full bg-sky-50 px-2 py-0.5 text-[10px] font-medium text-sky-700">Not in system</span>}
                              </td>
                            </tr>
                          ))}
                        </tbody>
                      </table>
                    )}
                  </div>
                )}

                <DialogFooter className="gap-2 sm:gap-2">
                  {reviewRun?.finished ? (
                    <Button onClick={() => setReviewOpen(false)}>Close</Button>
                  ) : (
                    <>
                      <Button variant="outline" disabled={running} onClick={() => setReviewOpen(false)}>Skip</Button>
                      <Button disabled={running || reviewTicked.length === 0 || !canWrite} onClick={createTicked}>
                        {running ? <Loader2 className="h-4 w-4 animate-spin" /> : `Create selected (${reviewTicked.length})`}
                      </Button>
                    </>
                  )}
                </DialogFooter>
              </>
            );
          })()}
        </DialogContent>
      </Dialog>

      <Dialog open={!!mismatchTarget} onOpenChange={(open) => { if (!open) setMismatchTarget(null); }}>
        <DialogContent className="sm:max-w-md max-w-[calc(100vw-1rem)] overflow-x-hidden [&>*]:min-w-0">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-1.5">
              <AlertTriangle className="h-4 w-4 text-amber-500" /> Vehicle mismatch
            </DialogTitle>
            <DialogDescription>
              Order #{mismatchTarget?.currentOrder?.orderNumber} — Notion's vehicle relation and the proforma
              slip's vehicle number disagree. Pick which one is correct.
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-2 text-sm">
            <div className="rounded-lg border border-gray-200 px-3 py-2">
              <div className="text-[11px] font-semibold uppercase tracking-wide text-gray-500">Notion says</div>
              <div className="font-medium text-[#001d6e]">{mismatchTarget?.vehicleNumber}</div>
            </div>
            <div className="rounded-lg border border-gray-200 px-3 py-2">
              <div className="text-[11px] font-semibold uppercase tracking-wide text-gray-500">Proforma slip says</div>
              <div className="font-medium text-[#001d6e]">{mismatchTarget?.currentOrder?.mismatchProformaVehicleNumber}</div>
            </div>
          </div>
          <DialogFooter className="gap-2 sm:gap-2">
            <Button
              variant="outline"
              disabled={resolveMismatchMutation.isPending}
              onClick={() => resolveMismatchMutation.mutate("proforma")}
            >
              Keep proforma slip's
            </Button>
            <Button
              disabled={resolveMismatchMutation.isPending}
              onClick={() => resolveMismatchMutation.mutate("notion")}
            >
              Keep Notion's (update slip)
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Order history — every past order this vehicle has carried, newest first. Fetched on
          demand (clicking the row's label columns), not bundled into the main fleet list. */}
      <Dialog open={!!historyTarget} onOpenChange={(open) => { if (!open) setHistoryTarget(null); }}>
        <DialogContent className="sm:max-w-lg max-w-[calc(100vw-1rem)] overflow-x-hidden [&>*]:min-w-0">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-1.5">
              <History className="h-4 w-4" /> {historyTarget?.vehicleNumber} — order history
            </DialogTitle>
            <DialogDescription>Every order this vehicle has carried, most recent first.</DialogDescription>
            {(historyTarget?.volume != null || historyTarget?.bodyType) && (
              <p className="text-xs text-gray-500">{historyTarget?.volume != null ? `Volume ${historyTarget.volume}` : ""}{historyTarget?.bodyType ? `${historyTarget?.volume != null ? " · " : ""}Body type ${historyTarget.bodyType}` : ""}</p>
            )}
          </DialogHeader>
          <div className="max-h-96 space-y-2 overflow-y-auto">
            {historyQuery.isLoading ? (
              <SectionSkeleton lines={4} />
            ) : (historyQuery.data?.history ?? []).length === 0 ? (
              <p className="py-6 text-center text-sm text-gray-400">No order history yet for this vehicle.</p>
            ) : (
              historyQuery.data!.history.map((h) => (
                <div key={h.orderNumber} className="rounded-lg border border-gray-200 px-3 py-2.5">
                  <div className="flex items-center justify-between gap-2">
                    <span className="text-sm font-semibold text-[#001d6e]">#{h.orderNumber}</span>
                    <span className="text-xs text-gray-400">{h.orderDate ?? "—"}</span>
                  </div>
                  <div className="mt-0.5 text-xs text-gray-700">{h.partyName ?? "—"}</div>
                  <div className="mt-1 flex flex-wrap gap-x-3 gap-y-0.5 text-[11px] text-gray-500">
                    <span>Plant: {h.plant ?? "—"}</span>
                    <span>Driver: {h.driver ?? "—"}</span>
                    <span>Trip days: {h.tripDays ?? "—"}</span>
                    <span>Status: {h.status ?? "—"}</span>
                  </div>
                  <div className="mt-1 flex flex-wrap gap-x-3 gap-y-0.5 text-[11px] text-gray-400">
                    <span>Est. free by: {h.tripCompletesOn ?? "—"}</span>
                    <span>Actually completed: {h.actualCompletedAt ?? "not yet"}</span>
                  </div>
                </div>
              ))
            )}
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setHistoryTarget(null)}>Close</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
