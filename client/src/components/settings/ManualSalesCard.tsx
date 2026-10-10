import { useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { ShoppingCart, Loader2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { RadioGroup, RadioGroupItem } from "@/components/ui/radio-group";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { useToast } from "@/hooks/use-toast";
import { apiRequest } from "@/lib/queryClient";
import { CSV_SKIP, cleanBarcodeCell, matchColumn, parseCsvRaw, parseQty } from "@/lib/csvImportHelpers";

// Settings > Data Management > Manual Sales. Pick the ONE date the sales belong to, upload the CSV, map the columns
// (Plant, Barcode, Item Name, Quantity — only these are used, whatever else the file has), check the preview, and
// add. Each row is sold from the plant in the CSV's Plant column (the plant picked here is only the fallback for a
// file with no plant column); stock comes off that plant's whole state pool like a Loading scan and never goes
// below zero — a row the stock cannot fully cover sells what there is, and a row with no stock is skipped. The sales show in Stock Overview's Sale column on the date
// picked. A row whose name differs from the Product Master asks for a confirmation first.
// Server: server/routes/manual-sales.ts.

type Field = "plant" | "barcode" | "itemName" | "quantity";
const FIELDS: { key: Field; label: string; required: boolean; candidates: string[] }[] = [
  { key: "plant", label: "Plant", required: false, candidates: ["plant", "plantname", "stkplant", "stockplant", "warehouse", "depot", "branch"] },
  { key: "barcode", label: "Barcode / SKU", required: true, candidates: ["barcode", "sku", "itemcode", "ean", "productbarcode", "code"] },
  { key: "itemName", label: "Item Name", required: false, candidates: ["itemname", "description", "productname", "productsnamedms", "item", "name", "material"] },
  { key: "quantity", label: "Quantity", required: true, candidates: ["quantity", "qty", "totalsales", "salequantity", "saleqty", "sale", "sold", "boxes"] },
];
type Mapping = Record<Field, string>;
type SaleRow = { plant: string | null; barcode: string; itemName: string | null; quantity: number };
type Status = "ok" | "partial" | "name_differs" | "not_found" | "bad_qty" | "bad_plant" | "short" | "zero";
type PreviewRow = {
  key: string; plant: string | null; csvPlant: string | null; barcode: string; canonicalBarcode: string | null; csvName: string | null; masterName: string | null; qty: number; sellQty: number;
  status: Status; available: number | null;
  // A row whose barcode and name disagree: the products it could be, for the person to pick from.
  needsChoice: boolean; chosen: boolean;
  options: { id: number; barcode: string; name: string; source: "barcode" | "name" | "similar"; available: number; enough: boolean; canSell: boolean }[];
};
type Preview = {
  rows: PreviewRow[]; plants: string[]; totalQty: number; shortBoxes: number;
  counts: { ok: number; partial: number; needsChoice: number; nameDiffers: number; notFound: number; short: number; badQty: number; badPlant: number; zero: number };
};
type Batch = { id: number; saleDate: string; plant: string; csvFileName: string | null; rowCount: number; totalQty: number; status: string; createdByName: string | null; createdAt: string };

const todayLocal = () => {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
};

const STATUS_LABEL: Record<Status, { text: string; cls: string }> = {
  ok: { text: "OK", cls: "bg-green-100 text-green-800" },
  name_differs: { text: "Choose product", cls: "bg-amber-100 text-amber-800" },
  not_found: { text: "Not in Product Master", cls: "bg-red-100 text-red-800" },
  partial: { text: "Sells what is in stock", cls: "bg-blue-100 text-blue-800" },
  short: { text: "No stock — skipped", cls: "bg-red-100 text-red-800" },
  bad_qty: { text: "Quantity below zero", cls: "bg-red-100 text-red-800" },
  bad_plant: { text: "Unknown plant", cls: "bg-red-100 text-red-800" },
  zero: { text: "No sale", cls: "bg-gray-100 text-gray-500" },
};

// A header-less plant column (the usual export leaves it blank): the column whose values are nearly all plant names.
function guessPlantColumn(csv: { headers: string[]; rows: Record<string, string>[] }, plantNames: string[]): string | null {
  const known = new Set(plantNames.map((p) => p.trim().toLowerCase()));
  if (known.size === 0) return null;
  let best: { h: string; share: number } | null = null;
  for (const h of csv.headers) {
    const values = csv.rows.slice(0, 60).map((r) => (r[h] ?? "").trim()).filter(Boolean);
    if (values.length < 3) continue;
    const share = values.filter((v) => known.has(v.toLowerCase())).length / values.length;
    if (share >= 0.8 && (!best || share > best.share)) best = { h, share };
  }
  return best?.h ?? null;
}

export default function ManualSalesCard({ isAdmin }: { isAdmin: boolean }) {
  const { toast } = useToast();
  const queryClient = useQueryClient();
  const [open, setOpen] = useState(false);
  const [step, setStep] = useState<"setup" | "mapping" | "review">("setup");
  const [saleDate, setSaleDate] = useState(todayLocal());
  const [defaultPlant, setDefaultPlant] = useState("");
  const [csv, setCsv] = useState<{ name: string; headers: string[]; rows: Record<string, string>[] } | null>(null);
  const [mapping, setMapping] = useState<Mapping>({ plant: CSV_SKIP, barcode: CSV_SKIP, itemName: CSV_SKIP, quantity: CSV_SKIP });
  const [rows, setRows] = useState<SaleRow[]>([]);
  const [preview, setPreview] = useState<Preview | null>(null);
  const [busy, setBusy] = useState(false);
  const [confirmNames, setConfirmNames] = useState(false);
  const [showAll, setShowAll] = useState(false);
  // For each row that needed a choice (by row key): the barcode of the product whose stock goes down. No entry = skip the row.
  const [choices, setChoices] = useState<Record<string, string>>({});

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
    setOpen(false); setStep("setup"); setSaleDate(todayLocal()); setDefaultPlant(""); setCsv(null); setRows([]); setPreview(null);
    setMapping({ plant: CSV_SKIP, barcode: CSV_SKIP, itemName: CSV_SKIP, quantity: CSV_SKIP }); setConfirmNames(false); setShowAll(false); setChoices({});
  };

  async function onFile(file: File) {
    const parsed = await parseCsvRaw(file);
    if (!parsed) { toast({ title: "Could not read this file", description: "No column headers could be detected in it.", variant: "destructive" }); return; }
    if (parsed.rows.length === 0) { toast({ title: "Empty file", description: "This file has no rows.", variant: "destructive" }); return; }
    setCsv(parsed);
    const plantCol = matchColumn(parsed.headers, FIELDS[0].candidates) ?? guessPlantColumn(parsed, (plantsQuery.data ?? []).map((p) => p.name));
    setMapping({
      plant: plantCol ?? CSV_SKIP,
      barcode: matchColumn(parsed.headers, FIELDS[1].candidates) ?? CSV_SKIP,
      itemName: matchColumn(parsed.headers, FIELDS[2].candidates) ?? CSV_SKIP,
      quantity: matchColumn(parsed.headers, FIELDS[3].candidates) ?? CSV_SKIP,
    });
    setStep("mapping");
  }

  async function confirmMapping() {
    if (!csv) return;
    if (mapping.barcode === CSV_SKIP || mapping.quantity === CSV_SKIP) {
      toast({ title: "Map Barcode and Quantity", description: "Those two columns are required.", variant: "destructive" });
      return;
    }
    if (mapping.plant === CSV_SKIP && !defaultPlant) {
      toast({ title: "Which plant?", description: "Map the CSV's Plant column, or go back and pick a plant for the whole file.", variant: "destructive" });
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
        plant: mapping.plant !== CSV_SKIP ? (r[mapping.plant] ?? "").trim() || null : null,
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
      const p: Preview = await apiRequest("POST", "/api/manual-sales/preview", { saleDate, plant: defaultPlant, items: built }, false, true);
      setPreview(p);
      setStep("review");
    } catch (e: any) {
      toast({ title: "Could not check the rows", description: e?.message, variant: "destructive" });
    } finally { setBusy(false); }
  }

  async function apply(chosen: Record<string, string>, allowDuplicate = false) {
    setBusy(true);
    try {
      const r = await apiRequest("POST", "/api/manual-sales/apply", { saleDate, plant: defaultPlant, csvFileName: csv?.name ?? null, items: rows, choices: chosen, allowDuplicate }, false, true);
      const perPlant = (r.batches ?? []).map((b: any) => `${b.plant} ${b.qty}`).join(", ");
      toast({ title: "Manual sales added", description: `${r.rowsAdded} item(s), ${r.totalQty} boxes for ${saleDate} (${perPlant}).${r.partialRows ? ` ${r.partialRows} row(s) sold only what was in stock (${(r.shortBoxes ?? 0).toLocaleString()} boxes short).` : ""}${r.skipped?.length ? ` ${r.skipped.length} row(s) skipped.` : ""}` });
      queryClient.invalidateQueries({ queryKey: ["/api/manual-sales/batches"] });
      queryClient.invalidateQueries({ queryKey: ["/api/scan-sessions/reports/plant-stock"] });
      queryClient.invalidateQueries({ queryKey: ["/api/products"] });
      reset();
    } catch (e: any) {
      const msg: string = e?.message ?? "";
      if (/already added/i.test(msg) && !allowDuplicate) {
        if (window.confirm(`${msg}\n\nAdd it again anyway?`)) { await apply(chosen, true); return; }
      } else {
        toast({ title: "Could not add the sales", description: msg || "Nothing was changed.", variant: "destructive" });
      }
    } finally { setBusy(false); setConfirmNames(false); }
  }

  async function reverse(b: Batch) {
    if (!window.confirm(`Reverse batch #${b.id} (${b.csvFileName ?? "CSV"}, ${b.saleDate}, ${b.plant}, ${b.totalQty} boxes)? The boxes go back to the plants they came from and leave the Sale column.`)) return;
    try {
      await apiRequest("POST", `/api/manual-sales/batches/${b.id}/reverse`, {}, false, true);
      toast({ title: "Batch reversed", description: `${b.totalQty} boxes returned to stock.` });
      queryClient.invalidateQueries({ queryKey: ["/api/manual-sales/batches"] });
      queryClient.invalidateQueries({ queryKey: ["/api/scan-sessions/reports/plant-stock"] });
    } catch (e: any) {
      toast({ title: "Could not reverse", description: e?.message, variant: "destructive" });
    }
  }

  const choiceRows = preview?.rows.filter((r) => r.needsChoice) ?? [];
  const chosenCount = choiceRows.filter((r) => choices[r.key]).length;
  const applicable = preview ? preview.counts.ok + preview.counts.partial + chosenCount : 0;
  // Rows with nothing to say (a 0 sale) stay out of the table unless asked for.
  const shownRows = preview ? (showAll ? preview.rows : preview.rows.filter((r) => r.status !== "zero")) : [];

  return (
    <div className="p-4 border rounded-lg bg-gray-50">
      <h4 className="font-medium flex items-center"><ShoppingCart className="h-4 w-4 mr-2" /> Manual Sales</h4>
      <p className="text-sm text-gray-600 mt-1 mb-3">
        Add a day's sales from a CSV when there was no load operation. Each row is sold from the plant named in the CSV, using that plant's whole state pool, and shows in Stock Overview on the date you pick. Stock never goes below zero. Admin only.
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
            <DialogTitle>{step === "setup" ? "Add Manual Sales" : step === "mapping" ? "Map CSV Columns" : "Check and add"}</DialogTitle>
            <DialogDescription>
              {step === "setup" && "Pick the date these sales belong to, then choose the CSV. The plants come from the CSV."}
              {step === "mapping" && csv && `"${csv.name}" — ${csv.rows.length} rows. Match each field to a CSV column; the other columns are ignored.`}
              {step === "review" && `${saleDate} · ${csv?.name ?? ""}${preview?.plants.length ? ` · ${preview.plants.join(", ")}` : ""}`}
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
                  <Label>Plant for the whole file <span className="font-normal text-gray-500">(only if the CSV has no plant column)</span></Label>
                  <Select value={defaultPlant || "__csv__"} onValueChange={(v) => setDefaultPlant(v === "__csv__" ? "" : v)}>
                    <SelectTrigger><SelectValue /></SelectTrigger>
                    <SelectContent>
                      <SelectItem value="__csv__">Use the plant column in the CSV</SelectItem>
                      {(plantsQuery.data ?? []).map((p) => <SelectItem key={p.name} value={p.name}>{p.name}</SelectItem>)}
                    </SelectContent>
                  </Select>
                </div>
              </div>
              <div className="space-y-1.5">
                <Label>CSV or Excel file</Label>
                <Input type="file" accept=".csv,.xlsx,.xls" disabled={!saleDate} onChange={(e) => { const f = e.target.files?.[0]; if (f) onFile(f); e.target.value = ""; }} />
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
                        <div className="flex w-full items-center gap-1.5 sm:w-[170px] sm:shrink-0">
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
                {mapping.plant === CSV_SKIP && !defaultPlant && <p className="mt-3 text-xs text-amber-700">No plant column mapped — go Back and pick a plant for the whole file, or map the CSV's plant column above.</p>}
              </div>
              <div>
                <p className="mb-2 text-xs font-semibold uppercase tracking-wide text-gray-500">First {Math.min(5, csv.rows.length)} of {csv.rows.length} rows</p>
                <div className="overflow-x-auto border">
                  <table className="w-max min-w-full border-collapse text-xs">
                    <thead><tr>{FIELDS.map((f) => <th key={f.key} className={`whitespace-nowrap border-b border-r px-3 py-2 text-left font-semibold ${mapping[f.key] !== CSV_SKIP ? "bg-green-50 text-green-800" : "bg-gray-100 text-gray-400"}`}>{f.label}{mapping[f.key] !== CSV_SKIP && <div className="font-normal text-green-600">← {mapping[f.key]}</div>}</th>)}</tr></thead>
                    <tbody>
                      {csv.rows.slice(0, 5).map((r, i) => (
                        <tr key={i}>{FIELDS.map((f) => <td key={f.key} className="whitespace-nowrap border-b border-r px-3 py-1.5">{mapping[f.key] !== CSV_SKIP ? r[mapping[f.key]] ?? "" : f.key === "plant" && defaultPlant ? defaultPlant : "—"}</td>)}</tr>
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
                {preview.counts.needsChoice > 0 && <span className="rounded bg-amber-100 px-2 py-1 font-semibold text-amber-800">{preview.counts.needsChoice} need you to choose the product</span>}
                {preview.counts.partial > 0 && <span className="rounded bg-blue-100 px-2 py-1 font-semibold text-blue-800">{preview.counts.partial} short of stock — will sell what is there ({preview.shortBoxes.toLocaleString()} boxes short)</span>}
                {preview.counts.short > 0 && <span className="rounded bg-red-100 px-2 py-1 font-semibold text-red-800">{preview.counts.short} with no stock at all — skipped</span>}
                {preview.counts.notFound > 0 && <span className="rounded bg-red-100 px-2 py-1 font-semibold text-red-800">{preview.counts.notFound} not in Product Master — skipped</span>}
                {preview.counts.badPlant > 0 && <span className="rounded bg-red-100 px-2 py-1 font-semibold text-red-800">{preview.counts.badPlant} unknown plant — skipped</span>}
                {preview.counts.badQty > 0 && <span className="rounded bg-red-100 px-2 py-1 font-semibold text-red-800">{preview.counts.badQty} quantity below zero — skipped</span>}
                {preview.counts.zero > 0 && (
                  <button type="button" onClick={() => setShowAll((v) => !v)} className="rounded bg-gray-100 px-2 py-1 font-semibold text-gray-600 hover:bg-gray-200">
                    {preview.counts.zero} with no sale (ignored) · {showAll ? "hide" : "show"}
                  </button>
                )}
                <span className="rounded bg-gray-100 px-2 py-1 font-semibold text-gray-700">{preview.totalQty.toLocaleString()} boxes will be taken</span>
              </div>
              <div className="max-h-[48vh] overflow-auto border">
                <table className="w-full text-xs">
                  <thead className="sticky top-0 bg-gray-100"><tr className="text-left text-gray-500"><th className="px-2 py-1.5">Plant</th><th>Barcode</th><th>CSV name</th><th>Product Master name</th><th className="text-right">Qty</th><th className="text-right">In stock</th><th className="pr-2">Status</th></tr></thead>
                  <tbody>
                    {shownRows.map((r, i) => (
                      <tr key={i} className="border-b align-top">
                        <td className="px-2 py-1.5">{r.plant ?? <span className="text-red-600">{r.csvPlant ?? "—"}</span>}</td>
                        <td className="font-mono">{r.barcode}</td>
                        <td className="max-w-[170px] break-words">{r.csvName ?? "—"}</td>
                        <td className="max-w-[170px] break-words">{r.masterName ?? (r.needsChoice ? <span className="text-gray-500">{r.options.length} possible product(s)</span> : "—")}</td>
                        <td className="text-right tabular-nums">{r.qty.toLocaleString()}{r.status === "partial" && <div className="font-semibold text-blue-700">sells {r.sellQty.toLocaleString()}</div>}</td>
                        <td className="text-right tabular-nums">{r.available != null ? r.available.toLocaleString() : "—"}</td>
                        <td className="pr-2"><span className={`rounded px-1.5 py-0.5 font-semibold ${r.needsChoice ? STATUS_LABEL.name_differs.cls : STATUS_LABEL[r.status].cls}`}>{r.needsChoice ? STATUS_LABEL.name_differs.text : STATUS_LABEL[r.status].text}</span></td>
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
              <Button disabled={busy || (applicable === 0 && (preview?.counts.needsChoice ?? 0) === 0)} onClick={() => (preview && preview.counts.needsChoice > 0 ? setConfirmNames(true) : apply({}))}>
                {busy ? <Loader2 className="mr-1.5 h-4 w-4 animate-spin" /> : null}{(preview?.counts.needsChoice ?? 0) > 0 ? `Continue (${preview!.counts.ok + preview!.counts.partial} ready, ${preview!.counts.needsChoice} to choose)` : `Add ${applicable} item(s) to Sale`}
              </Button>
            )}
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <Dialog open={confirmNames} onOpenChange={(o) => { if (!busy) setConfirmNames(o); }}>
        <DialogContent className="max-w-4xl max-h-[88vh] flex flex-col rounded-xl">
          <DialogHeader>
            <DialogTitle>Choose the product for {choiceRows.length} row(s)</DialogTitle>
            <DialogDescription>
              For these rows the barcode and the name in your CSV do not point to the same product. Pick the product whose stock should go down — every product with that barcode is listed, plus any with that name or a similar name. Products that share one barcode share one pile of stock. A row you do not pick is skipped.
            </DialogDescription>
          </DialogHeader>
          <div className="flex items-center gap-3 text-xs">
            <span className="text-gray-500">{chosenCount} of {choiceRows.length} chosen</span>
            <button type="button" className="text-[#001d6e] hover:underline" onClick={() => setChoices({})}>Skip all</button>
          </div>
          <div className="min-h-0 flex-1 space-y-3 overflow-auto pr-1">
            {choiceRows.map((r) => {
              const picked = choices[r.key] ?? "__skip__";
              return (
                <div key={r.key} className={`rounded-lg border p-3 ${choices[r.key] ? "border-green-300 bg-green-50/50" : "bg-white"}`}>
                  <div className="mb-2 flex flex-wrap items-baseline justify-between gap-2 text-xs">
                    <div>
                      <span className="font-semibold text-gray-900">{r.csvName ?? "(no name)"}</span>
                      <span className="ml-2 font-mono text-gray-500">{r.barcode}</span>
                      <span className="ml-2 text-gray-500">· {r.plant}</span>
                    </div>
                    <div className="font-semibold tabular-nums">Sold: {r.qty.toLocaleString()}</div>
                  </div>
                  <RadioGroup value={picked} onValueChange={(v) => setChoices((cur) => { const n = { ...cur }; if (v === "__skip__") delete n[r.key]; else n[r.key] = v; return n; })} className="gap-1.5">
                    {r.options.map((o) => (
                      <label key={o.id} className={`flex cursor-pointer items-start gap-2 rounded border px-2 py-1.5 text-xs ${!o.canSell ? "cursor-not-allowed bg-gray-50 opacity-60" : "hover:bg-gray-50"}`}>
                        <RadioGroupItem value={String(o.id)} disabled={!o.canSell} className="mt-0.5" />
                        <span className="flex-1">
                          <span className="font-medium">{o.name}</span>
                          <span className="ml-2 font-mono text-gray-500">{o.barcode}</span>
                          <span className="ml-2 rounded bg-gray-100 px-1.5 py-0.5 text-[10px] font-semibold text-gray-600">
                            {o.source === "barcode" ? "same barcode" : o.source === "name" ? "same name" : "similar name"}
                          </span>
                        </span>
                        <span className={`shrink-0 tabular-nums ${o.enough ? "text-gray-600" : o.canSell ? "font-semibold text-blue-700" : "font-semibold text-red-600"}`}>
                          in stock {o.available.toLocaleString()}{!o.canSell ? " — none, cannot sell" : !o.enough ? ` — only ${o.available.toLocaleString()}, will sell that` : ""}
                        </span>
                      </label>
                    ))}
                    <label className="flex cursor-pointer items-center gap-2 rounded border border-dashed px-2 py-1.5 text-xs text-gray-600 hover:bg-gray-50">
                      <RadioGroupItem value="__skip__" />
                      Skip this row — do not take any stock
                    </label>
                  </RadioGroup>
                </div>
              );
            })}
          </div>
          <DialogFooter className="gap-2">
            <Button variant="outline" disabled={busy} onClick={() => setConfirmNames(false)}>Go back</Button>
            <Button disabled={busy || !preview || preview.counts.ok + preview.counts.partial + chosenCount === 0} onClick={() => apply(choices)}>
              {busy ? <Loader2 className="mr-1.5 h-4 w-4 animate-spin" /> : null}Add {preview ? preview.counts.ok + preview.counts.partial + chosenCount : 0} item(s) to Sale
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
