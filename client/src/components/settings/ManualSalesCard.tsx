import { useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { ShoppingCart, Loader2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import {
  AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent, AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { useToast } from "@/hooks/use-toast";
import { apiRequest } from "@/lib/queryClient";
import { CSV_SKIP, cleanBarcodeCell, matchColumn, parseCsvRaw, parseQty } from "@/lib/csvImportHelpers";

// Settings > Data Management > Manual Sales. Pick the sale date and plant, upload the day's CSV, map the columns
// (Barcode, Item Name, Quantity — only these are used, whatever else the file has), check the preview, and add.
// Stock comes off the plant's whole state pool like a Loading scan, and the sale shows in Stock Overview's Sale
// column on the date picked. A row whose name differs from the Product Master asks for a confirmation first.
// Server: server/routes/manual-sales.ts.

type Field = "barcode" | "itemName" | "quantity";
const FIELDS: { key: Field; label: string; candidates: string[] }[] = [
  { key: "barcode", label: "Barcode / SKU", candidates: ["barcode", "itemcode", "sku", "ean", "productbarcode", "code"] },
  { key: "itemName", label: "Item Name", candidates: ["itemname", "description", "productname", "item", "name", "material"] },
  { key: "quantity", label: "Quantity", candidates: ["quantity", "qty", "salequantity", "saleqty", "sale", "sold", "boxes"] },
];
type Mapping = Record<Field, string>;
type SaleRow = { barcode: string; itemName: string | null; quantity: number };
type PreviewRow = {
  barcode: string; canonicalBarcode: string | null; csvName: string | null; masterName: string | null; qty: number;
  status: "ok" | "name_differs" | "not_found" | "bad_qty" | "short"; available: number | null; suggestion: { barcode: string; name: string } | null;
};
type Preview = { rows: PreviewRow[]; counts: { ok: number; nameDiffers: number; notFound: number; short: number; badQty: number }; totalQty: number };
type Batch = { id: number; saleDate: string; plant: string; csvFileName: string | null; rowCount: number; totalQty: number; status: string; createdByName: string | null; createdAt: string };

const todayLocal = () => {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
};

const STATUS_LABEL: Record<PreviewRow["status"], { text: string; cls: string }> = {
  ok: { text: "OK", cls: "bg-green-100 text-green-800" },
  name_differs: { text: "Name differs", cls: "bg-amber-100 text-amber-800" },
  not_found: { text: "Not in Product Master", cls: "bg-red-100 text-red-800" },
  short: { text: "Not enough stock", cls: "bg-red-100 text-red-800" },
  bad_qty: { text: "Quantity missing", cls: "bg-red-100 text-red-800" },
};

export default function ManualSalesCard({ isAdmin }: { isAdmin: boolean }) {
  const { toast } = useToast();
  const queryClient = useQueryClient();
  const [open, setOpen] = useState(false);
  const [step, setStep] = useState<"setup" | "mapping" | "review">("setup");
  const [saleDate, setSaleDate] = useState(todayLocal());
  const [plant, setPlant] = useState("");
  const [csv, setCsv] = useState<{ name: string; headers: string[]; rows: Record<string, string>[] } | null>(null);
  const [mapping, setMapping] = useState<Mapping>({ barcode: CSV_SKIP, itemName: CSV_SKIP, quantity: CSV_SKIP });
  const [rows, setRows] = useState<SaleRow[]>([]);
  const [preview, setPreview] = useState<Preview | null>(null);
  const [busy, setBusy] = useState(false);
  const [confirmNames, setConfirmNames] = useState(false);

  const plantsQuery = useQuery<{ name: string }[]>({
    queryKey: ["/api/plants"],
    queryFn: () => apiRequest("GET", "/api/plants").then((r: any) => r.json()),
    enabled: isAdmin,
  });
  const batchesQuery = useQuery<{ batches: Batch[] }>({
    queryKey: ["/api/manual-sales/batches"],
    queryFn: () => apiRequest("GET", "/api/manual-sales/batches", undefined, false, true),
    enabled: isAdmin,
  });

  const reset = () => {
    setOpen(false); setStep("setup"); setSaleDate(todayLocal()); setPlant(""); setCsv(null); setRows([]); setPreview(null);
    setMapping({ barcode: CSV_SKIP, itemName: CSV_SKIP, quantity: CSV_SKIP }); setConfirmNames(false);
  };

  async function onFile(file: File) {
    const parsed = await parseCsvRaw(file);
    if (!parsed) { toast({ title: "Could not read this file", description: "No column headers could be detected in it.", variant: "destructive" }); return; }
    if (parsed.rows.length === 0) { toast({ title: "Empty file", description: "This file has no rows.", variant: "destructive" }); return; }
    setCsv(parsed);
    setMapping({
      barcode: matchColumn(parsed.headers, FIELDS[0].candidates) ?? CSV_SKIP,
      itemName: matchColumn(parsed.headers, FIELDS[1].candidates) ?? CSV_SKIP,
      quantity: matchColumn(parsed.headers, FIELDS[2].candidates) ?? CSV_SKIP,
    });
    setStep("mapping");
  }

  async function confirmMapping() {
    if (!csv) return;
    if (mapping.barcode === CSV_SKIP || mapping.quantity === CSV_SKIP) {
      toast({ title: "Map Barcode and Quantity", description: "Those two columns are required.", variant: "destructive" });
      return;
    }
    const built: SaleRow[] = [];
    let skipped = 0;
    for (const r of csv.rows) {
      const raw = r[mapping.barcode] ?? "";
      if (!raw.trim()) continue; // a blank line, not a bad one
      const { value, rejected } = cleanBarcodeCell(raw);
      if (rejected) { skipped++; continue; }
      built.push({
        barcode: value,
        itemName: mapping.itemName !== CSV_SKIP ? (r[mapping.itemName] ?? "").trim() || null : null,
        quantity: parseQty(r[mapping.quantity] ?? "0"),
      });
    }
    if (built.length === 0) { toast({ title: "No valid barcodes found", description: "Check the Barcode column mapping.", variant: "destructive" }); return; }
    if (skipped > 0) toast({ title: `Skipped ${skipped} row(s) with an unreadable barcode`, description: "A total line, or a barcode Excel rounded to scientific notation.", variant: "destructive" });
    setRows(built);
    setBusy(true);
    try {
      const p: Preview = await apiRequest("POST", "/api/manual-sales/preview", { plant, saleDate, items: built }, false, true);
      setPreview(p);
      setStep("review");
    } catch (e: any) {
      toast({ title: "Could not check the rows", description: e?.message, variant: "destructive" });
    } finally { setBusy(false); }
  }

  async function apply(confirmNameDiffers: boolean, allowDuplicate = false) {
    setBusy(true);
    try {
      const r = await apiRequest("POST", "/api/manual-sales/apply", { plant, saleDate, csvFileName: csv?.name ?? null, items: rows, confirmNameDiffers, allowDuplicate }, false, true);
      toast({ title: "Manual sales added", description: `${r.rowsAdded} item(s), ${r.totalQty} boxes taken from stock for ${saleDate}.${r.skipped?.length ? ` ${r.skipped.length} row(s) skipped.` : ""}` });
      queryClient.invalidateQueries({ queryKey: ["/api/manual-sales/batches"] });
      queryClient.invalidateQueries({ queryKey: ["/api/scan-sessions/reports/plant-stock"] });
      queryClient.invalidateQueries({ queryKey: ["/api/products"] });
      reset();
    } catch (e: any) {
      const msg: string = e?.message ?? "";
      if (/already added/i.test(msg) && !allowDuplicate) {
        if (window.confirm(`${msg}\n\nAdd it again anyway?`)) { await apply(confirmNameDiffers, true); return; }
      } else {
        toast({ title: "Could not add the sales", description: msg || "Nothing was changed.", variant: "destructive" });
      }
    } finally { setBusy(false); setConfirmNames(false); }
  }

  async function reverse(b: Batch) {
    if (!window.confirm(`Reverse batch #${b.id} (${b.csvFileName ?? "CSV"}, ${b.saleDate}, ${b.totalQty} boxes)? The boxes go back to the plants they came from and leave the Sale column.`)) return;
    try {
      await apiRequest("POST", `/api/manual-sales/batches/${b.id}/reverse`, {}, false, true);
      toast({ title: "Batch reversed", description: `${b.totalQty} boxes returned to stock.` });
      queryClient.invalidateQueries({ queryKey: ["/api/manual-sales/batches"] });
      queryClient.invalidateQueries({ queryKey: ["/api/scan-sessions/reports/plant-stock"] });
    } catch (e: any) {
      toast({ title: "Could not reverse", description: e?.message, variant: "destructive" });
    }
  }

  const applicable = preview ? preview.counts.ok + preview.counts.nameDiffers : 0;
  const nameDiffRows = preview?.rows.filter((r) => r.status === "name_differs") ?? [];

  return (
    <div className="p-4 border rounded-lg bg-gray-50">
      <h4 className="font-medium flex items-center"><ShoppingCart className="h-4 w-4 mr-2" /> Manual Sales</h4>
      <p className="text-sm text-gray-600 mt-1 mb-3">
        Add a day's sales from a CSV when there was no load operation. Stock is taken from the plant's whole state pool, and the sale shows in Stock Overview on the date you pick. Admin only.
      </p>
      <Button variant="outline" size="sm" onClick={() => setOpen(true)} disabled={!isAdmin} title={!isAdmin ? "Admin access required" : undefined}>
        Add Manual Sales
      </Button>

      {isAdmin && (batchesQuery.data?.batches?.length ?? 0) > 0 && (
        <div className="mt-3 max-h-56 overflow-y-auto rounded border bg-white">
          <table className="w-full text-xs">
            <thead><tr className="border-b bg-gray-100 text-left text-gray-500"><th className="px-2 py-1.5">Date</th><th>Plant</th><th>File</th><th className="text-right">Boxes</th><th>By</th><th></th></tr></thead>
            <tbody>
              {batchesQuery.data!.batches.map((b) => (
                <tr key={b.id} className={`border-b ${b.status !== "active" ? "text-gray-400 line-through" : ""}`}>
                  <td className="px-2 py-1.5 tabular-nums">{b.saleDate}</td>
                  <td>{b.plant}</td>
                  <td className="max-w-[180px] truncate" title={b.csvFileName ?? ""}>{b.csvFileName ?? "—"}</td>
                  <td className="text-right tabular-nums">{b.totalQty.toLocaleString()}</td>
                  <td>{b.createdByName ?? "—"}</td>
                  <td className="pr-2 text-right">
                    {b.status === "active" ? <button type="button" className="text-red-600 hover:underline" onClick={() => reverse(b)}>Reverse</button> : <span className="no-underline">reversed</span>}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      <Dialog open={open} onOpenChange={(o) => { if (!o && !busy) reset(); }}>
        <DialogContent className="max-w-3xl max-h-[90vh] flex flex-col rounded-xl">
          <DialogHeader>
            <DialogTitle>{step === "setup" ? "Add Manual Sales" : step === "mapping" ? "Map CSV Columns" : "Check and add"}</DialogTitle>
            <DialogDescription>
              {step === "setup" && "Pick the date these sales belong to and the plant they were sold from, then choose the CSV."}
              {step === "mapping" && csv && `"${csv.name}" — ${csv.rows.length} rows. Match each field to a CSV column; the other columns are ignored.`}
              {step === "review" && `${plant} · ${saleDate} · ${csv?.name ?? ""}`}
            </DialogDescription>
          </DialogHeader>

          {step === "setup" && (
            <div className="space-y-4">
              <div className="grid gap-3 sm:grid-cols-2">
                <div className="space-y-1.5">
                  <Label>Sale date</Label>
                  <Input type="date" value={saleDate} onChange={(e) => setSaleDate(e.target.value)} />
                </div>
                <div className="space-y-1.5">
                  <Label>Plant</Label>
                  <Select value={plant} onValueChange={setPlant}>
                    <SelectTrigger><SelectValue placeholder="Select plant" /></SelectTrigger>
                    <SelectContent>{(plantsQuery.data ?? []).map((p) => <SelectItem key={p.name} value={p.name}>{p.name}</SelectItem>)}</SelectContent>
                  </Select>
                </div>
              </div>
              <div className="space-y-1.5">
                <Label>CSV or Excel file</Label>
                <Input type="file" accept=".csv,.xlsx,.xls" disabled={!plant || !saleDate} onChange={(e) => { const f = e.target.files?.[0]; if (f) onFile(f); e.target.value = ""; }} />
                {(!plant || !saleDate) && <p className="text-xs text-gray-500">Pick the date and the plant first.</p>}
              </div>
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
                        <div className="flex w-full items-center gap-1.5 sm:w-[150px] sm:shrink-0">
                          <span className={`h-2 w-2 rounded-full ${matched ? "bg-green-500" : "bg-gray-300"}`} />
                          <Label className="text-sm">{f.label}{f.key === "itemName" ? "" : " *"}</Label>
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
                    <thead><tr>{FIELDS.map((f) => <th key={f.key} className={`whitespace-nowrap border-b border-r px-3 py-2 text-left font-semibold ${mapping[f.key] !== CSV_SKIP ? "bg-green-50 text-green-800" : "bg-gray-100 text-gray-400"}`}>{f.label}</th>)}</tr></thead>
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

          {step === "review" && preview && (
            <div className="flex-1 min-h-0 space-y-3 overflow-y-auto pr-1">
              <div className="flex flex-wrap gap-2 text-xs">
                <span className="rounded bg-green-100 px-2 py-1 font-semibold text-green-800">{preview.counts.ok} OK</span>
                {preview.counts.nameDiffers > 0 && <span className="rounded bg-amber-100 px-2 py-1 font-semibold text-amber-800">{preview.counts.nameDiffers} name differs</span>}
                {preview.counts.notFound > 0 && <span className="rounded bg-red-100 px-2 py-1 font-semibold text-red-800">{preview.counts.notFound} not found — skipped</span>}
                {preview.counts.short > 0 && <span className="rounded bg-red-100 px-2 py-1 font-semibold text-red-800">{preview.counts.short} not enough stock — skipped</span>}
                {preview.counts.badQty > 0 && <span className="rounded bg-red-100 px-2 py-1 font-semibold text-red-800">{preview.counts.badQty} no quantity — skipped</span>}
                <span className="rounded bg-gray-100 px-2 py-1 font-semibold text-gray-700">{preview.totalQty.toLocaleString()} boxes will be taken</span>
              </div>
              <div className="max-h-[48vh] overflow-auto border">
                <table className="w-full text-xs">
                  <thead className="sticky top-0 bg-gray-100"><tr className="text-left text-gray-500"><th className="px-2 py-1.5">Barcode</th><th>CSV name</th><th>Product Master name</th><th className="text-right">Qty</th><th className="text-right">In stock</th><th className="pr-2">Status</th></tr></thead>
                  <tbody>
                    {preview.rows.map((r, i) => (
                      <tr key={i} className="border-b align-top">
                        <td className="px-2 py-1.5 font-mono">{r.barcode}</td>
                        <td className="max-w-[170px] break-words">{r.csvName ?? "—"}</td>
                        <td className="max-w-[170px] break-words">{r.masterName ?? (r.suggestion ? <span className="text-gray-500">Did you mean {r.suggestion.name} ({r.suggestion.barcode})?</span> : "—")}</td>
                        <td className="text-right tabular-nums">{r.qty.toLocaleString()}</td>
                        <td className="text-right tabular-nums">{r.available != null ? r.available.toLocaleString() : "—"}</td>
                        <td className="pr-2"><span className={`rounded px-1.5 py-0.5 font-semibold ${STATUS_LABEL[r.status].cls}`}>{STATUS_LABEL[r.status].text}</span></td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </div>
          )}

          <DialogFooter className="gap-2">
            {step !== "setup" && <Button variant="outline" disabled={busy} onClick={() => setStep(step === "review" ? "mapping" : "setup")}>Back</Button>}
            <Button variant="outline" disabled={busy} onClick={reset}>Cancel</Button>
            {step === "mapping" && <Button disabled={busy} onClick={confirmMapping}>{busy ? <Loader2 className="mr-1.5 h-4 w-4 animate-spin" /> : null}Check rows</Button>}
            {step === "review" && (
              <Button disabled={busy || applicable === 0} onClick={() => (preview && preview.counts.nameDiffers > 0 ? setConfirmNames(true) : apply(false))}>
                {busy ? <Loader2 className="mr-1.5 h-4 w-4 animate-spin" /> : null}Add {applicable} item(s) to Sale
              </Button>
            )}
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <AlertDialog open={confirmNames} onOpenChange={setConfirmNames}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>{nameDiffRows.length} row(s) have a different name</AlertDialogTitle>
            <AlertDialogDescription>
              The barcode is in the Product Master, but the name in your CSV is not the same as the one there. If you continue, these rows are added by their barcode, as the Product Master item:
            </AlertDialogDescription>
          </AlertDialogHeader>
          <ul className="max-h-48 space-y-1 overflow-y-auto text-xs">
            {nameDiffRows.slice(0, 8).map((r, i) => (
              <li key={i} className="rounded border p-1.5"><span className="font-mono">{r.barcode}</span><br />CSV: {r.csvName}<br />Product Master: {r.masterName}</li>
            ))}
            {nameDiffRows.length > 8 && <li className="text-gray-500">…and {nameDiffRows.length - 8} more</li>}
          </ul>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={busy}>Go back</AlertDialogCancel>
            <AlertDialogAction disabled={busy} onClick={(e) => { e.preventDefault(); apply(true); }}>Yes, add them</AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}
