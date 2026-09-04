import { useMemo, useState } from "react";
import { useMutation, useQuery } from "@tanstack/react-query";
import {
  AlertTriangle, Bell, CheckCircle2, ChevronDown, CloudDownload, Columns2, Loader2,
  Pencil, Plus, RefreshCw, Search, Trash2, Truck, X, Zap,
} from "lucide-react";
import PageHeader from "@/components/PageHeader";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import {
  AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent,
  AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import {
  Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle,
} from "@/components/ui/dialog";
import { useToast } from "@/hooks/use-toast";
import { apiRequest, queryClient } from "@/lib/queryClient";
import { hasPageWriteAccess } from "@/lib/permissions";
import type { VehicleInfo } from "@shared/schema";

// ─── Types (mirror server/services/notionVehicleSync.ts + vehicle-info route responses) ───
type EnrichedVehicle = VehicleInfo & { lastEditedByName: string | null; createdByName: string | null };

type VehicleFieldChange = {
  field: string; label: string;
  oldValue: string | number | boolean | null | undefined;
  newValue: string | number | boolean | null | undefined;
};
type VehicleChange = { vehicleId: number; vehicleNumber: string; changes: VehicleFieldChange[] };
type CreatedVehicle = { vehicleNumber: string; notionPageId: string };
type VehicleSyncReport = {
  syncTime: string; total: number; created: number; updated: number; skipped: number; notFound: number;
  triggeredBy: string; appliedBy?: string;
  changedVehicles: VehicleChange[]; createdVehicles: CreatedVehicle[]; errors: string[];
};

function isAdminOrSuper(): boolean {
  try {
    const u = JSON.parse(localStorage.getItem("currentUser") || "{}");
    return u.role === "admin" || u.role === "super-admin";
  } catch { return false; }
}

// Same button classes as NotionInventory.tsx (Product Master) — kept identical so the two
// pages read as one visual system rather than two similar-but-different ones.
const BTN = "h-8 bg-[#001d6e] text-white hover:bg-[#001552] text-xs";
const BTN_OUTLINE = "h-8 border border-[#001d6e] text-[#001d6e] bg-white hover:bg-[#001d6e]/5 text-xs";

type VehicleColumn = { key: keyof EnrichedVehicle; label: string; colWidth?: number };

const vehicleColumns: VehicleColumn[] = [
  { key: "vehicleNumber", label: "Vehicle No", colWidth: 110 },
  { key: "srNo", label: "Sr. No.", colWidth: 70 },
  { key: "rtoNumber", label: "RTO Number", colWidth: 120 },
  { key: "series", label: "Series" },
  { key: "companyType", label: "Company Type" },
  { key: "company", label: "Company" },
  { key: "manufacturer", label: "Manufacturer" },
  { key: "modelYear", label: "Model Year" },
  { key: "engine", label: "Engine" },
  { key: "volume", label: "Volume" },
  { key: "vehiclePercent", label: "Vehicle %" },
  { key: "gps", label: "GPS" },
  { key: "forGps", label: "For GPS" },
  { key: "driver", label: "Driver" },
  { key: "recordDriver", label: "Driver Records" },
  { key: "plant", label: "Plant" },
  { key: "status", label: "Status" },
  { key: "remark", label: "Remark" },
  { key: "acTruckUrl", label: "AC Track" },
  { key: "lastEditedByName", label: "Updated By", colWidth: 110 },
  { key: "lastEditedAt", label: "Updated At", colWidth: 140 },
];

const ALL_KEYS = new Set(vehicleColumns.map((c) => String(c.key)));

function cellValue(vehicle: EnrichedVehicle, key: keyof EnrichedVehicle): string {
  const value = vehicle[key];
  if (value === null || value === undefined || value === "") return "-";
  if (key === "lastEditedAt" || key === "createdAt") {
    return new Date(value as string | Date).toLocaleString("en-IN", { timeZone: "Asia/Kolkata" });
  }
  return String(value);
}

const EDITABLE_FIELDS: { key: keyof VehicleInfo; label: string }[] = [
  { key: "vehicleNumber", label: "Vehicle No" },
  { key: "srNo", label: "Sr. No." },
  { key: "rtoNumber", label: "RTO Number" },
  { key: "series", label: "Series" },
  { key: "companyType", label: "Company Type" },
  { key: "company", label: "Company" },
  { key: "manufacturer", label: "Manufacturer" },
  { key: "modelYear", label: "Model Year" },
  { key: "engine", label: "Engine" },
  { key: "volume", label: "Volume" },
  { key: "vehiclePercent", label: "Vehicle %" },
  { key: "gps", label: "GPS" },
  { key: "forGps", label: "For GPS" },
  { key: "driver", label: "Driver" },
  { key: "recordDriver", label: "Driver Records" },
  { key: "plant", label: "Plant" },
  { key: "status", label: "Status" },
  { key: "remark", label: "Remark" },
  { key: "acTruckUrl", label: "AC Track (link)" },
];

export default function VehicleMaster() {
  const { toast } = useToast();
  const canWrite = hasPageWriteAccess("vehicle-master");
  const admin = isAdminOrSuper();

  const [search, setSearch] = useState("");
  const [visibleColumnKeys, setVisibleColumnKeys] = useState<Set<string>>(new Set(ALL_KEYS));
  const [showPending, setShowPending] = useState(false);
  const [editing, setEditing] = useState<EnrichedVehicle | null>(null);
  const [showAddEdit, setShowAddEdit] = useState(false);
  const [form, setForm] = useState<Record<string, any>>({});
  const [deleteTarget, setDeleteTarget] = useState<EnrichedVehicle | null>(null);
  const [fullSyncConfirm, setFullSyncConfirm] = useState(false);

  const vehiclesQuery = useQuery<EnrichedVehicle[]>({
    queryKey: ["/api/vehicle-info"],
    queryFn: async () => {
      const res = await apiRequest("GET", "/api/vehicle-info?limit=1000");
      return res.json();
    },
  });

  const statusQuery = useQuery<{ isSyncing: boolean; hasPending: boolean; autoApplyEnabled: boolean }>({
    queryKey: ["/api/notion-vehicle-sync/status"],
    queryFn: async () => (await apiRequest("GET", "/api/notion-vehicle-sync/status")).json(),
    enabled: admin,
    refetchInterval: 5000,
  });

  const pendingQuery = useQuery<{ hasPending: boolean; report: VehicleSyncReport | null }>({
    queryKey: ["/api/notion-vehicle-sync/pending"],
    queryFn: async () => (await apiRequest("GET", "/api/notion-vehicle-sync/pending")).json(),
    enabled: admin,
  });

  const detectMutation = useMutation({
    mutationFn: async () => (await apiRequest("POST", "/api/notion-vehicle-sync/detect", {})).json(),
    onSuccess: (report: VehicleSyncReport) => {
      queryClient.invalidateQueries({ queryKey: ["/api/notion-vehicle-sync/pending"] });
      queryClient.invalidateQueries({ queryKey: ["/api/notion-vehicle-sync/status"] });
      const hasChanges = report.created + report.updated > 0;
      toast({
        title: hasChanges ? "Changes detected" : "No changes",
        description: hasChanges ? `${report.created} new, ${report.updated} changed — review below.` : "Vehicle Master is already up to date with Notion.",
      });
      if (hasChanges) setShowPending(true);
    },
    onError: (err: any) => toast({ title: "Check Sync failed", description: err?.message, variant: "destructive" }),
  });

  const applyMutation = useMutation({
    mutationFn: async () => (await apiRequest("POST", "/api/notion-vehicle-sync/apply", {})).json(),
    onSuccess: (report: VehicleSyncReport) => {
      queryClient.invalidateQueries({ queryKey: ["/api/vehicle-info"] });
      queryClient.invalidateQueries({ queryKey: ["/api/notion-vehicle-sync/pending"] });
      toast({ title: "Applied", description: `${report.created} created, ${report.updated} updated.` });
      setShowPending(false);
    },
    onError: (err: any) => toast({ title: "Apply failed", description: err?.message, variant: "destructive" }),
  });

  const fullSyncMutation = useMutation({
    mutationFn: async () => (await apiRequest("POST", "/api/notion-vehicle-sync/full-sync", {})).json(),
    onSuccess: (report: VehicleSyncReport) => {
      queryClient.invalidateQueries({ queryKey: ["/api/vehicle-info"] });
      toast({ title: "Full sync complete", description: `${report.created} vehicles imported from Notion.` });
      setFullSyncConfirm(false);
    },
    onError: (err: any) => toast({ title: "Full sync failed", description: err?.message, variant: "destructive" }),
  });

  const autoApplyMutation = useMutation({
    mutationFn: async (enabled: boolean) => (await apiRequest("POST", "/api/notion-vehicle-sync/auto-apply", { enabled })).json(),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ["/api/notion-vehicle-sync/status"] }),
  });

  const saveMutation = useMutation({
    mutationFn: async (data: Record<string, any>) => {
      const url = editing ? `/api/vehicle-info/${editing.id}` : "/api/vehicle-info";
      const res = await apiRequest(editing ? "PUT" : "POST", url, data);
      return res.json();
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/vehicle-info"] });
      toast({ title: editing ? "Vehicle updated" : "Vehicle added" });
      setShowAddEdit(false);
      setEditing(null);
      setForm({});
    },
    onError: (err: any) => toast({ title: "Save failed", description: err?.message, variant: "destructive" }),
  });

  const deleteMutation = useMutation({
    mutationFn: async (id: number) => apiRequest("DELETE", `/api/vehicle-info/${id}`),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/vehicle-info"] });
      toast({ title: "Vehicle deleted" });
      setDeleteTarget(null);
    },
    onError: (err: any) => toast({ title: "Delete failed", description: err?.message, variant: "destructive" }),
  });

  // Server-side truth (polled every 5s, survives a page refresh or a different admin having
  // triggered it) OR this tab's own in-flight request — either means a sync is running. A large
  // Notion database with rollup/formula properties can take well over a minute per sync, so this
  // has to be a persistent popup, not just a button spinner that resets on refresh.
  const syncInProgress = !!statusQuery.data?.isSyncing || detectMutation.isPending || applyMutation.isPending || fullSyncMutation.isPending;

  const vehicles = vehiclesQuery.data ?? [];
  const filteredVehicles = useMemo(() => {
    const q = search.trim().toLowerCase();
    if (!q) return vehicles;
    return vehicles.filter((v) =>
      [v.vehicleNumber, v.rtoNumber, v.company, v.manufacturer, v.driver, v.plant]
        .some((f) => (f ?? "").toLowerCase().includes(q)));
  }, [vehicles, search]);

  const linkedCount = vehicles.filter((v) => !!v.notionPageId).length;
  const visibleColumns = vehicleColumns.filter((c) => visibleColumnKeys.has(String(c.key)));
  const hiddenCount = vehicleColumns.length - visibleColumns.length;

  function toggleColumn(key: string) {
    setVisibleColumnKeys((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key); else next.add(key);
      return next;
    });
  }

  function openAdd() {
    setEditing(null);
    setForm({});
    setShowAddEdit(true);
  }
  function openEdit(v: EnrichedVehicle) {
    setEditing(v);
    setForm({ ...v });
    setShowAddEdit(true);
  }

  const pendingReport = pendingQuery.data?.report ?? null;

  return (
    <div className="container mx-auto px-3 sm:px-4 py-4 sm:py-6 pb-24">
      <PageHeader
        icon={Truck}
        title="Vehicle Master"
        description="Company vehicle registry — RTO number, driver, plant, GPS and status per truck, synced from Notion."
      />

      {/* Popup instead of an inline banner — stays open for as long as syncInProgress is true
          (server-truth, polled every 5s, so it reflects reality even after a refresh or if
          another admin triggered the sync) and closes itself the moment it flips false. No
          close button — this isn't dismissible, since dismissing it wouldn't stop the sync. */}
      <Dialog open={admin && syncInProgress} onOpenChange={() => {}}>
        <DialogContent
          className="max-w-sm text-center"
          hideCloseButton
          onInteractOutside={(e) => e.preventDefault()}
          onEscapeKeyDown={(e) => e.preventDefault()}
        >
          <div className="flex flex-col items-center gap-3 py-4">
            <Loader2 className="h-8 w-8 animate-spin text-amber-500" />
            <DialogTitle className="text-base">Sync in progress</DialogTitle>
            <DialogDescription className="text-sm">
              This database has several rollup/formula fields, so a Full Sync can take a minute or more. This will close automatically once it's done — safe to leave this tab open.
            </DialogDescription>
          </div>
        </DialogContent>
      </Dialog>

      {/* ── Stats + Actions combined card — same shape as Product Master ─────── */}
      <div className="mb-4 rounded-xl border border-gray-200 bg-white shadow-sm overflow-hidden">

        {/* Stats row */}
        <div className="grid grid-cols-2 md:grid-cols-4 divide-x divide-gray-100 border-b border-gray-100">
          <div className="flex items-center gap-2 sm:gap-3 px-3 py-3 sm:px-5 sm:py-4">
            <div className="h-8 w-8 sm:h-10 sm:w-10 shrink-0 rounded-lg bg-[#001d6e]/10 flex items-center justify-center">
              <Truck className="h-4 w-4 sm:h-5 sm:w-5 text-[#001d6e]" />
            </div>
            <div>
              <p className="text-xl sm:text-2xl font-extrabold text-gray-900 leading-none">{vehicles.length}</p>
              <p className="text-[10px] sm:text-xs font-medium text-gray-500 mt-0.5">Total Vehicles</p>
            </div>
          </div>

          <div className="flex items-center gap-2 sm:gap-3 px-3 py-3 sm:px-5 sm:py-4">
            <div className="h-8 w-8 sm:h-10 sm:w-10 shrink-0 rounded-lg bg-emerald-50 flex items-center justify-center">
              <CheckCircle2 className="h-4 w-4 sm:h-5 sm:w-5 text-emerald-600" />
            </div>
            <div>
              <p className="text-xl sm:text-2xl font-extrabold text-emerald-600 leading-none">{linkedCount}</p>
              <p className="text-[10px] sm:text-xs font-medium text-gray-500 mt-0.5">
                Linked · {vehicles.length > 0 ? Math.round((linkedCount / vehicles.length) * 100) : 0}%
              </p>
            </div>
          </div>

          <div className="flex items-center gap-2 sm:gap-3 px-3 py-3 sm:px-5 sm:py-4">
            <div className={`h-8 w-8 sm:h-10 sm:w-10 shrink-0 rounded-lg flex items-center justify-center ${pendingQuery.data?.hasPending ? "bg-amber-50" : "bg-gray-50"}`}>
              <Bell className={`h-4 w-4 sm:h-5 sm:w-5 ${pendingQuery.data?.hasPending ? "text-amber-500" : "text-gray-300"}`} />
            </div>
            <div>
              <p className={`text-xl sm:text-2xl font-extrabold leading-none ${pendingQuery.data?.hasPending ? "text-amber-600" : "text-gray-300"}`}>
                {(pendingReport?.created ?? 0) + (pendingReport?.updated ?? 0)}
              </p>
              <p className="text-[10px] sm:text-xs font-medium text-gray-500 mt-0.5">Pending</p>
            </div>
          </div>

          <div className="flex items-center gap-2 sm:gap-3 px-3 py-3 sm:px-5 sm:py-4">
            <div className={`h-8 w-8 sm:h-10 sm:w-10 shrink-0 rounded-lg flex items-center justify-center ${syncInProgress ? "bg-amber-50" : "bg-emerald-50"}`}>
              <AlertTriangle className={`h-4 w-4 sm:h-5 sm:w-5 ${syncInProgress ? "text-amber-500" : "text-emerald-500"}`} />
            </div>
            <div>
              <p className={`text-xs sm:text-sm font-bold leading-none ${syncInProgress ? "text-amber-600" : "text-emerald-600"}`}>
                {syncInProgress ? "Syncing…" : "Connected"}
              </p>
              <p className="text-[10px] sm:text-xs font-medium text-gray-500 mt-1">Notion Status</p>
            </div>
          </div>
        </div>

        {/* Action bar */}
        <div className="flex flex-wrap items-center gap-2 px-3 sm:px-4 py-2.5">
          {canWrite && (
            <Button size="sm" className={BTN} onClick={openAdd}>
              <Plus className="mr-1.5 h-3.5 w-3.5" /> Add Vehicle
            </Button>
          )}

          {admin && (
            <>
              {pendingQuery.data?.hasPending && (
                <Button size="sm" className={BTN} onClick={() => setShowPending(true)}>
                  <Bell className="mr-1.5 h-3.5 w-3.5" />
                  Review Changes
                  <span className="ml-1.5 rounded-full bg-white/25 px-1.5 py-0.5 text-[10px] font-bold leading-none">
                    {(pendingReport?.created ?? 0) + (pendingReport?.updated ?? 0)}
                  </span>
                </Button>
              )}
              {/* Persistent — stays visible even after Pending clears, since applying the rest of
                  a batch doesn't fix a vehicle-number collision still sitting in Notion. */}
              <Button size="sm" className={BTN} disabled={syncInProgress} onClick={() => detectMutation.mutate()}>
                {detectMutation.isPending ? <Loader2 className="mr-1.5 h-3.5 w-3.5 animate-spin" /> : <RefreshCw className="mr-1.5 h-3.5 w-3.5" />}
                Check Sync
              </Button>
              <Button size="sm" className={BTN} disabled={syncInProgress} onClick={() => setFullSyncConfirm(true)}>
                {fullSyncMutation.isPending ? <Loader2 className="mr-1.5 h-3.5 w-3.5 animate-spin" /> : <CloudDownload className="mr-1.5 h-3.5 w-3.5" />}
                Full Sync
              </Button>

              {/* Auto Apply toggle — same pill styling as Product Master's Auto Sync toggle */}
              <button
                onClick={() => autoApplyMutation.mutate(!statusQuery.data?.autoApplyEnabled)}
                disabled={statusQuery.isLoading || autoApplyMutation.isPending}
                title="Also controls whether the 24-hour scheduled sync auto-applies changes, not just manual checks"
                className={`h-8 flex items-center gap-2 rounded-md border px-3 text-xs font-semibold transition-all disabled:opacity-60 ${
                  statusQuery.data?.autoApplyEnabled
                    ? "bg-emerald-600 border-emerald-600 text-white hover:bg-emerald-700"
                    : "bg-white border-gray-200 text-gray-500 hover:bg-gray-50"
                }`}
              >
                <span className={`relative inline-flex h-4 w-7 shrink-0 items-center rounded-full transition-colors ${statusQuery.data?.autoApplyEnabled ? "bg-white/30" : "bg-gray-200"}`}>
                  <span className={`absolute h-3 w-3 rounded-full bg-white shadow transition-transform ${statusQuery.data?.autoApplyEnabled ? "translate-x-3.5" : "translate-x-0.5"}`} />
                </span>
                Auto Apply
              </button>
            </>
          )}

          <div className="flex-1" />

          {/* Column selector — identical pattern to Product Master's */}
          <Popover>
            <PopoverTrigger asChild>
              <Button size="sm" variant="outline" className={BTN_OUTLINE}>
                <Columns2 className="mr-1.5 h-3.5 w-3.5" />
                Columns
                {hiddenCount > 0 && (
                  <span className="ml-1.5 rounded-full bg-[#001d6e] text-white px-1.5 py-0.5 text-[10px] font-bold leading-none">
                    -{hiddenCount}
                  </span>
                )}
                <ChevronDown className="ml-1 h-3 w-3" />
              </Button>
            </PopoverTrigger>
            <PopoverContent align="end" className="w-60 p-0">
              <div className="px-3 py-2 border-b border-gray-100 bg-gray-50 rounded-t-md">
                <div className="flex items-center justify-between">
                  <span className="text-[11px] font-bold text-gray-500 uppercase tracking-wide">Columns</span>
                  <div className="flex gap-2">
                    <button className="text-[11px] font-medium text-[#001d6e] hover:underline" onClick={() => setVisibleColumnKeys(new Set(ALL_KEYS))}>
                      Select All
                    </button>
                    <span className="text-gray-300">|</span>
                    <button className="text-[11px] font-medium text-gray-400 hover:text-gray-600 hover:underline" onClick={() => setVisibleColumnKeys(new Set())}>
                      Deselect All
                    </button>
                  </div>
                </div>
                <p className="text-[10px] text-gray-400 mt-0.5">{visibleColumnKeys.size} of {ALL_KEYS.size} selected</p>
              </div>
              <div className="max-h-72 overflow-y-auto py-1">
                {vehicleColumns.map((col) => {
                  const key = String(col.key);
                  const checked = visibleColumnKeys.has(key);
                  return (
                    <label key={key} className="flex items-center gap-2.5 px-3 py-1.5 hover:bg-gray-50 cursor-pointer select-none">
                      <input type="checkbox" checked={checked} onChange={() => toggleColumn(key)} className="h-3.5 w-3.5 rounded border-gray-300 accent-[#001d6e]" />
                      <span className="text-xs text-gray-700 flex-1">{col.label}</span>
                    </label>
                  );
                })}
              </div>
            </PopoverContent>
          </Popover>

          {/* Refresh */}
          <button
            onClick={() => vehiclesQuery.refetch()}
            disabled={vehiclesQuery.isFetching}
            title="Refresh"
            className="flex items-center justify-center h-8 w-8 rounded border border-gray-200 text-gray-500 hover:bg-gray-50 disabled:opacity-40 transition-colors"
          >
            <RefreshCw className={`h-3.5 w-3.5 ${vehiclesQuery.isFetching ? "animate-spin" : ""}`} />
          </button>
        </div>
      </div>

      {/* ── Vehicle table — same card/header/table styling as Product Master ─── */}
      <div className="rounded-xl border border-gray-200 bg-white shadow-sm overflow-hidden">

        {/* Header bar */}
        <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-2 px-3 sm:px-5 py-3 sm:py-3.5 bg-white border-b border-gray-200">
          <div className="flex items-center gap-3">
            <div className="flex h-8 w-8 sm:h-9 sm:w-9 items-center justify-center rounded-lg bg-[#001d6e]/10">
              <Truck className="h-4 w-4 sm:h-5 sm:w-5 text-[#001d6e]" />
            </div>
            <div>
              <div className="text-lg sm:text-xl font-bold tracking-tight text-gray-900">Vehicle Master</div>
              <div className="text-xs text-gray-400 leading-none mt-0.5">
                {search ? `${filteredVehicles.length} of ${vehicles.length} vehicles` : `${vehicles.length} vehicles`}
                {visibleColumns.length < vehicleColumns.length && (
                  <span className="ml-1.5">· {visibleColumns.length} cols shown</span>
                )}
              </div>
            </div>
          </div>
          <div className="relative w-full sm:w-auto sm:shrink-0">
            <Search className="absolute left-2.5 top-1.5 h-3.5 w-3.5 text-gray-400 pointer-events-none" />
            <input
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              placeholder="Search vehicles…"
              className="h-7 w-full sm:w-52 rounded-md border border-gray-200 bg-gray-50 pl-7 pr-6 text-xs text-gray-700 placeholder:text-gray-400 focus:outline-none focus:ring-1 focus:ring-[#001d6e]/30 focus:bg-white"
            />
            {search && (
              <button onClick={() => setSearch("")} className="absolute right-2 top-1.5 text-gray-400 hover:text-gray-600">
                <X className="h-3.5 w-3.5" />
              </button>
            )}
          </div>
        </div>

        {/* Empty state */}
        {!vehiclesQuery.isLoading && vehicles.length === 0 && (
          <div className="flex flex-col items-center justify-center py-20 text-center">
            <div className="mb-4 flex h-16 w-16 items-center justify-center rounded-full bg-[#001d6e]/10">
              <Truck className="h-8 w-8 text-[#001d6e]/40" />
            </div>
            <div className="mb-1 text-base font-semibold text-[#001d6e]">No vehicles yet</div>
            <div className="mb-5 max-w-xs text-sm text-muted-foreground">
              {admin
                ? <>Run <strong>Full Sync</strong> to import your vehicle registry from Notion, or add one manually.</>
                : "No vehicles have been added yet."}
            </div>
            {admin && (
              <Button size="sm" onClick={() => setFullSyncConfirm(true)} disabled={syncInProgress} className="bg-[#001d6e] text-white hover:bg-[#001552]">
                {fullSyncMutation.isPending ? <Loader2 className="mr-1.5 h-4 w-4 animate-spin" /> : <CloudDownload className="mr-1.5 h-4 w-4" />}
                Run Full Sync
              </Button>
            )}
          </div>
        )}

        {/* Mobile swipe hint */}
        {vehicles.length > 0 && visibleColumns.length > 3 && (
          <div className="flex items-center justify-center gap-1.5 py-1 bg-[#001d6e]/5 border-b border-gray-100 sm:hidden">
            <span className="text-[10px] text-[#001d6e]/60 font-medium">← Swipe left / right to see all columns →</span>
          </div>
        )}

        {/* Table */}
        {(vehiclesQuery.isLoading || vehicles.length > 0) && (
          <div className="overflow-x-auto overflow-y-auto max-h-[52vh] sm:max-h-[calc(100vh-320px)] min-h-[260px] sm:min-h-[400px]" style={{ WebkitOverflowScrolling: "touch" }}>
            <table className="w-max min-w-full caption-bottom border-collapse text-xs">
              <thead>
                <tr className="bg-[#001d6e]">
                  {visibleColumns.map((col) => {
                    const isNameCol = col.key === "vehicleNumber";
                    const mw = col.colWidth ? `${col.colWidth}px` : "90px";
                    return (
                      <th
                        key={String(col.key)}
                        style={{ minWidth: mw, maxWidth: isNameCol ? "140px" : undefined }}
                        className={`sticky top-0 ${isNameCol ? "left-0 z-20 bg-[#001d6e]" : "z-10 bg-[#001d6e]"} whitespace-nowrap border-r border-[#1a3a9c] px-2 py-2 sm:px-2.5 sm:py-2.5 text-left text-[10px] sm:text-[11px] font-semibold tracking-wide uppercase text-white`}
                      >
                        {col.label}
                      </th>
                    );
                  })}
                  {canWrite && (
                    <th className="sticky top-0 z-10 bg-[#001d6e] whitespace-nowrap border-r border-[#1a3a9c] px-2 py-2 text-left text-[10px] sm:text-[11px] font-semibold tracking-wide uppercase text-white">
                      Actions
                    </th>
                  )}
                </tr>
              </thead>
              <tbody>
                {vehiclesQuery.isLoading ? (
                  <tr>
                    <td colSpan={visibleColumns.length + (canWrite ? 1 : 0)} className="h-40 text-center text-muted-foreground">
                      <Loader2 className="mx-auto mb-2 h-6 w-6 animate-spin text-[#001d6e]" />
                      <div className="text-sm">Loading vehicle master…</div>
                    </td>
                  </tr>
                ) : filteredVehicles.length === 0 ? (
                  <tr>
                    <td colSpan={visibleColumns.length + (canWrite ? 1 : 0)} className="h-32 text-center text-muted-foreground">
                      <Search className="mx-auto mb-2 h-5 w-5 opacity-30" />
                      <div className="text-sm">No vehicles match your search.</div>
                    </td>
                  </tr>
                ) : (
                  filteredVehicles.map((vehicle, i) => {
                    const isOdd = i % 2 !== 0;
                    return (
                      <tr key={vehicle.id} className={`transition-colors hover:bg-[#001d6e]/[0.04] ${isOdd ? "bg-slate-50" : "bg-white"}`}>
                        {visibleColumns.map((col) => {
                          const isNameCol = col.key === "vehicleNumber";
                          const mw = col.colWidth ? `${col.colWidth}px` : "90px";
                          const val = cellValue(vehicle, col.key);
                          const isEmpty = val === "-";
                          return (
                            <td
                              key={`${vehicle.id}-${String(col.key)}`}
                              style={{ minWidth: mw, maxWidth: isNameCol ? "140px" : "160px" }}
                              className={`border-r border-b border-gray-200 px-1.5 py-1.5 sm:px-2 sm:py-2 ${
                                isNameCol
                                  ? `sticky left-0 z-[5] text-[11px] sm:text-xs font-semibold text-[#001d6e] whitespace-normal break-words leading-snug shadow-[2px_0_4px_-1px_rgba(0,0,0,0.08)] ${isOdd ? "bg-slate-50" : "bg-white"}`
                                  : `text-[11px] sm:text-xs ${isEmpty ? "text-gray-300" : "text-gray-700"} whitespace-nowrap truncate`
                              }`}
                              title={val}
                            >
                              {val}
                            </td>
                          );
                        })}
                        {canWrite && (
                          <td className="border-r border-b border-gray-200 px-1.5 py-1.5 sm:px-2 sm:py-2">
                            <div className="flex gap-1">
                              <Button size="icon" variant="ghost" className="h-7 w-7" onClick={() => openEdit(vehicle)}>
                                <Pencil className="h-3.5 w-3.5" />
                              </Button>
                              <Button size="icon" variant="ghost" className="h-7 w-7 text-red-600 hover:text-red-700" onClick={() => setDeleteTarget(vehicle)}>
                                <Trash2 className="h-3.5 w-3.5" />
                              </Button>
                            </div>
                          </td>
                        )}
                      </tr>
                    );
                  })
                )}
              </tbody>
            </table>
          </div>
        )}
      </div>

      {/* Add/Edit — plain controlled form, not react-hook-form (Product Master itself has no
          manual edit form to mirror here; this is new, kept simple on purpose). */}
      <Dialog open={showAddEdit} onOpenChange={(open) => { if (!open) { setShowAddEdit(false); setEditing(null); } }}>
        <DialogContent className="max-w-2xl max-h-[85vh] overflow-y-auto">
          <DialogHeader>
            <DialogTitle>{editing ? `Edit ${editing.vehicleNumber}` : "Add Vehicle"}</DialogTitle>
            <DialogDescription>{editing ? "Manual edits are overwritten by the next Notion sync Apply, same as Product Master." : "New vehicles added here are not pushed to Notion — only pulled from it."}</DialogDescription>
          </DialogHeader>
          <div className="grid grid-cols-2 gap-3">
            {EDITABLE_FIELDS.map(({ key, label }) => (
              <div key={String(key)} className="space-y-1">
                <Label className="text-xs">{label}</Label>
                <Input
                  value={form[key] ?? ""}
                  onChange={(e) => setForm((f) => ({ ...f, [key]: e.target.value }))}
                  type={key === "volume" || key === "vehiclePercent" || key === "srNo" ? "number" : "text"}
                />
              </div>
            ))}
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setShowAddEdit(false)}>Cancel</Button>
            <Button
              className={BTN}
              disabled={saveMutation.isPending || !form.vehicleNumber}
              onClick={() => saveMutation.mutate({
                ...form,
                srNo: form.srNo ? Number(form.srNo) : undefined,
                volume: form.volume !== "" && form.volume != null ? Number(form.volume) : undefined,
                vehiclePercent: form.vehiclePercent !== "" && form.vehiclePercent != null ? Number(form.vehiclePercent) : undefined,
              })}
            >
              {saveMutation.isPending ? <Loader2 className="mr-1.5 h-3.5 w-3.5 animate-spin" /> : null}
              {editing ? "Save Changes" : "Add Vehicle"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Delete confirmation */}
      <AlertDialog open={!!deleteTarget} onOpenChange={(open) => { if (!open) setDeleteTarget(null); }}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Delete {deleteTarget?.vehicleNumber}?</AlertDialogTitle>
            <AlertDialogDescription>This can't be undone. It won't affect Notion — only this app's copy.</AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction className="bg-red-600 hover:bg-red-700" onClick={() => deleteTarget && deleteMutation.mutate(deleteTarget.id)}>
              Delete
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      {/* Full sync confirmation — this wipes vehicle_info first, same destructive shape as
          Product Master's Full Sync. */}
      <AlertDialog open={fullSyncConfirm} onOpenChange={setFullSyncConfirm}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Full Sync from Notion?</AlertDialogTitle>
            <AlertDialogDescription>This deletes every vehicle currently in Vehicle Master and re-imports everything from Notion from scratch. Any manual edits not present in Notion will be lost.</AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction className="bg-red-600 hover:bg-red-700" onClick={() => fullSyncMutation.mutate()}>
              {fullSyncMutation.isPending ? <Loader2 className="mr-1.5 h-3.5 w-3.5 animate-spin" /> : null}
              Full Sync
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      {/* Pending changes review — same detect → review → apply flow as Product Master. */}
      <Dialog open={showPending} onOpenChange={setShowPending}>
        <DialogContent className="max-w-3xl max-h-[85vh] flex flex-col">
          <DialogHeader>
            <DialogTitle>Pending Changes</DialogTitle>
            <DialogDescription>
              {pendingReport ? `${pendingReport.created} new, ${pendingReport.updated} changed, ${pendingReport.skipped} unchanged.` : "No pending changes."}
            </DialogDescription>
          </DialogHeader>
          <div className="min-h-0 flex-1 space-y-4 overflow-y-auto">
            {pendingReport?.createdVehicles && pendingReport.createdVehicles.length > 0 && (
              <div>
                <h4 className="mb-1.5 text-xs font-semibold uppercase text-gray-500">New ({pendingReport.createdVehicles.length})</h4>
                <ul className="space-y-0.5 text-sm">
                  {pendingReport.createdVehicles.map((v) => (
                    <li key={v.notionPageId} className="rounded bg-emerald-50 px-2 py-1 text-emerald-700">{v.vehicleNumber}</li>
                  ))}
                </ul>
              </div>
            )}
            {pendingReport?.changedVehicles && pendingReport.changedVehicles.length > 0 && (
              <div>
                <h4 className="mb-1.5 text-xs font-semibold uppercase text-gray-500">Changed ({pendingReport.changedVehicles.length})</h4>
                <div className="space-y-2">
                  {pendingReport.changedVehicles.map((v) => (
                    <div key={v.vehicleId} className="rounded border p-2 text-sm">
                      <div className="font-semibold">{v.vehicleNumber}</div>
                      {v.changes.map((c) => (
                        <div key={c.field} className="flex gap-2 text-xs text-gray-500">
                          <span className="w-32 shrink-0 text-gray-400">{c.label}</span>
                          <span className="line-through">{String(c.oldValue ?? "—")}</span>
                          <span>→</span>
                          <span className="font-medium text-gray-800">{String(c.newValue ?? "—")}</span>
                        </div>
                      ))}
                    </div>
                  ))}
                </div>
              </div>
            )}
            {pendingReport?.errors && pendingReport.errors.length > 0 && (
              <div>
                <h4 className="mb-1.5 text-xs font-semibold uppercase text-red-500">Errors ({pendingReport.errors.length})</h4>
                <ul className="space-y-0.5 text-xs text-red-600">
                  {pendingReport.errors.map((e, i) => <li key={i}>{e}</li>)}
                </ul>
              </div>
            )}
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setShowPending(false)}>Close</Button>
            <Button className={BTN} disabled={applyMutation.isPending} onClick={() => applyMutation.mutate()}>
              {applyMutation.isPending ? <Loader2 className="mr-1.5 h-3.5 w-3.5 animate-spin" /> : <CheckCircle2 className="mr-1.5 h-3.5 w-3.5" />}
              Apply
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
