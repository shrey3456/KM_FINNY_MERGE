import { useMemo, useState } from "react";
import { useMutation, useQuery } from "@tanstack/react-query";
import { addDays, differenceInCalendarDays, format, isSameDay, parse, startOfDay } from "date-fns";
import {
  AlertTriangle, CalendarClock, CalendarDays, ChevronDown, ChevronLeft, ChevronRight, ChevronsLeft,
  ChevronsRight, ChevronUp, History, Loader2, RefreshCw, Search, Truck,
} from "lucide-react";
import PageHeader from "@/components/PageHeader";
import { Button } from "@/components/ui/button";
import {
  Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle,
} from "@/components/ui/dialog";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { Checkbox } from "@/components/ui/checkbox";
import { Switch } from "@/components/ui/switch";
import { Input } from "@/components/ui/input";
import { useToast } from "@/hooks/use-toast";
import { apiRequest, queryClient } from "@/lib/queryClient";
import { hasPageWriteAccess } from "@/lib/permissions";
import { parseApiErrorMessage } from "@/lib/apiError";
import { usePersistentFilter } from "@/hooks/usePersistentFilter";
import { SectionSkeleton } from "@/components/ui/loading-skeletons";

// Vehicle Planning: a Gantt-style fleet timeline (rows = Krupa's vehicles, columns = days) plus
// the assign-a-vehicle-to-an-order workflow. Each vehicle's bar spans its current order's start
// date to the calculated "free" date (Notion's own "Trip Complets on" formula, read server-side
// — see server/routes/vehicle-planning.ts); a vehicle with no bar in view, or past the end of
// its bar, is free and gets an Assign button.
//
// TEST MODE (server/routes/vehicle-planning.ts): the Assign action only accepts three dummy
// order numbers — the picker below is limited to exactly those. Remove there, not here, once
// this page is trusted with real orders.

type CurrentOrder = {
  orderNumber: string; partyName: string | null; plant: string | null;
  orderDate: string | null; notionStatus: string | null; tripCompletesOn: string | null;
  vehicleMismatch: boolean; mismatchProformaVehicleNumber: string | null;
} | null;

type VehicleRow = {
  id: number; vehicleNumber: string | null; rtoNumber: string | null; driver: string | null;
  state: string | null; company: string | null;
  currentOrder: CurrentOrder; busy: boolean; busyUntil: string | null; tripDays: string | null;
  hasHistory: boolean; lastSyncedAt: string | null;
};

type AvailableOrder = {
  orderNumber: string; partyName: string | null; plant: string | null;
  orderDate: string | null; vehicleNumber: string | null; notionStatus: string | null;
};

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
  { key: "vehicleNumber", label: "Vehicle", width: 56 },
  { key: "rtoNumber", label: "RTO No.", width: 104 },
  { key: "orderNumber", label: "Order No.", width: 78 },
  { key: "state", label: "Plant / State", width: 92 },
  { key: "driver", label: "Driver", width: 108 },
  { key: "tripDays", label: "Trip Days", width: 62 },
];
const ROW_LABEL_WIDTH = LABEL_COLS.reduce((sum, c) => sum + c.width, 0);
const DAY_COL_MIN_WIDTH = 42; // px per day, so the whole thing scrolls horizontally at 30 days on a phone instead of squeezing unreadable
// Mouse-wheel / arrow-key nudge amount — fixed, no user-facing control for it. The full-window
// and single-day buttons stay as a discoverable fallback for anyone who'd rather click than
// scroll/use the keyboard.
const SCROLL_STEP_DAYS = 1;

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

export default function VehiclePlanning() {
  const { toast } = useToast();
  const canWrite = hasPageWriteAccess("vehicle-planning");
  const [assignTarget, setAssignTarget] = useState<VehicleRow | null>(null);
  const [mismatchTarget, setMismatchTarget] = useState<VehicleRow | null>(null);
  const [historyTarget, setHistoryTarget] = useState<VehicleRow | null>(null);
  const [filterOpen, setFilterOpen] = useState(false);
  const [showNoHistory, setShowNoHistory] = useState(false);
  const [search, setSearch] = useState("");
  // Plant / State / Driver — each a simple multi-select (empty array = no restriction), same
  // "show only what's checked" idea as the Companies filter, just derived from whatever values
  // are actually present in the current fleet rather than its own settings table.
  const [plantFilter, setPlantFilter] = usePersistentFilter<string[]>("vehiclePlanning:plantFilter", []);
  const [stateFilter, setStateFilter] = usePersistentFilter<string[]>("vehiclePlanning:stateFilter", []);
  const [driverFilter, setDriverFilter] = usePersistentFilter<string[]>("vehiclePlanning:driverFilter", []);
  const [plantFilterOpen, setPlantFilterOpen] = useState(false);
  const [stateFilterOpen, setStateFilterOpen] = useState(false);
  const [driverFilterOpen, setDriverFilterOpen] = useState(false);
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

  const fleetQuery = useQuery<{ vehicles: VehicleRow[]; testModeOrderNumbers: string[]; companyFilters: string[] }>({
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

  const availableOrdersQuery = useQuery<{ orders: AvailableOrder[] }>({
    queryKey: ["/api/vehicle-planning/available-orders"],
    queryFn: async () => (await apiRequest("GET", "/api/vehicle-planning/available-orders")).json(),
    enabled: !!assignTarget,
  });

  const assignMutation = useMutation({
    mutationFn: async (orderNumber: string) => {
      const res = await apiRequest("POST", "/api/vehicle-planning/assign", {
        orderNumber, vehicleId: assignTarget!.id,
      });
      if (!res.ok) throw new Error((await res.json().catch(() => ({})))?.message || "Failed to assign vehicle");
      return res.json();
    },
    onSuccess: (_, orderNumber) => {
      toast({ title: "Vehicle assigned", description: `${assignTarget?.vehicleNumber} → order ${orderNumber}` });
      queryClient.invalidateQueries({ queryKey: ["/api/vehicle-planning/vehicles"] });
      setAssignTarget(null);
    },
    onError: (err: any) => toast({ title: "Could not assign vehicle", description: parseApiErrorMessage(err), variant: "destructive" }),
  });

  const syncMutation = useMutation({
    mutationFn: async () => {
      const res = await apiRequest("POST", "/api/vehicle-planning/sync");
      if (!res.ok) throw new Error((await res.json().catch(() => ({})))?.message || "Failed to sync from Notion");
      return res.json() as Promise<{ syncedVehicles: number; mismatches: number }>;
    },
    onSuccess: (result) => {
      toast({
        title: "Synced from Notion",
        description: `${result.syncedVehicles} vehicle(s) checked${result.mismatches > 0 ? ` · ${result.mismatches} vehicle mismatch(es) found` : ""}`,
      });
      queryClient.invalidateQueries({ queryKey: ["/api/vehicle-planning/vehicles"] });
    },
    onError: (err: any) => toast({ title: "Sync failed", description: parseApiErrorMessage(err), variant: "destructive" }),
  });

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
    onError: (err: any) => toast({ title: "Could not save company filter", description: parseApiErrorMessage(err), variant: "destructive" }),
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
  const testOrders = fleetQuery.data?.testModeOrderNumbers ?? [];
  const availableCompanies = settingsQuery.data?.availableCompanies ?? [];
  const activeCompanyFilters = fleetQuery.data?.companyFilters ?? [];

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
      return showNoHistory || v.hasHistory || !!searchLower;
    })
    .sort((a, b) => {
      if (!sortBy) return 0;
      const dir = sortOrder === "asc" ? 1 : -1;
      if (sortBy === "vehicleNumber") return dir * (a.vehicleNumber ?? "").localeCompare(b.vehicleNumber ?? "", undefined, { numeric: true });
      return dir * (parseInt(a.currentOrder?.orderNumber ?? "", 10) || 0) - dir * (parseInt(b.currentOrder?.orderNumber ?? "", 10) || 0);
    });
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

  // Where (as a day-index into `days`) each vehicle's bar starts/ends, clipped to the visible
  // window — null when there's nothing to show in this window at all (no order, or a trip
  // entirely outside the current range).
  function barRange(v: VehicleRow): { startIdx: number; endIdx: number } | null {
    // Draws a bar for the trip whenever it HAS a date, regardless of whether that trip is
    // currently ongoing, already finished, or hasn't started yet — v.busy only controls whether
    // the vehicle still counts as unavailable today, not whether a past/future trip is visible
    // when the viewed window is scrolled to it. Using busyUntil (null once a trip ends) here used
    // to make every past trip's bar vanish instead of just showing as a plain finished bar.
    if (!v.currentOrder?.orderDate) return null;
    const start = startOfDay(new Date(v.currentOrder.orderDate));
    const end = parseTripDate(v.currentOrder.tripCompletesOn) ?? addDays(start, 1);
    const startIdx = differenceInCalendarDays(start, windowStart);
    const endIdx = differenceInCalendarDays(end, windowStart);
    if (endIdx < 0 || startIdx >= windowDays) return null; // entirely outside the window
    return { startIdx: Math.max(0, startIdx), endIdx: Math.min(windowDays, Math.max(endIdx, startIdx + 1)) };
  }

  return (
    <div className="container mx-auto px-3 sm:px-4 py-4 sm:py-6 pb-24">
      <PageHeader
        icon={CalendarClock}
        title="Vehicle Planning"
      />

      {testOrders.length > 0 && (
        <div className="mb-4 rounded-lg border border-amber-200 bg-amber-50 px-4 py-2.5 text-sm text-amber-800">
          Test mode — assigning is only possible for orders {testOrders.join(", ")}.
        </div>
      )}

      {/* Fleet controls — Sync from Notion (the only thing that ever talks to Notion; the page
          itself just reads vehicle_planning_state), which companies to include, search, and
          whether to show vehicles with no order history at all (hidden by default). */}
      <div className="mb-3 flex flex-wrap items-center gap-2">
        <Button
          size="sm"
          variant="outline"
          className="h-8 rounded-full px-3 text-xs"
          onClick={() => syncMutation.mutate()}
          disabled={syncMutation.isPending}
        >
          <RefreshCw className={`mr-1.5 h-3.5 w-3.5 ${syncMutation.isPending ? "animate-spin" : ""}`} />
          {syncMutation.isPending ? "Syncing…" : "Sync from Notion"}
        </Button>

        <Popover open={filterOpen} onOpenChange={setFilterOpen}>
          <PopoverTrigger asChild>
            <Button size="sm" variant="outline" className="h-8 rounded-full px-3 text-xs">
              Companies{activeCompanyFilters.length > 0 ? ` (${activeCompanyFilters.length})` : ""}
            </Button>
          </PopoverTrigger>
          <PopoverContent className="w-56 space-y-2" align="start">
            <div className="text-[11px] font-semibold uppercase tracking-wide text-gray-500">Include companies</div>
            <div className="max-h-56 space-y-1.5 overflow-y-auto">
              {availableCompanies.map((company) => {
                const checked = activeCompanyFilters.some((f) => company.toLowerCase().includes(f.toLowerCase()));
                return (
                  <label key={company} className="flex items-center gap-2 text-xs text-gray-700">
                    <Checkbox
                      checked={checked}
                      onCheckedChange={(next) => {
                        const nextFilters = next
                          ? Array.from(new Set([...activeCompanyFilters, company.toLowerCase()]))
                          : activeCompanyFilters.filter((f) => !company.toLowerCase().includes(f.toLowerCase()));
                        if (nextFilters.length === 0) return; // never let it go empty
                        settingsMutation.mutate(nextFilters);
                      }}
                    />
                    {company}
                  </label>
                );
              })}
              {availableCompanies.length === 0 && (
                <div className="py-2 text-center text-xs text-gray-400">No companies found</div>
              )}
            </div>
          </PopoverContent>
        </Popover>

        {/* Plant / State / Driver — simple local multi-selects, same checkbox-list shape as
            Companies above but purely client-side (no settings row to save to; these just
            narrow what's currently displayed). */}
        {([
          { label: "Plant", open: plantFilterOpen, setOpen: setPlantFilterOpen, options: availablePlants, active: plantFilter, setActive: setPlantFilter },
          { label: "State", open: stateFilterOpen, setOpen: setStateFilterOpen, options: availableStates, active: stateFilter, setActive: setStateFilter },
          { label: "Driver", open: driverFilterOpen, setOpen: setDriverFilterOpen, options: availableDrivers, active: driverFilter, setActive: setDriverFilter },
        ] as const).map((f) => (
          <Popover key={f.label} open={f.open} onOpenChange={f.setOpen}>
            <PopoverTrigger asChild>
              <Button size="sm" variant="outline" className="h-8 rounded-full px-3 text-xs">
                {f.label}{f.active.length > 0 ? ` (${f.active.length})` : ""}
              </Button>
            </PopoverTrigger>
            <PopoverContent className="w-56 space-y-2" align="start">
              <div className="flex items-center justify-between">
                <div className="text-[11px] font-semibold uppercase tracking-wide text-gray-500">{f.label}</div>
                {f.active.length > 0 && (
                  <button type="button" className="text-[11px] text-gray-400 hover:text-red-500" onClick={() => f.setActive([])}>
                    Clear
                  </button>
                )}
              </div>
              <div className="max-h-56 space-y-1.5 overflow-y-auto">
                {f.options.map((opt) => {
                  const checked = f.active.includes(opt);
                  return (
                    <label key={opt} className="flex items-center gap-2 text-xs text-gray-700">
                      <Checkbox
                        checked={checked}
                        onCheckedChange={(next) => {
                          f.setActive(next ? [...f.active, opt] : f.active.filter((x) => x !== opt));
                        }}
                      />
                      {opt}
                    </label>
                  );
                })}
                {f.options.length === 0 && (
                  <div className="py-2 text-center text-xs text-gray-400">None found</div>
                )}
              </div>
            </PopoverContent>
          </Popover>
        ))}

        <div className="relative">
          <Search className="pointer-events-none absolute left-2.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-gray-400" />
          <Input
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="Search vehicle, driver, order…"
            className="h-8 w-56 rounded-full pl-8 text-xs"
          />
        </div>

        <label className="flex items-center gap-1.5 text-xs text-gray-600">
          <Switch checked={showNoHistory} onCheckedChange={setShowNoHistory} />
          Show vehicles with no orders
        </label>
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

      {fleetQuery.isLoading ? (
        <SectionSkeleton lines={6} />
      ) : (
        <div
          className={`overflow-x-auto border bg-white shadow-sm focus:outline-none ${ganttActive ? "border-[#001d6e]/40 ring-2 ring-[#001d6e]/30" : "border-gray-200"}`}
          tabIndex={0}
          title={ganttActive ? "Scroll or use the arrow keys to move the date range" : "Click, then scroll or use the arrow keys to move the date range"}
          onFocus={() => setGanttActive(true)}
          onBlur={() => setGanttActive(false)}
          // A click anywhere inside the table (a row, a cell, empty space) bubbles up to here —
          // explicitly focusing the container itself is what actually fires onFocus above, since
          // a plain click on a non-focusable child div doesn't bubble FOCUS the way it bubbles
          // the click event itself.
          onClick={(e) => e.currentTarget.focus()}
          // Wheel/arrow-key nudging the date window only kicks in once this box is actually
          // focused (clicked into first) — otherwise just hovering the mouse over the table
          // while scrolling the PAGE normally would hijack that scroll into a date change
          // instead, which is what this was doing before.
          onWheel={(e) => {
            if (!ganttActive) return;
            e.preventDefault();
            const delta = Math.abs(e.deltaX) > Math.abs(e.deltaY) ? e.deltaX : e.deltaY;
            if (delta === 0) return;
            setWindowStart((d) => addDays(d, delta > 0 ? SCROLL_STEP_DAYS : -SCROLL_STEP_DAYS));
          }}
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
              {LABEL_COLS.map((c) => {
                const sortKey = c.key === "vehicleNumber" || c.key === "orderNumber" ? c.key : null;
                return (
                  <div
                    key={c.key}
                    style={{ width: c.width }}
                    className={`shrink-0 truncate px-1.5 py-2 text-[10px] font-semibold uppercase tracking-wide ${sortKey ? "cursor-pointer select-none" : ""}`}
                    onClick={sortKey ? () => toggleVpSort(sortKey) : undefined}
                  >
                    {c.label}
                    {sortKey && sortBy === sortKey && (
                      sortOrder === "asc" ? <ChevronUp className="ml-0.5 inline h-3 w-3" /> : <ChevronDown className="ml-0.5 inline h-3 w-3" />
                    )}
                  </div>
                );
              })}
              <div className="flex flex-1">
                {days.map((d, i) => (
                  <div
                    key={i}
                    style={{ width: `${100 / windowDays}%`, minWidth: DAY_COL_MIN_WIDTH }}
                    className={`shrink-0 py-1.5 text-center text-[11px] ${isSameDay(d, today) ? "bg-white/15 font-bold" : ""}`}
                  >
                    <div className="opacity-70">{format(d, "EEE")}</div>
                    <div>{format(d, "d/M")}</div>
                  </div>
                ))}
              </div>
            </div>

            {/* Vehicle rows */}
            {vehicles.map((v) => {
              const bar = barRange(v);
              const canAssign = canWrite; // now shown on a busy row too, not just a free one
              return (
                <div key={v.id} className="flex border-b border-gray-100 last:border-0">
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
                      className={`shrink-0 cursor-pointer px-1.5 py-2 text-[11px] hover:bg-[#001d6e]/5 ${c.key === "driver" ? "" : "truncate"} ${c.bold ? "font-semibold text-[#001d6e]" : "text-gray-600"} ${c.key === "orderNumber" ? "flex items-center gap-1" : ""}`}
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
                  <div className="relative flex-1" style={{ minHeight: 52 }}>
                    {/* One continuous area — no per-day cell borders (that read as a boxed
                        grid); just a faint tint marking today, for date alignment. */}
                    <div className="absolute inset-0 flex">
                      {days.map((d, i) => (
                        <div
                          key={i}
                          style={{ width: `${100 / windowDays}%`, minWidth: DAY_COL_MIN_WIDTH }}
                          className={`shrink-0 ${isSameDay(d, today) ? "bg-[#001d6e]/[0.04]" : ""}`}
                        />
                      ))}
                    </div>
                    {/* Busy bar + party name + Assign — all in NORMAL flow inside one
                        absolutely-positioned wrapper (spanning from the bar's start to the
                        row's right edge), instead of each piece guessing the others' height
                        with a fixed top-[Npx]. That's what let the gap between name and bar be
                        wrong: a fixed gap can't adapt to a 1-line vs. 2-line (wrapped) name.
                        Here the browser just stacks them (gap-0.5 = the actual minimum, not a
                        guess), so the gap is exactly as tight as that row's own name needs —
                        different per row, not the same fixed number for all of them. The bar's
                        own width is now relative to THIS wrapper's width (start-to-row-end), so
                        it's rescaled accordingly; Assign sits right after it as an ordinary flex
                        sibling, which is also what keeps it correctly aligned with the bar
                        automatically, with no separate position guess needed for it either. */}
                    {bar && (
                      <div className="absolute top-0 flex flex-col gap-0.5" style={{ left: `${(bar.startIdx / windowDays) * 100}%`, right: 0 }}>
                        {/* Full name, wrapped across as many lines as it needs — NOT capped to
                            the bar's own (often narrow) width like the bar below it is. A short
                            trip's bar can be a sliver of the row while its party name still
                            needs the row's full width to read without cutting off; the row's
                            minHeight (not a fixed height) is what lets it grow to fit this. */}
                        <div
                          className="whitespace-normal break-words text-[10px] font-medium leading-[1.15] text-black"
                          title={v.currentOrder?.partyName ?? undefined}
                        >
                          {v.currentOrder?.partyName ?? "—"}
                        </div>
                        <div className="flex items-center gap-1.5">
                          <div
                            className="h-2 shrink-0 rounded-full bg-emerald-600 shadow-sm"
                            style={{ width: `${((bar.endIdx - bar.startIdx) / (windowDays - bar.startIdx)) * 100}%` }}
                            title={`#${v.currentOrder?.orderNumber} · ${v.currentOrder?.partyName ?? "—"}${v.busyUntil ? ` · free ${v.busyUntil}` : ""}`}
                          />
                          {canAssign && (
                            <button
                              type="button"
                              onClick={() => setAssignTarget(v)}
                              className="shrink-0 rounded-full border border-emerald-300 bg-emerald-50 px-2.5 py-1 text-[11px] font-semibold text-emerald-700 hover:bg-emerald-100"
                            >
                              Assign
                            </button>
                          )}
                        </div>
                      </div>
                    )}
                    {/* Free row — no bar, so Assign just sits centred at the row's start. A past
                        trip outside the viewed window no longer needs its own muted label here
                        — clicking the row (see History dialog below) shows the full past order
                        number, party name and trip days properly instead of a cramped sliver of
                        text squeezed into this row. */}
                    {canAssign && !bar && (
                      <button
                        type="button"
                        onClick={() => setAssignTarget(v)}
                        className="absolute left-2 top-1/2 -translate-y-1/2 rounded-full border border-emerald-300 bg-emerald-50 px-2.5 py-1 text-[11px] font-semibold text-emerald-700 hover:bg-emerald-100"
                      >
                        Assign
                      </button>
                    )}
                    {/* Today's highlight, drawn LAST so it sits on top of the bar above instead of
                        being hidden underneath it (the background tint earlier in this same row
                        is UNDER the bar) — pointer-events-none so it never blocks the bar's own
                        title tooltip or the Assign button sitting on/after it. */}
                    {todayInView && (
                      <div
                        className="pointer-events-none absolute top-0 h-full bg-[#001d6e]/[0.04]"
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

      <Dialog open={!!assignTarget} onOpenChange={(open) => { if (!open) setAssignTarget(null); }}>
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-1.5">
              <Truck className="h-4 w-4" /> Assign {assignTarget?.vehicleNumber}
            </DialogTitle>
            <DialogDescription>
              Pick an order to assign this vehicle to.
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-2">
            {availableOrdersQuery.isLoading ? (
              <SectionSkeleton lines={3} />
            ) : (availableOrdersQuery.data?.orders ?? []).length === 0 ? (
              <p className="py-6 text-center text-sm text-gray-400">No orders available to assign right now.</p>
            ) : (
              availableOrdersQuery.data!.orders.map((o) => (
                <button
                  key={o.orderNumber}
                  type="button"
                  disabled={assignMutation.isPending}
                  onClick={() => assignMutation.mutate(o.orderNumber)}
                  className="flex w-full items-center justify-between gap-2 rounded-lg border border-gray-200 px-3 py-2.5 text-left hover:bg-[#001d6e]/5 disabled:opacity-50"
                >
                  <div className="min-w-0">
                    <div className="text-sm font-semibold text-[#001d6e]">#{o.orderNumber}</div>
                    <div className="text-xs text-gray-500">
                      {o.partyName ?? "—"} · {o.plant ?? "—"}
                      {o.vehicleNumber && <span className="ml-1">(currently {o.vehicleNumber})</span>}
                    </div>
                  </div>
                  {assignMutation.isPending && <Loader2 className="h-4 w-4 shrink-0 animate-spin text-gray-400" />}
                </button>
              ))
            )}
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setAssignTarget(null)} disabled={assignMutation.isPending}>
              Cancel
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <Dialog open={!!mismatchTarget} onOpenChange={(open) => { if (!open) setMismatchTarget(null); }}>
        <DialogContent className="sm:max-w-md">
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
        <DialogContent className="sm:max-w-lg">
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
