import { useEffect, useMemo, useState } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { format } from "date-fns";
import * as XLSX from "xlsx";
import jsPDF from "jspdf";
import autoTable from "jspdf-autotable";
import {
  History, Truck, Coins, Search, X, RefreshCw, FileDown,
  User, UserCircle, Loader2, ScanLine, ClipboardList, Package,
  Layers, PieChart, Trash2,
} from "lucide-react";
import {
  Table, TableBody, TableCell, TableHead, TableHeader, TableRow,
} from "@/components/ui/table";
import {
  Card, CardContent, CardDescription, CardHeader, CardTitle,
} from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Badge } from "@/components/ui/badge";
import {
  Select, SelectContent, SelectItem, SelectTrigger, SelectValue,
} from "@/components/ui/select";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { ScrollArea } from "@/components/ui/scroll-area";
import {
  Dialog, DialogContent, DialogDescription,
  DialogFooter, DialogHeader, DialogTitle,
} from "@/components/ui/dialog";
import PageHeader from "../components/PageHeader";
import { apiRequest } from "@/lib/queryClient";
import { getCurrentUserPermissions } from "../lib/permissions";

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
const OLD_SCAN_PAGE_SIZE = 10;

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

function parseLocalTs(ts: string | null | undefined): Date | null {
  if (!ts) return null;
  return new Date(ts.replace(/Z$/, ""));
}

function resolveIpp(itemsPerPallet: number, productName?: string): number {
  if (itemsPerPallet > 0) return itemsPerPallet;
  if (!productName) return 0;
  const star = productName.match(/\*(\d{1,5})/);
  if (star) { const n = parseInt(star[1], 10); if (n > 1) return n; }
  const standalone = productName.match(/\b(\d{1,4})\b/);
  if (standalone) { const n = parseInt(standalone[1], 10); if (n > 1) return n; }
  return 0;
}

function formatPallets(quantity: number, itemsPerPallet: number, productName?: string): string {
  const ipp = resolveIpp(itemsPerPallet, productName);
  if (ipp <= 0) return "—";
  const p = quantity / ipp;
  return p % 1 === 0 ? String(p) : p.toFixed(2);
}

const actionStyles: Record<string, string> = {
  add:    "bg-emerald-100 text-emerald-800 hover:bg-emerald-100",
  remove: "bg-red-100 text-red-800 hover:bg-red-100",
  update: "bg-blue-100 text-blue-800 hover:bg-blue-100",
};

// ─── Component ───────────────────────────────────────────────────────────────

const Reports = () => {
  const [currentTab, setCurrentTab] = useState("order-scan-history");
  const queryClient = useQueryClient();

  // ── Order Scan History state ───────────────────────────────────────────────
  const [selectedDate,   setSelectedDate]   = useState("");
  const [historyPage,    setHistoryPage]    = useState(1);
  const [historySearch,  setHistorySearch]  = useState("");
  const [historyScanner, setHistoryScanner] = useState("__all__");
  const [historyType,    setHistoryType]    = useState("all");

  useEffect(() => { setHistoryPage(1); }, [historySearch, historyScanner, historyType, selectedDate]);

  const historyOffset = (historyPage - 1) * HISTORY_PAGE_SIZE;
  const historyUrl = buildQueryUrl("/api/scan-sessions/reports/scan-history", {
    date:    selectedDate                                   || undefined,
    search:  historySearch                                  || undefined,
    scanner: historyScanner !== "__all__" ? historyScanner : undefined,
    type:    historyType    !== "all"     ? historyType     : undefined,
    limit:   HISTORY_PAGE_SIZE,
    offset:  historyOffset,
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
      refetchInterval: 15000,
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

  // ── Old scan history (warehouse stock scans) state ────────────────────────
  const [scanSearch,      setScanSearch]      = useState("");
  const [actionFilter,    setActionFilter]    = useState("all");
  const [scannerFilter,   setScannerFilter]   = useState("all");
  const [deleteId,        setDeleteId]        = useState<number | null>(null);
  const [scanPage,        setScanPage]        = useState(1);

  useEffect(() => { setScanPage(1); }, [scanSearch, actionFilter, scannerFilter]);

  const scanOffset = (scanPage - 1) * OLD_SCAN_PAGE_SIZE;
  const { data: scansRaw, isLoading: isLoadingScans, refetch: refetchScans } = useQuery<any[]>({
    queryKey: ["/api/scans", { limit: OLD_SCAN_PAGE_SIZE + 1, offset: scanOffset }],
    staleTime: 0,
  });

  const hasMoreScans = (scansRaw ?? []).length > OLD_SCAN_PAGE_SIZE;
  const scans = useMemo(() => {
    return [...(scansRaw ?? [])]
      .sort((a, b) => new Date(b.scannedAt || 0).getTime() - new Date(a.scannedAt || 0).getTime())
      .slice(0, OLD_SCAN_PAGE_SIZE);
  }, [scansRaw]);

  const scannerOptions = useMemo(() => {
    const names = new Set<string>();
    scans.forEach((s) => { if (s.scannerName) names.add(s.scannerName); });
    return Array.from(names).sort();
  }, [scans]);

  const filteredScans = useMemo(() => {
    const q = scanSearch.toLowerCase();
    return scans.filter((s) => {
      const matchSearch  = !q || s.productName?.toLowerCase().includes(q) || s.barcode?.toLowerCase().includes(q) || s.productSku?.toLowerCase().includes(q);
      const matchAction  = actionFilter  === "all" || s.action      === actionFilter;
      const matchScanner = scannerFilter === "all" || s.scannerName === scannerFilter;
      return matchSearch && matchAction && matchScanner;
    });
  }, [scans, scanSearch, actionFilter, scannerFilter]);

  const userPermissions = getCurrentUserPermissions();
  const canDelete = userPermissions.canDeleteOperationalItems;

  const deleteMutation = useMutation({
    mutationFn: async (id: number) => {
      const res = await fetch(`/api/scans/${id}`, { method: "DELETE" });
      if (!res.ok) throw new Error("Failed to delete scan record");
    },
    onSuccess: () => {
      setDeleteId(null);
      queryClient.invalidateQueries({ queryKey: ["/api/scans"] });
      queryClient.invalidateQueries({ queryKey: ["/api/products"] });
    },
  });

  // ── Load Operations ────────────────────────────────────────────────────────
  const { data: loadingOperations, isLoading: isLoadingOperations } = useQuery({
    queryKey: ["/api/loading-operations"],
  });

  // ── Stock Value ────────────────────────────────────────────────────────────
  const { data: products, isLoading: isLoadingProducts } = useQuery({
    queryKey: ["/api/products"],
  });

  const totalStockValue = useMemo(() => {
    if (!products || !Array.isArray(products)) return 0;
    return (products as any[]).reduce((t: number, p: any) => t + (p.stock || 0) * (p.price || 0), 0);
  }, [products]);

  // ─────────────────────────────────────────────────────────────────────────
  return (
    <div className="flex-1 overflow-y-auto p-4 lg:p-6">
      <div className="max-w-7xl mx-auto">
        <PageHeader
          icon={PieChart}
          title="Reports"
          description="Scan history, load operations, and inventory analytics"
        />

        <Tabs value={currentTab} onValueChange={setCurrentTab} className="w-full">
          <TabsList className="grid grid-cols-4 mb-6">
            <TabsTrigger value="order-scan-history" className="flex items-center gap-1.5">
              <History className="h-4 w-4" />
              <span className="hidden sm:inline">Order Scan History</span>
              <span className="sm:hidden">Scan History</span>
            </TabsTrigger>
            <TabsTrigger value="scan-logs" className="flex items-center gap-1.5">
              <Package className="h-4 w-4" />
              <span className="hidden sm:inline">Warehouse Logs</span>
              <span className="sm:hidden">Logs</span>
            </TabsTrigger>
            <TabsTrigger value="load-operations" className="flex items-center gap-1.5">
              <Truck className="h-4 w-4" />
              <span className="hidden sm:inline">Load Operations</span>
              <span className="sm:hidden">Load Ops</span>
            </TabsTrigger>
            <TabsTrigger value="stock-value" className="flex items-center gap-1.5">
              <Coins className="h-4 w-4" />
              <span className="hidden sm:inline">Stock Value</span>
              <span className="sm:hidden">Stock</span>
            </TabsTrigger>
          </TabsList>

          {/* ══════════════════════════════════════════════════════════════════ */}
          {/* ── Tab 1: Order Scan History ─────────────────────────────────── */}
          {/* ══════════════════════════════════════════════════════════════════ */}
          <TabsContent value="order-scan-history" className="space-y-4">

            {/* Page title row */}
            <div className="flex items-center gap-2">
              <History className="h-5 w-5 text-[#001d6e]" />
              <h2 className="text-lg font-semibold text-gray-900">Scan History</h2>
              {historyFetching && !historyLoading && (
                <span className="flex items-center gap-1 text-xs text-emerald-600">
                  <RefreshCw className="h-3 w-3 animate-spin" />Updating…
                </span>
              )}
            </div>
            <p className="text-xs text-gray-500 -mt-2">
              Every individual scan event — who scanned what, when, and on which order.
            </p>

            {/* Filter bar */}
            <div className="flex flex-wrap gap-2 items-center">
              {/* Date */}
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

              {/* Search */}
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
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {historyLoading ? (
                    <TableRow>
                      <TableCell colSpan={11} className="py-16 text-center text-sm text-gray-400">
                        <Loader2 className="h-5 w-5 animate-spin mx-auto mb-2 text-gray-300" />
                        Loading scan history…
                      </TableCell>
                    </TableRow>
                  ) : historyItems.length === 0 ? (
                    <TableRow>
                      <TableCell colSpan={11} className="py-16 text-center">
                        <ScanLine className="h-10 w-10 text-gray-200 mx-auto mb-3" />
                        <p className="text-sm text-gray-400">
                          No scan events found{selectedDate ? " for this date" : ""}.
                        </p>
                      </TableCell>
                    </TableRow>
                  ) : (
                    historyItems.map((h, idx) => {
                      const rowBg = h.isExtra
                        ? (idx % 2 === 0 ? "bg-amber-50/50" : "bg-amber-50/80")
                        : (idx % 2 === 0 ? "bg-white" : "bg-slate-50");
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
                            <p className="font-medium text-gray-900 text-xs leading-snug whitespace-normal break-words">
                              {h.itemName ?? <span className="text-gray-300">—</span>}
                            </p>
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
          </TabsContent>

          {/* ══════════════════════════════════════════════════════════════════ */}
          {/* ── Tab 2: Warehouse Scan Logs ────────────────────────────────── */}
          {/* ══════════════════════════════════════════════════════════════════ */}
          <TabsContent value="scan-logs" className="space-y-4">

            {/* Filter bar */}
            <Card className="rounded-xl border shadow-sm">
              <CardContent className="p-4">
                <div className="flex flex-wrap gap-3 items-end">
                  <div className="flex-1 min-w-[180px]">
                    <label className="text-xs font-medium text-gray-500 mb-1.5 block uppercase tracking-wide">Search</label>
                    <div className="relative">
                      <Search className="absolute left-2.5 top-2.5 h-4 w-4 text-gray-400" />
                      <Input
                        placeholder="Product, SKU or barcode…"
                        className="pl-9"
                        value={scanSearch}
                        onChange={(e) => setScanSearch(e.target.value)}
                      />
                    </div>
                  </div>
                  <div className="w-40">
                    <label className="text-xs font-medium text-gray-500 mb-1.5 block uppercase tracking-wide">Action</label>
                    <Select value={actionFilter} onValueChange={setActionFilter}>
                      <SelectTrigger><SelectValue placeholder="All actions" /></SelectTrigger>
                      <SelectContent>
                        <SelectItem value="all">All Actions</SelectItem>
                        <SelectItem value="add">Add</SelectItem>
                        <SelectItem value="remove">Remove</SelectItem>
                        <SelectItem value="update">Update</SelectItem>
                      </SelectContent>
                    </Select>
                  </div>
                  <div className="w-44">
                    <label className="text-xs font-medium text-gray-500 mb-1.5 block uppercase tracking-wide">Scanned By</label>
                    <Select value={scannerFilter} onValueChange={setScannerFilter}>
                      <SelectTrigger><SelectValue placeholder="All users" /></SelectTrigger>
                      <SelectContent>
                        <SelectItem value="all">All Users</SelectItem>
                        {scannerOptions.map((name) => (
                          <SelectItem key={name} value={name}>{name}</SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                  </div>
                  <div className="flex gap-2">
                    {(scanSearch || actionFilter !== "all" || scannerFilter !== "all") && (
                      <Button variant="ghost" size="icon" title="Clear filters"
                        onClick={() => { setScanSearch(""); setActionFilter("all"); setScannerFilter("all"); }}>
                        <X className="h-4 w-4" />
                      </Button>
                    )}
                    <Button variant="outline" size="icon" title="Refresh" onClick={() => refetchScans()}>
                      <RefreshCw className="h-4 w-4" />
                    </Button>
                  </div>
                </div>
              </CardContent>
            </Card>

            <Card className="rounded-xl border shadow-sm">
              <CardHeader className="pb-3 flex flex-row items-center justify-between">
                <div>
                  <CardTitle className="text-base">Warehouse Scan Records</CardTitle>
                  <CardDescription>Inventory add / remove / update scans</CardDescription>
                </div>
                <span className="text-sm text-gray-400">
                  {isLoadingScans ? "Loading…" : `${filteredScans.length} record${filteredScans.length !== 1 ? "s" : ""}`}
                </span>
              </CardHeader>
              <CardContent className="p-0">
                {isLoadingScans ? (
                  <div className="py-16 flex items-center justify-center">
                    <Loader2 className="h-6 w-6 animate-spin text-gray-400" />
                  </div>
                ) : filteredScans.length === 0 ? (
                  <div className="py-16 text-center">
                    <ScanLine className="h-10 w-10 text-gray-200 mx-auto mb-3" />
                    <p className="text-gray-500 font-medium">No records found</p>
                  </div>
                ) : (
                  <ScrollArea className="h-[520px]">
                    <Table>
                      <TableHeader>
                        <TableRow className="bg-gray-50 hover:bg-gray-50">
                          <TableHead className="pl-5 text-xs font-semibold uppercase tracking-wide text-gray-500">Timestamp</TableHead>
                          <TableHead className="text-xs font-semibold uppercase tracking-wide text-gray-500">Product</TableHead>
                          <TableHead className="text-xs font-semibold uppercase tracking-wide text-gray-500">Barcode</TableHead>
                          <TableHead className="text-xs font-semibold uppercase tracking-wide text-gray-500">Action</TableHead>
                          <TableHead className="text-xs font-semibold uppercase tracking-wide text-gray-500 text-right">
                            <span className="flex items-center justify-end gap-1"><Layers className="h-3 w-3" />Quantity</span>
                          </TableHead>
                          <TableHead className="text-xs font-semibold uppercase tracking-wide text-gray-500">
                            <span className="flex items-center gap-1"><UserCircle className="h-3 w-3" />Scanned By</span>
                          </TableHead>
                          {canDelete && <TableHead className="w-10" />}
                        </TableRow>
                      </TableHeader>
                      <TableBody>
                        {filteredScans.map((scan: any) => (
                          <TableRow key={scan.id} className="group hover:bg-blue-50/30">
                            <TableCell className="pl-5">
                              <p className="text-sm text-gray-800 whitespace-nowrap">
                                {scan.scannedAt ? format(parseLocalTs(scan.scannedAt)!, "MMM d, yyyy") : "—"}
                              </p>
                              <p className="text-xs text-gray-400 whitespace-nowrap">
                                {scan.scannedAt ? format(parseLocalTs(scan.scannedAt)!, "h:mm a") : ""}
                              </p>
                            </TableCell>
                            <TableCell>
                              <p className="font-medium text-gray-900 max-w-[220px] truncate text-sm">{scan.productName || "—"}</p>
                              {scan.productSku && scan.productSku !== "N/A" && (
                                <p className="text-xs text-gray-400">{scan.productSku}</p>
                              )}
                            </TableCell>
                            <TableCell>
                              <span className="font-mono text-xs text-gray-600">{scan.barcode || "—"}</span>
                            </TableCell>
                            <TableCell>
                              <Badge className={`text-xs capitalize ${actionStyles[scan.action] ?? "bg-gray-100 text-gray-700"}`}>
                                {scan.action || "—"}
                              </Badge>
                            </TableCell>
                            <TableCell className="text-right">
                              <span className="font-semibold text-[#001d6e]">
                                {formatPallets(scan.quantity, scan.itemsPerPallet, scan.productName)}
                              </span>
                            </TableCell>
                            <TableCell>
                              <p className="text-sm text-gray-800">{scan.scannerName || "—"}</p>
                              {scan.scannerDepartment && scan.scannerDepartment !== "N/A" && (
                                <p className="text-xs text-gray-400">{scan.scannerDepartment}</p>
                              )}
                            </TableCell>
                            {canDelete && (
                              <TableCell>
                                <Button
                                  variant="ghost" size="icon"
                                  className="h-7 w-7 opacity-0 group-hover:opacity-100 text-gray-400 hover:text-red-500"
                                  onClick={() => setDeleteId(scan.id)}
                                >
                                  <Trash2 className="h-3.5 w-3.5" />
                                </Button>
                              </TableCell>
                            )}
                          </TableRow>
                        ))}
                      </TableBody>
                    </Table>
                  </ScrollArea>
                )}
                {!isLoadingScans && scans.length > 0 && (
                  <div className="flex items-center justify-between border-t px-5 py-3 text-xs text-gray-500">
                    <span>Page {scanPage}</span>
                    <div className="flex gap-2">
                      <Button variant="outline" size="sm" disabled={scanPage <= 1}
                        onClick={() => setScanPage((p) => Math.max(1, p - 1))}>Prev</Button>
                      <Button variant="outline" size="sm" disabled={!hasMoreScans}
                        onClick={() => setScanPage((p) => p + 1)}>Next</Button>
                    </div>
                  </div>
                )}
              </CardContent>
            </Card>
          </TabsContent>

          {/* ══════════════════════════════════════════════════════════════════ */}
          {/* ── Tab 3: Load Operations ────────────────────────────────────── */}
          {/* ══════════════════════════════════════════════════════════════════ */}
          <TabsContent value="load-operations">
            <Card className="rounded-xl border shadow-sm">
              <CardHeader className="flex flex-row items-center justify-between">
                <div>
                  <CardTitle>Load Operations</CardTitle>
                  <CardDescription>All load operations including status and references</CardDescription>
                </div>
                <div className="flex gap-2">
                  <Button
                    variant="default"
                    className="gap-1 bg-[#001d6e] hover:bg-[#001d6e]/90"
                    onClick={() => window.location.href = "/gj-operations"}
                  >
                    <Truck className="h-4 w-4" />View Operations
                  </Button>
                  <Button
                    variant="outline" className="gap-1"
                    onClick={() => window.open("/api/loading-operations/export-csv", "_blank")}
                  >
                    <ClipboardList className="h-4 w-4" />Export CSV
                  </Button>
                </div>
              </CardHeader>
              <CardContent>
                {isLoadingOperations ? (
                  <div className="py-12 flex items-center justify-center">
                    <Loader2 className="h-6 w-6 animate-spin" />
                  </div>
                ) : !loadingOperations || (loadingOperations as any[]).length === 0 ? (
                  <div className="text-center py-8">
                    <p className="text-gray-500">No load operations available</p>
                  </div>
                ) : (
                  <ScrollArea className="h-[550px]">
                    <Table>
                      <TableHeader>
                        <TableRow className="bg-gray-50 hover:bg-gray-50">
                          <TableHead className="text-xs font-semibold uppercase tracking-wide text-gray-500">Reference #</TableHead>
                          <TableHead className="text-xs font-semibold uppercase tracking-wide text-gray-500">Status</TableHead>
                          <TableHead className="text-xs font-semibold uppercase tracking-wide text-gray-500">Created</TableHead>
                          <TableHead className="text-xs font-semibold uppercase tracking-wide text-gray-500">Completed</TableHead>
                        </TableRow>
                      </TableHeader>
                      <TableBody>
                        {(loadingOperations as any[]).map((op) => (
                          <TableRow key={op.id} className="hover:bg-blue-50/30">
                            <TableCell className="font-medium">{op.referenceNumber}</TableCell>
                            <TableCell>
                              <Badge variant="secondary" className="bg-purple-100 text-purple-800 hover:bg-purple-200">
                                {op.status}
                              </Badge>
                            </TableCell>
                            <TableCell>{op.createdAt ? format(parseLocalTs(op.createdAt)!, "MMM d, yyyy") : "—"}</TableCell>
                            <TableCell>{op.completedAt ? format(parseLocalTs(op.completedAt)!, "MMM d, yyyy") : "—"}</TableCell>
                          </TableRow>
                        ))}
                      </TableBody>
                    </Table>
                  </ScrollArea>
                )}
              </CardContent>
            </Card>
          </TabsContent>

          {/* ══════════════════════════════════════════════════════════════════ */}
          {/* ── Tab 4: Stock Value ────────────────────────────────────────── */}
          {/* ══════════════════════════════════════════════════════════════════ */}
          <TabsContent value="stock-value" className="space-y-6">
            <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
              {[
                {
                  label: "Total Stock Value",
                  value: isLoadingProducts
                    ? null
                    : `₹${new Intl.NumberFormat("en-IN").format(totalStockValue)}`,
                },
                {
                  label: "Total SKUs",
                  value: isLoadingProducts ? null : String((products as any[])?.length ?? 0),
                },
                {
                  label: "Avg Item Value",
                  value: isLoadingProducts
                    ? null
                    : products && (products as any[]).length > 0
                      ? `₹${new Intl.NumberFormat("en-IN").format(Math.round(totalStockValue / (products as any[]).length))}`
                      : "₹0",
                },
              ].map(({ label, value }) => (
                <Card key={label} className="rounded-xl border shadow-sm">
                  <CardContent className="p-6">
                    <p className="text-sm text-muted-foreground mb-1">{label}</p>
                    <p className="text-3xl font-bold">
                      {value === null ? <Loader2 className="h-6 w-6 animate-spin" /> : value}
                    </p>
                  </CardContent>
                </Card>
              ))}
            </div>

            <Card className="rounded-xl border shadow-sm">
              <CardHeader>
                <CardTitle>Item Value Breakdown</CardTitle>
                <CardDescription>Inventory with stock quantity and value per item</CardDescription>
              </CardHeader>
              <CardContent>
                {isLoadingProducts ? (
                  <div className="py-12 flex items-center justify-center">
                    <Loader2 className="h-6 w-6 animate-spin" />
                  </div>
                ) : !products || (products as any[]).length === 0 ? (
                  <div className="text-center py-8">
                    <p className="text-gray-500">No products available</p>
                  </div>
                ) : (
                  <ScrollArea className="h-[400px]">
                    <Table>
                      <TableHeader>
                        <TableRow className="bg-gray-50 hover:bg-gray-50">
                          <TableHead className="text-xs font-semibold uppercase tracking-wide text-gray-500">Item Name</TableHead>
                          <TableHead className="text-xs font-semibold uppercase tracking-wide text-gray-500">Category</TableHead>
                          <TableHead className="text-xs font-semibold uppercase tracking-wide text-gray-500 text-right">Stock Qty</TableHead>
                          <TableHead className="text-xs font-semibold uppercase tracking-wide text-gray-500 text-right">Unit Price</TableHead>
                          <TableHead className="text-xs font-semibold uppercase tracking-wide text-gray-500 text-right">Total Value</TableHead>
                        </TableRow>
                      </TableHeader>
                      <TableBody>
                        {(products as any[]).map((product) => (
                          <TableRow key={product.id} className="hover:bg-blue-50/30">
                            <TableCell className="font-medium">{product.name}</TableCell>
                            <TableCell className="text-gray-500">{product.category || "—"}</TableCell>
                            <TableCell className="text-right">{product.stock || 0}</TableCell>
                            <TableCell className="text-right">₹{new Intl.NumberFormat("en-IN").format(product.price || 0)}</TableCell>
                            <TableCell className="text-right font-semibold text-[#001d6e]">
                              ₹{new Intl.NumberFormat("en-IN").format((product.stock || 0) * (product.price || 0))}
                            </TableCell>
                          </TableRow>
                        ))}
                      </TableBody>
                    </Table>
                  </ScrollArea>
                )}
              </CardContent>
            </Card>
          </TabsContent>
        </Tabs>
      </div>

      {/* Delete confirmation dialog */}
      <Dialog open={deleteId !== null} onOpenChange={(open) => { if (!open) setDeleteId(null); }}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Delete Scan Record</DialogTitle>
            <DialogDescription>
              This will permanently remove the scan record and reverse the inventory change. This cannot be undone.
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button variant="outline" onClick={() => setDeleteId(null)}>Cancel</Button>
            <Button
              variant="destructive"
              disabled={deleteMutation.isPending}
              onClick={() => deleteId !== null && deleteMutation.mutate(deleteId)}
            >
              {deleteMutation.isPending ? "Deleting…" : "Delete"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
};

export default Reports;
