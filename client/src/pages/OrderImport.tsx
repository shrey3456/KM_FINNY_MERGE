import { useRef, useState } from "react";
import { useLocation } from "wouter";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import Papa from "papaparse";
import {
  AlertCircle,
  CheckCircle,
  CheckCircle2,
  ChevronDown,
  ChevronRight,
  FileUp,
  Loader2,
  PackageCheck,
  RefreshCw,
  ScanLine,
  Search,
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
  scanStatus: string; importedByName: string | null;
  scanActivatedByName: string | null; scanActivatedAt: string | null; scanCompletedAt: string | null;
};

export default function OrderImport() {
  const { toast } = useToast();
  const qc = useQueryClient();
  const fileRef = useRef<HTMLInputElement>(null);
  const [, navigate] = useLocation();
  const { user } = useAuth();
  const role = ((user as any)?.role ?? "").toLowerCase();
  const isImportRole = ["admin", "super-admin", "billing"].includes(role);

  // Form state
  const [plant, setPlant] = useState("");
  const [orderDate, setOrderDate] = useState(new Date().toISOString().split("T")[0]);
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
  const [expandedId, setExpandedId] = useState<number | null>(null);
  const [itemSearch, setItemSearch] = useState("");
  const [deleteTarget, setDeleteTarget] = useState<number | null>(null);
  const [lastImport, setLastImport] = useState<{ rowCount: number } | null>(null);

  // Server-side pagination + date filters (default to today)
  const todayStr = new Date().toISOString().split("T")[0];
  const [pageSize, setPageSize] = useState(10);
  const [currentPage, setCurrentPage] = useState(1);
  const [dateFrom, setDateFrom] = useState(todayStr);
  const [dateTo, setDateTo] = useState(todayStr);

  // ── Queries ────────────────────────────────────────────────────────────────
  type SessionsResponse = {
    sessions: (OrderImportSession & { importedByName: string | null })[];
    total: number;
    page: number;
    pageSize: number;
    totalPages: number;
  };

  const sessionsQuery = useQuery<SessionsResponse>({
    queryKey: ["/api/order-import/sessions", currentPage, pageSize, dateFrom, dateTo],
    queryFn: async () => {
      const params = new URLSearchParams({
        page: String(currentPage),
        pageSize: String(pageSize),
      });
      if (dateFrom) params.set("dateFrom", dateFrom);
      if (dateTo)   params.set("dateTo",   dateTo);
      return (await apiRequest("GET", `/api/order-import/sessions?${params}`)).json();
    },
  });

  const itemsQuery = useQuery<OrderImportItem[]>({
    queryKey: ["/api/order-import/sessions", expandedId, "items"],
    queryFn: async () =>
      (await apiRequest("GET", `/api/order-import/sessions/${expandedId}/items`)).json(),
    enabled: expandedId !== null,
  });

  const plantsQuery = useQuery<{ name: string }[]>({
    queryKey: ["/api/plants"],
    queryFn: async () => (await apiRequest("GET", "/api/plants")).json(),
  });

  // Today's sessions for the "Load for Scan" panel (billing/admin/super-admin only)
  const scanSessionsQuery = useQuery<ScanSession[]>({
    queryKey: ["/api/order-scan/sessions"],
    queryFn: async () => (await apiRequest("GET", "/api/order-scan/sessions")).json(),
    enabled: isImportRole,
    refetchInterval: 20000,
  });

  // ── Mutations ──────────────────────────────────────────────────────────────
  const importMutation = useMutation({
    mutationFn: async (payload: {
      plant: string;
      csvFileName: string;
      items: object[];
    }) => (await apiRequest("POST", "/api/order-import/sessions", payload)).json(),
    onSuccess: (data) => {
      setShowMappingDialog(false);
      setCsvData(null);
      setSelectedFile(null);
      setLastImport({ rowCount: data.rowCount });
      setCurrentPage(1);
      qc.invalidateQueries({ queryKey: ["/api/order-import/sessions"] });
      toast({
        title: "Import complete",
        description: `${data.rowCount} rows imported.`,
        className: "bg-green-50 border-green-200 text-green-900",
      });
    },
    onError: (err: any) =>
      toast({ title: "Import failed", description: err.message, variant: "destructive" }),
  });

  const loadForScanMutation = useMutation({
    mutationFn: async (id: number) =>
      (await apiRequest("POST", `/api/order-scan/sessions/${id}/activate`)).json(),
    onSuccess: () => navigate("/order-scan"),
    onError: (err: any) =>
      toast({ title: "Cannot load for scan", description: err.message, variant: "destructive" }),
  });

  const deleteMutation = useMutation({
    mutationFn: async (id: number) =>
      (await apiRequest("DELETE", `/api/order-import/sessions/${id}`)).json(),
    onSuccess: (_, id) => {
      setDeleteTarget(null);
      if (expandedId === id) setExpandedId(null);
      qc.invalidateQueries({ queryKey: ["/api/order-import/sessions"] });
      qc.invalidateQueries({ queryKey: ["/api/order-scan/sessions"] });
      toast({ title: "Session deleted" });
    },
    onError: (err: any) =>
      toast({ title: "Delete failed", description: err.message, variant: "destructive" }),
  });

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
    importMutation.mutate({ plant, csvFileName: csvData.name, items });
  }

  function clearForm() {
    setSelectedFile(null);
    setLastImport(null);
    setOrderDate(new Date().toISOString().split("T")[0]);
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

  return (
    <main className="min-h-screen bg-gray-50 p-4 sm:p-6 lg:p-8">
      {/* ── Header ── */}
      <div className="mx-auto max-w-7xl space-y-6">
        <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
          <div className="flex items-center gap-3">
            <div className="flex h-11 w-11 items-center justify-center rounded-md bg-[#001d6e] text-white">
              <FileUp className="h-6 w-6" />
            </div>
            <div>
              <h1 className="text-2xl font-semibold text-gray-950">Order Import</h1>
              <p className="text-sm text-gray-600">
                Upload a CSV, map columns to the fixed schema, and import order rows.
              </p>
            </div>
          </div>
          <Button
            variant="outline"
            onClick={() => sessionsQuery.refetch()}
            disabled={sessionsQuery.isFetching}
          >
            <RefreshCw className={`mr-2 h-4 w-4 ${sessionsQuery.isFetching ? "animate-spin" : ""}`} />
            Refresh
          </Button>
        </div>

        {/* ── Two-column layout ── */}
        <div className="grid gap-6 xl:grid-cols-[420px_1fr]">
          {/* Left: upload card */}
          <Card className="rounded-md">
            <CardHeader>
              <CardTitle className="text-lg">Upload CSV File</CardTitle>
            </CardHeader>
            <CardContent className="space-y-5">
              {/* Plant */}
              <div className="grid gap-2">
                <Label htmlFor="oi-plant">Plant</Label>
                {plantOptions.length > 0 ? (
                  <Select value={plant || "_none_"} onValueChange={(v) => setPlant(v === "_none_" ? "" : v)}>
                    <SelectTrigger id="oi-plant" className="w-full">
                      <SelectValue placeholder="Select plant…" />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="_none_">— Select plant —</SelectItem>
                      {plantOptions.map((p) => (
                        <SelectItem key={p.name} value={p.name}>{p.name}</SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                ) : (
                  <Input
                    id="oi-plant"
                    value={plant}
                    onChange={(e) => setPlant(e.target.value)}
                    placeholder="e.g. Valsad"
                  />
                )}
              </div>

              {/* Order Date */}
              <div className="grid gap-2">
                <Label htmlFor="oi-date">Order Date</Label>
                <Input
                  id="oi-date"
                  type="date"
                  value={orderDate}
                  onChange={(e) => setOrderDate(e.target.value)}
                />
              </div>

              {/* File input */}
              <div className="grid gap-2">
                <Label htmlFor="oi-file">CSV File</Label>
                <Input
                  ref={fileRef}
                  id="oi-file"
                  type="file"
                  accept=".csv"
                  onChange={handleFileChange}
                  disabled={importMutation.isPending}
                />
                {selectedFile && (
                  <p className="text-sm text-gray-600">
                    {selectedFile.name} ({Math.max(1, Math.round(selectedFile.size / 1024))} KB)
                  </p>
                )}
              </div>

              {/* Success */}
              {lastImport && (
                <Alert className="border-green-200 bg-green-50 text-green-900">
                  <CheckCircle className="h-4 w-4 text-green-700" />
                  <AlertDescription>
                    Successfully imported <strong>{lastImport.rowCount}</strong> rows.
                  </AlertDescription>
                </Alert>
              )}

              {/* Error */}
              {importMutation.isError && (
                <Alert variant="destructive">
                  <AlertCircle className="h-4 w-4" />
                  <AlertDescription>{(importMutation.error as Error).message}</AlertDescription>
                </Alert>
              )}

              {/* Actions */}
              <div className="flex justify-end gap-2">
                <Button
                  variant="outline"
                  onClick={clearForm}
                  disabled={!selectedFile || importMutation.isPending}
                >
                  Clear
                </Button>
                <Button
                  onClick={handleImportClick}
                  disabled={!selectedFile || !plant.trim() || importMutation.isPending}
                  className="bg-[#001d6e] hover:bg-[#00154b] text-white"
                >
                  {importMutation.isPending ? (
                    <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                  ) : (
                    <Upload className="mr-2 h-4 w-4" />
                  )}
                  Map &amp; Import
                </Button>
              </div>

              {/* Fixed schema info */}
              <div className="rounded-md border border-dashed bg-gray-50 px-4 py-3">
                <p className="mb-2 text-xs font-semibold text-gray-500 uppercase tracking-wide">Target columns</p>
                <div className="flex flex-wrap gap-1.5">
                  {TARGET_FIELDS.map((f) => (
                    <span key={f.key} className="rounded bg-[#001d6e]/10 px-2 py-0.5 text-xs font-medium text-[#001d6e]">
                      {f.label}
                    </span>
                  ))}
                </div>
              </div>
            </CardContent>
          </Card>

          {/* Right: import history */}
          <Card className="rounded-md">
            <CardHeader className="pb-3 space-y-3">
              <div className="flex items-center justify-between">
                <div>
                  <CardTitle className="text-lg">Import History</CardTitle>
                  <p className="text-xs text-gray-500 mt-0.5">{totalSessions} total sessions</p>
                </div>
                {/* Page size selector */}
                <div className="flex items-center gap-2">
                  <span className="text-xs text-gray-500">Show</span>
                  <Select
                    value={String(pageSize)}
                    onValueChange={(v) => { setPageSize(Number(v)); setCurrentPage(1); }}
                  >
                    <SelectTrigger className="h-8 w-[70px] text-xs">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="10">10</SelectItem>
                      <SelectItem value="25">25</SelectItem>
                      <SelectItem value="50">50</SelectItem>
                    </SelectContent>
                  </Select>
                  <span className="text-xs text-gray-500">per page</span>
                </div>
              </div>

              {/* Date filters */}
              <div className="flex flex-wrap items-center gap-2">
                <div className="flex items-center gap-1.5">
                  <Label className="text-xs text-gray-500 whitespace-nowrap">From</Label>
                  <Input
                    type="date"
                    value={dateFrom}
                    onChange={(e) => { setDateFrom(e.target.value); setCurrentPage(1); }}
                    className="h-8 w-[140px] text-xs"
                  />
                </div>
                <div className="flex items-center gap-1.5">
                  <Label className="text-xs text-gray-500 whitespace-nowrap">To</Label>
                  <Input
                    type="date"
                    value={dateTo}
                    onChange={(e) => { setDateTo(e.target.value); setCurrentPage(1); }}
                    className="h-8 w-[140px] text-xs"
                  />
                </div>
                {(dateFrom || dateTo) && (
                  <Button
                    size="sm"
                    variant="ghost"
                    className="h-8 px-2 text-xs text-gray-500 hover:text-red-600"
                    onClick={() => { setDateFrom(""); setDateTo(""); setCurrentPage(1); }}
                  >
                    <X className="mr-1 h-3 w-3" /> Clear
                  </Button>
                )}
                {sessionsQuery.isFetching && (
                  <Loader2 className="h-3.5 w-3.5 animate-spin text-gray-400" />
                )}
              </div>
            </CardHeader>
            <CardContent className="p-0">
              {sessionsQuery.isLoading ? (
                <div className="flex items-center justify-center py-16">
                  <Loader2 className="h-6 w-6 animate-spin text-[#001d6e]" />
                </div>
              ) : sessions.length === 0 ? (
                <div className="flex flex-col items-center justify-center py-16 text-muted-foreground">
                  <FileUp className="h-10 w-10 mb-2 opacity-20" />
                  <p className="text-sm">{dateFrom || dateTo ? "No sessions match the selected dates." : "No imports yet."}</p>
                </div>
              ) : (
                <>
                  <div className="divide-y">
                    {sessions.map((session) => {
                      const importerName = (session as any).importedByName || session.importedByCode || "Unknown";
                      return (
                        <div key={session.id}>
                          {/* Session header row */}
                          <div
                            className="flex cursor-pointer items-center gap-3 px-5 py-3 hover:bg-gray-50"
                            onClick={() => {
                              setExpandedId(expandedId === session.id ? null : session.id);
                              setItemSearch("");
                            }}
                          >
                            <span className="shrink-0 text-gray-400">
                              {expandedId === session.id
                                ? <ChevronDown className="h-4 w-4" />
                                : <ChevronRight className="h-4 w-4" />}
                            </span>
                            <div className="flex-1 min-w-0">
                              <p className="truncate text-sm font-medium text-gray-900">
                                {session.csvFileName}
                              </p>
                              <div className="flex flex-wrap items-center gap-x-2 gap-y-0.5 mt-0.5">
                                <span className="text-xs text-gray-500">{session.plant}</span>
                                <span className="text-xs text-gray-300">·</span>
                                <span className="text-xs text-gray-500">
                                  {new Date(session.createdAt!).toLocaleString()}
                                </span>
                                <span className="text-xs text-gray-300">·</span>
                                <span className="inline-flex items-center gap-1 text-xs text-[#001d6e] font-medium">
                                  <svg className="h-3 w-3" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                                    <circle cx="12" cy="8" r="4"/><path d="M4 20c0-4 3.6-7 8-7s8 3 8 7"/>
                                  </svg>
                                  {importerName}
                                </span>
                              </div>
                            </div>
                            <Badge className="shrink-0 bg-[#001d6e]/10 text-[#001d6e] hover:bg-[#001d6e]/10 text-xs">
                              {session.rowCount} rows
                            </Badge>
                            {(session as any).scanStatus !== "completed" && (
                              <Button
                                size="sm"
                                variant="ghost"
                                title="Load for scanning"
                                className="h-7 w-7 shrink-0 p-0 text-gray-400 hover:text-[#001d6e]"
                                disabled={loadForScanMutation.isPending}
                                onClick={(e) => { e.stopPropagation(); loadForScanMutation.mutate(session.id); }}
                              >
                                {loadForScanMutation.isPending
                                  ? <Loader2 className="h-3.5 w-3.5 animate-spin" />
                                  : <ScanLine className="h-3.5 w-3.5" />}
                              </Button>
                            )}
                            <Button
                              size="sm"
                              variant="ghost"
                              className="h-7 w-7 shrink-0 p-0 text-gray-400 hover:text-red-600"
                              onClick={(e) => { e.stopPropagation(); setDeleteTarget(session.id); }}
                            >
                              <Trash2 className="h-3.5 w-3.5" />
                            </Button>
                          </div>

                          {/* Expanded rows */}
                          {expandedId === session.id && (
                            <div className="border-t bg-gray-50/60 px-5 py-4">
                              <div className="mb-3 flex items-center gap-2">
                                <div className="relative flex-1 max-w-xs">
                                  <Search className="absolute left-3 top-2.5 h-3.5 w-3.5 text-gray-400" />
                                  <Input
                                    value={itemSearch}
                                    onChange={(e) => setItemSearch(e.target.value)}
                                    placeholder="Search rows…"
                                    className="pl-8 h-8 text-sm"
                                  />
                                </div>
                                {itemSearch && (
                                  <Button size="sm" variant="ghost" className="h-8 w-8 p-0"
                                    onClick={() => setItemSearch("")}>
                                    <X className="h-3.5 w-3.5" />
                                  </Button>
                                )}
                                <span className="ml-auto text-xs text-gray-500">
                                  {filteredItems.length} of {allItems.length}
                                </span>
                              </div>

                              {itemsQuery.isLoading ? (
                                <div className="flex justify-center py-6">
                                  <Loader2 className="h-5 w-5 animate-spin text-[#001d6e]" />
                                </div>
                              ) : (
                                <div className="overflow-x-auto rounded-md border">
                                  <table className="w-max min-w-full border-collapse text-sm">
                                    <thead>
                                      <tr>
                                        {["#", "Barcode", "Item Name", "SAP Code", "Qty", "Exp. Pallets", "Date"].map((h) => (
                                          <th key={h} className="sticky top-0 whitespace-nowrap border-b border-r bg-slate-100 px-3 py-2 text-left text-xs font-semibold text-[#001d6e]">
                                            {h}
                                          </th>
                                        ))}
                                      </tr>
                                    </thead>
                                    <tbody>
                                      {filteredItems.map((item, idx) => (
                                        <tr key={item.id} className={`border-b ${idx % 2 === 1 ? "bg-gray-50" : "bg-white"} hover:bg-blue-50/30`}>
                                          <td className="border-r px-3 py-1.5 text-xs text-gray-400">{idx + 1}</td>
                                          <td className="border-r px-3 py-1.5 text-xs">{item.barcode || "—"}</td>
                                          <td className="max-w-[240px] truncate border-r px-3 py-1.5 text-xs" title={item.itemName ?? ""}>{item.itemName || "—"}</td>
                                          <td className="border-r px-3 py-1.5 text-xs">{item.sapCode || "—"}</td>
                                          <td className="border-r px-3 py-1.5 text-right text-xs">{item.quantity ?? 0}</td>
                                          <td className="border-r px-3 py-1.5 text-right text-xs">{item.expectedPallets ?? "—"}</td>
                                          <td className="px-3 py-1.5 text-xs">{(item as any).date || "—"}</td>
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

                  {/* Pagination controls */}
                  {totalPages > 1 && (
                    <div className="flex items-center justify-between border-t px-5 py-3">
                      <span className="text-xs text-gray-500">
                        Page {safePage} of {totalPages} &nbsp;·&nbsp; {totalSessions} sessions
                      </span>
                      <div className="flex items-center gap-1">
                        <Button
                          size="sm"
                          variant="outline"
                          className="h-7 px-2 text-xs"
                          disabled={safePage <= 1}
                          onClick={() => setCurrentPage(safePage - 1)}
                        >
                          ← Prev
                        </Button>
                        {Array.from({ length: totalPages }, (_, i) => i + 1)
                          .filter((p) => p === 1 || p === totalPages || Math.abs(p - safePage) <= 1)
                          .reduce<(number | "…")[]>((acc, p, i, arr) => {
                            if (i > 0 && (p as number) - (arr[i - 1] as number) > 1) acc.push("…");
                            acc.push(p);
                            return acc;
                          }, [])
                          .map((p, i) =>
                            p === "…" ? (
                              <span key={`e${i}`} className="px-1 text-xs text-gray-400">…</span>
                            ) : (
                              <Button
                                key={p}
                                size="sm"
                                variant={p === safePage ? "default" : "outline"}
                                className={`h-7 w-7 p-0 text-xs ${p === safePage ? "bg-[#001d6e] text-white" : ""}`}
                                onClick={() => setCurrentPage(p as number)}
                              >
                                {p}
                              </Button>
                            )
                          )}
                        <Button
                          size="sm"
                          variant="outline"
                          className="h-7 px-2 text-xs"
                          disabled={safePage >= totalPages}
                          onClick={() => setCurrentPage(safePage + 1)}
                        >
                          Next →
                        </Button>
                      </div>
                    </div>
                  )}
                </>
              )}
            </CardContent>
          </Card>
        </div>{/* end two-column grid */}

        {/* ── Load CSV for Scan — full width ── */}
        {isImportRole && (
          <Card className="rounded-md">
            <CardHeader className="pb-3">
              <div className="flex items-center justify-between">
                <div className="flex items-center gap-2">
                  <div className="flex h-8 w-8 items-center justify-center rounded bg-[#001d6e]/10">
                    <PackageCheck className="h-4 w-4 text-[#001d6e]" />
                  </div>
                  <div>
                    <CardTitle className="text-base">Load CSV for Scan</CardTitle>
                    <p className="text-xs text-gray-500 mt-0.5">
                      Select a session and load it so dispatch staff can scan against it
                    </p>
                  </div>
                </div>
                <Button
                  size="sm" variant="outline"
                  onClick={() => scanSessionsQuery.refetch()}
                  disabled={scanSessionsQuery.isFetching}
                >
                  <RefreshCw className={`mr-1.5 h-3.5 w-3.5 ${scanSessionsQuery.isFetching ? "animate-spin" : ""}`} />
                  Refresh
                </Button>
              </div>
            </CardHeader>
            <CardContent className="pt-0">
              {scanSessionsQuery.isLoading ? (
                <div className="flex justify-center py-10">
                  <Loader2 className="h-6 w-6 animate-spin text-[#001d6e]" />
                </div>
              ) : (scanSessionsQuery.data ?? []).length === 0 ? (
                <div className="flex flex-col items-center justify-center py-10 text-gray-400">
                  <ScanLine className="h-8 w-8 mb-2 opacity-30" />
                  <p className="text-sm">No sessions found for today. Import a CSV first.</p>
                </div>
              ) : (
                <div className="divide-y rounded-md border overflow-hidden">
                  {(scanSessionsQuery.data ?? []).map((s) => {
                    const isActive    = s.scanStatus === "active";
                    const isCompleted = s.scanStatus === "completed";
                    const canLoad     = !isCompleted;
                    return (
                      <div
                        key={s.id}
                        className={`flex items-center gap-4 px-4 py-3 ${
                          isActive    ? "bg-amber-50/40" :
                          isCompleted ? "bg-green-50/30 opacity-75" :
                                        "bg-white hover:bg-gray-50"
                        }`}
                      >
                        {/* Status dot */}
                        <span className={`h-2.5 w-2.5 shrink-0 rounded-full ${
                          isActive ? "bg-amber-400 animate-pulse" :
                          isCompleted ? "bg-green-400" : "bg-gray-300"
                        }`} />

                        {/* File + meta */}
                        <div className="flex-1 min-w-0">
                          <p className="truncate text-sm font-medium text-gray-900">{s.csvFileName}</p>
                          <div className="flex flex-wrap items-center gap-x-2 gap-y-0.5 mt-0.5">
                            <span className="rounded bg-[#001d6e]/10 px-1.5 py-0.5 text-[10px] font-semibold text-[#001d6e] uppercase">{s.plant}</span>
                            <span className="text-xs text-gray-400">{s.rowCount} rows</span>
                            {s.importedByName && (
                              <span className="text-xs text-gray-400">· {s.importedByName}</span>
                            )}
                            {isActive && s.scanActivatedByName && (
                              <span className="text-xs text-amber-700 font-medium">· Scanning: {s.scanActivatedByName}</span>
                            )}
                            {isCompleted && s.scanCompletedAt && (
                              <span className="text-xs text-green-700 font-medium">
                                · Done {new Date(s.scanCompletedAt).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}
                              </span>
                            )}
                          </div>
                        </div>

                        {/* Status badge */}
                        <div className="shrink-0">
                          {isCompleted ? (
                            <span className="inline-flex items-center gap-1 rounded-full bg-green-100 px-2.5 py-1 text-xs font-semibold text-green-700">
                              <CheckCircle2 className="h-3 w-3" /> Done
                            </span>
                          ) : isActive ? (
                            <span className="inline-flex items-center gap-1 rounded-full bg-amber-100 px-2.5 py-1 text-xs font-semibold text-amber-700">
                              <ScanLine className="h-3 w-3" /> Active
                            </span>
                          ) : (
                            <span className="rounded-full bg-gray-100 px-2.5 py-1 text-xs font-semibold text-gray-500">
                              Available
                            </span>
                          )}
                        </div>

                        {/* Action buttons */}
                        <div className="flex shrink-0 items-center gap-2">
                          {canLoad && (
                            <Button
                              size="sm"
                              className={`text-xs ${
                                isActive
                                  ? "bg-amber-600 hover:bg-amber-700 text-white"
                                  : "bg-[#001d6e] hover:bg-[#00154b] text-white"
                              }`}
                              disabled={loadForScanMutation.isPending}
                              onClick={() => loadForScanMutation.mutate(s.id)}
                            >
                              {loadForScanMutation.isPending
                                ? <Loader2 className="mr-1.5 h-3.5 w-3.5 animate-spin" />
                                : <ScanLine className="mr-1.5 h-3.5 w-3.5" />}
                              {isActive ? "View Scan" : "Load for Scan"}
                            </Button>
                          )}
                          <Button
                            size="sm"
                            variant="ghost"
                            className="h-8 w-8 p-0 text-gray-400 hover:text-red-600"
                            onClick={() => setDeleteTarget(s.id)}
                          >
                            <Trash2 className="h-3.5 w-3.5" />
                          </Button>
                        </div>
                      </div>
                    );
                  })}
                </div>
              )}
            </CardContent>
          </Card>
        )}
      </div>{/* end max-w-7xl */}

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
              onClick={() => setShowMappingDialog(false)}
              disabled={importMutation.isPending}
            >
              Cancel
            </Button>
            <Button
              onClick={handleConfirmImport}
              disabled={importMutation.isPending || !csvData}
              className="bg-[#001d6e] hover:bg-[#00154b] text-white"
            >
              {importMutation.isPending ? (
                <><Loader2 className="mr-1.5 h-4 w-4 animate-spin" />Importing…</>
              ) : (
                <><Upload className="mr-1.5 h-4 w-4" />Import {csvData?.rows.length ?? 0} rows</>
              )}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

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
