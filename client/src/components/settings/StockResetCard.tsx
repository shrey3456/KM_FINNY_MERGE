import { useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { RotateCcw, Loader2, Download } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { useToast } from "@/hooks/use-toast";
import { apiRequest } from "@/lib/queryClient";
import { CSV_SKIP, cleanBarcodeCell, matchColumn, parseCsvRaw, parseQty } from "@/lib/csvImportHelpers";

// Settings > Data Management > Start Fresh / Reset Stock (the fresh start). Two ways: "zero" (no file — every item goes to what was already
// scanned on/after the start day, usually 0, for one plant or all plants; the opening stock is then imported with the normal Opening Stock
// import) and "count" (upload one plant's counted stock). Pick the plant and the day the count is for, upload the
// count (Barcode + Quantity), check the preview, take the backup, type RESET STOCK. Live stock becomes: counted stock + what was
// already scanned on/after that day (so an 11 Oct purchase scanned before the count is uploaded is kept); items not in the count
// start at 0; Stock Tracking Start can be set to that day. Every run is saved with each item's stock before and after and can be
// undone. Server: server/routes/stock-reset.ts.

type Preview = {
  summary: { itemsInCount: number; countTotal: number; liveBefore: number; liveAfter: number; toZero: number; changed: number; keptSince: number; unknown: number };
  warnings: { openOrderScans: number; openLoadSlips: number; openUnloadVehicles: string[]; futureDate: boolean; salesInScope?: number };
  unknown: { barcode: string; quantity: number }[];
  rows: { plant?: string; barcode: string; name: string | null; count: number; liveBefore: number; since: number; after: number }[];
  rowsTotal: number;
};
type Batch = { id: number; plant: string; asOfDate: string; itemCount: number; countTotal: number; liveBefore: number; liveAfter: number; csvFileName: string | null; setTrackingStart: boolean; status: string; createdByName: string | null };

const todayLocal = () => { const d = new Date(); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`; };
const downloadCsv = (name: string, header: string[], rows: (string | number)[][]) => {
  const esc = (v: string | number) => `"${String(v ?? "").replace(/"/g, '""')}"`;
  const blob = new Blob(["﻿" + [header, ...rows].map((r) => r.map(esc).join(",")).join("\r\n")], { type: "text/csv;charset=utf-8" });
  const a = document.createElement("a"); a.href = URL.createObjectURL(blob); a.download = name; document.body.appendChild(a); a.click(); a.remove();
};

export default function StockResetCard({ isAdmin }: { isAdmin: boolean }) {
  const { toast } = useToast();
  const queryClient = useQueryClient();
  const [open, setOpen] = useState(false);
  const [mode, setMode] = useState<"zero" | "count">("zero");
  const [step, setStep] = useState<"setup" | "mapping" | "review">("setup");
  const [plant, setPlant] = useState("");
  const [asOf, setAsOf] = useState(todayLocal());
  const [setTracking, setSetTracking] = useState(true);
  // Off (default) = the manual adjustments (Adjust column) made on/after the start day are thrown away; scans (purchases) of that day stay. Tick to keep the adjustments too.
  const [keepSince, setKeepSince] = useState(false);
  const [csv, setCsv] = useState<{ name: string; headers: string[]; rows: Record<string, string>[] } | null>(null);
  const [mapping, setMapping] = useState({ barcode: CSV_SKIP, quantity: CSV_SKIP });
  const [items, setItems] = useState<{ barcode: string; quantity: number }[]>([]);
  const [preview, setPreview] = useState<Preview | null>(null);
  const [confirmText, setConfirmText] = useState("");
  const [busy, setBusy] = useState(false);

  const plantsQuery = useQuery<{ name: string }[]>({
    queryKey: ["/api/plants"], queryFn: () => apiRequest("GET", "/api/plants").then((r: any) => r.json()), enabled: isAdmin,
  });
  const batchesQuery = useQuery<{ batches: Batch[] }>({
    queryKey: ["/api/stock-reset/batches"], queryFn: () => apiRequest("GET", "/api/stock-reset/batches", undefined, false, true), enabled: isAdmin,
  });

  const reset = () => {
    setOpen(false); setStep("setup"); setMode("zero"); setPlant(""); setAsOf(todayLocal()); setSetTracking(true); setKeepSince(false); setCsv(null);
    setMapping({ barcode: CSV_SKIP, quantity: CSV_SKIP }); setItems([]); setPreview(null); setConfirmText("");
  };

  async function onFile(file: File) {
    const parsed = await parseCsvRaw(file);
    if (!parsed) { toast({ title: "Could not read this file", description: "No column headers could be detected in it.", variant: "destructive" }); return; }
    if (parsed.rows.length === 0) { toast({ title: "Empty file", variant: "destructive" }); return; }
    setCsv(parsed);
    setMapping({
      barcode: matchColumn(parsed.headers, ["barcode", "sku", "ean", "itemcode", "code"]) ?? CSV_SKIP,
      quantity: matchColumn(parsed.headers, ["quantity", "qty", "stock", "closingstock", "count", "boxes"]) ?? CSV_SKIP,
    });
    setStep("mapping");
  }

  async function checkZero() {
    setBusy(true);
    try {
      const p: Preview = await apiRequest("POST", "/api/stock-reset/preview", { plant, asOfDate: asOf, zeroOnly: true, keepSince }, false, true);
      setItems([]); setPreview(p); setStep("review");
    } catch (e: any) { toast({ title: "Could not check", description: e?.message, variant: "destructive" }); }
    finally { setBusy(false); }
  }

  async function check() {
    if (!csv) return;
    if (mapping.barcode === CSV_SKIP || mapping.quantity === CSV_SKIP) { toast({ title: "Map Barcode and Quantity", variant: "destructive" }); return; }
    const built: { barcode: string; quantity: number }[] = [];
    let skipped = 0;
    for (const r of csv.rows) {
      const raw = r[mapping.barcode] ?? "";
      if (!raw.trim()) continue;
      const { value, rejected } = cleanBarcodeCell(raw);
      if (rejected) { skipped++; continue; }
      built.push({ barcode: value, quantity: parseQty(r[mapping.quantity] ?? "0") });
    }
    if (built.length === 0) { toast({ title: "No valid barcodes found", variant: "destructive" }); return; }
    if (skipped > 0) toast({ title: `Skipped ${skipped} row(s) with an unreadable barcode`, description: "A total line, or a barcode Excel rounded to scientific notation.", variant: "destructive" });
    setItems(built);
    setBusy(true);
    try {
      const p: Preview = await apiRequest("POST", "/api/stock-reset/preview", { plant, asOfDate: asOf, items: built, keepSince }, false, true);
      setPreview(p); setStep("review");
    } catch (e: any) { toast({ title: "Could not check the count", description: e?.message, variant: "destructive" }); }
    finally { setBusy(false); }
  }

  async function backupNow() {
    try {
      const d: { items: { barcode: string; name: string | null; plant: string; inStock: number; extraQty: number }[] } = await apiRequest("GET", `/api/stock-reset/current-stock?plant=${encodeURIComponent(plant)}`, undefined, false, true);
      downloadCsv(`stock-backup-${plant === "all" ? "all-plants" : plant}-${todayLocal()}.csv`, ["Barcode", "Item", "Plant", "Stock", "Extra"], d.items.map((x) => [x.barcode, x.name ?? "", x.plant, x.inStock, x.extraQty]));
      toast({ title: "Stock backup downloaded", description: `${d.items.length} item(s).` });
    } catch (e: any) { toast({ title: "Could not download the backup", description: e?.message, variant: "destructive" }); }
  }

  async function apply() {
    setBusy(true);
    try {
      const r = await apiRequest("POST", "/api/stock-reset/apply", { plant, asOfDate: asOf, zeroOnly: mode === "zero", keepSince, items, csvFileName: csv?.name ?? null, setTrackingStart: setTracking, confirm: confirmText }, false, true);
      toast({ title: mode === "zero" ? "Stock zeroed" : "Stock reset done", description: `${plant === "all" ? "All plants" : plant}: live stock ${r.summary.liveBefore.toLocaleString()} → ${r.summary.liveAfter.toLocaleString()} boxes${setTracking ? `; tracking starts ${asOf}` : ""}.` });
      queryClient.invalidateQueries({ queryKey: ["/api/stock-reset/batches"] });
      queryClient.invalidateQueries({ queryKey: ["/api/scan-sessions/reports/plant-stock"] });
      queryClient.invalidateQueries({ queryKey: ["/api/settings/sales-tracking-start"] });
      queryClient.invalidateQueries({ queryKey: ["/api/products"] });
      reset();
    } catch (e: any) { toast({ title: "Could not reset the stock", description: e?.message || "Nothing was changed.", variant: "destructive" }); }
    finally { setBusy(false); }
  }

  async function undo(b: Batch) {
    if (!window.confirm(`Undo reset #${b.id} (${b.plant}, as of ${b.asOfDate})? The live stock goes back by exactly what the reset changed (scans made since are kept)${b.setTrackingStart ? " and the old Stock Tracking Start is restored" : ""}.`)) return;
    try {
      await apiRequest("POST", `/api/stock-reset/batches/${b.id}/undo`, {}, false, true);
      toast({ title: "Reset undone" });
      queryClient.invalidateQueries({ queryKey: ["/api/stock-reset/batches"] });
      queryClient.invalidateQueries({ queryKey: ["/api/scan-sessions/reports/plant-stock"] });
      queryClient.invalidateQueries({ queryKey: ["/api/settings/sales-tracking-start"] });
    } catch (e: any) { toast({ title: "Could not undo", description: e?.message, variant: "destructive" }); }
  }

  const s = preview?.summary; const w = preview?.warnings;
  const canApply = !!preview && confirmText.trim().toUpperCase() === "RESET STOCK" && !busy;

  return (
    <div className="p-4 border rounded-lg bg-gray-50">
      <h4 className="font-medium flex items-center"><RotateCcw className="h-4 w-4 mr-2" /> Start Fresh — Zero Stock / Reset to Count</h4>
      <p className="text-sm text-gray-600 mt-1 mb-3">
        Pick the start day. "Zero" sets the live stock of one plant or all plants to zero (keeping only what was already scanned on or after that day) and sets Stock Tracking Start, so Stock Overview ignores everything before it — then import the opening stock with the Opening Stock import above. "Count" does both in one step from a counted-stock file. Take the backup first; every run can be undone. Admin only.
      </p>
      <Button variant="outline" size="sm" onClick={() => setOpen(true)} disabled={!isAdmin} title={!isAdmin ? "Admin access required" : undefined}>Start Fresh / Reset Stock</Button>

      {isAdmin && (batchesQuery.data?.batches?.length ?? 0) > 0 && (
        <div className="mt-3 max-h-56 overflow-y-auto rounded border bg-white">
          <table className="w-full text-xs">
            <thead><tr className="border-b bg-gray-100 text-left text-gray-500"><th className="px-2 py-1.5">#</th><th>Plant</th><th>As of</th><th className="text-right">Items</th><th className="text-right">Before → After</th><th className="pl-3">By</th><th></th></tr></thead>
            <tbody>
              {batchesQuery.data!.batches.map((b) => (
                <tr key={b.id} className={`border-b ${b.status !== "active" ? "text-gray-400 line-through" : ""}`}>
                  <td className="px-2 py-1.5">{b.id}</td><td>{b.plant}</td><td className="tabular-nums">{b.asOfDate}</td>
                  <td className="text-right tabular-nums">{b.itemCount}</td>
                  <td className="text-right tabular-nums">{b.liveBefore.toLocaleString()} → {b.liveAfter.toLocaleString()}</td>
                  <td className="pl-3">{b.createdByName ?? "—"}</td>
                  <td className="pr-2 text-right">{b.status === "active" ? <button type="button" className="text-red-600 hover:underline" onClick={() => undo(b)}>Undo</button> : <span>undone</span>}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      <Dialog open={open} onOpenChange={(o) => { if (!o && !busy) reset(); }}>
        <DialogContent className="max-w-4xl max-h-[90vh] flex flex-col rounded-xl">
          <DialogHeader>
            <DialogTitle>{step === "setup" ? "Start Fresh / Reset Stock" : step === "mapping" ? "Map CSV Columns" : "Check, back up and reset"}</DialogTitle>
            <DialogDescription>
              {step === "setup" && "Pick what to do, the plant and the day the stock starts from (the START of that day)."}
              {step === "mapping" && csv && `"${csv.name}" — ${csv.rows.length} rows. Match Barcode and Quantity.`}
              {step === "review" && `${plant === "all" ? "All plants" : plant} · from ${asOf} · ${mode === "zero" ? "zero only" : csv?.name ?? ""}`}
            </DialogDescription>
          </DialogHeader>

          {step === "setup" && (
            <div className="space-y-4">
              <div className="grid grid-cols-2 gap-1.5">
                <button type="button" onClick={() => { setMode("zero"); setPlant(""); }} className={`rounded-md border px-2 py-1.5 text-left text-xs ${mode === "zero" ? "border-[#001d6e] bg-[#001d6e]/5 text-[#001d6e]" : "border-gray-300 text-gray-600 hover:bg-gray-50"}`}>
                  <span className="font-semibold">Zero the stock</span><br />no file — then import the opening stock
                </button>
                <button type="button" onClick={() => { setMode("count"); setPlant(""); }} className={`rounded-md border px-2 py-1.5 text-left text-xs ${mode === "count" ? "border-[#001d6e] bg-[#001d6e]/5 text-[#001d6e]" : "border-gray-300 text-gray-600 hover:bg-gray-50"}`}>
                  <span className="font-semibold">Set to a counted stock</span><br />upload the count of one plant
                </button>
              </div>
              <div className="grid gap-3 sm:grid-cols-2">
                <div className="space-y-1.5">
                  <Label>Plant</Label>
                  <Select value={plant} onValueChange={setPlant}>
                    <SelectTrigger><SelectValue placeholder="Select a plant" /></SelectTrigger>
                    <SelectContent>
                      {mode === "zero" && <SelectItem value="all">All plants</SelectItem>}
                      {(plantsQuery.data ?? []).map((p) => <SelectItem key={p.name} value={p.name}>{p.name}</SelectItem>)}
                    </SelectContent>
                  </Select>
                </div>
                <div className="space-y-1.5">
                  <Label>Stock starts from (start of this day)</Label>
                  <Input type="date" value={asOf} onChange={(e) => setAsOf(e.target.value)} />
                </div>
              </div>
              <label className="flex items-start gap-2 text-sm">
                <input type="checkbox" className="mt-1" checked={keepSince} onChange={(e) => setKeepSince(e.target.checked)} />
                <span>Keep the manual adjustments already made on or after the start day <span className="text-gray-500">(unticked = they are removed. Scans — unloading and order-scan purchases — and loads of that day always stay)</span></span>
              </label>
              <label className="flex items-center gap-2 text-sm">
                <input type="checkbox" checked={setTracking} onChange={(e) => setSetTracking(e.target.checked)} />
                Also set Stock Tracking Start to this day (Stock Overview then ignores everything before it)
              </label>
              {mode === "count" ? (
                <div className="space-y-1.5">
                  <Label>Count file (CSV or Excel)</Label>
                  <Input type="file" accept=".csv,.xlsx,.xls" disabled={!plant || !asOf} onChange={(e) => { const f = e.target.files?.[0]; if (f) onFile(f); e.target.value = ""; }} />
                  {!plant && <p className="text-xs text-gray-500">Choose the plant first.</p>}
                </div>
              ) : (
                <p className="text-xs text-gray-600">Every item of the plant goes to what was already scanned on or after the start day (usually 0). Afterwards import the opening stock for that day with the Opening Stock import — it adds to the Opening.</p>
              )}
            </div>
          )}

          {step === "mapping" && csv && (
            <div className="flex-1 min-h-0 space-y-3 overflow-y-auto pr-1">
              {([["barcode", "Barcode / SKU *"], ["quantity", "Quantity *"]] as const).map(([k, label]) => (
                <div key={k} className="flex flex-col gap-1.5 sm:flex-row sm:items-center sm:gap-3">
                  <Label className="w-[170px] shrink-0 text-sm">{label}</Label>
                  <Select value={mapping[k]} onValueChange={(v) => setMapping((m) => ({ ...m, [k]: v }))}>
                    <SelectTrigger className="h-9 text-sm sm:flex-1"><SelectValue placeholder="— choose a column —" /></SelectTrigger>
                    <SelectContent>
                      <SelectItem value={CSV_SKIP}>— skip —</SelectItem>
                      {csv.headers.map((h) => <SelectItem key={h} value={h}>{h}</SelectItem>)}
                    </SelectContent>
                  </Select>
                </div>
              ))}
              <div className="overflow-x-auto border">
                <table className="w-max min-w-full text-xs"><thead><tr className="bg-gray-100"><th className="px-3 py-1.5 text-left">Barcode</th><th className="px-3 py-1.5 text-left">Quantity</th></tr></thead>
                  <tbody>{csv.rows.slice(0, 5).map((r, i) => <tr key={i} className="border-t"><td className="px-3 py-1">{mapping.barcode !== CSV_SKIP ? r[mapping.barcode] : "—"}</td><td className="px-3 py-1">{mapping.quantity !== CSV_SKIP ? r[mapping.quantity] : "—"}</td></tr>)}</tbody></table>
              </div>
            </div>
          )}

          {step === "review" && preview && s && w && (
            <div className="flex-1 min-h-0 space-y-3 overflow-y-auto pr-1">
              <div className="flex flex-wrap gap-2 text-xs">
                <span className="rounded bg-green-100 px-2 py-1 font-semibold text-green-800">{mode === "zero" ? "Zero only — no count" : `${s.itemsInCount} item(s) counted · ${s.countTotal.toLocaleString()} boxes`}</span>
                <span className="rounded bg-gray-100 px-2 py-1 font-semibold text-gray-700">Live stock now {s.liveBefore.toLocaleString()} → after {s.liveAfter.toLocaleString()}</span>
                {s.toZero > 0 && <span className="rounded bg-red-100 px-2 py-1 font-semibold text-red-800">{s.toZero} item(s) go to 0</span>}
                {s.keptSince !== 0 && <span className="rounded bg-blue-100 px-2 py-1 font-semibold text-blue-800">{s.keptSince.toLocaleString()} boxes (net) already scanned on/after {asOf} are kept</span>}
                {s.unknown > 0 && <span className="rounded bg-amber-100 px-2 py-1 font-semibold text-amber-800">{s.unknown} barcode(s) not in Product Master — skipped</span>}
              </div>
              {(w.openOrderScans > 0 || w.openLoadSlips > 0 || w.futureDate || w.openUnloadVehicles.length > 0 || (w.salesInScope ?? 0) > 0) && (
                <div className="rounded border border-amber-300 bg-amber-50 p-3 text-xs text-amber-900 space-y-1">
                  {w.futureDate && <p>The date is in the future.</p>}
                  {(w.salesInScope ?? 0) > 0 && <p>{w.salesInScope!.toLocaleString()} boxes of loads are dated on or after {asOf}. Loads cannot be thrown away, so the live stock goes to 0 but Stock Overview will still show them as Sale.</p>}
                  {w.openOrderScans > 0 && <p>{w.openOrderScans} order-scan session(s) dated before {asOf} are still open. Finish them first — scans made after the reset count in the live stock but not in Stock Overview.</p>}
                  {w.openLoadSlips > 0 && <p>{w.openLoadSlips} loading slip(s) dated before {asOf} are still open — same reason.</p>}
                  {w.openUnloadVehicles.length > 0 && <p>Unloading not finished yet: {w.openUnloadVehicles.join(", ")}. Boxes on those vehicles are not in the count; they will show as a purchase on the day they are scanned.</p>}
                </div>
              )}
              <div className="max-h-[34vh] overflow-auto border">
                <table className="w-full text-xs">
                  <thead className="sticky top-0 bg-gray-100"><tr className="text-left text-gray-500"><th className="px-2 py-1.5">Plant</th><th>Barcode</th><th>Item</th><th className="text-right">Count</th><th className="text-right">Live now</th><th className="text-right">Kept since</th><th className="pr-2 text-right">After</th></tr></thead>
                  <tbody>
                    {preview.rows.map((r) => (
                      <tr key={`${r.plant}|${r.barcode}`} className="border-t">
                        <td className="px-2 py-1">{r.plant ?? plant}</td><td className="font-mono">{r.barcode}</td><td className="max-w-[260px] break-words">{r.name ?? "—"}</td>
                        <td className="text-right tabular-nums">{r.count}</td><td className="text-right tabular-nums">{r.liveBefore}</td>
                        <td className="text-right tabular-nums">{r.since}</td><td className={`pr-2 text-right tabular-nums font-semibold ${r.after !== r.liveBefore ? "text-[#001d6e]" : ""}`}>{r.after}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
              {preview.rowsTotal > preview.rows.length && <p className="text-xs text-gray-500">Showing the {preview.rows.length} biggest changes of {preview.rowsTotal} item(s).</p>}
              {preview.unknown.length > 0 && <details className="text-xs"><summary className="cursor-pointer font-semibold text-amber-800">Barcodes not found ({preview.unknown.length})</summary><p className="mt-1 font-mono break-all">{preview.unknown.map((u) => u.barcode).join(", ")}</p></details>}
              <div className="flex flex-wrap items-center gap-3 rounded border bg-white p-3">
                <Button variant="outline" size="sm" onClick={backupNow}><Download className="mr-1.5 h-3.5 w-3.5" /> Download current stock (backup)</Button>
                <div className="flex items-center gap-2 text-sm">
                  <Label className="text-xs">Type <span className="font-mono font-semibold">RESET STOCK</span> to confirm</Label>
                  <Input className="h-8 w-40" value={confirmText} onChange={(e) => setConfirmText(e.target.value)} />
                </div>
              </div>
            </div>
          )}

          <DialogFooter className="gap-2">
            {step !== "setup" && <Button variant="outline" disabled={busy} onClick={() => setStep(step === "review" && mode === "count" ? "mapping" : "setup")}>Back</Button>}
            <Button variant="outline" disabled={busy} onClick={reset}>Cancel</Button>
            {step === "setup" && mode === "zero" && <Button disabled={busy || !plant || !asOf} onClick={checkZero}>{busy ? <Loader2 className="mr-1.5 h-4 w-4 animate-spin" /> : null}Check</Button>}
            {step === "mapping" && <Button disabled={busy} onClick={check}>{busy ? <Loader2 className="mr-1.5 h-4 w-4 animate-spin" /> : null}Check count</Button>}
            {step === "review" && <Button variant="destructive" disabled={!canApply} onClick={apply}>{busy ? <Loader2 className="mr-1.5 h-4 w-4 animate-spin" /> : null}{mode === "zero" ? "Zero stock" : "Reset stock"}</Button>}
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
