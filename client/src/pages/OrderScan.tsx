import { useEffect, useRef, useState } from "react";
import { useLocation } from "wouter";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Result } from "@zxing/library";
import BarcodeScanner from "@/lib/barcodeScanner";
import { apiRequest } from "@/lib/queryClient";
import { useToast } from "@/hooks/use-toast";
import { useAuth } from "@/hooks/use-auth";
import {
  AlertTriangle, ArrowLeft, Camera, CheckCircle2, Clock, Eye,
  Filter, Keyboard, Loader2, PackageCheck, RefreshCw, ScanLine,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Progress } from "@/components/ui/progress";
import {
  Dialog, DialogContent, DialogDescription,
  DialogFooter, DialogHeader, DialogTitle,
} from "@/components/ui/dialog";
import {
  Select, SelectContent, SelectItem, SelectTrigger, SelectValue,
} from "@/components/ui/select";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { Alert, AlertDescription } from "@/components/ui/alert";

// ── Types ────────────────────────────────────────────────────────────────────

type Session = {
  id: number; plant: string; csvFileName: string; rowCount: number;
  importedByName: string | null; createdAt: string;
  scanStatus: string; scanActivatedByName: string | null;
  scanActivatedAt: string | null; scanCompletedAt: string | null;
};

type ScanItem = {
  id: number; sessionId: number;
  barcode: string | null; itemName: string | null; sapCode: string | null;
  expectedQty: number; itemsPerPallet: number;
  scannedPallets: number; scannedLooseQty: number; totalScannedQty: number;
  status: string; lastScannedAt: string | null;
};

type PendingScan = { barcode: string; matchedItem: ScanItem | null };

const NO_STV = "__none__";

// ── Helpers ──────────────────────────────────────────────────────────────────

function itemStatusIcon(status: string) {
  if (status === "complete")
    return <CheckCircle2 className="h-4 w-4 text-green-500 shrink-0" />;
  if (status === "partial")
    return <ScanLine className="h-4 w-4 text-amber-500 shrink-0" />;
  return <span className="inline-block h-4 w-4 rounded-full border-2 border-gray-300 shrink-0" />;
}

function fmtTime(iso: string | null) {
  if (!iso) return "—";
  return new Date(iso).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
}

// ── Root: picks view by role ──────────────────────────────────────────────────

export default function OrderScan() {
  const { user } = useAuth();
  const role = ((user as any)?.role ?? "").toLowerCase().trim();
  const dept = ((user as any)?.department ?? "").toLowerCase().trim();

  // Monitor view: admin / billing / super-admin (no department-based dispatch)
  const isMonitor = ["admin", "super-admin", "billing"].includes(role);

  // Extract plant from department: "DISPATCH {VALSAD}" → "valsad", "Valsad" → "valsad"
  const NON_PLANT = new Set(["admin", "super-admin", "billing", "user", "dispatch", "read", "write", "it", "management", ""]);
  const deptPlant = dept.replace(/^dispatch[\s_-]*/i, "").replace(/[{}\[\]()]/g, "").trim();
  // Anyone with a real plant in their department gets the scan view
  const isDispatch = !isMonitor && !NON_PLANT.has(deptPlant);

  if (isMonitor) return <MonitorView />;
  return <ScanView />;
}

// ════════════════════════════════════════════════════════════════════════════
// MONITOR VIEW  —  admin / billing / super-admin
// Read-only dashboard showing active and completed sessions today
// ════════════════════════════════════════════════════════════════════════════

function MonitorView() {
  const [, navigate] = useLocation();
  const [expandedId, setExpandedId] = useState<number | null>(null);

  const sessionsQuery = useQuery<Session[]>({
    queryKey: ["/api/order-scan/sessions"],
    queryFn: () => apiRequest("GET", "/api/order-scan/sessions").then((r) => r.json()),
    refetchInterval: 15000,
  });

  const itemsQuery = useQuery<ScanItem[]>({
    queryKey: ["/api/order-scan/sessions", expandedId, "items"],
    queryFn: () =>
      apiRequest("GET", `/api/order-scan/sessions/${expandedId}/items`).then((r) => r.json()),
    enabled: expandedId !== null,
  });

  const sessions  = sessionsQuery.data ?? [];
  const active    = sessions.filter((s) => s.scanStatus === "active");
  const completed = sessions.filter((s) => s.scanStatus === "completed");
  const available = sessions.filter((s) => s.scanStatus === "available");

  const expandItems = itemsQuery.data ?? [];
  const expandDone  = expandItems.filter((i) => i.status === "complete").length;
  const expandPct   = expandItems.length ? Math.round((expandDone / expandItems.length) * 100) : 0;

  function toggleExpand(id: number) {
    setExpandedId((prev) => (prev === id ? null : id));
  }

  return (
    <main className="min-h-screen bg-gray-50 p-4 sm:p-6 lg:p-8">
      <div className="mx-auto max-w-5xl space-y-6">

        {/* Header */}
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-3">
            <div className="flex h-11 w-11 items-center justify-center rounded-md bg-[#001d6e] text-white">
              <Eye className="h-6 w-6" />
            </div>
            <div>
              <h1 className="text-2xl font-semibold text-gray-950">Scan Monitor</h1>
              <p className="text-sm text-gray-500">Live view of today's scan sessions</p>
            </div>
          </div>
          <div className="flex gap-2">
            <Button variant="outline" size="sm" onClick={() => navigate("/order-import")}>
              <PackageCheck className="mr-1.5 h-4 w-4" /> Load CSV for Scan
            </Button>
            <Button
              variant="outline" size="sm"
              onClick={() => sessionsQuery.refetch()}
              disabled={sessionsQuery.isFetching}
            >
              <RefreshCw className={`mr-1.5 h-4 w-4 ${sessionsQuery.isFetching ? "animate-spin" : ""}`} />
              Refresh
            </Button>
          </div>
        </div>

        {/* Summary strip */}
        <div className="grid grid-cols-3 gap-4">
          {[
            { label: "Active", count: active.length,    color: "bg-amber-100  text-amber-800  border-amber-200" },
            { label: "Available", count: available.length, color: "bg-blue-50     text-blue-700   border-blue-200" },
            { label: "Completed", count: completed.length, color: "bg-green-50   text-green-800  border-green-200" },
          ].map(({ label, count, color }) => (
            <div key={label} className={`rounded-lg border px-4 py-3 text-center ${color}`}>
              <p className="text-2xl font-bold">{count}</p>
              <p className="text-xs font-medium mt-0.5">{label}</p>
            </div>
          ))}
        </div>

        {sessionsQuery.isLoading ? (
          <div className="flex justify-center py-16">
            <Loader2 className="h-8 w-8 animate-spin text-[#001d6e]" />
          </div>
        ) : sessions.length === 0 ? (
          <Card className="rounded-md">
            <CardContent className="flex flex-col items-center py-16 text-gray-400">
              <ScanLine className="h-10 w-10 mb-3 opacity-20" />
              <p className="text-sm">No sessions today. Go to Order Import to upload a CSV.</p>
              <Button className="mt-4 bg-[#001d6e] text-white hover:bg-[#00154b]" onClick={() => navigate("/order-import")}>
                Go to Order Import
              </Button>
            </CardContent>
          </Card>
        ) : (
          <div className="space-y-6">

            {/* Active sessions */}
            {active.length > 0 && (
              <section>
                <h2 className="mb-3 flex items-center gap-2 text-sm font-semibold text-gray-700 uppercase tracking-wide">
                  <span className="h-2 w-2 rounded-full bg-amber-400 animate-pulse" />
                  Active Now
                </h2>
                <div className="space-y-3">
                  {active.map((s) => (
                    <SessionMonitorCard
                      key={s.id}
                      session={s}
                      expanded={expandedId === s.id}
                      onToggle={() => toggleExpand(s.id)}
                      items={expandedId === s.id ? expandItems : []}
                      itemsLoading={expandedId === s.id && itemsQuery.isLoading}
                      expandDone={expandedId === s.id ? expandDone : 0}
                      expandPct={expandedId === s.id ? expandPct : 0}
                    />
                  ))}
                </div>
              </section>
            )}

            {/* Available sessions */}
            {available.length > 0 && (
              <section>
                <h2 className="mb-3 text-sm font-semibold text-gray-700 uppercase tracking-wide">
                  Available (not yet loaded)
                </h2>
                <div className="space-y-2">
                  {available.map((s) => (
                    <SessionMonitorCard key={s.id} session={s} expanded={false} onToggle={() => {}} items={[]} itemsLoading={false} expandDone={0} expandPct={0} />
                  ))}
                </div>
              </section>
            )}

            {/* Completed sessions */}
            {completed.length > 0 && (
              <section>
                <h2 className="mb-3 flex items-center gap-2 text-sm font-semibold text-gray-700 uppercase tracking-wide">
                  <CheckCircle2 className="h-4 w-4 text-green-500" />
                  Completed Today
                </h2>
                <div className="space-y-2">
                  {completed.map((s) => (
                    <SessionMonitorCard
                      key={s.id}
                      session={s}
                      expanded={expandedId === s.id}
                      onToggle={() => toggleExpand(s.id)}
                      items={expandedId === s.id ? expandItems : []}
                      itemsLoading={expandedId === s.id && itemsQuery.isLoading}
                      expandDone={expandedId === s.id ? expandDone : 0}
                      expandPct={expandedId === s.id ? expandPct : 0}
                    />
                  ))}
                </div>
              </section>
            )}
          </div>
        )}
      </div>
    </main>
  );
}

// ── Monitor session card ──────────────────────────────────────────────────────

function SessionMonitorCard({
  session, expanded, onToggle, items, itemsLoading, expandDone, expandPct,
}: {
  session: Session; expanded: boolean; onToggle: () => void;
  items: ScanItem[]; itemsLoading: boolean; expandDone: number; expandPct: number;
}) {
  const isActive    = session.scanStatus === "active";
  const isCompleted = session.scanStatus === "completed";

  return (
    <Card className={`rounded-md overflow-hidden ${isActive ? "border-amber-200" : isCompleted ? "border-green-200" : ""}`}>
      <div
        className={`flex items-center gap-3 px-4 py-3 ${isActive ? "cursor-pointer hover:bg-amber-50/30" : isCompleted ? "cursor-pointer hover:bg-green-50/30" : ""}`}
        onClick={isActive || isCompleted ? onToggle : undefined}
      >
        {/* Status dot */}
        <span className={`h-2.5 w-2.5 shrink-0 rounded-full ${isActive ? "bg-amber-400 animate-pulse" : isCompleted ? "bg-green-400" : "bg-gray-300"}`} />

        <div className="flex-1 min-w-0">
          <p className="truncate text-sm font-semibold text-gray-900">{session.csvFileName}</p>
          <div className="flex flex-wrap items-center gap-x-2 gap-y-0.5 mt-0.5">
            <span className="rounded bg-[#001d6e]/10 px-1.5 py-0.5 text-[10px] font-semibold text-[#001d6e] uppercase">{session.plant}</span>
            <span className="text-xs text-gray-400">{session.rowCount} rows</span>
            {session.importedByName && (
              <span className="text-xs text-gray-400">by {session.importedByName}</span>
            )}
          </div>
        </div>

        {/* Right meta */}
        <div className="shrink-0 text-right text-xs text-gray-500 space-y-0.5">
          {isActive && (
            <>
              <p className="text-amber-700 font-medium">{session.scanActivatedByName ?? "Scanning…"}</p>
              <p className="flex items-center gap-1 justify-end"><Clock className="h-3 w-3" />{fmtTime(session.scanActivatedAt)}</p>
            </>
          )}
          {isCompleted && (
            <p className="text-green-700 font-medium flex items-center gap-1">
              <CheckCircle2 className="h-3 w-3" /> {fmtTime(session.scanCompletedAt)}
            </p>
          )}
          {!isActive && !isCompleted && (
            <Badge variant="outline" className="text-gray-400 text-[10px]">Available</Badge>
          )}
        </div>
      </div>

      {/* Expanded item list */}
      {expanded && (
        <div className="border-t bg-gray-50 px-4 pb-4 pt-3">
          {itemsLoading ? (
            <div className="flex justify-center py-6"><Loader2 className="h-5 w-5 animate-spin text-[#001d6e]" /></div>
          ) : items.length > 0 ? (
            <>
              <div className="mb-3 flex items-center gap-3">
                <Progress value={expandPct} className="h-2 flex-1" />
                <span className="text-xs font-medium text-gray-600 whitespace-nowrap">{expandDone}/{items.length} done ({expandPct}%)</span>
              </div>
              <div className="overflow-x-auto overflow-y-auto max-h-64 rounded border bg-white">
                <table className="w-full border-collapse text-xs">
                  <thead>
                    <tr>
                      {["", "Item", "Expected", "Scanned", "Status"].map((h) => (
                        <th key={h} className="sticky top-0 z-10 border-b bg-gray-50 px-3 py-2 text-left text-[11px] font-semibold text-gray-500 whitespace-nowrap">{h}</th>
                      ))}
                    </tr>
                  </thead>
                  <tbody>
                    {items.map((item) => (
                      <tr key={item.id} className={`border-b ${item.status === "complete" ? "bg-green-50/40" : item.status === "partial" ? "bg-amber-50/40" : ""}`}>
                        <td className="px-3 py-1.5">{itemStatusIcon(item.status)}</td>
                        <td className="max-w-[200px] truncate px-3 py-1.5 font-medium" title={item.itemName ?? ""}>{item.itemName ?? "—"}</td>
                        <td className="px-3 py-1.5 text-right">{item.expectedQty}</td>
                        <td className="px-3 py-1.5 text-right font-semibold">{item.totalScannedQty}</td>
                        <td className="px-3 py-1.5">
                          {item.status === "complete"
                            ? <Badge className="bg-green-100 text-green-800 text-[10px] border-0">Done</Badge>
                            : item.status === "partial"
                            ? <Badge className="bg-amber-100 text-amber-800 text-[10px] border-0">Partial</Badge>
                            : <Badge variant="outline" className="text-gray-400 text-[10px]">Pending</Badge>}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </>
          ) : (
            <p className="py-4 text-center text-xs text-gray-400">No scan items yet</p>
          )}
        </div>
      )}
    </Card>
  );
}

// ════════════════════════════════════════════════════════════════════════════
// SCAN VIEW  —  dispatch / user
// Shows active session for user's plant and allows scanning
// ════════════════════════════════════════════════════════════════════════════

type WhoAmI = { role: string; department: string; plantFilter: string | null };

function ScanView() {
  const { toast } = useToast();
  const qc = useQueryClient();
  const [, navigate] = useLocation();

  const [scanMode, setScanMode] = useState<"camera" | "manual">("camera");
  const [colFilters, setColFilters] = useState<{ item: string; barcode: string; status: string }>({ item: "", barcode: "", status: "" });
  const [openFilter, setOpenFilter] = useState<string | null>(null);
  const [pendingScan, setPendingScan] = useState<PendingScan | null>(null);
  const [pallets, setPallets]   = useState(1);
  const [looseQty, setLooseQty] = useState(0);
  const [selectedStv, setSelectedStv] = useState("");
  const [recentScans, setRecentScans] = useState<
    { barcode: string; name: string; total: number; stv: string; isExtra: boolean }[]
  >([]);

  const videoRef   = useRef<HTMLVideoElement>(null);
  const scannerRef = useRef<BarcodeScanner | null>(null);
  const [cameraReady, setCameraReady] = useState(false);
  const [cameraError, setCameraError] = useState<string | null>(null);
  const lastScanRef = useRef("");

  // Debug: what plant does the server see for this user?
  const whoamiQuery = useQuery<WhoAmI>({
    queryKey: ["/api/order-scan/whoami"],
    queryFn: () => apiRequest("GET", "/api/order-scan/whoami").then((r) => r.json()),
  });

  // Active session for this dispatch user's plant
  const sessionQuery = useQuery<Session | null>({
    queryKey: ["/api/order-scan/active"],
    queryFn: () => apiRequest("GET", "/api/order-scan/active").then((r) => r.json()),
    refetchInterval: 10000,
  });

  const session = sessionQuery.data ?? null;

  const itemsQuery = useQuery<ScanItem[]>({
    queryKey: ["/api/order-scan/sessions", session?.id, "items"],
    queryFn: () =>
      apiRequest("GET", `/api/order-scan/sessions/${session!.id}/items`).then((r) => r.json()),
    enabled: !!session,
    refetchInterval: 8000,
  });

  const stvsQuery = useQuery<string[]>({
    queryKey: ["/api/order-scan/stvs", session?.plant],
    queryFn: () =>
      apiRequest("GET", `/api/order-scan/stvs?plant=${encodeURIComponent(session!.plant)}`).then((r) => r.json()),
    enabled: !!session?.plant,
  });

  const scanMutation = useMutation({
    mutationFn: (payload: { barcode: string; pallets: number; looseQty: number; isExtra: boolean; stv: string | null }) =>
      apiRequest("POST", `/api/order-scan/sessions/${session!.id}/scan`, payload).then((r) => r.json()),
    onSuccess: (data) => {
      qc.invalidateQueries({ queryKey: ["/api/order-scan/sessions", session?.id, "items"] });
      setRecentScans((prev) => [
        {
          barcode: data.event.barcode,
          name:    data.event.itemName ?? data.event.barcode,
          total:   data.event.totalQty,
          stv:     data.event.stv ?? "",
          isExtra: data.event.isExtra,
        },
        ...prev.slice(0, 4),
      ]);
      setPendingScan(null);
      setSelectedStv("");
    },
    onError: (err: any) =>
      toast({ title: "Scan failed", description: err.message, variant: "destructive" }),
  });

  useEffect(() => {
    if (session && scanMode === "camera") startCamera();
    return () => stopCamera();
  }, [session?.id, scanMode]);

  async function startCamera() {
    if (!videoRef.current) return;
    setCameraError(null);
    const scanner = new BarcodeScanner({
      onDetected: (result: Result) => {
        const code = result.getText();
        if (!code || code === lastScanRef.current) return;
        lastScanRef.current = code;
        setTimeout(() => { lastScanRef.current = ""; }, 2000);
        handleBarcodeScan(code);
      },
      onError: (err: Error) => {
        if (err.message.includes("permission")) {
          setCameraError(err.message);
          setScanMode("manual");
        }
      },
    });
    scannerRef.current = scanner;
    await scanner.initialize();
    await scanner.start(videoRef.current);
    setCameraReady(true);
  }

  function stopCamera() {
    scannerRef.current?.stop();
    scannerRef.current = null;
    setCameraReady(false);
  }

  function handleBarcodeScan(barcode: string) {
    if (pendingScan) return;
    const match = (itemsQuery.data ?? []).find((i) => i.barcode === barcode) ?? null;
    setPallets(1);
    setLooseQty(0);
    setSelectedStv("");
    setPendingScan({ barcode, matchedItem: match });
  }

  function handleConfirmScan() {
    if (!pendingScan) return;
    const stvs = stvsQuery.data ?? [];
    if (stvs.length > 0 && !selectedStv) {
      toast({ title: "Select an STV first", variant: "destructive" });
      return;
    }
    scanMutation.mutate({
      barcode:  pendingScan.barcode,
      pallets,
      looseQty,
      isExtra:  !pendingScan.matchedItem,
      stv:      selectedStv || null,
    });
  }

  const items     = itemsQuery.data ?? [];
  const stvs      = stvsQuery.data  ?? [];
  const filtered = items.filter((i) => {
    if (colFilters.item && !i.itemName?.toLowerCase().includes(colFilters.item.toLowerCase())) return false;
    if (colFilters.barcode && !i.barcode?.toLowerCase().includes(colFilters.barcode.toLowerCase())) return false;
    if (colFilters.status && i.status !== colFilters.status) return false;
    return true;
  });

  const totalItems   = items.length;
  const doneItems    = items.filter((i) => i.status === "complete").length;
  const partialItems = items.filter((i) => i.status === "partial").length;
  const progressPct  = totalItems ? Math.round((doneItems / totalItems) * 100) : 0;
  const plt          = pendingScan?.matchedItem?.itemsPerPallet ?? 1;
  const calcTotal    = Math.round(pallets * Math.max(1, plt)) + looseQty;

  // Loading state
  if (sessionQuery.isLoading) {
    return (
      <div className="flex min-h-screen items-center justify-center">
        <Loader2 className="h-8 w-8 animate-spin text-[#001d6e]" />
      </div>
    );
  }

  // No active session for this plant
  if (!session) {
    const whoami = whoamiQuery.data;
    return (
      <main className="min-h-screen bg-gray-50 p-4 sm:p-6 lg:p-8">
        <div className="mx-auto max-w-lg space-y-6 pt-16">
          <div className="flex flex-col items-center text-center gap-4">
            <div className="flex h-16 w-16 items-center justify-center rounded-full bg-gray-100">
              <PackageCheck className="h-8 w-8 text-gray-400" />
            </div>
            <div>
              <h2 className="text-xl font-semibold text-gray-900">No active scan session</h2>
              <p className="mt-1 text-sm text-gray-500">
                Ask billing / admin to go to <strong>Order Import</strong> and load a CSV for your plant.
              </p>
            </div>

            {/* Debug info — shows what plant the server is filtering by */}
            {whoami && (
              <div className="w-full rounded-md border border-dashed bg-white px-4 py-3 text-left text-xs space-y-1 text-gray-500">
                <p><span className="font-semibold text-gray-700">Role:</span> {whoami.role || "—"}</p>
                <p><span className="font-semibold text-gray-700">Department:</span> {whoami.department || "—"}</p>
                <p>
                  <span className="font-semibold text-gray-700">Looking for plant:</span>{" "}
                  {whoami.plantFilter
                    ? <span className="font-mono text-[#001d6e] font-semibold">{whoami.plantFilter.toUpperCase()}</span>
                    : <span className="text-amber-600">No plant detected — will search all plants</span>}
                </p>
              </div>
            )}

            <Button
              variant="outline"
              onClick={() => { sessionQuery.refetch(); whoamiQuery.refetch(); }}
              disabled={sessionQuery.isFetching}
            >
              <RefreshCw className={`mr-2 h-4 w-4 ${sessionQuery.isFetching ? "animate-spin" : ""}`} />
              Check again
            </Button>
          </div>
        </div>
      </main>
    );
  }

  // ── Active scan view ────────────────────────────────────────────────────────
  return (
    <main className="flex min-h-screen flex-col bg-gray-50">

      {/* Top bar */}
      <div className="sticky top-0 z-20 border-b bg-white px-4 py-3 shadow-sm">
        <div className="mx-auto flex max-w-7xl items-center gap-3">
          <div className="flex-1 min-w-0">
            <p className="truncate text-sm font-semibold text-gray-900">{session.csvFileName}</p>
            <p className="text-xs text-gray-500">{session.plant} · {totalItems} items</p>
          </div>
          <div className="hidden sm:flex items-center gap-2 text-xs text-gray-500">
            <Progress value={progressPct} className="w-24 h-2" />
            <span className="whitespace-nowrap font-medium">{doneItems}/{totalItems}</span>
          </div>
        </div>
      </div>

      <div className="mx-auto w-full max-w-7xl flex-1 p-4 sm:p-6">
        {/* Mobile progress */}
        <div className="sm:hidden mb-4 space-y-1">
          <div className="flex justify-between text-xs text-gray-500">
            <span>{doneItems} done · {partialItems} partial · {totalItems - doneItems - partialItems} pending</span>
            <span>{progressPct}%</span>
          </div>
          <Progress value={progressPct} className="h-2" />
        </div>

        <div className="grid gap-6 lg:grid-cols-[1fr_340px]">

          {/* Item list */}
          <Card className="rounded-md">
            <CardHeader className="pb-3">
              <div className="flex items-center justify-between">
                <CardTitle className="text-base">Items ({totalItems})</CardTitle>
                <div className="flex items-center gap-2">
                  {(colFilters.item || colFilters.barcode || colFilters.status) && (
                    <button
                      className="text-xs text-red-500 hover:underline"
                      onClick={() => setColFilters({ item: "", barcode: "", status: "" })}
                    >
                      Clear filters
                    </button>
                  )}
                  <div className="hidden sm:flex items-center gap-3 text-xs text-gray-500">
                    <span className="flex items-center gap-1"><CheckCircle2 className="h-3 w-3 text-green-500" />{doneItems} done</span>
                    <span className="flex items-center gap-1"><ScanLine className="h-3 w-3 text-amber-500" />{partialItems} partial</span>
                  </div>
                </div>
              </div>
            </CardHeader>
            <CardContent className="p-0">
              {itemsQuery.isLoading ? (
                <div className="flex justify-center py-10">
                  <Loader2 className="h-6 w-6 animate-spin text-[#001d6e]" />
                </div>
              ) : (
                <div className="overflow-x-auto overflow-y-auto max-h-[480px]">
                  <table className="w-full border-collapse text-sm">
                    <thead>
                      <tr>
                        <th className="sticky top-0 z-10 border-b bg-slate-50 px-3 py-2 w-8" />

                        {/* Item — text filter */}
                        <th className="sticky top-0 z-10 border-b bg-slate-50 px-3 py-2 text-left whitespace-nowrap">
                          <Popover open={openFilter === "item"} onOpenChange={(o) => setOpenFilter(o ? "item" : null)}>
                            <PopoverTrigger asChild>
                              <button className={`flex items-center gap-1 text-xs font-semibold ${colFilters.item ? "text-[#001d6e]" : "text-gray-600"} hover:text-[#001d6e]`}>
                                Item
                                <Filter className={`h-3 w-3 ${colFilters.item ? "fill-[#001d6e]" : "text-gray-400"}`} />
                              </button>
                            </PopoverTrigger>
                            <PopoverContent className="w-52 p-3" align="start">
                              <p className="text-xs font-semibold text-gray-500 mb-2">Filter by Item</p>
                              <Input autoFocus placeholder="Search item name…" value={colFilters.item}
                                onChange={(e) => setColFilters((f) => ({ ...f, item: e.target.value }))}
                                className="h-7 text-xs" />
                              {colFilters.item && (
                                <button className="mt-1.5 text-xs text-red-400 hover:underline"
                                  onClick={() => setColFilters((f) => ({ ...f, item: "" }))}>Clear</button>
                              )}
                            </PopoverContent>
                          </Popover>
                        </th>

                        {/* Barcode — text filter */}
                        <th className="sticky top-0 z-10 border-b bg-slate-50 px-3 py-2 text-left whitespace-nowrap">
                          <Popover open={openFilter === "barcode"} onOpenChange={(o) => setOpenFilter(o ? "barcode" : null)}>
                            <PopoverTrigger asChild>
                              <button className={`flex items-center gap-1 text-xs font-semibold ${colFilters.barcode ? "text-[#001d6e]" : "text-gray-600"} hover:text-[#001d6e]`}>
                                Barcode
                                <Filter className={`h-3 w-3 ${colFilters.barcode ? "fill-[#001d6e]" : "text-gray-400"}`} />
                              </button>
                            </PopoverTrigger>
                            <PopoverContent className="w-52 p-3" align="start">
                              <p className="text-xs font-semibold text-gray-500 mb-2">Filter by Barcode</p>
                              <Input autoFocus placeholder="Search barcode…" value={colFilters.barcode}
                                onChange={(e) => setColFilters((f) => ({ ...f, barcode: e.target.value }))}
                                className="h-7 text-xs" />
                              {colFilters.barcode && (
                                <button className="mt-1.5 text-xs text-red-400 hover:underline"
                                  onClick={() => setColFilters((f) => ({ ...f, barcode: "" }))}>Clear</button>
                              )}
                            </PopoverContent>
                          </Popover>
                        </th>

                        {/* Non-filterable columns */}
                        {["Exp", "Pallets", "Loose", "Total"].map((h) => (
                          <th key={h} className="sticky top-0 z-10 border-b bg-slate-50 px-3 py-2 text-left text-xs font-semibold text-gray-600 whitespace-nowrap">{h}</th>
                        ))}

                        {/* Status — option filter */}
                        <th className="sticky top-0 z-10 border-b bg-slate-50 px-3 py-2 text-left whitespace-nowrap">
                          <Popover open={openFilter === "status"} onOpenChange={(o) => setOpenFilter(o ? "status" : null)}>
                            <PopoverTrigger asChild>
                              <button className={`flex items-center gap-1 text-xs font-semibold ${colFilters.status ? "text-[#001d6e]" : "text-gray-600"} hover:text-[#001d6e]`}>
                                Status
                                <Filter className={`h-3 w-3 ${colFilters.status ? "fill-[#001d6e]" : "text-gray-400"}`} />
                              </button>
                            </PopoverTrigger>
                            <PopoverContent className="w-40 p-2" align="start">
                              <p className="text-xs font-semibold text-gray-500 mb-1.5">Filter by Status</p>
                              {([["", "All"], ["complete", "Done"], ["partial", "Partial"], ["pending", "Pending"]] as [string, string][]).map(([val, label]) => (
                                <button key={val}
                                  className={`w-full text-left rounded px-2 py-1.5 text-xs transition-colors ${colFilters.status === val ? "bg-[#001d6e] text-white" : "hover:bg-gray-100 text-gray-700"}`}
                                  onClick={() => { setColFilters((f) => ({ ...f, status: val })); setOpenFilter(null); }}>
                                  {label}
                                </button>
                              ))}
                            </PopoverContent>
                          </Popover>
                        </th>
                      </tr>
                    </thead>
                    <tbody>
                      {filtered.map((item) => (
                        <tr
                          key={item.id}
                          className={`border-b cursor-pointer transition-colors ${
                            item.status === "complete" ? "bg-green-50/40" :
                            item.status === "partial"  ? "bg-amber-50/40" : ""
                          } hover:bg-blue-50/30`}
                          onClick={() => { if (item.barcode) handleBarcodeScan(item.barcode); }}
                        >
                          <td className="px-3 py-2">{itemStatusIcon(item.status)}</td>
                          <td className="max-w-[180px] truncate px-3 py-2 text-xs font-medium" title={item.itemName ?? ""}>{item.itemName ?? "—"}</td>
                          <td className="px-3 py-2 text-xs text-gray-500 font-mono">{item.barcode ?? "—"}</td>
                          <td className="px-3 py-2 text-xs text-right">{item.expectedQty}</td>
                          <td className="px-3 py-2 text-xs text-right">{Number(item.scannedPallets).toFixed(1)}</td>
                          <td className="px-3 py-2 text-xs text-right">{item.scannedLooseQty}</td>
                          <td className="px-3 py-2 text-xs text-right font-semibold">{item.totalScannedQty}</td>
                          <td className="px-3 py-2">
                            {item.status === "complete"
                              ? <Badge className="bg-green-100 text-green-800 text-xs border-0">Done</Badge>
                              : item.status === "partial"
                              ? <Badge className="bg-amber-100 text-amber-800 text-xs border-0">Partial</Badge>
                              : <Badge variant="outline" className="text-gray-400 text-xs">Pending</Badge>}
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                  {filtered.length === 0 && (
                    <p className="py-8 text-center text-sm text-gray-400">No items match</p>
                  )}
                </div>
              )}
            </CardContent>
          </Card>

          {/* Scanner panel */}
          <div className="space-y-4">
            <div className="flex gap-2">
              <Button
                size="sm" variant={scanMode === "camera" ? "default" : "outline"}
                className={`flex-1 ${scanMode === "camera" ? "bg-[#001d6e] text-white" : ""}`}
                onClick={() => setScanMode("camera")}
              >
                <Camera className="mr-2 h-4 w-4" /> Camera
              </Button>
              <Button
                size="sm" variant={scanMode === "manual" ? "default" : "outline"}
                className={`flex-1 ${scanMode === "manual" ? "bg-[#001d6e] text-white" : ""}`}
                onClick={() => { stopCamera(); setScanMode("manual"); }}
              >
                <Keyboard className="mr-2 h-4 w-4" /> Manual
              </Button>
            </div>

            {scanMode === "camera" && (
              <Card className="rounded-md overflow-hidden">
                <div className="relative bg-black aspect-video">
                  <video ref={videoRef} className="h-full w-full object-cover" autoPlay muted playsInline />
                  {!cameraReady && !cameraError && (
                    <div className="absolute inset-0 flex flex-col items-center justify-center text-white gap-2">
                      <Loader2 className="h-8 w-8 animate-spin" />
                      <p className="text-sm">Starting camera…</p>
                    </div>
                  )}
                  {cameraReady && (
                    <div className="pointer-events-none absolute inset-0 flex items-center justify-center">
                      <div className="h-20 w-52 rounded border-2 border-white/70" />
                    </div>
                  )}
                </div>
                {cameraError && (
                  <Alert variant="destructive" className="rounded-none border-0 border-t">
                    <AlertTriangle className="h-4 w-4" />
                    <AlertDescription className="text-xs">{cameraError}</AlertDescription>
                  </Alert>
                )}
              </Card>
            )}

            {scanMode === "manual" && (
              <Card className="rounded-md">
                <CardContent className="p-4 space-y-2">
                  <Label className="text-sm font-medium">Enter barcode</Label>
                  <ManualScanInput onScan={handleBarcodeScan} disabled={!!pendingScan} />
                </CardContent>
              </Card>
            )}

            {recentScans.length > 0 && (
              <Card className="rounded-md">
                <CardHeader className="pb-2 pt-3 px-4">
                  <CardTitle className="text-xs font-semibold uppercase tracking-wide text-gray-500">Recent Scans</CardTitle>
                </CardHeader>
                <CardContent className="px-4 pb-3 space-y-1.5">
                  {recentScans.map((s, i) => (
                    <div key={i} className={`flex items-center justify-between rounded px-2 py-1.5 text-xs ${s.isExtra ? "bg-orange-50" : "bg-green-50"}`}>
                      <div className="min-w-0">
                        <p className="truncate font-medium max-w-[160px]" title={s.name}>{s.name}</p>
                        {s.stv && <p className="text-gray-400 text-[10px]">{s.stv}</p>}
                      </div>
                      <span className={`font-mono shrink-0 ml-2 ${s.isExtra ? "text-orange-700" : "text-green-700"}`}>
                        {s.isExtra ? "EXTRA" : `+${s.total}`}
                      </span>
                    </div>
                  ))}
                </CardContent>
              </Card>
            )}
          </div>
        </div>
      </div>

      {/* Confirmation dialog */}
      <Dialog open={!!pendingScan} onOpenChange={(o) => { if (!o) { setPendingScan(null); setSelectedStv(""); } }}>
        <DialogContent className="max-w-sm">
          <DialogHeader>
            <DialogTitle className={`flex items-center gap-2 ${!pendingScan?.matchedItem ? "text-orange-700" : "text-green-700"}`}>
              {!pendingScan?.matchedItem
                ? <><AlertTriangle className="h-5 w-5" /> Not in order</>
                : <><CheckCircle2 className="h-5 w-5" /> Match found</>}
            </DialogTitle>
            <DialogDescription className="text-left space-y-0.5 pt-1">
              <p className="font-semibold text-gray-900 text-sm">
                {pendingScan?.matchedItem?.itemName ?? "Unknown item"}
              </p>
              <p className="font-mono text-xs text-gray-400">{pendingScan?.barcode}</p>
              {!pendingScan?.matchedItem && (
                <p className="text-xs text-orange-600 pt-1">This barcode is not in the CSV order. It will be logged as extra.</p>
              )}
            </DialogDescription>
          </DialogHeader>

          <div className="space-y-4 py-1">
            {pendingScan?.matchedItem && (
              <div className="rounded-md bg-gray-50 px-3 py-2 text-xs text-gray-600 space-y-0.5">
                <p>Items / pallet: <strong>{pendingScan.matchedItem.itemsPerPallet || "—"}</strong></p>
                <p>Expected: <strong>{pendingScan.matchedItem.expectedQty}</strong> · Scanned so far: <strong>{pendingScan.matchedItem.totalScannedQty}</strong></p>
              </div>
            )}

            <div className="grid grid-cols-2 gap-3">
              <div className="space-y-1">
                <Label htmlFor="sc-pallets" className="text-sm">Pallets</Label>
                <Input
                  id="sc-pallets" type="number" min={0} step={0.5}
                  value={pallets}
                  onChange={(e) => setPallets(parseFloat(e.target.value) || 0)}
                  className="text-center text-xl font-bold h-12"
                />
              </div>
              <div className="space-y-1">
                <Label htmlFor="sc-loose" className="text-sm">Loose Qty</Label>
                <Input
                  id="sc-loose" type="number" min={0}
                  value={looseQty}
                  onChange={(e) => setLooseQty(parseInt(e.target.value) || 0)}
                  className="text-center text-xl font-bold h-12"
                />
              </div>
            </div>

            <div className="rounded-md bg-[#001d6e]/5 border border-[#001d6e]/20 px-4 py-3 text-center">
              <p className="text-xs text-gray-500 mb-1">Total boxes</p>
              <p className="text-4xl font-bold text-[#001d6e]">{calcTotal}</p>
              {pendingScan?.matchedItem?.itemsPerPallet ? (
                <p className="text-xs text-gray-400 mt-0.5">
                  {pallets} × {pendingScan.matchedItem.itemsPerPallet} + {looseQty} loose
                </p>
              ) : null}
            </div>

            {stvs.length > 0 && (
              <div className="space-y-1">
                <Label className="text-sm">STV <span className="text-red-500">*</span></Label>
                <Select
                  value={selectedStv || NO_STV}
                  onValueChange={(v) => setSelectedStv(v === NO_STV ? "" : v)}
                >
                  <SelectTrigger className={`w-full ${!selectedStv ? "border-dashed text-gray-400" : ""}`}>
                    <SelectValue placeholder="Select STV…" />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value={NO_STV}>— Select STV —</SelectItem>
                    {stvs.map((s) => (
                      <SelectItem key={s} value={s}>{s}</SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
            )}
          </div>

          <DialogFooter className="gap-2">
            <Button variant="outline" onClick={() => { setPendingScan(null); setSelectedStv(""); }}>Cancel</Button>
            <Button
              onClick={handleConfirmScan}
              disabled={scanMutation.isPending || (stvs.length > 0 && !selectedStv)}
              className="bg-[#001d6e] hover:bg-[#00154b] text-white"
            >
              {scanMutation.isPending && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
              Confirm Scan
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </main>
  );
}

// ── Manual barcode input ──────────────────────────────────────────────────────

function ManualScanInput({ onScan, disabled }: { onScan: (code: string) => void; disabled: boolean }) {
  const [value, setValue] = useState("");
  const ref = useRef<HTMLInputElement>(null);
  useEffect(() => { ref.current?.focus(); }, []);

  return (
    <div className="flex gap-2">
      <Input
        ref={ref}
        value={value}
        onChange={(e) => setValue(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "Enter" && value.trim()) { onScan(value.trim()); setValue(""); }
        }}
        placeholder="Scan or type barcode…"
        disabled={disabled}
        className="font-mono"
        autoFocus
      />
      <Button
        size="sm"
        disabled={!value.trim() || disabled}
        onClick={() => { if (value.trim()) { onScan(value.trim()); setValue(""); } }}
        className="bg-[#001d6e] hover:bg-[#00154b] text-white shrink-0"
      >
        <ScanLine className="h-4 w-4" />
      </Button>
    </div>
  );
}
