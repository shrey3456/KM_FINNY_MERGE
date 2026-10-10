import { useState } from "react";
import { useQuery, useMutation } from "@tanstack/react-query";
import { Link } from "wouter";
import { ArrowLeft, FileText, Loader2, Upload } from "lucide-react";
import { useAuth } from "@/hooks/use-auth";
import { useToast } from "@/hooks/use-toast";
import { apiRequest } from "@/lib/queryClient";
import PageHeader from "@/components/PageHeader";
import { Button } from "@/components/ui/button";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";

// CSV upload for loads that already left the warehouse. The preview saves nothing; "Create loading" (after the preview) records the
// matched lines as loading entries through /api/loading-sales (server/routes/loading-sales-import.ts), using the matches and the
// link / skip picks made here.
// The plant comes from each order's slip. Only an order whose slip has no plant asks for one, and
// that pick is used for this preview only (never written to the slip).

type Product = { id: number; barcode: string; name: string };

type PreviewLine = {
  key: string;
  sapCode: string | null;
  csvName: string;
  csvQty: number | null;
  unit: string;
  status: "same" | "extra" | "less" | "newExtra" | "unmatched" | "ambiguous" | "skipped";
  linked?: boolean;
  product?: Product;
  candidates?: Product[];
  suggestions?: Array<Product & { score: number; reason?: string }>;
  slipQty?: number;
  difference?: number;
};

type PreviewOrder = {
  orderNumber: string;
  date: string | null;
  party: string;
  plant: string | null;
  plantFrom?: "slip" | "picked";
  status: "ready" | "needsPlant" | "alreadyRecorded" | "notInSystem";
  lines: PreviewLine[];
  slipOnly: Array<{ barcode: string; itemName: string; sapCode: string; quantity: number }>;
};

type PreviewResponse = {
  fileLines: number;
  summary: Record<string, number>;
  orders: PreviewOrder[];
};

type Pending = { key: string; product: Product } | null;

const LINE_LABEL: Record<PreviewLine["status"], string> = {
  same: "Same",
  extra: "CSV has more (Extra)",
  less: "CSV has less (Less)",
  newExtra: "Not on slip (Extra)",
  unmatched: "No SAP match",
  ambiguous: "More than one match",
  skipped: "Skipped",
};

const LINE_CLASS: Record<PreviewLine["status"], string> = {
  same: "text-gray-600",
  extra: "text-amber-700 font-medium",
  less: "text-red-700 font-medium",
  newExtra: "text-amber-700 font-medium",
  unmatched: "text-red-700 font-semibold",
  ambiguous: "text-red-700 font-semibold",
  skipped: "text-gray-400 line-through",
};

const ORDER_LABEL: Record<PreviewOrder["status"], string> = {
  ready: "Ready",
  needsPlant: "Plant needed",
  alreadyRecorded: "Already recorded — skipped",
  notInSystem: "Not in system — skipped",
};

type StockLine = { orderNumber: string; party: string | null; plant: string | null; itemName: string | null; sapCode: string | null; barcode: string; fileQty: number; alreadyLoaded: number; requested: number; loads: number; stock: number; noStock: boolean };
type StockCheck = { boxes: number; shortBoxes: number; lines: StockLine[]; lineCount: number } | null;

// Every matched line of every ready order (same / extra / less / not on slip), with the product the preview matched it to.
function linesOf(p: PreviewResponse | null | undefined) {
  return (p?.orders ?? [])
    .filter((o) => o.status === "ready")
    .flatMap((o) => o.lines
      .filter((l) => l.product && l.status !== "skipped" && l.status !== "unmatched" && l.status !== "ambiguous" && (l.csvQty ?? 0) > 0)
      .map((l) => ({ orderNumber: o.orderNumber, party: o.party, sapCode: l.sapCode, itemName: l.csvName, quantity: l.csvQty, barcode: l.product!.barcode })));
}

export default function LoadCsvUpload() {
  const { user } = useAuth();
  const { toast } = useToast();
  const [creating, setCreating] = useState(false);
  const [stockCheck, setStockCheck] = useState<StockCheck>(null);
  const [stockChecking, setStockChecking] = useState(false);

  // Which matched items have no stock / not enough, worked out by the same code that Create loading uses (nothing is saved).
  async function checkStock(p: PreviewResponse) {
    const lines = linesOf(p);
    if (lines.length === 0) { setStockCheck(null); return; }
    setStockChecking(true);
    try {
      const pv: any = await apiRequest("POST", "/api/loading-sales/preview", { lines }, false, true);
      const short = (pv.shortLines ?? []) as StockLine[];
      setStockCheck({ boxes: pv.summary?.boxes ?? 0, shortBoxes: short.reduce((n, l) => n + Math.max(0, l.requested - l.loads), 0), lines: short, lineCount: lines.length });
    } catch { setStockCheck(null); }
    finally { setStockChecking(false); }
  }
  const role = String((user as any)?.role ?? "").toLowerCase();
  const isAdmin = ["admin", "super-admin", "super admin", "super_admin"].includes(role);

  const [fileName, setFileName] = useState("");
  const [csvText, setCsvText] = useState("");
  const [preview, setPreview] = useState<PreviewResponse | null>(null);
  const [error, setError] = useState("");
  const [openOrder, setOpenOrder] = useState<string | null>(null);

  // The user's choices, sent back with every preview run. None of them are saved.
  const [plantsByOrder, setPlantsByOrder] = useState<Record<string, string>>({});
  const [links, setLinks] = useState<Array<{ key: string; productId: number }>>([]);
  const [skips, setSkips] = useState<string[]>([]);
  const [pending, setPending] = useState<Pending>(null);
  const [saveLink, setSaveLink] = useState<Record<string, boolean>>({});

  const plantsQuery = useQuery<Array<{ name: string }>>({
    queryKey: ["/api/plants", "load-csv-upload"],
    queryFn: () => apiRequest("GET", "/api/plants").then((r) => r.json()),
    enabled: isAdmin,
    staleTime: 60000,
  });
  const plantOptions = (plantsQuery.data ?? []).map((p) => p.name).sort((a, b) => a.localeCompare(b));

  const runPreview = useMutation({
    mutationFn: async (choices: { csvText: string; plantsByOrder: Record<string, string>; links: typeof links; skips: string[] }) => {
      const res = await apiRequest("POST", "/api/loading/csv-upload/preview", choices);
      if (!res.ok) throw new Error((await res.json().catch(() => ({})))?.message || "Preview failed");
      return (await res.json()) as PreviewResponse;
    },
    onSuccess: (data) => { setPreview(data); setError(""); checkStock(data); },
    onError: (err: any) => { setPreview(null); setError(err?.message ?? "Preview failed"); },
  });

  function rerun(next: { plantsByOrder?: Record<string, string>; links?: typeof links; skips?: string[]; csvText?: string }) {
    runPreview.mutate({
      csvText: next.csvText ?? csvText,
      plantsByOrder: next.plantsByOrder ?? plantsByOrder,
      links: next.links ?? links,
      skips: next.skips ?? skips,
    });
  }

  async function onPickFile(file: File | undefined) {
    if (!file) return;
    setFileName(file.name);
    const text = await file.text();
    setCsvText(text);
    setPreview(null);
    setError("");
    setPlantsByOrder({});
    setLinks([]);
    setSkips([]);
    setPending(null);
    setSaveLink({});
    // Pass the new text straight in: the state update above isn't visible until the next render.
    rerun({ csvText: text, plantsByOrder: {}, links: [], skips: [] });
  }

  if (!isAdmin) {
    return <div className="p-6"><p className="text-sm text-red-700">Only an admin can upload a load CSV.</p></div>;
  }

  function confirmPending() {
    if (!pending) return;
    const next = [...links.filter((l) => l.key !== pending.key), { key: pending.key, productId: pending.product.id }];
    setLinks(next);
    setSkips(skips.filter((k) => k !== pending.key));
    setPending(null);
    rerun({ links: next, skips: skips.filter((k) => k !== pending.key) });
  }

  function skipLine(key: string) {
    const next = [...skips.filter((k) => k !== key), key];
    setSkips(next);
    setLinks(links.filter((l) => l.key !== key));
    rerun({ skips: next, links: links.filter((l) => l.key !== key) });
  }

  function undoLine(key: string) {
    const nextLinks = links.filter((l) => l.key !== key);
    const nextSkips = skips.filter((k) => k !== key);
    setLinks(nextLinks);
    setSkips(nextSkips);
    setPending(null);
    rerun({ links: nextLinks, skips: nextSkips });
  }

  function pickPlant(orderNumber: string, plant: string) {
    const next = { ...plantsByOrder, [orderNumber]: plant };
    setPlantsByOrder(next);
    rerun({ plantsByOrder: next });
  }

  const hasText = !!csvText;

  // Every matched line of every ready order (same / extra / less / not on slip), with the product the preview matched it to.
  const loadLines = linesOf(preview);

  async function createLoading() {
    if (loadLines.length === 0) return;
    setCreating(true);
    try {
      let reverseManualSales = false;
      const pv: any = await apiRequest("POST", "/api/loading-sales/preview", { lines: loadLines }, false, true);
      const sm = pv.summary;
      if (pv.manualSales?.length) {
        if (!window.confirm(`Manual sales already exist for ${pv.dates.join(", ")} (${pv.manualSales.length} batch(es)). Reverse them first, so the same sales are not counted twice?\n\nOK = reverse them and continue. Cancel = stop.`)) { setCreating(false); return; }
        reverseManualSales = true;
      }
      const lead = `Create loading entries for ${sm.ordersFound} order(s): ${sm.boxes.toLocaleString()} boxes.`;
      const warn = [sm.short ? `${sm.short} item(s) have no stock and will be skipped` : "", sm.partial ? `${sm.partial} item(s) will load only what is in stock` : "", sm.unmatched ? `${sm.unmatched} line(s) not matched` : "", sm.alreadyCovered ? `${sm.alreadyCovered} item(s) already loaded` : ""].filter(Boolean).join("; ");
      if (!window.confirm(`${lead}${warn ? "\n\n" + warn + "." : ""}\n\nSlip status is not changed and nothing is sent to Notion. Continue?`)) { setCreating(false); return; }
      const r: any = await apiRequest("POST", "/api/loading-sales/apply", { lines: loadLines, csvFileName: fileName || null, reverseManualSales }, false, true);
      toast({ title: "Loading created", description: `${r.ordersLoaded} order(s), ${r.events} entr${r.events === 1 ? "y" : "ies"}, ${(r.boxes ?? 0).toLocaleString()} boxes. It can be reversed from Settings > Load from Sales Orders file.` });
      rerun({});
    } catch (e: any) {
      toast({ title: "Could not create the loading", description: e?.message || "Nothing was changed.", variant: "destructive" });
    } finally { setCreating(false); }
  }

  return (
    <div className="container-fluid max-w-full space-y-5 overflow-x-hidden px-3 py-6 sm:px-4 md:px-6">
      <div className="flex items-center gap-3">
        <Link href="/proforma-slips">
          <Button variant="outline" size="sm" className="gap-1.5">
            <ArrowLeft className="h-4 w-4" /> Back to Proforma Slips
          </Button>
        </Link>
      </div>
      <PageHeader
        icon={FileText}
        title="Create System Generated Load Slip"
        subtitle="Record loads that already left the warehouse. Preview first — nothing is saved on this page."
      />

      <div className="rounded-xl border border-amber-200 bg-amber-50 px-4 py-3 text-sm text-amber-900">
        Check the preview first, then press Create loading. The plant comes from each order's slip. Orders whose slip has no plant ask you
        for one here (your pick is not saved to the slip). Creating the loading records the matched lines as loading entries and takes the stock off; it does not change a slip's status.
      </div>

      <div className="flex flex-wrap items-center gap-3 rounded-xl border border-gray-200 bg-white p-4 shadow-sm">
        <label className="flex h-9 min-w-[16rem] flex-1 cursor-pointer items-center gap-2 rounded-md border border-dashed border-gray-300 px-3 text-sm text-gray-600 hover:bg-gray-50">
          <Upload className="h-4 w-4" />
          <span className="truncate">{fileName || "Choose a CSV file"}</span>
          <input type="file" accept=".csv,text/csv" className="sr-only" onChange={(e) => onPickFile(e.target.files?.[0])} />
        </label>
        {runPreview.isPending && <Loader2 className="h-4 w-4 animate-spin text-gray-500" />}
        {hasText && !runPreview.isPending && (
          <Button variant="outline" size="sm" onClick={() => rerun({})}>Run preview again</Button>
        )}
        {preview && loadLines.length > 0 && (
          <Button size="sm" disabled={creating || runPreview.isPending} onClick={createLoading}>
            {creating ? <Loader2 className="mr-1.5 h-4 w-4 animate-spin" /> : null}Create loading ({loadLines.length} lines)
          </Button>
        )}
      </div>

      {error && <div className="rounded-md border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-700">{error}</div>}

      {preview && (stockChecking || stockCheck) && (
        <div className="space-y-2 rounded-xl border border-gray-200 bg-white p-4 shadow-sm">
          <div className="flex flex-wrap items-center gap-2 text-sm">
            <span className="font-semibold text-gray-900">Stock check</span>
            {stockChecking && <Loader2 className="h-4 w-4 animate-spin text-gray-500" />}
            {stockCheck && (
              <>
                <span className="rounded bg-green-100 px-2 py-0.5 text-xs font-semibold text-green-800">{stockCheck.boxes.toLocaleString()} boxes can be loaded</span>
                {stockCheck.lines.filter((l) => l.noStock).length > 0 && <span className="rounded bg-red-100 px-2 py-0.5 text-xs font-semibold text-red-800">{stockCheck.lines.filter((l) => l.noStock).length} item(s) with no stock</span>}
                {stockCheck.lines.filter((l) => !l.noStock).length > 0 && <span className="rounded bg-blue-100 px-2 py-0.5 text-xs font-semibold text-blue-800">{stockCheck.lines.filter((l) => !l.noStock).length} item(s) short</span>}
                {stockCheck.shortBoxes > 0 && <span className="rounded bg-gray-100 px-2 py-0.5 text-xs font-semibold text-gray-700">{stockCheck.shortBoxes.toLocaleString()} boxes short in total</span>}
                {stockCheck.lines.length === 0 && <span className="text-xs text-gray-500">Every matched item has enough stock.</span>}
              </>
            )}
          </div>
          {stockCheck && stockCheck.lines.length > 0 && (
            <div className="max-h-[40vh] overflow-auto border">
              <table className="w-full text-xs">
                <thead className="sticky top-0 bg-gray-100"><tr className="text-left text-gray-500"><th className="px-2 py-1.5">Order</th><th>Party</th><th>Plant</th><th>SAP</th><th>Item</th><th>Barcode</th><th className="text-right">Needed</th><th className="text-right">In stock</th><th className="text-right">Short by</th><th className="pr-2">Result</th></tr></thead>
                <tbody>
                  {[...stockCheck.lines].sort((a, b) => Number(b.noStock) - Number(a.noStock)).map((l, i) => (
                    <tr key={i} className="border-t align-top">
                      <td className="px-2 py-1.5 font-mono">{l.orderNumber}</td>
                      <td className="max-w-[160px] break-words">{l.party ?? "—"}</td>
                      <td>{l.plant ?? "—"}</td>
                      <td className="font-mono">{l.sapCode ?? "—"}</td>
                      <td className="max-w-[240px] break-words">{l.itemName ?? "—"}</td>
                      <td className="font-mono">{l.barcode}</td>
                      <td className="text-right tabular-nums">{l.requested}</td>
                      <td className="text-right tabular-nums">{l.stock}</td>
                      <td className="text-right tabular-nums font-semibold text-red-700">{Math.max(0, l.requested - l.loads)}</td>
                      <td className="pr-2">{l.noStock ? <span className="rounded bg-red-100 px-1.5 py-0.5 font-semibold text-red-800">No stock — skipped</span> : <span className="rounded bg-blue-100 px-1.5 py-0.5 font-semibold text-blue-800">Loads {l.loads}</span>}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </div>
      )}

      {preview && (
        <>
          <div className="grid grid-cols-2 gap-2 sm:grid-cols-4 lg:grid-cols-8">
            {[
              ["Orders in file", preview.summary.orders],
              ["Ready", preview.summary.ready],
              ["Plant needed", preview.summary.needsPlant],
              ["Already recorded", preview.summary.alreadyRecorded],
              ["Not in system", preview.summary.notInSystem],
              ["Same", preview.summary.same],
              ["Extra", (preview.summary.extra ?? 0) + (preview.summary.newExtra ?? 0)],
              ["Less", preview.summary.less],
            ].map(([label, value]) => (
              <div key={String(label)} className="rounded-lg border border-gray-200 bg-white px-3 py-2 shadow-sm">
                <p className="text-[11px] font-medium uppercase tracking-wide text-gray-500">{label}</p>
                <p className="text-lg font-semibold tabular-nums text-gray-900">{Number(value ?? 0).toLocaleString()}</p>
              </div>
            ))}
          </div>

          <div className="space-y-2">
            {preview.orders.map((o) => {
              const isOpen = openOrder === o.orderNumber;
              const needsMatch = o.lines.filter((l) => l.status === "unmatched" || l.status === "ambiguous").length;
              return (
                <div key={o.orderNumber} className="overflow-hidden rounded-xl border border-gray-200 bg-white shadow-sm">
                  <button
                    type="button"
                    className="flex w-full flex-wrap items-center gap-x-4 gap-y-1 px-4 py-3 text-left hover:bg-gray-50"
                    onClick={() => setOpenOrder(isOpen ? null : o.orderNumber)}
                  >
                    <span className="font-semibold text-gray-900">Order {o.orderNumber}</span>
                    <span className="text-sm text-gray-600">{o.party}</span>
                    <span className="text-xs text-gray-500">{o.date ?? ""}</span>
                    {o.plant && <span className="text-xs text-gray-600">Plant: {o.plant}{o.plantFrom === "picked" ? " (picked)" : ""}</span>}
                    <span className={`ml-auto text-xs font-medium ${o.status === "ready" ? "text-emerald-700" : o.status === "needsPlant" ? "text-amber-700" : "text-gray-500"}`}>
                      {ORDER_LABEL[o.status]}
                    </span>
                    {needsMatch > 0 && (
                      <span className="rounded-full bg-red-100 px-2 py-0.5 text-[11px] font-semibold text-red-700">{needsMatch} need a match</span>
                    )}
                  </button>

                  {o.status === "needsPlant" && (
                    <div className="flex flex-wrap items-center gap-3 border-t border-amber-100 bg-amber-50 px-4 py-3 text-sm">
                      <span className="text-amber-900">This order's slip has no plant. Choose one:</span>
                      <div className="w-56">
                        <Select value={plantsByOrder[o.orderNumber] || undefined} onValueChange={(v) => pickPlant(o.orderNumber, v)}>
                          <SelectTrigger className="h-9 text-sm"><SelectValue placeholder="Choose a plant" /></SelectTrigger>
                          <SelectContent>
                            {plantOptions.map((p) => <SelectItem key={p} value={p}>{p}</SelectItem>)}
                          </SelectContent>
                        </Select>
                      </div>
                    </div>
                  )}

                  {isOpen && o.status === "ready" && (
                    <div className="border-t border-gray-100">
                      <div className="overflow-x-auto">
                        <table className="w-full text-sm">
                          <thead className="bg-gray-50 text-left text-[11px] uppercase tracking-wide text-gray-500">
                            <tr>
                              <th className="px-3 py-2">SAP code</th>
                              <th className="px-3 py-2">Item (CSV)</th>
                              <th className="px-3 py-2 text-right">CSV qty</th>
                              <th className="px-3 py-2 text-right">Slip qty</th>
                              <th className="px-3 py-2 text-right">Difference</th>
                              <th className="px-3 py-2">Product</th>
                              <th className="px-3 py-2">Result</th>
                            </tr>
                          </thead>
                          <tbody>
                            {o.lines.map((l) => {
                              const isMatchLine = l.status === "unmatched" || l.status === "ambiguous";
                              const isLinked = !!l.linked;
                              return (
                                <tr key={l.key} className="border-t border-gray-100 align-top">
                                  <td className="px-3 py-2 font-mono text-xs text-gray-700">{l.sapCode ?? "—"}</td>
                                  <td className="px-3 py-2 text-gray-800">{l.csvName}</td>
                                  <td className="px-3 py-2 text-right tabular-nums">{l.csvQty ?? "—"} <span className="text-xs text-gray-400">{l.unit}</span></td>
                                  <td className="px-3 py-2 text-right tabular-nums">{l.slipQty ?? "—"}</td>
                                  <td className="px-3 py-2 text-right tabular-nums">{l.difference ?? "—"}</td>
                                  <td className="px-3 py-2 text-xs text-gray-600">{l.product ? `${l.product.name} (${l.product.barcode})` : "—"}</td>
                                  <td className={`px-3 py-2 text-xs ${LINE_CLASS[l.status]}`}>
                                    <div>{LINE_LABEL[l.status]}{isLinked ? " · linked by you" : ""}</div>

                                    {isMatchLine && (
                                      <div className="mt-2 space-y-1.5">
                                        {(l.suggestions ?? []).map((s) => (
                                          <div key={s.id} className="flex flex-wrap items-center gap-2">
                                            <span className="text-gray-700">{s.name} <span className="text-gray-400">({s.barcode})</span>{s.reason && <span className={`ml-1.5 rounded px-1.5 py-0.5 text-[10px] font-semibold ${s.reason === "Similar name" ? "bg-gray-100 text-gray-600" : "bg-green-100 text-green-800"}`}>{s.reason}</span>}</span>
                                            <Button size="sm" variant="outline" className="h-6 px-2 text-[11px]"
                                              onClick={() => setPending({ key: l.key, product: { id: s.id, barcode: s.barcode, name: s.name } })}>
                                              Pick
                                            </Button>
                                          </div>
                                        ))}
                                        {(l.suggestions ?? []).length === 0 && <p className="text-gray-500">No barcode, slip line or similar name found.</p>}
                                        <div className="flex gap-2 pt-1">
                                          <Button size="sm" variant="ghost" className="h-6 px-2 text-[11px] text-gray-600" onClick={() => skipLine(l.key)}>Skip this line</Button>
                                        </div>
                                      </div>
                                    )}

                                    {pending?.key === l.key && (
                                      <div className="mt-2 rounded-md border border-[#001d6e]/30 bg-[#001d6e]/5 p-2">
                                        <p className="text-gray-800">Link this line to <strong>{pending.product.name}</strong> ({pending.product.barcode})?</p>
                                        <div className="mt-2 flex gap-2">
                                          <Button size="sm" className="h-7 bg-[#001d6e] px-3 text-[11px] text-white hover:bg-[#00154b]" onClick={confirmPending}>Confirm link</Button>
                                          <Button size="sm" variant="outline" className="h-7 px-3 text-[11px]" onClick={() => setPending(null)}>Cancel</Button>
                                        </div>
                                      </div>
                                    )}

                                    {isLinked && (
                                      <div className="mt-2 flex flex-wrap items-center gap-2">
                                        <label className="flex items-center gap-1.5 text-gray-700">
                                          <input type="checkbox" checked={!!saveLink[l.key]} onChange={(e) => setSaveLink({ ...saveLink, [l.key]: e.target.checked })} />
                                          Save this link for future uploads
                                        </label>
                                        <Button size="sm" variant="ghost" className="h-6 px-2 text-[11px] text-gray-600" onClick={() => undoLine(l.key)}>Undo</Button>
                                      </div>
                                    )}

                                    {l.status === "skipped" && (
                                      <Button size="sm" variant="ghost" className="mt-1 h-6 px-2 text-[11px] text-gray-600" onClick={() => undoLine(l.key)}>Undo skip</Button>
                                    )}
                                  </td>
                                </tr>
                              );
                            })}
                          </tbody>
                        </table>
                      </div>
                      {o.slipOnly.length > 0 && (
                        <p className="border-t border-gray-100 px-3 py-2 text-xs text-gray-500">
                          On the slip but not in the CSV (left alone): {o.slipOnly.map((s) => `${s.itemName} (${s.quantity})`).join(", ")}
                        </p>
                      )}
                    </div>
                  )}
                </div>
              );
            })}
          </div>
        </>
      )}
    </div>
  );
}
