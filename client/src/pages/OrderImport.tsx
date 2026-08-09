import { useEffect, useRef, useState } from "react";
import { useLocation } from "wouter";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import Papa from "papaparse";
import { getCurrentUserPermissions, hasPageWriteAccess, hasPageViewAccess } from "../lib/permissions";
import {
  AlertCircle,
  CheckCircle,
  CheckCircle2,
  ChevronDown,
  ChevronRight,
  FileBarChart,
  FileUp,
  History,
  Loader2,
  MoreVertical,
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
import EditCsvDialog from "@/components/modals/EditCsvDialog";
import ReportsDialog, { type ReportsDialogSession } from "@/components/modals/ReportsDialog";
import { PlantBadge } from "@/components/PlantBadge";
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
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
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
  // The date this CSV was uploaded FOR (chosen at upload) — distinct from createdAt (when it
  // was uploaded). All date filters/labels on this page use orderDate.
  orderDate: string | null;
  scanActivatedByName: string | null; scanActivatedAt: string | null; scanCompletedAt: string | null;
  scanActivatedByCode:string | null;
  // FIFO batch membership — already returned by /api/order-scan/sessions, just wasn't typed
  // here until Reports needed to know whether to offer group-level (Final/CSV-wise) reports.
  receivingSessionId: number | null; partIndex: number | null;
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
  let allowedPagesList: string[] = [];
  try { allowedPagesList = JSON.parse((user as any)?.allowedPages || "[]"); } catch { allowedPagesList = []; }
  // Write access (below) implies read access, so it's included here too.
  const isImportRole = ["admin", "super-admin"].includes(role)
    || department === "billing"
    || userPermissions.canAccessOrderManagement
    || allowedPagesList.includes("order-import")
    || hasPageWriteAccess("order-import");
  // Separate from page VISIBILITY (isImportRole above) — this controls whether the
  // currently-visible page's own write actions (Upload, Map & Import, Delete) are enabled.
  // Admin/super-admin/billing always have write access (unchanged); anyone else needs
  // admin to have explicitly granted "Order Import" in their Write Access on the
  // User Management page.
  const canWriteOrderImport = ["admin", "super-admin"].includes(role)
    || department === "billing"
    || hasPageWriteAccess("order-import");
  // Deleting a CSV (with stock/scan rollback) is stricter than general Order Import write
  // access — the server's DELETE/delete-preview routes require this exact admin/super-admin/
  // billing set (requireAdmin in server/routes/order-import.ts), NOT hasPageWriteAccess, so a
  // user only granted "Order Import" write access must not see an enabled delete button that
  // would just 403.
  const canDeleteOrderImport =canWriteOrderImport;
  // The Edit (pencil) button on Available/Active rows is gated by its OWN page key —
  // "order-import-edit" — independent of Order Import's own access above, exactly as it was
  // when this lived on its own page. hasPageViewAccess just controls whether the button is
  // shown at all; EditCsvDialog itself further disables its inputs unless hasPageWriteAccess.
  const canViewCsvEdit = hasPageViewAccess("order-import-edit");

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
  const [deletePreview, setDeletePreview] = useState<{
    scannedItemCount: number; scannedQtyTotal: number; extraQtyTotal: number; stockApplied: boolean;
  } | null>(null);
  // Plant/Order Date of the session being deleted — captured when the delete dialog opens
  // (from the row itself), so that if the admin picks "Delete, I'll re-upload" we can
  // pre-fill the Upload form with the SAME plant/date and jump straight into the mapping
  // dialog for the corrected file, instead of leaving them to scroll up and re-enter it.
  const [deleteTargetInfo, setDeleteTargetInfo] = useState<{ plant: string; orderDate: string } | null>(null);
  // Set right before programmatically opening the file picker after a "Delete, I'll re-upload".
  // handleFileChange checks this to skip straight to the mapping dialog for the chosen file,
  // instead of waiting for a separate "Map & Import" click.
  const reuploadPendingRef = useRef(false);
  const [deactivateTarget, setDeactivateTarget] = useState<number | null>(null);
  const [completeTarget, setCompleteTarget] = useState<number | null>(null);
  const [lastImport, setLastImport] = useState<{ rowCount: number } | null>(null);
  // Session id whose "Edit CSV" dialog is open — set from the Edit button on an Available/
  // Active row, cleared when the dialog closes.
  const [editSessionId, setEditSessionId] = useState<number | null>(null);
  // Reports live entirely inside Order Management now — no separate /order-reports page.
  // Opens the Reports dialog right here so an operator mid-upload/scan-review never leaves
  // this page just to check a report.
  const [reportsSession, setReportsSession] = useState<ReportsDialogSession | null>(null);
  const openReports = (s: { id: number; csvFileName: string; plant: string; receivingSessionId?: number | null; partIndex?: number | null }) => {
    setReportsSession({
      id: s.id, csvFileName: s.csvFileName, plant: s.plant,
      receivingSessionId: s.receivingSessionId, partIndex: s.partIndex,
    });
  };

  // Date filter for the History tab (default empty = show all, avoids UTC/IST mismatch). No
  // pagination — every matching session loads in one request (server still caps the request at
  // a generous ceiling; see HISTORY_PAGE_SIZE below).
  const todayStr = getLocalISODate();
  const HISTORY_PAGE_SIZE = 2000;
  const [currentPage, setCurrentPage] = useState(1);
  const [filterDate, setFilterDate] = useState("");
  const [filterPlant, setFilterPlant] = useState("");
  // Plant tab row under the status tabs. "" = All. Tabs are derived from the sessions actually
  // present in the current status tab, so they appear and disappear with the data.
  const [plantTab, setPlantTab] = useState("");

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
    sessions: (OrderImportSession & { importedByName: string | null; scanStatus: string; orderDate: string | null })[];
    total: number;
    page: number;
    pageSize: number;
    totalPages: number;
  };

  const sessionsQuery = useQuery<SessionsResponse>({
    queryKey: ["/api/order-import/sessions", "history", filterDate, filterPlant],
    queryFn: async ({ signal }) => {
      const params = new URLSearchParams({
        page: "1",
        pageSize: String(HISTORY_PAGE_SIZE),
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
    // Keep showing the last-known list while a poll/refresh is in flight — without this, some
    // refetch paths can briefly report no data, which flashes the "Loading…" state instead of
    // quietly updating the numbers once the new data arrives.
    placeholderData: (previousData) => previousData,
  });

  // Warns before a brand-new order gets a past Order Date (the server only accepts a past
  // date when it's a late part joining/reclaiming an existing group for that exact
  // plant+date — never for a genuinely new one). Only runs once both fields are filled and
  // the date is actually in the past, so it never fires for the normal today-or-later case.
  const isPastOrderDate = !!orderDate && orderDate < todayStr;
  const pastDateCheckQuery = useQuery<{ exists: boolean }>({
    queryKey: ["/api/order-import/sessions/date-check", plant, orderDate],
    queryFn: async () =>
      (await apiRequest("GET", `/api/order-import/sessions/date-check?plant=${encodeURIComponent(plant)}&date=${orderDate}`)).json(),
    enabled: isPastOrderDate && !!plant.trim(),
  });
  const isPastDateBlocked = isPastOrderDate && !!plant.trim() && pastDateCheckQuery.data?.exists === false;

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

  const plantsQuery = useQuery<{ name: string; bgColor?: string; textColor?: string; borderColor?: string }[]>({
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
    // Same as sessionsQuery above — keeps Available/Active/Completed showing their last-known
    // rows through every background poll instead of flashing a loading state.
    placeholderData: (previousData) => previousData,
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
    placeholderData: (previousData) => previousData,
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

        // Seed the no-filter History key so the list renders instantly even if the user had a
        // filter applied before uploading.
        const p1Key = ["/api/order-import/sessions", "history", "", ""] as const;
        const p1 = qc.getQueryData<SessionsResponse>(p1Key);
        qc.setQueryData<SessionsResponse>(p1Key, p1
          ? { ...p1, sessions: [newRow, ...p1.sessions], total: p1.total + 1, totalPages: 1 }
          : { sessions: [newRow], total: 1, page: 1, pageSize: HISTORY_PAGE_SIZE, totalPages: 1 },
        );

        qc.setQueryData<ScanSession[]>(["/api/order-scan/sessions"], (old) =>
          old ? [{ id: data.session.id, plant: data.session.plant, csvFileName: data.session.csvFileName, rowCount: data.rowCount, scanStatus: data.session.scanStatus ?? "available", importedByName: (user as any)?.name ?? null, createdAt: data.session.createdAt ?? new Date().toISOString(), orderDate: data.session.orderDate ?? orderDate ?? null, scanActivatedByName: null, scanActivatedAt: null, scanCompletedAt: null, scanActivatedByCode: null, receivingSessionId: data.session.receivingSessionId ?? null, partIndex: data.session.partIndex ?? null }, ...old] : [],
        );
      }

      if (data.replacesSessionId) {
        const carried = data.remapSummary?.itemsCarriedForward ?? 0;
        toast({
          title: "Linked as replacement",
          description: carried > 0
            ? `${carried} previously scanned item(s) were carried forward from the deleted CSV.`
            : `Replaces the deleted CSV for this plant/date — no prior scans to carry forward.`,
          className: "bg-green-50 border-green-200 text-green-900",
        });
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

  // Fetches the scanned-item/stock counts shown in the delete confirmation dialog, so the
  // admin knows how much will be reversed before confirming. Falls back to opening the
  // dialog with generic copy if the preview call itself fails.
  const deletePreviewMutation = useMutation({
    mutationFn: async (id: number) =>
      (await apiRequest("GET", `/api/order-import/sessions/${id}/delete-preview`)).json(),
    onSuccess: (data, id) => {
      setDeletePreview(data);
      setDeleteTarget(id);
    },
    onError: (_err: any, id) => {
      setDeletePreview(null);
      setDeleteTarget(id);
    },
  });

  const deleteMutation = useMutation({
    mutationFn: async ({ id, mode }: { id: number; mode: "replace" | "discard" }) =>
      (await apiRequest("DELETE", `/api/order-import/sessions/${id}?mode=${mode}`)).json(),
    onMutate: async ({ id }: { id: number; mode: "replace" | "discard" }) => {
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
      setDeletePreview(null);
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
    onSuccess: (data) => {
      if (!(data?.scannedItemCount > 0)) return;
      if (data.mode === "discard") {
        toast({
          title: "CSV removed",
          description: `${data.scannedItemCount} scanned item(s) reverted${data.stockReversed?.length ? " and stock rolled back" : ""}. Your next upload for this plant/date will be treated as a new file.`,
        });
      } else {
        toast({
          title: "CSV deleted",
          description: `${data.scannedItemCount} scanned item(s) held. Upload the corrected CSV for this plant/date and these scans will be carried forward automatically.`,
        });
      }
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

    // Reupload flow: plant/orderDate were already filled in when the file picker was popped
    // open, so skip the separate "Map & Import" click and go straight to the mapping dialog.
    if (reuploadPendingRef.current) {
      reuploadPendingRef.current = false;
      uploadQueueRef.current = files;
      uploadIdxRef.current = 0;
      uploadCollectedRef.current = { sessionIds: [], fileNames: [], failed: [], totalRows: 0, groupId: null };
      setUploadProgress({ current: 1, total: files.length });
      parseAndOpen(files[0]);
    }
  }

  // Start the sequential Map & Import queue: opens the mapping dialog for the first file;
  // each confirm imports that file and advances to the next file's mapping dialog.
  function handleImportClick() {
    if (!plant.trim()) {
      toast({ title: "Select a plant first", variant: "destructive" });
      return;
    }
    // Order Date drives FIFO grouping (plant + orderDate) and now Master View's scoping too,
    // so an import without one can't be placed in a group at all — require it up front.
    if (!orderDate.trim()) {
      toast({ title: "Select an Order Date first", description: "The Order Date decides which CSVs merge together as parts of one order.", variant: "destructive" });
      return;
    }
    if (selectedFiles.length === 0) {
      toast({ title: "Select a CSV file first", variant: "destructive" });
      return;
    }
    if (isPastDateBlocked) {
      toast({
        title: "This Order Date is in the past",
        description: `No existing order for ${plant} on ${orderDate} — a brand-new order can't use a past date. Pick today or later, or the correct existing date for a late part.`,
        variant: "destructive",
      });
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
  // History is server-paged and its total reflects whatever plant filter is applied, so remember
  // the unfiltered figure and show that on the tab badge — matching the other three, which ignore
  // the plant row too.
  const [historyTotalAll, setHistoryTotalAll] = useState(0);
  useEffect(() => {
    if (!filterPlant) setHistoryTotalAll(totalSessions);
  }, [filterPlant, totalSessions]);
  const allItems = itemsQuery.data ?? [];
  const filteredItems = itemSearch
    ? allItems.filter((i) =>
        [i.barcode, i.itemName, i.sapCode].some((v) =>
          v?.toLowerCase().includes(itemSearch.toLowerCase())
        )
      )
    : allItems;

  const plantOptions = (plantsQuery.data ?? []).filter((p) => p.name && p.name.trim() !== "");
  // Plant colors from Plant Management, keyed by upper-cased name, for the plant tab pills.
  const plantColorByName = new Map(plantOptions.map((p) => [p.name.toUpperCase(), p]));

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
  // Date filters match the ORDER DATE (what the CSV is FOR), not createdAt (when it was
  // uploaded) — those diverge whenever a late part is added to an earlier order, and the
  // order date is what users think in. Same value FIFO grouping and Master View key on.
  const availableScanSessions = _allScanSessions.filter(s =>
    s.scanStatus === "available" &&
    (!scanPlant    || (s.plant ?? "").toLowerCase() === scanPlant.toLowerCase()) &&
    (!plantTab     || (s.plant ?? "").toLowerCase() === plantTab.toLowerCase()) &&
    (!scanDate     || (s.orderDate ?? "").slice(0, 10) === scanDate)
  );
  const activeScanSessions = _allScanSessions.filter(s =>
    s.scanStatus === "active" &&
    (!activePlant  || (s.plant ?? "").toLowerCase() === activePlant.toLowerCase()) &&
    (!plantTab     || (s.plant ?? "").toLowerCase() === plantTab.toLowerCase()) &&
    (!activeDate   || (s.orderDate ?? "").slice(0, 10) === activeDate)
  );
  const completedScanSessions = _allScanSessions.filter(s =>
    s.scanStatus === "completed" &&
    (!completedPlant || (s.plant ?? "").toLowerCase() === completedPlant.toLowerCase()) &&
    (!plantTab       || (s.plant ?? "").toLowerCase() === plantTab.toLowerCase()) &&
    (!completedDate  || (s.orderDate ?? "").slice(0, 10) === completedDate)
  );
  // Tab badge counts deliberately ignore the plant row, so each status always advertises its full
  // total. Without this, picking a plant on one tab silently shrinks every other tab's count and
  // you lose sight of what's waiting elsewhere. The per-tab date filters still apply.
  const countByStatus = (status: string, date: string) =>
    _allScanSessions.filter((s) =>
      s.scanStatus === status && (!date || (s.orderDate ?? "").slice(0, 10) === date),
    ).length;
  const availableCount = countByStatus("available", scanDate);
  const activeCount    = countByStatus("active", activeDate);
  const completedCount = countByStatus("completed", completedDate);

  const activeId = activeSessionQuery.data?.id ?? null;

  const [activeTab, setActiveTab] = useState<"available" | "active" | "completed" | "history">("available");

  // Plant tabs come from the sessions in the current status tab (ignoring the plant selection
  // itself, so picking a plant never empties the row). History pages server-side, so it falls back
  // to every known session. A plant appears only once it actually has sessions.
  const plantTabSource = _allScanSessions.filter((s) =>
    activeTab === "history" ? true : s.scanStatus === activeTab,
  );
  const plantTabs = Array.from(
    // Show EVERY configured plant as a tab (from Plant Management), not only ones that happen to
    // have sessions in this status — plus any plant seen on a session or currently selected, to be
    // safe against a session whose plant was later removed from the list.
    new Set(
      [
        ...plantOptions.map((p) => p.name.trim()),
        ...plantTabSource.map((s) => (s.plant ?? "").trim()),
        plantTab.trim(),
      ].filter(Boolean),
    ),
  ).sort((a, b) => a.localeCompare(b));

  // Switching status tabs always resets the plant row back to All, so each tab opens showing
  // everything rather than inheriting a plant picked on a previous tab.
  const selectStatusTab = (key: "available" | "active" | "completed" | "history") => {
    setActiveTab(key);
    setPlantTab("");
    setFilterPlant("");
    setCurrentPage(1);
  };

  // Setting filterPlant too keeps the server-paged History query — and therefore the History tab's
  // count — on the same plant as the client-side tabs, so every status count reflects the
  // selected plant rather than only the tab you happen to be looking at.
  const selectPlantTab = (name: string) => {
    setPlantTab(name);
    setFilterPlant(name);
    setCurrentPage(1);
  };

  return (
    <main className="flex-1 overflow-y-auto bg-gray-50">
      <div className="mx-auto max-w-5xl px-4 py-6 space-y-6">

        {/* ── Page Header ── */}
        <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
          <div className="flex items-center gap-3">
            <div className="flex h-12 w-12 shrink-0 items-center justify-center rounded-xl bg-[#001d6e] text-white shadow-sm">
              <FileUp className="h-6 w-6" />
            </div>
            <div>
              <h1 className="text-2xl font-bold text-[#001d6e]">Order Import</h1>
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
              className="inline-flex items-center gap-1.5 border border-gray-200 bg-white px-3 py-1.5 text-sm font-medium text-gray-700 hover:bg-gray-50 disabled:opacity-50"
              onClick={() => sessionsQuery.refetch()}
              disabled={sessionsQuery.isFetching}
            >
              <RefreshCw className={`h-4 w-4 ${sessionsQuery.isFetching ? "animate-spin" : ""}`} />
              Refresh
            </button>
          </div>
        </div>

        {/* ── Upload Card ── */}
        <div className="border border-gray-200 bg-white shadow-sm">
          <div className="flex items-center gap-2 border-b border-gray-100 px-6 py-4">
            <Upload className="h-5 w-5 text-[#001d6e]" />
            <h2 className="text-base font-semibold text-gray-900">Upload CSV</h2>
          </div>
          <div className="p-6 space-y-4">
            {/* Desktop layout — a fixed 12-col grid instead of flex-wrap with ad-hoc min-widths,
                so the fields always line up the same way regardless of content length. */}
            <div className="hidden sm:grid sm:grid-cols-12 sm:items-end sm:gap-4">
              {/* Plant */}
              <div className="col-span-3 grid gap-1.5">
                <Label className="text-xs font-medium text-gray-600">Plant</Label>
                {plantOptions.length > 0 ? (
                  <Select value={plant || "_none_"} onValueChange={(v) => setPlant(v === "_none_" ? "" : v)}>
                    <SelectTrigger className="h-10 text-sm rounded-full"><SelectValue placeholder="Select…" /></SelectTrigger>
                    <SelectContent>
                      <SelectItem value="_none_">— Select —</SelectItem>
                      {plantOptions.map((p) => <SelectItem key={p.name} value={p.name}>{p.name}</SelectItem>)}
                    </SelectContent>
                  </Select>
                ) : (
                  <Input className="h-10 text-sm rounded-full" value={plant} onChange={(e) => setPlant(e.target.value)} placeholder="Plant…" />
                )}
              </div>
              {/* Date */}
              <div className="col-span-2 grid gap-1.5">
                <Label className="text-xs font-medium text-gray-600">Order Date</Label>
                {/* min=today: a normal upload here is always a new file for today (or later).
                    The one legitimate past-date case — replacing a deleted CSV for an order
                    that already exists — goes through "Delete, I'll re-upload" instead, which
                    sets orderDate via state and so isn't affected by this min. The
                    pastDateCheckQuery/isPastDateBlocked warning below stays as a second line of
                    defense against a manually typed-in past date slipping past the picker. */}
                <Input type="date" min={todayStr} className={`h-10 text-sm w-full rounded-full ${isPastDateBlocked ? "border-red-400" : ""}`} value={orderDate} onChange={(e) => setOrderDate(e.target.value)} />
                {isPastDateBlocked && (
                  <p className="text-[11px] leading-snug text-red-600">No existing order for this plant/date — pick today or later.</p>
                )}
              </div>
              {/* File */}
              <div className="col-span-4 grid gap-1.5">
                <Label className="text-xs font-medium text-gray-600 truncate">
                  CSV File{selectedFiles.length === 1 && <span className="text-green-600 font-medium"> · {selectedFiles[0].name}</span>}
                  {selectedFiles.length > 1 && <span className="text-green-600 font-medium"> · {selectedFiles.length} files selected</span>}
                </Label>
                <Input ref={fileRef} type="file" accept=".csv" multiple className="h-10 text-sm rounded-full"
                  onChange={handleFileChange} disabled={importMutation.isPending || isBatchImporting} />
              </div>
              {/* Actions */}
              <div className="col-span-3 flex gap-2">
                <Button variant="outline" className="h-10 shrink-0 rounded-full" onClick={clearForm}
                  disabled={selectedFiles.length === 0 || importMutation.isPending || isBatchImporting}>
                  <X className="h-4 w-4" />
                </Button>
                <Button className="h-10 flex-1 bg-[#001d6e] hover:bg-[#00154b] text-white rounded-full" onClick={handleImportClick}
                  disabled={selectedFiles.length === 0 || !plant.trim() || importMutation.isPending || isBatchImporting || !canWriteOrderImport || isPastDateBlocked}
                  title={!canWriteOrderImport ? "You have read-only access to Order Import" : isPastDateBlocked ? "No existing order for this plant/date — pick today or later" : undefined}>
                  {(importMutation.isPending || isBatchImporting) ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : <Upload className="mr-2 h-4 w-4" />}
                  {selectedFiles.length > 1 ? `Import ${selectedFiles.length} Files` : "Map & Import"}
                </Button>
              </div>
            </div>

            {/* Mobile layout */}
            <div className="sm:hidden space-y-4">
              <div className="grid gap-1.5">
                <Label className="text-xs font-medium text-gray-600">
                  CSV File{selectedFiles.length === 1 && <span className="text-green-600 font-medium"> · {selectedFiles[0].name}</span>}
                  {selectedFiles.length > 1 && <span className="text-green-600 font-medium"> · {selectedFiles.length} files selected</span>}
                </Label>
                <Input ref={fileRef} type="file" accept=".csv" multiple
                  className="h-11 text-sm file:mr-3 file:py-1 file:px-3 file:border-0 file:text-xs file:font-medium file:bg-[#001d6e]/10 file:text-[#001d6e] rounded-full"
                  onChange={handleFileChange} disabled={importMutation.isPending || isBatchImporting} />
              </div>
              {/* Plant + Date on one row — Date gets a fixed minimum wide enough for the native
                  picker to render its value (it clips/hides below ~140px), Plant absorbs
                  whatever width remains instead of splitting evenly. */}
              <div className="grid grid-cols-[1fr_142px] gap-3">
                <div className="grid gap-1.5">
                  <Label className="text-xs font-medium text-gray-600">Plant</Label>
                  {plantOptions.length > 0 ? (
                    <Select value={plant || "_none_"} onValueChange={(v) => setPlant(v === "_none_" ? "" : v)}>
                      <SelectTrigger className="h-11 text-sm rounded-full"><SelectValue placeholder="Select…" /></SelectTrigger>
                      <SelectContent>
                        <SelectItem value="_none_">— Select —</SelectItem>
                        {plantOptions.map((p) => <SelectItem key={p.name} value={p.name}>{p.name}</SelectItem>)}
                      </SelectContent>
                    </Select>
                  ) : (
                    <Input className="h-11 text-sm rounded-full" value={plant} onChange={(e) => setPlant(e.target.value)} placeholder="Plant…" />
                  )}
                </div>
                <div className="grid gap-1.5">
                  <Label className="text-xs font-medium text-gray-600">Order Date</Label>
                  <Input type="date" min={todayStr} className={`h-11 w-full text-sm px-2 rounded-full ${isPastDateBlocked ? "border-red-400" : ""}`} value={orderDate} onChange={(e) => setOrderDate(e.target.value)} />
                </div>
                {isPastDateBlocked && (
                  <p className="col-span-2 text-[11px] leading-snug text-red-600">No existing order for this plant/date — pick today or later.</p>
                )}
              </div>
              <div className="flex gap-2">
                <Button variant="outline" className="h-11 px-3.5 shrink-0 rounded-full" onClick={clearForm}
                  disabled={selectedFiles.length === 0 || importMutation.isPending || isBatchImporting}>
                  <X className="h-4 w-4" />
                </Button>
                <Button className="h-11 flex-1 bg-[#001d6e] hover:bg-[#00154b] text-white rounded-full" onClick={handleImportClick}
                  disabled={selectedFiles.length === 0 || !plant.trim() || importMutation.isPending || isBatchImporting || !canWriteOrderImport || isPastDateBlocked}
                  title={!canWriteOrderImport ? "You have read-only access to Order Import" : isPastDateBlocked ? "No existing order for this plant/date — pick today or later" : undefined}>
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
        <div className="border border-gray-200 bg-white shadow-sm">
          {/* Tab pills header */}
          <div className="border-b border-gray-100 px-5 py-4">
            <div className="flex gap-1 flex-wrap">
              {(
                [
                  { key: "available", label: "Available", count: availableCount },
                  { key: "active",    label: "Active",    count: activeCount },
                  { key: "completed", label: "Completed", count: completedCount },
                  { key: "history",   label: "History",   count: filterPlant ? historyTotalAll : totalSessions },
                ] as { key: "available" | "active" | "completed" | "history"; label: string; count: number }[]
              ).map((tab) => (
                <button
                  key={tab.key}
                  onClick={() => selectStatusTab(tab.key)}
                  className={
                    activeTab === tab.key
                      ? "rounded-full bg-[#001d6e] text-white px-4 py-1.5 text-sm font-medium"
                      : "rounded-full bg-white border border-gray-200 text-gray-600 px-4 py-1.5 text-sm font-medium hover:bg-gray-50"
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

            {/* Plant tabs — built from the sessions present in the tab above, so they track the
                data rather than a hard-coded list. Shown on all four status tabs. */}
            {plantTabs.length > 0 && (
              <div className="mt-3 flex flex-wrap items-center gap-1.5 border-t border-gray-100 pt-3">
                <span className="mr-1 text-[11px] font-semibold uppercase tracking-wide text-gray-400">
                  Plant
                </span>
                <button
                  onClick={() => selectPlantTab("")}
                  className={
                    plantTab === ""
                      ? "rounded-full bg-[#001d6e] px-3 py-1 text-xs font-medium text-white"
                      : "rounded-full border border-gray-200 bg-white px-3 py-1 text-xs font-medium text-gray-600 hover:bg-gray-50"
                  }
                >
                  All
                </button>
                {plantTabs.map((name) => {
                  const isSel = plantTab.toLowerCase() === name.toLowerCase();
                  const c = plantColorByName.get(name.toUpperCase());
                  return (
                    <button
                      key={name}
                      onClick={() => selectPlantTab(name)}
                      // Selected: solid navy. Unselected: tinted with the plant's configured colors
                      // from Plant Management (falls back to a plain grey pill when uncolored).
                      style={!isSel && c?.bgColor ? { backgroundColor: c.bgColor, color: c.textColor, borderColor: c.borderColor } : undefined}
                      className={
                        isSel
                          ? "rounded-full bg-[#001d6e] px-3 py-1 text-xs font-medium text-white"
                          : c?.bgColor
                            ? "rounded-full border px-3 py-1 text-xs font-semibold"
                            : "rounded-full border border-gray-200 bg-white px-3 py-1 text-xs font-medium text-gray-600 hover:bg-gray-50"
                      }
                    >
                      {name}
                    </button>
                  );
                })}
              </div>
            )}
          </div>

          {/* ── Tab: Available ── */}
          {activeTab === "available" && (
            <div>
              {/* Filters */}
              <div className="flex flex-wrap items-center gap-2 px-5 py-3 border-b border-gray-50">
                <Input type="date" value={scanDate} onChange={(e) => { setScanDate(e.target.value); setScanExpandedId(null); }}
                  className="h-8 w-[140px] text-xs rounded-full" />
                {scanDate !== todayStr && (
                  <Button size="sm" variant="ghost" className="h-8 px-2 text-xs text-gray-500 hover:text-[#001d6e] rounded-full"
                    onClick={() => { setScanDate(todayStr); setScanExpandedId(null); }}>
                    Today
                  </Button>
                )}
                {scanDate && (
                  <Button size="sm" variant="ghost" className="h-8 w-8 p-0 text-gray-400 hover:text-red-500 rounded-full"
                    onClick={() => { setScanDate(""); setScanExpandedId(null); }}>
                    <X className="h-3.5 w-3.5" />
                  </Button>
                )}
                <Button size="sm" variant="outline" className="h-8 w-8 p-0 ml-auto rounded-full"
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
                                <PlantBadge plant={s.plant} />
                                {/* The date this CSV is FOR — what grouping/filters key on. Shown
                                    ahead of the upload timestamp since it's the meaningful one. */}
                                {s.orderDate && (
                                  <span className="bg-emerald-50 px-1.5 py-0.5 text-[10px] font-semibold text-emerald-700" title="Order Date — the date this CSV was uploaded for">
                                    For {s.orderDate}
                                  </span>
                                )}
                                <span className="text-xs text-gray-400" title="Uploaded at">{fmtIST(s.createdAt)}</span>
                                {s.importedByName && <span className="text-xs text-gray-400">· {s.importedByName}</span>}
                                {plantBusy && (
                                  <span className="bg-amber-50 px-1.5 py-0.5 text-[10px] font-semibold text-amber-700" title="Another session is already active for this plant">
                                    Plant busy
                                  </span>
                                )}
                              </div>
                            </div>
                            <div className="flex shrink-0 items-center gap-1.5">
                              <span className="inline-flex items-center bg-[#001d6e]/10 px-2 py-0.5 text-xs font-semibold text-[#001d6e]">
                                {s.rowCount}
                              </span>
                              <Button size="sm"
                                className="h-7 px-2 text-xs bg-[#001d6e] hover:bg-[#00154b] text-white disabled:opacity-50 rounded-full"
                                disabled={loadForScanMutation.isPending || plantBusy}
                                title={plantBusy ? `Another session is already active for ${s.plant} — complete or deactivate it first` : undefined}
                                onClick={(e) => { e.stopPropagation(); if (!plantBusy) loadForScanMutation.mutate(s.id); }}>
                                {loadForScanMutation.isPending
                                  ? <Loader2 className="h-3 w-3 animate-spin mr-1" />
                                  : <ScanLine className="h-3 w-3 mr-1" />}
                                Load
                              </Button>
                              {canViewCsvEdit && (
                                <Button size="sm" variant="ghost"
                                  className="h-7 w-7 p-0 text-gray-400 hover:text-[#001d6e] rounded-full"
                                  title="Edit CSV"
                                  onClick={(e) => { e.stopPropagation(); setEditSessionId(s.id); }}>
                                  <Pencil className="h-3.5 w-3.5" />
                                </Button>
                              )}
                              <Button size="sm" variant="ghost"
                                className="h-7 w-7 p-0 text-gray-400 hover:text-red-600 disabled:opacity-30 rounded-full"
                                disabled={!canDeleteOrderImport || deletePreviewMutation.isPending}
                                title={!canDeleteOrderImport ? "Deleting a CSV is restricted to Admin" : undefined}
                                onClick={(e) => { e.stopPropagation(); setDeleteTargetInfo({ plant: s.plant, orderDate: s.orderDate || todayStr }); deletePreviewMutation.mutate(s.id); }}>
                                {deletePreviewMutation.isPending && deletePreviewMutation.variables === s.id
                                  ? <Loader2 className="h-3.5 w-3.5 animate-spin" />
                                  : <Trash2 className="h-3.5 w-3.5" />}
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
                                  placeholder="Search rows…" className="pl-8 h-9 text-sm rounded-full" />
                              </div>
                              {scanItemSearch && (
                                <Button size="sm" variant="ghost" className="h-9 w-9 p-0 rounded-full"
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
                              <div className="overflow-x-auto border">
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
                    <div key={s.id} className="bg-amber-50 border border-amber-200 p-4 mx-4 my-3">
                      <div className="flex items-center gap-3">
                        <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-full bg-amber-100 border border-amber-200">
                          <ScanLine className="h-5 w-5 text-amber-600" />
                        </div>
                        <div className="flex-1 min-w-0">
                          <p className="truncate text-sm font-bold text-gray-900">{stripCsvExt(s.csvFileName)}</p>
                          <div className="mt-0.5 flex flex-wrap items-center gap-x-1.5 gap-y-0.5">
                            <PlantBadge plant={s.plant} />
                            {s.orderDate && (
                              <span className="bg-emerald-50 px-1.5 py-0.5 text-[10px] font-semibold text-emerald-700" title="Order Date — the date this CSV was uploaded for">
                                For {s.orderDate}
                              </span>
                            )}
                            <span className="text-xs text-gray-500">{s.rowCount} rows</span>
                            {s.importedByName && <span className="text-xs text-gray-500">· {s.importedByName}</span>}
                          </div>
                          {s.scanActivatedByName && (
                            <p className="mt-1 text-xs text-amber-700 font-medium truncate">
                              Scanning by: {s.scanActivatedByName}
                              {s.scanActivatedAt && <span className="font-normal text-gray-400"> · since {fmtIST(s.scanActivatedAt)}</span>}
                            </p>
                          )}
                        </div>
                        {/* One primary action + a kebab menu for the rest — same on mobile and
                            desktop, avoids the old 4-button pileup that wrapped unevenly. */}
                        <div className="flex shrink-0 items-center gap-1.5">
                          <Button size="sm" className="h-8 px-2.5 text-xs bg-amber-600 hover:bg-amber-700 text-white rounded-full"
                            onClick={() => navigate("/scan")}>
                            <ScanLine className="sm:mr-1.5 h-3.5 w-3.5" /> <span className="hidden sm:inline">View Scan</span>
                          </Button>
                          <DropdownMenu>
                            <DropdownMenuTrigger asChild>
                              <Button size="sm" variant="outline" className="h-8 w-8 p-0 text-gray-500 border-amber-200 hover:bg-amber-100 rounded-full">
                                <MoreVertical className="h-4 w-4" />
                              </Button>
                            </DropdownMenuTrigger>
                            <DropdownMenuContent align="end" className="w-44 rounded-xl">
                              {canViewCsvEdit && (
                                <DropdownMenuItem onClick={() => setEditSessionId(s.id)}>
                                  <Pencil className="mr-2 h-3.5 w-3.5 text-gray-500" /> Edit CSV
                                </DropdownMenuItem>
                              )}
                              <DropdownMenuItem onClick={() => openReports({ id: s.id, csvFileName: s.csvFileName, plant: s.plant, receivingSessionId: s.receivingSessionId, partIndex: s.partIndex })}>
                                <FileBarChart className="mr-2 h-3.5 w-3.5 text-gray-500" /> Reports
                              </DropdownMenuItem>
                              <DropdownMenuItem
                                disabled={deactivateMutation.isPending}
                                onClick={() => setDeactivateTarget(s.id)}
                                className="text-amber-700 focus:text-amber-700">
                                <StopCircle className="mr-2 h-3.5 w-3.5" /> Deactivate
                              </DropdownMenuItem>
                              <DropdownMenuItem
                                disabled={completeMutation.isPending}
                                onClick={() => setCompleteTarget(s.id)}
                                className="text-green-700 focus:text-green-700">
                                <CheckCircle2 className="mr-2 h-3.5 w-3.5" /> Complete
                              </DropdownMenuItem>
                            </DropdownMenuContent>
                          </DropdownMenu>
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
                <Input type="date" value={completedDate} onChange={(e) => setCompletedDate(e.target.value)}
                  className="h-8 w-[140px] text-xs rounded-full" />
                {completedDate !== todayStr && (
                  <Button size="sm" variant="ghost" className="h-8 px-2 text-xs text-gray-500 hover:text-[#001d6e] rounded-full"
                    onClick={() => setCompletedDate(todayStr)}>
                    Today
                  </Button>
                )}
                {completedDate && (
                  <Button size="sm" variant="ghost" className="h-8 w-8 p-0 text-gray-400 hover:text-red-500 rounded-full"
                    onClick={() => setCompletedDate("")}>
                    <X className="h-3.5 w-3.5" />
                  </Button>
                )}
                <Button size="sm" variant="outline" className="h-8 w-8 p-0 ml-auto rounded-full"
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
                            <PlantBadge plant={s.plant} />
                            {s.orderDate && (
                              <span className="bg-emerald-50 px-1.5 py-0.5 text-[10px] font-semibold text-emerald-700" title="Order Date — the date this CSV was uploaded for">
                                For {s.orderDate}
                              </span>
                            )}
                            {s.scanCompletedAt && <span className="text-xs text-green-700 font-medium">Done {fmtIST(s.scanCompletedAt)}</span>}
                            {s.importedByName && <span className="text-xs text-gray-400">· {s.importedByName}</span>}
                            {s.scanActivatedByName && <span className="text-xs text-gray-400">· Scanned by {s.scanActivatedByName}</span>}
                          </div>
                        </div>
                        <div className="flex shrink-0 items-center gap-1.5">
                          <span className="inline-flex items-center bg-green-100 px-2 py-0.5 text-xs font-semibold text-green-700">
                            {s.rowCount}
                          </span>
                          <span className="inline-flex items-center gap-1 rounded-full bg-green-100 px-2 py-0.5 text-xs font-semibold text-green-700">
                            <CheckCircle2 className="h-3 w-3" /> Done
                          </span>
                          <Button size="sm" variant="outline" className="h-7 px-2 text-xs text-gray-600 border-gray-200 hover:bg-gray-50 rounded-full"
                            onClick={() => openReports({ id: s.id, csvFileName: s.csvFileName, plant: s.plant, receivingSessionId: s.receivingSessionId, partIndex: s.partIndex })}>
                            <FileBarChart className="h-3.5 w-3.5 sm:mr-1" /> <span className="hidden sm:inline">Reports</span>
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
                <Input type="date" value={filterDate} onChange={(e) => { setFilterDate(e.target.value); setCurrentPage(1); }}
                  className="h-8 w-[140px] text-xs rounded-full" />
                {filterDate !== todayStr && (
                  <Button size="sm" variant="ghost" className="h-8 px-2 text-xs text-gray-500 hover:text-[#001d6e] rounded-full"
                    onClick={() => { setFilterDate(todayStr); setCurrentPage(1); }}>
                    Today
                  </Button>
                )}
                {filterDate && (
                  <Button size="sm" variant="ghost" className="h-8 w-8 p-0 text-gray-400 hover:text-red-500 rounded-full"
                    onClick={() => { setFilterDate(""); setCurrentPage(1); }}>
                    <X className="h-3.5 w-3.5" />
                  </Button>
                )}
                {/* Always mounted (visibility toggled, not presence) so the background poll
                    never shifts the filter row — a mount/unmount here was the flicker source. */}
                <Loader2 className={`h-3.5 w-3.5 animate-spin text-gray-400 ${sessionsQuery.isFetching ? "visible" : "invisible"}`} />
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
                                  <span className="bg-[#001d6e]/10 px-1.5 py-0.5 text-[10px] font-semibold text-[#001d6e] uppercase">{session.plant}</span>
                                  {/* See the note on the other list: Order Date is the meaningful
                                      one (what grouping/filters use); createdAt is just when it landed. */}
                                  {(session as any).orderDate && (
                                    <span className="bg-emerald-50 px-1.5 py-0.5 text-[10px] font-semibold text-emerald-700" title="Order Date — the date this CSV was uploaded for">
                                      For {(session as any).orderDate}
                                    </span>
                                  )}
                                  <span className="text-xs text-gray-400" title="Uploaded at">{fmtIST(session.createdAt)}</span>
                                  <span className="inline-flex items-center gap-1 text-xs text-gray-500">
                                    <svg className="h-3 w-3" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                                      <circle cx="12" cy="8" r="4"/><path d="M4 20c0-4 3.6-7 8-7s8 3 8 7"/>
                                    </svg>
                                    {importerName}
                                  </span>
                                  {(session as any).receivingSessionId && (
                                    <span className="bg-purple-50 px-1.5 py-0.5 text-[10px] font-semibold text-purple-700">
                                      Part {(session as any).partIndex ?? "?"}
                                    </span>
                                  )}
                                </div>
                              </div>
                              <div className="flex shrink-0 items-center gap-1 ml-1">
                                <Badge className="bg-[#001d6e]/10 text-[#001d6e] hover:bg-[#001d6e]/10 text-xs px-1.5 rounded-xl">
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
                                {((session as any).scanStatus === "completed" || (session as any).scanStatus === "active") && (
                                  <Button size="sm" variant="outline" className="h-7 px-2 text-xs text-gray-600 border-gray-200 hover:bg-gray-50 rounded-full"
                                    onClick={(e) => {
                                      e.stopPropagation();
                                      openReports({
                                        id: session.id, csvFileName: session.csvFileName, plant: session.plant,
                                        receivingSessionId: (session as any).receivingSessionId, partIndex: (session as any).partIndex,
                                      });
                                    }}>
                                    <FileBarChart className="h-3.5 w-3.5 sm:mr-1" /> <span className="hidden sm:inline">Reports</span>
                                  </Button>
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
                                    placeholder="Search rows…" className="pl-8 h-9 text-sm rounded-full" />
                                </div>
                                {itemSearch && (
                                  <Button size="sm" variant="ghost" className="h-9 w-9 p-0 rounded-full"
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
                                <div className="overflow-x-auto border">
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
                  {totalSessions > 0 && (
                    <div className="border-t px-5 py-3">
                      <span className="text-xs text-gray-500">{totalSessions} session{totalSessions === 1 ? "" : "s"}</span>
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
        <DialogContent className="max-w-2xl max-h-[90vh] flex flex-col rounded-xl">
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
              <div className="border border-blue-100 bg-blue-50 px-4 py-3">
                <p className="mb-2 text-xs font-semibold text-blue-700">
                  {csvData.headers.length} columns detected in "{csvData.name}"
                </p>
                <div className="flex flex-wrap gap-1.5">
                  {csvData.headers.map((h) => (
                    <span key={h} className="border border-blue-200 bg-white px-2 py-0.5 text-xs text-blue-800 font-mono">
                      {h}
                    </span>
                  ))}
                </div>
              </div>
              <div className="border bg-gray-50 p-4">
                <p className="mb-3 text-xs font-semibold uppercase tracking-wide text-gray-500">
                  Map each target field → CSV column
                </p>
                <div className="grid grid-cols-1 gap-3">
                  {TARGET_FIELDS.map((field) => {
                    const matched = mapping[field.key] !== SKIP && mapping[field.key] !== "";
                    return (
                      <div key={field.key} className="flex flex-col gap-1.5 sm:flex-row sm:items-center sm:gap-3">
                        <div className="flex w-full items-center gap-1.5 sm:w-[140px] sm:shrink-0">
                          <span className={`h-2 w-2 rounded-full ${matched ? "bg-green-500" : "bg-gray-300"}`} />
                          <Label className="text-sm">{field.label}</Label>
                        </div>
                        <Select
                          value={mapping[field.key] || SKIP}
                          onValueChange={(v) => setMapping((m) => ({ ...m, [field.key]: v }))}
                        >
                          <SelectTrigger className={`sm:flex-1 h-9 text-sm rounded-full ${!matched ? "border-dashed text-gray-400" : ""}`}>
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
                <div className="overflow-x-auto border">
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
            <Button variant="outline" className="rounded-xl"
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
              className="bg-[#001d6e] hover:bg-[#00154b] text-white rounded-xl">
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
        <AlertDialogContent className="rounded-xl">
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
        <AlertDialogContent className="rounded-xl">
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
      <AlertDialog open={deleteTarget !== null} onOpenChange={(open) => { if (!open) { setDeleteTarget(null); setDeletePreview(null); setDeleteTargetInfo(null); } }}>
        <AlertDialogContent className="rounded-xl">
          <AlertDialogHeader>
            <AlertDialogTitle>Delete this CSV?</AlertDialogTitle>
            <AlertDialogDescription>
              {deletePreview && deletePreview.scannedItemCount > 0 ? (
                <>
                  {deletePreview.scannedItemCount} item(s) already scanned against this file
                  ({deletePreview.scannedQtyTotal} total qty
                  {deletePreview.extraQtyTotal > 0 ? `, ${deletePreview.extraQtyTotal} extra qty` : ""}
                  {deletePreview.stockApplied ? ", stock applied" : ""}).
                  {" "}Will you re-upload a corrected version for this plant/date?
                  <br /><br />
                  <b>Yes, I'll re-upload:</b> these scans are held and carried forward automatically onto the corrected CSV.
                  <br />
                  <b>No, remove permanently:</b> these scans are reverted{deletePreview.stockApplied ? " and stock is rolled back" : ""}, and your next upload is treated as a brand-new file.
                </>
              ) : (
                <>
                  Will you re-upload a corrected version for this plant/date?
                  {" "}Choose <b>re-upload later</b> to keep this slot for the corrected CSV, or
                  {" "}<b>remove permanently</b> to treat your next upload as a brand-new file.
                </>
              )}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter className="flex-col-reverse gap-2 sm:flex-row sm:justify-end">
            <AlertDialogCancel className="mt-0">Cancel</AlertDialogCancel>
            <AlertDialogAction className="bg-red-600 text-white hover:bg-red-700"
              onClick={() => deleteTarget !== null && deleteMutation.mutate({ id: deleteTarget, mode: "discard" })}
              disabled={deleteMutation.isPending}>
              {deleteMutation.isPending ? <Loader2 className="h-4 w-4 animate-spin" /> : "Remove permanently"}
            </AlertDialogAction>
            <AlertDialogAction
              onClick={() => {
                if (deleteTarget === null) return;
                const info = deleteTargetInfo;
                deleteMutation.mutate(
                  { id: deleteTarget, mode: "replace" },
                  {
                    onSuccess: () => {
                      if (info) {
                        setPlant(info.plant);
                        setOrderDate(info.orderDate);
                      }
                      toast({
                        title: "Pick the corrected CSV",
                        description: "Plant and Order Date are filled in — choose the file to continue.",
                      });
                      reuploadPendingRef.current = true;
                      fileRef.current?.scrollIntoView({ behavior: "smooth", block: "center" });
                      fileRef.current?.click();
                    },
                  },
                );
              }}
              disabled={deleteMutation.isPending}>
              {deleteMutation.isPending ? <Loader2 className="h-4 w-4 animate-spin" /> : "Delete, I'll re-upload"}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      <EditCsvDialog sessionId={editSessionId} onClose={() => setEditSessionId(null)} />
      <ReportsDialog session={reportsSession} onClose={() => setReportsSession(null)} />
    </main>
  );
}
