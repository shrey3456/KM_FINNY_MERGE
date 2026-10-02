import { useEffect, useMemo, useState } from "react";
import { useQuery, useMutation } from "@tanstack/react-query";
import { apiRequest, queryClient } from "@/lib/queryClient";
import { Card } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";
import {
  Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle,
} from "@/components/ui/dialog";
import {
  Select, SelectContent, SelectItem, SelectTrigger, SelectValue,
} from "@/components/ui/select";
import { useToast } from "@/hooks/use-toast";
import { useAuth } from "@/hooks/use-auth";
import { buildPageList, DataTable, type DataTableColumn } from "@/components/ui/data-table";
import {
  AddColumnFilterButton, ColumnFilterChipView, ColumnHeaderFilterButton,
} from "@/components/filters/ColumnFilterChip";
import {
  isConditionEmpty, type FilterableColumn, type FilterCondition,
} from "@/lib/columnFilters";
import { Label } from "@/components/ui/label";
import { PlantBadge } from "@/components/PlantBadge";
import { SectionSkeleton, SkeletonBar, TableSkeleton } from "@/components/ui/loading-skeletons";
import { ZoomableImg } from "@/components/ProductPhoto";
import {
  AlertTriangle, ArrowLeft, ArrowRightLeft, CheckCircle2, ChevronLeft, ChevronRight,
  ChevronDown, ClipboardList, Loader2, Package, Pause, Plus, RotateCcw, Search, Trash2, User, X,
} from "lucide-react";

// Sort Slip — godown picking.
//
// Two views in one page, the same shape as Load Operations: a landing list of slips, and the
// slip itself. What a person sees depends on what they hold:
//   • write access (supervisor) → every slip in their plants, and the buttons that move work
//     around: create from an order, transfer, complete, delete
//   • view access (loader)      → only the slips assigned to them, where the single thing they
//     can do is say how much of an item they have picked
// The server enforces all of that; this file only decides what to draw. And nothing here counts
// as a load operation — see server/routes/sort-slips.ts.

type SortSlipRow = {
  id: number;
  orderNumber: string;
  partyName: string | null;
  plant: string | null;
  orderDate: string | null;
  totalQty: number;
  pickedQty: number;
  platformStv: string | null;
  status: "unassigned" | "active" | "paused" | "completed";
  createdByName: string | null;
  createdAt: string;
  completedAt: string | null;
  completedByName: string | null;
  managedByCode: string | null;
  managedByName: string | null;
  assignees: Array<{ userCode: string; userName: string | null }>;
};

type SortSlipItem = {
  id: number;
  srNo: string | null;
  barcode: string | null;
  sapCode: string | null;
  itemName: string | null;
  expectedQty: number;
  pickedQty: number;
  productId: number | null;
  hasBoxImage: boolean;
  hasProductImage: boolean;
  /** Pieces per pallet at this slip's plant; 0 when Product Master has no size for it. */
  palletSize: number;
};

type Loader = {
  userCode: string;
  name: string | null;
  username: string;
  department: string | null;
  designation: string | null;
  activeSlipId: number | null;
  activeOrderNumber: string | null;
  plants: string | null;
  role: string | null;
};

// GET /sort-slips/supervisors' exact mirror of the loader shape, minus the "busy on one active
// slip" fields that only make sense for a loader — a supervisor can manage any number of slips.
type Supervisor = { userCode: string; name: string | null; username: string; department: string | null; designation: string | null; plants: string | null; role: string | null };

const STATUS_STYLES: Record<string, string> = {
  unassigned: "border-gray-200 bg-gray-50 text-gray-600",
  active: "border-blue-200 bg-blue-50 text-blue-700",
  paused: "border-amber-200 bg-amber-50 text-amber-700",
  completed: "border-green-200 bg-green-50 text-green-700",
};

const STATUS_LABELS: Record<string, string> = {
  unassigned: "Needs a loader",
  active: "Active",
  paused: "Paused",
  completed: "Completed",
};

// The carton photo, falling back to the product shot and then to nothing. Box Image is what a
// loader recognises a line by on the floor — a carton, not the packet inside it — which is why
// the item list leads with it.
function ItemPhoto({ item, size = 40, className }: { item: SortSlipItem; size?: number; className?: string }) {
  const [failed, setFailed] = useState(false);
  const src = !item.productId || failed
    ? null
    : item.hasBoxImage
      ? `/api/products/box-image-by-id?id=${item.productId}`
      : item.hasProductImage
        ? `/api/products/image-by-id?id=${item.productId}`
        : null;
  if (!src) {
    return (
      <div
        className={`flex items-center justify-center rounded border border-gray-200 bg-gray-50 text-gray-300 ${className ?? ""}`}
        style={className ? undefined : { width: size, height: size }}
      >
        <Package className="h-4 w-4" />
      </div>
    );
  }
  return (
    <ZoomableImg
      src={src}
      alt={item.itemName ?? ""}
      title={item.itemName}
      onError={() => setFailed(true)}
      className={`rounded border border-gray-200 bg-white object-contain ${className ?? ""}`}
      style={className ? undefined : { width: size, height: size }}
    />
  );
}

// Timestamps on this page all read the same way: Indian time, short date, 24-hour clock.
function fmtWhen(value: string | null) {
  return value
    ? new Date(value).toLocaleString("en-IN", {
        timeZone: "Asia/Kolkata", day: "2-digit", month: "short", hour: "2-digit", minute: "2-digit",
      })
    : "—";
}

function ProgressBar({ picked, total }: { picked: number; total: number }) {
  const pct = total > 0 ? Math.min(100, Math.round((picked / total) * 100)) : 0;
  return (
    <div className="flex items-center gap-2">
      <div className="h-1.5 w-16 overflow-hidden rounded-full bg-gray-100">
        <div
          className={`h-full rounded-full ${pct >= 100 ? "bg-green-500" : "bg-[#001d6e]"}`}
          style={{ width: `${pct}%` }}
        />
      </div>
      <span className="tabular-nums text-xs text-gray-600">
        {picked.toLocaleString()} / {total.toLocaleString()}
      </span>
    </div>
  );
}

export default function SortSlips() {
  const { toast } = useToast();
  const { user } = useAuth();

  // The slip being looked at, and whether the create popup is open, both remembered: coming back
  // to Sort Slip puts you back where you were rather than on the landing list.
  const [openOrder, setOpenOrder] = useState<string | null>(() => {
    try { return localStorage.getItem("sortSlip:openOrder") || null; } catch { return null; }
  });
  useEffect(() => {
    try {
      if (openOrder) localStorage.setItem("sortSlip:openOrder", openOrder);
      else localStorage.removeItem("sortSlip:openOrder");
    } catch { /* storage unavailable */ }
  }, [openOrder]);
  const [createOpen, setCreateOpen] = useState(false);

  // "Transfer to Supervisor" — a per-row action on the landing list, right next to Delete/Open
  // (loaders untouched, only WHO manages the slip changes). The row itself picks the slip, so
  // this only needs to remember which row and which target supervisor.
  const [transferSupRow, setTransferSupRow] = useState<SortSlipRow | null>(null);
  const [transferSupTarget, setTransferSupTarget] = useState("");
  const [transferSupSearch, setTransferSupSearch] = useState("");

  // ── Landing list ───────────────────────────────────────────────────────────
  const [search, setSearch] = useState("");
  const [statusTab, setStatusTab] = useState<"" | "unassigned" | "active" | "paused" | "completed">("");
  const [pageIndex, setPageIndex] = useState(0);
  const [pageSize, setPageSize] = useState(25);
  const [conditions, setConditions] = useState<Record<string, FilterCondition>>({});

  const filtersJson = useMemo(() => {
    const list = Object.values(conditions).filter((c) => !isConditionEmpty(c));
    return list.length > 0 ? JSON.stringify(list) : undefined;
  }, [conditions]);

  const listQuery = useQuery({
    queryKey: ["/api/sort-slips", search, statusTab, filtersJson, pageIndex, pageSize],
    queryFn: async () => {
      const params = new URLSearchParams({
        limit: String(pageSize),
        offset: String(pageIndex * pageSize),
      });
      if (search.trim()) params.set("search", search.trim());
      if (statusTab) params.set("status", statusTab);
      if (filtersJson) params.set("filters", filtersJson);
      const res = await apiRequest("GET", `/api/sort-slips?${params.toString()}`);
      return res.json() as Promise<{
        records: SortSlipRow[];
        total: number;
        canWrite: boolean;
        filterValues: Record<string, string[]>;
      }>;
    },
  });

  const canWrite = listQuery.data?.canWrite ?? false;
  const rows = listQuery.data?.records ?? [];
  const total = listQuery.data?.total ?? 0;
  const pageCount = Math.max(1, Math.ceil(total / pageSize));
  const filterValues = listQuery.data?.filterValues ?? {};

  // Server-paginated, so these conditions are sent to the backend rather than matched here —
  // filtering only the page on screen would leave every other page unfiltered. `accessor` is
  // present because FilterableColumn asks for it, and is never called.
  const asOptions = (values?: string[]) => (values ?? []).map((v) => ({ value: v, label: v }));
  const filterColumns: FilterableColumn<SortSlipRow>[] = useMemo(() => [
    { id: "orderNumber", label: "Order", filterType: "text", options: [], disableValues: true, accessor: (r) => r.orderNumber },
    { id: "partyName", label: "Party", filterType: "text", options: asOptions(filterValues.partyName), accessor: (r) => r.partyName },
    { id: "plant", label: "Plant", filterType: "enum", options: asOptions(filterValues.plant), accessor: (r) => r.plant },
    { id: "orderDate", label: "Order Date", filterType: "date", options: asOptions(filterValues.orderDate), accessor: (r) => r.orderDate },
    { id: "assignee", label: "Loaders", filterType: "text", options: asOptions(filterValues.assignee), accessor: (r) => r.assignees.map((a) => a.userName ?? a.userCode) },
    { id: "pickedQty", label: "Picked", filterType: "number", options: [], disableValues: true, accessor: (r) => r.pickedQty },
    { id: "totalQty", label: "Total Qty", filterType: "number", options: [], disableValues: true, accessor: (r) => r.totalQty },
    { id: "status", label: "Status", filterType: "enum", options: asOptions(filterValues.status), accessor: (r) => r.status },
    { id: "createdByName", label: "Created By", filterType: "text", options: [], disableValues: true, accessor: (r) => r.createdByName },
  ], [listQuery.data]);

  const setCondition = (id: string, condition: FilterCondition) => {
    setConditions((prev) => ({ ...prev, [id]: condition }));
    setPageIndex(0);
  };
  const clearCondition = (id: string) => {
    setConditions((prev) => { const next = { ...prev }; delete next[id]; return next; });
    setPageIndex(0);
  };
  const header = (id: string, label: string) => {
    const column = filterColumns.find((c) => c.id === id);
    return (
      <span className="inline-flex items-center gap-1">
        {label}
        {column && (
          <ColumnHeaderFilterButton
            column={column}
            condition={conditions[id]}
            onChange={(c) => setCondition(id, c)}
            onRemove={() => clearCondition(id)}
            initialTab={column.disableValues ? "condition" : "values"}
          />
        )}
      </span>
    );
  };

  const refreshAll = () => {
    queryClient.invalidateQueries({ queryKey: ["/api/sort-slips"] });
    if (openOrder) queryClient.invalidateQueries({ queryKey: ["/api/sort-slips", "detail", openOrder] });
  };

  // Supervisors this caller could hand a slip off to — fetched only once the dialog is
  // actually open, same lazy pattern the per-slip loader Transfer's own picker uses.
  const supervisorsQuery = useQuery({
    queryKey: ["/api/sort-slips/supervisors"],
    enabled: !!transferSupRow,
    queryFn: async () => {
      const res = await apiRequest("GET", `/api/sort-slips/supervisors`);
      return res.json() as Promise<Supervisor[]>;
    },
  });
  const supervisors = (supervisorsQuery.data ?? []).filter((s) => s.userCode !== user?.userCode);

  const transferSupMutation = useMutation({
    mutationFn: async () => {
      const res = await apiRequest("POST", "/api/sort-slips/transfer-supervisor", {
        slipIds: [transferSupRow!.id], toSupervisorCode: transferSupTarget,
      });
      return res.json() as Promise<{ moved: number[]; skipped: Array<{ id: number; reason: string }>; toSupervisorName: string }>;
    },
    onSuccess: (data) => {
      if (data.moved.length > 0) {
        toast({ title: `${transferSupRow?.orderNumber} handed to ${data.toSupervisorName}` });
        setTransferSupRow(null);
        setTransferSupTarget("");
        setTransferSupSearch("");
        refreshAll();
      } else {
        toast({ title: "Could not transfer", description: data.skipped[0]?.reason, variant: "destructive" });
      }
    },
    onError: (err: any) => toast({ title: "Could not transfer", description: err.message, variant: "destructive" }),
  });

  // ── Create ─────────────────────────────────────────────────────────────────
  const [orderSearch, setOrderSearch] = useState("");
  const [pickedOrder, setPickedOrder] = useState<any | null>(null);
  // One loader, not a set: a slip is handed to a person, and it changes hands by transfer.
  const [pickedLoader, setPickedLoader] = useState<string>("");
  // STV (platform) — same per-plant plantStvs concept Loading's Create Operation dialog uses.
  // Write-once at creation, same as proformaSlips.loadingStv; a pick event never carries its own.
  const [pickedStv, setPickedStv] = useState<string>("");
  const [loaderSearch, setLoaderSearch] = useState("");
  const [orderSuggIdx, setOrderSuggIdx] = useState(-1);
  const [deleteTarget, setDeleteTarget] = useState<SortSlipRow | null>(null);

  // An unfinished "New Sort Slip" survives leaving the page. Someone picks the order, goes to
  // User Management to give a loader the page, comes back — and the popup is where they left it
  // instead of starting from the search box again. Cleared as soon as the slip is created or the
  // popup is cancelled.
  const DRAFT_KEY = "sortSlip:createDraft";
  useEffect(() => {
    try {
      const raw = localStorage.getItem(DRAFT_KEY);
      if (!raw) return;
      const draft = JSON.parse(raw);
      if (draft?.order) {
        setPickedOrder(draft.order);
        setPickedLoader(draft.loaderCode ?? "");
        setPickedStv(draft.platformStv ?? "");
        setCreateOpen(true);
      }
    } catch { /* storage unavailable — the popup just opens empty */ }
  }, []);
  useEffect(() => {
    try {
      if (createOpen && pickedOrder) {
        localStorage.setItem(DRAFT_KEY, JSON.stringify({ order: pickedOrder, loaderCode: pickedLoader, platformStv: pickedStv }));
      }
    } catch { /* storage unavailable */ }
  }, [createOpen, pickedOrder, pickedLoader, pickedStv]);
  const clearDraft = () => {
    setPickedOrder(null);
    setPickedLoader("");
    setPickedStv("");
    setLoaderSearch("");
    setOrderSuggIdx(-1);
    try { localStorage.removeItem(DRAFT_KEY); } catch { /* storage unavailable */ }
  };

  const orderQuery = useQuery({
    queryKey: ["/api/sort-slips/orders/search", orderSearch],
    enabled: createOpen,
    queryFn: async () => {
      const res = await apiRequest("GET", `/api/sort-slips/orders/search?q=${encodeURIComponent(orderSearch)}`);
      return res.json() as Promise<any[]>;
    },
  });

  // Who this order can be given to: granted the page AND holding its plant, both decided by the
  // server. Keyed on the picked order's plant, so choosing a different order re-asks.
  // The order itself — header numbers and its item list — read before any slip exists, so the
  // supervisor sees what they are handing out while they are handing it out.
  const previewQuery = useQuery({
    queryKey: ["/api/sort-slips/orders/preview", pickedOrder?.orderNumber ?? ""],
    enabled: createOpen && !!pickedOrder,
    queryFn: async () => {
      const res = await apiRequest("GET", `/api/sort-slips/orders/${encodeURIComponent(pickedOrder.orderNumber)}/preview`);
      return res.json() as Promise<{ order: any; items: Array<{ id: number; srNo: string | null; barcode: string | null; itemName: string | null; quantity: number }> }>;
    },
  });

  const loadersQuery = useQuery({
    queryKey: ["/api/sort-slips/loaders", pickedOrder?.plant ?? ""],
    enabled: canWrite && createOpen && !!pickedOrder,
    queryFn: async () => {
      const res = await apiRequest("GET", `/api/sort-slips/loaders?plant=${encodeURIComponent(pickedOrder?.plant ?? "")}`);
      return res.json() as Promise<Loader[]>;
    },
  });

  // The order's plant's STV list — same endpoint Loading's Create Operation dialog uses.
  const stvsQuery = useQuery({
    queryKey: ["/api/order-scan/stvs", pickedOrder?.plant ?? ""],
    enabled: createOpen && !!pickedOrder?.plant,
    queryFn: async () => {
      const res = await apiRequest("GET", `/api/order-scan/stvs?plant=${encodeURIComponent(pickedOrder?.plant ?? "")}`);
      return res.json() as Promise<string[]>;
    },
  });
  const stvs = stvsQuery.data ?? [];

  // A loader already on another slip is named as unavailable rather than quietly dropped — the
  // "one active slip per loader" rule is the database's, so this is only the early warning.
  const busyElsewhere = (loader: Loader, currentSlipId?: number | null) =>
    !!loader.activeSlipId && loader.activeSlipId !== currentSlipId;

  const createMutation = useMutation({
    mutationFn: async () => {
      const res = await apiRequest("POST", "/api/sort-slips", {
        orderNumber: pickedOrder?.orderNumber,
        loaderCode: pickedLoader,
        platformStv: pickedStv,
      });
      return res.json();
    },
    onSuccess: (data: any) => {
      const loaderName = loadersQuery.data?.find((l) => l.userCode === pickedLoader)?.name ?? pickedLoader;
      toast({ title: "Sort slip created", description: `${data.orderNumber} · ${loaderName}` });
      setCreateOpen(false);
      clearDraft();
      setOrderSearch("");
      refreshAll();
      queryClient.invalidateQueries({ queryKey: ["/api/sort-slips/loaders"] });
      // Straight into the slip that was just made, the way Create Load Operation opens its load.
      setOpenOrder(data.orderNumber);
    },
    onError: (err: any) => toast({ title: "Could not create", description: err.message, variant: "destructive" }),
  });

  // The dialog itself (SortSlipDeleteDialog) owns the delete/replace mutations now — both end
  // up here to refresh the same three things a plain delete always needed refreshed.
  const afterDeleteOrReplace = () => {
    setDeleteTarget(null);
    refreshAll();
    queryClient.invalidateQueries({ queryKey: ["/api/sort-slips/loaders"] });
    queryClient.invalidateQueries({ queryKey: ["/api/scan-sessions/reports/scan-history"] });
  };

  if (openOrder) {
    return (
      <SortSlipDetail
        orderNumber={openOrder}
        onBack={() => { setOpenOrder(null); refreshAll(); }}
        onChanged={refreshAll}
        currentUserCode={user?.userCode ?? ""}
      />
    );
  }

  return (
    <div className="py-4 lg:py-6">
      <div className="mx-auto w-full max-w-[1800px]">
        <div className="mb-6">
          <h2 className="text-2xl font-bold">Sort Slip</h2>
          <p className="text-gray-600">
            {canWrite
              ? "Assign an order to loaders and follow what has been picked."
              : "The orders assigned to you, and how much of each item you have picked."}
          </p>
        </div>

        <Card className="overflow-hidden">
          <div className="border-b border-gray-200 bg-white px-3 py-3 sm:px-5">
            <div className="flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
              <div className="flex items-center gap-3">
                <div className="flex h-9 w-9 items-center justify-center rounded-full bg-[#001d6e] text-white">
                  <ClipboardList className="h-5 w-5" />
                </div>
                <div>
                  <div className="text-lg font-bold tracking-tight text-gray-900 sm:text-xl">Sort Slips</div>
                  <div className="mt-0.5 text-xs leading-none text-gray-400">
                    {total.toLocaleString()} slip{total === 1 ? "" : "s"}
                  </div>
                </div>
              </div>
              <div className="flex flex-wrap items-center gap-2">
                <div className="relative flex-1 sm:flex-none">
                  <Search className="pointer-events-none absolute left-2.5 top-2.5 h-3.5 w-3.5 text-gray-400" />
                  <Input
                    value={search}
                    onChange={(e) => { setSearch(e.target.value); setPageIndex(0); }}
                    placeholder="Order or party…"
                    className="h-9 w-full pl-8 text-sm sm:h-8 sm:w-52"
                  />
                </div>
                {canWrite && (
                  <Button
                    size="sm"
                    className="h-9 shrink-0 bg-[#001d6e] text-white hover:bg-[#00154b] sm:h-8"
                    onClick={() => setCreateOpen(true)}
                  >
                    <Plus className="mr-1.5 h-3.5 w-3.5" /> New Sort Slip
                  </Button>
                )}
              </div>
            </div>

            <div className="mt-3 flex flex-wrap items-center gap-2">
              {/* "unassigned" is gone as a tab: a slip is created with its loader, and the only
                  way it loses one without a Pause is a reopen that could not give it back — a
                  rare state that the All tab still shows. "paused" IS its own tab, though — a
                  supervisor pausing a slip to free its loader is an expected, everyday action,
                  not a rare edge case. */}
              {(["", "active", "paused", "completed"] as const).map((tab) => (
                <Button
                  key={tab || "all"}
                  size="sm"
                  variant={statusTab === tab ? "default" : "outline"}
                  className={`h-7 text-xs ${statusTab === tab ? "bg-[#001d6e] text-white hover:bg-[#00154b]" : ""}`}
                  onClick={() => { setStatusTab(tab); setPageIndex(0); }}
                >
                  {tab === "" ? "All" : STATUS_LABELS[tab]}
                </Button>
              ))}
              <AddColumnFilterButton
                columns={filterColumns}
                conditions={conditions}
                onApply={(id, c) => setCondition(id, c)}
                onClear={clearCondition}
              />
              {Object.entries(conditions)
                .filter(([, c]) => !isConditionEmpty(c))
                .map(([id, condition]) => (
                  <ColumnFilterChipView
                    key={id}
                    columnId={id}
                    condition={condition}
                    columns={filterColumns}
                    onEdit={(c) => setCondition(id, c)}
                    onRemove={() => clearCondition(id)}
                  />
                ))}
            </div>
          </div>

          {/* Nine columns need about 1000px, so below that the card list underneath takes over
              rather than handing someone a table to drag sideways. */}
          <div className="hidden overflow-x-auto min-[1024px]:block">
            <table className="w-full min-w-[1000px] text-sm">
              <thead className="bg-[#001d6e] text-left text-xs uppercase tracking-wide text-white">
                <tr>
                  <th className="px-3 py-2">{header("orderNumber", "Order")}</th>
                  <th className="px-3 py-2">{header("partyName", "Party")}</th>
                  <th className="px-3 py-2">{header("plant", "Plant")}</th>
                  <th className="px-3 py-2">{header("orderDate", "Order Date")}</th>
                  <th className="px-3 py-2">{header("assignee", "Loaders")}</th>
                  <th className="px-3 py-2">{header("pickedQty", "Picked")}</th>
                  <th className="px-3 py-2">{header("status", "Status")}</th>
                  <th className="px-3 py-2">{header("createdByName", "Created By")}</th>
                  <th className="px-3 py-2 text-right">Actions</th>
                </tr>
              </thead>
              <tbody>
                {listQuery.isLoading ? (
                  <tr><td colSpan={9} className="px-3 py-10 text-center text-gray-400">Loading sort slips…</td></tr>
                ) : rows.length === 0 ? (
                  <tr>
                    <td colSpan={9} className="px-3 py-10 text-center text-sm text-gray-400">
                      {canWrite
                        ? "No sort slips yet — start one from an order."
                        : "No sort slip is assigned to you."}
                    </td>
                  </tr>
                ) : rows.map((row) => (
                  <tr
                    key={row.id}
                    className="cursor-pointer border-b border-gray-100 hover:bg-gray-50"
                    onClick={() => setOpenOrder(row.orderNumber)}
                  >
                    <td className="px-3 py-2 font-semibold text-gray-900">{row.orderNumber}</td>
                    <td className="px-3 py-2 text-gray-700">{row.partyName || "—"}</td>
                    <td className="px-3 py-2">{row.plant ? <PlantBadge plant={row.plant} className="text-[10px]" /> : "—"}</td>
                    <td className="px-3 py-2 tabular-nums text-gray-600">{row.orderDate ?? "—"}</td>
                    <td className="px-3 py-2">
                      <div className="flex flex-wrap gap-1">
                        {row.assignees.length === 0
                          ? <span className="text-xs text-gray-400">Nobody yet</span>
                          : row.assignees.map((a) => (
                              <Badge key={a.userCode} variant="outline" className="border-blue-200 bg-blue-50 text-[10px] text-blue-700">
                                {a.userName ?? a.userCode}
                              </Badge>
                            ))}
                      </div>
                    </td>
                    <td className="px-3 py-2"><ProgressBar picked={row.pickedQty} total={row.totalQty} /></td>
                    <td className="px-3 py-2">
                      <Badge variant="outline" className={STATUS_STYLES[row.status] ?? ""}>
                        {STATUS_LABELS[row.status] ?? row.status}
                      </Badge>
                    </td>
                    <td className="px-3 py-2 text-xs text-gray-500">{row.createdByName || "—"}</td>
                    <td className="px-3 py-2 text-right">
                      <Button
                        size="sm"
                        className="h-7 bg-[#001d6e] text-xs text-white hover:bg-[#00154b]"
                        onClick={(e) => { e.stopPropagation(); setOpenOrder(row.orderNumber); }}
                      >
                        Open
                      </Button>
                      {/* Only the current owner sees this — the server would skip anyone else's
                          attempt anyway (see canManageAssignment), so it's hidden rather than
                          offered and then rejected. */}
                      {row.managedByCode === user?.userCode && row.status !== "completed" && (
                        <Button
                          size="sm" variant="ghost" className="h-7 w-7 p-0 text-amber-600 hover:text-amber-700"
                          title="Transfer to another supervisor"
                          onClick={(e) => { e.stopPropagation(); setTransferSupRow(row); }}
                        >
                          <ArrowRightLeft className="h-3.5 w-3.5" />
                        </Button>
                      )}
                      {/* Completed slips have no delete: they are the record of a finished sort. */}
                      {canWrite && row.status !== "completed" && (
                        <Button
                          size="sm" variant="ghost" className="h-7 w-7 p-0 text-red-500 hover:text-red-700"
                          title="Delete this sort slip"
                          onClick={(e) => { e.stopPropagation(); setDeleteTarget(row); }}
                        >
                          <Trash2 className="h-3.5 w-3.5" />
                        </Button>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>

          {/* Phone / tablet — one card per slip, everything that matters without a sideways drag. */}
          <div className="min-[1024px]:hidden">
            {listQuery.isLoading ? (
              <p className="py-10 text-center text-sm text-gray-400">Loading sort slips…</p>
            ) : rows.length === 0 ? (
              <p className="py-10 text-center text-sm text-gray-400">
                {canWrite ? "No sort slips yet — start one from an order." : "No sort slip is assigned to you."}
              </p>
            ) : rows.map((row) => (
              <div
                key={row.id}
                onClick={() => setOpenOrder(row.orderNumber)}
                className="cursor-pointer border-b border-gray-100 px-4 py-3 last:border-b-0 active:bg-gray-50"
              >
                <div className="flex items-start justify-between gap-2">
                  <div className="min-w-0">
                    <span className="text-[15px] font-bold text-gray-900">{row.orderNumber}</span>
                    <p className="truncate text-xs text-gray-500">{row.partyName || "—"}</p>
                  </div>
                  <Badge variant="outline" className={`shrink-0 ${STATUS_STYLES[row.status] ?? ""}`}>
                    {STATUS_LABELS[row.status] ?? row.status}
                  </Badge>
                </div>

                <div className="mt-1.5 flex flex-wrap items-center gap-1.5 text-xs text-gray-500">
                  {row.plant && <PlantBadge plant={row.plant} className="px-1.5 py-0 text-[10px]" />}
                  <span>{row.orderDate ?? "—"}</span>
                  {row.assignees.length === 0
                    ? <span className="text-amber-600">no loader</span>
                    : row.assignees.map((a) => (
                        <Badge key={a.userCode} variant="outline" className="border-blue-200 bg-blue-50 text-[10px] text-blue-700">
                          {a.userName ?? a.userCode}
                        </Badge>
                      ))}
                </div>

                <div className="mt-2 flex items-center justify-between gap-3">
                  <ProgressBar picked={row.pickedQty} total={row.totalQty} />
                  <div className="flex shrink-0 items-center gap-1.5">
                    {row.managedByCode === user?.userCode && row.status !== "completed" && (
                      <Button
                        size="sm" variant="ghost" className="h-9 w-9 p-0 text-amber-600"
                        title="Transfer to another supervisor"
                        onClick={(e) => { e.stopPropagation(); setTransferSupRow(row); }}
                      >
                        <ArrowRightLeft className="h-4 w-4" />
                      </Button>
                    )}
                    {canWrite && row.status !== "completed" && (
                      <Button
                        size="sm" variant="ghost" className="h-9 w-9 p-0 text-red-500"
                        title="Delete this sort slip"
                        onClick={(e) => { e.stopPropagation(); setDeleteTarget(row); }}
                      >
                        <Trash2 className="h-4 w-4" />
                      </Button>
                    )}
                    <Button
                      size="sm"
                      className="h-9 bg-[#001d6e] px-4 text-sm text-white hover:bg-[#00154b]"
                      onClick={(e) => { e.stopPropagation(); setOpenOrder(row.orderNumber); }}
                    >
                      Open
                    </Button>
                  </div>
                </div>
              </div>
            ))}
          </div>

          {/* Numbered pager, centred, with its own rows-per-page picker — the same pattern as
              Scan History and Unloading, since this list is paged on the server too. */}
          <div className="flex flex-wrap items-center justify-between gap-2 border-t border-gray-200 px-4 py-3">
            <div className="flex items-center gap-2 text-xs text-gray-500">
              <span>Rows</span>
              <Select value={String(pageSize)} onValueChange={(v) => { setPageSize(Number(v)); setPageIndex(0); }}>
                <SelectTrigger className="h-7 w-[70px] text-xs"><SelectValue /></SelectTrigger>
                <SelectContent>
                  {[10, 25, 50, 100].map((n) => <SelectItem key={n} value={String(n)}>{n}</SelectItem>)}
                </SelectContent>
              </Select>
            </div>
            <nav className="flex flex-wrap items-center justify-center gap-1" aria-label="Pagination">
              <Button variant="outline" size="sm" className="h-8 w-8 p-0" disabled={pageIndex === 0}
                onClick={() => setPageIndex(Math.max(0, pageIndex - 1))} aria-label="Previous page">
                <ChevronLeft className="h-4 w-4" />
              </Button>
              {buildPageList(pageIndex, pageCount).map((pg, i) =>
                pg === "gap" ? (
                  <span key={`gap-${i}`} aria-hidden className="select-none px-1 text-sm text-gray-400">…</span>
                ) : (
                  <Button
                    key={pg}
                    size="sm"
                    variant={pg === pageIndex ? "default" : "outline"}
                    className={`h-8 min-w-8 px-2 tabular-nums ${pg === pageIndex ? "bg-[#001d6e] text-white hover:bg-[#00154b]" : ""}`}
                    onClick={() => setPageIndex(pg)}
                    aria-current={pg === pageIndex ? "page" : undefined}
                  >
                    {pg + 1}
                  </Button>
                ),
              )}
              <Button variant="outline" size="sm" className="h-8 w-8 p-0" disabled={pageIndex >= pageCount - 1}
                onClick={() => setPageIndex(Math.min(pageCount - 1, pageIndex + 1))} aria-label="Next page">
                <ChevronRight className="h-4 w-4" />
              </Button>
            </nav>
            <span className="text-xs text-gray-500">
              {total === 0 ? "0" : `${(pageIndex * pageSize + 1).toLocaleString()}–${Math.min((pageIndex + 1) * pageSize, total).toLocaleString()} of ${total.toLocaleString()}`}
            </span>
          </div>
        </Card>
      </div>

      {/* New Sort Slip — find the order, look at it, hand it to a loader. Same two steps, the
          same card and the same search behaviour as Create Load Operation: a search box with a
          floating suggestion list, then what you picked shown back as a confirmed line. */}
      <Dialog open={createOpen} onOpenChange={(o) => { setCreateOpen(o); if (!o) clearDraft(); }}>
        <DialogContent className="max-w-lg">
          {!pickedOrder ? (
            <>
              <DialogHeader>
                <DialogTitle className="text-[#001d6e]">New Sort Slip</DialogTitle>
                <DialogDescription>Find the order to be sorted.</DialogDescription>
              </DialogHeader>
              <div className="relative">
                <Search className="absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-gray-400" />
                <Input
                  value={orderSearch}
                  onChange={(e) => { setOrderSearch(e.target.value); setOrderSuggIdx(-1); }}
                  onKeyDown={(e) => {
                    const list = orderQuery.data ?? [];
                    if (list.length === 0) return;
                    if (e.key === "ArrowDown") { e.preventDefault(); setOrderSuggIdx((i) => Math.min(i + 1, list.length - 1)); return; }
                    if (e.key === "ArrowUp") { e.preventDefault(); setOrderSuggIdx((i) => Math.max(i - 1, -1)); return; }
                    if (e.key === "Enter" && orderSuggIdx >= 0) {
                      e.preventDefault();
                      const order = list[orderSuggIdx];
                      if (!order.existingSortSlipId) { setPickedOrder(order); setPickedLoader(""); setLoaderSearch(""); }
                    }
                  }}
                  placeholder="Order number or party…"
                  className="h-10 pl-9 pr-9 text-sm"
                  autoFocus
                />
                {orderSearch && (
                  <button
                    type="button"
                    onClick={() => { setOrderSearch(""); setOrderSuggIdx(-1); }}
                    className="absolute right-3 top-1/2 -translate-y-1/2 text-gray-400 hover:text-gray-600"
                  >
                    <X className="h-4 w-4" />
                  </button>
                )}
              </div>
              <div className="max-h-72 overflow-y-auto rounded-lg border border-gray-200">
                {orderQuery.isFetching && (orderQuery.data ?? []).length === 0 ? (
                  <p className="px-4 py-3 text-xs text-gray-400">Searching…</p>
                ) : (orderQuery.data ?? []).length === 0 ? (
                  <p className="px-4 py-3 text-xs text-gray-400">No matching orders.</p>
                ) : (orderQuery.data ?? []).map((order: any, i: number) => (
                  <button
                    key={order.id}
                    type="button"
                    disabled={!!order.existingSortSlipId}
                    onMouseDown={(e) => e.preventDefault()}
                    onClick={() => { setPickedOrder(order); setPickedLoader(""); setLoaderSearch(""); }}
                    className={`flex w-full items-center justify-between gap-2 border-b border-gray-100 px-4 py-2.5 text-left last:border-0 disabled:cursor-not-allowed disabled:opacity-50 ${
                      i === orderSuggIdx ? "bg-[#001d6e]/10" : "hover:bg-[#001d6e]/5"
                    }`}
                  >
                    <div className="min-w-0">
                      <div className="truncate text-sm font-semibold text-[#001d6e]">{order.orderNumber}</div>
                      <div className="flex items-center gap-1.5 truncate text-xs text-gray-500">
                        <span className="truncate">{order.partyName || "—"}</span>
                        {order.plant && <PlantBadge plant={order.plant} className="shrink-0 px-1.5 py-0 text-[9px]" />}
                        <span className="shrink-0">{order.orderDate ?? "—"}</span>
                      </div>
                    </div>
                    <div className="flex shrink-0 items-center gap-1 text-xs text-gray-500">
                      {order.existingSortSlipId ? "Already sorted" : `${(order.totalQty ?? 0).toLocaleString()} pcs`}
                      <ChevronRight className="h-4 w-4 text-gray-300" />
                    </div>
                  </button>
                ))}
              </div>
            </>
          ) : (
            <>
              <DialogHeader>
                <DialogTitle className="text-[#001d6e]">#{pickedOrder.orderNumber}</DialogTitle>
                <DialogDescription className="flex flex-wrap items-center gap-1.5">
                  <span>{pickedOrder.partyName}</span>
                  {pickedOrder.plant && <PlantBadge plant={pickedOrder.plant} className="px-1.5 py-0 text-[10px]" />}
                  <span>{pickedOrder.orderDate ?? ""}</span>
                </DialogDescription>
              </DialogHeader>

              <div className="grid grid-cols-3 divide-x divide-gray-100 rounded-lg border border-gray-100 text-center">
                <div className="px-2 py-2.5">
                  <div className="text-base font-extrabold text-gray-900">{pickedOrder.itemCount ?? (previewQuery.data?.items.length ?? "—")}</div>
                  <div className="mt-0.5 text-[10px] font-medium text-gray-500">Items</div>
                </div>
                <div className="px-2 py-2.5">
                  <div className="text-base font-extrabold text-gray-900">{(pickedOrder.totalQty ?? 0).toLocaleString()}</div>
                  <div className="mt-0.5 text-[10px] font-medium text-gray-500">Total Qty</div>
                </div>
                <div className="px-2 py-2.5">
                  {/* An order with no volume on it shows a dash rather than an empty box. */}
                  <div className="text-base font-extrabold text-gray-900">
                    {pickedOrder.totalVolume !== null && pickedOrder.totalVolume !== undefined && String(pickedOrder.totalVolume).trim() !== ""
                      ? pickedOrder.totalVolume
                      : "—"}
                  </div>
                  <div className="mt-0.5 text-[10px] font-medium text-gray-500">Volume</div>
                </div>
              </div>

              <div className="space-y-1.5">
                <label className="flex items-center gap-1.5 text-xs font-semibold uppercase tracking-wide text-gray-500">
                  <Package className="h-3.5 w-3.5" /> Items on this order ({previewQuery.data?.items.length ?? 0})
                </label>
                <div className="max-h-44 overflow-y-auto rounded-lg border border-gray-100">
                  <table className="w-full text-xs">
                    <thead className="sticky top-0 bg-gray-50">
                      <tr className="text-left text-[10px] font-semibold uppercase tracking-wide text-gray-500">
                        <th className="px-3 py-1.5">Sr</th>
                        <th className="px-3 py-1.5">Item Name</th>
                        <th className="px-3 py-1.5 text-right">Qty</th>
                      </tr>
                    </thead>
                    <tbody>
                      {previewQuery.isLoading ? (
                        <tr><td colSpan={3} className="px-3 py-4 text-center text-gray-400">Loading items…</td></tr>
                      ) : (previewQuery.data?.items ?? []).map((item) => (
                        <tr key={item.id} className="border-t border-gray-50">
                          <td className="px-3 py-1.5 tabular-nums text-gray-500">{item.srNo || "—"}</td>
                          <td className="px-3 py-1.5 text-gray-900">{item.itemName || item.barcode || "—"}</td>
                          <td className="px-3 py-1.5 text-right tabular-nums">{item.quantity.toLocaleString()}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </div>

              {/* STV (platform) — required, and the only place it can ever be set for this
                  slip: once created, sorting for this order happens at whichever platform was
                  picked here, the same write-once rule Loading's Create Operation uses for
                  loadingStv. */}
              <div className="space-y-1.5">
                <label className="flex items-center gap-1.5 text-xs font-semibold uppercase tracking-wide text-gray-500">
                  Dispatch Directory <span className="text-red-600">*</span>
                </label>
                {stvs.length > 0 ? (
                  <Select value={pickedStv} onValueChange={setPickedStv}>
                    <SelectTrigger>
                      <SelectValue placeholder="Select Dispatch Directory…" />
                    </SelectTrigger>
                    <SelectContent>
                      {stvs.map((st) => (
                        <SelectItem key={st} value={st}>{st}</SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                ) : !stvsQuery.isLoading && (
                  <div className="rounded-lg bg-amber-50 px-3 py-2 text-xs text-amber-700">
                    No Dispatch Directory configured for {pickedOrder.plant || "this plant"} — add one in Plant Settings before creating this sort slip.
                  </div>
                )}
              </div>

              <LoaderPicker
                label="Assign a loader"
                loaders={loadersQuery.data ?? []}
                search={loaderSearch}
                onSearch={setLoaderSearch}
                selected={pickedLoader}
                onSelect={setPickedLoader}
                plant={pickedOrder.plant}
                isLoading={loadersQuery.isLoading}
              />

              <DialogFooter>
                <Button variant="outline" onClick={() => { setPickedOrder(null); setPickedLoader(""); }} disabled={createMutation.isPending}>
                  Change order
                </Button>
                <Button
                  className="bg-[#001d6e] text-white hover:bg-[#00154b]"
                  disabled={!pickedLoader || !pickedStv || createMutation.isPending}
                  onClick={() => createMutation.mutate()}
                >
                  {createMutation.isPending ? <Loader2 className="mr-1.5 h-4 w-4 animate-spin" /> : <Plus className="mr-1.5 h-4 w-4" />}
                  Create Sort Slip
                </Button>
              </DialogFooter>
            </>
          )}
        </DialogContent>
      </Dialog>

      {/* Transfer to Supervisor — a per-row action (the "transfer" icon next to Delete on each
          row), loaders untouched. Only WHO manages this one slip changes. */}
      <Dialog open={!!transferSupRow} onOpenChange={(o) => {
        if (!o) { setTransferSupRow(null); setTransferSupTarget(""); setTransferSupSearch(""); }
      }}>
        <DialogContent className="sm:max-w-[480px]">
          <DialogHeader>
            <DialogTitle>Transfer {transferSupRow?.orderNumber} to another supervisor</DialogTitle>
            <DialogDescription>
              {transferSupRow?.assignees.length
                ? `${transferSupRow.assignees.map((a) => a.userName ?? a.userCode).join(", ")} keeps working it exactly as they are — only who manages the slip changes.`
                : "Only who manages the slip changes."}
            </DialogDescription>
          </DialogHeader>
          <SupervisorPicker
            label="Hand off to"
            supervisors={supervisors}
            search={transferSupSearch}
            onSearch={setTransferSupSearch}
            selected={transferSupTarget}
            onSelect={setTransferSupTarget}
            isLoading={supervisorsQuery.isLoading}
          />
          <DialogFooter>
            <Button variant="outline" onClick={() => setTransferSupRow(null)}>Cancel</Button>
            <Button
              className="bg-amber-600 text-white hover:bg-amber-700"
              disabled={!transferSupTarget || transferSupMutation.isPending}
              onClick={() => transferSupMutation.mutate()}
            >
              {transferSupMutation.isPending ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : <ArrowRightLeft className="mr-2 h-4 w-4" />}
              Transfer
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Delete — only before Complete, and it says what is being thrown away */}
      <SortSlipDeleteDialog
        open={!!deleteTarget}
        onOpenChange={(o) => { if (!o) setDeleteTarget(null); }}
        target={deleteTarget && {
          id: deleteTarget.id, orderNumber: deleteTarget.orderNumber, partyName: deleteTarget.partyName,
          plant: deleteTarget.plant, pickedQty: deleteTarget.pickedQty,
          assigneeLabel: deleteTarget.assignees.length > 0
            ? deleteTarget.assignees.map((a) => a.userName ?? a.userCode).join(", ") : null,
        }}
        onDeleted={afterDeleteOrReplace}
        onReplaced={afterDeleteOrReplace}
      />
    </div>
  );
}

// What a sort slip's own delete dialog acts on — normalized once so the same dialog serves both
// the landing list (a row it has never fully loaded) and the detail view (the slip it has open).
type SortSlipDeleteTarget = {
  id: number; orderNumber: string; partyName: string | null; plant: string | null;
  assigneeLabel: string | null; pickedQty: number;
};

// Delete OR replace — the same choice Order CSV delete offers (re-upload the corrected file vs.
// remove permanently), here for a sort slip: "Remove permanently" wipes the slip and every pick
// on it together; "Replace with another order" keeps every pick already made and moves it onto a
// different order's own matching items, so the work already done is never thrown away just
// because the WRONG order was picked when the slip was created.
function SortSlipDeleteDialog({
  open, onOpenChange, target, onDeleted, onReplaced,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  target: SortSlipDeleteTarget | null;
  onDeleted: (data: any) => void;
  onReplaced: (data: any) => void;
}) {
  const { toast } = useToast();
  const [mode, setMode] = useState<"choose" | "search" | "preview">("choose");
  const [targetSearch, setTargetSearch] = useState("");
  const [pickedOrder, setPickedOrder] = useState<any | null>(null);

  useEffect(() => {
    if (!open) { setMode("choose"); setTargetSearch(""); setPickedOrder(null); }
  }, [open]);

  const orderQuery = useQuery({
    queryKey: ["/api/sort-slips/orders/search", targetSearch],
    enabled: open && mode === "search",
    queryFn: async () => {
      const res = await apiRequest("GET", `/api/sort-slips/orders/search?q=${encodeURIComponent(targetSearch)}`);
      return res.json() as Promise<any[]>;
    },
  });

  const previewQuery = useQuery({
    queryKey: ["/api/sort-slips", target?.id, "replace-preview", pickedOrder?.orderNumber],
    enabled: open && mode === "preview" && !!target && !!pickedOrder,
    queryFn: async () => {
      const res = await apiRequest(
        "GET",
        `/api/sort-slips/${target!.id}/replace-preview?targetOrderNumber=${encodeURIComponent(pickedOrder!.orderNumber)}`,
      );
      return res.json();
    },
  });

  const deleteMutation = useMutation({
    mutationFn: async () => {
      const res = await apiRequest("DELETE", `/api/sort-slips/${target!.id}`);
      return res.json();
    },
    onSuccess: (data: any) => {
      toast({ title: "Sort slip deleted", description: `${data.orderNumber} is gone` });
      onDeleted(data);
    },
    onError: (err: any) => toast({ title: "Could not delete", description: err.message, variant: "destructive" }),
  });

  const replaceMutation = useMutation({
    mutationFn: async () => {
      const res = await apiRequest("POST", `/api/sort-slips/${target!.id}/replace`, {
        targetOrderNumber: pickedOrder!.orderNumber,
      });
      return res.json();
    },
    onSuccess: (data: any) => {
      toast({ title: "Replaced", description: `${data.movedQty.toLocaleString()} pcs moved onto ${data.newOrderNumber}` });
      onReplaced(data);
    },
    onError: (err: any) => toast({ title: "Could not replace", description: err.message, variant: "destructive" }),
  });

  if (!target) return null;

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-[480px]">
        {mode === "choose" && (
          <>
            <DialogHeader>
              <DialogTitle className="flex items-center gap-2 text-red-700">
                <AlertTriangle className="h-5 w-5" /> Delete this sort slip
              </DialogTitle>
              <DialogDescription>This cannot be undone.</DialogDescription>
            </DialogHeader>
            <div className="rounded-lg border border-red-100 bg-red-50/60 p-3 text-sm">
              <p className="font-semibold text-gray-900">{target.orderNumber}</p>
              <p className="text-xs text-gray-600">
                {target.partyName || "—"} · {target.plant || "—"}
                {target.assigneeLabel ? ` · ${target.assigneeLabel}` : ""}
              </p>
              {target.pickedQty > 0 && (
                <p className="mt-2 text-red-700">{target.pickedQty.toLocaleString()} pcs already picked.</p>
              )}
            </div>
            <DialogFooter className="flex-col gap-2 sm:flex-row sm:justify-end">
              <Button variant="outline" onClick={() => onOpenChange(false)}>Cancel</Button>
              {target.pickedQty > 0 && (
                <Button variant="outline" className="border-[#001d6e] text-[#001d6e] hover:bg-[#001d6e]/5" onClick={() => setMode("search")}>
                  <ArrowRightLeft className="mr-2 h-4 w-4" /> Replace with another order
                </Button>
              )}
              <Button variant="destructive" disabled={deleteMutation.isPending} onClick={() => deleteMutation.mutate()}>
                {deleteMutation.isPending ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : <Trash2 className="mr-2 h-4 w-4" />}
                Remove permanently
              </Button>
            </DialogFooter>
          </>
        )}

        {mode === "search" && (
          <>
            <DialogHeader>
              <DialogTitle className="text-[#001d6e]">Replace with which order?</DialogTitle>
              <DialogDescription>
                Every pick already made on {target.orderNumber} moves onto the order you pick here, matched item by item.
              </DialogDescription>
            </DialogHeader>
            <div className="relative">
              <Search className="absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-gray-400" />
              <Input
                value={targetSearch}
                onChange={(e) => setTargetSearch(e.target.value)}
                placeholder="Order number or party…"
                className="h-10 pl-9 text-sm"
                autoFocus
              />
            </div>
            <div className="max-h-60 overflow-y-auto rounded-lg border border-gray-200">
              {(() => {
                const options = (orderQuery.data ?? []).filter((o: any) => o.orderNumber !== target.orderNumber);
                if (options.length === 0) {
                  return (
                    <p className="px-4 py-3 text-xs text-gray-400">
                      {orderQuery.isFetching ? "Searching…" : "No matching orders."}
                    </p>
                  );
                }
                return options.map((order: any) => (
                  <button
                    key={order.id}
                    type="button"
                    disabled={!!order.existingSortSlipId}
                    onClick={() => { setPickedOrder(order); setMode("preview"); }}
                    className="flex w-full items-center justify-between gap-2 border-b border-gray-100 px-4 py-2.5 text-left last:border-0 hover:bg-[#001d6e]/5 disabled:cursor-not-allowed disabled:opacity-50"
                  >
                    <div className="min-w-0">
                      <div className="truncate text-sm font-semibold text-[#001d6e]">{order.orderNumber}</div>
                      <div className="truncate text-xs text-gray-500">{order.partyName || "—"} · {order.plant || "—"}</div>
                    </div>
                    <span className="shrink-0 text-xs text-gray-500">
                      {order.existingSortSlipId ? "Already sorted" : `${(order.totalQty ?? 0).toLocaleString()} pcs`}
                    </span>
                  </button>
                ));
              })()}
            </div>
            <DialogFooter>
              <Button variant="outline" onClick={() => setMode("choose")}>Back</Button>
            </DialogFooter>
          </>
        )}

        {mode === "preview" && pickedOrder && (
          <>
            <DialogHeader>
              <DialogTitle className="text-[#001d6e]">Move picks to #{pickedOrder.orderNumber}?</DialogTitle>
              <DialogDescription>{pickedOrder.partyName || "—"} · {pickedOrder.plant || "—"}</DialogDescription>
            </DialogHeader>
            {previewQuery.isLoading ? (
              <p className="py-6 text-center text-sm text-gray-400">Checking the match…</p>
            ) : (
              <div className="max-h-72 space-y-2 overflow-y-auto">
                {(previewQuery.data?.matched ?? []).length > 0 && (
                  <div className="rounded-lg border border-emerald-100 bg-emerald-50/60 p-3">
                    <p className="mb-1 text-xs font-semibold uppercase tracking-wide text-emerald-700">Will move</p>
                    {previewQuery.data.matched.map((m: any, i: number) => (
                      <p key={i} className="text-sm text-gray-800">
                        <span className="font-semibold text-emerald-700">+{m.qty}</span>{" "}
                        {m.oldItemName || m.barcode} → {m.newItemName || m.newBarcode}
                      </p>
                    ))}
                  </div>
                )}
                {(previewQuery.data?.unmatched ?? []).length > 0 && (
                  <div className="rounded-lg border border-red-100 bg-red-50/60 p-3">
                    <p className="mb-1 text-xs font-semibold uppercase tracking-wide text-red-700">
                      Blocked — this order can't be used
                    </p>
                    {previewQuery.data.unmatched.map((u: any, i: number) => (
                      <p key={i} className="text-sm text-red-700">
                        {u.oldItemName || u.barcode} ({u.qty} pcs) — {u.reason}
                      </p>
                    ))}
                  </div>
                )}
              </div>
            )}
            <DialogFooter>
              <Button variant="outline" onClick={() => setMode("search")}>Choose a different order</Button>
              <Button
                className="bg-[#001d6e] text-white hover:bg-[#00154b]"
                disabled={!previewQuery.data?.canReplace || replaceMutation.isPending}
                onClick={() => replaceMutation.mutate()}
              >
                {replaceMutation.isPending ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : <ArrowRightLeft className="mr-2 h-4 w-4" />}
                Replace
              </Button>
            </DialogFooter>
          </>
        )}
      </DialogContent>
    </Dialog>
  );
}

// The loader a slip is handed to. One name, not a set — a slip belongs to one person and it
// changes hands by transfer. Same search-then-confirm shape as picking a vehicle on the Loading
// page: type, pick from the floating list, and see who you picked as a line you can clear.
//
// The list the server sends already holds only people who can take this slip (view access to Sort
// Slip, this plant, not a supervisor), so the only thing greyed out here is someone busy on
// another slip.
function LoaderPicker({
  label, loaders, search, onSearch, selected, onSelect, plant, isLoading, excludeCode,
}: {
  label: string;
  loaders: Loader[];
  search: string;
  onSearch: (value: string) => void;
  selected: string;
  onSelect: (code: string) => void;
  plant: string | null | undefined;
  isLoading?: boolean;
  /** The loader who already holds this slip — offering them again means nothing. */
  excludeCode?: string | null;
}) {
  const [focused, setFocused] = useState(false);
  const [suggIdx, setSuggIdx] = useState(-1);
  const available = loaders.filter((l) => l.userCode !== excludeCode);
  const term = search.trim().toLowerCase();
  const shown = available.filter((l) => !term
    || (l.name ?? "").toLowerCase().includes(term)
    || l.username.toLowerCase().includes(term)
    || l.userCode.toLowerCase().includes(term));
  const picked = available.find((l) => l.userCode === selected) ?? null;

  return (
    <div className="space-y-1.5">
      <label className="flex items-center gap-1.5 text-xs font-semibold uppercase tracking-wide text-gray-500">
        <User className="h-3.5 w-3.5" /> {label}
      </label>

      <div className="relative">
        <Search className="absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-gray-400" />
        <Input
          value={search}
          onChange={(e) => { onSearch(e.target.value); setSuggIdx(-1); }}
          onFocus={() => setFocused(true)}
          onBlur={() => setTimeout(() => setFocused(false), 150)}
          onKeyDown={(e) => {
            if (!focused || shown.length === 0) return;
            if (e.key === "ArrowDown") { e.preventDefault(); setSuggIdx((i) => Math.min(i + 1, shown.length - 1)); return; }
            if (e.key === "ArrowUp") { e.preventDefault(); setSuggIdx((i) => Math.max(i - 1, -1)); return; }
            if (e.key === "Escape") { setFocused(false); return; }
            if (e.key === "Enter" && suggIdx >= 0) {
              e.preventDefault();
              const loader = shown[suggIdx];
              if (!loader.activeSlipId) { onSelect(loader.userCode); setFocused(false); }
            }
          }}
          placeholder="Loader name or code…"
          className="h-10 pl-9 pr-9 text-sm"
        />
        {search && (
          <button
            type="button"
            onClick={() => { onSearch(""); setSuggIdx(-1); }}
            className="absolute right-3 top-1/2 -translate-y-1/2 text-gray-400 hover:text-gray-600"
          >
            <X className="h-4 w-4" />
          </button>
        )}

        {focused && !picked && (
          <div className="absolute z-20 mt-1 max-h-56 w-full overflow-y-auto rounded-lg border border-gray-200 bg-white shadow-lg">
            {isLoading ? (
              <p className="px-4 py-3 text-xs text-gray-400">Loading loaders…</p>
            ) : shown.length === 0 ? (
              <p className="px-4 py-3 text-xs text-gray-400">
                {available.length === 0
                  ? `Nobody can take a slip at ${plant ?? "this plant"} yet. On User Management give them view access to Sort Slip — write access makes someone a supervisor — and this plant.`
                  : "No loader matches that name."}
              </p>
            ) : shown.map((loader, i) => (
              <button
                key={loader.userCode}
                type="button"
                disabled={!!loader.activeSlipId}
                onMouseDown={(e) => e.preventDefault()}
                onClick={() => { onSelect(loader.userCode); setFocused(false); }}
                className={`flex w-full items-center justify-between gap-2 border-b border-gray-100 px-4 py-2.5 text-left last:border-0 disabled:cursor-not-allowed disabled:opacity-50 ${
                  i === suggIdx ? "bg-[#001d6e]/10" : "hover:bg-[#001d6e]/5"
                }`}
              >
                <div className="min-w-0">
                  <div className="truncate text-sm font-semibold text-[#001d6e]">{loader.name || loader.username}</div>
                  <div className="truncate text-xs text-gray-500">
                    {[loader.designation, loader.department].filter(Boolean).join(" · ") || loader.userCode}
                  </div>
                </div>
                {loader.activeSlipId
                  ? <span className="shrink-0 text-[11px] text-amber-600">on {loader.activeOrderNumber}</span>
                  : <ChevronRight className="h-4 w-4 shrink-0 text-gray-300" />}
              </button>
            ))}
          </div>
        )}
      </div>

      {picked && (
        <div className="flex items-center justify-between gap-2 rounded-lg border border-[#001d6e]/20 bg-[#001d6e]/5 px-3 py-2.5">
          <div className="min-w-0 text-sm">
            <span className="font-semibold text-[#001d6e]">{picked.name || picked.username}</span>
            <span className="text-gray-500">
              {" — "}{[picked.designation, picked.department].filter(Boolean).join(" · ") || picked.userCode}
            </span>
          </div>
          <button type="button" onClick={() => onSelect("")} className="shrink-0 text-gray-400 hover:text-gray-600">
            <X className="h-4 w-4" />
          </button>
        </div>
      )}
      <p className="text-xs text-gray-500">A loader can only be on one sort slip at a time.</p>
    </div>
  );
}

// A trimmed-down LoaderPicker for the Transfer to Supervisor dialog — no "busy on another slip"
// exclusivity (a supervisor can manage any number of slips at once), so no disabled rows either.
function SupervisorPicker({
  label, supervisors, search, onSearch, selected, onSelect, isLoading,
}: {
  label: string;
  supervisors: Supervisor[];
  search: string;
  onSearch: (value: string) => void;
  selected: string;
  onSelect: (code: string) => void;
  isLoading?: boolean;
}) {
  const [focused, setFocused] = useState(false);
  const term = search.trim().toLowerCase();
  const shown = supervisors.filter((s) => !term
    || (s.name ?? "").toLowerCase().includes(term)
    || s.username.toLowerCase().includes(term)
    || s.userCode.toLowerCase().includes(term));
  const picked = supervisors.find((s) => s.userCode === selected) ?? null;

  return (
    <div className="space-y-1.5">
      <label className="flex items-center gap-1.5 text-xs font-semibold uppercase tracking-wide text-gray-500">
        <User className="h-3.5 w-3.5" /> {label}
      </label>
      <div className="relative">
        <Search className="absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-gray-400" />
        <Input
          value={search}
          onChange={(e) => onSearch(e.target.value)}
          onFocus={() => setFocused(true)}
          onBlur={() => setTimeout(() => setFocused(false), 150)}
          placeholder="Supervisor name or code…"
          className="h-10 pl-9 pr-9 text-sm"
        />
        {search && (
          <button type="button" onClick={() => onSearch("")} className="absolute right-3 top-1/2 -translate-y-1/2 text-gray-400 hover:text-gray-600">
            <X className="h-4 w-4" />
          </button>
        )}
        {focused && !picked && (
          <div className="absolute z-20 mt-1 max-h-56 w-full overflow-y-auto rounded-lg border border-gray-200 bg-white shadow-lg">
            {isLoading ? (
              <p className="px-4 py-3 text-xs text-gray-400">Loading supervisors…</p>
            ) : shown.length === 0 ? (
              <p className="px-4 py-3 text-xs text-gray-400">No other supervisor matches that name.</p>
            ) : shown.map((s) => (
              <button
                key={s.userCode}
                type="button"
                onMouseDown={(e) => e.preventDefault()}
                onClick={() => { onSelect(s.userCode); setFocused(false); }}
                className="flex w-full items-center justify-between gap-2 border-b border-gray-100 px-4 py-2.5 text-left last:border-0 hover:bg-[#001d6e]/5"
              >
                <div className="min-w-0">
                  <div className="truncate text-sm font-semibold text-[#001d6e]">{s.name || s.username}</div>
                  <div className="truncate text-xs text-gray-500">
                    {[s.designation, s.department].filter(Boolean).join(" · ") || s.userCode}
                  </div>
                </div>
                <ChevronRight className="h-4 w-4 shrink-0 text-gray-300" />
              </button>
            ))}
          </div>
        )}
      </div>
      {picked && (
        <div className="flex items-center justify-between gap-2 rounded-lg border border-[#001d6e]/20 bg-[#001d6e]/5 px-3 py-2.5">
          <div className="min-w-0 text-sm">
            <span className="font-semibold text-[#001d6e]">{picked.name || picked.username}</span>
            <span className="text-gray-500">
              {" — "}{[picked.designation, picked.department].filter(Boolean).join(" · ") || picked.userCode}
            </span>
          </div>
          <button type="button" onClick={() => onSelect("")} className="shrink-0 text-gray-400 hover:text-gray-600">
            <X className="h-4 w-4" />
          </button>
        </div>
      )}
    </div>
  );
}

// ─── The slip itself ─────────────────────────────────────────────────────────

function SortSlipDetail({
  orderNumber, onBack, onChanged, currentUserCode,
}: {
  orderNumber: string;
  onBack: () => void;
  onChanged: () => void;
  currentUserCode: string;
}) {
  const { toast } = useToast();
  const [pickTarget, setPickTarget] = useState<SortSlipItem | null>(null);
  const [pickQty, setPickQty] = useState("");
  // The pallet box beside the quantity — kept in step with it both ways, as on Scan Operations.
  const [pickPallets, setPickPallets] = useState("");
  const [transferOpen, setTransferOpen] = useState(false);
  const [transferTo, setTransferTo] = useState("");
  const [transferSearch, setTransferSearch] = useState("");
  const [transferReason, setTransferReason] = useState("");
  const [deleteOpen, setDeleteOpen] = useState(false);
  const [completeOpen, setCompleteOpen] = useState(false);
  // Who has held this slip, folded away under one line in the header — the same collapsed
  // "Owner history" the Loading page carries for a load.
  const [loaderHistoryOpen, setLoaderHistoryOpen] = useState(false);
  const detailKey = ["/api/sort-slips", "detail", orderNumber];
  const detailQuery = useQuery({
    queryKey: detailKey,
    // Several loaders can be on one slip at once, so the numbers on screen have to keep up with
    // what the others are picking rather than going stale until a manual refresh.
    refetchInterval: 15_000,
    queryFn: async () => {
      const res = await apiRequest("GET", `/api/sort-slips/${encodeURIComponent(orderNumber)}`);
      return res.json() as Promise<{
        slip: any; items: SortSlipItem[];
        assignees: Array<{ userCode: string; userName: string | null; assignedByName: string | null; isActive: boolean }>;
        loaderTimeline: Array<{ userCode: string; userName: string | null; from: string | null; to: string | null; pickedQty: number }>;
        canWrite: boolean; canPick: boolean; canManageAssignment: boolean;
      }>;
    },
  });

  const slip = detailQuery.data?.slip;
  const items = detailQuery.data?.items ?? [];
  const assignees = detailQuery.data?.assignees ?? [];
  const loaderTimeline = detailQuery.data?.loaderTimeline ?? [];
  const canWrite = detailQuery.data?.canWrite ?? false;
  const canPick = detailQuery.data?.canPick ?? false;
  // Narrower than canWrite — Pause and Transfer both take a loader off work someone else put
  // them on, so they're limited to whoever currently owns the assignment (whoever assigned or
  // last transferred the active loader, or an admin) — see canManageAssignment in
  // server/routes/sort-slips.ts for why. A supervisor who isn't that person doesn't see either
  // button, instead of clicking one and hitting a 403.
  const canManageAssignment = detailQuery.data?.canManageAssignment ?? false;
  const isCompleted = slip?.status === "completed";
  const slipPlant = slip?.plant ?? "";

  // The people this slip can be given to — page access and this slip's plant, both applied by
  // the server, so anyone in this list can actually be assigned.
  const loadersQuery = useQuery({
    queryKey: ["/api/sort-slips/loaders", slipPlant],
    enabled: canWrite && !!slipPlant,
    queryFn: async () => {
      const res = await apiRequest("GET", `/api/sort-slips/loaders?plant=${encodeURIComponent(slipPlant)}`);
      return res.json() as Promise<Loader[]>;
    },
  });
  const loaders = loadersQuery.data ?? [];

  // Which item's pick history is open, if any. Supervisors only: a loader sees their own entries
  // in the slip's History panel, but "who else touched this line" is a supervisor's question.
  const [expandedItemId, setExpandedItemId] = useState<string | null>(null);

  const historyQuery = useQuery({
    queryKey: ["/api/sort-slips", "history", slip?.id],
    // Loaded for the History panel and for an expanded row alike — one query serves both.
    enabled: !!expandedItemId && !!slip?.id,
    queryFn: async () => {
      const res = await apiRequest("GET", `/api/sort-slips/${slip.id}/history`);
      return res.json() as Promise<{ picks: any[]; handoffs: any[] }>;
    },
  });

  const refresh = () => {
    queryClient.invalidateQueries({ queryKey: detailKey });
    queryClient.invalidateQueries({ queryKey: ["/api/sort-slips", "history", slip?.id] });
    queryClient.invalidateQueries({ queryKey: ["/api/sort-slips/loaders"] });
    // A pick is a Scan History row ("Sort Pick"), so that page's cache is stale the moment one is
    // recorded or removed. Without this it kept showing what it had until someone refreshed by
    // hand — the page only polls on its own first page.
    queryClient.invalidateQueries({ queryKey: ["/api/scan-sessions/reports/scan-history"] });
    onChanged();
  };

  const totals = items.reduce(
    (acc, i) => ({ expected: acc.expected + i.expectedQty, picked: acc.picked + i.pickedQty }),
    { expected: 0, picked: 0 },
  );
  const shortfall = totals.expected - totals.picked;

  const pickMutation = useMutation({
    mutationFn: async () => {
      const res = await apiRequest("POST", `/api/sort-slips/${slip.id}/pick`, {
        itemId: pickTarget?.id, qty: Number(pickQty),
      });
      return res.json();
    },
    onSuccess: (data: any) => {
      toast({
        title: "Picked",
        description: `${pickTarget?.itemName ?? "Item"} · +${pickQty}${data.remaining > 0 ? ` · ${data.remaining} still to go` : " · line complete"}`,
      });
      setPickTarget(null);
      setPickQty("");
      setPickPallets("");
      refresh();
    },
    onError: (err: any) => toast({ title: "Could not record that", description: err.message, variant: "destructive" }),
  });

  const transferMutation = useMutation({
    mutationFn: async () => {
      // No "from": the slip has one loader, and the server reads who that is.
      const res = await apiRequest("POST", `/api/sort-slips/${slip.id}/transfer`, {
        toUserCode: transferTo, reason: transferReason,
      });
      return res.json();
    },
    onSuccess: () => {
      toast({ title: "Loader changed" });
      setTransferOpen(false);
      setTransferTo(""); setTransferSearch(""); setTransferReason("");
      refresh();
    },
    onError: (err: any) => toast({ title: "Could not transfer", description: err.message, variant: "destructive" }),
  });

  // Steps the current loader off without naming a replacement — unlike transfer, which always
  // hands it to somebody. The loader is free the moment this succeeds; the slip itself just goes
  // back to unassigned, same state a brand-new slip starts in.
  const pauseMutation = useMutation({
    mutationFn: () => apiRequest("POST", `/api/sort-slips/${slip.id}/pause`),
    onSuccess: () => { toast({ title: "Sort slip paused", description: "The loader is free for another slip." }); refresh(); },
    onError: (err: any) => toast({ title: "Could not pause", description: err.message, variant: "destructive" }),
  });

  // The dialog itself (SortSlipDeleteDialog) owns the delete/replace mutations — after either
  // one, the loader picker's cache and Scan History both need a refetch, same as the landing
  // list's own after-delete step, and this view specifically goes back to the list (the slip it
  // was showing no longer exists, or exists as a different slip entirely after a replace).
  const afterDeleteOrReplace = () => {
    setDeleteOpen(false);
    queryClient.invalidateQueries({ queryKey: ["/api/sort-slips/loaders"] });
    queryClient.invalidateQueries({ queryKey: ["/api/scan-sessions/reports/scan-history"] });
    onBack();
  };

  const completeMutation = useMutation({
    mutationFn: () => apiRequest("POST", `/api/sort-slips/${slip.id}/complete`),
    onSuccess: () => { toast({ title: "Sort slip completed" }); setCompleteOpen(false); refresh(); },
    onError: (err: any) => toast({ title: "Could not complete", description: err.message, variant: "destructive" }),
  });

  const reopenMutation = useMutation({
    mutationFn: () => apiRequest("POST", `/api/sort-slips/${slip.id}/reopen`),
    onSuccess: (res: any) => {
      // The loader only gets it back if they were still free — say so rather than leaving a slip
      // that looks active but has nobody on it.
      const busy = (res as any)?.busyLoader;
      toast({
        title: "Sort slip reopened",
        description: busy ? `${busy} is on another slip now — transfer this one to somebody` : undefined,
      });
      refresh();
    },
    onError: (err: any) => toast({ title: "Could not reopen", description: err.message, variant: "destructive" }),
  });

  const voidMutation = useMutation({
    mutationFn: (pickId: number) => apiRequest("POST", `/api/sort-slips/picks/${pickId}/void`),
    onSuccess: () => { toast({ title: "Entry removed" }); refresh(); },
    onError: (err: any) => toast({ title: "Could not remove", description: err.message, variant: "destructive" }),
  });

  if (detailQuery.isLoading) {
    return (
      <div className="py-4 lg:py-6">
        <div className="mx-auto w-full max-w-[1800px]">
          <Button variant="ghost" size="sm" className="mb-3 text-gray-600" onClick={onBack}>
            <ArrowLeft className="mr-2 h-4 w-4" /> All sort slips
          </Button>
          {/* Mirrors the real header's shape (order/badges, party/date, progress+action buttons,
              loader chip) so nothing jumps once the real data lands. */}
          <Card className="mb-4 overflow-hidden">
            <div className="border-b border-gray-200 bg-white px-4 py-3">
              <div className="flex flex-wrap items-start justify-between gap-3">
                <div className="min-w-0 space-y-2">
                  <div className="flex flex-wrap items-center gap-2">
                    <SkeletonBar className="h-6 w-40" />
                    <SkeletonBar className="h-5 w-16 rounded-full" />
                    <SkeletonBar className="h-5 w-20 rounded-full" />
                  </div>
                  <SkeletonBar className="h-3.5 w-52" />
                </div>
                <div className="flex w-full flex-wrap items-center gap-2 sm:w-auto">
                  <SkeletonBar className="h-2 w-24 rounded-full" />
                  <SkeletonBar className="h-9 w-28 rounded-md sm:h-8" />
                  <SkeletonBar className="h-9 w-28 rounded-md sm:h-8" />
                  <SkeletonBar className="h-9 w-20 rounded-md sm:h-8" />
                </div>
              </div>
              <div className="mt-2 flex items-center gap-1.5">
                <SkeletonBar className="h-3 w-14" />
                <SkeletonBar className="h-5 w-24 rounded-full" />
              </div>
            </div>
          </Card>
          <Card className="mb-4 overflow-hidden p-4">
            <TableSkeleton columns={6} rows={6} />
          </Card>
        </div>
      </div>
    );
  }
  if (detailQuery.isError || !slip) {
    return (
      <div className="p-8 text-center">
        <p className="text-sm text-gray-500">{(detailQuery.error as any)?.message ?? "This sort slip could not be opened."}</p>
        <Button variant="outline" className="mt-3" onClick={onBack}><ArrowLeft className="mr-2 h-4 w-4" /> Back</Button>
      </div>
    );
  }

  const remainingOf = (item: SortSlipItem) => Math.max(0, item.expectedQty - item.pickedQty);
  // A quantity and what it is in pallets, one above the other in the same cell. Pallets get their
  // own columns on the scanning pages, but this table is read at a glance while walking a rack —
  // three numbers with their pallet count underneath beats six columns.
  const qtyCell = (qty: number, palletSize: number, tone: string) => (
    <div className="leading-tight">
      {/* Bumped from text-base — the Item column's own three lines (name/barcode/pallet-size)
          are taller than this cell either way, so a bigger number here doesn't grow the row. */}
      <div className={`text-lg tabular-nums ${tone}`}>{qty ? qty.toLocaleString() : "—"}</div>
      {palletSize > 0 && (
        <div className="text-[13px] tabular-nums text-gray-500">{(qty / palletSize).toFixed(2)} plt</div>
      )}
    </div>
  );

  // Navy-and-white, ruled the same way as Overall Scan Ops / Scan Operations, so the pages read
  // as one system — but this page's own columns: what was ordered, what has been picked, what is
  // left. The barcode sits under the item name rather than taking a column, and pallets belong in
  // the pick popup where they are actually counted.
  //
  // The widths below add up to about 680px on purpose. The table lays columns out as percentages
  // of their declared widths and only scrolls sideways once the total no longer fits, so seven
  // columns this size fill a laptop window edge to edge with nothing to drag.
  const headerBorder = "border-r border-white/10 !text-xs sm:!text-[13px]";
  const cellBorder = "border-r border-gray-200 !text-sm !py-3";

  const itemColumns: DataTableColumn<SortSlipItem>[] = [
    {
      id: "box", header: "Box Image", width: 86, minWidth: 64, align: "center", totalable: false, sortable: false,
      headerClassName: headerBorder,
      cellClassName: `text-center ${cellBorder}`,
      render: (item) => <div className="flex justify-center"><ItemPhoto item={item} size={48} /></div>,
    },
    {
      id: "srNo", header: "Sr", width: 56, minWidth: 44, align: "center", sortable: true, totalable: false,
      accessor: (item) => item.srNo ?? "",
      headerClassName: headerBorder,
      cellClassName: `text-center text-base tabular-nums font-semibold text-gray-700 ${cellBorder}`,
      render: (item) => item.srNo || <span className="text-gray-300">—</span>,
    },
    {
      id: "item", header: "Item", width: 300, minWidth: 160, sortable: true, hideable: false,
      totalable: false,
      // Searching/sorting on the barcode still works even though it is not a column of its own.
      accessor: (item) => `${item.itemName ?? ""} ${item.barcode ?? ""}`,
      headerClassName: headerBorder,
      cellClassName: `min-w-[200px] whitespace-normal break-words ${cellBorder}`,
      render: (item) => (
        <>
          {canWrite ? (
            <button
              type="button"
              onClick={() => setExpandedItemId((cur) => (cur === String(item.id) ? null : String(item.id)))}
              className={`block text-left text-[15px] font-semibold leading-snug text-gray-900 underline decoration-dotted underline-offset-2 ${
                expandedItemId === String(item.id) ? "text-[#001d6e] decoration-[#001d6e]" : "decoration-gray-300"
              }`}
              title="Who picked this line"
            >
              {item.itemName ?? "—"}
            </button>
          ) : (
            <span className="block text-[15px] font-semibold leading-snug text-gray-900">{item.itemName ?? "—"}</span>
          )}
          <span className="block font-mono text-[13px] text-gray-500">{item.barcode ?? "—"}</span>
          {/* The pack size this plant's state uses — the same number the pick popup converts
              pallets with, so the row can be read without opening it. */}
          {item.palletSize > 0 && (
            <span className="block text-[13px] font-semibold text-gray-600">{item.palletSize} per pallet</span>
          )}
        </>
      ),
    },
    {
      id: "expectedQty", header: "Order Qty", width: 92, minWidth: 76, align: "center", sortable: true, totalable: true,
      accessor: (item) => item.expectedQty,
      headerClassName: headerBorder,
      cellClassName: `text-center ${cellBorder}`,
      render: (item) => qtyCell(item.expectedQty, item.palletSize, "text-gray-700"),
    },
    {
      id: "pickedQty", header: "Picked", width: 88, minWidth: 72, align: "center", sortable: true, totalable: true,
      accessor: (item) => item.pickedQty,
      headerClassName: headerBorder,
      cellClassName: `text-center ${cellBorder}`,
      render: (item) => qtyCell(item.pickedQty, item.palletSize, item.pickedQty > 0 ? "font-semibold text-green-600" : "text-gray-300"),
    },
    {
      id: "remaining", header: "Remaining", width: 92, minWidth: 76, align: "center", sortable: true, totalable: true,
      accessor: (item) => remainingOf(item),
      headerClassName: headerBorder,
      cellClassName: `text-center ${cellBorder}`,
      render: (item) => {
        const left = remainingOf(item);
        return left === 0
          ? <span className="text-lg font-semibold tabular-nums text-green-600">0</span>
          : qtyCell(left, item.palletSize, "font-semibold text-amber-600");
      },
    },
    {
      id: "action", header: "Action", width: 84, minWidth: 76, align: "center", hideable: false, totalable: false,
      sortable: false, preventRowClick: true,
      headerClassName: headerBorder,
      cellClassName: cellBorder,
      render: (item) => (
        canPick && !isCompleted ? (
          <Button
            size="sm"
            className="h-8 bg-[#001d6e] px-4 text-sm font-semibold text-white hover:bg-[#00154b] disabled:bg-gray-200 disabled:text-gray-500"
            disabled={remainingOf(item) === 0}
            onClick={() => { setPickTarget(item); setPickQty(""); setPickPallets(""); }}
          >
            {remainingOf(item) === 0 ? "Done" : "Pick"}
          </Button>
        ) : null
      ),
    },
  ];



  return (
    <div className="py-4 lg:py-6">
      <div className="mx-auto w-full max-w-[1800px]">
        <Button variant="ghost" size="sm" className="mb-3 text-gray-600" onClick={onBack}>
          <ArrowLeft className="mr-2 h-4 w-4" /> All sort slips
        </Button>

        {/* Sticky — order/status/actions/loader stay on screen while the item list below
            scrolls, instead of scrolling away with everything else on a long order. */}
        <Card className="sticky top-0 z-20 mb-4 overflow-hidden shadow-sm">
          <div className="border-b border-gray-200 bg-white px-3 py-2 sm:px-4 sm:py-3">
            {/* Order number + badges always get their own row. */}
            <div className="flex flex-wrap items-center gap-1.5 sm:gap-2">
              <h2 className="text-base font-bold text-gray-900 sm:text-xl">{slip.orderNumber}</h2>
              <Badge variant="outline" className={STATUS_STYLES[slip.status] ?? ""}>
                {STATUS_LABELS[slip.status] ?? slip.status}
              </Badge>
              {slip.plant && <PlantBadge plant={slip.plant} className="text-[10px]" />}
              {slip.platformStv && (
                <Badge variant="outline" className="text-[10px]" title="The Dispatch Directory this slip was created for — set once at creation">
                  Dispatch Directory: {slip.platformStv}
                </Badge>
              )}
            </div>
            {/* Party/date and the progress bar + action buttons are direct siblings in ONE flex
                row now (they used to be in separate blocks, so they could never share a line no
                matter how much width was free) — wherever both actually fit side by side, they
                sit on the same row right after the date; otherwise this row wraps on its own. */}
            <div className="mt-1 flex flex-wrap items-center justify-between gap-2 sm:gap-3">
              <p className="text-xs text-gray-500 sm:text-sm">
                {slip.partyName || "—"} · {slip.orderDate ?? "—"}
                {slip.completedAt && ` · completed by ${slip.completedByName ?? "—"}`}
              </p>
              <div className="flex w-full flex-wrap items-center gap-1.5 md:w-auto md:gap-2">
                <ProgressBar picked={totals.picked} total={totals.expected} />

                {/* Icon-only below sm (label hidden, kept for a11y via title); flex-1 so the row
                    stretches edge-to-edge instead of a few small buttons sitting on the left
                    with dead space past them — the container itself stays full-width through md,
                    only reverting to natural/inline sizing on genuine desktop widths. */}
                {canWrite && !isCompleted && (
                  <>
                    {canManageAssignment && (
                      <Button
                        size="sm" title="Change Loader"
                        className="h-8 flex-1 bg-[#001d6e] px-2 text-xs text-white hover:bg-[#00154b] sm:px-3 md:flex-none"
                        onClick={() => setTransferOpen(true)}
                      >
                        <ArrowRightLeft className="h-3.5 w-3.5 sm:mr-1.5" /> <span className="hidden sm:inline">Change Loader</span>
                      </Button>
                    )}
                    <Button
                      size="sm" title="Complete"
                      className="h-8 flex-1 bg-green-600 px-2 text-xs text-white hover:bg-green-700 sm:px-3 md:flex-none"
                      onClick={() => setCompleteOpen(true)}
                    >
                      <CheckCircle2 className="h-3.5 w-3.5 sm:mr-1.5" /> <span className="hidden sm:inline">Complete</span>
                    </Button>
                    {/* Only while a loader is actually on it — pausing an already-unassigned slip
                        makes no sense, and this is the one-click "free the loader now" action,
                        not Loading's own two-step Pause/Claim. */}
                    {slip.status === "active" && canManageAssignment && (
                      <Button
                        size="sm" variant="outline" title="Pause"
                        className="h-8 flex-1 border-amber-200 px-2 text-xs text-amber-700 hover:bg-amber-50 sm:px-3 md:flex-none"
                        onClick={() => pauseMutation.mutate()}
                        disabled={pauseMutation.isPending}
                      >
                        {pauseMutation.isPending ? <Loader2 className="h-3.5 w-3.5 animate-spin sm:mr-1.5" /> : <Pause className="h-3.5 w-3.5 sm:mr-1.5" />}
                        <span className="hidden sm:inline">Pause</span>
                      </Button>
                    )}
                    {/* Only before Complete — a finished sort is a record, not a draft. */}
                    <Button
                      size="sm" variant="outline" title="Delete"
                      className="h-8 flex-1 border-red-200 px-2 text-xs text-red-600 hover:bg-red-50 hover:text-red-700 sm:px-3 md:flex-none"
                      onClick={() => setDeleteOpen(true)}
                    >
                      <Trash2 className="h-3.5 w-3.5 sm:mr-1.5" /> <span className="hidden sm:inline">Delete</span>
                    </Button>
                  </>
                )}
                {canWrite && isCompleted && (
                  <Button
                    size="sm"
                    className="h-8 flex-1 bg-[#001d6e] text-xs text-white hover:bg-[#00154b] md:flex-none"
                    onClick={() => reopenMutation.mutate()}
                    disabled={reopenMutation.isPending}
                  >
                    <RotateCcw className="mr-1.5 h-3.5 w-3.5" /> Reopen
                  </Button>
                )}
              </div>
            </div>

            {/* Loader chips and the loader-history toggle share one row now instead of two —
                a phone-height sticky header can't afford a whole extra line for what's really
                a footnote link. */}
            <div className="mt-1.5 flex flex-wrap items-center gap-1.5">
              <span className="text-xs text-gray-500">Loader:</span>
              {assignees.length === 0 ? (
                <span className="text-xs text-amber-600">nobody — transfer it to a loader</span>
              ) : assignees.map((a) => (
                <Badge key={a.userCode} variant="outline" className="border-blue-200 bg-blue-50 text-[11px] text-blue-700">
                  {a.userName ?? a.userCode}
                </Badge>
              ))}
              {loaderTimeline.length > 0 && (
                <button
                  type="button"
                  onClick={() => setLoaderHistoryOpen((v) => !v)}
                  className="ml-1 flex items-center gap-1 text-xs font-medium text-gray-500 hover:text-[#001d6e]"
                >
                  <User className="h-3 w-3 text-gray-400" />
                  History
                  <ChevronDown className={`h-3 w-3 text-gray-400 transition-transform ${loaderHistoryOpen ? "rotate-180" : ""}`} />
                </button>
              )}
            </div>

            {/* Every loader who has held this slip, with how much each of them picked while they
                had it — "the loader is an array", the same summary the Loading page keeps for a
                load's owners. Collapsed, so it costs nothing until somebody asks. */}
            {loaderTimeline.length > 0 && (
              <div>
                {loaderHistoryOpen && (
                  <div className="mt-2 overflow-hidden rounded-md border bg-white">
                    <table className="w-full text-sm">
                      <thead className="bg-gray-50 text-left text-xs uppercase tracking-wide text-gray-500">
                        <tr>
                          <th className="px-3 py-2">Loader</th>
                          <th className="px-3 py-2 text-right">Picked Qty</th>
                          <th className="hidden px-3 py-2 sm:table-cell">From</th>
                          <th className="px-3 py-2">To</th>
                        </tr>
                      </thead>
                      <tbody>
                        {loaderTimeline.map((entry, idx) => (
                          <tr key={`${entry.userCode}-${idx}`} className="border-t border-gray-100">
                            <td className="flex items-center gap-1.5 px-3 py-2">
                              <User className="h-3.5 w-3.5 shrink-0 text-gray-400" />
                              {entry.userName ?? entry.userCode}
                            </td>
                            <td className="px-3 py-2 text-right">
                              <Badge className="bg-blue-100 text-blue-800 hover:bg-blue-200">{entry.pickedQty}</Badge>
                            </td>
                            <td className="hidden whitespace-nowrap px-3 py-2 text-gray-500 sm:table-cell">{fmtWhen(entry.from)}</td>
                            <td className="whitespace-nowrap px-3 py-2 text-gray-500">
                              {entry.to ? fmtWhen(entry.to) : <span className="font-medium text-emerald-600">current</span>}
                            </td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                )}
              </div>
            )}
          </div>

        </Card>

        <Card className="mb-4 overflow-hidden">
          {/* Desktop only: the table. Below 1024px — phone or tablet — it could only be read by
              dragging sideways, so the card list underneath takes over there instead. */}
          <DataTable<SortSlipItem>
            // px/py on the wrapper so the search box above the table sits in the card with equal
            // space over and under it, instead of hard against the card's top edge.
            className="hidden px-4 pt-4 lg:block"
            containerClassName="-mx-4 rounded-none border-0"
            headerClassName="bg-[#001d6e] text-white border-[#1a3a9c] hover:bg-[#0a2b7e] hover:text-white"
            columns={itemColumns}
            data={items}
            getRowId={(item) => String(item.id)}
            isLoading={detailQuery.isLoading}
            loadingLabel="Loading items…"
            emptyState="This order has no items."
            sortMode="client"
            enableZebraStripes
            // Same "picked -> tint the row green" treatment the mobile card list uses.
            rowClassName={(item) => (item.pickedQty > 0 ? "bg-green-50" : undefined)}
            // Find a line without reading the whole slip — matches the item name and the barcode,
            // which is what people have in front of them on the floor.
            enableSearch
            searchPlaceholder="Search item or barcode…"
            searchableColumnIds={["item", "srNo"]}
            // Drag a column edge to widen it, as on the other pages.
            enableColumnResizing
            enableTotalsRow
            totalsLabelColumnId="item"
            // A supervisor can open any line to see who picked it and when — the same
            // click-to-expand the Overall Scan Ops table uses for its own per-item history.
            isRowExpandable={() => canWrite}
            expandedRowId={expandedItemId}
            renderExpandedRow={(item) => {
              const picks = (historyQuery.data?.picks ?? []).filter((p: any) => p.itemId === item.id);
              // Same row-numbered, sticky-header table shape as Overall Scan Ops' own item
              // history panel — just this table's own columns: no STV or Order/Vehicle, since a
              // pick has neither and we are already inside one slip's own item list.
              return (
                <div className="bg-gray-50 p-3">
                  {historyQuery.isLoading ? (
                    <SectionSkeleton lines={3} />
                  ) : picks.length === 0 ? (
                    <p className="py-4 text-center text-sm text-gray-400">Nothing picked on this line yet.</p>
                  ) : (
                    <div className="max-h-[50vh] overflow-y-auto border border-gray-200">
                      <table className="w-full table-fixed border-collapse text-xs">
                        <thead>
                          <tr className="sticky top-0 z-10 border-b-2 border-gray-300 bg-gray-100 text-left text-gray-600">
                            <th className="w-7 border-r border-gray-200 px-2 py-2 font-semibold">#</th>
                            <th className="w-[150px] border-r border-gray-200 px-2 py-2 font-semibold">Date &amp; Time</th>
                            <th className="border-r border-gray-200 px-2 py-2 font-semibold">Picked By</th>
                            <th className="w-20 border-r border-gray-200 px-2 py-2 text-center font-semibold">Qty</th>
                            <th className="w-16 border-r border-gray-200 px-2 py-2 font-semibold">Status</th>
                            <th className="w-14 px-2 py-2 text-right font-semibold">Action</th>
                          </tr>
                        </thead>
                        <tbody>
                          {picks.map((p: any, idx: number) => (
                            <tr
                              key={p.id}
                              className={`border-b border-gray-100 ${p.voided ? "opacity-60" : "hover:bg-gray-50"} ${idx % 2 !== 0 ? "bg-slate-50" : "bg-white"}`}
                            >
                              <td className="border-r border-gray-100 px-2 py-2 font-mono text-gray-400">{idx + 1}</td>
                              <td className="truncate border-r border-gray-100 px-2 py-2 text-gray-800">
                                {new Date(p.pickedAt).toLocaleString("en-IN")}
                              </td>
                              <td className="truncate border-r border-gray-100 px-2 py-2 text-gray-600">
                                {p.pickedByName ?? p.pickedByCode}
                              </td>
                              <td className="border-r border-gray-100 px-2 py-2 text-center">
                                <span className={`inline-flex flex-col items-center justify-center rounded-full px-2 py-0.5 text-[11px] font-bold ${
                                  p.voided ? "bg-gray-100 text-gray-400 line-through" : "bg-[#001d6e]/10 text-[#001d6e]"
                                }`}>
                                  +{p.qty}
                                </span>
                                {item.palletSize > 0 && (
                                  <div className="mt-0.5 text-[10px] tabular-nums text-gray-400">{(p.qty / item.palletSize).toFixed(2)} plt</div>
                                )}
                              </td>
                              <td className="truncate border-r border-gray-100 px-2 py-2 text-[11px]">
                                {p.voided ? (
                                  <span className="font-medium text-red-500">Voided</span>
                                ) : (
                                  <span className="font-semibold uppercase text-emerald-700">Picked</span>
                                )}
                              </td>
                              <td className="px-2 py-2 text-right">
                                {!p.voided && !isCompleted && (
                                  <Button
                                    size="sm" variant="ghost"
                                    className="h-6 px-2 text-[11px] text-red-600 hover:bg-red-50 hover:text-red-700"
                                    onClick={() => voidMutation.mutate(p.id)}
                                  >
                                    Void
                                  </Button>
                                )}
                              </td>
                            </tr>
                          ))}
                        </tbody>
                      </table>
                    </div>
                  )}
                </div>
              );
            }}
          />

          {/* Phone / tablet — one card per item, nothing to scroll sideways for. */}
          <div className="lg:hidden">
            {detailQuery.isLoading ? (
              <p className="py-10 text-center text-sm text-gray-400">Loading items…</p>
            ) : items.length === 0 ? (
              <p className="py-10 text-center text-sm text-gray-400">This order has no items.</p>
            ) : items.map((item) => {
              const left = remainingOf(item);
              const picked = item.pickedQty > 0;
              return (
                <div
                  key={item.id}
                  className={`flex items-start gap-3 border-b border-gray-100 px-4 py-3 last:border-b-0 ${picked ? "bg-green-50" : ""}`}
                >
                  <ItemPhoto item={item} size={48} />
                  <div className="min-w-0 flex-1">
                    <div className="flex items-start justify-between gap-2">
                      <span className="text-[15px] font-semibold leading-snug text-gray-900">{item.itemName ?? "—"}</span>
                      <span className="shrink-0 font-mono text-xs font-semibold text-gray-500">{item.srNo || "—"}</span>
                    </div>
                    <p className="mt-0.5 font-mono text-[13px] text-gray-500">{item.barcode ?? "—"}</p>
                    {/* Pallet math right under the barcode — how much makes one pallet, and how
                        many pallets are still needed for what's left. */}
                    {item.palletSize > 0 && (
                      <p className="mt-0.5 text-xs text-gray-400">{item.palletSize}/plt · {(left / item.palletSize).toFixed(2)} plt needed</p>
                    )}
                    {/* Pick on the left (bigger — the button IS the action, it gets the
                        emphasis), Expected/Received/Remain on the right in a bigger font, using
                        the row's spare width instead of sitting small and empty next to it. */}
                    <div className="mt-2 flex items-center justify-between gap-3">
                      {canPick && !isCompleted && (
                        <Button
                          size="sm"
                          className="h-11 shrink-0 bg-[#001d6e] px-6 text-base font-semibold text-white hover:bg-[#00154b] disabled:bg-gray-200 disabled:text-gray-500"
                          disabled={left === 0}
                          onClick={() => { setPickTarget(item); setPickQty(""); setPickPallets(""); }}
                        >
                          {left === 0 ? "Done" : "Pick"}
                        </Button>
                      )}
                      <div className="flex flex-1 flex-wrap items-center justify-end gap-x-3 gap-y-1 text-right text-lg leading-none tabular-nums">
                        <span className="text-gray-500">Expected <strong className="text-xl text-gray-800">{item.expectedQty.toLocaleString()}</strong></span>
                        <span className="text-gray-500">Received <strong className={`text-xl ${picked ? "text-green-600" : "text-gray-400"}`}>{item.pickedQty.toLocaleString()}</strong></span>
                        <span className="text-gray-500">Remain <strong className={`text-xl ${left > 0 ? "text-amber-600" : "text-green-600"}`}>{left.toLocaleString()}</strong></span>
                      </div>
                    </div>
                  </div>
                </div>
              );
            })}
          </div>
        </Card>
      </div>

      {/* Pick — the loader's one write, built like Scan Operations' confirmation: the picture
          filling one side, the item and its numbers on the other, and a big −/+ quantity box.
          The only difference is that nothing is scanned — the number is typed. */}
      <Dialog open={!!pickTarget} onOpenChange={(o) => { if (!o) { setPickTarget(null); setPickQty(""); setPickPallets(""); } }}>
        <DialogContent className="w-[calc(100%-2rem)] max-w-2xl overflow-y-auto rounded-2xl p-0 sm:max-w-3xl">
          {pickTarget && (() => {
            const remaining = remainingOf(pickTarget);
            const typed = Number(pickQty);
            const tooMany = !!pickQty && typed > remaining;
            const plt = pickTarget.palletSize;
            const setQty = (value: number) => {
              const next = Math.max(0, Math.min(remaining, value));
              setPickQty(String(next));
              setPickPallets(plt > 0 && next ? (next / plt).toFixed(2) : "");
            };
            return (
              <div className="flex flex-col sm:flex-row">
                <div className="flex shrink-0 items-center justify-center border-b border-gray-100 bg-gray-50 p-3 sm:w-72 sm:border-b-0 sm:border-r sm:p-4">
                  <ItemPhoto item={pickTarget} className="h-28 w-28 sm:h-60 sm:w-60" />
                </div>
                <div className="min-w-0 flex-1 p-4 sm:p-6">
                  <DialogHeader>
                    <DialogTitle className="flex items-center gap-2.5 text-xl text-[#001d6e] sm:text-2xl">
                      <CheckCircle2 className="h-6 w-6 sm:h-7 sm:w-7" /> How much did you pick?
                    </DialogTitle>
                    <DialogDescription className="min-w-0 space-y-1.5 pt-3 text-left">
                      <p className="text-lg font-bold leading-snug text-gray-900 sm:text-2xl">
                        {pickTarget.itemName || pickTarget.barcode}
                      </p>
                      <p className="font-mono text-base text-gray-500 sm:text-lg">{pickTarget.barcode || "—"}</p>
                    </DialogDescription>
                  </DialogHeader>

                  <div className="space-y-4 py-1">
                    <div className="space-y-1.5 rounded-xl bg-gray-50 px-3 py-2.5 text-sm text-gray-600 sm:px-4 sm:py-3 sm:text-base">
                      <p>Sr: <strong className="font-mono text-gray-700">{pickTarget.srNo || "—"}</strong></p>
                      <p>
                        Order: <strong>{pickTarget.expectedQty.toLocaleString()}</strong>
                        {" · "}Picked: <strong className="text-green-600">{pickTarget.pickedQty.toLocaleString()}</strong>
                      </p>
                      <p>Remaining: <strong className="text-red-600">{remaining.toLocaleString()}</strong> pcs</p>
                    </div>

                    {/* Pieces and pallets side by side, the same pair Scan Operations confirms
                        with: typing in either one recalculates the other. The pallet box only
                        appears when Product Master actually has a size for this state — with no
                        size there is no honest pallet number to show. */}
                    <div className={`grid gap-3 ${plt > 1 ? "sm:grid-cols-2" : "grid-cols-1"}`}>
                    <div className="space-y-1">
                      <Label className="text-sm">
                        Qty (pcs) <span className="font-normal text-gray-400">· up to {remaining.toLocaleString()}</span>
                      </Label>
                      <div className={`flex items-stretch overflow-hidden rounded-xl border-2 bg-white ${
                        tooMany ? "border-red-400" : "border-gray-300 focus-within:border-[#001d6e]"
                      }`}>
                        <Button
                          type="button" variant="ghost"
                          className="h-14 w-14 shrink-0 rounded-none border-r border-gray-200 text-3xl font-bold text-gray-500 hover:bg-gray-100"
                          onClick={() => setQty((Number(pickQty) || 0) - 1)}
                          aria-label="Decrease quantity"
                        >
                          −
                        </Button>
                        <Input
                          inputMode="numeric"
                          value={pickQty}
                          onChange={(e) => {
                            const value = e.target.value.replace(/[^0-9]/g, "");
                            setPickQty(value);
                            setPickPallets(plt > 0 && value ? (Number(value) / plt).toFixed(2) : "");
                          }}
                          onKeyDown={(e) => {
                            if (e.key === "Enter" && typed > 0 && !tooMany) {
                              e.preventDefault();
                              pickMutation.mutate();
                            }
                          }}
                          placeholder="0"
                          className="h-14 flex-1 rounded-none border-0 text-center text-3xl font-bold tabular-nums focus-visible:ring-0 focus-visible:ring-offset-0"
                        />
                        <Button
                          type="button" variant="ghost"
                          className="h-14 w-14 shrink-0 rounded-none border-l border-gray-200 text-3xl font-bold text-gray-500 hover:bg-gray-100"
                          onClick={() => setQty((Number(pickQty) || 0) + 1)}
                          aria-label="Increase quantity"
                        >
                          +
                        </Button>
                      </div>
                    </div>

                    {plt > 1 && (
                      <div className="space-y-1">
                        <Label className="text-sm">
                          Pallets <span className="font-normal text-gray-400">· {plt}/pallet</span>
                        </Label>
                        <div className="flex items-stretch overflow-hidden rounded-xl border-2 border-[#001d6e]/30 bg-white focus-within:border-[#001d6e]">
                          <Button
                            type="button" variant="ghost"
                            className="h-14 w-14 shrink-0 rounded-none border-r border-[#001d6e]/15 text-3xl font-bold text-[#001d6e] hover:bg-[#001d6e]/5"
                            onClick={() => {
                              const next = Math.max(0, Math.round(((parseFloat(pickPallets) || 0) - 1) * 100) / 100);
                              setPickPallets(next ? next.toFixed(2) : "");
                              setQty(Math.round(next * plt));
                            }}
                            aria-label="Decrease pallets"
                          >
                            −
                          </Button>
                          <Input
                            type="number" min={0} step="0.01"
                            value={pickPallets}
                            onChange={(e) => {
                              const raw = e.target.value;
                              setPickPallets(raw);
                              const pallets = parseFloat(raw);
                              if (!Number.isNaN(pallets) && pallets >= 0) setQty(Math.round(pallets * plt));
                            }}
                            placeholder="0.00"
                            className="h-14 flex-1 rounded-none border-0 text-center text-3xl font-bold tabular-nums focus-visible:ring-0 focus-visible:ring-offset-0"
                          />
                          <Button
                            type="button" variant="ghost"
                            className="h-14 w-14 shrink-0 rounded-none border-l border-[#001d6e]/15 text-3xl font-bold text-[#001d6e] hover:bg-[#001d6e]/5"
                            onClick={() => {
                              const next = Math.round(((parseFloat(pickPallets) || 0) + 1) * 100) / 100;
                              setPickPallets(next.toFixed(2));
                              setQty(Math.round(next * plt));
                            }}
                            aria-label="Increase pallets"
                          >
                            +
                          </Button>
                        </div>
                      </div>
                    )}
                    </div>
                    {tooMany && (
                      <p className="text-sm font-semibold text-red-600">
                        Only {remaining.toLocaleString()} left on this item.
                      </p>
                    )}
                    {/* The whole rest of the line in one tap — the common case at the end of an item. */}
                    {remaining > 0 && (
                      <button
                        type="button"
                        onClick={() => setQty(remaining)}
                        className="text-xs font-medium text-[#001d6e] hover:underline"
                      >
                        Take all {remaining.toLocaleString()}
                        {plt > 1 && ` · ${(remaining / plt).toFixed(2)} plt`}
                      </button>
                    )}
                  </div>

                  <DialogFooter className="pt-4">
                    <Button variant="outline" onClick={() => setPickTarget(null)}>Cancel</Button>
                    <Button
                      className="bg-[#001d6e] text-white hover:bg-[#00154b]"
                      disabled={!pickQty || typed <= 0 || tooMany || pickMutation.isPending}
                      onClick={() => pickMutation.mutate()}
                    >
                      {pickMutation.isPending ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : <CheckCircle2 className="mr-2 h-4 w-4" />}
                      Confirm
                    </Button>
                  </DialogFooter>
                </div>
              </div>
            );
          })()}
        </DialogContent>
      </Dialog>

      {/* Transfer — the only way a slip changes hands, and supervisors only. There is no "from"
          to pick: the slip has one loader and the server reads who that is. */}
      <Dialog open={transferOpen} onOpenChange={(o) => {
        setTransferOpen(o);
        if (!o) { setTransferTo(""); setTransferSearch(""); setTransferReason(""); }
      }}>
        <DialogContent className="sm:max-w-[480px]">
          <DialogHeader>
            <DialogTitle>Change this sort slip's loader</DialogTitle>
            <DialogDescription>
              {assignees[0]
                ? `${assignees[0].userName ?? assignees[0].userCode} hands it over. The picks they already made stay theirs — the work happened.`
                : "Nobody is on this slip — hand it to a loader."}
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-3">
            <div>
              <LoaderPicker
                label="Hand it to"
                loaders={loaders}
                search={transferSearch}
                onSearch={setTransferSearch}
                selected={transferTo}
                onSelect={setTransferTo}
                plant={slip.plant}
                isLoading={loadersQuery.isLoading}
                excludeCode={assignees[0]?.userCode ?? null}
              />
            </div>
            <div>
              <label className="mb-1 block text-sm font-medium text-gray-700">
                Reason <span className="font-normal text-gray-400">(optional)</span>
              </label>
              <Input value={transferReason} onChange={(e) => setTransferReason(e.target.value)} placeholder="Shift change…" />
            </div>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setTransferOpen(false)}>Cancel</Button>
            <Button
              className="bg-amber-600 text-white hover:bg-amber-700"
              disabled={!transferTo || transferMutation.isPending}
              onClick={() => transferMutation.mutate()}
            >
              {transferMutation.isPending ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : <ArrowRightLeft className="mr-2 h-4 w-4" />}
              Change Loader
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Delete or Replace — supervisors only, and never once the slip is completed */}
      <SortSlipDeleteDialog
        open={deleteOpen}
        onOpenChange={setDeleteOpen}
        target={{
          id: slip.id, orderNumber: slip.orderNumber, partyName: slip.partyName, plant: slip.plant,
          pickedQty: totals.picked,
          assigneeLabel: assignees[0] ? (assignees[0].userName ?? assignees[0].userCode) : null,
        }}
        onDeleted={afterDeleteOrReplace}
        onReplaced={afterDeleteOrReplace}
      />

      {/* Complete — a slip never closes itself, even when every line is full */}
      <Dialog open={completeOpen} onOpenChange={setCompleteOpen}>
        <DialogContent className="sm:max-w-[440px]">
          <DialogHeader>
            <DialogTitle>Complete this sort slip</DialogTitle>
            <DialogDescription>
              It leaves the loaders' active list and frees them for their next slip.
            </DialogDescription>
          </DialogHeader>
          <div className="rounded-lg border border-gray-200 p-3 text-sm">
            <p className="text-gray-700">
              Picked <span className="font-semibold tabular-nums">{totals.picked.toLocaleString()}</span> of{" "}
              <span className="font-semibold tabular-nums">{totals.expected.toLocaleString()}</span>.
            </p>
            {shortfall > 0 && (
              <p className="mt-1 text-amber-700">
                {shortfall.toLocaleString()} pcs short across{" "}
                {items.filter((i) => i.pickedQty < i.expectedQty).length} item(s) — completing it anyway is fine, it just
                records where the sorting stopped.
              </p>
            )}
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setCompleteOpen(false)}>Cancel</Button>
            <Button
              className="bg-green-600 text-white hover:bg-green-700"
              disabled={completeMutation.isPending}
              onClick={() => completeMutation.mutate()}
            >
              {completeMutation.isPending ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : <CheckCircle2 className="mr-2 h-4 w-4" />}
              Complete
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
