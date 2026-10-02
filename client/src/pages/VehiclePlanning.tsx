import { useMemo, useState } from "react";
import { useMutation, useQuery } from "@tanstack/react-query";
import { addDays, differenceInCalendarDays, format, isSameDay, parse, startOfDay } from "date-fns";
import { CalendarClock, CalendarDays, ChevronLeft, ChevronRight, Loader2, Truck } from "lucide-react";
import PageHeader from "@/components/PageHeader";
import { Button } from "@/components/ui/button";
import {
  Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle,
} from "@/components/ui/dialog";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { useToast } from "@/hooks/use-toast";
import { apiRequest, queryClient } from "@/lib/queryClient";
import { hasPageWriteAccess } from "@/lib/permissions";
import { parseApiErrorMessage } from "@/lib/apiError";
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
  orderDate: string | null; notionStatus: string | null;
} | null;

type VehicleRow = {
  id: number; vehicleNumber: string | null; rtoNumber: string | null; driver: string | null;
  state: string | null; company: string | null;
  currentOrder: CurrentOrder; busy: boolean; busyUntil: string | null; tripDays: string | null;
};

type AvailableOrder = {
  orderNumber: string; partyName: string | null; plant: string | null;
  orderDate: string | null; vehicleNumber: string | null; notionStatus: string | null;
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
  { key: "driver", label: "Driver", width: 76 },
  { key: "tripDays", label: "Trip Days", width: 62 },
];
const ROW_LABEL_WIDTH = LABEL_COLS.reduce((sum, c) => sum + c.width, 0);
const DAY_COL_MIN_WIDTH = 42; // px per day, so the whole thing scrolls horizontally at 30 days on a phone instead of squeezing unreadable

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
  // Widened from the old 14|30 literal — picking a custom date range (below) sets this to
  // whatever span the user actually chose, not just one of the two presets.
  const [windowDays, setWindowDays] = useState<number>(14);
  const [windowStart, setWindowStart] = useState<Date>(() => startOfDay(new Date()));

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

  const fleetQuery = useQuery<{ vehicles: VehicleRow[]; testModeOrderNumbers: string[] }>({
    queryKey: ["/api/vehicle-planning/vehicles"],
    queryFn: async () => (await apiRequest("GET", "/api/vehicle-planning/vehicles")).json(),
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

  const vehicles = fleetQuery.data?.vehicles ?? [];
  const testOrders = fleetQuery.data?.testModeOrderNumbers ?? [];
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
    if (!v.busy || !v.currentOrder?.orderDate) return null;
    const start = startOfDay(new Date(v.currentOrder.orderDate));
    const end = parseTripDate(v.busyUntil) ?? addDays(start, 1);
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
          <Button size="sm" variant="outline" className="h-8 w-8 rounded-full p-0" onClick={() => setWindowStart((d) => addDays(d, -windowDays))} aria-label="Earlier">
            <ChevronLeft className="h-4 w-4" />
          </Button>
          <Button size="sm" variant="outline" className="h-8 rounded-full px-3 text-xs" onClick={() => setWindowStart(today)}>
            Today
          </Button>
          <Button size="sm" variant="outline" className="h-8 w-8 rounded-full p-0" onClick={() => setWindowStart((d) => addDays(d, windowDays))} aria-label="Later">
            <ChevronRight className="h-4 w-4" />
          </Button>
        </div>
      </div>

      {fleetQuery.isLoading ? (
        <SectionSkeleton lines={6} />
      ) : (
        <div className="overflow-x-auto border border-gray-200 bg-white shadow-sm">
          <div style={{ minWidth: ROW_LABEL_WIDTH + windowDays * DAY_COL_MIN_WIDTH }}>
            {/* Day header — one continuous bar with date ticks, not a row of separately
                bordered boxes (that read as "many small columns" rather than one timeline). */}
            <div className="flex border-b border-gray-200 bg-[#001d6e] text-white">
              {LABEL_COLS.map((c) => (
                <div
                  key={c.key}
                  style={{ width: c.width }}
                  className="shrink-0 truncate px-1.5 py-2 text-[10px] font-semibold uppercase tracking-wide"
                >
                  {c.label}
                </div>
              ))}
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
                      className={`shrink-0 truncate px-1.5 py-2 text-[11px] ${c.bold ? "font-semibold text-[#001d6e]" : "text-gray-600"}`}
                      title={c.value ?? undefined}
                    >
                      {c.value ?? "—"}
                    </div>
                  ))}
                  <div className="relative flex-1" style={{ height: 52 }}>
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
                        <div
                          className="line-clamp-2 text-[10px] font-medium leading-[1.15] text-black"
                          style={{ maxWidth: `${((bar.endIdx - bar.startIdx) / (windowDays - bar.startIdx)) * 100}%` }}
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
                    {/* Free row — no bar, so Assign just sits centred at the row's start. */}
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
    </div>
  );
}
