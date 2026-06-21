import { useRef, useState } from "react";
import { useLocation } from "wouter";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import Papa from "papaparse";
import { getCurrentUserPermissions } from "../lib/permissions";
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
  const [selectedFile, setSelectedFile] = useState<File | null>(null);

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
    refetchInterval: 5000,
    refetchOnMount: true,
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
    refetchInterval: 5000,
    refetchOnMount: true,
  });

  // Active session — uses /active endpoint which has NO date filter whatsoever,
  // so it always finds whichever session is currently running regardless of when it was loaded.
  const activeSessionQuery = useQuery<ScanSession | null>({
    queryKey: ["/api/order-scan/active"],
    queryFn: async ({ signal }) =>
      (await apiRequest("GET", "/api/order-scan/active", undefined, undefined, false, signal)).json(),
    enabled: isImportRole,
    staleTime: 0,
    refetchInterval: 5000,
    refetchOnMount: true,
  });

  // ── Mutations ──────────────────────────────────────────────────────────────
  // Helper: immediately patch the paginated import-sessions cache
  type ImportSessionRow = OrderImportSession & { importedByName: string | null; scanStatus: string };
  const patchImportSessions = (updater: (rows: ImportSessionRow[]) => ImportSessionRow[]) => {
    // Patch every cached page variant so any currently visible page updates instantly
    qc.getQueriesData<SessionsResponse>({ queryKey: ["/api/order-import/sessions"] })
      .forEach(([key, data]) => {
        if (!data) return;
        qc.setQueryData<SessionsResponse>(key, {
          ...data,
          sessions: updater(data.sessions),
        });
      });
  };

  // Shared helper: cancel all in-flight session GET requests so stale responses
  // from the polling intervals can never arrive and overwrite a fresh mutation result.
  // This is the root cause of the production race condition:
  //   t=0  poll fires (GET in-flight)
  //   t=1  mutation completes, cache updated optimistically
  //   t=2  stale GET response arrives → overwrites the optimistic update
  // cancelQueries in onMutate prevents step 3 from ever happening.
  const cancelSessionQueries = () =>
    Promise.all([
      qc.cancelQueries({ queryKey: ["/api/order-scan/sessions"] }),
      qc.cancelQueries({ queryKey: ["/api/order-import/sessions"] }),
      qc.cancelQueries({ queryKey: ["/api/order-scan/active"] }),
      qc.cancelQueries({ queryKey: ["/api/order-scan/notification"] }),
    ]);

  // Shared helper: after every mutation fire IMMEDIATE network requests for all
  // session queries. refetchQueries (unlike invalidateQueries) does not wait for
  // staleTime — it fires the fetch right now, guaranteeing the UI reflects the
  // latest server state as soon as the response arrives.
  const refetchAllSessionQueries = () => {
    qc.refetchQueries({ queryKey: ["/api/order-import/sessions"], type: "all" });
    qc.refetchQueries({ queryKey: ["/api/order-scan/sessions"],   type: "all" });
    qc.refetchQueries({ queryKey: ["/api/order-scan/active"],     type: "all" });
    qc.refetchQueries({ queryKey: ["/api/order-scan/notification"], type: "all" });
  };

  const importMutation = useMutation({
    mutationFn: async (payload: { plant: string; csvFileName: string; items: object[] }) =>
      (await apiRequest("POST", "/api/order-import/sessions", payload)).json(),
    onMutate: async () => {
      await cancelSessionQueries();
    },
    onSuccess: (data) => {
      setShowMappingDialog(false);
      setCsvData(null);
      setSelectedFile(null);
      setLastImport({ rowCount: data.rowCount });
      setShowHistory(true);

      if (data.session) {
        const newImportRow: ImportSessionRow = {
          ...data.session,
          rowCount:        data.rowCount,
          scanStatus:      data.session.scanStatus ?? "available",
          importedByName:  (user as any)?.name ?? null,
        };

        // Patch every cached page variant immediately
        patchImportSessions((rows) => [newImportRow, ...rows]);

        // Seed the page-1 / no-filter cache key so the UI shows the new session
        // instantly even when the user was browsing a different page.
        const page1Key = ["/api/order-import/sessions", 1, pageSize, "", ""] as const;
        const page1Data = qc.getQueryData<SessionsResponse>(page1Key);
        if (page1Data) {
          qc.setQueryData<SessionsResponse>(page1Key, {
            ...page1Data,
            sessions: [newImportRow, ...page1Data.sessions].slice(0, pageSize),
            total: page1Data.total + 1,
            totalPages: Math.max(1, Math.ceil((page1Data.total + 1) / pageSize)),
          });
        }

        const newScanSession: ScanSession = {
          id:                  data.session.id,
          plant:               data.session.plant,
          csvFileName:         data.session.csvFileName,
          rowCount:            data.rowCount,
          scanStatus:          data.session.scanStatus ?? "available",
          importedByName:      (user as any)?.name ?? null,
          createdAt:           data.session.createdAt ?? new Date().toISOString(),
          scanActivatedByName: null,
          scanActivatedAt:     null,
          scanCompletedAt:     null,
          scanActivatedByCode: null,
        };
        qc.setQueryData<ScanSession[]>(["/api/order-scan/sessions"], (old) =>
          old ? [newScanSession, ...old] : [newScanSession],
        );
      }

      // Reset pagination after cache is seeded so the component renders page-1 data immediately
      setCurrentPage(1);
      setFilterDate("");
      setFilterPlant("");

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
      await cancelSessionQueries();
      const prevScanSessions  = qc.getQueryData<ScanSession[]>(["/api/order-scan/sessions"]);
      const prevImportPages   = qc.getQueriesData<SessionsResponse>({ queryKey: ["/api/order-import/sessions"] });
      const prevActive        = qc.getQueryData<ScanSession | null>(["/api/order-scan/active"]);
      const activatingSession = (prevScanSessions ?? []).find((s) => s.id === id);
      // Optimistic: mark session active immediately so it appears in Currently Active without waiting for server
      patchImportSessions((rows) => rows.map((s) => s.id === id ? { ...s, scanStatus: "active" } : s));
      qc.setQueryData<ScanSession[]>(["/api/order-scan/sessions"], (old) =>
        old ? old.map((s) => s.id === id ? { ...s, scanStatus: "active" } : s) : old,
      );
      if (activatingSession) {
        qc.setQueryData<ScanSession | null>(["/api/order-scan/active"], { ...activatingSession, scanStatus: "active" });
      }
      return { prevScanSessions, prevImportPages, prevActive };
    },
    onError: (err: any, _id, ctx) => {
      if (ctx) {
        if (ctx.prevScanSessions !== undefined)
          qc.setQueryData<ScanSession[]>(["/api/order-scan/sessions"], ctx.prevScanSessions);
        ctx.prevImportPages.forEach(([key, data]) => { if (data) qc.setQueryData<SessionsResponse>(key, data); });
        if (ctx.prevActive !== undefined)
          qc.setQueryData<ScanSession | null>(["/api/order-scan/active"], ctx.prevActive);
      }
      toast({ title: "Cannot load for scan", description: err.message, variant: "destructive" });
    },
    onSettled: () => refetchAllSessionQueries(),
  });

  const deleteMutation = useMutation({
    mutationFn: async (id: number) => {
      await apiRequest("DELETE", `/api/order-import/sessions/${id}`);
    },
    onMutate: async (id) => {
      await cancelSessionQueries();
      const previousScanSessions = qc.getQueryData<ScanSession[]>(["/api/order-scan/sessions"]);
      const previousImportPages  = qc.getQueriesData<SessionsResponse>({ queryKey: ["/api/order-import/sessions"] });
      const previousActive       = qc.getQueryData<ScanSession | null>(["/api/order-scan/active"]);
      // Optimistic: remove session from cache immediately before server responds
      setDeleteTarget(null);
      if (expandedId === id)     setExpandedId(null);
      if (scanExpandedId === id) setScanExpandedId(null);
      patchImportSessions((rows) => rows.filter((s) => s.id !== id));
      qc.setQueryData<ScanSession[]>(["/api/order-scan/sessions"], (old) =>
        old ? old.filter((s) => s.id !== id) : old,
      );
      if (previousActive?.id === id) qc.setQueryData(["/api/order-scan/active"], null);
      toast({ title: "Session deleted" });
      return { previousScanSessions, previousImportPages, previousActive };
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
      }
      toast({ title: "Delete failed", description: err.message, variant: "destructive" });
    },
    onSettled: () => refetchAllSessionQueries(),
  });

  const deactivateMutation = useMutation({
    mutationFn: async (id: number) =>
      (await apiRequest("POST", `/api/order-scan/sessions/${id}/deactivate`)).json(),
    onMutate: async (id) => {
      await cancelSessionQueries();
      const previousScanSessions = qc.getQueryData<ScanSession[]>(["/api/order-scan/sessions"]);
      const previousImportPages  = qc.getQueriesData<SessionsResponse>({ queryKey: ["/api/order-import/sessions"] });
      const previousActive       = qc.getQueryData<ScanSession | null>(["/api/order-scan/active"]);
      // Optimistic: revert status to available immediately
      setDeactivateTarget(null);
      patchImportSessions((rows) => rows.map((s) => s.id === id ? { ...s, scanStatus: "available" } : s));
      qc.setQueryData<ScanSession[]>(["/api/order-scan/sessions"], (old) =>
        old ? old.map((s) => s.id === id ? { ...s, scanStatus: "available" } : s) : old,
      );
      if (previousActive?.id === id) qc.setQueryData(["/api/order-scan/active"], null);
      toast({ title: "Session deactivated", description: "Lock released. Another session can now be loaded." });
      return { previousScanSessions, previousImportPages, previousActive };
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
      }
      toast({ title: "Deactivate failed", description: err.message, variant: "destructive" });
    },
    onSettled: () => refetchAllSessionQueries(),
  });

  const completeMutation = useMutation({
    mutationFn: async (id: number) =>
      (await apiRequest("POST", `/api/order-scan/sessions/${id}/complete`)).json(),
    onMutate: async (id) => {
      await cancelSessionQueries();
      const previousScanSessions = qc.getQueryData<ScanSession[]>(["/api/order-scan/sessions"]);
      const previousImportPages  = qc.getQueriesData<SessionsResponse>({ queryKey: ["/api/order-import/sessions"] });
      const previousActive       = qc.getQueryData<ScanSession | null>(["/api/order-scan/active"]);
      // Optimistic: mark completed immediately
      setCompleteTarget(null);
      setShowCompleted(true);
      patchImportSessions((rows) => rows.map((s) => s.id === id ? { ...s, scanStatus: "completed" } : s));
      qc.setQueryData<ScanSession[]>(["/api/order-scan/sessions"], (old) =>
        old ? old.map((s) => s.id === id ? { ...s, scanStatus: "completed" } : s) : old,
      );
      if (previousActive?.id === id) qc.setQueryData(["/api/order-scan/active"], null);
      toast({ title: "Session completed", className: "bg-green-50 border-green-200 text-green-900" });
      return { previousScanSessions, previousImportPages, previousActive };
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
      }
      toast({ title: "Complete failed", description: err.message, variant: "destructive" });
    },
    onSettled: () => refetchAllSessionQueries(),
  });

  const updateMutation = useMutation({
    mutationFn: async (payload: { id: number; csvFileName: string; items: object[] }) =>
      (await apiRequest("PUT", `/api/order-import/sessions/${payload.id}`, payload)).json(),
    onMutate: async () => {
      await cancelSessionQueries();
    },
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
  function parseAndOpen(file: File) {
    // Parse as raw arrays first so we can find the real header row.
    // Excel pivot-table exports often have a report-title row before the actual headers.
    Papa.parse<string[]>(file, {
      header: false,
      skipEmptyLines: true,
      delimiter: "",   // auto-detect delimiter
      encoding: "UTF-8",
      complete: (result) => {
        const rawRows = result.data as string[][];
        if (rawRows.length === 0) {
          toast({ title: "Empty file", description: "The CSV has no rows.", variant: "destructive" });
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
            description: "Could not detect column headers in the file.",
            variant: "destructive",
          });
          return;
        }

        // Build data rows from everything after the header row
        const dataRows = rawRows.slice(headerRowIdx + 1).map((row) => {
          const obj: Record<string, string> = {};
          headers.forEach((h, i) => { obj[h] = row[i] ?? ""; });
          return obj;
        });

        setCsvData({ name: file.name, headers, rows: dataRows });
        setMapping(autoMatch(headers));
        setShowMappingDialog(true);
      },
      error: (err) =>
        toast({ title: "Could not parse CSV", description: err.message, variant: "destructive" }),
    });
  }

  function handleFileChange(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    if (!file) return;
    setSelectedFile(file);
    setLastImport(null);
    e.target.value = "";
  }

  function handleImportClick() {
    if (!plant.trim()) {
      toast({ title: "Select a plant first", variant: "destructive" });
      return;
    }
    if (!selectedFile) {
      toast({ title: "Select a CSV file first", variant: "destructive" });
      return;
    }
    parseAndOpen(selectedFile);
  }

  function handleConfirmImport() {
    if (!csvData) return;
    const items = csvData.rows.map((row) => {
      const get = (key: TargetKey) => {
        const col = mapping[key];
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
    if (editTargetSession) {
      updateMutation.mutate({ id: editTargetSession.id, csvFileName: csvData.name, items });
    } else {
      importMutation.mutate({ plant, csvFileName: csvData.name, items });
    }
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
    setSelectedFile(null);
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

  return (
    <main className="min-h-screen bg-gray-50 p-3 sm:p-5 lg:p-8">
      <div className="mx-auto max-w-6xl space-y-4">

        {/* ── Header ── */}
        <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
          <div className="flex items-center gap-3">
            <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-md bg-[#001d6e] text-white">
              <FileUp className="h-5 w-5" />
            </div>
            <div>
              <h1 className="text-xl font-semibold text-gray-950">Order Import</h1>
              <p className="text-xs text-gray-500">Upload CSV, map columns, and import order rows.</p>
            </div>
          </div>
          <div className="flex gap-2 flex-wrap">
            <Button
              variant={showHistory ? "default" : "outline"}
              size="sm"
              onClick={() => setShowHistory(!showHistory)}
              className={showHistory ? "bg-[#001d6e] hover:bg-[#00154b] text-white" : ""}
            >
              <History className="mr-2 h-4 w-4" />
              Import History
              {totalSessions > 0 && (
                <Badge className={`ml-1.5 px-1.5 py-0 text-xs ${showHistory ? "bg-white/20 text-white" : "bg-[#001d6e]/10 text-[#001d6e]"}`}>
                  {totalSessions}
                </Badge>
              )}
            </Button>
            <Button
              variant="outline"
              size="sm"
              onClick={() => sessionsQuery.refetch()}
              disabled={sessionsQuery.isFetching}
            >
              <RefreshCw className={`mr-2 h-4 w-4 ${sessionsQuery.isFetching ? "animate-spin" : ""}`} />
              Refresh
            </Button>
          </div>
        </div>

        {/* ── Upload Card (compact) ── */}
        <Card className="rounded-md">
          <CardContent className="p-4">
            <div className="flex flex-wrap items-end gap-3">
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
                  CSV File {selectedFile && <span className="text-green-600 font-medium">· {selectedFile.name}</span>}
                </Label>
                <Input ref={fileRef} type="file" accept=".csv" className="h-9 text-sm"
                  onChange={handleFileChange} disabled={importMutation.isPending} />
              </div>
              {/* Actions */}
              <div className="flex gap-2 pb-0.5">
                <Button variant="outline" className="h-9" onClick={clearForm}
                  disabled={!selectedFile || importMutation.isPending}>
                  <X className="h-4 w-4" />
                </Button>
                <Button className="h-9 bg-[#001d6e] hover:bg-[#00154b] text-white" onClick={handleImportClick}
                  disabled={!selectedFile || !plant.trim() || importMutation.isPending}>
                  {importMutation.isPending ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : <Upload className="mr-2 h-4 w-4" />}
                  Map &amp; Import
                </Button>
              </div>
            </div>
            {/* Feedback row */}
            {(lastImport || importMutation.isError) && (
              <div className="mt-3">
                {lastImport && (
                  <p className="text-xs text-green-700 flex items-center gap-1">
                    <CheckCircle className="h-3.5 w-3.5" /> Imported <strong>{lastImport.rowCount}</strong> rows successfully.
                  </p>
                )}
                {importMutation.isError && (
                  <p className="text-xs text-red-600 flex items-center gap-1">
                    <AlertCircle className="h-3.5 w-3.5" /> {(importMutation.error as Error).message}
                  </p>
                )}
              </div>
            )}
          </CardContent>
        </Card>

        {/* ── Import History (toggled) ── */}
        {showHistory && (
          <Card className="rounded-md">
            <CardHeader className="pb-3 space-y-3">
              <div className="flex flex-wrap items-center justify-between gap-2">
                <div>
                  <CardTitle className="text-base">Import History</CardTitle>
                  <p className="text-xs text-gray-500 mt-0.5">{totalSessions} total sessions</p>
                </div>
                <div className="flex items-center gap-2">
                  <span className="text-xs text-gray-500">Show</span>
                  <Select
                    value={String(pageSize)}
                    onValueChange={(v) => { setPageSize(Number(v)); setCurrentPage(1); }}
                  >
                    <SelectTrigger className="h-8 w-[65px] text-xs">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="10">10</SelectItem>
                      <SelectItem value="25">25</SelectItem>
                      <SelectItem value="50">50</SelectItem>
                    </SelectContent>
                  </Select>
                </div>
              </div>

              {/* Plant + Date filters */}
              <div className="flex flex-wrap items-center gap-2">
                {plantOptions.length > 0 ? (
                  <Select value={filterPlant || "_all_"} onValueChange={(v) => { setFilterPlant(v === "_all_" ? "" : v); setCurrentPage(1); }}>
                    <SelectTrigger className="h-8 w-[130px] text-xs">
                      <SelectValue placeholder="All plants" />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="_all_">All plants</SelectItem>
                      {plantOptions.map((p) => (
                        <SelectItem key={p.name} value={p.name}>{p.name}</SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                ) : (
                  <Input value={filterPlant} onChange={(e) => { setFilterPlant(e.target.value); setCurrentPage(1); }}
                    placeholder="Plant…" className="h-8 w-[110px] text-xs" />
                )}
                <Input
                  type="date"
                  value={filterDate}
                  onChange={(e) => { setFilterDate(e.target.value); setCurrentPage(1); }}
                  className="h-8 w-[140px] text-xs"
                />
                {filterDate && (
                  <Button size="sm" variant="ghost" className="h-8 w-8 p-0 text-gray-400 hover:text-red-500"
                    onClick={() => { setFilterDate(""); setCurrentPage(1); }}>
                    <X className="h-3.5 w-3.5" />
                  </Button>
                )}
                {filterDate !== todayStr && (
                  <Button size="sm" variant="ghost" className="h-8 px-2 text-xs text-gray-500 hover:text-[#001d6e]"
                    onClick={() => { setFilterDate(todayStr); setCurrentPage(1); }}>
                    Today
                  </Button>
                )}
                {sessionsQuery.isFetching && <Loader2 className="h-3.5 w-3.5 animate-spin text-gray-400" />}
              </div>
            </CardHeader>
            <CardContent className="p-0">
              {sessionsQuery.isLoading ? (
                <div className="flex items-center justify-center py-12">
                  <Loader2 className="h-6 w-6 animate-spin text-[#001d6e]" />
                </div>
              ) : sessions.length === 0 ? (
                <div className="flex flex-col items-center justify-center py-12 text-muted-foreground">
                  <FileUp className="h-9 w-9 mb-2 opacity-20" />
                  <p className="text-sm text-center px-4">
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
                          {/* Session row */}
                          <div
                            className="cursor-pointer px-4 py-3 hover:bg-gray-50 active:bg-gray-100"
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
                                    <CheckCircle2 className="h-3 w-3" />
                                    Done
                                  </span>
                                )}
                                {(session as any).scanStatus === "available" && (
                                  <span className="rounded-full bg-gray-100 px-2 py-0.5 text-[10px] font-medium text-gray-500 whitespace-nowrap">
                                    Ready
                                  </span>
                                )}
                                <Button
                                  size="sm"
                                  variant="ghost"
                                  title="Re-import with new CSV"
                                  className="h-8 w-8 p-0 text-gray-400 hover:text-blue-600"
                                  onClick={(e) => {
                                    e.stopPropagation();
                                    setEditTargetSession({ id: session.id, plant: session.plant, csvFileName: session.csvFileName });
                                    setShowEditDialog(true);
                                  }}
                                >
                                  <Pencil className="h-3.5 w-3.5" />
                                </Button>
                                <Button
                                  size="sm"
                                  variant="ghost"
                                  className="h-8 w-8 p-0 text-gray-400 hover:text-red-600"
                                  onClick={(e) => { e.stopPropagation(); setDeleteTarget(session.id); }}
                                >
                                  <Trash2 className="h-3.5 w-3.5" />
                                </Button>
                              </div>
                            </div>
                          </div>

                          {/* Expanded items */}
                          {expandedId === session.id && (
                            <div className="border-t bg-gray-50/60 px-4 py-3">
                              <div className="mb-3 flex items-center gap-2">
                                <div className="relative flex-1">
                                  <Search className="absolute left-3 top-2.5 h-3.5 w-3.5 text-gray-400" />
                                  <Input
                                    value={itemSearch}
                                    onChange={(e) => setItemSearch(e.target.value)}
                                    placeholder="Search rows…"
                                    className="pl-8 h-9 text-sm"
                                  />
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
                    <div className="flex flex-wrap items-center justify-between gap-2 border-t px-4 py-3">
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
            </CardContent>
          </Card>
        )}

        {/* ── Scan section: side-by-side cards ── */}
        {isImportRole && (
        <div className="grid grid-cols-1 lg:grid-cols-[3fr_2fr] gap-4 items-start">

        {/* ── Card: All CSV Sessions (available to load) ── */}
        <Card className="rounded-md">
            <CardHeader className="pb-3">
              <div className="flex flex-wrap items-center justify-between gap-3">
                <div className="flex items-center gap-2">
                  <div className="flex h-8 w-8 items-center justify-center rounded bg-[#001d6e]/10 shrink-0">
                    <ScanLine className="h-4 w-4 text-[#001d6e]" />
                  </div>
                  <div>
                    <CardTitle className="text-base">CSV Sessions</CardTitle>
                    <p className="text-xs text-gray-500 mt-0.5">Load a CSV session for dispatch scanning</p>
                  </div>
                </div>
                <div className="flex flex-wrap items-center gap-2">
                  {plantOptions.length > 0 ? (
                    <Select value={scanPlant || "_all_"} onValueChange={(v) => { setScanPlant(v === "_all_" ? "" : v); setScanExpandedId(null); }}>
                      <SelectTrigger className="h-8 w-[130px] text-xs">
                        <SelectValue placeholder="All plants" />
                      </SelectTrigger>
                      <SelectContent>
                        <SelectItem value="_all_">All plants</SelectItem>
                        {plantOptions.map((p) => (
                          <SelectItem key={p.name} value={p.name}>{p.name}</SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                  ) : (
                    <Input value={scanPlant} onChange={(e) => { setScanPlant(e.target.value); setScanExpandedId(null); }}
                      placeholder="Plant…" className="h-8 w-[110px] text-xs" />
                  )}
                  <Input type="date" value={scanDate} onChange={(e) => { setScanDate(e.target.value); setScanExpandedId(null); }}
                    className="h-8 w-[140px] text-xs" />
                  {scanDate && (
                    <Button size="sm" variant="ghost" className="h-8 w-8 p-0 text-gray-400 hover:text-red-500"
                      onClick={() => { setScanDate(""); setScanExpandedId(null); }}>
                      <X className="h-3.5 w-3.5" />
                    </Button>
                  )}
                  {scanDate !== todayStr && (
                    <Button size="sm" variant="ghost" className="h-8 px-2 text-xs text-gray-500 hover:text-[#001d6e]"
                      onClick={() => { setScanDate(todayStr); setScanExpandedId(null); }}>
                      Today
                    </Button>
                  )}
                  <Button size="sm" variant="outline" className="h-8 w-8 p-0"
                    onClick={() => scanSessionsQuery.refetch()} disabled={scanSessionsQuery.isFetching}>
                    <RefreshCw className={`h-3.5 w-3.5 ${scanSessionsQuery.isFetching ? "animate-spin" : ""}`} />
                  </Button>
                </div>
              </div>
            </CardHeader>
            <CardContent className="p-0">
              {scanSessionsQuery.isFetching && availableScanSessions.length === 0 ? (
                <div className="flex justify-center py-10">
                  <Loader2 className="h-6 w-6 animate-spin text-[#001d6e]" />
                </div>
              ) : availableScanSessions.length === 0 ? (
                <div className="flex flex-col items-center justify-center py-10 text-gray-400">
                  <ScanLine className="h-8 w-8 mb-2 opacity-30" />
                  <p className="text-sm text-center">
                    No sessions found{scanPlant ? ` for ${scanPlant}` : ""}{scanDate ? ` on ${scanDate === todayStr ? "today" : scanDate}` : ""}.
                  </p>
                </div>
              ) : (
                <div className="divide-y">
                  {availableScanSessions.map((s) => {
                    const isExpanded  = scanExpandedId === s.id;
                    const scanAllItems = isExpanded ? (scanItemsQuery.data ?? []) : [];
                    const scanFiltered = scanItemSearch
                      ? scanAllItems.filter((i) => [i.barcode, i.itemName, i.sapCode].some((v) => v?.toLowerCase().includes(scanItemSearch.toLowerCase())))
                      : scanAllItems;
                    return (
                      <div key={s.id}>
                        {/* Session row — click to expand */}
                        <div
                          className="cursor-pointer px-4 py-3 hover:bg-gray-50 active:bg-gray-100"
                          onClick={() => { setScanExpandedId(isExpanded ? null : s.id); setScanItemSearch(""); }}
                        >
                          <div className="flex items-start gap-2">
                            <span className="mt-0.5 shrink-0 text-gray-400">
                              {isExpanded ? <ChevronDown className="h-4 w-4" /> : <ChevronRight className="h-4 w-4" />}
                            </span>
                            <div className="flex-1 min-w-0">
                              <p className="truncate text-sm font-medium text-gray-900">{s.csvFileName}</p>
                              <div className="mt-0.5 flex flex-wrap items-center gap-x-1.5 gap-y-0.5">
                                <span className="rounded bg-[#001d6e]/10 px-1.5 py-0.5 text-[10px] font-semibold text-[#001d6e] uppercase">{s.plant}</span>
                                <span className="text-xs text-gray-400">{fmtIST(s.createdAt)}</span>
                                {s.importedByName && (
                                  <span className="text-xs text-gray-400">· {s.importedByName}</span>
                                )}
                              </div>
                            </div>
                            <div className="flex shrink-0 items-center gap-1 ml-1">
                              <Badge className="bg-[#001d6e]/10 text-[#001d6e] hover:bg-[#001d6e]/10 text-xs px-1.5">
                                {s.rowCount}
                              </Badge>
                              <Button size="sm" variant="ghost"
                                className="h-8 w-8 p-0 text-gray-400 hover:text-[#001d6e]"
                                title="Load for scanning"
                                disabled={loadForScanMutation.isPending}
                                onClick={(e) => { e.stopPropagation(); loadForScanMutation.mutate(s.id); }}>
                                {loadForScanMutation.isPending
                                  ? <Loader2 className="h-3.5 w-3.5 animate-spin" />
                                  : <ScanLine className="h-3.5 w-3.5" />}
                              </Button>
                              <Button size="sm" variant="ghost"
                                className="h-8 w-8 p-0 text-gray-400 hover:text-red-600"
                                onClick={(e) => { e.stopPropagation(); setDeleteTarget(s.id); }}>
                                <Trash2 className="h-3.5 w-3.5" />
                              </Button>
                            </div>
                          </div>
                        </div>

                        {/* Expanded items */}
                        {isExpanded && (
                          <div className="border-t bg-gray-50/60 px-4 py-3">
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
            </CardContent>
          </Card>

        {/* ── Card: Currently Active Session ── */}
        <Card className={`rounded-md border-amber-200 ${activeScanSessions.length > 0 ? "shadow-amber-100 shadow-md" : ""}`}>
            <CardHeader className="pb-3 space-y-3">
              <div className="flex items-center gap-2">
                <div className={`flex h-8 w-8 items-center justify-center rounded shrink-0 ${
                  activeScanSessions.length > 0 ? "bg-amber-100" : "bg-gray-100"
                }`}>
                  <PackageCheck className={`h-4 w-4 ${activeScanSessions.length > 0 ? "text-amber-600" : "text-gray-400"}`} />
                </div>
                <div className="flex-1 min-w-0">
                  <CardTitle className="text-base flex items-center gap-2">
                    Currently Active
                    {activeScanSessions.length > 0 && (
                      <span className="inline-flex items-center gap-1">
                        <span className="h-2 w-2 rounded-full bg-amber-400 animate-pulse" />
                        <span className="text-xs font-normal text-amber-600">{activeScanSessions.length} running</span>
                      </span>
                    )}
                  </CardTitle>
                  <p className="text-xs text-gray-500 mt-0.5">Active scan sessions being worked on by dispatch</p>
                </div>
              </div>
              {/* Filters for Currently Active */}
              <div className="flex flex-wrap items-center gap-2">
                {plantOptions.length > 0 ? (
                  <Select value={activePlant || "_all_"} onValueChange={(v) => setActivePlant(v === "_all_" ? "" : v)}>
                    <SelectTrigger className="h-8 w-[120px] text-xs">
                      <SelectValue placeholder="All plants" />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="_all_">All plants</SelectItem>
                      {plantOptions.map((p) => (
                        <SelectItem key={p.name} value={p.name}>{p.name}</SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                ) : (
                  <Input value={activePlant} onChange={(e) => setActivePlant(e.target.value)}
                    placeholder="Plant…" className="h-8 w-[100px] text-xs" />
                )}
                <Input type="date" value={activeDate} onChange={(e) => setActiveDate(e.target.value)}
                  className="h-8 w-[135px] text-xs" />
                {activeDate && (
                  <Button size="sm" variant="ghost" className="h-8 w-8 p-0 text-gray-400 hover:text-red-500"
                    onClick={() => setActiveDate("")}>
                    <X className="h-3.5 w-3.5" />
                  </Button>
                )}
                {activeDate !== todayStr && (
                  <Button size="sm" variant="ghost" className="h-8 px-2 text-xs text-gray-500 hover:text-[#001d6e]"
                    onClick={() => setActiveDate(todayStr)}>
                    Today
                  </Button>
                )}
                <Button size="sm" variant="outline" className="h-8 w-8 p-0"
                  onClick={() => scanSessionsQuery.refetch()} disabled={scanSessionsQuery.isFetching}>
                  <RefreshCw className={`h-3.5 w-3.5 ${scanSessionsQuery.isFetching ? "animate-spin" : ""}`} />
                </Button>
              </div>
            </CardHeader>
            <CardContent className="p-0">
              {scanSessionsQuery.isFetching && activeScanSessions.length === 0 ? (
                <div className="flex justify-center py-10">
                  <Loader2 className="h-6 w-6 animate-spin text-amber-500" />
                </div>
              ) : activeScanSessions.length === 0 ? (
                <div className="flex flex-col items-center justify-center py-10 text-gray-400">
                  <PackageCheck className="h-8 w-8 mb-2 opacity-20" />
                  <p className="text-sm">No active session{activePlant ? ` for ${activePlant}` : ""}</p>
                  <p className="text-xs mt-0.5 text-gray-400">Load a CSV session above to start scanning</p>
                </div>
              ) : (
                <div className="divide-y">
                  {activeScanSessions.map((s) => (
                    <div key={s.id} className="px-4 py-4 bg-amber-50/30">
                      <div className="flex items-start gap-3">
                        <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-lg border border-amber-200 bg-amber-100">
                          <ScanLine className="h-5 w-5 text-amber-600" />
                        </div>
                        <div className="flex-1 min-w-0">
                          <p className="truncate text-sm font-semibold text-gray-900">{s.csvFileName}</p>
                          <div className="mt-0.5 flex flex-wrap items-center gap-x-1.5 gap-y-0.5">
                            <span className="rounded bg-amber-100 px-1.5 py-0.5 text-[10px] font-semibold text-amber-700 uppercase">{s.plant}</span>
                            <span className="text-xs text-gray-400">{s.rowCount} rows</span>
                            {s.importedByName && <span className="text-xs text-gray-400">· {s.importedByName}</span>}
                          </div>
                          {s.scanActivatedByName && (
                            <p className="mt-1 text-xs text-amber-700 font-medium">
                              Scanning: {s.scanActivatedByName}
                              {s.scanActivatedAt && <span className="font-normal text-gray-400"> · since {fmtIST(s.scanActivatedAt)}</span>}
                            </p>
                          )}
                        </div>
                        <div className="flex shrink-0 flex-col items-end gap-1.5">
                          <Button size="sm"
                            className="h-8 text-xs bg-amber-600 hover:bg-amber-700 text-white"
                            onClick={() => navigate("/scan")}>
                            <ScanLine className="mr-1.5 h-3.5 w-3.5" />
                            View Scan
                          </Button>
                          <div className="flex items-center gap-1">
                            <Button size="sm" variant="outline"
                              className="h-7 px-2 text-xs text-amber-700 border-amber-200 hover:bg-amber-50"
                              disabled={deactivateMutation.isPending}
                              title="Release lock (keep data)"
                              onClick={() => setDeactivateTarget(s.id)}>
                              <StopCircle className="mr-1 h-3 w-3" />
                              Deactivate
                            </Button>
                            <Button size="sm" variant="outline"
                              className="h-7 px-2 text-xs text-green-700 border-green-200 hover:bg-green-50"
                              disabled={completeMutation.isPending}
                              title="Mark as done"
                              onClick={() => setCompleteTarget(s.id)}>
                              <CheckCircle2 className="mr-1 h-3 w-3" />
                              Complete
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
            </CardContent>
          </Card>

        </div>
        )}{/* end isImportRole grid */}

        {/* ── Completed Sessions card ── */}
        {isImportRole && (
        <Card className="rounded-md border-green-200">
          <CardHeader className="pb-3 space-y-3">
            {/* Title row — click to toggle */}
            <div className="flex items-center justify-between gap-3 cursor-pointer select-none"
              onClick={() => setShowCompleted(!showCompleted)}>
              <div className="flex items-center gap-2">
                <div className="flex h-8 w-8 items-center justify-center rounded bg-green-100 shrink-0">
                  <CheckCircle2 className="h-4 w-4 text-green-600" />
                </div>
                <div>
                  <CardTitle className="text-base flex items-center gap-2">
                    Completed Sessions
                    {completedScanSessions.length > 0 && (
                      <Badge className="bg-green-100 text-green-700 hover:bg-green-100 text-xs px-1.5">
                        {completedScanSessions.length}
                      </Badge>
                    )}
                  </CardTitle>
                  <p className="text-xs text-gray-500 mt-0.5">Sessions that have been fully scanned</p>
                </div>
              </div>
              <span className="text-gray-400 shrink-0">
                {showCompleted ? <ChevronDown className="h-4 w-4" /> : <ChevronRight className="h-4 w-4" />}
              </span>
            </div>
            {/* Filters — always visible */}
            <div className="flex flex-wrap items-center gap-2">
              {plantOptions.length > 0 ? (
                <Select value={completedPlant || "_all_"} onValueChange={(v) => setCompletedPlant(v === "_all_" ? "" : v)}>
                  <SelectTrigger className="h-8 w-[130px] text-xs">
                    <SelectValue placeholder="All plants" />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="_all_">All plants</SelectItem>
                    {plantOptions.map((p) => (
                      <SelectItem key={p.name} value={p.name}>{p.name}</SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              ) : (
                <Input value={completedPlant} onChange={(e) => setCompletedPlant(e.target.value)}
                  placeholder="Plant…" className="h-8 w-[110px] text-xs" />
              )}
              <Input type="date" value={completedDate} onChange={(e) => setCompletedDate(e.target.value)}
                className="h-8 w-[140px] text-xs" />
              {completedDate && (
                <Button size="sm" variant="ghost" className="h-8 w-8 p-0 text-gray-400 hover:text-red-500"
                  onClick={() => setCompletedDate("")}>
                  <X className="h-3.5 w-3.5" />
                </Button>
              )}
              {completedDate !== todayStr && (
                <Button size="sm" variant="ghost" className="h-8 px-2 text-xs text-gray-500 hover:text-[#001d6e]"
                  onClick={() => setCompletedDate(todayStr)}>
                  Today
                </Button>
              )}
              <Button size="sm" variant="outline" className="h-8 w-8 p-0"
                onClick={() => scanSessionsQuery.refetch()} disabled={scanSessionsQuery.isFetching}>
                <RefreshCw className={`h-3.5 w-3.5 ${scanSessionsQuery.isFetching ? "animate-spin" : ""}`} />
              </Button>
            </div>
          </CardHeader>
          {showCompleted && (
            <CardContent className="p-0">
              {scanSessionsQuery.isFetching && completedScanSessions.length === 0 ? (
                <div className="flex justify-center py-10">
                  <Loader2 className="h-6 w-6 animate-spin text-green-600" />
                </div>
              ) : completedScanSessions.length === 0 ? (
                <div className="flex flex-col items-center justify-center py-10 text-gray-400">
                  <CheckCircle2 className="h-8 w-8 mb-2 opacity-20" />
                  <p className="text-sm text-center">
                    No completed sessions{completedPlant ? ` for ${completedPlant}` : ""}
                    {completedDate ? ` on ${completedDate === todayStr ? "today" : completedDate}` : " in the last 48 hours"}.
                  </p>
                </div>
              ) : (
                <div className="divide-y">
                  {completedScanSessions.map((s) => (
                    <div key={s.id} className="px-4 py-3 hover:bg-gray-50">
                      <div className="flex items-start gap-2">
                        <div className="flex-1 min-w-0">
                          <p className="truncate text-sm font-medium text-gray-900">{s.csvFileName}</p>
                          <div className="mt-0.5 flex flex-wrap items-center gap-x-1.5 gap-y-0.5">
                            <span className="rounded bg-green-100 px-1.5 py-0.5 text-[10px] font-semibold text-green-700 uppercase">{s.plant}</span>
                            <span className="text-xs text-gray-400">{fmtIST(s.createdAt)}</span>
                            {s.importedByName && <span className="text-xs text-gray-400">· {s.importedByName}</span>}
                            {s.scanCompletedAt && (
                              <span className="text-xs text-green-700 font-medium">· Done {fmtIST(s.scanCompletedAt)}</span>
                            )}
                            {s.scanActivatedByName && (
                              <span className="text-xs text-gray-400">· Scanned by {s.scanActivatedByName}</span>
                            )}
                          </div>
                        </div>
                        <div className="flex shrink-0 items-center gap-1 ml-1">
                          <Badge className="bg-green-100 text-green-700 hover:bg-green-100 text-xs px-1.5">
                            {s.rowCount}
                          </Badge>
                          <span className="inline-flex items-center gap-1 rounded-full bg-green-100 px-2 py-0.5 text-xs font-semibold text-green-700">
                            <CheckCircle2 className="h-3 w-3" />
                            Done
                          </span>
                        </div>
                      </div>
                    </div>
                  ))}
                </div>
              )}
            </CardContent>
          )}
        </Card>
        )}{/* end isImportRole */}

      </div>{/* end max-w-6xl */}

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

              {/* Detected columns chip list */}
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

              {/* Mapping selectors */}
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

              {/* Preview table */}
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
                              <td
                                key={f.key}
                                className={`max-w-[180px] truncate whitespace-nowrap border-r px-3 py-2 ${val ? "" : "text-gray-300"}`}
                                title={val}
                              >
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
            <Button
              variant="outline"
              onClick={() => { setShowMappingDialog(false); setEditTargetSession(null); }}
              disabled={importMutation.isPending || updateMutation.isPending}
            >
              Cancel
            </Button>
            <Button
              onClick={handleConfirmImport}
              disabled={importMutation.isPending || updateMutation.isPending || !csvData}
              className="bg-[#001d6e] hover:bg-[#00154b] text-white"
            >
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
              <Input
                ref={editFileRef}
                type="file"
                accept=".csv"
                className="h-10"
                onChange={(e) => { const f = e.target.files?.[0]; if (f) setEditFile(f); }}
              />
              {editFile && <p className="text-xs text-gray-500">{editFile.name} ({Math.max(1, Math.round(editFile.size / 1024))} KB)</p>}
            </div>
          </div>
          <DialogFooter className="gap-2">
            <Button variant="outline" onClick={() => { setShowEditDialog(false); setEditTargetSession(null); setEditFile(null); }}>
              Cancel
            </Button>
            <Button
              disabled={!editFile || updateMutation.isPending}
              className="bg-[#001d6e] hover:bg-[#00154b] text-white"
              onClick={() => { if (editFile) parseAndReplace(editFile); }}
            >
              {updateMutation.isPending
                ? <Loader2 className="mr-1.5 h-4 w-4 animate-spin" />
                : <Upload className="mr-1.5 h-4 w-4" />}
              Replace Data
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* ── Deactivate confirmation ── */}
      <AlertDialog
        open={deactivateTarget !== null}
        onOpenChange={(open) => { if (!open) setDeactivateTarget(null); }}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Deactivate this session?</AlertDialogTitle>
            <AlertDialogDescription>
              This releases the active lock so another session can be loaded. Scan progress is preserved — you can re-activate this session later.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction
              className="bg-amber-600 text-white hover:bg-amber-700"
              onClick={() => deactivateTarget !== null && deactivateMutation.mutate(deactivateTarget)}
              disabled={deactivateMutation.isPending}
            >
              {deactivateMutation.isPending ? <Loader2 className="h-4 w-4 animate-spin" /> : "Deactivate"}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      {/* ── Complete confirmation ── */}
      <AlertDialog
        open={completeTarget !== null}
        onOpenChange={(open) => { if (!open) setCompleteTarget(null); }}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Mark session as completed?</AlertDialogTitle>
            <AlertDialogDescription>
              This marks the scan session as done. It will no longer be available for scanning.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction
              className="bg-green-600 text-white hover:bg-green-700"
              onClick={() => completeTarget !== null && completeMutation.mutate(completeTarget)}
              disabled={completeMutation.isPending}
            >
              {completeMutation.isPending ? <Loader2 className="h-4 w-4 animate-spin" /> : "Complete"}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      {/* ── Delete confirmation ── */}
      <AlertDialog
        open={deleteTarget !== null}
        onOpenChange={(open) => { if (!open) setDeleteTarget(null); }}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Delete this import session?</AlertDialogTitle>
            <AlertDialogDescription>
              All rows in this session will be permanently deleted. This cannot be undone.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction
              className="bg-red-600 text-white hover:bg-red-700"
              onClick={() => deleteTarget !== null && deleteMutation.mutate(deleteTarget)}
              disabled={deleteMutation.isPending}
            >
              {deleteMutation.isPending
                ? <Loader2 className="h-4 w-4 animate-spin" />
                : "Delete"}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </main>
  );
}