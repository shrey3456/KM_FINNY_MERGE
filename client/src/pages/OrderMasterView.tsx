import { useMemo, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { format } from "date-fns";
import { Layers } from "lucide-react";
import PageHeader from "@/components/PageHeader";
import { PlantBadge } from "@/components/PlantBadge";
import { Input } from "@/components/ui/input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { DataTable, type DataTableColumn } from "@/components/ui/data-table";
import { TableCard } from "@/components/ui/table-card";
import { CollapsibleSearch } from "@/components/ui/collapsible-search";
import { apiRequest } from "@/lib/queryClient";

// Standalone, view-only counterpart to Scan Order's "Master View" tab — that tab only ever
// shows the ONE order currently loaded for scanning (it's driven by activeOrderScanSession),
// and deliberately has no click-to-expand history ("Master View is view-only — no click-to-
// expand history here", per its own comment). This page instead lets you pick ANY date (and
// optionally a plant) and see every item ordered that day, merged across every CSV uploaded
// for it — same merge-by-barcode logic — with a click-to-expand full day-wide scan history per
// item, reusing the exact same /master-view and /master-view/item-history endpoints (both are
// already date/plant-general, not tied to any "active" session).

function getLocalISODate(date = new Date()): string {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

type MvItem = {
  id: number;
  sessionId: number;
  barcode: string | null;
  itemName: string | null;
  sapCode: string | null;
  quantity: number | null;
  scannedQty: number | null;
  isExtra?: boolean;
  lastScannedAt?: string | null;
};
type MvFile = {
  sessionId: number;
  csvFileName: string;
  plant: string;
  items: MvItem[];
};
type MvResponse = {
  date: string;
  totalFiles: number;
  totalRows: number;
  files: MvFile[];
};

type MergedItem = {
  key: string;
  plant: string;
  barcode: string | null;
  itemName: string | null;
  sapCode: string | null;
  expected: number;
  scanned: number;
  extra: number;
  files: string[];
  isExtraOnly: boolean;
  lastScannedAt: string | null;
};

type HistoryEvent = {
  id: number;
  sessionId: number;
  barcode: string;
  itemName: string | null;
  pallets: number | null;
  totalQty: number | null;
  isExtra: boolean | null;
  scannedByName: string | null;
  scannedAt: string | null;
  voided: boolean | null;
  voidedByCode: string | null;
  voidedAt: string | null;
  voidReason: string | null;
  orderName: string | null;
  partIndex: number | null;
};

function StatusBadge({ item }: { item: MergedItem }) {
  const isDone = item.expected > 0 && item.scanned >= item.expected;
  const isPartial = item.scanned > 0 && !isDone && !item.isExtraOnly;
  if (item.isExtraOnly)
    return (
      <span className="inline-flex items-center rounded-sm border border-orange-300 bg-orange-50 px-2 py-0.5 text-[11px] font-semibold uppercase tracking-wide text-orange-700">
        Extra
      </span>
    );
  if (isDone)
    return (
      <span className="inline-flex items-center rounded-sm border border-emerald-300 bg-emerald-50 px-2 py-0.5 text-[11px] font-semibold uppercase tracking-wide text-emerald-700">
        Received
      </span>
    );
  if (isPartial)
    return (
      <span className="inline-flex items-center rounded-sm border border-amber-300 bg-amber-50 px-2 py-0.5 text-[11px] font-semibold uppercase tracking-wide text-amber-700">
        Partial
      </span>
    );
  return (
    <span className="inline-flex items-center rounded-sm border border-gray-300 bg-gray-50 px-2 py-0.5 text-[11px] font-semibold uppercase tracking-wide text-gray-500">
      Pending
    </span>
  );
}

const dash = <span className="text-gray-300">—</span>;

export default function OrderMasterView() {
  const [date, setDate] = useState(getLocalISODate());
  const [plant, setPlant] = useState("");
  const [search, setSearch] = useState("");
  const [expandedKey, setExpandedKey] = useState<string | null>(null);

  const { data: plants = [] } = useQuery<{ id: number; name: string }[]>({
    queryKey: ["/api/plants"],
    queryFn: () => apiRequest("GET", "/api/plants", undefined, false, true),
  });

  const mvQuery = useQuery<MvResponse>({
    queryKey: ["/api/order-import/master-view", date, plant],
    queryFn: () => {
      const params = new URLSearchParams({ date });
      if (plant) params.set("plant", plant);
      return apiRequest("GET", `/api/order-import/master-view?${params}`, undefined, false, true);
    },
    enabled: !!date,
    placeholderData: (previous) => previous,
    // Live-ish: someone may be scanning against this date's order right now — keep the "latest
    // scanned on top" ordering fresh without requiring a manual refresh.
    refetchInterval: 8000,
    refetchIntervalInBackground: false,
  });

  const mvData = mvQuery.data;

  // Every session that contributed to this date/plant view — the full-day scope for the
  // item-history drill-down (unlike Scan Order's Master View, which only ever knows about
  // the one currently-active session's group).
  const sessionIds = useMemo(() => (mvData?.files ?? []).map((f) => f.sessionId), [mvData]);

  // One consolidated row per item (matched by plant + barcode, falling back to item name) —
  // its expected/received/extra quantities summed across every CSV for the day. Plant is part
  // of the merge key (unlike the Scan tab's Master View, which only ever looks at one plant at
  // a time) so picking "All Plants" doesn't conflate the same barcode ordered by two different
  // plants into one row.
  const mergedItems = useMemo<MergedItem[]>(() => {
    if (!mvData) return [];
    const groups = new Map<string, MergedItem>();
    mvData.files.forEach((f) => {
      f.items.forEach((item) => {
        const nameKey = item.barcode?.trim().toLowerCase() || (item.itemName ? `name::${item.itemName.trim().toLowerCase()}` : `id::${item.id}`);
        const key = `${f.plant}::${nameKey}`;
        let g = groups.get(key);
        if (!g) {
          g = {
            key, plant: f.plant, barcode: item.barcode, itemName: item.itemName, sapCode: item.sapCode,
            expected: 0, scanned: 0, extra: 0, files: [], isExtraOnly: true, lastScannedAt: null,
          };
          groups.set(key, g);
        }
        g.expected += item.quantity ?? 0;
        g.scanned += item.scannedQty ?? 0;
        if (item.isExtra) g.extra += item.scannedQty ?? 0;
        if (!g.itemName && item.itemName) g.itemName = item.itemName;
        if (!g.sapCode && item.sapCode) g.sapCode = item.sapCode;
        if (!g.files.includes(f.csvFileName)) g.files.push(f.csvFileName);
        if (!item.isExtra) g.isExtraOnly = false;
        // Take the latest touch across every contributing CSV — a barcode split across two
        // parts should surface whichever part was scanned most recently, not the first one seen.
        if (item.lastScannedAt && (!g.lastScannedAt || new Date(item.lastScannedAt) > new Date(g.lastScannedAt))) {
          g.lastScannedAt = item.lastScannedAt;
        }
      });
    });
    // Just-scanned items lead the list — this is meant to read like a live activity feed, so a
    // partial scan (any quantity) floats its row up just as much as one that happens to complete
    // the line. Never-scanned rows have no lastScannedAt and fall back to alphabetical order at
    // the bottom.
    return Array.from(groups.values()).sort((a, b) => {
      if (a.lastScannedAt && b.lastScannedAt) {
        return new Date(b.lastScannedAt).getTime() - new Date(a.lastScannedAt).getTime();
      }
      if (a.lastScannedAt) return -1;
      if (b.lastScannedAt) return 1;
      return (a.itemName ?? "").localeCompare(b.itemName ?? "");
    });
  }, [mvData]);

  const filtered = useMemo(() => {
    if (!search) return mergedItems;
    const q = search.toLowerCase();
    return mergedItems.filter(
      (i) =>
        (i.itemName ?? "").toLowerCase().includes(q) ||
        (i.barcode ?? "").toLowerCase().includes(q) ||
        (i.sapCode ?? "").toLowerCase().includes(q),
    );
  }, [mergedItems, search]);

  // Full day-wide scan history for whichever item row is expanded — every scan event across
  // every session for this date/plant view, not just one CSV's.
  const expandedItem = filtered.find((i) => i.key === expandedKey) ?? null;
  const historyQuery = useQuery<{ items: HistoryEvent[] }>({
    queryKey: ["/api/order-import/master-view/item-history", expandedItem?.barcode, sessionIds.join(",")],
    queryFn: () =>
      apiRequest(
        "GET",
        `/api/order-import/master-view/item-history?barcode=${encodeURIComponent(expandedItem!.barcode!)}&sessionIds=${sessionIds.join(",")}`,
        undefined, false, true,
      ),
    enabled: !!expandedItem?.barcode && sessionIds.length > 0,
  });

  const columns: DataTableColumn<MergedItem>[] = [
    {
      id: "itemName", header: "Item Name", hideable: false, width: 260,
      accessor: (i) => i.itemName,
      cellClassName: "whitespace-normal break-words",
      render: (i) => (
        <span className={i.barcode ? "font-medium text-[#001d6e] underline decoration-dotted underline-offset-2" : "font-medium text-gray-900"}>
          {i.itemName ?? "—"}
        </span>
      ),
    },
    {
      id: "barcode", header: "Barcode / SAP", width: 150,
      accessor: (i) => i.barcode,
      cellClassName: "font-mono text-xs text-gray-500",
      render: (i) => i.barcode ?? i.sapCode ?? dash,
    },
    {
      id: "plant", header: "Plant", width: 90,
      render: (i) => <PlantBadge plant={i.plant} />,
    },
    {
      id: "expected", header: "Expected", width: 90, align: "right",
      accessor: (i) => i.expected,
      render: (i) => (i.expected > 0 ? i.expected.toLocaleString() : dash),
    },
    {
      id: "received", header: "Received", width: 90, align: "right",
      accessor: (i) => i.scanned,
      cellClassName: "font-semibold tabular-nums",
      render: (i) => i.scanned.toLocaleString(),
    },
    {
      id: "extra", header: "Extra", width: 80, align: "right",
      accessor: (i) => i.extra,
      render: (i) => (i.extra > 0 ? i.extra.toLocaleString() : dash),
    },
    {
      id: "remaining", header: "Remaining", width: 90, align: "right",
      accessor: (i) => Math.max(0, i.expected - i.scanned),
      render: (i) => {
        const remaining = Math.max(0, i.expected - i.scanned);
        return remaining > 0 ? remaining.toLocaleString() : dash;
      },
    },
    {
      id: "lastScanned", header: "Last Scanned", width: 140,
      accessor: (i) => i.lastScannedAt,
      cellClassName: "text-xs tabular-nums text-gray-500 whitespace-nowrap",
      render: (i) => (i.lastScannedAt ? format(new Date(i.lastScannedAt), "MMM d, h:mm a") : dash),
    },
    {
      id: "status", header: "Status", width: 110, hideable: false,
      render: (i) => <StatusBadge item={i} />,
    },
  ];

  return (
    <div className="flex-1 overflow-y-auto p-4 lg:p-6">
      <div className="max-w-7xl mx-auto space-y-4">
        <PageHeader
          icon={Layers}
          title="Order Master View"
          description="Every item ordered on a date, merged across every CSV uploaded for it — latest scanned item on top. Click an item to see its full day-wide scan history."
        />

        <TableCard
          icon={Layers}
          title="Items"
          subtitle={mvQuery.isLoading ? "Loading…" : `${filtered.length} of ${mergedItems.length} items · ${mvData?.totalFiles ?? 0} CSV(s)`}
          className="rounded-none shadow-none border-gray-300"
          headerActions={
            <>
              <CollapsibleSearch value={search} onChange={setSearch} placeholder="Item, barcode, SAP…" />

              <Input
                type="date"
                value={date}
                onChange={(e) => { setDate(e.target.value); setExpandedKey(null); }}
                className="h-8 w-[140px] text-xs"
              />

              <Select value={plant || "_all_"} onValueChange={(v) => { setPlant(v === "_all_" ? "" : v); setExpandedKey(null); }}>
                <SelectTrigger className="h-8 w-[130px] text-xs"><SelectValue placeholder="All plants" /></SelectTrigger>
                <SelectContent>
                  <SelectItem value="_all_">All plants</SelectItem>
                  {plants.map((p) => <SelectItem key={p.id} value={p.name}>{p.name}</SelectItem>)}
                </SelectContent>
              </Select>
            </>
          }
        >
          <DataTable<MergedItem>
            className="space-y-0"
            containerClassName="rounded-none border-0"
            columns={columns}
            data={filtered}
            getRowId={(i) => i.key}
            isLoading={mvQuery.isLoading}
            loadingLabel="Loading order…"
            emptyState="No items ordered for this date."
            noResultsState="No items match your search."
            hasActiveFilters={!!search}
            enableZebraStripes
            enableColumnResizing
            isStickyHeader
            maxHeight="max(420px, calc(100vh - 340px))"
            showMobileSwipeHint
            paginationMode="client"
            defaultPageSize={25}
            pageSizeOptions={[25, 50, 100]}
            onRowClick={(i) => setExpandedKey((k) => (k === i.key ? null : i.key))}
            isRowClickable={(i) => !!i.barcode}
            isRowExpandable={(i) => !!i.barcode}
            expandedRowId={expandedKey}
            renderExpandedRow={() => (
              <div className="bg-gray-50/60 p-3">
                <p className="mb-2 text-[11px] font-semibold uppercase tracking-wide text-gray-400">
                  Scan History — {expandedItem?.itemName ?? expandedItem?.barcode}
                </p>
                {historyQuery.isLoading ? (
                  <p className="py-4 text-center text-sm text-gray-400">Loading history…</p>
                ) : !historyQuery.data?.items.length ? (
                  <p className="py-4 text-center text-sm text-gray-400">No scans recorded for this item today.</p>
                ) : (
                  <div className="divide-y divide-gray-200 border border-gray-200 bg-white">
                    {historyQuery.data.items.map((ev) => (
                      <div key={ev.id} className={`flex flex-wrap items-center gap-x-6 gap-y-2 px-3 py-2.5 ${ev.voided ? "opacity-50" : ""}`}>
                        <div className="min-w-0">
                          <p className="text-[10px] font-semibold uppercase tracking-wide text-gray-400">Time</p>
                          <p className="whitespace-nowrap text-xs tabular-nums text-gray-700">
                            {ev.scannedAt ? format(new Date(ev.scannedAt), "MMM d, h:mm a") : dash}
                          </p>
                        </div>
                        <div className="min-w-0">
                          <p className="text-[10px] font-semibold uppercase tracking-wide text-gray-400">Scanned By</p>
                          <p className="whitespace-nowrap text-xs text-gray-700">{ev.scannedByName ?? "Unknown"}</p>
                        </div>
                        <div className="min-w-0">
                          <p className="text-[10px] font-semibold uppercase tracking-wide text-gray-400">Qty</p>
                          <p className="text-xs font-semibold tabular-nums text-gray-900">{ev.totalQty ?? 0}</p>
                        </div>
                        <div className="min-w-0">
                          <p className="text-[10px] font-semibold uppercase tracking-wide text-gray-400">File</p>
                          <p className="whitespace-nowrap text-xs text-gray-700" title={ev.orderName ?? undefined}>
                            {ev.partIndex ? `Part ${ev.partIndex}` : ev.orderName ?? dash}
                          </p>
                        </div>
                        <div className="min-w-0">
                          <p className="text-[10px] font-semibold uppercase tracking-wide text-gray-400">Type</p>
                          <p className="whitespace-nowrap text-xs text-gray-700">{ev.isExtra ? "Extra" : "Regular"}</p>
                        </div>
                        {ev.voided && (
                          <span className="inline-flex items-center rounded-sm border border-red-300 bg-red-50 px-2 py-0.5 text-[11px] font-semibold uppercase tracking-wide text-red-700">
                            Voided{ev.voidReason ? ` — ${ev.voidReason}` : ""}
                          </span>
                        )}
                      </div>
                    ))}
                  </div>
                )}
              </div>
            )}
            headerClassName="bg-[#001d6e] text-white border-[#1a3a9c] hover:bg-[#0a2b7e] hover:text-white"
          />
        </TableCard>
      </div>
    </div>
  );
}
