  import React, { useState, useMemo } from 'react';
import { useMutation, useQuery } from '@tanstack/react-query';
import { format } from 'date-fns';
import { AlertCircle, CheckCircle, ClipboardList, Loader2, RefreshCw, Upload, Trash2 } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { Badge } from '@/components/ui/badge';
import { Alert, AlertDescription } from '@/components/ui/alert';
import { apiRequest, queryClient } from '@/lib/queryClient';
import { useToast } from '@/hooks/use-toast';
import { 
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
  DialogFooter,
} from "@/components/ui/dialog";
import type { Order } from '@shared/schema';

type ImportResult = {
  success: boolean;
  ordersCreated: number;
  itemsCreated: number;
};

export default function OrderManagement() {
  const [file, setFile] = useState<File | null>(null);
  const [plant, setPlant] = useState('Valsad');
  const [orderDate, setOrderDate] = useState(format(new Date(), 'yyyy-MM-dd'));
  const [lastImport, setLastImport] = useState<ImportResult | null>(null);
  const [fileToDelete, setFileToDelete] = useState<string | null>(null);
  const { toast } = useToast();

  const { data: orders = [], isLoading, isError, refetch } = useQuery<Order[]>({
    queryKey: ['/api/orders'],
    queryFn: async () => {
      const response = await fetch('/api/orders');
      if (!response.ok) {
        throw new Error('Failed to load orders');
      }
      const data = await response.json();
      // Support both array responses and paginated envelope { page, limit, results }
      if (Array.isArray(data)) return data;
      if (data && Array.isArray(data.results)) return data.results;
      return [] as Order[];
    },
  });

  const importMutation = useMutation({
    mutationFn: async () => {
      if (!file) {
        throw new Error('Please select a CSV file.');
      }

      const formData = new FormData();
      formData.append('file', file);
      formData.append('plant', plant);
      formData.append('orderDate', orderDate);

      const response = await apiRequest('POST', '/api/orders/import-csv', formData, true);
      const data = await response.json();

      if (!response.ok) {
        throw new Error(data.message || 'Failed to import orders');
      }

      return data as ImportResult;
    },
    onSuccess: (data) => {
      setLastImport(data);
      setFile(null);
      const input = document.getElementById('arriving-orders-csv') as HTMLInputElement | null;
      if (input) input.value = '';

      queryClient.invalidateQueries({ queryKey: ['/api/orders'] });
      queryClient.invalidateQueries({ queryKey: ['/api/orders/imports'] });
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
    mutationFn: async (filename: string) => {
      const response = await apiRequest('POST', '/api/orders/batch-delete-by-filename', { filename }, false, true);
      if (response && response.error) {
        throw new Error(response.error);
      }
      return response;
    },
    onSuccess: (data: any, filename: string) => {
      toast({
        title: 'CSV Removed',
        description: `Successfully deleted ${data.deletedCount !== undefined ? data.deletedCount : 'all'} orders imported from ${filename}.`,
      });
      setFileToDelete(null);
      refetch();
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

  const recentOrders = orders.slice(0, 25);
  
  // Calculate recent imports dynamically
  const uniqueImports = useMemo(() => {
    const importMap = new Map<string, { filename: string, count: number, latestDate: string }>();
    
    orders.forEach(order => {
      const notes = order.notes || '';
      if (notes.startsWith('Imported from ')) {
        const filename = notes.replace('Imported from ', '');
        const entry = importMap.get(filename);
        if (entry) {
          entry.count += 1;
          const orderDate = new Date(order.createdAt || '').getTime();
          const entryDate = new Date(entry.latestDate).getTime();
          if (orderDate > entryDate) {
            entry.latestDate = order.createdAt ? new Date(order.createdAt).toISOString() : '';
          }
        } else {
          importMap.set(filename, { 
            filename, 
            count: 1, 
            latestDate: order.createdAt ? new Date(order.createdAt).toISOString() : new Date().toISOString()
          });
        }
      }
    });
    
    return Array.from(importMap.values())
      .sort((a, b) => new Date(b.latestDate).getTime() - new Date(a.latestDate).getTime())
      .slice(0, 5); // Just show top 5 recent imports
  }, [orders]);

  return (
    <main className="min-h-screen bg-gray-50 p-4 sm:p-6 lg:p-8">
      {/* CSV Delete Confirmation Dialog */}
      <Dialog open={!!fileToDelete} onOpenChange={(open) => !open && !deleteCsvMutation.isPending && setFileToDelete(null)}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Delete Imported CSV Orders</DialogTitle>
            <DialogDescription>
              Are you sure you want to remove the CSV <strong>{fileToDelete}</strong>? This will permanently delete all orders that were imported from this file. This action cannot be undone.
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

      <div className="mx-auto max-w-7xl space-y-6">
        <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
          <div className="flex items-center gap-3">
            <div className="flex h-11 w-11 items-center justify-center rounded-md bg-[#001d6e] text-white">
              <ClipboardList className="h-6 w-6" />
            </div>
            <div>
              <h1 className="text-2xl font-semibold text-gray-950">Order Management</h1>
              <p className="text-sm text-gray-600">Upload arriving order CSV files and review recent imports.</p>
            </div>
          </div>
          <Button variant="outline" onClick={() => refetch()} disabled={isLoading}>
            <RefreshCw className="mr-2 h-4 w-4" />
            Refresh
          </Button>
        </div>

        <div className="grid gap-6 xl:grid-cols-[420px_1fr]">
          <Card className="rounded-md">
            <CardHeader>
              <CardTitle className="text-lg">Upload Arriving Orders</CardTitle>
            </CardHeader>
            <CardContent className="space-y-5">
              <div className="grid gap-2">
                <Label htmlFor="arriving-orders-csv">CSV File</Label>
                <Input
                  id="arriving-orders-csv"
                  type="file"
                  accept=".csv"
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
                  Import CSV
                </Button>
              </div>
            </CardContent>
          </Card>

          <div className="space-y-6">
            {uniqueImports.length > 0 && (
              <Card className="rounded-md">
                <CardHeader>
                  <CardTitle className="text-lg">Recent CSV Imports</CardTitle>
                </CardHeader>
                <CardContent>
                  <div className="space-y-3">
                    {uniqueImports.map((importData) => (
                      <div key={importData.filename} className="flex items-center justify-between p-3 border rounded-md bg-white">
                        <div className="flex flex-col">
                          <span className="font-medium text-sm truncate max-w-[200px] sm:max-w-xs" title={importData.filename}>
                            {importData.filename}
                          </span>
                          <span className="text-xs text-gray-500">
                            {importData.count} orders • {new Date(importData.latestDate).toLocaleDateString()}
                          </span>
                        </div>
                        <Button
                          variant="ghost" 
                          size="sm"
                          className="h-8 text-red-600 hover:text-red-700 hover:bg-red-50"
                          onClick={() => setFileToDelete(importData.filename)}
                        >
                          <Trash2 className="h-4 w-4 mr-2" /> 
                           Remove
                        </Button>
                      </div>
                    ))}
                  </div>
                </CardContent>
              </Card>
            )}

            <Card className="rounded-md">
              <CardHeader className="flex flex-row items-center justify-between">
                <CardTitle className="text-lg">Recent Orders</CardTitle>
                <Badge variant="secondary">{orders.length} total</Badge>
              </CardHeader>
              <CardContent>
                {isLoading ? (
                  <div className="py-10 text-center text-sm text-gray-500">Loading orders...</div>
                ) : isError ? (
                  <Alert variant="destructive">
                    <AlertCircle className="h-4 w-4" />
                    <AlertDescription>Unable to load orders.</AlertDescription>
                  </Alert>
                ) : recentOrders.length === 0 ? (
                  <div className="py-10 text-center text-sm text-gray-500">No orders imported yet.</div>
                ) : (
                  <div className="overflow-x-auto">
                    <Table>
                      <TableHeader>
                        <TableRow>
                          <TableHead>Order No.</TableHead>
                          <TableHead>Dealer</TableHead>
                          <TableHead>Plant</TableHead>
                          <TableHead>Status</TableHead>
                          <TableHead>Date</TableHead>
                        </TableRow>
                      </TableHeader>
                      <TableBody>
                        {recentOrders.map((order) => (
                          <TableRow key={order.id}>
                            <TableCell className="font-medium">{order.orderNumber}</TableCell>
                            <TableCell>{order.dealer}</TableCell>
                            <TableCell>{order.plant || '-'}</TableCell>
                            <TableCell>
                              <Badge variant={order.status === 'ARRIVING' ? 'default' : 'secondary'}>
                                {order.status || 'DRAFT'}
                              </Badge>
                            </TableCell>
                            <TableCell>{order.orderDate || '-'}</TableCell>
                          </TableRow>
                        ))}
                      </TableBody>
                    </Table>
                  </div>
                )}
              </CardContent>
            </Card>
          </div>
        </div>
      </div>
    </main>
  );
}
