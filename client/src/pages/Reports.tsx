import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { getCurrentUserPermissions } from '../lib/permissions';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow
} from '@/components/ui/table';
import {
  Card,
  CardContent,
  CardHeader,
  CardTitle,
  CardDescription
} from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Badge } from '@/components/ui/badge';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { ScrollArea } from '@/components/ui/scroll-area';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import PageHeader from '../components/PageHeader';

import {
  Truck, Package, Loader2, Coins, ClipboardList, PieChart,
  Search, X, RefreshCw, Download, Layers, UserCircle, Trash2, ScanLine,
} from 'lucide-react';
import { format } from 'date-fns';
import { useEffect, useMemo, useState } from 'react';

const actionStyles: Record<string, string> = {
  add:    'bg-emerald-100 text-emerald-800 hover:bg-emerald-100',
  remove: 'bg-red-100 text-red-800 hover:bg-red-100',
  update: 'bg-blue-100 text-blue-800 hover:bg-blue-100',
};

const PAGE_SIZE = 10;

// Mirrors computeUnitsAsync fallback: extract pallet size from product name when
// the itemsPerPallet column is 0 (e.g. "24GM*240" → 240).
function resolveIpp(itemsPerPallet: number, productName?: string): number {
  if (itemsPerPallet > 0) return itemsPerPallet;
  if (!productName) return 0;
  const star = productName.match(/\*(\d{1,5})/);
  if (star) { const n = parseInt(star[1], 10); if (n > 1) return n; }
  const standalone = productName.match(/\b(\d{1,4})\b/);
  if (standalone) { const n = parseInt(standalone[1], 10); if (n > 1) return n; }
  return 0;
}

function formatPallets(quantity: number, itemsPerPallet: number, productName?: string): string {
  const ipp = resolveIpp(itemsPerPallet, productName);
  if (ipp <= 0) return '—';
  const p = quantity / ipp;
  return p % 1 === 0 ? String(p) : p.toFixed(2);
}

// DB stores TIMESTAMP WITHOUT TIME ZONE in local IST, but node-postgres appends 'Z',
// making JS treat it as UTC and shift by +5:30. Strip the Z so JS parses as local time.
function parseLocalTs(ts: string | null | undefined): Date | null {
  if (!ts) return null;
  return new Date(ts.replace(/Z$/, ''));
}

const Reports = () => {
  const [currentTab, setCurrentTab] = useState('scan-history');
  const queryClient = useQueryClient();

  // ── Scan history state ─────────────────────────────────────────────────────
  const [search, setSearch] = useState('');
  const [actionFilter, setActionFilter] = useState('all');
  const [scannerFilter, setScannerFilter] = useState('all');
  const [deleteId, setDeleteId] = useState<number | null>(null);
  const [scanPage, setScanPage] = useState(1);

  useEffect(() => {
    setScanPage(1);
  }, [search, actionFilter, scannerFilter]);

  const scanOffset = (scanPage - 1) * PAGE_SIZE;
  const { data: scansRaw, isLoading: isLoadingScans, refetch: refetchScans } = useQuery<any[]>({
    queryKey: ['/api/scans', { limit: PAGE_SIZE + 1, offset: scanOffset }],
    staleTime: 0,
  });

  const hasMoreScans = (scansRaw ?? []).length > PAGE_SIZE;
  const scans = useMemo(() => {
    const sorted = [...(scansRaw ?? [])].sort(
      (a, b) => new Date(b.scannedAt || 0).getTime() - new Date(a.scannedAt || 0).getTime(),
    );
    return sorted.slice(0, PAGE_SIZE);
  }, [scansRaw]);

  const scannerOptions = useMemo(() => {
    const names = new Set<string>();
    scans.forEach((s) => { if (s.scannerName) names.add(s.scannerName); });
    return Array.from(names).sort();
  }, [scans]);

  const filteredScans = useMemo(() => {
    const q = search.toLowerCase();
    return scans.filter((s) => {
      const matchSearch =
        !q ||
        s.productName?.toLowerCase().includes(q) ||
        s.barcode?.toLowerCase().includes(q) ||
        s.productSku?.toLowerCase().includes(q);
      const matchAction  = actionFilter  === 'all' || s.action      === actionFilter;
      const matchScanner = scannerFilter === 'all' || s.scannerName === scannerFilter;
      return matchSearch && matchAction && matchScanner;
    });
  }, [scans, search, actionFilter, scannerFilter]);

  const hasFilters = search || actionFilter !== 'all' || scannerFilter !== 'all';

  const userPermissions = getCurrentUserPermissions();
  const canDelete = userPermissions.canDeleteOperationalItems;

  const deleteMutation = useMutation({
    mutationFn: async (id: number) => {
      const res = await fetch(`/api/scans/${id}`, { method: 'DELETE' });
      if (!res.ok) throw new Error('Failed to delete scan record');
    },
    onSuccess: () => {
      setDeleteId(null);
      queryClient.invalidateQueries({ queryKey: ['/api/scans'] });
      queryClient.invalidateQueries({ queryKey: ['/api/products'] });
    },
  });

  const exportCsv = () => {
    const csv = [
      ['Timestamp', 'Product', 'Barcode', 'SKU', 'Action', 'Pallets', 'Scanned By', 'Department'].join(','),
      ...filteredScans.map((s) => [
        s.scannedAt ? format(parseLocalTs(s.scannedAt)!, 'yyyy-MM-dd h:mm a') : '',
        `"${s.productName || ''}"`,
        s.barcode || '',
        s.productSku || '',
        s.action || '',
        formatPallets(s.quantity, s.itemsPerPallet, s.productName),
        `"${s.scannerName || ''}"`,
        `"${s.scannerDepartment || ''}"`,
      ].join(',')),
    ].join('\n');
    const a = document.createElement('a');
    a.href = URL.createObjectURL(new Blob([csv], { type: 'text/csv' }));
    a.download = `scan-history-${format(new Date(), 'yyyy-MM-dd')}.csv`;
    a.click();
  };

  // ── Other data ─────────────────────────────────────────────────────────────
  const { data: loadingOperations, isLoading: isLoadingOperations } = useQuery({
    queryKey: ['/api/loading-operations'],
  });

  const { data: products, isLoading: isLoadingProducts } = useQuery({
    queryKey: ['/api/products'],
  });

  const calculateStockValue = () => {
    if (!products || !Array.isArray(products)) return 0;
    return products.reduce((total: number, product: any) => {
      return total + (product.stock || 0) * (product.price || 0);
    }, 0);
  };

  return (
    <div className="flex-1 overflow-y-auto p-4 lg:p-6">
      <div className="max-w-6xl mx-auto">
        <PageHeader
          icon={PieChart}
          title="Reports"
          description="View operational data and analytics"
        />

        <Tabs value={currentTab} onValueChange={setCurrentTab} className="w-full">
          <TabsList className="grid grid-cols-3 mb-8">
            <TabsTrigger value="scan-history" className="flex items-center">
              <Package className="h-4 w-4 mr-2" />
              Scan History
            </TabsTrigger>
            <TabsTrigger value="load-operations" className="flex items-center">
              <Truck className="h-4 w-4 mr-2" />
              Load Operations
            </TabsTrigger>
            <TabsTrigger value="stock-value" className="flex items-center">
              <Coins className="h-4 w-4 mr-2" />
              Stock Value
            </TabsTrigger>
          </TabsList>

          {/* ── Scan History Tab ───────────────────────────────────────────── */}
          <TabsContent value="scan-history" className="space-y-4">

            {/* Filter bar */}
            <Card className="rounded-xl border shadow-sm">
              <CardContent className="p-4">
                <div className="flex flex-wrap gap-3 items-end">
                  <div className="flex-1 min-w-[180px]">
                    <label className="text-xs font-medium text-gray-500 mb-1.5 block uppercase tracking-wide">Search</label>
                    <div className="relative">
                      <Search className="absolute left-2.5 top-2.5 h-4 w-4 text-gray-400" />
                      <Input
                        placeholder="Product, SKU or barcode…"
                        className="pl-9"
                        value={search}
                        onChange={(e) => setSearch(e.target.value)}
                      />
                    </div>
                  </div>

                  <div className="w-40">
                    <label className="text-xs font-medium text-gray-500 mb-1.5 block uppercase tracking-wide">Action</label>
                    <Select value={actionFilter} onValueChange={setActionFilter}>
                      <SelectTrigger><SelectValue placeholder="All actions" /></SelectTrigger>
                      <SelectContent>
                        <SelectItem value="all">All Actions</SelectItem>
                        <SelectItem value="add">Add</SelectItem>
                        <SelectItem value="remove">Remove</SelectItem>
                        <SelectItem value="update">Update</SelectItem>
                      </SelectContent>
                    </Select>
                  </div>

                  <div className="w-44">
                    <label className="text-xs font-medium text-gray-500 mb-1.5 block uppercase tracking-wide">Scanned By</label>
                    <Select value={scannerFilter} onValueChange={setScannerFilter}>
                      <SelectTrigger><SelectValue placeholder="All users" /></SelectTrigger>
                      <SelectContent>
                        <SelectItem value="all">All Users</SelectItem>
                        {scannerOptions.map((name) => (
                          <SelectItem key={name} value={name}>{name}</SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                  </div>

                  <div className="flex gap-2">
                    {hasFilters && (
                      <Button variant="ghost" size="icon" title="Clear filters"
                        onClick={() => { setSearch(''); setActionFilter('all'); setScannerFilter('all'); }}>
                        <X className="h-4 w-4" />
                      </Button>
                    )}
                    <Button variant="outline" size="icon" title="Refresh" onClick={() => refetchScans()}>
                      <RefreshCw className="h-4 w-4" />
                    </Button>
                    <Button variant="outline" size="sm" onClick={exportCsv}>
                      <Download className="h-4 w-4 mr-1.5" />Export
                    </Button>
                  </div>
                </div>
              </CardContent>
            </Card>

            {/* Table card */}
            <Card className="rounded-xl border shadow-sm">
              <CardHeader className="pb-3 flex flex-row items-center justify-between">
                <div>
                  <CardTitle className="text-base">Scan Records</CardTitle>
                  <CardDescription>Who scanned what and when</CardDescription>
                </div>
                <span className="text-sm text-gray-400">
                  {isLoadingScans ? 'Loading…' : `${filteredScans.length} record${filteredScans.length !== 1 ? 's' : ''}`}
                </span>
              </CardHeader>
              <CardContent className="p-0">
                {isLoadingScans ? (
                  <div className="py-16 flex items-center justify-center">
                    <Loader2 className="h-6 w-6 animate-spin text-gray-400" />
                  </div>
                ) : filteredScans.length === 0 ? (
                  <div className="py-16 text-center">
                    <ScanLine className="h-10 w-10 text-gray-200 mx-auto mb-3" />
                    <p className="text-gray-500 font-medium">No records found</p>
                    {hasFilters && <p className="text-sm text-gray-400 mt-1">Try clearing the filters.</p>}
                  </div>
                ) : (
                  <ScrollArea className="h-[520px]">
                    <Table>
                      <TableHeader>
                        <TableRow className="bg-gray-50 hover:bg-gray-50">
                          <TableHead className="pl-5 text-xs font-semibold uppercase tracking-wide text-gray-500">Timestamp</TableHead>
                          <TableHead className="text-xs font-semibold uppercase tracking-wide text-gray-500">Product</TableHead>
                          <TableHead className="text-xs font-semibold uppercase tracking-wide text-gray-500">Barcode</TableHead>
                          <TableHead className="text-xs font-semibold uppercase tracking-wide text-gray-500">Action</TableHead>
                          <TableHead className="text-xs font-semibold uppercase tracking-wide text-gray-500 text-right">
                            <span className="flex items-center justify-end gap-1">
                              <Layers className="h-3 w-3" />Quantity
                            </span>
                          </TableHead>
                          <TableHead className="text-xs font-semibold uppercase tracking-wide text-gray-500">
                            <span className="flex items-center gap-1">
                              <UserCircle className="h-3 w-3" />Scanned By
                            </span>
                          </TableHead>
                          {canDelete && <TableHead className="w-10" />}
                        </TableRow>
                      </TableHeader>
                      <TableBody>
                        {filteredScans.map((scan: any) => (
                          <TableRow key={scan.id} className="group hover:bg-blue-50/30">
                            <TableCell className="pl-5">
                              <p className="text-sm text-gray-800 whitespace-nowrap">
                                {scan.scannedAt ? format(parseLocalTs(scan.scannedAt)!, 'MMM d, yyyy') : '—'}
                              </p>
                              <p className="text-xs text-gray-400 whitespace-nowrap">
                                {scan.scannedAt ? format(parseLocalTs(scan.scannedAt)!, 'h:mm a') : ''}
                              </p>
                            </TableCell>
                            <TableCell>
                              <p className="font-medium text-gray-900 max-w-[220px] truncate text-sm">
                                {scan.productName || '—'}
                              </p>
                              {scan.productSku && scan.productSku !== 'N/A' && (
                                <p className="text-xs text-gray-400">{scan.productSku}</p>
                              )}
                            </TableCell>
                            <TableCell>
                              <span className="font-mono text-xs text-gray-600">{scan.barcode || '—'}</span>
                            </TableCell>
                            <TableCell>
                              <Badge className={`text-xs capitalize ${actionStyles[scan.action] ?? 'bg-gray-100 text-gray-700'}`}>
                                {scan.action || '—'}
                              </Badge>
                            </TableCell>
                            <TableCell className="text-right">
                              <span className="font-semibold text-[#001d6e]">
                                {formatPallets(scan.quantity, scan.itemsPerPallet, scan.productName)}
                              </span>
                            </TableCell>
                            <TableCell>
                              <p className="text-sm text-gray-800">{scan.scannerName || '—'}</p>
                              {scan.scannerDepartment && scan.scannerDepartment !== 'N/A' && (
                                <p className="text-xs text-gray-400">{scan.scannerDepartment}</p>
                              )}
                            </TableCell>
                            {canDelete && (
                              <TableCell>
                                <Button
                                  variant="ghost"
                                  size="icon"
                                  className="h-7 w-7 opacity-0 group-hover:opacity-100 text-gray-400 hover:text-red-500"
                                  onClick={() => setDeleteId(scan.id)}
                                >
                                  <Trash2 className="h-3.5 w-3.5" />
                                </Button>
                              </TableCell>
                            )}
                          </TableRow>
                        ))}
                      </TableBody>
                    </Table>
                  </ScrollArea>
                )}
                {!isLoadingScans && scans.length > 0 && (
                  <div className="flex items-center justify-between border-t px-5 py-3 text-xs text-gray-500">
                    <span>Page {scanPage}</span>
                    <div className="flex gap-2">
                      <Button
                        variant="outline"
                        size="sm"
                        disabled={scanPage <= 1}
                        onClick={() => setScanPage((p) => Math.max(1, p - 1))}
                      >
                        Prev
                      </Button>
                      <Button
                        variant="outline"
                        size="sm"
                        disabled={!hasMoreScans}
                        onClick={() => setScanPage((p) => p + 1)}
                      >
                        Next
                      </Button>
                    </div>
                  </div>
                )}
              </CardContent>
            </Card>
          </TabsContent>

          {/* ── Load Operations Tab ────────────────────────────────────────── */}
          <TabsContent value="load-operations">
            <Card>
              <CardHeader className="flex flex-row items-center justify-between">
                <div>
                  <CardTitle>Load Operations</CardTitle>
                  <CardDescription>
                    All load operations data including status and references
                  </CardDescription>
                </div>
                <div className="flex gap-2">
                  <Button
                    variant="default"
                    className="gap-1 bg-[#001d6e] hover:bg-[#001d6e]/90"
                    onClick={() => window.location.href = '/gj-operations'}
                  >
                    <Truck className="h-4 w-4" />
                    View Operations
                  </Button>
                  <Button
                    variant="outline"
                    className="gap-1"
                    onClick={() => window.open('/api/loading-operations/export-csv', '_blank')}
                  >
                    <ClipboardList className="h-4 w-4" />
                    Export CSV
                  </Button>
                </div>
              </CardHeader>
              <CardContent>
                {isLoadingOperations ? (
                  <div className="py-12 flex items-center justify-center">
                    <Loader2 className="h-6 w-6 animate-spin" />
                  </div>
                ) : !loadingOperations || (loadingOperations as any[]).length === 0 ? (
                  <div className="text-center py-8">
                    <p className="text-gray-500">No load operations available</p>
                  </div>
                ) : (
                  <ScrollArea className="h-[550px]">
                    <Table>
                      <TableHeader>
                        <TableRow>
                          <TableHead>Reference #</TableHead>
                          <TableHead>Status</TableHead>
                          <TableHead>Created Date</TableHead>
                          <TableHead>Completed Date</TableHead>
                        </TableRow>
                      </TableHeader>
                      <TableBody>
                        {(loadingOperations as any[]).map((op) => (
                          <TableRow key={op.id}>
                            <TableCell className="font-medium">{op.referenceNumber}</TableCell>
                            <TableCell>
                              <Badge variant="secondary" className="bg-purple-100 text-purple-800 hover:bg-purple-200">
                                {op.status}
                              </Badge>
                            </TableCell>
                            <TableCell>
                              {op.createdAt ? format(parseLocalTs(op.createdAt)!, 'MMM d, yyyy') : '-'}
                            </TableCell>
                            <TableCell>
                              {op.completedAt ? format(parseLocalTs(op.completedAt)!, 'MMM d, yyyy') : '-'}
                            </TableCell>
                          </TableRow>
                        ))}
                      </TableBody>
                    </Table>
                  </ScrollArea>
                )}
              </CardContent>
            </Card>
          </TabsContent>

          {/* ── Stock Value Tab ────────────────────────────────────────────── */}
          <TabsContent value="stock-value">
            <div className="grid grid-cols-1 gap-6">
              <Card>
                <CardHeader>
                  <CardTitle>Stock Value Summary</CardTitle>
                  <CardDescription>Current inventory valuation and stock statistics</CardDescription>
                </CardHeader>
                <CardContent>
                  <div className="grid grid-cols-1 md:grid-cols-3 gap-6">
                    <div className="bg-primary/5 rounded-lg p-6 flex flex-col">
                      <div className="text-sm font-medium text-muted-foreground mb-1">Total Stock Value</div>
                      <div className="text-3xl font-bold">
                        {isLoadingProducts ? <Loader2 className="h-6 w-6 animate-spin" /> : <>₹{new Intl.NumberFormat('en-IN').format(calculateStockValue())}</>}
                      </div>
                    </div>
                    <div className="bg-primary/5 rounded-lg p-6 flex flex-col">
                      <div className="text-sm font-medium text-muted-foreground mb-1">Total Items</div>
                      <div className="text-3xl font-bold">
                        {isLoadingProducts ? <Loader2 className="h-6 w-6 animate-spin" /> : (products as any[])?.length || 0}
                      </div>
                    </div>
                    <div className="bg-primary/5 rounded-lg p-6 flex flex-col">
                      <div className="text-sm font-medium text-muted-foreground mb-1">Average Item Value</div>
                      <div className="text-3xl font-bold">
                        {isLoadingProducts ? (
                          <Loader2 className="h-6 w-6 animate-spin" />
                        ) : products && (products as any[]).length > 0 ? (
                          `₹${new Intl.NumberFormat('en-IN').format(Math.round(calculateStockValue() / (products as any[]).length))}`
                        ) : '₹0'}
                      </div>
                    </div>
                  </div>
                </CardContent>
              </Card>

              <Card>
                <CardHeader>
                  <CardTitle>Item Value Breakdown</CardTitle>
                  <CardDescription>Detailed inventory with stock quantity and value per item</CardDescription>
                </CardHeader>
                <CardContent>
                  {isLoadingProducts ? (
                    <div className="py-12 flex items-center justify-center">
                      <Loader2 className="h-6 w-6 animate-spin" />
                    </div>
                  ) : !products || (products as any[]).length === 0 ? (
                    <div className="text-center py-8">
                      <p className="text-gray-500">No products available</p>
                    </div>
                  ) : (
                    <ScrollArea className="h-[400px]">
                      <Table>
                        <TableHeader>
                          <TableRow>
                            <TableHead>Item Name</TableHead>
                            <TableHead>Category</TableHead>
                            <TableHead className="text-right">Stock Qty</TableHead>
                            <TableHead className="text-right">Unit Price</TableHead>
                            <TableHead className="text-right">Total Value</TableHead>
                          </TableRow>
                        </TableHeader>
                        <TableBody>
                          {(products as any[]).map((product) => (
                            <TableRow key={product.id}>
                              <TableCell className="font-medium">{product.name}</TableCell>
                              <TableCell>{product.category || '-'}</TableCell>
                              <TableCell className="text-right">{product.stock || 0}</TableCell>
                              <TableCell className="text-right">₹{new Intl.NumberFormat('en-IN').format(product.price || 0)}</TableCell>
                              <TableCell className="text-right font-medium">
                                ₹{new Intl.NumberFormat('en-IN').format((product.stock || 0) * (product.price || 0))}
                              </TableCell>
                            </TableRow>
                          ))}
                        </TableBody>
                      </Table>
                    </ScrollArea>
                  )}
                </CardContent>
              </Card>
            </div>
          </TabsContent>
        </Tabs>
      </div>

      {/* Delete confirmation dialog */}
      <Dialog open={deleteId !== null} onOpenChange={(open) => { if (!open) setDeleteId(null); }}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Delete Scan Record</DialogTitle>
            <DialogDescription>
              This will permanently remove the scan record and reverse the inventory change. This cannot be undone.
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button variant="outline" onClick={() => setDeleteId(null)}>Cancel</Button>
            <Button
              variant="destructive"
              disabled={deleteMutation.isPending}
              onClick={() => deleteId !== null && deleteMutation.mutate(deleteId)}
            >
              {deleteMutation.isPending ? 'Deleting…' : 'Delete'}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
};

export default Reports;
