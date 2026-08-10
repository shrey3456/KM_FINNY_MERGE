import { useEffect, useMemo, useState } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { format } from "date-fns";
import { ChevronLeft, Eye, ListFilter, Loader2, Plus, X } from "lucide-react";
import { useAuth } from "@/hooks/use-auth";
import { useToast } from "@/hooks/use-toast";
import { hasPageWriteAccess } from "@/lib/permissions";
import { apiRequest } from "@/lib/queryClient";
import PageHeader from "@/components/PageHeader";
import { PlantBadge } from "@/components/PlantBadge";
import { TableCard } from "@/components/ui/table-card";
import { DataTable, type DataTableColumn } from "@/components/ui/data-table";
import { ColumnHeaderFilterButton, ColumnFilterPopoverContent } from "@/components/filters/ColumnFilterChip";
import { type FilterableColumn, type FilterCondition, conditionSummary, matchAllConditions } from "@/lib/columnFilters";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Select, SelectContent, SelectItem, SelectTrigger, SelectValue,
} from "@/components/ui/select";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import {
  Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription, DialogFooter,
} from "@/components/ui/dialog";

// ── Types ──────────────────────────────────────────────────────────────────

type Plant = { id: number; name: string };

// Matches GET /api/order-import/sessions' row shape (only the fields this page needs).
type SessionOption = {
  id: number;
  plant: string;
  csvFileName: string;
  orderDate: string | null;
  scanStatus: string | null;
  partIndex: number | null;
};

// Matches GET /api/order-scan/sessions/:id/items.
type OsScanItem = {
  id: number; sessionId: number;
  barcode: string | null; itemName: string | null; sapCode: string | null;
  expectedQty: number; itemsPerPallet: number;
  scannedPallets: number; scannedLooseQty: number; totalScannedQty: number;
  status: string; lastScannedAt: string | null;
};

// Matches GET /api/order-scan/sessions/:id/extras (grouped, un-voided only).
type ExtraRow = { barcode: string; itemName: string | null; totalQty: number };

// Matches GET /api/order-import/master-view/item-history.
type HistoryEvent = {
  id: number; sessionId: number; barcode: string; itemName: string | null;
  pallets: number | null; totalQty: number; isExtra: boolean; stv: string | null;
  scannedByName: string | null; scannedAt: string;
  voided: boolean | null; voidedAt: string | null; voidReason: string | null;
  orderName: string; partIndex: number | null;
};

const normalize = (v?: string | null) => String(v ?? "").trim().toLowerCase();

function getLocalISODate(date = new Date()): string {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

// A read-only replica of the Scan tab's CSV Items table (same Item/Exp/Received/Left/Extra/
// Status columns), except instead of always following whichever session happens to be
// "active" for your plant, you pick a plant + order date first and it shows that order's
// data instead — including already-completed ones. Deliberately filters-first: nothing is
// fetched until both are chosen, and every filter change re-queries the server rather than
// filtering an already-loaded set client-side.
// Void is included (click a row to see its scan history, void a mistaken entry from there)
// but gated by its own "scan-viewer" Write Access — independent of Scan Order/Scan History's
// write access, so someone can be trusted to look things up and correct a mistake without
// being able to do anything else on the real Scan Order page. See requireVoidAccess in
// server/routes/order-scan.ts for the matching server-side rule.
export default function ScanViewer() {
  const { user } = useAuth();
  const { toast } = useToast();
  const qc = useQueryClient();

  const isAdminOrSuper = ["admin", "super-admin"].includes(((user as any)?.role ?? "").toLowerCase());
  const canVoidScan = isAdminOrSuper || hasPageWriteAccess("scan-viewer");

  // Same plant scoping as the Scan page's own "Active:" switcher — admin/super-admin see
  // every plant, everyone else only the plant(s) actually assigned to them (users.plants).
  const myPlantNames: string[] = (() => {
    try {
      const parsed = JSON.parse((user as any)?.plants ?? "[]");
      return Array.isArray(parsed) ? parsed.map((p: any) => String(p)) : [];
    } catch { return []; }
  })();

  const [plant, setPlant] = useState("");
  // Defaults to today — "the live order date" — rather than blank, so the page shows
  // something immediately instead of starting on an empty screen. Still fully backend-driven:
  // this is just the initial value handed to the same filter, not a client-side default view.
  const [date, setDate] = useState(() => getLocalISODate());
  const [sessionId, setSessionId] = useState<number | null>(null);
  const [search, setSearch] = useState("");

  const filtersReady = !!plant && !!date;

  const { data: allPlants } = useQuery<Plant[]>({
    queryKey: ["/api/plants"],
    queryFn: () => apiRequest("GET", "/api/plants").then((r) => r.json()),
    staleTime: 60000,
  });

  // Plant pills to show — this user's own assigned plants, or every plant for admins.
  const plantOptions = isAdminOrSuper
    ? (allPlants ?? []).map((p) => p.name)
    : myPlantNames.map((p) => p.toUpperCase());

  // Same source the Scan page's own switcher uses — already scoped server-side to this
  // user's plants. Used here to resolve each plant's currently-active order date, so picking
  // a plant snaps the date to what's actually live for it instead of leaving whatever date a
  // previously-selected plant happened to be on.
  const activeSessionsQuery = useQuery<{ plant: string; orderDate: string | null }[]>({
    queryKey: ["/api/order-scan/active-sessions", "scan-viewer"],
    queryFn: () => apiRequest("GET", "/api/order-scan/active-sessions").then((r) => r.json()),
    staleTime: 30000,
  });
  const activeDateByPlant = new Map(
    (activeSessionsQuery.data ?? [])
      .filter((s) => !!s.orderDate)
      .map((s) => [normalize(s.plant), s.orderDate as string]),
  );

  // Picking a plant (including the initial default below) also sets the date to that
  // plant's live active order date, if it has one right now — falling back to today when it
  // doesn't, rather than carrying over whatever date a different plant happened to be on.
  const selectPlant = (p: string) => {
    setPlant(p);
    setSessionId(null);
    setDate(activeDateByPlant.get(normalize(p)) ?? getLocalISODate());
  };

  // Default to the first plant available once the list is known, same as the Scan page
  // defaulting to whichever plant it resolves for you rather than leaving it unset. Waits for
  // active-sessions to have loaded (or failed) too, so this default also gets the right date
  // in one step instead of picking a plant now and correcting the date a moment later.
  useEffect(() => {
    if (!plant && plantOptions.length > 0 && !activeSessionsQuery.isLoading) {
      selectPlant(plantOptions[0]);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [plantOptions.join(","), activeSessionsQuery.isLoading]);

  // Nothing is fetched until both filters are picked — this query is disabled otherwise, and
  // every value it depends on is in the queryKey, so changing plant/date always re-queries the
  // server instead of re-filtering whatever was loaded before.
  const sessionsQuery = useQuery<{ sessions: SessionOption[]; total: number }>({
    queryKey: ["/api/order-import/sessions", "scan-viewer", plant, date],
    queryFn: () =>
      apiRequest("GET", `/api/order-import/sessions?plant=${encodeURIComponent(plant)}&date=${encodeURIComponent(date)}&pageSize=50`)
        .then((r) => r.json()),
    enabled: filtersReady,
  });
  const sessionOptions = (sessionsQuery.data?.sessions ?? [])
    .slice()
    .sort((a, b) => (a.partIndex ?? 0) - (b.partIndex ?? 0));

  // Default to the first (lowest part number) session once the list for this plant/date
  // loads, or clear the selection if the filters changed and it no longer applies.
  useEffect(() => {
    if (sessionOptions.length === 0) { setSessionId(null); return; }
    if (!sessionOptions.some((s) => s.id === sessionId)) {
      setSessionId(sessionOptions[0].id);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sessionOptions.map((s) => s.id).join(",")]);

  const itemsQuery = useQuery<OsScanItem[]>({
    queryKey: ["/api/order-scan/sessions", sessionId, "items", "scan-viewer"],
    queryFn: () => apiRequest("GET", `/api/order-scan/sessions/${sessionId}/items`).then((r) => r.json()),
    enabled: sessionId != null,
  });
  const extrasQuery = useQuery<ExtraRow[]>({
    queryKey: ["/api/order-scan/sessions", sessionId, "extras", "scan-viewer"],
    queryFn: () => apiRequest("GET", `/api/order-scan/sessions/${sessionId}/extras`).then((r) => r.json()),
    enabled: sessionId != null,
  });
  const extraByBarcode = new Map((extrasQuery.data ?? []).map((e) => [normalize(e.barcode), e.totalQty ?? 0]));

  // Every part sharing this plant + order date — history spans the whole order, not just the
  // one part currently selected above, same as the Scan tab's own drill-down.
  const groupSessionIds = sessionOptions.map((s) => s.id);

  const [historyItem, setHistoryItem] = useState<OsScanItem | null>(null);
  const historyQuery = useQuery<{ items: HistoryEvent[] }>({
    queryKey: ["/api/order-import/master-view/item-history", "scan-viewer", historyItem?.barcode, groupSessionIds.join(",")],
    queryFn: () =>
      apiRequest(
        "GET",
        `/api/order-import/master-view/item-history?barcode=${encodeURIComponent(historyItem!.barcode!)}&sessionIds=${groupSessionIds.join(",")}`,
      ).then((r) => r.json()),
    enabled: !!historyItem?.barcode && groupSessionIds.length > 0,
  });

  // STV filter for the history drill-down — an item can have been scanned across more than
  // one truck/STV, so this narrows the list to just one. Resets whenever a different item's
  // history is opened.
  const [historyStvFilter, setHistoryStvFilter] = useState("");
  useEffect(() => { setHistoryStvFilter(""); }, [historyItem?.id]);
  const historyStvOptions = Array.from(
    new Set((historyQuery.data?.items ?? []).map((ev) => ev.stv).filter((s): s is string => !!s)),
  );
  const historyEvents = historyStvFilter
    ? (historyQuery.data?.items ?? []).filter((ev) => ev.stv === historyStvFilter)
    : (historyQuery.data?.items ?? []);

  const [voidTarget, setVoidTarget] = useState<HistoryEvent | null>(null);
  const [voidReason, setVoidReason] = useState("");
  const voidMutation = useMutation({
    mutationFn: (payload: { id: number; reason: string }) =>
      apiRequest("POST", `/api/order-scan/events/${payload.id}/void`, { reason: payload.reason }).then((r) => r.json()),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["/api/order-scan/sessions"] });
      qc.invalidateQueries({ queryKey: ["/api/order-import/master-view/item-history"] });
      qc.invalidateQueries({ queryKey: ["/api/order-import/master-view"] });
      qc.invalidateQueries({ queryKey: ["/api/scan-sessions/reports/scan-history"] });
      qc.invalidateQueries({ queryKey: ["/api/scan-sessions/reports/plant-stock"] });
      setVoidTarget(null);
      setVoidReason("");
      toast({ title: "Scan voided", description: "Excluded from totals and stock; kept in history." });
    },
    onError: (err: any) => toast({ title: "Failed to void scan", description: err?.message, variant: "destructive" }),
  });

  const items = itemsQuery.data ?? [];

  const rowState = (item: OsScanItem) => {
    const exp = item.expectedQty ?? 0;
    const received = item.totalScannedQty ?? 0;
    return {
      exp,
      received,
      left: Math.max(0, exp - received),
      extra: extraByBarcode.get(normalize(item.barcode ?? "")) ?? 0,
    };
  };
  // qty ÷ its own items-per-pallet — never one blended pallet size for every item, same rule
  // used everywhere else in this app (osTotals in Scan.tsx, Overall Stock's Pallets column).
  const pltQty = (qty: number, ipp: number) => (qty > 0 && ipp > 0 ? qty / ipp : 0);

  // Same 4-tile Total/Received/Remaining/Extra strip as the Scan tab, including the pallet
  // figure under each count — computed the same way (osTotals in Scan.tsx): each item's own
  // qty ÷ its own itemsPerPallet, summed, never one blended pallet size for everything.
  const [statFilter, setStatFilter] = useState<"" | "done" | "remaining" | "extra">("");
  const totals = items.reduce((acc, i) => {
    const exp = i.expectedQty ?? 0;
    const received = i.totalScannedQty ?? 0;
    const ipp = i.itemsPerPallet ?? 0;
    const done = Math.min(received, exp);
    const remaining = Math.max(0, exp - received);
    acc.expected += exp;
    acc.done += done;
    acc.remaining += remaining;
    if (ipp > 0) {
      acc.palletsExpected += exp / ipp;
      acc.palletsDone += done / ipp;
      acc.palletsRemaining += remaining / ipp;
    }
    return acc;
  }, { expected: 0, done: 0, remaining: 0, extra: 0, palletsExpected: 0, palletsDone: 0, palletsRemaining: 0, palletsExtra: 0 });
  (extrasQuery.data ?? []).forEach((e) => {
    const qty = e.totalQty ?? 0;
    totals.extra += qty;
    const match = items.find((i) => normalize(i.barcode ?? "") === normalize(e.barcode));
    const ipp = match?.itemsPerPallet ?? 0;
    if (ipp > 0) totals.palletsExtra += qty / ipp;
  });

  // Excel-style per-column filters for the items table (Item, Exp, Received, Left, Extra,
  // Status) — matched client-side since this order's item list is already fully loaded (not
  // paginated the way Scan History is), same approach as Overall Stock.
  const [columnConditions, setColumnConditions] = useState<Record<string, FilterCondition>>({});
  const setColumnCondition = (columnId: string, condition: FilterCondition) =>
    setColumnConditions((prev) => ({ ...prev, [columnId]: condition }));
  const clearColumnCondition = (columnId: string) =>
    setColumnConditions((prev) => {
      const next = { ...prev };
      delete next[columnId];
      return next;
    });
  const filterableColumns: FilterableColumn<OsScanItem>[] = useMemo(() => {
    const textOptions = (pick: (i: OsScanItem) => string | null) =>
      Array.from(new Set(items.map(pick).filter((v): v is string => !!v)))
        .sort((a, b) => a.localeCompare(b))
        .map((v) => ({ value: v, label: v }));
    const numberOptions = (pick: (i: OsScanItem) => number) =>
      Array.from(new Set(items.map(pick)))
        .sort((a, b) => a - b)
        .map((v) => ({ value: String(v), label: v.toLocaleString() }));
    const palletOptions = (pick: (i: OsScanItem) => number) =>
      Array.from(new Set(items.map(pick)))
        .sort((a, b) => a - b)
        .map((v) => ({ value: String(v), label: v.toFixed(2) }));
    const dateOptions = (pick: (i: OsScanItem) => string | null) => {
      const days = new Set<string>();
      items.forEach((i) => { const raw = pick(i); if (raw) days.add(format(new Date(raw), "yyyy-MM-dd")); });
      return Array.from(days).sort().reverse().map((d) => ({ value: d, label: format(new Date(d), "MMM d, yyyy") }));
    };
    return [
      { id: "item", label: "Item", filterType: "text", options: textOptions((i) => i.itemName), accessor: (i) => i.itemName },
      { id: "barcode", label: "Barcode / SAP", filterType: "text", options: textOptions((i) => i.barcode), accessor: (i) => i.barcode },
      { id: "exp", label: "Exp", filterType: "number", options: numberOptions((i) => i.expectedQty ?? 0), accessor: (i) => i.expectedQty ?? 0 },
      { id: "received", label: "Received", filterType: "number", options: numberOptions((i) => i.totalScannedQty ?? 0), accessor: (i) => i.totalScannedQty ?? 0 },
      { id: "left", label: "Left", filterType: "number", options: numberOptions((i) => rowState(i).left), accessor: (i) => rowState(i).left },
      { id: "extra", label: "Extra", filterType: "number", options: numberOptions((i) => rowState(i).extra), accessor: (i) => rowState(i).extra },
      { id: "expPlt", label: "Exp Plt", filterType: "number", options: palletOptions((i) => pltQty(rowState(i).exp, i.itemsPerPallet ?? 0)), accessor: (i) => pltQty(rowState(i).exp, i.itemsPerPallet ?? 0) },
      { id: "receivedPlt", label: "Received Plt", filterType: "number", options: palletOptions((i) => pltQty(rowState(i).received, i.itemsPerPallet ?? 0)), accessor: (i) => pltQty(rowState(i).received, i.itemsPerPallet ?? 0) },
      { id: "leftPlt", label: "Left Plt", filterType: "number", options: palletOptions((i) => pltQty(rowState(i).left, i.itemsPerPallet ?? 0)), accessor: (i) => pltQty(rowState(i).left, i.itemsPerPallet ?? 0) },
      { id: "extraPlt", label: "Extra Plt", filterType: "number", options: palletOptions((i) => pltQty(rowState(i).extra, i.itemsPerPallet ?? 0)), accessor: (i) => pltQty(rowState(i).extra, i.itemsPerPallet ?? 0) },
      {
        id: "status", label: "Status", filterType: "enum",
        options: [
          { value: "complete", label: "Received" },
          { value: "partial", label: "Partial" },
          { value: "pending", label: "Pending" },
        ],
        accessor: (i) => i.status ?? "pending",
      },
      { id: "lastScanned", label: "Last Scanned", filterType: "date", options: dateOptions((i) => i.lastScannedAt), accessor: (i) => i.lastScannedAt },
    ];
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [items, extrasQuery.data]);
  const columnConditionList = useMemo(() => Object.values(columnConditions), [columnConditions]);

  // The single "+ Filter" entry point — every generic column in one searchable list, same
  // pattern as Overall Stock/Scan History (no special-cased dims here: Plant/Order Date are
  // already their own controls above, scoping which order this table even shows).
  const [filterPickerOpen, setFilterPickerOpen] = useState(false);
  const [filterPickerKey, setFilterPickerKey] = useState("");
  const [filterPickerSearch, setFilterPickerSearch] = useState("");
  const filterPickerOptions = useMemo(() => {
    const q = filterPickerSearch.trim().toLowerCase();
    return filterableColumns
      .filter((c) => !columnConditions[c.id])
      .filter((c) => !q || c.label.toLowerCase().includes(q))
      .map((c) => ({ key: c.id, label: c.label }));
  }, [filterableColumns, columnConditions, filterPickerSearch]);
  const pickedFilterColumn = filterableColumns.find((c) => c.id === filterPickerKey) ?? null;
  // Wraps a plain header label with the Excel-style filter icon — same columnHeader() pattern
  // as Overall Stock/Scan History.
  const columnHeader = (id: string, label: string) => {
    const col = filterableColumns.find((c) => c.id === id);
    if (!col) return label;
    return (
      <span className="inline-flex items-center gap-1">
        {label}
        <ColumnHeaderFilterButton
          column={col}
          condition={columnConditions[id]}
          onChange={(c) => setColumnCondition(id, c)}
          onRemove={() => clearColumnCondition(id)}
        />
      </span>
    );
  };

  const columnFiltered = useMemo(
    () => items.filter((i) => matchAllConditions(i, columnConditionList, filterableColumns)),
    [items, columnConditionList, filterableColumns],
  );
  const filtered = !statFilter
    ? columnFiltered
    : columnFiltered.filter((i) => {
        const { received, left, extra } = rowState(i);
        if (statFilter === "done") return received > 0;
        if (statFilter === "remaining") return left > 0;
        return extra > 0;
      });

  const selectedSession = sessionOptions.find((s) => s.id === sessionId) ?? null;

  // The item-history drill-down panel — same content for whichever row is currently expanded
  // (driven by historyItem, set from the Item column's click handler below).
  const historyPanel = (
    <div className="bg-gray-50 p-3">
      {historyQuery.isLoading ? (
        <div className="flex justify-center py-6"><Loader2 className="h-5 w-5 animate-spin text-[#001d6e]" /></div>
      ) : (historyQuery.data?.items?.length ?? 0) === 0 ? (
        <p className="py-4 text-center text-xs text-gray-400">No scans yet for this item in this order.</p>
      ) : (
        <>
        {historyStvOptions.length > 1 && (
          <div className="mb-2 flex items-center gap-2">
            <Label className="text-xs text-gray-500">STV</Label>
            <Select value={historyStvFilter || "__all__"} onValueChange={(v) => setHistoryStvFilter(v === "__all__" ? "" : v)}>
              <SelectTrigger className="h-7 w-40 text-xs"><SelectValue /></SelectTrigger>
              <SelectContent>
                <SelectItem value="__all__">All STVs</SelectItem>
                {historyStvOptions.map((s) => (
                  <SelectItem key={s} value={s}>{s}</SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
        )}
        <div className="max-h-72 overflow-y-auto border border-gray-200">
          <table className="w-full table-fixed border-collapse text-xs">
            <thead>
              <tr className="sticky top-0 z-10 border-b-2 border-gray-300 bg-gray-100 text-left text-gray-600">
                <th className="w-7 border-r border-gray-200 px-2 py-2 font-semibold">#</th>
                <th className="w-[122px] border-r border-gray-200 px-2 py-2 font-semibold">Date &amp; Time</th>
                <th className="border-r border-gray-200 px-2 py-2 font-semibold">Scanned By</th>
                <th className="w-16 border-r border-gray-200 px-2 py-2 font-semibold">STV</th>
                <th className="border-r border-gray-200 px-2 py-2 font-semibold">Order / Part</th>
                <th className="w-14 border-r border-gray-200 px-2 py-2 text-center font-semibold">Qty</th>
                <th className="w-16 border-r border-gray-200 px-2 py-2 font-semibold">Status</th>
                {canVoidScan && <th className="w-14 px-2 py-2 text-right font-semibold">Action</th>}
              </tr>
            </thead>
            <tbody>
              {historyEvents.map((ev, idx) => (
                <tr key={ev.id} className={`border-b border-gray-100 ${ev.voided ? "opacity-60" : "hover:bg-gray-50"} ${idx % 2 !== 0 ? "bg-slate-50" : "bg-white"}`}>
                  <td className="border-r border-gray-100 px-2 py-2 font-mono text-gray-400">{idx + 1}</td>
                  <td className="truncate border-r border-gray-100 px-2 py-2 text-gray-800">{format(new Date(ev.scannedAt), "MMM d · h:mm a")}</td>
                  <td className="truncate border-r border-gray-100 px-2 py-2 text-gray-600">{ev.scannedByName ?? "—"}</td>
                  <td className="truncate border-r border-gray-100 px-2 py-2 font-mono text-gray-600">{ev.stv ?? "—"}</td>
                  <td className="truncate border-r border-gray-100 px-2 py-2 text-gray-600">
                    {ev.orderName?.replace(/\.csv$/i, "")}{ev.partIndex ? ` · Part ${ev.partIndex}` : ""}
                  </td>
                  <td className="border-r border-gray-100 px-2 py-2 text-center">
                    <span className={`inline-flex items-center justify-center rounded-full px-2 py-0.5 text-[11px] font-bold ${ev.isExtra ? "bg-amber-100 text-amber-700" : "bg-[#001d6e]/10 text-[#001d6e]"}`}>
                      {ev.isExtra ? "+" : ""}{ev.totalQty}
                    </span>
                  </td>
                  <td className="truncate border-r border-gray-100 px-2 py-2 text-[11px]">
                    {ev.voided ? (
                      <span className="font-medium text-red-500" title={ev.voidReason ?? undefined}>Voided</span>
                    ) : ev.isExtra ? (
                      <span className="font-semibold uppercase text-amber-700">Extra</span>
                    ) : (
                      <span className="text-gray-400">—</span>
                    )}
                  </td>
                  {canVoidScan && (
                    <td className="px-2 py-2 text-right">
                      {!ev.voided && (
                        <Button
                          size="sm" variant="ghost"
                          className="h-6 px-2 text-[11px] text-red-600 hover:bg-red-50 hover:text-red-700"
                          onClick={() => setVoidTarget(ev)}
                        >
                          Void
                        </Button>
                      )}
                    </td>
                  )}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        </>
      )}
    </div>
  );

  const headerBorder = "border-r border-white/10";
  const cellBorder = "border-r border-gray-200";

  const itemColumns: DataTableColumn<OsScanItem>[] = [
    {
      id: "item",
      header: columnHeader("item", "Item"),
      hideable: false,
      width: 260,
      sortable: true,
      accessor: (row) => `${row.itemName ?? ""} ${row.barcode ?? ""} ${row.sapCode ?? ""}`,
      totalable: false,
      headerClassName: headerBorder,
      cellClassName: `min-w-[180px] max-w-[320px] whitespace-normal break-words ${cellBorder}`,
      render: (row) => {
        const isOpen = historyItem?.id === row.id;
        return (
          <>
            <button
              type="button"
              disabled={!row.barcode}
              onClick={() => setHistoryItem((cur) => (cur?.id === row.id ? null : row))}
              className={`whitespace-normal break-words text-left font-medium leading-snug text-gray-900 underline decoration-dotted underline-offset-2 disabled:no-underline ${isOpen ? "text-[#001d6e] decoration-[#001d6e]" : "decoration-gray-300"}`}
            >
              {row.itemName ?? "—"}
            </button>
            <p className="whitespace-normal break-words font-mono text-xs text-gray-400">
              {row.barcode ?? "—"}{row.sapCode && ` · SAP ${row.sapCode}`}
            </p>
          </>
        );
      },
    },
    {
      id: "exp",
      header: columnHeader("exp", "Exp"),
      width: 80,
      align: "right",
      sortable: true,
      accessor: (row) => row.expectedQty ?? 0,
      headerClassName: headerBorder,
      cellClassName: `tabular-nums text-gray-600 ${cellBorder}`,
      render: (row) => rowState(row).exp || "—",
    },
    {
      id: "received",
      header: columnHeader("received", "Received"),
      width: 90,
      align: "right",
      sortable: true,
      accessor: (row) => row.totalScannedQty ?? 0,
      headerClassName: headerBorder,
      cellClassName: `tabular-nums font-semibold text-gray-900 ${cellBorder}`,
      render: (row) => rowState(row).received,
    },
    {
      id: "left",
      header: columnHeader("left", "Left"),
      width: 80,
      align: "right",
      sortable: true,
      accessor: (row) => rowState(row).left,
      headerClassName: headerBorder,
      cellClassName: cellBorder,
      render: (row) => {
        const { left } = rowState(row);
        return <span className={`tabular-nums font-semibold ${left > 0 ? "text-[#001d6e]" : "text-gray-300"}`}>{left || "—"}</span>;
      },
    },
    {
      id: "extra",
      header: columnHeader("extra", "Extra"),
      width: 80,
      align: "right",
      sortable: true,
      accessor: (row) => rowState(row).extra,
      headerClassName: headerBorder,
      cellClassName: cellBorder,
      render: (row) => {
        const { extra } = rowState(row);
        return <span className={`tabular-nums font-semibold ${extra > 0 ? "text-amber-600" : "text-gray-300"}`}>{extra > 0 ? `+${extra}` : "—"}</span>;
      },
    },
    // Pallet columns, their own columns rather than a subline under each qty cell — same
    // Exp → Received → Left → Extra order as the qty block above, matching the Master View
    // table's own Exp Plt/Received Plt/Remain Plt/Extra Plt columns in Scan.tsx.
    {
      id: "expPlt",
      header: columnHeader("expPlt", "Exp Plt"),
      width: 80,
      align: "right",
      sortable: true,
      accessor: (row) => pltQty(rowState(row).exp, row.itemsPerPallet ?? 0),
      headerClassName: headerBorder,
      cellClassName: `tabular-nums text-gray-500 ${cellBorder}`,
      render: (row) => pltQty(rowState(row).exp, row.itemsPerPallet ?? 0).toFixed(2),
    },
    {
      id: "receivedPlt",
      header: columnHeader("receivedPlt", "Received Plt"),
      width: 90,
      align: "right",
      sortable: true,
      accessor: (row) => pltQty(rowState(row).received, row.itemsPerPallet ?? 0),
      headerClassName: headerBorder,
      cellClassName: `tabular-nums font-semibold text-[#001d6e] ${cellBorder}`,
      render: (row) => pltQty(rowState(row).received, row.itemsPerPallet ?? 0).toFixed(2),
    },
    {
      id: "leftPlt",
      header: columnHeader("leftPlt", "Left Plt"),
      width: 80,
      align: "right",
      sortable: true,
      accessor: (row) => pltQty(rowState(row).left, row.itemsPerPallet ?? 0),
      headerClassName: headerBorder,
      cellClassName: `tabular-nums font-semibold text-purple-600 ${cellBorder}`,
      render: (row) => pltQty(rowState(row).left, row.itemsPerPallet ?? 0).toFixed(2),
    },
    {
      id: "extraPlt",
      header: columnHeader("extraPlt", "Extra Plt"),
      width: 80,
      align: "right",
      sortable: true,
      accessor: (row) => pltQty(rowState(row).extra, row.itemsPerPallet ?? 0),
      headerClassName: headerBorder,
      cellClassName: `tabular-nums font-semibold text-amber-600 ${cellBorder}`,
      render: (row) => pltQty(rowState(row).extra, row.itemsPerPallet ?? 0).toFixed(2),
    },
    {
      id: "status",
      header: columnHeader("status", "Status"),
      width: 100,
      align: "center",
      sortable: true,
      accessor: (row) => row.status ?? "pending",
      totalable: false,
      render: (row) => {
        const status = row.status ?? "pending";
        return (
          <span className={`inline-block px-2.5 py-1 text-xs font-semibold ${
            status === "complete" ? "bg-emerald-100 text-emerald-700" :
            status === "partial"  ? "bg-amber-100 text-amber-700" : "bg-gray-100 text-gray-500"
          }`}>
            {status === "complete" ? "Received" : status === "partial" ? "Partial" : "Pending"}
          </span>
        );
      },
    },
    {
      id: "lastScanned",
      header: columnHeader("lastScanned", "Last Scanned"),
      width: 130,
      sortable: true,
      accessor: (row) => row.lastScannedAt,
      totalable: false,
      cellClassName: "text-gray-500 whitespace-nowrap",
      render: (row) => (row.lastScannedAt ? format(new Date(row.lastScannedAt), "MMM d, yyyy · h:mm a") : <span className="text-gray-300">—</span>),
    },
  ];

  return (
    <div className="flex-1 overflow-y-auto bg-gray-50 p-4 lg:p-6">
      <div className="mx-auto max-w-6xl space-y-4">
        <PageHeader icon={Eye} title="Scan Viewer" description="Look up any order's scan progress by plant and date — view-only, with the ability to void a mistaken scan if you're allowed to." />

        {/* Plant switcher — unboxed, same exact markup/style as the Scan page's own "Active:"
            switcher (no bordered card wrapper) — scoped to this user's own assigned plants (all
            plants for admins), not a generic dropdown of every plant in the system. Order
            Date/Part sit inline right after it, same unboxed treatment. */}
        <div className="flex flex-wrap items-center gap-1.5 bg-white sm:bg-transparent px-3 py-2 sm:px-0 sm:py-0 border-b sm:border-0 border-gray-100">
          <span className="text-[10px] sm:text-xs font-semibold uppercase tracking-wide text-gray-400 mr-1">Plant:</span>
          {plantOptions.length === 0 ? (
            <span className="text-xs text-gray-400">No plants assigned to your account.</span>
          ) : (
            plantOptions.map((p) => (
              <button
                key={p}
                type="button"
                onClick={() => selectPlant(p)}
                className={`rounded-full px-3 py-1 text-xs font-semibold transition-colors ${
                  plant === p
                    ? "bg-[#001d6e] text-white"
                    : "border border-gray-200 bg-white text-gray-600 hover:bg-gray-50"
                }`}
              >
                {p}
              </button>
            ))
          )}

          <span className="ml-2 flex items-center gap-1.5">
            <Input type="date" className="h-8 w-auto text-xs" value={date} onChange={(e) => { setDate(e.target.value); setSessionId(null); }} />
            {/* Which date is actually being shown right now — the date input alone doesn't
                read clearly at a glance, and it's easy to lose track of after switching plants
                (each plant snaps to its own active date). */}
            {sessionOptions.length > 1 && (
              <Select value={sessionId ? String(sessionId) : ""} onValueChange={(v) => setSessionId(Number(v))}>
                <SelectTrigger className="h-8 w-36 text-xs"><SelectValue placeholder="Select part…" /></SelectTrigger>
                <SelectContent>
                  {sessionOptions.map((s) => (
                    <SelectItem key={s.id} value={String(s.id)}>
                      Part {s.partIndex ?? "—"} · {s.scanStatus ?? "—"}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            )}
          </span>
        </div>

        {!filtersReady ? (
          <div className="rounded-xl border border-dashed border-gray-300 bg-white py-16 text-center text-sm text-gray-400">
            Pick a plant and an order date to view its scan progress.
          </div>
        ) : sessionsQuery.isLoading ? (
          <div className="flex justify-center py-16"><Loader2 className="h-6 w-6 animate-spin text-[#001d6e]" /></div>
        ) : sessionOptions.length === 0 ? (
          <div className="rounded-xl border border-dashed border-gray-300 bg-white py-16 text-center text-sm text-gray-400">
            No order found for {plant} on {date}.
          </div>
        ) : (
          <>
          {/* Same 4-tile Total/Received/Remaining/Extra strip as the Scan tab — count plus a
              pallet total under each, each tile click-to-filter the table below. */}
          <div className="grid grid-cols-4 divide-x divide-gray-200 overflow-hidden rounded-xl border border-gray-300 bg-white">
            {([
              { key: "", label: "Total", value: totals.expected, plt: totals.palletsExpected, text: "text-gray-900" },
              { key: "done", label: "Received", value: totals.done, plt: totals.palletsDone, text: "text-emerald-600" },
              { key: "remaining", label: "Remaining", value: totals.remaining, plt: totals.palletsRemaining, text: "text-red-600" },
              { key: "extra", label: "Extra", value: totals.extra, plt: totals.palletsExtra, text: totals.extra > 0 ? "text-amber-600" : "text-gray-300" },
            ] as const).map((s) => {
              const isActive = statFilter === s.key;
              return (
                <button
                  key={s.label}
                  type="button"
                  onClick={() => setStatFilter(isActive ? "" : (s.key as typeof statFilter))}
                  aria-pressed={isActive}
                  title={s.key ? `Show only ${s.label.toLowerCase()} items` : "Show all items"}
                  className={`text-center px-2 py-3 transition-colors ${isActive ? "bg-[#001d6e]/[0.06] ring-1 ring-inset ring-[#001d6e]/30" : "hover:bg-gray-50"}`}
                >
                  <p className="text-[11px] uppercase tracking-wide text-gray-400">{s.label}</p>
                  <p className={`font-bold text-xl ${s.text}`}>{s.value}</p>
                  <p className={`font-bold text-lg ${s.text}`}>{s.plt.toFixed(2)} plt</p>
                </button>
              );
            })}
          </div>

          {/* Same TableCard + DataTable used by Overall Stock/Reports — navy header, built-in
              search, zebra stripes — plus the same Excel-style filtering: a filter icon on each
              column header, a unified "+ Filter" picker, and a "Filters (N)" summary. */}
          <TableCard
            icon={Eye}
            title={selectedSession?.csvFileName ?? "Items"}
            subtitle={
              <span className="flex items-center gap-2">
                <PlantBadge plant={plant} />
                {selectedSession?.scanStatus && (
                  <span className="uppercase tracking-wide">{selectedSession.scanStatus}</span>
                )}
              </span>
            }
            className="rounded-xl shadow-sm border-gray-200"
            searchValue={search}
            onSearchChange={setSearch}
            searchPlaceholder="Search items…"
            headerActions={
              <>
                {/* One unified "+ Filter" — every generic column (Item, Barcode/SAP, Exp,
                    Received, Left, Extra, Status, pallet columns, Last Scanned) in one
                    searchable list. */}
                <Popover
                  open={filterPickerOpen}
                  onOpenChange={(open) => {
                    setFilterPickerOpen(open);
                    if (!open) { setFilterPickerKey(""); setFilterPickerSearch(""); }
                  }}
                >
                  <PopoverTrigger asChild>
                    <Button
                      size="sm"
                      variant="outline"
                      className="h-8 gap-1 rounded-md border-dashed border-[#001d6e]/40 bg-white text-xs font-medium text-[#001d6e] hover:bg-[#001d6e]/5 hover:text-[#001d6e]"
                    >
                      <Plus className="h-3.5 w-3.5" /> Filter
                    </Button>
                  </PopoverTrigger>
                  <PopoverContent align="start" className="w-64">
                    {filterPickerKey === "" ? (
                      <div className="space-y-1.5">
                        <Input
                          className="h-8 text-xs"
                          placeholder="Find a filter…"
                          value={filterPickerSearch}
                          onChange={(e) => setFilterPickerSearch(e.target.value)}
                          autoFocus
                        />
                        <div className="max-h-56 overflow-y-auto">
                          {filterPickerOptions.length === 0 ? (
                            <div className="px-2 py-1.5 text-xs text-gray-400">
                              {filterPickerSearch ? "No matches" : "All filters added"}
                            </div>
                          ) : (
                            filterPickerOptions.map((d) => (
                              <button
                                key={d.key}
                                type="button"
                                onClick={() => setFilterPickerKey(d.key)}
                                className="block w-full rounded px-2 py-1.5 text-left text-xs text-gray-700 hover:bg-[#001d6e]/5 hover:text-[#001d6e]"
                              >
                                {d.label}
                              </button>
                            ))
                          )}
                        </div>
                      </div>
                    ) : pickedFilterColumn ? (
                      <div className="space-y-2">
                        <button
                          type="button"
                          onClick={() => setFilterPickerKey("")}
                          className="flex items-center gap-1 text-[11px] text-gray-400 hover:text-gray-600"
                        >
                          <ChevronLeft className="h-3 w-3" /> Back
                        </button>
                        <ColumnFilterPopoverContent
                          column={pickedFilterColumn}
                          onApply={(c) => {
                            setColumnCondition(pickedFilterColumn.id, c);
                            setFilterPickerOpen(false);
                            setFilterPickerKey("");
                          }}
                          onCancel={() => setFilterPickerKey("")}
                        />
                      </div>
                    ) : null}
                  </PopoverContent>
                </Popover>

                {Object.keys(columnConditions).length > 0 && (
                  <Button size="sm" variant="ghost" className="h-8 px-2 text-xs text-gray-500 hover:text-gray-900" onClick={() => setColumnConditions({})}>
                    Clear all
                  </Button>
                )}

                {/* Every active column filter in one list, with its own remove button. */}
                {Object.keys(columnConditions).length > 0 && (
                  <Popover>
                    <PopoverTrigger asChild>
                      <Button size="sm" variant="outline" className="h-8 rounded-full border-0 bg-[#001d6e] text-xs text-white hover:bg-[#001552] hover:text-white">
                        <ListFilter className="h-3.5 w-3.5 mr-1" />
                        Filters ({Object.keys(columnConditions).length})
                      </Button>
                    </PopoverTrigger>
                    <PopoverContent align="end" className="w-72">
                      <div className="space-y-0.5">
                        <p className="mb-1 text-[11px] font-semibold uppercase tracking-wide text-gray-500">Active filters</p>
                        {Object.entries(columnConditions).map(([columnId, condition]) => (
                          <div key={columnId} className="flex items-center justify-between gap-2 rounded px-1.5 py-1 text-xs hover:bg-gray-50">
                            <span className="text-gray-700">{conditionSummary(condition, filterableColumns)}</span>
                            <button type="button" onClick={() => clearColumnCondition(columnId)} className="text-gray-400 hover:text-red-500" aria-label="Remove filter">
                              <X className="h-3.5 w-3.5" />
                            </button>
                          </div>
                        ))}
                      </div>
                    </PopoverContent>
                  </Popover>
                )}
              </>
            }
          >
            <DataTable<OsScanItem>
              className="space-y-0"
              containerClassName="rounded-none border-0"
              headerClassName="bg-[#001d6e] text-white border-[#1a3a9c] hover:bg-[#0a2b7e] hover:text-white"
              columns={itemColumns}
              data={filtered}
              getRowId={(row) => String(row.id)}
              isLoading={itemsQuery.isLoading}
              enableSearch
              searchValue={search}
              onSearchChange={setSearch}
              searchableColumnIds={["item"]}
              enableZebraStripes
              rowClassName={(row) => {
                const status = row.status ?? "pending";
                return status === "complete" ? "bg-emerald-50/40" : status === "partial" ? "bg-amber-50/30" : undefined;
              }}
              renderExpandedRow={() => historyPanel}
              isRowExpandable={(row) => !!row.barcode}
              expandedRowId={historyItem ? String(historyItem.id) : null}
              emptyState={items.length === 0 ? "No items in this order." : "No items match your filters."}
            />
          </TableCard>
          </>
        )}
      </div>

      {/* Void confirmation — same rule as Scan/Scan History's own void dialog. */}
      <Dialog open={!!voidTarget} onOpenChange={(o) => { if (!o) { setVoidTarget(null); setVoidReason(""); } }}>
        <DialogContent className="w-[calc(100%-2rem)] max-w-sm">
          <DialogHeader>
            <DialogTitle className="text-red-600">Void this scan?</DialogTitle>
            <DialogDescription>
              This reverses its stock impact and excludes it from totals — the entry stays visible in history, marked as voided.
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-1.5 py-1">
            <Label htmlFor="scan-viewer-void-reason" className="text-xs">Reason</Label>
            <Input
              id="scan-viewer-void-reason"
              value={voidReason}
              onChange={(e) => setVoidReason(e.target.value)}
              placeholder="e.g. scanned wrong item, duplicate scan"
              autoFocus
            />
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => { setVoidTarget(null); setVoidReason(""); }}>Cancel</Button>
            <Button
              className="bg-red-600 text-white hover:bg-red-700"
              disabled={voidMutation.isPending || !voidReason.trim()}
              onClick={() => voidTarget && voidMutation.mutate({ id: voidTarget.id, reason: voidReason.trim() })}
            >
              {voidMutation.isPending ? <Loader2 className="h-4 w-4 animate-spin" /> : "Void Scan"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
