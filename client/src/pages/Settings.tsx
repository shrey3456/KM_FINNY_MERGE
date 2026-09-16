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
import { Smartphone, Radio, QrCode, Zap, Shield, Database, Loader2, Upload, CalendarDays, RefreshCw } from 'lucide-react';
import Papa from 'papaparse';
import { apiRequest } from '@/lib/queryClient';
import { useQuery, useQueryClient } from '@tanstack/react-query';
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

// ─── Opening Stock CSV column auto-detection — required: Barcode, Quantity ────────────────────
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

const Settings = () => {
  const [location] = useLocation();
  const form = useForm();
  const { toast } = useToast();
  const queryClient = useQueryClient();
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
  const productCount = (() => {
    const d = queryClient.getQueryData(['/api/products']) as any;
    return Array.isArray(d) ? d.length : 0;
  })();
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

  // ── Opening Stock: bulk-SETS (overwrites) a plant's baseline stock from a CSV — distinct from
  // Order Scan/Unloading (which ADD via scan events) and Clear Stock (which zeroes). Admin-only,
  // same severity class as Clear Stock, so it gets the same impact-preview + type-to-confirm gate.
  const [showOpeningStockDialog, setShowOpeningStockDialog] = useState(false);
  const [osPlant, setOsPlant] = useState('');
  const [osFile, setOsFile] = useState<File | null>(null);
  const [osRows, setOsRows] = useState<{ barcode: string; itemName: string | null; quantity: number }[] | null>(null);
  const [osPreview, setOsPreview] = useState<{ totalRows: number; distinctBarcodes: number; barcodesWithExistingStock: number; totalQtyToSet: number } | null>(null);
  const [osPreviewLoading, setOsPreviewLoading] = useState(false);
  const [osImporting, setOsImporting] = useState(false);
  const [osConfirmText, setOsConfirmText] = useState('');

  const handleOpeningStockDialogOpenChange = (open: boolean) => {
    setShowOpeningStockDialog(open);
    if (!open) {
      setOsPlant(''); setOsFile(null); setOsRows(null); setOsPreview(null); setOsConfirmText('');
    }
  };

  async function handleOpeningStockFile(file: File) {
    setOsFile(file);
    setOsRows(null);
    setOsPreview(null);
    const parsed = await new Promise<Record<string, string>[]>((resolve, reject) => {
      Papa.parse<Record<string, string>>(file, {
        header: true, skipEmptyLines: true,
        complete: (result) => resolve(result.data),
        error: (err) => reject(err),
      });
    }).catch((err) => {
      toast({ title: 'Could not parse CSV', description: err?.message, variant: 'destructive' });
      return null;
    });
    if (!parsed || parsed.length === 0) {
      toast({ title: 'Empty file', description: 'This CSV has no rows.', variant: 'destructive' });
      return;
    }
    const headers = Object.keys(parsed[0]);
    const barcodeCol = osMatchColumn(headers, 'barcode');
    const itemNameCol = osMatchColumn(headers, 'itemName');
    const qtyCol = osMatchColumn(headers, 'quantity');
    if (!barcodeCol) { toast({ title: 'Could not find a "Barcode" column in this CSV.', variant: 'destructive' }); return; }
    if (!qtyCol) { toast({ title: 'Could not find a "Quantity" column in this CSV.', variant: 'destructive' }); return; }

    // parseFloat (not a strip-non-digits-then-parseInt) — stripping every non-digit character
    // would remove the decimal point too, so a cell written as "200.00" (a common Excel export
    // format for a whole-number column) would become "20000", 100x too large. Commas are still
    // stripped first since those are a thousands separator, not part of the number.
    const parseQty = (raw: string) => {
      const n = parseFloat((raw ?? '0').replace(/,/g, '').trim());
      return Number.isFinite(n) ? Math.round(n) : 0;
    };
    const rows = parsed.map((row) => ({
      barcode: (row[barcodeCol] ?? '').trim(),
      itemName: itemNameCol ? (row[itemNameCol] ?? '').trim() || null : null,
      quantity: parseQty(row[qtyCol] ?? '0'),
    })).filter((r) => r.barcode);
    if (rows.length === 0) {
      toast({ title: 'No valid barcodes found in this CSV.', variant: 'destructive' });
      return;
    }
    setOsRows(rows);
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

  const osExpectedConfirmText = `SET ${osPlant}`.toUpperCase();

  const importOpeningStock = async () => {
    if (!osPlant || !osRows) return;
    setOsImporting(true);
    try {
      const data = await apiRequest('POST', '/api/opening-stock/import', { plant: osPlant, items: osRows }, false, true);
      toast({ title: 'Opening stock imported', description: `${data.rowsSet} barcode(s) set for ${osPlant}.` });
      queryClient.invalidateQueries({ queryKey: ['/api/products'] });
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
                      <p className="text-sm text-gray-600 mt-1 mb-3">Bulk-set a plant's baseline stock from a CSV (Barcode + Quantity) — overwrites whatever's currently there, admin only.</p>
                      <Button
                        variant="outline" size="sm"
                        onClick={() => setShowOpeningStockDialog(true)}
                        disabled={!isAdminUser}
                        title={!isAdminUser ? "Admin access required" : undefined}
                      >
                        Import Opening Stock
                      </Button>
                    </div>

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

                    <div className="p-4 border border-red-200 rounded-lg bg-red-50">
                      <h4 className="font-medium text-[#001d6e] flex items-center"><Shield className="h-4 w-4 mr-2" /> Danger Zone</h4>
                      <p className="text-sm text-[#001d6e] mt-1 mb-3">These actions are irreversible</p>
                      <div className="flex flex-wrap gap-2">
                        <Button
                          variant="destructive"
                          size="sm"
                          onClick={() => setShowClearStockDialog(true)}
                          disabled={!isAdminUser}
                          title={!isAdminUser ? "Admin access required" : undefined}
                        >
                          Clear Stock
                        </Button>
                        <Button
                          variant="destructive"
                          size="sm"
                          onClick={() => setShowClearDialog(true)}
                          disabled={isClearing || !canWrite}
                          title={!canWrite ? "You have read-only access to Settings" : undefined}
                        >
                          {isClearing ? "Clearing..." : "Clear Product Master"}
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

      <AlertDialog open={showClearDialog} onOpenChange={handleClearDialogOpenChange}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Clear Product Master?</AlertDialogTitle>
            <AlertDialogDescription>
              This will permanently delete all products and related data. This action cannot be undone.
            </AlertDialogDescription>
          </AlertDialogHeader>

          {/* NEW: details and guards */}
          <div className="space-y-4 mt-2">
            <div className="grid grid-cols-1 sm:grid-cols-3 gap-2 text-sm">
              <div className="p-2 rounded border bg-white">
                <div className="font-medium">Products</div>
                <div className="text-muted-foreground">{productCount}</div>
              </div>
              <div className="p-2 rounded border bg-white">
                <div className="font-medium">Sales</div>
                <div className="text-muted-foreground">{salesCount}</div>
              </div>
              <div className="p-2 rounded border bg-white">
                <div className="font-medium">Scans</div>
                <div className="text-muted-foreground">{scanCount}</div>
              </div>
            </div>

            <div className="p-3 rounded border border-yellow-200 bg-yellow-50 text-sm">
              Deleting inventory is permanent. Export your data first if needed.
            </div>

            <div className="space-y-2">
              <Label htmlFor="confirmText">Type CLEAR to confirm</Label>
              <Input
                id="confirmText"
                value={confirmText}
                onChange={(e) => setConfirmText(e.target.value)}
                placeholder="CLEAR"
              />
              <label className="flex items-center gap-2 text-sm">
                <input
                  type="checkbox"
                  checked={acknowledge}
                  onChange={(e) => setAcknowledge(e.target.checked)}
                />
                I understand this action cannot be undone.
              </label>
            </div>
          </div>

          <AlertDialogFooter>
            <AlertDialogCancel disabled={isClearing}>Cancel</AlertDialogCancel>
            <AlertDialogAction
              onClick={clearInventory}
              className="bg-red-600 hover:bg-red-700"
              disabled={isClearing || confirmText !== 'CLEAR' || !acknowledge}
            >
              {isClearing ? "Clearing..." : "Clear Product Master"}
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

      <AlertDialog open={showOpeningStockDialog} onOpenChange={handleOpeningStockDialogOpenChange}>
        <AlertDialogContent className="max-h-[90vh] overflow-y-auto">
          <AlertDialogHeader>
            <AlertDialogTitle>Import Opening Stock</AlertDialogTitle>
            <AlertDialogDescription>
              Sets the selected plant's stock to exactly what this CSV says for each barcode — overwrites
              whatever's currently there. Every change is still logged to the stock ledger.
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
              <Label htmlFor="osFile">CSV File (Barcode + Quantity required)</Label>
              <Input
                id="osFile" type="file" accept=".csv"
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
                    <div className="font-medium">Total qty to set</div>
                    <div className="text-muted-foreground">{osPreviewLoading ? '…' : osPreview?.totalQtyToSet ?? 0}</div>
                  </div>
                </div>

                {(osPreview?.barcodesWithExistingStock ?? 0) > 0 && (
                  <div className="p-3 rounded border border-yellow-200 bg-yellow-50 text-sm">
                    {osPreview?.barcodesWithExistingStock} barcode(s) already have stock at {osPlant} — this will overwrite it, not add to it.
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
    </>
  );
};

export default Settings;
