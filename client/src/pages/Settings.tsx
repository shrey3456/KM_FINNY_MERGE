import { useLocation } from 'wouter';
import MobileMenu from '@/components/ui/mobile-menu';
import { 
  Card, 
  CardContent, 
  CardDescription, 
  CardHeader, 
  CardTitle 
} from '@/components/ui/card';
import { 
  Tabs, 
  TabsContent, 
  TabsList, 
  TabsTrigger 
} from '@/components/ui/tabs';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { 
  Form, 
  FormControl, 
  FormDescription, 
  FormField, 
  FormItem, 
  FormLabel, 
  FormMessage 
} from '@/components/ui/form';
import { Switch } from '@/components/ui/switch';
import { Label } from '@/components/ui/label';
import { useToast } from '@/hooks/use-toast';
import { useForm } from 'react-hook-form';
import { useEffect, useState } from 'react';
import { Smartphone, Radio, QrCode, Zap, Shield, Database, Loader2, Upload, Download, CalendarDays, RefreshCw, Webhook, ExternalLink, Trash2 } from 'lucide-react';
import Papa from 'papaparse';
import * as XLSX from 'xlsx';
import { apiRequest } from '@/lib/queryClient';
import { SyncProgressDialog, type SyncProgress } from '@/components/SyncProgressDialog';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import ManualSalesCard from '@/components/settings/ManualSalesCard';
import LoadingFromSalesCard from '@/components/settings/LoadingFromSalesCard';
import OpeningStockEditorCard from '@/components/settings/OpeningStockEditorCard';
import { hasPageWriteAccess } from '@/lib/permissions';
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

// ─── Opening Stock CSV column auto-detection + manual mapping — same two-step pattern Order
// Import uses (client/src/pages/OrderImport.tsx: cleanHeader/parseCsvRaw/autoMatch/the mapping
// dialog): auto-match runs first, but the result always opens in a dialog where every field can
// be manually re-pointed at a different CSV column. Previously this just toast-failed and gave
// up the moment auto-match missed Barcode/Quantity — with no way to tell it which column really
// held them (a real header like "BARCODE" exported from Excel as UTF-16/with a stray BOM could
// come through mangled, and there was no fallback once normalisation failed to recognise it).
// Local calendar date, not toISOString() (a UTC moment that can land on the wrong day in a
// timezone ahead of or behind UTC) — matches the "YYYY-MM-DD" the server's own todayDateStr()
// produces, and what the <input type="date"> below reads and writes.
function osTodayLocalDateStr(): string {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

const osNormHeader = (h: string) => h.trim().toLowerCase().replace(/[^a-z0-9]/g, "");
const OS_COLUMN_CANDIDATES: Record<"barcode" | "itemName" | "quantity", string[]> = {
  barcode: ["barcode", "itemcode", "sku", "ean", "productbarcode", "code"],
  itemName: ["itemname", "description", "productname", "item", "name", "material"],
  quantity: ["quantity", "qty", "openingstock", "openingqty", "stock", "instock"],
};
function osMatchColumn(headers: string[], key: keyof typeof OS_COLUMN_CANDIDATES): string | null {
  const normalized = headers.map((h) => ({ raw: h, norm: osNormHeader(h) }));
  for (const c of OS_COLUMN_CANDIDATES[key]) {
    const exact = normalized.find((h) => h.norm === c);
    if (exact) return exact.raw;
  }
  for (const c of OS_COLUMN_CANDIDATES[key]) {
    const partial = normalized.find((h) => h.norm.includes(c));
    if (partial) return partial.raw;
  }
  return null;
}

const OS_SKIP = "__skip__";
const OS_TARGET_FIELDS: { key: "barcode" | "itemName" | "quantity"; label: string }[] = [
  { key: "barcode", label: "Barcode / SKU" },
  { key: "itemName", label: "Item Name" },
  { key: "quantity", label: "Quantity" },
];
type OsMapping = Record<"barcode" | "itemName" | "quantity", string>;
function osAutoMatch(headers: string[]): OsMapping {
  return {
    barcode: osMatchColumn(headers, "barcode") ?? OS_SKIP,
    itemName: osMatchColumn(headers, "itemName") ?? OS_SKIP,
    quantity: osMatchColumn(headers, "quantity") ?? OS_SKIP,
  };
}

// parseFloat (not a strip-non-digits-then-parseInt) — stripping every non-digit character would
// remove the decimal point too, so a cell written as "200.00" (a common Excel export format for
// a whole-number column) would become "20000", 100x too large. Commas are stripped first since
// those are a thousands separator, not part of the number.
function osParseQty(raw: string): number {
  const n = parseFloat((raw ?? "0").replace(/,/g, "").trim());
  return Number.isFinite(n) ? Math.round(n) : 0;
}

// Excel leaves a barcode cell in one of a few damaged shapes depending on how the sheet was
// saved, all of which a plain .trim() lets straight through as "valid":
//  - ="8906010500375" — the formula-wrapper trick used to force a long number to stay text
//    instead of auto-converting to scientific notation. The digits inside are the real,
//    undamaged barcode — just needs unwrapping.
//  - 8.90601E+12 — the number WAS allowed to auto-convert, which rounds it to ~6 significant
//    digits. The original barcode is gone for good at that point; this cell can't be repaired,
//    only recognised and rejected so it doesn't silently get imported as a different real item's
//    barcode (or as a new phantom row nothing else will ever match).
//  - A trailing "Grand Total"/"TOTAL" row some exports add at the bottom isn't a barcode at all —
//    rejected the same way: a cell with no digits in it whatsoever can't be one.
function cleanOsBarcodeCell(raw: string): { value: string; rejected: "scientific" | "not-a-barcode" | null } {
  const trimmed = (raw ?? "").trim();
  const unwrapped = /^="(.*)"$/.exec(trimmed)?.[1]?.trim() ?? trimmed;
  if (/^\d+(\.\d+)?E\+\d+$/i.test(unwrapped)) return { value: unwrapped, rejected: "scientific" };
  if (unwrapped && !/\d/.test(unwrapped)) return { value: unwrapped, rejected: "not-a-barcode" };
  return { value: unwrapped, rejected: null };
}

function buildOsRowsFromMapping(
  csvData: { headers: string[]; rows: Record<string, string>[] },
  mapping: OsMapping,
): { rows: { barcode: string; itemName: string | null; quantity: number }[]; skipped: { raw: string; reason: string }[] } {
  const barcodeCol = mapping.barcode;
  const itemNameCol = mapping.itemName;
  const qtyCol = mapping.quantity;
  const rows: { barcode: string; itemName: string | null; quantity: number }[] = [];
  const skipped: { raw: string; reason: string }[] = [];
  for (const row of csvData.rows) {
    const rawBarcode = barcodeCol && barcodeCol !== OS_SKIP ? (row[barcodeCol] ?? "") : "";
    if (!rawBarcode.trim()) continue; // same as the old .filter((r) => r.barcode) — a blank row, not a bad one
    const { value: barcode, rejected } = cleanOsBarcodeCell(rawBarcode);
    if (rejected === "scientific") {
      skipped.push({ raw: rawBarcode, reason: "Excel rounded this to scientific notation — the real barcode can't be recovered from this file; fix it at the source and re-export" });
      continue;
    }
    if (rejected === "not-a-barcode") {
      skipped.push({ raw: rawBarcode, reason: "doesn't look like a barcode (e.g. a totals row)" });
      continue;
    }
    rows.push({
      barcode,
      itemName: itemNameCol && itemNameCol !== OS_SKIP ? (row[itemNameCol] ?? "").trim() || null : null,
      quantity: qtyCol && qtyCol !== OS_SKIP ? osParseQty(row[qtyCol] ?? "0") : 0,
    });
  }
  return { rows, skipped };
}

// Strips a leading BOM and any other non-ASCII byte that an Excel "CSV UTF-16"/"CSV (Macintosh)"
// export can leave sitting inside a header cell — exactly what turns a plainly-named "BARCODE"
// column into something auto-match (and even a human skimming it) can no longer recognise.
function osCleanHeader(h: string): string {
  return h.replace(/^﻿/, "").replace(/[^\x20-\x7E]/g, "").trim();
}

// Reads a .csv as plain text rows via Papa, or a real .xlsx/.xls workbook's first sheet via
// SheetJS — either way the result is the same raw string[][] grid, so everything downstream
// (header-row detection, cleaning, mapping) doesn't care which format the file actually was.
// Reading a native workbook directly (raw: true, no number-format string applied) matters for
// more than convenience: a barcode CSV-exported FROM Excel is where values like ="8906010500375"
// or 8.90601E+12 get baked in as literal, permanently-damaged text in the first place — handing
// over the original .xlsx instead means SheetJS reads the cell's actual value, never Excel's
// own CSV-export mangling of it.
function readFileAsGrid(file: File): Promise<string[][]> {
  const isExcel = /\.xlsx?$/i.test(file.name);
  if (isExcel) {
    return file.arrayBuffer().then((buf) => {
      const workbook = XLSX.read(buf, { type: "array" });
      const sheet = workbook.Sheets[workbook.SheetNames[0]];
      if (!sheet) return [];
      const aoa = XLSX.utils.sheet_to_json<unknown[]>(sheet, { header: 1, defval: "", raw: true });
      // String(n) on a JS number never switches to scientific notation below 1e21 — far past any
      // real barcode's length — so a numeric cell's exact digits come through intact.
      return aoa.map((row) => row.map((cell) => (cell == null ? "" : String(cell))));
    });
  }
  return new Promise((resolve) => {
    Papa.parse<string[]>(file, {
      header: false,
      skipEmptyLines: true,
      delimiter: "", // auto-detect
      encoding: "UTF-8",
      complete: (result) => resolve(result.data as string[][]),
      error: () => resolve([]),
    });
  });
}

// Mirrors OrderImport.tsx's parseCsvRaw: picks the REAL header row by which row has the most
// non-empty cells in the first 15 — an Excel export with a report-title row above the actual
// headers would otherwise hand the title row to the mapping dialog instead, and every column
// would come back unmatched.
async function parseOsCsvRaw(file: File): Promise<{ name: string; headers: string[]; rows: Record<string, string>[] } | null> {
  const rawRows = await readFileAsGrid(file);
  if (rawRows.length === 0) return null;
  let headerRowIdx = 0;
  let maxCols = 0;
  for (let i = 0; i < Math.min(rawRows.length, 15); i++) {
    const nonEmpty = rawRows[i].filter((c) => c.trim() !== "").length;
    if (nonEmpty > maxCols) { maxCols = nonEmpty; headerRowIdx = i; }
  }
  const headers = rawRows[headerRowIdx].map((h) => osCleanHeader(h)).filter((h) => h !== "");
  if (headers.length === 0) return null;
  const rows = rawRows.slice(headerRowIdx + 1).map((row) => {
    const obj: Record<string, string> = {};
    headers.forEach((h, i) => { obj[h] = row[i] ?? ""; });
    return obj;
  });
  return { name: file.name, headers, rows };
}

const Settings = () => {
  const [location] = useLocation();
  const form = useForm();
  const { toast } = useToast();
  const queryClient = useQueryClient();
  // Where "Open status" (Notion Webhook Status card) goes — NOTION_WEBHOOK_STATUS_URL in the server's
  // .env, or this app's own status page if that isn't set.
  const webhookStatusLinkQuery = useQuery<{ url: string; fromEnv: boolean }>({
    queryKey: ['/api/webhooks/notion/status-link'],
    queryFn: () => apiRequest('GET', '/api/webhooks/notion/status-link', undefined, false, true),
    staleTime: 5 * 60 * 1000,
  });
  const [isClearing, setIsClearing] = useState(false);
  const [isResetting, setIsResetting] = useState(false);
  const [showClearDialog, setShowClearDialog] = useState(false);
  const canWrite = hasPageWriteAccess('settings');

  // Voucher prefixes state
  const [prefixes, setPrefixes] = useState<{ expense?: string; toll?: string } | null>(null);
  const [saving, setSaving] = useState(false);
  const [isAdminUser, setIsAdminUser] = useState(false);
  const [originalPrefixes, setOriginalPrefixes] = useState<{ expense?: string; toll?: string } | null>(null);

  useEffect(() => {
    (async () => {
      try {
        const res = await apiRequest('GET', '/api/voucher-prefixes', undefined, false, true);
        if (res && res.data) {
          setPrefixes(res.data as any);
          setOriginalPrefixes(res.data as any);
        }
      } catch (e) {
        // ignore
      }
    })();

    try {
      const userString = localStorage.getItem('currentUser');
      if (userString) {
        const user = JSON.parse(userString);
        const role = (user?.role || '').toString().toLowerCase();
        setIsAdminUser(['admin', 'super-admin', 'superadmin', 'super_admin'].includes(role));
      }
    } catch (e) {
      // ignore
    }
  }, []);

  // NEW: dialog UI state
  const [confirmText, setConfirmText] = useState('');
  const [acknowledge, setAcknowledge] = useState(false);

  // NEW: counts (read from cache)
  // The real number of products, fetched when the Full Sync dialog opens — the old cache read
  // always said 0 here because this page never loads the product list itself.
  const productCountQuery = useQuery<any[]>({
    queryKey: ['/api/products', 'settings-count'],
    queryFn: () => apiRequest('GET', '/api/products?all=true', undefined, false, true),
    enabled: showClearDialog,
    staleTime: 0,
  });
  // Full Sync's live progress ("Rebuilding Product Master · 120 of 300") — the server keeps it,
  // so it's polled while the sync button is running.
  const fullSyncStatusQuery = useQuery<{ isSyncing: boolean; syncProgress: SyncProgress | null }>({
    queryKey: ['/api/notion-inventory-sync/status', 'settings-progress'],
    queryFn: () => apiRequest('GET', '/api/notion-inventory-sync/status', undefined, false, true),
    enabled: isClearing,
    refetchInterval: 1500,
  });
  const productCount: number | string = productCountQuery.isLoading
    ? '…'
    : Array.isArray(productCountQuery.data) ? productCountQuery.data.length : 0;
  const salesCount = (() => {
    const d = queryClient.getQueryData(['/api/sales']) as any;
    return Array.isArray(d) ? d.length : 0;
  })();
  const scanCount = (() => {
    const d = queryClient.getQueryData(['/api/scans']) as any;
    return Array.isArray(d) ? d.length : 0;
  })();

  // Clear Stock dialog state — stock-only (see server/routes/settings-admin.ts's header comment);
  // it never touches Order Import/Loading/Unloading scan history, so there's no void-vs-remove
  // choice to make here anymore.
  const [showClearStockDialog, setShowClearStockDialog] = useState(false);
  const [isClearingStock, setIsClearingStock] = useState(false);
  const [csPlant, setCsPlant] = useState<string>('');
  const [csConfirmText, setCsConfirmText] = useState('');
  // Optional — leave blank and this clears everything for the plant, exactly like before. Set it
  // and only orders/vehicles/deliveries dated on or before it clear (Order Import, Unloading, and
  // Loading via its proforma slip's own order date).
  const [csOrderDateUpTo, setCsOrderDateUpTo] = useState('');

  // Backup CSV — writes one <table>.csv per table into backups/<database>-csv-<date>_<time>/ on the
  // server, the same folder scripts/restore-database-csv.ps1 reads back.
  const [isBackingUpCsv, setIsBackingUpCsv] = useState(false);
  const [csvBackupResult, setCsvBackupResult] = useState<{ folder: string; tables: number; rows: number; megabytes: number } | null>(null);

  const runCsvBackup = async () => {
    setIsBackingUpCsv(true);
    try {
      const data = await apiRequest('POST', '/api/settings/backup-csv', {}, false, true);
      setCsvBackupResult({
        folder: data.folder,
        tables: data.tables?.length ?? 0,
        rows: data.totalRows ?? 0,
        megabytes: data.megabytes ?? 0,
      });
      toast({
        title: 'Backup saved',
        description: `${data.tables?.length ?? 0} table(s), ${data.totalRows ?? 0} row(s) written to ${data.folder}`,
      });
    } catch (error: any) {
      console.error('Error running CSV backup:', error);
      toast({ title: 'Backup failed', description: error?.message || 'Could not write the CSV backup', variant: 'destructive' });
    } finally {
      setIsBackingUpCsv(false);
    }
  };

  // Operational-data-only backup — Scan History, Unloading, Loading, Product/Plant/Vehicle
  // Master, User Management and Proforma Slip, WITHOUT stock_movements/product_plant_stock.
  // Same folder/file convention and restore script as the full backup above.
  const [isBackingUpScoped, setIsBackingUpScoped] = useState(false);
  const [scopedBackupResult, setScopedBackupResult] = useState<{ folder: string; tables: number; rows: number; megabytes: number } | null>(null);
  const runScopedCsvBackup = async () => {
    setIsBackingUpScoped(true);
    try {
      const data = await apiRequest('POST', '/api/settings/backup-csv-scoped', {}, false, true);
      setScopedBackupResult({
        folder: data.folder,
        tables: data.tables?.length ?? 0,
        rows: data.totalRows ?? 0,
        megabytes: data.megabytes ?? 0,
      });
      toast({
        title: 'Backup saved',
        description: `${data.tables?.length ?? 0} table(s), ${data.totalRows ?? 0} row(s) written to ${data.folder}`,
      });
    } catch (error: any) {
      console.error('Error running scoped CSV backup:', error);
      toast({ title: 'Backup failed', description: error?.message || 'Could not write the CSV backup', variant: 'destructive' });
    } finally {
      setIsBackingUpScoped(false);
    }
  };

  // Remove Scan & Order Import Data — the receiving side only: Order Import CSVs, the Scan
  // Operations work against them, their scan history and the stock they brought in. Loading and
  // Unloading are left alone. Entries are DELETED, not reversed — no adjust row is written.
  type ScanResetCounts = {
    sessions: number; importItems: number; scanItems: number; scanEvents: number;
    stockMovements: number; stockRowsAdjusted: number; qtyRemoved: number;
  };
  const [showScanResetDialog, setShowScanResetDialog] = useState(false);
  const [isResettingScan, setIsResettingScan] = useState(false);
  const [srPlant, setSrPlant] = useState<string>('');
  const [srOrderDateUpTo, setSrOrderDateUpTo] = useState('');
  const [srConfirmText, setSrConfirmText] = useState('');
  const [srError, setSrError] = useState<string | null>(null);

  const { data: srPreview, isFetching: srPreviewLoading } = useQuery<{
    counts: ScanResetCounts; totalRows: number; dateScoped: boolean; confirmPhrase: string;
  }>({
    queryKey: ['/api/settings/reset-scan-data/preview', srPlant, srOrderDateUpTo],
    queryFn: () =>
      apiRequest(
        'GET',
        `/api/settings/reset-scan-data/preview?plant=${encodeURIComponent(srPlant)}`
          + `${srOrderDateUpTo ? `&orderDateUpTo=${encodeURIComponent(srOrderDateUpTo)}` : ''}`,
      ).then((r) => r.json()),
    enabled: showScanResetDialog && !!srPlant,
  });

  const handleScanResetDialogOpenChange = (open: boolean) => {
    setShowScanResetDialog(open);
    if (!open) { setSrPlant(''); setSrOrderDateUpTo(''); setSrConfirmText(''); setSrError(null); }
  };

  const expectedSrConfirmText = srPlant === 'all' ? 'DELETE SCAN ALL' : `DELETE SCAN ${srPlant}`.toUpperCase();

  const resetScanData = async () => {
    if (!srPlant) return;
    setSrError(null);
    setIsResettingScan(true);
    try {
      const data = await apiRequest(
        'POST', '/api/settings/reset-scan-data',
        {
          plant: srPlant,
          ...(srOrderDateUpTo ? { orderDateUpTo: srOrderDateUpTo } : {}),
          confirm: srConfirmText.trim().toUpperCase(),
        },
        false, true,
      );
      toast({
        title: data.warning ? 'Scan data removed (with a note)' : 'Scan data removed',
        description: (data.warning ? `${data.warning} ` : '')
          + `${data.counts.sessions} CSV(s), ${data.counts.scanEvents} scan(s) deleted; `
          + `${data.counts.stockRowsAdjusted} stock row(s) reduced by ${data.counts.qtyRemoved} box(es). `
          + `Loading and Unloading untouched.`,
      });
      queryClient.invalidateQueries();
      handleScanResetDialogOpenChange(false);
    } catch (error: any) {
      console.error('Error removing scan data:', error);
      setSrError(error?.message || 'Failed to remove the data');
      toast({ title: 'Nothing was removed', description: error?.message || 'Failed to remove the data', variant: 'destructive' });
    } finally {
      setIsResettingScan(false);
    }
  };

  // Reset Operations Data — deletes the day-to-day work (scan history, stock, loading,
  // unloading, order imports) from the database for good, for one plant or for all of them.
  // Product Master, Vehicle Master, proforma slips, users and plants are kept. Same
  // preview + type-to-confirm gate as Clear Stock, because this one cannot be undone at all.
  type ResetCounts = {
    orderSessions: number; orderItems: number; orderScanItems: number; orderScanEvents: number;
    unloadSessions: number; unloadItems: number; unloadScanEvents: number;
    loadingRecords: number; loadingScanEvents: number; loadingHandoffs: number;
    loadOperations: number; loadOperationItems: number;
    stockRows: number; stockMovements: number;
    scanHistory: number; legacyScanSessions: number;
    slipsLoadingReset: number; activities: number;
  };
  const [showResetDialog, setShowResetDialog] = useState(false);
  const [isResettingOps, setIsResettingOps] = useState(false);
  const [rdPlant, setRdPlant] = useState<string>('');
  const [rdConfirmText, setRdConfirmText] = useState('');
  // Optional cut-off. Blank removes everything for the plant; set, it removes only what belongs to
  // orders DATED on or before it — the CSV's / proforma slip's own order date, never the day
  // someone scanned. See the header comment in server/routes/settings-admin.ts.
  const [rdOrderDateUpTo, setRdOrderDateUpTo] = useState('');
  const [resetError, setResetError] = useState<string | null>(null);

  // Recalculate Stock — Check (read-only) shows every stored stock total that doesn't match the
  // history; Apply corrects them. See server/lib/stockRecalc.ts.
  type RecalcPlantRow = {
    barcode: string; plant: string; itemName: string | null;
    storedStock: number; storedExtra: number; correctStock: number; correctExtra: number; storedRows: number;
  };
  type RecalcProductRow = { productId: number; barcode: string; itemName: string | null; storedTotal: number; correctTotal: number };
  type RecalcPreview = { plantCount: number; productCount: number; plantRows: RecalcPlantRow[]; productRows: RecalcProductRow[] };
  const [recalcOpen, setRecalcOpen] = useState(false);
  const [recalcPreview, setRecalcPreview] = useState<RecalcPreview | null>(null);
  const [recalcChecking, setRecalcChecking] = useState(false);
  const [recalcApplying, setRecalcApplying] = useState(false);
  const [recalcConfirm, setRecalcConfirm] = useState('');
  const runStockCheck = async () => {
    setRecalcChecking(true);
    try {
      const data = await apiRequest('GET', '/api/settings/recalculate-stock/preview', undefined, false, true);
      setRecalcPreview(data as RecalcPreview);
      setRecalcConfirm('');
      setRecalcOpen(true);
    } catch (error: any) {
      toast({ title: 'Check failed', description: error?.message || 'Could not check stock', variant: 'destructive' });
    } finally {
      setRecalcChecking(false);
    }
  };
  const applyStockRecalc = async () => {
    setRecalcApplying(true);
    try {
      const result: any = await apiRequest('POST', '/api/settings/recalculate-stock', {}, false, true);
      queryClient.invalidateQueries({ queryKey: ['/api/scan-sessions/reports/plant-stock'] });
      toast({
        title: 'Stock recalculated',
        description: `${result.plantRowsFixed} item total(s) and ${result.productTotalsFixed} product total(s) corrected.`,
      });
      setRecalcOpen(false);
      setRecalcPreview(null);
    } catch (error: any) {
      toast({ title: 'Recalculate failed', description: error?.message || 'Could not recalculate stock', variant: 'destructive' });
    } finally {
      setRecalcApplying(false);
    }
  };

  // Recalculate from events only — a stricter sibling: purely Order Scan + Unloading − Loading,
  // straight from their own raw event tables, bypassing stock_movements entirely (no Adjust,
  // Exchange, Clear Stock or Opening Stock counted). Same Check/Apply shape as above.
  const [recalcEventsOpen, setRecalcEventsOpen] = useState(false);
  const [recalcEventsPreview, setRecalcEventsPreview] = useState<RecalcPreview | null>(null);
  const [recalcEventsChecking, setRecalcEventsChecking] = useState(false);
  const [recalcEventsApplying, setRecalcEventsApplying] = useState(false);
  const [recalcEventsConfirm, setRecalcEventsConfirm] = useState('');
  const runStockCheckFromEvents = async () => {
    setRecalcEventsChecking(true);
    try {
      const data = await apiRequest('GET', '/api/settings/recalculate-stock-events/preview', undefined, false, true);
      setRecalcEventsPreview(data as RecalcPreview);
      setRecalcEventsConfirm('');
      setRecalcEventsOpen(true);
    } catch (error: any) {
      toast({ title: 'Check failed', description: error?.message || 'Could not check stock', variant: 'destructive' });
    } finally {
      setRecalcEventsChecking(false);
    }
  };
  const applyStockRecalcFromEvents = async () => {
    setRecalcEventsApplying(true);
    try {
      const result: any = await apiRequest('POST', '/api/settings/recalculate-stock-events', {}, false, true);
      queryClient.invalidateQueries({ queryKey: ['/api/scan-sessions/reports/plant-stock'] });
      toast({
        title: 'Stock recalculated from events',
        description: `${result.plantRowsFixed} item total(s) and ${result.productTotalsFixed} product total(s) corrected`
          + `${result.ledgerRowsBackfilled ? `, ${result.ledgerRowsBackfilled} missing ledger entr${result.ledgerRowsBackfilled === 1 ? 'y' : 'ies'} backfilled` : ''}.`,
      });
      setRecalcEventsOpen(false);
      setRecalcEventsPreview(null);
    } catch (error: any) {
      toast({ title: 'Recalculate failed', description: error?.message || 'Could not recalculate stock', variant: 'destructive' });
    } finally {
      setRecalcEventsApplying(false);
    }
  };

  // Fill Stock Ledger (from Scan + Unload + Load events) — narrower standalone sibling of
  // Recalculate from events above: only reconciles stock_movements against Order Scan,
  // Unloading and Loading's raw records, never touches live stock (product_plant_stock/products)
  // at all. For fixing Overall Stock's Opening/Purchase columns when the live stock number is
  // already right.
  type LedgerGapRow = { barcode: string; plant: string; earliestAt: string; gap: number; productId: number | null };
  type LedgerBackfillPreview = { scanGapCount: number; unloadGapCount: number; loadGapCount: number; totalGaps: number; totalGapQty: number; scanGaps: LedgerGapRow[]; unloadGaps: LedgerGapRow[]; loadGaps: LedgerGapRow[] };
  const [ledgerBackfillOpen, setLedgerBackfillOpen] = useState(false);
  const [ledgerBackfillPreview, setLedgerBackfillPreview] = useState<LedgerBackfillPreview | null>(null);
  const [ledgerBackfillChecking, setLedgerBackfillChecking] = useState(false);
  const [ledgerBackfillApplying, setLedgerBackfillApplying] = useState(false);
  const [ledgerBackfillConfirm, setLedgerBackfillConfirm] = useState('');
  const runLedgerBackfillCheck = async () => {
    setLedgerBackfillChecking(true);
    try {
      const data = await apiRequest('GET', '/api/settings/backfill-stock-ledger/preview', undefined, false, true);
      setLedgerBackfillPreview(data as LedgerBackfillPreview);
      setLedgerBackfillConfirm('');
      setLedgerBackfillOpen(true);
    } catch (error: any) {
      toast({ title: 'Check failed', description: error?.message || 'Could not check stock ledger', variant: 'destructive' });
    } finally {
      setLedgerBackfillChecking(false);
    }
  };
  const applyLedgerBackfill = async () => {
    setLedgerBackfillApplying(true);
    try {
      const result: any = await apiRequest('POST', '/api/settings/backfill-stock-ledger', {}, false, true);
      queryClient.invalidateQueries({ queryKey: ['/api/scan-sessions/reports/plant-stock'] });
      toast({
        title: 'Stock ledger filled',
        description: `${result.written} ledger entr${result.written === 1 ? 'y' : 'ies'} added from Scan/Unload/Load events.`,
      });
      setLedgerBackfillOpen(false);
      setLedgerBackfillPreview(null);
    } catch (error: any) {
      toast({ title: 'Fill failed', description: error?.message || 'Could not fill stock ledger', variant: 'destructive' });
    } finally {
      setLedgerBackfillApplying(false);
    }
  };

  // Clear Stock entry history — view + bulk-delete the ledger rows a past Clear Stock run left
  // behind. Deleting them is ledger-only (never touches live stock) — the point is to clean up
  // the history BEFORE running Recalculate Stock above, since Recalculate Stock otherwise tries
  // to "undo" Clear Stock using only whatever slice of real history the ledger happens to have,
  // which can overshoot deeply negative for any item with stock older than full ledger tracking.
  type ClearStockEntry = { id: number; barcode: string; plant: string; qty: number; reason: string; at: string; itemName: string | null };
  const [showClearStockEntries, setShowClearStockEntries] = useState(false);
  const [clearStockEntries, setClearStockEntries] = useState<ClearStockEntry[] | null>(null);
  const [clearStockEntriesLoading, setClearStockEntriesLoading] = useState(false);
  const [deletingClearStockEntries, setDeletingClearStockEntries] = useState(false);
  const loadClearStockEntries = async () => {
    setClearStockEntriesLoading(true);
    try {
      const data = await apiRequest('GET', '/api/settings/clear-stock-entries', undefined, false, true);
      setClearStockEntries(data.items);
      setShowClearStockEntries(true);
    } catch (error: any) {
      toast({ title: 'Could not load Clear Stock entries', description: error?.message, variant: 'destructive' });
    } finally {
      setClearStockEntriesLoading(false);
    }
  };
  const deleteAllClearStockEntries = async () => {
    setDeletingClearStockEntries(true);
    try {
      const result: any = await apiRequest('DELETE', '/api/settings/clear-stock-entries', {}, false, true);
      toast({
        title: 'Clear Stock entries removed',
        description: `${result.deleted} entr${result.deleted === 1 ? 'y' : 'ies'} deleted. Live stock wasn't changed — run Recalculate Stock next to rebuild it from the cleaned-up history.`,
      });
      setShowClearStockEntries(false);
      setClearStockEntries(null);
    } catch (error: any) {
      toast({ title: 'Delete failed', description: error?.message, variant: 'destructive' });
    } finally {
      setDeletingClearStockEntries(false);
    }
  };

  const { data: allPlants } = useQuery<any[]>({
    queryKey: ['/api/plants'],
    queryFn: () => apiRequest('GET', '/api/plants').then((r) => r.json()),
    staleTime: 60000,
  });

  // Sales tracking start date — Overall Stock's ledger's "all dates" Sale Qty sums from here
  // onward (proforma data before it isn't reliable). Was a hardcoded constant; now editable here.
  const { data: salesTrackingData } = useQuery<{ salesTrackingStartDate: string }>({
    queryKey: ['/api/settings/sales-tracking-start'],
    queryFn: () => apiRequest('GET', '/api/settings/sales-tracking-start').then((r) => r.json()),
  });
  const [salesTrackingStartDraft, setSalesTrackingStartDraft] = useState('');
  useEffect(() => {
    if (salesTrackingData?.salesTrackingStartDate) setSalesTrackingStartDraft(salesTrackingData.salesTrackingStartDate);
  }, [salesTrackingData?.salesTrackingStartDate]);
  const [isSavingSalesTrackingStart, setIsSavingSalesTrackingStart] = useState(false);
  const saveSalesTrackingStart = async () => {
    if (!salesTrackingStartDraft) return;
    setIsSavingSalesTrackingStart(true);
    try {
      await apiRequest('PUT', '/api/settings/sales-tracking-start', { date: salesTrackingStartDraft }, false, true);
      queryClient.invalidateQueries({ queryKey: ['/api/settings/sales-tracking-start'] });
      queryClient.invalidateQueries({ queryKey: ['/api/scan-sessions/reports/plant-stock'] });
      toast({ title: 'Saved', description: `Sales tracking now starts from ${salesTrackingStartDraft}.` });
    } catch (error: any) {
      toast({ title: 'Error', description: error?.message || 'Failed to save', variant: 'destructive' });
    } finally {
      setIsSavingSalesTrackingStart(false);
    }
  };

  const { data: csPreview, isFetching: csPreviewLoading } = useQuery<{
    productsWithStock: number;
    dateScoped: boolean;
    activeBlockers: { source: string; plant: string; orderDate: string | null; label: string }[];
    canClear: boolean;
  }>({
    queryKey: ['/api/settings/clear-stock/preview', csPlant, csOrderDateUpTo],
    queryFn: () =>
      apiRequest(
        'GET',
        `/api/settings/clear-stock/preview?plant=${encodeURIComponent(csPlant)}${csOrderDateUpTo ? `&orderDateUpTo=${encodeURIComponent(csOrderDateUpTo)}` : ''}`,
      ).then((r) => r.json()),
    enabled: showClearStockDialog && !!csPlant,
  });

  const handleClearStockDialogOpenChange = (open: boolean) => {
    setShowClearStockDialog(open);
    if (!open) {
      setCsPlant('');
      setCsConfirmText('');
      setCsOrderDateUpTo('');
    }
  };

  const expectedCsConfirmText = csPlant === 'all' ? 'CLEAR ALL' : `CLEAR ${csPlant}`.toUpperCase();

  const clearStock = async () => {
    if (!csPlant) return;
    setIsClearingStock(true);
    try {
      const data = await apiRequest(
        'POST', '/api/settings/clear-stock',
        { plant: csPlant, ...(csOrderDateUpTo ? { orderDateUpTo: csOrderDateUpTo } : {}) },
        false, true,
      );
      toast({
        title: 'Success',
        description: `Stock cleared for ${csPlant === 'all' ? 'all plants' : csPlant}${csOrderDateUpTo ? ` (orders up to ${csOrderDateUpTo})` : ''}. `
          + `${data.stockRowsCleared} stock row(s) adjusted.`,
      });
      queryClient.invalidateQueries({ queryKey: ['/api/products'] });
      queryClient.invalidateQueries({ queryKey: ['/api/scans'] });
      queryClient.invalidateQueries({ queryKey: ['/api/scan-sessions/reports/plant-stock'] });
    } catch (error: any) {
      console.error('Error clearing stock:', error);
      toast({ title: 'Error', description: error?.message || 'Failed to clear stock', variant: 'destructive' });
    } finally {
      setIsClearingStock(false);
      handleClearStockDialogOpenChange(false);
    }
  };

  const { data: rdPreview, isFetching: rdPreviewLoading } = useQuery<{
    counts: ResetCounts; totalRows: number; dateScoped: boolean;
    activeBlockers: { source: string; plant: string; orderDate: string | null; label: string }[];
    canReset: boolean; confirmPhrase: string;
  }>({
    queryKey: ['/api/settings/reset-operations/preview', rdPlant, rdOrderDateUpTo],
    queryFn: () =>
      apiRequest(
        'GET',
        `/api/settings/reset-operations/preview?plant=${encodeURIComponent(rdPlant)}`
          + `${rdOrderDateUpTo ? `&orderDateUpTo=${encodeURIComponent(rdOrderDateUpTo)}` : ''}`,
      ).then((r) => r.json()),
    enabled: showResetDialog && !!rdPlant,
  });

  const handleResetDialogOpenChange = (open: boolean) => {
    setShowResetDialog(open);
    if (!open) { setRdPlant(''); setRdConfirmText(''); setRdOrderDateUpTo(''); setResetError(null); }
  };

  const expectedRdConfirmText = rdPlant === 'all' ? 'DELETE ALL' : `DELETE ${rdPlant}`.toUpperCase();

  const resetOperationsData = async () => {
    if (!rdPlant) return;
    setResetError(null);
    setIsResettingOps(true);
    try {
      const data = await apiRequest(
        'POST', '/api/settings/reset-operations',
        {
          plant: rdPlant,
          ...(rdOrderDateUpTo ? { orderDateUpTo: rdOrderDateUpTo } : {}),
          confirm: rdConfirmText.trim().toUpperCase(),
        },
        false, true,
      );
      toast({
        title: data.warning ? 'Data removed (with a note)' : 'Data removed',
        description: (data.warning ? `${data.warning} ` : '')
          + `${data.totalRows} row(s) deleted for ${rdPlant === 'all' ? 'all plants' : rdPlant}`
          + `${rdOrderDateUpTo ? ` (orders up to ${rdOrderDateUpTo})` : ''}. `
          + `${data.dateScoped ? `${data.counts.stockRows} stock row(s) corrected` : `${data.counts.stockRows} stock row(s) deleted`}, `
          + `${data.counts.slipsLoadingReset} proforma slip(s) can be loaded again from the start.`,
      });
      // Everything on screen was just built from data that no longer exists.
      queryClient.invalidateQueries();
      // Closed only once the removal actually succeeded.
      handleResetDialogOpenChange(false);
    } catch (error: any) {
      console.error('Error resetting operations data:', error);
      // The dialog deliberately STAYS OPEN on a failure: closing it used to hide the reason and
      // leave the person unsure whether anything was deleted (nothing is — the whole removal runs
      // in one transaction that rolls back). The message is shown in the dialog as well as in a
      // toast, so it can be read and retried without reopening and re-typing the phrase.
      setResetError(error?.message || 'Failed to remove the data');
      toast({ title: 'Nothing was removed', description: error?.message || 'Failed to remove the data', variant: 'destructive' });
    } finally {
      setIsResettingOps(false);
    }
  };

  // ── Opening Stock: ADDS each barcode's quantity onto the plant's current stock from a CSV,
  // same as a real receipt (Order Scan/Unloading also add via scan events) — and also records it
  // as Opening Stock on the ledger (server/routes/opening-stock.ts), so Stock Overview attributes
  // it correctly instead of as a Purchase. Never an absolute override — re-importing adds more on
  // top, it never resets a barcode to a fixed number (unlike Clear Stock, which zeroes it).
  // Admin-only, same severity class as Clear Stock, so it gets the same impact-preview +
  // type-to-confirm gate.
  const [showOpeningStockDialog, setShowOpeningStockDialog] = useState(false);
  const [osPlant, setOsPlant] = useState('');
  // The day this count was actually taken — the stock going INTO this date, same meaning as a
  // plain accounting Opening Balance. Defaults to today; lets a count taken a few days ago (or
  // planned to take effect on a future date) land in the right place instead of always being
  // "as of today".
  const [osAsOfDate, setOsAsOfDate] = useState(osTodayLocalDateStr());
  // 'add' = put the CSV's quantities on top (the original behaviour); 'set' = make each item's opening for this date equal to the CSV's quantity.
  const [osMode, setOsMode] = useState<'add' | 'set'>('add');
  const [osFile, setOsFile] = useState<File | null>(null);
  const [osRows, setOsRows] = useState<{ barcode: string; itemName: string | null; quantity: number }[] | null>(null);
  const [osPreview, setOsPreview] = useState<{ totalRows: number; distinctBarcodes: number; barcodesWithExistingStock: number; totalQtyToSet: number } | null>(null);
  const [osPreviewLoading, setOsPreviewLoading] = useState(false);
  const [osImporting, setOsImporting] = useState(false);
  const [osConfirmText, setOsConfirmText] = useState('');
  // Column-mapping step — same two-stage flow as Order Import: parse the file, auto-match what
  // it can, then ALWAYS let the mapping be reviewed/corrected in a dialog before any row is
  // built, rather than silently accepting a guess or hard-failing when auto-match misses.
  const [showOsMappingDialog, setShowOsMappingDialog] = useState(false);
  const [osCsvData, setOsCsvData] = useState<{ name: string; headers: string[]; rows: Record<string, string>[] } | null>(null);
  const [osMapping, setOsMapping] = useState<OsMapping>({ barcode: OS_SKIP, itemName: OS_SKIP, quantity: OS_SKIP });

  const handleOpeningStockDialogOpenChange = (open: boolean) => {
    setShowOpeningStockDialog(open);
    if (!open) {
      setOsPlant(''); setOsMode('add'); setOsAsOfDate(osTodayLocalDateStr()); setOsFile(null); setOsRows(null); setOsPreview(null); setOsConfirmText('');
      setShowOsMappingDialog(false); setOsCsvData(null);
    }
  };

  async function handleOpeningStockFile(file: File) {
    setOsFile(file);
    setOsRows(null);
    setOsPreview(null);
    const parsed = await parseOsCsvRaw(file);
    if (!parsed) {
      toast({ title: 'Could not read this file', description: 'No column headers could be detected in it.', variant: 'destructive' });
      return;
    }
    if (parsed.rows.length === 0) {
      toast({ title: 'Empty file', description: 'This file has no rows.', variant: 'destructive' });
      return;
    }
    setOsCsvData(parsed);
    setOsMapping(osAutoMatch(parsed.headers));
    // Two modal dialogs open at once (this one stacked on the still-open "Import Opening Stock"
    // AlertDialog) fights Radix's own focus-trap/pointer-events handling — closing the outer one
    // first (NOT via handleOpeningStockDialogOpenChange, which would wipe osPlant/osFile too) is
    // what actually lets the mapping dialog receive clicks. confirmOsMapping/cancelOsMapping
    // below re-open it once the mapping step is done.
    setShowOpeningStockDialog(false);
    setShowOsMappingDialog(true);
  }

  function confirmOsMapping() {
    if (!osCsvData) return;
    const { rows, skipped } = buildOsRowsFromMapping(osCsvData, osMapping);
    if (rows.length === 0) {
      toast({ title: 'No valid barcodes found', description: 'Check the Barcode column mapping.', variant: 'destructive' });
      return;
    }
    if (skipped.length > 0) {
      const reasons = new Set(skipped.map((s) => s.reason));
      toast({
        title: `Skipped ${skipped.length} row(s) with an unreadable barcode`,
        description: Array.from(reasons).join(' — '),
        variant: 'destructive',
      });
    }
    setOsRows(rows);
    setShowOsMappingDialog(false);
    setShowOpeningStockDialog(true);
  }

  // Back out of mapping without importing anything — same place (the outer dialog, file/mapping
  // cleared) whether triggered by the Cancel button or by dismissing the dialog itself (Escape /
  // overlay click), so the user never ends up with neither dialog open.
  function cancelOsMapping() {
    setShowOsMappingDialog(false);
    setOsCsvData(null);
    setOsFile(null);
    setShowOpeningStockDialog(true);
  }

  useEffect(() => {
    if (!osPlant || !osRows) { setOsPreview(null); return; }
    setOsPreviewLoading(true);
    apiRequest('POST', '/api/opening-stock/preview', { plant: osPlant, items: osRows }, false, true)
      .then((data) => setOsPreview(data))
      .catch((err: any) => toast({ title: 'Failed to load preview', description: err?.message, variant: 'destructive' }))
      .finally(() => setOsPreviewLoading(false));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [osPlant, osRows]);

  const osExpectedConfirmText = `ADD ${osPlant}`.toUpperCase();

  const importOpeningStock = async () => {
    if (!osPlant || !osRows) return;
    setOsImporting(true);
    try {
      const data = await apiRequest('POST', '/api/opening-stock/import', { plant: osPlant, items: osRows, asOfDate: osAsOfDate, mode: osMode }, false, true);
      toast({ title: osMode === 'set' ? 'Opening stock set' : 'Opening stock added', description: osMode === 'set' ? `${data.rowsSet} barcode(s) now have the CSV's quantity as their Opening Stock for ${osPlant}.` : `${data.rowsSet} barcode(s) added to current stock and Opening Stock for ${osPlant}.` });
      queryClient.invalidateQueries({ queryKey: ['/api/products'] });
      queryClient.invalidateQueries({ queryKey: ['/api/scan-sessions/reports/plant-stock'] });
      handleOpeningStockDialogOpenChange(false);
    } catch (error: any) {
      console.error('Error importing opening stock:', error);
      toast({ title: 'Error', description: error?.message || 'Failed to import opening stock', variant: 'destructive' });
    } finally {
      setOsImporting(false);
    }
  };

  // NEW: reset dialog when closed
  const handleClearDialogOpenChange = (open: boolean) => {
    setShowClearDialog(open);
    if (!open) {
      setConfirmText('');
      setAcknowledge(false);
    }
  };

  // Full Sync Product Master — the same full sync the Product Master page has: it reads every
  // product from Notion first and only then clears the Product Master and rebuilds it from
  // scratch (nothing is deleted if Notion can't be read). Replaces the plain "Clear Product
  // Master" button here, since an empty Product Master was never the goal.
  const fullSyncProductMaster = async () => {
    setIsClearing(true);
    setShowClearDialog(false); // the progress popup takes over from the confirmation
    try {
      const data = await apiRequest('POST', '/api/notion-inventory-sync/full-sync', {}, false, true);
      toast({ title: "Product Master rebuilt", description: `${data?.created ?? 0} products imported from Notion.` });
      queryClient.invalidateQueries({ queryKey: ['/api/products'] });
      queryClient.invalidateQueries({ queryKey: ['/api/notion-inventory-sync/status'] });
    } catch (error: any) {
      console.error("Error in full sync:", error);
      toast({ title: "Full sync failed", description: error?.message || "Could not rebuild the Product Master from Notion.", variant: "destructive" });
    } finally {
      setIsClearing(false);
      setShowClearDialog(false);
      setConfirmText('');
      setAcknowledge(false);
    }
  };

  const clearInventory = async () => {
    // Native confirm removed
    setIsClearing(true);
    try {
      const response = await fetch('/api/products/clear', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' }
      });
      if (response.ok) {
        const data = await response.json();
        toast({ title: "Success", description: "Inventory data cleared successfully", variant: "default" });
        // OPTIMIZATION: Update cache directly to empty list instead of refetching
        // This solves the rendering issue by immediately clearing the UI without needing a refresh
        queryClient.setQueriesData({ queryKey: ['/api/products'] }, (oldData: any) => []);
        queryClient.setQueriesData({ queryKey: ['/api/sales'] }, []);
        queryClient.setQueriesData({ queryKey: ['/api/scans'] }, []);
        queryClient.invalidateQueries({ queryKey: ['/api/products'] });
        queryClient.invalidateQueries({ queryKey: ['/api/sales'] });
        queryClient.invalidateQueries({ queryKey: ['/api/scans'] });
      } else {
        const errorData = await response.text();
        toast({ title: "Error", description: "Failed to clear inventory data", variant: "destructive" });
        console.error("Error clearing inventory:", errorData);
      }
    } catch (error) {
      console.error("Error clearing inventory:", error);
      toast({ title: "Error", description: "An unexpected error occurred", variant: "destructive" });
    } finally {
      setIsClearing(false);
      setShowClearDialog(false);
      setConfirmText('');
      setAcknowledge(false);
    }
  };
  
  const resetStock = async () => {
    if (!confirm("Are you sure you want to reset all stock values to zero? This action cannot be undone.")) {
      return;
    }
    
    setIsResetting(true);
    try {
      const response = await fetch('/api/products/reset-stock', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' }
      });
      
      if (response.ok) {
        const data = await response.json();
        toast({
          title: "Success",
          description: `Stock values reset successfully. ${data.updatedCount} products updated.`,
          variant: "default"
        });
        console.log("Stock reset:", data);

        // OPTIMIZATION: Update cache directly to reset values locally
        // This makes the UI update instantly without waiting for a refetch
        queryClient.setQueriesData({ queryKey: ['/api/products'] }, (oldData: any) => {
          if (Array.isArray(oldData)) {
            return oldData.map((product: any) => ({
              ...product,
              inStock: 0,
              purchased: 0,
              sold: 0,
              pallets: 0,
              // Update timestamp to now
              lastUpdated: new Date().toISOString()
            }));
          }
          return oldData;
        });
      } else {
        const errorData = await response.text();
        toast({
          title: "Error",
          description: "Failed to reset stock values",
          variant: "destructive"
        });
        console.error("Error resetting stock:", errorData);
      }
    } catch (error) {
      console.error("Error resetting stock:", error);
      toast({
        title: "Error",
        description: "An unexpected error occurred",
        variant: "destructive"
      });
    } finally {
      setIsResetting(false);
    }
  };
  
  return (
    <>
      {/* Mobile Header */}
      <header className="lg:hidden bg-white border-b border-gray-200 p-4">
        <div className="flex items-center justify-between">
          <div className="flex items-center space-x-3">
            <div className="w-10 h-10 rounded-lg bg-primary flex items-center justify-center text-white font-bold">
              KM
            </div>
            <h1 className="text-xl font-bold">KM-Tribe</h1>
          </div>
          <MobileMenu currentPath={location} />
        </div>
      </header>
      
      <div className="flex-1 overflow-y-auto p-4 lg:p-6">
        <div className="max-w-4xl mx-auto">
          <div className="mb-6">
            <h2 className="text-2xl font-bold">Settings</h2>
            <p className="text-gray-600">Configure application preferences</p>
          </div>
          
          <Tabs defaultValue="scanner">
            <TabsList className="mb-6">
              <TabsTrigger value="scanner">Scanner</TabsTrigger>
              <TabsTrigger value="app">Application</TabsTrigger>
              <TabsTrigger value="data">Data Management</TabsTrigger>
            </TabsList>
            
            <TabsContent value="scanner">
              <Card>
                <CardHeader>
                  <CardTitle>Scanner Settings</CardTitle>
                  <CardDescription>Configure how the barcode scanner functions</CardDescription>
                </CardHeader>
                <CardContent className="space-y-6">
                  <div className="space-y-4">
                    <div className="flex items-center justify-between">
                      <div className="space-y-0.5">
                        <Label htmlFor="camera-flash">Camera Flash</Label>
                        <p className="text-sm text-muted-foreground">
                          Enable camera flash by default when scanning
                        </p>
                      </div>
                      <Switch id="camera-flash" />
                    </div>
                    
                    <div className="flex items-center justify-between">
                      <div className="space-y-0.5">
                        <Label htmlFor="continuous-scan">Continuous Scanning</Label>
                        <p className="text-sm text-muted-foreground">
                          Allow scanning multiple barcodes without closing dialog
                        </p>
                      </div>
                      <Switch id="continuous-scan" />
                    </div>
                    
                    <div className="flex items-center justify-between">
                      <div className="space-y-0.5">
                        <Label htmlFor="auto-detect">Auto Detection</Label>
                        <p className="text-sm text-muted-foreground">
                          Automatically detect and scan barcodes without pressing button
                        </p>
                      </div>
                      <Switch id="auto-detect" defaultChecked />
                    </div>
                    
                    <div className="border-t pt-4">
                      <h4 className="text-sm font-medium mb-2">Supported Barcode Types</h4>
                      <div className="grid grid-cols-1 md:grid-cols-2 gap-y-2">
                        <div className="flex items-center space-x-2">
                          <input type="checkbox" id="ean13" defaultChecked />
                          <label htmlFor="ean13" className="text-sm">EAN-13</label>
                        </div>
                        <div className="flex items-center space-x-2">
                          <input type="checkbox" id="ean8" defaultChecked />
                          <label htmlFor="ean8" className="text-sm">EAN-8</label>
                        </div>
                        <div className="flex items-center space-x-2">
                          <input type="checkbox" id="upc" defaultChecked />
                          <label htmlFor="upc" className="text-sm">UPC-A/UPC-E</label>
                        </div>
                        <div className="flex items-center space-x-2">
                          <input type="checkbox" id="code128" defaultChecked />
                          <label htmlFor="code128" className="text-sm">Code 128</label>
                        </div>
                        <div className="flex items-center space-x-2">
                          <input type="checkbox" id="code39" defaultChecked />
                          <label htmlFor="code39" className="text-sm">Code 39</label>
                        </div>
                        <div className="flex items-center space-x-2">
                          <input type="checkbox" id="qr" defaultChecked />
                          <label htmlFor="qr" className="text-sm">QR Code</label>
                        </div>
                      </div>
                    </div>
                  </div>
                  
                  <div className="flex justify-end">
                    <Button>Save Settings</Button>
                  </div>
                </CardContent>
              </Card>
            </TabsContent>
            
            <TabsContent value="app">
              <Card>
                <CardHeader>
                  <CardTitle>Application Settings</CardTitle>
                  <CardDescription>Configure general application preferences</CardDescription>
                </CardHeader>
                <CardContent className="space-y-6">
                  <div className="space-y-4">
                    <div className="flex items-center justify-between">
                      <div className="space-y-0.5">
                        <Label htmlFor="dark-mode">Dark Mode</Label>
                        <p className="text-sm text-muted-foreground">
                          Switch between light and dark theme
                        </p>
                      </div>
                      <Switch id="dark-mode" />
                    </div>
                    
                    <div className="flex items-center justify-between">
                      <div className="space-y-0.5">
                        <Label htmlFor="notifications">Notifications</Label>
                        <p className="text-sm text-muted-foreground">
                          Enable notifications for important events
                        </p>
                      </div>
                      <Switch id="notifications" defaultChecked />
                    </div>
                    
                    <div className="space-y-2">
                      <Label htmlFor="language">Language</Label>
                      <select 
                        id="language" 
                        className="w-full flex h-10 rounded-md border border-input bg-background px-3 py-2 text-sm ring-offset-background focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2"
                      >
                        <option value="en">English</option>
                        <option value="es">Español</option>
                        <option value="fr">Français</option>
                      </select>
                    </div>
                  </div>
                  
                  <div className="flex justify-end">
                    <Button>Save Settings</Button>
                  </div>
                </CardContent>
              </Card>

              {/* Voucher Prefixes - centrally managed by admin */}
              <Card className="mt-6">
                <CardHeader>
                  <CardTitle>Voucher Prefixes</CardTitle>
                  <CardDescription>Set canonical prefixes for Expense and Toll vouchers (admin only)</CardDescription>
                </CardHeader>
                <CardContent>
                  <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                    <div>
                      <Label>Expense Prefix</Label>
                      <Input
                        value={prefixes?.expense || ''}
                        onChange={(e) => setPrefixes((p: any) => ({ ...(p||{}), expense: e.target.value }))}
                        disabled={!isAdminUser && !canWrite}
                        placeholder="e.g. KM2526-EV-"
                      />
                    </div>
                    <div>
                      <Label>Toll Prefix</Label>
                      <Input
                        value={prefixes?.toll || ''}
                        onChange={(e) => setPrefixes((p: any) => ({ ...(p||{}), toll: e.target.value }))}
                        disabled={!isAdminUser && !canWrite}
                        placeholder="e.g. KM2526-TV-"
                      />
                    </div>
                  </div>

                  <div className="mt-4 flex gap-2 justify-end">
                    <Button
                      type="button"
                      onClick={async (e) => {
                        e.preventDefault();
                        setSaving(true);
                        try {
                          const toSave: string[] = [];
                          const types: Array<'expense' | 'toll'> = ['expense', 'toll'];
                          for (const t of types) {
                            const current = (prefixes as any)?.[t];
                            const original = (originalPrefixes as any)?.[t];
                            // If original is null (never loaded), treat non-empty as changed
                            if (original === undefined || original === null) {
                              if (current) toSave.push(t);
                            } else if (String(current || '') !== String(original || '')) {
                              toSave.push(t);
                            }
                          }

                          if (toSave.length === 0) {
                            toast({ title: 'No changes', description: 'Nothing to save' });
                            setSaving(false);
                            return;
                          }

                          let finalData: any = originalPrefixes ? { ...(originalPrefixes as any) } : {};
                          for (const t of toSave) {
                            try {
                              const res = await apiRequest('PUT', `/api/voucher-prefixes/${t}`, { prefix: (prefixes as any)?.[t] || '' }, false, true);
                              if (res && res.data) {
                                // server returns full set; merge
                                finalData = { ...(finalData || {}), ...(res.data || {}) };
                              }
                            } catch (err) {
                              console.error(`Failed to save prefix ${t}:`, err);
                              // continue with others
                            }
                          }

                          if (finalData) {
                            setPrefixes(finalData);
                            setOriginalPrefixes(finalData);
                          }

                          try { localStorage.setItem('voucher_prefixes_updated', String(Date.now())); } catch (e) {}
                          toast({ title: 'Saved', description: 'Voucher prefixes updated' });
                        } catch (e: any) {
                          console.error('Failed to save voucher prefixes', e);
                          toast({ title: 'Error', description: 'Failed to save prefixes', variant: 'destructive' });
                        } finally {
                          setSaving(false);
                        }
                      }}
                      disabled={(!isAdminUser && !canWrite) || saving}
                    >
                      {saving ? 'Saving...' : 'Save Prefixes'}
                    </Button>
                  </div>
                </CardContent>
              </Card>
            </TabsContent>
            
            <TabsContent value="data">
              <Card>
                <CardHeader>
                  <CardTitle>Data Management</CardTitle>
                  <CardDescription>Manage your application data</CardDescription>
                </CardHeader>
                <CardContent className="space-y-6">
                  <div className="space-y-4">
                    <div className="p-4 border rounded-lg bg-gray-50">
                      <h4 className="font-medium flex items-center"><Database className="h-4 w-4 mr-2" /> Data Export</h4>
                      <p className="text-sm text-gray-600 mt-1 mb-3">Export your scan history and inventory data</p>
                      <div className="flex space-x-2">
                        <Button variant="outline" size="sm">Export Inventory</Button>
                        <Button variant="outline" size="sm">Export Scan History</Button>
                      </div>
                    </div>
                    
                    <div className="p-4 border rounded-lg bg-gray-50">
                      <h4 className="font-medium flex items-center"><Database className="h-4 w-4 mr-2" /> Opening Stock</h4>
                      <p className="text-sm text-gray-600 mt-1 mb-3">Import a plant's opening stock from a CSV (Barcode + Quantity) — it is added on top of the stock that is there, or, in "Set" mode, each item's opening becomes the CSV's quantity. Admin only. Use Edit Opening Stock below to change what was imported.</p>
                      <Button
                        variant="outline" size="sm"
                        onClick={() => setShowOpeningStockDialog(true)}
                        disabled={!isAdminUser}
                        title={!isAdminUser ? "Admin access required" : undefined}
                      >
                        Import Opening Stock
                      </Button>
                    </div>

                    <OpeningStockEditorCard isAdmin={isAdminUser} />

                    <ManualSalesCard isAdmin={isAdminUser} />

                    <LoadingFromSalesCard isAdmin={isAdminUser} />

                    <div className="p-4 border rounded-lg bg-gray-50">
                      <h4 className="font-medium flex items-center"><CalendarDays className="h-4 w-4 mr-2" /> Stock Tracking Start</h4>
                      <p className="text-sm text-gray-600 mt-1 mb-3">
                        When no date is picked on Overall Stock, its Purchase, Expected, Expected Sale and Sale columns count from this date onward. Everything before it is still included, as the Opening stock.
                      </p>
                      <div className="flex flex-wrap items-center gap-2">
                        <Input
                          type="date"
                          value={salesTrackingStartDraft}
                          onChange={(e) => setSalesTrackingStartDraft(e.target.value)}
                          disabled={!isAdminUser}
                          className="w-auto"
                        />
                        <Button
                          size="sm"
                          onClick={saveSalesTrackingStart}
                          disabled={!isAdminUser || isSavingSalesTrackingStart || !salesTrackingStartDraft || salesTrackingStartDraft === salesTrackingData?.salesTrackingStartDate}
                        >
                          {isSavingSalesTrackingStart ? 'Saving...' : 'Save'}
                        </Button>
                      </div>
                    </div>

                    {/* Recalculate Stock + Recalculate Stock (from events only) — hidden from the
                        UI for everyone, including admin/super-admin, same treatment as Clear
                        Stock/Backup above (not removed: runStockCheck/runStockCheckFromEvents,
                        their state, and the backend routes are all still here). Fill Stock
                        Ledger below is the one recalculation tool left reachable from here. */}
                    {false && (<>
                    <div className="p-4 border rounded-lg bg-gray-50">
                      <h4 className="font-medium flex items-center"><RefreshCw className="h-4 w-4 mr-2" /> Recalculate Stock</h4>
                      <p className="text-sm text-gray-600 mt-1 mb-3">
                        Adds up every item's stock again from its full history (every scan, unloading, loading and adjustment)
                        and fixes any stock total that doesn't match. Check first to see what would change — nothing is changed until you apply.
                      </p>
                      <Button
                        variant="outline" size="sm"
                        onClick={runStockCheck}
                        disabled={!isAdminUser || recalcChecking}
                        title={!isAdminUser ? "Admin access required" : undefined}
                      >
                        {recalcChecking ? <><Loader2 className="h-3.5 w-3.5 mr-1.5 animate-spin" /> Checking…</> : 'Check stock'}
                      </Button>
                    </div>

                    <div className="p-4 border rounded-lg bg-gray-50">
                      <h4 className="font-medium flex items-center"><RefreshCw className="h-4 w-4 mr-2" /> Recalculate Stock (from events only)</h4>
                      <p className="text-sm text-gray-600 mt-1 mb-3">
                        Stricter version of Recalculate Stock above: computes each item's live stock purely from Order Scan,
                        Unloading and Loading's own raw scan records — a manual Adjust, Exchange, Opening Stock import or
                        Clear Stock entry has no effect on this number at all. Apply also backfills any barcode+plant
                        whose real scan activity never made it into the stock_movements ledger at all (so Overall Stock's
                        Opening/Purchase/Sale show the real numbers too, not just the live stock figure).
                      </p>
                      <Button
                        variant="outline" size="sm"
                        onClick={runStockCheckFromEvents}
                        disabled={!isAdminUser || recalcEventsChecking}
                        title={!isAdminUser ? "Admin access required" : undefined}
                      >
                        {recalcEventsChecking ? <><Loader2 className="h-3.5 w-3.5 mr-1.5 animate-spin" /> Checking…</> : 'Check stock (events only)'}
                      </Button>
                    </div>
                    </>)}

                    {/* Fill Stock Ledger, Clear Stock History and Notion Webhook Status — hidden
                        from the UI for everyone, including admin/super-admin, same treatment as
                        everything else above (not removed: runLedgerBackfillCheck,
                        loadClearStockEntries, webhookStatusLinkQuery, their state, and the
                        backend routes are all still here). */}
                    {false && (<>
                    <div className="p-4 border rounded-lg bg-gray-50">
                      <h4 className="font-medium flex items-center"><RefreshCw className="h-4 w-4 mr-2" /> Fill Stock Ledger (from Scan + Unload + Load events)</h4>
                      <p className="text-sm text-gray-600 mt-1 mb-3">
                        Only fills in missing stock_movements entries from Order Scan, Unloading and Loading's own raw
                        records — it never touches the live stock number. Use this when the Stock page already shows the
                        right quantity but Overall Stock's Opening/Purchase columns still show 0 for it.
                      </p>
                      <Button
                        variant="outline" size="sm"
                        onClick={runLedgerBackfillCheck}
                        disabled={!isAdminUser || ledgerBackfillChecking}
                        title={!isAdminUser ? "Admin access required" : undefined}
                      >
                        {ledgerBackfillChecking ? <><Loader2 className="h-3.5 w-3.5 mr-1.5 animate-spin" /> Checking…</> : 'Check ledger'}
                      </Button>
                    </div>

                    <div className="p-4 border rounded-lg bg-gray-50">
                      <h4 className="font-medium flex items-center"><Trash2 className="h-4 w-4 mr-2" /> Clear Stock History</h4>
                      <p className="text-sm text-gray-600 mt-1 mb-3">
                        View every ledger entry a past Clear Stock run left behind, and remove them. This only cleans up the
                        history — it never changes live stock by itself. Do this BEFORE Recalculate Stock above if Clear Stock
                        has run recently, otherwise Recalculate Stock may push items with older stock history negative.
                      </p>
                      <Button
                        variant="outline" size="sm"
                        onClick={loadClearStockEntries}
                        disabled={!isAdminUser || clearStockEntriesLoading}
                        title={!isAdminUser ? "Admin access required" : undefined}
                      >
                        {clearStockEntriesLoading ? <><Loader2 className="h-3.5 w-3.5 mr-1.5 animate-spin" /> Loading…</> : 'View Clear Stock entries'}
                      </Button>
                    </div>

                    {/* Notion webhook check — opens the admin-only status page in a new tab: is the token set,
                        and what did the last changes from Notion do (updated / unchanged / error). */}
                    <div className="p-4 border rounded-lg bg-gray-50">
                      <h4 className="font-medium flex items-center"><Webhook className="h-4 w-4 mr-2" /> Notion Webhook Status</h4>
                      <p className="text-sm text-gray-600 mt-1 mb-3">
                        Check that changes made in Notion (order status, vehicles, products) are reaching the app, and see what
                        happened to the most recent ones.
                      </p>
                      <Button
                        variant="outline" size="sm"
                        onClick={() => window.open(webhookStatusLinkQuery.data?.url ?? '/api/webhooks/notion/status', '_blank', 'noopener')}
                        disabled={!isAdminUser}
                        title={!isAdminUser ? "Admin access required" : undefined}
                      >
                        <ExternalLink className="h-3.5 w-3.5 mr-1.5" /> Open status
                      </Button>
                      {isAdminUser && webhookStatusLinkQuery.data && (
                        <p className="mt-2 break-all text-xs text-gray-400">
                          Opens {webhookStatusLinkQuery.data?.url}
                          {!webhookStatusLinkQuery.data?.fromEnv && ' (set NOTION_WEBHOOK_STATUS_URL in .env to change it)'}
                        </p>
                      )}
                    </div>
                    </>)}

                    {/* Backup CSV + Backup Operational Data — hidden from the UI for everyone,
                        including admin/super-admin (not removed: runCsvBackup/runScopedCsvBackup,
                        their state, and the backend routes are all still here; re-add these two
                        Button blocks to bring them back). */}
                    {false && (<>
                    <div className="p-4 border rounded-lg">
                      <h4 className="font-medium flex items-center"><Database className="h-4 w-4 mr-2" /> Backup CSV</h4>
                      <p className="text-sm text-gray-600 mt-1 mb-3">
                        Saves every table as its own .csv file on the server, under
                        <span className="font-mono"> backups/&lt;database&gt;-csv-&lt;date&gt;_&lt;time&gt;/</span> — the same
                        folder the restore script reads back. Nothing is changed or deleted.
                      </p>
                      <Button
                        variant="outline" size="sm"
                        onClick={runCsvBackup}
                        disabled={isBackingUpCsv || !isAdminUser}
                        title={!isAdminUser ? "Admin access required" : undefined}
                      >
                        {isBackingUpCsv
                          ? <><Loader2 className="mr-1.5 h-3.5 w-3.5 animate-spin" /> Backing up…</>
                          : <><Download className="mr-1.5 h-3.5 w-3.5" /> Backup CSV</>}
                      </Button>
                      {csvBackupResult && (
                        <p className="mt-2 break-all text-xs text-gray-500">
                          Last backup: {csvBackupResult?.tables} table(s), {csvBackupResult?.rows.toLocaleString()} row(s),
                          {' '}{csvBackupResult?.megabytes.toFixed(1)} MB → <span className="font-mono">{csvBackupResult?.folder}</span>
                        </p>
                      )}
                    </div>

                    <div className="p-4 border rounded-lg">
                      <h4 className="font-medium flex items-center"><Database className="h-4 w-4 mr-2" /> Backup Operational Data</h4>
                      <p className="text-sm text-gray-600 mt-1 mb-3">
                        Same as Backup CSV above, but only Scan History, Unloading, Loading, Product/Plant/Vehicle Master, User
                        Management, Proforma Slip and the Activity log — no stock_movements or product_plant_stock. Same folder,
                        same restore script.
                      </p>
                      <Button
                        variant="outline" size="sm"
                        onClick={runScopedCsvBackup}
                        disabled={isBackingUpScoped || !isAdminUser}
                        title={!isAdminUser ? "Admin access required" : undefined}
                      >
                        {isBackingUpScoped
                          ? <><Loader2 className="mr-1.5 h-3.5 w-3.5 animate-spin" /> Backing up…</>
                          : <><Download className="mr-1.5 h-3.5 w-3.5" /> Backup Operational Data</>}
                      </Button>
                      {scopedBackupResult && (
                        <p className="mt-2 break-all text-xs text-gray-500">
                          Last backup: {scopedBackupResult?.tables} table(s), {scopedBackupResult?.rows.toLocaleString()} row(s),
                          {' '}{scopedBackupResult?.megabytes.toFixed(1)} MB → <span className="font-mono">{scopedBackupResult?.folder}</span>
                        </p>
                      )}
                    </div>
                    </>)}

                    <div className="p-4 border border-red-200 rounded-lg bg-red-50">
                      <h4 className="font-medium text-[#001d6e] flex items-center"><Shield className="h-4 w-4 mr-2" /> Danger Zone</h4>
                      <p className="text-sm text-[#001d6e] mt-1 mb-3">These actions are irreversible</p>
                      <div className="flex flex-wrap gap-2">
                        {/* Clear Stock — hidden from the UI entirely (even from admin/super-admin),
                            not removed: the dialog, mutation and backend route all still exist,
                            just unreachable from here after the ledger confusion it kept causing
                            this session (negative Opening, mismatched reports). Re-add this
                            Button to bring it back. */}
                        {/* "Remove Scan & Order Import Data" and "Remove All Operations Data" — hidden
                            from the UI, not removed: both dialogs, their state and the backend
                            routes all still exist. Re-add these two Buttons to bring them back. */}
                        {false && (<>
                        <Button
                          variant="destructive"
                          size="sm"
                          onClick={() => setShowScanResetDialog(true)}
                          disabled={!isAdminUser}
                          title={!isAdminUser ? "Admin access required" : undefined}
                        >
                          Remove Scan &amp; Order Import Data
                        </Button>
                        <Button
                          variant="destructive"
                          size="sm"
                          onClick={() => setShowResetDialog(true)}
                          disabled={!isAdminUser}
                          title={!isAdminUser ? "Admin access required" : undefined}
                        >
                          Remove All Operations Data
                        </Button>
                        </>)}
                        <Button
                          variant="destructive"
                          size="sm"
                          onClick={() => setShowClearDialog(true)}
                          disabled={isClearing || !canWrite}
                          title={!canWrite ? "You have read-only access to Settings" : "Clears the Product Master and rebuilds it from Notion"}
                        >
                          {isClearing ? "Syncing..." : "Full Sync Product Master"}
                        </Button>
                        <Button
                          variant="destructive"
                          size="sm"
                          onClick={resetStock}
                          disabled={isResetting || !canWrite}
                          title={!canWrite ? "You have read-only access to Settings" : undefined}
                        >
                          {isResetting ? "Resetting..." : "Reset Stock Values"}
                        </Button>
                        <Button 
                          variant="destructive" 
                          size="sm"
                        >
                          Reset Application
                        </Button>
                      </div>
                    </div>
                  </div>
                </CardContent>
              </Card>
            </TabsContent>
          </Tabs>
        </div>
      </div>

      {/* Recalculate Stock — the Check result, and Apply. */}
      <AlertDialog open={recalcOpen} onOpenChange={(open) => { if (!recalcApplying) setRecalcOpen(open); }}>
        <AlertDialogContent className="max-w-3xl">
          <AlertDialogHeader>
            <AlertDialogTitle>Recalculate Stock</AlertDialogTitle>
            <AlertDialogDescription>
              {recalcPreview && recalcPreview.plantCount + recalcPreview.productCount === 0
                ? 'Every stock total matches its history. Nothing to fix.'
                : `${recalcPreview?.plantCount ?? 0} item total(s) and ${recalcPreview?.productCount ?? 0} product total(s) don't match their history. Apply sets them to the correct numbers below. History, scans, CSVs and proforma slips are not changed.`}
            </AlertDialogDescription>
          </AlertDialogHeader>

          {recalcPreview && recalcPreview.plantCount + recalcPreview.productCount > 0 && (
            <div className="max-h-[55vh] space-y-4 overflow-y-auto">
              {recalcPreview.plantRows.length > 0 && (
                <div>
                  <p className="mb-1.5 text-sm font-semibold">Stock at a plant</p>
                  <div className="overflow-x-auto rounded border">
                    <table className="w-full text-xs">
                      <thead className="bg-gray-100 text-left">
                        <tr>
                          <th className="px-2 py-1.5">Item</th>
                          <th className="px-2 py-1.5">Plant</th>
                          <th className="px-2 py-1.5 text-right">Now</th>
                          <th className="px-2 py-1.5 text-right">Correct</th>
                        </tr>
                      </thead>
                      <tbody>
                        {recalcPreview.plantRows.map((r) => (
                          <tr key={`${r.barcode}::${r.plant}`} className="border-t">
                            <td className="px-2 py-1.5">
                              <div className="font-medium">{r.itemName ?? r.barcode}</div>
                              <div className="font-mono text-[10px] text-gray-400">{r.barcode}{r.storedRows > 1 ? ` · saved ${r.storedRows} times` : ''}</div>
                            </td>
                            <td className="px-2 py-1.5">{r.plant}</td>
                            <td className="px-2 py-1.5 text-right text-red-600">{r.storedStock}{r.storedExtra > 0 ? ` (extra ${r.storedExtra})` : ''}</td>
                            <td className="px-2 py-1.5 text-right font-semibold text-emerald-700">{r.correctStock}{r.correctExtra > 0 ? ` (extra ${r.correctExtra})` : ''}</td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                  {recalcPreview.plantCount > recalcPreview.plantRows.length && (
                    <p className="mt-1 text-xs text-gray-500">Showing {recalcPreview.plantRows.length} of {recalcPreview.plantCount} — Apply fixes all of them.</p>
                  )}
                </div>
              )}

              {recalcPreview.productRows.length > 0 && (
                <div>
                  <p className="mb-1.5 text-sm font-semibold">Total of all plants</p>
                  <div className="overflow-x-auto rounded border">
                    <table className="w-full text-xs">
                      <thead className="bg-gray-100 text-left">
                        <tr>
                          <th className="px-2 py-1.5">Item</th>
                          <th className="px-2 py-1.5 text-right">Now</th>
                          <th className="px-2 py-1.5 text-right">Correct</th>
                        </tr>
                      </thead>
                      <tbody>
                        {recalcPreview.productRows.map((r) => (
                          <tr key={r.productId} className="border-t">
                            <td className="px-2 py-1.5">
                              <div className="font-medium">{r.itemName ?? r.barcode}</div>
                              <div className="font-mono text-[10px] text-gray-400">{r.barcode}</div>
                            </td>
                            <td className="px-2 py-1.5 text-right text-red-600">{r.storedTotal}</td>
                            <td className="px-2 py-1.5 text-right font-semibold text-emerald-700">{r.correctTotal}</td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                  {recalcPreview.productCount > recalcPreview.productRows.length && (
                    <p className="mt-1 text-xs text-gray-500">Showing {recalcPreview.productRows.length} of {recalcPreview.productCount} — Apply fixes all of them.</p>
                  )}
                </div>
              )}

              <div className="space-y-1.5">
                <Label htmlFor="recalcConfirm">Type FIX to apply</Label>
                <Input id="recalcConfirm" value={recalcConfirm} onChange={(e) => setRecalcConfirm(e.target.value)} placeholder="FIX" />
              </div>
            </div>
          )}

          <AlertDialogFooter>
            <AlertDialogCancel disabled={recalcApplying}>Close</AlertDialogCancel>
            {recalcPreview && recalcPreview.plantCount + recalcPreview.productCount > 0 && (
              <Button
                onClick={applyStockRecalc}
                disabled={recalcApplying || recalcConfirm.trim().toUpperCase() !== 'FIX'}
                className="bg-[#001d6e] text-white hover:bg-[#001d6e]/90"
              >
                {recalcApplying ? <><Loader2 className="h-3.5 w-3.5 mr-1.5 animate-spin" /> Applying…</> : 'Apply'}
              </Button>
            )}
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      <AlertDialog open={recalcEventsOpen} onOpenChange={(open) => { if (!recalcEventsApplying) setRecalcEventsOpen(open); }}>
        <AlertDialogContent className="max-w-3xl">
          <AlertDialogHeader>
            <AlertDialogTitle>Recalculate Stock (from events only)</AlertDialogTitle>
            <AlertDialogDescription>
              {recalcEventsPreview && recalcEventsPreview.plantCount + recalcEventsPreview.productCount === 0
                ? 'Every stock total already matches Order Scan + Unloading − Loading. Nothing to fix.'
                : `${recalcEventsPreview?.plantCount ?? 0} item total(s) and ${recalcEventsPreview?.productCount ?? 0} product total(s) don't match the raw scan events. Apply sets them to the numbers below — computed purely from Order Scan, Unloading and Loading's own records, ignoring any Adjust/Exchange/Opening Stock/Clear Stock entries.`}
            </AlertDialogDescription>
          </AlertDialogHeader>

          {recalcEventsPreview && recalcEventsPreview.plantCount + recalcEventsPreview.productCount > 0 && (
            <div className="max-h-[55vh] space-y-4 overflow-y-auto">
              {recalcEventsPreview.plantRows.length > 0 && (
                <div>
                  <p className="mb-1.5 text-sm font-semibold">Stock at a plant</p>
                  <div className="overflow-x-auto rounded border">
                    <table className="w-full text-xs">
                      <thead className="bg-gray-100 text-left">
                        <tr>
                          <th className="px-2 py-1.5">Item</th>
                          <th className="px-2 py-1.5">Plant</th>
                          <th className="px-2 py-1.5 text-right">Now</th>
                          <th className="px-2 py-1.5 text-right">From events</th>
                        </tr>
                      </thead>
                      <tbody>
                        {recalcEventsPreview.plantRows.map((r) => (
                          <tr key={`${r.barcode}::${r.plant}`} className="border-t">
                            <td className="px-2 py-1.5">
                              <div className="font-medium">{r.itemName ?? r.barcode}</div>
                              <div className="font-mono text-[10px] text-gray-400">{r.barcode}{r.storedRows > 1 ? ` · saved ${r.storedRows} times` : ''}</div>
                            </td>
                            <td className="px-2 py-1.5">{r.plant}</td>
                            <td className="px-2 py-1.5 text-right text-red-600">{r.storedStock}{r.storedExtra > 0 ? ` (extra ${r.storedExtra})` : ''}</td>
                            <td className="px-2 py-1.5 text-right font-semibold text-emerald-700">{r.correctStock}{r.correctExtra > 0 ? ` (extra ${r.correctExtra})` : ''}</td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                  {recalcEventsPreview.plantCount > recalcEventsPreview.plantRows.length && (
                    <p className="mt-1 text-xs text-gray-500">Showing {recalcEventsPreview.plantRows.length} of {recalcEventsPreview.plantCount} — Apply fixes all of them.</p>
                  )}
                </div>
              )}

              {recalcEventsPreview.productRows.length > 0 && (
                <div>
                  <p className="mb-1.5 text-sm font-semibold">Total of all plants</p>
                  <div className="overflow-x-auto rounded border">
                    <table className="w-full text-xs">
                      <thead className="bg-gray-100 text-left">
                        <tr>
                          <th className="px-2 py-1.5">Item</th>
                          <th className="px-2 py-1.5 text-right">Now</th>
                          <th className="px-2 py-1.5 text-right">From events</th>
                        </tr>
                      </thead>
                      <tbody>
                        {recalcEventsPreview.productRows.map((r) => (
                          <tr key={r.productId} className="border-t">
                            <td className="px-2 py-1.5">
                              <div className="font-medium">{r.itemName ?? r.barcode}</div>
                              <div className="font-mono text-[10px] text-gray-400">{r.barcode}</div>
                            </td>
                            <td className="px-2 py-1.5 text-right text-red-600">{r.storedTotal}</td>
                            <td className="px-2 py-1.5 text-right font-semibold text-emerald-700">{r.correctTotal}</td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                  {recalcEventsPreview.productCount > recalcEventsPreview.productRows.length && (
                    <p className="mt-1 text-xs text-gray-500">Showing {recalcEventsPreview.productRows.length} of {recalcEventsPreview.productCount} — Apply fixes all of them.</p>
                  )}
                </div>
              )}

              <div className="space-y-1.5">
                <Label htmlFor="recalcEventsConfirm">Type FIX to apply</Label>
                <Input id="recalcEventsConfirm" value={recalcEventsConfirm} onChange={(e) => setRecalcEventsConfirm(e.target.value)} placeholder="FIX" />
              </div>
            </div>
          )}

          <AlertDialogFooter>
            <AlertDialogCancel disabled={recalcEventsApplying}>Close</AlertDialogCancel>
            {recalcEventsPreview && recalcEventsPreview.plantCount + recalcEventsPreview.productCount > 0 && (
              <Button
                onClick={applyStockRecalcFromEvents}
                disabled={recalcEventsApplying || recalcEventsConfirm.trim().toUpperCase() !== 'FIX'}
                className="bg-[#001d6e] text-white hover:bg-[#001d6e]/90"
              >
                {recalcEventsApplying ? <><Loader2 className="h-3.5 w-3.5 mr-1.5 animate-spin" /> Applying…</> : 'Apply'}
              </Button>
            )}
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      <AlertDialog open={ledgerBackfillOpen} onOpenChange={(open) => { if (!ledgerBackfillApplying) setLedgerBackfillOpen(open); }}>
        <AlertDialogContent className="max-w-3xl">
          <AlertDialogHeader>
            <AlertDialogTitle>Fill Stock Ledger (from Scan + Unload + Load events)</AlertDialogTitle>
            <AlertDialogDescription>
              {ledgerBackfillPreview && ledgerBackfillPreview.totalGaps === 0
                ? 'Every Order Scan, Unloading and Loading record already has a matching stock_movements entry. Nothing to fill.'
                : `${ledgerBackfillPreview?.totalGaps ?? 0} gap(s) (${ledgerBackfillPreview?.totalGapQty ?? 0} unit(s) total) have Scan/Unload/Load activity with no matching ledger entry. Apply adds one reconciliation row per gap, dated at that activity's own session/day — live stock is never touched.`}
            </AlertDialogDescription>
          </AlertDialogHeader>

          {ledgerBackfillPreview && ledgerBackfillPreview.totalGaps > 0 && (
            <div className="max-h-[55vh] space-y-4 overflow-y-auto">
              {ledgerBackfillPreview.scanGaps.length > 0 && (
                <div>
                  <p className="mb-1.5 text-sm font-semibold">Order Scan ({ledgerBackfillPreview.scanGapCount})</p>
                  <div className="overflow-x-auto rounded border">
                    <table className="w-full text-xs">
                      <thead className="bg-gray-100 text-left">
                        <tr>
                          <th className="px-2 py-1.5">Barcode</th>
                          <th className="px-2 py-1.5">Plant</th>
                          <th className="px-2 py-1.5 text-right">Missing qty</th>
                        </tr>
                      </thead>
                      <tbody>
                        {ledgerBackfillPreview.scanGaps.map((r) => (
                          <tr key={`scan::${r.barcode}::${r.plant}`} className="border-t">
                            <td className="px-2 py-1.5 font-mono text-[11px]">{r.barcode}</td>
                            <td className="px-2 py-1.5">{r.plant}</td>
                            <td className="px-2 py-1.5 text-right font-semibold text-emerald-700">{r.gap}</td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                  {ledgerBackfillPreview.scanGapCount > ledgerBackfillPreview.scanGaps.length && (
                    <p className="mt-1 text-xs text-gray-500">Showing {ledgerBackfillPreview.scanGaps.length} of {ledgerBackfillPreview.scanGapCount} — Apply fills all of them.</p>
                  )}
                </div>
              )}

              {ledgerBackfillPreview.unloadGaps.length > 0 && (
                <div>
                  <p className="mb-1.5 text-sm font-semibold">Unloading ({ledgerBackfillPreview.unloadGapCount})</p>
                  <div className="overflow-x-auto rounded border">
                    <table className="w-full text-xs">
                      <thead className="bg-gray-100 text-left">
                        <tr>
                          <th className="px-2 py-1.5">Barcode</th>
                          <th className="px-2 py-1.5">Plant</th>
                          <th className="px-2 py-1.5 text-right">Missing qty</th>
                        </tr>
                      </thead>
                      <tbody>
                        {ledgerBackfillPreview.unloadGaps.map((r) => (
                          <tr key={`unload::${r.barcode}::${r.plant}`} className="border-t">
                            <td className="px-2 py-1.5 font-mono text-[11px]">{r.barcode}</td>
                            <td className="px-2 py-1.5">{r.plant}</td>
                            <td className="px-2 py-1.5 text-right font-semibold text-emerald-700">{r.gap}</td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                  {ledgerBackfillPreview.unloadGapCount > ledgerBackfillPreview.unloadGaps.length && (
                    <p className="mt-1 text-xs text-gray-500">Showing {ledgerBackfillPreview.unloadGaps.length} of {ledgerBackfillPreview.unloadGapCount} — Apply fills all of them.</p>
                  )}
                </div>
              )}

              {ledgerBackfillPreview.loadGaps.length > 0 && (
                <div>
                  <p className="mb-1.5 text-sm font-semibold">Loading ({ledgerBackfillPreview.loadGapCount})</p>
                  <div className="overflow-x-auto rounded border">
                    <table className="w-full text-xs">
                      <thead className="bg-gray-100 text-left">
                        <tr>
                          <th className="px-2 py-1.5">Barcode</th>
                          <th className="px-2 py-1.5">Plant</th>
                          <th className="px-2 py-1.5 text-right">Missing qty</th>
                        </tr>
                      </thead>
                      <tbody>
                        {ledgerBackfillPreview.loadGaps.map((r) => (
                          <tr key={`load::${r.barcode}::${r.plant}`} className="border-t">
                            <td className="px-2 py-1.5 font-mono text-[11px]">{r.barcode}</td>
                            <td className="px-2 py-1.5">{r.plant}</td>
                            <td className="px-2 py-1.5 text-right font-semibold text-emerald-700">{r.gap}</td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                  {ledgerBackfillPreview.loadGapCount > ledgerBackfillPreview.loadGaps.length && (
                    <p className="mt-1 text-xs text-gray-500">Showing {ledgerBackfillPreview.loadGaps.length} of {ledgerBackfillPreview.loadGapCount} — Apply fills all of them.</p>
                  )}
                </div>
              )}

              <div className="space-y-1.5">
                <Label htmlFor="ledgerBackfillConfirm">Type FIX to apply</Label>
                <Input id="ledgerBackfillConfirm" value={ledgerBackfillConfirm} onChange={(e) => setLedgerBackfillConfirm(e.target.value)} placeholder="FIX" />
              </div>
            </div>
          )}

          <AlertDialogFooter>
            <AlertDialogCancel disabled={ledgerBackfillApplying}>Close</AlertDialogCancel>
            {ledgerBackfillPreview && ledgerBackfillPreview.totalGaps > 0 && (
              <Button
                onClick={applyLedgerBackfill}
                disabled={ledgerBackfillApplying || ledgerBackfillConfirm.trim().toUpperCase() !== 'FIX'}
                className="bg-[#001d6e] text-white hover:bg-[#001d6e]/90"
              >
                {ledgerBackfillApplying ? <><Loader2 className="h-3.5 w-3.5 mr-1.5 animate-spin" /> Applying…</> : 'Apply'}
              </Button>
            )}
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      {/* Clear Stock History — view + bulk-delete the ledger rows a past Clear Stock run left
          behind, so Recalculate Stock above can rebuild live stock from clean history afterward. */}
      <Dialog open={showClearStockEntries} onOpenChange={(open) => { if (!open) { setShowClearStockEntries(false); setClearStockEntries(null); } }}>
        <DialogContent className="max-w-3xl">
          <DialogHeader>
            <DialogTitle>Clear Stock History</DialogTitle>
            <DialogDescription>
              {clearStockEntries?.length
                ? `${clearStockEntries.length} Clear Stock ledger entr${clearStockEntries.length === 1 ? 'y' : 'ies'}. Deleting removes them from the history only — live stock is not changed. Run Recalculate Stock afterward to rebuild it.`
                : 'No Clear Stock entries found in the ledger.'}
            </DialogDescription>
          </DialogHeader>

          {clearStockEntries && clearStockEntries.length > 0 && (
            <div className="max-h-[55vh] overflow-y-auto rounded border">
              <table className="w-full text-xs">
                <thead className="sticky top-0 bg-gray-100 text-left">
                  <tr>
                    <th className="px-2 py-1.5">Item</th>
                    <th className="px-2 py-1.5">Plant</th>
                    <th className="px-2 py-1.5 text-right">Qty</th>
                    <th className="px-2 py-1.5">Reason</th>
                    <th className="px-2 py-1.5">When</th>
                  </tr>
                </thead>
                <tbody>
                  {clearStockEntries.map((e) => (
                    <tr key={e.id} className="border-t">
                      <td className="px-2 py-1.5">
                        <div className="font-medium">{e.itemName ?? e.barcode}</div>
                        <div className="font-mono text-[10px] text-gray-400">{e.barcode}</div>
                      </td>
                      <td className="px-2 py-1.5">{e.plant}</td>
                      <td className="px-2 py-1.5 text-right font-semibold text-red-600">{e.qty}</td>
                      <td className="px-2 py-1.5 text-gray-600">{e.reason}</td>
                      <td className="px-2 py-1.5 whitespace-nowrap text-gray-500">{new Date(e.at).toLocaleString('en-IN', { timeZone: 'Asia/Kolkata', day: 'numeric', month: 'short', hour: 'numeric', minute: '2-digit', hour12: true })}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}

          <DialogFooter>
            <Button variant="outline" onClick={() => { setShowClearStockEntries(false); setClearStockEntries(null); }} disabled={deletingClearStockEntries}>
              Close
            </Button>
            {clearStockEntries && clearStockEntries.length > 0 && (
              <Button
                variant="destructive"
                onClick={deleteAllClearStockEntries}
                disabled={deletingClearStockEntries}
              >
                {deletingClearStockEntries ? <><Loader2 className="h-3.5 w-3.5 mr-1.5 animate-spin" /> Deleting…</> : `Delete all ${clearStockEntries.length}`}
              </Button>
            )}
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Open for the whole Full Sync (it can take minutes) and closes itself when it's finished. */}
      <SyncProgressDialog
        open={isClearing}
        title="Full sync in progress"
        progress={fullSyncStatusQuery.data?.syncProgress ?? null}
        note="Safe to leave this tab open — this closes automatically once it's done."
      />

      <AlertDialog open={showClearDialog} onOpenChange={handleClearDialogOpenChange}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Full sync Product Master from Notion?</AlertDialogTitle>
            <AlertDialogDescription>
              This reads every product from Notion, then clears the Product Master and rebuilds it from the start.
              Nothing is deleted if Notion can't be reached. Products are re-created, so scan and order history keeps
              its text but is no longer linked to a product row. This can take a few minutes.
            </AlertDialogDescription>
          </AlertDialogHeader>

          {/* Details and guards */}
          <div className="space-y-4 mt-2">
            <div className="grid grid-cols-1 gap-2 text-sm">
              <div className="p-2 rounded border bg-white">
                <div className="font-medium">Products now</div>
                <div className="text-muted-foreground">{productCount}</div>
              </div>
            </div>

            <div className="p-3 rounded border border-yellow-200 bg-yellow-50 text-sm">
              Edits made only in the app (not in Notion) are replaced by what Notion has.
            </div>

            <div className="space-y-2">
              <Label htmlFor="confirmText">Type SYNC to confirm</Label>
              <Input
                id="confirmText"
                value={confirmText}
                onChange={(e) => setConfirmText(e.target.value)}
                placeholder="SYNC"
              />
              <label className="flex items-center gap-2 text-sm">
                <input
                  type="checkbox"
                  checked={acknowledge}
                  onChange={(e) => setAcknowledge(e.target.checked)}
                />
                I understand the Product Master will be rebuilt from Notion.
              </label>
            </div>
          </div>

          <AlertDialogFooter>
            <AlertDialogCancel disabled={isClearing}>Cancel</AlertDialogCancel>
            <AlertDialogAction
              onClick={(e) => { e.preventDefault(); void fullSyncProductMaster(); }}
              className="bg-red-600 hover:bg-red-700"
              disabled={isClearing || confirmText !== 'SYNC' || !acknowledge}
            >
              {isClearing ? "Syncing..." : "Full Sync Product Master"}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      <AlertDialog open={showClearStockDialog} onOpenChange={handleClearStockDialogOpenChange}>
        <AlertDialogContent className="max-h-[90vh] overflow-y-auto">
          <AlertDialogHeader>
            <AlertDialogTitle>Clear Stock?</AlertDialogTitle>
            <AlertDialogDescription>
              This resets stock numbers for the selected plant — either everything, or (if you set an Order Date
              below) only what orders/vehicles/deliveries dated on or before it contributed. It does not touch
              Order Import, Loading, or Unloading scan history — that stays exactly as-is. This action cannot be undone.
            </AlertDialogDescription>
          </AlertDialogHeader>

          <div className="space-y-4 mt-2">
            <div className="space-y-2">
              <Label htmlFor="csPlant">Plant</Label>
              <Select value={csPlant} onValueChange={(v) => { setCsPlant(v); setCsConfirmText(''); }}>
                <SelectTrigger id="csPlant">
                  <SelectValue placeholder="Select a plant" />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="all">All Plants</SelectItem>
                  {(allPlants ?? []).map((p: any) => (
                    <SelectItem key={p.id ?? p.name} value={p.name}>{p.name}</SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>

            <div className="space-y-2">
              <Label htmlFor="csOrderDateUpTo">Order Date up to (optional)</Label>
              <div className="flex flex-wrap items-center gap-2">
                <Input
                  id="csOrderDateUpTo"
                  type="date"
                  value={csOrderDateUpTo}
                  onChange={(e) => { setCsOrderDateUpTo(e.target.value); setCsConfirmText(''); }}
                  className="w-auto"
                />
                {csOrderDateUpTo && (
                  <Button variant="ghost" size="sm" onClick={() => { setCsOrderDateUpTo(''); setCsConfirmText(''); }}>
                    Clear date
                  </Button>
                )}
              </div>
              <p className="text-xs text-gray-500">
                Leave blank to clear everything for this plant, like before. Set a date to only clear what orders/
                vehicles/deliveries dated on or before it (checked across Order Import, Unloading, and Loading's
                own proforma order date) contributed to stock — stock is adjusted by exactly that amount, not
                zeroed out. Either way, no scan history is touched.
              </p>
            </div>

            {csPlant && (
              <>
                <div className="p-2 rounded border bg-white text-sm">
                  <div className="font-medium">Products w/ stock</div>
                  <div className="text-muted-foreground">{csPreviewLoading ? '…' : csPreview?.productsWithStock ?? 0}</div>
                </div>

                {csOrderDateUpTo && !csPreviewLoading && (csPreview?.activeBlockers?.length ?? 0) > 0 && (
                  <div className="p-3 rounded border border-red-200 bg-red-50 text-sm">
                    <div className="font-medium text-red-700 mb-1">Can't clear — still-open session(s) in scope:</div>
                    <ul className="list-disc pl-5 text-red-700 space-y-0.5">
                      {csPreview!.activeBlockers.slice(0, 5).map((b, i) => (
                        <li key={i}>{b.source} — {b.label} ({b.plant}{b.orderDate ? `, ${b.orderDate}` : ''})</li>
                      ))}
                      {csPreview!.activeBlockers.length > 5 && <li>and {csPreview!.activeBlockers.length - 5} more</li>}
                    </ul>
                    <p className="mt-1.5 text-red-600 text-xs">
                      A date-scoped clear can only reverse what's already been scanned — an open session's numbers
                      aren't final yet. Finish or complete these first, or clear without a date instead.
                    </p>
                  </div>
                )}

                <div className="p-3 rounded border border-yellow-200 bg-yellow-50 text-sm">
                  {csOrderDateUpTo
                    ? <>Stock for {csPlant === 'all' ? 'every plant' : csPlant} will be adjusted by what orders up to {csOrderDateUpTo} contributed — not zeroed out, since orders after that date aren't being cleared. </>
                    : <>Stock for {csPlant === 'all' ? 'every plant' : csPlant} will be set to 0. </>}
                  Order Import, Loading, and Unloading scan history, proforma slips, product master, and vehicle
                  master are not affected.
                </div>

                <div className="space-y-2">
                  <Label htmlFor="csConfirmText">Type {expectedCsConfirmText} to confirm</Label>
                  <Input
                    id="csConfirmText"
                    value={csConfirmText}
                    onChange={(e) => setCsConfirmText(e.target.value)}
                    placeholder={expectedCsConfirmText}
                  />
                </div>
              </>
            )}
          </div>

          <AlertDialogFooter>
            <AlertDialogCancel disabled={isClearingStock}>Cancel</AlertDialogCancel>
            <AlertDialogAction
              onClick={clearStock}
              className="bg-red-600 hover:bg-red-700"
              disabled={
                isClearingStock || !csPlant || csConfirmText.toUpperCase() !== expectedCsConfirmText
                || (!!csOrderDateUpTo && csPreview != null && !csPreview.canClear)
              }
            >
              {isClearingStock ? "Clearing..." : "Clear Stock"}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      {/* Remove Scan & Order Import Data — receiving only; Loading and Unloading stay. */}
      <AlertDialog open={showScanResetDialog} onOpenChange={handleScanResetDialogOpenChange}>
        <AlertDialogContent className="max-h-[90vh] overflow-y-auto">
          <AlertDialogHeader>
            <AlertDialogTitle>Remove scan &amp; order import data?</AlertDialogTitle>
            <AlertDialogDescription>
              This <strong>deletes</strong> the receiving side only: the imported order CSVs, the Scan Operations
              work done against them, their scan history, and the stock those scans brought in.
              <strong> Loading and Unloading are not touched.</strong> The entries are removed outright — no
              correction entry is written in their place — so this period reads as if the receiving never happened.
            </AlertDialogDescription>
          </AlertDialogHeader>

          <div className="space-y-4 mt-2">
            <div className="space-y-2">
              <Label htmlFor="srPlant">Plant</Label>
              <Select value={srPlant} onValueChange={(v) => { setSrPlant(v); setSrConfirmText(''); }}>
                <SelectTrigger id="srPlant">
                  <SelectValue placeholder="Select a plant" />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="all">All Plants</SelectItem>
                  {(allPlants ?? []).map((p: any) => (
                    <SelectItem key={p.id ?? p.name} value={p.name}>{p.name}</SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>

            <div className="space-y-2">
              <Label htmlFor="srOrderDateUpTo">Order date up to (optional)</Label>
              <div className="flex flex-wrap items-center gap-2">
                <Input
                  id="srOrderDateUpTo"
                  type="date"
                  value={srOrderDateUpTo}
                  onChange={(e) => { setSrOrderDateUpTo(e.target.value); setSrConfirmText(''); }}
                  className="w-auto"
                />
                {srOrderDateUpTo && (
                  <Button variant="ghost" size="sm" onClick={() => { setSrOrderDateUpTo(''); setSrConfirmText(''); }}>
                    Clear date
                  </Button>
                )}
              </div>
              <p className="text-xs text-gray-500">
                Leave blank to remove every receiving CSV for this plant. Set a date and only CSVs whose own
                order date is on or before it are removed — never the day someone scanned.
              </p>
            </div>

            {srPlant && (
              <>
                <div className="rounded border bg-white p-3 text-sm">
                  <div className="mb-2 font-medium">
                    {srPreviewLoading ? 'Counting…' : `${srPreview?.totalRows ?? 0} row(s) will be deleted`}
                  </div>
                  {srPreview && (
                    <ul className="grid grid-cols-2 gap-x-4 gap-y-1 text-muted-foreground">
                      <li>Order CSVs: <strong>{srPreview.counts.sessions}</strong></li>
                      <li>CSV items: <strong>{srPreview.counts.importItems}</strong></li>
                      <li>Scan history rows: <strong>{srPreview.counts.scanEvents}</strong></li>
                      <li>Scan item rows: <strong>{srPreview.counts.scanItems}</strong></li>
                      <li>Stock movements: <strong>{srPreview.counts.stockMovements}</strong></li>
                      <li>Stock to take back: <strong>{srPreview.counts.qtyRemoved}</strong> box(es) over <strong>{srPreview.counts.stockRowsAdjusted}</strong> row(s)</li>
                    </ul>
                  )}
                </div>

                <div className="rounded border border-yellow-200 bg-yellow-50 p-3 text-sm">
                  Stock for these items is reduced by exactly what these CSVs brought in
                  {srOrderDateUpTo ? ` on or before ${srOrderDateUpTo}` : ''}, with no adjustment entry left behind.
                  Loading, Unloading, proforma slips, Product Master and Vehicle Master are not affected.
                </div>

                <div className="space-y-2">
                  <Label htmlFor="srConfirmText">Type {expectedSrConfirmText} to confirm</Label>
                  <Input
                    id="srConfirmText"
                    value={srConfirmText}
                    onChange={(e) => setSrConfirmText(e.target.value)}
                    placeholder={expectedSrConfirmText}
                  />
                </div>
              </>
            )}
          </div>

          {srError && (
            <div className="mt-3 rounded border border-red-200 bg-red-50 p-3 text-sm text-red-700">
              <div className="font-medium">Nothing was removed.</div>
              <p className="mt-1 break-words">{srError}</p>
            </div>
          )}

          <AlertDialogFooter>
            <AlertDialogCancel disabled={isResettingScan}>Cancel</AlertDialogCancel>
            <AlertDialogAction
              onClick={resetScanData}
              className="bg-red-600 hover:bg-red-700"
              disabled={isResettingScan || !srPlant || srConfirmText.trim().toUpperCase() !== expectedSrConfirmText}
            >
              {isResettingScan ? 'Removing…' : 'Remove data'}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      {/* Remove All Operations Data — permanent deletion, so: pick the scope, see exactly how many
          rows go, then type the phrase. */}
      <AlertDialog open={showResetDialog} onOpenChange={handleResetDialogOpenChange}>
        <AlertDialogContent className="max-h-[90vh] overflow-y-auto">
          <AlertDialogHeader>
            <AlertDialogTitle>Remove all operations data?</AlertDialogTitle>
            <AlertDialogDescription>
              This <strong>deletes</strong> the day-to-day work from the database — scan history, stock, loading,
              unloading and imported order CSVs. It is not a void and not a backup: the rows are gone and cannot
              be brought back. Product Master, Vehicle Master, proforma slips, users and plants are kept.
              Set an Order Date below to remove only the orders dated on or before it.
            </AlertDialogDescription>
          </AlertDialogHeader>

          <div className="space-y-4 mt-2">
            <div className="space-y-2">
              <Label htmlFor="rdPlant">Plant</Label>
              <Select value={rdPlant} onValueChange={(v) => { setRdPlant(v); setRdConfirmText(''); }}>
                <SelectTrigger id="rdPlant">
                  <SelectValue placeholder="Select a plant" />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="all">All Plants</SelectItem>
                  {(allPlants ?? []).map((p: any) => (
                    <SelectItem key={p.id ?? p.name} value={p.name}>{p.name}</SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>

            <div className="space-y-2">
              <Label htmlFor="rdOrderDateUpTo">Order date up to (optional)</Label>
              <div className="flex flex-wrap items-center gap-2">
                <Input
                  id="rdOrderDateUpTo"
                  type="date"
                  value={rdOrderDateUpTo}
                  onChange={(e) => { setRdOrderDateUpTo(e.target.value); setRdConfirmText(''); }}
                  className="w-auto"
                />
                {rdOrderDateUpTo && (
                  <Button variant="ghost" size="sm" onClick={() => { setRdOrderDateUpTo(''); setRdConfirmText(''); }}>
                    Clear date
                  </Button>
                )}
              </div>
              <p className="text-xs text-gray-500">
                Leave blank to remove everything for this plant. Set a date and only orders dated on or before it
                are removed — the order date on the CSV, and for loading the proforma slip's own order date, never
                the day someone scanned. Stock is then adjusted back by exactly what those orders added or took
                out, instead of being deleted.
              </p>
            </div>

            {rdPlant && (
              <>
                {!rdPreviewLoading && (rdPreview?.activeBlockers?.length ?? 0) > 0 && (
                  <div className="rounded border border-red-200 bg-red-50 p-3 text-sm">
                    <div className="mb-1 font-medium text-red-700">Can't remove — still-open session(s) in scope:</div>
                    <ul className="list-disc space-y-0.5 pl-5 text-red-700">
                      {rdPreview!.activeBlockers.slice(0, 5).map((b, i) => (
                        <li key={i}>{b.source} — {b.label} ({b.plant}{b.orderDate ? `, ${b.orderDate}` : ''})</li>
                      ))}
                      {rdPreview!.activeBlockers.length > 5 && <li>and {rdPreview!.activeBlockers.length - 5} more</li>}
                    </ul>
                    <p className="mt-1.5 text-xs text-red-600">
                      A date-scoped removal has to reverse stock, and an open session's numbers aren't final yet.
                      Finish or complete these first, or remove without a date.
                    </p>
                  </div>
                )}

                <div className="rounded border bg-white p-3 text-sm">
                  <div className="mb-2 font-medium">
                    {rdPreviewLoading ? 'Counting…' : `${rdPreview?.totalRows ?? 0} row(s) will be deleted`}
                  </div>
                  {rdPreview && (
                    <ul className="grid grid-cols-2 gap-x-4 gap-y-1 text-muted-foreground">
                      <li>Order scan history: <strong>{rdPreview.counts.orderScanEvents}</strong></li>
                      <li>Order CSVs / items: <strong>{rdPreview.counts.orderSessions} / {rdPreview.counts.orderItems}</strong></li>
                      <li>Unloading scans: <strong>{rdPreview.counts.unloadScanEvents}</strong></li>
                      <li>Unloading batches / items: <strong>{rdPreview.counts.unloadSessions} / {rdPreview.counts.unloadItems}</strong></li>
                      <li>Loading scans: <strong>{rdPreview.counts.loadingScanEvents}</strong></li>
                      <li>Loading records: <strong>{rdPreview.counts.loadingRecords}</strong></li>
                      <li>
                        {rdPreview.dateScoped ? 'Stock rows adjusted: ' : 'Stock rows deleted: '}
                        <strong>{rdPreview.counts.stockRows}</strong>
                      </li>
                      <li>Stock movements: <strong>{rdPreview.counts.stockMovements}</strong></li>
                      {rdPreview.counts.activities > 0 && (
                        <li>Activity log: <strong>{rdPreview.counts.activities}</strong></li>
                      )}
                      <li>Slips reset for loading: <strong>{rdPreview.counts.slipsLoadingReset}</strong></li>
                    </ul>
                  )}
                </div>

                <div className="rounded border border-yellow-200 bg-yellow-50 p-3 text-sm">
                  Everything listed above for {rdPlant === 'all' ? 'every plant' : rdPlant}
                  {rdOrderDateUpTo ? ` dated on or before ${rdOrderDateUpTo}` : ''} is removed from the database
                  permanently. Proforma slips stay, but the loading progress of the orders in scope is wiped so
                  they can be loaded again from the start.
                  {rdOrderDateUpTo
                    ? ' Stock rows are kept (they are running totals with no date of their own) but corrected by'
                      + ' exactly what those entries did, and no correction entry is left behind. An Opening Stock'
                      + ' or manual adjustment inside that range is not undone (it belongs to no order) — run'
                      + ' Recalculate Stock afterwards to check.'
                    : ' Stock rows are deleted outright.'}
                  {(rdPlant !== 'all' || !!rdOrderDateUpTo) && ' The activity log has no plant and no order date, so it is only cleared by a full all-plants removal with no date.'}
                </div>

                <div className="space-y-2">
                  <Label htmlFor="rdConfirmText">Type {expectedRdConfirmText} to confirm</Label>
                  <Input
                    id="rdConfirmText"
                    value={rdConfirmText}
                    onChange={(e) => setRdConfirmText(e.target.value)}
                    placeholder={expectedRdConfirmText}
                  />
                </div>
              </>
            )}
          </div>

          {resetError && (
            <div className="mt-3 rounded border border-red-200 bg-red-50 p-3 text-sm text-red-700">
              <div className="font-medium">Nothing was removed.</div>
              <p className="mt-1 break-words">{resetError}</p>
            </div>
          )}

          <AlertDialogFooter>
            <AlertDialogCancel disabled={isResettingOps}>Cancel</AlertDialogCancel>
            <AlertDialogAction
              onClick={resetOperationsData}
              className="bg-red-600 hover:bg-red-700"
              disabled={
                isResettingOps || !rdPlant || rdConfirmText.trim().toUpperCase() !== expectedRdConfirmText
                || (rdPreview != null && !rdPreview.canReset)
              }
            >
              {isResettingOps ? 'Removing…' : 'Remove data'}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      <AlertDialog open={showOpeningStockDialog} onOpenChange={handleOpeningStockDialogOpenChange}>
        <AlertDialogContent className="max-h-[90vh] overflow-y-auto">
          <AlertDialogHeader>
            <AlertDialogTitle>Import Opening Stock</AlertDialogTitle>
            <AlertDialogDescription>
              Adds each barcode's quantity onto this plant's current stock, and records it as
              Opening Stock for the date below. This adds on top of what's already there — it
              never resets a barcode to a fixed number.
            </AlertDialogDescription>
          </AlertDialogHeader>

          <div className="space-y-4 mt-2">
            <div className="space-y-2">
              <Label htmlFor="osPlant">Plant</Label>
              <Select value={osPlant} onValueChange={setOsPlant}>
                <SelectTrigger id="osPlant"><SelectValue placeholder="Select a plant" /></SelectTrigger>
                <SelectContent>
                  {(allPlants ?? []).map((p: any) => (
                    <SelectItem key={p.id ?? p.name} value={p.name}>{p.name}</SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>

            <div className="space-y-2">
              <Label htmlFor="osAsOfDate">Opening stock as of</Label>
              <Input id="osAsOfDate" type="date" value={osAsOfDate} onChange={(e) => setOsAsOfDate(e.target.value)} />
              <p className="text-xs text-gray-500">
                The day this count was taken — Stock Overview will show it as Opening Stock for any period starting on or after this date.
              </p>
            </div>

            <div className="space-y-2">
              <Label>What to do with the quantities</Label>
              <div className="grid grid-cols-2 gap-1.5">
                <button type="button" onClick={() => setOsMode('add')}
                  className={`rounded-md border px-2 py-1.5 text-left text-xs ${osMode === 'add' ? 'border-[#001d6e] bg-[#001d6e]/5 text-[#001d6e]' : 'border-gray-300 text-gray-600 hover:bg-gray-50'}`}>
                  <span className="font-semibold">Add on top</span><br />the CSV's quantities are added to the stock and to the opening
                </button>
                <button type="button" onClick={() => setOsMode('set')}
                  className={`rounded-md border px-2 py-1.5 text-left text-xs ${osMode === 'set' ? 'border-[#001d6e] bg-[#001d6e]/5 text-[#001d6e]' : 'border-gray-300 text-gray-600 hover:bg-gray-50'}`}>
                  <span className="font-semibold">Set (replace)</span><br />each item's opening for this date becomes the CSV's quantity
                </button>
              </div>
            </div>

            <div className="space-y-2">
              <Label htmlFor="osFile">CSV or Excel File (Barcode + Quantity required)</Label>
              <Input
                id="osFile" type="file" accept=".csv,.xlsx,.xls"
                onChange={(e) => { const f = e.target.files?.[0]; if (f) handleOpeningStockFile(f); }}
              />
              {osFile && <div className="text-xs text-gray-500">{osFile.name}{osRows ? ` — ${osRows.length} row(s)` : ''}</div>}
            </div>

            {osPlant && osRows && (
              <>
                <div className="grid grid-cols-2 sm:grid-cols-4 gap-2 text-sm">
                  <div className="p-2 rounded border bg-white">
                    <div className="font-medium">Rows</div>
                    <div className="text-muted-foreground">{osPreviewLoading ? '…' : osPreview?.totalRows ?? 0}</div>
                  </div>
                  <div className="p-2 rounded border bg-white">
                    <div className="font-medium">Distinct barcodes</div>
                    <div className="text-muted-foreground">{osPreviewLoading ? '…' : osPreview?.distinctBarcodes ?? 0}</div>
                  </div>
                  <div className="p-2 rounded border bg-white">
                    <div className="font-medium">Already have stock</div>
                    <div className="text-muted-foreground">{osPreviewLoading ? '…' : osPreview?.barcodesWithExistingStock ?? 0}</div>
                  </div>
                  <div className="p-2 rounded border bg-white">
                    <div className="font-medium">Total qty to add</div>
                    <div className="text-muted-foreground">{osPreviewLoading ? '…' : osPreview?.totalQtyToSet ?? 0}</div>
                  </div>
                </div>

                {(osPreview?.barcodesWithExistingStock ?? 0) > 0 && (
                  <div className="p-3 rounded border border-yellow-200 bg-yellow-50 text-sm">
                    {osPreview?.barcodesWithExistingStock} barcode(s) already have stock at {osPlant} — this ADDS on top of it,
                    it doesn't replace it. Only re-import these if you mean to add more.
                  </div>
                )}

                <div className="space-y-2">
                  <Label htmlFor="osConfirmText">Type {osExpectedConfirmText} to confirm</Label>
                  <Input
                    id="osConfirmText"
                    value={osConfirmText}
                    onChange={(e) => setOsConfirmText(e.target.value)}
                    placeholder={osExpectedConfirmText}
                  />
                </div>
              </>
            )}
          </div>

          <AlertDialogFooter>
            <AlertDialogCancel disabled={osImporting}>Cancel</AlertDialogCancel>
            <AlertDialogAction
              onClick={importOpeningStock}
              className="bg-red-600 hover:bg-red-700"
              disabled={osImporting || !osPlant || !osRows || osConfirmText.toUpperCase() !== osExpectedConfirmText}
            >
              {osImporting ? (<><Loader2 className="mr-1.5 h-4 w-4 animate-spin inline" />Importing...</>) : (<><Upload className="mr-1.5 h-4 w-4 inline" />Import</>)}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      {/* ── Opening Stock column mapping dialog — same pattern as Order Import's (client/src/
          pages/OrderImport.tsx): auto-match pre-fills every field, but each one stays a Select
          the user can re-point at any other CSV column before anything is built from it. ── */}
      <Dialog open={showOsMappingDialog} onOpenChange={(open) => { if (!open) cancelOsMapping(); }}>
        <DialogContent className="max-w-2xl max-h-[90vh] flex flex-col rounded-xl">
          <DialogHeader>
            <DialogTitle>Map CSV Columns</DialogTitle>
            <DialogDescription>
              {osCsvData
                ? `"${osCsvData.name}" — ${osCsvData.rows.length} rows detected. Match each target field to a CSV column.`
                : "Map columns."}
            </DialogDescription>
          </DialogHeader>

          {osCsvData && (
            <div className="flex flex-col gap-4 overflow-y-auto flex-1 min-h-0 pr-1">
              <div className="border border-blue-100 bg-blue-50 px-4 py-3">
                <p className="mb-2 text-xs font-semibold text-blue-700">
                  {osCsvData.headers.length} columns detected in "{osCsvData.name}"
                </p>
                <div className="flex flex-wrap gap-1.5">
                  {osCsvData.headers.map((h) => (
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
                  {OS_TARGET_FIELDS.map((field) => {
                    const matched = osMapping[field.key] !== OS_SKIP && osMapping[field.key] !== "";
                    return (
                      <div key={field.key} className="flex flex-col gap-1.5 sm:flex-row sm:items-center sm:gap-3">
                        <div className="flex w-full items-center gap-1.5 sm:w-[140px] sm:shrink-0">
                          <span className={`h-2 w-2 rounded-full ${matched ? "bg-green-500" : "bg-gray-300"}`} />
                          <Label className="text-sm">{field.label}</Label>
                        </div>
                        <Select
                          value={osMapping[field.key] || OS_SKIP}
                          onValueChange={(v) => setOsMapping((m) => ({ ...m, [field.key]: v }))}
                        >
                          <SelectTrigger className={`sm:flex-1 h-9 text-sm rounded-full ${!matched ? "border-dashed text-gray-400" : ""}`}>
                            <SelectValue placeholder="— skip this field —" />
                          </SelectTrigger>
                          <SelectContent>
                            <SelectItem value={OS_SKIP}>— skip this field —</SelectItem>
                            {osCsvData.headers.map((h) => (
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
                  Preview — first {Math.min(5, osCsvData.rows.length)} of {osCsvData.rows.length} rows
                </p>
                <div className="overflow-x-auto border">
                  <table className="w-max min-w-full border-collapse text-xs">
                    <thead>
                      <tr>
                        {OS_TARGET_FIELDS.map((f) => {
                          const col = osMapping[f.key];
                          const matched = col && col !== OS_SKIP;
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
                      {osCsvData.rows.slice(0, 5).map((row, i) => (
                        <tr key={i} className="border-b hover:bg-gray-50">
                          {OS_TARGET_FIELDS.map((f) => {
                            const col = osMapping[f.key];
                            const val = col && col !== OS_SKIP ? (row[col] ?? "") : "";
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
            <Button variant="outline" className="rounded-xl" onClick={cancelOsMapping}>
              Cancel
            </Button>
            <Button
              onClick={confirmOsMapping}
              disabled={!osCsvData || osMapping.barcode === OS_SKIP || osMapping.quantity === OS_SKIP}
              className="bg-[#001d6e] hover:bg-[#00154b] text-white rounded-xl"
            >
              <Upload className="mr-1.5 h-4 w-4" />Use this mapping
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
};

export default Settings;
