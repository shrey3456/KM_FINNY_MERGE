import { useEffect, useState, useMemo } from "react";
import { useQuery } from "@tanstack/react-query";
import {
  AlertTriangle, ArrowLeft, Download, Search, RefreshCw,
  CalendarDays, X, UserCircle, FileDown, History, User, Filter,
} from "lucide-react";
import { Link } from "wouter";
import { apiRequest } from "@/lib/queryClient";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import * as XLSX from "xlsx";
import jsPDF from "jspdf";
import autoTable from "jspdf-autotable";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { format } from "date-fns";

// ─── Types ───────────────────────────────────────────────────────────────────

// Grouped (merged) extra item — one row per unique barcode, quantities summed across all CSVs
type ExtraItem = {
  barcode: string;
  itemName: string;
  totalQuantity: number;
  totalPallets: number | null;
  itemsPerPallet: number | null;
  firstArrived: string | null;
  lastArrived: string | null;
};

type StockItem = {
  srNo: number;
  sku: string;
  barcode: string | null;
  itemName: string;
  itemNo: string | null;
  sapCode: string | null;
  hsnCode: string | null;
  category: string | null;
  itemsPerPallet: number | null;
  volumeInCuFt: string | null;
  inStock: number | null;
  totalScanned: number;
  totalPallets: number | null;
  orders: Array<{ name: string; status: string }>;
  lastArrived: string | null;
};

type ScanHistoryItem = {
  id: number;
  barcode: string | null;
  itemName: string | null;
  pallets: number | null;
  totalQty: number;
  itemsPerPallet: number | null;
  looseQty: number | null;
  isExtra: boolean;
  stv: string | null;
  scannedByCode: string | null;
  scannedByName: string | null;
  scannedAt: string;
  orderName: string;
  plant: string;
};

type PaginatedResponse<T> = {
  items: T[];
  total: number;
  totalQuantity?: number;
  limit?: number;
  offset?: number;
};

type ScanHistoryResponse = {
  items: ScanHistoryItem[];
  total: number;
  totalBoxes: number;
  totalPallets: number;
  extraCount: number;
  scanners: string[];
  limit: number;
  offset: number;
};

// ─── Constants ───────────────────────────────────────────────────────────────

const STOCK_PAGE_SIZE   = 10;
const EXTRAS_PAGE_SIZE  = 10;
const HISTORY_PAGE_SIZE = 20;

// ─── Helpers ─────────────────────────────────────────────────────────────────

function buildQueryUrl(base: string, params: Record<string, string | number | undefined>) {
  const sp = new URLSearchParams();
  Object.entries(params).forEach(([k, v]) => {
    if (v !== undefined && v !== "") sp.set(k, String(v));
  });
  const q = sp.toString();
  return q ? `${base}?${q}` : base;
}

function withCacheBuster(url: string) {
  return buildQueryUrl(url, { _t: Date.now() });
}

function downloadCsv(filename: string, rows: Array<Array<string | number>>) {
  const csv = rows
    .map((row) => row.map((cell) => `"${String(cell).replace(/"/g, '""')}"`).join(","))
    .join("\n");
  const a = document.createElement("a");
  a.href = URL.createObjectURL(new Blob([csv], { type: "text/csv" }));
  a.download = filename;
  a.click();
}

function downloadExcel(filename: string, rows: Array<Array<string | number>>) {
  const sheet = XLSX.utils.aoa_to_sheet(rows);
  const book  = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(book, sheet, "Report");
  XLSX.writeFile(book, filename);
}

function downloadPdf(filename: string, title: string, rows: Array<Array<string | number>>) {
  const doc = new jsPDF({ orientation: "landscape" });
  doc.setFontSize(12);
  doc.text(title, 14, 12);
  const [header, ...body] = rows;
  autoTable(doc, {
    head: [header as string[]],
    body: body as string[][],
    startY: 18,
    styles: { fontSize: 8 },
    headStyles: { fillColor: [0, 29, 110] },
  });
  doc.save(filename);
}

// ─── Column-filter header ─────────────────────────────────────────────────────

function FilterHead({
  label, colKey, openCol, filters, onToggle, onChange, onClear, className, type = "text",
}: {
  label: string; colKey: string; openCol: string | null;
  filters: Record<string, string>;
  onToggle: (c: string) => void;
  onChange:  (c: string, v: string) => void;
  onClear:   (c: string) => void;
  className?: string;
  type?: "text" | "date";
}) {
  const isOpen    = openCol === colKey;
  const hasFilter = !!filters[colKey];
  const displayVal = type === "date" && filters[colKey]
    ? format(new Date(filters[colKey] + "T00:00:00"), "MMM d, yyyy")
    : filters[colKey] ?? "";
  return (
    <TableHead className={className}>
      <div className="relative">
        <button
          className="flex items-center gap-1.5 w-full text-white font-semibold uppercase tracking-wide text-[11px] sm:text-xs"
          onClick={() => onToggle(colKey)}
        >
          <span className="flex-1 text-left">
            {hasFilter && type === "date" ? displayVal : label}
          </span>
          <Filter className={`h-3 w-3 shrink-0 ${hasFilter ? "text-yellow-300" : "text-white/50"}`} />
        </button>
        {isOpen && (
          <div
            className="absolute top-full left-0 z-50 mt-1 bg-white border border-gray-200 rounded-md shadow-xl p-2 min-w-[180px]"
            onClick={(e) => e.stopPropagation()}
          >
            {type === "date" ? (
              <input
                autoFocus
                type="date"
                value={filters[colKey] ?? ""}
                onChange={(e) => onChange(colKey, e.target.value)}
                className="h-7 w-full rounded border border-gray-300 px-2 text-xs text-gray-900 focus:outline-none focus:ring-1 focus:ring-[#001d6e]"
              />
            ) : (
              <Input
                autoFocus
                value={filters[colKey] ?? ""}
                onChange={(e) => onChange(colKey, e.target.value)}
                placeholder={`Filter ${label.toLowerCase()}…`}
                className="h-7 text-xs text-gray-900"
              />
            )}
            {filters[colKey] && (
              <button
                className="mt-1.5 text-[11px] text-red-500 hover:underline block"
                onClick={() => onClear(colKey)}
              >
                Clear filter
              </button>
            )}
          </div>
        )}
      </div>
    </TableHead>
  );
}

function ActiveFilters({
  filters, labels, onClear, onClearAll, chipCls,
}: {
  filters: Record<string, string>;
  labels: Record<string, string>;
  onClear: (col: string) => void;
  onClearAll: () => void;
  chipCls: string;
}) {
  const entries = Object.entries(filters).filter(([, v]) => v);
  if (entries.length === 0) return null;
  return (
    <div className="flex flex-wrap items-center gap-1.5 px-3 py-1.5 border-b bg-gray-50/80">
      <span className="text-[11px] text-gray-400 font-medium shrink-0">Active filters:</span>
      {entries.map(([col, val]) => (
        <span
          key={col}
          className={`inline-flex items-center gap-1 text-[11px] font-medium rounded-full px-2 py-0.5 border ${chipCls}`}
        >
          <span className="opacity-70 font-normal">{labels[col] ?? col}:</span>
          <span>
            {col === "lastArrived"
              ? format(new Date(val + "T00:00:00"), "MMM d, yyyy")
              : val}
          </span>
          <button
            className="ml-0.5 leading-none hover:opacity-60"
            onClick={() => onClear(col)}
          >
            ×
          </button>
        </span>
      ))}
      {entries.length > 1 && (
        <button
          className="text-[11px] text-red-400 hover:underline ml-1"
          onClick={onClearAll}
        >
          Clear all
        </button>
      )}
    </div>
  );
}

// ─── Component ───────────────────────────────────────────────────────────────

export default function StockReport() {
  // ── Shared filter ──
  const [selectedDate, setSelectedDate] = useState("");

  // ── Stock table state ──
  const [search, setSearch]         = useState("");
  const [stockPage, setStockPage]   = useState(1);

  // ── Extras table state ──
  const [extrasPage, setExtrasPage] = useState(1);

  // ── Column filters (Stock table) ──
  const [columnFilters, setColumnFilters] = useState<Record<string, string>>({});
  const [openFilterCol, setOpenFilterCol] = useState<string | null>(null);
  const toggleFilterCol   = (col: string) => setOpenFilterCol((p) => (p === col ? null : col));
  const handleColFilter   = (col: string, val: string) => setColumnFilters((p) => ({ ...p, [col]: val }));
  const clearColFilter    = (col: string) => setColumnFilters((p) => { const n = { ...p }; delete n[col]; return n; });
  const clearAllColFilters = () => setColumnFilters({});

  // Close filter dropdown on outside click
  useEffect(() => {
    if (!openFilterCol) return;
    const close = () => setOpenFilterCol(null);
    const t = setTimeout(() => document.addEventListener("click", close), 0);
    return () => { clearTimeout(t); document.removeEventListener("click", close); };
  }, [openFilterCol]);

  // ── Extra Items column filters ──
  const [extraColumnFilters, setExtraColumnFilters] = useState<Record<string, string>>({});
  const [openExtraFilterCol, setOpenExtraFilterCol] = useState<string | null>(null);
  const toggleExtraFilterCol   = (col: string) => setOpenExtraFilterCol((p) => (p === col ? null : col));
  const handleExtraColFilter   = (col: string, val: string) => setExtraColumnFilters((p) => ({ ...p, [col]: val }));
  const clearExtraColFilter    = (col: string) => setExtraColumnFilters((p) => { const n = { ...p }; delete n[col]; return n; });
  const clearAllExtraColFilters = () => setExtraColumnFilters({});

  useEffect(() => {
    if (!openExtraFilterCol) return;
    const close = () => setOpenExtraFilterCol(null);
    const t = setTimeout(() => document.addEventListener("click", close), 0);
    return () => { clearTimeout(t); document.removeEventListener("click", close); };
  }, [openExtraFilterCol]);

  // ── Scan History state ──
  const [historyPage,    setHistoryPage]    = useState(1);
  const [historySearch,  setHistorySearch]  = useState("");
  const [historyScanner, setHistoryScanner] = useState("__all__");
  const [historyType,    setHistoryType]    = useState("all");

  // Reset pages when shared date filter changes
  useEffect(() => {
    setStockPage(1);
    setExtrasPage(1);
    setHistoryPage(1);
  }, [selectedDate]);

  useEffect(() => { setStockPage(1); }, [search]);
  useEffect(() => { setHistoryPage(1); }, [historySearch, historyScanner, historyType]);

  // ── URLs ──
  const stockOffset   = (stockPage   - 1) * STOCK_PAGE_SIZE;
  const extrasOffset  = (extrasPage  - 1) * EXTRAS_PAGE_SIZE;
  const historyOffset = (historyPage - 1) * HISTORY_PAGE_SIZE;

  const stockUrl = buildQueryUrl("/api/scan-sessions/reports/completed-stock", {
    date:   selectedDate || undefined,
    limit:  STOCK_PAGE_SIZE,
    offset: stockOffset,
  });
  const extrasUrl = buildQueryUrl("/api/scan-sessions/reports/extras", {
    date:    selectedDate || undefined,
    grouped: "true",
    limit:   EXTRAS_PAGE_SIZE,
    offset:  extrasOffset,
  });
  const historyUrl = buildQueryUrl("/api/scan-sessions/reports/scan-history", {
    date:    selectedDate                                    || undefined,
    search:  historySearch                                   || undefined,
    scanner: historyScanner !== "__all__" ? historyScanner  : undefined,
    type:    historyType    !== "all"     ? historyType      : undefined,
    limit:   HISTORY_PAGE_SIZE,
    offset:  historyOffset,
  });

  // ── Queries ──
  const { data: extrasData } = useQuery<PaginatedResponse<ExtraItem>>({
    queryKey: ["/api/scan-sessions/reports/extras", selectedDate, extrasPage],
    queryFn: async () => {
      const r = await apiRequest("GET", withCacheBuster(extrasUrl), undefined, false, true);
      if (r && Array.isArray(r.items)) return r;
      if (Array.isArray(r)) {
        const totalQuantity = r.reduce((s: number, i: any) => s + (i?.quantity ?? 0), 0);
        return { items: r, total: r.length, totalQuantity };
      }
      return { items: [], total: 0, totalQuantity: 0 };
    },
    refetchInterval: 5000,
  });

  const { data: stockData, isLoading: stockLoading, isFetching: stockFetching } =
    useQuery<PaginatedResponse<StockItem>>({
      queryKey: ["/api/scan-sessions/reports/completed-stock", selectedDate, stockPage],
      queryFn: async () => {
        const r = await apiRequest("GET", withCacheBuster(stockUrl), undefined, false, true);
        if (r && Array.isArray(r.items)) return r;
        if (Array.isArray(r)) return { items: r, total: r.length };
        return { items: [], total: 0 };
      },
      refetchInterval: 5000,
    });

  const { data: historyData, isLoading: historyLoading, isFetching: historyFetching } =
    useQuery<ScanHistoryResponse>({
      queryKey: [
        "/api/scan-sessions/reports/scan-history",
        selectedDate, historySearch, historyScanner, historyType, historyPage,
      ],
      queryFn: async () => {
        const r = await apiRequest("GET", withCacheBuster(historyUrl), undefined, false, true);
        return r ?? { items: [], total: 0, totalBoxes: 0, totalPallets: 0, extraCount: 0, scanners: [], limit: HISTORY_PAGE_SIZE, offset: 0 };
      },
      refetchInterval: 10000,
    });

  // ── Derived values ──
  const extras         = extrasData?.items ?? [];
  const extrasTotal    = extrasData?.total ?? 0;
  const totalExtraQty  = extrasData?.totalQuantity ?? extras.reduce((s, e) => s + (e.totalQuantity ?? 0), 0);
  const extrasHasMore  = extrasOffset + extras.length < extrasTotal;
  const extrasPageCount = Math.max(1, Math.ceil(extrasTotal / EXTRAS_PAGE_SIZE));

  const stockItems      = stockData?.items ?? [];
  const stockTotal      = stockData?.total ?? 0;
  const stockHasMore    = stockOffset + stockItems.length < stockTotal;
  const stockPageCount  = Math.max(1, Math.ceil(stockTotal / STOCK_PAGE_SIZE));

  const filteredStock = useMemo(() => {
    let result = stockItems;
    if (search) {
      const q = search.toLowerCase();
      result = result.filter((i) =>
        i.itemName.toLowerCase().includes(q) ||
        (i.barcode ?? "").toLowerCase().includes(q) ||
        (i.sku ?? "").toLowerCase().includes(q) ||
        (i.sapCode ?? "").toLowerCase().includes(q) ||
        (i.hsnCode ?? "").toLowerCase().includes(q) ||
        (i.category ?? "").toLowerCase().includes(q),
      );
    }
    Object.entries(columnFilters).forEach(([col, val]) => {
      if (!val) return;
      const v = val.toLowerCase();
      result = result.filter((i) => {
        if (col === "itemName") return (i.itemName ?? "").toLowerCase().includes(v);
        if (col === "barcode")  return ((i.barcode ?? "") || (i.sku ?? "")).toLowerCase().includes(v);
        if (col === "category") return (i.category ?? "").toLowerCase().includes(v);
        if (col === "sapCode")  return (i.sapCode ?? "").toLowerCase().includes(v);
        if (col === "hsnCode")     return (i.hsnCode ?? "").toLowerCase().includes(v);
        if (col === "lastArrived") return i.lastArrived
          ? i.lastArrived.startsWith(v)
          : false;
        return true;
      });
    });
    return result;
  }, [stockItems, search, columnFilters]);

  const filteredExtras = useMemo(() => {
    let result = extras;
    Object.entries(extraColumnFilters).forEach(([col, val]) => {
      if (!val) return;
      const v = val.toLowerCase();
      result = result.filter((e) => {
        if (col === "itemName") return (e.itemName ?? "").toLowerCase().includes(v);
        if (col === "barcode")  return (e.barcode ?? "").toLowerCase().includes(v);
        return true;
      });
    });
    return result;
  }, [extras, extraColumnFilters]);

  const historyItems      = historyData?.items ?? [];
  const historyTotal      = historyData?.total ?? 0;
  const historyTotalBoxes = historyData?.totalBoxes ?? 0;
  const historyTotalPallets = historyData?.totalPallets ?? 0;
  const historyExtraCount = historyData?.extraCount ?? 0;
  const historyScanners   = historyData?.scanners ?? [];
  const historyHasMore    = historyOffset + historyItems.length < historyTotal;

  // ── Stock export rows helper ──
  const stockExportRows = (src: StockItem[]) => [
    ["SR", "Item Name", "Barcode/SKU", "Category", "SAP", "HSN", "Volume", "Pallets", "Stock Qty", "Orders"],
    ...src.map((item) => [
      item.srNo,
      item.itemName,
      item.barcode || item.sku,
      item.category ?? "",
      item.sapCode ?? "",
      item.hsnCode ?? "",
      item.volumeInCuFt ?? "",
      item.totalPallets != null
        ? item.totalPallets
        : item.itemsPerPallet && item.itemsPerPallet > 0
          ? Number((item.totalScanned / item.itemsPerPallet).toFixed(2))
          : "",
      item.totalScanned,
      item.orders.map((o) => o.name).join(" | "),
    ]),
  ];

  // ── History export rows helper ──
  const historyExportRows = (src: ScanHistoryItem[]) => [
    ["#", "Scanned By", "User Code", "Item", "Barcode", "Order", "Plant", "Qty", "Pallets", "STV", "Type", "Time"],
    ...src.map((h, idx) => [
      idx + 1,
      h.scannedByName ?? "",
      h.scannedByCode ?? "",
      h.itemName ?? "",
      h.barcode ?? "",
      h.orderName,
      h.plant,
      h.totalQty,
      h.pallets != null ? parseFloat(String(h.pallets)).toFixed(2) : "",
      h.stv ?? "",
      h.isExtra ? "Extra" : "Regular",
      h.scannedAt ? format(new Date(h.scannedAt), "yyyy-MM-dd h:mm a") : "",
    ]),
  ];

  // ─────────────────────────────────────────────────────────────────────────────

  return (
    <div className="flex-1 overflow-y-auto bg-gray-50 p-3 sm:p-4 lg:p-6">
      <div className="mx-auto max-w-7xl space-y-6 sm:space-y-8">

        {/* ── Page header ── */}
        <div>
          <div className="flex flex-wrap items-center gap-2 sm:gap-3">
            <Link href="/scan">
              <Button
                variant="outline" size="sm"
                className="h-8 px-2.5 text-xs sm:text-sm gap-1.5 border-gray-200 bg-white hover:bg-gray-50"
              >
                <ArrowLeft className="h-3.5 w-3.5" />
                <span>Back</span>
              </Button>
            </Link>
            <div className="flex items-center gap-2">
              <h1 className="text-xl sm:text-2xl font-semibold text-gray-950">Stock Sheet</h1>
              {(stockFetching || historyFetching) && (
                <span className="flex items-center gap-1 text-xs text-emerald-600">
                  <RefreshCw className="h-3 w-3 animate-spin" />
                  Updating…
                </span>
              )}
            </div>
          </div>
          <p className="text-xs sm:text-sm text-gray-500 mt-0.5">
            Stock, extras, and full scan history — updates live as boxes are scanned.
          </p>
        </div>

        {/* ── Global filters (date — shared across all three tables) ── */}
        <div className="flex flex-wrap gap-3 items-center">
          <div className="relative flex-1 min-w-[180px] max-w-sm">
            <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-gray-400" />
            <Input
              className="pl-9"
              placeholder="Search item, barcode, SAP, HSN…"
              value={search}
              onChange={(e) => setSearch(e.target.value)}
            />
          </div>
          <div className="flex items-center gap-2">
            <div className="relative">
              <CalendarDays className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-gray-400 pointer-events-none" />
              <Input
                type="date"
                className="pl-9 w-[165px] text-xs sm:text-sm"
                value={selectedDate}
                onChange={(e) => setSelectedDate(e.target.value)}
              />
            </div>
            {selectedDate && (
              <Button
                variant="ghost" size="sm"
                className="h-9 px-2 text-gray-400 hover:text-gray-700"
                onClick={() => setSelectedDate("")}
              >
                <X className="h-4 w-4" />
              </Button>
            )}
          </div>
        </div>

        {selectedDate && (
          <div className="flex items-center gap-2 -mt-2 flex-wrap">
            <p className="text-sm text-[#001d6e] font-medium">
              Showing arrivals for{" "}
              <span className="underline">
                {new Date(selectedDate + "T00:00:00").toLocaleDateString(undefined, {
                  day: "2-digit", month: "long", year: "numeric",
                })}
              </span>
            </p>
            <span className="text-xs text-gray-400 bg-gray-100 rounded px-2 py-0.5">
              Qty = all boxes scanned on this date (regular + extra)
            </span>
          </div>
        )}

        {/* ═══════════════════════════════════════════════════════════════════ */}
        {/* ── 1. Stock Report ── */}
        {/* ═══════════════════════════════════════════════════════════════════ */}
        <div className="rounded-md border bg-white overflow-x-auto">
          <div className="flex flex-wrap items-center justify-between gap-2 border-b px-3 py-2">
            <span className="text-xs sm:text-sm font-semibold text-gray-700">Stock Report</span>
            <div className="flex flex-wrap gap-2">
              {(["CSV", "Excel", "PDF"] as const).map((fmt) => (
                <Button
                  key={fmt} variant="outline" size="sm" className="h-8 text-xs"
                  onClick={() => {
                    const rows = stockExportRows(filteredStock);
                    const suffix = `${selectedDate ? "-" + selectedDate : ""}-${format(new Date(), "yyyy-MM-dd")}`;
                    if (fmt === "CSV")   downloadCsv(`stock-report${suffix}.csv`, rows);
                    if (fmt === "Excel") downloadExcel(`stock-report${suffix}.xlsx`, rows);
                    if (fmt === "PDF")   downloadPdf(`stock-report${suffix}.pdf`, "Stock Report", rows);
                  }}
                >
                  <FileDown className="h-3.5 w-3.5 mr-1" />{fmt}
                </Button>
              ))}
            </div>
          </div>

          <ActiveFilters
            filters={columnFilters}
            labels={{ itemName: "Item", barcode: "Barcode/SKU", category: "Category", sapCode: "SAP Code", hsnCode: "HSN Code", lastArrived: "Date" }}
            onClear={clearColFilter}
            onClearAll={clearAllColFilters}
            chipCls="bg-blue-50 text-blue-700 border-blue-200"
          />
          <Table className="min-w-[980px] text-xs sm:text-sm">
            <TableHeader>
              <TableRow className="bg-[#001d6e] hover:bg-[#001d6e]">
                <TableHead className="text-white font-semibold uppercase tracking-wide sticky left-0 z-20 bg-[#001d6e] w-[52px] text-[11px] sm:text-xs">SR</TableHead>
                <FilterHead label="Item" colKey="itemName" openCol={openFilterCol} filters={columnFilters} onToggle={toggleFilterCol} onChange={handleColFilter} onClear={clearColFilter} className="text-white sticky left-0 sm:left-[52px] z-30 bg-[#001d6e] min-w-[180px] shadow-[2px_0_6px_rgba(0,0,0,0.06)]" />
                <FilterHead label="Barcode / SKU" colKey="barcode" openCol={openFilterCol} filters={columnFilters} onToggle={toggleFilterCol} onChange={handleColFilter} onClear={clearColFilter} className="text-white bg-[#001d6e]" />
                <FilterHead label="Category" colKey="category" openCol={openFilterCol} filters={columnFilters} onToggle={toggleFilterCol} onChange={handleColFilter} onClear={clearColFilter} className="text-white bg-[#001d6e]" />
                <FilterHead label="SAP Code" colKey="sapCode" openCol={openFilterCol} filters={columnFilters} onToggle={toggleFilterCol} onChange={handleColFilter} onClear={clearColFilter} className="text-white bg-[#001d6e]" />
                <FilterHead label="HSN Code" colKey="hsnCode" openCol={openFilterCol} filters={columnFilters} onToggle={toggleFilterCol} onChange={handleColFilter} onClear={clearColFilter} className="text-white bg-[#001d6e]" />
                <TableHead className="text-white font-semibold uppercase tracking-wide text-[11px] sm:text-xs">Volume (FT³)</TableHead>
                <TableHead className="text-white font-semibold uppercase tracking-wide text-right text-[11px] sm:text-xs">Pallets</TableHead>
                <TableHead className="text-white font-semibold uppercase tracking-wide text-right text-[11px] sm:text-xs">
                  {selectedDate ? "Qty (that day)" : "Stock Qty"}
                </TableHead>
                <FilterHead label="Date" colKey="lastArrived" type="date" openCol={openFilterCol} filters={columnFilters} onToggle={toggleFilterCol} onChange={handleColFilter} onClear={clearColFilter} className="text-white bg-[#001d6e] min-w-[140px]" />
              </TableRow>
            </TableHeader>
            <TableBody>
              {stockLoading ? (
                <TableRow>
                  <TableCell colSpan={10} className="py-16 text-center text-sm text-gray-400">
                    Loading stock sheet…
                  </TableCell>
                </TableRow>
              ) : filteredStock.length === 0 ? (
                <TableRow>
                  <TableCell colSpan={10} className="py-16 text-center text-sm text-gray-400">
                    No completed scan orders yet.
                  </TableCell>
                </TableRow>
              ) : (
                filteredStock.map((item, idx) => {
                  const rowBg = idx % 2 === 0 ? "bg-white" : "bg-slate-50";
                  return (
                    <TableRow key={item.sku + idx} className={`${rowBg} transition-colors hover:bg-slate-100/70`}>
                      <TableCell className={`text-gray-500 text-[11px] sm:text-xs sticky left-0 z-10 ${rowBg} w-[52px] py-2 bg-white`}>
                        {item.srNo}
                      </TableCell>
                      <TableCell className={`font-medium text-gray-900 sticky left-0 sm:left-[52px] z-20 ${rowBg} min-w-[180px] max-w-[220px] whitespace-normal break-words py-2 shadow-[2px_0_6px_rgba(0,0,0,0.06)] bg-white`}>
                        {item.itemName}
                      </TableCell>
                      <TableCell className="font-mono text-[11px] sm:text-xs font-medium text-gray-800 py-2">
                        {item.barcode || item.sku}
                      </TableCell>
                      <TableCell>
                        {item.category
                          ? <Badge variant="outline" className="text-xs">{item.category}</Badge>
                          : <span className="text-gray-300 text-xs">—</span>}
                      </TableCell>
                      <TableCell className="font-mono text-[11px] sm:text-xs text-gray-600 py-2">
                        {item.sapCode ?? <span className="text-gray-300">—</span>}
                      </TableCell>
                      <TableCell className="font-mono text-[11px] sm:text-xs text-gray-600 py-2">
                        {item.hsnCode ?? <span className="text-gray-300">—</span>}
                      </TableCell>
                      <TableCell className="text-[11px] sm:text-xs text-gray-600 text-center py-2">
                        {item.volumeInCuFt ?? <span className="text-gray-300">—</span>}
                      </TableCell>
                      <TableCell className="text-right text-[11px] sm:text-xs font-semibold text-[#001d6e] py-2">
                        {item.totalPallets != null
                          ? item.totalPallets
                          : item.itemsPerPallet && item.itemsPerPallet > 0
                            ? parseFloat((item.totalScanned / item.itemsPerPallet).toFixed(2))
                            : <span className="text-gray-300 font-normal">—</span>}
                      </TableCell>
                      <TableCell className="text-right py-2">
                        <span className="text-sm sm:text-base font-bold text-[#001d6e]">
                          {item.totalScanned.toLocaleString()}
                        </span>
                      </TableCell>
                      <TableCell className="text-xs text-gray-500 whitespace-nowrap py-2 min-w-[140px]">
                        {item.lastArrived
                          ? format(new Date(item.lastArrived), "MMM d, yyyy")
                          : <span className="text-gray-300">—</span>}
                      </TableCell>
                    </TableRow>
                  );
                })
              )}
            </TableBody>
          </Table>

          <div className="flex items-center justify-between border-t px-3 py-2 text-xs text-gray-500">
            <span>Page {stockPage} of {stockPageCount} · {stockTotal} items</span>
            <div className="flex gap-2">
              <Button variant="outline" size="sm" disabled={stockPage <= 1}
                onClick={() => setStockPage((p) => Math.max(1, p - 1))}>Prev</Button>
              <Button variant="outline" size="sm" disabled={!stockHasMore}
                onClick={() => setStockPage((p) => p + 1)}>Next</Button>
            </div>
          </div>
        </div>

        {/* ═══════════════════════════════════════════════════════════════════ */}
        {/* ── 2. Extra Items Report ── */}
        {/* ═══════════════════════════════════════════════════════════════════ */}
        <div className="space-y-3">
          <div className="flex items-center justify-between flex-wrap gap-2">
            <div className="flex items-center gap-2">
              <AlertTriangle className="h-5 w-5 text-amber-500" />
              <h2 className="text-base sm:text-lg font-semibold text-gray-900">Extra Items Report</h2>
            </div>
            <div className="flex flex-wrap items-center gap-2">
              <Badge variant="outline" className="border-amber-300 bg-amber-50 text-amber-700 text-sm px-3 py-1">
                {extrasTotal} item{extrasTotal !== 1 ? "s" : ""}
              </Badge>
              <Badge variant="outline" className="border-[#001d6e] bg-blue-50 text-[#001d6e] text-sm px-3 py-1">
                {totalExtraQty.toLocaleString()} total qty
              </Badge>
              <Button
                size="sm" variant="outline" className="h-8 text-xs"
                disabled={extras.length === 0}
                onClick={() => {
                  const suffix = `${selectedDate ? "-" + selectedDate : ""}-${format(new Date(), "yyyy-MM-dd")}`;
                  const rows = [
                    ["#", "Item Name", "Barcode", "Total Qty", "Total Pallets", "Items/Pallet", "First Arrived", "Last Arrived"],
                    ...extras.map((e, idx) => [
                      idx + 1,
                      e.itemName,
                      e.barcode,
                      e.totalQuantity,
                      e.totalPallets != null ? parseFloat(String(e.totalPallets)).toFixed(2) : "",
                      e.itemsPerPallet ?? "",
                      e.firstArrived ? format(new Date(e.firstArrived), "yyyy-MM-dd") : "",
                      e.lastArrived  ? format(new Date(e.lastArrived),  "yyyy-MM-dd") : "",
                    ]),
                  ];
                  downloadCsv(`extra-items${suffix}.csv`, rows);
                }}
              >
                <Download className="h-4 w-4 mr-1.5" />CSV
              </Button>
              <Button
                size="sm" variant="outline" className="h-8 text-xs"
                disabled={extras.length === 0}
                onClick={() => {
                  const suffix = `${selectedDate ? "-" + selectedDate : ""}-${format(new Date(), "yyyy-MM-dd")}`;
                  const rows = [
                    ["#", "Item Name", "Barcode", "Total Qty", "Total Pallets", "Items/Pallet", "First Arrived", "Last Arrived"],
                    ...extras.map((e, idx) => [
                      idx + 1,
                      e.itemName,
                      e.barcode,
                      e.totalQuantity,
                      e.totalPallets != null ? parseFloat(String(e.totalPallets)).toFixed(2) : "",
                      e.itemsPerPallet ?? "",
                      e.firstArrived ? format(new Date(e.firstArrived), "yyyy-MM-dd") : "",
                      e.lastArrived  ? format(new Date(e.lastArrived),  "yyyy-MM-dd") : "",
                    ]),
                  ];
                  downloadExcel(`extra-items${suffix}.xlsx`, rows);
                }}
              >
                <FileDown className="h-3.5 w-3.5 mr-1" />Excel
              </Button>
              <Button
                size="sm" variant="outline" className="h-8 text-xs"
                disabled={extras.length === 0}
                onClick={() => {
                  const suffix = `${selectedDate ? "-" + selectedDate : ""}-${format(new Date(), "yyyy-MM-dd")}`;
                  const rows = [
                    ["#", "Item Name", "Barcode", "Total Qty", "Total Pallets", "Items/Pallet", "First Arrived", "Last Arrived"],
                    ...extras.map((e, idx) => [
                      idx + 1,
                      e.itemName,
                      e.barcode,
                      e.totalQuantity,
                      e.totalPallets != null ? parseFloat(String(e.totalPallets)).toFixed(2) : "",
                      e.itemsPerPallet ?? "",
                      e.firstArrived ? format(new Date(e.firstArrived), "yyyy-MM-dd") : "",
                      e.lastArrived  ? format(new Date(e.lastArrived),  "yyyy-MM-dd") : "",
                    ]),
                  ];
                  downloadPdf(`extra-items${suffix}.pdf`, "Extra Items Report", rows);
                }}
              >
                <FileDown className="h-3.5 w-3.5 mr-1" />PDF
              </Button>
            </div>
          </div>

          <div className="rounded-md border bg-white overflow-x-auto">
            <ActiveFilters
              filters={extraColumnFilters}
              labels={{ itemName: "Item", barcode: "Barcode" }}
              onClear={clearExtraColFilter}
              onClearAll={clearAllExtraColFilters}
              chipCls="bg-amber-50 text-amber-700 border-amber-200"
            />
            <Table className="min-w-[780px] text-xs sm:text-sm">
              <TableHeader>
                <TableRow className="bg-amber-600 hover:bg-amber-600">
                  <TableHead className="text-white font-semibold uppercase tracking-wide sticky left-0 z-20 bg-amber-600 w-[44px] text-[11px] sm:text-xs">#</TableHead>
                  <FilterHead label="Item" colKey="itemName" openCol={openExtraFilterCol} filters={extraColumnFilters} onToggle={toggleExtraFilterCol} onChange={handleExtraColFilter} onClear={clearExtraColFilter} className="text-white sticky left-0 sm:left-[44px] z-30 bg-amber-600 min-w-[180px] shadow-[2px_0_6px_rgba(0,0,0,0.08)]" />
                  <FilterHead label="Barcode" colKey="barcode" openCol={openExtraFilterCol} filters={extraColumnFilters} onToggle={toggleExtraFilterCol} onChange={handleExtraColFilter} onClear={clearExtraColFilter} className="text-white bg-amber-600" />
                  <TableHead className="text-white font-semibold uppercase tracking-wide text-right">Total Qty</TableHead>
                  <TableHead className="text-white font-semibold uppercase tracking-wide text-right">Pallets</TableHead>
                  <TableHead className="text-white font-semibold uppercase tracking-wide">First Arrived</TableHead>
                  <TableHead className="text-white font-semibold uppercase tracking-wide">Last Arrived</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {filteredExtras.length === 0 ? (
                  <TableRow>
                    <TableCell colSpan={7} className="py-12 text-center text-sm text-gray-400">
                      No extra items recorded{selectedDate ? " for this date" : ""}.
                    </TableCell>
                  </TableRow>
                ) : (
                  filteredExtras.map((extra, idx) => {
                    const rowBg = idx % 2 === 0 ? "bg-white" : "bg-amber-50/40";
                    return (
                      <TableRow key={extra.barcode + idx} className={`${rowBg} transition-colors hover:bg-amber-50`}>
                        <TableCell className={`text-gray-400 text-[11px] sm:text-xs sticky left-0 z-10 ${rowBg} w-[44px] py-2 bg-white`}>
                          {idx + 1}
                        </TableCell>
                        <TableCell className={`font-medium text-gray-900 sticky left-0 sm:left-[44px] z-20 ${rowBg} min-w-[180px] max-w-[240px] whitespace-normal break-words py-2 shadow-[2px_0_6px_rgba(0,0,0,0.06)] bg-white`}>
                          {extra.itemName || <span className="text-gray-400 italic">Unknown</span>}
                        </TableCell>
                        <TableCell className="font-mono text-[11px] sm:text-xs text-gray-600 py-2">
                          {extra.barcode || <span className="text-gray-300">—</span>}
                        </TableCell>
                        <TableCell className="text-right py-2">
                          <span className="text-sm sm:text-base font-bold text-amber-700">
                            {(extra.totalQuantity ?? 0).toLocaleString()}
                          </span>
                        </TableCell>
                        <TableCell className="text-right font-semibold text-[#001d6e] py-2">
                          {extra.totalPallets != null && Number(extra.totalPallets) > 0
                            ? parseFloat(String(extra.totalPallets)).toFixed(2)
                            : <span className="text-gray-300 font-normal">—</span>}
                        </TableCell>
                        <TableCell className="text-xs text-gray-500 whitespace-nowrap py-2">
                          {extra.firstArrived
                            ? format(new Date(extra.firstArrived), "MMM d, yyyy")
                            : "—"}
                        </TableCell>
                        <TableCell className="text-xs text-gray-500 whitespace-nowrap py-2">
                          {extra.lastArrived
                            ? format(new Date(extra.lastArrived), "MMM d, yyyy")
                            : "—"}
                        </TableCell>
                      </TableRow>
                    );
                  })
                )}
              </TableBody>
            </Table>
            <div className="flex items-center justify-between border-t px-3 py-2 text-xs text-gray-500">
              <span>Page {extrasPage} of {extrasPageCount} · {extrasTotal} items</span>
              <div className="flex gap-2">
                <Button variant="outline" size="sm" disabled={extrasPage <= 1}
                  onClick={() => setExtrasPage((p) => Math.max(1, p - 1))}>Prev</Button>
                <Button variant="outline" size="sm" disabled={!extrasHasMore}
                  onClick={() => setExtrasPage((p) => p + 1)}>Next</Button>
              </div>
            </div>
          </div>
        </div>

        {/* Scan History has moved to /reports → Order Scan History tab */}
        <div className="hidden">

          {/* Section header */}
          <div className="flex items-center gap-2">
            <History className="h-5 w-5 text-[#001d6e]" />
            <h2 className="text-base sm:text-lg font-semibold text-gray-900">Scan History</h2>
            {historyFetching && (
              <span className="flex items-center gap-1 text-xs text-emerald-600">
                <RefreshCw className="h-3 w-3 animate-spin" />
                Updating…
              </span>
            )}
          </div>
          <p className="text-xs text-gray-500 -mt-1">
            Every individual scan event — who scanned what, when, and on which order.
          </p>

          {/* History-specific filters */}
          <div className="flex flex-wrap gap-2 items-center">
            {/* Free-text search */}
            <div className="relative min-w-[180px] flex-1 max-w-xs">
              <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-gray-400" />
              <Input
                className="pl-9 h-9 text-sm"
                placeholder="Item, barcode, or scanner…"
                value={historySearch}
                onChange={(e) => setHistorySearch(e.target.value)}
              />
              {historySearch && (
                <button
                  className="absolute right-2 top-1/2 -translate-y-1/2"
                  onClick={() => setHistorySearch("")}
                >
                  <X className="h-4 w-4 text-gray-400" />
                </button>
              )}
            </div>

            {/* Scanner filter */}
            <Select value={historyScanner} onValueChange={setHistoryScanner}>
              <SelectTrigger className="h-9 w-[160px] text-sm">
                <User className="h-3.5 w-3.5 mr-1.5 text-gray-400 shrink-0" />
                <SelectValue placeholder="All scanners" />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="__all__">All scanners</SelectItem>
                {historyScanners.map((name) => (
                  <SelectItem key={name} value={name}>{name}</SelectItem>
                ))}
              </SelectContent>
            </Select>

            {/* Type filter */}
            <Select value={historyType} onValueChange={setHistoryType}>
              <SelectTrigger className="h-9 w-[140px] text-sm">
                <SelectValue placeholder="All types" />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="all">All types</SelectItem>
                <SelectItem value="regular">Regular only</SelectItem>
                <SelectItem value="extra">Extra only</SelectItem>
              </SelectContent>
            </Select>

            {/* Export buttons */}
            <div className="flex gap-2 ml-auto">
              {(["CSV", "Excel", "PDF"] as const).map((fmt) => (
                <Button
                  key={fmt} variant="outline" size="sm" className="h-9 text-xs"
                  disabled={historyItems.length === 0}
                  onClick={() => {
                    const rows = historyExportRows(historyItems);
                    const suffix = `${selectedDate ? "-" + selectedDate : ""}-${format(new Date(), "yyyy-MM-dd")}`;
                    if (fmt === "CSV")   downloadCsv(`scan-history${suffix}.csv`, rows);
                    if (fmt === "Excel") downloadExcel(`scan-history${suffix}.xlsx`, rows);
                    if (fmt === "PDF")   downloadPdf(`scan-history${suffix}.pdf`, "Scan History", rows);
                  }}
                >
                  <FileDown className="h-3.5 w-3.5 mr-1" />{fmt}
                </Button>
              ))}
            </div>
          </div>

          {/* Summary chips */}
          <div className="flex flex-wrap gap-2">
            <div className="flex items-center gap-1.5 rounded-md border bg-white px-3 py-1.5 text-xs">
              <span className="text-gray-500">Total Events</span>
              <span className="font-bold text-gray-900">{historyTotal.toLocaleString()}</span>
            </div>
            <div className="flex items-center gap-1.5 rounded-md border bg-white px-3 py-1.5 text-xs">
              <span className="text-gray-500">Total Boxes</span>
              <span className="font-bold text-[#001d6e]">{historyTotalBoxes.toLocaleString()}</span>
            </div>
            <div className="flex items-center gap-1.5 rounded-md border bg-white px-3 py-1.5 text-xs">
              <span className="text-gray-500">Total Pallets</span>
              <span className="font-bold text-[#001d6e]">
                {historyTotalPallets > 0 ? parseFloat(String(historyTotalPallets)).toFixed(2) : "—"}
              </span>
            </div>
            <div className="flex items-center gap-1.5 rounded-md border border-amber-200 bg-amber-50 px-3 py-1.5 text-xs">
              <span className="text-amber-600">Extra Events</span>
              <span className="font-bold text-amber-700">{historyExtraCount.toLocaleString()}</span>
            </div>
          </div>

          {/* History table */}
          <div className="rounded-md border bg-white overflow-x-auto">
            <Table className="min-w-[1040px] text-xs sm:text-sm">
              <TableHeader>
                <TableRow className="bg-[#001d6e] hover:bg-[#001d6e]">
                  <TableHead className="text-white font-semibold uppercase tracking-wide sticky left-0 z-20 bg-[#001d6e] w-[44px] text-[11px]">#</TableHead>
                  <TableHead className="text-white font-semibold uppercase tracking-wide sticky left-0 sm:left-[44px] z-30 bg-[#001d6e] min-w-[130px] text-[11px] shadow-[2px_0_6px_rgba(0,0,0,0.10)]">
                    <span className="flex items-center gap-1"><UserCircle className="h-3.5 w-3.5" />Scanned By</span>
                  </TableHead>
                  <TableHead className="text-white font-semibold uppercase tracking-wide min-w-[180px] text-[11px]">Item</TableHead>
                  <TableHead className="text-white font-semibold uppercase tracking-wide text-[11px]">Barcode</TableHead>
                  <TableHead className="text-white font-semibold uppercase tracking-wide text-[11px]">Order</TableHead>
                  <TableHead className="text-white font-semibold uppercase tracking-wide text-[11px]">Plant</TableHead>
                  <TableHead className="text-white font-semibold uppercase tracking-wide text-right text-[11px]">Qty</TableHead>
                  <TableHead className="text-white font-semibold uppercase tracking-wide text-right text-[11px]">Pallets</TableHead>
                  <TableHead className="text-white font-semibold uppercase tracking-wide text-[11px]">STV</TableHead>
                  <TableHead className="text-white font-semibold uppercase tracking-wide text-[11px]">Type</TableHead>
                  <TableHead className="text-white font-semibold uppercase tracking-wide text-[11px] whitespace-nowrap">Time</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {historyLoading ? (
                  <TableRow>
                    <TableCell colSpan={11} className="py-16 text-center text-sm text-gray-400">
                      Loading scan history…
                    </TableCell>
                  </TableRow>
                ) : historyItems.length === 0 ? (
                  <TableRow>
                    <TableCell colSpan={11} className="py-16 text-center text-sm text-gray-400">
                      No scan events found{selectedDate ? " for this date" : ""}.
                    </TableCell>
                  </TableRow>
                ) : (
                  historyItems.map((h, idx) => {
                    const rowBg = h.isExtra
                      ? (idx % 2 === 0 ? "bg-amber-50/50" : "bg-amber-50/80")
                      : (idx % 2 === 0 ? "bg-white" : "bg-slate-50");
                    return (
                      <TableRow key={h.id} className={`${rowBg} transition-colors hover:bg-slate-100/70`}>
                        {/* # */}
                        <TableCell className={`text-gray-400 text-[11px] sticky left-0 z-10 ${rowBg} w-[44px] py-2.5`}>
                          {historyOffset + idx + 1}
                        </TableCell>

                        {/* Scanned By */}
                        <TableCell className={`sticky left-0 sm:left-[44px] z-20 ${rowBg} min-w-[130px] py-2.5 shadow-[2px_0_6px_rgba(0,0,0,0.06)]`}>
                          <p className="font-medium text-gray-900 text-xs leading-tight">
                            {h.scannedByName ?? <span className="text-gray-300">—</span>}
                          </p>
                          {h.scannedByCode && (
                            <p className="text-[11px] text-gray-400 font-mono leading-tight">{h.scannedByCode}</p>
                          )}
                        </TableCell>

                        {/* Item */}
                        <TableCell className="min-w-[180px] max-w-[240px] py-2.5">
                          <p className="font-medium text-gray-900 text-xs leading-snug whitespace-normal break-words">
                            {h.itemName ?? <span className="text-gray-300">—</span>}
                          </p>
                        </TableCell>

                        {/* Barcode */}
                        <TableCell className="font-mono text-[11px] text-gray-500 py-2.5">
                          {h.barcode ?? <span className="text-gray-300">—</span>}
                        </TableCell>

                        {/* Order */}
                        <TableCell className="text-xs text-gray-700 py-2.5 max-w-[140px] truncate">
                          {h.orderName}
                        </TableCell>

                        {/* Plant */}
                        <TableCell className="py-2.5">
                          <Badge variant="outline" className="text-[11px] px-1.5 py-0">
                            {h.plant}
                          </Badge>
                        </TableCell>

                        {/* Qty */}
                        <TableCell className="text-right font-bold text-[#001d6e] py-2.5">
                          {h.totalQty.toLocaleString()}
                        </TableCell>

                        {/* Pallets */}
                        <TableCell className="text-right font-semibold text-[#001d6e] py-2.5">
                          {h.pallets != null && Number(h.pallets) > 0
                            ? parseFloat(String(h.pallets)).toFixed(2)
                            : <span className="text-gray-300 font-normal">—</span>}
                        </TableCell>

                        {/* STV */}
                        <TableCell className="text-xs text-gray-600 py-2.5">
                          {h.stv ?? <span className="text-gray-300">—</span>}
                        </TableCell>

                        {/* Type */}
                        <TableCell className="py-2.5">
                          {h.isExtra
                            ? <Badge className="bg-amber-100 text-amber-800 hover:bg-amber-100 text-[11px] px-1.5 border-0">Extra</Badge>
                            : <Badge className="bg-green-100 text-green-800 hover:bg-green-100 text-[11px] px-1.5 border-0">Regular</Badge>}
                        </TableCell>

                        {/* Time */}
                        <TableCell className="text-[11px] text-gray-500 whitespace-nowrap py-2.5">
                          {h.scannedAt
                            ? format(new Date(h.scannedAt), "MMM d, h:mm a")
                            : "—"}
                        </TableCell>
                      </TableRow>
                    );
                  })
                )}
              </TableBody>
            </Table>

            <div className="flex items-center justify-between border-t px-3 py-2 text-xs text-gray-500">
              <span>
                {historyTotal > 0
                  ? `Showing ${historyOffset + 1}–${Math.min(historyOffset + historyItems.length, historyTotal)} of ${historyTotal} events`
                  : "No events"}
              </span>
              <div className="flex gap-2">
                <Button variant="outline" size="sm" disabled={historyPage <= 1}
                  onClick={() => setHistoryPage((p) => Math.max(1, p - 1))}>Prev</Button>
                <Button variant="outline" size="sm" disabled={!historyHasMore}
                  onClick={() => setHistoryPage((p) => p + 1)}>Next</Button>
              </div>
            </div>
          </div>
        </div>

      </div>
    </div>
  );
}
