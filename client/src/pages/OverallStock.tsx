import { useMemo, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { format } from "date-fns";
import * as XLSX from "xlsx";
import jsPDF from "jspdf";
import autoTable from "jspdf-autotable";
import { Filter, X, Download, FileDown, LayoutList } from "lucide-react";
import {
  Table, TableBody, TableCell, TableHead, TableHeader, TableRow,
} from "@/components/ui/table";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Badge } from "@/components/ui/badge";
import {
  Select, SelectContent, SelectItem, SelectTrigger, SelectValue,
} from "@/components/ui/select";
import PageHeader from "@/components/PageHeader";
import { apiRequest } from "@/lib/queryClient";

// ─── Types ───────────────────────────────────────────────────────────────────

type StockItem = {
  srNo: number; sku: string; barcode: string | null; itemName: string;
  sapCode: string | null; hsnCode: string | null; category: string | null;
  itemsPerPallet: number | null; totalScanned: number; totalPallets: number | null;
  lastArrived: string | null;
};

type ExtraItem = {
  barcode: string | null; itemName: string | null;
  totalQuantity: number; totalPallets: number | null;
  itemsPerPallet: number | null; lastArrived: string | null;
};

type CombinedRow = {
  key: string;
  itemName: string;
  barcode: string | null;
  sapCode: string | null;
  hsnCode: string | null;
  category: string | null;
  qty: number;
  pallets: number | null;
  itemsPerPallet: number | null;
  type: "regular" | "extra";
  lastArrived: string | null;
};

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

function downloadPdf(filename: string, rows: Array<Array<string | number>>) {
  const doc = new jsPDF({ orientation: "landscape" });
  doc.setFontSize(12);
  doc.text("Overall Stock Report", 14, 12);
  const [header, ...body] = rows;
  autoTable(doc, {
    head: [header as string[]],
    body: body as string[][],
    startY: 18,
    styles: { fontSize: 7 },
    headStyles: { fillColor: [0, 29, 110] },
  });
  doc.save(filename);
}

const PAGE_SIZE = 20;

// ─── Component ───────────────────────────────────────────────────────────────

export default function OverallStock() {
  const [selectedDate, setSelectedDate] = useState("");
  const [search,       setSearch]       = useState("");
  const [typeFilter,   setTypeFilter]   = useState<"all" | "regular" | "extra">("all");
  const [page,         setPage]         = useState(1);

  // Fetch all stock items (regular — from CSV orders)
  const stockUrl = buildUrl("/api/scan-sessions/reports/completed-stock", {
    date: selectedDate || undefined,
    limit: 200,
    offset: 0,
  });
  const { data: stockData } = useQuery<{ items: StockItem[]; total: number }>({
    queryKey: ["/api/scan-sessions/reports/completed-stock", selectedDate],
    queryFn: () => apiRequest("GET", stockUrl, undefined, false, true),
    refetchInterval: 30000,
  });

  // Fetch all extra items
  const extrasUrl = buildUrl("/api/scan-sessions/reports/extras", {
    date: selectedDate || undefined,
    grouped: "true",
    limit: 200,
    offset: 0,
  });
  const { data: extrasData } = useQuery<{ items: ExtraItem[]; total: number; totalQuantity: number }>({
    queryKey: ["/api/scan-sessions/reports/extras", selectedDate],
    queryFn: () => apiRequest("GET", extrasUrl, undefined, false, true),
    refetchInterval: 30000,
  });

  // Merge into a unified list
  const combined = useMemo<CombinedRow[]>(() => {
    const regularRows: CombinedRow[] = (stockData?.items ?? []).map((s, i) => ({
      key:           `reg-${s.sku}-${i}`,
      itemName:      s.itemName,
      barcode:       s.barcode,
      sapCode:       s.sapCode,
      hsnCode:       s.hsnCode,
      category:      s.category,
      qty:           s.totalScanned,
      pallets:       s.totalPallets,
      itemsPerPallet: s.itemsPerPallet,
      type:          "regular",
      lastArrived:   s.lastArrived,
    }));

    const extraRows: CombinedRow[] = (extrasData?.items ?? []).map((e, i) => ({
      key:           `ext-${e.barcode ?? i}-${i}`,
      itemName:      e.itemName ?? e.barcode ?? "Unknown",
      barcode:       e.barcode,
      sapCode:       null,
      hsnCode:       null,
      category:      null,
      qty:           e.totalQuantity,
      pallets:       e.totalPallets,
      itemsPerPallet: e.itemsPerPallet,
      type:          "extra",
      lastArrived:   e.lastArrived,
    }));

    return [...regularRows, ...extraRows].sort((a, b) => {
      if (!a.lastArrived && !b.lastArrived) return 0;
      if (!a.lastArrived) return 1;
      if (!b.lastArrived) return -1;
      return new Date(b.lastArrived).getTime() - new Date(a.lastArrived).getTime();
    });
  }, [stockData, extrasData]);

  // Filter
  const filtered = useMemo(() => {
    let rows = combined;
    if (typeFilter !== "all") rows = rows.filter((r) => r.type === typeFilter);
    if (search) {
      const q = search.toLowerCase();
      rows = rows.filter((r) =>
        r.itemName.toLowerCase().includes(q) ||
        (r.barcode ?? "").toLowerCase().includes(q) ||
        (r.sapCode ?? "").toLowerCase().includes(q) ||
        (r.category ?? "").toLowerCase().includes(q),
      );
    }
    return rows;
  }, [combined, typeFilter, search]);

  // Pagination
  const totalPages = Math.max(1, Math.ceil(filtered.length / PAGE_SIZE));
  const safePage   = Math.min(page, totalPages);
  const pageRows   = filtered.slice((safePage - 1) * PAGE_SIZE, safePage * PAGE_SIZE);

  // Summary
  const totalRegularQty = combined.filter((r) => r.type === "regular").reduce((s, r) => s + r.qty, 0);
  const totalExtraQty   = combined.filter((r) => r.type === "extra").reduce((s, r) => s + r.qty, 0);
  const totalRegularCount = combined.filter((r) => r.type === "regular").length;
  const totalExtraCount   = combined.filter((r) => r.type === "extra").length;

  // Export rows
  const exportRows = (src: CombinedRow[]) => [
    ["#", "Item", "Barcode", "SAP Code", "HSN Code", "Category", "Type", "Qty", "Pallets", "Last Scanned"],
    ...src.map((r, i) => [
      i + 1, r.itemName, r.barcode ?? "", r.sapCode ?? "", r.hsnCode ?? "",
      r.category ?? "", r.type === "regular" ? "Regular" : "Extra",
      r.qty,
      r.pallets != null ? parseFloat(String(r.pallets)).toFixed(2) : "",
      r.lastArrived ? format(new Date(r.lastArrived), "yyyy-MM-dd") : "",
    ]),
  ];

  return (
    <div className="flex-1 overflow-y-auto p-4 lg:p-6">
      <div className="max-w-7xl mx-auto space-y-4">
        <PageHeader
          icon={LayoutList}
          title="Overall Stock"
          description="Combined view of all scanned order items and extra items."
        />

        {/* Filters & actions */}
        <div className="flex flex-wrap gap-2 items-center">
          {/* Date */}
          <div className="flex items-center gap-1.5 rounded-md border bg-white px-2.5 h-9">
            <span className="text-xs text-gray-400 whitespace-nowrap">Date</span>
            <input
              type="date"
              className="text-xs bg-transparent outline-none text-gray-700 w-[130px]"
              value={selectedDate}
              onChange={(e) => { setSelectedDate(e.target.value); setPage(1); }}
            />
            {selectedDate && (
              <button onClick={() => { setSelectedDate(""); setPage(1); }}>
                <X className="h-3.5 w-3.5 text-gray-400" />
              </button>
            )}
          </div>

          {/* Search */}
          <div className="relative min-w-[180px] flex-1 max-w-xs">
            <Filter className="absolute left-3 top-1/2 -translate-y-1/2 h-3.5 w-3.5 text-gray-400" />
            <Input
              className="pl-8 h-9 text-sm"
              placeholder="Item, barcode, SAP, category…"
              value={search}
              onChange={(e) => { setSearch(e.target.value); setPage(1); }}
            />
            {search && (
              <button className="absolute right-2 top-1/2 -translate-y-1/2" onClick={() => { setSearch(""); setPage(1); }}>
                <X className="h-4 w-4 text-gray-400" />
              </button>
            )}
          </div>

          {/* Type filter */}
          <Select value={typeFilter} onValueChange={(v) => { setTypeFilter(v as typeof typeFilter); setPage(1); }}>
            <SelectTrigger className="h-9 w-[150px] text-sm">
              <SelectValue placeholder="All types" />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="all">All types</SelectItem>
              <SelectItem value="regular">Regular only</SelectItem>
              <SelectItem value="extra">Extra only</SelectItem>
            </SelectContent>
          </Select>

          {/* Export */}
          <div className="flex gap-2 ml-auto">
            {(["CSV", "Excel", "PDF"] as const).map((fmt) => (
              <Button key={fmt} variant="outline" size="sm" className="h-9 text-xs"
                disabled={filtered.length === 0}
                onClick={() => {
                  const rows = exportRows(filtered);
                  const suffix = `${selectedDate ? "-" + selectedDate : ""}-${format(new Date(), "yyyy-MM-dd")}`;
                  if (fmt === "CSV")   downloadCsv(`overall-stock${suffix}.csv`, rows);
                  if (fmt === "Excel") downloadExcel(`overall-stock${suffix}.xlsx`, rows);
                  if (fmt === "PDF")   downloadPdf(`overall-stock${suffix}.pdf`, rows);
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
            <span className="text-gray-500">Total Items</span>
            <span className="font-bold text-gray-900">{combined.length}</span>
          </div>
          <div className="flex items-center gap-1.5 rounded-md border border-blue-200 bg-blue-50 px-3 py-1.5 text-xs">
            <span className="text-blue-600">Regular ({totalRegularCount})</span>
            <span className="font-bold text-[#001d6e]">{totalRegularQty.toLocaleString()} boxes</span>
          </div>
          <div className="flex items-center gap-1.5 rounded-md border border-amber-200 bg-amber-50 px-3 py-1.5 text-xs">
            <span className="text-amber-600">Extra ({totalExtraCount})</span>
            <span className="font-bold text-amber-700">{totalExtraQty.toLocaleString()} boxes</span>
          </div>
          <div className="flex items-center gap-1.5 rounded-md border bg-white px-3 py-1.5 text-xs">
            <span className="text-gray-500">Total Boxes</span>
            <span className="font-bold text-gray-900">{(totalRegularQty + totalExtraQty).toLocaleString()}</span>
          </div>
        </div>

        {/* Table */}
        <div className="rounded-xl border bg-white overflow-x-auto shadow-sm">
          <Table className="min-w-[900px] text-xs sm:text-sm">
            <TableHeader>
              <TableRow className="bg-[#001d6e] hover:bg-[#001d6e]">
                <TableHead className="text-white font-semibold uppercase tracking-wide w-[44px] text-[11px]">#</TableHead>
                <TableHead className="text-white font-semibold uppercase tracking-wide min-w-[200px] text-[11px]">Item</TableHead>
                <TableHead className="text-white font-semibold uppercase tracking-wide text-[11px]">Barcode / SKU</TableHead>
                <TableHead className="text-white font-semibold uppercase tracking-wide text-[11px]">SAP Code</TableHead>
                <TableHead className="text-white font-semibold uppercase tracking-wide text-[11px]">Category</TableHead>
                <TableHead className="text-white font-semibold uppercase tracking-wide text-[11px]">Type</TableHead>
                <TableHead className="text-white font-semibold uppercase tracking-wide text-right text-[11px]">Qty (boxes)</TableHead>
                <TableHead className="text-white font-semibold uppercase tracking-wide text-right text-[11px]">Pallets</TableHead>
                <TableHead className="text-white font-semibold uppercase tracking-wide text-[11px]">Last Scanned</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {filtered.length === 0 ? (
                <TableRow>
                  <TableCell colSpan={9} className="py-16 text-center text-sm text-gray-400">
                    No stock data found{selectedDate ? " for this date" : ""}.
                  </TableCell>
                </TableRow>
              ) : (
                pageRows.map((row, idx) => {
                  const rowBg = row.type === "extra"
                    ? (idx % 2 === 0 ? "bg-amber-50/40" : "bg-amber-50/70")
                    : (idx % 2 === 0 ? "bg-white" : "bg-slate-50");
                  return (
                    <TableRow key={row.key} className={`${rowBg} transition-colors hover:bg-slate-100/70`}>
                      <TableCell className="text-gray-400 text-[11px] py-2.5">
                        {(safePage - 1) * PAGE_SIZE + idx + 1}
                      </TableCell>
                      <TableCell className="font-medium text-gray-900 min-w-[200px] max-w-[260px] whitespace-normal break-words py-2.5">
                        {row.itemName}
                      </TableCell>
                      <TableCell className="font-mono text-[11px] text-gray-600 py-2.5">
                        {row.barcode ?? <span className="text-gray-300">—</span>}
                      </TableCell>
                      <TableCell className="font-mono text-[11px] text-gray-600 py-2.5">
                        {row.sapCode ?? <span className="text-gray-300">—</span>}
                      </TableCell>
                      <TableCell className="py-2.5">
                        {row.category
                          ? <Badge variant="outline" className="text-xs">{row.category}</Badge>
                          : <span className="text-gray-300 text-xs">—</span>}
                      </TableCell>
                      <TableCell className="py-2.5">
                        {row.type === "regular"
                          ? <Badge className="bg-blue-100 text-blue-800 hover:bg-blue-100 text-[11px] px-1.5 border-0">Regular</Badge>
                          : <Badge className="bg-amber-100 text-amber-800 hover:bg-amber-100 text-[11px] px-1.5 border-0">Extra</Badge>}
                      </TableCell>
                      <TableCell className="text-right font-bold text-[#001d6e] py-2.5">
                        {row.qty.toLocaleString()}
                      </TableCell>
                      <TableCell className="text-right font-semibold text-[#001d6e] py-2.5">
                        {row.pallets != null && Number(row.pallets) > 0
                          ? parseFloat(String(row.pallets)).toFixed(2)
                          : <span className="text-gray-300 font-normal">—</span>}
                      </TableCell>
                      <TableCell className="text-[11px] text-gray-500 whitespace-nowrap py-2.5">
                        {row.lastArrived
                          ? format(new Date(row.lastArrived), "MMM d, yyyy")
                          : <span className="text-gray-300">—</span>}
                      </TableCell>
                    </TableRow>
                  );
                })
              )}
            </TableBody>
          </Table>

          <div className="flex items-center justify-between border-t px-4 py-2.5 text-xs text-gray-500">
            <span>
              {filtered.length > 0
                ? `Showing ${(safePage - 1) * PAGE_SIZE + 1}–${Math.min(safePage * PAGE_SIZE, filtered.length)} of ${filtered.length} items`
                : "No items"}
            </span>
            <div className="flex gap-2">
              <Button variant="outline" size="sm" disabled={safePage <= 1}
                onClick={() => setPage((p) => Math.max(1, p - 1))}>Prev</Button>
              <Button variant="outline" size="sm" disabled={safePage >= totalPages}
                onClick={() => setPage((p) => p + 1)}>Next</Button>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
