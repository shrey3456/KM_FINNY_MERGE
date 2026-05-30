import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { ArrowLeft, Search, Package, Layers, Tag, RefreshCw, CalendarDays, X } from "lucide-react";
import { Link } from "wouter";
import { apiRequest } from "@/lib/queryClient";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";

// ─── Types ───────────────────────────────────────────────────────────────────

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

// ─── Component ───────────────────────────────────────────────────────────────

export default function StockReport() {
  const [search, setSearch] = useState("");
  const [selectedDate, setSelectedDate] = useState("");

  const apiUrl = selectedDate
    ? `/api/scan-sessions/reports/completed-stock?date=${selectedDate}`
    : "/api/scan-sessions/reports/completed-stock";

  const { data: rawItems = [], isLoading, isFetching } = useQuery<StockItem[]>({
    queryKey: ["/api/scan-sessions/reports/completed-stock", selectedDate],
    queryFn: async () => {
      const r = await apiRequest("GET", apiUrl, undefined, false, true);
      return Array.isArray(r) ? r : [];
    },
    refetchInterval: 5000,
  });

  const items = search
    ? rawItems.filter((i) => {
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
    : rawItems;

  const totalScanned  = items.reduce((s, i) => s + i.totalScanned, 0);
  const totalItems    = items.length;
  const categories    = new Set(items.map((i) => i.category).filter(Boolean)).size;

  return (
    <div className="flex-1 overflow-y-auto bg-gray-50 p-4 lg:p-6">
      <div className="mx-auto max-w-7xl space-y-5">

        {/* Header */}
        <div>
          <Link href="/scan">
            <Button variant="ghost" className="mb-2 px-0 text-sm text-gray-500">
              <ArrowLeft className="mr-1 h-4 w-4" />Scan Order
            </Button>
          </Link>
          <div className="flex items-center gap-2">
            <h1 className="text-2xl font-semibold text-gray-950">Stock Sheet</h1>
            {isFetching && (
              <span className="flex items-center gap-1 text-xs text-emerald-600">
                <RefreshCw className="h-3 w-3 animate-spin" />
                Updating…
              </span>
            )}
          </div>
          <p className="text-sm text-gray-500">
            Available stock — updates live as boxes are scanned.
          </p>
        </div>

        {/* Summary cards */}
        <div className="grid gap-3 sm:grid-cols-3">
          <Card className="rounded-md">
            <CardContent className="flex items-center gap-3 p-5">
              <Package className="h-9 w-9 text-[#001d6e] shrink-0" />
              <div>
                <p className="text-xs text-gray-500">Unique Items</p>
                <p className="text-2xl font-semibold">{totalItems}</p>
              </div>
            </CardContent>
          </Card>
          <Card className="rounded-md">
            <CardContent className="flex items-center gap-3 p-5">
              <Layers className="h-9 w-9 text-emerald-600 shrink-0" />
              <div>
                <p className="text-xs text-gray-500">Total Stock Qty</p>
                <p className="text-2xl font-semibold text-emerald-700">
                  {totalScanned.toLocaleString()}
                </p>
              </div>
            </CardContent>
          </Card>
          <Card className="rounded-md">
            <CardContent className="flex items-center gap-3 p-5">
              <Tag className="h-9 w-9 text-indigo-500 shrink-0" />
              <div>
                <p className="text-xs text-gray-500">Categories</p>
                <p className="text-2xl font-semibold text-indigo-700">{categories}</p>
              </div>
            </CardContent>
          </Card>
        </div>

        {/* Filters row */}
        <div className="flex flex-wrap gap-3 items-center">
          {/* Search */}
          <div className="relative flex-1 min-w-[200px] max-w-sm">
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
                className="pl-9 w-[175px]"
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
          <Table>
            <TableHeader>
              <TableRow className="bg-[#001d6e] hover:bg-[#001d6e]">
                <TableHead className="text-white font-semibold">SR. NO.</TableHead>
                <TableHead className="text-white font-semibold">BARCODE / SKU</TableHead>
                <TableHead className="text-white font-semibold">ITEM NAME</TableHead>
                <TableHead className="text-white font-semibold">CATEGORY</TableHead>
                <TableHead className="text-white font-semibold">SAP CODE</TableHead>
                <TableHead className="text-white font-semibold">HSN CODE</TableHead>
                <TableHead className="text-white font-semibold">VOLUME (FT³)</TableHead>
                <TableHead className="text-white font-semibold text-right">PALLETS</TableHead>
                <TableHead className="text-white font-semibold text-right">STOCK QTY</TableHead>
                <TableHead className="text-white font-semibold">ORDER(S)</TableHead>
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
                items.map((item, idx) => (
                  <TableRow
                    key={item.sku + idx}
                    className={idx % 2 === 0 ? "bg-white" : "bg-gray-50"}
                  >
                    <TableCell className="text-gray-500 text-sm">{item.srNo}</TableCell>

                    <TableCell className="font-mono text-sm font-medium text-gray-800">
                      {item.barcode || item.sku}
                    </TableCell>

                    <TableCell className="font-medium text-gray-900 max-w-[200px]">
                      {item.itemName}
                    </TableCell>

                    <TableCell>
                      {item.category ? (
                        <Badge variant="outline" className="text-xs">{item.category}</Badge>
                      ) : (
                        <span className="text-gray-300 text-xs">—</span>
                      )}
                    </TableCell>

                    <TableCell className="font-mono text-xs text-gray-600">
                      {item.sapCode ?? <span className="text-gray-300">—</span>}
                    </TableCell>

                    <TableCell className="font-mono text-xs text-gray-600">
                      {item.hsnCode ?? <span className="text-gray-300">—</span>}
                    </TableCell>

                    <TableCell className="text-sm text-gray-600 text-center">
                      {item.volumeInCuFt ?? <span className="text-gray-300">—</span>}
                    </TableCell>

                    <TableCell className="text-right text-sm font-semibold text-[#001d6e]">
                      {/* Use stored numPallets from DB; fall back to live calculation */}
                      {item.totalPallets != null
                        ? item.totalPallets
                        : item.itemsPerPallet && item.itemsPerPallet > 0
                          ? parseFloat((item.totalScanned / item.itemsPerPallet).toFixed(2))
                          : <span className="text-gray-300 font-normal">—</span>}
                    </TableCell>

                    <TableCell className="text-right">
                      <span className="text-lg font-bold text-[#001d6e]">
                        {item.totalScanned.toLocaleString()}
                      </span>
                    </TableCell>

                    <TableCell className="max-w-[180px]">
                      {item.orders.length === 0 ? (
                        <span className="text-gray-300 text-xs">—</span>
                      ) : (
                        <div className="flex flex-wrap gap-1">
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
                ))
              )}
            </TableBody>
          </Table>
        </div>

      </div>
    </div>
  );
}
