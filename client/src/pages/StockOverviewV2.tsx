import { useMemo, useState } from "react";
import { useQuery, useMutation } from "@tanstack/react-query";
import { format } from "date-fns";
import { X } from "lucide-react";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { LayoutList, CalendarDays, Boxes, TrendingUp, History, ShoppingCart, ArrowLeftRight, RotateCw, Loader2, Scale } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle,
} from "@/components/ui/dialog";
import { useToast } from "@/hooks/use-toast";
import PageHeader from "@/components/PageHeader";
import { PlantBadge } from "@/components/PlantBadge";
import { apiRequest, queryClient } from "@/lib/queryClient";
import { useAuth } from "@/hooks/use-auth";
import { DataTable, type DataTableColumn } from "@/components/ui/data-table";
import { StatsBar } from "@/components/ui/stats-bar";
import { TableCard } from "@/components/ui/table-card";
import { CollapsibleSearch } from "@/components/ui/collapsible-search";

// Stock (New) — the plant-wise stock lines (server/lib/stockV2.ts). One row = one item at one plant; Stock is
// the single total Loading draws from, Purchase and Sale are the day-wise figures with their Extra inside,
// Opening and Closing are added up for the period you pick. Looks like the Stock Overview on purpose: this
// page runs beside it until the new one is proven, then the old one goes.

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

export default function StockOverviewV2() {
  const { user } = useAuth();
  const { toast } = useToast();
  const isAdmin = !!user && ((user as any).role === "admin" || (user as any).role === "super_admin" || (user as any).isAdmin === true);
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
  const rowIdOf = (r: Row) => (r.parts ? `m:${r.barcode}|${r.itemName}` : String(r.id ?? `${r.plant}-${r.barcode}`));
  const [compareOpen, setCompareOpen] = useState(false);
  const [openingOpen, setOpeningOpen] = useState(false);

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
  const rows = useMemo(() => {
    const t = search.trim().toLowerCase();
    let list = data?.items ?? [];
    if (t) list = list.filter((r) => [r.itemName, r.barcode, r.sapCode, r.srNo, r.category, r.brand].some((v) => String(v ?? "").toLowerCase().includes(t)));
    if (!merged) return list;
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
    });
  }, [data, search, merged]);

  const sum = (f: (r: Row) => number) => rows.reduce((s, r) => s + f(r), 0);
  const tOpen = sum((r) => r.openingStock);
  const tPurchase = sum((r) => r.purchaseQty);
  const tExtraP = sum((r) => r.extraPurchaseQty);
  const tSale = sum((r) => r.saleQty);
  const tClose = sum((r) => r.closingStock);
  const tExpP = sum((r) => r.expectedPurchase);
  const tExpS = sum((r) => r.expectedSale);
  const tStock = sum((r) => r.stock);
  const period = from || to ? `${from || "start"} → ${to || "today"}` : "All dates";

  const columns: DataTableColumn<Row>[] = [
    {
      id: "srNo", header: "Sr No", hideable: false, width: 44, fixedWidth: true, sortable: true, totalable: false,
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
    { id: "barcode", header: "Barcode / SKU", width: 140, fixedWidth: true, sortable: true, totalable: false, accessor: (r) => r.barcode, cellClassName: "font-mono text-gray-600", render: (r) => r.barcode },
    {
      id: "sapCode", header: "SAP Code", width: 110, sortable: true, totalable: false, accessor: (r) => r.sapCode, cellClassName: "font-mono text-gray-600",
      render: (r) => (r.sapCode ? <span title={r.sapIsFallback ? "No SAP for this state — the general code is used" : undefined}>{r.sapCode}{r.sapIsFallback ? "*" : ""}</span> : dash),
    },
    { id: "category", header: "Category", width: 130, sortable: true, totalable: false, accessor: (r) => r.category, cellClassName: "text-gray-700", render: (r) => r.category ?? dash },
    { id: "brand", header: "Brand", width: 110, sortable: true, totalable: false, accessor: (r) => r.brand, cellClassName: "text-gray-700", render: (r) => r.brand ?? dash },
    ...(merged ? [] : [{ id: "plant", header: "Plant", hideable: false, width: 100, sortable: true, totalable: false, accessor: (r) => r.plant, render: (r) => <PlantBadge plant={r.plant} /> } as DataTableColumn<Row>]),
    { id: "stock", header: "Stock", width: 90, align: "right", sortable: true, accessor: (r) => r.stock, total: (rs) => num(rs.reduce((s, r) => s + r.stock, 0)), cellClassName: "font-semibold text-[#001d6e]", render: (r) => <span className="tabular-nums">{num(r.stock)}</span> },
    { id: "expectedPurchase", header: "Expected Purchase", width: 110, align: "right", sortable: true, accessor: (r) => r.expectedPurchase, total: (rs) => num(rs.reduce((s, r) => s + r.expectedPurchase, 0)), render: (r) => figure(r.expectedPurchase, 0, "text-purple-700") },
    { id: "opening", header: "Opening", width: 90, align: "right", sortable: true, accessor: (r) => r.openingStock, total: (rs) => num(rs.reduce((s, r) => s + r.openingStock, 0)), render: (r) => figure(r.openingStock) },
    { id: "purchase", header: "Purchase", width: 130, align: "right", sortable: true, accessor: (r) => r.purchaseQty, total: (rs) => num(rs.reduce((s, r) => s + r.purchaseQty, 0)), render: (r) => figure(r.purchaseQty, r.extraPurchaseQty) },
    { id: "adjust", header: "Adjust", width: 80, align: "right", sortable: true, accessor: (r) => r.adjustQty, total: (rs) => signed(rs.reduce((s, r) => s + r.adjustQty, 0)), render: (r) => (r.adjustQty ? <span className="tabular-nums">{signed(r.adjustQty)}</span> : dash) },
    { id: "transferIn", header: "Transfer In", width: 90, align: "right", sortable: true, accessor: (r) => r.transferIn, total: (rs) => num(rs.reduce((s, r) => s + r.transferIn, 0)), render: (r) => figure(r.transferIn) },
    { id: "transferOut", header: "Transfer Out", width: 95, align: "right", sortable: true, accessor: (r) => r.transferOut, total: (rs) => num(rs.reduce((s, r) => s + r.transferOut, 0)), render: (r) => figure(r.transferOut) },
    { id: "expectedSale", header: "Expected Sale", width: 105, align: "right", sortable: true, accessor: (r) => r.expectedSale, total: (rs) => num(rs.reduce((s, r) => s + r.expectedSale, 0)), render: (r) => figure(r.expectedSale, 0, "text-purple-700") },
    { id: "sale", header: "Sale", width: 130, align: "right", sortable: true, accessor: (r) => r.saleQty, total: (rs) => num(rs.reduce((s, r) => s + r.saleQty, 0)), render: (r) => figure(r.saleQty, r.extraSaleQty, "text-emerald-700") },
    {
      id: "closing", header: "Closing", width: 90, align: "right", sortable: true, accessor: (r) => r.closingStock,
      total: (rs) => num(rs.reduce((s, r) => s + r.closingStock, 0)),
      cellClassName: "font-semibold", render: (r) => <span className={`tabular-nums ${r.closingStock < 0 ? "text-amber-600" : ""}`}>{num(r.closingStock)}</span>,
    },
  ];

  const rebuild = useMutation({
    mutationFn: () => apiRequest("POST", "/api/stock-v2/rebuild", undefined, false, true),
    onSuccess: (r: any) => {
      toast({ title: "Stock (New) rebuilt", description: `${r.lines} lines, ${r.movements} movements${r.skipped?.length ? `, ${r.skipped.length} skipped (not in Product Master)` : ""}.` });
      queryClient.invalidateQueries({ predicate: (q) => String(q.queryKey[0] ?? "").startsWith("/api/stock-v2") });
    },
    onError: (e: any) => toast({ title: "Rebuild failed", description: e?.message, variant: "destructive" }),
  });

  return (
    <div className="space-y-3 p-4 lg:p-6">
      <PageHeader
        icon={LayoutList}
        title="Stock (New)"
        description="Plant-wise stock lines — one Stock figure per item for Loading, with Purchase and Sale day by day. Opening and Closing are worked out for the dates you pick."
      />

      <StatsBar
        className="rounded-xl shadow-none border-gray-300 [&_.divide-x]:divide-gray-300"
        wrapLabels
        singleRow
        stats={[
          { icon: CalendarDays, tone: "navy" as const, value: num(tExpP), label: "Expected Purchase", hint: period },
          { icon: Scale, tone: "navy" as const, value: num(tStock), label: "Stock", hint: "Total on hand now" },
          { icon: History, tone: "navy" as const, value: num(tOpen), label: "Opening", hint: `Start of period` },
          { icon: Boxes, tone: "navy" as const, value: num(tPurchase), label: "Purchase", hint: tExtraP ? `${period} · incl. ${num(tExtraP)} extra` : period },
          { icon: ShoppingCart, tone: "navy" as const, value: num(tExpS), label: "Expected Sale", hint: period },
          { icon: ShoppingCart, tone: "emerald" as const, value: num(tSale), label: "Sale (loaded)", hint: period },
          { icon: TrendingUp, tone: tClose < 0 ? ("amber" as const) : ("navy" as const), value: num(tClose), label: "Closing", hint: "End of period" },
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
            {isAdmin && (
              <>
                <Button variant="outline" size="sm" className="h-8 text-xs" onClick={() => setCompareOpen(true)}>
                  <ArrowLeftRight className="mr-1 h-3.5 w-3.5" /> Compare with old
                </Button>
                <Button variant="outline" size="sm" className="h-8 text-xs" onClick={() => setOpeningOpen(true)}>
                  Opening stock
                </Button>
                <Button variant="outline" size="sm" className="h-8 text-xs" disabled={rebuild.isPending}
                  onClick={() => { if (window.confirm("Rebuild Stock (New) from the old stock? Everything on this page is recalculated from the old Stock Overview.")) rebuild.mutate(); }}>
                  {rebuild.isPending ? <Loader2 className="mr-1 h-3.5 w-3.5 animate-spin" /> : null} Rebuild
                </Button>
              </>
            )}
          </>
        }
      >
        <DataTable<Row>
          containerClassName="rounded-none border-0"
          columns={columns}
          data={isLoading ? [] : rows}
          getRowId={rowIdOf}
          renderExpandedRow={() => (detail ? <EntriesPanel row={detail} /> : null)}
          isRowExpandable={() => true}
          expandedRowId={detail ? rowIdOf(detail) : null}
          emptyState="No stock lines yet. Click Rebuild to bring the current stock across."
          noResultsState="No stock rows match your search."
          hasActiveFilters={!!search}
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

      {compareOpen && <CompareDialog onClose={() => setCompareOpen(false)} />}
      {openingOpen && <OpeningDialog onClose={() => setOpeningOpen(false)} />}
    </div>
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
const fmtAt = (v: string | null | undefined) => { const d = v ? new Date(v) : null; return d && !isNaN(d.getTime()) ? format(d, "dd MMM yyyy, hh:mm a") : "—"; };
const tabCls = (on: boolean) => `rounded-full px-3 py-1 text-xs font-medium ${on ? "bg-[#001d6e] text-white" : "border border-gray-200 bg-white text-gray-600 hover:bg-gray-50"}`;

function EntriesPanel({ row }: { row: Row }) {
  const parts = row.parts && row.parts.length ? row.parts : [row];
  const multi = parts.length > 1;
  const plants = parts.map((p) => p.plant);
  const plantsKey = plants.join(",");
  const [tab, setTab] = useState<"plants" | "days" | "scanning" | "unloading" | "loading" | "adjust">(multi ? "plants" : "days");
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

  const withPlant = (head: string[], rows: (string | number | JSX.Element)[][], plantOf: string[]) =>
    multi ? { head: ["Plant", ...head], rows: rows.map((r, i) => [plantOf[i], ...r]) } : { head, rows };
  const Table = ({ head, rows, empty, busy }: { head: string[]; rows: (string | number | JSX.Element)[][]; empty: string; busy: boolean }) => (
    busy ? <Loader2 className="mx-auto my-3 h-5 w-5 animate-spin" /> : (
      <table className="w-full text-left text-xs">
        <thead><tr className="border-b text-[11px] uppercase text-gray-400">{head.map((h) => <th key={h} className="py-1 pr-3">{h}</th>)}</tr></thead>
        <tbody>
          {rows.map((r, i) => <tr key={i} className="border-b border-gray-100">{r.map((c, j) => <td key={j} className="py-1 pr-3 align-top">{c}</td>)}</tr>)}
          {!rows.length && <tr><td colSpan={head.length} className="py-3 text-center text-gray-400">{empty}</td></tr>}
        </tbody>
      </table>
    )
  );
  const typeLabel = (t: string, q: number) => (t === "receive" ? "Received" : t === "dispatch" ? "Dispatched" : t === "exchange" ? "Exchange" : q < 0 ? "Adjust (−)" : "Adjust (+)");
  const fromHist = (q: ReturnType<typeof hist>, head: string[], map: (m: any) => (string | number | JSX.Element)[], empty: string) => {
    const items = q.data?.items ?? [];
    const t = withPlant(head, items.map(map), items.map((m: any) => m.plant));
    return <Table busy={q.isLoading} empty={empty} head={t.head} rows={t.rows} />;
  };

  return (
    <div className="sticky left-0 w-full max-w-[95vw] bg-gray-50 p-3">
      <div className="mb-2 flex flex-wrap items-center gap-x-2 gap-y-0.5 text-[#001d6e]">
        <History className="h-4 w-4 shrink-0" />
        <span className="text-sm font-semibold">{row.itemName}</span>
        <span className="font-mono text-xs text-gray-400">
          {row.barcode} · {multi ? `${row.plant} (${plants.join(", ")})` : row.plant}{row.sapCode ? ` · SAP ${row.sapCode}` : ""} · Stock {num(row.stock)}
        </span>
      </div>
      <div className="mb-2 flex flex-wrap items-center gap-1.5">
        {([...(multi ? [["plants", "Plants"]] : []), ["days", "Days"], ["scanning", "Scan Order"], ["unloading", "Unloading"], ["loading", "Loading"], ["adjust", "Adjust"]] as [typeof tab, string][]).map(([k, l]) => (
          <button key={k} type="button" onClick={() => setTab(k)} className={tabCls(tab === k)}>{l}</button>
        ))}
      </div>
      {tab === "plants" && (
        <Table busy={false} empty="" head={["Plant", "Stock", "Opening", "Purchase", "Adjust", "Transfer In", "Transfer Out", "Sale", "Closing"]}
          rows={parts.map((p) => [<PlantBadge key={p.plant} plant={p.plant} />, num(p.stock), num(p.openingStock), figure(p.purchaseQty, p.extraPurchaseQty), p.adjustQty ? signed(p.adjustQty) : "—", figure(p.transferIn), figure(p.transferOut), figure(p.saleQty, p.extraSaleQty, "text-emerald-700"), num(p.closingStock)])} />
      )}
      {tab === "days" && (() => {
        const dd = days.data?.days ?? [];
        const t = withPlant(["Date", "Purchase", "Sale", "Transfer In", "Transfer Out"], dd.map((d) => [d.date, figure(d.purchaseQty, d.extraPurchaseQty), figure(d.saleQty, d.extraSaleQty, "text-emerald-700"), figure(d.transferIn), figure(d.transferOut)]), dd.map((d) => d.plant));
        const ll = days.data?.ledger ?? [];
        const t2 = withPlant(["Date", "Correction", "Qty", "By"], ll.map((l) => [l.date, `${l.kind}${l.reason ? ` — ${l.reason}` : ""}`, signed(l.qty), l.by ?? "—"]), ll.map((l) => l.plant));
        return (
          <div className="space-y-3">
            <Table busy={days.isLoading} empty="No purchase or sale yet." head={t.head} rows={t.rows} />
            {!!ll.length && <Table busy={false} empty="" head={t2.head} rows={t2.rows} />}
          </div>
        );
      })()}
      {tab === "scanning" && fromHist(scanning, ["Arrived", "CSV", "Order date", "Type", "Qty", "Extra"],
        (m: any) => [fmtAt(m.arrivedAt), `${m.orderName ?? "—"}${m.partIndex ? ` (part ${m.partIndex})` : ""}`, m.orderDate ? String(m.orderDate).slice(0, 10) : "—", typeLabel(m.type, m.qty), signed(m.qty), m.extraQty ? num(m.extraQty) : "—"], "No scan-order entries.")}
      {tab === "unloading" && fromHist(unloading, ["Scanned", "Vehicle", "Order date", "Scanned by", "Qty", "Status"],
        (u: any) => [fmtAt(u.scannedAt), u.vehicleNumber ?? "—", u.orderDate ? String(u.orderDate).slice(0, 10) : "—", u.scannedByName ?? "—", num(u.qty), u.voided ? `Voided${u.voidReason ? ` — ${u.voidReason}` : ""}` : u.isExtra ? "Extra" : "OK"], "No unloading entries.")}
      {tab === "loading" && fromHist(loading, ["Scanned", "Order no.", "Order date", "Scanned by", "Qty", "Status"],
        (l: any) => [fmtAt(l.scannedAt), l.orderNumber ?? "—", l.orderDate ? String(l.orderDate).slice(0, 10) : "—", l.scannedByName ?? "—", signed(l.qty), l.voided ? `Voided${l.voidReason ? ` — ${l.voidReason}` : ""}` : l.isAdjust ? "Adjust" : l.isExtra ? "Extra" : "OK"], "No loading entries.")}
      {tab === "adjust" && fromHist(adjust, ["When", "Kind", "By", "Reason", "Stock change"],
        (a: any) => [fmtAt(a.at), a.kind, a.byName ?? "—", a.reason ?? "—", signed(a.stockQty)], "No adjustments.")}
    </div>
  );
}

function CompareDialog({ onClose }: { onClose: () => void }) {
  const { data, isLoading } = useQuery<{ mismatches: Array<{ plant: string; barcode: string; itemName: string | null; oldQty: number; newQty: number; diff: number }>; lines: number; oldRows: number; lastRebuildAt: string | null; loadingUsesV2: boolean }>({
    queryKey: ["/api/stock-v2/compare"],
    queryFn: () => apiRequest("GET", "/api/stock-v2/compare", undefined, false, true),
  });
  const source = useMutation({
    mutationFn: (useV2: boolean) => apiRequest("POST", "/api/stock-v2/loading-source", { useV2 }, false, true),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ["/api/stock-v2/compare"] }),
  });
  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="max-h-[85vh] max-w-3xl overflow-y-auto">
        <DialogHeader>
          <DialogTitle>Stock (New) vs Stock Overview</DialogTitle>
          <DialogDescription>
            {data ? `${data.lines} new lines · ${data.oldRows} old rows · ${data.mismatches.length === 0 ? "every Stock figure matches" : `${data.mismatches.length} differ`}` : "Comparing…"}
          </DialogDescription>
        </DialogHeader>
        {data && (
          <div className="flex items-center justify-between gap-3 rounded-md border border-gray-200 bg-gray-50 px-3 py-2 text-sm">
            <span>Loading takes its stock from: <b>{data.loadingUsesV2 ? "Stock (New)" : "Stock Overview (old)"}</b></span>
            <Button size="sm" variant="outline" disabled={source.isPending}
              onClick={() => {
                const next = !data.loadingUsesV2;
                if (next && data.mismatches.length > 0 && !window.confirm(`${data.mismatches.length} item(s) still differ. Switch Loading to Stock (New) anyway?`)) return;
                source.mutate(next);
              }}>
              {data.loadingUsesV2 ? "Switch back to old" : "Switch Loading to Stock (New)"}
            </Button>
          </div>
        )}
        {isLoading ? <Loader2 className="mx-auto h-5 w-5 animate-spin" /> : (
          <table className="w-full text-left text-sm">
            <thead><tr className="border-b text-xs uppercase text-gray-400"><th className="py-1">Plant</th><th>Item</th><th className="text-right">Old</th><th className="text-right">New</th><th className="text-right">Diff</th></tr></thead>
            <tbody>
              {(data?.mismatches ?? []).map((m) => (
                <tr key={`${m.plant}-${m.barcode}`} className="border-b border-gray-100">
                  <td className="py-1">{m.plant}</td>
                  <td className="truncate">{m.itemName ?? m.barcode}</td>
                  <td className="text-right tabular-nums">{num(m.oldQty)}</td>
                  <td className="text-right tabular-nums">{num(m.newQty)}</td>
                  <td className="text-right tabular-nums font-medium text-amber-600">{signed(m.diff)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </DialogContent>
    </Dialog>
  );
}

// Opening stock is for a fresh start only: closed by default; Start fresh clears Stock (New) and opens it
// for one date, entries replace (never add to) each line's opening figure, and Lock closes it again.
function OpeningDialog({ onClose }: { onClose: () => void }) {
  const { toast } = useToast();
  const [date, setDate] = useState(new Date().toISOString().slice(0, 10));
  const [text, setText] = useState("");
  const { data, refetch } = useQuery<{ open: boolean; date: string | null }>({
    queryKey: ["/api/stock-v2/opening"],
    queryFn: () => apiRequest("GET", "/api/stock-v2/opening", undefined, false, true),
  });
  const refresh = () => { refetch(); queryClient.invalidateQueries({ predicate: (q) => String(q.queryKey[0] ?? "").startsWith("/api/stock-v2/report") }); };
  const call = async (path: string, body?: unknown) => apiRequest("POST", path, body, false, true);
  const start = useMutation({
    mutationFn: () => call("/api/stock-v2/opening/start", { date }),
    onSuccess: () => { toast({ title: "Fresh start", description: "Stock (New) cleared. Enter the opening stock now." }); refresh(); },
    onError: (e: any) => toast({ title: "Could not start fresh", description: e?.message, variant: "destructive" }),
  });
  const save = useMutation({
    mutationFn: () => {
      const entries = text.split(/\r?\n/).map((l) => l.split(/[\t,;]/).map((x) => x.trim())).filter((p) => p.length >= 3 && p[0])
        .map((p) => ({ plant: p[0], barcode: p[1], qty: p[2] }));
      return call("/api/stock-v2/opening/set", { entries });
    },
    onSuccess: (r: any) => {
      toast({ title: `Opening saved for ${r.set} line(s)`, description: r.failed?.length ? `${r.failed.length} not saved: ${r.failed.slice(0, 3).map((f: any) => f.barcode + " — " + f.reason).join("; ")}` : undefined });
      if (!r.failed?.length) setText("");
      refresh();
    },
    onError: (e: any) => toast({ title: "Could not save", description: e?.message, variant: "destructive" }),
  });
  const lock = useMutation({
    mutationFn: () => call("/api/stock-v2/opening/lock"),
    onSuccess: () => { toast({ title: "Opening stock locked" }); refresh(); },
  });
  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="max-w-xl">
        <DialogHeader>
          <DialogTitle>Opening stock</DialogTitle>
          <DialogDescription>
            Only for a fresh start. It is closed the rest of the time; the Adjust and Clear actions keep working as usual.
          </DialogDescription>
        </DialogHeader>
        {!data?.open ? (
          <div className="space-y-3 text-sm">
            <p className="text-gray-600">Opening stock is <b>closed</b>. Start fresh to clear Stock (New) and enter a new opening — this does not touch the old Stock Overview.</p>
            <div className="flex items-center gap-2">
              <Input type="date" value={date} onChange={(e) => setDate(e.target.value)} className="h-9 w-44" />
              <Button disabled={start.isPending} onClick={() => { if (window.confirm("Start fresh? Every Purchase, Sale and correction in Stock (New) is cleared and all Stock goes to 0.")) start.mutate(); }}>
                Start fresh
              </Button>
            </div>
          </div>
        ) : (
          <div className="space-y-3 text-sm">
            <p className="text-gray-600">Open for <b>{data.date}</b>. One line per row: <code>plant, barcode, quantity</code> (paste from Excel works). Entering an item again replaces its opening.</p>
            <textarea value={text} onChange={(e) => setText(e.target.value)} rows={8} placeholder={"VALSAD, 8906010500023, 120"} className="w-full rounded-md border border-gray-300 p-2 font-mono text-xs" />
            <div className="flex justify-between">
              <Button variant="outline" disabled={lock.isPending} onClick={() => { if (window.confirm("Lock opening stock? It can only be opened again by a new fresh start.")) lock.mutate(); }}>Lock opening</Button>
              <Button disabled={save.isPending || !text.trim()} onClick={() => save.mutate()}>{save.isPending ? "Saving…" : "Save opening"}</Button>
            </div>
          </div>
        )}
      </DialogContent>
    </Dialog>
  );
}
