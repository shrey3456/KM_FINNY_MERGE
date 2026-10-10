import { useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Truck, Loader2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { useToast } from "@/hooks/use-toast";
import { apiRequest } from "@/lib/queryClient";
import { CSV_SKIP, matchColumn, parseCsvRaw, parseQty } from "@/lib/csvImportHelpers";

// Settings > Data Management > Load from Sales Orders file. The file lists, per ORDER NUMBER, what was really loaded
// (Order Number, Item "SAP (name)", Quantity, Party). For each order the server finds its proforma slip and records the
// loading the way a scan would — entries in Load Master, stock off the slip plant's state pool, the Sale column in Stock
// Overview — without changing the slip's status or sending anything to Notion. The file's quantity is the TOTAL for that
// order + item, so what is already loaded is counted first. Stock never goes below zero. A batch can be reversed.
// Server: server/routes/loading-sales-import.ts.

type Field = "orderNumber" | "date" | "item" | "sapCode" | "quantity" | "party";
const FIELDS: { key: Field; label: string; required: boolean; candidates: string[] }[] = [
  { key: "orderNumber", label: "Order Number", required: true, candidates: ["ordernumber", "orderno", "order", "ordno", "proformano", "slipno"] },
  { key: "date", label: "Date", required: false, candidates: ["date", "billdate", "orderdate"] },
  { key: "sapCode", label: "SAP code (if its own column)", required: false, candidates: ["sap", "sapcode"] },
  { key: "item", label: "Item name (or SAP code + name)", required: true, candidates: ["nameofitem", "tallywiseproducts", "itemname", "item", "description", "product", "material"] },
  { key: "quantity", label: "Quantity", required: true, candidates: ["balancequantity", "quantity", "qty", "balance", "boxes"] },
  { key: "party", label: "Party", required: false, candidates: ["partysname", "partyname", "party", "customer"] },
];
type Mapping = Record<Field, string>;
type FileLine = { orderNumber: string; sapCode: string | null; itemName: string | null; quantity: number; party: string | null; fileDate: string | null };
type OrderRow = {
  orderNumber: string; party: string | null; plant: string | null; vehicle: string | null; orderDate: string | null; found: boolean; completed: boolean;
  fileDate: string | null; lines: number; items: number; requested: number; boxes: number; alreadyLoaded: number; partial: number; short: number; unmatched: number;
};
type Summary = {
  orders: number; ordersFound: number; ordersMissing: number; ordersComplete: number; ordersWithoutVehicle: number; itemLines: number; boxes: number;
  requested: number; extraBoxes: number; alreadyCovered: number; partial: number; short: number; unmatched: number;
};
type ManualBatch = { id: number; saleDate: string; plant: string; csvFileName: string | null; totalQty: number };
type Preview = {
  summary: Summary; orders: OrderRow[]; dates: string[];
  problems: { orderNumber: string; party: string | null; sapCode: string | null; itemName: string | null; quantity: number; reason: string }[]; problemsTotal: number;
  shortLines: { orderNumber: string; party: string | null; plant: string | null; orderDate: string | null; itemName: string | null; sapCode: string | null; barcode: string; fileQty: number; alreadyLoaded: number; requested: number; loads: number; stock: number; noStock: boolean }[];
  manualSales: ManualBatch[]; manualSalesReversed: boolean;
};
type Batch = { id: number; saleDate: string | null; csvFileName: string | null; orderCount: number; eventCount: number; totalQty: number; note: string | null; status: string; createdByName: string | null };

// "100239 (30GM*120 CRUNCHEX CHILI TADKA WAFERS)" -> SAP + name. A cell with no brackets is taken as the name.
function splitItem(cell: string): { sapCode: string | null; itemName: string | null } {
  const t = (cell ?? "").trim();
  const m = /^(\d+)\s*\((.*)\)\s*$/s.exec(t);
  if (m) return { sapCode: m[1], itemName: m[2].trim() || null };
  const m2 = /^(\d{4,})\s+(.*)$/s.exec(t);
  if (m2) return { sapCode: m2[1], itemName: m2[2].trim() || null };
  return { sapCode: null, itemName: t || null };
}

// "1-Oct-26" or "10/01/2026" (month/day/year) -> "2026-10-01"
function parseDateCell(raw: string): string | null {
  const t = (raw ?? "").trim();
  const a = /^(\d{1,2})\/(\d{1,2})\/(\d{4})$/.exec(t);
  if (a) return `${a[3]}-${a[1].padStart(2, "0")}-${a[2].padStart(2, "0")}`;
  const months: Record<string, string> = { jan: "01", feb: "02", mar: "03", apr: "04", may: "05", jun: "06", jul: "07", aug: "08", sep: "09", oct: "10", nov: "11", dec: "12" };
  const b = /^(\d{1,2})-([A-Za-z]{3})-(\d{2,4})$/.exec(t);
  if (b && months[b[2].toLowerCase()]) return `${b[3].length === 2 ? "20" + b[3] : b[3]}-${months[b[2].toLowerCase()]}-${b[1].padStart(2, "0")}`;
  return null;
}

export default function LoadingFromSalesCard({ isAdmin }: { isAdmin: boolean }) {
  const { toast } = useToast();
  const queryClient = useQueryClient();
  const [open, setOpen] = useState(false);
  const [step, setStep] = useState<"setup" | "mapping" | "review">("setup");
  const [csv, setCsv] = useState<{ name: string; headers: string[]; rows: Record<string, string>[] } | null>(null);
  const [mapping, setMapping] = useState<Mapping>({ orderNumber: CSV_SKIP, date: CSV_SKIP, item: CSV_SKIP, sapCode: CSV_SKIP, quantity: CSV_SKIP, party: CSV_SKIP });
  const [lines, setLines] = useState<FileLine[]>([]);
  const [preview, setPreview] = useState<Preview | null>(null);
  const [reverseManual, setReverseManual] = useState(false);
  const [busy, setBusy] = useState(false);
  const [showOrders, setShowOrders] = useState(false);

  const batchesQuery = useQuery<{ batches: Batch[] }>({
    queryKey: ["/api/loading-sales/batches"],
    queryFn: () => apiRequest("GET", "/api/loading-sales/batches", undefined, false, true),
    enabled: isAdmin,
  });

  const reset = () => {
    setOpen(false); setStep("setup"); setCsv(null); setLines([]); setPreview(null); setReverseManual(false); setShowOrders(false);
    setMapping({ orderNumber: CSV_SKIP, date: CSV_SKIP, item: CSV_SKIP, sapCode: CSV_SKIP, quantity: CSV_SKIP, party: CSV_SKIP });
  };

  async function onFile(file: File) {
    const parsed = await parseCsvRaw(file);
    if (!parsed) { toast({ title: "Could not read this file", description: "No column headers could be detected in it.", variant: "destructive" }); return; }
    if (parsed.rows.length === 0) { toast({ title: "Empty file", description: "This file has no rows.", variant: "destructive" }); return; }
    setCsv(parsed);
    setMapping({
      orderNumber: matchColumn(parsed.headers, FIELDS[0].candidates) ?? CSV_SKIP,
      date: matchColumn(parsed.headers, FIELDS[1].candidates) ?? CSV_SKIP,
      sapCode: matchColumn(parsed.headers, FIELDS[2].candidates) ?? CSV_SKIP,
      item: matchColumn(parsed.headers, FIELDS[3].candidates) ?? CSV_SKIP,
      quantity: matchColumn(parsed.headers, FIELDS[4].candidates) ?? CSV_SKIP,
      party: matchColumn(parsed.headers, FIELDS[5].candidates) ?? CSV_SKIP,
    });
    setStep("mapping");
  }

  async function runPreview(built: FileLine[], reverse: boolean) {
    setBusy(true);
    try {
      const p: Preview = await apiRequest("POST", "/api/loading-sales/preview", { lines: built, reverseManualSales: reverse }, false, true);
      setPreview(p);
      setStep("review");
    } catch (e: any) {
      toast({ title: "Could not check the file", description: e?.message, variant: "destructive" });
    } finally { setBusy(false); }
  }

  async function confirmMapping() {
    if (!csv) return;
    if (FIELDS.some((f) => f.required && mapping[f.key] === CSV_SKIP)) {
      toast({ title: "Map the required columns", description: "Order Number, Item and Quantity are required.", variant: "destructive" });
      return;
    }
    const built: FileLine[] = [];
    for (const r of csv.rows) {
      const orderNumber = (r[mapping.orderNumber] ?? "").trim();
      const quantity = parseQty(r[mapping.quantity] ?? "0");
      if (!orderNumber || !/\d/.test(orderNumber) || quantity <= 0) continue; // blank, total or zero lines
      // a separate SAP column wins; otherwise the item cell may hold "SAP (name)"
      const split = splitItem(r[mapping.item] ?? "");
      const ownSap = mapping.sapCode !== CSV_SKIP ? (r[mapping.sapCode] ?? "").trim() || null : null;
      const sapCode = ownSap ?? split.sapCode;
      const itemName = ownSap ? ((r[mapping.item] ?? "").replace(/\s+/g, " ").trim() || null) : split.itemName;
      if (!sapCode && !itemName) continue;
      built.push({ orderNumber, sapCode, itemName, quantity, party: mapping.party !== CSV_SKIP ? (r[mapping.party] ?? "").trim() || null : null, fileDate: mapping.date !== CSV_SKIP ? parseDateCell(r[mapping.date] ?? "") : null });
    }
    if (built.length === 0) { toast({ title: "No usable lines", description: "Check the Order Number and Quantity mapping.", variant: "destructive" }); return; }
    setLines(built);
    setReverseManual(false);
    await runPreview(built, false);
  }

  async function apply() {
    setBusy(true);
    try {
      const r = await apiRequest("POST", "/api/loading-sales/apply", { lines, csvFileName: csv?.name ?? null, reverseManualSales: reverseManual }, false, true);
      toast({ title: "Loading created", description: `${r.ordersLoaded} order(s), ${r.events} entr${r.events === 1 ? "y" : "ies"}, ${(r.boxes ?? 0).toLocaleString()} boxes.${r.manualReversed ? ` ${r.manualReversed} manual sale batch(es) reversed first.` : ""}` });
      queryClient.invalidateQueries({ queryKey: ["/api/loading-sales/batches"] });
      queryClient.invalidateQueries({ queryKey: ["/api/manual-sales/batches"] });
      queryClient.invalidateQueries({ queryKey: ["/api/scan-sessions/reports/plant-stock"] });
      queryClient.invalidateQueries({ queryKey: ["/api/products"] });
      queryClient.invalidateQueries({ queryKey: ["/api/loading"] });
      reset();
    } catch (e: any) {
      toast({ title: "Could not create the loading", description: e?.message || "Nothing was changed.", variant: "destructive" });
    } finally { setBusy(false); }
  }

  async function reverse(b: Batch) {
    if (!window.confirm(`Reverse batch #${b.id} (${b.csvFileName ?? "file"}, ${b.totalQty.toLocaleString()} boxes, ${b.orderCount} orders)? Every entry is voided and the boxes go back to the plants they came from.`)) return;
    try {
      await apiRequest("POST", `/api/loading-sales/batches/${b.id}/reverse`, {}, false, true);
      toast({ title: "Batch reversed", description: `${b.totalQty.toLocaleString()} boxes returned to stock.` });
      queryClient.invalidateQueries({ queryKey: ["/api/loading-sales/batches"] });
      queryClient.invalidateQueries({ queryKey: ["/api/scan-sessions/reports/plant-stock"] });
      queryClient.invalidateQueries({ queryKey: ["/api/loading"] });
    } catch (e: any) {
      toast({ title: "Could not reverse", description: e?.message, variant: "destructive" });
    }
  }

  const s = preview?.summary;
  const needsManualDecision = !!preview && preview.manualSales.length > 0 && !preview.manualSalesReversed;
  const shownOrders = preview ? (showOrders ? preview.orders : preview.orders.filter((o) => !o.found || o.partial > 0 || o.short > 0 || o.unmatched > 0)) : [];

  return (
    <div className="p-4 border rounded-lg bg-gray-50">
      <h4 className="font-medium flex items-center"><Truck className="h-4 w-4 mr-2" /> Load from Sales Orders file</h4>
      <p className="text-sm text-gray-600 mt-1 mb-3">
        Upload the Sales Orders file (order number, item, quantity). Each order's slip gets its loading entries, stock comes off the slip plant's state pool and the boxes show in Stock Overview's Sale on the order date. Slip status is not changed and nothing is sent to Notion. Stock never goes below zero. Admin only.
      </p>
      <Button variant="outline" size="sm" onClick={() => setOpen(true)} disabled={!isAdmin} title={!isAdmin ? "Admin access required" : undefined}>
        Load from Sales File
      </Button>

      {isAdmin && (batchesQuery.data?.batches?.length ?? 0) > 0 && (
        <div className="mt-3 max-h-56 overflow-y-auto rounded border bg-white">
          <table className="w-full text-xs">
            <thead><tr className="border-b bg-gray-100 text-left text-gray-500"><th className="px-2 py-1.5">Date</th><th>File</th><th className="text-right">Orders</th><th className="text-right">Boxes</th><th className="pl-3">By</th><th></th></tr></thead>
            <tbody>
              {batchesQuery.data!.batches.map((b) => (
                <tr key={b.id} className={`border-b ${b.status !== "active" ? "text-gray-400 line-through" : ""}`} title={b.note ?? undefined}>
                  <td className="px-2 py-1.5 tabular-nums">{b.saleDate ?? "—"}</td>
                  <td className="max-w-[180px] truncate" title={b.csvFileName ?? ""}>{b.csvFileName ?? "—"}</td>
                  <td className="text-right tabular-nums">{b.orderCount}</td>
                  <td className="text-right tabular-nums">{b.totalQty.toLocaleString()}</td>
                  <td className="pl-3">{b.createdByName ?? "—"}</td>
                  <td className="pr-2 text-right">
                    {b.status === "active" ? <button type="button" className="text-red-600 hover:underline" onClick={() => reverse(b)}>Reverse</button> : <span>reversed</span>}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      <Dialog open={open} onOpenChange={(o) => { if (!o && !busy) reset(); }}>
        <DialogContent className="max-w-4xl max-h-[90vh] flex flex-col rounded-xl">
          <DialogHeader>
            <DialogTitle>{step === "setup" ? "Load from Sales Orders file" : step === "mapping" ? "Map CSV Columns" : "Check and create the loading"}</DialogTitle>
            <DialogDescription>
              {step === "setup" && "Choose the Sales Orders file. The orders are matched to proforma slips by order number."}
              {step === "mapping" && csv && `"${csv.name}" — ${csv.rows.length} rows. Match each field to a CSV column.`}
              {step === "review" && `${csv?.name ?? ""}${preview?.dates.length ? ` · slips dated ${preview.dates.join(", ")}` : ""}`}
            </DialogDescription>
          </DialogHeader>

          {step === "setup" && (
            <div className="space-y-1.5">
              <Label>CSV or Excel file</Label>
              <Input type="file" accept=".csv,.xlsx,.xls" onChange={(e) => { const f = e.target.files?.[0]; if (f) onFile(f); e.target.value = ""; }} />
            </div>
          )}

          {step === "mapping" && csv && (
            <div className="flex-1 min-h-0 space-y-4 overflow-y-auto pr-1">
              <div className="border bg-gray-50 p-4">
                <p className="mb-3 text-xs font-semibold uppercase tracking-wide text-gray-500">Map each field → CSV column</p>
                <div className="grid gap-3">
                  {FIELDS.map((f) => {
                    const matched = mapping[f.key] !== CSV_SKIP;
                    return (
                      <div key={f.key} className="flex flex-col gap-1.5 sm:flex-row sm:items-center sm:gap-3">
                        <div className="flex w-full items-center gap-1.5 sm:w-[190px] sm:shrink-0">
                          <span className={`h-2 w-2 rounded-full ${matched ? "bg-green-500" : "bg-gray-300"}`} />
                          <Label className="text-sm">{f.label}{f.required ? " *" : ""}</Label>
                        </div>
                        <Select value={mapping[f.key]} onValueChange={(v) => setMapping((m) => ({ ...m, [f.key]: v }))}>
                          <SelectTrigger className={`h-9 text-sm sm:flex-1 ${!matched ? "border-dashed text-gray-400" : ""}`}><SelectValue placeholder="— skip this field —" /></SelectTrigger>
                          <SelectContent>
                            <SelectItem value={CSV_SKIP}>— skip this field —</SelectItem>
                            {csv.headers.map((h) => <SelectItem key={h} value={h}>{h}</SelectItem>)}
                          </SelectContent>
                        </Select>
                      </div>
                    );
                  })}
                </div>
              </div>
              <div>
                <p className="mb-2 text-xs font-semibold uppercase tracking-wide text-gray-500">First {Math.min(5, csv.rows.length)} of {csv.rows.length} rows</p>
                <div className="overflow-x-auto border">
                  <table className="w-max min-w-full border-collapse text-xs">
                    <thead><tr>{FIELDS.map((f) => <th key={f.key} className={`whitespace-nowrap border-b border-r px-3 py-2 text-left font-semibold ${mapping[f.key] !== CSV_SKIP ? "bg-green-50 text-green-800" : "bg-gray-100 text-gray-400"}`}>{f.label}{mapping[f.key] !== CSV_SKIP && <div className="font-normal text-green-600">← {mapping[f.key]}</div>}</th>)}</tr></thead>
                    <tbody>
                      {csv.rows.slice(0, 5).map((r, i) => (
                        <tr key={i}>{FIELDS.map((f) => <td key={f.key} className="whitespace-nowrap border-b border-r px-3 py-1.5">{mapping[f.key] !== CSV_SKIP ? r[mapping[f.key]] ?? "" : "—"}</td>)}</tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </div>
            </div>
          )}

          {step === "review" && preview && s && (
            <div className="flex-1 min-h-0 space-y-3 overflow-y-auto pr-1">
              <div className="flex flex-wrap gap-2 text-xs">
                <span className="rounded bg-green-100 px-2 py-1 font-semibold text-green-800">{s.ordersFound} of {s.orders} orders found</span>
                <span className="rounded bg-gray-100 px-2 py-1 font-semibold text-gray-700">{s.boxes.toLocaleString()} boxes will be loaded</span>
                {s.extraBoxes > 0 && <span className="rounded bg-amber-100 px-2 py-1 font-semibold text-amber-800">{s.extraBoxes.toLocaleString()} of them beyond the slip (Extra)</span>}
                {s.alreadyCovered > 0 && <span className="rounded bg-gray-100 px-2 py-1 font-semibold text-gray-600">{s.alreadyCovered} item(s) already loaded — nothing added</span>}
                {s.partial > 0 && <span className="rounded bg-blue-100 px-2 py-1 font-semibold text-blue-800">{s.partial} short of stock — will load what is there</span>}
                {s.short > 0 && <span className="rounded bg-red-100 px-2 py-1 font-semibold text-red-800">{s.short} with no stock — skipped</span>}
                {s.ordersMissing > 0 && <span className="rounded bg-red-100 px-2 py-1 font-semibold text-red-800">{s.ordersMissing} order(s) have no slip — skipped</span>}
                {s.ordersComplete > 0 && <span className="rounded bg-gray-100 px-2 py-1 font-semibold text-gray-600">{s.ordersComplete} already completed — skipped</span>}
                {s.ordersWithoutVehicle > 0 && <span className="rounded bg-gray-100 px-2 py-1 font-semibold text-gray-600">{s.ordersWithoutVehicle} without a vehicle (still loaded)</span>}
                {s.unmatched > 0 && <span className="rounded bg-red-100 px-2 py-1 font-semibold text-red-800">{s.unmatched} line(s) not matched — skipped</span>}
              </div>

              {preview.manualSales.length > 0 && (
                <div className="rounded border border-amber-300 bg-amber-50 p-3 text-xs text-amber-900">
                  <p className="font-semibold">Manual sales already exist for {[...new Set(preview.manualSales.map((m) => m.saleDate))].join(", ")}</p>
                  <p className="mt-1">{preview.manualSales.map((m) => `#${m.id} ${m.plant} ${m.totalQty.toLocaleString()} boxes`).join(" · ")}. Loading this file as well would count the same sales twice.</p>
                  <label className="mt-2 flex items-center gap-2 font-medium">
                    <input type="checkbox" checked={reverseManual} disabled={busy} onChange={(e) => { setReverseManual(e.target.checked); runPreview(lines, e.target.checked); }} />
                    Reverse those manual sales first (stock they took goes back, then this file loads from it)
                  </label>
                </div>
              )}

              <div className="flex items-center gap-3 text-xs">
                <span className="text-gray-500">{showOrders ? "All orders" : "Orders needing attention"} ({shownOrders.length})</span>
                <button type="button" className="text-[#001d6e] hover:underline" onClick={() => setShowOrders((v) => !v)}>{showOrders ? "show only problems" : "show all orders"}</button>
              </div>
              <div className="max-h-[34vh] overflow-auto border">
                <table className="w-full text-xs">
                  <thead className="sticky top-0 bg-gray-100"><tr className="text-left text-gray-500"><th className="px-2 py-1.5">Order</th><th>Date</th><th>Party</th><th>Plant</th><th>Vehicle</th><th className="text-right">Items</th><th className="text-right">Loads</th><th className="pr-2 pl-3">Note</th></tr></thead>
                  <tbody>
                    {shownOrders.map((o) => (
                      <tr key={o.orderNumber} className="border-b align-top">
                        <td className="px-2 py-1.5 font-mono">{o.orderNumber}</td>
                        <td className="whitespace-nowrap tabular-nums">
                          {o.fileDate ?? o.orderDate ?? "—"}
                          {o.fileDate && o.orderDate && o.fileDate !== o.orderDate && <div className="text-[10px] font-semibold text-amber-700" title="The file's date differs from the slip's order date">slip: {o.orderDate}</div>}
                        </td>
                        <td className="max-w-[200px] break-words">{o.party ?? "—"}</td>
                        <td>{o.plant ?? "—"}</td>
                        <td>{o.vehicle ?? "—"}</td>
                        <td className="text-right tabular-nums">{o.items}</td>
                        <td className="text-right tabular-nums">{o.boxes.toLocaleString()}</td>
                        <td className="pr-2 pl-3">
                          {!o.found ? <span className="text-red-600">No slip</span>
                            : o.completed ? <span className="text-gray-500">Completed</span>
                            : <span className="text-gray-700">{[o.partial ? `${o.partial} short` : "", o.short ? `${o.short} no stock` : "", o.unmatched ? `${o.unmatched} unmatched` : "", o.alreadyLoaded ? `${o.alreadyLoaded.toLocaleString()} already loaded` : ""].filter(Boolean).join(" · ") || "OK"}</span>}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>

              {preview.problems.length > 0 && (
                <details className="rounded border bg-white p-2 text-xs">
                  <summary className="cursor-pointer font-semibold text-red-700">{preview.problemsTotal} line(s) that will be skipped{preview.problemsTotal > preview.problems.length ? ` (first ${preview.problems.length} shown)` : ""}</summary>
                  <table className="mt-2 w-full">
                    <thead><tr className="text-left text-gray-500"><th>Order</th><th>SAP</th><th>Item</th><th className="text-right">Qty</th><th className="pl-3">Why</th></tr></thead>
                    <tbody>
                      {preview.problems.map((p, i) => (
                        <tr key={i} className="border-t align-top"><td className="font-mono">{p.orderNumber}</td><td className="font-mono">{p.sapCode ?? "—"}</td><td className="max-w-[260px] break-words">{p.itemName ?? "—"}</td><td className="text-right tabular-nums">{p.quantity}</td><td className="pl-3 text-red-700">{p.reason}</td></tr>
                      ))}
                    </tbody>
                  </table>
                </details>
              )}

              {(() => {
                const noStock = preview.shortLines.filter((l) => l.noStock);
                const partial = preview.shortLines.filter((l) => !l.noStock);
                const table = (rows: typeof noStock, tone: string) => (
                  <div className="max-h-[30vh] overflow-auto border">
                    <table className="w-full text-xs">
                      <thead className="sticky top-0 bg-gray-100"><tr className="text-left text-gray-500"><th className="px-2 py-1.5">Order</th><th>Party</th><th>Plant</th><th>Date</th><th>SAP</th><th>Item</th><th>Barcode</th><th className="text-right">In file</th><th className="text-right">Already loaded</th><th className="text-right">Needed</th><th className="text-right">Stock</th><th className="pr-2 text-right">Loads</th></tr></thead>
                      <tbody>
                        {rows.map((l, i) => (
                          <tr key={i} className="border-t align-top">
                            <td className="px-2 py-1.5 font-mono">{l.orderNumber}</td>
                            <td className="max-w-[160px] break-words">{l.party ?? "—"}</td>
                            <td>{l.plant ?? "—"}</td>
                            <td className="whitespace-nowrap tabular-nums">{l.orderDate ?? "—"}</td>
                            <td className="font-mono">{l.sapCode ?? "—"}</td>
                            <td className="max-w-[220px] break-words">{l.itemName ?? "—"}</td>
                            <td className="font-mono">{l.barcode}</td>
                            <td className="text-right tabular-nums">{l.fileQty}</td>
                            <td className="text-right tabular-nums">{l.alreadyLoaded}</td>
                            <td className="text-right tabular-nums">{l.requested}</td>
                            <td className={`text-right tabular-nums font-semibold ${tone}`}>{l.stock}</td>
                            <td className="pr-2 text-right tabular-nums">{l.loads}</td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                );
                return (
                  <>
                    {noStock.length > 0 && (
                      <div className="space-y-1">
                        <p className="text-xs font-semibold text-red-700">{noStock.length} item(s) with no stock — skipped</p>
                        {table(noStock, "text-red-700")}
                      </div>
                    )}
                    {partial.length > 0 && (
                      <div className="space-y-1">
                        <p className="text-xs font-semibold text-blue-700">{partial.length} item(s) short of stock — will load what is there</p>
                        {table(partial, "text-blue-700")}
                      </div>
                    )}
                  </>
                );
              })()}
            </div>
          )}

          <DialogFooter className="gap-2">
            {step !== "setup" && <Button variant="outline" disabled={busy} onClick={() => setStep(step === "review" ? "mapping" : "setup")}>Back</Button>}
            <Button variant="outline" disabled={busy} onClick={reset}>Cancel</Button>
            {step === "mapping" && <Button disabled={busy} onClick={confirmMapping}>{busy ? <Loader2 className="mr-1.5 h-4 w-4 animate-spin" /> : null}Check file</Button>}
            {step === "review" && (
              <Button disabled={busy || !s || s.boxes === 0 || needsManualDecision} title={needsManualDecision ? "Reverse the manual sales first, or cancel" : undefined} onClick={apply}>
                {busy ? <Loader2 className="mr-1.5 h-4 w-4 animate-spin" /> : null}Create loading ({s?.boxes.toLocaleString() ?? 0} boxes)
              </Button>
            )}
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
