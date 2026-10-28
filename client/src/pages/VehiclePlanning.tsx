import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { useMutation, useQuery } from "@tanstack/react-query";
import { addDays, differenceInCalendarDays, format, isSameDay, parse, startOfDay } from "date-fns";
import {
  AlertTriangle, CalendarClock, CalendarDays, CheckCircle2, ChevronDown, ChevronLeft, ChevronRight, ChevronsLeft,
  ChevronsRight, ChevronUp, DatabaseZap, History, Loader2, ListFilter, RefreshCw, RotateCcw, Search, Truck, Undo2,
} from "lucide-react";
import PageHeader from "@/components/PageHeader";
import { Button } from "@/components/ui/button";
import {
  Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle,
} from "@/components/ui/dialog";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { Checkbox } from "@/components/ui/checkbox";
import { Input } from "@/components/ui/input";
import { useToast } from "@/hooks/use-toast";
import { apiRequest, queryClient } from "@/lib/queryClient";
import { hasPageWriteAccess, isAdminOrSuperAdmin } from "@/lib/permissions";
import { parseApiErrorBody, parseApiErrorMessage } from "@/lib/apiError";
import { ToastAction } from "@/components/ui/toast";
import { usePersistentFilter } from "@/hooks/usePersistentFilter";
import { SectionSkeleton } from "@/components/ui/loading-skeletons";
import { SyncProgressDialog } from "@/components/SyncProgressDialog";
import { withNotionNotice } from "@/lib/notionSyncNotice";
import { ExtendReasonDialog, PlanningStartDateRow, ResetBanner, ResetPlanningDialog, type LastReset } from "@/components/VehiclePlanningReset";

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
};
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
  { key: "vehicleNumber", label: "Vehicle", width: 64 },
  { key: "rtoNumber", label: "RTO No.", width: 104 },
  { key: "orderNumber", label: "Order No.", width: 78 },
  { key: "state", label: "Plant / State", width: 92 },
  { key: "driver", label: "Driver", width: 108 },
  { key: "tripDays", label: "Trip Days", width: 68 },
];
const ROW_LABEL_WIDTH = LABEL_COLS.reduce((sum, c) => sum + c.width, 0);
const DAY_COL_MIN_WIDTH = 42; // px per day, so the whole thing scrolls horizontally at 30 days on a phone instead of squeezing unreadable
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
  const live = (v.trips ?? []).filter((t) => t.state !== "cancelled");
  return !live.some((t) => t.startDay <= day && day < t.freeFromDay);
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
  // A trip bar that was clicked (its details + Arrived / Undo), the Arrived date form, and a stretch that would run into the next trip.
  const [tripTarget, setTripTarget] = useState<{ vehicle: VehicleRow; trip: Trip } | null>(null);
  const [arrivalTarget, setArrivalTarget] = useState<{ vehicle: VehicleRow; trip: Trip } | null>(null);
  const [arrivalDay, setArrivalDay] = useState("");
  const [arrivalNote, setArrivalNote] = useState("");
  const [stretchAsk, setStretchAsk] = useState<{ vehicle: VehicleRow; trip: Trip; newEnd: string; clashes: Trip[]; reason?: string } | null>(null);
  // Moving a trip's last day LATER first asks why (ExtendReasonDialog); the clash question, when there is one, follows. And the admin's Reset planning dialog.
  const [extendAsk, setExtendAsk] = useState<{ vehicle: VehicleRow; trip: Trip; newEnd: string; clashes: Trip[] } | null>(null);
  const [resetOpen, setResetOpen] = useState(false);
  const [drag, setDrag] = useState<{ vehicleId: number; orderNumber: string; endIdx: number } | null>(null);
  // Change plan on one trip: move it to another vehicle, change its driver, or take the vehicle off.
  const [changeTarget, setChangeTarget] = useState<{ vehicle: VehicleRow; trip: Trip } | null>(null);
  const [moveSearch, setMoveSearch] = useState("");
  const [moveDest, setMoveDest] = useState<VehicleRow | null>(null);
  const [moveAsk, setMoveAsk] = useState<NotFreeAsk | null>(null);
  // Which order of a shared trip the Change dialog works on: "" = the whole trip.
  const [changeOrder, setChangeOrder] = useState("");
  const [arrivalSameDay, setArrivalSameDay] = useState(true);
  const [changeDriverText, setChangeDriverText] = useState<string | null>(null);
  const [changeDriverExtra, setChangeDriverExtra] = useState<NotionDriver | null>(null);
  const [removeSure, setRemoveSure] = useState(false);
  const [tripFilter, setTripFilter] = useState<"all" | "awaiting" | "conflicts">("all");
  // "Available" filter: only the vehicles that are free on a chosen day (planned to be back or arrived by then). "" = off.
  const [availableOn, setAvailableOn] = usePersistentFilter<string>("vehiclePlanning:availableOn", "");
  const [availableOpen, setAvailableOpen] = useState(false);
  const [filterOpen, setFilterOpen] = useState(false);
  // Which vehicles to list: only those with orders (default), all of them, or only those with no orders (the ones free to assign).
  const [orderView, setOrderView] = usePersistentFilter<"with" | "all" | "none">("vehiclePlanning:orderView", "with");
  const [search, setSearch] = useState("");
  // Plant / State / Driver — each a simple multi-select (empty array = no restriction), same
  // "show only what's checked" idea as the Companies filter, just derived from whatever values
  // are actually present in the current fleet rather than its own settings table.
  const [plantFilter, setPlantFilter] = usePersistentFilter<string[]>("vehiclePlanning:plantFilter", []);
  const [stateFilter, setStateFilter] = usePersistentFilter<string[]>("vehiclePlanning:stateFilter", []);
  const [driverFilter, setDriverFilter] = usePersistentFilter<string[]>("vehiclePlanning:driverFilter", []);
  const [filtersOpen, setFiltersOpen] = useState(false);
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
  // accumulated and converted at one day per DAY_COL_MIN_WIDTH of finger travel, so a slow drag
  // moves smoothly day by day and a fast flick covers many days. Registered natively (non-
  // passive): React's onWheel is passive and can't preventDefault, which is what stops the
  // browser's own back/forward swipe navigation from firing on a sideways gesture.
  const wheelAccum = useRef(0);
  useEffect(() => {
    const el = ganttRef.current;
    if (!el) return;
    const onWheel = (e: WheelEvent) => {
      const horizontal = Math.abs(e.deltaX) > Math.abs(e.deltaY) || e.shiftKey;
      if (!horizontal && !ganttActiveRef.current) return; // plain vertical scroll stays the page's
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
      toast({ title: body.undo ? "Arrival removed" : "Arrival saved", description: `Order #${body.orderNumber}` });
      queryClient.invalidateQueries({ queryKey: ["/api/vehicle-planning/vehicles"] });
      // Back earlier than planned: say when it is free and how many orders are waiting for a vehicle.
      if (!body.undo && data?.early && data?.waiting > 0 && data?.freeFrom && arrivalTarget) {
        setEarlyAsk({ vehicle: arrivalTarget.vehicle, freeFrom: data.freeFrom, waiting: data.waiting });
      }
      setArrivalTarget(null);
      setTripTarget(null);
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
        orderNumber: changeOrder, vehicleId: destId, force: force || undefined, sameTripAs: sameTripAs || undefined,
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
    },
    onError: (err: any) => toast({ title: "Could not remove the vehicle", description: parseApiErrorMessage(err), variant: "destructive" }),
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
    setAssignDate(""); setAssignSearch(""); setAssignPick(null); setDriverText(null); setDriverExtra(null); setAssignAsk(null);
  }, [assignTarget?.id]);
  useEffect(() => {
    setChangeOrder(""); setMoveSearch(""); setMoveDest(null); setMoveAsk(null); setChangeDriverText(null); setChangeDriverExtra(null); setRemoveSure(false);
  }, [changeTarget?.trip.orderNumber, changeTarget?.vehicle.id]);


  const syncMutation = useMutation({
    mutationFn: async () => {
      const res = await apiRequest("POST", "/api/vehicle-planning/sync");
      if (!res.ok) throw new Error((await res.json().catch(() => ({})))?.message || "Failed to sync from Notion");
      return res.json() as Promise<{ syncedVehicles: number; mismatches: number; notInSystem: number }>;
    },
    onSuccess: (result) => {
      toast({
        title: "Refreshed from Notion",
        description: `${result.syncedVehicles} vehicle(s) checked${result.mismatches > 0 ? ` · ${result.mismatches} vehicle mismatch(es) found` : ""}${result.notInSystem > 0 ? ` · ${result.notInSystem} order(s) assigned in Notion but not in our system` : ""}`,
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

  // Distinct values actually present in the current fleet — what the Plant/State/Driver filter
  // checkboxes offer, so the list only ever shows real options, never a stale/empty one.
  const availablePlants = useMemo(
    () => Array.from(new Set(allVehicles.map((v) => v.currentOrder?.plant).filter((x): x is string => !!x))).sort(),
    [allVehicles],
  );
  const availableStates = useMemo(
    () => Array.from(new Set(allVehicles.map((v) => v.state).filter((x): x is string => !!x))).sort(),
    [allVehicles],
  );
  const availableDrivers = useMemo(
    () => Array.from(new Set(allVehicles.map((v) => v.driver).filter((x): x is string => !!x))).sort(),
    [allVehicles],
  );

  // Hidden by default (no sync history yet for this vehicle) unless the toggle is on or the
  // vehicle itself matches an active search — so a search can still surface one on demand.
  const searchLower = search.trim().toLowerCase();
  const vehicles = allVehicles
    .filter((v) => {
      const matchesSearch = !searchLower
        || [v.vehicleNumber, v.driver, v.currentOrder?.orderNumber].some((f) => (f ?? "").toLowerCase().includes(searchLower));
      if (!matchesSearch) return false;
      if (plantFilter.length > 0 && !plantFilter.includes(v.currentOrder?.plant ?? "")) return false;
      if (stateFilter.length > 0 && !stateFilter.includes(v.state ?? "")) return false;
      if (driverFilter.length > 0 && !driverFilter.includes(v.driver ?? "")) return false;
      if (tripFilter === "awaiting" && v.vehicleState !== "awaiting") return false;
      if (tripFilter === "conflicts" && !(v.conflicts?.length)) return false;
      if (availableOn && !isAvailableOn(v, availableOn)) return false;
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

  // The trips to draw for one vehicle, each on a lane: trips that overlap in time (a conflict) go on separate lanes
  // so neither bar hides the other. Cancelled trips are not drawn.
  // A trip of two or more days ends at the MIDDLE of its last day (the vehicle is back by then and can go out again), and a trip that starts on
  // such a day begins at the middle - so the previous and the new trip sit end to end on that day. A one-day trip fills its day.
  const endsHalf = (t: Trip) => t.freeFromDay === t.lastBusyDay && t.startDay < t.lastBusyDay;
  function tripLanes(v: VehicleRow): { trip: Trip; lane: number; startIdx: number; endIdx: number; drawStart: number; drawEnd: number; labelEndIdx: number; conflict: boolean }[] {
    const shown = (v.trips ?? []).filter((t) => t.state !== "cancelled");
    const laneEnds: number[] = [];
    const conflictSet = new Set((v.conflicts ?? []).map((c) => c.orderNumber));
    const placed = shown.map((trip) => {
      const s0 = dayIdx(trip.startDay);
      const e0 = dayIdx(trip.lastBusyDay) + 1; // exclusive: the bar covers the last busy day itself
      const startHalf = shown.some((q) => q !== trip && endsHalf(q) && q.lastBusyDay === trip.startDay);
      const sf = s0 + (startHalf ? 0.5 : 0);
      const ef = e0 - (endsHalf(trip) ? 0.5 : 0);
      let lane = laneEnds.findIndex((end) => end <= sf);
      if (lane < 0) { lane = laneEnds.length; laneEnds.push(ef); } else laneEnds[lane] = ef;
      return { trip, lane, s0, e0, sf, ef, conflict: conflictSet.has(trip.orderNumber) };
    });
    return placed
      .filter((p) => p.e0 > 0 && p.s0 < windowDays)
      .map((p) => {
        const nextOnLane = placed.filter((q) => q.lane === p.lane && q.sf > p.sf).map((q) => q.sf).sort((a, b) => a - b)[0];
        return {
          trip: p.trip, lane: p.lane, conflict: p.conflict,
          startIdx: Math.max(0, p.s0), endIdx: Math.min(windowDays, p.e0),
          drawStart: p.s0 < 0 ? 0 : p.sf, drawEnd: p.e0 > windowDays ? windowDays : p.ef,
          labelEndIdx: Math.min(windowDays, nextOnLane ?? windowDays),
        };
      });
  }

  const LANE_HEIGHT = 42;

  function tripBarClass(state: TripState, conflict: boolean) {
    if (conflict) return "bg-red-500";
    switch (state) {
      case "planned": return "border border-dashed border-blue-600 bg-blue-200";   // new: not started yet
      case "awaiting": return "bg-amber-400";
      case "arrived": return "bg-slate-400";                                          // past
      case "closed": return "bg-slate-300";                                           // past
      default: return "bg-emerald-600";                                               // current: on the trip now
    }
  }
  const stateText: Record<TripState, string> = {
    planned: "Planned", on_trip: "On the trip", awaiting: "Planned end passed - waiting for arrival", arrived: "Arrived", closed: "Closed (no arrival recorded)", cancelled: "Cancelled",
  };

  // Called when the right edge of a bar is let go on a new day. A stretch into the next trip asks first; anything else is saved straight away.
  function finishStretch(v: VehicleRow, trip: Trip, newEnd: string) {
    if (newEnd === trip.lastBusyDay) return;
    const clashes = (v.trips ?? []).filter((t) => t.orderNumber !== trip.orderNumber && t.state !== "cancelled" && t.state !== "arrived" && t.state !== "closed"
      && t.startDay > trip.startDay && t.startDay <= newEnd);
    if (newEnd > trip.lastBusyDay) { setExtendAsk({ vehicle: v, trip, newEnd, clashes }); return; }   // a longer trip needs a reason first
    if (clashes.length > 0) { setStretchAsk({ vehicle: v, trip, newEnd, clashes }); return; }
    expectedEndMutation.mutate({ vehicleId: v.id, orderNumber: trip.orderNumber, expectedEnd: newEnd === trip.plannedLastDay ? null : newEnd });
  }

  const chipCls = (on: boolean) => `rounded-full px-3 py-1 text-xs font-medium ${on ? "bg-[#001d6e] text-white" : "border border-gray-200 bg-white text-gray-600 hover:bg-gray-50"}`;

  // The label over a trip's bar: one party, or for a shared load both names when there is room ("Party A + Party B") and the first with "+1" when there is not.
  function barLabel(t: Trip, labelDays: number): string {
    if (t.members.length <= 1) return t.partyName ?? "—";
    // Slips of different lengths on one trip show their days ("Party A (4d) + Party B (2d)"); equal lengths need no numbers.
    const sameLength = t.members.every((m) => m.tripDays === t.members[0].tripDays);
    const names = t.members.map((m) => `${m.partyName ?? "—"}${sameLength ? "" : ` (${m.tripDays}d)`}`);
    return labelDays * DAY_COL_MIN_WIDTH >= 200 ? names.join(" + ") : `${names[0]} +${names.length - 1}`;
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

  function openArrival(v: VehicleRow, t: Trip) {
    const todayIso = format(new Date(), "yyyy-MM-dd");
    setArrivalDay(t.lastBusyDay < todayIso && t.lastBusyDay >= t.startDay ? t.lastBusyDay : todayIso);
    setArrivalNote("");
    setArrivalSameDay(true);
    setArrivalTarget({ vehicle: v, trip: t });
  }

  return (
    <div className="container mx-auto px-3 sm:px-4 py-4 sm:py-6 pb-24">
      <PageHeader
        icon={CalendarClock}
        title="Vehicle Planning"
      />

      {/* After a Reset planning: when, by whom, the day Refresh from Notion starts from, and Undo (7 days). */}
      <ResetBanner planningStartDate={fleetQuery.data?.planningStartDate ?? null} lastReset={fleetQuery.data?.lastReset ?? null} lastRefreshedAt={fleetQuery.data?.lastRefreshedAt ?? null} isAdmin={canWrite && isAdmin} onRefreshNow={() => syncMutation.mutate()} onResetAgain={() => setResetOpen(true)} />

      {/* Fleet controls - search at the left; Companies (with the planning settings); at the right Filter, Available and Refresh from Notion
          (the only thing that ever talks to Notion; the page itself just reads vehicle_planning_state). */}
      <div className="mb-3 flex flex-wrap items-center gap-2">
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
                <PlanningStartDateRow planningStartDate={fleetQuery.data?.planningStartDate ?? null} />
                <Button size="sm" variant="outline" className="h-8 w-full rounded-full border-red-200 px-3 text-xs text-red-700 hover:bg-red-50 hover:text-red-800"
                  title="Clear our planning board and start again from a day. Notion is not changed."
                  onClick={() => { setFilterOpen(false); setResetOpen(true); }}>
                  <RotateCcw className="mr-1.5 h-3.5 w-3.5" /> Reset planning
                </Button>
              </div>
            )}
          </PopoverContent>
        </Popover>

        <div className="ml-auto flex flex-wrap items-center gap-2">
          {/* Plant / State / Driver in one Filter button - purely client-side, they only narrow what is displayed. */}
          <Popover open={filtersOpen} onOpenChange={setFiltersOpen}>
            <PopoverTrigger asChild>
              <Button size="sm" variant="outline" className={`h-8 rounded-full px-3 text-xs ${plantFilter.length + stateFilter.length + driverFilter.length > 0 ? "border-[#001d6e] bg-[#001d6e]/5 text-[#001d6e]" : ""}`}>
                <ListFilter className="mr-1.5 h-3.5 w-3.5" />
                Filter{plantFilter.length + stateFilter.length + driverFilter.length > 0 ? ` (${plantFilter.length + stateFilter.length + driverFilter.length})` : ""}
              </Button>
            </PopoverTrigger>
            <PopoverContent className="w-[34rem] max-w-[calc(100vw-1rem)] space-y-2" align="end">
              <div className="flex items-center justify-between">
                <div className="text-[11px] font-semibold uppercase tracking-wide text-gray-500">Show only</div>
                {plantFilter.length + stateFilter.length + driverFilter.length > 0 && (
                  <button type="button" className="text-[11px] text-gray-400 hover:text-red-500" onClick={() => { setPlantFilter([]); setStateFilter([]); setDriverFilter([]); }}>
                    Clear all
                  </button>
                )}
              </div>
              <div className="grid gap-3 sm:grid-cols-3">
                {([
                  { label: "Plant", options: availablePlants, active: plantFilter, setActive: setPlantFilter },
                  { label: "State", options: availableStates, active: stateFilter, setActive: setStateFilter },
                  { label: "Driver", options: availableDrivers, active: driverFilter, setActive: setDriverFilter },
                ] as const).map((f) => (
                  <div key={f.label} className="min-w-0">
                    <div className="mb-1 flex items-center justify-between border-b pb-1">
                      <span className="text-xs font-semibold text-gray-700">{f.label}{f.active.length > 0 ? ` (${f.active.length})` : ""}</span>
                      {f.active.length > 0 && (
                        <button type="button" className="text-[11px] text-gray-400 hover:text-red-500" onClick={() => f.setActive([])}>Clear</button>
                      )}
                    </div>
                    <div className="max-h-56 space-y-1.5 overflow-y-auto pr-1">
                      {f.options.map((opt) => (
                        <label key={opt} className="flex items-center gap-2 text-xs text-gray-700">
                          <Checkbox
                            checked={f.active.includes(opt)}
                            onCheckedChange={(next) => f.setActive(next ? [...f.active, opt] : f.active.filter((x) => x !== opt))}
                          />
                          <span className="truncate">{opt}</span>
                        </label>
                      ))}
                      {f.options.length === 0 && <div className="py-2 text-center text-xs text-gray-400">None found</div>}
                    </div>
                  </div>
                ))}
              </div>
            </PopoverContent>
          </Popover>

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
          <Button
            size="sm"
            variant="outline"
            className="h-8 rounded-full px-3 text-xs"
            onClick={() => syncMutation.mutate()}
            disabled={syncMutation.isPending}
          >
            <RefreshCw className={`mr-1.5 h-3.5 w-3.5 ${syncMutation.isPending ? "animate-spin" : ""}`} />
            {syncMutation.isPending ? "Refreshing…" : "Refresh from Notion"}
          </Button>
        </div>
      </div>

      <div className="mb-3 flex flex-wrap items-center gap-2">
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
          { key: "awaiting" as const, label: "Awaiting arrival", count: awaitingCount, on: "border-amber-400 bg-amber-50 text-amber-800", off: "text-amber-700" },
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

        {/* What the bar colours mean. */}
        <div className="ml-auto flex flex-wrap items-center gap-x-3 gap-y-1 text-[11px] text-gray-600" aria-label="Bar colours">
          <span className="flex items-center gap-1"><span className="h-2 w-5 rounded-full bg-emerald-600" /> Current</span>
          <span className="flex items-center gap-1"><span className="h-2 w-5 rounded-full border border-dashed border-blue-600 bg-blue-200" /> New</span>
          <span className="flex items-center gap-1"><span className="h-2 w-5 rounded-full bg-slate-400" /> Past</span>
          <span className="flex items-center gap-1"><span className="h-2 w-5 rounded-full bg-amber-400" /> Waiting for arrival</span>
          <span className="flex items-center gap-1"><span className="h-2 w-5 rounded-full bg-red-500" /> Clash</span>
        </div>
      </div>

      {/* Window controls — 14/30 day toggle, a calendar picker for an exact single date or
          range, and Prev/Today/Next to stretch the view into the past or future a page (one
          window's width) at a time. */}
      <div className="mb-3 flex flex-wrap items-center gap-2">
        <div className="flex overflow-hidden rounded-full border border-gray-200 bg-white text-xs font-medium">
          {([14, 30] as const).map((n) => (
            <button
              key={n}
              type="button"
              onClick={() => setWindowDays(n)}
              className={`px-3 py-1.5 ${windowDays === n ? "bg-[#001d6e] text-white" : "text-gray-600 hover:bg-gray-50"}`}
            >
              {n} days
            </button>
          ))}
        </div>

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

        <div className="ml-auto flex items-center gap-1">
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

      {missingCount > 0 && (
        <div className="mb-3 flex flex-wrap items-center justify-between gap-2 rounded-lg border border-sky-200 bg-sky-50 px-3 py-2 text-xs text-sky-900">
          <span className="flex items-center gap-1.5"><DatabaseZap className="h-3.5 w-3.5" /> {missingCount} order{missingCount === 1 ? " is" : "s are"} in Notion but not in our system.</span>
          <Button size="sm" variant="outline" className="h-7 border-sky-300 px-3 text-xs" onClick={openReview}>Review</Button>
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
          className={`overflow-x-auto overscroll-x-contain border bg-white shadow-sm focus:outline-none ${ganttActive ? "border-[#001d6e]/40 ring-2 ring-[#001d6e]/30" : "border-gray-200"}`}
          tabIndex={0}
          title={ganttActive ? "Scroll or use the arrow keys to move the date range" : "Click, then scroll or use the arrow keys to move the date range"}
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
          <div style={{ minWidth: ROW_LABEL_WIDTH + windowDays * DAY_COL_MIN_WIDTH }}>
            {/* Day header — one continuous bar with date ticks, not a row of separately
                bordered boxes (that read as "many small columns" rather than one timeline). */}
            <div className="flex border-b border-gray-200 bg-[#001d6e] text-white">
              {/* Vehicle … Trip Days stay pinned to the left while the calendar scrolls under them. */}
              <div className="sticky left-0 z-20 flex shrink-0 bg-[#001d6e] shadow-[2px_0_4px_-1px_rgba(0,0,0,0.25)]">
              {LABEL_COLS.map((c) => {
                const sortKey = c.key === "vehicleNumber" || c.key === "orderNumber" ? c.key : null;
                return (
                  <div
                    key={c.key}
                    style={{ width: c.width }}
                    className={`shrink-0 truncate border-r border-white/10 px-2 py-2.5 text-[10px] font-semibold uppercase tracking-wide ${sortKey ? "cursor-pointer select-none" : ""}`}
                    onClick={sortKey ? () => toggleVpSort(sortKey) : undefined}
                  >
                    {c.label}
                    {sortKey && sortBy === sortKey && (
                      sortOrder === "asc" ? <ChevronUp className="ml-0.5 inline h-3 w-3" /> : <ChevronDown className="ml-0.5 inline h-3 w-3" />
                    )}
                  </div>
                );
              })}
              </div>
              <div className="flex flex-1">
                {days.map((d, i) => (
                  <div
                    key={i}
                    style={{ width: `${100 / windowDays}%`, minWidth: DAY_COL_MIN_WIDTH }}
                    className={`shrink-0 border-l border-white/10 py-1.5 text-center text-[11px] ${isSameDay(d, today) ? "bg-white/15 font-bold" : ""}`}
                  >
                    <div className="opacity-70">{format(d, "EEE")}</div>
                    <div>{format(d, "d/M")}</div>
                  </div>
                ))}
              </div>
            </div>

            {/* Vehicle rows */}
            {vehicles.map((v, rowIdx) => {
              const lanes = tripLanes(v);
              const laneCount = Math.max(1, ...lanes.map((l) => l.lane + 1));
              const freeIdx = v.freeFrom ? dayIdx(v.freeFrom) : null;
              const canAssign = canWrite; // now shown on a busy row too, not just a free one
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
                      style={{ width: LABEL_COLS.find((l) => l.key === c.key)!.width }}
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
                    </div>
                  ))}
                  </div>
                  <div data-track className="relative flex-1" style={{ minHeight: 10 + laneCount * LANE_HEIGHT }}>
                    {/* One continuous area. A thin, light vertical line at each day (a little firmer at the start of a week, Monday) lines the bars up
                        with the dates in the header without turning it into a boxed grid; today keeps its faint tint. */}
                    <div className="absolute inset-0 flex">
                      {days.map((d, i) => (
                        <div
                          key={i}
                          style={{ width: `${100 / windowDays}%`, minWidth: DAY_COL_MIN_WIDTH }}
                          className={`shrink-0 border-l ${d.getDay() === 1 ? "border-gray-300" : "border-gray-200/70"} ${isSameDay(d, today) ? "bg-[#001d6e]/[0.04]" : ""}`}
                        />
                      ))}
                    </div>
                    {/* One bar per trip. Each bar sits on its own lane (overlapping trips stack), has the party name above it
                        (as wide as the free space up to the next trip on the lane), opens the trip's details on click, and - when
                        the trip has not arrived - has a handle on its right edge to drag the expected last day. */}
                    {lanes.map((l) => {
                      const t = l.trip;
                      const dragging = drag && drag.vehicleId === v.id && drag.orderNumber === t.orderNumber ? drag : null;
                      const endIdx = dragging ? dragging.endIdx : l.endIdx;
                      // Where the bar is drawn (half days included); the drag itself still moves whole days (endIdx).
                      const drawEnd = dragging ? dragging.endIdx - (dragging.endIdx - 1 > dayIdx(t.startDay) && dragging.endIdx <= windowDays ? 0.5 : 0) : l.drawEnd;
                      const canStretch = canWrite && (t.state === "planned" || t.state === "on_trip" || t.state === "awaiting");
                      return (
                        <div key={t.orderNumber} className="absolute flex flex-col gap-0.5" style={{ top: 4 + l.lane * LANE_HEIGHT, left: `${(l.drawStart / windowDays) * 100}%`, width: `${((Math.max(l.labelEndIdx, drawEnd) - l.drawStart) / windowDays) * 100}%` }}>
                          <div className="truncate text-[10px] font-medium leading-[1.15] text-black" title={t.partyName ?? undefined}>
                            {barLabel(t, l.labelEndIdx - l.drawStart)}
                          </div>
                          <div className="relative h-2.5" style={{ width: `${((drawEnd - l.drawStart) / (Math.max(l.labelEndIdx, drawEnd) - l.drawStart)) * 100}%` }}>
                            <button
                              type="button"
                              onClick={() => setTripTarget({ vehicle: v, trip: t })}
                              className={`h-full w-full rounded-full shadow-sm ${tripBarClass(t.state, l.conflict)}`}
                              title={`#${t.members.map((m) => m.orderNumber).join(" + #")} · ${t.members.map((m) => m.partyName ?? "—").join(" + ")} · ${dayLabel(t.startDay)} to ${dayLabel(t.lastBusyDay)} · ${l.conflict ? "Vehicle not back yet" : stateText[t.state]}${t.notionNote ? " · Notion not updated" : ""}`}
                            />
                            {/* A shared load whose slips end on different days: a notch on the bar at each shorter slip's last day. */}
                            {t.members.length > 1 && drawEnd > l.drawStart && t.members.filter((m) => m.plannedLastDay < t.lastBusyDay).map((m) => {
                              const pos = (dayIdx(m.plannedLastDay) + 1 - l.drawStart) / (drawEnd - l.drawStart);
                              if (!(pos > 0 && pos < 1)) return null;
                              return (
                                <span key={m.orderNumber} className="absolute top-[-2px] z-[1] h-[calc(100%+4px)] w-2 -translate-x-1/2" style={{ left: `${pos * 100}%` }}
                                  title={`#${m.orderNumber} ${m.partyName ?? ""} ends ${dayLabel(m.plannedLastDay)} (${m.tripDays} day${m.tripDays === 1 ? "" : "s"})`}>
                                  <span className="mx-auto block h-full w-0.5 rounded bg-white" />
                                </span>
                              );
                            })}
                            {t.notionNote && <AlertTriangle className="pointer-events-none absolute -top-3 right-0 h-3 w-3 text-amber-500" />}
                            {canStretch && (
                              <div
                                className="absolute -right-1.5 top-1/2 h-4 w-3 -translate-y-1/2 cursor-ew-resize touch-none rounded-sm border border-gray-500 bg-white/90"
                                title="Drag to change the expected last day"
                                onClick={(e) => e.stopPropagation()}
                                onPointerDown={(e) => {
                                  e.stopPropagation();
                                  const track = (e.currentTarget as HTMLElement).closest("[data-track]") as HTMLElement | null;
                                  if (!track) return;
                                  const dayW = track.getBoundingClientRect().width / windowDays;
                                  const x0 = e.clientX;
                                  const base = l.endIdx;
                                  let last = base;
                                  setDrag({ vehicleId: v.id, orderNumber: t.orderNumber, endIdx: base });
                                  const move = (ev: PointerEvent) => {
                                    last = Math.max(l.startIdx + 1, Math.min(windowDays, base + Math.round((ev.clientX - x0) / dayW)));
                                    setDrag({ vehicleId: v.id, orderNumber: t.orderNumber, endIdx: last });
                                  };
                                  const up = () => {
                                    window.removeEventListener("pointermove", move);
                                    window.removeEventListener("pointerup", up);
                                    setDrag(null);
                                    if (last !== base) finishStretch(v, t, format(addDays(windowStart, last - 1), "yyyy-MM-dd"));
                                  };
                                  window.addEventListener("pointermove", move);
                                  window.addEventListener("pointerup", up);
                                }}
                              />
                            )}
                          </div>
                        </div>
                      );
                    })}
                    {/* Assign sits right after the last bar and says when the vehicle is free. */}
                    {canAssign && (() => {
                      const idx = freeIdx == null ? 0 : Math.max(0, Math.min(windowDays - 1, freeIdx));
                      // The vehicle is free from the MIDDLE of the day when the trip that frees it last is a multi-day one.
                      const halfFree = !!v.freeFrom && (v.trips ?? []).some((q) => q.state !== "cancelled" && q.freeFromDay === v.freeFrom && endsHalf(q));
                      const pillAt = idx + (halfFree && freeIdx != null && freeIdx >= 0 && freeIdx < windowDays ? 0.5 : 0);
                      const freeNow = !v.freeFrom || dayIdx(v.freeFrom) <= todayIdx;
                      const nearEnd = pillAt >= windowDays - 2;
                      return (
                        <button
                          type="button"
                          onClick={() => setAssignTarget(v)}
                          className="absolute rounded-lg border border-emerald-300 bg-emerald-50 px-2 py-0.5 text-center text-[11px] font-semibold leading-tight text-emerald-700 hover:bg-emerald-100"
                          style={nearEnd ? { right: 4, top: 17 } : { left: `calc(${(pillAt / windowDays) * 100}% + 4px)`, top: 17 }}
                          title={v.freeFrom ? `Free from ${halfFree ? "the middle of " : ""}${dayLabel(v.freeFrom)}` : "No trips yet"}
                        >
                          Assign
                          <div className="text-[9px] font-normal text-emerald-600">{freeNow ? "Free now" : `Free ${dayLabel(v.freeFrom!)}${halfFree ? " pm" : ""}`}</div>
                        </button>
                      );
                    })()}
                    {/* Today's highlight, drawn LAST so it sits on top of the bar above instead of
                        being hidden underneath it (the background tint earlier in this same row
                        is UNDER the bar) — pointer-events-none so it never blocks the bar's own
                        title tooltip or the Assign button sitting on/after it. */}
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

      {/* Scroll bar for the date range — drag the slider (or tap the arrows) to slide the calendar
          left/right without needing the keyboard or a focused chart. Spans 90 days back to 270
          ahead of today; the arrows nudge a day at a time and hold-click repeats via the browser. */}
      {!fleetQuery.isLoading && (
        <div className="sticky bottom-2 z-30 mt-2 flex items-center gap-2 rounded-full border border-gray-300 bg-white/95 px-2 py-1.5 shadow-md backdrop-blur">
          <Button size="sm" variant="outline" className="h-7 w-7 shrink-0 rounded-full p-0" onClick={() => setWindowStart((d) => addDays(d, -SCROLL_STEP_DAYS))} aria-label="Scroll calendar left" title="Scroll left">
            <ChevronLeft className="h-4 w-4" />
          </Button>
          <input
            type="range"
            min={-90}
            max={270}
            step={1}
            value={Math.max(-90, Math.min(270, differenceInCalendarDays(windowStart, today)))}
            onChange={(e) => setWindowStart(addDays(today, Number(e.target.value)))}
            aria-label="Scroll calendar left or right"
            className="h-2 min-w-0 flex-1 cursor-pointer accent-[#001d6e]"
          />
          <span className="hidden shrink-0 text-[11px] font-medium text-gray-600 sm:inline">
            {format(windowStart, "d MMM")} – {format(addDays(windowStart, windowDays - 1), "d MMM yyyy")}
          </span>
          <Button size="sm" variant="outline" className="h-7 w-7 shrink-0 rounded-full p-0" onClick={() => setWindowStart((d) => addDays(d, SCROLL_STEP_DAYS))} aria-label="Scroll calendar right" title="Scroll right">
            <ChevronRight className="h-4 w-4" />
          </Button>
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
                      {o.vehicleNumber && <span className="ml-1">(currently {o.vehicleNumber})</span>}
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

                <div className="space-y-1.5">
                  <div className="text-[11px] font-semibold uppercase tracking-wide text-gray-500">Or pick another order</div>
                  <div className="flex gap-2">
                    <Input type="date" value={shownDate} onChange={(e) => setAssignDate(e.target.value)} className="h-9 w-40" />
                    <Input value={assignSearch} onChange={(e) => setAssignSearch(e.target.value)} placeholder="Order no. or party" className="h-9 flex-1" />
                  </div>
                  <div className="max-h-44 space-y-1.5 overflow-y-auto">
                    {availableOrdersQuery.isLoading ? (
                      <SectionSkeleton lines={3} />
                    ) : (data?.orders ?? []).length === 0 ? (
                      <p className="py-4 text-center text-sm text-gray-400">No orders for this date.</p>
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
        <DialogContent className="sm:max-w-md max-w-[calc(100vw-1rem)] overflow-x-hidden [&>*]:min-w-0">
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
                <DialogFooter className="gap-2 sm:gap-2">
                  <Button variant="outline" onClick={() => setTripTarget(null)}>Close</Button>
                  {canWrite && t.arrivedOn && (
                    <Button variant="outline" disabled={arrivalMutation.isPending} onClick={() => arrivalMutation.mutate({ vehicleId: v.id, orderNumber: t.orderNumber, undo: true })}>
                      <Undo2 className="mr-1.5 h-4 w-4" /> Undo arrival
                    </Button>
                  )}
                  {canWrite && inConflict && (() => {
                    const blocker = v.trips?.find((x) => x.orderNumber === inConflict.withOrderNumber);
                    return blocker && !blocker.arrivedOn && (blocker.state === "on_trip" || blocker.state === "awaiting") ? (
                      <Button variant="outline" onClick={() => { setTripTarget(null); openArrival(v, blocker); }}>Mark #{blocker.orderNumber} arrived</Button>
                    ) : null;
                  })()}
                  {canWrite && !t.arrivedOn && t.state !== "closed" && t.state !== "cancelled" && !t.notInSystem && (
                    <Button variant="outline" onClick={() => { setTripTarget(null); setChangeTarget({ vehicle: v, trip: t }); }}>Change</Button>
                  )}
                  {canWrite && !t.arrivedOn && t.state !== "planned" && t.state !== "cancelled" && (
                    <Button onClick={() => { setTripTarget(null); openArrival(v, t); }}>
                      <CheckCircle2 className="mr-1.5 h-4 w-4" /> Arrived
                    </Button>
                  )}
                </DialogFooter>
              </>
            );
          })()}
        </DialogContent>
      </Dialog>

      {/* Arrived: the day the vehicle really came back (default today). It is free from the next day. */}
      <Dialog open={!!arrivalTarget} onOpenChange={(open) => { if (!open) setArrivalTarget(null); }}>
        <DialogContent className="sm:max-w-sm max-w-[calc(100vw-1rem)] overflow-x-hidden [&>*]:min-w-0">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-1.5"><CheckCircle2 className="h-4 w-4 text-emerald-600" /> Vehicle arrived</DialogTitle>
            <DialogDescription>
              {arrivalTarget?.vehicle.vehicleNumber} · order #{arrivalTarget?.trip.orderNumber}. Untick the box below if it cannot go out again that day.
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-2">
            <div>
              <label className="text-[11px] font-semibold uppercase tracking-wide text-gray-500">Arrived on</label>
              <Input type="date" value={arrivalDay} min={arrivalTarget?.trip.startDay} max={format(new Date(), "yyyy-MM-dd")} onChange={(e) => setArrivalDay(e.target.value)} className="h-9" />
            </div>
            <label className="flex items-center gap-2 text-xs text-gray-700">
              <Checkbox checked={arrivalSameDay} onCheckedChange={(on) => setArrivalSameDay(on === true)} />
              Can go out again the same day
            </label>
            <div>
              <label className="text-[11px] font-semibold uppercase tracking-wide text-gray-500">Note (optional)</label>
              <Input value={arrivalNote} onChange={(e) => setArrivalNote(e.target.value)} placeholder="For example: came back early" className="h-9" />
            </div>
          </div>
          <DialogFooter className="gap-2 sm:gap-2">
            <Button variant="outline" onClick={() => setArrivalTarget(null)} disabled={arrivalMutation.isPending}>Cancel</Button>
            <Button
              disabled={arrivalMutation.isPending || !arrivalDay}
              onClick={() => arrivalMutation.mutate({ vehicleId: arrivalTarget!.vehicle.id, orderNumber: arrivalTarget!.trip.orderNumber, arrivedOn: arrivalDay, note: arrivalNote.trim() || undefined, freeSameDay: arrivalSameDay })}
            >
              {arrivalMutation.isPending ? <Loader2 className="h-4 w-4 animate-spin" /> : "Save arrival"}
            </Button>
          </DialogFooter>
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
        onConfirm={(reason) => {
          if (!extendAsk) return;
          const { vehicle, trip, newEnd, clashes } = extendAsk;
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
