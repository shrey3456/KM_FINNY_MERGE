import { useEffect, useState } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { format } from "date-fns";
import * as XLSX from "xlsx";
import jsPDF from "jspdf";
import autoTable from "jspdf-autotable";
import {
  History, Search, X, RefreshCw, FileDown, ChevronDown,
  User, UserCircle, Loader2, ScanLine, Upload,
} from "lucide-react";
import { useAuth } from "../../hooks/use-auth";
import { useToast } from "@/hooks/use-toast";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import {
  Table, TableBody, TableCell, TableHead, TableHeader, TableRow,
} from "@/components/ui/table";
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
  scanners: string[];
  limit: number;
  offset: number;
};

// ─── Constants ───────────────────────────────────────────────────────────────

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
  const historyScanners     = historyData?.scanners ?? [];
  const historyHasMore      = historyOffset + historyItems.length < historyTotal;

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
      h.isExtra ? "Extra" : "Regular",
      h.scannedAt ? format(new Date(h.scannedAt), "yyyy-MM-dd HH:mm") : "",
    ]),
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

        {/* Filter bar */}
        <div className="flex flex-wrap gap-2 items-center">
          <div className="flex items-center gap-1.5 rounded-md border bg-white px-2.5 h-9">
            <span className="text-xs text-gray-400 whitespace-nowrap">Date</span>
            <input
              type="date"
              className="text-xs bg-transparent outline-none text-gray-700 w-[130px]"
              value={selectedDate}
              onChange={(e) => setSelectedDate(e.target.value)}
            />
            {selectedDate && (
              <button onClick={() => setSelectedDate("")}>
                <X className="h-3.5 w-3.5 text-gray-400" />
              </button>
            )}
          </div>

          <div className="relative min-w-[180px] flex-1 max-w-xs">
            <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-gray-400" />
            <Input
              className="pl-9 h-9 text-sm"
              placeholder="Item, barcode, or scanner…"
              value={historySearch}
              onChange={(e) => setHistorySearch(e.target.value)}
            />
            {historySearch && (
              <button className="absolute right-2 top-1/2 -translate-y-1/2" onClick={() => setHistorySearch("")}>
                <X className="h-4 w-4 text-gray-400" />
              </button>
            )}
          </div>

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

          <Select value={historyPlant} onValueChange={setHistoryPlant}>
            <SelectTrigger className="h-9 w-[150px] text-sm">
              <SelectValue placeholder="All plants" />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="__all__">All plants</SelectItem>
              {plantList.map((p) => (
                <SelectItem key={p.id} value={p.name}>{p.name}</SelectItem>
              ))}
            </SelectContent>
          </Select>

          {historyFetching && !historyLoading && (
            <span className="flex items-center gap-1 text-xs text-emerald-600">
              <RefreshCw className="h-3 w-3 animate-spin" />Updating…
            </span>
          )}

          <div className="flex gap-2 ml-auto">
            {/* One Export control instead of three buttons; the format is picked from the menu. */}
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <Button variant="outline" size="sm" className="h-9 text-xs" disabled={historyItems.length === 0}>
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
              size="sm" className="h-9 text-xs bg-[#001d6e] hover:bg-[#00154b] text-white"
              onClick={() => { setNotionOpen(true); setNotionResult(null); setNotionError(null); }}
            >
              <Upload className="h-3.5 w-3.5 mr-1" />Upload to Notion
            </Button>
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
        <div className="rounded-xl border bg-white overflow-x-auto shadow-sm">
          <Table className="min-w-[1040px] text-xs sm:text-sm">
            <TableHeader>
              <TableRow className="bg-[#001d6e] hover:bg-[#001d6e]">
                <TableHead className="text-white font-semibold uppercase tracking-wide w-[44px] text-[11px]">#</TableHead>
                <TableHead className="text-white font-semibold uppercase tracking-wide min-w-[130px] text-[11px]">
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
                {isAdmin && <TableHead className="text-white font-semibold uppercase tracking-wide text-center text-[11px] w-[60px]">Void</TableHead>}
              </TableRow>
            </TableHeader>
            <TableBody>
              {historyLoading ? (
                <TableRow>
                  <TableCell colSpan={isAdmin ? 12 : 11} className="py-16 text-center text-sm text-gray-400">
                    <Loader2 className="h-5 w-5 animate-spin mx-auto mb-2 text-gray-300" />
                    Loading scan history…
                  </TableCell>
                </TableRow>
              ) : historyItems.length === 0 ? (
                <TableRow>
                  <TableCell colSpan={isAdmin ? 12 : 11} className="py-16 text-center">
                    <ScanLine className="h-10 w-10 text-gray-200 mx-auto mb-3" />
                    <p className="text-sm text-gray-400">
                      No scan events found{selectedDate ? " for this date" : ""}.
                    </p>
                  </TableCell>
                </TableRow>
              ) : (
                historyItems.map((h, idx) => {
                  // Stripe by the row's stable id (not its position), so a new scan
                  // landing at the top doesn't flip every row's color/number on each poll.
                  const stripeEven = h.id % 2 === 0;
                  const rowBg = h.voided
                    ? "bg-gray-50 opacity-60"
                    : h.isExtra
                    ? (stripeEven ? "bg-amber-50/50" : "bg-amber-50/80")
                    : (stripeEven ? "bg-white" : "bg-slate-50");
                  return (
                    <TableRow key={h.id} className={`${rowBg} transition-colors hover:bg-slate-100/70`}>
                      <TableCell className="text-gray-400 text-[11px] py-2.5 w-[44px]">
                        {historyOffset + idx + 1}
                      </TableCell>
                      <TableCell className="min-w-[130px] py-2.5">
                        <p className="font-medium text-gray-900 text-xs leading-tight">
                          {h.scannedByName ?? <span className="text-gray-300">—</span>}
                        </p>
                        {h.scannedByCode && (
                          <p className="text-[11px] text-gray-400 font-mono leading-tight">{h.scannedByCode}</p>
                        )}
                      </TableCell>
                      <TableCell className="min-w-[180px] max-w-[240px] py-2.5">
                        <p className={`font-medium text-gray-900 text-xs leading-snug whitespace-normal break-words ${h.voided ? "line-through" : ""}`}>
                          {h.itemName ?? <span className="text-gray-300">—</span>}
                        </p>
                        {h.voided && (
                          <p className="text-[10px] font-semibold text-red-500" title={h.voidReason ?? undefined}>
                            Voided{h.voidedAt ? ` · ${format(new Date(h.voidedAt), "MMM d, h:mm a")}` : ""}
                          </p>
                        )}
                      </TableCell>
                      <TableCell className="font-mono text-[11px] text-gray-500 py-2.5">
                        {h.barcode ?? <span className="text-gray-300">—</span>}
                      </TableCell>
                      <TableCell className="text-xs text-gray-700 py-2.5 max-w-[140px] truncate">
                        {h.orderName}
                      </TableCell>
                      <TableCell className="py-2.5">
                        <Badge variant="outline" className="text-[11px] px-1.5 py-0">{h.plant}</Badge>
                      </TableCell>
                      <TableCell className="text-right font-bold text-[#001d6e] py-2.5">
                        {h.totalQty.toLocaleString()}
                      </TableCell>
                      <TableCell className="text-right font-semibold text-[#001d6e] py-2.5">
                        {h.pallets != null && Number(h.pallets) > 0
                          ? parseFloat(String(h.pallets)).toFixed(2)
                          : <span className="text-gray-300 font-normal">—</span>}
                      </TableCell>
                      <TableCell className="text-xs text-gray-600 py-2.5">
                        {h.stv ?? <span className="text-gray-300">—</span>}
                      </TableCell>
                      <TableCell className="py-2.5">
                        {h.isExtra
                          ? <Badge className="bg-amber-100 text-amber-800 hover:bg-amber-100 text-[11px] px-1.5 border-0">Extra</Badge>
                          : <Badge className="bg-green-100 text-green-800 hover:bg-green-100 text-[11px] px-1.5 border-0">Regular</Badge>}
                      </TableCell>
                      <TableCell className="text-[11px] text-gray-500 whitespace-nowrap py-2.5">
                        {h.scannedAt ? format(new Date(h.scannedAt), "MMM d, h:mm a") : "—"}
                      </TableCell>
                      {isAdmin && (
                        <TableCell className="text-center py-2.5">
                          {!h.voided && (
                            <Button size="sm" variant="ghost" className="h-7 w-7 p-0 text-gray-400 hover:text-red-600"
                              onClick={() => setVoidTarget(h)} title="Void this scan">
                              <Trash2 className="h-3.5 w-3.5" />
                            </Button>
                          )}
                        </TableCell>
                      )}
                    </TableRow>
                  );
                })
              )}
            </TableBody>
          </Table>

          <div className="flex items-center justify-between border-t px-4 py-2.5 text-xs text-gray-500">
            <span>
              {historyTotal > 0
                ? `Showing ${historyOffset + 1}–${Math.min(historyOffset + historyItems.length, historyTotal)} of ${historyTotal.toLocaleString()} events`
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
