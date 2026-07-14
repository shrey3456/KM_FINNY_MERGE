import { useMemo, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { format } from "date-fns";
import * as XLSX from "xlsx";
import jsPDF from "jspdf";
import autoTable from "jspdf-autotable";
import { Filter, X, FileDown, LayoutList, Columns3, Check, Factory } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  Select, SelectContent, SelectItem, SelectTrigger, SelectValue,
} from "@/components/ui/select";
import PageHeader from "@/components/PageHeader";
import { apiRequest } from "@/lib/queryClient";

// ─── Types ───────────────────────────────────────────────────────────────────

// One row per (barcode, plant) — the live plant-wise running stock. inStock is every
// physical box (extras included); extraQty is the over-order portion, shown separately.
type PlantStockRow = {
  srNo: number;
  barcode: string | null;
  plant: string;
  itemName: string;
  itemNo: string | null;
  sapCode: string | null;
  hsnCode: string | null;
  category: string | null;
  brand: string | null;
  itemsPerPallet: number | null;
  inStock: number;
  extraQty: number;
  pallets: number | null;
  extraPallets: number | null;
  lastArrived: string | null;
};

type PlantStockResponse = {
  items: PlantStockRow[];
  total: number;
  // null = admin/super-admin (all plants). Array = the plant(s) this user is limited to.
  plants: string[] | null;
};

// ─── Column config ────────────────────────────────────────────────────────────

const ALL_COLUMNS = [
  { key: "barcode",     label: "Barcode / SKU" },
  { key: "sapCode",     label: "SAP Code" },
  { key: "category",    label: "Category" },
  { key: "brand",       label: "Brand" },
  { key: "stock",       label: "Stock (Boxes)" },
  { key: "extra",       label: "Extra" },
  { key: "pallets",     label: "Pallets" },
  { key: "extraPallets", label: "Extra Pallets" },
  { key: "lastUpdated", label: "Last Updated" },
] as const;

type ColKey = typeof ALL_COLUMNS[number]["key"];

// ─── Helpers ─────────────────────────────────────────────────────────────────

function buildUrl(base: string, params: Record<string, string | number | undefined>) {
  const sp = new URLSearchParams();
  Object.entries(params).forEach(([k, v]) => {
    if (v !== undefined && v !== "") sp.set(k, String(v));
  });
  const q = sp.toString();
  return q ? `${base}?${q}` : base;
}

function downloadCsv(filename: string, rows: Array<Array<string | number>>) {
  const csv = rows.map((r) => r.map((c) => `"${String(c).replace(/"/g, '""')}"`).join(",")).join("\n");
  const a = document.createElement("a");
  a.href = URL.createObjectURL(new Blob([csv], { type: "text/csv" }));
  a.download = filename; a.click();
}

function downloadExcel(filename: string, rows: Array<Array<string | number>>) {
  const sheet = XLSX.utils.aoa_to_sheet(rows);
  const book  = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(book, sheet, "Overall Stock");
  XLSX.writeFile(book, filename);
}

function downloadPdf(filename: string, rows: Array<Array<string | number>>) {
  const doc = new jsPDF({ orientation: "landscape" });
  doc.setFontSize(12);
  doc.text("Overall Stock Report (Plant-wise)", 14, 12);
  const [header, ...body] = rows;
  autoTable(doc, {
    head: [header as string[]],
    body: body as string[][],
    startY: 18,
    styles: { fontSize: 7 },
    headStyles: { fillColor: [0, 29, 110] },
  });
  doc.save(filename);
}

const PAGE_SIZE = 20;

// ─── Component ───────────────────────────────────────────────────────────────

export default function OverallStock() {
  const [plantFilter, setPlantFilter] = useState(""); // "" = all plants the user may see
  const [search,      setSearch]      = useState("");
  const [page,        setPage]        = useState(1);
  const [visibleCols, setVisibleCols] = useState<Set<ColKey>>(new Set(ALL_COLUMNS.map((c) => c.key)));
  const [colDropOpen, setColDropOpen] = useState(false);

  const toggleCol = (key: ColKey) =>
    setVisibleCols((prev) => {
      const next = new Set(prev);
      if (next.has(key)) { if (next.size > 1) next.delete(key); }
      else next.add(key);
      return next;
    });
  const show = (key: ColKey) => visibleCols.has(key);

  // All configured plants — used to populate the plant switcher for admins.
  const { data: allPlants = [] } = useQuery<{ id: number; name: string }[]>({
    queryKey: ["/api/plants"],
    queryFn: () => apiRequest("GET", "/api/plants", undefined, false, true),
  });

  // Plant-wise stock. Server enforces access: admins get every plant, others only theirs.
  const stockUrl = buildUrl("/api/scan-sessions/reports/plant-stock", {
    plant: plantFilter || undefined,
  });
  const { data: stockData } = useQuery<PlantStockResponse>({
    queryKey: ["/api/scan-sessions/reports/plant-stock", plantFilter],
    queryFn: () => apiRequest("GET", stockUrl, undefined, false, true),
    refetchInterval: 30000,
  });

  const rows = stockData?.items ?? [];
  // null = admin (may pick any plant). Array = restricted user → lock the switcher to these.
  const allowedPlants = stockData?.plants ?? null;
  const isAdmin = allowedPlants === null;

  // Plant dropdown options: admins pick from every configured plant; restricted users only
  // from the plant(s) assigned to them. "All" means "all plants I'm allowed to see".
  const plantOptions = isAdmin
    ? allPlants.map((p) => p.name)
    : (allowedPlants ?? []).map((p) => p.toUpperCase());

  // Client-side search filter (server already scoped by plant).
  const filtered = useMemo(() => {
    if (!search) return rows;
    const q = search.toLowerCase();
    return rows.filter((r) =>
      r.itemName.toLowerCase().includes(q) ||
      (r.barcode ?? "").toLowerCase().includes(q) ||
      (r.sapCode ?? "").toLowerCase().includes(q) ||
      (r.category ?? "").toLowerCase().includes(q) ||
      r.plant.toLowerCase().includes(q),
    );
  }, [rows, search]);

  // Pagination
  const totalPages = Math.max(1, Math.ceil(filtered.length / PAGE_SIZE));
  const safePage   = Math.min(page, totalPages);
  const pageRows   = filtered.slice((safePage - 1) * PAGE_SIZE, safePage * PAGE_SIZE);

  // Summary
  const totalStock = filtered.reduce((s, r) => s + r.inStock, 0);
  const totalExtra = filtered.reduce((s, r) => s + r.extraQty, 0);
  const totalExtraPallets = filtered.reduce((s, r) => s + (r.extraPallets ?? 0), 0);

  // Export rows
  const exportRows = (src: PlantStockRow[]): Array<Array<string | number>> => [
    ["#", "Item", "Barcode", "SAP Code", "HSN Code", "Category", "Brand", "Plant", "Stock (Boxes)", "Extra", "Pallets", "Extra Pallets", "Last Updated"],
    ...src.map((r, i) => [
      i + 1, r.itemName, r.barcode ?? "", r.sapCode ?? "", r.hsnCode ?? "",
      r.category ?? "", r.brand ?? "", r.plant, r.inStock, r.extraQty,
      r.pallets != null ? r.pallets.toFixed(2) : "",
      r.extraPallets != null ? r.extraPallets.toFixed(2) : "",
      r.lastArrived ? format(new Date(r.lastArrived), "yyyy-MM-dd") : "",
    ]),
  ];

  return (
    <div className="flex-1 overflow-y-auto p-4 lg:p-6">
      <div className="max-w-7xl mx-auto space-y-4">
        <PageHeader
          icon={LayoutList}
          title="Overall Stock"
          description="Live plant-wise stock. Stock = all boxes received (extras included); Extra is shown separately."
        />

        {/* Summary tiles */}
        <div className="grid grid-cols-2 sm:grid-cols-3 gap-3">
          <div className="rounded-xl border bg-white px-4 py-3 shadow-sm">
            <p className="text-xs uppercase tracking-wide text-gray-400">Total Stock</p>
            <p className="text-2xl font-bold text-[#001d6e]">{totalStock.toLocaleString()}</p>
            <p className="text-[11px] text-gray-400">boxes{plantFilter ? ` · ${plantFilter}` : allowedPlants && allowedPlants.length ? ` · ${plantOptions.join(", ")}` : " · all plants"}</p>
          </div>
          <div className="rounded-xl border bg-white px-4 py-3 shadow-sm">
            <p className="text-xs uppercase tracking-wide text-gray-400">Extra (of which)</p>
            <p className="text-2xl font-bold text-amber-600">{totalExtra.toLocaleString()}</p>
            <p className="text-[11px] text-gray-400">boxes over order · {totalExtraPallets.toFixed(2)} plt</p>
          </div>
          <div className="rounded-xl border bg-white px-4 py-3 shadow-sm">
            <p className="text-xs uppercase tracking-wide text-gray-400">Items</p>
            <p className="text-2xl font-bold text-gray-900">{filtered.length.toLocaleString()}</p>
            <p className="text-[11px] text-gray-400">item · plant rows</p>
          </div>
        </div>

        {/* Filters & actions */}
        <div className="flex flex-wrap gap-2 items-center">
          {/* Plant */}
          <div className="flex items-center gap-1.5">
            <Factory className="h-4 w-4 text-gray-400" />
            <Select value={plantFilter || "_all_"} onValueChange={(v) => { setPlantFilter(v === "_all_" ? "" : v); setPage(1); }}>
              <SelectTrigger className="h-9 w-[160px] text-sm">
                <SelectValue placeholder="All plants" />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="_all_">{isAdmin ? "All plants" : "All my plants"}</SelectItem>
                {plantOptions.map((p) => <SelectItem key={p} value={p}>{p}</SelectItem>)}
              </SelectContent>
            </Select>
          </div>

          {/* Search */}
          <div className="relative min-w-[180px] flex-1 max-w-xs">
            <Filter className="absolute left-3 top-1/2 -translate-y-1/2 h-3.5 w-3.5 text-gray-400" />
            <Input
              className="pl-8 h-9 text-sm"
              placeholder="Item, barcode, SAP, category…"
              value={search}
              onChange={(e) => { setSearch(e.target.value); setPage(1); }}
            />
            {search && (
              <button className="absolute right-2 top-1/2 -translate-y-1/2" onClick={() => { setSearch(""); setPage(1); }}>
                <X className="h-4 w-4 text-gray-400" />
              </button>
            )}
          </div>

          {/* Column visibility */}
          <div className="relative">
            <Button variant="outline" size="sm" className="h-9 text-xs gap-1.5" onClick={() => setColDropOpen((o) => !o)}>
              <Columns3 className="h-3.5 w-3.5" />Columns
            </Button>
            {colDropOpen && (
              <>
                <div className="fixed inset-0 z-10" onClick={() => setColDropOpen(false)} />
                <div className="absolute right-0 top-10 z-20 w-48 rounded-lg border bg-white shadow-lg py-1">
                  {ALL_COLUMNS.map((col) => (
                    <button
                      key={col.key}
                      className="flex w-full items-center gap-2 px-3 py-1.5 text-xs text-gray-700 hover:bg-gray-50"
                      onClick={() => toggleCol(col.key)}
                    >
                      <span className={`flex h-4 w-4 items-center justify-center rounded border ${visibleCols.has(col.key) ? "bg-[#001d6e] border-[#001d6e]" : "border-gray-300"}`}>
                        {visibleCols.has(col.key) && <Check className="h-2.5 w-2.5 text-white" />}
                      </span>
                      {col.label}
                    </button>
                  ))}
                </div>
              </>
            )}
          </div>

          {/* Export */}
          <div className="flex gap-2 ml-auto">
            {(["CSV", "Excel", "PDF"] as const).map((fmt) => (
              <Button key={fmt} variant="outline" size="sm" className="h-9 text-xs"
                disabled={filtered.length === 0}
                onClick={() => {
                  const exp = exportRows(filtered);
                  const suffix = `${plantFilter ? "-" + plantFilter : ""}-${format(new Date(), "yyyy-MM-dd")}`;
                  if (fmt === "CSV")   downloadCsv(`overall-stock${suffix}.csv`, exp);
                  if (fmt === "Excel") downloadExcel(`overall-stock${suffix}.xlsx`, exp);
                  if (fmt === "PDF")   downloadPdf(`overall-stock${suffix}.pdf`, exp);
                }}
              >
                <FileDown className="h-3.5 w-3.5 mr-1" />{fmt}
              </Button>
            ))}
          </div>
        </div>

        {/* Table */}
        <div className="rounded-xl border bg-white shadow-sm overflow-hidden">
          <div className="overflow-x-auto">
            <table className="w-full text-xs border-collapse" style={{ minWidth: 760 }}>
              <thead>
                <tr className="bg-[#001d6e]">
                  <th className="px-3 py-3 text-left text-[11px] font-semibold uppercase tracking-wide text-white border-r border-[#001d6e]/30 w-[44px]">#</th>
                  <th className="px-3 py-3 text-left text-[11px] font-semibold uppercase tracking-wide text-white border-r border-[#001d6e]/30 min-w-[200px]">Item</th>
                  {show("barcode")     && <th className="px-3 py-3 text-left  text-[11px] font-semibold uppercase tracking-wide text-white border-r border-[#001d6e]/30">Barcode / SKU</th>}
                  {show("sapCode")     && <th className="px-3 py-3 text-left  text-[11px] font-semibold uppercase tracking-wide text-white border-r border-[#001d6e]/30">SAP Code</th>}
                  {show("category")    && <th className="px-3 py-3 text-left  text-[11px] font-semibold uppercase tracking-wide text-white border-r border-[#001d6e]/30">Category</th>}
                  {show("brand")       && <th className="px-3 py-3 text-left  text-[11px] font-semibold uppercase tracking-wide text-white border-r border-[#001d6e]/30">Brand</th>}
                  <th className="px-3 py-3 text-left text-[11px] font-semibold uppercase tracking-wide text-white border-r border-[#001d6e]/30">Plant</th>
                  {show("stock")       && <th className="px-3 py-3 text-right text-[11px] font-semibold uppercase tracking-wide text-white border-r border-[#001d6e]/30">Stock (Boxes)</th>}
                  {show("extra")       && <th className="px-3 py-3 text-right text-[11px] font-semibold uppercase tracking-wide text-white border-r border-[#001d6e]/30">Extra</th>}
                  {show("pallets")     && <th className="px-3 py-3 text-right text-[11px] font-semibold uppercase tracking-wide text-white border-r border-[#001d6e]/30">Pallets</th>}
                  {show("extraPallets") && <th className="px-3 py-3 text-right text-[11px] font-semibold uppercase tracking-wide text-white border-r border-[#001d6e]/30">Extra Pallets</th>}
                  {show("lastUpdated") && <th className="px-3 py-3 text-left  text-[11px] font-semibold uppercase tracking-wide text-white">Last Updated</th>}
                </tr>
              </thead>
              <tbody>
                {filtered.length === 0 ? (
                  <tr>
                    <td colSpan={3 + visibleCols.size} className="py-16 text-center text-sm text-gray-400">
                      No stock yet{plantFilter ? ` for ${plantFilter}` : ""}. Stock appears here once an order is completed.
                    </td>
                  </tr>
                ) : (
                  pageRows.map((row, idx) => {
                    const rowBg = idx % 2 === 0 ? "bg-white" : "bg-slate-50";
                    const cell = "border-r border-gray-100";
                    return (
                      <tr key={`${row.barcode}-${row.plant}`} className={`${rowBg} border-b border-gray-100 hover:bg-slate-100/60`}>
                        <td className={`px-3 py-3 text-gray-400 text-[11px] tabular-nums ${cell}`}>
                          {(safePage - 1) * PAGE_SIZE + idx + 1}
                        </td>
                        <td className={`px-3 py-3 font-medium text-gray-900 min-w-[200px] max-w-[280px] whitespace-normal break-words ${cell}`}>
                          {row.itemName}
                        </td>
                        {show("barcode") && (
                          <td className={`px-3 py-3 font-mono text-[11px] text-gray-600 ${cell}`}>
                            {row.barcode ?? <span className="text-gray-300">—</span>}
                          </td>
                        )}
                        {show("sapCode") && (
                          <td className={`px-3 py-3 font-mono text-[11px] text-gray-600 ${cell}`}>
                            {row.sapCode ?? <span className="text-gray-300">—</span>}
                          </td>
                        )}
                        {show("category") && (
                          <td className={`px-3 py-3 ${cell}`}>
                            {row.category
                              ? <span className="inline-flex items-center rounded-full border border-gray-200 px-2 py-0.5 text-[11px] text-gray-700">{row.category}</span>
                              : <span className="text-gray-300">—</span>}
                          </td>
                        )}
                        {show("brand") && (
                          <td className={`px-3 py-3 text-[11px] text-gray-700 ${cell}`}>
                            {row.brand ?? <span className="text-gray-300">—</span>}
                          </td>
                        )}
                        <td className={`px-3 py-3 ${cell}`}>
                          <span className="inline-flex items-center rounded-full bg-[#001d6e]/10 px-2 py-0.5 text-[10px] font-semibold text-[#001d6e] uppercase">{row.plant}</span>
                        </td>
                        {show("stock") && (
                          <td className={`px-3 py-3 text-right font-bold text-[#001d6e] tabular-nums ${cell}`}>
                            {row.inStock.toLocaleString()}
                          </td>
                        )}
                        {show("extra") && (
                          <td className={`px-3 py-3 text-right tabular-nums ${cell}`}>
                            {row.extraQty > 0 ? (
                              <span className="font-semibold text-amber-600">{row.extraQty.toLocaleString()}</span>
                            ) : (
                              <span className="text-gray-300">—</span>
                            )}
                          </td>
                        )}
                        {show("pallets") && (
                          <td className={`px-3 py-3 text-right font-semibold text-[#001d6e] tabular-nums ${cell}`}>
                            {row.pallets != null && row.pallets > 0
                              ? row.pallets.toFixed(2)
                              : <span className="text-gray-300 font-normal">—</span>}
                          </td>
                        )}
                        {show("extraPallets") && (
                          <td className={`px-3 py-3 text-right font-semibold text-amber-600 tabular-nums ${cell}`}>
                            {row.extraPallets != null && row.extraPallets > 0
                              ? row.extraPallets.toFixed(2)
                              : <span className="text-gray-300 font-normal">—</span>}
                          </td>
                        )}
                        {show("lastUpdated") && (
                          <td className="px-3 py-3 text-[11px] text-gray-500 whitespace-nowrap">
                            {row.lastArrived
                              ? format(new Date(row.lastArrived), "MMM d, yyyy")
                              : <span className="text-gray-300">—</span>}
                          </td>
                        )}
                      </tr>
                    );
                  })
                )}
              </tbody>
            </table>
          </div>

          <div className="flex items-center justify-between border-t px-4 py-2.5 text-xs text-gray-500">
            <span>
              {filtered.length > 0
                ? `Showing ${(safePage - 1) * PAGE_SIZE + 1}–${Math.min(safePage * PAGE_SIZE, filtered.length)} of ${filtered.length} rows`
                : "No rows"}
            </span>
            <div className="flex gap-2">
              <Button variant="outline" size="sm" disabled={safePage <= 1}
                onClick={() => setPage((p) => Math.max(1, p - 1))}>Prev</Button>
              <Button variant="outline" size="sm" disabled={safePage >= totalPages}
                onClick={() => setPage((p) => p + 1)}>Next</Button>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
