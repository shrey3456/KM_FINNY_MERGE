import { useEffect, useState } from "react";
import { useMutation, useQuery } from "@tanstack/react-query";
import { AlertTriangle, CalendarDays, CheckCircle2, Info, Loader2, RefreshCw, RotateCcw, Undo2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { useToast } from "@/hooks/use-toast";
import { apiRequest, queryClient } from "@/lib/queryClient";
import { parseApiErrorMessage } from "@/lib/apiError";

// Vehicle Planning - "Reset planning" (clear our planning board and start again from a day; Notion is never changed), the banner that follows a reset (Undo, change the
// start day), and the "Why is the trip extended?" dialog. Kept apart from the page itself, which is already long.

const fleetKey = ["/api/vehicle-planning/vehicles"];
const fmtDay = (day: string | null | undefined) => {
  if (!day) return "-";
  const [y, m, d] = day.slice(0, 10).split("-");
  return `${d}-${m}-${y}`;
};

type Preview = {
  companyFilters: string[]; vehiclesWithTrips: number; trips: number; slipsToClear: number;
  kept: { orderNumber: string; vehicleNumber: string | null; reason: string }[]; keptCount: number;
  currentStartDate: string | null; today: string;
};
type ResetResult = { resetId: number; vehiclesCleared: number; trips: number; slipsCleared: number; kept: { orderNumber: string }[]; keptCount: number; startDate: string };

function Tile({ value, label, tone = "text-[#001d6e]" }: { value: number; label: string; tone?: string }) {
  return (
    <div className="rounded-xl border border-gray-200 bg-white px-3 py-3 text-center shadow-sm">
      <div className={`text-2xl font-bold tabular-nums ${tone}`}>{value.toLocaleString()}</div>
      <div className="mt-0.5 text-[11px] leading-tight text-gray-500">{label}</div>
    </div>
  );
}

// ─── Reset planning ───────────────────────────────────────────────────────────────────────────────────────────────

export function ResetPlanningDialog({ open, onOpenChange, onRefreshNow }: { open: boolean; onOpenChange: (open: boolean) => void; onRefreshNow: () => void }) {
  const { toast } = useToast();
  const [startDate, setStartDate] = useState("");
  const [confirmText, setConfirmText] = useState("");
  const [showKept, setShowKept] = useState(false);
  const [result, setResult] = useState<ResetResult | null>(null);

  const preview = useQuery<Preview>({
    queryKey: ["/api/vehicle-planning/reset/preview"],
    queryFn: async () => (await apiRequest("GET", "/api/vehicle-planning/reset/preview")).json(),
    enabled: open && !result,
    staleTime: 0,
    refetchOnMount: "always",
  });
  useEffect(() => { if (open) { setConfirmText(""); setShowKept(false); setResult(null); } }, [open]);
  useEffect(() => { if (open && preview.data && !startDate) setStartDate(preview.data.today); }, [open, preview.data, startDate]);

  const resetMutation = useMutation({
    mutationFn: async () => {
      const res = await apiRequest("POST", "/api/vehicle-planning/reset", { startDate, confirm: confirmText.trim() });
      if (!res.ok) throw new Error((await res.json().catch(() => ({})))?.message || "Failed to reset planning");
      return res.json() as Promise<ResetResult>;
    },
    onSuccess: (r) => { setResult(r); queryClient.invalidateQueries({ queryKey: fleetKey }); },
    onError: (err: any) => toast({ title: "Could not reset planning", description: parseApiErrorMessage(err), variant: "destructive" }),
  });

  const p = preview.data;
  const nothing = !!p && p.trips === 0;
  const canReset = !!p && !nothing && !!startDate && confirmText.trim().toUpperCase() === "RESET" && !resetMutation.isPending;

  return (
    <Dialog open={open} onOpenChange={(o) => { if (!resetMutation.isPending) onOpenChange(o); }}>
      <DialogContent className="max-w-[calc(100vw-1rem)] overflow-x-hidden sm:max-w-xl [&>*]:min-w-0">
        {result ? (
          <>
            <DialogHeader>
              <DialogTitle className="flex items-center gap-2 text-emerald-700"><CheckCircle2 className="h-5 w-5" /> Planning reset</DialogTitle>
              <DialogDescription>The board is clear. Notion was not changed.</DialogDescription>
            </DialogHeader>
            <div className="grid grid-cols-3 gap-2">
              <Tile value={result.trips} label="trips cleared" />
              <Tile value={result.slipsCleared} label="slips lost their vehicle" />
              <Tile value={result.keptCount} label="kept (gone out or loading)" tone="text-amber-600" />
            </div>
            <p className="rounded-lg bg-gray-50 px-3 py-2 text-xs text-gray-600">
              Refresh from Notion now brings in each vehicle's latest order dated <strong>{fmtDay(result.startDate)}</strong> or later. You can undo this reset for 7 days from the banner on the page.
            </p>
            <DialogFooter className="gap-2 sm:gap-2">
              <Button variant="outline" onClick={() => onOpenChange(false)}>Close</Button>
              <Button onClick={() => { onOpenChange(false); onRefreshNow(); }}><RefreshCw className="mr-1.5 h-4 w-4" /> Refresh from Notion now</Button>
            </DialogFooter>
          </>
        ) : (
          <>
            <DialogHeader>
              <DialogTitle className="flex items-center gap-2"><RotateCcw className="h-4 w-4 text-red-600" /> Reset planning</DialogTitle>
              <DialogDescription>Clear our planning board and start again from a day you choose.</DialogDescription>
            </DialogHeader>

            {preview.isLoading ? (
              <div className="flex items-center justify-center gap-2 py-10 text-sm text-gray-500"><Loader2 className="h-4 w-4 animate-spin" /> Counting what will be cleared…</div>
            ) : preview.isError || !p ? (
              <p className="py-6 text-center text-sm text-red-600">Could not load the counts. Close this and try again.</p>
            ) : (
              <div className="space-y-3">
                <div className="flex flex-wrap items-center gap-1.5 text-xs text-gray-600">
                  <span>Vehicles in:</span>
                  {p.companyFilters.map((c) => <span key={c} className="rounded-full border border-[#001d6e]/20 bg-[#001d6e]/5 px-2 py-0.5 font-medium capitalize text-[#001d6e]">{c}</span>)}
                  <span className="text-gray-400">(the companies selected on this page)</span>
                </div>

                <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
                  <Tile value={p.vehiclesWithTrips} label="vehicles with trips" />
                  <Tile value={p.trips} label="trips on the board" />
                  <Tile value={p.slipsToClear} label="slips lose their vehicle and driver" tone="text-red-600" />
                  <Tile value={p.keptCount} label="kept (gone out or loading)" tone="text-amber-600" />
                </div>
                {p.keptCount > 0 && (
                  <div className="text-xs">
                    <button type="button" className="font-medium text-[#001d6e] underline decoration-dotted underline-offset-2" onClick={() => setShowKept((v) => !v)}>
                      {showKept ? "Hide" : "Which ones are kept?"}
                    </button>
                    {showKept && (
                      <ul className="mt-1.5 max-h-28 space-y-0.5 overflow-y-auto rounded-lg bg-amber-50 px-3 py-2 text-amber-900">
                        {p.kept.map((k) => <li key={k.orderNumber}>#{k.orderNumber}{k.vehicleNumber ? ` (${k.vehicleNumber})` : ""} - {k.reason}</li>)}
                        {p.keptCount > p.kept.length && <li>and {p.keptCount - p.kept.length} more…</li>}
                      </ul>
                    )}
                  </div>
                )}

                <div className="space-y-1">
                  <label className="flex items-center gap-1.5 text-xs font-semibold text-gray-700"><CalendarDays className="h-3.5 w-3.5 text-gray-400" /> Start fresh from</label>
                  <Input type="date" value={startDate} onChange={(e) => setStartDate(e.target.value)} className="h-9 w-full sm:w-52" />
                  <p className="text-[11px] text-gray-500">Orders dated before this day are not brought back by Refresh from Notion.</p>
                </div>

                <div className="flex gap-2 rounded-lg border border-blue-100 bg-blue-50 px-3 py-2 text-xs text-blue-900">
                  <Info className="mt-0.5 h-3.5 w-3.5 shrink-0" />
                  <span><strong>Notion is not changed.</strong> Its vehicles stay as they are. After the reset, Refresh from Notion fetches each vehicle's latest order from the start day on.</span>
                </div>

                {nothing ? (
                  <p className="rounded-lg bg-gray-50 px-3 py-2 text-center text-xs text-gray-500">There is nothing on the board to clear.</p>
                ) : (
                  <div className="space-y-1">
                    <label className="flex items-center gap-1.5 text-xs font-semibold text-gray-700"><AlertTriangle className="h-3.5 w-3.5 text-red-500" /> Type RESET to confirm</label>
                    <Input value={confirmText} onChange={(e) => setConfirmText(e.target.value)} placeholder="RESET" className="h-9 w-full font-mono tracking-widest sm:w-52" autoComplete="off" />
                  </div>
                )}
              </div>
            )}

            <DialogFooter className="gap-2 sm:gap-2">
              <Button variant="outline" disabled={resetMutation.isPending} onClick={() => onOpenChange(false)}>Cancel</Button>
              <Button variant="destructive" disabled={!canReset} onClick={() => resetMutation.mutate()}>
                {resetMutation.isPending ? <Loader2 className="h-4 w-4 animate-spin" /> : "Reset planning"}
              </Button>
            </DialogFooter>
          </>
        )}
      </DialogContent>
    </Dialog>
  );
}

// ─── The banner after a reset ─────────────────────────────────────────────────────────────────────────────────────

export type LastReset = { id: number; at: string; byName: string | null; startDate: string | null };

export function ResetBanner({ planningStartDate, lastReset, lastRefreshedAt, isAdmin, onRefreshNow, onResetAgain }: { planningStartDate: string | null; lastReset: LastReset | null; lastRefreshedAt: string | null; isAdmin: boolean; onRefreshNow: () => void; onResetAgain: () => void }) {
  const { toast } = useToast();
  const [sure, setSure] = useState(false);
  const [dateOpen, setDateOpen] = useState(false);
  const [draft, setDraft] = useState("");
  useEffect(() => { setDraft(planningStartDate ?? ""); }, [planningStartDate, dateOpen]);

  const undoMutation = useMutation({
    mutationFn: async () => {
      const res = await apiRequest("POST", "/api/vehicle-planning/reset/undo", { id: lastReset!.id });
      if (!res.ok) throw new Error((await res.json().catch(() => ({})))?.message || "Failed to undo the reset");
      return res.json() as Promise<{ trips: number; slips: number }>;
    },
    onSuccess: (r) => {
      toast({ title: "Reset undone", description: `${r.trips} trip(s) and ${r.slips} slip(s) put back.` });
      setSure(false);
      queryClient.invalidateQueries({ queryKey: fleetKey });
    },
    onError: (err: any) => toast({ title: "Could not undo", description: parseApiErrorMessage(err), variant: "destructive" }),
  });
  const dateMutation = useMutation({
    mutationFn: async (startDate: string | null) => {
      const res = await apiRequest("POST", "/api/vehicle-planning/start-date", { startDate });
      if (!res.ok) throw new Error((await res.json().catch(() => ({})))?.message || "Failed to save the start date");
      return res.json();
    },
    onSuccess: () => { setDateOpen(false); queryClient.invalidateQueries({ queryKey: fleetKey }); },
    onError: (err: any) => toast({ title: "Could not save", description: parseApiErrorMessage(err), variant: "destructive" }),
  });

  // The line is only for the moment between the reset and the next Refresh from Notion; once a Refresh has run since, it goes away
  // (the start date and Reset planning stay in the Companies settings).
  if (!lastReset || (lastRefreshedAt && new Date(lastRefreshedAt) > new Date(lastReset.at))) return null;
  const when = new Date(lastReset.at).toLocaleString("en-IN", { timeZone: "Asia/Kolkata", day: "2-digit", month: "short", hour: "numeric", minute: "2-digit", hour12: true });

  return (
    <div className="mb-3 flex flex-wrap items-center gap-x-3 gap-y-1.5 rounded-xl border border-amber-200 bg-amber-50 px-3 py-2 text-xs text-amber-900">
      <RotateCcw className="h-3.5 w-3.5 shrink-0" />
      <span className="min-w-0">
        Planning was reset on <strong>{when}</strong>{lastReset.byName ? <> by {lastReset.byName}</> : null}. {planningStartDate ? <>Refresh from Notion starts from <strong>{fmtDay(planningStartDate)}</strong>.</> : <>Press Refresh from Notion to bring the orders in.</>}
      </span>
      {isAdmin && (
        <span className="flex flex-wrap items-center gap-1.5">
          {(sure ? (
            <>
              <span className="font-medium">Put everything back?</span>
              <Button size="sm" className="h-7 px-2.5 text-xs" disabled={undoMutation.isPending} onClick={() => undoMutation.mutate()}>
                {undoMutation.isPending ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : "Yes, undo"}
              </Button>
              <Button size="sm" variant="ghost" className="h-7 px-2 text-xs" onClick={() => setSure(false)}>No</Button>
            </>
          ) : (
            <Button size="sm" variant="outline" className="h-7 border-amber-300 bg-white px-2.5 text-xs" onClick={() => setSure(true)}><Undo2 className="mr-1 h-3.5 w-3.5" /> Undo reset</Button>
          ))}
          <Popover open={dateOpen} onOpenChange={setDateOpen}>
            <PopoverTrigger asChild>
              <Button size="sm" variant="outline" className="h-7 border-amber-300 bg-white px-2.5 text-xs"><CalendarDays className="mr-1 h-3.5 w-3.5" /> Change start date</Button>
            </PopoverTrigger>
            <PopoverContent className="w-60 space-y-2" align="start">
              <div className="text-[11px] font-semibold uppercase tracking-wide text-gray-500">Refresh from Notion starts from</div>
              <Input type="date" value={draft} onChange={(e) => setDraft(e.target.value)} className="h-9" />
              <div className="flex items-center justify-between gap-2">
                <button type="button" className="text-[11px] text-gray-500 underline decoration-dotted hover:text-red-600" disabled={dateMutation.isPending} onClick={() => dateMutation.mutate(null)}>Remove the date</button>
                <Button size="sm" className="h-8 px-3 text-xs" disabled={!draft || dateMutation.isPending} onClick={() => dateMutation.mutate(draft)}>
                  {dateMutation.isPending ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : "Save"}
                </Button>
              </div>
            </PopoverContent>
          </Popover>
          <Button size="sm" variant="ghost" className="h-7 px-2 text-xs" onClick={onRefreshNow}><RefreshCw className="mr-1 h-3.5 w-3.5" /> Refresh from Notion</Button>
          <Button size="sm" variant="outline" className="h-7 border-red-200 bg-white px-2.5 text-xs text-red-700 hover:bg-red-50 hover:text-red-800" onClick={onResetAgain}><RotateCcw className="mr-1 h-3.5 w-3.5" /> Reset planning</Button>
        </span>
      )}
    </div>
  );
}

// The start-fresh day as a row inside the Companies settings (the banner above is only there until the next Refresh).
export function PlanningStartDateRow({ planningStartDate }: { planningStartDate: string | null }) {
  const { toast } = useToast();
  const [draft, setDraft] = useState("");
  useEffect(() => { setDraft(planningStartDate ?? ""); }, [planningStartDate]);
  const save = useMutation({
    mutationFn: async (startDate: string | null) => {
      const res = await apiRequest("POST", "/api/vehicle-planning/start-date", { startDate });
      if (!res.ok) throw new Error((await res.json().catch(() => ({})))?.message || "Failed to save the start date");
      return res.json();
    },
    onSuccess: () => queryClient.invalidateQueries({ queryKey: fleetKey }),
    onError: (err: any) => toast({ title: "Could not save", description: parseApiErrorMessage(err), variant: "destructive" }),
  });
  return (
    <div className="space-y-1.5">
      <div className="text-[11px] font-semibold uppercase tracking-wide text-gray-500">Refresh from Notion starts from</div>
      <Input type="date" value={draft} onChange={(e) => setDraft(e.target.value)} className="h-8 text-xs" />
      <div className="flex items-center justify-between gap-2">
        <button type="button" className="text-[11px] text-gray-500 underline decoration-dotted hover:text-red-600 disabled:opacity-40" disabled={!planningStartDate || save.isPending} onClick={() => save.mutate(null)}>Remove the date</button>
        <Button size="sm" className="h-7 px-3 text-xs" disabled={!draft || draft === (planningStartDate ?? "") || save.isPending} onClick={() => save.mutate(draft)}>
          {save.isPending ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : "Save"}
        </Button>
      </div>
    </div>
  );
}

// ─── Why is the trip extended? ────────────────────────────────────────────────────────────────────────────────────

const REASONS = ["Breakdown", "Waiting to unload", "Road / traffic", "Party delay", "Other"] as const;

export function ExtendReasonDialog({ ask, pending, onCancel, onConfirm }: {
  ask: { vehicleNumber: string | null; orders: string[]; oldEnd: string; newEnd: string; extraDays: number } | null;
  pending: boolean;
  onCancel: () => void;
  onConfirm: (reason: string) => void;
}) {
  const [chip, setChip] = useState<(typeof REASONS)[number] | "">("");
  const [text, setText] = useState("");
  useEffect(() => { if (ask) { setChip(""); setText(""); } }, [ask?.orders.join(","), ask?.newEnd]);
  const detail = text.trim();
  const reason = chip === "Other" ? detail : chip ? (detail ? `${chip} - ${detail}` : chip) : "";
  const valid = chip !== "" && reason.length >= 3;

  return (
    <Dialog open={!!ask} onOpenChange={(o) => { if (!o && !pending) onCancel(); }}>
      <DialogContent className="max-w-[calc(100vw-1rem)] overflow-x-hidden sm:max-w-md [&>*]:min-w-0">
        <DialogHeader>
          <DialogTitle>Why is the trip extended?</DialogTitle>
          <DialogDescription>
            {ask && (
              <>
                {ask.orders.length > 1 ? "Orders " : "Order "}{ask.orders.map((o) => `#${o}`).join(" + ")}{ask.vehicleNumber ? ` · ${ask.vehicleNumber}` : ""}
                <span className="mt-1 block font-medium text-gray-800">
                  Ends {fmtDay(ask.oldEnd)} → {fmtDay(ask.newEnd)} <span className="text-red-600">(+{ask.extraDays} day{ask.extraDays === 1 ? "" : "s"})</span>
                </span>
              </>
            )}
          </DialogDescription>
        </DialogHeader>
        <div className="space-y-3">
          <div className="flex flex-wrap gap-1.5">
            {REASONS.map((r) => (
              <button key={r} type="button" onClick={() => setChip(r)}
                className={`rounded-full px-3 py-1 text-xs font-medium ${chip === r ? "bg-[#001d6e] text-white" : "border border-gray-200 bg-white text-gray-600 hover:bg-gray-50"}`}>
                {r}
              </button>
            ))}
          </div>
          <div className="space-y-1">
            <label className="text-xs font-semibold text-gray-700">{chip === "Other" ? "Reason (required)" : "More detail (optional)"}</label>
            <Input value={text} onChange={(e) => setText(e.target.value)} maxLength={200} placeholder="For example: the truck waited 2 days at the party's godown" className="h-9" />
          </div>
        </div>
        <DialogFooter className="gap-2 sm:gap-2">
          <Button variant="outline" disabled={pending} onClick={onCancel}>Cancel</Button>
          <Button disabled={!valid || pending} onClick={() => onConfirm(reason)}>
            {pending ? <Loader2 className="h-4 w-4 animate-spin" /> : "Save extension"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
