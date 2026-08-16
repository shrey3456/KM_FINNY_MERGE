  import React, { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { format } from 'date-fns';
import { AlertCircle, CheckCircle, ChevronLeft, ChevronRight, ClipboardList, Loader2, RefreshCw, Upload, Trash2 } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Alert, AlertDescription } from '@/components/ui/alert';
import { apiRequest } from '@/lib/queryClient';
import { useToast } from '@/hooks/use-toast';
import { 
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
  DialogFooter,
} from "@/components/ui/dialog";

type ImportResult = {
  success: boolean;
  ordersCreated: number;
  itemsCreated: number;
};

export default function OrderManagement() {
  const queryClient = useQueryClient();
  const [file, setFile] = useState<File | null>(null);
  const [plant, setPlant] = useState('Valsad');
  const [orderDate, setOrderDate] = useState(format(new Date(), 'yyyy-MM-dd'));
  const [lastImport, setLastImport] = useState<ImportResult | null>(null);
  const [fileToDelete, setFileToDelete] = useState<string | null>(null);
  const [csvPage, setCsvPage] = useState(1);
  const CSV_PAGE_SIZE = 8;
  const { toast } = useToast();

  const { data: importsData, isLoading, refetch: refetchImports } = useQuery<any>({
    queryKey: ['/api/orders/imports', csvPage, CSV_PAGE_SIZE],
    queryFn: async () => {
      const response = await fetch(`/api/orders/imports?page=${csvPage}&limit=${CSV_PAGE_SIZE}`, {
        credentials: 'include',
        cache: 'no-store',
      });
      if (!response.ok) throw new Error('Failed to load imports');
      return response.json();
    },
    staleTime: 0,
  });
  const importSummaries: { filename: string; noteKey: string; orderCount: number; itemCount: number; lastImportedAt: string }[] =
    Array.isArray(importsData?.results) ? importsData.results : (Array.isArray(importsData) ? importsData : []);
  const importsTotalPages: number = importsData?.totalPages ?? 1;
  const importsTotal: number = importsData?.total ?? importSummaries.length;

  const importMutation = useMutation({
    mutationFn: async () => {
      if (!file) {
        throw new Error('Please select a CSV or Excel file.');
      }

      const formData = new FormData();
      formData.append('file', file);
      formData.append('plant', plant);
      formData.append('orderDate', orderDate);

      const response = await fetch('/api/orders/import-csv', {
        method: 'POST',
        body: formData,
        credentials: 'include',
      });

      const data = await response.json().catch(() => ({}));

      if (!response.ok) {
        if (data.debug) {
          console.error('[import] Server debug info:', JSON.stringify(data.debug, null, 2));
        }
        throw new Error(data.message || `Upload failed (${response.status})`);
      }

      return data as ImportResult;
    },
    onSuccess: (data) => {
      setLastImport(data);
      setFile(null);
      const input = document.getElementById('arriving-orders-csv') as HTMLInputElement | null;
      if (input) input.value = '';

      setCsvPage(1);
      queryClient.invalidateQueries({ queryKey: ['/api/orders/imports'] });
      refetchImports();
      toast({
        title: 'Orders imported',
        description: `${data.ordersCreated} orders and ${data.itemsCreated} items were imported.`,
      });
    },
    onError: (error: Error) => {
      toast({
        title: 'Import failed',
        description: error.message,
        variant: 'destructive',
      });
    },
  });

  const deleteCsvMutation = useMutation({
    mutationFn: async (noteKey: string) => {
      const response = await apiRequest('POST', '/api/orders/batch-delete-by-filename', { noteKey }, false, true);
      if (response && response.error) {
        throw new Error(response.error);
      }
      if (response?.deletedCount === 0) {
        throw new Error(`No orders found for this import. Nothing was deleted.`);
      }
      return response;
    },
    onSuccess: (data: any) => {
      const displayName = fileToDelete ? fileToDelete.replace(/^Imported from\s*/i, '').replace(/#\d+$/, '').trim() : '';
      toast({
        title: 'CSV Removed',
        description: `Deleted ${data.deletedCount} order${data.deletedCount !== 1 ? 's' : ''} imported from ${displayName}.`,
      });
      setFileToDelete(null);
      // Invalidate all related caches so every query re-fetches fresh data
      queryClient.invalidateQueries({ queryKey: ['/api/orders'] });
      queryClient.invalidateQueries({ queryKey: ['/api/orders/imports'] });
    },
    onError: (error: Error) => {
      toast({
        title: 'Failed to remove CSV',
        description: error.message,
        variant: 'destructive',
      });
      setFileToDelete(null);
    }
  });


  return (
    <main className="min-h-screen bg-gray-50 p-4 sm:p-6 lg:p-8">
      {/* CSV Delete Confirmation Dialog */}
      <Dialog open={!!fileToDelete} onOpenChange={(open) => !open && !deleteCsvMutation.isPending && setFileToDelete(null)}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Delete Imported CSV Orders</DialogTitle>
            <DialogDescription>
              Are you sure you want to remove the CSV <strong>{fileToDelete ? fileToDelete.replace(/^Imported from\s*/i, '').replace(/#\d+$/, '').trim() : ''}</strong>? This will permanently delete all orders that were imported from this file. This action cannot be undone.
            </DialogDescription>
          </DialogHeader>
          <DialogFooter className="mt-4 gap-2">
            <Button variant="outline" onClick={() => setFileToDelete(null)} disabled={deleteCsvMutation.isPending}>
              Cancel
            </Button>
            <Button 
              variant="destructive" 
              onClick={() => fileToDelete && deleteCsvMutation.mutate(fileToDelete)}
              disabled={deleteCsvMutation.isPending}
            >
              {deleteCsvMutation.isPending ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : <Trash2 className="mr-2 h-4 w-4" />}
              Remove CSV Orders
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <div className="mx-auto w-full max-w-[1800px] space-y-6">
        <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
          <div className="flex items-center gap-3">
            <div className="flex h-11 w-11 items-center justify-center rounded-md bg-[#001d6e] text-white">
              <ClipboardList className="h-6 w-6" />
            </div>
            <div>
              <h1 className="text-2xl font-semibold text-gray-950">Order Management</h1>
              <p className="text-sm text-gray-600">Upload arriving order CSV or Excel files and review recent imports.</p>
            </div>
          </div>
          <Button variant="outline" onClick={() => refetchImports()} disabled={isLoading}>
            <RefreshCw className="mr-2 h-4 w-4" />
            Refresh
          </Button>
        </div>

        <div className="grid gap-6 xl:grid-cols-[420px_1fr]">
          <Card className="rounded-md">
            <CardHeader>
              <CardTitle className="text-lg">Upload Arriving Orders (CSV / Excel)</CardTitle>
            </CardHeader>
            <CardContent className="space-y-5">
              <div className="grid gap-2">
                <Label htmlFor="arriving-orders-csv">CSV or Excel File</Label>
                <Input
                  id="arriving-orders-csv"
                  type="file"
                  accept=".csv,.xlsx,.xls"
                  onChange={(event) => {
                    setFile(event.target.files?.[0] || null);
                    setLastImport(null);
                  }}
                  disabled={importMutation.isPending}
                />
                {file && (
                  <p className="text-sm text-gray-600">
                    {file.name} ({Math.max(1, Math.round(file.size / 1024))} KB)
                  </p>
                )}
              </div>

              <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-1">
                <div className="grid gap-2">
                  <Label htmlFor="order-plant">Plant</Label>
                  <Input
                    id="order-plant"
                    value={plant}
                    onChange={(event) => setPlant(event.target.value)}
                    disabled={importMutation.isPending}
                  />
                </div>
                <div className="grid gap-2">
                  <Label htmlFor="order-date">Order Date</Label>
                  <Input
                    id="order-date"
                    type="date"
                    value={orderDate}
                    onChange={(event) => setOrderDate(event.target.value)}
                    disabled={importMutation.isPending}
                  />
                </div>
              </div>

              {lastImport && (
                <Alert className="border-green-200 bg-green-50 text-green-900">
                  <CheckCircle className="h-4 w-4 text-green-700" />
                  <AlertDescription>
                    Imported {lastImport.ordersCreated} orders with {lastImport.itemsCreated} items.
                  </AlertDescription>
                </Alert>
              )}

              {importMutation.isError && (
                <Alert variant="destructive">
                  <AlertCircle className="h-4 w-4" />
                  <AlertDescription>{(importMutation.error as Error).message}</AlertDescription>
                </Alert>
              )}

              <div className="flex justify-end gap-2">
                <Button
                  variant="outline"
                  onClick={() => {
                    setFile(null);
                    setLastImport(null);
                    const input = document.getElementById('arriving-orders-csv') as HTMLInputElement | null;
                    if (input) input.value = '';
                  }}
                  disabled={!file || importMutation.isPending}
                >
                  Clear
                </Button>
                <Button
                  onClick={() => importMutation.mutate()}
                  disabled={!file || importMutation.isPending}
                  className="bg-[#001d6e] hover:bg-[#00154b]"
                >
                  {importMutation.isPending ? (
                    <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                  ) : (
                    <Upload className="mr-2 h-4 w-4" />
                  )}
                  Import File
                </Button>
              </div>
            </CardContent>
          </Card>

          <div className="space-y-6">
            {importSummaries.length > 0 && (
              <Card className="rounded-md">
                <CardHeader>
                  <CardTitle className="text-lg">Uploaded CSVs</CardTitle>
                </CardHeader>
                <CardContent>
                  <div className="space-y-3">
                    {importSummaries.map((s) => (
                      <div key={s.filename} className="flex items-center justify-between p-3 border rounded-md bg-white">
                        <div className="flex flex-col">
                          <span className="font-medium text-sm truncate max-w-[200px] sm:max-w-xs" title={s.filename}>
                            {s.filename}
                          </span>
                          <span className="text-xs text-gray-500">
                            {s.orderCount} orders • {new Date(s.lastImportedAt).toLocaleDateString()}
                          </span>
                        </div>
                        <Button
                          variant="ghost"
                          size="sm"
                          className="h-8 text-red-600 hover:text-red-700 hover:bg-red-50"
                          onClick={() => setFileToDelete(s.noteKey)}
                        >
                          <Trash2 className="h-4 w-4 mr-2" />
                          Remove
                        </Button>
                      </div>
                    ))}
                  </div>

                  {importsTotalPages > 1 && (
                    <div className="flex items-center justify-between mt-4 pt-3 border-t">
                      <span className="text-xs text-gray-500">
                        Page {csvPage} of {importsTotalPages} · {importsTotal} upload{importsTotal !== 1 ? 's' : ''}
                      </span>
                      <div className="flex gap-1">
                        <Button
                          variant="outline"
                          size="sm"
                          className="h-7 w-7 p-0"
                          disabled={csvPage <= 1}
                          onClick={() => setCsvPage((p) => Math.max(1, p - 1))}
                        >
                          <ChevronLeft className="h-3.5 w-3.5" />
                        </Button>
                        <Button
                          variant="outline"
                          size="sm"
                          className="h-7 w-7 p-0"
                          disabled={csvPage >= importsTotalPages}
                          onClick={() => setCsvPage((p) => Math.min(importsTotalPages, p + 1))}
                        >
                          <ChevronRight className="h-3.5 w-3.5" />
                        </Button>
                      </div>
                    </div>
                  )}
                </CardContent>
              </Card>
            )}

          </div>
        </div>
      </div>
    </main>
  );
}
