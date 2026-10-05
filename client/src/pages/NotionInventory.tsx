import { useEffect, useMemo, useRef, useState } from "react";
import { useMutation, useQuery } from "@tanstack/react-query";
import Papa from "papaparse";
import jsPDF from "jspdf";
import autoTable from "jspdf-autotable";
import {
  AlertTriangle,
  ArrowDown,
  ArrowUp,
  Bell,
  CheckCircle2,
  ChevronDown,
  ChevronsUpDown,
  CloudDownload,
  Columns2,
  Database,
  Download,
  FileDown,
  FileUp,
  Image as ImageIcon,
  Loader2,
  PackagePlus,
  RefreshCw,
  Search,
  X,
  Zap,
} from "lucide-react";
import PageHeader from "@/components/PageHeader";
import { AddColumnFilterButton, ColumnFilterChipView, ColumnHeaderFilterButton } from "@/components/filters/ColumnFilterChip";
import { type FilterableColumn, type FilterCondition, matchAllConditions } from "@/lib/columnFilters";
import { Button } from "@/components/ui/button";
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
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover";
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
import { usePersistentFilter } from "@/hooks/usePersistentFilter";
import { ZoomableImg } from "@/components/ProductPhoto";
import { SectionSkeleton } from "@/components/ui/loading-skeletons";

type SyncStatus = {
  isSyncing: boolean;
  // "How far along" whatever sync is currently running — a phase label plus a running count,
  // e.g. fetching Notion pages (total unknown, Notion's own pagination gives no upfront count)
  // or checking/downloading images (a real total, since that job list is known before it starts).
  syncProgress: { phase: string; current: number; total: number | null } | null;
  lastSyncTime: string | null;
  lastReport: SyncReport | null;
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
  newSr: string | null;
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
  imagesCached?: number;
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
  { key: "newSr",            label: "New Sr.",            colWidth: 75  },
  { key: "name",             label: "Products Name",      stickyLeft: 0, colWidth: 150 },
  { key: "barcode",          label: "SKU",                colWidth: 105 },
  { key: "brand",            label: "Brand" },
  { key: "category",         label: "Category" },
  { key: "plant",            label: "Plant" },
  { key: "notionWiseName",   label: "Notion Wise Name" },
  { key: "saleCategory",     label: "Sale Category" },
  { key: "type",             label: "Type" },
  { key: "productImage",     label: "Product Image" },
  { key: "boxImage",         label: "Box Image" },
  { key: "volumeInCuFt",     label: "Vol Master" },
  { key: "itemsPerPallet",   label: "Packets" },
  { key: "mpPlt",            label: "MP PLT",             tone: "mp" },
  { key: "gjPlt",            label: "GJ PLT",             tone: "gj" },
  { key: "gjSr",             label: "GJ Sr",              tone: "gj" },
  { key: "gjHsn",            label: "GJ HSN",             tone: "gj" },
  { key: "gjSap",            label: "GJ SAP",             tone: "gj" },
  { key: "gjSaleRate",       label: "GJ Sale Rate",       tone: "gj" },
  { key: "gjIgst",           label: "GJ IGST",            tone: "gj" },
  { key: "gjGaPur",          label: "GJ-GA PUR",          tone: "gj" },
  { key: "gjMhPur",          label: "GJ-MH PUR",          tone: "gj" },
  { key: "gjNagarPur",       label: "GJ-NAGAR PUR",       tone: "gj" },
  { key: "forGjOrderForm",   label: "For GJ Order Form",  tone: "gj" },
  { key: "mpSr",             label: "MP Sr",              tone: "mp" },
  { key: "mpHsn",            label: "MP HSN",             tone: "mp" },
  { key: "mpSap",            label: "MP SAP",             tone: "mp" },
  { key: "mpJhPur",          label: "MP-JH PUR",          tone: "mp" },
  { key: "mpMhPur",          label: "MP-MH PUR",          tone: "mp" },
  { key: "mpMpPurJabalpur",  label: "MP-MP Jabalpur",     tone: "mp" },
  { key: "mpMpPurKhargone",  label: "MP-MP Khargone",     tone: "mp" },
  { key: "mpWbPur",          label: "MP-WB PUR",          tone: "mp" },
  { key: "saleMpJh",         label: "Sale MP-JH",         tone: "mp" },
  { key: "saleMpMh",         label: "Sale MP-MH",         tone: "mp" },
  { key: "saleMpMp",         label: "Sale MP-MP",         tone: "mp" },
  { key: "mpJhIgst",         label: "MP-JH IGST",         tone: "mp" },
  { key: "mpMhIgst",         label: "MP-MH IGST",         tone: "mp" },
  { key: "mpMpCgst",         label: "MP-MP CGST",         tone: "mp" },
  { key: "mpMpSgst",         label: "MP-MP SGST",         tone: "mp" },
  { key: "mpWbIgst",         label: "MP-WB IGST",         tone: "mp" },
  { key: "mpWbSale",         label: "MP-WB Sale",         tone: "mp" },
  { key: "forMpOrderForm",   label: "For MP Order Form",  tone: "mp" },
  { key: "upSr",             label: "UP Sr",              tone: "up" },
  { key: "upHsn",            label: "UP HSN",             tone: "up" },
  { key: "upSap",            label: "UP SAP",             tone: "up" },
  { key: "upRate",           label: "UP Rate",            tone: "up" },
  { key: "upIgst",           label: "UP IGST",            tone: "up" },
  { key: "forUpOrderForm",   label: "For UP Order Form",  tone: "up" },
  { key: "lastChangedBy",    label: "Changed By" },
  { key: "lastUpdated",      label: "Last Updated" },
];

const ALL_KEYS = new Set(productColumns.map((c) => String(c.key)));

// Every digit run padded to the same width before comparing — so "V2" sorts before "V10" and a
// New Sr. like "C0001"/"V001" reads in the order it's printed, not the order plain string
// comparison would put it in.
function naturalSortKey(value: string): string {
  return value.toUpperCase().replace(/\d+/g, (digits) => digits.padStart(8, "0"));
}

function cellValue(product: Product, key: keyof Product) {
  const value = product[key];
  if (value === null || value === undefined || value === "") return "-";
  if (key === "lastUpdated" || key === "createdAt" || key === "updatedAt") {
    return new Date(value as string | Date).toLocaleString();
  }
  return String(value);
}

const BTN = "h-8 bg-[#001d6e] text-white hover:bg-[#001552] text-xs";
const BTN_OUTLINE = "h-8 border border-[#001d6e] text-[#001d6e] bg-white hover:bg-[#001d6e]/5 text-xs";

export default function NotionInventory() {
  const { toast } = useToast();
  const [searchTerm, setSearchTerm] = usePersistentFilter("notionInventory:search", "");
  // Sorted by New Sr. by default; any column header can be clicked to sort by that one instead,
  // cycling asc → desc → back to the New Sr. default.
  // Not remembered between visits: the list always opens in Sr. No. order.
  const [productSort, setProductSort] = useState<{ key: string; direction: "asc" | "desc" }>(
    { key: "newSr", direction: "asc" },
  );
  // Excel-style column filters — same "+ Filter" button, header filter icons and removable chips
  // as the other tables. Only the pictures are left out (nothing to filter on in a filename).
  const [columnConditions, setColumnConditions] = useState<Record<string, FilterCondition>>({});
  const setColumnCondition = (id: string, condition: FilterCondition) =>
    setColumnConditions((prev) => ({ ...prev, [id]: condition }));
  const clearColumnCondition = (id: string) =>
    setColumnConditions((prev) => { const next = { ...prev }; delete next[id]; return next; });
  const cycleProductSort = (key: string) =>
    setProductSort((cur) =>
      cur.key !== key ? { key, direction: "asc" }
      : cur.direction === "asc" ? { key, direction: "desc" }
      : { key: "newSr", direction: "asc" });
  const [showFullSyncConfirm, setShowFullSyncConfirm] = useState(false);
  const [lastApplyReport, setLastApplyReport] = useState<SyncReport | null>(null);
  const [showReviewDialog, setShowReviewDialog] = useState(false);
  const [showAutoApplyReport, setShowAutoApplyReport] = useState(false);
  const [visibleColumnKeys, setVisibleColumnKeys] = useState<Set<string>>(new Set(ALL_KEYS));
  // Server-persisted (not per-browser) — also gates the 24-hour scheduled sync job, so
  // everyone sees and controls the same real setting instead of a local-only preference.
  const autoSyncConfigQuery = useQuery({
    queryKey: ["/api/notion-inventory-sync/auto-apply-config"],
    queryFn: async (): Promise<{ enabled: boolean }> => {
      const response = await apiRequest("GET", "/api/notion-inventory-sync/auto-apply-config");
      return response.json();
    },
    staleTime: 60 * 1000,
  });
  const autoSync = autoSyncConfigQuery.data?.enabled ?? false;

  const toggleAutoSyncMutation = useMutation({
    mutationFn: async (next: boolean) => {
      const response = await apiRequest("POST", "/api/notion-inventory-sync/auto-apply-config", { enabled: next });
      return response.json();
    },
    onSuccess: async (data: { enabled: boolean }) => {
      await queryClient.invalidateQueries({ queryKey: ["/api/notion-inventory-sync/auto-apply-config"] });
      toast({
        title: data.enabled ? "Auto Sync enabled" : "Auto Sync disabled",
        description: data.enabled
          ? "Changes from Notion will be applied automatically — both on manual checks and the 24-hour scheduled sync."
          : "Changes will be detected and left pending for review, whether checked manually or by the 24-hour scheduled sync.",
        className: data.enabled ? "bg-emerald-50 border-emerald-200 text-emerald-900" : undefined,
      });
    },
    onError: (error: any) => {
      toast({ title: "Could not update Auto Sync", description: error.message, variant: "destructive" });
    },
  });

  function toggleAutoSync() {
    toggleAutoSyncMutation.mutate(!autoSync);
  }

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
    staleTime: 5 * 60 * 1000,   // products stay fresh for 5 min — only invalidated after sync
    refetchOnWindowFocus: false, // switching tabs should not re-download 256+ products
  });

  const statusQuery = useQuery({
    queryKey: ["/api/notion-inventory-sync/status"],
    queryFn: async (): Promise<SyncStatus> => {
      const response = await apiRequest("GET", "/api/notion-inventory-sync/status");
      return response.json();
    },
    // Slow (5 min) normally — this is also how the page learns about a scheduled server-side
    // sync nobody triggered from here. While a sync is actually running (server truth, so this
    // also catches one another admin started) it speeds up to show live progress instead of a
    // stale number sitting on screen for minutes.
    refetchInterval: (query) => (query.state.data?.isSyncing ? 1500 : 5 * 60 * 1000),
    refetchOnWindowFocus: false,
  });

  // When the 5-min poll returns a new apply report (from server auto-sync),
  // show it to the user as an info-only dialog so they know what changed.
  useEffect(() => {
    const report = statusQuery.data?.lastReport;
    if (!report?.syncTime) return;
    const seenKey = "notionLastSeenReport";
    const lastSeen = localStorage.getItem(seenKey) ?? "";
    if (report.syncTime > lastSeen) {
      // Only show if something was actually created or updated
      const hasChanges = (report.created ?? 0) + (report.updated ?? 0) > 0;
      if (hasChanges) {
        setLastApplyReport(report);
        setShowAutoApplyReport(true);
      }
      // Mark as seen regardless so we don't keep prompting
      localStorage.setItem(seenKey, report.syncTime);
    }
  }, [statusQuery.data?.lastReport?.syncTime]);

  const pendingQuery = useQuery({
    queryKey: ["/api/notion-inventory-sync/pending"],
    queryFn: async (): Promise<PendingResponse> => {
      const response = await apiRequest("GET", "/api/notion-inventory-sync/pending");
      return response.json();
    },
    refetchInterval: 5 * 60 * 1000, // 5 minutes
    refetchOnWindowFocus: false,
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

  // syncImages=false ("Sync Notion") checks data fields only and is fast; syncImages=true
  // ("Sync Photos") also downloads/hashes every product image, which is the slow part. Apply
  // only ever applies image changes that a syncImages:true run actually queued — running
  // "Sync Notion" after a "Sync Photos" review (without applying) clears any queued photo
  // changes too, since each detect pass replaces the pending state outright.
  const detectMutation = useMutation({
    mutationFn: async (syncImages: boolean) => {
      const response = await apiRequest("POST", "/api/notion-inventory-sync/detect", { syncImages });
      return response.json();
    },
    onSuccess: async (data) => {
      setLastApplyReport(null);
      await queryClient.invalidateQueries({ queryKey: ["/api/notion-inventory-sync/status"] });
      await queryClient.invalidateQueries({ queryKey: ["/api/notion-inventory-sync/pending"] });
      const total = (data.created ?? 0) + (data.updated ?? 0);
      if (total === 0) {
        toast({ title: "Already up to date", description: "No changes found in Notion." });
        return;
      }
      if (autoSync) {
        toast({ title: "Auto Sync: applying…", description: `${data.created ?? 0} new · ${data.updated ?? 0} changed — applying now.` });
        applyMutation.mutate();
      } else {
        setShowReviewDialog(true);
        toast({ title: "Notion changes detected", description: `${data.created ?? 0} new and ${data.updated ?? 0} changed products found.` });
      }
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
      setShowAutoApplyReport(true);
      await queryClient.invalidateQueries({ queryKey: ["/api/products"] });
      await queryClient.invalidateQueries({ queryKey: ["/api/notion-inventory-sync/status"] });
      await queryClient.invalidateQueries({ queryKey: ["/api/notion-inventory-sync/pending"] });
      toast({
        title: data.remainingCreated || data.remainingUpdated ? "Applied, but still different" : "Changes applied successfully",
        description: data.remainingCreated || data.remainingUpdated
          ? `${data.remainingCreated ?? 0} new and ${data.remainingUpdated ?? 0} changed still remain.`
          : `${data.created ?? 0} created · ${data.updated ?? 0} updated.`,
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

  const visibleColumns = useMemo(
    () => productColumns.filter((col) => visibleColumnKeys.has(String(col.key))),
    [visibleColumnKeys],
  );

  // Operator-adjustable column widths, keyed by column key. Empty until a column is dragged, so
  // untouched columns keep their natural sizing from productColumns.
  const [colWidths, setColWidths] = useState<Record<string, number>>({});

  // Width a column should render at: a dragged override, else its declared width, else a default.
  const getColWidth = (col: ProductColumn) =>
    colWidths[String(col.key)] ?? col.colWidth ?? (col.key === "name" ? 150 : 100);

  const startColResize = (e: React.MouseEvent, col: ProductColumn) => {
    e.preventDefault();
    e.stopPropagation();
    const startX = e.clientX;
    const startWidth = getColWidth(col);
    const onMove = (moveEvent: MouseEvent) => {
      const delta = moveEvent.clientX - startX;
      setColWidths((prev) => ({ ...prev, [String(col.key)]: Math.max(60, startWidth + delta) }));
    };
    const onUp = () => {
      document.removeEventListener("mousemove", onMove);
      document.removeEventListener("mouseup", onUp);
      document.body.style.userSelect = "";
      document.body.style.cursor = "";
    };
    document.body.style.userSelect = "none";
    document.body.style.cursor = "col-resize";
    document.addEventListener("mousemove", onMove);
    document.addEventListener("mouseup", onUp);
  };

  const filterColumns = useMemo<FilterableColumn<Product>[]>(
    () => productColumns
      .filter((c) => c.key !== "productImage" && c.key !== "boxImage")
      .map((c) => {
        const id = String(c.key);
        if (c.key === "lastUpdated") {
          return { id, label: c.label, filterType: "date", disableValues: true, options: [], accessor: (p: Product) => (p[c.key] as any) ?? null } as FilterableColumn<Product>;
        }
        const values = Array.from(new Set(products.map((p) => String(p[c.key] ?? "").trim()).filter(Boolean)))
          .sort((a, b) => naturalSortKey(a).localeCompare(naturalSortKey(b)));
        return {
          id, label: c.label, filterType: "text",
          options: values.map((v) => ({ value: v, label: v })),
          accessor: (p: Product) => { const v = p[c.key]; return v == null || v === "" ? null : String(v); },
        } as FilterableColumn<Product>;
      }),
    [products],
  );
  const conditionList = Object.values(columnConditions);
  const filterHeader = (key: string) => {
    const column = filterColumns.find((c) => c.id === key);
    if (!column) return null;
    return (
      <ColumnHeaderFilterButton
        column={column}
        condition={columnConditions[key]}
        onChange={(c) => setColumnCondition(key, c)}
        onRemove={() => clearColumnCondition(key)}
      />
    );
  };

  const filteredProducts = useMemo(() => {
    const query = searchTerm.trim().toLowerCase();
    const searched = products.filter((product) => {
      if (!matchAllConditions(product, conditionList, filterColumns)) return false;
      if (!query) return true;
      return (product.newSr ?? "").toLowerCase().includes(query)
        || visibleColumns.some((col) => cellValue(product, col.key).toLowerCase().includes(query));
    });
    const sortCol = productColumns.find((c) => String(c.key) === productSort.key) ?? productColumns[0];
    const dir = productSort.direction === "asc" ? 1 : -1;
    return [...searched].sort((a, b) => {
      const ae = cellValue(a, sortCol.key) === "-";
      const be = cellValue(b, sortCol.key) === "-";
      // Rows with nothing in the sorted column go last, whichever way it is sorted.
      if (ae !== be) return ae ? 1 : -1;
      const av = naturalSortKey(cellValue(a, sortCol.key));
      const bv = naturalSortKey(cellValue(b, sortCol.key));
      return av < bv ? -1 * dir : av > bv ? 1 * dir : 0;
    });
  }, [products, searchTerm, visibleColumns, productSort, columnConditions, filterColumns]);

  function toggleColumn(key: string) {
    setVisibleColumnKeys((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  }

  function exportCsv() {
    const rows = filteredProducts.map((p) =>
      Object.fromEntries(productColumns.map((col) => [col.label, cellValue(p, col.key)])),
    );
    const csv = Papa.unparse(rows);
    const blob = new Blob([csv], { type: "text/csv;charset=utf-8;" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `products-${new Date().toISOString().slice(0, 10)}.csv`;
    a.click();
    URL.revokeObjectURL(url);
  }

  function exportPdf() {
    const doc = new jsPDF({ orientation: "landscape", unit: "pt", format: "a3" });
    doc.setFontSize(14);
    doc.text("Product Master", 40, 32);
    doc.setFontSize(9);
    doc.text(`Exported ${new Date().toLocaleString()} · ${filteredProducts.length} products`, 40, 48);
    autoTable(doc, {
      head: [productColumns.map((c) => c.label)],
      body: filteredProducts.map((p) => productColumns.map((col) => cellValue(p, col.key))),
      startY: 58,
      styles: { fontSize: 6.5, cellPadding: 2 },
      headStyles: { fillColor: [0, 29, 110], textColor: 255, fontStyle: "bold" },
      alternateRowStyles: { fillColor: [248, 250, 252] },
    });
    doc.save(`products-${new Date().toISOString().slice(0, 10)}.pdf`);
  }

  const isBusy =
    fullSyncMutation.isPending ||
    detectMutation.isPending ||
    applyMutation.isPending ||
    Boolean(statusQuery.data?.isSyncing);

  const pendingReport = pendingQuery.data?.report ?? null;
  const reportToShow = pendingReport ?? lastApplyReport;
  const isPending = !!pendingReport && ((pendingReport.created ?? 0) + (pendingReport.updated ?? 0)) > 0;
  const isConfigured = statusQuery.data?.configured ?? false;

  const hiddenCount = ALL_KEYS.size - visibleColumnKeys.size;

  return (
    <div className="container mx-auto px-3 sm:px-4 py-4 sm:py-6 pb-24">
      <PageHeader
        icon={Database}
        title="Product Master"
        description="Product master synced from Notion into PostgreSQL."
      />

      {/* Popup instead of a button spinner alone — same pattern as Vehicle Master's own sync
          dialog: stays open for as long as a sync is actually running (server truth via the
          polled status, so it also shows for whoever ELSE triggered it), closes itself the
          moment it flips false. No close button — dismissing it wouldn't stop the sync. */}
      <Dialog open={isBusy} onOpenChange={() => {}}>
        <DialogContent
          className="max-w-sm text-center"
          hideCloseButton
          onInteractOutside={(e) => e.preventDefault()}
          onEscapeKeyDown={(e) => e.preventDefault()}
        >
          <div className="flex flex-col items-center gap-3 py-4">
            <Loader2 className="h-8 w-8 animate-spin text-amber-500" />
            <DialogTitle className="text-base">
              {statusQuery.data?.syncProgress?.phase ?? "Sync in progress"}
            </DialogTitle>
            <DialogDescription className="text-sm">
              {statusQuery.data?.syncProgress ? (
                <>
                  {statusQuery.data.syncProgress.current.toLocaleString()}
                  {statusQuery.data.syncProgress.total != null
                    ? ` of ${statusQuery.data.syncProgress.total.toLocaleString()}`
                    : ""}
                  {" "}done so far.
                </>
              ) : (
                "This can take a minute or more with a database this size."
              )}
              {" "}Safe to leave this tab open — this will close automatically once it's done.
            </DialogDescription>
          </div>
        </DialogContent>
      </Dialog>

      <input ref={fileInputRef} type="file" accept=".csv" className="hidden" onChange={handleCsvFile} />

      {/* ── Stats + Actions combined card ───────────────────────────── */}
      <div className="mb-4 rounded-xl border border-gray-200 bg-white shadow-sm overflow-hidden">

        {/* Stats row */}
        <div className="grid grid-cols-2 md:grid-cols-4 divide-x divide-gray-100 border-b border-gray-100">
          {/* Total Products */}
          <div className="flex items-center gap-2 sm:gap-3 px-3 py-3 sm:px-5 sm:py-4">
            <div className="h-8 w-8 sm:h-10 sm:w-10 shrink-0 rounded-lg bg-[#001d6e]/10 flex items-center justify-center">
              <Database className="h-4 w-4 sm:h-5 sm:w-5 text-[#001d6e]" />
            </div>
            <div>
              <p className="text-xl sm:text-2xl font-extrabold text-gray-900 leading-none">{products.length}</p>
              <p className="text-[10px] sm:text-xs font-medium text-gray-500 mt-0.5">Total Products</p>
            </div>
          </div>

          {/* Linked to Notion */}
          <div className="flex items-center gap-2 sm:gap-3 px-3 py-3 sm:px-5 sm:py-4">
            <div className="h-8 w-8 sm:h-10 sm:w-10 shrink-0 rounded-lg bg-emerald-50 flex items-center justify-center">
              <CheckCircle2 className="h-4 w-4 sm:h-5 sm:w-5 text-emerald-600" />
            </div>
            <div>
              <p className="text-xl sm:text-2xl font-extrabold text-emerald-600 leading-none">{linkedCount}</p>
              <p className="text-[10px] sm:text-xs font-medium text-gray-500 mt-0.5">
                Linked · {products.length > 0 ? Math.round((linkedCount / products.length) * 100) : 0}%
              </p>
            </div>
          </div>

          {/* Pending Changes */}
          <div className="flex items-center gap-2 sm:gap-3 px-3 py-3 sm:px-5 sm:py-4">
            <div className={`h-8 w-8 sm:h-10 sm:w-10 shrink-0 rounded-lg flex items-center justify-center ${(statusQuery.data?.pendingCount ?? 0) > 0 ? "bg-amber-50" : "bg-gray-50"}`}>
              <Bell className={`h-4 w-4 sm:h-5 sm:w-5 ${(statusQuery.data?.pendingCount ?? 0) > 0 ? "text-amber-500" : "text-gray-300"}`} />
            </div>
            <div>
              <p className={`text-xl sm:text-2xl font-extrabold leading-none ${(statusQuery.data?.pendingCount ?? 0) > 0 ? "text-amber-600" : "text-gray-300"}`}>
                {statusQuery.data?.pendingCount ?? 0}
              </p>
              <p className="text-[10px] sm:text-xs font-medium text-gray-500 mt-0.5">
                {statusQuery.data?.pendingDetectedAt
                  ? `At ${new Date(statusQuery.data.pendingDetectedAt).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}`
                  : "Pending"}
              </p>
            </div>
          </div>

          {/* Notion Status */}
          <div className="flex items-center gap-2 sm:gap-3 px-3 py-3 sm:px-5 sm:py-4">
            <div className={`h-8 w-8 sm:h-10 sm:w-10 shrink-0 rounded-lg flex items-center justify-center ${isConfigured ? "bg-emerald-50" : "bg-red-50"}`}>
              <AlertTriangle className={`h-4 w-4 sm:h-5 sm:w-5 ${isConfigured ? "text-emerald-500" : "text-red-400"}`} />
            </div>
            <div>
              <p className={`text-xs sm:text-sm font-bold leading-none ${isConfigured ? "text-emerald-600" : "text-red-500"}`}>
                {isConfigured ? "Connected" : "Not set"}
              </p>
              <p className="text-[10px] sm:text-xs font-medium text-gray-500 mt-1">
                {statusQuery.data?.lastSyncTime
                  ? `${new Date(statusQuery.data.lastSyncTime).toLocaleDateString()}`
                  : "Never synced"}
              </p>
            </div>
          </div>
        </div>

        {/* Action bar */}
        <div className="flex flex-wrap items-center gap-2 px-3 sm:px-4 py-2.5">

        {/* 1. Import CSV */}
        <Button size="sm" className={BTN} onClick={() => fileInputRef.current?.click()} disabled={csvImportMutation.isPending}>
          {csvImportMutation.isPending ? <Loader2 className="mr-1.5 h-3.5 w-3.5 animate-spin" /> : <FileUp className="mr-1.5 h-3.5 w-3.5" />}
          Import CSV
        </Button>

        {/* 2. Export */}
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <Button size="sm" className={BTN} disabled={filteredProducts.length === 0}>
              <Download className="mr-1.5 h-3.5 w-3.5" />
              Export <ChevronDown className="ml-1 h-3 w-3" />
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="start">
            <DropdownMenuItem onClick={exportCsv}>
              <FileDown className="mr-2 h-4 w-4" /> Export as CSV
            </DropdownMenuItem>
            <DropdownMenuItem onClick={exportPdf}>
              <Download className="mr-2 h-4 w-4" /> Export as PDF
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>

        {/* 3. Sync Notion — data fields only, fast. Photos are a separate, deliberate action
            below so a routine sync never pays the slow per-product image download+hash cost. */}
        <Button size="sm" className={BTN} onClick={() => detectMutation.mutate(false)} disabled={isBusy || !isConfigured}
          title="Check Notion for data changes (fast — item name, SAP code, qty, etc). Does not check photos.">
          {detectMutation.isPending && detectMutation.variables === false ? <Loader2 className="mr-1.5 h-3.5 w-3.5 animate-spin" /> : <CloudDownload className="mr-1.5 h-3.5 w-3.5" />}
          Sync Notion
        </Button>

        {/* 3b. Sync Photos — on demand only; never runs automatically (not on the 24h job,
            not bundled into "Sync Notion"). Apply only ever touches images that this queued. */}
        <Button size="sm" className={BTN} onClick={() => detectMutation.mutate(true)} disabled={isBusy || !isConfigured}
          title="Check Notion for photo changes. Slower — downloads and hashes every product image.">
          {detectMutation.isPending && detectMutation.variables === true ? <Loader2 className="mr-1.5 h-3.5 w-3.5 animate-spin" /> : <ImageIcon className="mr-1.5 h-3.5 w-3.5" />}
          Sync Photos
        </Button>

        {/* 4. Review / Apply */}
        {isPending ? (
          <Button size="sm" className={BTN} onClick={() => setShowReviewDialog(true)}>
            <Bell className="mr-1.5 h-3.5 w-3.5" />
            Review Changes
            <span className="ml-1.5 rounded-full bg-white/25 px-1.5 py-0.5 text-[10px] font-bold leading-none">
              {(pendingReport?.created ?? 0) + (pendingReport?.updated ?? 0)}
            </span>
          </Button>
        ) : (
          <Button size="sm" className={BTN} onClick={() => applyMutation.mutate()} disabled={isBusy || !statusQuery.data?.hasPendingChanges}>
            {applyMutation.isPending ? <Loader2 className="mr-1.5 h-3.5 w-3.5 animate-spin" /> : <Zap className="mr-1.5 h-3.5 w-3.5" />}
            Apply Pending
            {statusQuery.data?.pendingCount ? (
              <span className="ml-1.5 rounded-full bg-white/25 px-1.5 py-0.5 text-[10px] font-bold leading-none">
                {statusQuery.data.pendingCount}
              </span>
            ) : null}
          </Button>
        )}

        {/* First sync when DB empty */}
        {products.length === 0 && (
          <Button size="sm" className={BTN} onClick={() => setShowFullSyncConfirm(true)} disabled={isBusy || !isConfigured}>
            {fullSyncMutation.isPending ? <Loader2 className="mr-1.5 h-3.5 w-3.5 animate-spin" /> : <Database className="mr-1.5 h-3.5 w-3.5" />}
            First Sync
          </Button>
        )}

        {/* Auto Sync toggle — server-persisted, also gates the 24-hour scheduled sync */}
        <button
          onClick={toggleAutoSync}
          disabled={autoSyncConfigQuery.isLoading || toggleAutoSyncMutation.isPending}
          title="Also controls whether the 24-hour scheduled sync auto-applies changes, not just manual checks"
          className={`h-8 flex items-center gap-2 rounded-md border px-3 text-xs font-semibold transition-all disabled:opacity-60 ${
            autoSync
              ? "bg-emerald-600 border-emerald-600 text-white hover:bg-emerald-700"
              : "bg-white border-gray-200 text-gray-500 hover:bg-gray-50"
          }`}
        >
          {/* toggle pill */}
          <span className={`relative inline-flex h-4 w-7 shrink-0 items-center rounded-full transition-colors ${autoSync ? "bg-white/30" : "bg-gray-200"}`}>
            <span className={`absolute h-3 w-3 rounded-full bg-white shadow transition-transform ${autoSync ? "translate-x-3.5" : "translate-x-0.5"}`} />
          </span>
          Auto Apply
        </button>

        <div className="flex-1" />

        {/* Column selector */}
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
                  <button
                    className="text-[11px] font-medium text-[#001d6e] hover:underline"
                    onClick={() => setVisibleColumnKeys(new Set(ALL_KEYS))}
                  >Select All</button>
                  <span className="text-gray-300">|</span>
                  <button
                    className="text-[11px] font-medium text-gray-400 hover:text-gray-600 hover:underline"
                    onClick={() => setVisibleColumnKeys(new Set())}
                  >Deselect All</button>
                </div>
              </div>
              <p className="text-[10px] text-gray-400 mt-0.5">{visibleColumnKeys.size} of {ALL_KEYS.size} selected</p>
            </div>
            <div className="max-h-72 overflow-y-auto py-1">
              {productColumns.map((col) => {
                const key = String(col.key);
                const checked = visibleColumnKeys.has(key);
                return (
                  <label
                    key={key}
                    className="flex items-center gap-2.5 px-3 py-1.5 hover:bg-gray-50 cursor-pointer select-none"
                  >
                    <input
                      type="checkbox"
                      checked={checked}
                      onChange={() => toggleColumn(key)}
                      className="h-3.5 w-3.5 rounded border-gray-300 accent-[#001d6e]"
                    />
                    <span className="text-xs text-gray-700 flex-1">{col.label}</span>
                    {col.tone && (
                      <span className={`text-[10px] font-bold ${col.tone === "gj" ? "text-sky-600" : col.tone === "mp" ? "text-emerald-600" : "text-amber-600"}`}>
                        {col.tone.toUpperCase()}
                      </span>
                    )}
                  </label>
                );
              })}
            </div>
          </PopoverContent>
        </Popover>

        {/* Refresh */}
        <button
          onClick={() => productsQuery.refetch()}
          disabled={productsQuery.isFetching}
          title="Refresh"
          className="flex items-center justify-center h-8 w-8 rounded border border-gray-200 text-gray-500 hover:bg-gray-50 disabled:opacity-40 transition-colors"
        >
          <RefreshCw className={`h-3.5 w-3.5 ${productsQuery.isFetching ? "animate-spin" : ""}`} />
        </button>
        </div> {/* end action bar */}
      </div> {/* end stats+actions card */}

      {/* ── Product table ─────────────────────────────────────────── */}
      <div className="rounded-xl border border-gray-200 bg-white shadow-sm overflow-hidden">

        {/* Header bar */}
        <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-2 px-3 sm:px-5 py-3 sm:py-3.5 bg-white border-b border-gray-200">
          <div className="flex items-center gap-3">
            <div className="flex h-8 w-8 sm:h-9 sm:w-9 items-center justify-center rounded-lg bg-[#001d6e]/10">
              <Database className="h-4 w-4 sm:h-5 sm:w-5 text-[#001d6e]" />
            </div>
            <div>
              <div className="text-lg sm:text-xl font-bold tracking-tight text-gray-900">Product Master</div>
              <div className="text-xs text-gray-400 leading-none mt-0.5">
                {searchTerm || conditionList.length > 0
                  ? `${filteredProducts.length} of ${products.length} products`
                  : `${products.length} products`}
                {visibleColumns.length < productColumns.length && (
                  <span className="ml-1.5">· {visibleColumns.length} cols shown</span>
                )}
              </div>
            </div>
          </div>
          {/* Filter + Search */}
          <div className="flex w-full items-center gap-2 sm:w-auto sm:shrink-0">
          <AddColumnFilterButton
            columns={filterColumns}
            conditions={columnConditions}
            onApply={setColumnCondition}
            onClear={clearColumnCondition}
            className="h-7 shrink-0 gap-1 rounded-md border-dashed border-[#001d6e]/40 bg-white text-xs font-medium text-[#001d6e] hover:bg-[#001d6e]/5 hover:text-[#001d6e]"
          />
          <div className="relative min-w-0 flex-1 sm:w-auto sm:flex-none">
            <Search className="absolute left-2.5 top-1.5 h-3.5 w-3.5 text-gray-400 pointer-events-none" />
            <input
              value={searchTerm}
              onChange={(e) => setSearchTerm(e.target.value)}
              placeholder="Search products…"
              className="h-7 w-full sm:w-52 rounded-md border border-gray-200 bg-gray-50 pl-7 pr-6 text-xs text-gray-700 placeholder:text-gray-400 focus:outline-none focus:ring-1 focus:ring-[#001d6e]/30 focus:bg-white"
            />
            {searchTerm && (
              <button onClick={() => setSearchTerm("")} className="absolute right-2 top-1.5 text-gray-400 hover:text-gray-600">
                <X className="h-3.5 w-3.5" />
              </button>
            )}
          </div>
          </div>
        </div>
        {conditionList.length > 0 && (
          <div className="flex flex-wrap items-center gap-1.5 border-b border-gray-200 bg-white px-3 py-2 sm:px-5">
            {Object.entries(columnConditions).map(([id, condition]) => (
              <ColumnFilterChipView
                key={id}
                columnId={id}
                condition={condition}
                columns={filterColumns}
                onEdit={(c) => setColumnCondition(id, c)}
                onRemove={() => clearColumnCondition(id)}
              />
            ))}
          </div>
        )}

        {/* Empty states */}
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

        {!productsQuery.isLoading && isConfigured && products.length === 0 && (
          <div className="flex flex-col items-center justify-center py-20 text-center">
            <div className="mb-4 flex h-16 w-16 items-center justify-center rounded-full bg-[#001d6e]/10">
              <Database className="h-8 w-8 text-[#001d6e]/40" />
            </div>
            <div className="mb-1 text-base font-semibold text-[#001d6e]">No products imported yet</div>
            <div className="mb-5 max-w-xs text-sm text-muted-foreground">
              Run <strong>First Sync</strong> to import your full product master from Notion into the database.
            </div>
            <Button size="sm" onClick={() => setShowFullSyncConfirm(true)} disabled={isBusy} className="bg-[#001d6e] text-white hover:bg-[#001552]">
              {fullSyncMutation.isPending ? <Loader2 className="mr-1.5 h-4 w-4 animate-spin" /> : <Database className="mr-1.5 h-4 w-4" />}
              Run First Sync
            </Button>
          </div>
        )}

        {/* Mobile swipe hint */}
        {(products.length > 0 && visibleColumns.length > 3) && (
          <div className="flex items-center justify-center gap-1.5 py-1 bg-[#001d6e]/5 border-b border-gray-100 sm:hidden">
            <span className="text-[10px] text-[#001d6e]/60 font-medium">← Swipe left / right to see all columns →</span>
          </div>
        )}

        {/* Table */}
        {(productsQuery.isLoading || products.length > 0) && (
          <div
            className="overflow-x-auto overflow-y-auto max-h-[52vh] sm:max-h-[calc(100vh-320px)] min-h-[260px] sm:min-h-[400px]"
            style={{ WebkitOverflowScrolling: "touch" }}
          >
            <table className="w-max min-w-full caption-bottom border-collapse text-xs">
              <thead>
                <tr className="bg-[#001d6e]">
                  {visibleColumns.map((col) => {
                    const isNameCol = col.key === "name";
                    const dragged = colWidths[String(col.key)];
                    // Once dragged, the width is pinned exactly; until then keep the original
                    // min/max behaviour so the layout is unchanged for untouched columns.
                    const mw = isNameCol ? "120px" : col.colWidth ? `${Math.round(col.colWidth * 0.68)}px` : "70px";
                    return (
                      <th
                        key={col.key}
                        style={
                          dragged
                            ? { width: dragged, minWidth: dragged, maxWidth: dragged }
                            : { minWidth: mw, maxWidth: isNameCol ? "150px" : undefined }
                        }
                        className={`group relative sticky top-0 ${isNameCol ? "left-0 z-20 bg-[#001d6e]" : "z-10 bg-[#001d6e]"} cursor-pointer select-none whitespace-nowrap border-r border-[#1a3a9c] px-2 py-2 sm:px-2.5 sm:py-2.5 text-left text-[10px] sm:text-[11px] font-semibold tracking-wide uppercase text-white hover:bg-[#0a2b7e]`}
                        onClick={() => cycleProductSort(String(col.key))}
                      >
                        <span className="inline-flex items-center gap-1">
                          {col.label}
                          {filterHeader(String(col.key))}
                          {productSort.key === col.key ? (
                            productSort.direction === "asc" ? <ArrowUp className="h-3 w-3" /> : <ArrowDown className="h-3 w-3" />
                          ) : (
                            <ChevronsUpDown className="h-3 w-3 opacity-40" />
                          )}
                        </span>
                        {/* Drag the right edge to resize; double-click resets this column. */}
                        <span
                          onMouseDown={(e) => startColResize(e, col)}
                          onDoubleClick={(e) => {
                            e.stopPropagation();
                            setColWidths((prev) => {
                              const next = { ...prev };
                              delete next[String(col.key)];
                              return next;
                            });
                          }}
                          title="Drag to resize · double-click to reset"
                          className="absolute right-0 top-0 z-30 flex h-full w-3 cursor-col-resize touch-none select-none items-center justify-center"
                        >
                          <span className="h-1/2 w-[3px] rounded-full bg-transparent transition-colors group-hover:bg-white/60" />
                        </span>
                      </th>
                    );
                  })}
                </tr>
              </thead>
              <tbody>
                {productsQuery.isLoading ? (
                  <tr>
                    <td colSpan={visibleColumns.length} className="p-0"><SectionSkeleton lines={6} /></td>
                  </tr>
                ) : filteredProducts.length === 0 ? (
                  <tr>
                    <td colSpan={visibleColumns.length} className="h-32 text-center text-muted-foreground">
                      <Search className="mx-auto mb-2 h-5 w-5 opacity-30" />
                      <div className="text-sm">No products match your search or filters.</div>
                    </td>
                  </tr>
                ) : (
                  filteredProducts.map((product, i) => {
                    const isOdd = i % 2 !== 0;
                    return (
                      <tr
                        key={product.id}
                        className={`transition-colors hover:bg-[#001d6e]/[0.04] ${isOdd ? "bg-slate-50" : "bg-white"}`}
                      >
                        {visibleColumns.map((col) => {
                          const isNameCol = col.key === "name";
                          const dragged = colWidths[String(col.key)];
                          const mw = isNameCol ? "120px" : col.colWidth ? `${Math.round(col.colWidth * 0.68)}px` : "70px";
                          const val = cellValue(product, col.key);
                          const isEmpty = val === "-";
                          return (
                            <td
                              key={`${product.id}-${col.key}`}
                              // Must mirror the header's width, or the column won't visibly resize.
                              style={
                                dragged
                                  ? { width: dragged, minWidth: dragged, maxWidth: dragged }
                                  : { minWidth: mw, maxWidth: isNameCol ? "150px" : "140px" }
                              }
                              className={`border-r border-b border-gray-200 px-1.5 py-1.5 sm:px-2 sm:py-2 ${
                                isNameCol
                                  ? `sticky left-0 z-[5] text-[11px] sm:text-xs font-semibold text-[#001d6e] whitespace-normal break-words leading-snug shadow-[2px_0_4px_-1px_rgba(0,0,0,0.08)] ${isOdd ? "bg-slate-50" : "bg-white"}`
                                  : `text-[11px] sm:text-xs ${isEmpty ? "text-gray-300" : "text-gray-700"} whitespace-nowrap truncate`
                              }`}
                              title={col.key === "productImage" || col.key === "boxImage" ? product.name : val}
                            >
                              {/* Both pictures are cached files, so the cell shows the thumbnail
                                  rather than the filename the column actually holds. */}
                              {(col.key === "productImage" || col.key === "boxImage") && !isEmpty ? (
                                <ZoomableImg
                                  src={`/api/products/${col.key === "boxImage" ? "box-image-by-id" : "image-by-id"}?id=${product.id}`}
                                  alt={product.name}
                                  title={product.name}
                                  className="h-8 w-8 rounded border border-gray-200 bg-gray-50 object-contain"
                                  onError={(e) => { (e.currentTarget as HTMLImageElement).style.display = "none"; }}
                                />
                              ) : val}
                            </td>
                          );
                        })}
                      </tr>
                    );
                  })
                )}
              </tbody>
            </table>
          </div>
        )}

      </div>

      {/* ── Auto Apply Report dialog ───────────────────────────────── */}
      <Dialog open={showAutoApplyReport} onOpenChange={setShowAutoApplyReport}>
        <DialogContent className="w-[calc(100vw-2rem)] sm:max-w-2xl max-h-[85vh] flex flex-col p-4 sm:p-6">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2">
              <CheckCircle2 className="h-5 w-5 text-emerald-500" />
              Auto Sync — Changes Applied
            </DialogTitle>
            <DialogDescription>
              {lastApplyReport?.syncTime
                ? `Applied on ${new Date(lastApplyReport.syncTime).toLocaleString()} — here's what changed.`
                : "Auto sync completed. Here's a summary of what was applied."}
            </DialogDescription>
          </DialogHeader>

          {lastApplyReport && (
            <div className="flex flex-col gap-4 overflow-hidden">
              {/* Summary chips */}
              <div className="flex flex-wrap gap-3">
                {(lastApplyReport.created ?? 0) > 0 && (
                  <div className="flex flex-col items-center px-4 py-2 bg-purple-50 border border-purple-200 rounded-lg">
                    <span className="text-2xl font-bold text-purple-700">{lastApplyReport.created}</span>
                    <span className="text-xs text-purple-600">Created</span>
                  </div>
                )}
                {(lastApplyReport.updated ?? 0) > 0 && (
                  <div className="flex flex-col items-center px-4 py-2 bg-emerald-50 border border-emerald-200 rounded-lg">
                    <span className="text-2xl font-bold text-emerald-700">{lastApplyReport.updated}</span>
                    <span className="text-xs text-emerald-600">Updated</span>
                  </div>
                )}
                <div className="flex flex-col items-center px-4 py-2 bg-gray-50 border border-gray-200 rounded-lg">
                  <span className="text-2xl font-bold text-gray-500">{lastApplyReport.skipped}</span>
                  <span className="text-xs text-gray-400">No Change</span>
                </div>
                <div className="flex flex-col items-center px-4 py-2 bg-blue-50 border border-blue-200 rounded-lg">
                  <span className="text-2xl font-bold text-blue-700">{lastApplyReport.total}</span>
                  <span className="text-xs text-blue-600">Total Pages</span>
                </div>
              </div>

              {/* Created products list */}
              {(lastApplyReport.createdProducts?.length ?? 0) > 0 && (
                <div className="border rounded-md overflow-y-auto max-h-36">
                  <div className="bg-purple-50 px-3 py-1.5 text-xs font-semibold text-purple-700 border-b sticky top-0">
                    New products added ({lastApplyReport.createdProducts.length})
                  </div>
                  {lastApplyReport.createdProducts.map((cp) => (
                    <div key={cp.notionPageId} className="flex items-center gap-2 px-3 py-1.5 text-xs border-b last:border-0">
                      <PackagePlus className="h-3.5 w-3.5 shrink-0 text-purple-500" />
                      <span className="font-medium">{cp.productName}</span>
                      <span className="text-gray-300">·</span>
                      <span className="text-gray-500">{cp.barcode}</span>
                    </div>
                  ))}
                </div>
              )}

              {/* Changed products — card list (mobile-friendly) */}
              {(lastApplyReport.changedProducts?.length ?? 0) > 0 ? (
                <div className="overflow-y-auto flex-1 border rounded-md divide-y divide-gray-100">
                  <div className="bg-[#001d6e] px-3 py-2 flex items-center gap-2 sticky top-0">
                    <span className="text-[11px] font-bold uppercase tracking-wide text-white">
                      Updated Products ({lastApplyReport.changedProducts.length})
                    </span>
                  </div>
                  {lastApplyReport.changedProducts.map((pc, idx) => (
                    <div key={pc.productId} className={`px-3 py-3 ${idx % 2 !== 0 ? "bg-slate-50" : "bg-white"}`}>
                      <div className="flex items-center justify-between gap-2 mb-2">
                        <span className="text-sm font-semibold text-[#001d6e] leading-snug truncate">{pc.productName}</span>
                        <span className="text-[11px] text-gray-400 shrink-0 font-mono">{pc.barcode || pc.newSr || "—"}</span>
                      </div>
                      <div className="rounded-md border border-gray-100 divide-y divide-gray-100 overflow-hidden">
                        {pc.changes.map((ch, i) => (
                          <div key={i} className="grid grid-cols-[minmax(70px,auto)_1fr] items-center gap-x-2 px-2.5 py-1.5">
                            <span className="text-[11px] font-medium text-gray-500">{ch.label}</span>
                            <div className="flex items-center justify-end gap-1.5 min-w-0 text-right">
                              <span className="text-[11px] text-red-400 line-through truncate max-w-[45%]" title={String(ch.oldValue ?? "—")}>
                                {ch.oldValue != null && ch.oldValue !== "" ? String(ch.oldValue) : "—"}
                              </span>
                              <span className="text-gray-300 shrink-0">→</span>
                              <span className="text-[11px] text-emerald-700 font-semibold truncate max-w-[45%]" title={String(ch.newValue)}>
                                {String(ch.newValue)}
                              </span>
                            </div>
                          </div>
                        ))}
                      </div>
                    </div>
                  ))}
                </div>
              ) : (
                <div className="flex flex-col items-center py-8 text-gray-400">
                  <CheckCircle2 className="h-8 w-8 mb-2 text-emerald-300" />
                  <p className="text-sm">No field-level changes — only new products were added.</p>
                </div>
              )}
            </div>
          )}

          <DialogFooter>
            <Button className="bg-[#001d6e] hover:bg-[#001552] text-white" onClick={() => {
              setShowAutoApplyReport(false);
              if (lastApplyReport?.syncTime) {
                localStorage.setItem("notionLastSeenReport", lastApplyReport.syncTime);
              }
            }}>
              Got it
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* ── Review dialog ──────────────────────────────────────────── */}
      <Dialog open={showReviewDialog} onOpenChange={setShowReviewDialog}>
        <DialogContent className="w-[calc(100vw-2rem)] sm:max-w-3xl max-h-[85vh] flex flex-col p-4 sm:p-6">
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
                {(reportToShow.imagesCached ?? 0) > 0 && (
                  <div className="flex flex-col items-center px-4 py-2 bg-purple-50 border border-purple-200 rounded-lg">
                    <span className="text-2xl font-bold text-purple-700">{reportToShow.imagesCached}</span>
                    <span className="text-xs text-purple-600">Images Cached</span>
                  </div>
                )}
                {(reportToShow.errors?.length ?? 0) > 0 && (
                  <div className="flex flex-col items-center px-4 py-2 bg-red-50 border border-red-200 rounded-lg">
                    <span className="text-2xl font-bold text-red-700">{reportToShow.errors.length}</span>
                    <span className="text-xs text-red-600">Errors</span>
                  </div>
                )}
              </div>

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

              {(reportToShow.changedProducts?.length ?? 0) > 0 ? (
                <div className="overflow-y-auto flex-1 border rounded-md divide-y divide-gray-100">
                  <div className="bg-[#001d6e] px-3 py-2 flex items-center gap-2 sticky top-0">
                    <span className="text-[11px] font-bold uppercase tracking-wide text-white">
                      Products to Update ({reportToShow.changedProducts.length})
                    </span>
                  </div>
                  {reportToShow.changedProducts.map((pc, idx) => (
                    <div key={pc.productId} className={`px-3 py-3 ${idx % 2 !== 0 ? "bg-slate-50" : "bg-white"}`}>
                      <div className="flex items-center justify-between gap-2 mb-2">
                        <span className="text-sm font-semibold text-[#001d6e] leading-snug truncate">{pc.productName}</span>
                        <span className="text-[11px] text-gray-400 shrink-0 font-mono">{pc.barcode || pc.newSr || "—"}</span>
                      </div>
                      <div className="rounded-md border border-gray-100 divide-y divide-gray-100 overflow-hidden">
                        {pc.changes.map((ch, i) => (
                          <div key={i} className="grid grid-cols-[minmax(70px,auto)_1fr] items-center gap-x-2 px-2.5 py-1.5">
                            <span className="text-[11px] font-medium text-gray-500">{ch.label}</span>
                            <div className="flex items-center justify-end gap-1.5 min-w-0 text-right">
                              <span className="text-[11px] text-red-500 line-through truncate max-w-[45%]" title={String(ch.oldValue ?? "—")}>
                                {ch.oldValue != null && ch.oldValue !== "" ? String(ch.oldValue) : "—"}
                              </span>
                              <span className="text-gray-300 shrink-0">→</span>
                              <span className="text-[11px] text-green-700 font-semibold truncate max-w-[45%]" title={String(ch.newValue)}>
                                {String(ch.newValue)}
                              </span>
                            </div>
                          </div>
                        ))}
                      </div>
                    </div>
                  ))}
                </div>
              ) : (
                <div className="flex flex-col items-center justify-center py-10 text-muted-foreground">
                  <CheckCircle2 className="h-10 w-10 mb-2 text-green-400" />
                  <p className="text-sm">No field changes detected.</p>
                  <p className="text-xs mt-1">Products already match Notion data.</p>
                </div>
              )}

              {(reportToShow.errors?.length ?? 0) > 0 && (
                <div className="bg-red-50 border border-red-200 rounded-md p-3">
                  <p className="text-xs font-semibold text-red-700 mb-1">Errors ({reportToShow.errors.length})</p>
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
            <Button variant="outline" onClick={() => setShowReviewDialog(false)}>Dismiss</Button>
            {isPending && (
              <Button
                onClick={() => applyMutation.mutate()}
                disabled={isBusy || (!(reportToShow?.updated) && !(reportToShow?.created))}
                className="bg-[#001d6e] hover:bg-[#001552] text-white"
              >
                {applyMutation.isPending ? (
                  <><Loader2 className="h-4 w-4 animate-spin mr-1.5" /> Applying...</>
                ) : (
                  <><Zap className="h-4 w-4 mr-1.5" />
                    Apply ({reportToShow?.created ?? 0} new + {reportToShow?.updated ?? 0} changed)
                  </>
                )}
              </Button>
            )}
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* ── CSV import dialog ──────────────────────────────────────── */}
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

              <div className="rounded-md border bg-gray-50 px-3 py-2">
                <p className="text-xs font-semibold text-gray-500 mb-1.5">Detected columns</p>
                <div className="flex flex-wrap gap-1">
                  {csvPreview.headers.map((h) => (
                    <span key={h} className="rounded bg-white border px-2 py-0.5 text-xs text-gray-700">{h}</span>
                  ))}
                </div>
              </div>

              <div className="overflow-auto flex-1 border rounded-md">
                <table className="w-max min-w-full text-xs border-collapse">
                  <thead>
                    <tr className="bg-[#001d6e]">
                      {csvPreview.headers.slice(0, 6).map((h) => (
                        <th key={h} className="sticky top-0 px-3 py-2 text-left text-[11px] font-semibold text-white border-r border-[#1a3a9c] whitespace-nowrap">{h}</th>
                      ))}
                      {csvPreview.headers.length > 6 && (
                        <th className="sticky top-0 px-3 py-2 text-left text-[11px] font-semibold text-blue-200 whitespace-nowrap">+{csvPreview.headers.length - 6} more</th>
                      )}
                    </tr>
                  </thead>
                  <tbody>
                    {csvPreview.rows.slice(0, 5).map((row, i) => (
                      <tr key={i} className={`border-b ${i % 2 !== 0 ? "bg-slate-50" : "bg-white"} hover:bg-gray-50`}>
                        {csvPreview.headers.slice(0, 6).map((h) => (
                          <td key={h} className="px-3 py-1.5 border-r text-gray-700 whitespace-nowrap max-w-[160px] truncate" title={row[h]}>{row[h] || "—"}</td>
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
            <Button variant="outline" onClick={() => { setShowCsvDialog(false); setCsvPreview(null); }}>Cancel</Button>
            <Button
              onClick={() => csvPreview && csvImportMutation.mutate(csvPreview.rows)}
              disabled={csvImportMutation.isPending || !csvPreview}
              className="bg-[#001d6e] hover:bg-[#001552] text-white"
            >
              {csvImportMutation.isPending
                ? <><Loader2 className="mr-1.5 h-4 w-4 animate-spin" />Importing…</>
                : <><FileUp className="mr-1.5 h-4 w-4" />Import {csvPreview?.rows.length ?? 0} rows</>}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* ── First sync confirmation ────────────────────────────────── */}
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
            <AlertDialogAction onClick={() => fullSyncMutation.mutate()} className="bg-[#001d6e] text-white hover:bg-[#001552]">
              {fullSyncMutation.isPending ? (
                <><Loader2 className="mr-2 h-4 w-4 animate-spin" />Syncing…</>
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
