import { useMemo, useRef, useState } from "react";
import { useMutation, useQuery } from "@tanstack/react-query";
import Papa from "papaparse";
import {
  AlertTriangle,
  Bell,
  CheckCircle2,
  CloudDownload,
  Database,
  Eye,
  FileUp,
  Loader2,
  PackagePlus,
  RefreshCw,
  Search,
  X,
  Zap,
} from "lucide-react";
import PageHeader from "@/components/PageHeader";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
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
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { useToast } from "@/hooks/use-toast";
import { apiRequest, queryClient } from "@/lib/queryClient";
import { Product } from "@shared/schema";

type SyncStatus = {
  isSyncing: boolean;
  lastSyncTime: string | null;
  configured: boolean;
  hasPendingChanges: boolean;
  pendingCount: number;
  pendingDetectedAt: string | null;
};

type FieldChange = {
  field: string;
  label: string;
  oldValue: string | number | null | undefined;
  newValue: string | number | null | undefined;
};

type ProductChange = {
  productId: number;
  productName: string;
  barcode: string;
  srNo: string | null;
  changes: FieldChange[];
};

type SyncReport = {
  syncTime: string;
  total: number;
  created: number;
  updated: number;
  skipped: number;
  notFound: number;
  remainingCreated?: number;
  remainingUpdated?: number;
  changedProducts: ProductChange[];
  createdProducts: Array<{
    productName: string;
    barcode: string;
    notionPageId: string;
  }>;
  errors: string[];
};

type PendingResponse = {
  hasPending: boolean;
  report: SyncReport | null;
};

type ProductColumn = {
  key: keyof Product;
  label: string;
  tone?: "gj" | "mp" | "up";
  stickyLeft?: number;
  colWidth?: number;
};

const productColumns: ProductColumn[] = [
  { key: "newSr",  label: "New Sr.",       colWidth: 65  },
  { key: "srNo",   label: "Sr. No.",       colWidth: 70  },
  { key: "barcode",label: "SKU",           colWidth: 105 },
  { key: "name",   label: "Products Name", stickyLeft: 0, colWidth: 210 },
  { key: "notionWiseName", label: "Notion Wise Name" },
  { key: "brand", label: "Brand" },
  { key: "category", label: "Category" },
  { key: "saleCategory", label: "Sale Category" },
  { key: "plant", label: "Plant" },
  { key: "type", label: "Type" },
  { key: "productImage", label: "Product Image" },
  { key: "volumeInCuFt", label: "Vol Master" },
  { key: "itemsPerPallet", label: "Packets" },
  { key: "indPlt", label: "IND PLT" },
  { key: "valPlt", label: "VAL PLT" },
  { key: "gjSr", label: "GJ Sr", tone: "gj" },
  { key: "gjHsn", label: "GJ HSN", tone: "gj" },
  { key: "gjSap", label: "GJ SAP", tone: "gj" },
  { key: "gjSaleRate", label: "GJ Sale Rate", tone: "gj" },
  { key: "gjIgst", label: "GJ IGST", tone: "gj" },
  { key: "gjGaPur", label: "GJ-GA PUR", tone: "gj" },
  { key: "gjMhPur", label: "GJ-MH PUR", tone: "gj" },
  { key: "gjNagarPur", label: "GJ-NAGAR PUR", tone: "gj" },
  { key: "forGjOrderForm", label: "For GJ Order Form", tone: "gj" },
  { key: "mpSr", label: "MP Sr", tone: "mp" },
  { key: "mpHsn", label: "MP HSN", tone: "mp" },
  { key: "mpSap", label: "MP SAP", tone: "mp" },
  { key: "mpJhPur", label: "MP-JH PUR", tone: "mp" },
  { key: "mpMhPur", label: "MP-MH PUR", tone: "mp" },
  { key: "mpMpPurJabalpur", label: "MP-MP Jabalpur", tone: "mp" },
  { key: "mpMpPurKhargone", label: "MP-MP Khargone", tone: "mp" },
  { key: "mpWbPur", label: "MP-WB PUR", tone: "mp" },
  { key: "saleMpJh", label: "Sale MP-JH", tone: "mp" },
  { key: "saleMpMh", label: "Sale MP-MH", tone: "mp" },
  { key: "saleMpMp", label: "Sale MP-MP", tone: "mp" },
  { key: "mpJhIgst", label: "MP-JH IGST", tone: "mp" },
  { key: "mpMhIgst", label: "MP-MH IGST", tone: "mp" },
  { key: "mpMpCgst", label: "MP-MP CGST", tone: "mp" },
  { key: "mpMpSgst", label: "MP-MP SGST", tone: "mp" },
  { key: "mpWbIgst", label: "MP-WB IGST", tone: "mp" },
  { key: "mpWbSale", label: "MP-WB Sale", tone: "mp" },
  { key: "forMpOrderForm", label: "For MP Order Form", tone: "mp" },
  { key: "upSr", label: "UP Sr", tone: "up" },
  { key: "upHsn", label: "UP HSN", tone: "up" },
  { key: "upSap", label: "UP SAP", tone: "up" },
  { key: "upRate", label: "UP Rate", tone: "up" },
  { key: "upIgst", label: "UP IGST", tone: "up" },
  { key: "forUpOrderForm", label: "For UP Order Form", tone: "up" },
  { key: "lastChangedBy", label: "Changed By" },
  { key: "lastUpdated", label: "Last Updated" },
];

function cellValue(product: Product, key: keyof Product) {
  const value = product[key];
  if (value === null || value === undefined || value === "") return "-";
  if (key === "lastUpdated" || key === "createdAt" || key === "updatedAt") {
    return new Date(value as string | Date).toLocaleString();
  }
  return String(value);
}

function toneClass(tone?: ProductColumn["tone"]) {
  if (tone === "gj") return "bg-sky-50";
  if (tone === "mp") return "bg-emerald-50";
  if (tone === "up") return "bg-amber-50";
  return "bg-white";
}

function toneHeaderClass(tone?: ProductColumn["tone"]) {
  if (tone === "gj") return "bg-sky-100 text-sky-800";
  if (tone === "mp") return "bg-emerald-100 text-emerald-800";
  if (tone === "up") return "bg-amber-100 text-amber-800";
  return "bg-slate-100 text-[#001d6e]";
}

export default function NotionInventory() {
  const { toast } = useToast();
  const [searchTerm, setSearchTerm] = useState("");
  const [showFullSyncConfirm, setShowFullSyncConfirm] = useState(false);
  const [lastApplyReport, setLastApplyReport] = useState<SyncReport | null>(null);
  const [showReviewDialog, setShowReviewDialog] = useState(false);

  // CSV import state
  const fileInputRef = useRef<HTMLInputElement>(null);
  const [csvPreview, setCsvPreview] = useState<{
    rows: Record<string, string>[];
    headers: string[];
    fileName: string;
  } | null>(null);
  const [showCsvDialog, setShowCsvDialog] = useState(false);

  const productsQuery = useQuery({
    queryKey: ["/api/products", { all: "true" }],
    queryFn: async (): Promise<Product[]> => {
      const response = await apiRequest("GET", "/api/products?all=true");
      return response.json();
    },
    staleTime: 5000,
    refetchOnWindowFocus: true,
  });

  const statusQuery = useQuery({
    queryKey: ["/api/notion-inventory-sync/status"],
    queryFn: async (): Promise<SyncStatus> => {
      const response = await apiRequest("GET", "/api/notion-inventory-sync/status");
      return response.json();
    },
    refetchInterval: 10000,
    refetchOnWindowFocus: true,
  });

  const pendingQuery = useQuery({
    queryKey: ["/api/notion-inventory-sync/pending"],
    queryFn: async (): Promise<PendingResponse> => {
      const response = await apiRequest("GET", "/api/notion-inventory-sync/pending");
      return response.json();
    },
    refetchInterval: 10000,
    refetchOnWindowFocus: true,
  });

  const fullSyncMutation = useMutation({
    mutationFn: async () => {
      const response = await apiRequest("POST", "/api/notion-inventory-sync/full-sync");
      return response.json();
    },
    onSuccess: async (data) => {
      setShowFullSyncConfirm(false);
      await queryClient.invalidateQueries({ queryKey: ["/api/products"] });
      await queryClient.invalidateQueries({ queryKey: ["/api/notion-inventory-sync/status"] });
      toast({
        title: "Notion import complete",
        description: `${data.created ?? 0} products imported into PostgreSQL.`,
        className: "bg-green-50 border-green-200 text-green-900",
      });
    },
    onError: (error: any) => {
      setShowFullSyncConfirm(false);
      toast({
        title: "Notion import failed",
        description: error.message || "Could not import product master from Notion.",
        variant: "destructive",
      });
    },
  });

  const detectMutation = useMutation({
    mutationFn: async () => {
      const response = await apiRequest("POST", "/api/notion-inventory-sync/detect");
      return response.json();
    },
    onSuccess: async (data) => {
      setLastApplyReport(null);
      await queryClient.invalidateQueries({ queryKey: ["/api/notion-inventory-sync/status"] });
      await queryClient.invalidateQueries({ queryKey: ["/api/notion-inventory-sync/pending"] });
      const total = (data.created ?? 0) + (data.updated ?? 0);
      if (total > 0) setShowReviewDialog(true);
      toast({
        title: "Notion changes detected",
        description: `${data.created ?? 0} new and ${data.updated ?? 0} changed products found.`,
      });
    },
    onError: (error: any) => {
      toast({
        title: "Detection failed",
        description: error.message || "Could not check Notion changes.",
        variant: "destructive",
      });
    },
  });

  const applyMutation = useMutation({
    mutationFn: async () => {
      const response = await apiRequest("POST", "/api/notion-inventory-sync/apply");
      return response.json();
    },
    onSuccess: async (data) => {
      setLastApplyReport(data);
      setShowReviewDialog(false);
      await queryClient.invalidateQueries({ queryKey: ["/api/products"] });
      await queryClient.invalidateQueries({ queryKey: ["/api/notion-inventory-sync/status"] });
      await queryClient.invalidateQueries({ queryKey: ["/api/notion-inventory-sync/pending"] });
      toast({
        title: data.remainingCreated || data.remainingUpdated ? "Applied, but still different" : "Pending changes applied",
        description: data.remainingCreated || data.remainingUpdated
          ? `${data.remainingCreated ?? 0} new and ${data.remainingUpdated ?? 0} changed still remain.`
          : `${data.created ?? 0} created and ${data.updated ?? 0} updated.`,
        className: data.remainingCreated || data.remainingUpdated
          ? "bg-amber-50 border-amber-200 text-amber-900"
          : "bg-green-50 border-green-200 text-green-900",
      });
    },
    onError: (error: any) => {
      toast({
        title: "Apply failed",
        description: error.message || "Could not apply pending Notion changes.",
        variant: "destructive",
      });
    },
  });

  const csvImportMutation = useMutation({
    mutationFn: async (rows: Record<string, string>[]) => {
      const response = await apiRequest("POST", "/api/products/csv-import", { rows });
      return response.json();
    },
    onSuccess: async (data) => {
      setShowCsvDialog(false);
      setCsvPreview(null);
      await queryClient.invalidateQueries({ queryKey: ["/api/products"] });
      toast({
        title: "CSV import complete",
        description: `${data.created ?? 0} created, ${data.updated ?? 0} updated, ${data.skipped ?? 0} skipped.`,
        className: "bg-green-50 border-green-200 text-green-900",
      });
    },
    onError: (error: any) => {
      toast({
        title: "CSV import failed",
        description: error.message || "Could not import CSV data.",
        variant: "destructive",
      });
    },
  });

  function handleCsvFile(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    if (!file) return;
    Papa.parse<Record<string, string>>(file, {
      header: true,
      skipEmptyLines: true,
      complete: (result) => {
        setCsvPreview({
          rows: result.data,
          headers: result.meta.fields ?? [],
          fileName: file.name,
        });
        setShowCsvDialog(true);
      },
      error: () => {
        toast({ title: "Failed to parse CSV", variant: "destructive" });
      },
    });
    e.target.value = "";
  }

  const products = productsQuery.data ?? [];
  const linkedCount = products.filter((p) => p.notionPageId).length;
  const filteredProducts = useMemo(() => {
    const query = searchTerm.trim().toLowerCase();
    if (!query) return products;
    return products.filter((product) =>
      productColumns.some((col) => cellValue(product, col.key).toLowerCase().includes(query))
    );
  }, [products, searchTerm]);

  const isBusy =
    fullSyncMutation.isPending ||
    detectMutation.isPending ||
    applyMutation.isPending ||
    Boolean(statusQuery.data?.isSyncing);

  const pendingReport = pendingQuery.data?.report ?? null;
  const reportToShow = pendingReport ?? lastApplyReport;
  const isPending = !!pendingReport && ((pendingReport.created ?? 0) + (pendingReport.updated ?? 0)) > 0;
  const isConfigured = statusQuery.data?.configured ?? false;

  return (
    <div className="container mx-auto px-4 py-6 pb-24">
      <PageHeader
        icon={Database}
        title="Notion Inventory"
        description="Product master synced from Notion into PostgreSQL."
      />

      {/* Stats row */}
      <div className="mb-4 grid gap-3 sm:grid-cols-2 md:grid-cols-4">
        <div className="rounded-lg border border-[#001d6e]/10 bg-white p-4 shadow-sm">
          <div className="text-xs font-medium uppercase tracking-wide text-muted-foreground">Total Products</div>
          <div className="mt-1 text-3xl font-bold text-[#001d6e]">{products.length}</div>
          <div className="mt-1 text-xs text-muted-foreground">in database</div>
        </div>
        <div className="rounded-lg border border-[#001d6e]/10 bg-white p-4 shadow-sm">
          <div className="text-xs font-medium uppercase tracking-wide text-muted-foreground">Linked to Notion</div>
          <div className="mt-1 text-3xl font-bold text-emerald-600">{linkedCount}</div>
          <div className="mt-1 text-xs text-muted-foreground">
            {products.length > 0 ? Math.round((linkedCount / products.length) * 100) : 0}% synced
          </div>
        </div>
        <div className="rounded-lg border border-[#001d6e]/10 bg-white p-4 shadow-sm">
          <div className="text-xs font-medium uppercase tracking-wide text-muted-foreground">Pending Changes</div>
          <div className={`mt-1 text-3xl font-bold ${(statusQuery.data?.pendingCount ?? 0) > 0 ? "text-amber-600" : "text-gray-400"}`}>
            {statusQuery.data?.pendingCount ?? 0}
          </div>
          {statusQuery.data?.pendingDetectedAt ? (
            <div className="mt-1 text-xs text-muted-foreground">
              Detected {new Date(statusQuery.data.pendingDetectedAt).toLocaleTimeString()}
            </div>
          ) : (
            <div className="mt-1 text-xs text-muted-foreground">no pending changes</div>
          )}
        </div>
        <div className="rounded-lg border border-[#001d6e]/10 bg-white p-4 shadow-sm">
          <div className="text-xs font-medium uppercase tracking-wide text-muted-foreground">Notion Config</div>
          <div className="mt-2">
            {isConfigured ? (
              <Badge className="bg-emerald-100 text-emerald-800 hover:bg-emerald-100 px-2 py-1">
                <CheckCircle2 className="mr-1.5 h-3.5 w-3.5" />
                Connected
              </Badge>
            ) : (
              <Badge variant="destructive" className="px-2 py-1">
                <AlertTriangle className="mr-1.5 h-3.5 w-3.5" />
                Not configured
              </Badge>
            )}
          </div>
          {statusQuery.data?.lastSyncTime ? (
            <div className="mt-2 text-xs text-muted-foreground">
              Last sync {new Date(statusQuery.data.lastSyncTime).toLocaleDateString()}
            </div>
          ) : (
            <div className="mt-2 text-xs text-muted-foreground">never synced</div>
          )}
        </div>
      </div>

      {/* Action bar */}
      <div className="mb-4 flex flex-col gap-3 rounded-lg border border-[#001d6e]/10 bg-white p-4 shadow-sm lg:flex-row lg:items-center lg:justify-between">
        <div className="relative w-full lg:max-w-sm">
          <Search className="absolute left-3 top-2.5 h-4 w-4 text-muted-foreground" />
          <Input
            value={searchTerm}
            onChange={(e) => setSearchTerm(e.target.value)}
            placeholder="Search products..."
            className="pl-9 border-[#001d6e]/20 focus-visible:ring-[#001d6e]/30"
          />
        </div>

        <div className="flex flex-wrap gap-2">
          <Button
            variant="outline"
            size="sm"
            onClick={() => productsQuery.refetch()}
            disabled={productsQuery.isFetching}
            className="border-[#001d6e]/20 text-[#001d6e] hover:bg-[#001d6e]/5"
          >
            <RefreshCw className={`mr-1.5 h-4 w-4 ${productsQuery.isFetching ? "animate-spin" : ""}`} />
            Refresh
          </Button>
          <Button
            variant="outline"
            size="sm"
            onClick={() => detectMutation.mutate()}
            disabled={isBusy || !isConfigured}
            className="border-[#001d6e]/20 text-[#001d6e] hover:bg-[#001d6e]/5"
          >
            {detectMutation.isPending
              ? <Loader2 className="mr-1.5 h-4 w-4 animate-spin" />
              : <CloudDownload className="mr-1.5 h-4 w-4" />}
            Check Notion
          </Button>
          {isPending && (
            <Button
              size="sm"
              variant="outline"
              onClick={() => setShowReviewDialog(true)}
              className="border-amber-400 bg-amber-50 text-amber-700 hover:bg-amber-100 flex items-center gap-1"
            >
              <Bell className="h-4 w-4" />
              Review Changes
              <Badge className="ml-1 bg-amber-500 text-white px-1.5 py-0 text-xs">
                {(pendingReport?.created ?? 0) + (pendingReport?.updated ?? 0)}
              </Badge>
            </Button>
          )}
          <Button
            size="sm"
            onClick={() => applyMutation.mutate()}
            disabled={isBusy || !statusQuery.data?.hasPendingChanges}
            className="bg-amber-500 text-white hover:bg-amber-600"
          >
            {applyMutation.isPending
              ? <Loader2 className="mr-1.5 h-4 w-4 animate-spin" />
              : <Zap className="mr-1.5 h-4 w-4" />}
            Apply {statusQuery.data?.pendingCount ? `(${statusQuery.data.pendingCount})` : "Pending"}
          </Button>
          {products.length === 0 && (
            <Button
              size="sm"
              onClick={() => setShowFullSyncConfirm(true)}
              disabled={isBusy || !isConfigured}
              className="bg-[#001d6e] text-white hover:bg-[#001552]"
            >
              {fullSyncMutation.isPending
                ? <Loader2 className="mr-1.5 h-4 w-4 animate-spin" />
                : <Database className="mr-1.5 h-4 w-4" />}
              First Sync
            </Button>
          )}
          <input
            ref={fileInputRef}
            type="file"
            accept=".csv"
            className="hidden"
            onChange={handleCsvFile}
          />
          <Button
            size="sm"
            variant="outline"
            onClick={() => fileInputRef.current?.click()}
            disabled={csvImportMutation.isPending}
            className="border-emerald-400 bg-emerald-50 text-emerald-700 hover:bg-emerald-100"
          >
            {csvImportMutation.isPending
              ? <Loader2 className="mr-1.5 h-4 w-4 animate-spin" />
              : <FileUp className="mr-1.5 h-4 w-4" />}
            Import CSV
          </Button>
        </div>
      </div>

      {/* Last apply result banner — shown only after applying (not for pending, handled by action bar button) */}
      {lastApplyReport && !isPending && (
        <div className="mb-4 flex items-center gap-3 rounded-lg border border-emerald-200 bg-emerald-50 px-4 py-3 shadow-sm">
          <CheckCircle2 className="h-4 w-4 shrink-0 text-emerald-600" />
          <div className="flex min-w-0 flex-1 flex-wrap items-center gap-x-3 gap-y-1">
            <span className="text-sm font-semibold text-emerald-900">Changes Applied</span>
            <div className="flex flex-wrap gap-1.5">
              {(lastApplyReport.created ?? 0) > 0 && (
                <Badge className="bg-[#001d6e]/10 text-[#001d6e] hover:bg-[#001d6e]/10 px-1.5 text-xs">
                  <PackagePlus className="mr-1 h-3 w-3" />
                  {lastApplyReport.created} created
                </Badge>
              )}
              {(lastApplyReport.updated ?? 0) > 0 && (
                <Badge className="bg-emerald-100 text-emerald-800 hover:bg-emerald-100 px-1.5 text-xs">
                  {lastApplyReport.updated} updated
                </Badge>
              )}
            </div>
            <span className="text-xs text-muted-foreground">
              {new Date(lastApplyReport.syncTime).toLocaleString()}
            </span>
          </div>
          <div className="flex shrink-0 items-center gap-2">
            <Button
              size="sm"
              variant="outline"
              onClick={() => setShowReviewDialog(true)}
              className="h-7 px-3 text-xs border-emerald-300 text-emerald-800 hover:bg-emerald-100"
            >
              <Eye className="mr-1.5 h-3.5 w-3.5" />
              View Report
            </Button>
            <Button
              size="sm"
              variant="ghost"
              onClick={() => setLastApplyReport(null)}
              className="h-7 w-7 p-0 text-muted-foreground hover:text-foreground"
              title="Dismiss"
            >
              <X className="h-3.5 w-3.5" />
            </Button>
          </div>
        </div>
      )}

      {/* Product table */}
      <div className="rounded-lg border border-[#001d6e]/10 bg-white shadow-sm">
        <div className="flex items-center justify-between border-b border-[#001d6e]/10 bg-[#001d6e]/[0.03] px-5 py-3 rounded-t-lg">
          <div className="text-2xl font-bold text-[#001d6e]">Product Master</div>
          <div className="flex items-center gap-3">
            {searchTerm && (
              <span className="text-xs text-muted-foreground">
                {filteredProducts.length} of {products.length}
              </span>
            )}
            <Badge variant="outline" className="border-[#001d6e]/20 text-[#001d6e] text-xs">
              {filteredProducts.length} rows
            </Badge>
          </div>
        </div>

        {/* Not configured empty state */}
        {!productsQuery.isLoading && !isConfigured && products.length === 0 && (
          <div className="flex flex-col items-center justify-center py-20 text-center">
            <div className="mb-4 flex h-16 w-16 items-center justify-center rounded-full bg-[#001d6e]/10">
              <Database className="h-8 w-8 text-[#001d6e]/40" />
            </div>
            <div className="mb-1 text-base font-semibold text-[#001d6e]">Notion not connected</div>
            <div className="mb-4 max-w-xs text-sm text-muted-foreground">
              Set the <code className="rounded bg-gray-100 px-1 text-xs">NOTION_INVENTORY_DATABASE_ID</code> environment variable to connect your Notion database.
            </div>
          </div>
        )}

        {/* Configured but no products yet */}
        {!productsQuery.isLoading && isConfigured && products.length === 0 && (
          <div className="flex flex-col items-center justify-center py-20 text-center">
            <div className="mb-4 flex h-16 w-16 items-center justify-center rounded-full bg-[#001d6e]/10">
              <Database className="h-8 w-8 text-[#001d6e]/40" />
            </div>
            <div className="mb-1 text-base font-semibold text-[#001d6e]">No products imported yet</div>
            <div className="mb-5 max-w-xs text-sm text-muted-foreground">
              Run <strong>First Sync</strong> to import your full product master from Notion into the database.
            </div>
            <Button
              size="sm"
              onClick={() => setShowFullSyncConfirm(true)}
              disabled={isBusy}
              className="bg-[#001d6e] text-white hover:bg-[#001552]"
            >
              {fullSyncMutation.isPending
                ? <Loader2 className="mr-1.5 h-4 w-4 animate-spin" />
                : <Database className="mr-1.5 h-4 w-4" />}
              Run First Sync
            </Button>
          </div>
        )}

        {/* Table — only show when there are products */}
        {(productsQuery.isLoading || products.length > 0) && (
          <div className="overflow-x-auto overflow-y-auto max-h-[calc(100vh-220px)] min-h-[400px] rounded-b-lg">
            <table className="w-max min-w-full caption-bottom text-xs border-collapse">
              <thead>
                <tr>
                  {productColumns.map((col) => {
                    const isNameCol = col.key === "name";
                    return (
                      <th
                        key={col.key}
                        style={{ minWidth: col.colWidth ? `${col.colWidth}px` : "110px" }}
                        className={`sticky top-0 ${isNameCol ? "md:left-0 md:z-20 z-10" : "z-10"} whitespace-nowrap border-r border-b-2 border-b-gray-300 px-2.5 py-2 text-left text-xs font-semibold ${toneHeaderClass(col.tone)}`}
                      >
                        {col.label}
                      </th>
                    );
                  })}
                </tr>
              </thead>
              <tbody>
                {productsQuery.isLoading ? (
                  <tr>
                    <td colSpan={productColumns.length} className="h-40 text-center text-muted-foreground">
                      <Loader2 className="mx-auto mb-2 h-6 w-6 animate-spin text-[#001d6e]" />
                      <div className="text-sm">Loading product master…</div>
                    </td>
                  </tr>
                ) : filteredProducts.length === 0 ? (
                  <tr>
                    <td colSpan={productColumns.length} className="h-32 text-center text-muted-foreground">
                      <Search className="mx-auto mb-2 h-5 w-5 opacity-30" />
                      <div className="text-sm">No products match your search.</div>
                    </td>
                  </tr>
                ) : (
                  filteredProducts.map((product, i) => (
                    <tr
                      key={product.id}
                      className={`border-b hover:bg-[#001d6e]/[0.02] ${i % 2 === 0 ? "" : "bg-gray-50/40"}`}
                    >
                      {productColumns.map((col) => {
                        const isNameCol = col.key === "name";
                        return (
                          <td
                            key={`${product.id}-${col.key}`}
                            style={{ minWidth: col.colWidth ? `${col.colWidth}px` : "110px" }}
                            className={`border-r px-2.5 py-1.5 text-xs ${isNameCol ? "md:sticky md:left-0 md:z-[5] whitespace-normal break-words leading-tight" : "whitespace-nowrap max-w-[180px] truncate"} ${toneClass(col.tone)}`}
                            title={cellValue(product, col.key)}
                          >
                            {cellValue(product, col.key)}
                          </td>
                        );
                      })}
                    </tr>
                  ))
                )}
              </tbody>
            </table>
          </div>
        )}
      </div>

      {/* Review dialog — Inventory-style with stat boxes + flat changes table */}
      <Dialog open={showReviewDialog} onOpenChange={setShowReviewDialog}>
        <DialogContent className="max-w-3xl max-h-[80vh] flex flex-col">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2">
              <Bell className="h-5 w-5 text-amber-500" />
              {isPending ? "Review Pending Notion Changes" : "Last Apply Result"}
            </DialogTitle>
            <DialogDescription>
              {reportToShow?.syncTime
                ? `${isPending ? "Detected" : "Applied"} on ${new Date(reportToShow.syncTime).toLocaleString()}${isPending ? " — review before applying" : ""}`
                : "Changes detected from Notion. Review and confirm before applying."}
            </DialogDescription>
          </DialogHeader>

          {reportToShow && (
            <div className="flex flex-col gap-4 overflow-hidden">
              {/* Summary stat boxes */}
              <div className="flex flex-wrap gap-3">
                {(reportToShow.created ?? 0) > 0 && (
                  <div className="flex flex-col items-center px-4 py-2 bg-purple-50 border border-purple-200 rounded-lg">
                    <span className="text-2xl font-bold text-purple-700">{reportToShow.created}</span>
                    <span className="text-xs text-purple-600">To Create</span>
                  </div>
                )}
                <div className="flex flex-col items-center px-4 py-2 bg-amber-50 border border-amber-200 rounded-lg">
                  <span className="text-2xl font-bold text-amber-700">{reportToShow.updated}</span>
                  <span className="text-xs text-amber-600">To Update</span>
                </div>
                <div className="flex flex-col items-center px-4 py-2 bg-gray-50 border border-gray-200 rounded-lg">
                  <span className="text-2xl font-bold text-gray-600">{reportToShow.skipped}</span>
                  <span className="text-xs text-gray-500">No Change</span>
                </div>
                <div className="flex flex-col items-center px-4 py-2 bg-yellow-50 border border-yellow-200 rounded-lg">
                  <span className="text-2xl font-bold text-yellow-700">{reportToShow.notFound}</span>
                  <span className="text-xs text-yellow-600">Unmatched</span>
                </div>
                <div className="flex flex-col items-center px-4 py-2 bg-blue-50 border border-blue-200 rounded-lg">
                  <span className="text-2xl font-bold text-blue-700">{reportToShow.total}</span>
                  <span className="text-xs text-blue-600">Total Pages</span>
                </div>
                {(reportToShow.errors?.length ?? 0) > 0 && (
                  <div className="flex flex-col items-center px-4 py-2 bg-red-50 border border-red-200 rounded-lg">
                    <span className="text-2xl font-bold text-red-700">{reportToShow.errors.length}</span>
                    <span className="text-xs text-red-600">Errors</span>
                  </div>
                )}
              </div>

              {/* New products list (compact) */}
              {(reportToShow.createdProducts?.length ?? 0) > 0 && (
                <div className="border rounded-md overflow-y-auto max-h-40">
                  <div className="bg-purple-50 px-3 py-1.5 text-xs font-semibold text-purple-700 border-b">
                    New products to add ({reportToShow.createdProducts.length})
                  </div>
                  {reportToShow.createdProducts.map((cp) => (
                    <div key={cp.notionPageId} className="flex items-center gap-2 px-3 py-1.5 text-xs border-b last:border-0">
                      <PackagePlus className="h-3.5 w-3.5 shrink-0 text-purple-500" />
                      <span className="font-medium">{cp.productName}</span>
                      <span className="text-muted-foreground">·</span>
                      <span className="text-muted-foreground">{cp.barcode}</span>
                    </div>
                  ))}
                </div>
              )}

              {/* Changed products flat table */}
              {(reportToShow.changedProducts?.length ?? 0) > 0 ? (
                <div className="overflow-y-auto flex-1 border rounded-md">
                  <Table>
                    <TableHeader>
                      <TableRow className="bg-muted/50">
                        <TableHead className="w-[220px] min-w-[220px]">Product</TableHead>
                        <TableHead className="w-[90px] min-w-[90px]">SKU</TableHead>
                        <TableHead>Proposed Changes</TableHead>
                      </TableRow>
                    </TableHeader>
                    <TableBody>
                      {reportToShow.changedProducts.map((pc) => (
                        <TableRow key={pc.productId}>
                          <TableCell className="font-medium text-xs align-top py-2.5 break-words whitespace-normal leading-tight" title={pc.productName}>
                            {pc.productName}
                          </TableCell>
                          <TableCell className="text-xs text-muted-foreground align-top py-2.5">
                            {pc.barcode || pc.srNo || "—"}
                          </TableCell>
                          <TableCell className="align-top py-2.5">
                            <div className="flex flex-col gap-1">
                              {pc.changes.map((ch, i) => (
                                <div key={i} className="flex items-start gap-1 text-xs">
                                  <span className="font-medium text-muted-foreground min-w-[100px]">{ch.label}:</span>
                                  <span
                                    className="line-through text-red-500 max-w-[130px] truncate"
                                    title={String(ch.oldValue ?? "—")}
                                  >
                                    {ch.oldValue != null && ch.oldValue !== "" ? String(ch.oldValue) : "—"}
                                  </span>
                                  <span className="text-gray-400 mx-1">→</span>
                                  <span
                                    className="text-green-700 font-medium max-w-[130px] truncate"
                                    title={String(ch.newValue)}
                                  >
                                    {String(ch.newValue)}
                                  </span>
                                </div>
                              ))}
                            </div>
                          </TableCell>
                        </TableRow>
                      ))}
                    </TableBody>
                  </Table>
                </div>
              ) : (
                <div className="flex flex-col items-center justify-center py-10 text-muted-foreground">
                  <CheckCircle2 className="h-10 w-10 mb-2 text-green-400" />
                  <p className="text-sm">No field changes detected.</p>
                  <p className="text-xs mt-1">Products already match Notion data.</p>
                </div>
              )}

              {/* Errors section */}
              {(reportToShow.errors?.length ?? 0) > 0 && (
                <div className="bg-red-50 border border-red-200 rounded-md p-3">
                  <p className="text-xs font-semibold text-red-700 mb-1">
                    Errors ({reportToShow.errors.length})
                  </p>
                  {reportToShow.errors.slice(0, 5).map((err, i) => (
                    <p key={i} className="text-xs text-red-600">{err}</p>
                  ))}
                  {reportToShow.errors.length > 5 && (
                    <p className="text-xs text-red-400 mt-1">...and {reportToShow.errors.length - 5} more</p>
                  )}
                </div>
              )}
            </div>
          )}

          <DialogFooter>
            <Button variant="outline" onClick={() => setShowReviewDialog(false)}>
              Dismiss
            </Button>
            {isPending && (
              <Button
                onClick={() => applyMutation.mutate()}
                disabled={isBusy || (!(reportToShow?.updated) && !(reportToShow?.created))}
                className="flex items-center gap-1 bg-amber-600 hover:bg-amber-700 text-white"
              >
                {applyMutation.isPending ? (
                  <><Loader2 className="h-4 w-4 animate-spin" /> Applying...</>
                ) : (
                  <><Zap className="h-4 w-4" />
                    Apply ({reportToShow?.created ?? 0} new + {reportToShow?.updated ?? 0} changed)
                  </>
                )}
              </Button>
            )}
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* CSV import preview dialog */}
      <Dialog open={showCsvDialog} onOpenChange={(open) => { setShowCsvDialog(open); if (!open) setCsvPreview(null); }}>
        <DialogContent className="max-w-2xl max-h-[80vh] flex flex-col">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2">
              <FileUp className="h-5 w-5 text-emerald-600" />
              Import CSV
            </DialogTitle>
            <DialogDescription>
              {csvPreview
                ? `"${csvPreview.fileName}" — ${csvPreview.rows.length} rows, ${csvPreview.headers.length} columns detected`
                : "Review before importing"}
            </DialogDescription>
          </DialogHeader>

          {csvPreview && (
            <div className="flex flex-col gap-4 overflow-hidden flex-1 min-h-0">
              {/* Stats */}
              <div className="flex flex-wrap gap-3">
                <div className="flex flex-col items-center px-4 py-2 bg-emerald-50 border border-emerald-200 rounded-lg">
                  <span className="text-2xl font-bold text-emerald-700">{csvPreview.rows.length}</span>
                  <span className="text-xs text-emerald-600">Rows</span>
                </div>
                <div className="flex flex-col items-center px-4 py-2 bg-blue-50 border border-blue-200 rounded-lg">
                  <span className="text-2xl font-bold text-blue-700">{csvPreview.headers.length}</span>
                  <span className="text-xs text-blue-600">Columns</span>
                </div>
              </div>

              {/* Column headers detected */}
              <div className="rounded-md border bg-gray-50 px-3 py-2">
                <p className="text-xs font-semibold text-gray-500 mb-1.5">Detected columns</p>
                <div className="flex flex-wrap gap-1">
                  {csvPreview.headers.map((h) => (
                    <span key={h} className="rounded bg-white border px-2 py-0.5 text-xs text-gray-700">{h}</span>
                  ))}
                </div>
              </div>

              {/* Preview first 5 rows */}
              <div className="overflow-auto flex-1 border rounded-md">
                <table className="w-max min-w-full text-xs border-collapse">
                  <thead>
                    <tr>
                      {csvPreview.headers.slice(0, 6).map((h) => (
                        <th key={h} className="sticky top-0 bg-gray-100 px-3 py-2 text-left font-semibold border-r border-b whitespace-nowrap">{h}</th>
                      ))}
                      {csvPreview.headers.length > 6 && (
                        <th className="sticky top-0 bg-gray-100 px-3 py-2 text-left font-semibold border-b text-gray-400">+{csvPreview.headers.length - 6} more</th>
                      )}
                    </tr>
                  </thead>
                  <tbody>
                    {csvPreview.rows.slice(0, 5).map((row, i) => (
                      <tr key={i} className="border-b hover:bg-gray-50">
                        {csvPreview.headers.slice(0, 6).map((h) => (
                          <td key={h} className="px-3 py-1.5 border-r whitespace-nowrap max-w-[160px] truncate" title={row[h]}>{row[h] || "—"}</td>
                        ))}
                        {csvPreview.headers.length > 6 && <td className="px-3 py-1.5 text-gray-400">…</td>}
                      </tr>
                    ))}
                  </tbody>
                </table>
                {csvPreview.rows.length > 5 && (
                  <p className="px-3 py-2 text-xs text-muted-foreground border-t">
                    …and {csvPreview.rows.length - 5} more rows
                  </p>
                )}
              </div>
            </div>
          )}

          <DialogFooter>
            <Button variant="outline" onClick={() => { setShowCsvDialog(false); setCsvPreview(null); }}>
              Cancel
            </Button>
            <Button
              onClick={() => csvPreview && csvImportMutation.mutate(csvPreview.rows)}
              disabled={csvImportMutation.isPending || !csvPreview}
              className="bg-emerald-600 hover:bg-emerald-700 text-white"
            >
              {csvImportMutation.isPending
                ? <><Loader2 className="mr-1.5 h-4 w-4 animate-spin" />Importing…</>
                : <><FileUp className="mr-1.5 h-4 w-4" />Import {csvPreview?.rows.length ?? 0} rows</>}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* First sync confirmation */}
      <AlertDialog open={showFullSyncConfirm} onOpenChange={setShowFullSyncConfirm}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle className="text-[#001d6e]">First sync from Notion?</AlertDialogTitle>
            <AlertDialogDescription>
              This clears the current product inventory table and imports the full Notion product master into PostgreSQL with Notion page IDs. This action cannot be undone.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction
              onClick={() => fullSyncMutation.mutate()}
              className="bg-[#001d6e] text-white hover:bg-[#001552]"
            >
              {fullSyncMutation.isPending ? (
                <>
                  <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                  Syncing…
                </>
              ) : (
                "Start First Sync"
              )}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}
