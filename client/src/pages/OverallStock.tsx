import { Fragment, useEffect, useMemo, useRef, useState } from "react";
import { useQuery, useMutation } from "@tanstack/react-query";
import { format } from "date-fns";
import * as XLSX from "xlsx";
import jsPDF from "jspdf";
import autoTable from "jspdf-autotable";
import { FileDown, LayoutList, Boxes, TrendingUp, ChevronDown, ChevronLeft, ChevronRight, PackageX, CalendarDays, Loader2, History, X, Plus, ArrowLeftRight, Search, ListFilter, ShoppingCart, Scale, Pencil, Trash2, RotateCw } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import {
  Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle,
} from "@/components/ui/dialog";
import { useToast } from "@/hooks/use-toast";
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
import { apiRequest, queryClient } from "@/lib/queryClient";
import { useAuth } from "@/hooks/use-auth";
import { hasPageWriteAccess } from "@/lib/permissions";
import { DataTable, DataTableColumnToggle, buildPageList, type DataTableColumn } from "@/components/ui/data-table";
import { StatsBar } from "@/components/ui/stats-bar";
import { TableCard } from "@/components/ui/table-card";
import { CollapsibleSearch } from "@/components/ui/collapsible-search";
import ExchangeProductDialog, { type ExchangeSourceRow } from "@/components/modals/ExchangeProductDialog";
import { ColumnFilterPopoverContent, ColumnHeaderFilterButton } from "@/components/filters/ColumnFilterChip";
import { type FilterableColumn, type FilterCondition, conditionSummary, isConditionEmpty, matchAllConditions } from "@/lib/columnFilters";
import { SectionSkeleton } from "@/components/ui/loading-skeletons";

// ─── Types ───────────────────────────────────────────────────────────────────

// One row per (barcode, plant) for the selected period. inStock = Purchase in the period (every
// physical box in, extras included); extraQty is the extra portion of it, shown separately.
type PlantStockRow = {
  // Product Master's own "New Sr." (COALESCE(p.new_sr, p_bc.new_sr) server-side) — not a
  // row-position counter, so it's null whenever the row has no Product Master match at all.
  srNo: string | null;
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
  // Sum of every CSV's ordered quantity for this barcode+plant — scoped down to one date's
  // orders when a date filter is picked (see expectedDate below); otherwise summed from the
  // configured Sales Tracking Start date onward (see salesTrackingStart below, Settings > Data
  // Management), the same floor Sale Qty uses. null when Expected Qty isn't populated at all.
  expectedQty?: number | null;
  expectedPallets?: number | null;
  // Expected Sale — proforma slip quantity for this barcode+plant in the period (planned, not what
  // was loaded). null when none.
  expectedSaleQty?: number | null;
  expectedSalePallets?: number | null;
  // The stock ledger for the period (see /reports/plant-stock): openingStock = on hand at the start,
  // inStock above = Purchase during it, saleQty = actually loaded (dated by the proforma slip's
  // order date), closingStock = Opening + Purchase + Adjust − Sale (Settings-wide clears sit in
  // systemQty and are deliberately outside it). With no date picked the period runs from
  // Settings > Stock Tracking Start, so Closing is the live warehouse count.
  saleQty?: number | null;
  // Signed corrections in the period — Clear Stock, a voided scan's or a deleted CSV's rollback,
  // a manual Adjust, an exchange. Kept out of Purchase (which is what physically came in) and
  // counted towards Closing: Closing = Opening + Purchase + Adjust − Sale.
  adjustQty?: number | null;
  // Settings-wide corrections (Clear Stock) for this item in the period. Its own figure so one
  // clear across the whole catalogue can't bury the corrections an operator actually made — and
  // its own column, hidden until asked for.
  systemQty?: number | null;
  // Stock moved between plants by an Unloading batch that has a separate purchase plant: In at the
  // plant the stock was added to, Out at the plant the purchase was booked at. Counted in Closing.
  transferIn?: number | null;
  transferOut?: number | null;
  salePallets?: number | null;
  openingStock?: number | null;
  openingPallets?: number | null;
  closingStock?: number | null;
  closingPallets?: number | null;
  // Live on-hand stock right now, independent of the period — what Exchange can take from.
  liveStock?: number;
  // Set only on a synthetic row built by combining this item's per-plant rows together (see
  // groupedByState) — every plant folded into it, so the Details/History drill-down knows which
  // plants to query instead of just the one plant a normal row carries. Absent (or length <= 1)
  // means "a real, single-plant row" — Edit/Delete/Exchange (which need one exact target) stay
  // enabled only in that case.
  combinedPlants?: string[];
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
  // Set only when an explicit date filter is applied. Null in the default "all dates" mode,
  // where expectedTotal is summed from salesTrackingStart onward instead of one date's orders.
  expectedDate?: string | null;
  expectedTotal?: number | null;
  // Sale = actually loaded; Expected Sale = proforma slips. Both over the same period.
  saleDate?: string | null;
  saleTotal?: number | null;
  expectedSaleTotal?: number | null;
  // The ledger's period: start (the date/range start, or Stock Tracking Start) and end (null = today).
  periodStart?: string | null;
  periodEnd?: string | null;
  // The "all dates" floor BOTH Expected Qty and Sale Qty sum from — admin-editable on Settings
  // (Sales Tracking Start), sent along so the "since ..." labels below always show the real
  // configured date instead of a hardcoded one.
  salesTrackingStart?: string | null;
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
  // Tagged on client-side after fetching — the endpoint itself is scoped to one plant per call
  // (see combinedScanningHistory), so the response doesn't carry it, but a multi-plant state
  // view needs to know which plant each merged entry came from.
  plant?: string;
};

// One dated entry from unload_scan_events for a single (barcode, plant) — Unloading's own
// arrival history, kept as an entirely separate shape/query from StockMovementRow above rather
// than folded into it (see /reports/unloading-history's own comment for why).
type UnloadingHistoryRow = {
  id: number;
  qty: number;
  pallets: number | null;
  looseQty: number | null;
  isExtra: boolean;
  voided: boolean;
  voidReason: string | null;
  scannedAt: string;
  scannedByName: string | null;
  stv: string | null;
  vehicleNumber: string | null;
  orderDate: string | null;
  partIndex: number | null;
  plant?: string;
};

// One dated entry from loading_scan_events for a single (barcode, plant) — Loading's own
// dispatch history, same separate shape/query treatment as UnloadingHistoryRow above.
type LoadingHistoryRow = {
  id: number;
  qty: number;
  pallets: number | null;
  looseQty: number | null;
  isExtra: boolean;
  voided: boolean;
  voidReason: string | null;
  scannedAt: string;
  scannedByName: string | null;
  // The Loading Items table's +/- correction ("Loading Adjust"); qty keeps its sign (+ loaded more).
  isAdjust?: boolean;
  orderNumber: string | null;
  orderDate: string | null;
  plant?: string;
};

// One adjustment for a single (barcode, plant) — /reports/adjust-history. stockQty is the change to
// stock (+ added / − removed) for both kinds.
type AdjustHistoryRow = {
  // manual = this page's Adjust dialog, loading = the Loading Items table's +/-, scan = an Order
  // Scan CSV edit, correction = a stock correction belonging to no tab (Clear Stock, exchange).
  kind: "manual" | "loading" | "scan" | "correction";
  id: number;
  stockQty: number;
  loadedQty: number | null;
  reason: string | null;
  orderNumber: string | null;
  orderDate: string | null;
  at: string;
  byName: string | null;
  voided: boolean;
  plant?: string;
};

// Per-plant "how much of this item's stock came from Scanning (Order Import) vs. Unloading" —
// contribution totals, not an attempt to attribute the current balance to a source (see
// /reports/source-breakdown's own comment).
type SourceBreakdownRow = { plant: string; scanningQty: number; unloadingQty: number };

// One row per party for an item's Details drill-down "Parties" tab — quantity already summed
// across every one of that party's proforma slips for this barcode (see /reports/party-breakdown's
// own comment), so a party never shows up more than once. `orders` is the dropdown detail behind
// that total — one entry per proforma slip (order number + order date) that contributed to it.
type PartyBreakdownRow = {
  partyName: string; qty: number; orderCount: number;
  orders: { orderNumber: string; orderDate: string | null; qty: number }[];
};

// ─── Column config ────────────────────────────────────────────────────────────

const ALL_COLUMNS = [
  { key: "barcode",     label: "Barcode / SKU" },
  { key: "sapCode",     label: "SAP Code" },
  { key: "category",    label: "Category" },
  { key: "brand",       label: "Brand" },
  { key: "expected",    label: "Expected Purchase" },
  { key: "opening",      label: "Opening" },
  { key: "purchase",     label: "Purchase (includes Extra)" },
  { key: "extra",        label: "Extra" },
  { key: "adjust",       label: "Adjust" },
  { key: "transferIn",   label: "Transfer In (from another plant)" },
  { key: "transferOut",  label: "Transfer Out (to another plant)" },
  { key: "totalIn",      label: "Total Stock (Opening + Purchase + Adjust + Transfer)" },
  { key: "expectedSale", label: "Expected Sale (proforma)" },
  { key: "sale",         label: "Sale (loaded)" },
  { key: "closing",      label: "Closing" },
] as const;


// ─── Helpers ─────────────────────────────────────────────────────────────────

// Adds two possibly-null quantities the way groupedByState needs to: stays null only when
// BOTH sides are null (genuinely no data anywhere), otherwise treats a null side as 0 so one
// plant actually having a value isn't masked by another plant simply not populating it.
function sumNullable(a: number | null | undefined, b: number | null | undefined): number | null {
  if (a == null && b == null) return null;
  return (a ?? 0) + (b ?? 0);
}

function normalizedText(value: unknown): string {
  return typeof value === "string" ? value.toLowerCase() : "";
}

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
  // Right-align every numeric/quantity column — matches exportRows' header order: #, Item,
  // Barcode, SAP Code, HSN Code, Category, Brand, Plant (indices 0-7, "#" excepted), then every
  // quantity column from index 8 onward (Expected/Opening/Purchase/Extra/Expected Sale/Sale/Closing) through to the end.
  const columnStyles: Record<number, { halign: "right" }> = { 0: { halign: "right" } };
  for (let i = 8; i < header.length; i++) columnStyles[i] = { halign: "right" };

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

// Filters survive leaving the page and coming back — they live in component state, so navigating
// away used to drop whatever the table had been narrowed to. sessionStorage rather than
// localStorage: a filter is working context for the current sitting, not a preference that should
// still be applied when the app is opened fresh tomorrow.
const STOCK_FILTERS_KEY = "overallStock:filters";

type SavedStockFilters = {
  search?: string;
  activeFilters?: { id: number; field: string; value: string }[];
  conditions?: Record<string, FilterCondition>;
};

function readSavedStockFilters(): SavedStockFilters {
  try {
    return JSON.parse(sessionStorage.getItem(STOCK_FILTERS_KEY) ?? "{}") as SavedStockFilters;
  } catch {
    // Corrupt or unreadable (private-mode storage throws) — start clean rather than break the page.
    return {};
  }
}

// Solid navy fill, matching the Product Master action buttons. Squared off (rounded-xl)
// for the business-report look — no soft/pill-shaped filter controls.
const FILTER_BTN_CLASS = "h-7 rounded-full border-0 bg-[#001d6e] px-2.5 text-[11px] text-white hover:bg-[#001552] hover:text-white sm:h-8 sm:px-3 sm:text-xs";

// ─── Component ───────────────────────────────────────────────────────────────

export default function OverallStock() {
  const { user } = useAuth();
  const isAdminOrSuper = ["admin", "super-admin"].includes(((user as any)?.role ?? "").toLowerCase());
  // Matches the server's actual rule (POST /reports/exchange-stock: requirePageWrite('overall-stock')).
  const canExchange = isAdminOrSuper || hasPageWriteAccess("overall-stock");
  // Seeded from whatever was left applied last time — see STOCK_FILTERS_KEY.
  const [search,      setSearch]      = useState(() => readSavedStockFilters().search ?? "");
  const [pageIndex,   setPageIndex]   = useState(0);
  // Dynamic "+ Filter" conditions the operator adds on demand. Each is one field + a chosen value;
  // an empty value means "added but not yet set" and matches everything until picked. See
  // FILTER_FIELDS below for the available dimensions and how each one matches a row.
  const [activeFilters, setActiveFilters] = useState<{ id: number; field: string; value: string }[]>(
    () => readSavedStockFilters().activeFilters ?? [],
  );
  // Start the id counter past anything restored, so a newly added filter can't collide with one
  // that came back from storage (ids are the React keys and the remove-by-id handle).
  const filterIdRef = useRef(
    (readSavedStockFilters().activeFilters ?? []).reduce((max, f) => Math.max(max, f.id), 0),
  );
  // Excel-style per-column filters — one condition per column id, triggered from the filter icon
  // on that column's header (or the global "+ Filter" button). A separate, more flexible system
  // from the Plant/Date chips above, which stay special since Date changes what the server query
  // even means. See client/src/lib/columnFilters.ts for the matching engine.
  const [columnConditions, setColumnConditions] = useState<Record<string, FilterCondition>>(
    () => readSavedStockFilters().conditions ?? {},
  );
  const setColumnCondition = (columnId: string, condition: FilterCondition) => {
    setColumnConditions((prev) => ({ ...prev, [columnId]: condition }));
  };
  const clearColumnCondition = (columnId: string) => {
    setColumnConditions((prev) => {
      const next = { ...prev };
      delete next[columnId];
      return next;
    });
  };

  // The single "+ Filter" entry point — one combined list (Plant, Date, then every generic
  // column), so there's one button instead of two. Picking Plant/Date opens their existing
  // special editors below; picking anything else opens the shared ColumnFilterPopoverContent.
  const [filterPickerOpen, setFilterPickerOpen] = useState(false);
  const [filterPickerKey, setFilterPickerKey] = useState("");
  const [filterPickerSearch, setFilterPickerSearch] = useState("");
  // Date control: "single" shows one editable date input, "range" shows editable From + To.
  // The item whose corrections are being read, if any — set by clicking an Adjust figure.
  // combinedPlants carries every underlying plant when opened from a merged All/State row (whose
  // own `plant` is a fake placeholder like "ALL" or a state code, never a real plant) — without
  // it, a merged row's OTHER plants' entries (e.g. a stray duplicate sitting under a different
  // plant than the one this row happens to be labelled with) would never show up here at all.
  const [adjustHistoryTarget, setAdjustHistoryTarget] = useState<{ barcode: string; plant: string; itemName: string; combinedPlants?: string[] } | null>(null);
  // Which item row opened the Transfer In / Out detail (the moves between plants behind the figure).
  const [transferTarget, setTransferTarget] = useState<{ barcode: string; plant: string; itemName: string; combinedPlants?: string[] } | null>(null);
  // View chip "Moved Stock": only the rows where stock moved in from or out to another plant.
  const [movedOnly, setMovedOnly] = useState(false);
  // The one Adjust ledger row about to be deleted from the Adjustments dialog — a stray or
  // duplicate entry (e.g. a stale "Opening stock import" row) distorting the Opening/Adjust/
  // Total Stock figures. Deleting it never touches live stock, only the ledger it's computed
  // from — see the server's own comment on DELETE /plant-stock/movements/:id.
  const [deleteMovementTarget, setDeleteMovementTarget] = useState<StockAdjustment | null>(null);
  const [datePickMode, setDatePickMode] = useState<"single" | "range">("single");
  const [dateOpen, setDateOpen] = useState(false);
  // The calendar half opens separately from the quick-ranges half — two buttons, two
  // popovers, one shared date value.
  const [dateCalOpen, setDateCalOpen] = useState(false); // controls the Date popover
  // Column visibility/order are real preferences, not working context for one sitting — saved to
  // localStorage (not sessionStorage) so choosing which columns to see survives closing the
  // browser/logging out, and only changes again when the user actually touches it here.
  const [visibleColumnIds, setVisibleColumnIds] = useState<Set<string>>(() => {
    // "system" (Settings-wide clears) is deliberately NOT in here: the Columns menu offers it,
    // but a bulk clear isn't day-to-day reading and Closing counts it either way.
    const defaults = new Set(["srNo", "itemName", ...ALL_COLUMNS.map((c) => c.key), "plant"]);
    try {
      const raw = localStorage.getItem("overallStock:visibleColumnIds");
      const parsed = raw ? JSON.parse(raw) : null;
      if (!Array.isArray(parsed)) return defaults;
      const saved = new Set<string>(parsed);
      // Columns introduced by the stock ledger: a layout saved before them would otherwise keep
      // them hidden. Expected Sale shows wherever Sale did; Closing replaces Remain.
      if (saved.has("sale")) saved.add("expectedSale");
      if (saved.has("remain")) { saved.add("closing"); saved.add("opening"); }
      // Adjust and Total In belong beside Purchase for everyone, including people whose saved
      // layout predates them — without this they are built but never shown.
      if (saved.has("purchase")) { saved.add("adjust"); saved.add("totalIn"); }
      // The Transfer columns are new: shown once for a layout saved before them, then left to the user.
      try {
        if (!localStorage.getItem("overallStock:transferColsAdded")) {
          saved.add("transferIn"); saved.add("transferOut");
          localStorage.setItem("overallStock:transferColsAdded", "1");
        }
      } catch { /* private mode */ }
      return saved;
    } catch {
      return defaults;
    }
  });
  useEffect(() => {
    try { localStorage.setItem("overallStock:visibleColumnIds", JSON.stringify(Array.from(visibleColumnIds))); } catch { /* storage unavailable */ }
  }, [visibleColumnIds]);

  // Column order, remembered per page. An empty array means "declared order", which is also what
  // Reset order restores.
  const [columnOrder, setColumnOrder] = useState<string[]>(() => {
    try {
      const raw = localStorage.getItem("overallStock:columnOrder");
      const parsed = raw ? JSON.parse(raw) : [];
      return Array.isArray(parsed) ? parsed : [];
    } catch {
      return [];
    }
  });
  useEffect(() => {
    try { localStorage.setItem("overallStock:columnOrder", JSON.stringify(columnOrder)); } catch { /* storage unavailable */ }
  }, [columnOrder]);


  // Arrival-history / details drill-down — clicking a row opens a three-tab panel below it:
  // "Details" (per-plant Stock + Scanning-vs-Unloading breakdown), "Parties" (which parties
  // ordered this item and how much, merged across every one of their orders), and "History"
  // (the dated ledger, itself split into a Scanning list and a separate Unloading list — see the
  // History tab's own comment). A normal row has one plant; a state-combined row (see
  // groupedByState) carries every plant folded into it via combinedPlants, so all the queries
  // below run once per plant and merge — same shape either way, just one plant in the list
  // instead of several.
  const [detailRow, setDetailRow] = useState<PlantStockRow | null>(null);
  const [detailTab, setDetailTab] = useState<"details" | "parties" | "history">("details");
  // Which party rows are expanded in the Parties tab, showing their own per-order dropdown
  // (proforma slip number + order date). Reset whenever a different item is opened.
  const [expandedParties, setExpandedParties] = useState<Set<string>>(new Set());
  const [historySource, setHistorySource] = useState<"scanning" | "unloading" | "loading" | "adjust">("scanning");
  const detailPlants = detailRow?.combinedPlants?.length ? detailRow.combinedPlants : (detailRow ? [detailRow.plant] : []);

  const { data: scanningHistoryData, isLoading: scanningHistoryLoading } = useQuery<{ items: StockMovementRow[] }>({
    queryKey: ["/api/scan-sessions/reports/stock-movements", detailRow?.barcode, detailPlants.join(",")],
    queryFn: async () => {
      const perPlant = await Promise.all(detailPlants.map((plant) =>
        apiRequest("GET", buildUrl("/api/scan-sessions/reports/stock-movements", { barcode: detailRow!.barcode!, plant }), undefined, false, true)
          .then((data: { items: StockMovementRow[] }) => data.items.map((it) => ({ ...it, plant })))
      ));
      return { items: perPlant.flat().sort((a, b) => +new Date(b.arrivedAt) - +new Date(a.arrivedAt)) };
    },
    enabled: !!detailRow?.barcode && detailPlants.length > 0,
  });

  const { data: unloadingHistoryData, isLoading: unloadingHistoryLoading } = useQuery<{ items: UnloadingHistoryRow[] }>({
    queryKey: ["/api/scan-sessions/reports/unloading-history", detailRow?.barcode, detailPlants.join(",")],
    queryFn: async () => {
      const perPlant = await Promise.all(detailPlants.map((plant) =>
        apiRequest("GET", buildUrl("/api/scan-sessions/reports/unloading-history", { barcode: detailRow!.barcode!, plant }), undefined, false, true)
          .then((data: { items: UnloadingHistoryRow[] }) => data.items.map((it) => ({ ...it, plant })))
      ));
      return { items: perPlant.flat().sort((a, b) => +new Date(b.scannedAt) - +new Date(a.scannedAt)) };
    },
    enabled: !!detailRow?.barcode && detailPlants.length > 0,
  });

  const { data: loadingHistoryData, isLoading: loadingHistoryLoading } = useQuery<{ items: LoadingHistoryRow[] }>({
    queryKey: ["/api/scan-sessions/reports/loading-history", detailRow?.barcode, detailPlants.join(",")],
    queryFn: async () => {
      const perPlant = await Promise.all(detailPlants.map((plant) =>
        apiRequest("GET", buildUrl("/api/scan-sessions/reports/loading-history", { barcode: detailRow!.barcode!, plant }), undefined, false, true)
          .then((data: { items: LoadingHistoryRow[] }) => data.items.map((it) => ({ ...it, plant })))
      ));
      return { items: perPlant.flat().sort((a, b) => +new Date(b.scannedAt) - +new Date(a.scannedAt)) };
    },
    enabled: !!detailRow?.barcode && detailPlants.length > 0,
  });

  const { data: adjustHistoryData, isLoading: adjustHistoryLoading } = useQuery<{ items: AdjustHistoryRow[] }>({
    queryKey: ["/api/scan-sessions/reports/adjust-history", detailRow?.barcode, detailPlants.join(",")],
    queryFn: async () => {
      const perPlant = await Promise.all(detailPlants.map((plant) =>
        apiRequest("GET", buildUrl("/api/scan-sessions/reports/adjust-history", { barcode: detailRow!.barcode!, plant }), undefined, false, true)
          .then((data: { items: AdjustHistoryRow[] }) => data.items.map((it) => ({ ...it, plant })))
      ));
      return { items: perPlant.flat().sort((a, b) => +new Date(b.at) - +new Date(a.at)) };
    },
    enabled: !!detailRow?.barcode && detailPlants.length > 0 && historySource === "adjust",
  });

  const { data: sourceBreakdownData, isLoading: sourceBreakdownLoading } = useQuery<{ breakdown: SourceBreakdownRow[] }>({
    queryKey: ["/api/scan-sessions/reports/source-breakdown", detailRow?.barcode, detailPlants.join(",")],
    queryFn: () =>
      apiRequest(
        "GET",
        buildUrl("/api/scan-sessions/reports/source-breakdown", { barcode: detailRow!.barcode!, plants: detailPlants.join(",") }),
        undefined, false, true,
      ),
    enabled: !!detailRow?.barcode && detailPlants.length > 0,
  });

  const { data: partyBreakdownData, isLoading: partyBreakdownLoading } = useQuery<{ parties: PartyBreakdownRow[] }>({
    queryKey: ["/api/scan-sessions/reports/party-breakdown", detailRow?.barcode, detailPlants.join(",")],
    queryFn: () =>
      apiRequest(
        "GET",
        buildUrl("/api/scan-sessions/reports/party-breakdown", { barcode: detailRow!.barcode!, plants: detailPlants.join(",") }),
        undefined, false, true,
      ),
    enabled: !!detailRow?.barcode && detailPlants.length > 0,
  });

  // Product Exchange — a distinct action from the row-click history drill-down above; opens
  // ExchangeProductDialog with this row locked in as the source ("From") product.
  const [exchangeSource, setExchangeSource] = useState<ExchangeSourceRow | null>(null);

  const { toast } = useToast();

  // Edit (set this item's stock to a new total — logs one stock_movements 'adjust' row for the
  // delta) and Delete (remove this barcode+plant entirely, including its receiving/loading/
  // unloading scan history — the surgical, one-item counterpart to Settings > Clear Stock) —
  // both admin-only (server/routes/plant-stock-admin.ts).
  const [editTarget, setEditTarget] = useState<PlantStockRow | null>(null);
  // The plant being adjusted, chosen inside the dialog (see editPlantOptions).
  const [editPlant, setEditPlant] = useState("");
  // Bumped on every open, so the quantity box is filled with the current stock each time the
  // dialog opens — even when it's the same item as last time (nothing else changes then).
  const [editOpenSeq, setEditOpenSeq] = useState(0);
  const editPrefilledRef = useRef("");
  const [editQtyInput, setEditQtyInput] = useState("");
  const [editReason, setEditReason] = useState("");
  const [deleteTarget, setDeleteTarget] = useState<PlantStockRow | null>(null);
  const [deleteConfirmText, setDeleteConfirmText] = useState("");

  const { data: deletePreview, isFetching: deletePreviewLoading } = useQuery<{
    currentStock: number; receivingScanEvents: number; loadingScanEvents: number;
    unloadingScanEvents: number; stockMovements: number; orderImportSessionsTouched: number;
    unloadingSessionsTouched: number;
  }>({
    queryKey: ["/api/plant-stock/delete-preview", deleteTarget?.barcode, deleteTarget?.plant],
    queryFn: () =>
      apiRequest(
        "GET",
        buildUrl("/api/plant-stock/delete-preview", { barcode: deleteTarget!.barcode!, plant: deleteTarget!.plant }),
        undefined, false, true,
      ),
    enabled: !!deleteTarget?.barcode,
  });

  const adjustMutation = useMutation({
    mutationFn: (vars: { barcode: string; plant: string; mode: "add" | "remove" | "set"; qty: number; expectedCurrentQty: number; reason: string }) =>
      apiRequest("POST", "/api/plant-stock/adjust", vars, false, true),
    onSuccess: (data: any) => {
      toast({ title: "Stock updated", description: `${data.plant}: ${data.previousQty} → ${data.newQty} (${data.delta >= 0 ? "+" : ""}${data.delta})` });
      queryClient.invalidateQueries({ queryKey: ["/api/scan-sessions/reports/plant-stock"] });
      queryClient.invalidateQueries({ queryKey: ["/api/scan-sessions/reports/stock-movements"] });
      queryClient.invalidateQueries({ queryKey: ["/api/scan-sessions/reports/scan-history"] });
      queryClient.invalidateQueries({ queryKey: ["/api/plant-stock/current"] });
      setEditTarget(null);
    },
    // A refusal because stock moved in the meantime also refreshes the live number shown, so the
    // next Save previews against what is actually there now.
    onError: (error: any) => {
      queryClient.invalidateQueries({ queryKey: ["/api/plant-stock/current"] });
      toast({ title: "Failed to update stock", description: error?.message, variant: "destructive" });
    },
  });

  const deleteMutation = useMutation({
    mutationFn: (vars: { barcode: string; plant: string }) =>
      apiRequest("DELETE", "/api/plant-stock", vars, false, true),
    onSuccess: () => {
      toast({ title: "Item deleted" });
      queryClient.invalidateQueries({ queryKey: ["/api/scan-sessions/reports/plant-stock"] });
      setDeleteTarget(null);
      setDeleteConfirmText("");
    },
    onError: (error: any) => toast({ title: "Failed to delete", description: error?.message, variant: "destructive" }),
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

  // All configured plants — used to populate the state/plant switcher tabs for admins.
  const { data: allPlants = [] } = useQuery<{ id: number; name: string; state?: string | null; bgColor?: string; textColor?: string; borderColor?: string }[]>({
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

  // Extra tab — server-side filter (pps.extra_qty > 0, see /reports/plant-stock) rather than
  // filtering the already-loaded rows client-side, so it stays correct against whatever date
  // scoping is active too (extraQty means "extra received in the window" in dateMode).
  const [extrasOnly, setExtrasOnly] = useState(false);

  // The plant chosen via a chip, if any — sent to the server to scope the query, same as the
  // date preset below.
  const activePlant = activeFilters.find((f) => f.field === "plant")?.value || "";
  // The state tab chosen, if any — a separate chip from "plant" so a state can be viewed
  // combined (every plant in it at once) without narrowing to one specific plant.
  const activeStateChip = activeFilters.find((f) => f.field === "state")?.value || "";

  // Every configured plant grouped by its state (plants.state) — the source for both the
  // top-level State tabs and each state's nested plant switch. Built from the FULL plant list
  // (not narrowed to this user's allowed set yet — that narrowing happens below, once
  // plantOptions is known, via visibleStateGroups) so it can resolve a plant's state before the
  // stock query itself has even run.
  const stateGroups = useMemo(() => {
    const byState = new Map<string, { name: string; bgColor?: string; textColor?: string; borderColor?: string }[]>();
    allPlants.forEach((p) => {
      const key = (p.state || "").trim().toUpperCase() || "OTHER"; // plants with no state configured still show, grouped together rather than silently dropped
      if (!byState.has(key)) byState.set(key, []);
      byState.get(key)!.push(p);
    });
    return Array.from(byState.entries())
      .map(([state, plants]) => ({ state, plants: [...plants].sort((a, b) => a.name.localeCompare(b.name)) }))
      .sort((a, b) => a.state.localeCompare(b.state));
  }, [allPlants]);
  // The state currently in view — either the explicit state chip (combined-state view), or
  // derived from whichever specific plant is selected, so the nested plant row stays correctly
  // highlighted even when a plant filter was set some other way (e.g. from the Filters list).
  const activeState = activeStateChip || (activePlant
    ? stateGroups.find((g) => g.plants.some((p) => p.name.toUpperCase() === activePlant.toUpperCase()))?.state ?? ""
    : "");

  // State tabs and the nested plant switch both write into the same "plant"/"state" chip pair —
  // picking one always clears the other, so the two levels never disagree about what's shown.
  const setStateTab = (state: string) => {
    setActiveFilters((prev) => {
      const others = prev.filter((f) => f.field !== "plant" && f.field !== "state");
      return state ? [...others, { id: ++filterIdRef.current, field: "state", value: state }] : others;
    });
  };
  const setPlantTab = (name: string) => {
    setActiveFilters((prev) => {
      const others = prev.filter((f) => f.field !== "plant" && f.field !== "state");
      return name ? [...others, { id: ++filterIdRef.current, field: "plant", value: name }] : others;
    });
  };

  // Plant-wise stock. Server enforces access: admins get every plant, others only theirs. A
  // specific plant always wins over a state — never send both (state is redundant once a plant
  // is picked, and the server would ignore it anyway).
  type StockAdjustment = {
    id: number; barcode: string; plant: string; qty: number; extraQty: number | null;
    reason: string | null; at: string; byCode: string | null; byName: string | null;
    origin: "page" | "operation" | "settings" | "opening";
  };
  // Real plant names to actually filter by — combinedPlants when this was opened from a merged
  // row (its own `plant` is a fake placeholder, never a real one), otherwise just the one plant.
  const adjustHistoryPlants = adjustHistoryTarget?.combinedPlants?.length ? adjustHistoryTarget.combinedPlants : (adjustHistoryTarget?.plant ? [adjustHistoryTarget.plant] : []);
  const adjustHistoryQuery = useQuery<{ items: StockAdjustment[] }>({
    queryKey: ["/api/scan-sessions/reports/stock-adjustments", adjustHistoryTarget?.barcode, adjustHistoryPlants.join(","), fromDate, toDate],
    queryFn: () => apiRequest(
      "GET",
      buildUrl("/api/scan-sessions/reports/stock-adjustments", {
        barcode: adjustHistoryTarget?.barcode,
        plant: adjustHistoryPlants.join(",") || undefined,
        from: fromDate || undefined,
        to: toDate || undefined,
      }),
      undefined, false, true,
    ),
    enabled: !!adjustHistoryTarget?.barcode,
  });

  // Deletes one Adjust ledger entry (the Adjustments dialog's per-row trash button) — never
  // touches live stock, see the server endpoint's own comment. Refetches both this dialog's own
  // list and the main stock report, since Opening/Adjust/Total Stock are computed from the same
  // ledger this just changed.
  const transferPlants = transferTarget?.combinedPlants?.length ? transferTarget.combinedPlants : (transferTarget?.plant ? [transferTarget.plant] : []);
  const transferQuery = useQuery<{ items: Array<{ id: number; plant: string; direction: "in" | "out" | null; otherPlant: string | null; qty: number; reason: string | null; at: string; day: string; vehicleNumber: string | null; csvFileName: string | null; byName: string | null }> }>({
    queryKey: ["/api/scan-sessions/reports/stock-transfers", transferTarget?.barcode, transferPlants.join(","), fromDate, toDate],
    queryFn: () => apiRequest(
      "GET",
      buildUrl("/api/scan-sessions/reports/stock-transfers", {
        barcode: transferTarget?.barcode,
        plant: transferPlants.join(",") || undefined,
        from: fromDate || undefined,
        to: toDate || undefined,
      }),
      undefined, false, true,
    ),
    enabled: !!transferTarget?.barcode,
  });

  const deleteMovementMutation = useMutation({
    mutationFn: (id: number) => apiRequest("DELETE", `/api/plant-stock/movements/${id}`, undefined, false, true),
    onSuccess: () => {
      toast({ title: "Entry deleted", description: "That ledger entry was removed. Live stock was not changed." });
      queryClient.invalidateQueries({ queryKey: ["/api/scan-sessions/reports/stock-adjustments"] });
      queryClient.invalidateQueries({ queryKey: ["/api/scan-sessions/reports/plant-stock"] });
      setDeleteMovementTarget(null);
    },
    onError: (err: any) => toast({ title: "Could not delete entry", description: err?.message, variant: "destructive" }),
  });

  const stockUrl = buildUrl("/api/scan-sessions/reports/plant-stock", {
    plant: activePlant || undefined,
    state: (!activePlant && activeState) || undefined,
    from: fromDate || undefined,
    to: toDate || undefined,
    extrasOnly: extrasOnly ? "true" : undefined,
  });
  const { data: stockData, refetch: refetchStock, isFetching: isStockFetching } = useQuery<PlantStockResponse>({
    queryKey: ["/api/scan-sessions/reports/plant-stock", activePlant, activeState, fromDate, toDate, extrasOnly],
    queryFn: () => apiRequest("GET", stockUrl, undefined, false, true),
    refetchInterval: 30000,
  });
  // True when a date range is active: the Stock/Extra numbers then mean "received in this
  // window" rather than "total on hand", so the UI labels them differently.
  const dateMode = stockData?.dateMode ?? false;
  // Expected Qty (sum of every CSV's ordered quantity across all parts) — an explicit date
  // filter scopes this to that one date's orders; with no filter it sums from the configured
  // Sales Tracking Start date onward (expectedDate is then null).
  const expectedDate = stockData?.expectedDate ?? null;
  const expectedTotal = stockData?.expectedTotal ?? 0;
  const hasExpected = stockData?.expectedTotal != null;
  // Expected Sale = proforma slips (planned); Sale = what Loading actually loaded. Both follow the
  // same period as every other column.
  const saleDate = stockData?.saleDate ?? null;
  const expectedSaleTotal = stockData?.expectedSaleTotal ?? 0;
  const salesTrackingStartLabel = stockData?.salesTrackingStart
    ? new Date(`${stockData.salesTrackingStart}T00:00:00`).toLocaleDateString("en-IN", { year: "numeric", month: "short", day: "numeric" })
    : null;
  // "61,049.19 plt" — a bare toFixed(2) ran the digits together at these sizes.
  const pltLabel = (pallets: number) =>
    `${pallets.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })} plt`;
  // The period every tile covers: one date, a range, or since Stock Tracking Start.
  const periodLabel = saleDate
    ? saleDate
    : stockData?.from || stockData?.to
      ? `${stockData?.from ?? "…"} – ${stockData?.to ?? "today"}`
      : `Since ${salesTrackingStartLabel ?? "start"}`;

  const rows = stockData?.items ?? [];
  // null = admin (may pick any plant). Array = restricted user → lock the switcher to these.
  const allowedPlants = stockData?.plants ?? null;
  const isAdmin = allowedPlants === null;

  // Plant dropdown options: admins pick from every configured plant; restricted users only
  // from the plant(s) assigned to them. "All" means "all plants I'm allowed to see".
  const plantOptions = isAdmin
    ? allPlants.map((p) => p.name)
    : (allowedPlants ?? []).map((p) => p.toUpperCase());

  // stateGroups narrowed to plants this user is actually allowed to see — what the tabs
  // themselves render. A state with zero visible plants (all outside this user's allowed set)
  // doesn't get a tab at all.
  const visibleStateGroups = useMemo(
    () => stateGroups
      .map((g) => ({ ...g, plants: g.plants.filter((p) => plantOptions.some((n) => n.toUpperCase() === p.name.toUpperCase())) }))
      .filter((g) => g.plants.length > 0),
    [stateGroups, plantOptions],
  );
  const activeStateGroup = visibleStateGroups.find((g) => g.state === activeState) ?? null;

  // ── Adjust dialog ───────────────────────────────────────────────────────────────
  // Plants offered follow the tab being viewed — a plant tab offers just that plant, a state tab
  // the plants in that state, All every plant this user can see. Never "All" itself: an
  // adjustment always lands on exactly one plant, and it's offered even where this item has no
  // stock yet (the old menu only listed plants already holding it, which is why a Valsad-only
  // item offered nothing but Valsad).
  const editPlantOptions = activePlant
    ? [activePlant]
    : activeStateGroup
      ? activeStateGroup.plants.map((p) => p.name)
      : plantOptions;
  const openEditDialog = (row: PlantStockRow) => {
    const single = !row.combinedPlants || row.combinedPlants.length <= 1;
    const rowPlantOption = single ? editPlantOptions.find((p) => p.toUpperCase() === row.plant.toUpperCase()) : undefined;
    setEditTarget(row);
    setEditPlant(editPlantOptions.length === 1 ? editPlantOptions[0] : rowPlantOption ?? "");
    setEditOpenSeq((n) => n + 1);
    setEditQtyInput("");
    setEditReason("");
  };
  // The plant's LIVE stock — the preview and the server's own check both use this, never the table
  // row's numbers (a date filter or a merged All/State row would make those the wrong baseline).
  const { data: editCurrent, isFetching: editCurrentLoading } = useQuery<{ inStock: number; extraQty: number; total: number }>({
    queryKey: ["/api/plant-stock/current", editTarget?.barcode, editPlant],
    queryFn: () => apiRequest("GET", buildUrl("/api/plant-stock/current", { barcode: editTarget!.barcode!, plant: editPlant }), undefined, false, true),
    enabled: !!editTarget?.barcode && !!editPlant,
    staleTime: 0,
  });
  // The quantity box starts at the live stock, so the person just types what the count should be;
  // the + / − adjustment is worked out from the difference.
  // Filled once per open / plant / stock figure — not on every keystroke, so clearing the box to
  // type a new number doesn't snap it back to the current stock.
  useEffect(() => {
    if (!editTarget || !editCurrent) return;
    const key = `${editOpenSeq}::${editPlant}::${editCurrent.total}`;
    if (editPrefilledRef.current === key) return;
    editPrefilledRef.current = key;
    setEditQtyInput(String(editCurrent.total));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [editOpenSeq, editPlant, editCurrent?.total]);
  const editQtyNumber = Math.round(Number(editQtyInput));
  const editPreview = (() => {
    if (!editCurrent || editQtyInput.trim() === "" || !Number.isFinite(Number(editQtyInput)) || Number(editQtyInput) < 0) return null;
    const current = editCurrent.total;
    return { current, next: editQtyNumber, delta: editQtyNumber - current };
  })();

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
      // Half-set ranges are normal while picking: choosing the FROM bound leaves TO empty, and
      // format(new Date(""), …) throws "Invalid time value". Render the missing bound as "…"
      // instead of crashing the page mid-selection.
      const fmt = (s: string) => {
        const d = s ? new Date(s) : null;
        return d && !isNaN(d.getTime()) ? format(d, "MMM d, yyyy") : "…";
      };
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
      { id: "expected", label: "Expected Purchase", filterType: "number", options: numberOptions((r) => r.expectedQty), accessor: (r) => r.expectedQty ?? null },
      { id: "opening", label: "Opening", filterType: "number", options: numberOptions((r) => r.openingStock), accessor: (r) => r.openingStock ?? null },
      { id: "purchase", label: "Purchase", filterType: "number", options: numberOptions((r) => r.inStock), accessor: (r) => r.inStock },
      { id: "extra", label: "Extra", filterType: "number", options: numberOptions((r) => r.extraQty), accessor: (r) => r.extraQty },
      { id: "adjust", label: "Adjust", filterType: "number", options: numberOptions((r) => r.adjustQty), accessor: (r) => r.adjustQty ?? null },
      { id: "transferIn", label: "Transfer In", filterType: "number", options: numberOptions((r) => r.transferIn), accessor: (r) => r.transferIn ?? null },
      { id: "transferOut", label: "Transfer Out", filterType: "number", options: numberOptions((r) => r.transferOut), accessor: (r) => r.transferOut ?? null },
      { id: "system", label: "System (Clear Stock)", filterType: "number", options: numberOptions((r) => r.systemQty), accessor: (r) => r.systemQty ?? null },
      { id: "totalIn", label: "Total Stock", filterType: "number", options: numberOptions((r) => (r.openingStock ?? 0) + r.inStock + (r.adjustQty ?? 0) + (r.transferIn ?? 0) - (r.transferOut ?? 0)), accessor: (r) => (r.openingStock ?? 0) + r.inStock + (r.adjustQty ?? 0) + (r.transferIn ?? 0) - (r.transferOut ?? 0) },
      { id: "expectedSale", label: "Expected Sale", filterType: "number", options: numberOptions((r) => r.expectedSaleQty), accessor: (r) => r.expectedSaleQty ?? null },
      { id: "sale", label: "Sale", filterType: "number", options: numberOptions((r) => r.saleQty), accessor: (r) => r.saleQty ?? null },
      { id: "closing", label: "Closing", filterType: "number", options: numberOptions((r) => r.closingStock), accessor: (r) => r.closingStock ?? null },
    ];
  }, [rows]);

  // Options for the unified "+ Filter" picker's list step — Plant/Date plus every generic
  // column, minus whichever are already active (each dimension can only be added once).
  const filterPickerOptions = useMemo(() => {
    // Plant (tab strip) and Date (its own control before "+ Filter") are intentionally NOT here.
    // Already-filtered columns are left OUT of this list: "+ Filter" adds a new one, while
    // changing or removing an existing filter happens in the "Filters (N)" dropdown, which lists
    // them all and opens each one's builder pre-filled.
    const q = filterPickerSearch.trim().toLowerCase();
    // Date leads the list — it's the dimension people reach for first, and it opens the same
    // single/range + quick-ranges panel the toolbar's own Date button shows.
    const dims: { key: string; label: string; icon?: typeof CalendarDays }[] = [
      ...filterableColumns
        .filter((c) => !columnConditions[c.id])
        .map((c) => ({ key: c.id, label: c.label })),
    ];
    return dims.filter((d) => !q || d.label.toLowerCase().includes(q));
  }, [filterableColumns, columnConditions, filterPickerSearch]);
  const pickedFilterColumn = filterableColumns.find((c) => c.id === filterPickerKey) ?? null;

  // The "Filters (N)" popover doubles as the editor: it lists everything applied, and drilling
  // into one swaps the list for that filter's builder (editFilterKey), with a Back link.
  const [editFilterOpen, setEditFilterOpen] = useState(false);
  const [editFilterKey, setEditFilterKey] = useState("");
  const editFilterColumn = filterableColumns.find((c) => c.id === editFilterKey) ?? null;

  // The date filter, split in two so each entry does one job. Both write the same
  // activeFilters["date"] value, so whichever you use, the other reflects it.
  //   Date        — named ranges only (Today, Yesterday, This week, This month)
  //   Custom date — the calendar: a single date, or a from/to range
  const dateQuickBody = (
    <div className="space-y-3">
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
                  setFilterPickerOpen(false);
                  setFilterPickerKey("");
                }}
                className="rounded-md border border-gray-300 px-2 py-1 text-xs text-gray-700 hover:border-[#001d6e]/40 hover:bg-[#001d6e]/5 hover:text-[#001d6e]"
              >
                {o.label}
              </button>
            ))}
          </div>
        </div>
    </div>
  );

  const dateCustomBody = (
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
    </div>
  );


  // Both halves together — what the toolbar's own Date button still shows.
  const dateFilterBody = (
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
                  setFilterPickerOpen(false);
                  setFilterPickerKey("");
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
              onClick={() => { upsertSimpleFilter("date", ""); setDateOpen(false); setDateCalOpen(false); }}
              className="text-[11px] text-red-500 hover:underline"
            >
              Clear date
            </button>
          </div>
        )}
    </div>
  );

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
  };

  // A row passes when every set filter matches it (empty-value filters are ignored until picked).
  const matchesActiveFilters = (r: PlantStockRow) =>
    activeFilters.every((af) => !af.value || (fieldOf(af.field)?.match(r, af.value) ?? true));

  const columnConditionList = useMemo(() => Object.values(columnConditions), [columnConditions]);

  const filtered = useMemo(() => {
    return rows.filter((r) => {
      if (!matchesActiveFilters(r)) return false;
      if (!matchAllConditions(r, columnConditionList, filterableColumns)) return false;
      if (movedOnly && !(r.transferIn || r.transferOut)) return false;
      if (!search) return true;
      const q = normalizedText(search);
      return (
        // Sr No is an exact match, so "1" finds Sr No 1 and not 10–19 as well.
        normalizedText(r.srNo) === q ||
        normalizedText(r.itemName).includes(q) ||
        normalizedText(r.barcode).includes(q) ||
        normalizedText(r.sapCode).includes(q) ||
        normalizedText(r.category).includes(q) ||
        normalizedText(r.brand).includes(q) ||
        normalizedText(r.plant).includes(q)
      );
    });
  }, [rows, search, activeFilters, columnConditionList, filterableColumns, movedOnly]);

  // Summary — from REAL stock rows only; empty boxes are never counted as stock.
  const totalStock = filtered.reduce((s, r) => s + r.inStock, 0);
  const totalPallets = filtered.reduce((s, r) => s + (r.pallets ?? 0), 0);
  const totalExtra = filtered.reduce((s, r) => s + r.extraQty, 0);
  const totalExtraPallets = filtered.reduce((s, r) => s + (r.extraPallets ?? 0), 0);
  // Purchase = inStock, already the full physical total (extras inside it) — never add extraQty
  // on top. Opening / Sale / Closing are summed over the same filtered rows as the table.
  const totalPurchase = totalStock;
  const totalPurchasePallets = totalPallets;
  const totalOpening = filtered.reduce((s, r) => s + (r.openingStock ?? 0), 0);
  const totalOpeningPallets = filtered.reduce((s, r) => s + (r.openingPallets ?? 0), 0);
  const totalSale = filtered.reduce((s, r) => s + (r.saleQty ?? 0), 0);
  const totalAdjust = filtered.reduce((s, r) => s + (r.adjustQty ?? 0), 0);
  const totalSalePallets = filtered.reduce((s, r) => s + (r.salePallets ?? 0), 0);
  const totalClosing = filtered.reduce((s, r) => s + (r.closingStock ?? 0), 0);
  const totalClosingPallets = filtered.reduce((s, r) => s + (r.closingPallets ?? 0), 0);
  // Expected / Expected Sale pallets are summed over ALL rows — the same scope as the server's
  // expectedTotal / expectedSaleTotal shown beside them.
  const expectedPalletsTotal = rows.reduce((s, r) => s + (r.expectedPallets ?? 0), 0);
  const expectedSalePalletsTotal = rows.reduce((s, r) => s + (r.expectedSalePallets ?? 0), 0);

  // Not narrowed to one specific plant — a State tab (every plant in that state) OR the "All"
  // tab (every plant the user can see) — used to just widen the plant filter, so the same item
  // showed up as one row PER plant — a confusing pile of "duplicate" entries for what's really
  // one product. Combined into a single row per item instead: Stock/Extra/Sale/Expected/Opening/
  // Closing summed across every plant in view, with combinedPlants recording which plants went
  // into it so the Details/History drill-down can still break it back down. A specific single
  // plant is unaffected — there's only ever one row per item there already.
  const isMergedView = !activePlant;
  const groupedByState = useMemo(() => {
    if (!isMergedView) return filtered;
    const byBarcode = new Map<string, PlantStockRow>();
    for (const r of filtered) {
      if (r.isEmptyBox) continue; // empty boxes stay their own per-plant rows below, never merged
      const key = normalizedText(r.barcode) || normalizedText(r.itemName) || `missing-${r.srNo}`;
      const existing = byBarcode.get(key);
      if (!existing) {
        byBarcode.set(key, { ...r, plant: activeState || "ALL", combinedPlants: [r.plant] });
        continue;
      }
      existing.inStock += r.inStock;
      existing.adjustQty = (existing.adjustQty ?? 0) + (r.adjustQty ?? 0);
      existing.systemQty = (existing.systemQty ?? 0) + (r.systemQty ?? 0);
      existing.transferIn = (existing.transferIn ?? 0) + (r.transferIn ?? 0);
      existing.transferOut = (existing.transferOut ?? 0) + (r.transferOut ?? 0);
      existing.extraQty += r.extraQty;
      existing.pallets = (existing.pallets ?? 0) + (r.pallets ?? 0);
      existing.extraPallets = (existing.extraPallets ?? 0) + (r.extraPallets ?? 0);
      existing.expectedQty = sumNullable(existing.expectedQty, r.expectedQty);
      existing.expectedPallets = sumNullable(existing.expectedPallets, r.expectedPallets) ?? undefined;
      existing.saleQty = sumNullable(existing.saleQty, r.saleQty);
      existing.salePallets = sumNullable(existing.salePallets, r.salePallets) ?? undefined;
      existing.expectedSaleQty = sumNullable(existing.expectedSaleQty, r.expectedSaleQty);
      existing.expectedSalePallets = sumNullable(existing.expectedSalePallets, r.expectedSalePallets) ?? undefined;
      existing.liveStock = (existing.liveStock ?? 0) + (r.liveStock ?? 0);
      existing.openingStock = sumNullable(existing.openingStock, r.openingStock);
      existing.openingPallets = sumNullable(existing.openingPallets, r.openingPallets) ?? undefined;
      existing.closingStock = sumNullable(existing.closingStock, r.closingStock);
      existing.closingPallets = sumNullable(existing.closingPallets, r.closingPallets) ?? undefined;
      if (r.lastArrived && (!existing.lastArrived || r.lastArrived > existing.lastArrived)) existing.lastArrived = r.lastArrived;
      existing.combinedPlants!.push(r.plant);
    }
    return Array.from(byBarcode.values());
  }, [filtered, isMergedView, activeState]);

  // Empty boxes as their OWN distinct rows (one per plant), appended below the stock rows.
  // Never mixed into stock/extra totals — the quantity shows only inside the "Empty Box" badge.
  const emptyBoxRows = useMemo<PlantStockRow[]>(() => {
    // Empty boxes have no category/brand and aren't product stock, so any active dimension filter
    // (once it has a value) necessarily excludes them.
    if (activeFilters.some((f) => f.value)) return [];
    if (columnConditionList.some((c) => !isConditionEmpty(c))) return [];
    const list = stockData?.emptyBoxByPlant ?? [];
    const q = normalizedText(search);
    return list
      .filter((e) => e.qty > 0)
      .filter((e) => !search || "empty box".includes(q) || normalizedText(e.plant).includes(q))
      .map((e) => ({
        srNo: null, barcode: "EMPTY_BOX", plant: e.plant, itemName: "Empty Box",
        itemNo: null, sapCode: null, hsnCode: null, category: null, brand: null,
        itemsPerPallet: null, inStock: e.qty, extraQty: 0, pallets: null, extraPallets: null,
        lastArrived: null, isEmptyBox: true, emptyBoxCount: e.count,
      }));
  }, [stockData?.emptyBoxByPlant, search, activeFilters, columnConditionList]);
  const emptyBoxTotal = stockData?.emptyBoxTotal ?? 0;

  // Real stock rows first, then the distinct empty-box rows. groupedByState IS filtered when not
  // in state view (see its own comment) — this always reflects whichever one applies.
  const displayRows = useMemo(() => [...groupedByState, ...emptyBoxRows], [groupedByState, emptyBoxRows]);

  // Any change to what's being listed restarts at page 1 — staying on page 4 of a plant you just
  // switched to shows an arbitrary slice, and reads as empty whenever the new set is shorter.
  useEffect(() => {
    setPageIndex(0);
  }, [search, activePlant, activeFilters, columnConditionList]);

  // Keep the saved copy in step with what's applied, so coming back restores it. The page number
  // isn't saved — a filtered table should reopen at the top of its results.
  useEffect(() => {
    try {
      sessionStorage.setItem(
        STOCK_FILTERS_KEY,
        JSON.stringify({ search, activeFilters, conditions: columnConditions } satisfies SavedStockFilters),
      );
    } catch {
      // Storage unavailable (private mode / quota) — filters just won't outlive the page.
    }
  }, [search, activeFilters, columnConditions]);

  // Export rows — same order as the table's own columns.
  const exportRows = (src: PlantStockRow[]): Array<Array<string | number>> => [
    [
      "Sr No", "Item", "Barcode", "SAP Code", "HSN Code", "Category", "Brand", "Plant",
      "Expected Qty", "Expected Pallets",
      "Opening Stock", "Opening Pallets",
      "Purchase Qty", "Purchase Pallets", "Extra Qty (within Purchase)", "Extra Pallets",
      "Adjust Qty", "Transfer In", "Transfer Out", "Total Stock (Opening + Purchase + Adjust + Transfer)", "System (Clear Stock)",
      "Expected Sale Qty", "Expected Sale Pallets",
      "Sale Qty (loaded)", "Sale Pallets",
      "Closing Stock", "Closing Pallets",
      "Last Updated",
    ],
    ...src.map((r) => {
      // inStock already IS the full physical purchase (extras included) — never add extraQty.
      const purchaseQty = r.inStock;
      const ipp = r.itemsPerPallet ? Number(r.itemsPerPallet) : 0;
      const purchasePallets = ipp > 0 ? purchaseQty / ipp : null;
      const plt = (v: number | null | undefined) => (v != null ? v.toFixed(2) : "");
      return [
        r.srNo ?? "", r.itemName, r.barcode ?? "", r.sapCode ?? "", r.hsnCode ?? "",
        r.category ?? "", r.brand ?? "", r.plant,
        r.expectedQty ?? "", plt(r.expectedPallets),
        r.openingStock ?? "", plt(r.openingPallets),
        purchaseQty, plt(purchasePallets), r.extraQty, plt(r.extraPallets),
        r.adjustQty ?? 0, r.transferIn ?? 0, r.transferOut ?? 0, (r.openingStock ?? 0) + purchaseQty + (r.adjustQty ?? 0) + (r.transferIn ?? 0) - (r.transferOut ?? 0), r.systemQty ?? 0,
        r.expectedSaleQty ?? "", plt(r.expectedSalePallets),
        r.saleQty ?? "", plt(r.salePallets),
        r.closingStock ?? "", plt(r.closingPallets),
        r.lastArrived ? format(new Date(r.lastArrived), "yyyy-MM-dd") : "",
      ];
    }),
  ];

  const dash = <span className="text-gray-300">—</span>;
  // Crisper grid lines (was border-gray-100) — a typical business/report table reads as an
  // actual grid, not a barely-visible divider.
  const cellBorder = "border-r border-gray-300";
  const headerBorder = "border-r border-[#001d6e]/30";

  // Shared qty+pallets stacked cell — every quantity column (Expected/Opening/Purchase/Sale/
  // Closing/Remain) reads the same way: the number on top, its pallet figure underneath, and
  // (Purchase only) a third line showing how much of that total was "extra" — already included
  // in the number above, not added on top of it.
  const stackedCell = (qty: number | null | undefined, plt: number | null | undefined, colorClass: string, extra?: number | null) => {
    if (qty == null) return dash;
    return (
      <span>
        <span className={`block font-bold tabular-nums ${colorClass}`}>{qty.toLocaleString()}</span>
        {plt != null && plt > 0 && <span className="block text-[11px] font-semibold text-gray-500">{plt.toFixed(2)} plt</span>}
        {extra != null && extra > 0 && <span className="block text-[11px] font-semibold text-amber-600">+{extra.toLocaleString()} extra</span>}
      </span>
    );
  };

  // Exchange/Edit/Delete all need one exact (barcode, plant) target. A normal row already IS
  // that; a merged row (All tab, or a State tab — see groupedByState) has more than one plant
  // folded into it, so clicking straight through would act on the wrong (summed) numbers. For a
  // merged row, this shows a small plant-picker menu instead, resolves the ONE real row for the
  // plant picked (from the raw, ungrouped `rows`), and only then runs the action against it.
  const plantScopedAction = (
    row: PlantStockRow,
    icon: React.ReactNode,
    title: string,
    hoverClass: string,
    onPick: (target: PlantStockRow) => void,
  ) => {
    const plants = row.combinedPlants;
    if (!plants || plants.length <= 1) {
      return (
        <Button
          size="sm" variant="ghost" className={`h-7 w-7 p-0 text-gray-400 ${hoverClass}`} title={title}
          onClick={(e) => { e.stopPropagation(); onPick(row); }}
        >
          {icon}
        </Button>
      );
    }
    return (
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <Button
            size="sm" variant="ghost" className={`h-7 w-7 p-0 text-gray-400 ${hoverClass}`}
            title={`${title} — pick a plant`} onClick={(e) => e.stopPropagation()}
          >
            {icon}
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end">
          {plants.map((plant) => (
            <DropdownMenuItem
              key={plant}
              onClick={() => {
                const target = rows.find((r) => r.barcode === row.barcode && r.plant === plant);
                if (target) onPick(target);
              }}
            >
              {plant}
            </DropdownMenuItem>
          ))}
        </DropdownMenuContent>
      </DropdownMenu>
    );
  };

  const stockColumns: DataTableColumn<PlantStockRow>[] = [
    {
      id: "srNo",
      header: columnHeader("srNo", "Sr No"),
      hideable: false,
      width: 44,
      // Pinned left, first — see Item Name's own comment below.
      fixedWidth: true,
      sortable: true,
      // Numeric, not a plain string compare — Sr No is mostly digits ("1", "2", "10"), and a
      // string sort would read "10" as less than "2". Falls back to the raw string so a
      // non-numeric Sr No (if one ever exists) still sorts somewhere sensible instead of
      // vanishing as null.
      accessor: (row) => {
        const n = Number(row.srNo);
        return row.srNo != null && Number.isFinite(n) ? n : row.srNo;
      },
      totalable: false,
      headerClassName: headerBorder,
      cellClassName: `text-gray-400 tabular-nums ${cellBorder}`,
      render: (row) => row.srNo || dash,
    },
    {
      id: "itemName",
      header: columnHeader("itemName", "Item"),
      hideable: false,
      width: 220,
      // Pinned left (see stickyColumnIds on the DataTable below) — fixedWidth makes its on-screen
      // width exact and stable instead of stretching/shrinking with the other columns, which a
      // sticky-left offset needs to line up against.
      fixedWidth: true,
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
            onClick={() => {
              setDetailRow((cur) => (cur && cur.barcode === row.barcode && cur.plant === row.plant ? null : row));
              setDetailTab("details");
              setHistorySource("scanning");
              setExpandedParties(new Set());
            }}
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
      // Pinned left right after Item Name — see that column's own comment.
      fixedWidth: true,
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
    // Only meaningful for a single specific plant — merged views (All, or a State tab) fold
    // every plant into one row per item, so there's no one real plant left to show here.
    ...(!isMergedView ? [{
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
    } as DataTableColumn<PlantStockRow>] : []),
    {
      id: "expected",
      header: columnHeader("expected", "Expected Purchase"),
      width: 110,
      align: "right",
      sortable: true,
      accessor: (row) => row.expectedQty ?? 0,
      total: (rows) => {
        const withVal = rows.filter((r) => r.expectedQty != null);
        if (withVal.length === 0) return null;
        const qty = withVal.reduce((sum, r) => sum + (r.expectedQty ?? 0), 0);
        const plt = withVal.reduce((sum, r) => sum + (r.expectedPallets ?? 0), 0);
        return stackedCell(qty, plt, "text-purple-700");
      },
      headerClassName: headerBorder,
      cellClassName: cellBorder,
      render: (row) =>
        row.isEmptyBox || row.expectedQty == null ? dash : (
          <span title={expectedDate ? `Sum of ordered quantity across every CSV/part uploaded for ${expectedDate}` : `Sum of ordered quantity across every CSV/part uploaded since ${salesTrackingStartLabel ?? "the configured start date"}`}>
            {stackedCell(row.expectedQty, row.expectedPallets, "text-purple-700")}
          </span>
        ),
    },
    // Opening — stock on hand at the START of the period: every earlier purchase minus every
    // earlier sale (the previous period's Closing carried forward).
    ...([{
      id: "opening",
      header: columnHeader("opening", "Opening"),
      width: 110,
      align: "right" as const,
      sortable: true,
      accessor: (row: PlantStockRow) => row.openingStock ?? 0,
      total: (rows: PlantStockRow[]) => {
        const withVal = rows.filter((r) => r.openingStock != null);
        if (withVal.length === 0) return null;
        const qty = withVal.reduce((sum, r) => sum + (r.openingStock ?? 0), 0);
        const plt = withVal.reduce((sum, r) => sum + (r.openingPallets ?? 0), 0);
        return stackedCell(qty, plt, "text-gray-700");
      },
      headerClassName: headerBorder,
      cellClassName: cellBorder,
      render: (row: PlantStockRow) =>
        row.isEmptyBox ? dash : (
          <span title="Stock on hand at the start of this period — the previous period's Closing carried forward.">
            {stackedCell(row.openingStock, row.openingPallets, "text-gray-700")}
          </span>
        ),
    } as DataTableColumn<PlantStockRow>]),
    {
      // Purchase — every physical box that came in during the period. inStock already IS that full
      // total (extras are counted inside it) — never add extraQty on top, that would double-count
      // them. The standalone Extra column right after this one is only the breakdown.
      id: "purchase",
      header: columnHeader("purchase", "Purchase"),
      width: 120,
      align: "right",
      sortable: true,
      accessor: (row) => row.inStock,
      total: (rows) => {
        const qty = rows.reduce((sum, r) => sum + r.inStock, 0);
        const plt = rows.reduce((sum, r) => sum + (r.pallets ?? 0), 0);
        return stackedCell(qty, plt, "text-[#001d6e]");
      },
      headerClassName: headerBorder,
      cellClassName: `font-bold text-[#001d6e] tabular-nums ${cellBorder}`,
      render: (row) => {
        if (row.isEmptyBox) {
          return <span className="font-bold text-orange-600 tabular-nums" title="Empty boxes — not counted in stock totals">{row.inStock.toLocaleString()}</span>;
        }
        const purchaseQty = row.inStock;
        const ipp = row.itemsPerPallet ? Number(row.itemsPerPallet) : 0;
        const purchasePlt = ipp > 0 ? purchaseQty / ipp : null;
        return stackedCell(purchaseQty, purchasePlt, "text-[#001d6e]");
      },
    },
    {
      // Standalone, always-visible breakdown of how much of Purchase (above) was extra
      // (over-order) — already included in Purchase's total, not additional stock on top of it.
      id: "extra",
      header: columnHeader("extra", "Extra"),
      width: 100,
      align: "right",
      sortable: true,
      accessor: (row) => row.extraQty,
      total: (rows) => {
        const qty = rows.reduce((sum, r) => sum + r.extraQty, 0);
        const plt = rows.reduce((sum, r) => sum + (r.extraPallets ?? 0), 0);
        return qty > 0 ? stackedCell(qty, plt, "text-amber-600") : null;
      },
      headerClassName: headerBorder,
      cellClassName: cellBorder,
      render: (row) =>
        row.isEmptyBox || !(row.extraQty > 0) ? dash : stackedCell(row.extraQty, row.extraPallets, "text-amber-600"),
    },
    {
      // Corrections, signed: a clear or a rollback reads as a minus here instead of dragging
      // Purchase below zero, and an added correction reads as a plus. Counted in Closing.
      id: "adjust",
      header: columnHeader("adjust", "Adjust"),
      width: 100,
      align: "right",
      sortable: true,
      accessor: (row) => row.adjustQty ?? 0,
      total: (rows) => {
        const qty = rows.reduce((sum, r) => sum + (r.adjustQty ?? 0), 0);
        return qty !== 0 ? stackedCell(qty, null, qty < 0 ? "text-red-600" : "text-emerald-600") : null;
      },
      headerClassName: headerBorder,
      cellClassName: cellBorder,
      render: (row) => {
        const qty = row.adjustQty ?? 0;
        if (row.isEmptyBox || qty === 0) return dash;
        const ipp = row.itemsPerPallet ? Number(row.itemsPerPallet) : 0;
        // Clickable: one number per item says nothing about who changed what — this opens the
        // corrections it is made of.
        return (
          <button
            type="button"
            className="w-full text-right hover:underline"
            title="Show every correction behind this figure"
            onClick={(e) => { e.stopPropagation(); setAdjustHistoryTarget({ barcode: row.barcode ?? "", plant: row.plant, itemName: row.itemName ?? row.barcode ?? "", combinedPlants: row.combinedPlants }); }}
          >
            {stackedCell(qty, ipp > 0 ? qty / ipp : null, qty < 0 ? "text-red-600" : "text-emerald-600")}
          </button>
        );
      },
    },
    {
      // Stock that arrived from another plant: an Unloading batch whose purchase plant is not its
      // stock plant books the purchase at the purchase plant and moves it here. Click for which
      // batches and which plant it came from.
      id: "transferIn",
      header: columnHeader("transferIn", "Transfer In"),
      width: 110,
      align: "right",
      sortable: true,
      accessor: (row) => row.transferIn ?? 0,
      total: (rows) => {
        const qty = rows.reduce((sum, r) => sum + (r.transferIn ?? 0), 0);
        return qty !== 0 ? stackedCell(qty, null, "text-emerald-600") : null;
      },
      headerClassName: headerBorder,
      cellClassName: cellBorder,
      render: (row) => {
        const qty = row.transferIn ?? 0;
        if (row.isEmptyBox || qty === 0) return dash;
        const ipp = row.itemsPerPallet ? Number(row.itemsPerPallet) : 0;
        return (
          <button
            type="button"
            className="w-full text-right hover:underline"
            title="Show where this stock was moved in from"
            onClick={(e) => { e.stopPropagation(); setTransferTarget({ barcode: row.barcode ?? "", plant: row.plant, itemName: row.itemName ?? row.barcode ?? "", combinedPlants: row.combinedPlants }); }}
          >
            {stackedCell(qty, ipp > 0 ? qty / ipp : null, qty < 0 ? "text-red-600" : "text-emerald-600")}
          </button>
        );
      },
    },
    {
      // Stock this plant bought but that was added to another plant (the purchase stays here as
      // Purchase; this takes it out again so Closing is right).
      id: "transferOut",
      header: columnHeader("transferOut", "Transfer Out"),
      width: 110,
      align: "right",
      sortable: true,
      accessor: (row) => row.transferOut ?? 0,
      total: (rows) => {
        const qty = rows.reduce((sum, r) => sum + (r.transferOut ?? 0), 0);
        return qty !== 0 ? stackedCell(qty, null, "text-red-600") : null;
      },
      headerClassName: headerBorder,
      cellClassName: cellBorder,
      render: (row) => {
        const qty = row.transferOut ?? 0;
        if (row.isEmptyBox || qty === 0) return dash;
        const ipp = row.itemsPerPallet ? Number(row.itemsPerPallet) : 0;
        return (
          <button
            type="button"
            className="w-full text-right hover:underline"
            title="Show where this stock was moved to"
            onClick={(e) => { e.stopPropagation(); setTransferTarget({ barcode: row.barcode ?? "", plant: row.plant, itemName: row.itemName ?? row.barcode ?? "", combinedPlants: row.combinedPlants }); }}
          >
            {stackedCell(qty, ipp > 0 ? qty / ipp : null, qty < 0 ? "text-emerald-600" : "text-red-600")}
          </button>
        );
      },
    },
    {
      // Settings-wide corrections — Clear Stock. Hidden unless turned on in Columns; Closing
      // counts it either way, so the row adds up whether it is on screen or not.
      id: "system",
      header: columnHeader("system", "System"),
      width: 110,
      align: "right",
      sortable: true,
      accessor: (row) => row.systemQty ?? 0,
      total: (rows) => {
        const qty = rows.reduce((sum, r) => sum + (r.systemQty ?? 0), 0);
        return qty !== 0 ? stackedCell(qty, null, qty < 0 ? "text-red-600" : "text-emerald-600") : null;
      },
      headerClassName: headerBorder,
      cellClassName: cellBorder,
      render: (row) => {
        const qty = row.systemQty ?? 0;
        if (row.isEmptyBox || qty === 0) return dash;
        const ipp = row.itemsPerPallet ? Number(row.itemsPerPallet) : 0;
        return stackedCell(qty, ipp > 0 ? qty / ipp : null, qty < 0 ? "text-red-600" : "text-emerald-600");
      },
    },
    {
      // Opening + Purchase + Adjust — the full total this plant has to work with in the period,
      // not just what came in during it. Editing an item's stock by hand lands in Adjust, so
      // Purchase alone (40) no longer looks like the whole story when the edit made it 80, or
      // when the item started the period already holding stock (Opening); this column is the
      // figure that accounts for all three.
      id: "totalIn",
      header: columnHeader("totalIn", "Total Stock"),
      width: 110,
      align: "right",
      sortable: true,
      accessor: (row) => (row.openingStock ?? 0) + row.inStock + (row.adjustQty ?? 0) + (row.transferIn ?? 0) - (row.transferOut ?? 0),
      total: (rows) => {
        const qty = rows.reduce((sum, r) => sum + (r.openingStock ?? 0) + r.inStock + (r.adjustQty ?? 0) + (r.transferIn ?? 0) - (r.transferOut ?? 0), 0);
        return stackedCell(qty, null, "text-[#001d6e]");
      },
      headerClassName: headerBorder,
      cellClassName: `font-semibold tabular-nums ${cellBorder}`,
      render: (row) => {
        if (row.isEmptyBox) return dash;
        const qty = (row.openingStock ?? 0) + row.inStock + (row.adjustQty ?? 0) + (row.transferIn ?? 0) - (row.transferOut ?? 0);
        const ipp = row.itemsPerPallet ? Number(row.itemsPerPallet) : 0;
        return stackedCell(qty, ipp > 0 ? qty / ipp : null, qty < 0 ? "text-red-600" : "text-[#001d6e]");
      },
    },
    // Expected Sale — what the proforma slips PLAN to send out in this period (not what was loaded).
    {
      id: "expectedSale",
      header: columnHeader("expectedSale", "Expected Sale"),
      width: 110,
      align: "right",
      sortable: true,
      accessor: (row) => row.expectedSaleQty ?? null,
      total: (rows) => {
        const withVal = rows.filter((r) => r.expectedSaleQty != null);
        if (withVal.length === 0) return null;
        const qty = withVal.reduce((sum, r) => sum + (r.expectedSaleQty ?? 0), 0);
        const plt = withVal.reduce((sum, r) => sum + (r.expectedSalePallets ?? 0), 0);
        return stackedCell(qty, plt, "text-teal-700");
      },
      headerClassName: headerBorder,
      cellClassName: cellBorder,
      render: (row) =>
        row.isEmptyBox || row.expectedSaleQty == null ? dash : (
          <span title={saleDate ? `Proforma slip quantity for ${saleDate}` : `Proforma slip quantity for ${periodLabel}`}>
            {stackedCell(row.expectedSaleQty, row.expectedSalePallets, "text-teal-700")}
          </span>
        ),
    },
    // Sale — what Loading actually loaded, dated by each proforma slip's order date.
    {
      id: "sale",
      header: columnHeader("sale", "Sale"),
      width: 100,
      align: "right",
      sortable: true,
      accessor: (row) => row.saleQty ?? null,
      total: (rows) => {
        const qty = rows.reduce((sum, r) => sum + (r.saleQty ?? 0), 0);
        const plt = rows.reduce((sum, r) => sum + (r.salePallets ?? 0), 0);
        return stackedCell(qty, plt, "text-emerald-600");
      },
      headerClassName: headerBorder,
      cellClassName: cellBorder,
      render: (row) =>
        row.isEmptyBox || !row.saleQty ? dash : (
          <span title="Actually loaded on the Loading page, dated by the proforma slip's order date.">
            {stackedCell(row.saleQty, row.salePallets, "text-emerald-600")}
          </span>
        ),
    },
    // Closing = Opening + Purchase − Sale — stock on hand at the END of the period, and the next
    // period's Opening. With no date picked it is the live warehouse count.
    {
      id: "closing",
      header: columnHeader("closing", "Closing"),
      width: 120,
      align: "right",
      sortable: true,
      accessor: (row) => row.closingStock ?? null,
      total: (rows) => {
        const withVal = rows.filter((r) => r.closingStock != null);
        if (withVal.length === 0) return null;
        const qty = withVal.reduce((sum, r) => sum + (r.closingStock ?? 0), 0);
        const plt = withVal.reduce((sum, r) => sum + (r.closingPallets ?? 0), 0);
        return stackedCell(qty, plt, qty < 0 ? "text-red-600" : "text-gray-900");
      },
      headerClassName: headerBorder,
      cellClassName: cellBorder,
      render: (row) => {
        if (row.isEmptyBox || row.closingStock == null) return dash;
        return (
          <span title="Opening + Purchase − Sale — stock on hand at the end of this period.">
            {stackedCell(row.closingStock, row.closingPallets, row.closingStock < 0 ? "text-red-600" : "text-gray-900")}
          </span>
        );
      },
    },
    ...(isAdminOrSuper ? [{
      id: "actions",
      header: "",
      hideable: false,
      totalable: false,
      width: 96,
      align: "center" as const,
      render: (row: PlantStockRow) =>
        !row.isEmptyBox && row.barcode ? (
          <div className="flex items-center justify-center gap-0.5" onClick={(e) => e.stopPropagation()}>
            {/* One button on every row — the plant is picked inside the dialog (see editPlantOptions),
                so merged All/State rows no longer need the small per-plant menu. */}
            {isAdminOrSuper && (
              <Button
                size="sm" variant="ghost" className="h-7 w-7 p-0 text-gray-400 hover:text-[#001d6e]"
                title="Adjust this item's stock"
                onClick={(e) => { e.stopPropagation(); openEditDialog(row); }}
              >
                <Pencil className="h-3.5 w-3.5" />
              </Button>
            )}
            {isAdminOrSuper && plantScopedAction(
              row, <Trash2 className="h-3.5 w-3.5" />, "Delete this item — removes it and its scan history entirely", "hover:text-red-600",
              (target) => { setDeleteTarget(target); setDeleteConfirmText(""); },
            )}
          </div>
        ) : null,
    } satisfies DataTableColumn<PlantStockRow>] : []),
  ];

  // Tab-button style shared by the Details/History switch and the Scanning/Unloading switch
  // inside it — same look as the Single date/Date range toggle above.
  const detailTabButton = (active: boolean) =>
    `rounded-md border px-2.5 py-1 text-xs font-medium ${
      active ? "border-[#001d6e] bg-[#001d6e]/5 text-[#001d6e]" : "border-gray-300 text-gray-600 hover:bg-gray-50"
    }`;

  // Details tab — one row per plant folded into detailRow (just one, for a normal row), each
  // paired with its Scanning-vs-Unloading contribution split from sourceBreakdownData. Looked up
  // from the raw, ungrouped `rows` (not `filtered`) so this always shows the real full picture
  // regardless of whatever search/column filters happen to be active on the table itself.
  const detailPlantRows = detailPlants.map((plant) => ({
    plant,
    stock: rows.find((r) => r.barcode === detailRow?.barcode && r.plant === plant) ?? null,
    breakdown: sourceBreakdownData?.breakdown.find((b) => normalizedText(b.plant) === normalizedText(plant)) ?? null,
  }));

  // overflow-x-visible below sm: a horizontal scroller nested inside the main table's own
  // horizontally-scrolling wrapper (data-table.tsx) is exactly what made this feel broken on a
  // small/touch screen — two scroll surfaces fighting over the same swipe. Letting this table's
  // own width just overflow lets the ONE outer scrollbar handle it there instead; at sm and up
  // there's enough room (and a mouse, not a finger) for the self-contained scroll to stay
  // pleasant rather than confusing.
  const detailsTabContent = (
    <div className="max-h-[360px] overflow-y-auto overflow-x-visible sm:overflow-x-auto border border-gray-300">
      <table className="w-max border-collapse text-xs">
        <thead>
          <tr className="border-b-2 border-gray-300 bg-gray-100 text-left text-gray-600 sticky top-0">
            <th className="border-r border-gray-300 px-2 py-2 font-semibold">Plant</th>
            <th className="border-r border-gray-300 px-2 py-2 text-right font-semibold">Expected</th>
            <th className="border-r border-gray-300 px-2 py-2 text-right font-semibold">Opening</th>
            <th className="border-r border-gray-300 px-2 py-2 text-right font-semibold">Purchase</th>
            <th className="border-r border-gray-300 px-2 py-2 text-right font-semibold">Adjust</th>
            <th className="border-r border-gray-300 px-2 py-2 text-right font-semibold" title="Moved in from (+) / out to (−) another plant">Transfer</th>
            <th className="border-r border-gray-300 px-2 py-2 text-right font-semibold">Stock</th>
            <th className="border-r border-gray-300 px-2 py-2 text-right font-semibold">Extra</th>
            <th className="border-r border-gray-300 px-2 py-2 text-right font-semibold">Sale</th>
            <th className="border-r border-gray-300 px-2 py-2 text-right font-semibold">Expected Sale</th>
            <th className="border-r border-gray-300 px-2 py-2 text-right font-semibold">Via Scan Order</th>
            <th className="border-r border-gray-300 px-2 py-2 text-right font-semibold">Via Unloading</th>
            <th className="px-2 py-2 text-right font-semibold">Via Adjust</th>
          </tr>
        </thead>
        <tbody>
          {sourceBreakdownLoading && !sourceBreakdownData ? (
            <tr><td colSpan={13} className="p-0"><SectionSkeleton lines={3} /></td></tr>
          ) : detailPlantRows.map(({ plant, stock, breakdown }) => (
            <tr key={plant} className="border-b border-gray-200 bg-white">
              <td className="border-r border-gray-200 px-2 py-2 font-medium text-gray-900">{plant}</td>
              <td className="border-r border-gray-200 px-2 py-2 text-right">{stackedCell(stock?.expectedQty, stock?.expectedPallets, "text-purple-700")}</td>
              <td className="border-r border-gray-200 px-2 py-2 text-right tabular-nums text-gray-700">{stock?.openingStock ? stock.openingStock : <span className="text-gray-300">—</span>}</td>
              <td className="border-r border-gray-200 px-2 py-2 text-right tabular-nums text-gray-700">{stock?.inStock ? stock.inStock : <span className="text-gray-300">—</span>}</td>
              <td className="border-r border-gray-200 px-2 py-2 text-right tabular-nums text-gray-700">{stock?.adjustQty ? stock.adjustQty : <span className="text-gray-300">—</span>}</td>
              <td className="border-r border-gray-200 px-2 py-2 text-right tabular-nums text-gray-700">{(stock?.transferIn || stock?.transferOut) ? ((stock.transferIn ?? 0) - (stock.transferOut ?? 0)) : <span className="text-gray-300">—</span>}</td>
              <td className="border-r border-gray-200 px-2 py-2 text-right font-bold tabular-nums text-[#001d6e]">{stock?.closingStock ?? 0}</td>
              <td className="border-r border-gray-200 px-2 py-2 text-right tabular-nums text-amber-600">{stock?.extraQty ? stock.extraQty : <span className="text-gray-300">—</span>}</td>
              <td className="border-r border-gray-200 px-2 py-2 text-right tabular-nums text-emerald-600">{stock?.saleQty != null ? stock.saleQty : <span className="text-gray-300">—</span>}</td>
              <td className="border-r border-gray-200 px-2 py-2 text-right">{stackedCell(stock?.expectedSaleQty, stock?.expectedSalePallets, "text-purple-700")}</td>
              <td className="border-r border-gray-200 px-2 py-2 text-right tabular-nums text-gray-700">{breakdown?.scanningQty ? breakdown.scanningQty : <span className="text-gray-300">—</span>}</td>
              <td className="border-r border-gray-200 px-2 py-2 text-right tabular-nums text-gray-700">{breakdown?.unloadingQty ? breakdown.unloadingQty : <span className="text-gray-300">—</span>}</td>
              <td className="px-2 py-2 text-right tabular-nums text-gray-700">{stock?.adjustQty ? stock.adjustQty : <span className="text-gray-300">—</span>}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );

  // Parties tab — which parties ordered this item and how much, merged across every one of
  // their orders (see /reports/party-breakdown's own comment) so a party that ordered it 5
  // times shows as one row, not 5. Each row expands into a dropdown of the individual proforma
  // slips (order number + order date) that made up its total.
  const togglePartyExpanded = (partyName: string) => {
    setExpandedParties((prev) => {
      const next = new Set(prev);
      if (next.has(partyName)) next.delete(partyName); else next.add(partyName);
      return next;
    });
  };
  const partiesTabContent = (
    <div className="max-h-[360px] overflow-y-auto border border-gray-300">
      <table className="w-full border-collapse text-xs">
        <thead>
          <tr className="border-b-2 border-gray-300 bg-gray-100 text-left text-gray-600 sticky top-0">
            <th className="border-r border-gray-300 px-3 py-2 font-semibold">Party</th>
            <th className="border-r border-gray-300 px-3 py-2 text-right font-semibold">Total Qty</th>
            <th className="px-3 py-2 text-right font-semibold">Orders</th>
          </tr>
        </thead>
        <tbody>
          {partyBreakdownLoading && !partyBreakdownData ? (
            <tr><td colSpan={3} className="p-0"><SectionSkeleton lines={3} /></td></tr>
          ) : (partyBreakdownData?.parties?.length ?? 0) === 0 ? (
            <tr><td colSpan={3} className="py-6 text-center text-gray-400">No proforma orders for this item yet.</td></tr>
          ) : partyBreakdownData!.parties.map((p) => {
            const isExpanded = expandedParties.has(p.partyName);
            return (
              <Fragment key={p.partyName}>
                <tr
                  className="cursor-pointer border-b border-gray-200 bg-white hover:bg-gray-50"
                  onClick={() => togglePartyExpanded(p.partyName)}
                >
                  <td className="border-r border-gray-200 px-3 py-2 font-medium text-gray-900">
                    <span className="flex items-center gap-1.5">
                      <ChevronDown className={`h-3.5 w-3.5 shrink-0 text-gray-400 transition-transform ${isExpanded ? "rotate-180" : ""}`} />
                      {p.partyName}
                    </span>
                  </td>
                  <td className="border-r border-gray-200 px-3 py-2 text-right font-bold tabular-nums text-[#001d6e]">{p.qty.toLocaleString()}</td>
                  <td className="px-3 py-2 text-right tabular-nums text-gray-700">{p.orderCount}</td>
                </tr>
                {isExpanded && (
                  <tr className="border-b border-gray-200 bg-gray-50">
                    <td colSpan={3} className="px-3 py-2">
                      <table className="w-full border-collapse text-[11px]">
                        <thead>
                          <tr className="text-left text-gray-500">
                            <th className="border-b border-gray-200 py-1 font-semibold">Proforma Slip No.</th>
                            <th className="border-b border-gray-200 py-1 font-semibold">Order Date</th>
                            <th className="border-b border-gray-200 py-1 text-right font-semibold">Qty</th>
                          </tr>
                        </thead>
                        <tbody>
                          {p.orders.map((o, i) => (
                            <tr key={`${o.orderNumber}-${i}`}>
                              <td className="py-1 text-gray-800">{o.orderNumber}</td>
                              <td className="py-1 text-gray-600 whitespace-nowrap">
                                {/* orderDate comes back as a full ISO datetime string (a `date`
                                    column serialized through a JS Date), not plain YYYY-MM-DD —
                                    slice to just the date part before treating it as local
                                    midnight, or appending T00:00:00 onto an already-ISO string
                                    produces an invalid date. */}
                                {o.orderDate ? format(new Date(`${o.orderDate.slice(0, 10)}T00:00:00`), "MMM d, yyyy") : "—"}
                              </td>
                              <td className="py-1 text-right tabular-nums text-gray-800">{o.qty.toLocaleString()}</td>
                            </tr>
                          ))}
                        </tbody>
                      </table>
                    </td>
                  </tr>
                )}
              </Fragment>
            );
          })}
        </tbody>
      </table>
    </div>
  );

  // History tab — Scan Order, Unloading, Loading and Adjust are four separate lists (their own
  // separate queries, see the useQuery calls above), never merged into one table. Each tab shows
  // only its own source: this one is Order Scan's rows, not the whole ledger. A state-combined
  // row's entries carry a Plant column since they span more than one; a normal single-plant row
  // just repeats the same plant on every line, which is harmless.
  const scanningHistoryContent = scanningHistoryLoading ? (
    <SectionSkeleton lines={3} />
  ) : (scanningHistoryData?.items?.length ?? 0) === 0 ? (
    <p className="py-6 text-center text-sm text-gray-400">No Scan Order movements yet for this item.</p>
  ) : (
    <div className="max-h-[360px] overflow-y-auto border border-gray-300">
      <table className="w-full border-collapse text-xs">
        <thead>
          <tr className="border-b-2 border-gray-300 bg-gray-100 text-left text-gray-600 sticky top-0">
            <th className="border-r border-gray-300 px-3 py-2 font-semibold">Date &amp; Movement</th>
            {detailPlants.length > 1 && <th className="border-r border-gray-300 px-3 py-2 font-semibold">Plant</th>}
            <th className="border-r border-gray-300 px-3 py-2 font-semibold">Order / CSV</th>
            <th className="border-r border-gray-300 px-3 py-2 font-semibold">Order Date</th>
            <th className="border-r border-gray-300 px-3 py-2 text-right font-semibold">Qty</th>
            <th className="px-3 py-2 text-right font-semibold">Extra</th>
          </tr>
        </thead>
        <tbody>
          {scanningHistoryData!.items.map((m) => {
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
                    <span>{m.arrivedAt ? format(new Date(m.arrivedAt), "MMM d, yyyy · h:mm:ss a") : "—"}</span>
                    {movementBadge}
                  </div>
                </td>
                {detailPlants.length > 1 && <td className="border-r border-gray-200 px-3 py-2 text-gray-600">{m.plant}</td>}
                <td className="border-r border-gray-200 px-3 py-2 text-gray-600">
                  {m.orderName ? (
                    m.orderName
                  ) : (
                    <span className="text-gray-400" title={m.reason ?? undefined}>{m.reason ?? "—"}</span>
                  )}
                </td>
                <td className="border-r border-gray-200 px-3 py-2 text-gray-600 whitespace-nowrap">
                  {m.orderDate ? format(new Date(`${m.orderDate}T00:00:00`), "MMM d, yyyy") : <span className="text-gray-300">—</span>}
                </td>
                <td className={`border-r border-gray-200 px-3 py-2 text-right font-bold tabular-nums ${isNegative ? "text-red-500" : "text-[#001d6e]"}`}>
                  {isNegative ? m.qty : `+${m.qty}`}
                </td>
                <td className="px-3 py-2 text-right tabular-nums text-amber-600">
                  {m.extraQty ? (m.extraQty < 0 ? m.extraQty : `+${m.extraQty}`) : <span className="text-gray-300">—</span>}
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );

  const unloadingHistoryContent = unloadingHistoryLoading ? (
    <SectionSkeleton lines={3} />
  ) : (unloadingHistoryData?.items?.length ?? 0) === 0 ? (
    <p className="py-6 text-center text-sm text-gray-400">No unloading movements yet for this item.</p>
  ) : (
    <div className="max-h-[360px] overflow-y-auto border border-gray-300">
      <table className="w-full border-collapse text-xs">
        <thead>
          <tr className="border-b-2 border-gray-300 bg-gray-100 text-left text-gray-600 sticky top-0">
            <th className="border-r border-gray-300 px-3 py-2 font-semibold">Date &amp; Movement</th>
            {detailPlants.length > 1 && <th className="border-r border-gray-300 px-3 py-2 font-semibold">Plant</th>}
            <th className="border-r border-gray-300 px-3 py-2 font-semibold">Vehicle</th>
            <th className="border-r border-gray-300 px-3 py-2 font-semibold">Order Date</th>
            <th className="px-3 py-2 text-right font-semibold">Qty</th>
          </tr>
        </thead>
        <tbody>
          {unloadingHistoryData!.items.map((m) => {
            const movementBadge = m.voided
              ? <span className="inline-block bg-gray-200 px-1.5 py-0.5 text-[10px] font-semibold uppercase tracking-wide text-gray-600">Voided</span>
              : m.isExtra
              ? <span className="inline-block bg-amber-100 px-1.5 py-0.5 text-[10px] font-semibold uppercase tracking-wide text-amber-700">Extra</span>
              : <span className="inline-block bg-emerald-100 px-1.5 py-0.5 text-[10px] font-semibold uppercase tracking-wide text-emerald-700">Received</span>;
            return (
              <tr key={m.id} className="border-b border-gray-200 bg-white">
                <td className="border-r border-gray-200 px-3 py-2 whitespace-nowrap">
                  <div className="flex flex-col gap-1">
                    <span>{m.scannedAt ? format(new Date(m.scannedAt), "MMM d, yyyy · h:mm:ss a") : "—"}</span>
                    {movementBadge}
                  </div>
                </td>
                {detailPlants.length > 1 && <td className="border-r border-gray-200 px-3 py-2 text-gray-600">{m.plant}</td>}
                <td className="border-r border-gray-200 px-3 py-2 text-gray-600">
                  {m.vehicleNumber ?? <span className="text-gray-300">—</span>}
                </td>
                <td className="border-r border-gray-200 px-3 py-2 text-gray-600 whitespace-nowrap">
                  {m.orderDate ? format(new Date(`${m.orderDate}T00:00:00`), "MMM d, yyyy") : <span className="text-gray-300">—</span>}
                </td>
                <td className={`px-3 py-2 text-right font-bold tabular-nums ${m.voided ? "text-gray-400 line-through" : "text-[#001d6e]"}`}>
                  {m.qty}
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );

  const loadingHistoryContent = loadingHistoryLoading ? (
    <SectionSkeleton lines={3} />
  ) : (loadingHistoryData?.items?.length ?? 0) === 0 ? (
    <p className="py-6 text-center text-sm text-gray-400">No loading (dispatch) movements yet for this item.</p>
  ) : (
    <div className="max-h-[360px] overflow-y-auto border border-gray-300">
      <table className="w-full border-collapse text-xs">
        <thead>
          <tr className="border-b-2 border-gray-300 bg-gray-100 text-left text-gray-600 sticky top-0">
            <th className="border-r border-gray-300 px-3 py-2 font-semibold">Date &amp; Movement</th>
            {detailPlants.length > 1 && <th className="border-r border-gray-300 px-3 py-2 font-semibold">Plant</th>}
            <th className="border-r border-gray-300 px-3 py-2 font-semibold">Order</th>
            <th className="border-r border-gray-300 px-3 py-2 font-semibold">Order Date</th>
            <th className="px-3 py-2 text-right font-semibold">Qty</th>
          </tr>
        </thead>
        <tbody>
          {loadingHistoryData!.items.map((m) => {
            // Stock change: a load takes stock out, so +5 loaded is −5 stock (a Loading Adjust can
            // be negative — loaded less — which puts stock back).
            const stockQty = -m.qty;
            const movementBadge = m.voided
              ? <span className="inline-block bg-gray-200 px-1.5 py-0.5 text-[10px] font-semibold uppercase tracking-wide text-gray-600">Voided</span>
              : m.isAdjust
              ? <span className="inline-block bg-blue-100 px-1.5 py-0.5 text-[10px] font-semibold uppercase tracking-wide text-blue-700">Loading Adjust</span>
              : m.isExtra
              ? <span className="inline-block bg-amber-100 px-1.5 py-0.5 text-[10px] font-semibold uppercase tracking-wide text-amber-700">Extra</span>
              : <span className="inline-block bg-red-100 px-1.5 py-0.5 text-[10px] font-semibold uppercase tracking-wide text-red-700">Dispatched</span>;
            return (
              <tr key={m.id} className="border-b border-gray-200 bg-white">
                <td className="border-r border-gray-200 px-3 py-2 whitespace-nowrap">
                  <div className="flex flex-col gap-1">
                    <span>{m.scannedAt ? format(new Date(m.scannedAt), "MMM d, yyyy · h:mm:ss a") : "—"}</span>
                    {movementBadge}
                  </div>
                </td>
                {detailPlants.length > 1 && <td className="border-r border-gray-200 px-3 py-2 text-gray-600">{m.plant}</td>}
                <td className="border-r border-gray-200 px-3 py-2 text-gray-600">
                  {m.orderNumber ? `#${m.orderNumber}` : <span className="text-gray-300">—</span>}
                </td>
                <td className="border-r border-gray-200 px-3 py-2 text-gray-600 whitespace-nowrap">
                  {m.orderDate ? format(new Date(m.orderDate), "MMM d, yyyy") : <span className="text-gray-300">—</span>}
                </td>
                <td className={`px-3 py-2 text-right font-bold tabular-nums ${m.voided ? "text-gray-400 line-through" : stockQty > 0 ? "text-emerald-600" : "text-red-600"}`}>
                  {stockQty > 0 ? `+${stockQty}` : stockQty}
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );

  // Adjust tab — every change that isn't a Scan Order / Unloading / Loading scan: this page's own
  // Adjust dialog, the Loading Items table's +/- ("Loading Adjust"), and stock corrections like
  // Clear Stock or an exchange. Qty is always the change to stock.
  const adjustHistoryContent = adjustHistoryLoading ? (
    <SectionSkeleton lines={3} />
  ) : (adjustHistoryData?.items?.length ?? 0) === 0 ? (
    <p className="py-6 text-center text-sm text-gray-400">No adjustments yet for this item.</p>
  ) : (
    <div className="max-h-[360px] overflow-y-auto border border-gray-300">
      <table className="w-full border-collapse text-xs">
        <thead>
          <tr className="border-b-2 border-gray-300 bg-gray-100 text-left text-gray-600 sticky top-0">
            <th className="border-r border-gray-300 px-3 py-2 font-semibold">Date &amp; Type</th>
            {detailPlants.length > 1 && <th className="border-r border-gray-300 px-3 py-2 font-semibold">Plant</th>}
            <th className="border-r border-gray-300 px-3 py-2 font-semibold">Details</th>
            <th className="border-r border-gray-300 px-3 py-2 font-semibold">By</th>
            <th className="px-3 py-2 text-right font-semibold">Stock Qty</th>
          </tr>
        </thead>
        <tbody>
          {adjustHistoryData!.items.map((m) => {
            const typeBadge = m.voided
              ? <span className="inline-block bg-gray-200 px-1.5 py-0.5 text-[10px] font-semibold uppercase tracking-wide text-gray-600">Voided</span>
              : m.kind === "loading"
              ? <span className="inline-block bg-blue-100 px-1.5 py-0.5 text-[10px] font-semibold uppercase tracking-wide text-blue-700">Loading Adjust</span>
              : m.kind === "scan"
              ? <span className="inline-block bg-emerald-100 px-1.5 py-0.5 text-[10px] font-semibold uppercase tracking-wide text-emerald-700">Scan Adjust</span>
              : m.kind === "correction"
              ? <span className="inline-block bg-purple-100 px-1.5 py-0.5 text-[10px] font-semibold uppercase tracking-wide text-purple-700">Correction</span>
              : <span className="inline-block bg-slate-200 px-1.5 py-0.5 text-[10px] font-semibold uppercase tracking-wide text-slate-700">Adjust</span>;
            return (
              <tr key={`${m.kind}-${m.id}`} className="border-b border-gray-200 bg-white">
                <td className="border-r border-gray-200 px-3 py-2 whitespace-nowrap">
                  <div className="flex flex-col gap-1">
                    <span>{m.at ? format(new Date(m.at), "MMM d, yyyy · h:mm:ss a") : "—"}</span>
                    {typeBadge}
                  </div>
                </td>
                {detailPlants.length > 1 && <td className="border-r border-gray-200 px-3 py-2 text-gray-600">{m.plant}</td>}
                <td className="border-r border-gray-200 px-3 py-2 text-gray-600">
                  {m.kind === "loading" ? (
                    <div className="flex flex-col">
                      <span>{m.orderNumber ? `#${m.orderNumber}` : "—"}</span>
                      <span className="text-[11px] text-gray-400">
                        {(m.loadedQty ?? 0) > 0 ? `Loaded +${m.loadedQty}` : `Loaded ${m.loadedQty}`}
                        {m.orderDate ? ` · ${format(new Date(`${m.orderDate}T00:00:00`), "MMM d, yyyy")}` : ""}
                      </span>
                    </div>
                  ) : m.kind === "scan" ? (
                    <div className="flex flex-col">
                      <span>{m.orderNumber ?? "—"}</span>
                      <span className="text-[11px] text-gray-400">
                        {m.reason ?? ""}
                        {m.orderDate ? ` · ${format(new Date(`${m.orderDate}T00:00:00`), "MMM d, yyyy")}` : ""}
                      </span>
                    </div>
                  ) : (
                    m.reason ?? <span className="text-gray-300">—</span>
                  )}
                </td>
                <td className="border-r border-gray-200 px-3 py-2 text-gray-600">{m.byName ?? <span className="text-gray-300">—</span>}</td>
                <td className={`px-3 py-2 text-right font-bold tabular-nums ${m.voided ? "text-gray-400 line-through" : m.stockQty > 0 ? "text-emerald-600" : "text-red-600"}`}>
                  {m.stockQty > 0 ? `+${m.stockQty}` : m.stockQty}
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );

  // Inline Details/History drill-down — rendered as the DataTable's expanded row when an item
  // name is clicked (detailRow set). Sticky-left so it stays visible regardless of how far the
  // wide, side-scrolling table is scrolled; widened to max-w-[95vw] (from max-w-3xl) so the
  // Details tab's 12 columns fit without needing their own inner scrollbar on a normal screen.
  const movementsPanel = (
    <div className="sticky left-0 w-full max-w-[95vw] bg-gray-50 p-3">
      <div className="mb-2 flex flex-wrap items-center gap-x-2 gap-y-0.5 text-[#001d6e]">
        <History className="h-4 w-4 shrink-0" />
        <span className="text-sm font-semibold">{detailRow?.itemName ?? "Item"}</span>
        <span className="font-mono text-xs text-gray-400">
          {detailRow?.barcode} · {detailPlants.length > 1 ? `${detailRow?.plant} (${detailPlants.join(", ")})` : detailRow?.plant}
        </span>
      </div>

      <div className="mb-2 flex flex-wrap items-center gap-1.5">
        <button type="button" onClick={() => setDetailTab("details")} className={detailTabButton(detailTab === "details")}>Details</button>
        <button type="button" onClick={() => setDetailTab("parties")} className={detailTabButton(detailTab === "parties")}>Parties</button>
        <button type="button" onClick={() => setDetailTab("history")} className={detailTabButton(detailTab === "history")}>History</button>
      </div>

      {detailTab === "details" ? detailsTabContent : detailTab === "parties" ? partiesTabContent : (
        <div className="space-y-2">
          <div className="flex flex-wrap items-center gap-1.5">
            <button type="button" onClick={() => setHistorySource("scanning")} className={detailTabButton(historySource === "scanning")}>Scan Order</button>
            <button type="button" onClick={() => setHistorySource("unloading")} className={detailTabButton(historySource === "unloading")}>Unloading</button>
            <button type="button" onClick={() => setHistorySource("loading")} className={detailTabButton(historySource === "loading")}>Loading</button>
            <button type="button" onClick={() => setHistorySource("adjust")} className={detailTabButton(historySource === "adjust")}>Adjust</button>
          </div>
          {historySource === "scanning" ? scanningHistoryContent
            : historySource === "unloading" ? unloadingHistoryContent
            : historySource === "loading" ? loadingHistoryContent
            : adjustHistoryContent}
        </div>
      )}
    </div>
  );

  return (
    <div className="flex-1 overflow-y-auto overflow-x-hidden p-4 lg:p-6">
      <div className="mx-auto w-full max-w-[1800px] space-y-4">
        {/* Title, summary tiles and the View/State/Plant tabs stay pinned to the top of the
            page's own scroll container while the table below scrolls underneath — same
            "sticky top-0 bg-... " treatment applied to the Scan Operations page's desktop
            header (client/src/pages/Scanning/Scan.tsx), so this context is never lost while
            scrolling a long/paginated table. bg-white matches the page shell (Layout.tsx's
            <main>), not this div's own (unset) background. */}
        {/* z-30, not z-20: the DataTable's own pinned-column header cells (stickyColumnIds
            below) are also `position: sticky` at z-20 — tied z-index + later-in-DOM meant the
            table won the stacking order and painted over this header as it scrolled past.
            -mt-4 lg:-mt-6, not just -mx-: top-0 only occupies space from the scroll container's
            own padding edge downward — it does NOT retroactively cover that container's OWN top
            padding (p-4 lg:p-6 on the root below). That strip was never opaque, so the table
            scrolling behind it peeked through right above this header. Pulling the sticky div up
            by the same amount (then re-adding it as this div's own pt-4/lg:pt-6, already below)
            puts the opaque bg-white flush with the true scrollport top instead. */}
        <div className="-mx-5 -mt-4 space-y-3 bg-white px-4 pb-2 pt-4 lg:-mx-7 lg:-mt-6 lg:space-y-2 lg:px-6 lg:pt-3">
        <PageHeader
          icon={LayoutList}
          title="Stock Overview"
          description="Plant-wise stock ledger — Opening, Purchase, Adjust, Sale (loaded) and Closing for the date you pick, or since Stock Tracking Start."
        />

        {/* Summary tiles — the figure, its name, then ONE detail line (period · pallets). The
            details used to be a line each, which made the tiles different heights and pushed the
            numbers out of alignment across the row. */}
        <StatsBar
          className="rounded-xl shadow-none border-gray-300 [&_.divide-x]:divide-gray-300"
          wrapLabels
          singleRow
          stats={[
            {
              icon: CalendarDays,
              tone: "navy" as const,
              value: expectedTotal.toLocaleString(),
              label: "Expected Purchase",
              hint: `${periodLabel} · ${pltLabel(expectedPalletsTotal)}`,
            },
            {
              icon: History,
              tone: "navy" as const,
              value: totalOpening.toLocaleString(),
              label: "Opening",
              hint: `Start of period · ${pltLabel(totalOpeningPallets)}`,
            },
            {
              icon: Boxes,
              tone: "navy" as const,
              value: totalPurchase.toLocaleString(),
              label: "Purchase",
              hint: [
                // Extra is already inside this total — it is only broken out here.
                `${pltLabel(totalPurchasePallets)}${totalExtra > 0 ? ` · +${totalExtra.toLocaleString()} extra` : ""}`,
                activePlant ? activePlant
                  : activeState ? `${activeState} (${activeStateGroup?.plants.map((p) => p.name).join(", ") ?? activeState})`
                  : allowedPlants && allowedPlants.length ? plantOptions.join(", ") : "All Plants",
              ],
            },
            {
              icon: ShoppingCart,
              tone: "navy" as const,
              value: expectedSaleTotal.toLocaleString(),
              label: "Expected Sale",
              hint: `${periodLabel} · ${pltLabel(expectedSalePalletsTotal)}`,
            },
            {
              icon: ShoppingCart,
              tone: "emerald" as const,
              value: totalSale.toLocaleString(),
              label: "Sale (loaded)",
              hint: `${periodLabel} · ${pltLabel(totalSalePallets)}`,
            },
            {
              icon: TrendingUp,
              tone: totalClosing < 0 ? "amber" as const : "navy" as const,
              value: totalClosing.toLocaleString(),
              label: "Closing",
              hint: `End of period · ${pltLabel(totalClosingPallets)}`,
            },
          ]}
        />

        {/* Extra tab — narrows the whole table down to just items with extra (over-order) stock.
            A toggle rather than a chip-based filter, since it's a single yes/no dimension that
            also has to change what the server sends (extraQty means different things in and out
            of dateMode), not something matched against an already-loaded row. */}
        <div className="flex flex-wrap items-center gap-1.5">
          <span className="mr-1 text-[11px] font-semibold uppercase tracking-wide text-gray-400">View</span>
          <button
            onClick={() => { setExtrasOnly(false); setMovedOnly(false); }}
            className={
              !extrasOnly && !movedOnly
                ? "rounded-full bg-[#001d6e] px-3.5 py-1.5 text-xs font-semibold text-white ring-2 ring-[#001d6e]/30"
                : "rounded-full border border-gray-200 bg-white px-3.5 py-1.5 text-xs font-medium text-gray-600 hover:bg-gray-50"
            }
          >
            All Stock
          </button>
          <button
            onClick={() => { setExtrasOnly(true); setMovedOnly(false); }}
            className={
              extrasOnly
                ? "rounded-full bg-amber-500 px-3.5 py-1.5 text-xs font-semibold text-white ring-2 ring-amber-500/30"
                : "rounded-full border border-gray-200 bg-white px-3.5 py-1.5 text-xs font-medium text-gray-600 hover:bg-gray-50"
            }
          >
            Extra Only
          </button>
          <button
            onClick={() => { setMovedOnly(true); setExtrasOnly(false); }}
            title="Only items where stock moved in from, or out to, another plant"
            className={
              movedOnly
                ? "rounded-full bg-sky-600 px-3.5 py-1.5 text-xs font-semibold text-white ring-2 ring-sky-600/30"
                : "rounded-full border border-gray-200 bg-white px-3.5 py-1.5 text-xs font-medium text-gray-600 hover:bg-gray-50"
            }
          >
            Moved Stock
          </button>
        </div>

        {/* State tabs — quick switch to view a whole state's combined stock (or All). Picking a
            state with more than one plant under it reveals a second, nested pill row below to
            narrow down to one specific plant within that state; a single-plant state (e.g. MP)
            needs no nested row since the state view already IS that one plant's view. */}
        {visibleStateGroups.length > 0 && (
          <div className="flex flex-wrap items-center gap-1.5">
            <span className="mr-1 text-[11px] font-semibold uppercase tracking-wide text-gray-400">State</span>
            <button
              onClick={() => setStateTab("")}
              className={
                activeState === ""
                  ? "rounded-full bg-[#001d6e] px-3.5 py-1.5 text-xs font-semibold text-white ring-2 ring-[#001d6e]/30"
                  : "rounded-full border border-gray-200 bg-white px-3.5 py-1.5 text-xs font-medium text-gray-600 hover:bg-gray-50"
              }
            >
              All
            </button>
            {visibleStateGroups.map((g) => (
              <button
                key={g.state}
                onClick={() => setStateTab(g.state)}
                className={
                  activeState === g.state
                    ? "rounded-full bg-[#001d6e] px-3.5 py-1.5 text-xs font-semibold text-white ring-2 ring-[#001d6e]/30"
                    : "rounded-full border border-gray-200 bg-white px-3.5 py-1.5 text-xs font-medium text-gray-600 hover:bg-gray-50"
                }
              >
                {g.state}
              </button>
            ))}
          </div>
        )}

        {/* Nested plant switch — only for a state with multiple plants, so a single-plant state
            never shows a redundant one-pill row. */}
        {activeStateGroup && activeStateGroup.plants.length > 1 && (
          <div className="flex flex-wrap items-center gap-1.5 pl-1">
            <span className="mr-1 text-[11px] font-semibold uppercase tracking-wide text-gray-400">Plant</span>
            <button
              onClick={() => setPlantTab("")}
              className={
                activePlant === ""
                  ? "rounded-full bg-[#001d6e]/80 px-3 py-1 text-xs font-semibold text-white ring-2 ring-[#001d6e]/30"
                  : "rounded-full border border-gray-200 bg-white px-3 py-1 text-xs font-medium text-gray-600 hover:bg-gray-50"
              }
            >
              All {activeStateGroup.state}
            </button>
            {activeStateGroup.plants.map((p) => {
              const isSel = activePlant.toUpperCase() === p.name.toUpperCase();
              return (
                <button
                  key={p.name}
                  onClick={() => setPlantTab(p.name)}
                  style={p.bgColor ? { backgroundColor: p.bgColor, color: p.textColor, borderColor: p.borderColor } : undefined}
                  className={`rounded-full px-3 py-1 text-xs font-semibold ${
                    p.bgColor ? "border" : "border border-gray-200 bg-white text-gray-600 hover:bg-gray-50"
                  } ${isSel ? "ring-2 ring-[#001d6e] ring-offset-1" : ""}`}
                >
                  {p.name}
                </button>
              );
            })}
          </div>
        )}

        </div>

        {/* Table card — search, sort, every filter (Plant/Date + column filters), column
            visibility, and export all live in this one row now, right under the table title. */}
        <TableCard
          icon={LayoutList}
          title="Stock by Plant"
          subtitle={
            search
              ? `${filtered.length} of ${rows.length} rows`
              : isMergedView
                ? `${groupedByState.length} item${groupedByState.length === 1 ? "" : "s"} · combined across plants`
                : `${rows.length} item · plant rows`
          }
          className="rounded-xl shadow-none border-gray-300"
          headerActions={
            <>
              <Button
                type="button"
                variant="outline"
                size="icon"
                onClick={() => {
                  // Reloads the stock list AND every stock history/detail query, not just the table.
                  refetchStock();
                  queryClient.invalidateQueries({
                    predicate: (q) => {
                      const key = String(q.queryKey[0] ?? "");
                      return key.startsWith("/api/scan-sessions/reports") || key.startsWith("/api/plant-stock");
                    },
                  });
                }}
                disabled={isStockFetching}
                title="Refresh stock now (the page also refreshes itself every 30 seconds)"
                className="h-8 w-8 rounded-md border-gray-300 text-gray-600 hover:bg-gray-50"
              >
                <RotateCw className={`h-3.5 w-3.5 ${isStockFetching ? "animate-spin" : ""}`} />
              </Button>

              <CollapsibleSearch
                value={search}
                onChange={(v) => setSearch(v)}
                placeholder="Sr No, item, barcode, SAP, category…"
              />


            {/* Two buttons, one filter. "Filter by date" offers ONLY the named ranges
                (Today / Yesterday / This week / This month); "Calendar" is where a single date or a
                from/to range is picked. Both write the same value, so each reflects the other.
                Deliberately not the shared SingleDateFilter: that offers Today/Tomorrow/Yesterday and
                is single-date only, so it can express neither of those two requirements. */}
            <div className="flex items-center gap-1">
              <Popover open={dateOpen} onOpenChange={setDateOpen}>
                <PopoverTrigger asChild>
                  <Button
                    size="sm"
                    variant="outline"
                    className={`h-8 gap-1.5 rounded-md text-xs font-medium ${dateValue ? "border-[#001d6e] bg-[#001d6e]/5 text-[#001d6e]" : "border-gray-300 text-gray-600 hover:bg-gray-50"}`}
                  >
                    <CalendarDays className="h-3.5 w-3.5" />
                    {/* Shows what's actually applied — a single date, or "from – to" for a
                        range — so the filter is readable without opening either panel. */}
                    {dateValue ? describeSimpleFilter("date", dateValue).replace("Date: ", "") : "Filter by date"}
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
                <PopoverContent align="end" sideOffset={6} avoidCollisions={false} className="w-72">
                  {dateQuickBody}
                </PopoverContent>
              </Popover>

              <Popover open={dateCalOpen} onOpenChange={(o) => { setDateCalOpen(o); if (o) setDatePickMode(dateIsRange ? "range" : "single"); }}>
                <PopoverTrigger asChild>
                  <Button size="sm" variant="outline" className="h-8 rounded-md border-gray-300 text-xs font-medium text-gray-500 hover:bg-gray-50">
                    Calendar
                  </Button>
                </PopoverTrigger>
                <PopoverContent align="end" sideOffset={6} avoidCollisions={false} className="w-72">
                  {dateCustomBody}
                </PopoverContent>
              </Popover>
            </div>


              {/* One unified "+ Filter" — every column in the same searchable list. Plant is
                  the tab strip; Date has its own pair of buttons above. */}
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

              {/* Plant/State are excluded — they're owned by the state/plant tabs, so Clear all
                  neither counts nor clears them (that would silently switch the tabs back to All). */}
              {(activeFilters.some((f) => f.value && f.field !== "plant" && f.field !== "state") || Object.keys(columnConditions).length > 0) && (
                <Button
                  size="sm"
                  variant="ghost"
                  className="h-8 px-2 text-xs text-gray-500 hover:text-gray-900"
                  onClick={() => { setActiveFilters((prev) => prev.filter((f) => f.field === "plant" || f.field === "state")); setColumnConditions({}); }}
                >
                  Clear all
                </Button>
              )}

              {/* Every active filter (Plant/Date + column filters) in one list, in case the
                  individual chips scroll out of view or there are too many to scan at a glance. */}
              {(activeFilters.filter((f) => f.value && f.field !== "plant" && f.field !== "state").length + Object.keys(columnConditions).length) > 0 && (
                <Popover open={editFilterOpen} onOpenChange={(o) => { setEditFilterOpen(o); if (!o) setEditFilterKey(""); }}>
                  <PopoverTrigger asChild>
                    <Button size="sm" variant="outline" className={FILTER_BTN_CLASS}>
                      <ListFilter className="h-3.5 w-3.5 mr-1" />
                      Filters ({activeFilters.filter((f) => f.value && f.field !== "plant" && f.field !== "state").length + Object.keys(columnConditions).length})
                    </Button>
                  </PopoverTrigger>
                  {/* One place to see AND change every applied filter. Editing drills down inside
                      this same popover (list → builder → Back), the way "+ Filter" already works,
                      rather than opening a popover within a popover. */}
                  <PopoverContent align="start" className="w-72">
                    {editFilterColumn ? (
                      <div className="space-y-2">
                        <button
                          type="button"
                          onClick={() => setEditFilterKey("")}
                          className="flex items-center gap-1 text-[11px] text-gray-400 hover:text-gray-600"
                        >
                          <ChevronLeft className="h-3 w-3" /> Back to filters
                        </button>
                        <ColumnFilterPopoverContent
                          column={editFilterColumn}
                          initial={columnConditions[editFilterColumn.id]}
                          onApply={(c) => { setColumnCondition(editFilterColumn.id, c); setEditFilterKey(""); }}
                          onClear={() => { clearColumnCondition(editFilterColumn.id); setEditFilterKey(""); }}
                          onCancel={() => setEditFilterKey("")}
                        />
                      </div>
                    ) : (
                      <div className="space-y-0.5">
                        <p className="mb-1 text-[11px] font-semibold uppercase tracking-wide text-gray-500">Active filters</p>
                        {activeFilters.filter((f) => f.value && f.field !== "plant" && f.field !== "state").map((f) => (
                          <div key={f.id} className="flex items-center justify-between gap-2 rounded text-xs hover:bg-gray-50">
                            {/* Clicking an applied filter reopens its editor. Date gets the full
                                control — single/range toggle, the inputs AND the quick ranges —
                                since editing it should offer every way of changing it. */}
                            <button
                              type="button"
                              onClick={() => {
                                if (f.field !== "date") return;
                                setEditFilterOpen(false);
                                setDateOpen(true);
                              }}
                              disabled={f.field !== "date"}
                              className="flex min-w-0 flex-1 items-center gap-1.5 px-1.5 py-1 text-left text-gray-700 enabled:hover:text-[#001d6e] disabled:cursor-default"
                              title={f.field === "date" ? "Edit this filter" : undefined}
                            >
                              {f.field === "date" && <Pencil className="h-3 w-3 shrink-0 opacity-40" />}
                              <span className="truncate">{describeSimpleFilter(f.field, f.value)}</span>
                            </button>
                            <button type="button" onClick={() => removeFilter(f.id)} className="mr-1.5 shrink-0 text-gray-400 hover:text-red-500" aria-label="Remove filter">
                              <X className="h-3.5 w-3.5" />
                            </button>
                          </div>
                        ))}
                        {Object.entries(columnConditions).map(([columnId, condition]) => (
                          <div key={columnId} className="flex items-center justify-between gap-2 rounded text-xs hover:bg-gray-50">
                            {/* The summary itself is the edit control — clicking it opens this
                                filter's builder pre-filled, so it can be changed in place. */}
                            <button
                              type="button"
                              onClick={() => setEditFilterKey(columnId)}
                              className="flex min-w-0 flex-1 items-center gap-1.5 px-1.5 py-1 text-left text-gray-700 hover:text-[#001d6e]"
                              title="Edit this filter"
                            >
                              <Pencil className="h-3 w-3 shrink-0 opacity-40" />
                              <span className="truncate">{conditionSummary(condition, filterableColumns)}</span>
                            </button>
                            <button type="button" onClick={() => clearColumnCondition(columnId)} className="mr-1.5 shrink-0 text-gray-400 hover:text-red-500" aria-label="Remove filter">
                              <X className="h-3.5 w-3.5" />
                            </button>
                          </div>
                        ))}
                      </div>
                    )}
                  </PopoverContent>
                </Popover>
              )}

              <DataTableColumnToggle
              columnOrder={columnOrder}
              onColumnOrderChange={setColumnOrder}
                columns={stockColumns}
                visibleColumnIds={visibleColumnIds}
                onToggleColumn={toggleColumn}
                onSetAll={(visible) => setVisibleColumnIds(visible ? new Set(stockColumns.map((c) => c.id)) : new Set())}
                buttonClassName={FILTER_BTN_CLASS}
              />

              {/* One Export control instead of three buttons; the format is picked from the menu. */}
              <div >
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
                          const suffix = `${activePlant ? "-" + activePlant : activeState ? "-" + activeState : ""}-${format(new Date(), "yyyy-MM-dd")}`;
                          if (fmt === "CSV")   downloadCsv(`overall-stock${suffix}.csv`, exp);
                          if (fmt === "Excel") downloadExcel(`overall-stock${suffix}.xlsx`, exp);
                          if (fmt === "PDF") {
                            const plantScope = activePlant
                              || (activeState ? `${activeState} (${activeStateGroup?.plants.map((p) => p.name).join(", ") ?? activeState})` : "")
                              || (allowedPlants && allowedPlants.length ? plantOptions.join(", ") : "All Plants");
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
            containerClassName="rounded-none border-0"
            columns={stockColumns}
            data={displayRows}
            getRowId={(row) => `${row.isEmptyBox ? "EB" : row.barcode}-${row.plant}`}
            rowClassName={(row) => (row.isEmptyBox ? "bg-orange-50/40" : undefined)}
            renderExpandedRow={() => movementsPanel}
            isRowExpandable={(row) => !row.isEmptyBox && !!row.barcode}
            expandedRowId={detailRow ? `${detailRow.isEmptyBox ? "EB" : detailRow.barcode}-${detailRow.plant}` : null}
            emptyState={`No stock yet${activePlant ? ` for ${activePlant}` : activeState ? ` for ${activeState}` : ""}. Stock appears here once an order is completed.`}
            noResultsState="No stock rows match your search."
            hasActiveFilters={!!search || activeFilters.length > 0 || Object.keys(columnConditions).length > 0}
            enableTotalsRow
            enableZebraStripes
            sortMode="client"
            // The table scrolls inside its own box (isStickyHeader + maxHeight) so its column
            // header stays pinned to the table itself, directly under the page header above,
            // instead of the whole page scrolling rows up behind that header. 560px ≈ page
            // header + tabs + card title row + pagination bar; the floor keeps it usable on
            // short screens (the page then scrolls as before).
            isStickyHeader
            maxHeight="max(480px, calc(100dvh - 140px))"
            paginationMode="client"
            // Sr No + Item Name + Barcode stay put while the figure columns scroll underneath —
            // all three are marked fixedWidth above so their pinned offsets line up exactly.
            stickyColumnIds={["srNo", "itemName", "barcode"]}
            pageIndex={pageIndex}
            onPageIndexChange={setPageIndex}
            defaultPageSize={PAGE_SIZE}
            pageSizeOptions={[20, 50, 100, 200]}
            enableColumnResizing
            enableColumnVisibility
            columnVisibility={visibleColumnIds}
            columnOrder={columnOrder}
            onColumnOrderChange={setColumnOrder}
            onColumnVisibilityChange={setVisibleColumnIds}
            showMobileSwipeHint
            headerClassName="bg-[#001d6e] text-white border-[#1a3a9c] hover:bg-[#0a2b7e] hover:text-white"
            // Below 480px the card list below replaces this table — sixteen columns on a phone
            // means reading every row by scrolling sideways.
            className="space-y-0 hidden min-[480px]:block landscape:block"
          />

          {/* Mobile card list — the narrow-screen counterpart to the table, same treatment as the
              Scan pages: the identifying fields stacked, then the figures as labelled pairs, so
              nothing depends on horizontal scrolling. */}
          <div className="min-[480px]:hidden landscape:hidden">
            {displayRows.length === 0 ? (
              <p className="py-10 text-center text-sm text-gray-400">
                No stock rows match your filters.

              </p>
            ) : (
              displayRows.slice(pageIndex * PAGE_SIZE, (pageIndex + 1) * PAGE_SIZE).map((row) => {
                // The same ledger as the table: Opening → Purchase → Sale → Closing. Purchase is
                // inStock alone — extras are already inside it, so they're never added on top.
                const closing = row.closingStock ?? 0;
                const figures: { label: string; value: string; tone?: string }[] = [
                  { label: "Expected Purchase", value: (row.expectedQty ?? 0).toLocaleString() },
                  { label: "Opening", value: (row.openingStock ?? 0).toLocaleString() },
                  { label: "Purchase", value: row.inStock.toLocaleString() },
                  ...(row.extraQty > 0 ? [{ label: "Extra", value: `+${row.extraQty.toLocaleString()}`, tone: "text-amber-600" }] : []),
                  { label: "Expected Sale", value: (row.expectedSaleQty ?? 0).toLocaleString(), tone: "text-teal-700" },
                  { label: "Sale", value: (row.saleQty ?? 0).toLocaleString(), tone: "text-emerald-600" },
                  { label: "Closing", value: closing.toLocaleString(), tone: closing < 0 ? "text-amber-600" : "text-[#001d6e]" },
                ];
                return (
                  <div
                    key={`${row.isEmptyBox ? "EB" : row.barcode}-${row.plant}`}
                    className={`border-b border-gray-100 px-4 py-3 ${row.isEmptyBox ? "bg-orange-50/40" : ""}`}
                  >
                    <div className="flex items-start justify-between gap-2">
                      <div className="min-w-0">
                        <p className="text-[15px] font-semibold leading-snug text-gray-900">
                          {row.isEmptyBox ? "Empty Box" : row.itemName}
                        </p>
                        {!row.isEmptyBox && (
                          <p className="mt-0.5 font-mono text-xs text-gray-400">
                            {row.barcode ?? "—"}{row.sapCode && ` · SAP ${row.sapCode}`}
                          </p>
                        )}
                      </div>
                      {row.plant && <PlantBadge plant={row.plant} />}
                    </div>
                    <div className="mt-2 flex flex-wrap gap-x-4 gap-y-1">
                      {figures.map((f) => (
                        <span key={f.label} className="text-sm">
                          <span className="text-gray-400">{f.label} </span>
                          <span className={`font-bold tabular-nums ${f.tone ?? "text-gray-900"}`}>{f.value}</span>
                        </span>
                      ))}
                    </div>
                  </div>
                );
              })
            )}

            {/* The table's pager is inside the table, which is hidden on a phone — so the card
                list needs its own or mobile can only ever see page 1. */}
            {displayRows.length > PAGE_SIZE && (() => {
              const pageCount = Math.ceil(displayRows.length / PAGE_SIZE);
              return (
                <div className="flex flex-wrap items-center justify-between gap-2 border-t border-gray-200 px-4 py-3">
                  <span className="text-xs text-gray-500">
                    Showing {(pageIndex * PAGE_SIZE + 1).toLocaleString()}–
                    {Math.min((pageIndex + 1) * PAGE_SIZE, displayRows.length).toLocaleString()} of{" "}
                    {displayRows.length.toLocaleString()}
                  </span>
                  <nav className="flex flex-wrap items-center justify-center gap-1" aria-label="Pagination">
                    <Button
                      variant="outline" size="sm" className="h-8 w-8 p-0"
                      onClick={() => setPageIndex(Math.max(0, pageIndex - 1))}
                      disabled={pageIndex === 0}
                      aria-label="Previous page"
                    >
                      <ChevronLeft className="h-4 w-4" />
                    </Button>
                    {buildPageList(pageIndex, pageCount).map((pg, i) =>
                      pg === "gap" ? (
                        <span key={`gap-${i}`} aria-hidden className="select-none px-1 text-sm text-gray-400">…</span>
                      ) : (
                        <Button
                          key={pg}
                          variant={pg === pageIndex ? "default" : "outline"}
                          size="sm"
                          className={`h-8 min-w-8 px-2 tabular-nums ${pg === pageIndex ? "bg-[#001d6e] text-white hover:bg-[#00154b]" : ""}`}
                          onClick={() => setPageIndex(pg)}
                          aria-label={`Page ${pg + 1}`}
                          aria-current={pg === pageIndex ? "page" : undefined}
                        >
                          {pg + 1}
                        </Button>
                      ),
                    )}
                    <Button
                      variant="outline" size="sm" className="h-8 w-8 p-0"
                      onClick={() => setPageIndex(Math.min(pageCount - 1, pageIndex + 1))}
                      disabled={pageIndex >= pageCount - 1}
                      aria-label="Next page"
                    >
                      <ChevronRight className="h-4 w-4" />
                    </Button>
                  </nav>
                </div>
              );
            })()}
          </div>
        </TableCard>
      </div>

      <ExchangeProductDialog source={exchangeSource} onClose={() => setExchangeSource(null)} />

      {/* Adjust — pick a plant, see its live stock, then add, remove or set it. The server applies
          the change against that same live number (refusing if it moved meanwhile) and logs one
          'adjust' row, shown as "Adjusted" in the history drill-down and "Adjust" in Scan History. */}
      {/* Every correction behind one item's Adjust figure — opened by clicking that figure. */}
      <Dialog open={!!adjustHistoryTarget} onOpenChange={(open) => { if (!open) setAdjustHistoryTarget(null); }}>
        <DialogContent className="max-w-2xl">
          <DialogHeader>
            <DialogTitle>Adjustments</DialogTitle>
            <DialogDescription className="space-y-0.5 pt-1">
              <span className="block font-semibold text-gray-900">{adjustHistoryTarget?.itemName}</span>
              <span className="block font-mono text-xs text-gray-400">
                {adjustHistoryTarget?.barcode}
                {adjustHistoryPlants.length > 1 ? ` · ${adjustHistoryPlants.join(", ")}` : adjustHistoryPlants[0] ? ` · ${adjustHistoryPlants[0]}` : ""}
              </span>
            </DialogDescription>
          </DialogHeader>

          {adjustHistoryQuery.isLoading ? (
            <p className="py-8 text-center text-sm text-gray-400">Loading…</p>
          ) : (adjustHistoryQuery.data?.items?.length ?? 0) === 0 ? (
            <p className="py-8 text-center text-sm text-gray-400">No corrections for this item in this period.</p>
          ) : (
            <div className="max-h-[60vh] overflow-y-auto border border-gray-200">
              <table className="w-full border-collapse text-xs">
                <thead>
                  <tr className="sticky top-0 border-b-2 border-gray-300 bg-gray-100 text-left text-gray-600">
                    <th className="border-r border-gray-200 px-3 py-2 font-semibold">Date &amp; Time</th>
                    {adjustHistoryPlants.length > 1 && <th className="border-r border-gray-200 px-3 py-2 font-semibold">Plant</th>}
                    <th className="border-r border-gray-200 px-3 py-2 font-semibold">By</th>
                    <th className="border-r border-gray-200 px-3 py-2 text-right font-semibold">Qty</th>
                    <th className="border-r border-gray-200 px-3 py-2 font-semibold">From</th>
                    <th className="border-r border-gray-200 px-3 py-2 font-semibold">Reason</th>
                    {isAdminOrSuper && <th className="px-3 py-2 font-semibold">&nbsp;</th>}
                  </tr>
                </thead>
                <tbody>
                  {adjustHistoryQuery.data!.items.map((a) => (
                    <tr key={a.id} className="border-b border-gray-100 bg-white">
                      <td className="whitespace-nowrap border-r border-gray-100 px-3 py-2 text-gray-700">
                        {new Date(a.at).toLocaleString("en-IN", {
                          timeZone: "Asia/Kolkata", day: "numeric", month: "short",
                          hour: "numeric", minute: "2-digit", second: "2-digit", hour12: true,
                        })}
                      </td>
                      {adjustHistoryPlants.length > 1 && <td className="border-r border-gray-100 px-3 py-2 text-gray-600">{a.plant}</td>}
                      <td className="border-r border-gray-100 px-3 py-2 text-gray-600">{a.byName ?? a.byCode ?? "—"}</td>
                      <td className={`border-r border-gray-100 px-3 py-2 text-right font-semibold tabular-nums ${a.qty < 0 ? "text-red-600" : "text-emerald-600"}`}>
                        {a.qty > 0 ? `+${a.qty.toLocaleString()}` : a.qty.toLocaleString()}
                      </td>
                      <td className="border-r border-gray-100 px-3 py-2">
                        <span className={`rounded px-1.5 py-0.5 text-[10px] font-semibold uppercase tracking-wide ${
                          a.origin === "settings" ? "bg-slate-200 text-slate-700"
                          : a.origin === "page" ? "bg-[#001d6e]/10 text-[#001d6e]"
                          : a.origin === "opening" ? "bg-purple-100 text-purple-700"
                          : "bg-amber-100 text-amber-700"}`}>
                          {a.origin === "settings" ? "Settings" : a.origin === "page" ? "Stock page" : a.origin === "opening" ? "Opening" : "Operation"}
                        </span>
                      </td>
                      <td className="border-r border-gray-100 px-3 py-2 text-gray-600">{a.reason ?? "—"}</td>
                      {isAdminOrSuper && (
                        <td className="px-3 py-2 text-right">
                          <Button
                            size="sm" variant="ghost" className="h-7 w-7 p-0 text-gray-400 hover:text-red-600"
                            title="Delete this ledger entry — doesn't change live stock"
                            onClick={() => setDeleteMovementTarget(a)}
                          >
                            <Trash2 className="h-3.5 w-3.5" />
                          </Button>
                        </td>
                      )}
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}

          <DialogFooter>
            <Button variant="outline" onClick={() => setAdjustHistoryTarget(null)}>Close</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Moves between plants behind an item Transfer In / Transfer Out figure — an Unloading batch whose
          purchase plant differs from its stock plant. Lines add up to the figure on the table. */}
      <Dialog open={!!transferTarget} onOpenChange={(open) => { if (!open) setTransferTarget(null); }}>
        <DialogContent className="max-w-3xl">
          <DialogHeader>
            <DialogTitle>Stock moved between plants</DialogTitle>
            <DialogDescription className="space-y-0.5 pt-1">
              <span className="block font-semibold text-gray-900">{transferTarget?.itemName}</span>
              <span className="block font-mono text-xs text-gray-400">
                {transferTarget?.barcode}
                {transferPlants.length > 1 ? ` · ${transferPlants.join(", ")}` : transferPlants[0] ? ` · ${transferPlants[0]}` : ""}
              </span>
            </DialogDescription>
          </DialogHeader>
          {transferQuery.isLoading ? (
            <p className="py-8 text-center text-sm text-gray-400">Loading…</p>
          ) : (transferQuery.data?.items?.length ?? 0) === 0 ? (
            <p className="py-8 text-center text-sm text-gray-400">No moves between plants for this item in this period.</p>
          ) : (
            <div className="max-h-[60vh] overflow-y-auto border border-gray-200">
              <table className="w-full border-collapse text-xs">
                <thead>
                  <tr className="sticky top-0 border-b-2 border-gray-300 bg-gray-100 text-left text-gray-600">
                    <th className="border-r border-gray-200 px-3 py-2 font-semibold">Batch date</th>
                    <th className="border-r border-gray-200 px-3 py-2 font-semibold">Plant</th>
                    <th className="border-r border-gray-200 px-3 py-2 font-semibold">Move</th>
                    <th className="border-r border-gray-200 px-3 py-2 text-right font-semibold">Qty</th>
                    <th className="border-r border-gray-200 px-3 py-2 font-semibold">Unloading batch</th>
                    <th className="border-r border-gray-200 px-3 py-2 font-semibold">By</th>
                    <th className="px-3 py-2 font-semibold">Reason</th>
                  </tr>
                </thead>
                <tbody>
                  {transferQuery.data!.items.map((t) => (
                    <tr key={t.id} className="border-b border-gray-100 bg-white">
                      <td className="whitespace-nowrap border-r border-gray-100 px-3 py-2 text-gray-700">{t.day}</td>
                      <td className="border-r border-gray-100 px-3 py-2 text-gray-700">{t.plant}</td>
                      <td className="whitespace-nowrap border-r border-gray-100 px-3 py-2">
                        {t.direction === "in"
                          ? <span className="rounded bg-emerald-100 px-1.5 py-0.5 text-[10px] font-semibold uppercase text-emerald-700">In ← {t.otherPlant}</span>
                          : <span className="rounded bg-red-100 px-1.5 py-0.5 text-[10px] font-semibold uppercase text-red-700">Out → {t.otherPlant}</span>}
                      </td>
                      <td className={`border-r border-gray-100 px-3 py-2 text-right font-semibold tabular-nums ${t.qty < 0 ? "text-red-600" : "text-emerald-600"}`}>
                        {t.qty > 0 ? `+${t.qty.toLocaleString()}` : t.qty.toLocaleString()}
                      </td>
                      <td className="border-r border-gray-100 px-3 py-2 text-gray-600">{[t.vehicleNumber, t.csvFileName].filter(Boolean).join(" · ") || "—"}</td>
                      <td className="border-r border-gray-100 px-3 py-2 text-gray-600">{t.byName ?? "—"}</td>
                      <td className="px-3 py-2 text-gray-600">{t.reason ?? "—"}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
          <DialogFooter>
            <Button variant="outline" onClick={() => setTransferTarget(null)}>Close</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Delete-one-ledger-entry confirm — a lighter-weight confirm than the full item Delete
          below (no type-to-confirm text) since this only removes one history row, never live
          stock; still a real, logged, admin-only action so it isn't a single accidental click. */}
      <Dialog open={!!deleteMovementTarget} onOpenChange={(open) => { if (!open) setDeleteMovementTarget(null); }}>
        <DialogContent className="max-w-sm">
          <DialogHeader>
            <DialogTitle>Delete this entry?</DialogTitle>
            <DialogDescription>
              {deleteMovementTarget && (
                <>
                  <span className={`font-semibold ${deleteMovementTarget.qty < 0 ? "text-red-600" : "text-emerald-600"}`}>
                    {deleteMovementTarget.qty > 0 ? `+${deleteMovementTarget.qty}` : deleteMovementTarget.qty}
                  </span>
                  {" "}· {deleteMovementTarget.reason ?? "no reason recorded"} · {deleteMovementTarget.plant}
                  <br />
                  This removes it from the ledger only — it will no longer count toward Opening/Adjust/Total Stock.
                  It does not change this item's current live stock.
                </>
              )}
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button variant="outline" onClick={() => setDeleteMovementTarget(null)} disabled={deleteMovementMutation.isPending}>Cancel</Button>
            <Button
              className="bg-red-600 hover:bg-red-700"
              disabled={deleteMovementMutation.isPending}
              onClick={() => deleteMovementTarget && deleteMovementMutation.mutate(deleteMovementTarget.id)}
            >
              {deleteMovementMutation.isPending ? (<><Loader2 className="mr-1.5 h-4 w-4 animate-spin inline" />Deleting...</>) : "Delete entry"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <Dialog open={!!editTarget} onOpenChange={(open) => { if (!open) setEditTarget(null); }}>
        <DialogContent className="max-w-sm">
          <DialogHeader>
            <DialogTitle>Adjust stock — {editTarget?.itemName}</DialogTitle>
            <DialogDescription>
              <span className="font-mono">{editTarget?.barcode}</span> · saved as an Adjust entry in Scan History.
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-3">
            <div className="space-y-1.5">
              <Label>Plant</Label>
              <Select value={editPlant || undefined} onValueChange={setEditPlant} disabled={editPlantOptions.length <= 1}>
                <SelectTrigger><SelectValue placeholder="Select a plant…" /></SelectTrigger>
                <SelectContent>
                  {editPlantOptions.map((p) => (
                    <SelectItem key={p} value={p}>{p}</SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            {editPlant && (
              <div className="rounded-md border border-gray-200 bg-gray-50 px-3 py-2 text-xs text-gray-600">
                {editCurrentLoading && !editCurrent ? (
                  "Loading current stock…"
                ) : editCurrent ? (
                  <>
                    Current stock at {editPlant}:{" "}
                    <span className="font-semibold text-gray-900">{editCurrent.total}</span>
                    {editCurrent.extraQty > 0 && ` (incl. ${editCurrent.extraQty} extra)`}
                  </>
                ) : (
                  "Couldn't load current stock."
                )}
              </div>
            )}
            <div className="space-y-1.5">
              <Label htmlFor="editQty">Correct quantity</Label>
              <Input
                id="editQty"
                type="number"
                min="0"
                value={editQtyInput}
                onChange={(e) => setEditQtyInput(e.target.value)}
                placeholder={editCurrent ? `Current: ${editCurrent.total}` : "Pick a plant first"}
                disabled={!editCurrent}
              />
              {editPreview && (
                <div className="grid grid-cols-3 gap-1.5 text-center">
                  <div className="rounded-md border border-gray-200 bg-white px-2 py-1.5">
                    <p className="text-[10px] font-semibold uppercase tracking-wide text-gray-400">Current</p>
                    <p className="text-sm font-bold text-gray-900">{editPreview.current}</p>
                  </div>
                  <div className="rounded-md border border-gray-200 bg-white px-2 py-1.5">
                    <p className="text-[10px] font-semibold uppercase tracking-wide text-gray-400">New</p>
                    <p className="text-sm font-bold text-[#001d6e]">{editPreview.next}</p>
                  </div>
                  <div className={`rounded-md border px-2 py-1.5 ${
                    editPreview.delta > 0 ? "border-emerald-200 bg-emerald-50"
                    : editPreview.delta < 0 ? "border-amber-200 bg-amber-50" : "border-gray-200 bg-white"
                  }`}>
                    <p className="text-[10px] font-semibold uppercase tracking-wide text-gray-400">Adjustment</p>
                    <p className={`text-sm font-bold ${
                      editPreview.delta > 0 ? "text-emerald-700" : editPreview.delta < 0 ? "text-amber-700" : "text-gray-500"
                    }`}>
                      {editPreview.delta > 0 ? `+${editPreview.delta}` : editPreview.delta}
                    </p>
                  </div>
                </div>
              )}
              {editPreview && editPreview.delta !== 0 && (
                <p className="text-xs text-gray-500">
                  {editPreview.delta > 0 ? `${editPreview.delta} will be added` : `${-editPreview.delta} will be removed`} — saved as an Adjust entry.
                </p>
              )}
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="editReason">Reason (optional)</Label>
              <Input
                id="editReason"
                placeholder="e.g. Physical count correction"
                value={editReason}
                onChange={(e) => setEditReason(e.target.value)}
              />
            </div>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setEditTarget(null)} disabled={adjustMutation.isPending}>Cancel</Button>
            <Button
              disabled={
                adjustMutation.isPending ||
                !editPlant ||
                !editCurrent ||
                !editPreview ||
                editPreview.delta === 0
              }
              onClick={() => {
                if (!editTarget?.barcode || !editCurrent) return;
                adjustMutation.mutate({
                  barcode: editTarget.barcode,
                  plant: editPlant,
                  mode: "set",
                  qty: editQtyNumber,
                  expectedCurrentQty: editCurrent.total,
                  reason: editReason,
                });
              }}
            >
              {adjustMutation.isPending && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
              Save
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Delete — permanently removes this barcode+plant, including its receiving/loading/
          unloading scan history. Type-to-confirm since it's irreversible, same pattern as
          Settings > Clear Stock. */}
      <Dialog open={!!deleteTarget} onOpenChange={(open) => { if (!open) { setDeleteTarget(null); setDeleteConfirmText(""); } }}>
        <DialogContent className="max-w-sm">
          <DialogHeader>
            <DialogTitle className="text-red-700">Delete {deleteTarget?.itemName}?</DialogTitle>
            <DialogDescription>
              <span className="font-mono">{deleteTarget?.barcode}</span> · {deleteTarget?.plant}. This permanently removes the
              item's stock and every trace of it from receiving, Loading, and Unloading scan history at this plant. Cannot be undone.
              <span className="mt-1.5 block text-xs text-gray-500">
                Proforma slips are not changed. If this item is on one, it stays listed here with its Expected Sale.
              </span>

            </DialogDescription>
          </DialogHeader>
          {deletePreviewLoading ? (
            <SectionSkeleton lines={2} />
          ) : deletePreview && (
            <div className="grid grid-cols-2 gap-2 text-sm">
              <div className="p-2 rounded border bg-white">
                <div className="font-medium">Current stock</div>
                <div className="text-muted-foreground">{deletePreview.currentStock}</div>
              </div>
              <div className="p-2 rounded border bg-white">
                <div className="font-medium">Stock movements</div>
                <div className="text-muted-foreground">{deletePreview.stockMovements}</div>
              </div>
              <div className="p-2 rounded border bg-white">
                <div className="font-medium">Receiving events</div>
                <div className="text-muted-foreground">{deletePreview.receivingScanEvents}</div>
              </div>
              <div className="p-2 rounded border bg-white">
                <div className="font-medium">Loading events</div>
                <div className="text-muted-foreground">{deletePreview.loadingScanEvents}</div>
              </div>
              <div className="p-2 rounded border bg-white">
                <div className="font-medium">Unloading events</div>
                <div className="text-muted-foreground">{deletePreview.unloadingScanEvents}</div>
              </div>
              <div className="p-2 rounded border bg-white">
                <div className="font-medium">Import sessions touched</div>
                <div className="text-muted-foreground">{deletePreview.orderImportSessionsTouched + deletePreview.unloadingSessionsTouched}</div>
              </div>
            </div>
          )}
          <div className="space-y-1.5">
            <Label htmlFor="deleteConfirm">Type DELETE to confirm</Label>
            <Input
              id="deleteConfirm"
              placeholder="DELETE"
              value={deleteConfirmText}
              onChange={(e) => setDeleteConfirmText(e.target.value)}
            />
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => { setDeleteTarget(null); setDeleteConfirmText(""); }} disabled={deleteMutation.isPending}>
              Cancel
            </Button>
            <Button
              variant="destructive"
              disabled={deleteMutation.isPending || deleteConfirmText.trim().toUpperCase() !== "DELETE"}
              onClick={() => {
                if (!deleteTarget?.barcode) return;
                deleteMutation.mutate({ barcode: deleteTarget.barcode, plant: deleteTarget.plant });
              }}
            >
              {deleteMutation.isPending && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
              Delete
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
