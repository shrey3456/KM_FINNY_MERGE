import { useMemo, useState } from "react";
import { useMutation, useQuery } from "@tanstack/react-query";
import {
  AlertTriangle,
  ArrowRight,
  Bell,
  CheckCircle2,
  CloudDownload,
  Database,
  Eye,
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
};

const productColumns: ProductColumn[] = [
  { key: "newSr", label: "New Sr." },
  { key: "srNo", label: "Sr. No." },
  { key: "barcode", label: "SKU" },
  { key: "name", label: "Products Name" },
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
  return "bg-[#001d6e]/5 text-[#001d6e]";
}

export default function NotionInventory() {
  const { toast } = useToast();
  const [searchTerm, setSearchTerm] = useState("");
  const [showFullSyncConfirm, setShowFullSyncConfirm] = useState(false);
  const [lastApplyReport, setLastApplyReport] = useState<SyncReport | null>(null);
  const [expandedProduct, setExpandedProduct] = useState<number | null>(null);
  const [showReviewDialog, setShowReviewDialog] = useState(false);

  const productsQuery = useQuery({
    queryKey: ["/api/products", { all: "true" }],
    queryFn: async (): Promise<Product[]> => {
      const response = await apiRequest("GET", "/api/products?all=true");
      return response.json();
    },
    staleTime: 15000,
  });

  const statusQuery = useQuery({
    queryKey: ["/api/notion-inventory-sync/status"],
    queryFn: async (): Promise<SyncStatus> => {
      const response = await apiRequest("GET", "/api/notion-inventory-sync/status");
      return response.json();
    },
    refetchInterval: 30000,
  });

  const pendingQuery = useQuery({
    queryKey: ["/api/notion-inventory-sync/pending"],
    queryFn: async (): Promise<PendingResponse> => {
      const response = await apiRequest("GET", "/api/notion-inventory-sync/pending");
      return response.json();
    },
    refetchInterval: 30000,
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
      setExpandedProduct(null);
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
      setExpandedProduct(null);
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
        </div>
      </div>

      {/* Compact changes banner */}
      {reportToShow && (
        <div className={`mb-4 flex items-center gap-3 rounded-lg border px-4 py-3 shadow-sm ${
          isPending ? "border-amber-200 bg-amber-50" : "border-emerald-200 bg-emerald-50"
        }`}>
          <Bell className={`h-4 w-4 shrink-0 ${isPending ? "text-amber-500" : "text-emerald-600"}`} />
          <div className="flex min-w-0 flex-1 flex-wrap items-center gap-x-3 gap-y-1">
            <span className={`text-sm font-semibold ${isPending ? "text-amber-900" : "text-emerald-900"}`}>
              {isPending ? "Pending Changes from Notion" : "Last Apply Result"}
            </span>
            <div className="flex flex-wrap gap-1.5">
              {(reportToShow.created ?? 0) > 0 && (
                <Badge className="bg-[#001d6e]/10 text-[#001d6e] hover:bg-[#001d6e]/10 px-1.5 text-xs">
                  <PackagePlus className="mr-1 h-3 w-3" />
                  {reportToShow.created} new
                </Badge>
              )}
              {(reportToShow.updated ?? 0) > 0 && (
                <Badge className="bg-amber-100 text-amber-800 hover:bg-amber-100 px-1.5 text-xs">
                  {reportToShow.updated} changed
                </Badge>
              )}
              {(reportToShow.skipped ?? 0) > 0 && (
                <Badge variant="outline" className="px-1.5 text-xs">{reportToShow.skipped} unchanged</Badge>
              )}
            </div>
            <span className="text-xs text-muted-foreground">
              {new Date(reportToShow.syncTime).toLocaleString()}
            </span>
          </div>
          <div className="flex shrink-0 items-center gap-2">
            <Button
              size="sm"
              variant="outline"
              onClick={() => setShowReviewDialog(true)}
              className={`h-7 px-3 text-xs ${
                isPending
                  ? "border-amber-300 text-amber-800 hover:bg-amber-100"
                  : "border-emerald-300 text-emerald-800 hover:bg-emerald-100"
              }`}
            >
              <Eye className="mr-1.5 h-3.5 w-3.5" />
              Review
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
      <div className="rounded-lg border border-[#001d6e]/10 bg-white shadow-sm overflow-hidden">
        <div className="flex items-center justify-between border-b border-[#001d6e]/10 bg-[#001d6e]/[0.03] px-5 py-3">
          <div className="font-semibold text-[#001d6e]">Product Master</div>
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
          <div className="max-h-[68vh] overflow-auto">
            <Table>
              <TableHeader className="sticky top-0 z-10">
                <TableRow>
                  {productColumns.map((col) => (
                    <TableHead
                      key={col.key}
                      className={`min-w-[130px] whitespace-nowrap border-r text-xs font-semibold ${toneHeaderClass(col.tone)}`}
                    >
                      {col.label}
                    </TableHead>
                  ))}
                </TableRow>
              </TableHeader>
              <TableBody>
                {productsQuery.isLoading ? (
                  <TableRow>
                    <TableCell colSpan={productColumns.length} className="h-40 text-center text-muted-foreground">
                      <Loader2 className="mx-auto mb-2 h-6 w-6 animate-spin text-[#001d6e]" />
                      <div className="text-sm">Loading product master…</div>
                    </TableCell>
                  </TableRow>
                ) : filteredProducts.length === 0 ? (
                  <TableRow>
                    <TableCell colSpan={productColumns.length} className="h-32 text-center text-muted-foreground">
                      <Search className="mx-auto mb-2 h-5 w-5 opacity-30" />
                      <div className="text-sm">No products match your search.</div>
                    </TableCell>
                  </TableRow>
                ) : (
                  filteredProducts.map((product) => (
                    <TableRow key={product.id} className="hover:bg-[#001d6e]/[0.02]">
                      {productColumns.map((col) => (
                        <TableCell
                          key={`${product.id}-${col.key}`}
                          className={`max-w-[220px] truncate whitespace-nowrap border-r text-xs ${toneClass(col.tone)}`}
                          title={cellValue(product, col.key)}
                        >
                          {cellValue(product, col.key)}
                        </TableCell>
                      ))}
                    </TableRow>
                  ))
                )}
              </TableBody>
            </Table>
          </div>
        )}
      </div>

      {/* Review dialog — centered modal */}
      <Dialog open={showReviewDialog} onOpenChange={setShowReviewDialog}>
        <DialogContent className="flex max-h-[90vh] w-full max-w-3xl flex-col gap-0 overflow-hidden p-0">
          {/* Dialog header */}
          <DialogHeader className="border-b border-[#001d6e]/10 bg-[#001d6e]/[0.03] px-6 py-4">
            <div className="flex items-center justify-between">
              <DialogTitle className="flex items-center gap-2 text-[#001d6e]">
                <Bell className="h-4 w-4 text-amber-500" />
                {isPending ? "Pending Changes from Notion" : "Last Apply Result"}
              </DialogTitle>
              {reportToShow && (
                <span className="text-xs text-muted-foreground">
                  {new Date(reportToShow.syncTime).toLocaleString()}
                </span>
              )}
            </div>
            {reportToShow && (
              <div className="flex flex-wrap items-center gap-2 pt-2">
                <Badge className="bg-[#001d6e]/10 text-[#001d6e] hover:bg-[#001d6e]/10">
                  <PackagePlus className="mr-1 h-3 w-3" />
                  {reportToShow.created} new
                </Badge>
                <Badge className="bg-amber-100 text-amber-800 hover:bg-amber-100">
                  {reportToShow.updated} changed
                </Badge>
                <Badge variant="outline">{reportToShow.skipped} unchanged</Badge>
                <Badge variant="outline">{reportToShow.total} checked</Badge>
                {isPending && (
                  <Button
                    size="sm"
                    onClick={() => applyMutation.mutate()}
                    disabled={isBusy}
                    className="ml-auto h-7 bg-[#001d6e] px-3 text-xs text-white hover:bg-[#001552]"
                  >
                    {applyMutation.isPending
                      ? <Loader2 className="mr-1.5 h-3.5 w-3.5 animate-spin" />
                      : <Zap className="mr-1.5 h-3.5 w-3.5" />}
                    Apply All
                  </Button>
                )}
              </div>
            )}
          </DialogHeader>

          {/* Scrollable body */}
          {reportToShow && (
            <div className="flex-1 divide-y overflow-y-auto">
              {/* New products */}
              <div className="p-5">
                <div className="mb-3 flex items-center gap-2">
                  <div className="h-2 w-2 rounded-full bg-[#001d6e]" />
                  <span className="text-sm font-semibold text-[#001d6e]">New Products</span>
                  <Badge className="ml-auto bg-[#001d6e]/10 text-[#001d6e] hover:bg-[#001d6e]/10">
                    {reportToShow.createdProducts?.length ?? 0}
                  </Badge>
                </div>
                <div className="divide-y rounded-lg border border-[#001d6e]/10">
                  {reportToShow.createdProducts?.length ? (
                    reportToShow.createdProducts.map((product) => (
                      <div
                        key={product.notionPageId}
                        className="flex items-center gap-3 px-3 py-2.5 transition-colors hover:bg-[#001d6e]/[0.03]"
                      >
                        <PackagePlus className="h-3.5 w-3.5 shrink-0 text-[#001d6e]/60" />
                        <div className="min-w-0 flex-1">
                          <div className="truncate text-xs font-medium text-[#001d6e]" title={product.productName}>
                            {product.productName}
                          </div>
                          <div className="truncate text-xs text-muted-foreground" title={product.barcode}>
                            SKU: {product.barcode}
                          </div>
                        </div>
                      </div>
                    ))
                  ) : (
                    <div className="flex items-center justify-center py-8 text-sm text-muted-foreground">
                      No new products
                    </div>
                  )}
                </div>
              </div>

              {/* Changed products */}
              <div className="p-5">
                <div className="mb-3 flex items-center gap-2">
                  <div className="h-2 w-2 rounded-full bg-amber-500" />
                  <span className="text-sm font-semibold text-[#001d6e]">Changed Products</span>
                  <Badge className="ml-auto bg-amber-100 text-amber-700 hover:bg-amber-100">
                    {reportToShow.changedProducts?.length ?? 0}
                  </Badge>
                </div>
                <div className="divide-y rounded-lg border border-[#001d6e]/10">
                  {reportToShow.changedProducts?.length ? (
                    reportToShow.changedProducts.map((product) => (
                      <div key={product.productId} className="divide-y">
                        <button
                          className="flex w-full items-center gap-3 px-3 py-2.5 text-left transition-colors hover:bg-[#001d6e]/[0.03]"
                          onClick={() =>
                            setExpandedProduct(expandedProduct === product.productId ? null : product.productId)
                          }
                        >
                          <div className="min-w-0 flex-1">
                            <div className="truncate text-xs font-semibold text-[#001d6e]" title={product.productName}>
                              {product.productName}
                            </div>
                            <div className="text-xs text-muted-foreground">
                              {product.barcode || product.srNo || "—"} &middot;{" "}
                              {product.changes.length} field{product.changes.length !== 1 ? "s" : ""} changed
                            </div>
                          </div>
                          <Badge className="shrink-0 bg-amber-100 text-amber-700 hover:bg-amber-100">
                            {product.changes.length}
                          </Badge>
                        </button>

                        {expandedProduct === product.productId && (
                          <div className="space-y-1.5 bg-gray-50 px-3 py-2">
                            {product.changes.map((change, index) => (
                              <div
                                key={`${product.productId}-${change.field}-${index}`}
                                className="rounded-md border border-[#001d6e]/10 bg-white px-3 py-2"
                              >
                                <div className="mb-1.5 text-[10px] font-semibold uppercase tracking-wide text-[#001d6e]/60">
                                  {change.label}
                                </div>
                                <div className="flex flex-wrap items-center gap-2">
                                  <span
                                    className="max-w-[40%] truncate rounded bg-red-50 px-2 py-0.5 text-xs text-red-600 line-through"
                                    title={String(change.oldValue ?? "—")}
                                  >
                                    {change.oldValue != null && change.oldValue !== "" ? String(change.oldValue) : "—"}
                                  </span>
                                  <ArrowRight className="h-3 w-3 shrink-0 text-muted-foreground" />
                                  <span
                                    className="max-w-[40%] truncate rounded bg-emerald-50 px-2 py-0.5 text-xs font-medium text-emerald-700"
                                    title={String(change.newValue ?? "—")}
                                  >
                                    {change.newValue != null && change.newValue !== "" ? String(change.newValue) : "—"}
                                  </span>
                                </div>
                              </div>
                            ))}
                          </div>
                        )}
                      </div>
                    ))
                  ) : (
                    <div className="flex items-center justify-center py-8 text-sm text-muted-foreground">
                      No changed products
                    </div>
                  )}
                </div>
              </div>

              {/* Errors */}
              {reportToShow.errors?.length > 0 && (
                <div className="bg-red-50 px-5 py-4">
                  <div className="mb-2 flex items-center gap-2 text-sm font-semibold text-red-700">
                    <AlertTriangle className="h-4 w-4" />
                    {reportToShow.errors.length} sync issue{reportToShow.errors.length !== 1 ? "s" : ""}
                  </div>
                  <div className="space-y-1">
                    {reportToShow.errors.slice(0, 10).map((error, index) => (
                      <div key={index} className="text-xs text-red-600">{error}</div>
                    ))}
                    {reportToShow.errors.length > 10 && (
                      <div className="text-xs text-red-500">+{reportToShow.errors.length - 10} more…</div>
                    )}
                  </div>
                </div>
              )}
            </div>
          )}
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
