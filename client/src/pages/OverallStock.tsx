import { useMemo, useRef, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { format } from "date-fns";
import * as XLSX from "xlsx";
import jsPDF from "jspdf";
import autoTable from "jspdf-autotable";
import { FileDown, LayoutList, Boxes, TrendingUp, ChevronDown, ChevronLeft, PackageX, CalendarDays, Loader2, History, X, Plus, ArrowLeftRight, Search, ListFilter } from "lucide-react";
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
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { Input } from "@/components/ui/input";
import PageHeader from "@/components/PageHeader";
import { PlantBadge } from "@/components/PlantBadge";
import { apiRequest } from "@/lib/queryClient";
import { DataTable, DataTableColumnToggle, type DataTableColumn } from "@/components/ui/data-table";
import { StatsBar } from "@/components/ui/stats-bar";
import { TableCard } from "@/components/ui/table-card";
import { CollapsibleSearch } from "@/components/ui/collapsible-search";
import ExchangeProductDialog, { type ExchangeSourceRow } from "@/components/modals/ExchangeProductDialog";
import { ColumnFilterPopoverContent, ColumnHeaderFilterButton } from "@/components/filters/ColumnFilterChip";
import { type FilterableColumn, type FilterCondition, conditionSummary, isConditionEmpty, matchAllConditions } from "@/lib/columnFilters";

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
  // Set only when ONE date applies to everything Expected Qty was computed for — an explicit
  // date filter, a single plant selected, or every active plant coincidentally on the same
  // date. Null when plants are on different active dates — activeDatesByPlant carries each
  // plant's own date in that case instead.
  expectedDate?: string | null;
  expectedTotal?: number | null;
  // Each plant's own currently-active session's order date (lowercased plant key) — used to
  // label the "All plants" tile sensibly when there's no single shared date to show.
  activeDatesByPlant?: Record<string, string>;
};

// One dated entry from the stock_movements ledger for a single (barcode, plant) — powers the
// arrival-history drill-down dialog. type: 'receive' (a scan added stock), 'adjust' (a void or
// a CSV delete-rollback reversed some), 'dispatch' (future — outbound, not written yet),
// 'exchange' (a manual Product Exchange moved stock into or out of this barcode).
type StockMovementRow = {
  id: number;
  qty: number;
  extraQty: number | null;
  type: "receive" | "dispatch" | "adjust" | "exchange";
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

// Solid navy fill, matching the Notion Inventory action buttons. Squared off (rounded-xl)
// for the business-report look — no soft/pill-shaped filter controls.
const FILTER_BTN_CLASS = "h-8 rounded-full border-0 bg-[#001d6e] text-white hover:bg-[#001552] hover:text-white text-xs";

// ─── Component ───────────────────────────────────────────────────────────────

export default function OverallStock() {
  const [search,      setSearch]      = useState("");
  const [pageIndex,   setPageIndex]   = useState(0);
  // Dynamic "+ Filter" conditions the operator adds on demand. Each is one field + a chosen value;
  // an empty value means "added but not yet set" and matches everything until picked. See
  // FILTER_FIELDS below for the available dimensions and how each one matches a row.
  const [activeFilters, setActiveFilters] = useState<{ id: number; field: string; value: string }[]>([]);
  const filterIdRef = useRef(0);
  // Excel-style per-column filters — one condition per column id, triggered from the filter icon
  // on that column's header (or the global "+ Filter" button). A separate, more flexible system
  // from the Plant/Date chips above, which stay special since Date changes what the server query
  // even means. See client/src/lib/columnFilters.ts for the matching engine.
  const [columnConditions, setColumnConditions] = useState<Record<string, FilterCondition>>({});
  const setColumnCondition = (columnId: string, condition: FilterCondition) => {
    setColumnConditions((prev) => ({ ...prev, [columnId]: condition }));
    setPageIndex(0);
  };
  const clearColumnCondition = (columnId: string) => {
    setColumnConditions((prev) => {
      const next = { ...prev };
      delete next[columnId];
      return next;
    });
    setPageIndex(0);
  };

  // The single "+ Filter" entry point — one combined list (Plant, Date, then every generic
  // column), so there's one button instead of two. Picking Plant/Date opens their existing
  // special editors below; picking anything else opens the shared ColumnFilterPopoverContent.
  const [filterPickerOpen, setFilterPickerOpen] = useState(false);
  const [filterPickerKey, setFilterPickerKey] = useState("");
  const [filterPickerSearch, setFilterPickerSearch] = useState("");
  // Date control: "single" shows one editable date input, "range" shows editable From + To.
  const [datePickMode, setDatePickMode] = useState<"single" | "range">("single");
  const [dateOpen, setDateOpen] = useState(false); // controls the Date popover
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

  // Product Exchange — a distinct action from the row-click history drill-down above; opens
  // ExchangeProductDialog with this row locked in as the source ("From") product.
  const [exchangeSource, setExchangeSource] = useState<ExchangeSourceRow | null>(null);

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

  // All configured plants — used to populate the plant switcher/tabs for admins.
  const { data: allPlants = [] } = useQuery<{ id: number; name: string; bgColor?: string; textColor?: string; borderColor?: string }[]>({
    queryKey: ["/api/plants"],
    queryFn: () => apiRequest("GET", "/api/plants", undefined, false, true),
  });

  // The Date "+ Filter" chip's value is either a preset key (today/yday/week/month) or a custom
  // single date encoded as "d:YYYY-MM-DD". Either way it resolves to a from/to window the server
  // uses for ledger mode (received-in-window) instead of current totals. No chip = current totals.
  // The Date filter value is now always explicit dates the operator can edit:
  //   "d:YYYY-MM-DD"                    → a single day (from = to)
  //   "r:YYYY-MM-DD:YYYY-MM-DD"         → a from–to range
  // Presets just compute one of those; there are no stored keyword presets anymore.
  const dateValue = activeFilters.find((f) => f.field === "date")?.value ?? "";
  const { from: fromDate, to: toDate } = useMemo(() => {
    if (dateValue.startsWith("d:")) { const day = dateValue.slice(2); return { from: day, to: day }; }
    if (dateValue.startsWith("r:")) { const [, f, t] = dateValue.split(":"); return { from: f ?? "", to: t ?? "" }; }
    return { from: "", to: "" };
  }, [dateValue]);
  const dateIsRange = dateValue.startsWith("r:");

  // Presets compute an explicit d:/r: value (see encoding above) rather than storing a keyword.
  const isoOf = (x: Date) => format(x, "yyyy-MM-dd");
  const datePresetValue = (key: string): string => {
    const d = new Date();
    if (key === "today") return `d:${isoOf(d)}`;
    if (key === "yday") { const y = new Date(d); y.setDate(y.getDate() - 1); return `d:${isoOf(y)}`; }
    if (key === "week") { const w = new Date(d); w.setDate(w.getDate() - 6); return `r:${isoOf(w)}:${isoOf(d)}`; }
    if (key === "lastweek") { const f = new Date(d); f.setDate(f.getDate() - 13); const t = new Date(d); t.setDate(t.getDate() - 7); return `r:${isoOf(f)}:${isoOf(t)}`; }
    if (key === "month") return `r:${isoOf(new Date(d.getFullYear(), d.getMonth(), 1))}:${isoOf(d)}`;
    if (key === "lastmonth") return `r:${isoOf(new Date(d.getFullYear(), d.getMonth() - 1, 1))}:${isoOf(new Date(d.getFullYear(), d.getMonth(), 0))}`;
    return "";
  };
  const DATE_PRESETS = [
    { value: "today", label: "Today" },
    { value: "yday", label: "Yesterday" },
    { value: "week", label: "This week" },
    { value: "month", label: "This month" },
  ];

  // The plant chosen via a chip, if any — sent to the server to scope the query, same as the
  // date preset below. Extras is a purely client-side "+ Filter" dimension (see filterFields).
  const activePlant = activeFilters.find((f) => f.field === "plant")?.value || "";
  // Plant tabs drive the same plant filter as the "+ Filter" chip — clicking one sets/replaces
  // the plant condition (empty = "All"), so the server query, labels and exports all follow.
  const setPlantTab = (name: string) => {
    setActiveFilters((prev) => {
      const others = prev.filter((f) => f.field !== "plant");
      return name ? [...others, { id: ++filterIdRef.current, field: "plant", value: name }] : others;
    });
    setPageIndex(0);
  };

  // Plant-wise stock. Server enforces access: admins get every plant, others only theirs.
  const stockUrl = buildUrl("/api/scan-sessions/reports/plant-stock", {
    plant: activePlant || undefined,
    from: fromDate || undefined,
    to: toDate || undefined,
  });
  const { data: stockData } = useQuery<PlantStockResponse>({
    queryKey: ["/api/scan-sessions/reports/plant-stock", activePlant, fromDate, toDate],
    queryFn: () => apiRequest("GET", stockUrl, undefined, false, true),
    refetchInterval: 30000,
  });
  // True when a date range is active: the Stock/Extra numbers then mean "received in this
  // window" rather than "total on hand", so the UI labels them differently.
  const dateMode = stockData?.dateMode ?? false;
  // Expected Qty (sum of every CSV's ordered quantity across all parts) — server resolves
  // WHICH date(s) per plant (explicit filter, or each plant's own currently-active session),
  // so this tile can be present (expectedTotal != null) even when expectedDate is null because
  // the plants in view are on different active dates. activeDatesByPlant then carries each
  // plant's own date for a per-plant-aware label.
  const expectedDate = stockData?.expectedDate ?? null;
  const expectedTotal = stockData?.expectedTotal ?? 0;
  const hasExpected = stockData?.expectedTotal != null;
  const activeDatesByPlant = stockData?.activeDatesByPlant ?? {};

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
  // Available "+ Filter" dimensions. options: the values to choose from (derived from the data
  // for category/brand/plant, fixed for stock status); match: does a row satisfy this value?
  const filterFields = useMemo(() => {
    const distinct = (pick: (r: PlantStockRow) => string | null) =>
      Array.from(new Set(rows.map(pick).filter((v): v is string => !!v)))
        .sort()
        .map((v) => ({ value: v, label: v }));
    return [
      { key: "plant", label: "Plant", options: distinct((r) => r.plant), match: (r: PlantStockRow, v: string) => r.plant === v },
      // Date is handled server-side (from/to switch it into ledger mode) with its own editable
      // single-date/range editor below, so it needs no options/match here.
      { key: "date", label: "Date", options: [] as { value: string; label: string }[], match: () => true },
    ];
  }, [rows]);
  const fieldOf = (key: string) => filterFields.find((f) => f.key === key);
  // Human-readable summary for a Plant/Date chip, for the "Filters (N)" list — mirrors what
  // conditionSummary() does for the generic column filters.
  const describeSimpleFilter = (field: string, value: string) => {
    if (field === "plant") return `Plant: ${value}`;
    if (field === "date") {
      const fmt = (s: string) => format(new Date(s), "MMM d, yyyy");
      if (value.startsWith("d:")) return `Date: ${fmt(value.slice(2))}`;
      if (value.startsWith("r:")) { const [, f, t] = value.split(":"); return `Date: ${fmt(f)} – ${fmt(t)}`; }
      return `Date: ${value}`;
    }
    return value;
  };

  // Columns the Excel-style filter system can offer — everything except srNo/plant (plant stays
  // a special server-scoping chip above) and the Exchange action column. Ids match stockColumns'
  // ids exactly, so a header's filter icon can look up its column definition directly. Options
  // are the column's own distinct values, pre-formatted for display (raw values still drive the
  // actual match, so precision/consistency is never lost — only the label is prettified).
  const filterableColumns: FilterableColumn<PlantStockRow>[] = useMemo(() => {
    const textOptions = (pick: (r: PlantStockRow) => string | null) =>
      Array.from(new Set(rows.map(pick).filter((v): v is string => !!v)))
        .sort((a, b) => a.localeCompare(b))
        .map((v) => ({ value: v, label: v }));
    const numberOptions = (pick: (r: PlantStockRow) => number | null | undefined, decimals = 0) =>
      Array.from(new Set(rows.map(pick).filter((v): v is number => v != null)))
        .sort((a, b) => a - b)
        .map((v) => ({ value: String(v), label: decimals ? v.toFixed(decimals) : v.toLocaleString() }));
    const dateOptions = (pick: (r: PlantStockRow) => string | null) => {
      const days = new Set<string>();
      rows.forEach((r) => { const raw = pick(r); if (raw) days.add(format(new Date(raw), "yyyy-MM-dd")); });
      return Array.from(days).sort().reverse().map((d) => ({ value: d, label: format(new Date(d), "MMM d, yyyy") }));
    };
    return [
      { id: "itemName", label: "Item", filterType: "text", options: textOptions((r) => r.itemName), accessor: (r) => r.itemName },
      { id: "barcode", label: "Barcode / SKU", filterType: "text", options: textOptions((r) => r.barcode), accessor: (r) => r.barcode },
      { id: "sapCode", label: "SAP Code", filterType: "text", options: textOptions((r) => r.sapCode), accessor: (r) => r.sapCode },
      { id: "category", label: "Category", filterType: "enum", options: textOptions((r) => r.category), accessor: (r) => r.category },
      { id: "brand", label: "Brand", filterType: "enum", options: textOptions((r) => r.brand), accessor: (r) => r.brand },
      { id: "expected", label: "Expected Qty", filterType: "number", options: numberOptions((r) => r.expectedQty), accessor: (r) => r.expectedQty ?? null },
      { id: "stock", label: "Stock (Boxes)", filterType: "number", options: numberOptions((r) => r.inStock), accessor: (r) => r.inStock },
      { id: "extra", label: "Extra", filterType: "number", options: numberOptions((r) => r.extraQty), accessor: (r) => r.extraQty },
      { id: "pallets", label: "Pallets", filterType: "number", options: numberOptions((r) => r.pallets, 2), accessor: (r) => r.pallets },
      { id: "extraPallets", label: "Extra Pallets", filterType: "number", options: numberOptions((r) => r.extraPallets, 2), accessor: (r) => r.extraPallets },
      { id: "lastUpdated", label: "Last Updated", filterType: "date", options: dateOptions((r) => r.lastArrived), accessor: (r) => r.lastArrived },
    ];
  }, [rows]);

  // Options for the unified "+ Filter" picker's list step — Plant/Date plus every generic
  // column, minus whichever are already active (each dimension can only be added once).
  const filterPickerOptions = useMemo(() => {
    // Plant (tab strip) and Date (its own control before "+ Filter") are intentionally NOT here.
    const dims = filterableColumns.map((c) => ({ key: c.id, label: c.label }));
    const isActive = (key: string) => !!columnConditions[key];
    const q = filterPickerSearch.trim().toLowerCase();
    return dims.filter((d) => !isActive(d.key) && (!q || d.label.toLowerCase().includes(q)));
  }, [filterableColumns, columnConditions, filterPickerSearch]);
  const pickedFilterColumn = filterableColumns.find((c) => c.id === filterPickerKey) ?? null;

  // Renders a column header's label plus its Excel-style filter icon, for stockColumns entries
  // that have a matching entry in filterableColumns (same id).
  const columnHeader = (id: string, label: string) => {
    const col = filterableColumns.find((c) => c.id === id);
    if (!col) return label;
    return (
      <span className="inline-flex items-center gap-1">
        {label}
        <ColumnHeaderFilterButton
          column={col}
          condition={columnConditions[id]}
          onChange={(c) => setColumnCondition(id, c)}
          onRemove={() => clearColumnCondition(id)}
        />
      </span>
    );
  };

  const removeFilter = (id: number) => {
    setActiveFilters((prev) => prev.filter((f) => f.id !== id));
    setPageIndex(0);
  };
  // Add-or-set in one call — used by the unified "+ Filter" picker below, which builds a
  // complete Plant/Date value before it ever becomes a chip (same one-step Apply pattern as the
  // generic column filters), instead of adding an empty chip and editing it in place afterwards.
  const upsertSimpleFilter = (field: string, value: string) => {
    setActiveFilters((prev) => {
      const idx = prev.findIndex((f) => f.field === field);
      if (idx >= 0) { const next = [...prev]; next[idx] = { ...next[idx], value }; return next; }
      return [...prev, { id: ++filterIdRef.current, field, value }];
    });
    setPageIndex(0);
  };

  // A row passes when every set filter matches it (empty-value filters are ignored until picked).
  const matchesActiveFilters = (r: PlantStockRow) =>
    activeFilters.every((af) => !af.value || (fieldOf(af.field)?.match(r, af.value) ?? true));

  const columnConditionList = useMemo(() => Object.values(columnConditions), [columnConditions]);

  const filtered = useMemo(() => {
    return rows.filter((r) => {
      if (!matchesActiveFilters(r)) return false;
      if (!matchAllConditions(r, columnConditionList, filterableColumns)) return false;
      if (!search) return true;
      const q = search.toLowerCase();
      return (
        r.itemName.toLowerCase().includes(q) ||
        (r.barcode ?? "").toLowerCase().includes(q) ||
        (r.sapCode ?? "").toLowerCase().includes(q) ||
        (r.category ?? "").toLowerCase().includes(q) ||
        (r.brand ?? "").toLowerCase().includes(q) ||
        r.plant.toLowerCase().includes(q)
      );
    });
  }, [rows, search, activeFilters, columnConditionList, filterableColumns]);

  // Summary — from REAL stock rows only; empty boxes are never counted as stock.
  const totalStock = filtered.reduce((s, r) => s + r.inStock, 0);
  const totalPallets = filtered.reduce((s, r) => s + (r.pallets ?? 0), 0);
  const totalExtra = filtered.reduce((s, r) => s + r.extraQty, 0);
  const totalExtraPallets = filtered.reduce((s, r) => s + (r.extraPallets ?? 0), 0);
  // Pallet equivalent of the Expected Qty total below — summed over ALL rows (not `filtered`),
  // same scope as expectedTotal itself (Plant/Date-scoped only, unaffected by search/column
  // filters), so the two numbers on that tile always agree with each other.
  const expectedPalletsTotal = rows.reduce(
    (s, r) => s + (r.expectedQty && r.itemsPerPallet ? r.expectedQty / r.itemsPerPallet : 0),
    0,
  );

  // Empty boxes as their OWN distinct rows (one per plant), appended below the stock rows.
  // Never mixed into stock/extra totals — the quantity shows only inside the "Empty Box" badge.
  const emptyBoxRows = useMemo<PlantStockRow[]>(() => {
    // Empty boxes have no category/brand and aren't product stock, so any active dimension filter
    // (once it has a value) necessarily excludes them.
    if (activeFilters.some((f) => f.value)) return [];
    if (columnConditionList.some((c) => !isConditionEmpty(c))) return [];
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
  }, [stockData?.emptyBoxByPlant, search, activeFilters, columnConditionList]);
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
      header: columnHeader("itemName", "Item"),
      hideable: false,
      width: 220,
      sortable: true,
      accessor: (row) => row.itemName,
      totalable: false,
      headerClassName: headerBorder,
      cellClassName: `font-medium text-gray-900 whitespace-normal break-words ${cellBorder}`,
      // Clicking the name toggles an inline arrival-history panel below the row (see the
      // DataTable's renderExpandedRow prop) — same drill-down behavior as the Scan tab, instead
      // of opening a separate dialog.
      render: (row) => {
        if (row.isEmptyBox) {
          return (
            <span className="inline-flex items-center gap-1.5" title={row.emptyBoxCount ? `${row.emptyBoxCount} entr${row.emptyBoxCount === 1 ? "y" : "ies"}` : undefined}>
              <span>Empty Box</span>
              <span className="inline-flex items-center bg-orange-100 px-1.5 py-0.5 text-[9px] font-semibold uppercase tracking-wide text-orange-700">No product</span>
            </span>
          );
        }
        const isOpen = !!detailRow && detailRow.barcode === row.barcode && detailRow.plant === row.plant;
        return (
          <button
            type="button"
            disabled={!row.barcode}
            onClick={() => setDetailRow((cur) => (cur && cur.barcode === row.barcode && cur.plant === row.plant ? null : row))}
            className={`text-left underline decoration-dotted underline-offset-2 hover:text-[#001d6e] hover:decoration-[#001d6e] disabled:no-underline disabled:hover:text-inherit ${isOpen ? "text-[#001d6e] decoration-[#001d6e]" : "decoration-gray-300"}`}
          >
            {row.itemName}
          </button>
        );
      },
    },
    {
      id: "barcode",
      header: columnHeader("barcode", "Barcode / SKU"),
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
      header: columnHeader("sapCode", "SAP Code"),
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
      header: columnHeader("category", "Category"),
      width: 130,
      sortable: true,
      accessor: (row) => row.category,
      totalable: false,
      headerClassName: headerBorder,
      cellClassName: `text-gray-700 ${cellBorder}`,
      render: (row) => row.category ?? dash,
    },
    {
      id: "brand",
      header: columnHeader("brand", "Brand"),
      width: 110,
      sortable: true,
      accessor: (row) => row.brand,
      totalable: false,
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
      totalable: false,
      headerClassName: headerBorder,
      cellClassName: cellBorder,
      render: (row) => (row.plant ? <PlantBadge plant={row.plant} /> : dash),
    },
    {
      id: "expected",
      header: columnHeader("expected", "Expected Qty"),
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
      header: columnHeader("stock", "Stock (Boxes)"),
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
      header: columnHeader("extra", "Extra"),
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
      header: columnHeader("pallets", "Pallets"),
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
      header: columnHeader("extraPallets", "Extra Pallets"),
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
      header: columnHeader("lastUpdated", "Last Updated"),
      width: 120,
      sortable: true,
      accessor: (row) => row.lastArrived,
      totalable: false,
      cellClassName: "text-gray-500 whitespace-nowrap",
      render: (row) => (row.lastArrived ? format(new Date(row.lastArrived), "MMM d, yyyy") : dash),
    },
    ...(isAdmin ? [{
      id: "actions",
      header: "",
      hideable: false,
      totalable: false,
      width: 48,
      align: "center" as const,
      render: (row: PlantStockRow) =>
        !row.isEmptyBox && row.barcode ? (
          <Button
            size="sm"
            variant="ghost"
            className="h-7 w-7 p-0 text-gray-400 hover:text-[#001d6e]"
            title="Exchange this product for another"
            onClick={(e) => {
              e.stopPropagation();
              setExchangeSource({
                barcode: row.barcode!,
                itemName: row.itemName,
                plant: row.plant,
                availableStock: row.inStock,
                itemsPerPallet: row.itemsPerPallet,
              });
            }}
          >
            <ArrowLeftRight className="h-3.5 w-3.5" />
          </Button>
        ) : null,
    } satisfies DataTableColumn<PlantStockRow>] : []),
  ];

  // Inline arrival-history drill-down — rendered as the DataTable's expanded row when an item
  // name is clicked (detailRow set). Same stock_movements ledger the old dialog showed, now
  // shown as a dropdown panel below the row (matching the Scan tab). Sticky-left + width-capped
  // so it stays visible without its own horizontal scroll inside the wide, side-scrolling table.
  const movementsPanel = (
    <div className="sticky left-0 w-full max-w-3xl bg-gray-50 p-3">
      <div className="mb-2 flex flex-wrap items-center gap-x-2 gap-y-0.5 text-[#001d6e]">
        <History className="h-4 w-4 shrink-0" />
        <span className="text-sm font-semibold">{detailRow?.itemName ?? "Item"}</span>
        <span className="font-mono text-xs text-gray-400">{detailRow?.barcode} · {detailRow?.plant}</span>
      </div>
      {movementsLoading ? (
        <div className="flex justify-center py-8">
          <Loader2 className="h-5 w-5 animate-spin text-[#001d6e]" />
        </div>
      ) : (movementsData?.items?.length ?? 0) === 0 ? (
        <p className="py-6 text-center text-sm text-gray-400">No stock movements yet for this item.</p>
      ) : (
        <div className="max-h-[360px] overflow-y-auto border border-gray-300">
          <table className="w-full border-collapse text-xs">
            <thead>
              <tr className="border-b-2 border-gray-300 bg-gray-100 text-left text-gray-600 sticky top-0">
                <th className="border-r border-gray-300 px-3 py-2 font-semibold">Date &amp; Movement</th>
                <th className="border-r border-gray-300 px-3 py-2 font-semibold">Order / CSV</th>
                <th className="border-r border-gray-300 px-3 py-2 text-right font-semibold">Qty</th>
                <th className="px-3 py-2 text-right font-semibold">Extra</th>
              </tr>
            </thead>
            <tbody>
              {movementsData!.items.map((m) => {
                const isNegative = m.qty < 0;
                const movementBadge = m.type === "dispatch"
                  ? <span className="inline-block bg-red-100 px-1.5 py-0.5 text-[10px] font-semibold uppercase tracking-wide text-red-700">Dispatched</span>
                  : m.type === "adjust"
                  ? <span className="inline-block bg-gray-200 px-1.5 py-0.5 text-[10px] font-semibold uppercase tracking-wide text-gray-600">Adjusted</span>
                  : m.type === "exchange"
                  ? <span className="inline-block bg-purple-100 px-1.5 py-0.5 text-[10px] font-semibold uppercase tracking-wide text-purple-700">Exchanged</span>
                  : <span className="inline-block bg-emerald-100 px-1.5 py-0.5 text-[10px] font-semibold uppercase tracking-wide text-emerald-700">Received</span>;
                return (
                  <tr key={m.id} className="border-b border-gray-200 bg-white">
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
    </div>
  );

  return (
    <div className="flex-1 overflow-y-auto p-4 lg:p-6">
      <div className="max-w-7xl mx-auto space-y-4">
        <PageHeader
          icon={LayoutList}
          title="Stock Overview"
          description="Live plant-wise inventory. Stock reflects all boxes received (extras included); Excess and Ordered quantity are reported separately."
        />

        {/* Summary tiles — squared off (rounded-xl, no shadow, stronger divider) to match the
            business-report treatment applied to the table below. */}
        <StatsBar
          className="rounded-xl shadow-none border-gray-300 [&_.divide-x]:divide-gray-300"
          wrapLabels
        
          stats={[
            {
              icon: Boxes,
              tone: "navy",
              value: totalStock.toLocaleString(),
              // In date mode this is what ARRIVED in the window, not what's on hand — say so
              // explicitly, otherwise the number reads as a (much smaller) total stock figure.
              label: `${dateMode ? "Total Stock Received" : "Total Stock (Boxes)"} · ${totalPallets.toFixed(2)} plt${activePlant ? ` · ${activePlant}` : allowedPlants && allowedPlants.length ? ` · ${plantOptions.join(", ")}` : " · All Plants"}`,
            },
            {
              icon: TrendingUp,
              tone: "amber",
              value: totalExtra.toLocaleString(),
              label: `Excess Stock (Over-Order) · ${totalExtraPallets.toFixed(2)} plt`,
            },
            ...(hasExpected ? [{
              icon: CalendarDays,
              tone: "navy" as const,
              value: expectedTotal.toLocaleString(),
              // One shared date (explicit filter, one plant selected, or every active plant
              // coincidentally matches) shows that date. Otherwise (plants on different active
              // dates, e.g. Valsad on the 19th while Indore is still on the 10th) there's no
              // single date to print, so each plant's own active date is listed instead.
              label: expectedDate
                ? `Today's Total Order Qty (${expectedDate}) · ${expectedPalletsTotal.toFixed(2)} plt`
                : `Current Active Orders (${Object.entries(activeDatesByPlant).map(([p, d]) => `${p.toUpperCase()} ${d}`).join(", ")}) · ${expectedPalletsTotal.toFixed(2)} plt`,
            }] : []),
          ]}
        />

        {/* Plant tabs — quick switch to view a single plant's stock (or All). Each plant tab is
            filled with that plant's configured Plant Management colors; the active tab gets a navy
            ring so it's clear which is selected. "All" is solid navy. */}
        {plantOptions.length > 0 && (
          <div className="flex flex-wrap items-center gap-1.5">
            <span className="mr-1 text-[11px] font-semibold uppercase tracking-wide text-gray-400">Plant</span>
            <button
              onClick={() => setPlantTab("")}
              className={
                activePlant === ""
                  ? "rounded-full bg-[#001d6e] px-3.5 py-1.5 text-xs font-semibold text-white ring-2 ring-[#001d6e]/30"
                  : "rounded-full border border-gray-200 bg-white px-3.5 py-1.5 text-xs font-medium text-gray-600 hover:bg-gray-50"
              }
            >
              All
            </button>
            {plantOptions.map((name) => {
              const isSel = activePlant.toUpperCase() === name.toUpperCase();
              const c = allPlants.find((p) => p.name.toUpperCase() === name.toUpperCase());
              return (
                <button
                  key={name}
                  onClick={() => setPlantTab(name)}
                  style={c?.bgColor ? { backgroundColor: c.bgColor, color: c.textColor, borderColor: c.borderColor } : undefined}
                  className={`rounded-full px-3.5 py-1.5 text-xs font-semibold ${
                    c?.bgColor ? "border" : "border border-gray-200 bg-white text-gray-600 hover:bg-gray-50"
                  } ${isSel ? "ring-2 ring-[#001d6e] ring-offset-1" : ""}`}
                >
                  {name}
                </button>
              );
            })}
          </div>
        )}

        {/* Table card — search, sort, every filter (Plant/Date + column filters), column
            visibility, and export all live in this one row now, right under the table title. */}
        <TableCard
          icon={LayoutList}
          title="Stock by Plant"
          subtitle={search ? `${filtered.length} of ${rows.length} rows` : `${rows.length} item · plant rows`}
          className="rounded-xl shadow-none border-gray-300"
          headerActions={
            <>
              <CollapsibleSearch
                value={search}
                onChange={(v) => { setSearch(v); setPageIndex(0); }}
                placeholder="Item, barcode, SAP, category…"
              />

              {/* Standalone Date control — sits BEFORE "+ Filter". Single date or from/to range,
                  both editable; opening it starts in the mode matching the current selection. */}
              <Popover open={dateOpen} onOpenChange={(o) => { setDateOpen(o); if (o) { setDatePickMode(dateIsRange ? "range" : "single"); } }}>
                <PopoverTrigger asChild>
                  <Button
                    size="sm"
                    variant="outline"
                    className={`h-8 gap-1 rounded-md text-xs font-medium ${dateValue ? "border-[#001d6e] bg-[#001d6e]/5 text-[#001d6e]" : "border-gray-300 text-gray-600 hover:bg-gray-50"}`}
                  >
                    <CalendarDays className="h-3.5 w-3.5" />
                    {dateValue ? describeSimpleFilter("date", dateValue).replace("Date: ", "") : "Date"}
                    {dateValue && (
                      <span
                        role="button"
                        aria-label="Clear date"
                        onClick={(e) => { e.stopPropagation(); upsertSimpleFilter("date", ""); }}
                        className="ml-0.5 rounded p-0.5 hover:bg-[#001d6e]/10"
                      >
                        <X className="h-3 w-3" />
                      </span>
                    )}
                  </Button>
                </PopoverTrigger>
                {/* align="end" anchors the box to the button's right edge (opens leftward) and
                    avoidCollisions={false} stops Radix from re-positioning it when the content
                    height changes as you pick options — so the popover stays put. */}
                <PopoverContent align="end" sideOffset={6} avoidCollisions={false} className="w-72">
                  <div className="space-y-3">
                    {/* Single vs range toggle — Single shows one editable date, Range shows two. */}
                    <div className="grid grid-cols-2 gap-1.5">
                      {(["single", "range"] as const).map((m) => (
                        <button
                          key={m}
                          type="button"
                          onClick={() => setDatePickMode(m)}
                          className={`rounded-md border px-2 py-1 text-xs font-medium ${
                            datePickMode === m ? "border-[#001d6e] bg-[#001d6e]/5 text-[#001d6e]" : "border-gray-300 text-gray-600 hover:bg-gray-50"
                          }`}
                        >
                          {m === "single" ? "Single date" : "Date range"}
                        </button>
                      ))}
                    </div>

                    {datePickMode === "single" ? (
                      <div className="space-y-1">
                        <label className="text-[11px] font-semibold uppercase tracking-wide text-gray-500">Date</label>
                        <input
                          type="date"
                          value={fromDate}
                          onChange={(e) => {
                            upsertSimpleFilter("date", e.target.value ? `d:${e.target.value}` : "");
                            // A single date is one complete pick — apply and close right away,
                            // same as tapping a quick-range preset.
                            if (e.target.value) setDateOpen(false);
                          }}
                          className="h-8 w-full rounded-md border border-gray-300 bg-white px-2 text-xs"
                        />
                      </div>
                    ) : (
                      <div className="grid grid-cols-2 gap-2">
                        <div className="space-y-1">
                          <label className="text-[11px] font-semibold uppercase tracking-wide text-gray-500">From</label>
                          <input
                            type="date"
                            value={fromDate}
                            max={toDate || undefined}
                            onChange={(e) => upsertSimpleFilter("date", `r:${e.target.value}:${toDate}`)}
                            className="h-8 w-full rounded-md border border-gray-300 bg-white px-2 text-xs"
                          />
                        </div>
                        <div className="space-y-1">
                          <label className="text-[11px] font-semibold uppercase tracking-wide text-gray-500">To</label>
                          <input
                            type="date"
                            value={toDate}
                            min={fromDate || undefined}
                            onChange={(e) => upsertSimpleFilter("date", `r:${fromDate}:${e.target.value}`)}
                            className="h-8 w-full rounded-md border border-gray-300 bg-white px-2 text-xs"
                          />
                        </div>
                      </div>
                    )}

                    <div className="space-y-1">
                      <label className="text-[11px] font-semibold uppercase tracking-wide text-gray-500">Quick ranges</label>
                      <div className="grid grid-cols-2 gap-1.5">
                        {DATE_PRESETS.map((o) => (
                          <button
                            key={o.value}
                            type="button"
                            onClick={() => {
                              const v = datePresetValue(o.value);
                              upsertSimpleFilter("date", v);
                              setDatePickMode(v.startsWith("r:") ? "range" : "single");
                              setDateOpen(false);
                            }}
                            className="rounded-md border border-gray-300 px-2 py-1 text-xs text-gray-700 hover:border-[#001d6e]/40 hover:bg-[#001d6e]/5 hover:text-[#001d6e]"
                          >
                            {o.label}
                          </button>
                        ))}
                      </div>
                    </div>

                    {/* Every pick above applies immediately (no Done button) — this just clears it. */}
                    {dateValue && (
                      <div className="flex items-center justify-end pt-1">
                        <button
                          type="button"
                          onClick={() => { upsertSimpleFilter("date", ""); setDateOpen(false); }}
                          className="text-[11px] text-red-500 hover:underline"
                        >
                          Clear date
                        </button>
                      </div>
                    )}
                  </div>
                </PopoverContent>
              </Popover>

              {/* One unified "+ Filter" — every generic column in the same searchable list.
                  (Plant is the tab strip; Date is its own control above.) */}
              <Popover
                open={filterPickerOpen}
                onOpenChange={(open) => {
                  setFilterPickerOpen(open);
                  if (!open) { setFilterPickerKey(""); setFilterPickerSearch(""); }
                }}
              >
                <PopoverTrigger asChild>
                  <Button
                    size="sm"
                    variant="outline"
                    className="h-8 gap-1 rounded-md border-dashed border-[#001d6e]/40 bg-white text-xs font-medium text-[#001d6e] hover:bg-[#001d6e]/5 hover:text-[#001d6e]"
                  >
                    <Plus className="h-3.5 w-3.5" /> Filter
                  </Button>
                </PopoverTrigger>
                <PopoverContent align="start" className="w-64">
                  {filterPickerKey === "" ? (
                    <div className="space-y-1.5">
                      <div className="relative">
                        <Search className="absolute left-2 top-2 h-3.5 w-3.5 text-gray-400" />
                        <Input
                          className="h-8 pl-7 text-xs"
                          placeholder="Find a filter…"
                          value={filterPickerSearch}
                          onChange={(e) => setFilterPickerSearch(e.target.value)}
                          autoFocus
                        />
                      </div>
                      <div className="max-h-56 overflow-y-auto">
                        {filterPickerOptions.length === 0 ? (
                          <div className="px-2 py-1.5 text-xs text-gray-400">
                            {filterPickerSearch ? "No matches" : "All filters added"}
                          </div>
                        ) : (
                          filterPickerOptions.map((d) => (
                            <button
                              key={d.key}
                              type="button"
                              onClick={() => {
                                // Opening Date: start in the mode matching the current selection.
                                if (d.key === "date") setDatePickMode(dateIsRange ? "range" : "single");
                                setFilterPickerKey(d.key);
                              }}
                              className="block w-full rounded px-2 py-1.5 text-left text-xs text-gray-700 hover:bg-[#001d6e]/5 hover:text-[#001d6e]"
                            >
                              {d.label}
                            </button>
                          ))
                        )}
                      </div>
                    </div>
                  ) : filterPickerKey === "plant" ? (
                    <div className="space-y-3">
                      <button
                        type="button"
                        onClick={() => setFilterPickerKey("")}
                        className="flex items-center gap-1 text-[11px] text-gray-400 hover:text-gray-600"
                      >
                        <ChevronLeft className="h-3 w-3" /> Back
                      </button>
                      <div className="space-y-1">
                        <label className="text-[11px] font-semibold uppercase tracking-wide text-gray-500">Plant</label>
                        <Select
                          onValueChange={(v) => {
                            upsertSimpleFilter("plant", v);
                            setFilterPickerOpen(false);
                            setFilterPickerKey("");
                          }}
                        >
                          <SelectTrigger className="h-8 text-xs"><SelectValue placeholder="Choose a plant…" /></SelectTrigger>
                          <SelectContent>
                            {plantOptions.map((p) => <SelectItem key={p} value={p}>{p}</SelectItem>)}
                          </SelectContent>
                        </Select>
                      </div>
                    </div>
                  ) : pickedFilterColumn ? (
                    <div className="space-y-2">
                      <button
                        type="button"
                        onClick={() => setFilterPickerKey("")}
                        className="flex items-center gap-1 text-[11px] text-gray-400 hover:text-gray-600"
                      >
                        <ChevronLeft className="h-3 w-3" /> Back
                      </button>
                      <ColumnFilterPopoverContent
                        column={pickedFilterColumn}
                        onApply={(c) => {
                          setColumnCondition(pickedFilterColumn.id, c);
                          setFilterPickerOpen(false);
                          setFilterPickerKey("");
                        }}
                        onCancel={() => setFilterPickerKey("")}
                      />
                    </div>
                  ) : null}
                </PopoverContent>
              </Popover>

              {/* Plant is excluded — it's owned by the plant tabs, so Clear all neither counts it
                  nor clears it (that would silently switch the tab back to All). */}
              {(activeFilters.some((f) => f.field !== "plant" && f.field !== "date") || Object.keys(columnConditions).length > 0) && (
                <Button
                  size="sm"
                  variant="ghost"
                  className="h-8 px-2 text-xs text-gray-500 hover:text-gray-900"
                  onClick={() => { setActiveFilters((prev) => prev.filter((f) => f.field === "plant" || f.field === "date")); setColumnConditions({}); setPageIndex(0); }}
                >
                  Clear all
                </Button>
              )}

              {/* Every active filter (Plant/Date + column filters) in one list, in case the
                  individual chips scroll out of view or there are too many to scan at a glance. */}
              {(activeFilters.filter((f) => f.value && f.field !== "plant" && f.field !== "date").length + Object.keys(columnConditions).length) > 0 && (
                <Popover>
                  <PopoverTrigger asChild>
                    <Button size="sm" variant="outline" className={FILTER_BTN_CLASS}>
                      <ListFilter className="h-3.5 w-3.5 mr-1" />
                      Filters ({activeFilters.filter((f) => f.value && f.field !== "plant" && f.field !== "date").length + Object.keys(columnConditions).length})
                    </Button>
                  </PopoverTrigger>
                  <PopoverContent align="start" className="w-72">
                    <div className="space-y-0.5">
                      <p className="mb-1 text-[11px] font-semibold uppercase tracking-wide text-gray-500">Active filters</p>
                      {activeFilters.filter((f) => f.value && f.field !== "plant" && f.field !== "date").map((f) => (
                        <div key={f.id} className="flex items-center justify-between gap-2 rounded px-1.5 py-1 text-xs hover:bg-gray-50">
                          <span className="text-gray-700">{describeSimpleFilter(f.field, f.value)}</span>
                          <button type="button" onClick={() => removeFilter(f.id)} className="text-gray-400 hover:text-red-500" aria-label="Remove filter">
                            <X className="h-3.5 w-3.5" />
                          </button>
                        </div>
                      ))}
                      {Object.entries(columnConditions).map(([columnId, condition]) => (
                        <div key={columnId} className="flex items-center justify-between gap-2 rounded px-1.5 py-1 text-xs hover:bg-gray-50">
                          <span className="text-gray-700">{conditionSummary(condition, filterableColumns)}</span>
                          <button type="button" onClick={() => clearColumnCondition(columnId)} className="text-gray-400 hover:text-red-500" aria-label="Remove filter">
                            <X className="h-3.5 w-3.5" />
                          </button>
                        </div>
                      ))}
                    </div>
                  </PopoverContent>
                </Popover>
              )}

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
                          const suffix = `${activePlant ? "-" + activePlant : ""}-${format(new Date(), "yyyy-MM-dd")}`;
                          if (fmt === "CSV")   downloadCsv(`overall-stock${suffix}.csv`, exp);
                          if (fmt === "Excel") downloadExcel(`overall-stock${suffix}.xlsx`, exp);
                          if (fmt === "PDF") {
                            const plantScope = activePlant || (allowedPlants && allowedPlants.length ? plantOptions.join(", ") : "All Plants");
                            downloadPdf(`overall-stock${suffix}.pdf`, exp, { title: "Stock Overview Report", scope: plantScope });
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
        >
          <DataTable<PlantStockRow>
            className="space-y-0"
            containerClassName="rounded-none border-0"
            columns={stockColumns}
            data={displayRows}
            getRowId={(row) => `${row.isEmptyBox ? "EB" : row.barcode}-${row.plant}`}
            rowClassName={(row) => (row.isEmptyBox ? "bg-orange-50/40" : undefined)}
            renderExpandedRow={() => movementsPanel}
            isRowExpandable={(row) => !row.isEmptyBox && !!row.barcode}
            expandedRowId={detailRow ? `${detailRow.isEmptyBox ? "EB" : detailRow.barcode}-${detailRow.plant}` : null}
            emptyState={`No stock yet${activePlant ? ` for ${activePlant}` : ""}. Stock appears here once an order is completed.`}
            noResultsState="No stock rows match your search."
            hasActiveFilters={!!search || activeFilters.length > 0 || Object.keys(columnConditions).length > 0}
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

      <ExchangeProductDialog source={exchangeSource} onClose={() => setExchangeSource(null)} />
    </div>
  );
}
