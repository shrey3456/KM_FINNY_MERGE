import { useEffect, useRef, useState } from "react";
import { useLocation } from "wouter";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import Papa from "papaparse";
import { getCurrentUserPermissions, hasPageWriteAccess } from "../lib/permissions";
import {
  AlertCircle,
  CheckCircle,
  CheckCircle2,
  ChevronDown,
  ChevronRight,
  FileUp,
  History,
  Loader2,
  PackageCheck,
  RefreshCw,
  ScanLine,
  Search,
  StopCircle,
  Trash2,
  Upload,
  X,
} from "lucide-react";
import { useAuth } from "@/hooks/use-auth";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Badge } from "@/components/ui/badge";
import { Alert, AlertDescription } from "@/components/ui/alert";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { useToast } from "@/hooks/use-toast";
import { apiRequest } from "@/lib/queryClient";
import type { OrderImportSession, OrderImportItem } from "@shared/schema";

// ── Fixed target columns ─────────────────────────────────────────────────────
const TARGET_FIELDS = [
  { key: "barcode",         label: "Barcode / SKU" },
  { key: "itemName",        label: "Item Name" },
  { key: "sapCode",         label: "SAP Code" },
  { key: "quantity",        label: "Quantity" },
  { key: "expectedPallets", label: "Expected Pallets" },
] as const;
type TargetKey = (typeof TARGET_FIELDS)[number]["key"];
type Mapping = Record<TargetKey, string>;

const SKIP = "__skip__";

// Strip BOM and extra whitespace from a CSV header
function cleanHeader(h: string): string {
  return h.replace(/^﻿/, "").replace(/[^\x20-\x7E]/g, "").trim();
}

function autoMatch(headers: string[]): Mapping {
  // Build a normalised version: lowercase, strip spaces/underscores/special chars
  const norm = headers.map((h) => h.toLowerCase().replace(/[\s_\-+*]/g, ""));

  const best = (...kws: string[]) => {
    // 1. exact normalised match
    for (const kw of kws) {
      const k = kw.toLowerCase().replace(/[\s_\-+*]/g, "");
      const i = norm.findIndex((h) => h === k);
      if (i !== -1) return headers[i];
    }
    // 2. starts-with match
    for (const kw of kws) {
      const k = kw.toLowerCase().replace(/[\s_\-+*]/g, "");
      const i = norm.findIndex((h) => h.startsWith(k));
      if (i !== -1) return headers[i];
    }
    // 3. contains match
    for (const kw of kws) {
      const k = kw.toLowerCase().replace(/[\s_\-+*]/g, "");
      const i = norm.findIndex((h) => h.includes(k));
      if (i !== -1) return headers[i];
    }
    return SKIP;
  };

  return {
    // barcode: look for barcode, sku, product code, item code, bar code
    barcode: best(
      "barcode", "bar code", "bar_code",
      "sku", "product code", "productcode", "item code", "itemcode",
      "code", "product_code", "item_no", "itemno", "article"
    ),
    // item name: product name, item name, description, product+name combo
    itemName: best(
      "product name", "productname", "item name", "itemname",
      "product+name", "productcode+productname", "description",
      "name", "item", "product"
    ),
    // sap code
    sapCode: best(
      "sap code", "sapcode", "sap_code", "sap",
      "material code", "materialcode", "material no", "materialno"
    ),
    // quantity: total column preferred over individual dealer qty
    quantity: best(
      "total", "grand total", "sum", "total qty", "total quantity",
      "quantity", "qty", "boxes", "nos", "pcs", "count", "units"
    ),
    // expected pallets
    expectedPallets: best(
      "expected pallets", "expectedpallets", "expected pallet",
      "pallets", "pallet", "plt", "expected"
    ),
  };
}

type ScanSession = {
  id: number; plant: string; csvFileName: string; rowCount: number;
  scanStatus: string; importedByName: string | null; createdAt: string | null;
  scanActivatedByName: string | null; scanActivatedAt: string | null; scanCompletedAt: string | null;
  scanActivatedByCode:string | null;
};

// DB stores timestamps in IST (server local time). The pg driver reads them as UTC
// and JSON serializes with Z, shifting the time by +5:30. To undo this, display
// using timeZone "UTC" so the raw stored value (= actual IST time) is shown as-is.
// Display-only: strips a trailing ".csv" from a file name so it reads cleanly in the UI.
function stripCsvExt(name?: string | null): string {
  return (name ?? "").replace(/\.csv$/i, "");
}

function fmtIST(dt: string | Date | null | undefined): string {
  if (!dt) return "—";
  const s = dt instanceof Date ? dt.toISOString() : String(dt);
  const d = new Date(/Z$|[+-]\d{2}:\d{2}$/.test(s) ? s : s.replace(" ", "T") + "Z");
  if (isNaN(d.getTime())) return "—";
  return d.toLocaleString("en-IN", { timeZone: "UTC" });
}

function getLocalISODate(date = new Date()): string {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

export default function OrderImport() {
  const { toast } = useToast();
  const qc = useQueryClient();
  const fileRef = useRef<HTMLInputElement>(null);
  const [, navigate] = useLocation();
  const { user } = useAuth();
  const role = ((user as any)?.role ?? "").toLowerCase();
  const department = ((user as any)?.department ?? "").toLowerCase();
  const userPermissions = getCurrentUserPermissions();
  const isImportRole = ["admin", "super-admin"].includes(role)
    || department === "billing"
    || userPermissions.canAccessOrderManagement;
  // Separate from page VISIBILITY (isImportRole above) — this controls whether the
  // currently-visible page's own write actions (Upload, Map & Import, Delete) are enabled.
  // Admin/super-admin/billing always have write access (unchanged); anyone else needs
  // admin to have explicitly granted "Order Import" in their Write Access on the
  // User Management page.
  const canWriteOrderImport = ["admin", "super-admin"].includes(role)
    || department === "billing"
    || hasPageWriteAccess("order-import");

  // Form state
  const [plant, setPlant] = useState("");
  const [orderDate, setOrderDate] = useState(getLocalISODate());
  // Upload CSV: select one or many files; you Map & Import EACH one in turn (a mapping
  // dialog per file). All files sharing the same plant + Order Date auto-group into one
  // FIFO batch server-side (Part 1 loads, the rest auto-advance on complete).
  const [selectedFiles, setSelectedFiles] = useState<File[]>([]);
  const [isBatchImporting, setIsBatchImporting] = useState(false);
  // Sequential per-file Map & Import queue.
  const uploadQueueRef = useRef<File[]>([]);
  const uploadIdxRef = useRef(0);
  const uploadCollectedRef = useRef<{ sessionIds: number[]; fileNames: string[]; failed: string[]; totalRows: number; groupId: number | null }>({ sessionIds: [], fileNames: [], failed: [], totalRows: 0, groupId: null });
  const [uploadProgress, setUploadProgress] = useState<{ current: number; total: number } | null>(null);

  // CSV parse result
  const [csvData, setCsvData] = useState<{
    name: string;
    headers: string[];
    rows: Record<string, string>[];
  } | null>(null);
  const [mapping, setMapping] = useState<Mapping>({
    barcode: SKIP, itemName: SKIP, sapCode: SKIP, quantity: SKIP, expectedPallets: SKIP,
  });
  const [showMappingDialog, setShowMappingDialog] = useState(false);

  // Session view
  const [showHistory, setShowHistory] = useState(false);
  const [expandedId, setExpandedId] = useState<number | null>(null);
  const [itemSearch, setItemSearch] = useState("");
  const [deleteTarget, setDeleteTarget] = useState<number | null>(null);
  const [deactivateTarget, setDeactivateTarget] = useState<number | null>(null);
  const [completeTarget, setCompleteTarget] = useState<number | null>(null);
  const [lastImport, setLastImport] = useState<{ rowCount: number } | null>(null);

  // Server-side pagination + date filter (default empty = show all, avoids UTC/IST mismatch)
  const todayStr = getLocalISODate();
  const [pageSize, setPageSize] = useState(10);
  const [currentPage, setCurrentPage] = useState(1);
  const [filterDate, setFilterDate] = useState("");
  const [filterPlant, setFilterPlant] = useState("");

  // Load CSV for Scan — plant and date filters (default empty = server last-48h window)
  const [scanPlant, setScanPlant] = useState("");
  const [scanDate, setScanDate] = useState(todayStr);
  const [scanExpandedId, setScanExpandedId] = useState<number | null>(null);
  const [scanItemSearch, setScanItemSearch] = useState("");

  // Currently Active card — own plant/date filters
  const [activePlant, setActivePlant] = useState("");
  const [activeDate, setActiveDate] = useState("");

  // Completed Sessions card — own plant/date filters, collapsed by default
  const [showCompleted, setShowCompleted] = useState(false);
  const [completedPlant, setCompletedPlant] = useState("");
  const [completedDate, setCompletedDate] = useState("");

  // Live-sync transport status. A successful WS handshake (joined-import) only
  // proves the upgrade succeeded — it does NOT prove that spontaneous server-push
  // frames will actually reach us. Some reverse proxies (IIS ARR in production)
  // keep the socket open but buffer/drop later pushes, so a client can think it
  // is "connected" yet never receive an import-update. Therefore we keep a brisk
  // safety-net poll even when connected (8s) instead of trusting push alone; if
  // the socket truly drops we fall back to fast polling (2.5s).
  const [wsConnected, setWsConnected] = useState(false);
  const SYNC_INTERVAL = wsConnected ? 8_000 : 2_500;

  // ── Queries ────────────────────────────────────────────────────────────────
  type SessionsResponse = {
    sessions: (OrderImportSession & { importedByName: string | null; scanStatus: string })[];
    total: number;
    page: number;
    pageSize: number;
    totalPages: number;
  };

  const sessionsQuery = useQuery<SessionsResponse>({
    queryKey: ["/api/order-import/sessions", currentPage, pageSize, filterDate, filterPlant],
    queryFn: async ({ signal }) => {
      const params = new URLSearchParams({
        page: String(currentPage),
        pageSize: String(pageSize),
      });
      if (filterDate)  params.set("date",  filterDate);
      if (filterPlant) params.set("plant", filterPlant);
      return (await apiRequest("GET", `/api/order-import/sessions?${params}`, undefined, undefined, false, signal)).json();
    },
    staleTime: 0,
    refetchInterval: SYNC_INTERVAL,
    refetchIntervalInBackground: true,
    refetchOnMount: true,
    refetchOnWindowFocus: true,
  });

  const itemsQuery = useQuery<OrderImportItem[]>({
    queryKey: ["/api/order-import/items", expandedId],
    queryFn: async () =>
      (await apiRequest("GET", `/api/order-import/sessions/${expandedId}/items`)).json(),
    enabled: expandedId !== null,
  });

  const scanItemsQuery = useQuery<OrderImportItem[]>({
    queryKey: ["/api/order-import/items", scanExpandedId, "scan"],
    queryFn: async () =>
      (await apiRequest("GET", `/api/order-import/sessions/${scanExpandedId}/items`)).json(),
    enabled: scanExpandedId !== null,
  });

  const plantsQuery = useQuery<{ name: string }[]>({
    queryKey: ["/api/plants"],
    queryFn: async () => (await apiRequest("GET", "/api/plants")).json(),
  });

  const scanSessionsQuery = useQuery<ScanSession[]>({
    queryKey: ["/api/order-scan/sessions"],
    queryFn: async ({ signal }) =>
      (await apiRequest("GET", "/api/order-scan/sessions", undefined, undefined, false, signal)).json(),
    enabled: isImportRole,
    staleTime: 0,
    refetchInterval: SYNC_INTERVAL,
    refetchIntervalInBackground: true,
    refetchOnMount: true,
    refetchOnWindowFocus: true,
  });

  // Active session — uses /active endpoint which has NO date filter whatsoever,
  // so it always finds whichever session is currently running regardless of when it was loaded.
  const activeSessionQuery = useQuery<ScanSession | null>({
    queryKey: ["/api/order-scan/active"],
    queryFn: async ({ signal }) =>
      (await apiRequest("GET", "/api/order-scan/active", undefined, undefined, false, signal)).json(),
    enabled: isImportRole,
    staleTime: 0,
    refetchInterval: SYNC_INTERVAL,
    refetchIntervalInBackground: true,
    refetchOnMount: true,
    refetchOnWindowFocus: true,
  });

  // ── WebSocket: real-time sync ──────────────────────────────────────────────
  // Reuses the existing /ws/order-scan WebSocket server with a "join-import"
  // subscription type so the OrderImport page receives instant push updates
  // whenever any CSV is uploaded, session status changes, etc.
  // Polling (refetchInterval:5000) stays as a fallback if the WS drops.
  useEffect(() => {
    if (!isImportRole) return;

    let ws: WebSocket | null = null;
    let retryMs = 2000;
    let retryTimer: ReturnType<typeof setTimeout> | null = null;
    let mounted = true;
    let lastMsgAt = Date.now();

    const refetchAll = () => {
      qc.refetchQueries({ queryKey: ["/api/order-import/sessions"], type: "all" });
      qc.refetchQueries({ queryKey: ["/api/order-scan/sessions"],   type: "all" });
      qc.refetchQueries({ queryKey: ["/api/order-scan/active"],     type: "all" });
      qc.refetchQueries({ queryKey: ["/api/order-scan/notification"], type: "all" });
    };

    // Dead-connection detector: if no message (including server pings) for 55s, reconnect
    const deadTimer = setInterval(() => {
      if (ws && Date.now() - lastMsgAt > 55_000) {
        ws.close();
      }
    }, 10_000);

    const connect = () => {
      if (!mounted) return;
      const proto = window.location.protocol === "https:" ? "wss:" : "ws:";
      ws = new WebSocket(`${proto}//${window.location.host}/ws/order-scan`);

      ws.onopen = () => {
        retryMs = 2000;
        lastMsgAt = Date.now();
        console.log("[WS:OrderImport] Connected to /ws/order-scan");
        ws!.send(JSON.stringify({ type: "join-import" }));
      };

      ws.onmessage = (e) => {
        lastMsgAt = Date.now();
        try {
          const msg = JSON.parse(e.data);
          if (msg.type === "joined-import") {
            console.log("[WS:OrderImport] Subscribed to import events ✓");
            // Only now is the push channel confirmed working — slow the polling
            // fallback down to a safety-net interval.
            setWsConnected(true);
          } else if (msg.type === "import-update") {
            console.log("[WS:OrderImport] Received import-update — refetching queries");
            refetchAll();
          }
          // "ping" is a keepalive — no action needed
        } catch { /* ignore malformed */ }
      };

      ws.onerror = () => { /* onclose fires next */ };

      ws.onclose = () => {
        ws = null;
        if (!mounted) return;
        // Push channel is down — resume fast polling so users still see updates.
        setWsConnected(false);
        console.log(`[WS:OrderImport] Disconnected — reconnecting in ${retryMs}ms`);
        retryTimer = setTimeout(() => {
          retryMs = Math.min(retryMs * 2, 30_000);
          connect();
        }, retryMs);
      };
    };

    connect();

    return () => {
      mounted = false;
      clearInterval(deadTimer);
      if (retryTimer) clearTimeout(retryTimer);
      ws?.close();
    };
  }, [isImportRole, qc]);

  // ── Mutations ──────────────────────────────────────────────────────────────
  type ImportSessionRow = OrderImportSession & { importedByName: string | null; scanStatus: string };

  // Patch every cached page of the paginated import-sessions list immediately.
  const patchImportSessions = (updater: (rows: ImportSessionRow[]) => ImportSessionRow[]) => {
    qc.getQueriesData<SessionsResponse>({ queryKey: ["/api/order-import/sessions"] })
      .forEach(([key, data]) => {
        if (!data) return;
        qc.setQueryData<SessionsResponse>(key, { ...data, sessions: updater(data.sessions) });
      });
  };

  // After every mutation fire immediate refetches. SSE usually beats this, but
  // onSettled is a guaranteed belt-and-suspenders fallback.
  const refetchAllSessionQueries = () => {
    qc.refetchQueries({ queryKey: ["/api/order-import/sessions"], type: "all" });
    qc.refetchQueries({ queryKey: ["/api/order-scan/sessions"],   type: "all" });
    qc.refetchQueries({ queryKey: ["/api/order-scan/active"],     type: "all" });
    qc.refetchQueries({ queryKey: ["/api/order-scan/notification"], type: "all" });
    qc.invalidateQueries({ queryKey: ["/api/order-import/master-view"] });
  };

  const importMutation = useMutation({
    mutationFn: async (payload: { plant: string; csvFileName: string; items: object[] }) =>
      (await apiRequest("POST", "/api/order-import/sessions", payload)).json(),
    onSuccess: (data) => {
      setShowMappingDialog(false);
      setCsvData(null);
      setSelectedFiles([]);
      setLastImport({ rowCount: data.rowCount });
      setShowHistory(true);
      setCurrentPage(1);
      setFilterDate("");
      setFilterPlant("");

      // Optimistic update: show the new session immediately in both lists
      // while the SSE-triggered refetch confirms server state in the background.
      if (data.session) {
        const newRow: ImportSessionRow = {
          ...data.session,
          rowCount:       data.rowCount,
          scanStatus:     data.session.scanStatus ?? "available",
          importedByName: (user as any)?.name ?? null,
        };
        patchImportSessions((rows) => [newRow, ...rows]);

        // Seed page-1/no-filter key so the list renders instantly even if the
        // user was on a filtered page before uploading.
        const p1Key = ["/api/order-import/sessions", 1, pageSize, "", ""] as const;
        const p1 = qc.getQueryData<SessionsResponse>(p1Key);
        qc.setQueryData<SessionsResponse>(p1Key, p1
          ? { ...p1, sessions: [newRow, ...p1.sessions].slice(0, pageSize), total: p1.total + 1, totalPages: Math.max(1, Math.ceil((p1.total + 1) / pageSize)) }
          : { sessions: [newRow], total: 1, page: 1, pageSize, totalPages: 1 },
        );

        qc.setQueryData<ScanSession[]>(["/api/order-scan/sessions"], (old) =>
          old ? [{ id: data.session.id, plant: data.session.plant, csvFileName: data.session.csvFileName, rowCount: data.rowCount, scanStatus: data.session.scanStatus ?? "available", importedByName: (user as any)?.name ?? null, createdAt: data.session.createdAt ?? new Date().toISOString(), scanActivatedByName: null, scanActivatedAt: null, scanCompletedAt: null, scanActivatedByCode: null }, ...old] : [],
        );
      }

      toast({ title: "Import complete", description: `${data.rowCount} rows imported.`, className: "bg-green-50 border-green-200 text-green-900" });
    },
    onError: (err: any) =>
      toast({ title: "Import failed", description: err.message, variant: "destructive" }),
    onSettled: () => refetchAllSessionQueries(),
  });

  const loadForScanMutation = useMutation({
    mutationFn: async (id: number) =>
      (await apiRequest("POST", `/api/order-scan/sessions/${id}/activate`)).json(),
    onMutate: async (id) => {
      await Promise.all([
        qc.cancelQueries({ queryKey: ["/api/order-import/sessions"] }),
        qc.cancelQueries({ queryKey: ["/api/order-scan/sessions"] }),
        qc.cancelQueries({ queryKey: ["/api/order-scan/active"] }),
        qc.cancelQueries({ queryKey: ["/api/order-scan/notification"] }),
      ]);
      const prevScanSessions  = qc.getQueryData<ScanSession[]>(["/api/order-scan/sessions"]);
      const prevImportPages   = qc.getQueriesData<SessionsResponse>({ queryKey: ["/api/order-import/sessions"] });
      const prevActive        = qc.getQueryData<ScanSession | null>(["/api/order-scan/active"]);
      const prevNotif         = qc.getQueryData(["/api/order-scan/notification"]);
      const activatingSession = (prevScanSessions ?? []).find((s) => s.id === id);
      patchImportSessions((rows) => rows.map((s) => s.id === id ? { ...s, scanStatus: "active" } : s));
      qc.setQueryData<ScanSession[]>(["/api/order-scan/sessions"], (old) =>
        old ? old.map((s) => s.id === id ? { ...s, scanStatus: "active" } : s) : old,
      );
      if (activatingSession) {
        qc.setQueryData<ScanSession | null>(["/api/order-scan/active"], { ...activatingSession, scanStatus: "active" });
        // Seed the notification cache immediately so the /scan page sees the active
        // session as soon as it mounts — no network round-trip needed.
        qc.setQueryData(["/api/order-scan/notification"], {
          active: true,
          session: {
            id:              activatingSession.id,
            plant:           activatingSession.plant,
            csvFileName:     activatingSession.csvFileName,
            rowCount:        activatingSession.rowCount,
            importedByName:  activatingSession.importedByName,
            scanActivatedAt: new Date().toISOString(),
          },
        });
      }
      return { prevScanSessions, prevImportPages, prevActive, prevNotif };
    },
    onSuccess: () => {
      navigate("/scan");
    },
    onError: (err: any, _id, ctx) => {
      if (ctx) {
        if (ctx.prevScanSessions !== undefined)
          qc.setQueryData<ScanSession[]>(["/api/order-scan/sessions"], ctx.prevScanSessions);
        ctx.prevImportPages.forEach(([key, data]) => { if (data) qc.setQueryData<SessionsResponse>(key, data); });
        if (ctx.prevActive !== undefined)
          qc.setQueryData<ScanSession | null>(["/api/order-scan/active"], ctx.prevActive);
        if (ctx.prevNotif !== undefined)
          qc.setQueryData(["/api/order-scan/notification"], ctx.prevNotif);
      }
      // Parse structured 409 conflict response: "409: {message, conflictFileName}"
      let title = "Cannot load for scan";
      let description: string = err?.message ?? "Something went wrong";
      try {
        const jsonStr = String(err?.message ?? "").replace(/^\d+:\s*/, "");
        const parsed = JSON.parse(jsonStr);
        if (parsed.message) description = parsed.message;
        if (parsed.conflictFileName) description += ` — deactivate "${parsed.conflictFileName}" first.`;
      } catch { /* use raw message */ }
      toast({ title, description, variant: "destructive" });
    },
    onSettled: () => refetchAllSessionQueries(),
  });

  const deleteMutation = useMutation({
    mutationFn: async (id: number) => {
      await apiRequest("DELETE", `/api/order-import/sessions/${id}`);
    },
    onMutate: async (id) => {
      await Promise.all([
        qc.cancelQueries({ queryKey: ["/api/order-import/sessions"] }),
        qc.cancelQueries({ queryKey: ["/api/order-scan/sessions"] }),
        qc.cancelQueries({ queryKey: ["/api/order-scan/active"] }),
        qc.cancelQueries({ queryKey: ["/api/order-scan/notification"] }),
      ]);
      const previousScanSessions = qc.getQueryData<ScanSession[]>(["/api/order-scan/sessions"]);
      const previousImportPages  = qc.getQueriesData<SessionsResponse>({ queryKey: ["/api/order-import/sessions"] });
      const previousActive       = qc.getQueryData<ScanSession | null>(["/api/order-scan/active"]);
      const previousNotif        = qc.getQueryData(["/api/order-scan/notification"]);
      setDeleteTarget(null);
      if (expandedId === id)     setExpandedId(null);
      if (scanExpandedId === id) setScanExpandedId(null);
      patchImportSessions((rows) => rows.filter((s) => s.id !== id));
      qc.setQueryData<ScanSession[]>(["/api/order-scan/sessions"], (old) =>
        old ? old.filter((s) => s.id !== id) : old,
      );
      if (previousActive?.id === id) {
        qc.setQueryData(["/api/order-scan/active"], null);
        qc.setQueryData(["/api/order-scan/notification"], { active: false, session: null });
      }
      toast({ title: "Session deleted" });
      return { previousScanSessions, previousImportPages, previousActive, previousNotif };
    },
    onError: (err: any, _, context) => {
      if (context) {
        if (context.previousScanSessions !== undefined)
          qc.setQueryData<ScanSession[]>(["/api/order-scan/sessions"], context.previousScanSessions);
        context.previousImportPages.forEach(([key, data]) => {
          if (data) qc.setQueryData<SessionsResponse>(key, data);
        });
        if (context.previousActive !== undefined)
          qc.setQueryData<ScanSession | null>(["/api/order-scan/active"], context.previousActive);
        if (context.previousNotif !== undefined)
          qc.setQueryData(["/api/order-scan/notification"], context.previousNotif);
      }
      toast({ title: "Delete failed", description: err.message, variant: "destructive" });
    },
    onSettled: () => refetchAllSessionQueries(),
  });

  const deactivateMutation = useMutation({
    mutationFn: async (id: number) =>
      (await apiRequest("POST", `/api/order-scan/sessions/${id}/deactivate`)).json(),
    onMutate: async (id) => {
      await Promise.all([
        qc.cancelQueries({ queryKey: ["/api/order-import/sessions"] }),
        qc.cancelQueries({ queryKey: ["/api/order-scan/sessions"] }),
        qc.cancelQueries({ queryKey: ["/api/order-scan/active"] }),
        qc.cancelQueries({ queryKey: ["/api/order-scan/notification"] }),
      ]);
      const previousScanSessions = qc.getQueryData<ScanSession[]>(["/api/order-scan/sessions"]);
      const previousImportPages  = qc.getQueriesData<SessionsResponse>({ queryKey: ["/api/order-import/sessions"] });
      const previousActive       = qc.getQueryData<ScanSession | null>(["/api/order-scan/active"]);
      const previousNotif        = qc.getQueryData(["/api/order-scan/notification"]);
      setDeactivateTarget(null);
      patchImportSessions((rows) => rows.map((s) => s.id === id ? { ...s, scanStatus: "available" } : s));
      qc.setQueryData<ScanSession[]>(["/api/order-scan/sessions"], (old) =>
        old ? old.map((s) => s.id === id ? { ...s, scanStatus: "available" } : s) : old,
      );
      if (previousActive?.id === id) {
        qc.setQueryData(["/api/order-scan/active"], null);
        qc.setQueryData(["/api/order-scan/notification"], { active: false, session: null });
      }
      toast({ title: "Session deactivated", description: "Lock released. Another session can now be loaded." });
      return { previousScanSessions, previousImportPages, previousActive, previousNotif };
    },
    onError: (err: any, _, context) => {
      if (context) {
        if (context.previousScanSessions !== undefined)
          qc.setQueryData<ScanSession[]>(["/api/order-scan/sessions"], context.previousScanSessions);
        context.previousImportPages.forEach(([key, data]) => {
          if (data) qc.setQueryData<SessionsResponse>(key, data);
        });
        if (context.previousActive !== undefined)
          qc.setQueryData<ScanSession | null>(["/api/order-scan/active"], context.previousActive);
        if (context.previousNotif !== undefined)
          qc.setQueryData(["/api/order-scan/notification"], context.previousNotif);
      }
      toast({ title: "Deactivate failed", description: err.message, variant: "destructive" });
    },
    onSettled: () => refetchAllSessionQueries(),
  });

  const completeMutation = useMutation({
    mutationFn: async (id: number) =>
      (await apiRequest("POST", `/api/order-scan/sessions/${id}/complete`)).json(),
    onMutate: async (id) => {
      await Promise.all([
        qc.cancelQueries({ queryKey: ["/api/order-import/sessions"] }),
        qc.cancelQueries({ queryKey: ["/api/order-scan/sessions"] }),
        qc.cancelQueries({ queryKey: ["/api/order-scan/active"] }),
        qc.cancelQueries({ queryKey: ["/api/order-scan/notification"] }),
      ]);
      const previousScanSessions = qc.getQueryData<ScanSession[]>(["/api/order-scan/sessions"]);
      const previousImportPages  = qc.getQueriesData<SessionsResponse>({ queryKey: ["/api/order-import/sessions"] });
      const previousActive       = qc.getQueryData<ScanSession | null>(["/api/order-scan/active"]);
      const previousNotif        = qc.getQueryData(["/api/order-scan/notification"]);
      setCompleteTarget(null);
      setShowCompleted(true);
      patchImportSessions((rows) => rows.map((s) => s.id === id ? { ...s, scanStatus: "completed" } : s));
      qc.setQueryData<ScanSession[]>(["/api/order-scan/sessions"], (old) =>
        old ? old.map((s) => s.id === id ? { ...s, scanStatus: "completed" } : s) : old,
      );
      if (previousActive?.id === id) {
        qc.setQueryData(["/api/order-scan/active"], null);
        qc.setQueryData(["/api/order-scan/notification"], { active: false, session: null });
      }
      toast({ title: "Session completed", className: "bg-green-50 border-green-200 text-green-900" });
      return { previousScanSessions, previousImportPages, previousActive, previousNotif };
    },
    onError: (err: any, _, context) => {
      if (context) {
        if (context.previousScanSessions !== undefined)
          qc.setQueryData<ScanSession[]>(["/api/order-scan/sessions"], context.previousScanSessions);
        context.previousImportPages.forEach(([key, data]) => {
          if (data) qc.setQueryData<SessionsResponse>(key, data);
        });
        if (context.previousActive !== undefined)
          qc.setQueryData<ScanSession | null>(["/api/order-scan/active"], context.previousActive);
        if (context.previousNotif !== undefined)
          qc.setQueryData(["/api/order-scan/notification"], context.previousNotif);
      }
      toast({ title: "Complete failed", description: err.message, variant: "destructive" });
    },
    onSettled: () => refetchAllSessionQueries(),
  });

  if (!isImportRole) {
    return (
      <main className="min-h-screen bg-gray-50 flex items-center justify-center p-8">
        <div className="text-center">
          <div className="flex h-12 w-12 items-center justify-center rounded-full bg-red-100 mx-auto mb-4">
            <FileUp className="h-6 w-6 text-red-500" />
          </div>
          <h2 className="text-lg font-semibold text-gray-900">Access Denied</h2>
          <p className="mt-1 text-sm text-gray-500">You don't have permission to access Order Import.</p>
        </div>
      </main>
    );
  }

  // ── Handlers ───────────────────────────────────────────────────────────────

  // Parses raw arrays first so we can find the real header row — Excel pivot-table
  // exports often have a report-title row before the actual headers. Shared by the
  // single-file review flow (parseAndOpen) and the automatic multi-file batch import,
  // so both detect headers the same way.
  function parseCsvRaw(file: File): Promise<{ name: string; headers: string[]; rows: Record<string, string>[] } | null> {
    return new Promise((resolve) => {
      Papa.parse<string[]>(file, {
        header: false,
        skipEmptyLines: true,
        delimiter: "",   // auto-detect delimiter
        encoding: "UTF-8",
        complete: (result) => {
          const rawRows = result.data as string[][];
          if (rawRows.length === 0) {
            toast({ title: "Empty file", description: `"${file.name}" has no rows.`, variant: "destructive" });
            resolve(null);
            return;
          }

          // Find the row with the most non-empty cells in the first 15 rows.
          // That row is almost always the real header row.
          let headerRowIdx = 0;
          let maxCols = 0;
          for (let i = 0; i < Math.min(rawRows.length, 15); i++) {
            const nonEmpty = rawRows[i].filter((c) => c.trim() !== "").length;
            if (nonEmpty > maxCols) {
              maxCols = nonEmpty;
              headerRowIdx = i;
            }
          }

          // Clean and filter header cells
          const headers = rawRows[headerRowIdx]
            .map((h) => cleanHeader(h))
            .filter((h) => h !== "");

          if (headers.length === 0) {
            toast({
              title: "No columns found",
              description: `Could not detect column headers in "${file.name}".`,
              variant: "destructive",
            });
            resolve(null);
            return;
          }

          // Build data rows from everything after the header row
          const rows = rawRows.slice(headerRowIdx + 1).map((row) => {
            const obj: Record<string, string> = {};
            headers.forEach((h, i) => { obj[h] = row[i] ?? ""; });
            return obj;
          });

          resolve({ name: file.name, headers, rows });
        },
        error: (err) => {
          toast({ title: "Could not parse CSV", description: `"${file.name}": ${err.message}`, variant: "destructive" });
          resolve(null);
        },
      });
    });
  }

  function buildItemsFromRows(rows: Record<string, string>[], activeMapping: Mapping) {
    return rows.map((row) => {
      const get = (key: TargetKey) => {
        const col = activeMapping[key];
        return col && col !== SKIP ? (row[col] ?? "") : "";
      };
      return {
        barcode:         get("barcode") || null,
        itemName:        get("itemName") || null,
        sapCode:         get("sapCode") || null,
        quantity:        parseInt(get("quantity")) || 0,
        expectedPallets: parseFloat(get("expectedPallets")) || null,
        date:            orderDate || null,
      };
    });
  }

  async function parseAndOpen(file: File) {
    const parsed = await parseCsvRaw(file);
    if (!parsed) return;
    setCsvData(parsed);
    setMapping(autoMatch(parsed.headers));
    setShowMappingDialog(true);
  }

  function handleFileChange(e: React.ChangeEvent<HTMLInputElement>) {
    const files = Array.from(e.target.files ?? []);
    if (files.length === 0) return;
    setSelectedFiles(files);
    setLastImport(null);
    e.target.value = "";
  }

  // Start the sequential Map & Import queue: opens the mapping dialog for the first file;
  // each confirm imports that file and advances to the next file's mapping dialog.
  function handleImportClick() {
    if (!plant.trim()) {
      toast({ title: "Select a plant first", variant: "destructive" });
      return;
    }
    if (selectedFiles.length === 0) {
      toast({ title: "Select a CSV file first", variant: "destructive" });
      return;
    }
    uploadQueueRef.current = selectedFiles;
    uploadIdxRef.current = 0;
    uploadCollectedRef.current = { sessionIds: [], fileNames: [], failed: [], totalRows: 0, groupId: null };
    setUploadProgress({ current: 1, total: selectedFiles.length });
    parseAndOpen(selectedFiles[0]);
  }

  function handleConfirmImport() {
    if (!csvData) return;
    const items = buildItemsFromRows(csvData.rows, mapping);
    importQueuedFile(csvData.name, items);
  }

  // Imports the current queued file (with the shared plant + Order Date, so the server
  // auto-groups it), then either opens the next file's mapping dialog or finishes the batch.
  async function importQueuedFile(csvFileName: string, items: object[]) {
    setIsBatchImporting(true);
    const c = uploadCollectedRef.current;
    try {
      const resp = await apiRequest("POST", "/api/order-import/sessions", { plant, csvFileName, items, orderDate });
      const data = await resp.json();
      if (data?.session?.id) {
        if (c.groupId == null) c.groupId = data.session.receivingSessionId ?? data.session.id;
        c.sessionIds.push(data.session.id);
        c.fileNames.push(csvFileName);
        c.totalRows += data.rowCount ?? 0;
      } else {
        c.failed.push(csvFileName);
      }
    } catch {
      c.failed.push(csvFileName);
    }

    const nextIdx = uploadIdxRef.current + 1;
    const queue = uploadQueueRef.current;
    if (nextIdx < queue.length) {
      uploadIdxRef.current = nextIdx;
      setUploadProgress({ current: nextIdx + 1, total: queue.length });
      setIsBatchImporting(false);
      await parseAndOpen(queue[nextIdx]); // reopen mapping dialog for the next file
    } else {
      finishQueuedImport();
    }
  }

  function finishQueuedImport() {
    const c = uploadCollectedRef.current;
    setIsBatchImporting(false);
    setShowMappingDialog(false);
    setCsvData(null);
    setSelectedFiles([]);
    if (fileRef.current) fileRef.current.value = "";
    setUploadProgress(null);
    setLastImport({ rowCount: c.totalRows });
    setShowHistory(true);
    setCurrentPage(1);
    setFilterDate("");
    setFilterPlant("");
    refetchAllSessionQueries();

    const n = c.sessionIds.length;
    toast({
      title: c.failed.length === 0 ? "Import complete" : n === 0 ? "Import failed" : "Import finished with errors",
      description: `${n} file(s) imported · ${c.totalRows} rows${c.failed.length ? ` · failed: ${c.failed.join(", ")}` : ""}. Same plant + order date auto-group; Part 1 loads now, the rest auto-load as each completes. View reports on the Order Reports page.`,
      variant: n === 0 ? "destructive" : undefined,
      className: c.failed.length === 0 ? "bg-green-50 border-green-200 text-green-900" : undefined,
    });
  }

  function clearForm() {
    setSelectedFiles([]);
    setLastImport(null);
    setOrderDate(getLocalISODate());
    if (fileRef.current) fileRef.current.value = "";
  }

  const sessions        = sessionsQuery.data?.sessions  ?? [];
  const totalSessions   = sessionsQuery.data?.total     ?? 0;
  const totalPages      = sessionsQuery.data?.totalPages ?? 1;
  const safePage        = currentPage;

  const allItems = itemsQuery.data ?? [];
  const filteredItems = itemSearch
    ? allItems.filter((i) =>
        [i.barcode, i.itemName, i.sapCode].some((v) =>
          v?.toLowerCase().includes(itemSearch.toLowerCase())
        )
      )
    : allItems;

  const plantOptions = (plantsQuery.data ?? []).filter((p) => p.name && p.name.trim() !== "");

  const _allScanSessions = scanSessionsQuery.data ?? [];

  // Plants that currently have an active session — UNFILTERED by the Active tab's own
  // plant/date filters, since this drives whether Load is disabled on the Available tab
  // and must always reflect true global state, not whatever the user is filtering by.
  const activePlantsSet = new Set(
    _allScanSessions.filter((s) => s.scanStatus === "active").map((s) => (s.plant ?? "").toLowerCase()),
  );

  // Client-side filters — empty string means "all". Status filter ensures a session
  // removed via completeMutation disappears from Currently Active immediately (cache
  // patch sets scanStatus → "completed" before the background refetch arrives).
  const availableScanSessions = _allScanSessions.filter(s =>
    s.scanStatus === "available" &&
    (!scanPlant    || (s.plant ?? "").toLowerCase() === scanPlant.toLowerCase()) &&
    (!scanDate     || (s.createdAt ?? "").slice(0, 10) === scanDate)
  );
  const activeScanSessions = _allScanSessions.filter(s =>
    s.scanStatus === "active" &&
    (!activePlant  || (s.plant ?? "").toLowerCase() === activePlant.toLowerCase()) &&
    (!activeDate   || (s.createdAt ?? "").slice(0, 10) === activeDate)
  );
  const completedScanSessions = _allScanSessions.filter(s =>
    s.scanStatus === "completed" &&
    (!completedPlant || (s.plant ?? "").toLowerCase() === completedPlant.toLowerCase()) &&
    (!completedDate  || (s.createdAt ?? "").slice(0, 10) === completedDate)
  );
  const activeId = activeSessionQuery.data?.id ?? null;

  const [activeTab, setActiveTab] = useState<"available" | "active" | "completed" | "history">("available");

  return (
    <main className="flex-1 overflow-y-auto bg-gray-50">
      <div className="mx-auto max-w-5xl px-4 py-6 space-y-6">

        {/* ── Page Header ── */}
        <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
          <div className="flex items-center gap-3">
            <div className="flex h-12 w-12 shrink-0 items-center justify-center rounded-xl bg-[#001d6e] text-white">
              <FileUp className="h-6 w-6" />
            </div>
            <div>
              <h1 className="text-2xl font-bold text-gray-900">Order Import</h1>
              <p className="text-sm text-gray-500">Upload a CSV, map columns, and manage scan sessions</p>
            </div>
          </div>
          <div className="flex items-center gap-3">
            <div className="flex items-center gap-1.5" title={wsConnected ? "Real-time updates active" : "Live updates via polling (WebSocket not connected)"}>
              <span className={`h-2 w-2 rounded-full ${wsConnected ? "bg-green-500" : "bg-amber-500 animate-pulse"}`} />
              <span className={`text-xs font-medium ${wsConnected ? "text-green-700" : "text-amber-600"}`}>
                {wsConnected ? "Live" : "Syncing"}
              </span>
            </div>
            <button
              className="inline-flex items-center gap-1.5 rounded-lg border border-gray-200 bg-white px-3 py-1.5 text-sm font-medium text-gray-700 hover:bg-gray-50 disabled:opacity-50"
              onClick={() => sessionsQuery.refetch()}
              disabled={sessionsQuery.isFetching}
            >
              <RefreshCw className={`h-4 w-4 ${sessionsQuery.isFetching ? "animate-spin" : ""}`} />
              Refresh
            </button>
          </div>
        </div>

        {/* ── Upload Card ── */}
        <div className="rounded-xl border border-gray-200 bg-white shadow-sm">
          <div className="flex items-center gap-2 border-b border-gray-100 px-5 py-4">
            <Upload className="h-5 w-5 text-[#001d6e]" />
            <h2 className="text-base font-semibold text-gray-900">Upload CSV</h2>
          </div>
          <div className="p-5 space-y-4">
            {/* Desktop layout */}
            <div className="hidden sm:flex flex-wrap items-end gap-3">
              {/* Plant */}
              <div className="grid gap-1 min-w-[130px] flex-1">
                <Label className="text-xs text-gray-500">Plant</Label>
                {plantOptions.length > 0 ? (
                  <Select value={plant || "_none_"} onValueChange={(v) => setPlant(v === "_none_" ? "" : v)}>
                    <SelectTrigger className="h-9 text-sm"><SelectValue placeholder="Select…" /></SelectTrigger>
                    <SelectContent>
                      <SelectItem value="_none_">— Select —</SelectItem>
                      {plantOptions.map((p) => <SelectItem key={p.name} value={p.name}>{p.name}</SelectItem>)}
                    </SelectContent>
                  </Select>
                ) : (
                  <Input className="h-9 text-sm" value={plant} onChange={(e) => setPlant(e.target.value)} placeholder="Plant…" />
                )}
              </div>
              {/* Date */}
              <div className="grid gap-1">
                <Label className="text-xs text-gray-500">Order Date</Label>
                <Input type="date" className="h-9 text-sm w-[150px]" value={orderDate} onChange={(e) => setOrderDate(e.target.value)} />
              </div>
              {/* File */}
              <div className="grid gap-1 flex-[2] min-w-[180px]">
                <Label className="text-xs text-gray-500">
                  CSV File{selectedFiles.length === 1 && <span className="text-green-600 font-medium"> · {selectedFiles[0].name}</span>}
                  {selectedFiles.length > 1 && <span className="text-green-600 font-medium"> · {selectedFiles.length} files selected</span>}
                </Label>
                <Input ref={fileRef} type="file" accept=".csv" multiple className="h-9 text-sm"
                  onChange={handleFileChange} disabled={importMutation.isPending || isBatchImporting} />
              </div>
              {/* Actions */}
              <div className="flex gap-2 pb-0.5">
                <Button variant="outline" className="h-9" onClick={clearForm}
                  disabled={selectedFiles.length === 0 || importMutation.isPending || isBatchImporting}>
                  <X className="h-4 w-4" />
                </Button>
                <Button className="h-9 bg-[#001d6e] hover:bg-[#00154b] text-white" onClick={handleImportClick}
                  disabled={selectedFiles.length === 0 || !plant.trim() || importMutation.isPending || isBatchImporting || !canWriteOrderImport}
                  title={!canWriteOrderImport ? "You have read-only access to Order Import" : undefined}>
                  {(importMutation.isPending || isBatchImporting) ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : <Upload className="mr-2 h-4 w-4" />}
                  {selectedFiles.length > 1 ? `Import ${selectedFiles.length} Files` : "Map & Import"}
                </Button>
              </div>
            </div>

            {/* Mobile layout */}
            <div className="sm:hidden space-y-3">
              <div className="grid gap-1">
                <Label className="text-xs text-gray-500 font-medium">
                  CSV File{selectedFiles.length === 1 && <span className="text-green-600 font-medium"> · {selectedFiles[0].name}</span>}
                  {selectedFiles.length > 1 && <span className="text-green-600 font-medium"> · {selectedFiles.length} files selected</span>}
                </Label>
                <Input ref={fileRef} type="file" accept=".csv" multiple
                  className="h-11 text-sm file:mr-3 file:py-1 file:px-3 file:rounded file:border-0 file:text-xs file:font-medium file:bg-[#001d6e]/10 file:text-[#001d6e]"
                  onChange={handleFileChange} disabled={importMutation.isPending || isBatchImporting} />
              </div>
              <div className="grid grid-cols-2 gap-3">
                <div className="grid gap-1">
                  <Label className="text-xs text-gray-500">Plant</Label>
                  {plantOptions.length > 0 ? (
                    <Select value={plant || "_none_"} onValueChange={(v) => setPlant(v === "_none_" ? "" : v)}>
                      <SelectTrigger className="h-10 text-sm"><SelectValue placeholder="Select…" /></SelectTrigger>
                      <SelectContent>
                        <SelectItem value="_none_">— Select —</SelectItem>
                        {plantOptions.map((p) => <SelectItem key={p.name} value={p.name}>{p.name}</SelectItem>)}
                      </SelectContent>
                    </Select>
                  ) : (
                    <Input className="h-10 text-sm" value={plant} onChange={(e) => setPlant(e.target.value)} placeholder="Plant…" />
                  )}
                </div>
                <div className="grid gap-1">
                  <Label className="text-xs text-gray-500">Order Date</Label>
                  <Input type="date" className="h-10 text-sm w-full" value={orderDate} onChange={(e) => setOrderDate(e.target.value)} />
                </div>
              </div>
              <div className="flex gap-2">
                <Button variant="outline" className="h-10 px-3 shrink-0" onClick={clearForm}
                  disabled={selectedFiles.length === 0 || importMutation.isPending || isBatchImporting}>
                  <X className="h-4 w-4" />
                </Button>
                <Button className="h-10 flex-1 bg-[#001d6e] hover:bg-[#00154b] text-white" onClick={handleImportClick}
                  disabled={selectedFiles.length === 0 || !plant.trim() || importMutation.isPending || isBatchImporting || !canWriteOrderImport}
                  title={!canWriteOrderImport ? "You have read-only access to Order Import" : undefined}>
                  {(importMutation.isPending || isBatchImporting) ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : <Upload className="mr-2 h-4 w-4" />}
                  {selectedFiles.length > 1 ? `Import ${selectedFiles.length} Files` : "Map & Import"}
                </Button>
              </div>
            </div>

            {/* Feedback */}
            {lastImport && (
              <p className="flex items-center gap-1.5 text-sm text-green-700">
                <CheckCircle className="h-4 w-4" />
                Imported <strong>{lastImport.rowCount}</strong> rows successfully.
              </p>
            )}
            {importMutation.isError && (
              <p className="flex items-center gap-1.5 text-sm text-red-600">
                <AlertCircle className="h-4 w-4" />
                {(importMutation.error as Error).message}
              </p>
            )}
          </div>
        </div>

        {/* ── Session Manager Tabs ── */}
        <div className="rounded-xl border border-gray-200 bg-white shadow-sm">
          {/* Tab pills header */}
          <div className="border-b border-gray-100 px-5 py-4">
            <div className="flex gap-1 flex-wrap">
              {(
                [
                  { key: "available", label: "Available", count: availableScanSessions.length },
                  { key: "active",    label: "Active",    count: activeScanSessions.length },
                  { key: "completed", label: "Completed", count: completedScanSessions.length },
                  { key: "history",   label: "History",   count: totalSessions },
                ] as { key: "available" | "active" | "completed" | "history"; label: string; count: number }[]
              ).map((tab) => (
                <button
                  key={tab.key}
                  onClick={() => setActiveTab(tab.key)}
                  className={
                    activeTab === tab.key
                      ? "bg-[#001d6e] text-white rounded-full px-4 py-1.5 text-sm font-medium"
                      : "bg-white border border-gray-200 text-gray-600 rounded-full px-4 py-1.5 text-sm font-medium hover:bg-gray-50"
                  }
                >
                  {tab.label}
                  {tab.count > 0 && (
                    <span className={`ml-1.5 inline-flex h-5 min-w-[20px] items-center justify-center rounded-full px-1 text-xs font-semibold ${
                      activeTab === tab.key ? "bg-white/20 text-white" : "bg-gray-100 text-gray-600"
                    }`}>
                      {tab.count}
                    </span>
                  )}
                </button>
              ))}
            </div>
          </div>

          {/* ── Tab: Available ── */}
          {activeTab === "available" && (
            <div>
              {/* Filters */}
              <div className="flex flex-wrap items-center gap-2 px-5 py-3 border-b border-gray-50">
                {plantOptions.length > 0 ? (
                  <Select value={scanPlant || "_all_"} onValueChange={(v) => { setScanPlant(v === "_all_" ? "" : v); setScanExpandedId(null); }}>
                    <SelectTrigger className="h-8 w-[130px] text-xs">
                      <SelectValue placeholder="All plants" />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="_all_">All plants</SelectItem>
                      {plantOptions.map((p) => <SelectItem key={p.name} value={p.name}>{p.name}</SelectItem>)}
                    </SelectContent>
                  </Select>
                ) : (
                  <Input value={scanPlant} onChange={(e) => { setScanPlant(e.target.value); setScanExpandedId(null); }}
                    placeholder="Plant…" className="h-8 w-[110px] text-xs" />
                )}
                <Input type="date" value={scanDate} onChange={(e) => { setScanDate(e.target.value); setScanExpandedId(null); }}
                  className="h-8 w-[140px] text-xs" />
                {scanDate !== todayStr && (
                  <Button size="sm" variant="ghost" className="h-8 px-2 text-xs text-gray-500 hover:text-[#001d6e]"
                    onClick={() => { setScanDate(todayStr); setScanExpandedId(null); }}>
                    Today
                  </Button>
                )}
                {scanDate && (
                  <Button size="sm" variant="ghost" className="h-8 w-8 p-0 text-gray-400 hover:text-red-500"
                    onClick={() => { setScanDate(""); setScanExpandedId(null); }}>
                    <X className="h-3.5 w-3.5" />
                  </Button>
                )}
                <Button size="sm" variant="outline" className="h-8 w-8 p-0 ml-auto"
                  onClick={() => scanSessionsQuery.refetch()} disabled={scanSessionsQuery.isFetching}>
                  <RefreshCw className={`h-3.5 w-3.5 ${scanSessionsQuery.isFetching ? "animate-spin" : ""}`} />
                </Button>
              </div>
              {/* Content */}
              {scanSessionsQuery.isFetching && availableScanSessions.length === 0 ? (
                <div className="flex justify-center py-12">
                  <Loader2 className="h-6 w-6 animate-spin text-[#001d6e]" />
                </div>
              ) : availableScanSessions.length === 0 ? (
                <div className="flex flex-col items-center justify-center py-12 text-gray-400">
                  <ScanLine className="h-10 w-10 mb-3 opacity-20" />
                  <p className="text-sm font-medium">No available sessions</p>
                  <p className="text-xs mt-1">Upload a CSV above to create one</p>
                </div>
              ) : (
                <div className="divide-y">
                  {availableScanSessions.map((s) => {
                    const isExpanded = scanExpandedId === s.id;
                    const scanAllItems = isExpanded ? (scanItemsQuery.data ?? []) : [];
                    const scanFiltered = scanItemSearch
                      ? scanAllItems.filter((i) => [i.barcode, i.itemName, i.sapCode].some((v) => v?.toLowerCase().includes(scanItemSearch.toLowerCase())))
                      : scanAllItems;
                    // Only one session may be active per plant at a time. Disabling Load up
                    // front (rather than only reacting to the server's 409) is the primary
                    // guard; the backend re-checks under a row lock on every /activate call
                    // regardless, so a race between two admins clicking at the same instant
                    // is still caught server-side even if both buttons briefly looked enabled.
                    const plantBusy = activePlantsSet.has((s.plant ?? "").toLowerCase());
                    return (
                      <div key={s.id}>
                        <div
                          className="cursor-pointer px-5 py-3 hover:bg-gray-50 active:bg-gray-100"
                          onClick={() => { setScanExpandedId(isExpanded ? null : s.id); setScanItemSearch(""); }}
                        >
                          <div className="flex items-center gap-3">
                            <span className="shrink-0 text-gray-400">
                              {isExpanded ? <ChevronDown className="h-4 w-4" /> : <ChevronRight className="h-4 w-4" />}
                            </span>
                            <div className="flex-1 min-w-0">
                              <p className="truncate text-sm font-medium text-gray-900">{stripCsvExt(s.csvFileName)}</p>
                              <div className="mt-0.5 flex flex-wrap items-center gap-x-1.5 gap-y-0.5">
                                <span className="rounded bg-[#001d6e]/10 px-1.5 py-0.5 text-[10px] font-semibold text-[#001d6e] uppercase">{s.plant}</span>
                                <span className="text-xs text-gray-400">{fmtIST(s.createdAt)}</span>
                                {s.importedByName && <span className="text-xs text-gray-400">· {s.importedByName}</span>}
                                {plantBusy && (
                                  <span className="rounded bg-amber-50 px-1.5 py-0.5 text-[10px] font-semibold text-amber-700" title="Another session is already active for this plant">
                                    Plant busy
                                  </span>
                                )}
                              </div>
                            </div>
                            <div className="flex shrink-0 items-center gap-1.5">
                              <span className="inline-flex items-center rounded-full bg-[#001d6e]/10 px-2 py-0.5 text-xs font-semibold text-[#001d6e]">
                                {s.rowCount}
                              </span>
                              <Button size="sm"
                                className="h-7 px-2 text-xs bg-[#001d6e] hover:bg-[#00154b] text-white disabled:opacity-50"
                                disabled={loadForScanMutation.isPending || plantBusy}
                                title={plantBusy ? `Another session is already active for ${s.plant} — complete or deactivate it first` : undefined}
                                onClick={(e) => { e.stopPropagation(); if (!plantBusy) loadForScanMutation.mutate(s.id); }}>
                                {loadForScanMutation.isPending
                                  ? <Loader2 className="h-3 w-3 animate-spin mr-1" />
                                  : <ScanLine className="h-3 w-3 mr-1" />}
                                Load
                              </Button>
                              <Button size="sm" variant="ghost"
                                className="h-7 w-7 p-0 text-gray-400 hover:text-red-600 disabled:opacity-30"
                                disabled={!canWriteOrderImport}
                                title={!canWriteOrderImport ? "You have read-only access to Order Import" : undefined}
                                onClick={(e) => { e.stopPropagation(); setDeleteTarget(s.id); }}>
                                <Trash2 className="h-3.5 w-3.5" />
                              </Button>
                            </div>
                          </div>
                        </div>
                        {isExpanded && (
                          <div className="border-t bg-gray-50/60 px-5 py-3">
                            <div className="mb-3 flex items-center gap-2">
                              <div className="relative flex-1">
                                <Search className="absolute left-3 top-2.5 h-3.5 w-3.5 text-gray-400" />
                                <Input value={scanItemSearch} onChange={(e) => setScanItemSearch(e.target.value)}
                                  placeholder="Search rows…" className="pl-8 h-9 text-sm" />
                              </div>
                              {scanItemSearch && (
                                <Button size="sm" variant="ghost" className="h-9 w-9 p-0"
                                  onClick={() => setScanItemSearch("")}>
                                  <X className="h-3.5 w-3.5" />
                                </Button>
                              )}
                              <span className="text-xs text-gray-500 whitespace-nowrap">
                                {scanFiltered.length}/{scanAllItems.length}
                              </span>
                            </div>
                            {scanItemsQuery.isLoading ? (
                              <div className="flex justify-center py-6">
                                <Loader2 className="h-5 w-5 animate-spin text-[#001d6e]" />
                              </div>
                            ) : (
                              <div className="overflow-x-auto rounded-md border">
                                <table className="w-max min-w-full border-collapse text-xs">
                                  <thead>
                                    <tr>
                                      {["#", "Barcode", "Item Name", "SAP Code", "Qty", "Pallets"].map((h) => (
                                        <th key={h} className="sticky top-0 whitespace-nowrap border-b border-r bg-slate-100 px-3 py-2 text-left font-semibold text-[#001d6e]">{h}</th>
                                      ))}
                                    </tr>
                                  </thead>
                                  <tbody>
                                    {scanFiltered.map((item, idx) => (
                                      <tr key={item.id} className={`border-b ${idx % 2 === 1 ? "bg-gray-50" : "bg-white"} hover:bg-blue-50/30`}>
                                        <td className="border-r px-3 py-1.5 text-gray-400">{idx + 1}</td>
                                        <td className="border-r px-3 py-1.5">{item.barcode || "—"}</td>
                                        <td className="max-w-[160px] truncate border-r px-3 py-1.5" title={item.itemName ?? ""}>{item.itemName || "—"}</td>
                                        <td className="border-r px-3 py-1.5">{item.sapCode || "—"}</td>
                                        <td className="border-r px-3 py-1.5 text-right">{item.quantity ?? 0}</td>
                                        <td className="px-3 py-1.5 text-right">{item.expectedPallets ?? "—"}</td>
                                      </tr>
                                    ))}
                                  </tbody>
                                </table>
                              </div>
                            )}
                          </div>
                        )}
                      </div>
                    );
                  })}
                </div>
              )}
            </div>
          )}

          {/* ── Tab: Active ── */}
          {activeTab === "active" && (
            <div>
              {activeScanSessions.length === 0 ? (
                <div className="flex flex-col items-center justify-center py-12 text-gray-400">
                  <PackageCheck className="h-10 w-10 mb-3 opacity-20" />
                  <p className="text-sm font-medium">No active session</p>
                  <p className="text-xs mt-1">Load a CSV session from Available to start scanning</p>
                </div>
              ) : (
                <div className="divide-y divide-amber-100">
                  {activeScanSessions.map((s) => (
                    <div key={s.id} className="bg-amber-50 border border-amber-200 rounded-xl p-4 mx-4 my-3">
                      <div className="flex items-start gap-3">
                        <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-full bg-amber-100 border border-amber-200">
                          <ScanLine className="h-5 w-5 text-amber-600" />
                        </div>
                        <div className="flex-1 min-w-0">
                          <p className="truncate text-sm font-bold text-gray-900">{stripCsvExt(s.csvFileName)}</p>
                          <div className="mt-0.5 flex flex-wrap items-center gap-x-1.5 gap-y-0.5">
                            <span className="rounded bg-amber-200 px-1.5 py-0.5 text-[10px] font-semibold text-amber-800 uppercase">{s.plant}</span>
                            <span className="text-xs text-gray-500">{s.rowCount} rows</span>
                            {s.importedByName && <span className="text-xs text-gray-500">· {s.importedByName}</span>}
                          </div>
                          {s.scanActivatedByName && (
                            <p className="mt-1 text-xs text-amber-700 font-medium">
                              Scanning by: {s.scanActivatedByName}
                              {s.scanActivatedAt && <span className="font-normal text-gray-400"> · since {fmtIST(s.scanActivatedAt)}</span>}
                            </p>
                          )}
                          {/* Mobile buttons */}
                          <div className="mt-3 flex flex-wrap gap-2 sm:hidden">
                            <Button size="sm" className="h-9 flex-1 text-xs bg-amber-600 hover:bg-amber-700 text-white"
                              onClick={() => navigate("/scan")}>
                              <ScanLine className="mr-1.5 h-3.5 w-3.5" /> View Scan
                            </Button>
                            <Button size="sm" variant="outline"
                              className="h-9 flex-1 text-xs text-amber-700 border-amber-200 hover:bg-amber-50"
                              disabled={deactivateMutation.isPending}
                              onClick={() => setDeactivateTarget(s.id)}>
                              <StopCircle className="mr-1 h-3 w-3" /> Deactivate
                            </Button>
                            <Button size="sm" variant="outline"
                              className="h-9 flex-1 text-xs text-green-700 border-green-200 hover:bg-green-50"
                              disabled={completeMutation.isPending}
                              onClick={() => setCompleteTarget(s.id)}>
                              <CheckCircle2 className="mr-1 h-3 w-3" /> Complete
                            </Button>
                          </div>
                        </div>
                        {/* Desktop buttons */}
                        <div className="hidden sm:flex shrink-0 flex-col items-end gap-1.5">
                          <Button size="sm" className="h-8 text-xs bg-amber-600 hover:bg-amber-700 text-white"
                            onClick={() => navigate("/scan")}>
                            <ScanLine className="mr-1.5 h-3.5 w-3.5" /> View Scan
                          </Button>
                          <div className="flex items-center gap-1">
                            <Button size="sm" variant="outline"
                              className="h-7 px-2 text-xs text-amber-700 border-amber-200 hover:bg-amber-50"
                              disabled={deactivateMutation.isPending}
                              onClick={() => setDeactivateTarget(s.id)}>
                              <StopCircle className="mr-1 h-3 w-3" /> Deactivate
                            </Button>
                            <Button size="sm" variant="outline"
                              className="h-7 px-2 text-xs text-green-700 border-green-200 hover:bg-green-50"
                              disabled={completeMutation.isPending}
                              onClick={() => setCompleteTarget(s.id)}>
                              <CheckCircle2 className="mr-1 h-3 w-3" /> Complete
                            </Button>
                          </div>
                        </div>
                      </div>
                    </div>
                  ))}
                </div>
              )}
            </div>
          )}

          {/* ── Tab: Completed ── */}
          {activeTab === "completed" && (
            <div>
              {/* Filters */}
              <div className="flex flex-wrap items-center gap-2 px-5 py-3 border-b border-gray-50">
                {plantOptions.length > 0 ? (
                  <Select value={completedPlant || "_all_"} onValueChange={(v) => setCompletedPlant(v === "_all_" ? "" : v)}>
                    <SelectTrigger className="h-8 w-[130px] text-xs">
                      <SelectValue placeholder="All plants" />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="_all_">All plants</SelectItem>
                      {plantOptions.map((p) => <SelectItem key={p.name} value={p.name}>{p.name}</SelectItem>)}
                    </SelectContent>
                  </Select>
                ) : (
                  <Input value={completedPlant} onChange={(e) => setCompletedPlant(e.target.value)}
                    placeholder="Plant…" className="h-8 w-[110px] text-xs" />
                )}
                <Input type="date" value={completedDate} onChange={(e) => setCompletedDate(e.target.value)}
                  className="h-8 w-[140px] text-xs" />
                {completedDate !== todayStr && (
                  <Button size="sm" variant="ghost" className="h-8 px-2 text-xs text-gray-500 hover:text-[#001d6e]"
                    onClick={() => setCompletedDate(todayStr)}>
                    Today
                  </Button>
                )}
                {completedDate && (
                  <Button size="sm" variant="ghost" className="h-8 w-8 p-0 text-gray-400 hover:text-red-500"
                    onClick={() => setCompletedDate("")}>
                    <X className="h-3.5 w-3.5" />
                  </Button>
                )}
                <Button size="sm" variant="outline" className="h-8 w-8 p-0 ml-auto"
                  onClick={() => scanSessionsQuery.refetch()} disabled={scanSessionsQuery.isFetching}>
                  <RefreshCw className={`h-3.5 w-3.5 ${scanSessionsQuery.isFetching ? "animate-spin" : ""}`} />
                </Button>
              </div>
              {/* Content */}
              {scanSessionsQuery.isFetching && completedScanSessions.length === 0 ? (
                <div className="flex justify-center py-12">
                  <Loader2 className="h-6 w-6 animate-spin text-green-600" />
                </div>
              ) : completedScanSessions.length === 0 ? (
                <div className="flex flex-col items-center justify-center py-12 text-gray-400">
                  <CheckCircle2 className="h-10 w-10 mb-3 opacity-20" />
                  <p className="text-sm font-medium">No completed sessions</p>
                  <p className="text-xs mt-1">Sessions completed in the last 48 hours appear here</p>
                </div>
              ) : (
                <div className="divide-y">
                  {completedScanSessions.map((s) => (
                    <div key={s.id} className="px-5 py-3 hover:bg-gray-50">
                      <div className="flex items-center gap-3">
                        <div className="flex-1 min-w-0">
                          <p className="truncate text-sm font-medium text-gray-900">{stripCsvExt(s.csvFileName)}</p>
                          <div className="mt-0.5 flex flex-wrap items-center gap-x-1.5 gap-y-0.5">
                            <span className="rounded bg-green-100 px-1.5 py-0.5 text-[10px] font-semibold text-green-700 uppercase">{s.plant}</span>
                            {s.scanCompletedAt && <span className="text-xs text-green-700 font-medium">Done {fmtIST(s.scanCompletedAt)}</span>}
                            {s.importedByName && <span className="text-xs text-gray-400">· {s.importedByName}</span>}
                            {s.scanActivatedByName && <span className="text-xs text-gray-400">· Scanned by {s.scanActivatedByName}</span>}
                          </div>
                        </div>
                        <div className="flex shrink-0 items-center gap-1.5">
                          <span className="inline-flex items-center rounded-full bg-green-100 px-2 py-0.5 text-xs font-semibold text-green-700">
                            {s.rowCount}
                          </span>
                          <span className="inline-flex items-center gap-1 rounded-full bg-green-100 px-2 py-0.5 text-xs font-semibold text-green-700">
                            <CheckCircle2 className="h-3 w-3" /> Done
                          </span>
                        </div>
                      </div>
                    </div>
                  ))}
                </div>
              )}
            </div>
          )}

          {/* ── Tab: History ── */}
          {activeTab === "history" && (
            <div>
              {/* Filters */}
              <div className="flex flex-wrap items-center gap-2 px-5 py-3 border-b border-gray-50">
                {plantOptions.length > 0 ? (
                  <Select value={filterPlant || "_all_"} onValueChange={(v) => { setFilterPlant(v === "_all_" ? "" : v); setCurrentPage(1); }}>
                    <SelectTrigger className="h-8 w-[130px] text-xs">
                      <SelectValue placeholder="All plants" />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="_all_">All plants</SelectItem>
                      {plantOptions.map((p) => <SelectItem key={p.name} value={p.name}>{p.name}</SelectItem>)}
                    </SelectContent>
                  </Select>
                ) : (
                  <Input value={filterPlant} onChange={(e) => { setFilterPlant(e.target.value); setCurrentPage(1); }}
                    placeholder="Plant…" className="h-8 w-[110px] text-xs" />
                )}
                <Input type="date" value={filterDate} onChange={(e) => { setFilterDate(e.target.value); setCurrentPage(1); }}
                  className="h-8 w-[140px] text-xs" />
                {filterDate !== todayStr && (
                  <Button size="sm" variant="ghost" className="h-8 px-2 text-xs text-gray-500 hover:text-[#001d6e]"
                    onClick={() => { setFilterDate(todayStr); setCurrentPage(1); }}>
                    Today
                  </Button>
                )}
                {filterDate && (
                  <Button size="sm" variant="ghost" className="h-8 w-8 p-0 text-gray-400 hover:text-red-500"
                    onClick={() => { setFilterDate(""); setCurrentPage(1); }}>
                    <X className="h-3.5 w-3.5" />
                  </Button>
                )}
                <Select value={String(pageSize)} onValueChange={(v) => { setPageSize(Number(v)); setCurrentPage(1); }}>
                  <SelectTrigger className="h-8 w-[65px] text-xs">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="10">10</SelectItem>
                    <SelectItem value="25">25</SelectItem>
                    <SelectItem value="50">50</SelectItem>
                  </SelectContent>
                </Select>
                {sessionsQuery.isFetching && <Loader2 className="h-3.5 w-3.5 animate-spin text-gray-400" />}
              </div>
              {/* Content */}
              {sessionsQuery.isLoading ? (
                <div className="flex items-center justify-center py-12">
                  <Loader2 className="h-6 w-6 animate-spin text-[#001d6e]" />
                </div>
              ) : sessions.length === 0 ? (
                <div className="flex flex-col items-center justify-center py-12 text-muted-foreground">
                  <FileUp className="h-10 w-10 mb-3 opacity-20" />
                  <p className="text-sm font-medium">
                    {filterDate ? `No imports found for ${filterDate}.` : "No imports yet."}
                  </p>
                </div>
              ) : (
                <>
                  <div className="divide-y">
                    {sessions.map((session) => {
                      const importerName = (session as any).importedByName || session.importedByCode || "Unknown";
                      return (
                        <div key={session.id}>
                          <div
                            className="cursor-pointer px-5 py-3 hover:bg-gray-50 active:bg-gray-100"
                            onClick={() => {
                              setExpandedId(expandedId === session.id ? null : session.id);
                              setItemSearch("");
                            }}
                          >
                            <div className="flex items-start gap-2">
                              <span className="mt-0.5 shrink-0 text-gray-400">
                                {expandedId === session.id
                                  ? <ChevronDown className="h-4 w-4" />
                                  : <ChevronRight className="h-4 w-4" />}
                              </span>
                              <div className="flex-1 min-w-0">
                                <p className="truncate text-sm font-medium text-gray-900">{stripCsvExt(session.csvFileName)}</p>
                                <div className="mt-0.5 flex flex-wrap items-center gap-x-1.5 gap-y-0.5">
                                  <span className="rounded bg-[#001d6e]/10 px-1.5 py-0.5 text-[10px] font-semibold text-[#001d6e] uppercase">{session.plant}</span>
                                  <span className="text-xs text-gray-400">{fmtIST(session.createdAt)}</span>
                                  <span className="inline-flex items-center gap-1 text-xs text-gray-500">
                                    <svg className="h-3 w-3" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                                      <circle cx="12" cy="8" r="4"/><path d="M4 20c0-4 3.6-7 8-7s8 3 8 7"/>
                                    </svg>
                                    {importerName}
                                  </span>
                                  {(session as any).receivingSessionId && (
                                    <span className="rounded bg-purple-50 px-1.5 py-0.5 text-[10px] font-semibold text-purple-700">
                                      Part {(session as any).partIndex ?? "?"}
                                    </span>
                                  )}
                                </div>
                              </div>
                              <div className="flex shrink-0 items-center gap-1 ml-1">
                                <Badge className="bg-[#001d6e]/10 text-[#001d6e] hover:bg-[#001d6e]/10 text-xs px-1.5">
                                  {session.rowCount}
                                </Badge>
                                {(session as any).scanStatus === "active" && (
                                  <span className="inline-flex items-center gap-1 rounded-full bg-amber-100 px-2 py-0.5 text-[10px] font-semibold text-amber-700 whitespace-nowrap">
                                    <span className="h-1.5 w-1.5 rounded-full bg-amber-400 animate-pulse" />
                                    Loaded
                                  </span>
                                )}
                                {(session as any).scanStatus === "completed" && (
                                  <span className="inline-flex items-center gap-1 rounded-full bg-green-100 px-2 py-0.5 text-[10px] font-semibold text-green-700 whitespace-nowrap">
                                    <CheckCircle2 className="h-3 w-3" /> Done
                                  </span>
                                )}
                                {(session as any).scanStatus === "available" && (
                                  <span className="rounded-full bg-gray-100 px-2 py-0.5 text-[10px] font-medium text-gray-500 whitespace-nowrap">
                                    Ready
                                  </span>
                                )}
                              </div>
                            </div>
                          </div>
                          {expandedId === session.id && (
                            <div className="border-t bg-gray-50/60 px-5 py-3">
                              <div className="mb-3 flex items-center gap-2">
                                <div className="relative flex-1">
                                  <Search className="absolute left-3 top-2.5 h-3.5 w-3.5 text-gray-400" />
                                  <Input value={itemSearch} onChange={(e) => setItemSearch(e.target.value)}
                                    placeholder="Search rows…" className="pl-8 h-9 text-sm" />
                                </div>
                                {itemSearch && (
                                  <Button size="sm" variant="ghost" className="h-9 w-9 p-0"
                                    onClick={() => setItemSearch("")}>
                                    <X className="h-3.5 w-3.5" />
                                  </Button>
                                )}
                                <span className="text-xs text-gray-500 whitespace-nowrap">
                                  {filteredItems.length}/{allItems.length}
                                </span>
                              </div>
                              {itemsQuery.isLoading ? (
                                <div className="flex justify-center py-6">
                                  <Loader2 className="h-5 w-5 animate-spin text-[#001d6e]" />
                                </div>
                              ) : (
                                <div className="overflow-x-auto rounded-md border">
                                  <table className="w-max min-w-full border-collapse text-xs">
                                    <thead>
                                      <tr>
                                        {["#", "Barcode", "Item Name", "SAP Code", "Qty", "Pallets", "Date"].map((h) => (
                                          <th key={h} className="sticky top-0 whitespace-nowrap border-b border-r bg-slate-100 px-3 py-2 text-left font-semibold text-[#001d6e]">
                                            {h}
                                          </th>
                                        ))}
                                      </tr>
                                    </thead>
                                    <tbody>
                                      {filteredItems.map((item, idx) => (
                                        <tr key={item.id} className={`border-b ${idx % 2 === 1 ? "bg-gray-50" : "bg-white"} hover:bg-blue-50/30`}>
                                          <td className="border-r px-3 py-1.5 text-gray-400">{idx + 1}</td>
                                          <td className="border-r px-3 py-1.5">{item.barcode || "—"}</td>
                                          <td className="max-w-[200px] truncate border-r px-3 py-1.5" title={item.itemName ?? ""}>{item.itemName || "—"}</td>
                                          <td className="border-r px-3 py-1.5">{item.sapCode || "—"}</td>
                                          <td className="border-r px-3 py-1.5 text-right">{item.quantity ?? 0}</td>
                                          <td className="border-r px-3 py-1.5 text-right">{item.expectedPallets ?? "—"}</td>
                                          <td className="px-3 py-1.5">{(item as any).date || "—"}</td>
                                        </tr>
                                      ))}
                                    </tbody>
                                  </table>
                                </div>
                              )}
                            </div>
                          )}
                        </div>
                      );
                    })}
                  </div>
                  {/* Pagination */}
                  {totalPages > 1 && (
                    <div className="flex flex-wrap items-center justify-between gap-2 border-t px-5 py-3">
                      <span className="text-xs text-gray-500">
                        Page {safePage} of {totalPages} · {totalSessions} sessions
                      </span>
                      <div className="flex items-center gap-1">
                        <Button size="sm" variant="outline" className="h-8 px-2 text-xs"
                          disabled={safePage <= 1} onClick={() => setCurrentPage(safePage - 1)}>
                          ← Prev
                        </Button>
                        {Array.from({ length: totalPages }, (_, i) => i + 1)
                          .filter((p) => p === 1 || p === totalPages || Math.abs(p - safePage) <= 1)
                          .reduce<(number | "…")[]>((acc, p, i, arr) => {
                            if (i > 0 && (p as number) - (arr[i - 1] as number) > 1) acc.push("…");
                            acc.push(p); return acc;
                          }, [])
                          .map((p, i) =>
                            p === "…" ? (
                              <span key={`e${i}`} className="px-1 text-xs text-gray-400">…</span>
                            ) : (
                              <Button key={p} size="sm"
                                variant={p === safePage ? "default" : "outline"}
                                className={`h-8 w-8 p-0 text-xs ${p === safePage ? "bg-[#001d6e] text-white" : ""}`}
                                onClick={() => setCurrentPage(p as number)}>
                                {p}
                              </Button>
                            )
                          )}
                        <Button size="sm" variant="outline" className="h-8 px-2 text-xs"
                          disabled={safePage >= totalPages} onClick={() => setCurrentPage(safePage + 1)}>
                          Next →
                        </Button>
                      </div>
                    </div>
                  )}
                </>
              )}
            </div>
          )}
        </div>

      </div>{/* end max-w-5xl */}

      {/* ── Column mapping dialog ── */}
      <Dialog
        open={showMappingDialog}
        onOpenChange={(open) => { if (!open) { setShowMappingDialog(false); } }}
      >
        <DialogContent className="max-w-2xl max-h-[90vh] flex flex-col">
          <DialogHeader>
            <DialogTitle>Map CSV Columns</DialogTitle>
            <DialogDescription>
              {csvData
                ? `"${csvData.name}" — ${csvData.rows.length} rows detected. Match each target field to a CSV column.`
                : "Map columns."}
            </DialogDescription>
          </DialogHeader>

          {csvData && (
            <div className="flex flex-col gap-4 overflow-y-auto flex-1 min-h-0 pr-1">
              <div className="rounded-md border border-blue-100 bg-blue-50 px-4 py-3">
                <p className="mb-2 text-xs font-semibold text-blue-700">
                  {csvData.headers.length} columns detected in "{csvData.name}"
                </p>
                <div className="flex flex-wrap gap-1.5">
                  {csvData.headers.map((h) => (
                    <span key={h} className="rounded border border-blue-200 bg-white px-2 py-0.5 text-xs text-blue-800 font-mono">
                      {h}
                    </span>
                  ))}
                </div>
              </div>
              <div className="rounded-md border bg-gray-50 p-4">
                <p className="mb-3 text-xs font-semibold uppercase tracking-wide text-gray-500">
                  Map each target field → CSV column
                </p>
                <div className="grid grid-cols-1 gap-3">
                  {TARGET_FIELDS.map((field) => {
                    const matched = mapping[field.key] !== SKIP && mapping[field.key] !== "";
                    return (
                      <div key={field.key} className="flex items-center gap-3">
                        <div className="flex w-[140px] shrink-0 items-center gap-1.5">
                          <span className={`h-2 w-2 rounded-full ${matched ? "bg-green-500" : "bg-gray-300"}`} />
                          <Label className="text-sm">{field.label}</Label>
                        </div>
                        <Select
                          value={mapping[field.key] || SKIP}
                          onValueChange={(v) => setMapping((m) => ({ ...m, [field.key]: v }))}
                        >
                          <SelectTrigger className={`flex-1 h-9 text-sm ${!matched ? "border-dashed text-gray-400" : ""}`}>
                            <SelectValue placeholder="— skip this field —" />
                          </SelectTrigger>
                          <SelectContent>
                            <SelectItem value={SKIP}>— skip this field —</SelectItem>
                            {csvData.headers.map((h) => (
                              <SelectItem key={h} value={h}>{h}</SelectItem>
                            ))}
                          </SelectContent>
                        </Select>
                      </div>
                    );
                  })}
                </div>
              </div>
              <div>
                <p className="mb-2 text-xs font-semibold uppercase tracking-wide text-gray-500">
                  Preview — first {Math.min(5, csvData.rows.length)} of {csvData.rows.length} rows
                </p>
                <div className="overflow-x-auto rounded-md border">
                  <table className="w-max min-w-full border-collapse text-xs">
                    <thead>
                      <tr>
                        {TARGET_FIELDS.map((f) => {
                          const col = mapping[f.key];
                          const matched = col && col !== SKIP;
                          return (
                            <th key={f.key} className={`sticky top-0 whitespace-nowrap border-b border-r px-3 py-2 text-left font-semibold ${matched ? "bg-green-50 text-green-800" : "bg-gray-100 text-gray-400"}`}>
                              {f.label}
                              {matched && (
                                <div className="font-normal text-green-600 text-xs mt-0.5">← {col}</div>
                              )}
                            </th>
                          );
                        })}
                      </tr>
                    </thead>
                    <tbody>
                      {csvData.rows.slice(0, 5).map((row, i) => (
                        <tr key={i} className="border-b hover:bg-gray-50">
                          {TARGET_FIELDS.map((f) => {
                            const col = mapping[f.key];
                            const val = col && col !== SKIP ? (row[col] ?? "") : "";
                            return (
                              <td key={f.key} className={`max-w-[180px] truncate whitespace-nowrap border-r px-3 py-2 ${val ? "" : "text-gray-300"}`} title={val}>
                                {val || "—"}
                              </td>
                            );
                          })}
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </div>
            </div>
          )}

          <DialogFooter className="mt-2 gap-2">
            {uploadProgress && (
              <span className="mr-auto self-center text-xs text-gray-500">File {uploadProgress.current} of {uploadProgress.total}</span>
            )}
            <Button variant="outline"
              onClick={() => {
                // Cancel aborts the whole queue.
                setShowMappingDialog(false);
                uploadQueueRef.current = [];
                uploadIdxRef.current = 0;
                setUploadProgress(null);
              }}
              disabled={isBatchImporting}>
              Cancel
            </Button>
            <Button onClick={handleConfirmImport}
              disabled={isBatchImporting || !csvData}
              className="bg-[#001d6e] hover:bg-[#00154b] text-white">
              {isBatchImporting ? (
                <><Loader2 className="mr-1.5 h-4 w-4 animate-spin" />Importing…</>
              ) : (
                <><Upload className="mr-1.5 h-4 w-4" />Import {csvData?.rows.length ?? 0} rows{uploadProgress && uploadProgress.total > 1 ? ` · next file →` : ""}</>
              )}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* ── Deactivate confirmation ── */}
      <AlertDialog open={deactivateTarget !== null} onOpenChange={(open) => { if (!open) setDeactivateTarget(null); }}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Deactivate this session?</AlertDialogTitle>
            <AlertDialogDescription>
              This releases the active lock so another session can be loaded. Scan progress is preserved — you can re-activate this session later.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction className="bg-amber-600 text-white hover:bg-amber-700"
              onClick={() => deactivateTarget !== null && deactivateMutation.mutate(deactivateTarget)}
              disabled={deactivateMutation.isPending}>
              {deactivateMutation.isPending ? <Loader2 className="h-4 w-4 animate-spin" /> : "Deactivate"}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      {/* ── Complete confirmation ── */}
      <AlertDialog open={completeTarget !== null} onOpenChange={(open) => { if (!open) setCompleteTarget(null); }}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Mark session as completed?</AlertDialogTitle>
            <AlertDialogDescription>
              This marks the scan session as done. It will no longer be available for scanning.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction className="bg-green-600 text-white hover:bg-green-700"
              onClick={() => completeTarget !== null && completeMutation.mutate(completeTarget)}
              disabled={completeMutation.isPending}>
              {completeMutation.isPending ? <Loader2 className="h-4 w-4 animate-spin" /> : "Complete"}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      {/* ── Delete confirmation ── */}
      <AlertDialog open={deleteTarget !== null} onOpenChange={(open) => { if (!open) setDeleteTarget(null); }}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Delete this import session?</AlertDialogTitle>
            <AlertDialogDescription>
              All rows in this session will be permanently deleted. This cannot be undone.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction className="bg-red-600 text-white hover:bg-red-700"
              onClick={() => deleteTarget !== null && deleteMutation.mutate(deleteTarget)}
              disabled={deleteMutation.isPending}>
              {deleteMutation.isPending ? <Loader2 className="h-4 w-4 animate-spin" /> : "Delete"}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </main>
  );
}
