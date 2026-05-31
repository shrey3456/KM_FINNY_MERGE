import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { getCurrentUserPermissions } from '../lib/permissions';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Badge } from '@/components/ui/badge';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { format } from 'date-fns';
import { useEffect, useMemo, useState } from 'react';
import {
  Download,
  History,
  Layers,
  RefreshCw,
  Search,
  ScanLine,
  Trash2,
  UserCircle,
  X,
} from 'lucide-react';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import PageHeader from '../components/PageHeader';

const PAGE_SIZE = 10;

const actionStyles: Record<string, string> = {
  add: 'bg-emerald-100 text-emerald-800 hover:bg-emerald-100',
  remove: 'bg-red-100 text-red-800 hover:bg-red-100',
  update: 'bg-blue-100 text-blue-800 hover:bg-blue-100',
};

function formatPallets(quantity: number, itemsPerPallet: number): string {
  if (!itemsPerPallet || itemsPerPallet <= 0) return '—';
  const p = quantity / itemsPerPallet;
  return p % 1 === 0 ? String(p) : p.toFixed(2);
}

export default function ScanHistoryPage() {
  const queryClient = useQueryClient();
  const [search, setSearch] = useState('');
  const [actionFilter, setActionFilter] = useState('all');
  const [scannerFilter, setScannerFilter] = useState('all');
  const [deleteId, setDeleteId] = useState<number | null>(null);
  const [scanPage, setScanPage] = useState(1);

  useEffect(() => {
    setScanPage(1);
  }, [search, actionFilter, scannerFilter]);

  const scanOffset = (scanPage - 1) * PAGE_SIZE;
  const { data: rawScans = [], isLoading, refetch } = useQuery<any[]>({
    queryKey: ['/api/scans', { limit: PAGE_SIZE + 1, offset: scanOffset }],
    staleTime: 0,
  });

  const hasMoreScans = rawScans.length > PAGE_SIZE;
  const scans = useMemo(() => {
    const sorted = [...rawScans].sort(
      (a, b) => new Date(b.scannedAt || 0).getTime() - new Date(a.scannedAt || 0).getTime(),
    );
    return sorted.slice(0, PAGE_SIZE);
  }, [rawScans]);

  // Unique scanner names for filter dropdown
  const scannerOptions = useMemo(() => {
    const names = new Set<string>();
    scans.forEach((s) => { if (s.scannerName) names.add(s.scannerName); });
    return Array.from(names).sort();
  }, [scans]);

  const filtered = useMemo(() => {
    const q = search.toLowerCase();
    return scans.filter((s) => {
      const matchSearch =
        !q ||
        s.productName?.toLowerCase().includes(q) ||
        s.barcode?.toLowerCase().includes(q) ||
        s.productSku?.toLowerCase().includes(q);
      const matchAction = actionFilter === 'all' || s.action === actionFilter;
      const matchScanner = scannerFilter === 'all' || s.scannerName === scannerFilter;
      return matchSearch && matchAction && matchScanner;
    });
  }, [scans, search, actionFilter, scannerFilter]);

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

  const clearFilters = () => {
    setSearch('');
    setActionFilter('all');
    setScannerFilter('all');
  };

  const hasFilters = search || actionFilter !== 'all' || scannerFilter !== 'all';

  return (
    <>
      <div className="flex-1 overflow-y-auto bg-gray-50 p-4 lg:p-6">
        <div className="max-w-6xl mx-auto space-y-5">
          <PageHeader
            icon={History}
            title="Scan History"
            description="A full record of who scanned what and when."
          />

          {/* Filters */}
          <Card className="rounded-xl border-0 shadow-sm">
            <CardContent className="p-4">
              <div className="flex flex-wrap gap-3 items-end">
                <div className="flex-1 min-w-[200px]">
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

                <div className="w-44">
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

                <div className="w-48">
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
                    <Button variant="ghost" size="icon" onClick={clearFilters} title="Clear filters">
                      <X className="h-4 w-4" />
                    </Button>
                  )}
                  <Button variant="outline" size="icon" onClick={() => refetch()} title="Refresh">
                    <RefreshCw className="h-4 w-4" />
                  </Button>
                  <Button variant="outline" size="sm" onClick={() => {
                    const csv = [
                      ['Timestamp', 'Product', 'Barcode', 'SKU', 'Action', 'Pallets', 'Scanned By', 'Department'].join(','),
                      ...filtered.map((s) => [
                        format(new Date(s.scannedAt), 'yyyy-MM-dd HH:mm'),
                        `"${s.productName || ''}"`,
                        s.barcode || '',
                        s.productSku || '',
                        s.action || '',
                        formatPallets(s.quantity, s.itemsPerPallet),
                        `"${s.scannerName || ''}"`,
                        `"${s.scannerDepartment || ''}"`,
                      ].join(',')),
                    ].join('\n');
                    const a = document.createElement('a');
                    a.href = URL.createObjectURL(new Blob([csv], { type: 'text/csv' }));
                    a.download = `scan-history-${format(new Date(), 'yyyy-MM-dd')}.csv`;
                    a.click();
                  }}>
                    <Download className="h-4 w-4 mr-1.5" />Export
                  </Button>
                </div>
              </div>
            </CardContent>
          </Card>

          {/* Table */}
          <Card className="rounded-xl border-0 shadow-sm">
            <CardHeader className="pb-3 flex flex-row items-center justify-between">
              <CardTitle className="text-base font-semibold flex items-center gap-2">
                <History className="h-4 w-4 text-[#001d6e]" />
                Scan Records
              </CardTitle>
              <span className="text-sm text-gray-400">
                {isLoading ? 'Loading…' : `${filtered.length} record${filtered.length !== 1 ? 's' : ''}`}
              </span>
            </CardHeader>
            <CardContent className="p-0">
              {isLoading ? (
                <div className="py-20 text-center text-gray-400 text-sm">Loading scan history…</div>
              ) : filtered.length === 0 ? (
                <div className="py-20 text-center">
                  <ScanLine className="h-10 w-10 text-gray-200 mx-auto mb-3" />
                  <p className="text-gray-500 font-medium">No records found</p>
                  {hasFilters && <p className="text-sm text-gray-400 mt-1">Try clearing the filters.</p>}
                </div>
              ) : (
                <div className="overflow-x-auto">
                  <Table>
                    <TableHeader>
                      <TableRow className="bg-gray-50 hover:bg-gray-50">
                        <TableHead className="pl-5 text-xs font-semibold uppercase tracking-wide text-gray-500">Timestamp</TableHead>
                        <TableHead className="text-xs font-semibold uppercase tracking-wide text-gray-500">Product</TableHead>
                        <TableHead className="text-xs font-semibold uppercase tracking-wide text-gray-500">Barcode</TableHead>
                        <TableHead className="text-xs font-semibold uppercase tracking-wide text-gray-500">Action</TableHead>
                        <TableHead className="text-xs font-semibold uppercase tracking-wide text-gray-500 text-right">
                          <span className="flex items-center justify-end gap-1">
                            <Layers className="h-3 w-3" />Pallets
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
                      {filtered.map((scan) => (
                        <TableRow key={scan.id} className="group hover:bg-blue-50/30">
                          <TableCell className="pl-5">
                            <p className="text-sm text-gray-800 whitespace-nowrap">
                              {scan.scannedAt ? format(new Date(scan.scannedAt), 'MMM d, yyyy') : '—'}
                            </p>
                            <p className="text-xs text-gray-400 whitespace-nowrap">
                              {scan.scannedAt ? format(new Date(scan.scannedAt), 'HH:mm') : ''}
                            </p>
                          </TableCell>
                          <TableCell>
                            <p className="font-medium text-gray-900 max-w-[240px] truncate text-sm">
                              {scan.productName || '—'}
                            </p>
                            <p className="text-xs text-gray-400">{scan.productSku || ''}</p>
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
                              {formatPallets(scan.quantity, scan.itemsPerPallet)}
                            </span>
                            {scan.itemsPerPallet > 0 && (
                              <p className="text-xs text-gray-400">{scan.quantity}/{scan.itemsPerPallet}</p>
                            )}
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
                </div>
              )}
              {!isLoading && scans.length > 0 && (
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
        </div>
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
    </>
  );
}
