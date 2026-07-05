import { useEffect, useRef, useState } from "react";
import { useLocation } from "wouter";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import Papa from "papaparse";
import { getCurrentUserPermissions } from "../lib/permissions";
import {
  AlertCircle,
  AlertTriangle,
  CheckCircle,
  CheckCircle2,
  ChevronDown,
  ChevronRight,
  Download,
  FileUp,
  History,
  Layers,
  Loader2,
  PackageCheck,
  Pencil,
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

// ── Batch Master View (multi-file upload) ───────────────────────────────────
type MvItem = {
  id: number; barcode: string | null; itemName: string | null;
  sapCode: string | null; quantity: number | null; expectedPallets: number | null;
  scannedQty: number | null; scanStatus: string | null; isExtra?: boolean;
};
type MvFile = {
  sessionId: number; csvFileName: string; rowCount: number | null;
  uploadedAt: string | null; uploadedBy: string; plant: string;
  scanStatus: string | null; items: MvItem[];
};
type MvResponse = { date: string; totalFiles: number; totalRows: number; files: MvFile[] };
type MvMergedItem = {
  barcode: string | null; itemName: string | null; sapCode: string | null;
  quantity: number; scannedQty: number; expectedPallets: number | null;
  _files: string[]; _isExtra: boolean;
};
type BatchResult = { sessionIds: number[]; fileNames: string[]; totalRows: number; failed: string[]; groupId: number | null };

// ── FIFO group report (per-part + consolidated, with cross-part adjustments) ────
type GroupReportEntry = {
  barcode: string; itemName: string; expectedQty: number; receivedQty: number;
  extraQty: number; missingQty: number;
  adjustedTo: { toPartId: number; toCsvFileName: string; qty: number }[];
  adjustedFrom: { fromPartId: number; fromCsvFileName: string; qty: number }[];
  remainingExtra: number; remainingMissing: number;
};
type GroupReportPart = {
  id: number; partIndex: number; csvFileName: string; plant: string;
  scanStatus: string | null; rowCount: number | null;
  items: GroupReportEntry[];
  summary: {
    totalExpected: number; totalReceived: number; totalExtra: number; totalMissing: number;
    totalAdjustedTo: number; totalAdjustedFrom: number;
    netExtraAfterAdjustment: number; netMissingAfterAdjustment: number;
  };
};
type GroupReport = {
  groupId: number; plant: string;
  parts: GroupReportPart[];
  consolidated: {
    totalExpected: number; totalReceived: number; totalExtra: number; totalMissing: number;
    totalAdjustments: number; finalStockAdded: number;
    netExtraAfterAdjustment: number; netMissingAfterAdjustment: number;
    allComplete: boolean;
    productWise: { barcode: string; itemName: string; totalExpected: number; totalReceived: number; totalExtra: number; totalMissing: number; totalAdjusted: number }[];
  };
};

// DB stores timestamps in IST (server local time). The pg driver reads them as UTC
// and JSON serializes with Z, shifting the time by +5:30. To undo this, display
// using timeZone "UTC" so the raw stored value (= actual IST time) is shown as-is.
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

  // Form state
  const [plant, setPlant] = useState("");
  const [orderDate, setOrderDate] = useState(getLocalISODate());
  // One file → existing single-import flow (mapping dialog for review).
  // Multiple files → automatic batch import, each file auto-mapped independently.
  const [selectedFiles, setSelectedFiles] = useState<File[]>([]);
  const [isBatchImporting, setIsBatchImporting] = useState(false);
  const [batchResult, setBatchResult] = useState<BatchResult | null>(null);
  const [showBatchMasterView, setShowBatchMasterView] = useState(false);

  // FIFO Session upload — separate from the plain multi-file batch above: these files
  // become one group (Part 1, Part 2, ...) and completing a part auto-activates the next.
  const [fifoPlant, setFifoPlant] = useState("");
  const [fifoFiles, setFifoFiles] = useState<File[]>([]);
  const fifoFileRef = useRef<HTMLInputElement>(null);
  const [isFifoImporting, setIsFifoImporting] = useState(false);

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
  const [editTargetSession, setEditTargetSession] = useState<{ id: number; plant: string; csvFileName: string } | null>(null);
  const [showEditDialog, setShowEditDialog] = useState(false);
  const [editFile, setEditFile] = useState<File | null>(null);
  const editFileRef = useRef<HTMLInputElement>(null);
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

  // Master View scoped to exactly the sessions from the last batch upload (not the
  // broader date+plant view) — see GET /order-import/master-view?sessionIds=...
  const batchMvQuery = useQuery<MvResponse>({
    queryKey: ["/api/order-import/master-view", "batch", batchResult?.sessionIds],
    queryFn: async () =>
      (await apiRequest("GET", `/api/order-import/master-view?sessionIds=${batchResult!.sessionIds.join(",")}`)).json(),
    enabled: showBatchMasterView && !!batchResult && batchResult.sessionIds.length > 0,
    staleTime: 0,
  });

  // Same barcode-merge logic as the Scan page's Master View: same item across the
  // batch's files has its expected/scanned qty summed into one row.
  const batchMvItems: MvMergedItem[] = (() => {
    const data = batchMvQuery.data;
    if (!data) return [];
    const groups = new Map<string, MvMergedItem>();
    data.files.forEach((f) => {
      f.items.forEach((item) => {
        const key = item.barcode?.trim().toLowerCase()
          || (item.itemName ? `name::${item.itemName.trim().toLowerCase()}` : `id::${item.id}`);
        let g = groups.get(key);
        if (!g) {
          g = { barcode: item.barcode, itemName: item.itemName, sapCode: item.sapCode, quantity: 0, scannedQty: 0, expectedPallets: null, _files: [], _isExtra: true };
          groups.set(key, g);
        }
        g.quantity += item.quantity ?? 0;
        g.scannedQty += item.scannedQty ?? 0;
        if (item.expectedPallets != null) g.expectedPallets = (g.expectedPallets ?? 0) + item.expectedPallets;
        if (!g.itemName && item.itemName) g.itemName = item.itemName;
        if (!g.sapCode && item.sapCode) g.sapCode = item.sapCode;
        if (!g._files.includes(f.csvFileName)) g._files.push(f.csvFileName);
        if (!item.isExtra) g._isExtra = false;
      });
    });
    return Array.from(groups.values());
  })();

  // FIFO batch report — per-part expected/received/extra/missing with cross-part
  // adjustments. Only meaningful (and only enabled) when the batch is a FIFO group.
  const groupReportQuery = useQuery<GroupReport>({
    queryKey: ["/api/order-import/sessions", batchResult?.groupId, "group-report"],
    queryFn: async () =>
      (await apiRequest("GET", `/api/order-import/sessions/${batchResult!.groupId}/group-report`)).json(),
    enabled: showBatchMasterView && !!batchResult?.groupId,
    staleTime: 0,
    refetchInterval: 10000,
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

  const updateMutation = useMutation({
    mutationFn: async (payload: { id: number; csvFileName: string; items: object[] }) =>
      (await apiRequest("PUT", `/api/order-import/sessions/${payload.id}`, payload)).json(),
    onSuccess: (data, vars) => {
      setShowMappingDialog(false);
      setCsvData(null);
      setEditTargetSession(null);
      qc.invalidateQueries({ queryKey: ["/api/order-import/items", vars.id] });
      toast({ title: "Import updated", description: `${data.rowCount} rows replaced.`, className: "bg-green-50 border-green-200 text-green-900" });
    },
    onError: (err: any) =>
      toast({ title: "Update failed", description: err.message, variant: "destructive" }),
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

  function handleImportClick() {
    if (!plant.trim()) {
      toast({ title: "Select a plant first", variant: "destructive" });
      return;
    }
    if (selectedFiles.length === 0) {
      toast({ title: "Select a CSV file first", variant: "destructive" });
      return;
    }
    if (selectedFiles.length === 1) {
      parseAndOpen(selectedFiles[0]);
    } else {
      runBatchImport();
    }
  }

  function handleConfirmImport() {
    if (!csvData) return;
    const items = buildItemsFromRows(csvData.rows, mapping);
    if (editTargetSession) {
      updateMutation.mutate({ id: editTargetSession.id, csvFileName: csvData.name, items });
    } else {
      importMutation.mutate({ plant, csvFileName: csvData.name, items });
    }
  }

  // Multi-file upload: each file gets its own auto-detected column mapping (different
  // suppliers use different headers) and becomes its own independent order_import_sessions
  // row — no FIFO/receiving-session grouping, no manual per-file review. Continues past a
  // single file's failure so one bad CSV doesn't block the rest of the batch.
  async function runBatchImport() {
    const files = selectedFiles;
    if (files.length === 0) return;
    setIsBatchImporting(true);
    const sessionIds: number[] = [];
    const fileNames: string[] = [];
    const failed: string[] = [];
    let totalRows = 0;

    for (const file of files) {
      try {
        const parsed = await parseCsvRaw(file);
        if (!parsed) { failed.push(file.name); continue; }
        const fileMapping = autoMatch(parsed.headers);
        const items = buildItemsFromRows(parsed.rows, fileMapping);
        const resp = await apiRequest("POST", "/api/order-import/sessions", { plant, csvFileName: file.name, items });
        const data = await resp.json();
        if (data?.session?.id) {
          sessionIds.push(data.session.id);
          fileNames.push(file.name);
          totalRows += data.rowCount ?? 0;
        } else {
          failed.push(file.name);
        }
      } catch {
        failed.push(file.name);
      }
    }

    setIsBatchImporting(false);
    setSelectedFiles([]);
    if (fileRef.current) fileRef.current.value = "";
    setLastImport({ rowCount: totalRows });
    setShowHistory(true);
    setCurrentPage(1);
    setFilterDate("");
    setFilterPlant("");
    refetchAllSessionQueries();

    if (sessionIds.length > 0) {
      setBatchResult({ sessionIds, fileNames, totalRows, failed, groupId: null });
      setShowBatchMasterView(true);
    }

    toast({
      title: failed.length === 0 ? "Batch import complete" : sessionIds.length === 0 ? "Batch import failed" : "Batch import finished with errors",
      description: `${sessionIds.length} of ${files.length} file(s) imported · ${totalRows} rows${failed.length ? ` · failed: ${failed.join(", ")}` : ""}`,
      variant: sessionIds.length === 0 ? "destructive" : undefined,
      className: failed.length === 0 ? "bg-green-50 border-green-200 text-green-900" : undefined,
    });
  }

  // FIFO Session upload: files become ONE group (Part 1, Part 2, ...). Part 1 is created
  // first with partIndex:1 and no receivingSessionId — the server self-assigns Part 1's own
  // id as the group id and returns it, which is then attached to every subsequent part.
  // Only Part 1 auto-activates immediately (nothing else in the group is active yet);
  // completing a part auto-activates the next by partIndex (see /order-scan/.../complete).
  // Reopens the Batch Master View / FIFO Report for a group after the fact (e.g. from
  // the History tab), not just right after uploading it. Derives sessionIds from the
  // report's own parts list since we don't have them cached from the original upload.
  async function openGroupReport(groupId: number) {
    try {
      const resp = await apiRequest("GET", `/api/order-import/sessions/${groupId}/group-report`);
      const data: GroupReport = await resp.json();
      setBatchResult({
        sessionIds: data.parts.map((p) => p.id),
        fileNames: data.parts.map((p) => p.csvFileName),
        totalRows: data.parts.reduce((s, p) => s + (p.rowCount ?? 0), 0),
        failed: [],
        groupId,
      });
      setShowBatchMasterView(true);
    } catch {
      toast({ title: "Failed to load FIFO report", variant: "destructive" });
    }
  }

  function downloadCsvFile(filename: string, rows: (string | number)[][]) {
    const csv = rows.map((r) => r.map((v) => `"${String(v ?? "").replace(/"/g, '""')}"`).join(",")).join("\n");
    const a = document.createElement("a");
    a.href = URL.createObjectURL(new Blob([csv], { type: "text/csv;charset=utf-8;" }));
    a.download = filename;
    a.click();
    URL.revokeObjectURL(a.href);
  }

  // CSV-wise export: one row per (part, item) with expected/received/extra/missing and the
  // cross-part adjustments applied to that line.
  function downloadGroupPartCsv(report: GroupReport) {
    const rows: (string | number)[][] = [[
      "Part", "File", "Status", "Barcode", "Item Name",
      "Expected", "Received", "Extra", "Missing", "Adjusted To Next", "Adjusted From Prev", "Net Extra", "Net Missing",
    ]];
    report.parts.forEach((p) => {
      p.items.forEach((i) => {
        rows.push([
          p.partIndex, p.csvFileName, p.scanStatus ?? "", i.barcode, i.itemName,
          i.expectedQty, i.receivedQty, i.extraQty, i.missingQty,
          i.adjustedTo.reduce((s, a) => s + a.qty, 0),
          i.adjustedFrom.reduce((s, a) => s + a.qty, 0),
          i.remainingExtra, i.remainingMissing,
        ]);
      });
    });
    downloadCsvFile(`fifo-report-partwise-group${report.groupId}.csv`, rows);
  }

  // Per-CSV report download — works as soon as THAT one part is completed, no need to wait
  // for the whole group. Fetches the single part's report and writes one CSV for it.
  async function downloadPartReport(sessionId: number, csvFileName: string) {
    try {
      const resp = await apiRequest("GET", `/api/order-import/sessions/${sessionId}/part-report`);
      const part: GroupReportPart = await resp.json();
      const rows: (string | number)[][] = [[
        "Barcode", "Item Name", "Expected", "Received", "Extra", "Missing",
        "Adjusted To Next", "Adjusted From Prev", "Net Extra", "Net Missing",
      ]];
      part.items.forEach((i) => {
        rows.push([
          i.barcode, i.itemName, i.expectedQty, i.receivedQty, i.extraQty, i.missingQty,
          i.adjustedTo.reduce((s, a) => s + a.qty, 0),
          i.adjustedFrom.reduce((s, a) => s + a.qty, 0),
          i.remainingExtra, i.remainingMissing,
        ]);
      });
      rows.push([]);
      rows.push(["TOTAL", "", part.summary.totalExpected, part.summary.totalReceived, part.summary.totalExtra, part.summary.totalMissing, part.summary.totalAdjustedTo, part.summary.totalAdjustedFrom, part.summary.netExtraAfterAdjustment, part.summary.netMissingAfterAdjustment]);
      const safeName = csvFileName.replace(/\.csv$/i, "").replace(/[^\w.-]+/g, "_");
      downloadCsvFile(`part-report-${safeName}.csv`, rows);
    } catch {
      toast({ title: "Failed to download part report", variant: "destructive" });
    }
  }

  // Final export: consolidated product-wise totals across the whole group (post-adjustment).
  function downloadGroupFinalCsv(report: GroupReport) {
    const rows: (string | number)[][] = [[
      "Barcode", "Item Name", "Total Expected", "Total Received", "Total Extra", "Total Missing", "Total Adjusted",
    ]];
    report.consolidated.productWise.forEach((pw) => {
      rows.push([pw.barcode, pw.itemName, pw.totalExpected, pw.totalReceived, pw.totalExtra, pw.totalMissing, pw.totalAdjusted]);
    });
    rows.push([]);
    rows.push(["CONSOLIDATED", "", report.consolidated.totalExpected, report.consolidated.totalReceived, report.consolidated.totalExtra, report.consolidated.totalMissing, report.consolidated.totalAdjustments]);
    rows.push(["Final Stock Added", report.consolidated.finalStockAdded, "Net Extra", report.consolidated.netExtraAfterAdjustment, "Net Missing", report.consolidated.netMissingAfterAdjustment, ""]);
    downloadCsvFile(`fifo-report-final-group${report.groupId}.csv`, rows);
  }

  async function runFifoImport() {
    if (!fifoPlant.trim()) {
      toast({ title: "Select a plant first", variant: "destructive" });
      return;
    }
    const files = fifoFiles;
    if (files.length === 0) {
      toast({ title: "Select at least one CSV file", variant: "destructive" });
      return;
    }
    setIsFifoImporting(true);
    let groupId: number | null = null;
    const sessionIds: number[] = [];
    const fileNames: string[] = [];
    const failed: string[] = [];
    let totalRows = 0;
    let partIndex = 1;

    for (const file of files) {
      try {
        const parsed = await parseCsvRaw(file);
        if (!parsed) { failed.push(file.name); partIndex++; continue; }
        const fileMapping = autoMatch(parsed.headers);
        const items = buildItemsFromRows(parsed.rows, fileMapping);
        const body: Record<string, unknown> = { plant: fifoPlant, csvFileName: file.name, items, partIndex };
        if (groupId) body.receivingSessionId = groupId;
        const resp = await apiRequest("POST", "/api/order-import/sessions", body);
        const data = await resp.json();
        if (data?.session?.id) {
          if (!groupId) groupId = data.session.receivingSessionId ?? data.session.id;
          sessionIds.push(data.session.id);
          fileNames.push(file.name);
          totalRows += data.rowCount ?? 0;
        } else {
          failed.push(file.name);
        }
      } catch {
        failed.push(file.name);
      }
      partIndex++;
    }

    setIsFifoImporting(false);
    setFifoFiles([]);
    if (fifoFileRef.current) fifoFileRef.current.value = "";
    setLastImport({ rowCount: totalRows });
    setShowHistory(true);
    setCurrentPage(1);
    setFilterDate("");
    setFilterPlant("");
    refetchAllSessionQueries();

    if (sessionIds.length > 0) {
      setBatchResult({ sessionIds, fileNames, totalRows, failed, groupId });
      setShowBatchMasterView(true);
    }

    toast({
      title: failed.length === 0 ? "FIFO session created" : sessionIds.length === 0 ? "FIFO session failed" : "FIFO session created with errors",
      description: `${sessionIds.length} of ${files.length} part(s) created · ${totalRows} rows${failed.length ? ` · failed: ${failed.join(", ")}` : ""}. Part 1 is active; the rest auto-load as each part is completed.`,
      variant: sessionIds.length === 0 ? "destructive" : undefined,
      className: failed.length === 0 ? "bg-green-50 border-green-200 text-green-900" : undefined,
    });
  }

  function parseAndReplace(file: File) {
    if (!editTargetSession) return;
    Papa.parse<string[]>(file, {
      header: false,
      skipEmptyLines: true,
      delimiter: "",
      encoding: "UTF-8",
      complete: (result) => {
        const rawRows = result.data as string[][];
        if (rawRows.length === 0) {
          toast({ title: "Empty file", description: "The CSV has no rows.", variant: "destructive" });
          return;
        }
        let headerRowIdx = 0;
        let maxCols = 0;
        for (let i = 0; i < Math.min(rawRows.length, 15); i++) {
          const nonEmpty = rawRows[i].filter((c) => c.trim() !== "").length;
          if (nonEmpty > maxCols) { maxCols = nonEmpty; headerRowIdx = i; }
        }
        const headers = rawRows[headerRowIdx].map((h) => cleanHeader(h)).filter((h) => h !== "");
        if (headers.length === 0) {
          toast({ title: "No columns found", description: "Could not detect column headers in the file.", variant: "destructive" });
          return;
        }
        const dataRows = rawRows.slice(headerRowIdx + 1).map((row) => {
          const obj: Record<string, string> = {};
          headers.forEach((h, i) => { obj[h] = row[i] ?? ""; });
          return obj;
        });
        const autoMapping = autoMatch(headers);
        const get = (row: Record<string, string>, key: TargetKey) => {
          const col = autoMapping[key];
          return col && col !== SKIP ? (row[col] ?? "") : "";
        };
        const items = dataRows.map((row) => ({
          barcode:         get(row, "barcode") || null,
          itemName:        get(row, "itemName") || null,
          sapCode:         get(row, "sapCode") || null,
          quantity:        parseInt(get(row, "quantity")) || 0,
          expectedPallets: parseFloat(get(row, "expectedPallets")) || null,
        }));
        if (items.length === 0) {
          toast({ title: "No data rows found", description: "The CSV contained no data rows.", variant: "destructive" });
          return;
        }
        setShowEditDialog(false);
        setEditFile(null);
        if (editFileRef.current) editFileRef.current.value = "";
        updateMutation.mutate({ id: editTargetSession!.id, csvFileName: file.name, items });
      },
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
                  disabled={selectedFiles.length === 0 || !plant.trim() || importMutation.isPending || isBatchImporting}>
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
                  disabled={selectedFiles.length === 0 || !plant.trim() || importMutation.isPending || isBatchImporting}>
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

        {/* ── FIFO Session Upload ── */}
        <div className="rounded-xl border border-purple-200 bg-white shadow-sm">
          <div className="flex items-center gap-2 border-b border-gray-100 px-5 py-4">
            <Layers className="h-5 w-5 text-purple-700" />
            <h2 className="text-base font-semibold text-gray-900">FIFO Session Upload</h2>
            <span className="text-xs text-gray-400">Multiple files → one ordered group; Part 1 loads now, the rest auto-load as each part completes</span>
          </div>
          <div className="p-5 space-y-4">
            <div className="flex flex-wrap items-end gap-3">
              <div className="grid gap-1 min-w-[130px] flex-1">
                <Label className="text-xs text-gray-500">Plant</Label>
                {plantOptions.length > 0 ? (
                  <Select value={fifoPlant || "_none_"} onValueChange={(v) => setFifoPlant(v === "_none_" ? "" : v)}>
                    <SelectTrigger className="h-9 text-sm"><SelectValue placeholder="Select…" /></SelectTrigger>
                    <SelectContent>
                      <SelectItem value="_none_">— Select —</SelectItem>
                      {plantOptions.map((p) => <SelectItem key={p.name} value={p.name}>{p.name}</SelectItem>)}
                    </SelectContent>
                  </Select>
                ) : (
                  <Input className="h-9 text-sm" value={fifoPlant} onChange={(e) => setFifoPlant(e.target.value)} placeholder="Plant…" />
                )}
              </div>
              <div className="grid gap-1 flex-[2] min-w-[220px]">
                <Label className="text-xs text-gray-500">
                  CSV Files (in scan order){fifoFiles.length > 0 && <span className="text-purple-700 font-medium"> · {fifoFiles.length} selected</span>}
                </Label>
                <Input ref={fifoFileRef} type="file" accept=".csv" multiple className="h-9 text-sm"
                  onChange={(e) => { setFifoFiles(Array.from(e.target.files ?? [])); e.target.value = ""; }}
                  disabled={isFifoImporting} />
              </div>
              <div className="flex gap-2 pb-0.5">
                <Button variant="outline" className="h-9" onClick={() => { setFifoFiles([]); if (fifoFileRef.current) fifoFileRef.current.value = ""; }}
                  disabled={fifoFiles.length === 0 || isFifoImporting}>
                  <X className="h-4 w-4" />
                </Button>
                <Button className="h-9 bg-purple-700 hover:bg-purple-800 text-white" onClick={runFifoImport}
                  disabled={fifoFiles.length === 0 || !fifoPlant.trim() || isFifoImporting}>
                  {isFifoImporting ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : <Layers className="mr-2 h-4 w-4" />}
                  Create FIFO Session ({fifoFiles.length || 0} part{fifoFiles.length === 1 ? "" : "s"})
                </Button>
              </div>
            </div>
            {fifoFiles.length > 1 && (
              <div className="rounded-lg border bg-purple-50/50 px-4 py-2.5 text-xs text-purple-800">
                Order: {fifoFiles.map((f, i) => `Part ${i + 1}: ${f.name}`).join(" · ")}
              </div>
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
                              <p className="truncate text-sm font-medium text-gray-900">{s.csvFileName}</p>
                              <div className="mt-0.5 flex flex-wrap items-center gap-x-1.5 gap-y-0.5">
                                <span className="rounded bg-[#001d6e]/10 px-1.5 py-0.5 text-[10px] font-semibold text-[#001d6e] uppercase">{s.plant}</span>
                                <span className="text-xs text-gray-400">{fmtIST(s.createdAt)}</span>
                                {s.importedByName && <span className="text-xs text-gray-400">· {s.importedByName}</span>}
                              </div>
                            </div>
                            <div className="flex shrink-0 items-center gap-1.5">
                              <span className="inline-flex items-center rounded-full bg-[#001d6e]/10 px-2 py-0.5 text-xs font-semibold text-[#001d6e]">
                                {s.rowCount}
                              </span>
                              <Button size="sm"
                                className="h-7 px-2 text-xs bg-[#001d6e] hover:bg-[#00154b] text-white"
                                disabled={loadForScanMutation.isPending}
                                onClick={(e) => { e.stopPropagation(); loadForScanMutation.mutate(s.id); }}>
                                {loadForScanMutation.isPending
                                  ? <Loader2 className="h-3 w-3 animate-spin mr-1" />
                                  : <ScanLine className="h-3 w-3 mr-1" />}
                                Load
                              </Button>
                              <Button size="sm" variant="ghost"
                                className="h-7 w-7 p-0 text-gray-400 hover:text-red-600"
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
                          <p className="truncate text-sm font-bold text-gray-900">{s.csvFileName}</p>
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
                            <Button size="sm" variant="ghost"
                              className="h-9 w-9 p-0 text-gray-400 hover:text-red-600"
                              onClick={() => setDeleteTarget(s.id)}>
                              <Trash2 className="h-3.5 w-3.5" />
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
                            <Button size="sm" variant="ghost"
                              className="h-7 w-7 p-0 text-gray-400 hover:text-red-600"
                              onClick={() => setDeleteTarget(s.id)}>
                              <Trash2 className="h-3.5 w-3.5" />
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
                          <p className="truncate text-sm font-medium text-gray-900">{s.csvFileName}</p>
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
                          <Button size="sm" variant="outline"
                            className="h-7 gap-1 px-2 text-xs text-green-700 border-green-200 hover:bg-green-50"
                            onClick={() => downloadPartReport(s.id, s.csvFileName)}>
                            <Download className="h-3.5 w-3.5" /> Report
                          </Button>
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
                                <p className="truncate text-sm font-medium text-gray-900">{session.csvFileName}</p>
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
                                    <button
                                      className="rounded bg-purple-50 px-1.5 py-0.5 text-[10px] font-semibold text-purple-700 hover:bg-purple-100"
                                      onClick={(e) => { e.stopPropagation(); openGroupReport((session as any).receivingSessionId); }}
                                    >
                                      Part {(session as any).partIndex ?? "?"} · View FIFO Report
                                    </button>
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
                                {(session as any).scanStatus === "completed" && (
                                  <Button size="sm" variant="ghost" title="Download this CSV's report"
                                    className="h-8 w-8 p-0 text-gray-400 hover:text-green-600"
                                    onClick={(e) => { e.stopPropagation(); downloadPartReport(session.id, session.csvFileName); }}>
                                    <Download className="h-3.5 w-3.5" />
                                  </Button>
                                )}
                                <Button size="sm" variant="ghost" title="Re-import with new CSV"
                                  className="h-8 w-8 p-0 text-gray-400 hover:text-blue-600"
                                  onClick={(e) => {
                                    e.stopPropagation();
                                    setEditTargetSession({ id: session.id, plant: session.plant, csvFileName: session.csvFileName });
                                    setShowEditDialog(true);
                                  }}>
                                  <Pencil className="h-3.5 w-3.5" />
                                </Button>
                                <Button size="sm" variant="ghost"
                                  className="h-8 w-8 p-0 text-gray-400 hover:text-red-600"
                                  onClick={(e) => { e.stopPropagation(); setDeleteTarget(session.id); }}>
                                  <Trash2 className="h-3.5 w-3.5" />
                                </Button>
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
            <DialogTitle>{editTargetSession ? "Re-map & Replace" : "Map CSV Columns"}</DialogTitle>
            <DialogDescription>
              {csvData
                ? `"${csvData.name}" — ${csvData.rows.length} rows detected. Match each target field to a CSV column.`
                : "Map columns."}
              {editTargetSession && (
                <span className="block mt-1 text-amber-600 font-medium">
                  Replacing: {editTargetSession.csvFileName} (Plant: {editTargetSession.plant})
                </span>
              )}
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
            <Button variant="outline" onClick={() => { setShowMappingDialog(false); setEditTargetSession(null); }}
              disabled={importMutation.isPending || updateMutation.isPending}>
              Cancel
            </Button>
            <Button onClick={handleConfirmImport}
              disabled={importMutation.isPending || updateMutation.isPending || !csvData}
              className="bg-[#001d6e] hover:bg-[#00154b] text-white">
              {(importMutation.isPending || updateMutation.isPending) ? (
                <><Loader2 className="mr-1.5 h-4 w-4 animate-spin" />{editTargetSession ? "Replacing…" : "Importing…"}</>
              ) : editTargetSession ? (
                <><Pencil className="mr-1.5 h-4 w-4" />Replace {csvData?.rows.length ?? 0} rows</>
              ) : (
                <><Upload className="mr-1.5 h-4 w-4" />Import {csvData?.rows.length ?? 0} rows</>
              )}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* ── Edit / Re-import dialog ── */}
      <Dialog
        open={showEditDialog}
        onOpenChange={(open) => { if (!open) { setShowEditDialog(false); setEditTargetSession(null); setEditFile(null); } }}
      >
        <DialogContent className="max-w-sm">
          <DialogHeader>
            <DialogTitle>Re-import CSV</DialogTitle>
            <DialogDescription>
              Upload a new CSV to replace all rows in <strong>{editTargetSession?.csvFileName}</strong>.
              Plant: <strong>{editTargetSession?.plant}</strong>
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-3">
            <div className="grid gap-1.5">
              <Label>New CSV File</Label>
              <Input ref={editFileRef} type="file" accept=".csv" className="h-10"
                onChange={(e) => { const f = e.target.files?.[0]; if (f) setEditFile(f); }} />
              {editFile && <p className="text-xs text-gray-500">{editFile.name} ({Math.max(1, Math.round(editFile.size / 1024))} KB)</p>}
            </div>
          </div>
          <DialogFooter className="gap-2">
            <Button variant="outline" onClick={() => { setShowEditDialog(false); setEditTargetSession(null); setEditFile(null); }}>
              Cancel
            </Button>
            <Button disabled={!editFile || updateMutation.isPending}
              className="bg-[#001d6e] hover:bg-[#00154b] text-white"
              onClick={() => { if (editFile) parseAndReplace(editFile); }}>
              {updateMutation.isPending
                ? <Loader2 className="mr-1.5 h-4 w-4 animate-spin" />
                : <Upload className="mr-1.5 h-4 w-4" />}
              Replace Data
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* ── Batch Master View — merged view of just the files from the last multi-upload ── */}
      <Dialog open={showBatchMasterView} onOpenChange={(open) => { if (!open) setShowBatchMasterView(false); }}>
        <DialogContent className="max-w-3xl max-h-[90vh] flex flex-col">
          <DialogHeader>
            <DialogTitle>Batch Master View</DialogTitle>
            <DialogDescription>
              {batchResult ? `${batchResult.sessionIds.length} file(s) imported · ${batchResult.totalRows} rows` : "Loading…"}
              {batchResult && batchResult.failed.length > 0 && (
                <span className="block mt-1 text-red-600 font-medium">Failed: {batchResult.failed.join(", ")}</span>
              )}
            </DialogDescription>
          </DialogHeader>

          {batchMvQuery.isLoading ? (
            <div className="flex justify-center py-12"><Loader2 className="h-6 w-6 animate-spin text-[#001d6e]" /></div>
          ) : (
            <div className="flex flex-col gap-3 overflow-y-auto flex-1 min-h-0 pr-1">
              <div className="flex flex-wrap gap-2">
                {(batchMvQuery.data?.files ?? []).map((f) => (
                  <span key={f.sessionId} className="inline-flex items-center gap-1.5 rounded-full border border-gray-200 bg-white px-3 py-1 text-xs text-gray-600">
                    <Layers className="h-3 w-3 text-gray-400" />
                    {f.csvFileName} <span className="text-gray-400">· {f.rowCount ?? f.items.length} rows</span>
                  </span>
                ))}
              </div>
              <div className="rounded-xl border bg-white shadow-sm overflow-hidden">
                <div className="flex items-center justify-between px-4 py-3 border-b bg-white">
                  <h3 className="text-sm font-semibold text-gray-900">Merged Items</h3>
                  <span className="text-xs text-gray-400">{batchMvItems.length} items</span>
                </div>
                <div className="overflow-x-auto">
                  <table className="w-full text-xs sm:text-sm">
                    <thead>
                      <tr className="bg-[#001d6e]">
                        <th className="px-3 py-2 w-8" />
                        <th className="px-3 py-2 text-left font-semibold text-white text-[11px] uppercase tracking-wide">Item Name</th>
                        <th className="px-3 py-2 text-left font-semibold text-white text-[11px] uppercase tracking-wide">Barcode</th>
                        <th className="px-3 py-2 text-left font-semibold text-white text-[11px] uppercase tracking-wide">Files</th>
                        <th className="px-3 py-2 text-right font-semibold text-white text-[11px] uppercase tracking-wide">Exp</th>
                        <th className="px-3 py-2 text-right font-semibold text-white text-[11px] uppercase tracking-wide">Done</th>
                        <th className="px-3 py-2 text-right font-semibold text-white text-[11px] uppercase tracking-wide">Remain</th>
                        <th className="px-3 py-2 text-center font-semibold text-white text-[11px] uppercase tracking-wide">Status</th>
                      </tr>
                    </thead>
                    <tbody>
                      {batchMvItems.length === 0 ? (
                        <tr><td colSpan={8} className="px-3 py-6 text-center text-gray-400">No items found</td></tr>
                      ) : batchMvItems.map((item, idx) => {
                        const exp  = item.quantity ?? 0;
                        const done = item.scannedQty ?? 0;
                        const remain = Math.max(0, exp - done);
                        const isExtraOnly = item._isExtra;
                        const isDone = done >= exp && exp > 0;
                        const isPartial = done > 0 && !isDone && !isExtraOnly;
                        const rowBg = isExtraOnly ? "bg-orange-50/40" : isDone ? "bg-emerald-50/40" : isPartial ? "bg-amber-50/30" : idx % 2 === 0 ? "bg-white" : "bg-slate-50";
                        return (
                          <tr key={idx} className={`${rowBg} border-b border-gray-100 hover:bg-slate-100/60`}>
                            <td className="px-3 py-2 text-center">
                              {isExtraOnly
                                ? <AlertTriangle className="h-4 w-4 text-orange-500 mx-auto" />
                                : isDone
                                ? <CheckCircle2 className="h-4 w-4 text-emerald-500 mx-auto" />
                                : isPartial
                                ? <ScanLine className="h-4 w-4 text-amber-500 mx-auto" />
                                : <span className="inline-block h-4 w-4 rounded-full border-2 border-gray-300" />}
                            </td>
                            <td className="px-3 py-2 font-medium text-gray-900 min-w-[200px]"><span className="block whitespace-normal break-words">{item.itemName ?? "—"}</span></td>
                            <td className="px-3 py-2 font-mono text-gray-500">{item.barcode ?? "—"}</td>
                            <td className="px-3 py-2 text-xs text-gray-400 max-w-[130px] truncate" title={item._files.join(", ")}>
                              {item._files.length > 1 ? `${item._files.length} files` : item._files[0]}
                            </td>
                            <td className="px-3 py-2 text-right text-gray-600 tabular-nums">{exp || "—"}</td>
                            <td className="px-3 py-2 text-right tabular-nums font-bold">
                              <span className={isExtraOnly ? "text-orange-700" : isDone ? "text-emerald-700" : isPartial ? "text-amber-700" : "text-gray-400"}>{done}</span>
                            </td>
                            <td className="px-3 py-2 text-right tabular-nums font-bold">
                              <span className={remain > 0 ? "text-red-600" : "text-gray-400"}>{remain}</span>
                            </td>
                            <td className="px-3 py-2 text-center">
                              <span className={`inline-flex rounded-full px-2 py-0.5 text-[11px] font-semibold ${isExtraOnly ? "bg-orange-100 text-orange-700" : isDone ? "bg-emerald-100 text-emerald-700" : isPartial ? "bg-amber-100 text-amber-700" : "bg-gray-100 text-gray-500"}`}>
                                {isExtraOnly ? "Extra" : isDone ? "Done" : isPartial ? "Partial" : "Pending"}
                              </span>
                            </td>
                          </tr>
                        );
                      })}
                    </tbody>
                  </table>
                </div>
              </div>

              {/* ── FIFO batch report — only for a FIFO Session upload, not the plain multi-file batch ── */}
              {batchResult?.groupId && (
                <div className="rounded-xl border border-purple-200 bg-white shadow-sm overflow-hidden">
                  <div className="flex items-center justify-between gap-2 px-4 py-3 border-b bg-purple-50/50 flex-wrap">
                    <h3 className="text-sm font-semibold text-purple-900 flex items-center gap-1.5">
                      <Layers className="h-4 w-4" /> FIFO Batch Report
                    </h3>
                    <div className="flex items-center gap-2">
                      {groupReportQuery.data?.consolidated.allComplete && (
                        <span className="inline-flex items-center gap-1 rounded-full bg-emerald-100 px-2 py-0.5 text-[11px] font-semibold text-emerald-700">
                          <CheckCircle2 className="h-3 w-3" /> All parts complete
                        </span>
                      )}
                      {groupReportQuery.data && (
                        <>
                          <Button size="sm" variant="outline" className="h-7 gap-1 px-2 text-[11px]"
                            onClick={() => downloadGroupPartCsv(groupReportQuery.data!)}>
                            <Download className="h-3 w-3" /> CSV-wise
                          </Button>
                          <Button size="sm" variant="outline" className="h-7 gap-1 px-2 text-[11px]"
                            onClick={() => downloadGroupFinalCsv(groupReportQuery.data!)}>
                            <Download className="h-3 w-3" /> Final
                          </Button>
                        </>
                      )}
                    </div>
                  </div>

                  {groupReportQuery.isLoading ? (
                    <div className="flex justify-center py-8"><Loader2 className="h-5 w-5 animate-spin text-purple-700" /></div>
                  ) : groupReportQuery.data ? (
                    <div className="p-4 space-y-4">
                      {/* Consolidated summary — running total until every part is complete */}
                      <div className="grid grid-cols-3 sm:grid-cols-6 gap-2">
                        {[
                          { label: "Expected", value: groupReportQuery.data.consolidated.totalExpected, cls: "text-gray-700" },
                          { label: "Received", value: groupReportQuery.data.consolidated.totalReceived, cls: "text-[#001d6e]" },
                          { label: "Extra", value: groupReportQuery.data.consolidated.totalExtra, cls: "text-amber-600" },
                          { label: "Missing", value: groupReportQuery.data.consolidated.totalMissing, cls: "text-red-600" },
                          { label: "Adjusted", value: groupReportQuery.data.consolidated.totalAdjustments, cls: "text-purple-600" },
                          { label: "Final Stock", value: groupReportQuery.data.consolidated.finalStockAdded, cls: "text-green-600" },
                        ].map((c) => (
                          <div key={c.label} className="rounded-md border bg-gray-50 px-2 py-2 text-center">
                            <p className={`text-lg font-bold ${c.cls}`}>{c.value}</p>
                            <p className="text-[10px] uppercase tracking-wide text-gray-500">{c.label}</p>
                          </div>
                        ))}
                      </div>
                      {(groupReportQuery.data.consolidated.netMissingAfterAdjustment > 0 || groupReportQuery.data.consolidated.netExtraAfterAdjustment > 0) && (
                        <p className="text-xs text-gray-500">
                          After cross-part adjustment: <strong className="text-red-600">{groupReportQuery.data.consolidated.netMissingAfterAdjustment}</strong> still missing,{" "}
                          <strong className="text-amber-600">{groupReportQuery.data.consolidated.netExtraAfterAdjustment}</strong> unmatched extra
                          {!groupReportQuery.data.consolidated.allComplete && " (may still resolve once remaining parts are scanned)"}.
                        </p>
                      )}

                      {/* Part-wise breakdown */}
                      <div className="overflow-x-auto rounded-md border">
                        <table className="w-max min-w-full border-collapse text-xs">
                          <thead>
                            <tr>
                              {["Part", "File", "Status", "Expected", "Received", "Extra", "Missing", "Adj. To Next", "Adj. From Prev", "Net Extra", "Net Missing", "Report"].map((h) => (
                                <th key={h} className="sticky top-0 whitespace-nowrap border-b border-r bg-slate-100 px-3 py-2 text-left font-semibold text-purple-900">{h}</th>
                              ))}
                            </tr>
                          </thead>
                          <tbody>
                            {groupReportQuery.data.parts.map((p) => (
                              <tr key={p.id} className="border-b hover:bg-gray-50">
                                <td className="border-r px-3 py-1.5 font-semibold">{p.partIndex}</td>
                                <td className="max-w-[160px] truncate border-r px-3 py-1.5" title={p.csvFileName}>{p.csvFileName}</td>
                                <td className="border-r px-3 py-1.5 capitalize">{p.scanStatus}</td>
                                <td className="border-r px-3 py-1.5 text-right">{p.summary.totalExpected}</td>
                                <td className="border-r px-3 py-1.5 text-right">{p.summary.totalReceived}</td>
                                <td className="border-r px-3 py-1.5 text-right text-amber-600">{p.summary.totalExtra}</td>
                                <td className="border-r px-3 py-1.5 text-right text-red-600">{p.summary.totalMissing}</td>
                                <td className="border-r px-3 py-1.5 text-right text-purple-600">{p.summary.totalAdjustedTo}</td>
                                <td className="border-r px-3 py-1.5 text-right text-purple-600">{p.summary.totalAdjustedFrom}</td>
                                <td className="border-r px-3 py-1.5 text-right font-semibold">{p.summary.netExtraAfterAdjustment}</td>
                                <td className="border-r px-3 py-1.5 text-right font-semibold">{p.summary.netMissingAfterAdjustment}</td>
                                <td className="px-3 py-1.5 text-center">
                                  <button
                                    className="inline-flex items-center gap-1 rounded border border-gray-200 px-1.5 py-0.5 text-[11px] text-gray-600 hover:bg-gray-50"
                                    title={`Download report for ${p.csvFileName}`}
                                    onClick={() => downloadPartReport(p.id, p.csvFileName)}>
                                    <Download className="h-3 w-3" /> CSV
                                  </button>
                                </td>
                              </tr>
                            ))}
                          </tbody>
                        </table>
                      </div>

                      {/* Adjustment detail — only barcodes with an actual cross-part adjustment */}
                      {groupReportQuery.data.parts.some((p) => p.items.some((i) => i.adjustedTo.length > 0)) && (
                        <div>
                          <p className="mb-1.5 text-xs font-semibold uppercase tracking-wide text-gray-500">Adjustment Detail</p>
                          <div className="space-y-1.5 text-xs">
                            {groupReportQuery.data.parts.flatMap((p) =>
                              p.items.flatMap((i) =>
                                i.adjustedTo.map((a, idx) => (
                                  <div key={`${p.id}-${i.barcode}-${idx}`} className="rounded border border-purple-100 bg-purple-50 px-3 py-1.5 text-purple-800">
                                    <span className="font-mono">{i.barcode}</span> ({i.itemName}) — <strong>{a.qty}</strong> extra from Part {p.partIndex} ({p.csvFileName}) covers Part {groupReportQuery.data!.parts.find((x) => x.id === a.toPartId)?.partIndex ?? "?"} ({a.toCsvFileName})
                                  </div>
                                )),
                              ),
                            )}
                          </div>
                        </div>
                      )}
                    </div>
                  ) : (
                    <p className="py-6 text-center text-sm text-gray-400">No report data yet.</p>
                  )}
                </div>
              )}
            </div>
          )}

          <DialogFooter className="mt-2">
            <Button variant="outline" onClick={() => setShowBatchMasterView(false)}>Close</Button>
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
