import { drawPdfHeader, drawPdfFooter, greenTotalRow, setPdfProperties } from "@/lib/pdfBranding";
import { useEffect, useMemo, useRef, useState } from "react";
import * as XLSX from "xlsx";
import jsPDF from "jspdf";
import autoTable from "jspdf-autotable";
import { useMutation, useQuery } from "@tanstack/react-query";
import { format } from "date-fns";
import { X } from "lucide-react";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { LayoutList, CalendarDays, Boxes, History, ShoppingCart, RotateCw, Loader2, Scale, Plus, Search, ChevronLeft, ChevronDown, FileDown, Trash2, MoreVertical } from "lucide-react";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from "@/components/ui/dropdown-menu";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { scanTypeLabel } from "./Scanning/ScanHistory";
import ExchangeProductDialog from "@/components/modals/ExchangeProductDialog";
import { Input } from "@/components/ui/input";
import PageHeader from "@/components/PageHeader";
import { PlantBadge } from "@/components/PlantBadge";
import { apiRequest, queryClient } from "@/lib/queryClient";
import { useAuth } from "@/hooks/use-auth";
import { useToast } from "@/hooks/use-toast";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle, DialogFooter } from "@/components/ui/dialog";
import { DataTable, DataTableColumnToggle, type DataTableColumn } from "@/components/ui/data-table";
import { StatsBar } from "@/components/ui/stats-bar";
import { TableCard } from "@/components/ui/table-card";
import { CollapsibleSearch } from "@/components/ui/collapsible-search";
import { ColumnFilterPopoverContent, ColumnHeaderFilterButton } from "@/components/filters/ColumnFilterChip";
import { type FilterableColumn, type FilterCondition, isConditionEmpty, matchAllConditions } from "@/lib/columnFilters";

// Stock Overview - the plant-wise stock lines (server/lib/stockV2.ts). One row = one item at one plant; Stock is the single total Loading draws
// from, Purchase and Sale are the day-wise figures with their Extra inside, Opening and Closing are added up for the period you pick.

type Row = {
  id: number | null; plant: string; state: string | null; barcode: string; itemName: string;
  sapCode: string | null; sapIsFallback: boolean; srNo: string | null; brand: string | null; category: string | null;
  palletSize: number | null; stock: number;
  openingStock: number; purchaseQty: number; extraPurchaseQty: number; saleQty: number; extraSaleQty: number;
  transferIn: number; transferOut: number; adjustQty: number; closingStock: number; closingPallets: number;
  expectedPurchase: number; expectedSale: number;
  // Set on a combined row (all plants / a state): the plant rows folded into it.
  parts?: Row[];
};
type Report = { items: Row[]; total: number; from: string | null; to: string | null };
type DayRow = { date: string; purchaseQty: number; extraPurchaseQty: number; saleQty: number; extraSaleQty: number; transferIn: number; transferOut: number };
type LedgerRow = { id: number; date: string; kind: string; qty: number; reason: string | null; by: string | null };

const dash = <span className="text-gray-300">—</span>;
const num = (n: number) => n.toLocaleString();
const signed = (n: number) => (n > 0 ? `+${n.toLocaleString()}` : n.toLocaleString());
// Same look as the Stock Overview: navy pill buttons, navy column headers, ruled columns.
const FILTER_BTN_CLASS = "h-7 rounded-full border-0 bg-[#001d6e] px-2.5 text-[11px] text-white hover:bg-[#001552] hover:text-white sm:h-8 sm:px-3 sm:text-xs";
const cellBorder = "border-r border-gray-300";
const headerBorder = "border-r border-[#001d6e]/30";
const FILTERS_KEY = "stockV2:filters";
const VISIBLE_KEY = "stockV2:visibleColumnIds";
const ORDER_KEY = "stockV2:columnOrder";
const PILL_ON = "rounded-full bg-[#001d6e] px-3.5 py-1.5 text-xs font-semibold text-white ring-2 ring-[#001d6e]/30";
const PILL_OFF = "rounded-full border border-gray-200 bg-white px-3.5 py-1.5 text-xs font-medium text-gray-600 hover:bg-gray-50";

function figure(n: number, extra?: number, tone = "text-gray-900") {
  if (!n && !extra) return dash;
  return (
    <span className={`tabular-nums ${tone}`}>
      {num(n)}
      {extra ? <span className="ml-1 text-[10px] font-medium text-amber-600">({num(extra)} extra)</span> : null}
    </span>
  );
}

// Default order of the list: by Sr No, ascending (the letter first, then the number: C020, C148, I174, V050 ...); items with no Sr No last.
const bySr = (a: Row, b: Row) => {
  if (!a.srNo && !b.srNo) return a.itemName.localeCompare(b.itemName);
  if (!a.srNo) return 1;
  if (!b.srNo) return -1;
  return a.srNo.localeCompare(b.srNo, undefined, { numeric: true, sensitivity: "base" }) || a.itemName.localeCompare(b.itemName);
};

// Pallets for a figure: each plant's own boxes divided by that plant's own pallet size (GJ and MP can differ), added up
// across a combined row's plants. Null when no plant has a pallet size set.
const palletsOf = (r: Row, f: (x: Row) => number): number | null => {
  let total = 0, any = false;
  for (const p of r.parts?.length ? r.parts : [r]) {
    if (p.palletSize && p.palletSize > 0) { total += f(p) / p.palletSize; any = true; }
  }
  return any ? total : null;
};
// The figure with its pallets written underneath it, in small grey type.
const withPallets = (r: Row, f: (x: Row) => number, node: React.ReactNode) => {
  const pal = f(r) ? palletsOf(r, f) : null;
  return (
    <div className="flex flex-col items-center leading-tight">
      {node}
      {pal != null ? <span className="text-[10px] font-medium tabular-nums text-[#001d6e]">{pal.toFixed(2)} plt</span> : null}
    </div>
  );
};

const totalPO = (r: Row) => r.openingStock + r.purchaseQty + r.adjustQty + r.transferIn - r.transferOut;

export default function StockOverview() {
  const { user } = useAuth();
  // Same rule as the Stock Overview: only an admin sees the delete icon (the server checks it too).
  const isAdmin = ["admin", "super-admin"].includes((((user as any)?.role as string) ?? "").toLowerCase());
  const [adjustTarget, setAdjustTarget] = useState<Row | null>(null);
  const [search, setSearch] = useState("");
  const [state, setState] = useState("");
  const [plant, setPlant] = useState("");
  // Same encoding as the Stock Overview: "d:YYYY-MM-DD" (one day) or "r:YYYY-MM-DD:YYYY-MM-DD" (a range).
  const [dateValue, setDateValue] = useState("");
  const { from, to } = useMemo(() => {
    if (dateValue.startsWith("d:")) return { from: dateValue.slice(2), to: dateValue.slice(2) };
    if (dateValue.startsWith("r:")) { const [, f, t] = dateValue.split(":"); return { from: f ?? "", to: t ?? "" }; }
    return { from: "", to: "" };
  }, [dateValue]);
  const [detail, setDetail] = useState<Row | null>(null);
  // Excel-style per-column filters (the funnel on each header, or "+ Filter"): same engine as the Stock Overview (lib/columnFilters).
  const [columnConditions, setColumnConditions] = useState<Record<string, FilterCondition>>(() => {
    try { return JSON.parse(sessionStorage.getItem(FILTERS_KEY) ?? "{}"); } catch { return {}; }
  });
  useEffect(() => { try { sessionStorage.setItem(FILTERS_KEY, JSON.stringify(columnConditions)); } catch { /* storage unavailable */ } }, [columnConditions]);
  const setColumnCondition = (id: string, c: FilterCondition) => setColumnConditions((prev) => ({ ...prev, [id]: c }));
  const clearColumnCondition = (id: string) => setColumnConditions((prev) => { const n = { ...prev }; delete n[id]; return n; });
  // The table's own sort, captured so an export comes out in the order you are looking at.
  const [sortState, setSortState] = useState<{ columnId: string; direction: "asc" | "desc" } | null>(null);
  const [filterPickerOpen, setFilterPickerOpen] = useState(false);
  const [filterPickerKey, setFilterPickerKey] = useState("");
  const [filterPickerSearch, setFilterPickerSearch] = useState("");
  // Which columns show and in what order is a preference: kept in localStorage.
  const [visibleColumnIds, setVisibleColumnIds] = useState<Set<string> | null>(() => {
    try { const raw = localStorage.getItem(VISIBLE_KEY); const a = raw ? JSON.parse(raw) : null; return Array.isArray(a) ? new Set<string>(a) : null; } catch { return null; }
  });
  useEffect(() => { try { if (visibleColumnIds) localStorage.setItem(VISIBLE_KEY, JSON.stringify(Array.from(visibleColumnIds))); } catch { /* storage unavailable */ } }, [visibleColumnIds]);
  const [columnOrder, setColumnOrder] = useState<string[]>(() => {
    try { const a = JSON.parse(localStorage.getItem(ORDER_KEY) ?? "[]"); return Array.isArray(a) ? a : []; } catch { return []; }
  });
  useEffect(() => { try { localStorage.setItem(ORDER_KEY, JSON.stringify(columnOrder)); } catch { /* storage unavailable */ } }, [columnOrder]);
  const rowIdOf = (r: Row) => (r.parts ? `m:${r.barcode}|${r.itemName}` : String(r.id ?? `${r.plant}-${r.barcode}`));

  const url = useMemo(() => {
    const q = new URLSearchParams();
    if (state) q.set("state", state);
    if (plant) q.set("plant", plant);
    if (from) q.set("from", from);
    if (to) q.set("to", to);
    return `/api/stock-v2/report?${q.toString()}`;
  }, [state, plant, from, to]);

  const { data, isLoading, isFetching, refetch } = useQuery<Report>({
    queryKey: [url],
    queryFn: () => apiRequest("GET", url, undefined, false, true),
    refetchInterval: 30000,
  });
  // The full list (no state/plant narrowing) only to learn which states / plants exist for the pills.
  const { data: all } = useQuery<Report>({
    queryKey: ["/api/stock-v2/report?pills"],
    queryFn: () => apiRequest("GET", "/api/stock-v2/report", undefined, false, true),
    staleTime: 60000,
  });
  const states = useMemo(() => {
    const m = new Map<string, Set<string>>();
    for (const r of all?.items ?? []) {
      const s = (r.state || "").toUpperCase() || "—";
      if (!m.has(s)) m.set(s, new Set());
      m.get(s)!.add(r.plant);
    }
    return Array.from(m.entries()).map(([s, p]) => ({ state: s, plants: Array.from(p).sort() })).sort((a, b) => a.state.localeCompare(b.state));
  }, [all]);

  // Without a plant picked (All, or a State) every item is ONE row, its plants added together — like the Stock
  // Overview's merged view; the plant-wise figures are in the row's "Plants" tab. Pick a plant for plant rows.
  const merged = !plant;
  const mergedRows = useMemo(() => {
    const t = search.trim().toLowerCase();
    let list = data?.items ?? [];
    if (t) list = list.filter((r) => [r.itemName, r.barcode, r.sapCode, r.srNo, r.category, r.brand].some((v) => String(v ?? "").toLowerCase().includes(t)));
    if (!merged) return [...list].sort(bySr);
    const byKey = new Map<string, Row[]>();
    for (const r of list) {
      const k = `${r.barcode.trim().toLowerCase()}|${r.itemName.trim().toLowerCase()}`; // same barcode AND same name = the same product
      if (!byKey.has(k)) byKey.set(k, []);
      byKey.get(k)!.push(r);
    }
    const add = (f: (r: Row) => number, ps: Row[]) => ps.reduce((x, r) => x + f(r), 0);
    return Array.from(byKey.values()).map((ps): Row => {
      if (ps.length === 1) return { ...ps[0], parts: ps };
      const head = ps[0];
      return {
        ...head,
        id: null,
        plant: ps.map((p) => p.plant).join(", "),
        stock: add((r) => r.stock, ps), openingStock: add((r) => r.openingStock, ps),
        purchaseQty: add((r) => r.purchaseQty, ps), extraPurchaseQty: add((r) => r.extraPurchaseQty, ps),
        saleQty: add((r) => r.saleQty, ps), extraSaleQty: add((r) => r.extraSaleQty, ps),
        transferIn: add((r) => r.transferIn, ps), transferOut: add((r) => r.transferOut, ps), adjustQty: add((r) => r.adjustQty, ps),
        closingStock: add((r) => r.closingStock, ps), closingPallets: add((r) => r.closingPallets, ps),
        expectedPurchase: add((r) => r.expectedPurchase, ps), expectedSale: add((r) => r.expectedSale, ps),
        parts: ps,
      };
    }).sort(bySr);
  }, [data, search, merged]);

  // The funnel / "+ Filter" conditions narrow what is listed (and what the cards add up), exactly as on the Stock Overview.
  const textOptions = (pick: (r: Row) => string | null | undefined) =>
    Array.from(new Set(mergedRows.map(pick).filter((v): v is string => !!v))).sort((a, b) => a.localeCompare(b)).map((v) => ({ value: v, label: v }));
  const numberOptions = (pick: (r: Row) => number | null | undefined) =>
    Array.from(new Set(mergedRows.map(pick).filter((v): v is number => v != null))).sort((a, b) => a - b).map((v) => ({ value: String(v), label: v.toLocaleString() }));
  const filterableColumns: FilterableColumn<Row>[] = [
    { id: "itemName", label: "Item", filterType: "text", options: textOptions((r) => r.itemName), accessor: (r) => r.itemName },
    { id: "barcode", label: "Barcode / SKU", filterType: "text", options: textOptions((r) => r.barcode), accessor: (r) => r.barcode },
    { id: "sapCode", label: "SAP Code", filterType: "text", options: textOptions((r) => r.sapCode), accessor: (r) => r.sapCode },
    { id: "category", label: "Category", filterType: "enum", options: textOptions((r) => r.category), accessor: (r) => r.category },
    { id: "brand", label: "Brand", filterType: "enum", options: textOptions((r) => r.brand), accessor: (r) => r.brand },
    { id: "opening", label: "Opening", filterType: "number", options: numberOptions((r) => r.openingStock), accessor: (r) => r.openingStock },
    { id: "expectedPurchase", label: "Expected Purchase", filterType: "number", options: numberOptions((r) => r.expectedPurchase), accessor: (r) => r.expectedPurchase },
    { id: "purchase", label: "Purchase", filterType: "number", options: numberOptions((r) => r.purchaseQty), accessor: (r) => r.purchaseQty },
    { id: "extra", label: "Extra Purchase", filterType: "number", options: numberOptions((r) => r.extraPurchaseQty), accessor: (r) => r.extraPurchaseQty },
    { id: "adjust", label: "Adjust", filterType: "number", options: numberOptions((r) => r.adjustQty), accessor: (r) => r.adjustQty },
    { id: "transferIn", label: "Transfer In", filterType: "number", options: numberOptions((r) => r.transferIn), accessor: (r) => r.transferIn },
    { id: "transferOut", label: "Transfer Out", filterType: "number", options: numberOptions((r) => r.transferOut), accessor: (r) => r.transferOut },
    { id: "totalPO", label: "Total P & O", filterType: "number", options: numberOptions((r) => totalPO(r)), accessor: (r) => totalPO(r) },
    { id: "expectedSale", label: "Expected Sale", filterType: "number", options: numberOptions((r) => r.expectedSale), accessor: (r) => r.expectedSale },
    { id: "sale", label: "Sale", filterType: "number", options: numberOptions((r) => r.saleQty), accessor: (r) => r.saleQty },
    { id: "extraSale", label: "Extra Sale", filterType: "number", options: numberOptions((r) => r.extraSaleQty), accessor: (r) => r.extraSaleQty },
    { id: "closing", label: "Closing", filterType: "number", options: numberOptions((r) => r.closingStock), accessor: (r) => r.closingStock },
    { id: "stock", label: "Stock", filterType: "number", options: numberOptions((r) => r.stock), accessor: (r) => r.stock },
  ];
  const conditionList = Object.values(columnConditions);
  const rows = useMemo(
    () => (conditionList.length ? mergedRows.filter((r) => matchAllConditions(r, conditionList, filterableColumns)) : mergedRows),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [mergedRows, columnConditions],
  );
  const columnHeader = (id: string, label: string) => {
    const col = filterableColumns.find((c) => c.id === id);
    if (!col) return label;
    return (
      <span className="inline-flex items-center justify-center gap-1 whitespace-nowrap">
        {label}
        <ColumnHeaderFilterButton column={col} condition={columnConditions[id]} onChange={(c) => setColumnCondition(id, c)} onRemove={() => clearColumnCondition(id)} />
      </span>
    );
  };
  const pickedFilterColumn = filterableColumns.find((c) => c.id === filterPickerKey) ?? null;
  const filterPickerOptions = filterableColumns.filter((c) => !columnConditions[c.id] && c.label.toLowerCase().includes(filterPickerSearch.trim().toLowerCase()));

  const sum = (f: (r: Row) => number) => rows.reduce((s, r) => s + f(r), 0);
  const tOpen = sum((r) => r.openingStock);
  const tPurchase = sum((r) => r.purchaseQty);
  const tExtraP = sum((r) => r.extraPurchaseQty);
  const tSale = sum((r) => r.saleQty);
  const tExpP = sum((r) => r.expectedPurchase);
  const tExpS = sum((r) => r.expectedSale);
  const tStock = sum((r) => r.stock);
  const period = from || to ? `${from || "start"} → ${to || "today"}` : "All dates";

  // Every column is centred (header and cells) except Item and Sr No, which stay left. Each width is wide enough for the header words,
  // the filter funnel and the sort arrow (a long header wraps onto two lines instead of being cut off).
  const sumOf = (rs: Row[], f: (r: Row) => number) => rs.reduce((x, r) => x + f(r), 0);
  const columns: DataTableColumn<Row>[] = [
    {
      id: "srNo", header: "Sr No", hideable: false, width: 74, fixedWidth: true, sortable: true, totalable: false,
      accessor: (r) => { const n = Number(r.srNo); return r.srNo != null && Number.isFinite(n) ? n : r.srNo; },
      cellClassName: "text-gray-400 tabular-nums", render: (r) => r.srNo || dash,
    },
    {
      id: "itemName", header: "Item", hideable: false, width: 220, fixedWidth: true, sortable: true, totalable: false,
      accessor: (r) => r.itemName, cellClassName: "font-medium text-gray-900 whitespace-normal break-words",
      render: (r) => (
        <button type="button" onClick={() => setDetail((cur) => (cur && rowIdOf(cur) === rowIdOf(r) ? null : r))} className="text-left underline decoration-dotted decoration-gray-300 underline-offset-2 hover:text-[#001d6e]">
          {r.itemName}
        </button>
      ),
    },
    { id: "barcode", header: "Barcode / SKU", width: 146, align: "center", fixedWidth: true, sortable: true, totalable: false, accessor: (r) => r.barcode, cellClassName: "font-mono text-gray-600", render: (r) => r.barcode },
    {
      id: "sapCode", header: "SAP Code", width: 106, align: "center", sortable: true, totalable: false, accessor: (r) => r.sapCode, cellClassName: "font-mono text-gray-600",
      render: (r) => (r.sapCode ? <span title={r.sapIsFallback ? "No SAP for this state — the general code is used" : undefined}>{r.sapCode}{r.sapIsFallback ? "*" : ""}</span> : dash),
    },
    { id: "category", header: "Category", width: 112, align: "center", sortable: true, totalable: false, accessor: (r) => r.category, cellClassName: "text-gray-700", render: (r) => r.category ?? dash },
    { id: "brand", header: "Brand", width: 92, align: "center", sortable: true, totalable: false, accessor: (r) => r.brand, cellClassName: "text-gray-700", render: (r) => r.brand ?? dash },
    ...(merged ? [] : [{ id: "plant", header: "Plant", hideable: false, width: 96, align: "center", sortable: true, totalable: false, accessor: (r) => r.plant, render: (r) => <PlantBadge plant={r.plant} /> } as DataTableColumn<Row>]),
    { id: "opening", header: "Opening", width: 100, align: "center", sortable: true, accessor: (r) => r.openingStock, total: (rs) => num(sumOf(rs, (r) => r.openingStock)), render: (r) => withPallets(r, (x) => x.openingStock, figure(r.openingStock)) },
    { id: "expectedPurchase", header: "Expected Purchase", width: 164, align: "center", sortable: true, accessor: (r) => r.expectedPurchase, total: (rs) => num(sumOf(rs, (r) => r.expectedPurchase)), render: (r) => withPallets(r, (x) => x.expectedPurchase, figure(r.expectedPurchase, 0, "text-purple-700")) },
    { id: "purchase", header: "Purchase", width: 104, align: "center", sortable: true, accessor: (r) => r.purchaseQty, total: (rs) => num(sumOf(rs, (r) => r.purchaseQty)), render: (r) => withPallets(r, (x) => x.purchaseQty, figure(r.purchaseQty)) },
    { id: "extra", header: "Extra Purchase", width: 142, align: "center", sortable: true, accessor: (r) => r.extraPurchaseQty, total: (rs) => num(sumOf(rs, (r) => r.extraPurchaseQty)), render: (r) => (r.extraPurchaseQty ? withPallets(r, (x) => x.extraPurchaseQty, <span className="tabular-nums text-amber-600">{num(r.extraPurchaseQty)}</span>) : dash) },
    {
      // Click the figure to read the corrections behind it (an admin can delete one there), as on the Stock Overview.
      id: "adjust", header: "Adjust", width: 92, align: "center", sortable: true, preventRowClick: true, accessor: (r) => r.adjustQty, total: (rs) => signed(sumOf(rs, (r) => r.adjustQty)),
      render: (r) => (r.adjustQty
        ? withPallets(r, (x) => x.adjustQty, <button type="button" title="See the adjustments behind this figure" onClick={() => setAdjustTarget(r)} className="tabular-nums font-medium text-[#001d6e] underline decoration-dotted underline-offset-2 hover:text-[#0a2b7e]">{signed(r.adjustQty)}</button>)
        : dash),
    },
    { id: "transferIn", header: "Transfer In", width: 114, align: "center", sortable: true, accessor: (r) => r.transferIn, total: (rs) => num(sumOf(rs, (r) => r.transferIn)), render: (r) => withPallets(r, (x) => x.transferIn, figure(r.transferIn)) },
    { id: "transferOut", header: "Transfer Out", width: 124, align: "center", sortable: true, accessor: (r) => r.transferOut, total: (rs) => num(sumOf(rs, (r) => r.transferOut)), render: (r) => withPallets(r, (x) => x.transferOut, figure(r.transferOut)) },
    {
      // Total P & O = Opening + Purchase + Adjust + Transfer In - Transfer Out (everything that has come in, before any Sale).
      id: "totalPO", header: "Total P & O", width: 116, align: "center", sortable: true, accessor: (r) => totalPO(r),
      total: (rs) => num(sumOf(rs, (r) => totalPO(r))),
      cellClassName: "font-semibold", render: (r) => withPallets(r, totalPO, <span className="tabular-nums">{num(totalPO(r))}</span>),
    },
    { id: "expectedSale", header: "Expected Sale", width: 130, align: "center", sortable: true, accessor: (r) => r.expectedSale, total: (rs) => num(sumOf(rs, (r) => r.expectedSale)), render: (r) => withPallets(r, (x) => x.expectedSale, figure(r.expectedSale, 0, "text-purple-700")) },
    { id: "sale", header: "Sale", width: 84, align: "center", sortable: true, accessor: (r) => r.saleQty, total: (rs) => num(sumOf(rs, (r) => r.saleQty)), render: (r) => withPallets(r, (x) => x.saleQty, figure(r.saleQty, 0, "text-emerald-700")) },
    { id: "extraSale", header: "Extra Sale", width: 110, align: "center", sortable: true, accessor: (r) => r.extraSaleQty, total: (rs) => num(sumOf(rs, (r) => r.extraSaleQty)), render: (r) => (r.extraSaleQty ? withPallets(r, (x) => x.extraSaleQty, <span className="tabular-nums text-amber-600">{num(r.extraSaleQty)}</span>) : dash) },
    {
      id: "closing", header: "Closing", width: 100, align: "center", sortable: true, accessor: (r) => r.closingStock,
      total: (rs) => num(sumOf(rs, (r) => r.closingStock)),
      cellClassName: "font-semibold", render: (r) => withPallets(r, (x) => x.closingStock, <span className={`tabular-nums ${r.closingStock < 0 ? "text-amber-600" : ""}`}>{num(r.closingStock)}</span>),
    },
    ...(isAdmin ? [{ id: "actions", header: "", hideable: false, width: 52, fixedWidth: true, align: "center", preventRowClick: true, totalable: false, render: (r: Row) => (r.id != null || r.parts?.length ? <LineActions row={r} /> : null) } as DataTableColumn<Row>] : []),
    { id: "stock", header: "Stock", width: 88, align: "center", sortable: true, accessor: (r) => r.stock, total: (rs) => num(sumOf(rs, (r) => r.stock)), cellClassName: "font-semibold text-[#001d6e]", render: (r) => withPallets(r, (x) => x.stock, <span className="tabular-nums">{num(r.stock)}</span>) },
  ];

  // The same column look as the Stock Overview: ruled cells, ruled navy header cells, a funnel on every column that can be filtered.
  const baseColumns = columns;
  const styledColumns: DataTableColumn<Row>[] = baseColumns.map((c) => ({
    ...c,
    header: typeof c.header === "string" ? columnHeader(c.id, c.header) : c.header,
    headerClassName: `${(c as any).headerClassName ?? ""} whitespace-nowrap text-center ${headerBorder}`.trim(),
    cellClassName: `${c.cellClassName ?? ""} ${cellBorder}`.trim(),
  }));
  const visibleSet = visibleColumnIds ?? new Set(baseColumns.map((c) => c.id));
  const toggleColumn = (id: string) => setVisibleColumnIds((prev) => {
    const next = new Set(prev ?? baseColumns.map((c) => c.id));
    if (next.has(id)) next.delete(id); else next.add(id);
    return next;
  });

  // Export — what is visible, in the table's order: CSV, Excel or PDF.
  // What you see is what is exported: the rows left after the pills, date, search and funnel filters, in the table's current sort,
  // with the visible columns in their current order, and a Total row like the table's.
  // `onlyPicked` (the PDF): exactly the columns ticked in the Columns button — the always-shown Sr No / Item / Plant are left out
  // unless nothing is ticked, so a PDF of 5 picked columns has 5 columns.
  const exportRows = (onlyPicked = false): Array<Array<string | number>> => {
    const picked = baseColumns.filter((c) => c.id !== "actions" && (c as any).hideable !== false && visibleSet.has(c.id));
    const cols = onlyPicked && picked.length > 0
      ? picked
      : baseColumns.filter((c) => c.id !== "actions" && (visibleSet.has(c.id) || (c as any).hideable === false));
    const ordered = columnOrder.length ? [...cols].sort((a, b) => (columnOrder.indexOf(a.id) + 1 || 999) - (columnOrder.indexOf(b.id) + 1 || 999)) : cols;
    let list = rows;
    if (sortState) {
      const sc = baseColumns.find((c) => c.id === sortState.columnId) as any;
      if (sc?.accessor) {
        list = [...rows].sort((x, y) => {
          const va = sc.accessor(x), vb = sc.accessor(y);
          if (va == null && vb == null) return 0;
          if (va == null) return 1;
          if (vb == null) return -1;
          if (va < vb) return sortState.direction === "asc" ? -1 : 1;
          if (va > vb) return sortState.direction === "asc" ? 1 : -1;
          return 0;
        });
      }
    }
    const head = ordered.map((c) => String(c.header).replace(/ /g, " "));
    const body = list.map((r) => ordered.map((c) => { const v = (c as any).accessor?.(r); return v == null ? "" : v; }));
    const totals = ordered.map((c, i) => (i === 0 ? "Total" : (c as any).total ? String((c as any).total(list)) : ""));
    return [head, ...body, totals];
  };
  const exportAs = (fmt: "CSV" | "Excel" | "PDF") => {
    const data = exportRows(fmt === "PDF");
    const stamp = `${state || "all"}${plant ? "-" + plant : ""}-${format(new Date(), "yyyy-MM-dd")}`;
    if (fmt === "CSV") {
      const csv = data.map((r) => r.map((c) => `"${String(c).replace(/"/g, '""')}"`).join(",")).join("\n");
      const a = document.createElement("a");
      a.href = URL.createObjectURL(new Blob([csv], { type: "text/csv" }));
      a.download = `stock-new-${stamp}.csv`; a.click();
    } else if (fmt === "Excel") {
      const book = XLSX.utils.book_new();
      XLSX.utils.book_append_sheet(book, XLSX.utils.aoa_to_sheet(data), "Stock Overview");
      XLSX.writeFile(book, `stock-new-${stamp}.xlsx`);
    } else {
      const doc = new jsPDF({ orientation: "landscape", unit: "mm", format: "a4" });
      const scope = [state ? `State ${state}` : "All states", plant || "", search ? `search "${search}"` : "", Object.keys(columnConditions).length ? `${Object.keys(columnConditions).length} filter(s)` : ""].filter(Boolean).join(" · ");
      const subtitle = `${period} · ${scope} · ${rows.length} rows`;
      setPdfProperties(doc, "Stock Overview Report", subtitle);
      const startY = drawPdfHeader(doc, { title: "Stock Overview Report", subtitle, margin: 10, generated: format(new Date(), "d MMM yyyy, HH:mm") });
      autoTable(doc, {
        head: [data[0].map(String)], body: data.slice(1).map((r) => r.map(String)), startY, theme: "grid",
        styles: { fontSize: 7, cellPadding: 2, lineColor: [210, 210, 210], lineWidth: 0.15 },
        headStyles: { fillColor: [0, 29, 110], textColor: 255, fontStyle: "bold" }, alternateRowStyles: { fillColor: [245, 247, 251] }, margin: { left: 10, right: 10 }, didParseCell: greenTotalRow,
      });
      drawPdfFooter(doc, 10);
      doc.save(`stock-new-${stamp}.pdf`);
    }
  };

  return (
    <div className="space-y-3 p-4 lg:p-6">
      <PageHeader
        icon={LayoutList}
        title="Stock Overview"
        description="Plant-wise stock lines — one Stock figure per item for Loading, with Purchase and Sale day by day. Opening and Closing are worked out for the dates you pick."
      />

      <StatsBar
        className="rounded-xl shadow-none border-gray-300 [&_.divide-x]:divide-gray-300"
        wrapLabels
        singleRow
        stats={[
          { icon: History, tone: "navy" as const, value: num(tOpen), label: "Opening", hint: `Start of period` },
          { icon: CalendarDays, tone: "navy" as const, value: num(tExpP), label: "Expected Purchase", hint: period },
          { icon: Boxes, tone: "navy" as const, value: num(tPurchase), label: "Purchase", hint: tExtraP ? `${period} · incl. ${num(tExtraP)} extra` : period },
          { icon: ShoppingCart, tone: "emerald" as const, value: num(tSale), label: "Sale (loaded)", hint: period },
          { icon: ShoppingCart, tone: "navy" as const, value: num(tExpS), label: "Expected Sale", hint: period },
          { icon: Scale, tone: "navy" as const, value: num(tStock), label: "Stock", hint: "Total on hand now" },
        ]}
      />

      <div className="flex flex-wrap items-center gap-1.5">
        <span className="mr-1 text-[11px] font-semibold uppercase tracking-wide text-gray-400">State</span>
        <button onClick={() => { setState(""); setPlant(""); }} className={!state && !plant ? PILL_ON : PILL_OFF}>All</button>
        {states.map((g) => (
          <button key={g.state} onClick={() => { setState(g.state); setPlant(""); }} className={state === g.state && !plant ? PILL_ON : PILL_OFF}>{g.state}</button>
        ))}
      </div>
      {state && (states.find((g) => g.state === state)?.plants.length ?? 0) > 1 && (
        <div className="flex flex-wrap items-center gap-1.5">
          <span className="mr-1 text-[11px] font-semibold uppercase tracking-wide text-gray-400">Plant</span>
          {states.find((g) => g.state === state)!.plants.map((p) => (
            <button key={p} onClick={() => setPlant(plant === p ? "" : p)} className={plant === p ? PILL_ON : PILL_OFF}>{p}</button>
          ))}
        </div>
      )}

      <TableCard
        icon={LayoutList}
        title="Stock by Plant"
        subtitle={`${rows.length} line${rows.length === 1 ? "" : "s"} · ${period}`}
        className="rounded-xl shadow-none border-gray-300"
        headerActions={
          <>
            <Button type="button" variant="outline" size="icon" onClick={() => refetch()} disabled={isFetching} title="Refresh" className="h-8 w-8 rounded-md border-gray-300 text-gray-600 hover:bg-gray-50">
              <RotateCw className={`h-3.5 w-3.5 ${isFetching ? "animate-spin" : ""}`} />
            </Button>
            <CollapsibleSearch value={search} onChange={setSearch} placeholder="Sr No, item, barcode, SAP, category…" />
            <DateFilter value={dateValue} onChange={setDateValue} />
            <Popover
              open={filterPickerOpen}
              onOpenChange={(open) => { setFilterPickerOpen(open); if (!open) { setFilterPickerKey(""); setFilterPickerSearch(""); } }}
            >
              <PopoverTrigger asChild>
                <Button size="sm" variant="outline" className="h-8 gap-1 rounded-md border-dashed border-[#001d6e]/40 bg-white text-xs font-medium text-[#001d6e] hover:bg-[#001d6e]/5 hover:text-[#001d6e]">
                  <Plus className="h-3.5 w-3.5" /> Filter
                </Button>
              </PopoverTrigger>
              <PopoverContent align="start" className="w-64">
                {filterPickerKey === "" ? (
                  <div className="space-y-1.5">
                    <div className="relative">
                      <Search className="absolute left-2 top-2 h-3.5 w-3.5 text-gray-400" />
                      <Input className="h-8 pl-7 text-xs" placeholder="Find a filter…" value={filterPickerSearch} onChange={(e) => setFilterPickerSearch(e.target.value)} autoFocus />
                    </div>
                    <div className="max-h-56 overflow-y-auto">
                      {filterPickerOptions.length === 0 ? (
                        <div className="px-2 py-1.5 text-xs text-gray-400">{filterPickerSearch ? "No matches" : "All filters added"}</div>
                      ) : (
                        filterPickerOptions.map((d) => (
                          <button key={d.id} type="button" onClick={() => setFilterPickerKey(d.id)}
                            className="block w-full rounded px-2 py-1.5 text-left text-xs text-gray-700 hover:bg-[#001d6e]/5 hover:text-[#001d6e]">
                            {d.label}
                          </button>
                        ))
                      )}
                    </div>
                  </div>
                ) : pickedFilterColumn ? (
                  <div className="space-y-2">
                    <button type="button" onClick={() => setFilterPickerKey("")} className="flex items-center gap-1 text-[11px] text-gray-400 hover:text-gray-600">
                      <ChevronLeft className="h-3 w-3" /> Back
                    </button>
                    <ColumnFilterPopoverContent
                      column={pickedFilterColumn}
                      onApply={(c) => { setColumnCondition(pickedFilterColumn.id, c); setFilterPickerOpen(false); setFilterPickerKey(""); }}
                      onCancel={() => setFilterPickerKey("")}
                    />
                  </div>
                ) : null}
              </PopoverContent>
            </Popover>
            {Object.values(columnConditions).some((c) => !isConditionEmpty(c)) && (
              <Button size="sm" variant="ghost" className="h-8 px-2 text-xs text-gray-500 hover:text-gray-900" onClick={() => setColumnConditions({})}>Clear all</Button>
            )}
            <DataTableColumnToggle
              columnOrder={columnOrder}
              onColumnOrderChange={setColumnOrder}
              columns={baseColumns}
              visibleColumnIds={visibleSet}
              onToggleColumn={toggleColumn}
              onSetAll={(visible) => setVisibleColumnIds(visible ? new Set(baseColumns.map((c) => c.id)) : new Set())}
              buttonClassName={FILTER_BTN_CLASS}
            />
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <Button variant="outline" size="sm" className={FILTER_BTN_CLASS} disabled={rows.length === 0}>
                  <FileDown className="mr-1 h-3.5 w-3.5" /> Export <ChevronDown className="ml-1 h-3.5 w-3.5 opacity-70" />
                </Button>
              </DropdownMenuTrigger>
              <DropdownMenuContent align="end" className="w-36">
                {(["CSV", "Excel", "PDF"] as const).map((f) => (
                  <DropdownMenuItem key={f} onSelect={() => exportAs(f)}>
                    <FileDown className="mr-2 h-3.5 w-3.5 opacity-70" /> {f}
                  </DropdownMenuItem>
                ))}
              </DropdownMenuContent>
            </DropdownMenu>
          </>
        }
      >
        <DataTable<Row>
          containerClassName="rounded-none border-0"
          columns={styledColumns}
          data={isLoading ? [] : rows}
          getRowId={rowIdOf}
          renderExpandedRow={() => (detail ? <EntriesPanel row={detail} dateSelected={!!(from || to)} /> : null)}
          isRowExpandable={() => true}
          expandedRowId={detail ? rowIdOf(detail) : null}
          emptyState="No stock lines yet. They appear here once stock is received, loaded or adjusted."
          noResultsState="No stock rows match your search."
          hasActiveFilters={!!search || Object.keys(columnConditions).length > 0}
          headerClassName="bg-[#001d6e] text-white border-[#1a3a9c] hover:bg-[#0a2b7e] hover:text-white"
          enableColumnVisibility
          columnVisibility={visibleSet}
          onColumnVisibilityChange={(v: Set<string>) => setVisibleColumnIds(v)}
          onSortingChange={(sv: any) => setSortState(sv)}
          columnOrder={columnOrder}
          onColumnOrderChange={setColumnOrder}
          showMobileSwipeHint
          enableTotalsRow
          enableZebraStripes
          sortMode="client"
          isStickyHeader
          maxHeight="max(480px, calc(100dvh - 140px))"
          paginationMode="client"
          stickyColumnIds={["srNo", "itemName", "barcode"]}
          defaultPageSize={50}
          pageSizeOptions={[20, 50, 100, 200]}
          enableColumnResizing
        />
      </TableCard>

      {adjustTarget && <AdjustDialog row={adjustTarget} from={from} to={to} isAdmin={isAdmin} onClose={() => setAdjustTarget(null)} />}

    </div>
  );
}

// The admin actions on ONE stock line (one item at one plant; on a combined row the plant is picked first): Adjust (add / remove / set), Clear (Stock to 0, the book keeps its history) and
// Delete history (forget the line's days and corrections). Each is its own dialog; the server checks admin and the plant again.
function LineActions({ row: top }: { row: Row }) {
  const { toast } = useToast();
  // A combined row (all plants / a state) folds several plants: the action is about one of them, picked in the dialog.
  const parts = (top.parts && top.parts.length ? top.parts : [top]).filter((p) => p.id != null);
  const [pick, setPick] = useState(0);
  const row = parts[Math.min(pick, parts.length - 1)] ?? top;
  const [dialog, setDialog] = useState<null | "adjust" | "clear" | "delete">(null);
  const [exchange, setExchange] = useState(false);
  const [mode, setMode] = useState<"add" | "remove" | "set">("add");
  const [qty, setQty] = useState("");
  const [reason, setReason] = useState("");
  const [typed, setTyped] = useState("");
  const q = Math.round(Number(qty));
  const valid = Number.isFinite(q) && q >= 0 && (mode === "set" || q > 0);
  const next = !valid ? null : mode === "add" ? row.stock + q : mode === "remove" ? row.stock - q : q;
  const close = () => { setDialog(null); setQty(""); setReason(""); setTyped(""); setMode("add"); };
  const refresh = () => queryClient.invalidateQueries({ predicate: (qq) => String(qq.queryKey[0] ?? "").startsWith("/api/stock-v2") || String(qq.queryKey[0] ?? "").startsWith("/api/scan-sessions") });
  const run = useMutation({
    mutationFn: () => {
      if (dialog === "adjust") return apiRequest("POST", `/api/stock-v2/line/${row.id}/adjust`, { mode, qty: q, expectedCurrentQty: row.stock, reason: reason.trim() || undefined }, false, true);
      if (dialog === "clear") return apiRequest("POST", `/api/stock-v2/line/${row.id}/clear`, {}, false, true);
      return apiRequest("DELETE", `/api/stock-v2/line/${row.id}`, undefined, false, true);
    },
    onSuccess: () => {
      toast({ title: dialog === "adjust" ? "Stock adjusted" : dialog === "clear" ? "Stock cleared" : "History deleted", description: `${row.itemName} at ${row.plant}` });
      refresh(); close();
    },
    onError: (e: any) => { toast({ title: "Could not do that", description: e?.message ?? "Try again", variant: "destructive" }); refresh(); },
  });
  const title = dialog === "adjust" ? "Adjust stock" : dialog === "clear" ? "Clear stock" : "Delete stock history";
  return (
    <>
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <Button type="button" variant="ghost" size="icon" className="h-7 w-7" title="Stock actions"><MoreVertical className="h-4 w-4" /></Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end" className="w-44">
          <DropdownMenuItem onSelect={() => setDialog("adjust")}>Adjust stock…</DropdownMenuItem>
          <DropdownMenuItem onSelect={() => setExchange(true)} disabled={row.stock <= 0}>Exchange to another product…</DropdownMenuItem>
          <DropdownMenuItem onSelect={() => setDialog("clear")} disabled={row.stock === 0}>Clear stock…</DropdownMenuItem>
          <DropdownMenuItem onSelect={() => setDialog("delete")} className="text-red-600 focus:text-red-600">Delete history…</DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>
      <ExchangeProductDialog
        source={exchange ? { barcode: row.barcode, itemName: row.itemName, plant: row.plant, availableStock: row.stock, itemsPerPallet: row.palletSize } : null}
        onClose={() => setExchange(false)}
      />
      <Dialog open={dialog !== null} onOpenChange={(o) => { if (!o) close(); }}>
        <DialogContent className="max-w-md">
          <DialogHeader>
            <DialogTitle>{title}</DialogTitle>
            <DialogDescription>{row.itemName} · {row.barcode} · {row.plant} · Stock now <b>{num(row.stock)}</b></DialogDescription>
          </DialogHeader>
          {parts.length > 1 && (
            <div className="flex flex-wrap gap-1.5">
              {parts.map((p, i) => <button key={p.id} type="button" onClick={() => setPick(i)} className={tabCls(i === pick)}>{p.plant} · {num(p.stock)}</button>)}
            </div>
          )}
          {dialog === "adjust" && (
            <div className="space-y-3">
              <div className="flex gap-1.5">
                {([["add", "Add"], ["remove", "Remove"], ["set", "Set to"]] as const).map(([k, l]) => (
                  <button key={k} type="button" onClick={() => setMode(k)} className={tabCls(mode === k)}>{l}</button>
                ))}
              </div>
              <Input type="number" min={0} inputMode="numeric" placeholder={mode === "set" ? "New stock" : "Boxes"} value={qty} onChange={(e) => setQty(e.target.value)} />
              <Input placeholder="Reason (optional)" value={reason} onChange={(e) => setReason(e.target.value)} />
              {next != null && <p className={`text-sm ${next < 0 ? "text-red-600" : "text-gray-600"}`}>{next < 0 ? `Only ${num(row.stock)} in stock — can't remove ${num(q)}.` : `Stock ${num(row.stock)} → ${num(next)} (${signed(next - row.stock)})`}</p>}
            </div>
          )}
          {dialog === "clear" && <p className="text-sm text-gray-600">Takes the Stock of this item at {row.plant} from {num(row.stock)} to 0. It is recorded as a correction (Adjust {signed(-row.stock)}); the purchases and sales stay in the book.</p>}
          {dialog === "delete" && (
            <div className="space-y-2">
              <p className="text-sm text-gray-600">Forgets every day and correction of this item at {row.plant} and sets its Stock to 0. Scan entries (Order Scan, Unloading, Loading) are not touched. Type the barcode to confirm.</p>
              <Input placeholder={row.barcode} value={typed} onChange={(e) => setTyped(e.target.value)} />
            </div>
          )}
          <DialogFooter>
            <Button variant="outline" onClick={close}>Cancel</Button>
            <Button
              className={dialog === "delete" ? "bg-red-600 hover:bg-red-700" : "bg-[#001d6e] hover:bg-[#001552]"}
              disabled={run.isPending || (dialog === "adjust" && (!valid || (next ?? 0) < 0)) || (dialog === "delete" && typed.trim().toLowerCase() !== row.barcode.toLowerCase())}
              onClick={() => run.mutate()}
            >
              {run.isPending ? <Loader2 className="h-4 w-4 animate-spin" /> : dialog === "adjust" ? "Save" : dialog === "clear" ? "Clear stock" : "Delete"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}

// Same two buttons as the Stock Overview: "Filter by date" = quick ranges, "Calendar" = one date or a from/to range.
const isoOf = (d: Date) => format(d, "yyyy-MM-dd");
function presetValue(key: string): string {
  const d = new Date();
  if (key === "today") return `d:${isoOf(d)}`;
  if (key === "yday") { const y = new Date(d); y.setDate(y.getDate() - 1); return `d:${isoOf(y)}`; }
  if (key === "week") { const w = new Date(d); w.setDate(w.getDate() - 6); return `r:${isoOf(w)}:${isoOf(d)}`; }
  if (key === "month") return `r:${isoOf(new Date(d.getFullYear(), d.getMonth(), 1))}:${isoOf(d)}`;
  return "";
}
const PRESETS = [{ value: "today", label: "Today" }, { value: "yday", label: "Yesterday" }, { value: "week", label: "This week" }, { value: "month", label: "This month" }];

function DateFilter({ value, onChange }: { value: string; onChange: (v: string) => void }) {
  const [quickOpen, setQuickOpen] = useState(false);
  const [calOpen, setCalOpen] = useState(false);
  const isRange = value.startsWith("r:");
  const [mode, setMode] = useState<"single" | "range">("single");
  const parts = value.startsWith("d:") ? [value.slice(2), value.slice(2)] : value.startsWith("r:") ? value.split(":").slice(1) : ["", ""];
  const fromDate = parts[0] ?? "";
  const toDate = parts[1] ?? "";
  const fmt = (x: string) => { const d = x ? new Date(x) : null; return d && !isNaN(d.getTime()) ? format(d, "MMM d, yyyy") : "…"; };
  const label = value.startsWith("d:") ? fmt(fromDate) : isRange ? `${fmt(fromDate)} – ${fmt(toDate)}` : "Filter by date";
  const inputCls = "h-8 w-full rounded-md border border-gray-300 bg-white px-2 text-xs";
  return (
    <div className="flex items-center gap-1">
      <Popover open={quickOpen} onOpenChange={setQuickOpen}>
        <PopoverTrigger asChild>
          <Button size="sm" variant="outline" className={`h-8 gap-1.5 rounded-md text-xs font-medium ${value ? "border-[#001d6e] bg-[#001d6e]/5 text-[#001d6e]" : "border-gray-300 text-gray-600 hover:bg-gray-50"}`}>
            <CalendarDays className="h-3.5 w-3.5" />
            {label}
            {value && (
              <span role="button" aria-label="Clear date" onClick={(e) => { e.stopPropagation(); onChange(""); }} className="ml-0.5 rounded p-0.5 hover:bg-[#001d6e]/10">
                <X className="h-3 w-3" />
              </span>
            )}
          </Button>
        </PopoverTrigger>
        <PopoverContent align="end" sideOffset={6} avoidCollisions={false} className="w-72">
          <div className="space-y-1">
            <label className="text-[11px] font-semibold uppercase tracking-wide text-gray-500">Quick ranges</label>
            <div className="grid grid-cols-2 gap-1.5">
              {PRESETS.map((o) => (
                <button key={o.value} type="button" onClick={() => { onChange(presetValue(o.value)); setQuickOpen(false); }}
                  className="rounded-md border border-gray-300 px-2 py-1 text-xs text-gray-700 hover:border-[#001d6e]/40 hover:bg-[#001d6e]/5 hover:text-[#001d6e]">
                  {o.label}
                </button>
              ))}
            </div>
          </div>
        </PopoverContent>
      </Popover>
      <Popover open={calOpen} onOpenChange={(o) => { setCalOpen(o); if (o) setMode(isRange ? "range" : "single"); }}>
        <PopoverTrigger asChild>
          <Button size="sm" variant="outline" className="h-8 rounded-md border-gray-300 text-xs font-medium text-gray-500 hover:bg-gray-50">Calendar</Button>
        </PopoverTrigger>
        <PopoverContent align="end" sideOffset={6} avoidCollisions={false} className="w-72">
          <div className="space-y-3">
            <div className="grid grid-cols-2 gap-1.5">
              {(["single", "range"] as const).map((m) => (
                <button key={m} type="button" onClick={() => setMode(m)}
                  className={`rounded-md border px-2 py-1 text-xs font-medium ${mode === m ? "border-[#001d6e] bg-[#001d6e]/5 text-[#001d6e]" : "border-gray-300 text-gray-600 hover:bg-gray-50"}`}>
                  {m === "single" ? "Single date" : "Date range"}
                </button>
              ))}
            </div>
            {mode === "single" ? (
              <div className="space-y-1">
                <label className="text-[11px] font-semibold uppercase tracking-wide text-gray-500">Date</label>
                <input type="date" value={fromDate} className={inputCls}
                  onChange={(e) => { onChange(e.target.value ? `d:${e.target.value}` : ""); if (e.target.value) setCalOpen(false); }} />
              </div>
            ) : (
              <div className="grid grid-cols-2 gap-2">
                <div className="space-y-1">
                  <label className="text-[11px] font-semibold uppercase tracking-wide text-gray-500">From</label>
                  <input type="date" value={fromDate} max={toDate || undefined} className={inputCls} onChange={(e) => onChange(`r:${e.target.value}:${toDate}`)} />
                </div>
                <div className="space-y-1">
                  <label className="text-[11px] font-semibold uppercase tracking-wide text-gray-500">To</label>
                  <input type="date" value={toDate} min={fromDate || undefined} className={inputCls} onChange={(e) => onChange(`r:${fromDate}:${e.target.value}`)} />
                </div>
              </div>
            )}
          </div>
        </PopoverContent>
      </Popover>
    </div>
  );
}

// The entries behind one line, opened under its row like the Stock Overview: Days (this page's own book), then
// the same four histories — Scan Order, Unloading, Loading, Adjust.
type Hist = { items: any[] };
const fmtAt = (v: string | null | undefined) => { const d = v ? new Date(v) : null; return d && !isNaN(d.getTime()) ? format(d, "dd MMM yyyy, hh:mm:ss a") : "—"; };
const tabCls = (on: boolean) => `rounded-full px-3 py-1 text-xs font-medium ${on ? "bg-[#001d6e] text-white" : "border border-gray-200 bg-white text-gray-600 hover:bg-gray-50"}`;

function EntriesPanel({ row, dateSelected }: { row: Row; dateSelected: boolean }) {
  const parts = row.parts && row.parts.length ? row.parts : [row];
  const multi = parts.length > 1;
  const plants = parts.map((p) => p.plant);
  const plantsKey = plants.join(",");
  const [tab, setTab] = useState<"plants" | "days" | "scanning" | "unloading" | "loading" | "adjust">(multi ? "plants" : dateSelected ? "scanning" : "days");
  // The Days book is the all-dates view: with a date picked, the table above already is that day, so the tab is not offered.
  useEffect(() => { if (dateSelected && tab === "days") setTab(multi ? "plants" : "scanning"); }, [dateSelected, tab, multi]);
  const newest = (it: any) => +new Date(it.arrivedAt ?? it.scannedAt ?? it.at ?? 0);
  // One history per plant, merged newest first — what the Stock Overview does for a combined (all plants / state) row.
  const hist = (name: string, forTab: string) => useQuery<Hist>({
    queryKey: [`/api/scan-sessions/reports/${name}`, row.barcode, plantsKey],
    queryFn: async () => {
      const per = await Promise.all(plants.map((plant) =>
        apiRequest("GET", `/api/scan-sessions/reports/${name}?barcode=${encodeURIComponent(row.barcode)}&plant=${encodeURIComponent(plant)}`, undefined, false, true)
          .then((d: Hist) => d.items.map((it) => ({ ...it, plant })))));
      return { items: per.flat().sort((a, b) => newest(b) - newest(a)) };
    },
    enabled: tab === forTab,
  });
  const lineIds = parts.map((p) => p.id).filter((x): x is number => x != null);
  const days = useQuery<{ days: (DayRow & { plant: string })[]; ledger: (LedgerRow & { plant: string })[] }>({
    queryKey: ["/api/stock-v2/line-days", lineIds.join(",")],
    queryFn: async () => {
      const per = await Promise.all(parts.filter((p) => p.id != null).map((p) =>
        apiRequest("GET", `/api/stock-v2/line/${p.id}/days`, undefined, false, true)
          .then((d: { days: DayRow[]; ledger: LedgerRow[] }) => ({ days: d.days.map((x) => ({ ...x, plant: p.plant })), ledger: d.ledger.map((x) => ({ ...x, plant: p.plant })) }))));
      return {
        days: per.flatMap((x) => x.days).sort((a, b) => b.date.localeCompare(a.date)),
        ledger: per.flatMap((x) => x.ledger).sort((a, b) => b.date.localeCompare(a.date)),
      };
    },
    enabled: tab === "days" && lineIds.length > 0,
  });
  const scanning = hist("stock-movements", "scanning");
  const unloading = hist("unloading-history", "unloading");
  const loading = hist("loading-history", "loading");
  const adjust = hist("adjust-history", "adjust");

  // `raw` is the plain value behind every cell (a number or text), used by the funnel filters and the Total row.
  const withPlant = (head: string[], rows: (string | number | JSX.Element)[][], plantOf: string[], classes?: string[], raw?: (string | number)[][]) =>
    multi
      ? { head: ["Plant", ...head], rows: rows.map((r, i) => [plantOf[i], ...r]), classes, raw: raw?.map((r, i) => [plantOf[i], ...r]) }
      : { head, rows, classes, raw };

  // Every inner table has the same funnel filters as the main table (one condition per column, kept per tab).
  // The panel is pinned to the left and is exactly as wide as the main table's visible area, so it never scrolls sideways with the table.
  const panelRef = useRef<HTMLDivElement>(null);
  const [panelW, setPanelW] = useState<number | null>(null);
  useEffect(() => {
    let anc: HTMLElement | null = panelRef.current?.parentElement ?? null;
    while (anc && !/(auto|scroll)/.test(getComputedStyle(anc).overflowX)) anc = anc.parentElement;
    if (!anc) return;
    const el = anc;
    const measure = () => setPanelW(el.clientWidth);
    measure();
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    return () => ro.disconnect();
  }, []);
  const [innerFilters, setInnerFilters] = useState<Record<string, Record<string, FilterCondition>>>({});
  const setInnerCond = (tabKey: string, col: string, c: FilterCondition | null) =>
    setInnerFilters((prev) => {
      const cur = { ...(prev[tabKey] ?? {}) };
      if (c) cur[col] = c; else delete cur[col];
      return { ...prev, [tabKey]: cur };
    });

  // One ruled, centred table for every tab (navy header like the Scan History page). It always fits the width of the main table (no sideways
  // scroll): columns share the width by what their header and content need, long headers wrap with the funnel beside the last word, the header
  // stays put and the rows scroll under it inside a fixed-height box. Plant and the long text columns are left aligned, the rest centred.
  const LEFT = new Set(["Plant", "CSV", "Reason", "Correction"]);
  const MIN: Record<string, number> = { Plant: 104, Date: 96, Correction: 260, By: 100, Arrived: 170, Scanned: 170, When: 170, CSV: 210, "Order date": 100, Vehicle: 100, "Order no.": 100, "Scanned by": 110, Reason: 200, "Stock change": 96, Type: 150 };
  const minWidth = (h: string) => MIN[h] ?? Math.max(66, Math.max(...h.split(" ").map((w) => w.length)) * 8 + 40);
  const renderTable = ({ tabKey, head, rows, raw, empty, busy, classes, totalLabel }: {
    tabKey: string; head: string[]; rows: (string | number | JSX.Element)[][]; raw?: (string | number)[][]; empty: string; busy: boolean; classes?: string[]; totalLabel?: string;
  }) => {
    if (busy) return <Loader2 className="mx-auto my-3 h-5 w-5 animate-spin" />;
    const values = raw ?? rows.map((r) => r.map((c) => (typeof c === "string" || typeof c === "number" ? c : "")));
    const conds = innerFilters[tabKey] ?? {};
    const colDefs: FilterableColumn<{ i: number }>[] = head.map((h, ci) => {
      const col = values.map((r) => r[ci]);
      const numeric = col.length > 0 && col.every((v) => typeof v === "number");
      const distinct = Array.from(new Set(col.filter((v) => v !== "" && v != null))).slice(0, 300);
      distinct.sort((x, y) => (numeric ? Number(x) - Number(y) : String(x).localeCompare(String(y))));
      return { id: h, label: h, filterType: numeric ? "number" : "text", options: distinct.map((v) => ({ value: String(v), label: String(v) })), accessor: (r: { i: number }) => values[r.i]?.[ci] as any };
    });
    const condList = Object.values(conds);
    const keep = rows.map((_, i) => i).filter((i) => !condList.length || matchAllConditions({ i }, condList, colDefs));
    const mins = head.map(minWidth);
    const minTotal = mins.reduce((x, y) => x + y, 0);
    // The Total row (Plants tab) adds up the rows that are left after filtering.
    const totals = totalLabel
      ? head.map((_, ci) => (ci === 0 ? totalLabel : (() => { const nums = keep.map((i) => values[i][ci]); return nums.every((v) => typeof v === "number") ? (head[ci] === "Adjust" ? signed(nums.reduce((x, y) => x + (y as number), 0)) : num(nums.reduce((x, y) => x + (y as number), 0))) : ""; })()))
      : null;
    return (
      <div className="max-h-[360px] w-full overflow-y-auto overflow-x-hidden rounded-md border border-gray-300 bg-white">
        <table className="w-full border-collapse text-[13px]" style={{ tableLayout: "fixed" }}>
          <colgroup>{mins.map((w, i) => <col key={i} style={{ width: `${(w / minTotal) * 100}%` }} />)}</colgroup>
          <thead>
            <tr>
              {head.map((h, ci) => (
                <th key={h} className="sticky top-0 z-10 border border-[#1a3a9c] bg-[#001d6e] px-1.5 py-2 text-center text-[11px] font-semibold uppercase leading-tight tracking-wide text-white">
                  {h.replace("P & O", "P & O")}{" "}
                  <span className="inline-block align-middle"><ColumnHeaderFilterButton column={colDefs[ci]} condition={conds[h]} onChange={(c) => setInnerCond(tabKey, h, c)} onRemove={() => setInnerCond(tabKey, h, null)} /></span>
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {keep.map((i, n) => (
              <tr key={i} className={classes?.[i] || (n % 2 ? "bg-gray-50/70" : "bg-white")}>
                {rows[i].map((c, j) => <td key={j} className={`whitespace-normal break-words border border-gray-200 px-2 py-1.5 align-middle ${LEFT.has(head[j]) ? "text-left" : "text-center tabular-nums"}`}>{c}</td>)}
              </tr>
            ))}
            {totals && keep.length > 0 && (
              <tr className="bg-gray-100 font-semibold">{totals.map((c, j) => <td key={j} className={`border border-gray-300 px-2 py-1.5 ${j === 0 ? "text-left" : "text-center tabular-nums"}`}>{c}</td>)}</tr>
            )}
            {!keep.length && <tr><td colSpan={head.length} className="border border-gray-200 py-3 text-center text-gray-400">{condList.length ? "No rows match the filters." : empty}</td></tr>}
          </tbody>
        </table>
      </div>
    );
  };

  // The Type column, worded and coloured exactly as on the Scan History page (Scan / Unload / Load / Stock + Regular / Extra / Adjust).
  const TypeCell = ({ flags, note }: { flags: { sourceKind: string; isExtra?: boolean; isAdjust?: boolean; isExchange?: boolean }; note?: string | null }) => {
    const tl = scanTypeLabel(flags);
    return (
      <span className="inline-flex flex-col items-center gap-0.5">
        <Badge className={`${tl.className} whitespace-nowrap border-0 px-1.5 text-[11px]`}>{tl.label}</Badge>
        {note ? <span className="text-[10px] leading-tight text-gray-500">{note}</span> : null}
      </span>
    );
  };
  // Row tint by type, as on the Scan History page: Extra amber, Adjust slate, Exchange purple, Voided greyed out.
  const tintOf = (f: { voided?: boolean; isAdjust?: boolean; isExtra?: boolean; isExchange?: boolean }) =>
    f.isExchange ? "bg-purple-50/70" : f.voided ? "bg-gray-100 opacity-60" : f.isAdjust ? "bg-slate-100/70" : f.isExtra ? "bg-amber-50/80" : "";
  const fromHist = (tabKey: string, q: ReturnType<typeof hist>, head: string[], map: (m: any) => (string | number | JSX.Element)[], rawOf: (m: any) => (string | number)[], empty: string, tint?: (m: any) => string) => {
    const items = q.data?.items ?? [];
    const t = withPlant(head, items.map(map), items.map((m: any) => m.plant), tint ? items.map(tint) : undefined, items.map(rawOf));
    return renderTable({ tabKey, busy: q.isLoading, empty, head: t.head, rows: t.rows, raw: t.raw, classes: t.classes });
  };
  const adjustFlags = (a: any): { sourceKind: string; isAdjust?: boolean; isExchange?: boolean } => {
    const exchange = a.kind === "correction" && /exchange/i.test(String(a.reason ?? ""));
    return a.kind === "loading" ? { sourceKind: "loading", isAdjust: true } : a.kind === "scan" ? { sourceKind: "scan", isAdjust: true } : exchange ? { sourceKind: "stock", isExchange: true } : { sourceKind: "stock", isAdjust: true };
  };
  const voidNote = (u: any) => (u.voided ? `Voided${u.voidReason ? ` — ${u.voidReason}` : ""}` : null);

  return (
    <div ref={panelRef} className="sticky left-0 box-border bg-gray-50 p-3" style={{ width: panelW ?? undefined, maxWidth: "100%" }}>
      <div className="mb-2 flex flex-wrap items-center gap-x-2 gap-y-0.5 text-[#001d6e]">
        <History className="h-4 w-4 shrink-0" />
        <span className="text-sm font-semibold">{row.itemName}</span>
        <span className="font-mono text-xs text-gray-400">
          {row.barcode} · {plants.join(", ")}{row.sapCode ? ` · SAP ${row.sapCode}` : ""} · Stock {num(row.stock)}
        </span>
      </div>
      <div className="mb-2 flex flex-wrap items-center gap-1.5">
        {([...(multi ? [["plants", "Plants"]] : []), ...(dateSelected ? [] : [["days", "Days"]]), ["scanning", "Scan Order"], ["unloading", "Unloading"], ["loading", "Loading"], ["adjust", "Adjust"]] as [typeof tab, string][]).map(([k, l]) => (
          <button key={k} type="button" onClick={() => setTab(k)} className={tabCls(tab === k)}>{l}</button>
        ))}
      </div>
      {tab === "plants" && (() => {
        // The same columns as the table above, one row per plant, with a Total row (of the rows left after filtering).
        const cell = (n: number, tone?: string) => figure(n, 0, tone);
        const ex = (n: number) => (n ? <span className="tabular-nums text-amber-600">{num(n)}</span> : "—");
        const head = ["Plant", "Opening", "Expected Purchase", "Purchase", "Extra Purchase", "Adjust", "Transfer In", "Transfer Out", "Total P & O", "Expected Sale", "Sale", "Extra Sale", "Closing", "Stock"];
        const rowsOf = parts.map((p) => [
          <span key={p.plant} className="font-medium text-gray-800">{p.plant}</span>,
          cell(p.openingStock), cell(p.expectedPurchase, "text-purple-700"), cell(p.purchaseQty), ex(p.extraPurchaseQty),
          p.adjustQty ? signed(p.adjustQty) : "—", cell(p.transferIn), cell(p.transferOut),
          <span key="po" className="font-semibold tabular-nums">{num(totalPO(p))}</span>,
          cell(p.expectedSale, "text-purple-700"), cell(p.saleQty, "text-emerald-700"), ex(p.extraSaleQty),
          <span key="cl" className={`font-semibold tabular-nums ${p.closingStock < 0 ? "text-amber-600" : ""}`}>{num(p.closingStock)}</span>,
          <span key="st" className="font-semibold tabular-nums text-[#001d6e]">{num(p.stock)}</span>,
        ]);
        const raws = parts.map((p) => [p.plant, p.openingStock, p.expectedPurchase, p.purchaseQty, p.extraPurchaseQty, p.adjustQty, p.transferIn, p.transferOut, totalPO(p), p.expectedSale, p.saleQty, p.extraSaleQty, p.closingStock, p.stock]);
        return renderTable({ tabKey: "plants", busy: false, empty: "", head, rows: rowsOf, raw: raws, totalLabel: multi ? "Total" : undefined });
      })()}
      {tab === "days" && (() => {
        const dd = days.data?.days ?? [];
        const t = withPlant(["Date", "Purchase", "Extra Purchase", "Sale", "Extra Sale", "Transfer In", "Transfer Out"],
          dd.map((d) => [d.date, figure(d.purchaseQty), d.extraPurchaseQty ? num(d.extraPurchaseQty) : "—", figure(d.saleQty, 0, "text-emerald-700"), d.extraSaleQty ? num(d.extraSaleQty) : "—", figure(d.transferIn), figure(d.transferOut)]),
          dd.map((d) => d.plant), undefined, dd.map((d) => [d.date, d.purchaseQty, d.extraPurchaseQty, d.saleQty, d.extraSaleQty, d.transferIn, d.transferOut]));
        const ll = days.data?.ledger ?? [];
        const t2 = withPlant(["Date", "Correction", "Qty", "By"], ll.map((l) => [l.date, `${l.kind}${l.reason ? ` — ${l.reason}` : ""}`, signed(l.qty), l.by ?? "—"]), ll.map((l) => l.plant),
          undefined, ll.map((l) => [l.date, `${l.kind}${l.reason ? ` — ${l.reason}` : ""}`, l.qty, l.by ?? "—"]));
        return (
          <div className="space-y-3">
            {renderTable({ tabKey: "days", busy: days.isLoading, empty: "No purchase or sale yet.", head: t.head, rows: t.rows, raw: t.raw })}
            {!!ll.length && renderTable({ tabKey: "corrections", busy: false, empty: "", head: t2.head, rows: t2.rows, raw: t2.raw })}
          </div>
        );
      })()}
      {tab === "scanning" && fromHist("scanning", scanning, ["Arrived", "CSV", "Order date", "Qty", "Extra", "Type"],
        (m: any) => [fmtAt(m.arrivedAt), `${m.orderName ?? "—"}${m.partIndex ? ` (part ${m.partIndex})` : ""}`, m.orderDate ? String(m.orderDate).slice(0, 10) : "—", signed(m.qty), m.extraQty ? num(m.extraQty) : "—",
          <TypeCell key="ty" flags={{ sourceKind: "scan", isExtra: m.extraQty > 0 }} />],
        (m: any) => [fmtAt(m.arrivedAt), `${m.orderName ?? "—"}${m.partIndex ? ` (part ${m.partIndex})` : ""}`, m.orderDate ? String(m.orderDate).slice(0, 10) : "—", Number(m.qty), Number(m.extraQty ?? 0), scanTypeLabel({ sourceKind: "scan", isExtra: m.extraQty > 0 }).label],
        "No scan-order entries.", (m: any) => tintOf({ isExtra: m.extraQty > 0 }))}
      {tab === "unloading" && fromHist("unloading", unloading, ["Scanned", "Vehicle", "Order date", "Scanned by", "Qty", "Type"],
        (u: any) => [fmtAt(u.scannedAt), u.vehicleNumber ?? "—", u.orderDate ? String(u.orderDate).slice(0, 10) : "—", u.scannedByName ?? "—", num(u.qty),
          <TypeCell key="ty" flags={{ sourceKind: "unloading", isExtra: !!u.isExtra, isAdjust: !!u.isAdjust }} note={voidNote(u)} />],
        (u: any) => [fmtAt(u.scannedAt), u.vehicleNumber ?? "—", u.orderDate ? String(u.orderDate).slice(0, 10) : "—", u.scannedByName ?? "—", Number(u.qty), scanTypeLabel({ sourceKind: "unloading", isExtra: !!u.isExtra, isAdjust: !!u.isAdjust }).label],
        "No unloading entries.", (u: any) => tintOf({ voided: u.voided, isAdjust: u.isAdjust, isExtra: u.isExtra }))}
      {tab === "loading" && fromHist("loading", loading, ["Scanned", "Order no.", "Order date", "Scanned by", "Qty", "Type"],
        (l: any) => [fmtAt(l.scannedAt), l.orderNumber ?? "—", l.orderDate ? String(l.orderDate).slice(0, 10) : "—", l.scannedByName ?? "—", signed(l.qty),
          <TypeCell key="ty" flags={{ sourceKind: "loading", isExtra: !!l.isExtra, isAdjust: !!l.isAdjust }} note={voidNote(l)} />],
        (l: any) => [fmtAt(l.scannedAt), l.orderNumber ?? "—", l.orderDate ? String(l.orderDate).slice(0, 10) : "—", l.scannedByName ?? "—", Number(l.qty), scanTypeLabel({ sourceKind: "loading", isExtra: !!l.isExtra, isAdjust: !!l.isAdjust }).label],
        "No loading entries.", (l: any) => tintOf({ voided: l.voided, isAdjust: l.isAdjust, isExtra: l.isExtra }))}
      {tab === "adjust" && fromHist("adjust", adjust, ["When", "By", "Reason", "Stock change", "Type"],
        (a: any) => [fmtAt(a.at), a.byName ?? "—", a.reason ?? "—", signed(a.stockQty), <TypeCell key="ty" flags={adjustFlags(a)} note={voidNote(a)} />],
        (a: any) => [fmtAt(a.at), a.byName ?? "—", a.reason ?? "—", Number(a.stockQty), scanTypeLabel(adjustFlags(a)).label],
        "No adjustments.", (a: any) => tintOf({ voided: a.voided, isAdjust: !adjustFlags(a).isExchange, isExchange: !!adjustFlags(a).isExchange }))}
    </div>
  );
}

// The Adjustments list behind one Adjust figure: every correction (manual Adjust, Opening, Clear Stock, Exchange, void credit) in the period, newest
// first. An admin can delete one. Deleting only edits the ledger: Stock is not changed (the same rule as the Stock Overview).
type AdjustEntry = { id: number; date: string; kind: string; qty: number; reason: string | null; origin: string | null; source: string | null; byName: string | null; by: string | null; at: string; plant: string };
function AdjustDialog({ row, from, to, isAdmin, onClose }: { row: Row; from: string; to: string; isAdmin: boolean; onClose: () => void }) {
  const { toast } = useToast();
  const parts = row.parts && row.parts.length ? row.parts : [row];
  const ids = parts.map((p) => p.id).filter((x): x is number => x != null);
  const [target, setTarget] = useState<AdjustEntry | null>(null);
  const list = useQuery<AdjustEntry[]>({
    queryKey: ["/api/stock-v2/line-adjust", ids.join(","), from, to],
    queryFn: async () => {
      const per = await Promise.all(parts.filter((p) => p.id != null).map((p) =>
        apiRequest("GET", `/api/stock-v2/line/${p.id}/days`, undefined, false, true).then((d: { ledger: Omit<AdjustEntry, "plant">[] }) => d.ledger.map((l) => ({ ...l, plant: p.plant })))));
      return per.flat()
        .filter((l) => (!from || l.date >= from) && (!to || l.date <= to))
        .sort((a, b) => +new Date(b.at) - +new Date(a.at));
    },
    enabled: ids.length > 0,
  });
  const del = useMutation({
    mutationFn: (id: number) => apiRequest("DELETE", `/api/stock-v2/ledger/${id}`, undefined, false, true),
    onSuccess: () => {
      toast({ title: "Entry deleted", description: "That entry was removed from the book. Stock was not changed." });
      queryClient.invalidateQueries({ predicate: (q) => String(q.queryKey[0] ?? "").startsWith("/api/stock-v2") });
      setTarget(null);
    },
    onError: (e: any) => toast({ title: "Could not delete", description: e?.message, variant: "destructive" }),
  });
  const kindLabel = (l: AdjustEntry) => (l.kind === "opening" ? "Opening" : l.kind === "clear" ? "Settings" : l.kind === "exchange" ? "Exchange" : l.kind === "void" ? "Void" : l.origin === "page" ? "Stock page" : "Operation");
  const entries = list.data ?? [];
  return (
    <>
      <Dialog open onOpenChange={(o) => { if (!o) onClose(); }}>
        <DialogContent className="max-w-3xl">
          <DialogHeader>
            <DialogTitle>Adjustments</DialogTitle>
            <DialogDescription>
              <span className="font-semibold text-gray-800">{row.itemName}</span>
              <span className="ml-2 font-mono text-xs text-gray-400">{row.barcode} · {parts.map((p) => p.plant).join(", ")}</span>
            </DialogDescription>
          </DialogHeader>
          <div className="max-h-[420px] overflow-y-auto rounded-md border border-gray-300">
            <table className="w-full border-collapse text-[13px]">
              <thead>
                <tr>
                  {["Date & Time", "Plant", "By", "Qty", "From", "Reason", ...(isAdmin ? [""] : [])].map((h, i) => (
                    <th key={i} className="sticky top-0 z-10 border border-[#1a3a9c] bg-[#001d6e] px-2 py-2 text-center text-[11px] font-semibold uppercase tracking-wide text-white">{h}</th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {list.isLoading && <tr><td colSpan={7} className="py-4 text-center text-gray-400"><Loader2 className="mx-auto h-4 w-4 animate-spin" /></td></tr>}
                {!list.isLoading && entries.length === 0 && <tr><td colSpan={7} className="py-4 text-center text-gray-400">No adjustments in this period.</td></tr>}
                {entries.map((l, i) => (
                  <tr key={l.id} className={i % 2 ? "bg-gray-50/70" : "bg-white"}>
                    <td className="whitespace-nowrap border border-gray-200 px-2 py-1.5 text-center">{fmtAt(l.at)}</td>
                    <td className="border border-gray-200 px-2 py-1.5 text-center">{l.plant}</td>
                    <td className="border border-gray-200 px-2 py-1.5 text-center">{l.byName ?? l.by ?? "—"}</td>
                    <td className={`border border-gray-200 px-2 py-1.5 text-center font-semibold tabular-nums ${l.qty < 0 ? "text-red-600" : "text-emerald-600"}`}>{signed(l.qty)}</td>
                    <td className="border border-gray-200 px-2 py-1.5 text-center"><span className="whitespace-nowrap rounded bg-[#001d6e]/10 px-1.5 py-0.5 text-[11px] font-medium text-[#001d6e]">{kindLabel(l)}</span></td>
                    <td className="border border-gray-200 px-2 py-1.5 text-left text-gray-600">{l.reason ?? "—"}</td>
                    {isAdmin && (
                      <td className="border border-gray-200 px-1 py-1 text-center">
                        <Button size="sm" variant="ghost" className="h-7 w-7 p-0 text-gray-400 hover:text-red-600" title="Delete this entry — Stock is not changed" onClick={() => setTarget(l)}>
                          <Trash2 className="h-4 w-4" />
                        </Button>
                      </td>
                    )}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <DialogFooter><Button variant="outline" onClick={onClose}>Close</Button></DialogFooter>
        </DialogContent>
      </Dialog>
      <Dialog open={!!target} onOpenChange={(o) => { if (!o) setTarget(null); }}>
        <DialogContent className="max-w-md">
          <DialogHeader>
            <DialogTitle>Delete this entry?</DialogTitle>
            <DialogDescription>
              {target && (
                <>
                  <span className={`font-semibold ${target.qty < 0 ? "text-red-600" : "text-emerald-600"}`}>{signed(target.qty)}</span>{" "}· {target.reason ?? "no reason recorded"} · {target.plant}
                  <br />
                  This removes it from the book only: it will no longer count toward Opening / Adjust / Total P & O. It does not change this item's Stock.
                </>
              )}
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button variant="outline" onClick={() => setTarget(null)} disabled={del.isPending}>Cancel</Button>
            <Button className="bg-red-600 text-white hover:bg-red-700" disabled={del.isPending} onClick={() => target && del.mutate(target.id)}>
              {del.isPending ? <Loader2 className="mr-1.5 h-3.5 w-3.5 animate-spin" /> : null} Delete
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}
