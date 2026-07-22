import { useMemo, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { format } from "date-fns";
import * as XLSX from "xlsx";
import jsPDF from "jspdf";
import autoTable from "jspdf-autotable";
import { FileDown, LayoutList, Factory, Boxes, TrendingUp, ChevronDown, PackageX, CalendarDays, Check, Loader2, History } from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import {
  Select, SelectContent, SelectItem, SelectTrigger, SelectValue,
} from "@/components/ui/select";
import {
  Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription,
} from "@/components/ui/dialog";
import PageHeader from "@/components/PageHeader";
import { apiRequest } from "@/lib/queryClient";
import { DataTable, DataTableColumnToggle, type DataTableColumn } from "@/components/ui/data-table";
import { StatsBar } from "@/components/ui/stats-bar";
import { TableCard } from "@/components/ui/table-card";

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
  // Marks a synthetic "Empty Box" row (a distinct entry, NOT product stock). When true,
  // inStock carries the empty-box quantity purely for display and emptyBoxCount the # of
  // entries; the stock/extra/pallet cells render as dashes so it's never read as inventory.
  isEmptyBox?: boolean;
  emptyBoxCount?: number;
  // Sum of every CSV's ordered quantity for this barcode+plant on the picked date (across ALL
  // parts uploaded for that date) — only populated when exactly one date is selected (see
  // expectedDate below). null when no single date is active.
  expectedQty?: number | null;
};

type PlantStockResponse = {
  items: PlantStockRow[];
  total: number;
  // null = admin/super-admin (all plants). Array = the plant(s) this user is limited to.
  plants: string[] | null;
  // Empty boxes: physical boxes received with no product — a distinct status, never part of
  // stock. Surfaced separately for reconciliation.
  emptyBoxByPlant?: { plant: string; qty: number; count: number }[];
  emptyBoxTotal?: number;
  // true when a from/to range was applied — quantities then mean "received in that window"
  // (sourced from the stock_movements ledger), not current totals.
  dateMode?: boolean;
  from?: string | null;
  to?: string | null;
  // Set only when from/to pin down exactly one date — the date Expected Qty was computed for.
  expectedDate?: string | null;
  expectedTotal?: number | null;
};

// One dated entry from the stock_movements ledger for a single (barcode, plant) — powers the
// arrival-history drill-down dialog. type: 'receive' (a scan added stock), 'adjust' (a void or
// a CSV delete-rollback reversed some), 'dispatch' (future — outbound, not written yet).
type StockMovementRow = {
  id: number;
  qty: number;
  extraQty: number | null;
  type: "receive" | "dispatch" | "adjust";
  reason: string | null;
  arrivedAt: string;
  orderName: string | null;
  orderDate: string | null;
  partIndex: number | null;
};

// ─── Column config ────────────────────────────────────────────────────────────

const ALL_COLUMNS = [
  { key: "barcode",     label: "Barcode / SKU" },
  { key: "sapCode",     label: "SAP Code" },
  { key: "category",    label: "Category" },
  { key: "brand",       label: "Brand" },
  { key: "expected",    label: "Expected Qty" },
  { key: "stock",       label: "Stock (Boxes)" },
  { key: "extra",       label: "Extra" },
  { key: "pallets",     label: "Pallets" },
  { key: "extraPallets", label: "Extra Pallets" },
  { key: "lastUpdated", label: "Last Updated" },
] as const;

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

// Business-report layout: a branded header band (title + scope/filter line + generated-on/row
// count), a bordered grid table with zebra striping and right-aligned numeric columns, and a
// footer with page numbers — instead of a bare title + default-styled table.
function downloadPdf(
  filename: string,
  rows: Array<Array<string | number>>,
  meta: { title: string; scope: string },
) {
  const doc = new jsPDF({ orientation: "landscape" });
  const pageWidth = doc.internal.pageSize.getWidth();
  const pageHeight = doc.internal.pageSize.getHeight();
  const margin = 14;

  // ── Header band ──
  doc.setFillColor(0, 29, 110); // brand navy — matches the app's header treatment
  doc.rect(0, 0, pageWidth, 24, "F");
  doc.setTextColor(255, 255, 255);
  doc.setFont("helvetica", "bold");
  doc.setFontSize(15);
  doc.text(meta.title, margin, 14);
  doc.setFont("helvetica", "normal");
  doc.setFontSize(9);
  doc.text(meta.scope, margin, 20);

  doc.setFontSize(8);
  doc.text(`Generated ${format(new Date(), "MMM d, yyyy 'at' h:mm a")}`, pageWidth - margin, 17, { align: "right" });
  doc.setTextColor(0, 0, 0);

  const [header, ...body] = rows;
  // Right-align every numeric/quantity column — matches the header order built by exportRows:
  // #, Item, Barcode, SAP Code, HSN Code, Category, Brand, Plant, Expected Qty, Stock (Boxes),
  // Extra, Pallets, Extra Pallets, Last Updated.
  const rightAlignCols = [0, 8, 9, 10, 11, 12];
  const columnStyles: Record<number, { halign: "right" }> = {};
  rightAlignCols.forEach((i) => { columnStyles[i] = { halign: "right" }; });

  autoTable(doc, {
    head: [header as string[]],
    body: body as string[][],
    startY: 30,
    theme: "grid",
    styles: { fontSize: 7, cellPadding: 2.2, lineColor: [210, 210, 210], lineWidth: 0.15 },
    headStyles: { fillColor: [0, 29, 110], textColor: 255, fontStyle: "bold", halign: "left" },
    alternateRowStyles: { fillColor: [245, 247, 251] },
    columnStyles,
    margin: { left: margin, right: margin },
  });

  // ── Footer: page numbers + brand, on every page ──
  const pageCount = doc.getNumberOfPages();
  for (let i = 1; i <= pageCount; i++) {
    doc.setPage(i);
    doc.setFontSize(8);
    doc.setTextColor(150, 150, 150);
    doc.text("KM Finny — Confidential", margin, pageHeight - 8);
    doc.text(`Page ${i} of ${pageCount}`, pageWidth - margin, pageHeight - 8, { align: "right" });
  }

  doc.save(filename);
}

const PAGE_SIZE = 20;

// Solid navy fill, matching the Notion Inventory action buttons. Squared off (rounded-none)
// for the business-report look — no soft/pill-shaped filter controls.
const FILTER_BTN_CLASS = "h-8 rounded-none border-0 bg-[#001d6e] text-white hover:bg-[#001552] hover:text-white text-xs";

// Date-range presets. Declared once so the dropdown items and the trigger's active label
// (and thus the "which filter is selected" state) can't drift apart.
const QUICK_FILTERS = [
  { key: "today", label: "Today" },
  { key: "yday",  label: "Yesterday" },
  { key: "week",  label: "This week" },
  { key: "month", label: "This month" },
] as const;

// ─── Component ───────────────────────────────────────────────────────────────

export default function OverallStock() {
  const [plantFilter, setPlantFilter] = useState(""); // "" = all plants the user may see
  const [search,      setSearch]      = useState("");
  const [pageIndex,   setPageIndex]   = useState(0);
  // Date range → the server switches from current running totals to the dated movements
  // ledger, showing ONLY what was received inside the window (earlier stock is not carried
  // in). Both empty = today's behavior, current totals.
  const [fromDate,    setFromDate]    = useState("");
  const [toDate,      setToDate]      = useState("");
  const [extrasOnly,  setExtrasOnly]  = useState(false);
  const [sortBy,      setSortBy]      = useState<"" | "stock" | "extra">("");
  // Which quick-filter preset produced the current date range, so the trigger can name it and
  // Clear can undo just that. Reset to "" whenever the dates are edited by hand, since the range
  // then no longer corresponds to a preset.
  const [quickFilter, setQuickFilter] = useState<"" | "today" | "yday" | "week" | "month">("");
  const [visibleColumnIds, setVisibleColumnIds] = useState<Set<string>>(
    () => new Set(["srNo", "itemName", ...ALL_COLUMNS.map((c) => c.key), "plant"]),
  );

  // Arrival-history drill-down — clicking a row opens a dialog showing every dated entry from
  // the stock_movements ledger for that exact (barcode, plant): when it arrived and how much.
  const [detailRow, setDetailRow] = useState<PlantStockRow | null>(null);
  const { data: movementsData, isLoading: movementsLoading } = useQuery<{ items: StockMovementRow[] }>({
    queryKey: ["/api/scan-sessions/reports/stock-movements", detailRow?.barcode, detailRow?.plant],
    queryFn: () =>
      apiRequest(
        "GET",
        buildUrl("/api/scan-sessions/reports/stock-movements", { barcode: detailRow!.barcode!, plant: detailRow!.plant }),
        undefined, false, true,
      ),
    enabled: !!detailRow?.barcode,
  });

  const toggleColumn = (key: string) =>
    setVisibleColumnIds((prev) => {
      const next = new Set(prev);
      if (next.has(key)) {
        // Keep at least one of the optional (ALL_COLUMNS) columns visible.
        const remainingOptional = ALL_COLUMNS.filter((c) => c.key !== key && next.has(c.key));
        if (remainingOptional.length > 0) next.delete(key);
      } else next.add(key);
      return next;
    });

  // All configured plants — used to populate the plant switcher for admins.
  const { data: allPlants = [] } = useQuery<{ id: number; name: string }[]>({
    queryKey: ["/api/plants"],
    queryFn: () => apiRequest("GET", "/api/plants", undefined, false, true),
  });

  // Plant-wise stock. Server enforces access: admins get every plant, others only theirs.
  const stockUrl = buildUrl("/api/scan-sessions/reports/plant-stock", {
    plant: plantFilter || undefined,
    from: fromDate || undefined,
    to: toDate || undefined,
    extrasOnly: extrasOnly ? "1" : undefined,
    sort: sortBy || undefined,
  });
  const { data: stockData } = useQuery<PlantStockResponse>({
    queryKey: ["/api/scan-sessions/reports/plant-stock", plantFilter, fromDate, toDate, extrasOnly, sortBy],
    queryFn: () => apiRequest("GET", stockUrl, undefined, false, true),
    refetchInterval: 30000,
  });
  // True when a date range is active: the Stock/Extra numbers then mean "received in this
  // window" rather than "total on hand", so the UI labels them differently.
  const dateMode = stockData?.dateMode ?? false;
  // Expected Qty (sum of every CSV's ordered quantity across all parts for one date) only
  // populates when from/to pin down exactly ONE date — set server-side as expectedDate.
  const expectedDate = stockData?.expectedDate ?? null;
  const expectedTotal = stockData?.expectedTotal ?? 0;

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

  // Summary — from REAL stock rows only; empty boxes are never counted as stock.
  const totalStock = filtered.reduce((s, r) => s + r.inStock, 0);
  const totalExtra = filtered.reduce((s, r) => s + r.extraQty, 0);
  const totalExtraPallets = filtered.reduce((s, r) => s + (r.extraPallets ?? 0), 0);

  // Empty boxes as their OWN distinct rows (one per plant), appended below the stock rows.
  // Never mixed into stock/extra totals — the quantity shows only inside the "Empty Box" badge.
  const emptyBoxRows = useMemo<PlantStockRow[]>(() => {
    const list = stockData?.emptyBoxByPlant ?? [];
    const q = search.toLowerCase();
    return list
      .filter((e) => e.qty > 0)
      .filter((e) => !search || "empty box".includes(q) || e.plant.toLowerCase().includes(q))
      .map((e) => ({
        srNo: 0, barcode: "EMPTY_BOX", plant: e.plant, itemName: "Empty Box",
        itemNo: null, sapCode: null, hsnCode: null, category: null, brand: null,
        itemsPerPallet: null, inStock: e.qty, extraQty: 0, pallets: null, extraPallets: null,
        lastArrived: null, isEmptyBox: true, emptyBoxCount: e.count,
      }));
  }, [stockData?.emptyBoxByPlant, search]);
  const emptyBoxTotal = stockData?.emptyBoxTotal ?? 0;

  // Real stock rows first, then the distinct empty-box rows.
  const displayRows = useMemo(() => [...filtered, ...emptyBoxRows], [filtered, emptyBoxRows]);

  // Export rows
  const exportRows = (src: PlantStockRow[]): Array<Array<string | number>> => [
    ["#", "Item", "Barcode", "SAP Code", "HSN Code", "Category", "Brand", "Plant", "Expected Qty", "Stock (Boxes)", "Extra", "Pallets", "Extra Pallets", "Last Updated"],
    ...src.map((r, i) => [
      i + 1, r.itemName, r.barcode ?? "", r.sapCode ?? "", r.hsnCode ?? "",
      r.category ?? "", r.brand ?? "", r.plant, r.expectedQty ?? "", r.inStock, r.extraQty,
      r.pallets != null ? r.pallets.toFixed(2) : "",
      r.extraPallets != null ? r.extraPallets.toFixed(2) : "",
      r.lastArrived ? format(new Date(r.lastArrived), "yyyy-MM-dd") : "",
    ]),
  ];

  const dash = <span className="text-gray-300">—</span>;
  // Crisper grid lines (was border-gray-100) — a typical business/report table reads as an
  // actual grid, not a barely-visible divider.
  const cellBorder = "border-r border-gray-300";
  const headerBorder = "border-r border-[#001d6e]/30";

  const stockColumns: DataTableColumn<PlantStockRow>[] = [
    {
      id: "srNo",
      header: "#",
      hideable: false,
      width: 44,
      headerClassName: headerBorder,
      cellClassName: `text-gray-400 tabular-nums ${cellBorder}`,
      render: (_row, rowIndex) => rowIndex + 1,
    },
    {
      id: "itemName",
      header: "Item",
      hideable: false,
      width: 220,
      sortable: true,
      accessor: (row) => row.itemName,
      headerClassName: headerBorder,
      cellClassName: `font-medium text-gray-900 whitespace-normal break-words ${cellBorder}`,
      render: (row) =>
        row.isEmptyBox ? (
          <span className="inline-flex items-center gap-1.5" title={row.emptyBoxCount ? `${row.emptyBoxCount} entr${row.emptyBoxCount === 1 ? "y" : "ies"}` : undefined}>
            <span>Empty Box</span>
            <span className="inline-flex items-center bg-orange-100 px-1.5 py-0.5 text-[9px] font-semibold uppercase tracking-wide text-orange-700">No product</span>
          </span>
        ) : (
          row.itemName
        ),
    },
    {
      id: "barcode",
      header: "Barcode / SKU",
      width: 140,
      sortable: true,
      accessor: (row) => row.barcode,
      totalable: false,
      headerClassName: headerBorder,
      cellClassName: `font-mono text-gray-600 ${cellBorder}`,
      render: (row) => (row.isEmptyBox ? dash : row.barcode ?? dash),
    },
    {
      id: "sapCode",
      header: "SAP Code",
      width: 110,
      sortable: true,
      accessor: (row) => row.sapCode,
      totalable: false,
      headerClassName: headerBorder,
      cellClassName: `font-mono text-gray-600 ${cellBorder}`,
      render: (row) => row.sapCode ?? dash,
    },
    {
      id: "category",
      header: "Category",
      width: 130,
      sortable: true,
      accessor: (row) => row.category,
      headerClassName: headerBorder,
      cellClassName: `text-gray-700 ${cellBorder}`,
      render: (row) => row.category ?? dash,
    },
    {
      id: "brand",
      header: "Brand",
      width: 110,
      sortable: true,
      accessor: (row) => row.brand,
      headerClassName: headerBorder,
      cellClassName: `text-gray-700 ${cellBorder}`,
      render: (row) => row.brand ?? dash,
    },
    {
      id: "plant",
      header: "Plant",
      hideable: false,
      width: 100,
      sortable: true,
      accessor: (row) => row.plant,
      headerClassName: headerBorder,
      cellClassName: `font-semibold text-[#001d6e] uppercase ${cellBorder}`,
      render: (row) => row.plant,
    },
    {
      id: "expected",
      header: "Expected Qty",
      width: 110,
      align: "right",
      sortable: true,
      accessor: (row) => row.expectedQty ?? 0,
      headerClassName: headerBorder,
      cellClassName: cellBorder,
      render: (row) =>
        row.isEmptyBox || row.expectedQty == null ? dash : (
          <span className="font-bold text-purple-700 tabular-nums" title="Sum of ordered quantity across every CSV/part uploaded for this date">
            {row.expectedQty.toLocaleString()}
          </span>
        ),
    },
    {
      id: "stock",
      header: "Stock (Boxes)",
      width: 110,
      align: "right",
      sortable: true,
      accessor: (row) => row.inStock,
      headerClassName: headerBorder,
      cellClassName: `font-bold text-[#001d6e] tabular-nums ${cellBorder}`,
      render: (row) =>
        row.isEmptyBox
          ? <span className="font-bold text-orange-600 tabular-nums" title="Empty boxes — not counted in stock totals">{row.inStock.toLocaleString()}</span>
          : row.inStock.toLocaleString(),
    },
    {
      id: "extra",
      header: "Extra",
      width: 90,
      align: "right",
      sortable: true,
      accessor: (row) => row.extraQty,
      headerClassName: headerBorder,
      cellClassName: cellBorder,
      render: (row) =>
        row.extraQty > 0 ? (
          <span className="font-semibold text-amber-600 tabular-nums">{row.extraQty.toLocaleString()}</span>
        ) : (
          dash
        ),
    },
    {
      id: "pallets",
      header: "Pallets",
      width: 90,
      align: "right",
      sortable: true,
      accessor: (row) => row.pallets,
      total: (rows) => rows.reduce((sum, r) => sum + (r.pallets ?? 0), 0).toFixed(2),
      headerClassName: headerBorder,
      cellClassName: cellBorder,
      render: (row) =>
        row.pallets != null && row.pallets > 0 ? (
          <span className="font-semibold text-[#001d6e] tabular-nums">{row.pallets.toFixed(2)}</span>
        ) : (
          dash
        ),
    },
    {
      id: "extraPallets",
      header: "Extra Pallets",
      width: 110,
      align: "right",
      sortable: true,
      accessor: (row) => row.extraPallets,
      total: (rows) => rows.reduce((sum, r) => sum + (r.extraPallets ?? 0), 0).toFixed(2),
      headerClassName: headerBorder,
      cellClassName: cellBorder,
      render: (row) =>
        row.extraPallets != null && row.extraPallets > 0 ? (
          <span className="font-semibold text-amber-600 tabular-nums">{row.extraPallets.toFixed(2)}</span>
        ) : (
          dash
        ),
    },
    {
      id: "lastUpdated",
      header: "Last Updated",
      width: 120,
      sortable: true,
      accessor: (row) => row.lastArrived,
      cellClassName: "text-gray-500 whitespace-nowrap",
      render: (row) => (row.lastArrived ? format(new Date(row.lastArrived), "MMM d, yyyy") : dash),
    },
  ];

  return (
    <div className="flex-1 overflow-y-auto p-4 lg:p-6">
      <div className="max-w-7xl mx-auto space-y-4">
        <PageHeader
          icon={LayoutList}
          title="Stock Overview"
          description="Live plant-wise inventory. Stock reflects all boxes received (extras included); Excess and Ordered quantity are reported separately."
        />

        {/* Summary tiles — squared off (rounded-none, no shadow, stronger divider) to match the
            business-report treatment applied to the table below. */}
        <StatsBar
          className="rounded-none shadow-none border-gray-300 [&_.divide-x]:divide-gray-300"
          wrapLabels
        
          stats={[
            {
              icon: Boxes,
              tone: "navy",
              value: totalStock.toLocaleString(),
              // In date mode this is what ARRIVED in the window, not what's on hand — say so
              // explicitly, otherwise the number reads as a (much smaller) total stock figure.
              label: `${dateMode ? "Total Stock Received" : "Total Stock (Boxes)"}${plantFilter ? ` · ${plantFilter}` : allowedPlants && allowedPlants.length ? ` · ${plantOptions.join(", ")}` : " · All Plants"}`,
            },
            {
              icon: TrendingUp,
              tone: "amber",
              value: totalExtra.toLocaleString(),
              label: `Excess Stock (Over-Order) · ${totalExtraPallets.toFixed(2)} plt`,
            },
            {
              icon: PackageX,
              tone: "amber",
              value: emptyBoxTotal.toLocaleString(),
              label: "Empty Boxes",
            },
            // Always on: sums every CSV/part's ordered quantity for one date — defaults to
            // TODAY when no date filter is set (see the server's todayIST default), or the
            // exact date picked via From/To otherwise.
            ...(expectedDate ? [{
              icon: CalendarDays,
              tone: "navy" as const,
              value: expectedTotal.toLocaleString(),
              label: !fromDate && !toDate ? `Today's Total Order Qty (${expectedDate})` : `Total Order Qty (${expectedDate})`,
            }] : []),
          ]}
          actions={
            <>
              <Select value={plantFilter || "_all_"} onValueChange={(v) => { setPlantFilter(v === "_all_" ? "" : v); setPageIndex(0); }}>
                <SelectTrigger className={`w-[132px] gap-1.5 ${FILTER_BTN_CLASS}`}>
                  <Factory className="h-3.5 w-3.5 shrink-0" />
                  <SelectValue placeholder="All plants" />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="_all_">{isAdmin ? "All plants" : "All my plants"}</SelectItem>
                  {plantOptions.map((p) => <SelectItem key={p} value={p}>{p}</SelectItem>)}
                </SelectContent>
              </Select>

              {/* Date range — when set, the numbers become "received in this window" (from the
                  movements ledger) instead of current totals. Both empty = totals, as before. */}
              <div className="flex items-center gap-1">
                <input
                  type="date"
                  value={fromDate}
                  onChange={(e) => { setFromDate(e.target.value); setQuickFilter(""); setPageIndex(0); }}
                  className="h-8 rounded-none border border-gray-300 bg-white px-2 text-xs"
                  aria-label="From date"
                />
                <span className="text-xs text-gray-400">→</span>
                <input
                  type="date"
                  value={toDate}
                  onChange={(e) => { setToDate(e.target.value); setQuickFilter(""); setPageIndex(0); }}
                  className="h-8 rounded-none border border-gray-300 bg-white px-2 text-xs"
                  aria-label="To date"
                />
              </div>

              {/* Quick presets — collapsed into one dropdown so the filter row stays compact. The
                  trigger names the active preset so the selection is visible while closed. */}
              <DropdownMenu>
                <DropdownMenuTrigger asChild>
                  <Button size="sm" variant="outline" className={FILTER_BTN_CLASS}>
                    <CalendarDays className="h-3.5 w-3.5 mr-1" />
                    {QUICK_FILTERS.find((p) => p.key === quickFilter)?.label ?? "Quick filter"}
                    <ChevronDown className="h-3.5 w-3.5 ml-1 opacity-70" />
                  </Button>
                </DropdownMenuTrigger>
                <DropdownMenuContent align="start" className="w-40">
                  {QUICK_FILTERS.map((p) => (
                    <DropdownMenuItem
                      key={p.key}
                      onSelect={() => {
                        const d = new Date();
                        const iso = (x: Date) => format(x, "yyyy-MM-dd");
                        let f = "", t = iso(d);
                        if (p.key === "today") f = iso(d);
                        if (p.key === "yday")  { const y = new Date(d); y.setDate(y.getDate() - 1); f = iso(y); t = iso(y); }
                        if (p.key === "week")  { const w = new Date(d); w.setDate(w.getDate() - 6); f = iso(w); }
                        if (p.key === "month") { f = iso(new Date(d.getFullYear(), d.getMonth(), 1)); }
                        setFromDate(f); setToDate(t); setQuickFilter(p.key); setPageIndex(0);
                      }}
                    >
                      <span className="flex-1">{p.label}</span>
                      {quickFilter === p.key && <Check className="h-3.5 w-3.5 text-[#001d6e]" />}
                    </DropdownMenuItem>
                  ))}
                </DropdownMenuContent>
              </DropdownMenu>

              {/* Only shown while a quick filter is active, and clears only that — the plant, sort
                  and Extras-only filters are left untouched. */}
              {quickFilter && (
              <Button
                size="sm"
                variant="outline"
                className="h-8 rounded-none border-gray-300 bg-white text-xs text-gray-600 hover:bg-gray-50 hover:text-gray-900"
                onClick={() => { setFromDate(""); setToDate(""); setQuickFilter(""); setPageIndex(0); }}
              >
                Clear
              </Button>
              )}

              <Button
                size="sm"
                variant="outline"
                className={`${FILTER_BTN_CLASS} ${extrasOnly ? "ring-2 ring-amber-400" : ""}`}
                onClick={() => { setExtrasOnly((v) => !v); setPageIndex(0); }}
              >
                Extras only
              </Button>

              <Select value={sortBy || "_none_"} onValueChange={(v) => { setSortBy(v === "_none_" ? "" : (v as "stock" | "extra")); setPageIndex(0); }}>
                <SelectTrigger className={`w-[124px] gap-1.5 ${FILTER_BTN_CLASS}`}>
                  <SelectValue placeholder="Sort" />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="_none_">Sort: Name</SelectItem>
                  <SelectItem value="stock">Sort: Stock ↓</SelectItem>
                  <SelectItem value="extra">Sort: Extra ↓</SelectItem>
                </SelectContent>
              </Select>

              <DataTableColumnToggle
                columns={stockColumns}
                visibleColumnIds={visibleColumnIds}
                onToggleColumn={toggleColumn}
                onSetAll={(visible) => setVisibleColumnIds(visible ? new Set(stockColumns.map((c) => c.id)) : new Set())}
                buttonClassName={FILTER_BTN_CLASS}
              />

              {/* One Export control instead of three buttons; the format is picked from the menu. */}
              <div className="ml-auto">
                <DropdownMenu>
                  <DropdownMenuTrigger asChild>
                    <Button variant="outline" size="sm" className={FILTER_BTN_CLASS} disabled={filtered.length === 0}>
                      <FileDown className="h-3.5 w-3.5 mr-1" />
                      Export
                      <ChevronDown className="h-3.5 w-3.5 ml-1 opacity-70" />
                    </Button>
                  </DropdownMenuTrigger>
                  <DropdownMenuContent align="end" className="w-36">
                    {(["CSV", "Excel", "PDF"] as const).map((fmt) => (
                      <DropdownMenuItem
                        key={fmt}
                        onSelect={() => {
                          const exp = exportRows(filtered);
                          const suffix = `${plantFilter ? "-" + plantFilter : ""}-${format(new Date(), "yyyy-MM-dd")}`;
                          if (fmt === "CSV")   downloadCsv(`overall-stock${suffix}.csv`, exp);
                          if (fmt === "Excel") downloadExcel(`overall-stock${suffix}.xlsx`, exp);
                          if (fmt === "PDF") {
                            const plantScope = plantFilter || (allowedPlants && allowedPlants.length ? plantOptions.join(", ") : "All Plants");
                            const dateScope = fromDate || toDate ? `  ·  ${fromDate || "…"} to ${toDate || "…"}` : "";
                            downloadPdf(`overall-stock${suffix}.pdf`, exp, { title: "Stock Overview Report", scope: `${plantScope}${dateScope}` });
                          }
                        }}
                      >
                        <FileDown className="h-3.5 w-3.5 mr-2 opacity-70" />
                        {fmt}
                      </DropdownMenuItem>
                    ))}
                  </DropdownMenuContent>
                </DropdownMenu>
              </div>
            </>
          }
        />

        {/* Table card — title + search only; filters live in the stats card's action bar.
            Squared off (rounded-none, no shadow) — a business report reads as a plain bordered
            grid, not a soft floating card. */}
        <TableCard
          icon={LayoutList}
          title="Stock by Plant"
          subtitle={search ? `${filtered.length} of ${rows.length} rows` : `${rows.length} item · plant rows`}
          searchValue={search}
          onSearchChange={(v) => { setSearch(v); setPageIndex(0); }}
          searchPlaceholder="Item, barcode, SAP, category…"
          className="rounded-none shadow-none border-gray-300"
        >
          <DataTable<PlantStockRow>
            className="space-y-0"
            containerClassName="rounded-none border-0"
            columns={stockColumns}
            data={displayRows}
            getRowId={(row) => `${row.isEmptyBox ? "EB" : row.barcode}-${row.plant}`}
            rowClassName={(row) => (row.isEmptyBox ? "bg-orange-50/40" : "cursor-pointer")}
            onRowClick={(row) => setDetailRow(row)}
            isRowClickable={(row) => !row.isEmptyBox && !!row.barcode}
            emptyState={`No stock yet${plantFilter ? ` for ${plantFilter}` : ""}. Stock appears here once an order is completed.`}
            noResultsState="No stock rows match your search."
            hasActiveFilters={!!search}
            enableTotalsRow
            enableZebraStripes
            sortMode="client"
            paginationMode="client"
            pageIndex={pageIndex}
            onPageIndexChange={setPageIndex}
            defaultPageSize={PAGE_SIZE}
            pageSizeOptions={[20, 50, 100, 200]}
            enableColumnResizing
            enableColumnVisibility
            columnVisibility={visibleColumnIds}
            onColumnVisibilityChange={setVisibleColumnIds}
            showMobileSwipeHint
            headerClassName="bg-[#001d6e] text-white border-[#1a3a9c] hover:bg-[#0a2b7e] hover:text-white"
          />
        </TableCard>
      </div>

      {/* ── Stock movement history drill-down — every dated entry from the stock_movements
          ledger for the clicked (barcode, plant). Deliberately generalized to cover BOTH
          directions, not just inbound: today every row is a receive/adjust (party-order
          dispatch — outbound, stock-decreasing — isn't built yet), but once it is, its rows
          land in this same ledger/table with type='dispatch' and a negative qty. The "Date &
          Movement" column (was "Arrived" — inbound-only wording) shows the date PLUS a
          Received/Dispatched/Adjusted badge so both directions read correctly without any
          further UI change when dispatch ships. ── */}
      <Dialog open={!!detailRow} onOpenChange={(open) => { if (!open) setDetailRow(null); }}>
        <DialogContent className="max-w-xl">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2 text-[#001d6e]">
              <History className="h-5 w-5" />
              {detailRow?.itemName ?? "Item"}
            </DialogTitle>
            <DialogDescription className="font-mono text-xs">
              {detailRow?.barcode} · {detailRow?.plant}
            </DialogDescription>
          </DialogHeader>

          {movementsLoading ? (
            <div className="flex justify-center py-10">
              <Loader2 className="h-6 w-6 animate-spin text-[#001d6e]" />
            </div>
          ) : (movementsData?.items?.length ?? 0) === 0 ? (
            <p className="py-8 text-center text-sm text-gray-400">No stock movements yet for this item.</p>
          ) : (
            <div className="max-h-[420px] overflow-y-auto border border-gray-300">
              <table className="w-full border-collapse text-xs">
                <thead>
                  <tr className="border-b-2 border-gray-300 bg-gray-100 text-left text-gray-600">
                    <th className="border-r border-gray-300 px-3 py-2 font-semibold">Date &amp; Movement</th>
                    <th className="border-r border-gray-300 px-3 py-2 font-semibold">Order / CSV</th>
                    <th className="border-r border-gray-300 px-3 py-2 text-right font-semibold">Qty</th>
                    <th className="px-3 py-2 text-right font-semibold">Extra</th>
                  </tr>
                </thead>
                <tbody>
                  {movementsData!.items.map((m) => {
                    const isNegative = m.qty < 0;
                    // type is the source of truth for direction (qty sign can be negative for
                    // BOTH a dispatch and a reversal/void adjust) — badge them distinctly so
                    // "stock going out because of a party order" reads differently from
                    // "a mistaken scan being undone".
                    const movementBadge = m.type === "dispatch"
                      ? <span className="inline-block bg-red-100 px-1.5 py-0.5 text-[10px] font-semibold uppercase tracking-wide text-red-700">Dispatched</span>
                      : m.type === "adjust"
                      ? <span className="inline-block bg-gray-200 px-1.5 py-0.5 text-[10px] font-semibold uppercase tracking-wide text-gray-600">Adjusted</span>
                      : <span className="inline-block bg-emerald-100 px-1.5 py-0.5 text-[10px] font-semibold uppercase tracking-wide text-emerald-700">Received</span>;
                    return (
                      <tr key={m.id} className="border-b border-gray-200">
                        <td className="border-r border-gray-200 px-3 py-2 whitespace-nowrap">
                          <div className="flex flex-col gap-1">
                            <span>{m.arrivedAt ? format(new Date(m.arrivedAt), "MMM d, yyyy · h:mm a") : "—"}</span>
                            {movementBadge}
                          </div>
                        </td>
                        <td className="border-r border-gray-200 px-3 py-2 text-gray-600">
                          {m.orderName ? (
                            <>
                              {m.orderName}
                              {m.partIndex ? <span className="text-gray-400"> · Part {m.partIndex}</span> : null}
                            </>
                          ) : (
                            <span className="text-gray-400" title={m.reason ?? undefined}>{m.reason ?? "—"}</span>
                          )}
                        </td>
                        <td className={`border-r border-gray-200 px-3 py-2 text-right font-bold tabular-nums ${isNegative ? "text-red-500" : "text-[#001d6e]"}`}>
                          {isNegative ? m.qty : `+${m.qty}`}
                        </td>
                        <td className="px-3 py-2 text-right tabular-nums text-amber-600">
                          {m.extraQty ? (isNegative ? m.extraQty : `+${m.extraQty}`) : <span className="text-gray-300">—</span>}
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          )}
        </DialogContent>
      </Dialog>
    </div>
  );
}
