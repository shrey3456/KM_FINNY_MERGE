import { useEffect, useMemo, useRef, useState } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { format } from "date-fns";
import * as XLSX from "xlsx";
import jsPDF from "jspdf";
import autoTable from "jspdf-autotable";
import {
  History, X, RefreshCw, FileDown, ChevronDown, ChevronLeft, ChevronRight,
  Loader2, Upload, Trash2, Plus, ListFilter, Filter, CalendarDays, Pencil,
} from "lucide-react";
import { useAuth } from "../../hooks/use-auth";
import { useToast } from "@/hooks/use-toast";
import { hasPageWriteAccess } from "@/lib/permissions";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Badge } from "@/components/ui/badge";
import {
  Select, SelectContent, SelectItem, SelectTrigger, SelectValue,
} from "@/components/ui/select";
import {
  Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription, DialogFooter,
} from "@/components/ui/dialog";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { Checkbox } from "@/components/ui/checkbox";
import { Label } from "@/components/ui/label";
import PageHeader from "../../components/PageHeader";
import { apiRequest } from "@/lib/queryClient";
import { DataTable, buildPageList, type DataTableColumn } from "@/components/ui/data-table";
import { PlantBadge } from "@/components/PlantBadge";
import { TableCard } from "@/components/ui/table-card";
import { CollapsibleSearch } from "@/components/ui/collapsible-search";
import { ColumnFilterPopoverContent, ColumnHeaderFilterButton } from "@/components/filters/ColumnFilterChip";
import { type FilterableColumn, type FilterCondition, conditionSummary, isConditionEmpty } from "@/lib/columnFilters";
import { usePersistentFilter } from "@/hooks/usePersistentFilter";
import { Accordion, AccordionItem, AccordionTrigger, AccordionContent } from "@/components/ui/accordion";

// The Type column, in one place — the table cell, its badge and the CSV export all read it, so a
// row can never be labelled one way in the table and another in the export.
//
// A label is "<where it came from> <what kind>": Scan / Unload / Load / Stock, then Adjust (a qty
// edit or a +/- correction) > Empty Box > Extra > Regular. Adjust wins over Extra, so a correction
// that also goes past the expected qty reads "Load Adjust", not "Load Extra".
type ScanTypeLabel = { source: string; kind: string; label: string; className: string };

function scanTypeLabel(row: {
  isExtra?: boolean; isEmptyBox?: boolean; isExchange?: boolean;
  isDispatch?: boolean; isUnload?: boolean; isAdjust?: boolean;
  sourceKind?: string; orderName?: string | null;
}): ScanTypeLabel {
  // sourceKind comes from the server; the flags are the fallback for an older one that doesn't
  // send it yet.
  const source = row.sourceKind
    ?? (row.isDispatch ? "loading" : row.isUnload ? "unloading" : row.isExchange || row.isAdjust ? "stock" : "scan");
  const word = source === "loading" ? "Load"
    : source === "unloading" ? "Unload"
    : source === "stock" ? "Stock"
    // Godown picking on the Sort Slip page — typed in, never scanned, and it moves no stock.
    : source === "sorting" ? "Sort"
    : "Scan";
  // A real Scan/Unload/Load event whose ledger row was reconstructed afterward (Settings > Data
  // Management > Fill Stock Ledger), most often after restoring into a different database — see
  // its own reason text in stockRecalc.ts. Same text this page's "Remove entry" option already
  // sniffs for the Remove-Operations-Data rows, just a different prefix.
  const isBackfill = !!row.orderName?.startsWith("Backfilled from");
  const kind = row.isExchange ? "Exchange"
    : row.isAdjust ? "Adjust"
    : isBackfill ? "Backfill"
    : row.isEmptyBox ? "Empty Box"
    : row.isExtra ? "Extra"
    : source === "sorting" ? "Pick"
    : "Regular";
  // Colour says the source at a glance; the words carry the detail.
  const className = source === "loading" ? "bg-blue-100 text-blue-800 hover:bg-blue-100"
    : source === "unloading" ? "bg-teal-100 text-teal-800 hover:bg-teal-100"
    : source === "stock" ? "bg-slate-200 text-slate-800 hover:bg-slate-200"
    : source === "sorting" ? "bg-purple-100 text-purple-800 hover:bg-purple-100"
    : "bg-green-100 text-green-800 hover:bg-green-100";
  return { source: word, kind, label: word + " " + kind, className };
}

// ─── Types ───────────────────────────────────────────────────────────────────

type ScanHistoryItem = {
  id: number;
  barcode: string | null;
  itemName: string | null;
  pallets: number | null;
  totalQty: number;
  itemsPerPallet: number | null;
  looseQty: number | null;
  isExtra: boolean;
  isEmptyBox?: boolean;
  isExchange?: boolean;
  // An adjustment, signed totalQty. On its own: a person's manual stock adjustment from Overall
  // Stock's Adjust dialog (+added / −removed), never voidable or editable here. With isDispatch:
  // "Loading Adjust" — the Loading Items table's +/- (+ loaded more / − loaded less), voidable
  // like any loading entry.
  isAdjust?: boolean;
  // Loading page's item-scanning history (server/routes/loading.ts) — a real stock removal onto
  // a vehicle for a proforma order, distinct from a receiving scan (isExchange stays false here).
  isDispatch?: boolean;
  // Unloading page's own scan history (server/routes/unloading.ts) — a real stock addition for a
  // vehicle+date batch, distinct from both receiving and Loading dispatch.
  isUnload?: boolean;
  // Which page wrote this row, straight from the server. The flags above say what kind of entry it
  // is; this says where it came from, and scanTypeLabel joins the two ("Scan Extra", "Load Adjust").
  sourceKind?: "scan" | "loading" | "unloading" | "stock";
  emptyBoxNote?: string | null;
  stv: string | null;
  scannedByCode: string | null;
  scannedByName: string | null;
  scannedAt: string;
  // Set only on a row that was CORRECTED: scannedAt stays the original scan's own time, this is
  // when the correction was made. A qty edit writes a replacement row, so without both times a
  // correction made today to a scan from the 16th read as if it had been scanned today.
  adjustedAt?: string | null;
  orderName: string;
  orderDate: string | null;
  srNo: string | null;
  plant: string;
  voided: boolean | null;
  voidedAt: string | null;
  voidReason: string | null;
};

// The row's own "pallets" column is floor(totalQty / itemsPerPallet) — a real, separate fact
// (whole physical pallets in THIS one scan, with looseQty as the remainder), legitimately 0 for
// a scan smaller than one pallet. That's not what belongs in a "Pallets" total/column meant to
// answer "how much of a pallet is this qty" — for that, every other pallet figure in the app
// (Scan Operations' own Expected/Received tiles, Sort Slip, etc.) uses the fractional qty ÷
// itemsPerPallet instead, which is what this computes.
function palletFraction(row: { totalQty: number; itemsPerPallet: number | null }): number | null {
  return row.itemsPerPallet && row.itemsPerPallet > 0 ? row.totalQty / row.itemsPerPallet : null;
}

type ScanHistoryResponse = {
  items: ScanHistoryItem[];
  total: number;
  totalBoxes: number;
  totalPallets: number;
  extraCount: number;
  emptyBoxCount?: number;
  scanners: string[];
  /** Totals-row figures for Qty/Pallets over the whole filtered set, not just the loaded page. */
  qtyTotal?: number;
  palletsTotal?: number;
  limit: number;
  offset: number;
};

// ─── Constants ───────────────────────────────────────────────────────────────

// Solid navy fill, matching Overall Stock / Product Master's filter buttons. Squared off
// (rounded-xl) for the business-report look — no soft/pill-shaped filter controls.
const FILTER_BTN_CLASS = "h-8 rounded-full border-0 bg-[#001d6e] text-white hover:bg-[#001552] hover:text-white text-xs";

// Rows per request. One page per view keeps the load to a single query — see the note on the
// query below for why this page is paginated rather than loading the whole history.
const HISTORY_PAGE_SIZE = 20;               // the default; the footer's "Show" picker changes it
const HISTORY_PAGE_SIZE_OPTIONS = [20, 50, 100] as const;  // 100 is the server's own cap on `limit`

// Filters survive leaving the page and coming back — they live in component state, so navigating
// away used to drop whatever the history had been narrowed to. sessionStorage rather than
// localStorage: a filter is working context for the current sitting, not a preference that should
// still be applied when the app is opened fresh tomorrow.
const HISTORY_FILTERS_KEY = "scanHistory:filters";

type SavedHistoryFilters = {
  search?: string;
  activeFilters?: { id: number; field: string; value: string }[];
  conditions?: Record<string, FilterCondition>;
};

function readSavedHistoryFilters(): SavedHistoryFilters {
  try {
    return JSON.parse(sessionStorage.getItem(HISTORY_FILTERS_KEY) ?? "{}") as SavedHistoryFilters;
  } catch {
    return {};
  }
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

function buildQueryUrl(base: string, params: Record<string, string | number | undefined>) {
  const sp = new URLSearchParams();
  Object.entries(params).forEach(([k, v]) => {
    if (v !== undefined && v !== "") sp.set(k, String(v));
  });
  const q = sp.toString();
  return q ? `${base}?${q}` : base;
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

// A header filter icon for the "special" single-value filters (Type, Scanner) — mirrors
// ColumnHeaderFilterButton's look/behavior (amber+filled when active, stops propagation so it
// never also triggers the header's click-to-sort) but picks from a small fixed option list
// instead of the generic Values/Condition engine, since these aren't real table columns with
// their own accessor — they're server-side exact-match params.
// `multiple` turns the list into a checklist: `value` is then a comma-separated set ("extra,adjust")
// and a row matching ANY of the ticked types passes (the server reads it the same way). The popover
// stays open while ticking, since picking several is the point.
function SimpleFilterHeaderButton({
  label, options, value, onChange, onClear, multiple,
}: {
  label: string;
  options: { value: string; label: string }[];
  value: string;
  onChange: (value: string) => void;
  onClear: () => void;
  multiple?: boolean;
}) {
  const [open, setOpen] = useState(false);
  const active = !!value;
  const selected = value ? value.split(",").filter(Boolean) : [];
  const toggle = (option: string) => {
    const next = selected.includes(option) ? selected.filter((s) => s !== option) : [...selected, option];
    onChange(next.join(","));
  };
  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <button
          type="button"
          onClick={(e) => e.stopPropagation()}
          className={`flex h-4 w-4 shrink-0 items-center justify-center normal-case ${active ? "text-amber-300" : "text-white/50 hover:text-white"}`}
          aria-label={`Filter ${label}`}
          title={`Filter ${label}`}
        >
          <Filter className="h-3 w-3" fill={active ? "currentColor" : "none"} />
        </button>
      </PopoverTrigger>
      <PopoverContent align="start" className="w-52" onClick={(e) => e.stopPropagation()}>
        <div className="space-y-2">
          <p className="text-[11px] font-semibold uppercase tracking-wide text-gray-500">{label}</p>
          <div className="space-y-0.5">
            {options.map((o) => (
              multiple ? (
                <label
                  key={o.value}
                  className={`flex w-full cursor-pointer items-center gap-2 rounded px-2 py-1.5 text-left text-xs ${selected.includes(o.value) ? "bg-[#001d6e]/10 text-[#001d6e]" : "text-gray-700 hover:bg-gray-50"}`}
                >
                  <Checkbox checked={selected.includes(o.value)} onCheckedChange={() => toggle(o.value)} />
                  {o.label}
                </label>
              ) : (
                <button
                  key={o.value}
                  type="button"
                  onClick={() => { onChange(o.value); setOpen(false); }}
                  className={`block w-full rounded px-2 py-1.5 text-left text-xs ${value === o.value ? "bg-[#001d6e] text-white" : "text-gray-700 hover:bg-gray-50"}`}
                >
                  {o.label}
                </button>
              )
            ))}
          </div>
          {active && (
            <button
              type="button"
              onClick={() => { onClear(); setOpen(false); }}
              className="text-[11px] text-red-500 hover:underline"
            >
              Clear filter
            </button>
          )}
        </div>
      </PopoverContent>
    </Popover>
  );
}

// ─── Component ───────────────────────────────────────────────────────────────

const ALL_NOTION_COLUMNS = ["#", "Scanned By", "Code", "Item", "Barcode", "Order", "Plant", "Qty", "Pallets", "STV", "Type", "Time"] as const;

// A dispatch row's combined-table id is (3000000000 + loading_scan_events.id), and an unload
// row's is (4000000000 + unload_scan_events.id) — see SCAN_HISTORY_COMBINED_SOURCE in
// server/routes/scan-sessions.ts, kept out of every other source's id space in the same UNION.
// Each source's own void endpoint takes the real underlying id, not the combined-table one.
const LOADING_EVENT_ID_OFFSET = 3000000000;
const UNLOAD_EVENT_ID_OFFSET = 4000000000;

const ScanHistory = () => {
  const { user } = useAuth();
  const { toast } = useToast();
  const queryClient = useQueryClient();
  const isAdmin = ["admin", "super-admin"].includes(((user as any)?.role ?? "").toLowerCase());
  // Matches the server's actual rule (POST /reports/upload-to-notion: requirePageWrite('scan-history')).
  const canUploadNotion = isAdmin || hasPageWriteAccess("scan-history");
  // Matches the server's actual rule (POST /order-scan/events/:id/void: requirePageWrite chained
  // for BOTH 'scan-order' and 'scan-history') — a user with only one of the two would otherwise
  // see a clickable Void button that 403s on click. Load Event's void (loading_scan_events) is
  // the same idea with "loading" swapped in for "scan-order" — see requireLoadingVoidAccess in
  // server/routes/loading.ts.
  const canVoidScan = isAdmin || (hasPageWriteAccess("scan-order") && hasPageWriteAccess("scan-history"));
  const canVoidLoadEvent = isAdmin || (hasPageWriteAccess("loading") && hasPageWriteAccess("scan-history"));
  // Unlike canVoidScan/canVoidLoadEvent above, requireUnloadingVoidAccess in
  // server/routes/unloading.ts is deliberately unloading-write-only — it does NOT also require
  // scan-history write.
  const canVoidUnloadEvent = isAdmin || hasPageWriteAccess("unloading");
  const [voidTarget, setVoidTarget] = useState<ScanHistoryItem | null>(null);
  const [voidReason, setVoidReason] = useState("");
  // "Remove entry" — takes a finished row out of this list for good. Offered on exactly two
  // kinds of row, and the server re-checks both: a scan that is already VOIDED (it counts
  // towards nothing any more), and a stock line written by Settings > Remove All Operations
  // Data (the minus entries that removal leaves behind). A live scan or somebody's manual
  // Stock Adjust is never offered — those still mean something.
  const canRemoveEntry = isAdmin || hasPageWriteAccess("scan-history");
  const isRemovableEntry = (row: ScanHistoryItem) =>
    !!row.voided
    || (row.sourceKind === "stock" && (row.orderName ?? "").startsWith("Remove operations data (Settings)"));
  const [removeTarget, setRemoveTarget] = useState<ScanHistoryItem | null>(null);
  const removeMutation = useMutation({
    mutationFn: (row: ScanHistoryItem) =>
      apiRequest("POST", "/api/scan-sessions/reports/scan-history/remove", { id: row.id }, false, true),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/scan-sessions/reports/scan-history"] });
      setRemoveTarget(null);
      toast({ title: "Entry removed", description: "Gone from this list. The record stays in Activities." });
    },
    onError: (err: any) => toast({ title: "Could not remove the entry", description: err?.message, variant: "destructive" }),
  });

  const voidMutation = useMutation({
    mutationFn: (payload: { id: number; reason: string; isDispatch?: boolean; isUnload?: boolean }) =>
      apiRequest(
        "POST",
        payload.isUnload
          ? `/api/unloading/events/${payload.id}/void`
          : payload.isDispatch
          ? `/api/loading/events/${payload.id}/void`
          : `/api/order-scan/events/${payload.id}/void`,
        { reason: payload.reason },
      ).then((r) => r.json()),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/scan-sessions/reports/scan-history"] });
      // Load Event's order-summary row (totalQty/itemCount/etc.) is a server-side aggregate over
      // these same events, so it needs its own invalidation — voiding one event doesn't touch the
      // scan-history query key at all.
      queryClient.invalidateQueries({ queryKey: ["/api/scan-sessions/reports/load-events"] });
      queryClient.invalidateQueries({ queryKey: ["/api/unloading/sessions"] });
      // Voiding reverses real stock (product_plant_stock/products.in_stock) — keep Overall
      // Stock's cache from showing a now-stale number if that tab is already open.
      queryClient.invalidateQueries({ queryKey: ["/api/scan-sessions/reports/plant-stock"] });
      setVoidTarget(null);
      setVoidReason("");
      toast({ title: "Scan voided", description: "Excluded from totals and stock; kept in history." });
    },
    onError: (err: any) => toast({ title: "Failed to void scan", description: err?.message, variant: "destructive" }),
  });
  // Edit — corrects a mistake in an already-recorded scan (Qty, and STV where the source has
  // one) without voiding it outright. Same permission pairs as Void above (editing is at least
  // as sensitive) and the same per-source id-offset stripping. Load Event has no STV field at
  // all (server/routes/loading.ts's PUT only accepts totalQty) — see editStvSupported below.
  const [editTarget, setEditTarget] = useState<ScanHistoryItem | null>(null);
  const [editQty, setEditQty] = useState("");
  const [editStv, setEditStv] = useState("");
  const editStvSupported = !editTarget?.isDispatch;
  const editMutation = useMutation({
    mutationFn: (payload: { id: number; totalQty?: number; stv?: string | null; isDispatch?: boolean; isUnload?: boolean }) => {
      const body: Record<string, unknown> = {};
      if (payload.totalQty !== undefined) body.totalQty = payload.totalQty;
      if (payload.stv !== undefined) body.stv = payload.stv;
      return apiRequest(
        "PUT",
        payload.isUnload
          ? `/api/unloading/events/${payload.id}`
          : payload.isDispatch
          ? `/api/loading/events/${payload.id}`
          : `/api/order-scan/events/${payload.id}`,
        body,
      ).then((r) => r.json());
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/scan-sessions/reports/scan-history"] });
      queryClient.invalidateQueries({ queryKey: ["/api/scan-sessions/reports/load-events"] });
      queryClient.invalidateQueries({ queryKey: ["/api/unloading/sessions"] });
      queryClient.invalidateQueries({ queryKey: ["/api/scan-sessions/reports/plant-stock"] });
      setEditTarget(null);
      toast({ title: "Scan updated" });
    },
    onError: (err: any) => toast({ title: "Failed to edit scan", description: err?.message, variant: "destructive" }),
  });
  // Four sections — "all" (every source merged, the default so nothing's hidden by accident),
  // receiving history (the original page), Loading's own item-scanning history
  // (server/routes/loading.ts), and Unloading's own scan history (server/routes/unloading.ts).
  // Same table/filters/export/void shell for all four; only the server-side `source` scoping
  // (isDispatch/isUnload) and a couple of labels differ.
  const [historySource, setHistorySource] = usePersistentFilter<"all" | "receiving" | "dispatch" | "unload" | "sorting">("scanHistory:source", "all");
  // Seeded from whatever was left applied last time — see HISTORY_FILTERS_KEY.
  const [historySearch,  setHistorySearch]  = useState(() => readSavedHistoryFilters().search ?? "");
  const [historyPage,    setHistoryPage]    = useState(1);
  // Kept per browser like the other filters, so a person who works in 100-row pages gets them
  // back next time instead of re-picking on every visit.
  const [historyPageSize, setHistoryPageSize] = usePersistentFilter<number>("scanHistory:pageSize", HISTORY_PAGE_SIZE);
  const [historyExporting, setHistoryExporting] = useState<string | null>(null);
  // Date/Scanner/Type — single-value filters, same "+ Filter" chip pattern as Overall Stock's
  // Date (kept separate from the generic column engine below since each is a simple exact-match
  // server param, not a column/operator/value condition). Plant used to live here too, but is
  // now a regular generic column (see filterableColumns) so it gets the same Values checklist
  // and header icon as Item/Barcode/etc.
  const [activeFilters, setActiveFilters] = useState<{ id: number; field: string; value: string }[]>(
    () => readSavedHistoryFilters().activeFilters ?? [],
  );
  // Start the id counter past anything restored, so a newly added filter can't collide with one
  // that came back from storage (ids are the React keys and the remove-by-id handle).
  const filterIdRef = useRef(
    (readSavedHistoryFilters().activeFilters ?? []).reduce((max, f) => Math.max(max, f.id), 0),
  );
  const selectedDate   = activeFilters.find((f) => f.field === "date")?.value ?? "";
  const historyScanner = activeFilters.find((f) => f.field === "scanner")?.value ?? "";
  const historyType    = activeFilters.find((f) => f.field === "type")?.value ?? "";
  const upsertSimpleFilter = (field: string, value: string) => {
    setActiveFilters((prev) => {
      const idx = prev.findIndex((f) => f.field === field);
      if (idx >= 0) { const next = [...prev]; next[idx] = { ...next[idx], value }; return next; }
      return [...prev, { id: ++filterIdRef.current, field, value }];
    });
  };
  const removeFilter = (id: number) => setActiveFilters((prev) => prev.filter((f) => f.id !== id));
  const clearSimpleFilter = (field: string) => setActiveFilters((prev) => prev.filter((f) => f.field !== field));
  // Empty Box / Exchange only ever happen on the receiving side — Load/Unload Event's Type
  // filter only offers what can actually occur there (matched what was expected, or went over).
  const TYPE_OPTIONS = historySource === "dispatch"
    ? [
        { value: "regular", label: "Load Regular" },
        { value: "extra", label: "Load Extra" },
        { value: "adjust", label: "Load Adjust" },
      ]
    : historySource === "unload"
    ? [
        { value: "regular", label: "Unload Regular" },
        { value: "extra", label: "Unload Extra" },
        { value: "adjust", label: "Unload Adjust" },
      ]
    // Picking has one kind of entry: someone said how much they took off the rack.
    : historySource === "sorting"
    ? [{ value: "regular", label: "Sort Pick" }]
    : historySource === "all"
    // All Events lists every source at once, so a plain "Regular" here would mean regular from
    // ANY of them — which is exactly why picking "Scan Regular" used to show Load Regular rows
    // further down the list. Each option names its own source and the server matches both.
    ? [
        { value: "scan:regular", label: "Scan Regular" },
        { value: "scan:extra", label: "Scan Extra" },
        { value: "scan:empty", label: "Scan Empty Box" },
        { value: "scan:adjust", label: "Scan Adjust" },
        { value: "loading:regular", label: "Load Regular" },
        { value: "loading:extra", label: "Load Extra" },
        { value: "loading:adjust", label: "Load Adjust" },
        { value: "unloading:regular", label: "Unload Regular" },
        { value: "unloading:extra", label: "Unload Extra" },
        { value: "unloading:adjust", label: "Unload Adjust" },
        { value: "stock:exchange", label: "Stock Exchange" },
        { value: "stock:adjust", label: "Stock Adjust" },
        { value: "sorting:regular", label: "Sort Pick" },
      ]
    : [
        { value: "regular", label: "Scan Regular" },
        { value: "extra", label: "Scan Extra" },
        { value: "empty", label: "Scan Empty Box" },
        { value: "exchange", label: "Stock Exchange" },
        { value: "adjust", label: "Adjust (Scan + Stock)" },
      ];

  // Date filter — same control/encoding as Overall Stock: the stored value is either a single
  // day ("d:YYYY-MM-DD") or a from–to range ("r:YYYY-MM-DD:YYYY-MM-DD"), both resolving to a
  // from/to window sent to the server. Presets just compute one of those. Filters scan date
  // (scannedAt) — "Scan Date" below, to read distinctly from "Order Date" (its own generic
  // column filter, set only via "+ Filter", not a second standalone control here).
  const dateValue = selectedDate;
  const { from: fromDate, to: toDate } = useMemo(() => {
    if (dateValue.startsWith("d:")) { const day = dateValue.slice(2); return { from: day, to: day }; }
    if (dateValue.startsWith("r:")) { const [, f, t] = dateValue.split(":"); return { from: f ?? "", to: t ?? "" }; }
    return { from: "", to: "" };
  }, [dateValue]);
  const dateIsRange = dateValue.startsWith("r:");
  const [datePickMode, setDatePickMode] = useState<"single" | "range">("single");
  const [dateOpen, setDateOpen] = useState(false);
  // The calendar half opens separately from the quick-ranges half — two buttons, two
  // popovers, one shared date value.
  const [dateCalOpen, setDateCalOpen] = useState(false);
  const isoOf = (x: Date) => format(x, "yyyy-MM-dd");
  const datePresetValue = (key: string): string => {
    const d = new Date();
    if (key === "today") return `d:${isoOf(d)}`;
    if (key === "yday") { const y = new Date(d); y.setDate(y.getDate() - 1); return `d:${isoOf(y)}`; }
    if (key === "week") { const w = new Date(d); w.setDate(w.getDate() - 6); return `r:${isoOf(w)}:${isoOf(d)}`; }
    if (key === "month") return `r:${isoOf(new Date(d.getFullYear(), d.getMonth(), 1))}:${isoOf(d)}`;
    return "";
  };
  const DATE_PRESETS = [
    { value: "today", label: "Today" },
    { value: "yday", label: "Yesterday" },
    { value: "week", label: "This week" },
    { value: "month", label: "This month" },
  ];

  const describeSimpleFilter = (field: string, value: string) => {
    if (field === "date") {
      // Same guard as the range branch below — an empty or malformed date must not throw.
      if (value.startsWith("d:")) {
        const d = value.slice(2) ? new Date(value.slice(2)) : null;
        return `Scan Date: ${d && !isNaN(d.getTime()) ? format(d, "MMM d, yyyy") : "…"}`;
      }
      if (value.startsWith("r:")) {
        const [, f, t] = value.split(":");
        const fmt = (s: string) => {
          const d = s ? new Date(s) : null;
          return d && !isNaN(d.getTime()) ? format(d, "MMM d") : "…";
        };
        return `Scan Date: ${fmt(f)} → ${fmt(t)}`;
      }
      return `Scan Date: ${value}`;
    }
    if (field === "scanner") return `Scanned By: ${value}`;
    if (field === "type") {
      const picked = value.split(",").filter(Boolean);
      const labels = picked.map((v) => TYPE_OPTIONS.find((o) => o.value === v)?.label ?? v);
      return `Type: ${labels.join(", ") || value}`;
    }
    return value;
  };

  // Every distinct value for every generic filter column, fetched once from the server (Scan
  // History is paginated, so — unlike Overall Stock, which builds its Values checklist straight
  // from the fully-loaded rows already in the browser — there's no complete dataset on the
  // client to read distinct values from otherwise).
  const { data: filterValues = {} } = useQuery<Record<string, { value: string; label: string }[]>>({
    queryKey: ["/api/scan-sessions/reports/scan-history/filter-values", historySource],
    queryFn: () => apiRequest("GET", `/api/scan-sessions/reports/scan-history/filter-values?source=${historySource}`, undefined, false, true),
    staleTime: 60_000,
  });

  // Excel-style per-column filters — Item, Barcode, Order, Qty, Pallets, STV, Time, Plant. Scan
  // History is server-paginated, so (unlike Overall Stock) these are sent to the server as a
  // `filters` param rather than matched client-side — see applyScanHistoryColumnFilters on the
  // backend. `accessor` is unused here for that same reason (no client-side matching happens);
  // it's only present to satisfy FilterableColumn's shape.
  // Qty/Pallets skip the Values checklist (disableValues) — every distinct quantity that ever
  // occurred isn't a useful list to pick from; typing a number/range is the only sensible way to
  // filter these two, so only the Condition tab shows for them.
  const filterableColumns: FilterableColumn<ScanHistoryItem>[] = useMemo(() => [
    { id: "barcode", label: "Barcode", filterType: "text", options: filterValues.barcode ?? [], accessor: (r) => r.barcode },
    { id: "qty", label: "Qty", filterType: "number", options: [], disableValues: true, accessor: (r) => r.totalQty },
    { id: "pallets", label: "Pallets", filterType: "number", options: [], disableValues: true, accessor: (r) => r.pallets },
    { id: "stv", label: "STV", filterType: "text", options: filterValues.stv ?? [], accessor: (r) => r.stv },
    { id: "time", label: "Time", filterType: "date", options: filterValues.time ?? [], accessor: (r) => r.scannedAt },
    { id: "orderDate", label: "Order Date", filterType: "date", options: filterValues.orderDate ?? [], accessor: (r) => r.orderDate },
    { id: "plant", label: "Plant", filterType: "enum", options: filterValues.plant ?? [], accessor: (r) => r.plant },
  ], [filterValues]);
  const [columnConditions, setColumnConditions] = useState<Record<string, FilterCondition>>(
    () => readSavedHistoryFilters().conditions ?? {},
  );
  const setColumnCondition = (columnId: string, condition: FilterCondition) =>
    setColumnConditions((prev) => ({ ...prev, [columnId]: condition }));
  const clearColumnCondition = (columnId: string) =>
    setColumnConditions((prev) => {
      const next = { ...prev };
      delete next[columnId];
      return next;
    });

  const columnHeader = (id: string, label: string, initialTab?: "values" | "condition") => {
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
          initialTab={initialTab}
        />
      </span>
    );
  };
  const filtersJson = useMemo(() => {
    const list = Object.values(columnConditions).filter((c) => !isConditionEmpty(c));
    return list.length > 0 ? JSON.stringify(list) : undefined;
  }, [columnConditions]);

  // The single "+ Filter" entry point — Date/Scanner/Type plus every generic column (including
  // Plant), same unified list-then-builder pattern as Overall Stock.
  const [filterPickerOpen, setFilterPickerOpen] = useState(false);
  const [filterPickerKey, setFilterPickerKey] = useState("");
  const [filterPickerSearch, setFilterPickerSearch] = useState("");
  // The date filter, split so each "+ Filter" entry does one job. Both write the same
  // activeFilters["date"], so whichever sets it, the other opens on that value.
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


  // Both halves together — what the "Filters (N)" editor shows, since editing an applied date
  // should offer every way of changing it, not just the calendar.
  const dateFullBody = (
    <>
      {dateCustomBody}
      {dateQuickBody}
    </>
  );

  const filterPickerOptions = useMemo(() => {
    // Date lives here rather than in its own toolbar button, split in two: named ranges under
    // "Date", the calendar under "Custom date". Both drive the same activeFilters["date"].
    const dims: { key: string; label: string; icon?: typeof CalendarDays }[] = [
      { key: "scanner", label: "Scanned By" },
      { key: "type", label: "Type" },
      ...filterableColumns.map((c) => ({ key: c.id, label: c.label })),
    ];
    const isActive = (key: string) =>
      ["date", "date-custom"].includes(key) ? false
        : ["scanner", "type"].includes(key)
        ? activeFilters.some((f) => f.field === key)
        : !!columnConditions[key];
    // Already-filtered columns are left OUT of this list: "+ Filter" adds a new one, while
    // changing or removing an existing filter happens in the "Filters (N)" dropdown, which lists
    // them all and opens each one's builder pre-filled.
    const q = filterPickerSearch.trim().toLowerCase();
    return dims.filter((d) => !isActive(d.key) && (!q || d.label.toLowerCase().includes(q)));
  }, [filterableColumns, activeFilters, columnConditions, filterPickerSearch]);
  const pickedFilterColumn = filterableColumns.find((c) => c.id === filterPickerKey) ?? null;

  // The "Filters (N)" popover doubles as the editor: it lists everything applied, and drilling
  // into one swaps the list for that filter's own builder (editFilterKey), with a Back link — a
  // drill-down inside the same popover rather than a popover within a popover.
  const [editFilterOpen, setEditFilterOpen] = useState(false);
  const [editFilterKey, setEditFilterKey] = useState("");
  const editFilterColumn = filterableColumns.find((c) => c.id === editFilterKey) ?? null;

  // Notion upload state
  const [notionOpen,      setNotionOpen]      = useState(false);
  const [notionColumns,   setNotionColumns]   = useState<string[]>([...ALL_NOTION_COLUMNS]);
  const [notionUploading, setNotionUploading] = useState(false);
  const [notionResult,    setNotionResult]    = useState<{ uploaded: number; fetched: number; url: string; errors: string[] } | null>(null);
  const [notionError,     setNotionError]     = useState<string | null>(null);
  const [envDbId,         setEnvDbId]         = useState<string | null>(null);

  // Load configured DB ID from env on mount
  useEffect(() => {
    apiRequest("GET", "/api/scan-sessions/reports/notion-config", undefined, false, true)
      .then((r: any) => {
        if (r?.dbId) setEnvDbId(r.dbId);
      })
      .catch(() => {});
  }, []);

  const toggleNotionCol = (col: string) =>
    setNotionColumns((prev) =>
      prev.includes(col) ? prev.filter((c) => c !== col) : [...prev, col]
    );

  const handleNotionUpload = async () => {
    if (!envDbId) { setNotionError("No Notion database configured in .env"); return; }
    if (notionColumns.length === 0) { setNotionError("Select at least one column."); return; }
    setNotionError(null);
    setNotionResult(null);
    setNotionUploading(true);
    try {
      const r = await apiRequest("POST", "/api/scan-sessions/reports/upload-to-notion", {
        columns: notionColumns,
        from:    fromDate       || undefined,
        to:      toDate         || undefined,
        search:  historySearch  || undefined,
        scanner: historyScanner || undefined,
        type:    historyType    || undefined,
      }, false, true);
      setNotionResult({ uploaded: (r as any).uploaded, fetched: (r as any).fetched, url: (r as any).url, errors: (r as any).errors ?? [] });
    } catch (e: any) {
      setNotionError(e?.message ?? "Upload failed.");
    } finally {
      setNotionUploading(false);
    }
  };


  // Server-driven pagination, same as develop: ONE request for one 20-row page. This page briefly
  // loaded the entire filtered history instead (walking it 100 rows at a time, in sequence, while
  // a 5s poll restarted the walk) and took ~20s to show anything — pagination is what made it
  // about a second, so it's back.
  //
  // Resetting historyPage via a plain effect (the previous approach) ran one render AFTER the
  // filter actually changed — so the render in between still queried with the OLD page number
  // against the NEW filters. Page 3 of a brand-new filtered set usually doesn't exist, so that
  // request came back genuinely empty, which placeholderData can't paper over (it's a real
  // successful response, not a stale one) — hence the "No events found" flash before the
  // corrected page-1 request landed a moment later. Comparing a signature of the filter values
  // at render time (not in an effect) means the very first render after a filter change already
  // computes page 1 for the query, so that wrong intermediate request never happens at all.
  const historyFilterSignature = JSON.stringify([historySource, selectedDate, historySearch, historyScanner, historyType, filtersJson, historyPageSize]);
  const lastHistoryFilterSignatureRef = useRef(historyFilterSignature);
  const effectiveHistoryPage = historyFilterSignature !== lastHistoryFilterSignatureRef.current ? 1 : historyPage;
  useEffect(() => {
    if (historyFilterSignature !== lastHistoryFilterSignatureRef.current) {
      lastHistoryFilterSignatureRef.current = historyFilterSignature;
      setHistoryPage(1);
    }
  }, [historyFilterSignature]);

  // Keep the saved copy in step with what's applied, so coming back to this page restores it. The
  // page number isn't saved — a filtered report should reopen at the top of its results.
  useEffect(() => {
    try {
      sessionStorage.setItem(
        HISTORY_FILTERS_KEY,
        JSON.stringify({
          search: historySearch,
          activeFilters,
          conditions: columnConditions,
        } satisfies SavedHistoryFilters),
      );
    } catch {
      // Storage unavailable (private mode / quota) — filters just won't outlive the page.
    }
  }, [historySearch, activeFilters, columnConditions]);

  const historyOffset = (effectiveHistoryPage - 1) * historyPageSize;
  const historyUrl = buildQueryUrl("/api/scan-sessions/reports/scan-history", {
    source:  historySource,
    from:    fromDate       || undefined,
    to:      toDate         || undefined,
    search:  historySearch  || undefined,
    scanner: historyScanner || undefined,
    type:    historyType    || undefined,
    filters: filtersJson,
    limit:   historyPageSize,
    offset:  historyOffset,
  });

  const { data: historyData, isLoading: historyLoading, isFetching: historyFetching } =
    useQuery<ScanHistoryResponse>({
      queryKey: [
        "/api/scan-sessions/reports/scan-history",
        historySource, selectedDate, historySearch, historyScanner, historyType, filtersJson, effectiveHistoryPage, historyPageSize,
      ],
      queryFn: async () => {
        const r = await apiRequest("GET", historyUrl, undefined, false, true);
        return r ?? { items: [], total: 0, totalBoxes: 0, totalPallets: 0, extraCount: 0, scanners: [], limit: historyPageSize, offset: 0 };
      },
      // Only auto-polls on page 1. This page sorts newest-first, and new scans keep landing at
      // the top in a busy warehouse — every new one pushes page 2+'s fixed OFFSET window down
      // by one, so on page 2+ the 5s poll was fighting the live insert order: the total crossing
      // the page boundary between polls made that page flip between having rows and being empty
      // ("No events found" for a moment, then real rows, repeating) even though nothing was
      // actually wrong. Page 1 doesn't have this problem — new rows only ever ADD to its front,
      // never shift what's already showing out of the window — so it's the only page safe to
      // keep live.
      refetchInterval: effectiveHistoryPage === 1 ? 5000 : false,
      placeholderData: (previousData) => previousData,
    });

  const historyItems        = historyData?.items ?? [];
  const historyTotal        = historyData?.total ?? 0;
  const historyScanners     = historyData?.scanners ?? [];
  const historyHasMore      = historyOffset + historyItems.length < historyTotal;
  // Page count for the numbered pager — at least one, so an empty result still renders "1".
  const historyPageCount    = Math.max(1, Math.ceil(historyTotal / historyPageSize));

  // Export must cover every row matching the current filters — the server caps `limit` at 100
  // (see /reports/scan-history), so this pages through with the SAME filters until it has
  // everything, then hands the full set to the exporter. Kept independent of the table's own
  // fetch so a click always exports a fresh, complete set even mid-poll.
  async function fetchAllHistoryItems(): Promise<ScanHistoryItem[]> {
    const EXPORT_PAGE_SIZE = 100; // server-side max for `limit`
    let offset = 0;
    let total = Infinity;
    const all: ScanHistoryItem[] = [];
    while (offset < total) {
      const url = buildQueryUrl("/api/scan-sessions/reports/scan-history", {
        source:  historySource,
        from:    fromDate       || undefined,
        to:      toDate         || undefined,
        search:  historySearch  || undefined,
        scanner: historyScanner || undefined,
        type:    historyType    || undefined,
        filters: filtersJson,
        limit:   EXPORT_PAGE_SIZE,
        offset,
      });
      const r: ScanHistoryResponse | undefined = await apiRequest("GET", url, undefined, false, true);
      const items = r?.items ?? [];
      if (items.length === 0) break; // guards against an infinite loop if total is ever wrong
      all.push(...items);
      total = r?.total ?? all.length;
      offset += items.length;
    }
    return all;
  }

  const historyExportRows = (src: ScanHistoryItem[]) => [
    ["Sr. No", "Scanned By", "Code", "Item", "Barcode", "Order No.", "Order Date", "Plant", "Qty", "Pallets", "STV", "Type", "Time"],
    ...src.map((h) => [
      h.srNo ?? "",
      h.scannedByName ?? "",
      h.scannedByCode ?? "",
      h.itemName ?? "",
      h.barcode ?? "",
      h.orderName ?? "",
      h.orderDate ?? "",
      h.plant,
      h.totalQty,
      (() => { const p = palletFraction(h); return p != null ? p.toFixed(2) : ""; })(),
      h.stv ?? "",
      scanTypeLabel(h).label,
      h.scannedAt ? format(new Date(h.scannedAt), "yyyy-MM-dd HH:mm") : "",
    ]),
  ];

  const dash = <span className="text-gray-300">—</span>;

  // Same table structure/styling as Overall Stock (DataTable + TableCard): sortable/resizable/
  // hideable columns, zebra stripes, business-report borders, plus a totals row.
  //
  // The table only ever holds one 20-row page, so DataTable's own row-summing would report the
  // total of whatever page you happen to be on. Qty and Pallets therefore take their figure from
  // the server, computed over the whole filtered set (see qtyTotal/palletsTotal on
  // /reports/scan-history) — the number stays the same as you page through, which is the only
  // reading of "Total" that means anything here. Voided scans are excluded, matching the rule the
  // void dialog states ("removes it from totals and stock").
  const historyColumns: DataTableColumn<ScanHistoryItem>[] = [
    {
      id: "srNo",
      header: "Sr. No",
      hideable: false,
      width: 64,
      cellClassName: "text-gray-500 tabular-nums",
      // The item's inventory Sr. No (products.new_sr), so the same item always shows the same
      // number here as on the Inventory page — not a per-page running row count.
      render: (row) => row.srNo || dash,
    },
    {
      id: "scannedBy",
      header: "Scanned By",
      hideable: false,
      width: 150,
      accessor: (row) => row.scannedByName,
      render: (row) => (
        <>
          <p className="font-medium text-gray-900 text-xs leading-tight">{row.scannedByName ?? dash}</p>
          {row.scannedByCode && (
            <p className="text-[11px] text-gray-400 font-mono leading-tight">{row.scannedByCode}</p>
          )}
        </>
      ),
    },
    {
      id: "item",
      header: "Item",
      hideable: false,
      width: 220,
      accessor: (row) => row.itemName,
      totalable: false,
      cellClassName: "whitespace-normal break-words",
      render: (row) => (
        <>
          <p className={`font-medium text-gray-900 text-xs leading-snug ${row.voided ? "line-through" : ""}`}>
            {row.itemName ?? dash}
          </p>
          {row.voided && (
            <p className="text-[10px] font-semibold text-red-500" title={row.voidReason ?? undefined}>
              Voided{row.voidedAt ? ` · ${format(new Date(row.voidedAt), "MMM d, h:mm a")}` : ""}
            </p>
          )}
        </>
      ),
    },
    {
      id: "barcode",
      header: columnHeader("barcode", "Barcode"),
      width: 120,
      accessor: (row) => row.barcode,
      // A barcode is an identifier that happens to be digits — adding them up is meaningless, so
      // it never joins the totals row (same reason SAP Code/STV opt out below).
      totalable: false,
      cellClassName: "font-mono text-gray-500",
      render: (row) => row.barcode ?? dash,
    },
    {
      // Which order this entry belongs to — the receiving CSV/session name for a Scan History
      // row, or the proforma slip's order number for a Load Event row (see "orderName" in
      // SCAN_HISTORY_COMBINED_SOURCE, server/routes/scan-sessions.ts).
      id: "orderNumber",
      header: "Order No.",
      width: 130,
      accessor: (row) => row.orderName,
      totalable: false,
      cellClassName: "text-gray-600",
      render: (row) => row.orderName || dash,
    },
    {
      id: "order",
      // Opens straight to the Condition tab (a real calendar input for on/before/after/between)
      // instead of the Values tab — the Values checklist only ever lists dates that already have
      // a scan on them (capped at 500), not every date you might actually want to pick.
      header: columnHeader("orderDate", "Order Date", "condition"),
      width: 120,
      accessor: (row) => row.orderDate ?? "",
      totalable: false,
      cellClassName: "whitespace-nowrap text-gray-600",
      // Show the order's date (from the CSV import) instead of the order/file name.
      render: (row) => {
        if (!row.orderDate) return dash;
        const d = new Date(row.orderDate);
        return isNaN(d.getTime()) ? row.orderDate : format(d, "MMM d, yyyy");
      },
    },
    {
      id: "plant",
      header: columnHeader("plant", "Plant"),
      width: 90,
      accessor: (row) => row.plant,
      totalable: false,
      render: (row) => (row.plant ? <PlantBadge plant={row.plant} /> : <span className="text-gray-300">—</span>),
    },
    {
      id: "qty",
      header: columnHeader("qty", "Qty"),
      width: 80,
      align: "right",
      accessor: (row) => row.totalQty,
      // Whole-set figure from the server; the row-sum fallback only covers the loaded page and is
      // there for an older server that doesn't send the field.
      total: (rows) =>
        (historyData?.qtyTotal ??
          rows.reduce((sum, r) => (r.voided ? sum : sum + (r.totalQty ?? 0)), 0)
        ).toLocaleString(),
      cellClassName: "font-bold",
      render: (row) =>
        row.isExchange || row.isAdjust ? (
          <span className={row.totalQty < 0 ? "text-red-500" : "text-emerald-600"}>
            {row.totalQty < 0 ? row.totalQty.toLocaleString() : `+${row.totalQty.toLocaleString()}`}
          </span>
        ) : (
          <span className="text-[#001d6e]">{row.totalQty.toLocaleString()}</span>
        ),
    },
    {
      id: "pallets",
      header: columnHeader("pallets", "Pallets"),
      width: 90,
      align: "right",
      accessor: (row) => palletFraction(row),
      total: (rows) =>
        (historyData?.palletsTotal ??
          rows.reduce((sum, r) => (r.voided ? sum : sum + (palletFraction(r) ?? 0)), 0)
        ).toFixed(2),
      cellClassName: "font-semibold text-[#001d6e]",
      // != null only — a real 0 (or 0.07, etc.) is common and legitimate; only a row with no
      // pallet size at all (itemsPerPallet null/0, e.g. a Stock Exchange ledger row) has
      // nothing to show, and gets the dash.
      render: (row) => { const p = palletFraction(row); return p != null ? p.toFixed(2) : dash; },
    },
    {
      id: "stv",
      header: columnHeader("stv", "STV"),
      width: 90,
      accessor: (row) => row.stv,
      totalable: false,
      cellClassName: "text-gray-600",
      render: (row) => row.stv ?? dash,
    },
    {
      id: "type",
      header: (
        <span className="inline-flex items-center gap-1">
          Type
          <SimpleFilterHeaderButton
            label="Type"
            options={TYPE_OPTIONS}
            value={historyType}
            multiple
            onChange={(v) => (v ? upsertSimpleFilter("type", v) : clearSimpleFilter("type"))}
            onClear={() => clearSimpleFilter("type")}
          />
        </span>
      ),
      width: 100,
      accessor: (row) => scanTypeLabel(row).label,
      render: (row) => {
        const t = scanTypeLabel(row);
        return <Badge className={`${t.className} whitespace-nowrap text-[11px] px-1.5 border-0`}>{t.label}</Badge>;
      },
    },
    {
      id: "time",
      header: columnHeader("time", "Time"),
      width: 150,
      accessor: (row) => row.scannedAt,
      cellClassName: "whitespace-nowrap text-gray-500",
      // The scan's own time on top; underneath, when it was corrected or voided — so a correction
      // never hides the day the boxes were actually scanned.
      render: (row) => (
        <>
          <span className="block">{row.scannedAt ? format(new Date(row.scannedAt), "MMM d, h:mm:ss a") : dash}</span>
          {row.adjustedAt && (
            <span className="block text-[11px] text-amber-600">
              edited {format(new Date(row.adjustedAt), "MMM d, h:mm a")}
            </span>
          )}
          {row.voided && row.voidedAt && (
            <span className="block text-[11px] text-red-500">
              voided {format(new Date(row.voidedAt), "MMM d, h:mm a")}
            </span>
          )}
        </>
      ),
    },
    ...(canVoidScan || canVoidLoadEvent || canVoidUnloadEvent || canRemoveEntry
      ? [
          {
            id: "edit",
            header: "Edit",
            hideable: false,
            width: 48,
            align: "center" as const,
            render: (row: ScanHistoryItem) =>
              // Same permission-pair-per-source and stock-row exclusion as Void below. A Load
              // Adjust is a +/- correction with no qty to re-edit — void it and press +/- again.
              !row.voided && scanTypeLabel(row).source !== "Stock" && !(row.isAdjust && row.isDispatch)
              && scanTypeLabel(row).source !== "Sort"
              && (row.isDispatch ? canVoidLoadEvent : row.isUnload ? canVoidUnloadEvent : canVoidScan) && (
                <Button size="sm" variant="ghost" className="h-7 w-7 p-0 text-gray-400 hover:text-[#001d6e]"
                  onClick={() => { setEditTarget(row); setEditQty(String(row.totalQty ?? 0)); setEditStv(row.stv ?? ""); }}
                  title="Edit this scan">
                  <Pencil className="h-3.5 w-3.5" />
                </Button>
              ),
          } as DataTableColumn<ScanHistoryItem>,
          {
            // One shared slot for Void/Remove instead of two separate columns — a row is only
            // ever eligible for ONE of them (isRemovableEntry is exactly "already voided", and
            // Void's own condition is exactly "not yet voided"), so a dedicated second column
            // was always empty on every row the other one filled.
            id: "void",
            header: "Void",
            hideable: false,
            width: 56,
            align: "center" as const,
            render: (row: ScanHistoryItem) => {
              if (canRemoveEntry && isRemovableEntry(row)) {
                return (
                  <Button size="sm" variant="ghost" className="h-7 w-7 p-0 text-gray-400 hover:text-red-600"
                    onClick={() => setRemoveTarget(row)}
                    title={row.voided ? "Remove this voided entry from history" : "Remove this leftover stock entry from history"}>
                    <X className="h-3.5 w-3.5" />
                  </Button>
                );
              }
              // Exchange rows aren't backed by a voidable event at all. Receiving/dispatch/unload
              // each check their own permission and hit their own endpoint (see voidMutation) — a
              // user with only one of the write-access pairs would otherwise see a Void button
              // that 403s on the row it doesn't cover. Every real scan row can be voided, including
              // the corrections; only the stock-ledger rows (manual adjust, exchange) can't.
              const canShowVoid = !row.voided && scanTypeLabel(row).source !== "Stock" && scanTypeLabel(row).source !== "Sort"
                && (row.isDispatch ? canVoidLoadEvent : row.isUnload ? canVoidUnloadEvent : canVoidScan);
              return canShowVoid && (
                <Button size="sm" variant="ghost" className="h-7 w-7 p-0 text-gray-400 hover:text-red-600"
                  onClick={() => setVoidTarget(row)} title="Void this scan">
                  <Trash2 className="h-3.5 w-3.5" />
                </Button>
              );
            },
          } as DataTableColumn<ScanHistoryItem>,
        ]
      : []),
  ];

  return (
    <>
    <div className="flex-1 overflow-y-auto overflow-x-hidden p-4 lg:p-6">
      <div className="mx-auto w-full max-w-[1800px] space-y-4">
        <PageHeader
          icon={History}
          title="Scan History"
          description={
            historySource === "dispatch"
              ? "Every item loaded onto a vehicle — who scanned what, when, and for which order."
              : historySource === "unload"
              ? "Every item unloaded for a vehicle + date batch — who scanned what, when, and for which vehicle."
              : historySource === "sorting"
              ? "Every pick made on a sort slip — who took what off the rack, when, and for which order."
              : historySource === "all"
              ? "Every event across receiving, Loading, Unloading and sorting — who did what, when, and where."
              : "Every individual receiving scan event — who scanned what, when, and on which order."
          }
        />

        {/* Five sections, same table/filters/export/void shell underneath — only the server-side
            `source` scoping (isDispatch/isUnload/sourceKind, or none at all for "all") and a
            couple of labels differ between them. A dropdown rather than tab buttons since "All"
            (the default) needs to read as just one more choice among them, not a separate concept
            bolted on top of the rest. */}
        <Select value={historySource} onValueChange={(v) => { setHistorySource(v as typeof historySource); clearSimpleFilter("type"); }}>
          <SelectTrigger className="h-9 w-[200px] rounded-full border-gray-300 bg-white text-sm font-semibold">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="all">All</SelectItem>
            <SelectItem value="receiving">Scan History</SelectItem>
            <SelectItem value="dispatch">Load Event</SelectItem>
            <SelectItem value="unload">Unload Event</SelectItem>
            <SelectItem value="sorting">Pick Up Event</SelectItem>
          </SelectContent>
        </Select>


        {/* Table card — same shared DataTable component as Overall Stock: sortable/resizable/
            hideable columns, zebra stripes, mobile swipe hint. No pagination — the whole filtered
            list loads and the table body scrolls under a sticky header, matching the Scan page's
            Master View. */}
        <TableCard
          icon={History}
          title={historySource === "dispatch" ? "Load Events" : historySource === "unload" ? "Unload Events" : historySource === "sorting" ? "Pick Up Events" : historySource === "all" ? "All Events" : "Scan Events"}
          subtitle={
            <span className="inline-flex items-center gap-1.5">
              <span>{historyTotal > 0 ? `${historyTotal.toLocaleString()} events` : "0 events"}</span>
              {/* Always mounted (visibility toggled, not presence) so the 5s poll never causes a
                  layout shift — kept here in the subtitle line instead of the button row, where
                  its reserved width used to show up as a permanent gap next to "+ Filter". */}
              <span
                className={`inline-flex items-center gap-1 text-emerald-600 ${historyFetching && !historyLoading ? "visible" : "invisible"}`}
                aria-hidden={!(historyFetching && !historyLoading)}
              >
                <RefreshCw className="h-3 w-3 animate-spin" />Updating…
              </span>
            </span>
          }
          className="rounded-xl shadow-none border-gray-300"
          headerActions={
            <>
              <CollapsibleSearch
                value={historySearch}
                onChange={setHistorySearch}
                placeholder="Item, barcode, or scanner…"
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
                    {dateValue ? describeSimpleFilter("date", dateValue).replace("Scan Date: ", "") : "Filter by date"}
                    {dateValue && (
                      <span
                        role="button"
                        aria-label="Clear date"
                        onClick={(e) => { e.stopPropagation(); clearSimpleFilter("date"); }}
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


              {/* One unified "+ Filter" — Scanned By, Type, Plant and every generic column in
                  the same searchable list. Date has its own pair of buttons above. */}
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
                        <Input
                          className="h-8 text-xs"
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
                              onClick={() => setFilterPickerKey(d.key)}
                              className="block w-full rounded px-2 py-1.5 text-left text-xs text-gray-700 hover:bg-[#001d6e]/5 hover:text-[#001d6e]"
                            >
                                {d.label}
                            </button>
                          ))
                        )}
                      </div>
                    </div>
                  ) : filterPickerKey === "date" || filterPickerKey === "date-custom" ? (
                    <div className="space-y-3">
                      <button type="button" onClick={() => setFilterPickerKey("")} className="flex items-center gap-1 text-[11px] text-gray-400 hover:text-gray-600">
                        <ChevronLeft className="h-3 w-3" /> Back
                      </button>
                      {filterPickerKey === "date" ? dateQuickBody : dateCustomBody}
                    </div>
                  ) : filterPickerKey === "scanner" ? (
                    <div className="space-y-3">
                      <button type="button" onClick={() => setFilterPickerKey("")} className="flex items-center gap-1 text-[11px] text-gray-400 hover:text-gray-600">
                        <ChevronLeft className="h-3 w-3" /> Back
                      </button>
                      <div className="space-y-1">
                        <label className="text-[11px] font-semibold uppercase tracking-wide text-gray-500">Scanned By</label>
                        <Select onValueChange={(v) => { upsertSimpleFilter("scanner", v); setFilterPickerOpen(false); setFilterPickerKey(""); }}>
                          <SelectTrigger className="h-8 text-xs"><SelectValue placeholder="Choose a scanner…" /></SelectTrigger>
                          <SelectContent>
                            {historyScanners.map((name) => <SelectItem key={name} value={name}>{name}</SelectItem>)}
                          </SelectContent>
                        </Select>
                      </div>
                    </div>
                  ) : filterPickerKey === "type" ? (
                    <div className="space-y-3">
                      <button type="button" onClick={() => setFilterPickerKey("")} className="flex items-center gap-1 text-[11px] text-gray-400 hover:text-gray-600">
                        <ChevronLeft className="h-3 w-3" /> Back
                      </button>
                      <div className="space-y-1">
                        <label className="text-[11px] font-semibold uppercase tracking-wide text-gray-500">Type</label>
                        {/* Tick as many as you like — the list stays open and a row matching any of
                            them is shown. */}
                        <div className="space-y-0.5">
                          {TYPE_OPTIONS.map((o) => {
                            const picked = historyType ? historyType.split(",").filter(Boolean) : [];
                            const on = picked.includes(o.value);
                            return (
                              <label key={o.value} className={`flex cursor-pointer items-center gap-2 rounded px-2 py-1.5 text-xs ${on ? "bg-[#001d6e]/10 text-[#001d6e]" : "text-gray-700 hover:bg-gray-50"}`}>
                                <Checkbox
                                  checked={on}
                                  onCheckedChange={() => {
                                    const next = on ? picked.filter((v) => v !== o.value) : [...picked, o.value];
                                    if (next.length) upsertSimpleFilter("type", next.join(","));
                                    else clearSimpleFilter("type");
                                  }}
                                />
                                {o.label}
                              </label>
                            );
                          })}
                        </div>
                      </div>
                    </div>
                  ) : pickedFilterColumn ? (
                    <div className="space-y-2">
                      <button type="button" onClick={() => setFilterPickerKey("")} className="flex items-center gap-1 text-[11px] text-gray-400 hover:text-gray-600">
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

              {/* Every active filter (Date/Scanner/Type/Plant + column filters) in one list. */}
              {(activeFilters.length + Object.keys(columnConditions).length) > 0 && (
                <Popover open={editFilterOpen} onOpenChange={(o) => { setEditFilterOpen(o); if (!o) setEditFilterKey(""); }}>
                  <PopoverTrigger asChild>
                    <Button size="sm" variant="outline" className={FILTER_BTN_CLASS}>
                      <ListFilter className="h-3.5 w-3.5 mr-1" />
                      Filters ({activeFilters.length + Object.keys(columnConditions).length})
                    </Button>
                  </PopoverTrigger>
                  {/* One place to see AND change every applied filter — the list drills down into
                      a filter's own builder rather than opening a popover inside a popover. */}
                  <PopoverContent align="start" className="w-72">
                    {editFilterKey === "scanner" || editFilterKey === "type" || editFilterKey === "date" ? (
                      <div className="space-y-3">
                        <button
                          type="button"
                          onClick={() => setEditFilterKey("")}
                          className="flex items-center gap-1 text-[11px] text-gray-400 hover:text-gray-600"
                        >
                          <ChevronLeft className="h-3 w-3" /> Back to filters
                        </button>
                        {editFilterKey === "scanner" && (
                          <div className="space-y-1">
                            <label className="text-[11px] font-semibold uppercase tracking-wide text-gray-500">Scanned By</label>
                            {/* value= so it opens showing what's currently set, not a blank picker. */}
                            <Select value={historyScanner} onValueChange={(v) => { upsertSimpleFilter("scanner", v); setEditFilterKey(""); }}>
                              <SelectTrigger className="h-8 text-xs"><SelectValue placeholder="Choose a scanner…" /></SelectTrigger>
                              <SelectContent>
                                {historyScanners.map((name) => <SelectItem key={name} value={name}>{name}</SelectItem>)}
                              </SelectContent>
                            </Select>
                          </div>
                        )}
                        {editFilterKey === "type" && (
                          <div className="space-y-1">
                            <label className="text-[11px] font-semibold uppercase tracking-wide text-gray-500">Type</label>
                            <div className="space-y-0.5">
                              {TYPE_OPTIONS.map((o) => {
                                const picked = historyType ? historyType.split(",").filter(Boolean) : [];
                                const on = picked.includes(o.value);
                                return (
                                  <label key={o.value} className={`flex cursor-pointer items-center gap-2 rounded px-2 py-1.5 text-xs ${on ? "bg-[#001d6e]/10 text-[#001d6e]" : "text-gray-700 hover:bg-gray-50"}`}>
                                    <Checkbox
                                      checked={on}
                                      onCheckedChange={() => {
                                        const next = on ? picked.filter((v) => v !== o.value) : [...picked, o.value];
                                        if (next.length) upsertSimpleFilter("type", next.join(","));
                                        else clearSimpleFilter("type");
                                      }}
                                    />
                                    {o.label}
                                  </label>
                                );
                              })}
                            </div>
                          </div>
                        )}
                        {editFilterKey === "date" && (
                          // The complete control, not just the inputs: the single/range toggle and
                          // the quick ranges belong here too, so editing an applied date offers
                          // everything setting it did.
                          <>{dateFullBody}</>
                        )}
                      </div>
                    ) : editFilterColumn ? (
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
                        {/* Scanned By / Type / Date aren't column conditions — they're their own
                            single-value server params — so they get their own small editors below
                            rather than the shared builder. Clicking one still opens it pre-set. */}
                        {activeFilters.map((f) => (
                          <div key={f.id} className="flex items-center justify-between gap-2 rounded text-xs hover:bg-gray-50">
                            <button
                              type="button"
                              onClick={() => setEditFilterKey(f.field)}
                              className="flex min-w-0 flex-1 items-center gap-1.5 px-1.5 py-1 text-left text-gray-700 hover:text-[#001d6e]"
                              title="Edit this filter"
                            >
                              <Pencil className="h-3 w-3 shrink-0 opacity-40" />
                              <span className="truncate">{describeSimpleFilter(f.field, f.value)}</span>
                            </button>
                            <button type="button" onClick={() => removeFilter(f.id)} className="mr-1.5 shrink-0 text-gray-400 hover:text-red-500" aria-label="Remove filter">
                              <X className="h-3.5 w-3.5" />
                            </button>
                          </div>
                        ))}
                        {Object.entries(columnConditions).map(([columnId, condition]) => (
                          <div key={columnId} className="flex items-center justify-between gap-2 rounded text-xs hover:bg-gray-50">
                            {/* The summary itself is the edit control — clicking it opens this filter's
                                builder pre-filled, so it can be changed without removing it first. */}
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

              {/* One Export control instead of three buttons; the format is picked from the menu. */}
              <DropdownMenu>
                <DropdownMenuTrigger asChild>
                  <Button variant="outline" size="sm" className={FILTER_BTN_CLASS} disabled={historyItems.length === 0}>
                    <FileDown className="h-3.5 w-3.5 mr-1" />
                    Export
                    <ChevronDown className="h-3.5 w-3.5 ml-1 opacity-70" />
                  </Button>
                </DropdownMenuTrigger>
                <DropdownMenuContent align="end" className="w-36">
                  {(["CSV", "Excel", "PDF"] as const).map((fmt) => (
                    <DropdownMenuItem
                      key={fmt}
                      disabled={historyExporting !== null}
                      // The table now holds only the current 20-row page, so the export fetches
                      // the full filtered set itself — otherwise a click would quietly produce a
                      // file containing just the rows that happened to be on screen.
                      onSelect={async (e) => {
                        e.preventDefault();
                        setHistoryExporting(fmt);
                        try {
                          const rows = historyExportRows(await fetchAllHistoryItems());
                          // Named the way the page is, so a downloaded file reads as "Scan History"
                          // in the folder rather than "scan-history".
                          const dateSuffix = dateValue ? ` - ${fromDate}${dateIsRange ? ` to ${toDate}` : ""}` : "";
                          const name = `Scan History${dateSuffix} - ${format(new Date(), "yyyy-MM-dd")}`;
                          if (fmt === "CSV")   downloadCsv(`${name}.csv`, rows);
                          if (fmt === "Excel") downloadExcel(`${name}.xlsx`, rows);
                          if (fmt === "PDF")   downloadPdf(`${name}.pdf`, "Scan History", rows);
                        } catch (err: any) {
                          toast({ title: `${fmt} export failed`, description: err?.message, variant: "destructive" });
                        } finally {
                          setHistoryExporting(null);
                        }
                      }}
                    >
                      {historyExporting === fmt
                        ? <Loader2 className="h-3.5 w-3.5 mr-2 animate-spin" />
                        : <FileDown className="h-3.5 w-3.5 mr-2 opacity-70" />}
                      {fmt}
                    </DropdownMenuItem>
                  ))}
                </DropdownMenuContent>
              </DropdownMenu>

              {/* Notion export reads receiving history only (server/services/scanHistoryNotionSync.ts
                  queries order_scan_events directly) — hidden on the Load Event tab so it can't
                  be mistaken for exporting whatever's currently filtered there. */}
              {canUploadNotion && historySource === "receiving" && (
                <Button
                  size="sm" className={FILTER_BTN_CLASS}
                  onClick={() => { setNotionOpen(true); setNotionResult(null); setNotionError(null); }}
                >
                  <Upload className="h-3.5 w-3.5 mr-1" />Upload to Notion
                </Button>
              )}
            </>
          }
        >
          <DataTable<ScanHistoryItem>
            // Below 480px the card list below replaces this table — thirteen columns on a phone
            // means reading every row by scrolling sideways, same split the Scan pages use.
            className="space-y-0 hidden min-[480px]:block landscape:block"
            containerClassName="rounded-none border-0"
            columns={historyColumns}
            data={historyItems}
            getRowId={(row) => String(row.id)}
            isLoading={historyLoading}
            loadingLabel="Loading scan history…"
            emptyState={`No ${historySource === "dispatch" ? "load " : historySource === "unload" ? "unload " : historySource === "all" ? "" : "scan "}events found${selectedDate ? " for this date" : ""}.`}
            noResultsState={`No ${historySource === "dispatch" ? "load " : historySource === "unload" ? "unload " : historySource === "all" ? "" : "scan "}events match your search.`}
            hasActiveFilters={!!historySearch || activeFilters.length > 0 || Object.keys(columnConditions).length > 0}
            rowClassName={(row) => {
              // Stripe by the row's stable id (not its position), so a new scan landing at the
              // top doesn't flip every row's color/number on each poll.
              const stripeEven = row.id % 2 === 0;
              // Color is by TYPE (Regular/Extra/Adjust) only, never by source (Scan/Load/
              // Unload) — isDispatch/isUnload used to be checked before isExtra/isAdjust, so
              // e.g. a "Load Extra" row and a "Load Regular" row both came out blue (source
              // won), while only rows with no source flag at all (Scan) ever actually showed
              // amber/slate. Source is still visible as text (scanTypeLabel below), just no
              // longer double-coded onto the same color channel as type.
              if (row.isExchange) return stripeEven ? "bg-purple-50/50" : "bg-purple-50/80";
              if (row.isEmptyBox) return stripeEven ? "bg-orange-50/50" : "bg-orange-50/80";
              if (row.voided) return "bg-gray-50 opacity-60";
              if (row.isAdjust) return stripeEven ? "bg-slate-50" : "bg-slate-100/70";
              if (row.isExtra) return stripeEven ? "bg-amber-50/50" : "bg-amber-50/80";
              return undefined;
            }}
            enableZebraStripes
            enableTotalsRow
            enableColumnResizing
            showMobileSwipeHint
            // No isStickyHeader/maxHeight here, matching develop: a 20-row page is short enough to
            // read whole, so a bounded scroll box would only add an inner scrollbar next to the
            // page's own. The table flows and the card grows with it.
            headerClassName="bg-[#001d6e] text-white border-[#1a3a9c] hover:bg-[#0a2b7e] hover:text-white"
            // Pagination is server-driven (Prev/Next over 20-row pages), so it's rendered here
            // rather than through DataTable's own client-side pageIndex/pageSize controls, which
            // would only page the rows already in the browser.
            renderFooter={(ctx) => (
              <tfoot>
                <tr>
                  <td colSpan={ctx.columnCount} className="border-t border-gray-300 bg-white px-4 py-2.5">
                    {/* Three tracks so the page numbers sit in the TRUE centre of the row: with a
                        plain justify-between they would only look centred when the text on the
                        left happened to match the picker on the right. */}
                    <div className="grid grid-cols-1 items-center gap-2 text-xs text-gray-500 sm:grid-cols-[1fr_auto_1fr]">
                      <span>
                        {historyTotal > 0
                          ? `Showing ${historyOffset + 1}–${Math.min(historyOffset + historyItems.length, historyTotal)} of ${historyTotal.toLocaleString()} events`
                          : "No events"}
                      </span>
                      {/* Numbered pages, the same buildPageList pattern every other table here
                          uses — Prev/Next alone gave no idea where you were in 40 pages of events. */}
                      <nav className="flex flex-wrap items-center justify-center gap-1" aria-label="Pagination">
                        <Button variant="outline" size="sm" className="h-8 w-8 rounded-xl p-0" disabled={historyPage <= 1}
                          onClick={() => setHistoryPage((pg) => Math.max(1, pg - 1))} aria-label="Previous page">
                          <ChevronLeft className="h-4 w-4" />
                        </Button>
                        {buildPageList(effectiveHistoryPage - 1, historyPageCount).map((pg, i) =>
                          pg === "gap" ? (
                            <span key={`gap-${i}`} aria-hidden className="select-none px-1 text-gray-400">…</span>
                          ) : (
                            <Button
                              key={pg}
                              variant={pg === effectiveHistoryPage - 1 ? "default" : "outline"}
                              size="sm"
                              className={`h-8 min-w-8 rounded-xl px-2 tabular-nums ${pg === effectiveHistoryPage - 1 ? "bg-[#001d6e] text-white hover:bg-[#00154b]" : ""}`}
                              onClick={() => setHistoryPage(pg + 1)}
                              aria-label={`Page ${pg + 1}`}
                              aria-current={pg === effectiveHistoryPage - 1 ? "page" : undefined}
                            >
                              {pg + 1}
                            </Button>
                          ),
                        )}
                        <Button variant="outline" size="sm" className="h-8 w-8 rounded-xl p-0" disabled={!historyHasMore}
                          onClick={() => setHistoryPage((pg) => pg + 1)} aria-label="Next page">
                          <ChevronRight className="h-4 w-4" />
                        </Button>
                      </nav>
                      <div className="flex items-center justify-end gap-1.5">
                        <span className="whitespace-nowrap">Show</span>
                        {/* The shared Select, not a native one: a native list is drawn by the
                            browser and would stay upright on a rotated kiosk screen. */}
                        <Select value={String(historyPageSize)} onValueChange={(v) => { setHistoryPageSize(Number(v)); setHistoryPage(1); }}>
                          <SelectTrigger className="h-7 w-[72px] rounded-lg text-xs"><SelectValue /></SelectTrigger>
                          <SelectContent>
                            {HISTORY_PAGE_SIZE_OPTIONS.map((n) => (
                              <SelectItem key={n} value={String(n)}>{n}</SelectItem>
                            ))}
                          </SelectContent>
                        </Select>
                      </div>
                    </div>
                  </td>
                </tr>
              </tfoot>
            )}
          />

          {/* Mobile card list — the narrow-screen counterpart to the table: each scan's fields
              stacked as labelled lines, so nothing depends on horizontal scrolling. */}
          <div className="min-[480px]:hidden landscape:hidden">
            {historyLoading ? (
              <p className="py-10 text-center text-sm text-gray-400">Loading scan history…</p>
            ) : historyItems.length === 0 ? (
              <p className="py-10 text-center text-sm text-gray-400">No scan events found.</p>
            ) : (
              historyItems.map((row) => (
                <div
                  key={row.id}
                  className={`border-b border-gray-100 px-4 py-3 ${
                    row.isExchange ? "bg-purple-50/60"
                    : row.isEmptyBox ? "bg-orange-50/60"
                    : row.voided ? "bg-gray-50 opacity-60"
                    : row.isAdjust ? "bg-slate-100/60"
                    : row.isExtra ? "bg-amber-50/60" : ""}`}
                >
                  <div className="flex items-start justify-between gap-2">
                    <div className="min-w-0">
                      <p className={`text-[15px] font-semibold leading-snug text-gray-900 ${row.voided ? "line-through" : ""}`}>
                        {row.itemName ?? "—"}
                      </p>
                      <p className="mt-0.5 font-mono text-xs text-gray-400">{row.barcode ?? "—"}</p>
                    </div>
                    {row.plant && <PlantBadge plant={row.plant} />}
                  </div>
                  <div className="mt-2 flex flex-wrap gap-x-4 gap-y-1 text-sm">
                    <span>
                      <span className="text-gray-400">Qty </span>
                      <span className="font-bold tabular-nums text-gray-900">{(row.totalQty ?? 0).toLocaleString()}</span>
                    </span>
                    {palletFraction(row) != null && (
                      <span>
                        <span className="text-gray-400">Pallets </span>
                        <span className="font-bold tabular-nums text-[#001d6e]">{palletFraction(row)!.toFixed(2)}</span>
                      </span>
                    )}
                    {row.stv && (
                      <span>
                        <span className="text-gray-400">STV </span>
                        <span className="font-medium text-gray-700">{row.stv}</span>
                      </span>
                    )}
                  </div>
                  <p className="mt-1 text-xs text-gray-400">
                    {row.scannedByName ?? "—"} · {format(new Date(row.scannedAt), "MMM d, yyyy · h:mm a")}
                  </p>
                  {row.voided && (
                    <p className="mt-1 text-[11px] font-semibold uppercase text-red-500">
                      Voided{row.voidReason ? ` · ${row.voidReason}` : ""}
                    </p>
                  )}
                </div>
              ))
            )}

            {/* The table's pager lives in its <tfoot>, which is hidden with the table — so the
                card list needs its own or a phone can only ever see page 1. */}
            <div className="grid grid-cols-[1fr_auto_1fr] items-center gap-2 border-t border-gray-200 px-4 py-3">
              <span className="text-xs text-gray-500">
                {historyTotal > 0
                  ? `${(historyOffset + 1).toLocaleString()}–${Math.min(historyOffset + historyItems.length, historyTotal).toLocaleString()} of ${historyTotal.toLocaleString()}`
                  : "No events"}
              </span>
              {/* Same numbered pager as the table's, narrower window so it fits a phone. */}
              <nav className="flex flex-wrap items-center justify-center gap-1" aria-label="Pagination">
                <Button variant="outline" size="sm" className="h-8 w-8 rounded-xl p-0" disabled={historyPage <= 1}
                  onClick={() => setHistoryPage((pg) => Math.max(1, pg - 1))} aria-label="Previous page">
                  <ChevronLeft className="h-4 w-4" />
                </Button>
                {buildPageList(effectiveHistoryPage - 1, historyPageCount, 0).map((pg, i) =>
                  pg === "gap" ? (
                    <span key={`gap-${i}`} aria-hidden className="select-none px-1 text-xs text-gray-400">…</span>
                  ) : (
                    <Button
                      key={pg}
                      variant={pg === effectiveHistoryPage - 1 ? "default" : "outline"}
                      size="sm"
                      className={`h-8 min-w-8 rounded-xl px-2 text-xs tabular-nums ${pg === effectiveHistoryPage - 1 ? "bg-[#001d6e] text-white hover:bg-[#00154b]" : ""}`}
                      onClick={() => setHistoryPage(pg + 1)}
                      aria-label={`Page ${pg + 1}`}
                      aria-current={pg === effectiveHistoryPage - 1 ? "page" : undefined}
                    >
                      {pg + 1}
                    </Button>
                  ),
                )}
                <Button variant="outline" size="sm" className="h-8 w-8 rounded-xl p-0" disabled={!historyHasMore}
                  onClick={() => setHistoryPage((pg) => pg + 1)} aria-label="Next page">
                  <ChevronRight className="h-4 w-4" />
                </Button>
              </nav>
              <div className="flex items-center justify-end gap-1.5 text-xs text-gray-500">
                <Select value={String(historyPageSize)} onValueChange={(v) => { setHistoryPageSize(Number(v)); setHistoryPage(1); }}>
                  <SelectTrigger className="h-7 w-[64px] rounded-lg text-xs"><SelectValue /></SelectTrigger>
                  <SelectContent>
                    {HISTORY_PAGE_SIZE_OPTIONS.map((n) => (
                      <SelectItem key={n} value={String(n)}>{n}</SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
            </div>
          </div>
        </TableCard>
      </div>
    </div>

    {/* ── Upload to Notion Dialog ─────────────────────────────────────── */}
    <Dialog open={notionOpen} onOpenChange={(o) => { setNotionOpen(o); if (!o) { setNotionResult(null); setNotionError(null); } }}>
      <DialogContent className="max-w-md">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2 text-[#001d6e]">
            <Upload className="h-4 w-4" /> Upload to Notion
          </DialogTitle>
        </DialogHeader>

        <div className="space-y-4 py-1">
          {!envDbId && (
            <p className="text-xs text-red-500">No database configured. Set SCAN_HISTORY_NOTION_DB_ID in .env</p>
          )}

          {/* Column selection */}
          <div className="space-y-1.5">
            <div className="flex items-center justify-between">
              <Label className="text-xs font-semibold text-gray-600 uppercase tracking-wide">Columns to upload</Label>
              <button
                className="text-[11px] text-[#001d6e] hover:underline"
                onClick={() => setNotionColumns(notionColumns.length === ALL_NOTION_COLUMNS.length ? [] : [...ALL_NOTION_COLUMNS])}
              >
                {notionColumns.length === ALL_NOTION_COLUMNS.length ? "Deselect all" : "Select all"}
              </button>
            </div>
            <div className="grid grid-cols-3 gap-x-4 gap-y-2 rounded-xl border bg-gray-50 p-3">
              {ALL_NOTION_COLUMNS.map((col) => (
                <div key={col} className="flex items-center gap-1.5">
                  <Checkbox
                    id={`nc-${col}`}
                    checked={notionColumns.includes(col)}
                    onCheckedChange={() => toggleNotionCol(col)}
                    disabled={col === "#"}
                  />
                  <label htmlFor={`nc-${col}`} className="text-xs text-gray-700 cursor-pointer select-none">
                    {col}
                  </label>
                </div>
              ))}
            </div>
          </div>

          {/* Active filters note — column filters aren't sent to this upload (only Date/Scanned
              By/Type/Plant/Search are), so it's flagged only for what actually applies here. */}
          {(selectedDate || historySearch || historyScanner || historyType) ? (
            <p className="text-[11px] text-amber-600 bg-amber-50 border border-amber-200 rounded px-2.5 py-1.5">
              Active filters will be applied — only filtered records will be uploaded (max 2000 rows).
            </p>
          ) : (
            <p className="text-[11px] text-gray-500">
              No filters active — all scan history will be uploaded (max 2000 rows).
            </p>
          )}

          {/* Result / Error */}
          {notionResult && (
            <div className={`text-sm rounded px-3 py-2 space-y-1.5 border ${notionResult.uploaded === 0 ? 'bg-red-50 border-red-200 text-red-700' : 'bg-green-50 border-green-200 text-green-700'}`}>
              <p className="font-medium">
                {notionResult.fetched === 0
                  ? '⚠ No records found with current filters.'
                  : `✓ Uploaded ${notionResult.uploaded} of ${notionResult.fetched} rows.`}
              </p>
              {notionResult.errors.length > 0 && (
                <p className="text-xs text-red-600">{notionResult.errors[0]}</p>
              )}
              {notionResult.uploaded > 0 && (
                <a
                  href={notionResult.url}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="inline-block text-[#001d6e] underline font-medium text-xs"
                >
                  → Open in Notion
                </a>
              )}
            </div>
          )}
          {notionError && (
            <div className="text-sm text-red-700 bg-red-50 border border-red-200 rounded px-3 py-2">
              {notionError}
            </div>
          )}
        </div>

        <DialogFooter>
          <Button variant="outline" size="sm" onClick={() => setNotionOpen(false)} disabled={notionUploading}>
            Cancel
          </Button>
          <Button
            size="sm"
            className="bg-[#001d6e] hover:bg-[#00154b] text-white"
            onClick={handleNotionUpload}
            disabled={notionUploading || !envDbId}
          >
            {notionUploading ? (
              <><Loader2 className="h-3.5 w-3.5 mr-1.5 animate-spin" />Uploading…</>
            ) : (
              <><Upload className="h-3.5 w-3.5 mr-1.5" />Upload</>
            )}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>

    {/* Void scan confirmation — admin or scan-history write access. Keeps the row in history (never deleted), marked
        Voided; excluded from totals and reversed out of stock. */}
    <Dialog open={!!removeTarget} onOpenChange={(o) => { if (!o) setRemoveTarget(null); }}>
      <DialogContent className="max-w-md">
        <DialogHeader>
          <DialogTitle>Remove this entry from history?</DialogTitle>
          <DialogDescription className="space-y-2 pt-1">
            <p>
              <span className="font-semibold text-gray-900">{removeTarget?.itemName ?? removeTarget?.barcode ?? "This entry"}</span>
              {removeTarget ? ` · ${scanTypeLabel(removeTarget).label} · ${removeTarget.totalQty}` : ""}
            </p>
            <p className="text-sm">
              It disappears from this list. Stock is not touched — a voided scan was already
              reversed, and a removal's stock line is what explains the change in Stock Overview,
              so both are kept in the ledger. Who removed it is recorded in Activities.
            </p>
          </DialogDescription>
        </DialogHeader>
        <DialogFooter className="gap-2">
          <Button variant="outline" onClick={() => setRemoveTarget(null)} disabled={removeMutation.isPending}>Cancel</Button>
          <Button
            className="bg-red-600 text-white hover:bg-red-700"
            disabled={removeMutation.isPending}
            onClick={() => removeTarget && removeMutation.mutate(removeTarget)}
          >
            {removeMutation.isPending && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
            Remove entry
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>

    <Dialog open={!!voidTarget} onOpenChange={(o) => { if (!o) { setVoidTarget(null); setVoidReason(""); } }}>
      <DialogContent className="max-w-sm">
        <DialogHeader>
          <DialogTitle>Void this scan?</DialogTitle>
        </DialogHeader>
        <p className="text-sm text-gray-600">
          <span className="font-semibold text-gray-900">{voidTarget?.itemName ?? voidTarget?.barcode}</span> — {voidTarget?.totalQty ?? 0} scanned by {voidTarget?.scannedByName ?? "—"}.
        </p>
        <p className="text-sm text-gray-500">
          This removes it from totals and stock, but the entry stays here marked "Voided" for the record — it is never deleted.
        </p>
        <div className="space-y-1.5">
          <Label className="text-sm">Reason (optional)</Label>
          <Input value={voidReason} onChange={(e) => setVoidReason(e.target.value)} placeholder="e.g. wrong barcode scanned by mistake" />
        </div>
        <DialogFooter className="gap-2">
          <Button variant="outline" onClick={() => { setVoidTarget(null); setVoidReason(""); }} disabled={voidMutation.isPending}>
            Cancel
          </Button>
          <Button
            onClick={() => {
              if (!voidTarget) return;
              const id = voidTarget.isDispatch ? voidTarget.id - LOADING_EVENT_ID_OFFSET
                : voidTarget.isUnload ? voidTarget.id - UNLOAD_EVENT_ID_OFFSET
                : voidTarget.id;
              voidMutation.mutate({ id, reason: voidReason, isDispatch: voidTarget.isDispatch, isUnload: voidTarget.isUnload });
            }}
            disabled={voidMutation.isPending}
            className="bg-red-600 hover:bg-red-700 text-white"
          >
            {voidMutation.isPending && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
            Void Scan
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>

    {/* Edit scan — corrects Qty (and STV, where the source has one) on an already-recorded scan.
        A qty change is never an in-place edit server-side: it voids the original event and writes
        a fresh one for the corrected quantity, so the row you're looking at right now stays
        exactly as it is here — you'll see it flip to "Voided" and a new corrected row appear once
        this saves. */}
    <Dialog open={!!editTarget} onOpenChange={(o) => { if (!o) { setEditTarget(null); setEditQty(""); setEditStv(""); } }}>
      <DialogContent className="max-w-sm">
        <DialogHeader>
          <DialogTitle>Edit this scan</DialogTitle>
        </DialogHeader>
        <p className="text-sm text-gray-600">
          <span className="font-semibold text-gray-900">{editTarget?.itemName ?? editTarget?.barcode}</span> — scanned by {editTarget?.scannedByName ?? "—"}.
        </p>
        <div className="space-y-1.5">
          <Label className="text-sm">Qty</Label>
          <Input type="number" min="1" value={editQty} onChange={(e) => setEditQty(e.target.value)} />
        </div>
        {editStvSupported && (
          <div className="space-y-1.5">
            <Label className="text-sm">STV</Label>
            <Input value={editStv} onChange={(e) => setEditStv(e.target.value)} placeholder="e.g. PLT-08" />
          </div>
        )}
        {Number(editQty) !== (editTarget?.totalQty ?? 0) && (
          <p className="text-xs text-amber-600">
            Changing Qty voids this scan and records a new one for {editQty || 0} — stock and totals are adjusted by the difference.
          </p>
        )}
        <DialogFooter className="gap-2">
          <Button variant="outline" onClick={() => { setEditTarget(null); setEditQty(""); setEditStv(""); }} disabled={editMutation.isPending}>
            Cancel
          </Button>
          <Button
            onClick={() => {
              if (!editTarget) return;
              const id = editTarget.isDispatch ? editTarget.id - LOADING_EVENT_ID_OFFSET
                : editTarget.isUnload ? editTarget.id - UNLOAD_EVENT_ID_OFFSET
                : editTarget.id;
              const qtyChanged = Number(editQty) !== (editTarget.totalQty ?? 0);
              const stvChanged = editStvSupported && editStv.trim() !== (editTarget.stv ?? "");
              editMutation.mutate({
                id,
                isDispatch: editTarget.isDispatch,
                isUnload: editTarget.isUnload,
                ...(qtyChanged ? { totalQty: Number(editQty) } : {}),
                ...(stvChanged ? { stv: editStv.trim() || null } : {}),
              });
            }}
            disabled={editMutation.isPending || !editQty || Number(editQty) <= 0 || (Number(editQty) === (editTarget?.totalQty ?? 0) && (!editStvSupported || editStv.trim() === (editTarget?.stv ?? "")))}
            className="bg-[#001d6e] hover:bg-[#00154b] text-white"
          >
            {editMutation.isPending && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
            Save
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>

    </>
  );
};

export default ScanHistory;
