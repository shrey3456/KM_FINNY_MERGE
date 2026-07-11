import { useMemo, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { format } from "date-fns";
import * as XLSX from "xlsx";
import jsPDF from "jspdf";
import autoTable from "jspdf-autotable";
import { Filter, X, Download, FileDown, LayoutList, Columns3, Check, ChevronDown } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  Select, SelectContent, SelectItem, SelectTrigger, SelectValue,
} from "@/components/ui/select";
import PageHeader from "@/components/PageHeader";
import { apiRequest } from "@/lib/queryClient";

// ─── Types ───────────────────────────────────────────────────────────────────

type StockItem = {
  srNo: number; sku: string; barcode: string | null; itemName: string;
  sapCode: string | null; hsnCode: string | null; category: string | null;
  brand: string | null;
  itemsPerPallet: number | null; totalScanned: number; totalPallets: number | null;
  lastArrived: string | null;
};

type ExtraItem = {
  barcode: string | null; itemName: string | null;
  totalQuantity: number; totalPallets: number | null;
  itemsPerPallet: number | null; lastArrived: string | null;
  sapCode: string | null; hsnCode: string | null; category: string | null;
  brand: string | null;
};

type CombinedRow = {
  key: string;
  itemName: string;
  barcode: string | null;
  sapCode: string | null;
  hsnCode: string | null;
  category: string | null;
  brand: string | null;
  regularQty: number;
  extraQty: number;
  pallets: number | null;
  itemsPerPallet: number | null;
  lastArrived: string | null;
};

// ─── Column config ────────────────────────────────────────────────────────────

const ALL_COLUMNS = [
  { key: "barcode",     label: "Barcode / SKU" },
  { key: "sapCode",     label: "SAP Code" },
  { key: "category",    label: "Category" },
  { key: "brand",       label: "Brand" },
  { key: "regularQty",  label: "Regular Qty" },
  { key: "extraQty",    label: "Extra Qty" },
  { key: "pallets",     label: "Pallets" },
  { key: "lastScanned", label: "Last Scanned" },
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
  doc.text("Overall Stock Report", 14, 12);
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
  const [selectedDate, setSelectedDate] = useState("");
  const [search,       setSearch]       = useState("");
  const [typeFilter,   setTypeFilter]   = useState<"all" | "regular" | "extra">("all");
  const [page,         setPage]         = useState(1);
  const [visibleCols,  setVisibleCols]  = useState<Set<ColKey>>(
    new Set(ALL_COLUMNS.map((c) => c.key)),
  );
  const [colDropOpen,    setColDropOpen]    = useState(false);
  const [colFilters,     setColFilters]     = useState<Partial<Record<string, string>>>({});
  const [activeFilterCol, setActiveFilterCol] = useState<string | null>(null);

  const toggleCol = (key: ColKey) =>
    setVisibleCols((prev) => {
      const next = new Set(prev);
      if (next.has(key)) { if (next.size > 1) next.delete(key); }
      else next.add(key);
      return next;
    });

  const show = (key: ColKey) => visibleCols.has(key);

  const setColFilter = (col: string, val: string) => {
    setColFilters((prev) => ({ ...prev, [col]: val }));
    setPage(1);
  };

  const clearColFilter = (col: string) => {
    setColFilters((prev) => { const n = { ...prev }; delete n[col]; return n; });
  };

  const toggleFilterCol = (col: string) =>
    setActiveFilterCol((prev) => (prev === col ? null : col));

  const hasColFilter = (col: string) => !!(colFilters[col]?.trim());
  const anyColFilters = Object.values(colFilters).some((v) => v?.trim());

  // Fetch all stock items (regular — from CSV orders)
  const stockUrl = buildUrl("/api/scan-sessions/reports/completed-stock", {
    date: selectedDate || undefined,
    limit: 200,
    offset: 0,
  });
  const { data: stockData } = useQuery<{ items: StockItem[]; total: number }>({
    queryKey: ["/api/scan-sessions/reports/completed-stock", selectedDate],
    queryFn: () => apiRequest("GET", stockUrl, undefined, false, true),
    refetchInterval: 30000,
  });

  // Fetch all extra items
  const extrasUrl = buildUrl("/api/scan-sessions/reports/extras", {
    date: selectedDate || undefined,
    grouped: "true",
    limit: 200,
    offset: 0,
  });
  const { data: extrasData } = useQuery<{ items: ExtraItem[]; total: number; totalQuantity: number }>({
    queryKey: ["/api/scan-sessions/reports/extras", selectedDate],
    queryFn: () => apiRequest("GET", extrasUrl, undefined, false, true),
    refetchInterval: 30000,
  });

  // Merge into a unified list — an item scanned as both regular and extra
  // collapses into ONE row (keyed by barcode, falling back to SKU) instead of
  // showing twice, with its regular/extra quantities added as separate fields.
  const combined = useMemo<CombinedRow[]>(() => {
    const map = new Map<string, CombinedRow>();
    const keyFor = (barcode: string | null | undefined, fallback: string) =>
      barcode && barcode.trim() ? `bc:${barcode.trim().toLowerCase()}` : `nb:${fallback}`;

    const newerDate = (a: string | null, b: string | null) =>
      !a ? b : !b ? a : new Date(b).getTime() > new Date(a).getTime() ? b : a;

    // API aggregates (totalScanned/totalQuantity/totalPallets) can come back as
    // numeric strings — coerce with Number() so `+=` adds instead of concatenating
    // (e.g. 0 + "30" would otherwise yield the string "030").
    const num = (v: number | string | null | undefined) => Number(v ?? 0) || 0;

    (stockData?.items ?? []).forEach((s) => {
      const key = keyFor(s.barcode, `sku:${s.sku}`);
      const existing = map.get(key);
      if (existing) {
        existing.regularQty += num(s.totalScanned);
        existing.pallets = num(existing.pallets) + num(s.totalPallets);
        existing.lastArrived = newerDate(existing.lastArrived, s.lastArrived);
      } else {
        map.set(key, {
          key, itemName: s.itemName, barcode: s.barcode, sapCode: s.sapCode,
          hsnCode: s.hsnCode, category: s.category, brand: s.brand ?? null,
          regularQty: num(s.totalScanned), extraQty: 0, pallets: num(s.totalPallets),
          itemsPerPallet: s.itemsPerPallet, lastArrived: s.lastArrived,
        });
      }
    });

    (extrasData?.items ?? []).forEach((e, i) => {
      const key = keyFor(e.barcode, `ex:${e.barcode ?? i}`);
      const existing = map.get(key);
      if (existing) {
        existing.extraQty += num(e.totalQuantity);
        existing.pallets = num(existing.pallets) + num(e.totalPallets);
        existing.lastArrived = newerDate(existing.lastArrived, e.lastArrived);
      } else {
        map.set(key, {
          key, itemName: e.itemName ?? e.barcode ?? "Unknown", barcode: e.barcode,
          sapCode: e.sapCode ?? null, hsnCode: e.hsnCode ?? null, category: e.category ?? null,
          brand: e.brand ?? null, regularQty: 0, extraQty: num(e.totalQuantity),
          pallets: num(e.totalPallets), itemsPerPallet: e.itemsPerPallet, lastArrived: e.lastArrived,
        });
      }
    });

    return Array.from(map.values()).sort((a, b) => {
      if (!a.lastArrived && !b.lastArrived) return 0;
      if (!a.lastArrived) return 1;
      if (!b.lastArrived) return -1;
      return new Date(b.lastArrived).getTime() - new Date(a.lastArrived).getTime();
    });
  }, [stockData, extrasData]);

  // Filter
  const filtered = useMemo(() => {
    let rows = combined;
    if (typeFilter === "regular") rows = rows.filter((r) => r.regularQty > 0);
    if (typeFilter === "extra")   rows = rows.filter((r) => r.extraQty > 0);
    if (search) {
      const q = search.toLowerCase();
      rows = rows.filter((r) =>
        r.itemName.toLowerCase().includes(q) ||
        (r.barcode ?? "").toLowerCase().includes(q) ||
        (r.sapCode ?? "").toLowerCase().includes(q) ||
        (r.category ?? "").toLowerCase().includes(q),
      );
    }
    // Column-level filters
    const cf = colFilters;
    if (cf["item"]?.trim())        { const q = cf["item"]!.toLowerCase();        rows = rows.filter((r) => r.itemName.toLowerCase().includes(q)); }
    if (cf["barcode"]?.trim())     { const q = cf["barcode"]!.toLowerCase();     rows = rows.filter((r) => (r.barcode ?? "").toLowerCase().includes(q)); }
    if (cf["sapCode"]?.trim())     { const q = cf["sapCode"]!.toLowerCase();     rows = rows.filter((r) => (r.sapCode ?? "").toLowerCase().includes(q)); }
    if (cf["category"]?.trim())    { const q = cf["category"]!.toLowerCase();    rows = rows.filter((r) => (r.category ?? "").toLowerCase().includes(q)); }
    if (cf["brand"]?.trim())       { const q = cf["brand"]!.toLowerCase();       rows = rows.filter((r) => (r.brand ?? "").toLowerCase().includes(q)); }
    if (cf["lastScanned"]?.trim()) { const q = cf["lastScanned"]!.toLowerCase(); rows = rows.filter((r) => r.lastArrived ? format(new Date(r.lastArrived), "MMM d, yyyy").toLowerCase().includes(q) : false); }
    return rows;
  }, [combined, typeFilter, search, colFilters]);

  // Pagination
  const totalPages = Math.max(1, Math.ceil(filtered.length / PAGE_SIZE));
  const safePage   = Math.min(page, totalPages);
  const pageRows   = filtered.slice((safePage - 1) * PAGE_SIZE, safePage * PAGE_SIZE);

  // Summary
  const totalRegularQty = combined.reduce((s, r) => s + r.regularQty, 0);
  const totalExtraQty   = combined.reduce((s, r) => s + r.extraQty, 0);
  const totalRegularCount = combined.filter((r) => r.regularQty > 0).length;
  const totalExtraCount   = combined.filter((r) => r.extraQty > 0).length;

  // Export rows
  const exportRows = (src: CombinedRow[]) => [
    ["#", "Item", "Barcode", "SAP Code", "HSN Code", "Category", "Brand", "Regular Qty", "Extra Qty", "Pallets", "Last Scanned"],
    ...src.map((r, i) => [
      i + 1, r.itemName, r.barcode ?? "", r.sapCode ?? "", r.hsnCode ?? "",
      r.category ?? "", r.brand ?? "", r.regularQty, r.extraQty,
      r.pallets != null ? parseFloat(String(r.pallets)).toFixed(2) : "",
      r.lastArrived ? format(new Date(r.lastArrived), "yyyy-MM-dd") : "",
    ]),
  ];

  return (
    <div className="flex-1 overflow-y-auto p-4 lg:p-6">
      <div className="max-w-7xl mx-auto space-y-4">
        <PageHeader
          icon={LayoutList}
          title="Overall Stock"
          description="Combined view of all scanned order items and extra items."
        />

        {/* Filters & actions */}
        <div className="flex flex-wrap gap-2 items-center">
          {/* Date */}
          <div className="flex items-center gap-1.5 rounded-md border bg-white px-2.5 h-9">
            <span className="text-xs text-gray-400 whitespace-nowrap">Date</span>
            <input
              type="date"
              className="text-xs bg-transparent outline-none text-gray-700 w-[130px]"
              value={selectedDate}
              onChange={(e) => { setSelectedDate(e.target.value); setPage(1); }}
            />
            {selectedDate && (
              <button onClick={() => { setSelectedDate(""); setPage(1); }}>
                <X className="h-3.5 w-3.5 text-gray-400" />
              </button>
            )}
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

          {/* Type filter */}
          <Select value={typeFilter} onValueChange={(v) => { setTypeFilter(v as typeof typeFilter); setPage(1); }}>
            <SelectTrigger className="h-9 w-[150px] text-sm">
              <SelectValue placeholder="All types" />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="all">All types</SelectItem>
              <SelectItem value="regular">Regular only</SelectItem>
              <SelectItem value="extra">Extra only</SelectItem>
            </SelectContent>
          </Select>

          {/* Column visibility */}
          <div className="relative">
            <Button
              variant="outline" size="sm" className="h-9 text-xs gap-1.5"
              onClick={() => setColDropOpen((o) => !o)}
            >
              <Columns3 className="h-3.5 w-3.5" />Columns Filter
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
                  const rows = exportRows(filtered);
                  const suffix = `${selectedDate ? "-" + selectedDate : ""}-${format(new Date(), "yyyy-MM-dd")}`;
                  if (fmt === "CSV")   downloadCsv(`overall-stock${suffix}.csv`, rows);
                  if (fmt === "Excel") downloadExcel(`overall-stock${suffix}.xlsx`, rows);
                  if (fmt === "PDF")   downloadPdf(`overall-stock${suffix}.pdf`, rows);
                }}
              >
                <FileDown className="h-3.5 w-3.5 mr-1" />{fmt}
              </Button>
            ))}
          </div>
        </div>

        {/* Table */}
        {anyColFilters && (
          <div className="flex flex-wrap gap-1.5 mb-2">
            {Object.entries(colFilters).filter(([, v]) => v?.trim()).map(([col, val]) => (
              <span key={col} className="inline-flex items-center gap-1 rounded-full bg-blue-100 px-2.5 py-1 text-[11px] text-blue-800 font-medium">
                <span className="capitalize">{col}</span>: {val}
                <button onClick={() => clearColFilter(col)} className="ml-0.5 hover:text-blue-600">
                  <X className="h-3 w-3" />
                </button>
              </span>
            ))}
            <button onClick={() => setColFilters({})} className="text-[11px] text-gray-400 hover:text-gray-600 underline px-1">
              Clear all
            </button>
          </div>
        )}
        <div className="rounded-xl border bg-white shadow-sm overflow-hidden">
          <div className="overflow-x-auto">
            <table className="w-full text-xs border-collapse" style={{ minWidth: 700 }}>
              <thead>
                {/* Label row */}
                <tr className="bg-[#001d6e]">
                  <th className="px-3 py-3 text-left text-[11px] font-semibold uppercase tracking-wide text-white border-r border-[#001d6e]/30 w-[44px]">#</th>
                  {/* Item — filterable */}
                  <th className="border-r border-[#001d6e]/30 min-w-[200px] p-0">
                    <button
                      onClick={() => toggleFilterCol("item")}
                      className={`w-full flex items-center justify-between gap-1 px-3 py-3 text-left text-[11px] font-semibold uppercase tracking-wide text-white hover:bg-white/10 transition-colors ${hasColFilter("item") ? "bg-white/20" : ""}`}
                    >
                      Item
                      <ChevronDown className={`h-3 w-3 shrink-0 transition-transform ${activeFilterCol === "item" ? "rotate-180" : ""}`} />
                    </button>
                  </th>
                  {show("barcode") && (
                    <th className="border-r border-[#001d6e]/30 p-0">
                      <button onClick={() => toggleFilterCol("barcode")} className={`w-full flex items-center justify-between gap-1 px-3 py-3 text-left text-[11px] font-semibold uppercase tracking-wide text-white hover:bg-white/10 transition-colors ${hasColFilter("barcode") ? "bg-white/20" : ""}`}>
                        Barcode / SKU <ChevronDown className={`h-3 w-3 shrink-0 transition-transform ${activeFilterCol === "barcode" ? "rotate-180" : ""}`} />
                      </button>
                    </th>
                  )}
                  {show("sapCode") && (
                    <th className="border-r border-[#001d6e]/30 p-0">
                      <button onClick={() => toggleFilterCol("sapCode")} className={`w-full flex items-center justify-between gap-1 px-3 py-3 text-left text-[11px] font-semibold uppercase tracking-wide text-white hover:bg-white/10 transition-colors ${hasColFilter("sapCode") ? "bg-white/20" : ""}`}>
                        SAP Code <ChevronDown className={`h-3 w-3 shrink-0 transition-transform ${activeFilterCol === "sapCode" ? "rotate-180" : ""}`} />
                      </button>
                    </th>
                  )}
                  {show("category") && (
                    <th className="border-r border-[#001d6e]/30 p-0">
                      <button onClick={() => toggleFilterCol("category")} className={`w-full flex items-center justify-between gap-1 px-3 py-3 text-left text-[11px] font-semibold uppercase tracking-wide text-white hover:bg-white/10 transition-colors ${hasColFilter("category") ? "bg-white/20" : ""}`}>
                        Category <ChevronDown className={`h-3 w-3 shrink-0 transition-transform ${activeFilterCol === "category" ? "rotate-180" : ""}`} />
                      </button>
                    </th>
                  )}
                  {show("brand") && (
                    <th className="border-r border-[#001d6e]/30 p-0">
                      <button onClick={() => toggleFilterCol("brand")} className={`w-full flex items-center justify-between gap-1 px-3 py-3 text-left text-[11px] font-semibold uppercase tracking-wide text-white hover:bg-white/10 transition-colors ${hasColFilter("brand") ? "bg-white/20" : ""}`}>
                        Brand <ChevronDown className={`h-3 w-3 shrink-0 transition-transform ${activeFilterCol === "brand" ? "rotate-180" : ""}`} />
                      </button>
                    </th>
                  )}
                  {show("regularQty")  && <th className="px-3 py-3 text-right text-[11px] font-semibold uppercase tracking-wide text-white border-r border-[#001d6e]/30">Regular Qty</th>}
                  {show("extraQty")    && <th className="px-3 py-3 text-right text-[11px] font-semibold uppercase tracking-wide text-white border-r border-[#001d6e]/30">Extra Qty</th>}
                  {show("pallets")     && <th className="px-3 py-3 text-right text-[11px] font-semibold uppercase tracking-wide text-white border-r border-[#001d6e]/30">Pallets</th>}
                  {show("lastScanned") && (
                    <th className="p-0">
                      <button onClick={() => toggleFilterCol("lastScanned")} className={`w-full flex items-center justify-between gap-1 px-3 py-3 text-left text-[11px] font-semibold uppercase tracking-wide text-white hover:bg-white/10 transition-colors ${hasColFilter("lastScanned") ? "bg-white/20" : ""}`}>
                        Last Scanned <ChevronDown className={`h-3 w-3 shrink-0 transition-transform ${activeFilterCol === "lastScanned" ? "rotate-180" : ""}`} />
                      </button>
                    </th>
                  )}
                </tr>
                {/* Filter input row — only renders when a column filter is open */}
                {activeFilterCol && (
                  <tr className="bg-[#001a5e]">
                    <td className="border-r border-[#001d6e]/30" />
                    {/* Item */}
                    <td className="p-1.5 border-r border-[#001d6e]/30">
                      {activeFilterCol === "item" && (
                        <div className="relative">
                          <input autoFocus value={colFilters["item"] ?? ""} onChange={(e) => setColFilter("item", e.target.value)}
                            placeholder="Filter item…"
                            className="w-full rounded px-2 py-1 text-[11px] bg-white/90 text-gray-900 placeholder-gray-400 outline-none focus:ring-1 focus:ring-white/50" />
                          {colFilters["item"] && <button onClick={() => clearColFilter("item")} className="absolute right-1.5 top-1"><X className="h-3 w-3 text-gray-400" /></button>}
                        </div>
                      )}
                    </td>
                    {show("barcode") && (
                      <td className="p-1.5 border-r border-[#001d6e]/30">
                        {activeFilterCol === "barcode" && (
                          <div className="relative">
                            <input autoFocus value={colFilters["barcode"] ?? ""} onChange={(e) => setColFilter("barcode", e.target.value)}
                              placeholder="Filter barcode…"
                              className="w-full rounded px-2 py-1 text-[11px] bg-white/90 text-gray-900 placeholder-gray-400 outline-none" />
                            {colFilters["barcode"] && <button onClick={() => clearColFilter("barcode")} className="absolute right-1.5 top-1"><X className="h-3 w-3 text-gray-400" /></button>}
                          </div>
                        )}
                      </td>
                    )}
                    {show("sapCode") && (
                      <td className="p-1.5 border-r border-[#001d6e]/30">
                        {activeFilterCol === "sapCode" && (
                          <div className="relative">
                            <input autoFocus value={colFilters["sapCode"] ?? ""} onChange={(e) => setColFilter("sapCode", e.target.value)}
                              placeholder="Filter SAP code…"
                              className="w-full rounded px-2 py-1 text-[11px] bg-white/90 text-gray-900 placeholder-gray-400 outline-none" />
                            {colFilters["sapCode"] && <button onClick={() => clearColFilter("sapCode")} className="absolute right-1.5 top-1"><X className="h-3 w-3 text-gray-400" /></button>}
                          </div>
                        )}
                      </td>
                    )}
                    {show("category") && (
                      <td className="p-1.5 border-r border-[#001d6e]/30">
                        {activeFilterCol === "category" && (
                          <div className="relative">
                            <input autoFocus value={colFilters["category"] ?? ""} onChange={(e) => setColFilter("category", e.target.value)}
                              placeholder="Filter category…"
                              className="w-full rounded px-2 py-1 text-[11px] bg-white/90 text-gray-900 placeholder-gray-400 outline-none" />
                            {colFilters["category"] && <button onClick={() => clearColFilter("category")} className="absolute right-1.5 top-1"><X className="h-3 w-3 text-gray-400" /></button>}
                          </div>
                        )}
                      </td>
                    )}
                    {show("brand") && (
                      <td className="p-1.5 border-r border-[#001d6e]/30">
                        {activeFilterCol === "brand" && (
                          <div className="relative">
                            <input autoFocus value={colFilters["brand"] ?? ""} onChange={(e) => setColFilter("brand", e.target.value)}
                              placeholder="Filter brand…"
                              className="w-full rounded px-2 py-1 text-[11px] bg-white/90 text-gray-900 placeholder-gray-400 outline-none" />
                            {colFilters["brand"] && <button onClick={() => clearColFilter("brand")} className="absolute right-1.5 top-1"><X className="h-3 w-3 text-gray-400" /></button>}
                          </div>
                        )}
                      </td>
                    )}
                    {show("regularQty")  && <td className="border-r border-[#001d6e]/30" />}
                    {show("extraQty")    && <td className="border-r border-[#001d6e]/30" />}
                    {show("pallets")     && <td className="border-r border-[#001d6e]/30" />}
                    {show("lastScanned") && (
                      <td className="p-1.5">
                        {activeFilterCol === "lastScanned" && (
                          <div className="relative">
                            <input autoFocus value={colFilters["lastScanned"] ?? ""} onChange={(e) => setColFilter("lastScanned", e.target.value)}
                              placeholder="e.g. Jun 27"
                              className="w-full rounded px-2 py-1 text-[11px] bg-white/90 text-gray-900 placeholder-gray-400 outline-none" />
                            {colFilters["lastScanned"] && <button onClick={() => clearColFilter("lastScanned")} className="absolute right-1.5 top-1"><X className="h-3 w-3 text-gray-400" /></button>}
                          </div>
                        )}
                      </td>
                    )}
                  </tr>
                )}
              </thead>
              <tbody>
                {filtered.length === 0 ? (
                  <tr>
                    <td colSpan={2 + visibleCols.size} className="py-16 text-center text-sm text-gray-400">
                      No stock data found{selectedDate ? " for this date" : ""}.
                    </td>
                  </tr>
                ) : (
                  pageRows.map((row, idx) => {
                    const hasExtra = row.extraQty > 0;
                    const rowBg = hasExtra
                      ? (idx % 2 === 0 ? "bg-amber-50/40" : "bg-amber-50/60")
                      : (idx % 2 === 0 ? "bg-white" : "bg-slate-50");
                    const cellBorder = "border-r border-gray-100";
                    return (
                      <tr key={row.key} className={`${rowBg} border-b border-gray-100 transition-colors hover:bg-slate-100/60`}>
                        <td className={`px-3 py-3 text-gray-400 text-[11px] tabular-nums ${cellBorder}`}>
                          {(safePage - 1) * PAGE_SIZE + idx + 1}
                        </td>
                        <td className={`px-3 py-3 font-medium text-gray-900 min-w-[200px] max-w-[260px] whitespace-normal break-words ${cellBorder}`}>
                          {row.itemName}
                        </td>
                        {show("barcode") && (
                          <td className={`px-3 py-3 font-mono text-[11px] text-gray-600 ${cellBorder}`}>
                            {row.barcode ?? <span className="text-gray-300">—</span>}
                          </td>
                        )}
                        {show("sapCode") && (
                          <td className={`px-3 py-3 font-mono text-[11px] text-gray-600 ${cellBorder}`}>
                            {row.sapCode ?? <span className="text-gray-300">—</span>}
                          </td>
                        )}
                        {show("category") && (
                          <td className={`px-3 py-3 ${cellBorder}`}>
                            {row.category
                              ? <span className="inline-flex items-center rounded-full border border-gray-200 px-2 py-0.5 text-[11px] text-gray-700">{row.category}</span>
                              : <span className="text-gray-300">—</span>}
                          </td>
                        )}
                        {show("brand") && (
                          <td className={`px-3 py-3 text-[11px] text-gray-700 ${cellBorder}`}>
                            {row.brand ?? <span className="text-gray-300">—</span>}
                          </td>
                        )}
                        {show("regularQty") && (
                          <td className={`px-3 py-3 text-right font-bold text-[#001d6e] tabular-nums ${cellBorder}`}>
                            {row.regularQty > 0
                              ? row.regularQty.toLocaleString()
                              : <span className="text-gray-300 font-normal">—</span>}
                          </td>
                        )}
                        {show("extraQty") && (
                          <td className={`px-3 py-3 text-right font-bold tabular-nums ${cellBorder} ${row.extraQty > 0 ? "text-amber-700" : ""}`}>
                            {row.extraQty > 0
                              ? row.extraQty.toLocaleString()
                              : <span className="text-gray-300 font-normal">—</span>}
                          </td>
                        )}
                        {show("pallets") && (
                          <td className={`px-3 py-3 text-right font-semibold text-[#001d6e] tabular-nums ${cellBorder}`}>
                            {row.pallets != null && Number(row.pallets) > 0
                              ? parseFloat(String(row.pallets)).toFixed(2)
                              : <span className="text-gray-300 font-normal">—</span>}
                          </td>
                        )}
                        {show("lastScanned") && (
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
                ? `Showing ${(safePage - 1) * PAGE_SIZE + 1}–${Math.min(safePage * PAGE_SIZE, filtered.length)} of ${filtered.length} items`
                : "No items"}
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
