import { useEffect, useState } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { format } from "date-fns";
import * as XLSX from "xlsx";
import jsPDF from "jspdf";
import autoTable from "jspdf-autotable";
import {
  History, X, RefreshCw, FileDown, ChevronDown,
  User, Loader2, ScanLine, Upload, Trash2,
  Boxes, Layers, AlertTriangle, PackageX,
} from "lucide-react";
import { useAuth } from "../../hooks/use-auth";
import { useToast } from "@/hooks/use-toast";
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
import { Checkbox } from "@/components/ui/checkbox";
import { Label } from "@/components/ui/label";
import PageHeader from "../../components/PageHeader";
import { apiRequest } from "@/lib/queryClient";
import { DataTable, DataTableColumnToggle, type DataTableColumn } from "@/components/ui/data-table";
import { StatsBar } from "@/components/ui/stats-bar";
import { TableCard } from "@/components/ui/table-card";

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
// (rounded-none) for the business-report look — no soft/pill-shaped filter controls.
const FILTER_BTN_CLASS = "h-8 rounded-none border-0 bg-[#001d6e] text-white hover:bg-[#001552] hover:text-white text-xs";

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

// ─── Component ───────────────────────────────────────────────────────────────

const ALL_NOTION_COLUMNS = ["#", "Scanned By", "Code", "Item", "Barcode", "Order", "Plant", "Qty", "Pallets", "STV", "Type", "Time"] as const;

const Reports = () => {
  const { user } = useAuth();
  const { toast } = useToast();
  const queryClient = useQueryClient();
  const isAdmin = ["admin", "super-admin"].includes(((user as any)?.role ?? "").toLowerCase());
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
  const [selectedDate,   setSelectedDate]   = useState("");
  const [historyPage,    setHistoryPage]    = useState(1);
  const [historySearch,  setHistorySearch]  = useState("");
  const [historyScanner, setHistoryScanner] = useState("__all__");
  const [historyType,    setHistoryType]    = useState("all");
  const [historyPlant,   setHistoryPlant]   = useState("__all__");
  const [historyExporting, setHistoryExporting] = useState<string | null>(null);
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

  // Plant options for the filter. Non-admins are already restricted server-side, so this
  // dropdown mainly lets admins narrow to one plant; picking a plant you can't see returns
  // nothing (the server ignores/blocks it).
  const { data: plantList = [] } = useQuery<{ id: number; name: string }[]>({
    queryKey: ["/api/plants"],
    queryFn: () => apiRequest("GET", "/api/plants", undefined, false, true),
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
        date:    selectedDate                                   || undefined,
        search:  historySearch                                  || undefined,
        scanner: historyScanner !== "__all__" ? historyScanner : undefined,
        type:    historyType    !== "all"     ? historyType     : undefined,
        plant:   historyPlant   !== "__all__" ? historyPlant   : undefined,
      }, false, true);
      setNotionResult({ uploaded: (r as any).uploaded, fetched: (r as any).fetched, url: (r as any).url, errors: (r as any).errors ?? [] });
    } catch (e: any) {
      setNotionError(e?.message ?? "Upload failed.");
    } finally {
      setNotionUploading(false);
    }
  };

  useEffect(() => { setHistoryPage(1); }, [historySearch, historyScanner, historyType, historyPlant, selectedDate]);

  const historyOffset = (historyPage - 1) * HISTORY_PAGE_SIZE;
  const historyUrl = buildQueryUrl("/api/scan-sessions/reports/scan-history", {
    date:    selectedDate                                   || undefined,
    search:  historySearch                                  || undefined,
    scanner: historyScanner !== "__all__" ? historyScanner : undefined,
    type:    historyType    !== "all"     ? historyType     : undefined,
    plant:   historyPlant   !== "__all__" ? historyPlant   : undefined,
    limit:   HISTORY_PAGE_SIZE,
    offset:  historyOffset,
  });

  const { data: historyData, isLoading: historyLoading, isFetching: historyFetching } =
    useQuery<ScanHistoryResponse>({
      queryKey: [
        "/api/scan-sessions/reports/scan-history",
        selectedDate, historySearch, historyScanner, historyType, historyPlant, historyPage,
      ],
      queryFn: async () => {
        const r = await apiRequest("GET", withCacheBuster(historyUrl), undefined, false, true);
        return r ?? { items: [], total: 0, totalBoxes: 0, totalPallets: 0, extraCount: 0, scanners: [], limit: HISTORY_PAGE_SIZE, offset: 0 };
      },
      refetchInterval: 5000,
      placeholderData: (previousData) => previousData,
    });

  const historyItems        = historyData?.items ?? [];
  const historyTotal        = historyData?.total ?? 0;
  const historyTotalBoxes   = historyData?.totalBoxes ?? 0;
  const historyTotalPallets = historyData?.totalPallets ?? 0;
  const historyExtraCount   = historyData?.extraCount ?? 0;
  const historyEmptyBoxCount = historyData?.emptyBoxCount ?? 0;
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
        date:    selectedDate                                  || undefined,
        search:  historySearch                                 || undefined,
        scanner: historyScanner !== "__all__" ? historyScanner : undefined,
        type:    historyType    !== "all"     ? historyType    : undefined,
        plant:   historyPlant   !== "__all__" ? historyPlant   : undefined,
        limit:   EXPORT_PAGE_SIZE,
        offset,
      });
      const r: ScanHistoryResponse | undefined = await apiRequest("GET", withCacheBuster(url), undefined, false, true);
      const items = r?.items ?? [];
      if (items.length === 0) break; // guards against an infinite loop if total is ever wrong
      all.push(...items);
      total = r?.total ?? all.length;
      offset += items.length;
    }
    return all;
  }

  const historyExportRows = (src: ScanHistoryItem[]) => [
    ["#", "Scanned By", "Code", "Item", "Barcode", "Order", "Plant", "Qty", "Pallets", "STV", "Type", "Time"],
    ...src.map((h, i) => [
      i + 1,
      h.scannedByName ?? "",
      h.scannedByCode ?? "",
      h.itemName ?? "",
      h.barcode ?? "",
      h.orderName,
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
      header: "#",
      hideable: false,
      width: 48,
      cellClassName: "text-gray-400 tabular-nums",
      render: (_row, rowIndex) => historyOffset + rowIndex + 1,
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
      header: "Barcode",
      width: 120,
      accessor: (row) => row.barcode,
      cellClassName: "font-mono text-gray-500",
      render: (row) => row.barcode ?? dash,
    },
    {
      id: "order",
      header: "Order",
      width: 140,
      accessor: (row) => row.orderName,
      cellClassName: "truncate",
      render: (row) => row.orderName,
    },
    {
      id: "plant",
      header: "Plant",
      width: 90,
      accessor: (row) => row.plant,
      render: (row) => <Badge variant="outline" className="text-[11px] px-1.5 py-0">{row.plant}</Badge>,
    },
    {
      id: "qty",
      header: "Qty",
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
      header: "Pallets",
      width: 90,
      align: "right",
      accessor: (row) => row.pallets,
      cellClassName: "font-semibold text-[#001d6e]",
      render: (row) =>
        row.pallets != null && Number(row.pallets) > 0 ? parseFloat(String(row.pallets)).toFixed(2) : dash,
    },
    {
      id: "stv",
      header: "STV",
      width: 90,
      accessor: (row) => row.stv,
      cellClassName: "text-gray-600",
      render: (row) => row.stv ?? dash,
    },
    {
      id: "type",
      header: "Type",
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
      header: "Time",
      width: 130,
      accessor: (row) => row.scannedAt,
      cellClassName: "whitespace-nowrap text-gray-500",
      render: (row) => (row.scannedAt ? format(new Date(row.scannedAt), "MMM d, h:mm a") : dash),
    },
    ...(isAdmin
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

        {/* Stats+filters and the table share ONE bordered box (divide-y draws the single line
            between them) instead of two separate boxes with a gap — reads as one section. */}
        <div className="rounded-xl border border-gray-300 bg-white shadow-sm overflow-hidden divide-y divide-gray-300">
        {/* Summary tiles + filters — same "business report" treatment as Overall Stock:
            squared tiles/controls (rounded-none), solid navy filter buttons. */}
        <StatsBar
          className="rounded-none shadow-none border-0 [&_.divide-x]:divide-gray-300"
          stats={[
            { icon: History, tone: "navy", value: historyTotal.toLocaleString(), label: "Total Events" },
            { icon: Boxes, tone: "navy", value: historyTotalBoxes.toLocaleString(), label: "Total Boxes" },
            {
              icon: Layers, tone: "navy",
              value: historyTotalPallets > 0 ? parseFloat(String(historyTotalPallets)).toFixed(2) : "—",
              label: "Total Pallets",
            },
            { icon: AlertTriangle, tone: "amber", value: historyExtraCount.toLocaleString(), label: "Extra Events" },
            { icon: PackageX, tone: "amber", value: historyEmptyBoxCount.toLocaleString(), label: "Empty Boxes" },
          ]}
          actions={
            <>
              <div className="flex items-center gap-1.5 h-8 rounded-none border border-gray-300 bg-white px-2.5">
                <span className="text-xs text-gray-400 whitespace-nowrap">Date</span>
                <input
                  type="date"
                  className="text-xs bg-transparent outline-none text-gray-700 w-[120px]"
                  value={selectedDate}
                  onChange={(e) => setSelectedDate(e.target.value)}
                />
                {selectedDate && (
                  <button onClick={() => setSelectedDate("")}>
                    <X className="h-3.5 w-3.5 text-gray-400" />
                  </button>
                )}
              </div>

              <Select value={historyScanner} onValueChange={setHistoryScanner}>
                <SelectTrigger className={`w-[150px] gap-1.5 ${FILTER_BTN_CLASS}`}>
                  <User className="h-3.5 w-3.5 shrink-0" />
                  <SelectValue placeholder="All scanners" />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="__all__">All scanners</SelectItem>
                  {historyScanners.map((name) => (
                    <SelectItem key={name} value={name}>{name}</SelectItem>
                  ))}
                </SelectContent>
              </Select>

              <Select value={historyType} onValueChange={setHistoryType}>
                <SelectTrigger className={`w-[130px] gap-1.5 ${FILTER_BTN_CLASS}`}>
                  <SelectValue placeholder="All types" />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="all">All types</SelectItem>
                  <SelectItem value="regular">Regular only</SelectItem>
                  <SelectItem value="extra">Extra only</SelectItem>
                  <SelectItem value="empty">Empty Box only</SelectItem>
                  <SelectItem value="exchange">Exchange only</SelectItem>
                </SelectContent>
              </Select>

              <Select value={historyPlant} onValueChange={setHistoryPlant}>
                <SelectTrigger className={`w-[140px] gap-1.5 ${FILTER_BTN_CLASS}`}>
                  <SelectValue placeholder="All plants" />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="__all__">All plants</SelectItem>
                  {plantList.map((p) => (
                    <SelectItem key={p.id} value={p.name}>{p.name}</SelectItem>
                  ))}
                </SelectContent>
              </Select>

              {/* Always mounted (visibility toggled, not presence) so the 5s poll never shifts
                  the filter bar layout — a mount/unmount here was pushing Export sideways
                  every cycle. */}
              <span
                className={`flex items-center gap-1 text-xs text-emerald-600 ${historyFetching && !historyLoading ? "visible" : "invisible"}`}
                aria-hidden={!(historyFetching && !historyLoading)}
              >
                <RefreshCw className="h-3 w-3 animate-spin" />Updating…
              </span>

              <div className="ml-auto flex gap-2">
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
                          const suffix = `${selectedDate ? "-" + selectedDate : ""}-${format(new Date(), "yyyy-MM-dd")}`;
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
                <Button
                  size="sm" className={FILTER_BTN_CLASS}
                  onClick={() => { setNotionOpen(true); setNotionResult(null); setNotionError(null); }}
                >
                  <Upload className="h-3.5 w-3.5 mr-1" />Upload to Notion
                </Button>
              </div>
            </>
          }
        />

        {/* Table card — same shared DataTable component as Overall Stock: sortable/resizable/
            hideable columns, zebra stripes, mobile swipe hint. Pagination is server-driven
            (Prev/Next over 20-row pages), so it's rendered via renderFooter instead of the
            DataTable's own client pageIndex/pageSize controls. */}
        <TableCard
          icon={History}
          title="Scan Events"
          subtitle={historyTotal > 0 ? `${historyItems.length} of ${historyTotal.toLocaleString()} events` : "0 events"}
          searchValue={historySearch}
          onSearchChange={setHistorySearch}
          searchPlaceholder="Item, barcode, or scanner…"
          className="rounded-none shadow-none border-0"
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
            hasActiveFilters={!!historySearch}
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
                        <Button variant="outline" size="sm" className="rounded-none" disabled={historyPage <= 1}
                          onClick={() => setHistoryPage((p) => Math.max(1, p - 1))}>Prev</Button>
                        <Button variant="outline" size="sm" className="rounded-none" disabled={!historyHasMore}
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
            <div className="grid grid-cols-3 gap-x-4 gap-y-2 rounded-lg border bg-gray-50 p-3">
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

          {/* Active filters note */}
          {(selectedDate || historySearch || historyScanner !== "__all__" || historyType !== "all") && (
            <p className="text-[11px] text-amber-600 bg-amber-50 border border-amber-200 rounded px-2.5 py-1.5">
              Active filters will be applied — only filtered records will be uploaded (max 2000 rows).
            </p>
          )}
          {!selectedDate && historySearch === "" && historyScanner === "__all__" && historyType === "all" && (
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

    {/* Void scan confirmation — admin-only. Keeps the row in history (never deleted), marked
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
