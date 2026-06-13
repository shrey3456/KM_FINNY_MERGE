import { useEffect, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { AlertTriangle, ArrowLeft, Download, Search, RefreshCw, CalendarDays, X, UserCircle, FileDown } from "lucide-react";
import { Link } from "wouter";
import { apiRequest } from "@/lib/queryClient";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
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

type ExtraItem = {
  id: number;
  sessionId: number;
  orderName: string;
  csvName: string;
  code: string;
  itemName: string;
  sku: string | null;
  quantity: number;
  pallets: number | null;
  reason: "not_in_order" | "unknown_product";
  scannedByName: string | null;
  scannedAt: string | null;
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
  totalPallets: number | null; // stored in DB from scan confirmation
  orders: Array<{ name: string; status: string }>;
};

type PaginatedResponse<T> = {
  items: T[];
  total: number;
  totalQuantity?: number;
  limit?: number;
  offset?: number;
};

const PAGE_SIZE = 10;

function buildQueryUrl(base: string, params: Record<string, string | number | undefined>) {
  const searchParams = new URLSearchParams();
  Object.entries(params).forEach(([key, value]) => {
    if (value !== undefined && value !== "") {
      searchParams.set(key, String(value));
    }
  });

  const query = searchParams.toString();
  return query ? `${base}?${query}` : base;
}

function withCacheBuster(url: string) {
  return buildQueryUrl(url, { _t: Date.now() });
}

function downloadCsv(filename: string, rows: Array<Array<string | number>>) {
  const csv = rows.map((row) => row.map((cell) => `"${String(cell).replace(/"/g, '""')}"`).join(",")).join("\n");
  const a = document.createElement("a");
  a.href = URL.createObjectURL(new Blob([csv], { type: "text/csv" }));
  a.download = filename;
  a.click();
}

function downloadExcel(filename: string, rows: Array<Array<string | number>>) {
  const sheet = XLSX.utils.aoa_to_sheet(rows);
  const book = XLSX.utils.book_new();
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

export default function StockReport() {
  const [search, setSearch] = useState("");
  const [selectedDate, setSelectedDate] = useState("");
  const [stockPage, setStockPage] = useState(1);
  const [extrasPage, setExtrasPage] = useState(1);

  useEffect(() => {
    setStockPage(1);
    setExtrasPage(1);
  }, [selectedDate]);

  useEffect(() => {
    setStockPage(1);
  }, [search]);

  const stockOffset = (stockPage - 1) * PAGE_SIZE;
  const extrasOffset = (extrasPage - 1) * PAGE_SIZE;

  const stockUrl = buildQueryUrl("/api/scan-sessions/reports/completed-stock", {
    date: selectedDate || undefined,
    limit: PAGE_SIZE,
    offset: stockOffset,
  });

  const extrasUrl = buildQueryUrl("/api/scan-sessions/reports/extras", {
    date: selectedDate || undefined,
    limit: PAGE_SIZE,
    offset: extrasOffset,
  });

  const { data: extrasData } = useQuery<PaginatedResponse<ExtraItem>>({
    queryKey: ["/api/scan-sessions/reports/extras", selectedDate, extrasPage],
    queryFn: async () => {
      const r = await apiRequest("GET", withCacheBuster(extrasUrl), undefined, false, true);
      if (r && Array.isArray(r.items)) return r;
      if (Array.isArray(r)) {
        const totalQuantity = r.reduce((sum, item) => sum + (item?.quantity ?? 0), 0);
        return { items: r, total: r.length, totalQuantity };
      }
      return { items: [], total: 0, totalQuantity: 0 };
    },
    refetchInterval: 5000,
  });

  const extras = extrasData?.items ?? [];
  const extrasTotal = extrasData?.total ?? 0;
  const totalExtraQty = extrasData?.totalQuantity ?? extras.reduce((s, e) => s + (e.quantity ?? 0), 0);
  const extrasHasMore = extrasOffset + extras.length < extrasTotal;
  const extrasPageCount = Math.max(1, Math.ceil(extrasTotal / PAGE_SIZE));

  const { data: stockData, isLoading, isFetching } = useQuery<PaginatedResponse<StockItem>>({
    queryKey: ["/api/scan-sessions/reports/completed-stock", selectedDate, stockPage],
    queryFn: async () => {
      const r = await apiRequest("GET", withCacheBuster(stockUrl), undefined, false, true);
      if (r && Array.isArray(r.items)) return r;
      if (Array.isArray(r)) {
        return { items: r, total: r.length };
      }
      return { items: [], total: 0 };
    },
    refetchInterval: 5000,
  });

  const stockItems = stockData?.items ?? [];
  const stockTotal = stockData?.total ?? 0;
  const stockHasMore = stockOffset + stockItems.length < stockTotal;
  const stockPageCount = Math.max(1, Math.ceil(stockTotal / PAGE_SIZE));

  const items = search
    ? stockItems.filter((i) => {
        const q = search.toLowerCase();
        return (
          i.itemName.toLowerCase().includes(q) ||
          (i.barcode ?? "").toLowerCase().includes(q) ||
          (i.sku ?? "").toLowerCase().includes(q) ||
          (i.sapCode ?? "").toLowerCase().includes(q) ||
          (i.hsnCode ?? "").toLowerCase().includes(q) ||
          (i.category ?? "").toLowerCase().includes(q)
        );
      })
    : stockItems;

  return (
    <div className="flex-1 overflow-y-auto bg-gray-50 p-3 sm:p-4 lg:p-6">
      <div className="mx-auto max-w-7xl space-y-4 sm:space-y-5">

        {/* Header */}
        <div>
          <div className="flex flex-wrap items-center gap-2 sm:gap-3">
            <Link href="/scan">
              <Button
                variant="outline"
                size="sm"
                className="h-8 px-2.5 text-xs sm:text-sm gap-1.5 border-gray-200 bg-white hover:bg-gray-50"
              >
                <ArrowLeft className="h-3.5 w-3.5" />
                <span>Back</span>
              </Button>
            </Link>
            <div className="flex items-center gap-2">
              <h1 className="text-xl sm:text-2xl font-semibold text-gray-950">Stock Sheet</h1>
              {isFetching && (
                <span className="flex items-center gap-1 text-xs text-emerald-600">
                  <RefreshCw className="h-3 w-3 animate-spin" />
                  Updating…
                </span>
              )}
            </div>
          </div>
          <p className="text-xs sm:text-sm text-gray-500">
            Available stock — updates live as boxes are scanned.
          </p>
        </div>

        {/* Filters row */}
        <div className="flex flex-wrap gap-3 items-center">
          {/* Search */}
          <div className="relative flex-1 min-w-[180px] max-w-sm">
            <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-gray-400" />
            <Input
              className="pl-9"
              placeholder="Search item, barcode, SAP, HSN…"
              value={search}
              onChange={(e) => setSearch(e.target.value)}
            />
          </div>

          {/* Date filter */}
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
                variant="ghost"
                size="sm"
                className="h-9 px-2 text-gray-400 hover:text-gray-700"
                onClick={() => setSelectedDate("")}
              >
                <X className="h-4 w-4" />
              </Button>
            )}
          </div>
        </div>

        {/* Date badge */}
        {selectedDate && (
          <p className="text-sm text-[#001d6e] font-medium">
            Showing arrivals for <span className="underline">{new Date(selectedDate + "T00:00:00").toLocaleDateString(undefined, { day: "2-digit", month: "long", year: "numeric" })}</span>
          </p>
        )}

        {/* Stock table */}
        <div className="rounded-md border bg-white overflow-x-auto">
          <div className="flex flex-wrap items-center justify-between gap-2 border-b px-3 py-2">
            <span className="text-xs sm:text-sm font-medium text-gray-700">Stock Report</span>
            <div className="flex flex-wrap gap-2">
              <Button
                variant="outline"
                size="sm"
                className="h-8 text-xs"
                onClick={() => {
                  const rows = [
                    ["SR", "Item Name", "Barcode/SKU", "Category", "SAP", "HSN", "Volume", "Pallets", "Stock Qty", "Orders"],
                    ...items.map((item) => [
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
                  downloadCsv(
                    `stock-report${selectedDate ? "-" + selectedDate : ""}-${format(new Date(), "yyyy-MM-dd")}.csv`,
                    rows,
                  );
                }}
              >
                <FileDown className="h-3.5 w-3.5 mr-1" />CSV
              </Button>
              <Button
                variant="outline"
                size="sm"
                className="h-8 text-xs"
                onClick={() => {
                  const rows = [
                    ["SR", "Item Name", "Barcode/SKU", "Category", "SAP", "HSN", "Volume", "Pallets", "Stock Qty", "Orders"],
                    ...items.map((item) => [
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
                  downloadExcel(
                    `stock-report${selectedDate ? "-" + selectedDate : ""}-${format(new Date(), "yyyy-MM-dd")}.xlsx`,
                    rows,
                  );
                }}
              >
                <FileDown className="h-3.5 w-3.5 mr-1" />Excel
              </Button>
              <Button
                variant="outline"
                size="sm"
                className="h-8 text-xs"
                onClick={() => {
                  const rows = [
                    ["SR", "Item Name", "Barcode/SKU", "Category", "SAP", "HSN", "Volume", "Pallets", "Stock Qty", "Orders"],
                    ...items.map((item) => [
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
                  downloadPdf(
                    `stock-report${selectedDate ? "-" + selectedDate : ""}-${format(new Date(), "yyyy-MM-dd")}.pdf`,
                    "Stock Report",
                    rows,
                  );
                }}
              >
                <FileDown className="h-3.5 w-3.5 mr-1" />PDF
              </Button>
            </div>
          </div>
          <Table className="min-w-[980px] text-xs sm:text-sm">
            <TableHeader>
              <TableRow className="bg-[#001d6e] hover:bg-[#001d6e]">
                <TableHead className="text-white font-semibold uppercase tracking-wide sticky left-0 z-20 bg-[#001d6e] w-[52px] text-[11px] sm:text-xs">SR</TableHead>
                <TableHead className="text-white font-semibold uppercase tracking-wide sticky left-0 sm:left-[52px] z-30 bg-[#001d6e] min-w-[180px] text-[11px] sm:text-xs shadow-[2px_0_6px_rgba(0,0,0,0.06)]">Item</TableHead>
                <TableHead className="text-white font-semibold uppercase tracking-wide">Barcode / SKU</TableHead>
                <TableHead className="text-white font-semibold uppercase tracking-wide">Category</TableHead>
                <TableHead className="text-white font-semibold uppercase tracking-wide">SAP Code</TableHead>
                <TableHead className="text-white font-semibold uppercase tracking-wide">HSN Code</TableHead>
                <TableHead className="text-white font-semibold uppercase tracking-wide">Volume (FT³)</TableHead>
                <TableHead className="text-white font-semibold uppercase tracking-wide text-right">Pallets</TableHead>
                <TableHead className="text-white font-semibold uppercase tracking-wide text-right">Stock Qty</TableHead>
                <TableHead className="text-white font-semibold uppercase tracking-wide min-w-[220px]">Order(s)</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {isLoading ? (
                <TableRow>
                  <TableCell colSpan={10} className="py-16 text-center text-sm text-gray-400">
                    Loading stock sheet…
                  </TableCell>
                </TableRow>
              ) : items.length === 0 ? (
                <TableRow>
                  <TableCell colSpan={10} className="py-16 text-center text-sm text-gray-400">
                    No completed scan orders yet.
                  </TableCell>
                </TableRow>
              ) : (
                items.map((item, idx) => {
                  const rowBg = idx % 2 === 0 ? "bg-white" : "bg-slate-50";
                  return (
                    <TableRow
                      key={item.sku + idx}
                      className={`${rowBg} transition-colors hover:bg-slate-100/70`}
                    >
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
                        {item.category ? (
                          <Badge variant="outline" className="text-xs">{item.category}</Badge>
                        ) : (
                          <span className="text-gray-300 text-xs">—</span>
                        )}
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
                        {/* Use stored numPallets from DB; fall back to live calculation */}
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

                      <TableCell className="min-w-[220px] max-w-[320px] py-2">
                        {item.orders.length === 0 ? (
                          <span className="text-gray-300 text-xs">—</span>
                        ) : (
                          <div className="flex flex-wrap gap-1.5">
                            {item.orders.map((o) => (
                              <Badge
                                key={o.name}
                                variant="outline"
                                className={`text-xs ${
                                  o.status === "scanning"
                                    ? "border-blue-300 bg-blue-50 text-blue-700"
                                    : "border-emerald-300 bg-emerald-50 text-emerald-700"
                                }`}
                              >
                                {o.name}
                              </Badge>
                            ))}
                          </div>
                        )}
                      </TableCell>
                    </TableRow>
                  );
                })
              )}
            </TableBody>
          </Table>
          <div className="flex items-center justify-between border-t px-3 py-2 text-xs text-gray-500">
            <span>Page {stockPage} of {stockPageCount}</span>
            <div className="flex gap-2">
              <Button
                variant="outline"
                size="sm"
                disabled={stockPage <= 1}
                onClick={() => setStockPage((p) => Math.max(1, p - 1))}
              >
                Prev
              </Button>
              <Button
                variant="outline"
                size="sm"
                disabled={!stockHasMore}
                onClick={() => setStockPage((p) => p + 1)}
              >
                Next
              </Button>
            </div>
          </div>
        </div>

        {/* Extra Items Report */}
          <div className="space-y-3">
          <div className="flex items-center justify-between">
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
                size="sm"
                variant="outline"
                disabled={extras.length === 0}
                className="h-8 text-xs"
                onClick={() => {
                  const csv = [
                    ["#", "Order", "CSV", "Item Name", "Barcode/SKU", "Qty", "Pallets", "Reason", "Scanned By", "Time"].join(","),
                    ...extras.map((e, idx) => [
                      idx + 1,
                      `"${e.orderName}"`,
                      `"${e.csvName}"`,
                      `"${e.itemName}"`,
                      e.code || e.sku || "",
                      e.quantity ?? 0,
                      e.pallets != null && Number(e.pallets) > 0 ? parseFloat(String(e.pallets)).toFixed(2) : "",
                      e.reason === "not_in_order" ? "Not in order" : "Unknown product",
                      `"${e.scannedByName || ""}"`,
                      e.scannedAt ? format(new Date(e.scannedAt.replace(/Z$/, "")), "yyyy-MM-dd h:mm a") : "",
                    ].join(",")),
                  ].join("\n");
                  const a = document.createElement("a");
                  a.href = URL.createObjectURL(new Blob([csv], { type: "text/csv" }));
                  a.download = `extra-items${selectedDate ? "-" + selectedDate : ""}-${format(new Date(), "yyyy-MM-dd")}.csv`;
                  a.click();
                }}
              >
                <Download className="h-4 w-4 mr-1.5" />Get Sheet
              </Button>
              <Button
                size="sm"
                variant="outline"
                className="h-8 text-xs"
                disabled={extras.length === 0}
                onClick={() => {
                  const rows = [
                    ["#", "Order", "CSV", "Item Name", "Barcode/SKU", "Qty", "Pallets", "Reason", "Scanned By", "Time"],
                    ...extras.map((e, idx) => [
                      idx + 1,
                      e.orderName,
                      e.csvName,
                      e.itemName,
                      e.code || e.sku || "",
                      e.quantity ?? 0,
                      e.pallets != null && Number(e.pallets) > 0 ? parseFloat(String(e.pallets)).toFixed(2) : "",
                      e.reason === "not_in_order" ? "Not in order" : "Unknown product",
                      e.scannedByName || "",
                      e.scannedAt ? format(new Date(e.scannedAt.replace(/Z$/, "")), "yyyy-MM-dd h:mm a") : "",
                    ]),
                  ];
                  downloadExcel(
                    `extra-items${selectedDate ? "-" + selectedDate : ""}-${format(new Date(), "yyyy-MM-dd")}.xlsx`,
                    rows,
                  );
                }}
              >
                <FileDown className="h-3.5 w-3.5 mr-1" />Excel
              </Button>
              <Button
                size="sm"
                variant="outline"
                className="h-8 text-xs"
                disabled={extras.length === 0}
                onClick={() => {
                  const rows = [
                    ["#", "Order", "CSV", "Item Name", "Barcode/SKU", "Qty", "Pallets", "Reason", "Scanned By", "Time"],
                    ...extras.map((e, idx) => [
                      idx + 1,
                      e.orderName,
                      e.csvName,
                      e.itemName,
                      e.code || e.sku || "",
                      e.quantity ?? 0,
                      e.pallets != null && Number(e.pallets) > 0 ? parseFloat(String(e.pallets)).toFixed(2) : "",
                      e.reason === "not_in_order" ? "Not in order" : "Unknown product",
                      e.scannedByName || "",
                      e.scannedAt ? format(new Date(e.scannedAt.replace(/Z$/, "")), "yyyy-MM-dd h:mm a") : "",
                    ]),
                  ];
                  downloadPdf(
                    `extra-items${selectedDate ? "-" + selectedDate : ""}-${format(new Date(), "yyyy-MM-dd")}.pdf`,
                    "Extra Items Report",
                    rows,
                  );
                }}
              >
                <FileDown className="h-3.5 w-3.5 mr-1" />PDF
              </Button>
            </div>
          </div>

          <div className="rounded-md border bg-white overflow-x-auto">
            <Table className="min-w-[960px] text-xs sm:text-sm">
              <TableHeader>
                <TableRow className="bg-amber-600 hover:bg-amber-600">
                    <TableHead className="text-white font-semibold uppercase tracking-wide sticky left-0 z-20 bg-amber-600 w-[52px] text-[11px] sm:text-xs">#</TableHead>
                    <TableHead className="text-white font-semibold uppercase tracking-wide sticky left-0 sm:left-[52px] z-30 bg-amber-600 min-w-[180px] text-[11px] sm:text-xs shadow-[2px_0_6px_rgba(0,0,0,0.08)]">Item</TableHead>
                    <TableHead className="text-white font-semibold uppercase tracking-wide">Order</TableHead>
                    <TableHead className="text-white font-semibold uppercase tracking-wide">Barcode / SKU</TableHead>
                    <TableHead className="text-white font-semibold uppercase tracking-wide text-right">Qty</TableHead>
                    <TableHead className="text-white font-semibold uppercase tracking-wide text-right">Pallets</TableHead>
                    <TableHead className="text-white font-semibold uppercase tracking-wide">Reason</TableHead>
                    <TableHead className="text-white font-semibold uppercase tracking-wide">
                    <span className="flex items-center gap-1"><UserCircle className="h-3.5 w-3.5" />SCANNED BY</span>
                  </TableHead>
                    <TableHead className="text-white font-semibold uppercase tracking-wide">Time</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {extras.length === 0 ? (
                  <TableRow>
                    <TableCell colSpan={9} className="py-12 text-center text-sm text-gray-400">
                      No extra items recorded{selectedDate ? " for this date" : ""}.
                    </TableCell>
                  </TableRow>
                ) : (
                  extras.map((extra, idx) => {
                    const rowBg = idx % 2 === 0 ? "bg-white" : "bg-amber-50/40";
                    return (
                      <TableRow key={extra.id} className={`${rowBg} transition-colors hover:bg-amber-50`}>
                        <TableCell className={`text-gray-400 text-[11px] sm:text-xs sticky left-0 z-10 ${rowBg} w-[52px] py-2 bg-white`}>
                          {idx + 1}
                        </TableCell>
                        <TableCell className={`font-medium text-gray-900 sticky left-0 sm:left-[52px] z-20 ${rowBg} min-w-[180px] max-w-[220px] whitespace-normal break-words py-2 shadow-[2px_0_6px_rgba(0,0,0,0.06)] bg-white`}>
                          {extra.itemName}
                        </TableCell>
                        <TableCell>
                          <p className="font-medium text-gray-800 text-sm">{extra.orderName}</p>
                          <p className="text-xs text-gray-400">{extra.csvName}</p>
                        </TableCell>
                        <TableCell className="font-mono text-[11px] sm:text-xs text-gray-600 py-2">
                          {extra.code || extra.sku || <span className="text-gray-300">—</span>}
                        </TableCell>
                        <TableCell className="text-right font-bold text-amber-700 py-2">
                          {(extra.quantity ?? 0).toLocaleString()}
                        </TableCell>
                        <TableCell className="text-right font-semibold text-[#001d6e] py-2">
                          {extra.pallets != null && Number(extra.pallets) > 0
                            ? parseFloat(String(extra.pallets)).toFixed(2)
                            : <span className="text-gray-300 font-normal">—</span>}
                        </TableCell>
                        <TableCell>
                          <Badge
                            className={
                              extra.reason === "not_in_order"
                                ? "bg-orange-100 text-orange-800 hover:bg-orange-100 text-xs"
                                : "bg-red-100 text-red-800 hover:bg-red-100 text-xs"
                            }
                          >
                            {extra.reason === "not_in_order" ? "Not in order" : "Unknown product"}
                          </Badge>
                        </TableCell>
                        <TableCell className="text-sm text-gray-700">
                          {extra.scannedByName || <span className="text-gray-300">—</span>}
                        </TableCell>
                        <TableCell className="text-xs text-gray-500 whitespace-nowrap">
                          {extra.scannedAt
                            ? format(new Date(extra.scannedAt.replace(/Z$/, "")), "MMM d, h:mm a")
                            : "—"}
                        </TableCell>
                      </TableRow>
                    );
                  })
                )}
              </TableBody>
            </Table>
            <div className="flex items-center justify-between border-t px-3 py-2 text-xs text-gray-500">
              <span>Page {extrasPage} of {extrasPageCount}</span>
              <div className="flex gap-2">
                <Button
                  variant="outline"
                  size="sm"
                  disabled={extrasPage <= 1}
                  onClick={() => setExtrasPage((p) => Math.max(1, p - 1))}
                >
                  Prev
                </Button>
                <Button
                  variant="outline"
                  size="sm"
                  disabled={!extrasHasMore}
                  onClick={() => setExtrasPage((p) => p + 1)}
                >
                  Next
                </Button>
              </div>
            </div>
          </div>
        </div>

      </div>
    </div>
  );
}
