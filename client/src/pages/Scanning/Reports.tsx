import { useEffect, useMemo, useRef, useState } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { format } from "date-fns";
import * as XLSX from "xlsx";
import jsPDF from "jspdf";
import autoTable from "jspdf-autotable";
import {
  History, X, RefreshCw, FileDown, ChevronDown, ChevronLeft,
  Loader2, Upload, Trash2, Plus, ListFilter, Filter, CalendarDays,
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
  Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter,
} from "@/components/ui/dialog";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { Checkbox } from "@/components/ui/checkbox";
import { Label } from "@/components/ui/label";
import PageHeader from "../../components/PageHeader";
import { apiRequest } from "@/lib/queryClient";
import { DataTable, DataTableColumnToggle, type DataTableColumn } from "@/components/ui/data-table";
import { PlantBadge } from "@/components/PlantBadge";
import { TableCard } from "@/components/ui/table-card";
import { CollapsibleSearch } from "@/components/ui/collapsible-search";
import { ColumnFilterPopoverContent, ColumnHeaderFilterButton } from "@/components/filters/ColumnFilterChip";
import { type FilterableColumn, type FilterCondition, conditionSummary, isConditionEmpty } from "@/lib/columnFilters";

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
  emptyBoxNote?: string | null;
  stv: string | null;
  scannedByCode: string | null;
  scannedByName: string | null;
  scannedAt: string;
  orderName: string;
  orderDate: string | null;
  srNo: string | null;
  plant: string;
  voided: boolean | null;
  voidedAt: string | null;
  voidReason: string | null;
};

type ScanHistoryResponse = {
  items: ScanHistoryItem[];
  total: number;
  totalBoxes: number;
  totalPallets: number;
  extraCount: number;
  emptyBoxCount?: number;
  scanners: string[];
  limit: number;
  offset: number;
};

// ─── Constants ───────────────────────────────────────────────────────────────

const HISTORY_PAGE_SIZE = 20;

// Solid navy fill, matching Overall Stock / Notion Inventory's filter buttons. Squared off
// (rounded-xl) for the business-report look — no soft/pill-shaped filter controls.
const FILTER_BTN_CLASS = "h-8 rounded-full border-0 bg-[#001d6e] text-white hover:bg-[#001552] hover:text-white text-xs";

// Column ids that can be hidden via the column-visibility toggle — mirrors historyColumns
// below. "#", Scanned By, Item and Void always stay visible (hideable: false there), so they
// don't need to be included/excluded here — DataTable adds them back regardless.
const HISTORY_OPTIONAL_COLUMNS = ["barcode", "order", "plant", "qty", "pallets", "stv", "type", "time"] as const;

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
function SimpleFilterHeaderButton({
  label, options, value, onChange, onClear,
}: {
  label: string;
  options: { value: string; label: string }[];
  value: string;
  onChange: (value: string) => void;
  onClear: () => void;
}) {
  const [open, setOpen] = useState(false);
  const active = !!value;
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
              <button
                key={o.value}
                type="button"
                onClick={() => { onChange(o.value); setOpen(false); }}
                className={`block w-full rounded px-2 py-1.5 text-left text-xs ${value === o.value ? "bg-[#001d6e] text-white" : "text-gray-700 hover:bg-gray-50"}`}
              >
                {o.label}
              </button>
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

const Reports = () => {
  const { user } = useAuth();
  const { toast } = useToast();
  const queryClient = useQueryClient();
  const isAdmin = ["admin", "super-admin"].includes(((user as any)?.role ?? "").toLowerCase());
  // Matches the server's actual rule (POST /reports/upload-to-notion: requirePageWrite('scan-history')).
  const canUploadNotion = isAdmin || hasPageWriteAccess("scan-history");
  // Matches the server's actual rule (POST /events/:id/void: requirePageWrite chained for BOTH
  // 'scan-order' and 'scan-history') — a user with only one of the two would otherwise see a
  // clickable Void button that 403s on click.
  const canVoidScan = isAdmin || (hasPageWriteAccess("scan-order") && hasPageWriteAccess("scan-history"));
  const [voidTarget, setVoidTarget] = useState<ScanHistoryItem | null>(null);
  const [voidReason, setVoidReason] = useState("");
  const voidMutation = useMutation({
    mutationFn: (payload: { id: number; reason: string }) =>
      apiRequest("POST", `/api/order-scan/events/${payload.id}/void`, { reason: payload.reason }).then((r) => r.json()),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/scan-sessions/reports/scan-history"] });
      // Voiding reverses real stock (product_plant_stock/products.in_stock) — keep Overall
      // Stock's cache from showing a now-stale number if that tab is already open.
      queryClient.invalidateQueries({ queryKey: ["/api/scan-sessions/reports/plant-stock"] });
      setVoidTarget(null);
      setVoidReason("");
      toast({ title: "Scan voided", description: "Excluded from totals and stock; kept in history." });
    },
    onError: (err: any) => toast({ title: "Failed to void scan", description: err?.message, variant: "destructive" }),
  });
  const [historyPage,    setHistoryPage]    = useState(1);
  const [historySearch,  setHistorySearch]  = useState("");
  const [historyExporting, setHistoryExporting] = useState<string | null>(null);
  // Date/Scanner/Type — single-value filters, same "+ Filter" chip pattern as Overall Stock's
  // Date (kept separate from the generic column engine below since each is a simple exact-match
  // server param, not a column/operator/value condition). Plant used to live here too, but is
  // now a regular generic column (see filterableColumns) so it gets the same Values checklist
  // and header icon as Item/Barcode/etc.
  const [activeFilters, setActiveFilters] = useState<{ id: number; field: string; value: string }[]>([]);
  const filterIdRef = useRef(0);
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
  const TYPE_OPTIONS = [
    { value: "regular", label: "Regular only" },
    { value: "extra", label: "Extra only" },
    { value: "empty", label: "Empty Box only" },
    { value: "exchange", label: "Exchange only" },
  ];

  // Date filter — same control/encoding as Overall Stock: the stored value is either a single
  // day ("d:YYYY-MM-DD") or a from–to range ("r:YYYY-MM-DD:YYYY-MM-DD"), both resolving to a
  // from/to window sent to the server. Presets just compute one of those. Filters scan date
  // (scannedAt).
  const dateValue = selectedDate;
  const { from: fromDate, to: toDate } = useMemo(() => {
    if (dateValue.startsWith("d:")) { const day = dateValue.slice(2); return { from: day, to: day }; }
    if (dateValue.startsWith("r:")) { const [, f, t] = dateValue.split(":"); return { from: f ?? "", to: t ?? "" }; }
    return { from: "", to: "" };
  }, [dateValue]);
  const dateIsRange = dateValue.startsWith("r:");
  const [datePickMode, setDatePickMode] = useState<"single" | "range">("single");
  const [dateOpen, setDateOpen] = useState(false);
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
      if (value.startsWith("d:")) return `Date: ${format(new Date(value.slice(2)), "MMM d, yyyy")}`;
      if (value.startsWith("r:")) {
        const [, f, t] = value.split(":");
        const fmt = (s: string) => (s ? format(new Date(s), "MMM d") : "…");
        return `Date: ${fmt(f)} → ${fmt(t)}`;
      }
      return `Date: ${value}`;
    }
    if (field === "scanner") return `Scanned By: ${value}`;
    if (field === "type") return `Type: ${TYPE_OPTIONS.find((o) => o.value === value)?.label ?? value}`;
    return value;
  };

  // Every distinct value for every generic filter column, fetched once from the server (Scan
  // History is paginated, so — unlike Overall Stock, which builds its Values checklist straight
  // from the fully-loaded rows already in the browser — there's no complete dataset on the
  // client to read distinct values from otherwise).
  const { data: filterValues = {} } = useQuery<Record<string, { value: string; label: string }[]>>({
    queryKey: ["/api/scan-sessions/reports/scan-history/filter-values"],
    queryFn: () => apiRequest("GET", "/api/scan-sessions/reports/scan-history/filter-values", undefined, false, true),
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
    { id: "plant", label: "Plant", filterType: "enum", options: filterValues.plant ?? [], accessor: (r) => r.plant },
  ], [filterValues]);
  const [columnConditions, setColumnConditions] = useState<Record<string, FilterCondition>>({});
  const setColumnCondition = (columnId: string, condition: FilterCondition) =>
    setColumnConditions((prev) => ({ ...prev, [columnId]: condition }));
  const clearColumnCondition = (columnId: string) =>
    setColumnConditions((prev) => {
      const next = { ...prev };
      delete next[columnId];
      return next;
    });
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
  const filtersJson = useMemo(() => {
    const list = Object.values(columnConditions).filter((c) => !isConditionEmpty(c));
    return list.length > 0 ? JSON.stringify(list) : undefined;
  }, [columnConditions]);

  // The single "+ Filter" entry point — Date/Scanner/Type plus every generic column (including
  // Plant), same unified list-then-builder pattern as Overall Stock.
  const [filterPickerOpen, setFilterPickerOpen] = useState(false);
  const [filterPickerKey, setFilterPickerKey] = useState("");
  const [filterPickerSearch, setFilterPickerSearch] = useState("");
  const filterPickerOptions = useMemo(() => {
    // Date is its own standalone control (below), not part of this "+ Filter" list — same split
    // as Overall Stock.
    const dims = [
      { key: "scanner", label: "Scanned By" },
      { key: "type", label: "Type" },
      ...filterableColumns.map((c) => ({ key: c.id, label: c.label })),
    ];
    const isActive = (key: string) =>
      ["scanner", "type"].includes(key)
        ? activeFilters.some((f) => f.field === key)
        : !!columnConditions[key];
    const q = filterPickerSearch.trim().toLowerCase();
    return dims.filter((d) => !isActive(d.key) && (!q || d.label.toLowerCase().includes(q)));
  }, [filterableColumns, activeFilters, columnConditions, filterPickerSearch]);
  const pickedFilterColumn = filterableColumns.find((c) => c.id === filterPickerKey) ?? null;
  const [visibleColumnIds, setVisibleColumnIds] = useState<Set<string>>(
    () => new Set(HISTORY_OPTIONAL_COLUMNS),
  );
  const toggleColumn = (key: string) =>
    setVisibleColumnIds((prev) => {
      const next = new Set(prev);
      if (next.has(key)) {
        // Keep at least one optional column visible.
        const remainingOptional = HISTORY_OPTIONAL_COLUMNS.filter((c) => c !== key && next.has(c));
        if (remainingOptional.length > 0) next.delete(key);
      } else next.add(key);
      return next;
    });

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

  useEffect(() => { setHistoryPage(1); }, [historySearch, activeFilters, filtersJson]);

  const historyOffset = (historyPage - 1) * HISTORY_PAGE_SIZE;
  const historyUrl = buildQueryUrl("/api/scan-sessions/reports/scan-history", {
    from:    fromDate       || undefined,
    to:      toDate         || undefined,
    search:  historySearch  || undefined,
    scanner: historyScanner || undefined,
    type:    historyType    || undefined,
    filters: filtersJson,
    limit:   HISTORY_PAGE_SIZE,
    offset:  historyOffset,
  });

  const { data: historyData, isLoading: historyLoading, isFetching: historyFetching } =
    useQuery<ScanHistoryResponse>({
      queryKey: [
        "/api/scan-sessions/reports/scan-history",
        selectedDate, historySearch, historyScanner, historyType, filtersJson, historyPage,
      ],
      queryFn: async () => {
        const r = await apiRequest("GET", historyUrl, undefined, false, true);
        return r ?? { items: [], total: 0, totalBoxes: 0, totalPallets: 0, extraCount: 0, scanners: [], limit: HISTORY_PAGE_SIZE, offset: 0 };
      },
      refetchInterval: 5000,
      placeholderData: (previousData) => previousData,
    });

  const historyItems        = historyData?.items ?? [];
  const historyTotal        = historyData?.total ?? 0;
  const historyScanners     = historyData?.scanners ?? [];
  const historyHasMore      = historyOffset + historyItems.length < historyTotal;

  // Export must cover every row matching the current filters, not just the current page —
  // the server caps `limit` at 100 (see /reports/scan-history), so this pages through with
  // the SAME filters until it has everything, then hands the full set to the exporter.
  // Previously the button exported `historyItems` directly, which is only the current
  // HISTORY_PAGE_SIZE (20) page — e.g. exporting "today" silently dropped every row past
  // page 1.
  async function fetchAllHistoryItems(): Promise<ScanHistoryItem[]> {
    const EXPORT_PAGE_SIZE = 100; // server-side max for `limit`
    let offset = 0;
    let total = Infinity;
    const all: ScanHistoryItem[] = [];
    while (offset < total) {
      const url = buildQueryUrl("/api/scan-sessions/reports/scan-history", {
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
    ["Sr. No", "Scanned By", "Code", "Item", "Barcode", "Order Date", "Plant", "Qty", "Pallets", "STV", "Type", "Time"],
    ...src.map((h) => [
      h.srNo ?? "",
      h.scannedByName ?? "",
      h.scannedByCode ?? "",
      h.itemName ?? "",
      h.barcode ?? "",
      h.orderDate ?? "",
      h.plant,
      h.totalQty,
      h.pallets != null ? parseFloat(String(h.pallets)).toFixed(2) : "",
      h.stv ?? "",
      h.isExchange ? "Exchange" : h.isEmptyBox ? "Empty Box" : h.isExtra ? "Extra" : "Regular",
      h.scannedAt ? format(new Date(h.scannedAt), "yyyy-MM-dd HH:mm") : "",
    ]),
  ];

  const dash = <span className="text-gray-300">—</span>;

  // Same table structure/styling as Overall Stock (DataTable + TableCard): sortable/resizable/
  // hideable columns, zebra stripes, business-report borders. No totals row here — the server
  // only ever hands us one page of rows, so a client-side sum would just total the visible page
  // instead of the real filtered total (the summary tiles above already show the true totals).
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
      cellClassName: "font-mono text-gray-500",
      render: (row) => row.barcode ?? dash,
    },
    {
      id: "order",
      header: "Order Date",
      width: 120,
      accessor: (row) => row.orderDate ?? "",
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
      render: (row) => (row.plant ? <PlantBadge plant={row.plant} /> : <span className="text-gray-300">—</span>),
    },
    {
      id: "qty",
      header: columnHeader("qty", "Qty"),
      width: 80,
      align: "right",
      accessor: (row) => row.totalQty,
      cellClassName: "font-bold",
      render: (row) =>
        row.isExchange ? (
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
      accessor: (row) => row.pallets,
      cellClassName: "font-semibold text-[#001d6e]",
      render: (row) =>
        row.pallets != null && Number(row.pallets) > 0 ? parseFloat(String(row.pallets)).toFixed(2) : dash,
    },
    {
      id: "stv",
      header: columnHeader("stv", "STV"),
      width: 90,
      accessor: (row) => row.stv,
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
            onChange={(v) => upsertSimpleFilter("type", v)}
            onClear={() => clearSimpleFilter("type")}
          />
        </span>
      ),
      width: 100,
      accessor: (row) => (row.isExchange ? "Exchange" : row.isEmptyBox ? "Empty Box" : row.isExtra ? "Extra" : "Regular"),
      render: (row) =>
        row.isExchange ? (
          <Badge className="bg-purple-100 text-purple-800 hover:bg-purple-100 text-[11px] px-1.5 border-0">Exchange</Badge>
        ) : row.isEmptyBox ? (
          <Badge className="bg-orange-100 text-orange-800 hover:bg-orange-100 text-[11px] px-1.5 border-0">Empty Box</Badge>
        ) : row.isExtra ? (
          <Badge className="bg-amber-100 text-amber-800 hover:bg-amber-100 text-[11px] px-1.5 border-0">Extra</Badge>
        ) : (
          <Badge className="bg-green-100 text-green-800 hover:bg-green-100 text-[11px] px-1.5 border-0">Regular</Badge>
        ),
    },
    {
      id: "time",
      header: columnHeader("time", "Time"),
      width: 130,
      accessor: (row) => row.scannedAt,
      cellClassName: "whitespace-nowrap text-gray-500",
      render: (row) => (row.scannedAt ? format(new Date(row.scannedAt), "MMM d, h:mm a") : dash),
    },
    ...(canVoidScan
      ? [
          {
            id: "void",
            header: "Void",
            hideable: false,
            width: 56,
            align: "center" as const,
            render: (row: ScanHistoryItem) =>
              !row.voided && !row.isExchange && (
                <Button size="sm" variant="ghost" className="h-7 w-7 p-0 text-gray-400 hover:text-red-600"
                  onClick={() => setVoidTarget(row)} title="Void this scan">
                  <Trash2 className="h-3.5 w-3.5" />
                </Button>
              ),
          } as DataTableColumn<ScanHistoryItem>,
        ]
      : []),
  ];

  return (
    <>
    <div className="flex-1 overflow-y-auto p-4 lg:p-6">
      <div className="max-w-7xl mx-auto space-y-4">
        <PageHeader
          icon={History}
          title="Scan History"
          description="Every individual scan event — who scanned what, when, and on which order."
        />

        {/* Table card — same shared DataTable component as Overall Stock: sortable/resizable/
            hideable columns, zebra stripes, mobile swipe hint. Pagination is server-driven
            (Prev/Next over 20-row pages), so it's rendered via renderFooter instead of the
            DataTable's own client pageIndex/pageSize controls. */}
        <TableCard
          icon={History}
          title="Scan Events"
          subtitle={
            <span className="inline-flex items-center gap-1.5">
              <span>{historyTotal > 0 ? `${historyItems.length} of ${historyTotal.toLocaleString()} events` : "0 events"}</span>
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

              {/* Standalone Date control — sits BEFORE "+ Filter", same as Overall Stock. Single
                  date or from/to range (both editable) plus quick-range presets; filters scan
                  date (scannedAt). */}
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
                        onClick={(e) => { e.stopPropagation(); clearSimpleFilter("date"); }}
                        className="ml-0.5 rounded p-0.5 hover:bg-[#001d6e]/10"
                      >
                        <X className="h-3 w-3" />
                      </span>
                    )}
                  </Button>
                </PopoverTrigger>
                {/* align="end" + avoidCollisions={false}: box anchors to the button's right edge
                    and never re-positions as its height changes while picking — stays put. */}
                <PopoverContent align="end" sideOffset={6} avoidCollisions={false} className="w-72">
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

                    {dateValue && (
                      <div className="flex items-center justify-end pt-1">
                        <button
                          type="button"
                          onClick={() => { clearSimpleFilter("date"); setDateOpen(false); }}
                          className="text-[11px] text-red-500 hover:underline"
                        >
                          Clear date
                        </button>
                      </div>
                    )}
                  </div>
                </PopoverContent>
              </Popover>

              {/* One unified "+ Filter" — Scanned By, Type, Plant, and every generic column in the
                  same searchable list, same pattern as Overall Stock. (Date is its own control.) */}
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
                        <Select onValueChange={(v) => { upsertSimpleFilter("type", v); setFilterPickerOpen(false); setFilterPickerKey(""); }}>
                          <SelectTrigger className="h-8 text-xs"><SelectValue placeholder="Choose a type…" /></SelectTrigger>
                          <SelectContent>
                            {TYPE_OPTIONS.map((o) => <SelectItem key={o.value} value={o.value}>{o.label}</SelectItem>)}
                          </SelectContent>
                        </Select>
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
                <Popover>
                  <PopoverTrigger asChild>
                    <Button size="sm" variant="outline" className={FILTER_BTN_CLASS}>
                      <ListFilter className="h-3.5 w-3.5 mr-1" />
                      Filters ({activeFilters.length + Object.keys(columnConditions).length})
                    </Button>
                  </PopoverTrigger>
                  <PopoverContent align="start" className="w-72">
                    <div className="space-y-0.5">
                      <p className="mb-1 text-[11px] font-semibold uppercase tracking-wide text-gray-500">Active filters</p>
                      {activeFilters.map((f) => (
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
                columns={historyColumns}
                visibleColumnIds={visibleColumnIds}
                onToggleColumn={toggleColumn}
                onSetAll={(visible) => setVisibleColumnIds(visible ? new Set(HISTORY_OPTIONAL_COLUMNS) : new Set())}
                buttonClassName={FILTER_BTN_CLASS}
              />

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
                      onSelect={() => {
                        const rows = historyExportRows(historyItems);
                        const dateSuffix = dateValue ? `-${fromDate}${dateIsRange ? `_to_${toDate}` : ""}` : "";
                        const suffix = `${dateSuffix}-${format(new Date(), "yyyy-MM-dd")}`;
                        if (fmt === "CSV")   downloadCsv(`scan-history${suffix}.csv`, rows);
                        if (fmt === "Excel") downloadExcel(`scan-history${suffix}.xlsx`, rows);
                        if (fmt === "PDF")   downloadPdf(`scan-history${suffix}.pdf`, "Scan History", rows);
                      }}
                    >
                      <FileDown className="h-3.5 w-3.5 mr-2 opacity-70" />
                      {fmt}
                    </DropdownMenuItem>
                  ))}
                </DropdownMenuContent>
              </DropdownMenu>

              {canUploadNotion && (
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
            className="space-y-0"
            containerClassName="rounded-none border-0"
            columns={historyColumns}
            data={historyItems}
            getRowId={(row) => String(row.id)}
            isLoading={historyLoading}
            loadingLabel="Loading scan history…"
            emptyState={`No scan events found${selectedDate ? " for this date" : ""}.`}
            noResultsState="No scan events match your search."
            hasActiveFilters={!!historySearch || activeFilters.length > 0 || Object.keys(columnConditions).length > 0}
            rowClassName={(row) => {
              // Stripe by the row's stable id (not its position), so a new scan landing at the
              // top doesn't flip every row's color/number on each poll.
              const stripeEven = row.id % 2 === 0;
              if (row.isExchange) return stripeEven ? "bg-purple-50/50" : "bg-purple-50/80";
              if (row.isEmptyBox) return stripeEven ? "bg-orange-50/50" : "bg-orange-50/80";
              if (row.voided) return "bg-gray-50 opacity-60";
              if (row.isExtra) return stripeEven ? "bg-amber-50/50" : "bg-amber-50/80";
              return undefined;
            }}
            enableZebraStripes
            enableColumnResizing
            enableColumnVisibility
            columnVisibility={visibleColumnIds}
            onColumnVisibilityChange={setVisibleColumnIds}
            showMobileSwipeHint
            headerClassName="bg-[#001d6e] text-white border-[#1a3a9c] hover:bg-[#0a2b7e] hover:text-white"
            renderFooter={(ctx) => (
              <tfoot>
                <tr>
                  <td colSpan={ctx.columnCount} className="border-t border-gray-300 bg-white px-4 py-2.5">
                    <div className="flex items-center justify-between text-xs text-gray-500">
                      <span>
                        {historyTotal > 0
                          ? `Showing ${historyOffset + 1}–${Math.min(historyOffset + historyItems.length, historyTotal)} of ${historyTotal.toLocaleString()} events`
                          : "No events"}
                      </span>
                      <div className="flex gap-2">
                        <Button variant="outline" size="sm" className="rounded-xl" disabled={historyPage <= 1}
                          onClick={() => setHistoryPage((p) => Math.max(1, p - 1))}>Prev</Button>
                        <Button variant="outline" size="sm" className="rounded-xl" disabled={!historyHasMore}
                          onClick={() => setHistoryPage((p) => p + 1)}>Next</Button>
                      </div>
                    </div>
                  </td>
                </tr>
              </tfoot>
            )}
          />
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
            onClick={() => { if (voidTarget) voidMutation.mutate({ id: voidTarget.id, reason: voidReason }); }}
            disabled={voidMutation.isPending}
            className="bg-red-600 hover:bg-red-700 text-white"
          >
            {voidMutation.isPending && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
            Void Scan
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
    </>
  );
};

export default Reports;
