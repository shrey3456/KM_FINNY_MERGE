import { useEffect, useMemo, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { addDays, format } from "date-fns";
import { CheckCircle2, Clock, FileText, Loader2, Package, PackagePlus, RefreshCw, Search, Users, X } from "lucide-react";
import { useLocation } from "wouter";
import { NotionStatusBadge } from "@/components/NotionStatusBadge";
import { apiRequest } from "@/lib/queryClient";
import { usePersistentFilter } from "@/hooks/usePersistentFilter";
import { DateInput } from "@/components/ui/date-input";
import { Button } from "@/components/ui/button";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { CollapsibleSearch } from "@/components/ui/collapsible-search";
import { StatsBar } from "@/components/ui/stats-bar";
import { DataTable, type DataTableColumn } from "@/components/ui/data-table";
import { ProductPhoto } from "@/components/ProductPhoto";
import { PlantBadge } from "@/components/PlantBadge";
import { SectionSkeleton } from "@/components/ui/loading-skeletons";
import { AddColumnFilterButton, ColumnFilterChipView, ColumnHeaderFilterButton } from "@/components/filters/ColumnFilterChip";
import { type FilterableColumn, type FilterCondition, matchAllConditions } from "@/lib/columnFilters";

// Overall Scan Ops → "Loading": every product the Notion orders (proforma slips) of ONE plant and
// order date need, one row per product, with each party's share underneath. Read-only; shows
// only the selected date. Data: GET /api/loading/date-items.

type Plant = { id: number; name: string; bgColor?: string | null; textColor?: string | null; borderColor?: string | null };

type PartyRow = { partyName: string; orderNumber: string; plant: string; vehicleNumber: string | null; expected: number; loaded: number; extra: number; remaining: number };
type ItemRow = {
  barcode: string; srNo: string | null; itemName: string; itemsPerPallet: number;
  expected: number; loaded: number; extra: number; remaining: number;
  parties: PartyRow[];
};
type OrderHit = { orderNumber: string; partyName: string; plant: string; orderDate: string };
// One proforma slip of the day, with its load progress (GET /api/loading/date-slips).
type DaySlip = {
  id: number; orderNumber: string; partyName: string | null; plant: string | null; vehicleNumber: string | null;
  notionStatus: string | null; loadingCompletedAt: string | null; loadingOwnerName: string | null; loadingPausedAt: string | null;
  loadingStv: string | null; hasLoad: boolean; totalQty: number; loadedQty: number; orderVolume: number | null; loadedVolume: number;
};
type DateItems = { plant: string; date: string; orders: number; parties: number; items: ItemRow[] };

const ALL_PLANTS = "__all__";
const plt = (qty: number, ipp: number) => (ipp > 0 ? qty / ipp : 0);

// "2 plt · 5 loose" under a quantity — blank when the item has no pallet size.
function PalletLine({ qty, ipp }: { qty: number; ipp: number }) {
  if (ipp <= 0 || qty <= 0) return null;
  const pallets = Math.floor(qty / ipp);
  const loose = qty % ipp;
  const parts = [pallets > 0 ? `${pallets} plt` : null, loose > 0 ? `${loose} loose` : null].filter(Boolean);
  return parts.length ? <span className="mt-0.5 block whitespace-nowrap text-[11px] font-semibold leading-tight text-violet-600">{parts.join(" · ")}</span> : null;
}

function ProductThumb({ name, className = "h-11 w-11" }: { name: string; className?: string }) {
  const [failed, setFailed] = useState(false);
  if (failed) return <div className={`${className} shrink-0 rounded border border-gray-200 bg-gray-50`} />;
  return (
    <ProductPhoto
      name={name}
      zoomable
      onLoadState={setFailed}
      className={`${className} shrink-0 rounded border border-gray-200 bg-white object-contain`}
    />
  );
}

// Party-wise breakdown shown when a product is opened.
function PartyBreakdown({ row, showPlant }: { row: ItemRow; showPlant: boolean }) {
  return (
    <div className="border-t border-gray-100 bg-slate-50/70 p-3">
      <p className="mb-2 text-xs font-semibold uppercase tracking-wide text-gray-500">
        Party-wise — {row.itemName}
      </p>
      {row.expected === 0 && row.extra > 0 && (
        <p className="mb-2 rounded-md bg-amber-100 px-2.5 py-1.5 text-base font-semibold text-amber-800">
          Not on any order — loaded as Extra on the order{row.parties.filter((p) => p.extra > 0).length > 1 ? "s" : ""} below.
        </p>
      )}
      <div className="overflow-x-auto rounded-lg border border-gray-200 bg-white">
        <table className="w-full min-w-[520px] text-sm">
          <thead>
            <tr className="bg-gray-50 text-left text-[11px] font-semibold uppercase tracking-wide text-gray-500">
              <th className="px-3 py-2">Order No.</th>
              <th className="px-3 py-2">Party</th>
              <th className="px-3 py-2 text-center">Expected</th>
              <th className="px-3 py-2 text-center">Loaded</th>
              <th className="px-3 py-2 text-center">Remaining</th>
              <th className="px-3 py-2 text-center">Extra</th>
            </tr>
          </thead>
          <tbody>
            {row.parties.map((p, i) => (
              <tr
                key={`${p.orderNumber}-${i}`}
                className={`border-t border-gray-100 ${p.extra > 0 ? "bg-amber-50" : p.expected > 0 && p.loaded >= p.expected ? "bg-emerald-50" : ""}`}
              >
                <td className="px-3 py-2 text-sm font-semibold tabular-nums text-[#001d6e]">#{p.orderNumber}{showPlant && p.plant && <span className="mt-0.5 block"><PlantBadge plant={p.plant} /></span>}</td>
                <td className="px-3 py-2">
                  <span className="block font-medium text-gray-900">{p.partyName || "—"}</span>
                  {p.vehicleNumber && <span className="block text-xs text-gray-400">{p.vehicleNumber}</span>}
                  {p.expected === 0 && p.extra > 0 && <span className="block text-sm font-semibold text-amber-700">Extra — not on this order</span>}
                </td>
                <td className="px-3 py-2 text-center text-[17px] font-bold tabular-nums text-gray-800">{p.expected}<PalletLine qty={p.expected} ipp={row.itemsPerPallet} /></td>
                <td className="px-3 py-2 text-center text-[17px] font-bold tabular-nums text-emerald-700">{p.loaded}<PalletLine qty={p.loaded} ipp={row.itemsPerPallet} /></td>
                <td className="px-3 py-2 text-center text-[17px] font-bold tabular-nums text-[#001d6e]">{p.remaining}<PalletLine qty={p.remaining} ipp={row.itemsPerPallet} /></td>
                <td className="px-3 py-2 text-center text-[17px] tabular-nums">
                  {p.extra > 0 ? <><span className="font-bold text-amber-600">{p.extra}</span><PalletLine qty={p.extra} ipp={row.itemsPerPallet} /></> : null}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}

export function LoadingViewerSection({
  plantOptions, getPlantColorCfg,
}: {
  plantOptions: string[];
  getPlantColorCfg: (plantName: string | null | undefined) => Plant | null;
}) {
  const [plant, setPlant] = usePersistentFilter<string>("scanViewer:loading:plant", "");
  // Always opens on today — not remembered between visits, so it never reopens on an old date.
  const [date, setDate] = useState(() => format(new Date(), "yyyy-MM-dd"));
  const [search, setSearch] = useState("");
  // Order-number search: narrows the whole page to that order — only its items, and every quantity
  // (rows, totals, stats) counted for that order alone, not the whole date.
  const [orderNo, setOrderNo] = useState("");
  const [picked, setPicked] = useState<OrderHit | null>(null);
  const [sugOpen, setSugOpen] = useState(false);
  // Items = every product of the day; Slips = every proforma slip of the day, each opening in Load Operations.
  const [tab, setTab] = useState<"items" | "slips">("items");
  // Slips tab: "" = every slip; "load:<state>" or "notion:<status>" narrows to one status chip.
  const [slipChip, setSlipChip] = useState("");
  const [, navigate] = useLocation();
  const [expanded, setExpanded] = useState<string | null>(null);
  const [conditions, setConditions] = useState<Record<string, FilterCondition>>({});

  // A saved plant this user may no longer see falls back to the first one they can.
  // "All plants" is a choice of its own (and the default), not a plant name.
  const activePlant = plant === ALL_PLANTS || !plant
    ? ALL_PLANTS
    : plantOptions.find((p) => p.toLowerCase() === plant.toLowerCase()) ?? ALL_PLANTS;

  const query = useQuery<DateItems>({
    queryKey: ["/api/loading/date-items", activePlant, date, picked?.orderNumber ?? ""],
    queryFn: async () => {
      // A picked order is read on its own — its own plant and date decide what is shown.
      const url = picked
        ? `/api/loading/date-items?order=${encodeURIComponent(picked.orderNumber)}`
        : `/api/loading/date-items?plant=${encodeURIComponent(activePlant)}&date=${encodeURIComponent(date)}`;
      const res = await apiRequest("GET", url);
      if (!res.ok) throw new Error((await res.json().catch(() => ({})))?.message || "Failed to load");
      return res.json();
    },
    enabled: !!picked || (!!activePlant && !!date),
    refetchInterval: 15_000,
  });
  // Order numbers matching what was typed — the picker below the box. Server-side plant-restricted.
  const suggestQuery = useQuery<OrderHit[]>({
    queryKey: ["/api/loading/order-suggest", orderNo.trim(), activePlant, date],
    queryFn: async () => {
      // Only the chosen plant (or, on "All plants", the plants this user may see) and the chosen date.
      const res = await apiRequest("GET", `/api/loading/order-suggest?q=${encodeURIComponent(orderNo.trim())}&plant=${encodeURIComponent(activePlant)}&date=${encodeURIComponent(date)}`);
      return res.ok ? res.json() : [];
    },
    enabled: !picked && orderNo.trim().replace(/^#/, "").length >= 2,
    staleTime: 15_000,
  });
  const suggestions = suggestQuery.data ?? [];
  const slipsQuery = useQuery<{ slips: DaySlip[] }>({
    queryKey: ["/api/loading/date-slips", activePlant, date],
    queryFn: async () => {
      const res = await apiRequest("GET", `/api/loading/date-slips?plant=${encodeURIComponent(activePlant)}&date=${encodeURIComponent(date)}`);
      if (!res.ok) throw new Error((await res.json().catch(() => ({})))?.message || "Failed to load");
      return res.json();
    },
    enabled: !!activePlant && !!date,
    refetchInterval: 15_000,
  });
  const pickedSlips = (slipsQuery.data?.slips ?? []).filter((s) => !picked || s.orderNumber === picked.orderNumber);
  const pickOrder = (h: OrderHit) => {
    setPicked(h); setOrderNo(h.orderNumber); setDate(h.orderDate); setSugOpen(false); setExpanded(null);
  };
  // No manual pick needed: once the typed number matches exactly one order (or is exactly an order
  // number), that order selects itself.
  useEffect(() => {
    if (picked || suggestions.length === 0) return;
    const typed = orderNo.trim().replace(/^#/, "").toLowerCase();
    const hit = suggestions.find((h) => h.orderNumber.toLowerCase() === typed) ?? (suggestions.length === 1 ? suggestions[0] : null);
    if (hit) pickOrder(hit);
  }, [suggestions, picked]);
  const clearOrder = () => { setPicked(null); setOrderNo(""); setSugOpen(false); setExpanded(null); };
  const orderQ = picked ? picked.orderNumber.toLowerCase() : "";
  const items = useMemo<ItemRow[]>(() => {
    const all = query.data?.items ?? [];
    if (!orderQ) return all;
    const out: ItemRow[] = [];
    for (const it of all) {
      const parties = it.parties.filter((p) => p.orderNumber.toLowerCase() === orderQ);
      if (parties.length === 0) continue;
      const sum = (k: "expected" | "loaded" | "extra" | "remaining") => parties.reduce((s, p) => s + p[k], 0);
      out.push({ ...it, parties, expected: sum("expected"), loaded: sum("loaded"), extra: sum("extra"), remaining: sum("remaining") });
    }
    // Extras that are not on this order's slip first, then the slip's own items.
    out.sort((a, b) => Number(b.expected === 0 && b.extra > 0) - Number(a.expected === 0 && a.extra > 0));
    return out;
  }, [query.data, orderQ]);
  const shownOrders = orderQ ? new Set(items.flatMap((i) => i.parties.map((p) => p.orderNumber))).size : (query.data?.orders ?? 0);
  const shownParties = orderQ ? new Set(items.flatMap((i) => i.parties.map((p) => p.partyName))).size : (query.data?.parties ?? 0);

  const totals = items.reduce(
    (acc, it) => {
      acc.expected += it.expected; acc.loaded += it.loaded; acc.remaining += it.remaining; acc.extra += it.extra;
      acc.pExpected += plt(it.expected, it.itemsPerPallet); acc.pLoaded += plt(it.loaded, it.itemsPerPallet);
      acc.pRemaining += plt(it.remaining, it.itemsPerPallet); acc.pExtra += plt(it.extra, it.itemsPerPallet);
      return acc;
    },
    { expected: 0, loaded: 0, remaining: 0, extra: 0, pExpected: 0, pLoaded: 0, pRemaining: 0, pExtra: 0 },
  );

  const distinct = (values: string[]) =>
    Array.from(new Set(values.map((v) => v.trim()).filter(Boolean))).sort((a, b) => a.localeCompare(b, undefined, { numeric: true, sensitivity: "base" })).map((v) => ({ value: v, label: v }));
  const filterColumns: FilterableColumn<ItemRow>[] = [
    { id: "sr", label: "Sr No", filterType: "text", options: distinct(items.map((i) => i.srNo ?? "")), accessor: (i) => i.srNo },
    { id: "item", label: "Item Name", filterType: "text", options: distinct(items.map((i) => i.itemName)), accessor: (i) => i.itemName },
    { id: "barcode", label: "Barcode", filterType: "text", options: distinct(items.map((i) => i.barcode)), accessor: (i) => i.barcode },
    { id: "party", label: "Party", filterType: "text", options: distinct(items.flatMap((i) => i.parties.map((p) => p.partyName))), accessor: (i) => i.parties.map((p) => p.partyName) },
    { id: "expected", label: "Expected", filterType: "number", disableValues: true, options: [], accessor: (i) => i.expected },
    { id: "loaded", label: "Loaded", filterType: "number", disableValues: true, options: [], accessor: (i) => i.loaded },
    { id: "remaining", label: "Remaining", filterType: "number", disableValues: true, options: [], accessor: (i) => i.remaining },
    { id: "extra", label: "Extra", filterType: "number", disableValues: true, options: [], accessor: (i) => i.extra },
  ];
  const conditionList = Object.values(conditions);
  const setCondition = (id: string, c: FilterCondition) => setConditions((prev) => ({ ...prev, [id]: c }));
  const clearCondition = (id: string) => setConditions((prev) => { const next = { ...prev }; delete next[id]; return next; });
  const columnHeader = (id: string, label: string) => {
    const column = filterColumns.find((c) => c.id === id);
    if (!column) return label;
    return (
      <span className="inline-flex items-center gap-1">
        {label}
        <ColumnHeaderFilterButton column={column} condition={conditions[id]} onChange={(c) => setCondition(id, c)} onRemove={() => clearCondition(id)} />
      </span>
    );
  };

  const q = search.trim().toLowerCase();
  const rows = items.filter((it) => {
    if (!matchAllConditions(it, conditionList, filterColumns)) return false;
    if (!q) return true;
    return `${it.srNo ?? ""} ${it.itemName} ${it.barcode} ${it.parties.map((p) => `${p.partyName} ${p.orderNumber}`).join(" ")}`.toLowerCase().includes(q);
  });

  const toggle = (barcode: string) => setExpanded((cur) => (cur === barcode ? null : barcode));
  const plantCfg = activePlant === ALL_PLANTS ? null : getPlantColorCfg(activePlant);

  const columns: DataTableColumn<ItemRow>[] = [
    {
      id: "sr", header: "Sr No", align: "center", width: 64, minWidth: 56, fixedWidth: true, sortable: true, totalable: false,
      accessor: (r) => r.srNo ?? "",
      cellClassName: "align-top px-1 text-sm font-semibold tabular-nums text-gray-600", headerClassName: "px-1",
      render: (r) => r.srNo || "—",
    },
    {
      id: "item", header: columnHeader("item", "Item"), align: "center", width: 260, minWidth: 140, sortable: true,
      accessor: (r) => r.itemName,
      cellClassName: "whitespace-normal break-words text-left text-base leading-tight text-gray-700",
      total: (all) => <span className="font-semibold">Total · {all.length} items</span>,
      render: (r) => (
        <div className="flex items-center gap-2.5">
          <ProductThumb name={r.itemName} />
          <div className="min-w-0">
            <span className="block text-sm font-medium leading-snug text-gray-900">{r.itemName}</span>
            <span className="block font-mono text-sm text-gray-400">{r.barcode}</span>
            {r.itemsPerPallet > 0 && <span className="block text-xs font-semibold text-gray-500">{r.itemsPerPallet} per pallet</span>}
            {r.expected === 0 && r.extra > 0 && (
              <span className="mt-0.5 inline-block rounded-full bg-amber-100 px-2 py-0.5 text-sm font-bold text-amber-800">
                {picked ? "EXTRA · NOT ON THIS ORDER'S SLIP" : `NOT ON ANY ORDER · ${r.parties.filter((p) => p.extra > 0).map((p) => `#${p.orderNumber}`).join(", ")}`}
              </span>
            )}
          </div>
        </div>
      ),
    },
    {
      id: "expected", header: columnHeader("expected", "Expected"), align: "center", width: 84, minWidth: 70, sortable: true,
      accessor: (r) => r.expected, cellClassName: "text-2xl text-gray-700",
      total: (all) => <>{all.reduce((s, r) => s + r.expected, 0)}</>,
      render: (r) => <><span className="block text-[17px] font-bold leading-none tabular-nums text-gray-800">{r.expected}</span><PalletLine qty={r.expected} ipp={r.itemsPerPallet} /></>,
    },
    {
      id: "loaded", header: columnHeader("loaded", "Loaded"), align: "center", width: 84, minWidth: 70, sortable: true,
      accessor: (r) => r.loaded, cellClassName: "text-2xl font-semibold text-gray-900",
      total: (all) => <>{all.reduce((s, r) => s + r.loaded, 0)}</>,
      render: (r) => <><span className="block text-[17px] font-bold leading-none tabular-nums text-emerald-700">{r.loaded}</span><PalletLine qty={r.loaded} ipp={r.itemsPerPallet} /></>,
    },
    {
      id: "remaining", header: columnHeader("remaining", "Remaining"), align: "center", width: 90, minWidth: 74, sortable: true,
      accessor: (r) => r.remaining, cellClassName: "text-2xl text-gray-700",
      total: (all) => <>{all.reduce((s, r) => s + r.remaining, 0)}</>,
      render: (r) => <><span className="block text-[17px] font-bold leading-none tabular-nums text-[#001d6e]">{r.remaining}</span><PalletLine qty={r.remaining} ipp={r.itemsPerPallet} /></>,
    },
    {
      id: "extra", header: columnHeader("extra", "Extra"), align: "center", width: 80, minWidth: 66, sortable: true,
      accessor: (r) => r.extra, cellClassName: "text-2xl",
      total: (all) => <>{all.reduce((s, r) => s + r.extra, 0)}</>,
      render: (r) => (r.extra > 0 ? <><span className="block text-[17px] font-bold leading-none tabular-nums text-amber-600">{r.extra}</span><PalletLine qty={r.extra} ipp={r.itemsPerPallet} /></> : null),
    },
  ];

  const orderBox = (
        <div className="relative">
          <Search className="pointer-events-none absolute left-2.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-gray-400" />
          <input
            value={orderNo}
            onChange={(e) => { setOrderNo(e.target.value); if (picked) { setPicked(null); setExpanded(null); } setSugOpen(true); }}
            onFocus={() => setSugOpen(true)}
            onBlur={() => setTimeout(() => setSugOpen(false), 150)}
            onKeyDown={(e) => { if (e.key === "Enter" && suggestions[0] && !picked) { e.preventDefault(); pickOrder(suggestions[0]); } }}
            placeholder="Order number"
            className={`h-8 w-44 rounded-full border bg-white pl-8 pr-7 text-xs font-semibold text-[#001d6e] placeholder:font-normal placeholder:text-gray-400 focus:outline-none ${picked ? "border-[#001d6e] ring-1 ring-[#001d6e]/30" : "border-gray-200 focus:border-[#001d6e]"}`}
          />
          {orderNo && (
            <button type="button" onClick={clearOrder} className="absolute right-2 top-1/2 -translate-y-1/2 text-gray-400 hover:text-gray-700" aria-label="Clear order number">
              <X className="h-3.5 w-3.5" />
            </button>
          )}
          {sugOpen && !picked && orderNo.trim().replace(/^#/, "").length >= 2 && (
            <div className="absolute left-0 top-9 z-30 max-h-72 w-72 overflow-y-auto rounded-xl border border-gray-200 bg-white py-1 shadow-lg">
              {suggestQuery.isLoading ? (
                <p className="px-3 py-2 text-xs text-gray-400">Searching…</p>
              ) : suggestions.length === 0 ? (
                <p className="px-3 py-2 text-xs text-gray-400">No order found for your plants.</p>
              ) : suggestions.map((h) => (
                <button
                  key={`${h.orderNumber}-${h.orderDate}`}
                  type="button"
                  onMouseDown={(e) => { e.preventDefault(); pickOrder(h); }}
                  className="flex w-full items-center justify-between gap-2 px-3 py-1.5 text-left hover:bg-gray-50"
                >
                  <span className="min-w-0">
                    <span className="block text-sm font-semibold text-[#001d6e]">#{h.orderNumber}</span>
                    <span className="block truncate text-xs text-gray-500">{h.partyName}</span>
                  </span>
                  <span className="shrink-0 text-right text-[11px] text-gray-400">{h.plant}<br />{h.orderDate}</span>
                </button>
              ))}
            </div>
          )}
        </div>
  );

  const loadState = (s: DaySlip) =>
    s.loadingCompletedAt ? { label: "Completed", cls: "bg-emerald-100 text-emerald-700" }
    : s.hasLoad ? { label: s.loadingPausedAt ? "Paused" : "Loading", cls: s.loadingPausedAt ? "bg-amber-100 text-amber-800" : "bg-blue-100 text-blue-700" }
    : { label: "Not started", cls: "bg-gray-100 text-gray-600" };
  // Clicking a slip opens its read-only view (the same details as Load Operations, no buttons).
  const viewSlip = (orderNumber: string) => navigate(`/load-master/slip/${encodeURIComponent(orderNumber)}`);
  const daySlips = pickedSlips.filter((s) =>
    !slipChip ? true
    : slipChip.startsWith("load:") ? loadState(s).label === slipChip.slice(5)
    : (s.notionStatus ?? "") === slipChip.slice(7));
  const loadChips = ["Not started", "Loading", "Paused", "Completed"]
    .map((label) => ({ key: `load:${label}`, label, count: pickedSlips.filter((s) => loadState(s).label === label).length }))
    .filter((c) => c.count > 0);
  const notionCounts = new Map<string, number>();
  for (const s of pickedSlips) if (s.notionStatus) notionCounts.set(s.notionStatus, (notionCounts.get(s.notionStatus) ?? 0) + 1);
  const createdCount = pickedSlips.filter((s) => s.hasLoad).length;
  const slipTotals = daySlips.reduce(
    (a, s) => ({ qty: a.qty + s.totalQty, loaded: a.loaded + s.loadedQty, done: a.done + (s.loadingCompletedAt ? 1 : 0), started: a.started + (s.hasLoad ? 1 : 0) }),
    { qty: 0, loaded: 0, done: 0, started: 0 },
  );
  const slipsView = (
    <>
      <StatsBar
        singleRow
        stats={[
          { icon: FileText, label: "Slips", value: daySlips.length, hint: `${slipTotals.started} started · ${daySlips.length - slipTotals.started} not started`, tone: "navy" },
          { icon: Package, label: "Total", value: slipTotals.qty, hint: "boxes ordered", tone: "navy" },
          { icon: CheckCircle2, label: "Loaded", value: slipTotals.loaded, hint: "boxes loaded", tone: "emerald" },
          { icon: Clock, label: "Remaining", value: Math.max(0, slipTotals.qty - slipTotals.loaded), hint: "boxes left", tone: "red" },
          { icon: Users, label: "Completed", value: slipTotals.done, hint: `of ${daySlips.length} slips`, tone: slipTotals.done > 0 ? "emerald" : "muted" },
        ]}
      />
      <div className="flex flex-wrap items-center gap-1.5">
        <span className="mr-1 text-xs font-semibold text-gray-500">Load created for <b className="text-[#001d6e]">{createdCount}</b> of <b className="text-gray-800">{pickedSlips.length}</b> slips</span>
        <button type="button" onClick={() => setSlipChip("")}
          className={`rounded-full px-3 py-1 text-xs font-semibold ${!slipChip ? "bg-[#001d6e] text-white ring-2 ring-[#001d6e]/30" : "border border-gray-200 bg-white text-gray-600 hover:bg-gray-50"}`}>
          All ({pickedSlips.length})
        </button>
        {loadChips.map((c) => (
          <button key={c.key} type="button" onClick={() => setSlipChip(slipChip === c.key ? "" : c.key)}
            className={`rounded-full px-3 py-1 text-xs font-semibold ${slipChip === c.key ? "bg-[#001d6e] text-white ring-2 ring-[#001d6e]/30" : "border border-gray-200 bg-white text-gray-600 hover:bg-gray-50"}`}>
            {c.label} ({c.count})
          </button>
        ))}
        {Array.from(notionCounts.entries()).map(([status, count]) => (
          <button key={status} type="button" onClick={() => setSlipChip(slipChip === `notion:${status}` ? "" : `notion:${status}`)}
            className={`rounded-full px-1 py-0.5 ${slipChip === `notion:${status}` ? "ring-2 ring-[#001d6e]/40" : ""}`} title={`Slips with status ${status}`}>
            <span className="inline-flex items-center gap-1"><NotionStatusBadge status={status} /><span className="text-xs font-semibold text-gray-600">{count}</span></span>
          </button>
        ))}
      </div>
      <div className="rounded-xl border border-gray-200 bg-white shadow-sm">
        <div className="flex flex-wrap items-center gap-2 rounded-t-xl border-b border-gray-100 px-4 py-3">
          <FileText className="h-4 w-4 text-[#001d6e]" />
          <span className="text-lg font-semibold text-gray-900">{picked ? `Order #${picked.orderNumber} · ${picked.partyName}` : `Load slips of ${date}`}</span>
          <span className="text-sm text-gray-400">({daySlips.length})</span>
          <div className="ml-auto flex items-center gap-2">{orderBox}</div>
        </div>
        {slipsQuery.isLoading ? (
          <div className="p-3"><SectionSkeleton lines={6} /></div>
        ) : slipsQuery.isError ? (
          <div className="py-10 text-center text-base text-red-600">{(slipsQuery.error as Error).message}</div>
        ) : daySlips.length === 0 ? (
          <div className="py-16 text-center text-base text-gray-400">
            {picked ? `Nothing found for order #${picked.orderNumber}.` : `No load slips for ${activePlant === ALL_PLANTS ? "any plant" : activePlant} on ${date}.`}
          </div>
        ) : (
          <>
            <div className="hidden overflow-x-auto lg:block">
              <table className="w-full min-w-[900px] text-sm">
                <thead>
                  <tr className="bg-[#001d6e] text-left text-[11px] font-semibold uppercase tracking-wide text-white">
                    <th className="px-3 py-2">Order No.</th>
                    <th className="px-3 py-2">Party</th>
                    {activePlant === ALL_PLANTS && <th className="px-3 py-2">Plant</th>}
                    <th className="px-3 py-2">Vehicle</th>
                    <th className="px-3 py-2">Load</th>
                    <th className="px-3 py-2">Status</th>
                    <th className="px-3 py-2 text-center">Loaded / Total</th>
                    <th className="px-3 py-2 text-center">Volume</th>
                    <th className="px-3 py-2">Owner</th>
                  </tr>
                </thead>
                <tbody>
                  {daySlips.map((s) => {
                    const st = loadState(s);
                    const pct = s.totalQty > 0 ? Math.min(100, Math.round((s.loadedQty / s.totalQty) * 100)) : 0;
                    return (
                      <tr key={s.id} onClick={() => viewSlip(s.orderNumber)} className={`cursor-pointer border-t border-gray-100 ${s.loadingCompletedAt ? "bg-emerald-50" : "bg-white"} hover:bg-gray-50`} title="Click to view this slip">
                        <td className="px-3 py-2 font-semibold tabular-nums text-[#001d6e]">#{s.orderNumber}</td>
                        <td className="px-3 py-2 text-gray-800">{s.partyName || "—"}</td>
                        {activePlant === ALL_PLANTS && <td className="px-3 py-2">{s.plant ? <PlantBadge plant={s.plant} /> : "—"}</td>}
                        <td className="px-3 py-2 text-gray-700">{s.vehicleNumber || <span className="text-gray-300">—</span>}</td>
                        <td className="px-3 py-2"><span className={`rounded-full px-2 py-0.5 text-xs font-semibold ${st.cls}`}>{st.label}</span></td>
                        <td className="px-3 py-2"><NotionStatusBadge status={s.notionStatus} /></td>
                        <td className="px-3 py-2 text-center tabular-nums">
                          <span className="font-semibold text-emerald-600">{s.loadedQty}</span> <span className="text-gray-400">/</span> <span className="font-semibold">{s.totalQty}</span>
                          <div className="mx-auto mt-1 h-1 w-24 overflow-hidden rounded-full bg-gray-200"><div className="h-full bg-emerald-500" style={{ width: `${pct}%` }} /></div>
                        </td>
                        <td className="px-3 py-2 text-center text-xs tabular-nums">
                          <span className="font-semibold text-emerald-600">{s.loadedVolume.toFixed(2)}</span>
                          {s.orderVolume != null && <> <span className="text-gray-400">/</span> <span className="font-semibold">{s.orderVolume.toFixed(2)}</span></>}
                        </td>
                        <td className="px-3 py-2 text-xs text-gray-600">{s.loadingOwnerName || <span className="text-gray-300">—</span>}</td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
            <div className="grid gap-2 p-3 sm:grid-cols-2 lg:hidden">
              {daySlips.map((s) => {
                const st = loadState(s);
                return (
                  <div key={s.id} onClick={() => viewSlip(s.orderNumber)} role="button" className={`cursor-pointer rounded-lg border border-l-4 px-3 py-2.5 shadow-sm ${s.loadingCompletedAt ? "border-l-emerald-500 bg-emerald-50" : s.hasLoad ? "border-l-blue-400 bg-white" : "border-l-gray-300 bg-white"}`}>
                    <div className="flex items-start justify-between gap-2">
                      <div className="min-w-0">
                        <p className="text-base font-bold tabular-nums text-[#001d6e]">#{s.orderNumber}</p>
                        <p className="truncate text-sm text-gray-800">{s.partyName || "—"}</p>
                      </div>
                      <div className="flex shrink-0 flex-col items-end gap-1">
                        <span className={`rounded-full px-2 py-0.5 text-xs font-semibold ${st.cls}`}>{st.label}</span>
                        {s.plant && activePlant === ALL_PLANTS && <PlantBadge plant={s.plant} />}
                      </div>
                    </div>
                    <p className="mt-1 text-sm tabular-nums text-gray-600">
                      Loaded <span className="text-[17px] font-bold text-emerald-600">{s.loadedQty}</span> / <span className="text-[17px] font-bold text-gray-900">{s.totalQty}</span>
                      {s.vehicleNumber && <span className="ml-2 text-xs text-gray-500">{s.vehicleNumber}</span>}
                    </p>
                    <div className="mt-2 flex items-center justify-between gap-2">
                      <NotionStatusBadge status={s.notionStatus} />
                    </div>
                  </div>
                );
              })}
            </div>
          </>
        )}
      </div>
    </>
  );

  return (
    <div className="space-y-3" style={{ fontFamily: "Inter, ui-sans-serif, system-ui, sans-serif" }}>
      {/* Plant + date — the only inputs; everything below is for that one day. */}
      <div className="flex flex-wrap items-center gap-2">
        <Select value={activePlant} onValueChange={(v) => { setPlant(v); if (picked) clearOrder(); }}>
          <SelectTrigger
            className="h-8 w-auto gap-1 rounded-full text-xs font-semibold"
            style={plantCfg ? { backgroundColor: plantCfg.bgColor ?? undefined, color: plantCfg.textColor ?? undefined, borderColor: plantCfg.borderColor ?? undefined } : undefined}
          >
            <SelectValue placeholder="Plant" />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value={ALL_PLANTS}>All plants</SelectItem>
            {plantOptions.map((p) => <SelectItem key={p} value={p}>{p}</SelectItem>)}
          </SelectContent>
        </Select>
        <DateInput className="h-8 rounded-full text-xs" value={date} onChange={(v) => { setDate(v); setExpanded(null); if (picked) clearOrder(); }} clearable={false} />
        {/* Quick dates — one tap for the days that are normally looked at. */}
        <div className="flex overflow-hidden rounded-full border border-gray-200 bg-white">
          {([
            { label: "Yesterday", offset: -1 },
            { label: "Today", offset: 0 },
            { label: "Tomorrow", offset: 1 },
          ] as const).map((d) => {
            const value = format(addDays(new Date(), d.offset), "yyyy-MM-dd");
            const active = date === value;
            return (
              <button
                key={d.label}
                type="button"
                onClick={() => { setDate(value); setExpanded(null); if (picked) clearOrder(); }}
                className={`px-3 py-1 text-sm font-semibold transition-colors ${active ? "bg-[#001d6e] text-white" : "text-gray-600 hover:bg-gray-50"}`}
              >
                {d.label}
              </button>
            );
          })}
        </div>
        <Button
          variant="outline" size="sm" className="ml-auto h-8 gap-1.5 rounded-full text-xs"
          onClick={() => query.refetch()} disabled={query.isFetching}
        >
          {query.isFetching ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <RefreshCw className="h-3.5 w-3.5" />} Refresh
        </Button>
      </div>

      <div className="flex flex-wrap items-center gap-1.5">
        {([
          { key: "items", label: "Items", count: items.length },
          { key: "slips", label: "Slips", count: pickedSlips.length },
        ] as const).map((t) => (
          <button
            key={t.key}
            type="button"
            onClick={() => setTab(t.key)}
            className={`rounded-full px-3.5 py-1.5 text-xs font-semibold transition-colors ${tab === t.key ? "bg-[#001d6e] text-white ring-2 ring-[#001d6e]/30" : "border border-gray-200 bg-white text-gray-600 hover:bg-gray-50"}`}
          >
            {t.label} <span className={tab === t.key ? "text-white/70" : "text-gray-400"}>({t.count})</span>
          </button>
        ))}
      </div>

      {!activePlant || !date ? (
        <div className="rounded-xl border border-dashed border-gray-300 bg-white py-16 text-center text-base text-gray-400">
          Pick a plant and an order date.
        </div>
      ) : (
        <>
          {tab === "slips" ? slipsView : (<>
          {!query.isLoading && !query.isError && items.length > 0 && (
          <StatsBar
            singleRow
            stats={[
              { icon: Package, label: "Total", value: totals.expected, hint: `${totals.pExpected.toFixed(2)} plt`, tone: "navy" },
              { icon: CheckCircle2, label: "Loaded", value: totals.loaded, hint: `${totals.pLoaded.toFixed(2)} plt`, tone: "emerald" },
              { icon: Clock, label: "Remaining", value: totals.remaining, hint: `${totals.pRemaining.toFixed(2)} plt`, tone: "red" },
              { icon: PackagePlus, label: "Extra", value: totals.extra, hint: `${totals.pExtra.toFixed(2)} plt`, tone: totals.extra > 0 ? "amber" : "muted" },
              { icon: Users, label: "Orders", value: shownOrders, hint: `${shownParties} parties · ${items.length} items`, tone: "navy" },
            ]}
          />
          )}

          <div className="rounded-xl border border-gray-200 bg-white shadow-sm">
            <div className="flex flex-wrap items-center gap-2 rounded-t-xl border-b border-gray-100 px-4 py-3">
              <Package className="h-4 w-4 text-[#001d6e]" />
              <span className="text-lg font-semibold text-gray-900">{picked ? `Order #${picked.orderNumber} · ${picked.partyName} · ${date}` : `Items Loaded on ${date}`}</span>
              <span className="text-sm text-gray-400">{conditionList.length > 0 || q ? `(${rows.length} of ${items.length})` : `(${items.length})`}</span>
              <div className="ml-auto flex items-center gap-2">
                {orderBox}
                <AddColumnFilterButton
                  columns={filterColumns}
                  conditions={conditions}
                  onApply={setCondition}
                  onClear={clearCondition}
                  className="h-8 shrink-0 gap-1 rounded-xl border-dashed border-[#001d6e]/40 bg-white text-xs font-medium text-[#001d6e] hover:bg-[#001d6e]/5 hover:text-[#001d6e]"
                />
                <CollapsibleSearch value={search} onChange={setSearch} placeholder="Search item, barcode, party or order…" />
              </div>
              {conditionList.length > 0 && (
                <div className="flex w-full flex-wrap items-center gap-1.5">
                  {Object.entries(conditions).map(([id, condition]) => (
                    <ColumnFilterChipView key={id} columnId={id} condition={condition} columns={filterColumns} onEdit={(c) => setCondition(id, c)} onRemove={() => clearCondition(id)} />
                  ))}
                </div>
              )}
            </div>

            {query.isLoading ? (
              <div className="p-3"><SectionSkeleton lines={6} /></div>
            ) : query.isError ? (
              <div className="py-10 text-center text-base text-red-600">{(query.error as Error).message}</div>
            ) : items.length === 0 ? (
              <div className="py-16 text-center text-base text-gray-400">
                {picked ? `Nothing found for order #${picked.orderNumber}.` : `No Notion orders for ${activePlant === ALL_PLANTS ? "any plant" : activePlant} on ${date}.`}
              </div>
            ) : (
            <>
            {/* Desktop: table. */}
            <div className="hidden lg:block">
              <DataTable<ItemRow>
                containerClassName="rounded-none border-0"
                headerClassName="bg-[#001d6e] text-white border-[#1a3a9c] hover:bg-[#0a2b7e] hover:text-white text-xs sm:text-xs"
                columns={columns}
                data={rows}
                getRowId={(r) => r.barcode}
                enableZebraStripes
                rowClassName={(r) => (r.extra > 0 ? "bg-amber-50 hover:bg-amber-50/80" : r.expected > 0 && r.loaded >= r.expected ? "bg-emerald-50 hover:bg-emerald-50/80" : undefined)}
                renderExpandedRow={(r) => <PartyBreakdown row={r} showPlant={activePlant === ALL_PLANTS} />}
                isRowExpandable={() => true}
                expandedRowId={expanded}
                onRowClick={(r) => toggle(r.barcode)}
                emptyState="No items."
                noResultsState="No items match this filter."
                hasActiveFilters={!!q || conditionList.length > 0}
                sortMode="client"
                enableTotalsRow
                enableColumnResizing
                isStickyHeader
                maxHeight="70vh"
              />
            </div>

            {/* Tablet / phone: one card per product, same numbers, tap to open the parties. */}
            <div className="grid gap-2 p-3 sm:grid-cols-2 lg:hidden">
              {rows.length === 0 ? (
                <p className="col-span-full py-8 text-center text-base text-gray-400">No items match this filter.</p>
              ) : rows.map((r) => {
                const open = expanded === r.barcode;
                return (
                  <div key={r.barcode} className={open ? "sm:col-span-2" : undefined}>
                    <div
                      role="button"
                      onClick={() => toggle(r.barcode)}
                      className={`flex items-center gap-3 rounded-lg border border-l-4 px-3 py-2.5 shadow-sm ${
                        r.extra > 0 ? "border-l-amber-400 bg-amber-50" : r.expected > 0 && r.loaded >= r.expected ? "border-l-emerald-500 bg-emerald-50" : "border-l-gray-300 bg-white"
                      }`}
                    >
                      <ProductThumb name={r.itemName} className="h-14 w-14" />
                      <div className="min-w-0 flex-1">
                        <p className="truncate text-base font-semibold text-gray-900">{r.itemName}</p>
                        <p className="truncate font-mono text-sm text-gray-400">{r.barcode}{r.itemsPerPallet > 0 ? ` · ${r.itemsPerPallet}/plt` : ""}</p>
                        {r.expected === 0 && r.extra > 0 && (
                          <p className="truncate text-sm font-bold text-amber-700">
                            {picked ? "Extra · not on this order's slip" : `Not on any order · ${r.parties.filter((p) => p.extra > 0).map((p) => `#${p.orderNumber}`).join(", ")}`}
                          </p>
                        )}
                        <p className="mt-0.5 text-base tabular-nums text-gray-600">
                          Exp <span className="text-[17px] font-bold text-gray-900">{r.expected}</span>
                          <span className="text-gray-300"> · </span>
                          Loaded <span className="text-[17px] font-bold text-emerald-600">{r.loaded}</span>
                          <span className="text-gray-300"> · </span>
                          Rem <span className="text-[17px] font-bold text-[#001d6e]">{r.remaining}</span>
                          {r.extra > 0 && <span className="ml-1.5 text-[17px] font-bold text-amber-600">{r.extra} extra</span>}
                        </p>
                      </div>
                    </div>
                    {open && <div className="mt-1 overflow-hidden rounded-xl border border-gray-200 bg-white"><PartyBreakdown row={r} showPlant={activePlant === ALL_PLANTS} /></div>}
                  </div>
                );
              })}
            </div>
            </>
            )}
          </div>
          </>)}
        </>
      )}
    </div>
  );
}
