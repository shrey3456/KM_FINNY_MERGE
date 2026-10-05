import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { addDays, format } from "date-fns";
import { CheckCircle2, Clock, Loader2, Package, PackagePlus, RefreshCw, Users } from "lucide-react";
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
  const [expanded, setExpanded] = useState<string | null>(null);
  const [conditions, setConditions] = useState<Record<string, FilterCondition>>({});

  // A saved plant this user may no longer see falls back to the first one they can.
  // "All plants" is a choice of its own (and the default), not a plant name.
  const activePlant = plant === ALL_PLANTS || !plant
    ? ALL_PLANTS
    : plantOptions.find((p) => p.toLowerCase() === plant.toLowerCase()) ?? ALL_PLANTS;

  const query = useQuery<DateItems>({
    queryKey: ["/api/loading/date-items", activePlant, date],
    queryFn: async () => {
      const res = await apiRequest("GET", `/api/loading/date-items?plant=${encodeURIComponent(activePlant)}&date=${encodeURIComponent(date)}`);
      if (!res.ok) throw new Error((await res.json().catch(() => ({})))?.message || "Failed to load");
      return res.json();
    },
    enabled: !!activePlant && !!date,
    refetchInterval: 15_000,
  });
  const items = query.data?.items ?? [];

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
    { id: "order", label: "Order No.", filterType: "text", options: distinct(items.flatMap((i) => i.parties.map((p) => p.orderNumber))), accessor: (i) => i.parties.map((p) => p.orderNumber) },
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
                NOT ON ANY ORDER · {r.parties.filter((p) => p.extra > 0).map((p) => `#${p.orderNumber}`).join(", ")}
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

  return (
    <div className="space-y-3" style={{ fontFamily: "Inter, ui-sans-serif, system-ui, sans-serif" }}>
      {/* Plant + date — the only inputs; everything below is for that one day. */}
      <div className="flex flex-wrap items-center gap-2">
        <Select value={activePlant} onValueChange={setPlant}>
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
        <DateInput className="h-8 rounded-full text-xs" value={date} onChange={(v) => { setDate(v); setExpanded(null); }} clearable={false} />
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
                onClick={() => { setDate(value); setExpanded(null); }}
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

      {!activePlant || !date ? (
        <div className="rounded-xl border border-dashed border-gray-300 bg-white py-16 text-center text-base text-gray-400">
          Pick a plant and an order date.
        </div>
      ) : query.isLoading ? (
        <SectionSkeleton lines={6} />
      ) : query.isError ? (
        <div className="rounded-xl border border-red-200 bg-red-50 py-10 text-center text-base text-red-600">{(query.error as Error).message}</div>
      ) : items.length === 0 ? (
        <div className="rounded-xl border border-dashed border-gray-300 bg-white py-16 text-center text-base text-gray-400">
          No Notion orders for {activePlant === ALL_PLANTS ? "any plant" : activePlant} on {date}.
        </div>
      ) : (
        <>
          <StatsBar
            singleRow
            stats={[
              { icon: Package, label: "Total", value: totals.expected, hint: `${totals.pExpected.toFixed(2)} plt`, tone: "navy" },
              { icon: CheckCircle2, label: "Loaded", value: totals.loaded, hint: `${totals.pLoaded.toFixed(2)} plt`, tone: "emerald" },
              { icon: Clock, label: "Remaining", value: totals.remaining, hint: `${totals.pRemaining.toFixed(2)} plt`, tone: "red" },
              { icon: PackagePlus, label: "Extra", value: totals.extra, hint: `${totals.pExtra.toFixed(2)} plt`, tone: totals.extra > 0 ? "amber" : "muted" },
              { icon: Users, label: "Orders", value: query.data?.orders ?? 0, hint: `${query.data?.parties ?? 0} parties · ${items.length} items`, tone: "navy" },
            ]}
          />

          <div className="overflow-hidden rounded-xl border border-gray-200 bg-white shadow-sm">
            <div className="flex flex-wrap items-center gap-2 border-b border-gray-100 px-4 py-3">
              <Package className="h-4 w-4 text-[#001d6e]" />
              <span className="text-lg font-semibold text-gray-900">Items Loaded on {date}</span>
              <span className="text-sm text-gray-400">{conditionList.length > 0 || q ? `(${rows.length} of ${items.length})` : `(${items.length})`}</span>
              <div className="ml-auto flex items-center gap-2">
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
                            Not on any order · {r.parties.filter((p) => p.extra > 0).map((p) => `#${p.orderNumber}`).join(", ")}
                          </p>
                        )}
                        <p className="mt-0.5 text-base tabular-nums text-gray-600">
                          Exp <span className="text-[17px] font-bold text-gray-900">{r.expected}</span>
                          <span className="text-gray-300"> · </span>
                          Loaded <span className="text-[17px] font-bold text-emerald-600">{r.loaded}</span>
                          <span className="text-gray-300"> · </span>
                          Rem <span className="text-[17px] font-bold text-[#001d6e]">{r.remaining}</span>
                          {r.extra > 0 && <span className="ml-1.5 text-[17px] font-bold text-amber-600">+{r.extra} extra</span>}
                        </p>
                      </div>
                    </div>
                    {open && <div className="mt-1 overflow-hidden rounded-xl border border-gray-200 bg-white"><PartyBreakdown row={r} showPlant={activePlant === ALL_PLANTS} /></div>}
                  </div>
                );
              })}
            </div>
          </div>
        </>
      )}
    </div>
  );
}
