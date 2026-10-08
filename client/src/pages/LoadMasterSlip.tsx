import { useState } from "react";
import { useMutation, useQuery } from "@tanstack/react-query";
import { useLocation } from "wouter";
import { ArrowLeft, CheckCircle2, Clock, Loader2, Package, PackagePlus, Trash2, Undo2, X } from "lucide-react";
import { apiRequest, queryClient } from "@/lib/queryClient";
import { useToast } from "@/hooks/use-toast";
import { parseApiErrorMessage } from "@/lib/apiError";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { StatsBar } from "@/components/ui/stats-bar";
import { SectionSkeleton } from "@/components/ui/loading-skeletons";
import { PlantBadge } from "@/components/PlantBadge";
import { NotionStatusBadge } from "@/components/NotionStatusBadge";
import { ProductPhoto } from "@/components/ProductPhoto";
import { HistoryStatus } from "@/components/HistoryStatus";

// Load Master → one slip, VIEW ONLY. It shows what the Load Operations screen shows for the same slip —
// header, totals, items with their progress, and the scan history — but has no scan / extra / +/- /
// complete buttons. Users with Write Access on the Load Master page also get Void, Remove (a voided
// entry from the history list) and Delete load; everyone else only reads.

type SlipItem = {
  id: number; barcode: string | null; itemName: string | null; srNo: string | null; sapCode: string | null;
  expected: number; loaded: number; remaining: number; extraQty?: number; itemsPerPallet: number; stockAvailable: number | null;
  isComplete: boolean;
};
type SlipEvent = {
  id: number; barcode: string | null; itemName: string | null; totalQty: number; isExtra: boolean; isAdjust: boolean;
  voided: boolean; voidReason: string | null; voidedAt: string | null; scannedByName: string | null; scannedAt: string; stv: string | null;
};
type MasterSlip = {
  slip: {
    orderNumber: string; partyName: string | null; plant: string | null; orderDate: string | null; loadDate?: string | null;
    vehicleNumber: string | null; rtoNumber?: string | null; notionStatus: string | null; loadingStv: string | null;
    loadingOwnerName: string | null; loadingPausedAt: string | null; loadingCompletedAt: string | null; totalVolume: string | null;
    createdByName?: string | null;
  };
  items: SlipItem[]; allComplete: boolean; loadedVolume: number; hasLoad: boolean; events: SlipEvent[]; canWrite: boolean;
};

const day = (iso: string | null | undefined) =>
  iso ? new Date(String(iso).length <= 10 ? `${iso}T00:00:00` : iso).toLocaleDateString("en-IN", { timeZone: "Asia/Kolkata", day: "2-digit", month: "short", year: "numeric" }) : "—";
const dateTime = (iso: string | null | undefined) =>
  iso ? new Date(iso).toLocaleString("en-IN", { timeZone: "Asia/Kolkata", day: "2-digit", month: "short", hour: "2-digit", minute: "2-digit", hour12: false }) : "—";

function PltLine({ qty, ipp }: { qty: number; ipp: number }) {
  if (ipp <= 0 || qty <= 0) return null;
  const plt = Math.floor(qty / ipp);
  const loose = qty % ipp;
  const parts = [plt > 0 ? `${plt} plt` : null, loose > 0 ? `${loose} loose` : null].filter(Boolean);
  return parts.length ? <span className="block whitespace-nowrap text-[11px] font-semibold leading-tight text-violet-600">{parts.join(" · ")}</span> : null;
}

export default function LoadMasterSlip({ orderNumber }: { orderNumber: string }) {
  const [, navigate] = useLocation();
  const { toast } = useToast();
  const queryKey = ["/api/loading/master/slip", orderNumber];

  const query = useQuery<MasterSlip>({
    queryKey,
    queryFn: async () => {
      const res = await apiRequest("GET", `/api/loading/master/slip/${encodeURIComponent(orderNumber)}`);
      if (!res.ok) throw new Error((await res.json().catch(() => ({})))?.message || "Failed to load the slip");
      return res.json();
    },
    refetchInterval: 15_000,
  });
  const data = query.data;
  const refresh = () => queryClient.invalidateQueries({ queryKey });

  // ── writer actions ──────────────────────────────────────────────────────────────────────────
  const [voidTarget, setVoidTarget] = useState<SlipEvent | null>(null);
  const [voidReason, setVoidReason] = useState("");
  const [deleteOpen, setDeleteOpen] = useState(false);
  const [deleteMode, setDeleteMode] = useState<"void" | "remove">("void");

  const voidMutation = useMutation({
    mutationFn: async ({ id, reason }: { id: number; reason: string }) => {
      const res = await apiRequest("POST", `/api/loading/master/events/${id}/void`, { reason });
      return res.json();
    },
    onSuccess: () => { toast({ title: "Scan voided", description: "The boxes were put back into stock." }); setVoidTarget(null); setVoidReason(""); refresh(); },
    onError: (err: any) => toast({ title: "Could not void", description: parseApiErrorMessage(err), variant: "destructive" }),
  });
  const removeMutation = useMutation({
    mutationFn: async (id: number) => (await apiRequest("POST", `/api/loading/master/events/${id}/remove`)).json(),
    onSuccess: () => { toast({ title: "Entry removed from the history" }); refresh(); },
    onError: (err: any) => toast({ title: "Could not remove", description: parseApiErrorMessage(err), variant: "destructive" }),
  });
  const deleteMutation = useMutation({
    mutationFn: async (mode: "void" | "remove") =>
      (await apiRequest("POST", `/api/loading/master/proforma/${encodeURIComponent(orderNumber)}/reset`, { mode })).json(),
    onSuccess: () => { toast({ title: "Load deleted", description: "Its stock was put back and the slip can be started again." }); setDeleteOpen(false); refresh(); queryClient.invalidateQueries({ queryKey: ["/api/loading/date-slips"] }); },
    onError: (err: any) => toast({ title: "Could not delete the load", description: parseApiErrorMessage(err), variant: "destructive" }),
  });

  const back = (
    <Button variant="outline" size="sm" className="h-8 gap-1.5 rounded-full text-xs" onClick={() => navigate("/load-master")}>
      <ArrowLeft className="h-3.5 w-3.5" /> Back to Load Master
    </Button>
  );

  if (query.isLoading) return <div className="mx-auto w-full max-w-[1800px] space-y-3 p-3 sm:p-4">{back}<SectionSkeleton lines={8} /></div>;
  if (query.isError || !data) {
    return (
      <div className="mx-auto w-full max-w-[1800px] space-y-3 p-3 sm:p-4">
        {back}
        <div className="rounded-xl border border-red-200 bg-red-50 py-10 text-center text-base text-red-600">{(query.error as Error)?.message ?? "Failed to load the slip"}</div>
      </div>
    );
  }

  const { slip, items, events, canWrite, hasLoad } = data;
  const totals = items.reduce(
    (a, i) => ({ expected: a.expected + i.expected, loaded: a.loaded + i.loaded, remaining: a.remaining + i.remaining, extra: a.extra + Math.max(0, i.extraQty ?? 0) }),
    { expected: 0, loaded: 0, remaining: 0, extra: 0 },
  );
  const orderVolume = parseFloat(slip.totalVolume ?? "");
  const state = slip.loadingCompletedAt ? { label: "Completed", cls: "bg-emerald-100 text-emerald-700" }
    : hasLoad ? { label: slip.loadingPausedAt ? "Paused" : "Loading", cls: slip.loadingPausedAt ? "bg-amber-100 text-amber-800" : "bg-blue-100 text-blue-700" }
    : { label: "Not started", cls: "bg-gray-100 text-gray-600" };
  const pct = totals.expected > 0 ? Math.min(100, Math.round((totals.loaded / totals.expected) * 100)) : 0;

  return (
    <div className="mx-auto w-full max-w-[1800px] space-y-3 p-3 sm:p-4">
      <div className="flex flex-wrap items-center gap-2">
        {back}
        <span className="rounded-full bg-gray-100 px-2.5 py-0.5 text-xs font-semibold text-gray-600">View only</span>
        {canWrite && hasLoad && (
          <Button variant="outline" size="sm" className="ml-auto h-8 gap-1.5 rounded-full border-red-200 text-xs text-red-600 hover:bg-red-50 hover:text-red-700" onClick={() => setDeleteOpen(true)}>
            <Trash2 className="h-3.5 w-3.5" /> Delete load
          </Button>
        )}
      </div>

      {/* Header */}
      <div className="rounded-xl border border-gray-200 bg-white p-4 shadow-sm">
        <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
          <span className="text-xl font-bold text-[#001d6e]">#{slip.orderNumber}</span>
          <span className="text-base text-gray-700">{slip.partyName ?? "—"}</span>
          {slip.plant && <PlantBadge plant={slip.plant} />}
          <span className={`rounded-full px-2 py-0.5 text-xs font-semibold ${state.cls}`}>{state.label}</span>
          <NotionStatusBadge status={slip.notionStatus} />
        </div>
        <div className="mt-2 flex flex-wrap gap-x-6 gap-y-1 text-sm text-gray-600">
          <span>Order date <b className="text-gray-800">{day(slip.orderDate)}</b></span>
          {slip.loadDate && <span>Load date <b className="text-gray-800">{day(slip.loadDate)}</b></span>}
          <span>Vehicle <b className="text-gray-800">{slip.vehicleNumber ?? "—"}</b>{slip.rtoNumber ? <span className="text-gray-400"> · RTO {slip.rtoNumber}</span> : null}</span>
          <span>Dispatch Directory <b className="text-gray-800">{slip.loadingStv ?? "—"}</b></span>
          <span>Owner <b className="text-gray-800">{slip.loadingOwnerName ?? "—"}</b></span>
          {slip.loadingCompletedAt && <span>Completed <b className="text-gray-800">{dateTime(slip.loadingCompletedAt)}</b></span>}
        </div>
        <div className="mt-3 flex items-center gap-3">
          <div className="h-2 w-48 overflow-hidden rounded-full bg-gray-200"><div className="h-full bg-emerald-500" style={{ width: `${pct}%` }} /></div>
          <span className="text-sm font-semibold tabular-nums text-gray-700">{totals.loaded}/{totals.expected} · {pct}%</span>
          <span className="text-sm tabular-nums text-gray-500">
            Volume <b className="text-emerald-600">{data.loadedVolume.toFixed(2)}</b>{Number.isFinite(orderVolume) ? <> / <b className="text-gray-800">{orderVolume.toFixed(2)}</b></> : null}
          </span>
        </div>
      </div>

      <StatsBar
        singleRow
        stats={[
          { icon: Package, label: "Total", value: totals.expected, hint: `${items.length} items`, tone: "navy" },
          { icon: CheckCircle2, label: "Loaded", value: totals.loaded, hint: `${pct}%`, tone: "emerald" },
          { icon: Clock, label: "Remaining", value: totals.remaining, hint: "boxes left", tone: "red" },
          { icon: PackagePlus, label: "Extra", value: totals.extra, hint: "over the order", tone: totals.extra > 0 ? "amber" : "muted" },
        ]}
      />

      {/* Items */}
      <div className="overflow-hidden rounded-xl border border-gray-200 bg-white shadow-sm">
        <div className="border-b border-gray-100 px-4 py-3 text-lg font-semibold text-gray-900">Items on this order <span className="text-sm font-normal text-gray-400">({items.length})</span></div>
        <div className="overflow-x-auto">
          <table className="w-full min-w-[760px] text-sm">
            <thead>
              <tr className="bg-[#001d6e] text-left text-[11px] font-semibold uppercase tracking-wide text-white">
                <th className="px-3 py-2">Sr</th>
                <th className="px-3 py-2">Item</th>
                <th className="px-3 py-2 text-center">Expected</th>
                <th className="px-3 py-2 text-center">Loaded</th>
                <th className="px-3 py-2 text-center">Remaining</th>
                <th className="px-3 py-2 text-center">Extra</th>
                <th className="px-3 py-2 text-center">Stock</th>
              </tr>
            </thead>
            <tbody>
              {items.map((it) => {
                const extra = Math.max(0, it.extraQty ?? 0);
                return (
                  <tr key={`${it.id}-${it.barcode}`} className={`border-t border-gray-100 ${extra > 0 ? "bg-amber-50" : it.isComplete ? "bg-emerald-50" : "bg-white"}`}>
                    <td className="px-3 py-2 align-top text-xs font-semibold text-gray-600">{it.srNo ?? "—"}</td>
                    <td className="px-3 py-2">
                      <div className="flex items-center gap-2.5">
                        {it.itemName && <ProductPhoto name={it.itemName} zoomable className="h-11 w-11 shrink-0 rounded border border-gray-200 bg-white object-contain" />}
                        <div className="min-w-0">
                          <span className="block font-medium leading-snug text-gray-900">{it.itemName ?? "—"}</span>
                          <span className="block font-mono text-xs text-gray-400">{it.barcode}{it.sapCode ? ` · SAP ${it.sapCode}` : ""}{it.itemsPerPallet > 0 ? ` · ${it.itemsPerPallet}/plt` : ""}</span>
                        </div>
                      </div>
                    </td>
                    <td className="px-3 py-2 text-center tabular-nums"><span className="text-[17px] font-bold text-gray-800">{it.expected}</span><PltLine qty={it.expected} ipp={it.itemsPerPallet} /></td>
                    <td className="px-3 py-2 text-center tabular-nums"><span className="text-[17px] font-bold text-emerald-700">{it.loaded}</span><PltLine qty={it.loaded} ipp={it.itemsPerPallet} /></td>
                    <td className="px-3 py-2 text-center tabular-nums"><span className="text-[17px] font-bold text-[#001d6e]">{it.remaining}</span><PltLine qty={it.remaining} ipp={it.itemsPerPallet} /></td>
                    <td className="px-3 py-2 text-center tabular-nums">{extra > 0 ? <><span className="text-[17px] font-bold text-amber-600">{extra}</span><PltLine qty={extra} ipp={it.itemsPerPallet} /></> : <span className="text-gray-300">—</span>}</td>
                    <td className="px-3 py-2 text-center tabular-nums"><span className={`text-[17px] font-bold ${(it.stockAvailable ?? 0) <= 0 ? "text-red-600" : "text-gray-700"}`}>{it.stockAvailable ?? 0}</span><PltLine qty={it.stockAvailable ?? 0} ipp={it.itemsPerPallet} /></td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      </div>

      {/* History */}
      <div className="overflow-hidden rounded-xl border border-gray-200 bg-white shadow-sm">
        <div className="border-b border-gray-100 px-4 py-3 text-lg font-semibold text-gray-900">Load history <span className="text-sm font-normal text-gray-400">({events.length})</span></div>
        {events.length === 0 ? (
          <p className="py-10 text-center text-sm text-gray-400">Nothing has been scanned for this order yet.</p>
        ) : (
          <div className="max-h-[60vh] overflow-auto">
            <table className="w-full min-w-[720px] text-sm">
              <thead>
                <tr className="sticky top-0 bg-gray-100 text-left text-xs font-semibold text-gray-600">
                  <th className="px-3 py-2">Date &amp; time</th>
                  <th className="px-3 py-2">Item</th>
                  <th className="px-3 py-2 text-right">Qty</th>
                  <th className="px-3 py-2">Status</th>
                  <th className="px-3 py-2">By</th>
                  {canWrite && <th className="px-3 py-2 text-right">Action</th>}
                </tr>
              </thead>
              <tbody>
                {events.map((ev) => (
                  <tr key={ev.id} className={`border-t border-gray-100 ${ev.voided ? "bg-white opacity-60" : "bg-white"}`}>
                    <td className="whitespace-nowrap px-3 py-2 text-gray-700">{dateTime(ev.scannedAt)}</td>
                    <td className="px-3 py-2"><span className="block text-gray-900">{ev.itemName ?? "—"}</span><span className="block font-mono text-xs text-gray-400">{ev.barcode}</span></td>
                    <td className="px-3 py-2 text-right font-semibold tabular-nums">{ev.totalQty}</td>
                    <td className="px-3 py-2"><HistoryStatus source="loading" isExtra={ev.isExtra} isAdjust={ev.isAdjust} voided={ev.voided} voidReason={ev.voidReason} /></td>
                    <td className="px-3 py-2 text-gray-600">{ev.scannedByName ?? "—"}</td>
                    {canWrite && (
                      <td className="px-3 py-2 text-right">
                        {ev.voided ? (
                          <Button size="sm" variant="ghost" className="h-7 gap-1 px-2 text-xs text-gray-500 hover:text-red-600" disabled={removeMutation.isPending} onClick={() => removeMutation.mutate(ev.id)} title="Take this voided entry out of the history list">
                            <X className="h-3.5 w-3.5" /> Remove
                          </Button>
                        ) : (
                          <Button size="sm" variant="ghost" className="h-7 gap-1 px-2 text-xs text-red-600 hover:bg-red-50 hover:text-red-700" onClick={() => { setVoidTarget(ev); setVoidReason(""); }}>
                            <Undo2 className="h-3.5 w-3.5" /> Void
                          </Button>
                        )}
                      </td>
                    )}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>

      {/* Void a scan */}
      <Dialog open={!!voidTarget} onOpenChange={(open) => { if (!open) setVoidTarget(null); }}>
        <DialogContent className="max-w-md">
          <DialogHeader>
            <DialogTitle>Void this scan?</DialogTitle>
            <DialogDescription>
              {voidTarget?.itemName} · {voidTarget?.totalQty} boxes. The boxes are put back into stock and the entry stays in the history marked Voided.
            </DialogDescription>
          </DialogHeader>
          <Input value={voidReason} onChange={(e) => setVoidReason(e.target.value)} placeholder="Reason (optional)" />
          <DialogFooter>
            <Button variant="outline" onClick={() => setVoidTarget(null)}>Cancel</Button>
            <Button className="bg-red-600 text-white hover:bg-red-700" disabled={voidMutation.isPending} onClick={() => voidTarget && voidMutation.mutate({ id: voidTarget.id, reason: voidReason })}>
              {voidMutation.isPending && <Loader2 className="mr-1.5 h-3.5 w-3.5 animate-spin" />} Void scan
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Delete the whole load */}
      <Dialog open={deleteOpen} onOpenChange={setDeleteOpen}>
        <DialogContent className="max-w-md">
          <DialogHeader>
            <DialogTitle>Delete the load for #{slip.orderNumber}?</DialogTitle>
            <DialogDescription>Every scan is put back into stock, the vehicle and owner are cleared, and the slip can be started again.</DialogDescription>
          </DialogHeader>
          <div className="space-y-2 text-sm">
            <label className={`flex cursor-pointer gap-2 rounded-md border p-3 ${deleteMode === "void" ? "border-[#001d6e] bg-[#001d6e]/5" : "border-gray-200"}`}>
              <input type="radio" checked={deleteMode === "void"} onChange={() => setDeleteMode("void")} />
              <span><b>Keep the history</b> — the scans stay in the history marked Voided.</span>
            </label>
            <label className={`flex cursor-pointer gap-2 rounded-md border p-3 ${deleteMode === "remove" ? "border-red-400 bg-red-50" : "border-gray-200"}`}>
              <input type="radio" checked={deleteMode === "remove"} onChange={() => setDeleteMode("remove")} />
              <span><b>Remove everything</b> — the scans and the history are deleted, as if this load never happened.</span>
            </label>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setDeleteOpen(false)}>Cancel</Button>
            <Button className="bg-red-600 text-white hover:bg-red-700" disabled={deleteMutation.isPending} onClick={() => deleteMutation.mutate(deleteMode)}>
              {deleteMutation.isPending && <Loader2 className="mr-1.5 h-3.5 w-3.5 animate-spin" />} Delete load
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
