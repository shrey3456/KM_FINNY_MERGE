import React, { useState } from 'react';
import { useLocation } from 'wouter';
import { useQuery, useMutation } from '@tanstack/react-query';
import { format } from 'date-fns';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { Badge } from '@/components/ui/badge';
import { Skeleton } from '@/components/ui/skeleton';
import { Alert, AlertDescription } from '@/components/ui/alert';
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from '@/components/ui/collapsible';
import { Label } from '@/components/ui/label';
import { Calendar } from '@/components/ui/calendar';
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover';
import { Progress } from '@/components/ui/progress';
import { 
  ShoppingCart, 
  Plus,
  Search,
  Download,
  Upload,
  ChevronDown,
  ChevronUp,
  Eye,
  Calendar as CalendarIcon,
  Truck,
  Users,
  Package,
  AlertCircle,
  CheckCircle,
  XCircle
} from 'lucide-react';
import MobileMenu from '../components/ui/mobile-menu';
import { SingleDateFilter } from '@/components/SingleDateFilter';
import { useToast } from '@/hooks/use-toast';
import { apiRequest, queryClient } from '@/lib/queryClient';
import { DealerPurchaseOrder, DealerPurchaseOrderItem } from '@shared/schema';
import { cn } from '@/lib/utils';

// Purchase Orders Import Component
function PurchaseOrdersImport({ onImportSuccess }: { onImportSuccess: () => void }) {
  const [file, setFile] = useState<File | null>(null);
  const [deliveryDate, setDeliveryDate] = useState<Date>();
  const [importing, setImporting] = useState(false);
  const [importStatus, setImportStatus] = useState<'idle' | 'success' | 'error'>('idle');
  const [statusMessage, setStatusMessage] = useState<string>('');
  const [progress, setProgress] = useState<number>(0);
  const { toast } = useToast();

  const handleFileChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    if (e.target.files && e.target.files.length > 0) {
      setFile(e.target.files[0]);
      setImportStatus('idle');
      setStatusMessage('');
    }
  };

  const handleImport = async () => {
    if (!file) {
      setImportStatus('error');
      setStatusMessage('Please select an Excel/CSV file to import');
      return;
    }

    if (!deliveryDate) {
      setImportStatus('error');
      setStatusMessage('Please select a delivery date');
      return;
    }

    try {
      setImporting(true);
      setProgress(10);
      
      const formData = new FormData();
      formData.append('file', file);
      formData.append('deliveryDate', format(deliveryDate, 'yyyy-MM-dd'));

      setProgress(30);
      
      const response = await apiRequest('POST', '/api/dealer-purchase-orders/from-excel', formData, true);
      
      setProgress(80);
      
      const data = await response.json();
      setProgress(100);
      
      if (response.ok) {
        setImportStatus('success');
        setStatusMessage(`Successfully imported purchase order with ${data.totalDealers ?? 0} dealers and ${data.totalItems ?? 0} items.`);
        
        toast({
          title: 'Import Successful',
          description: statusMessage,
        });
        
        onImportSuccess();
        
        // Reset form
        setFile(null);
        setDeliveryDate(undefined);
        const fileInput = document.getElementById('excel-file') as HTMLInputElement;
        if (fileInput) fileInput.value = '';
      } else {
        throw new Error(data.message || 'Error importing Excel file');
      }
    } catch (error) {
      console.error('Import error:', error);
      setImportStatus('error');
      setStatusMessage(error instanceof Error ? error.message : 'Failed to import Excel file');
      
      toast({
        title: 'Import Failed',
        description: statusMessage,
        variant: 'destructive',
      });
    } finally {
      setImporting(false);
    }
  };

  return (
    <div className="space-y-6" data-testid="purchase-orders-import">
      <div className="grid w-full max-w-sm items-center gap-1.5">
        <Label htmlFor="excel-file">Excel/CSV File</Label>
        <Input
          id="excel-file"
          type="file"
          accept=".xlsx,.xls,.csv"
          onChange={handleFileChange}
          disabled={importing}
          className="cursor-pointer"
          data-testid="input-excel-file"
        />
        <p className="text-sm text-muted-foreground mt-1">
          Upload an Excel or CSV file with dealer purchase order data.
        </p>
      </div>

      <div className="grid w-full max-w-sm items-center gap-1.5">
        <Label htmlFor="delivery-date">Delivery Date</Label>
        <Popover>
          <PopoverTrigger asChild>
            <Button
              variant="outline"
              className={cn(
                "w-full justify-start text-left font-normal",
                !deliveryDate && "text-muted-foreground"
              )}
              data-testid="button-delivery-date"
            >
              <CalendarIcon className="mr-2 h-4 w-4" />
              {deliveryDate ? format(deliveryDate, 'dd/MM/yyyy') : 'Select delivery date'}
            </Button>
          </PopoverTrigger>
          <PopoverContent className="w-auto p-0">
            <Calendar
              mode="single"
              selected={deliveryDate}
              onSelect={setDeliveryDate}
              initialFocus
            />
          </PopoverContent>
        </Popover>
      </div>

      {importing && (
        <div className="space-y-2">
          <Progress value={progress} className="w-full" data-testid="progress-import" />
          <p className="text-sm text-center text-muted-foreground">
            Importing... Please wait.
          </p>
        </div>
      )}

      {importStatus === 'success' && (
        <Alert variant="default" className="bg-green-50 border-green-300" data-testid="alert-success">
          <CheckCircle className="h-4 w-4 text-green-600" />
          <AlertDescription className="text-green-700">
            {statusMessage}
          </AlertDescription>
        </Alert>
      )}

      {importStatus === 'error' && (
        <Alert variant="destructive" data-testid="alert-error">
          <XCircle className="h-4 w-4" />
          <AlertDescription>
            {statusMessage}
          </AlertDescription>
        </Alert>
      )}

      <div className="flex justify-end space-x-2">
        <Button
          variant="default"
          disabled={!file || !deliveryDate || importing}
          onClick={handleImport}
          className="space-x-1"
          data-testid="button-import-excel"
        >
          <Upload className="h-4 w-4" />
          <span>Upload and Import</span>
        </Button>
      </div>
    </div>
  );
}

const Purchases = () => {
  const [location] = useLocation();
  const [searchTerm, setSearchTerm] = useState('');
  const [selectedDate, setSelectedDate] = useState<Date | null>(new Date());
  const [showImport, setShowImport] = useState(false);
  const { toast } = useToast();

  // Format date for API call (YYYY-MM-DD)
  const formattedDate = selectedDate ? format(selectedDate, 'yyyy-MM-dd') : undefined;

  // Fetch dealer purchase orders with date filtering
  const { data: purchaseOrders = [], isLoading, error, refetch } = useQuery<DealerPurchaseOrder[]>({
    queryKey: ['/api/dealer-purchase-orders', { date: formattedDate }],
    enabled: !!formattedDate,
    queryFn: async () => {
      const url = formattedDate 
        ? `/api/dealer-purchase-orders?date=${formattedDate}`
        : '/api/dealer-purchase-orders';
      const response = await fetch(url);
      if (!response.ok) {
        throw new Error('Failed to fetch purchase orders');
      }
      return response.json();
    },
  });

  // Fetch purchase order items for the same date
  const { data: purchaseOrderItems = [], isLoading: isLoadingItems } = useQuery<DealerPurchaseOrderItem[]>({
    queryKey: ['/api/dealer-purchase-order-items', { date: formattedDate }],
    enabled: !!formattedDate,
    queryFn: async () => {
      const url = formattedDate 
        ? `/api/dealer-purchase-order-items?date=${formattedDate}`
        : '/api/dealer-purchase-order-items';
      const response = await fetch(url);
      if (!response.ok) {
        throw new Error('Failed to fetch purchase order items');
      }
      return response.json();
    },
  });

  // Transform data to show dealer-centric view
  const dealerOrderData = React.useMemo(() => {
    if (!purchaseOrders.length || !purchaseOrderItems.length) return [];

    // Pre-index orders by id for O(1) lookup instead of O(n) find
    const ordersById = new Map<number, DealerPurchaseOrder>();
    purchaseOrders.forEach(order => {
      ordersById.set(order.id, order);
    });

    const dealerMap = new Map<string, {
      dealerName: string;
      orderDate: string;
      deliveryDate?: string;
      status: string;
      items: DealerPurchaseOrderItem[];
      totalItems: number;
      totalQuantity: number;
      purchaseOrderId: number;
    }>();

    // Group items by dealer
    purchaseOrderItems.forEach(item => {
      if (!item.purchaseOrderId) return; // Skip items without purchase order ID
      const order = ordersById.get(item.purchaseOrderId);
      if (!order) return;

      const key = `${item.dealerName}_${item.purchaseOrderId}`;
      
      if (!dealerMap.has(key)) {
        dealerMap.set(key, {
          dealerName: item.dealerName || 'Unknown Dealer',
          orderDate: order.orderDate ? format(new Date(order.orderDate), 'dd/MM/yyyy') : 'N/A',
          deliveryDate: order.deliveryDate ? format(new Date(order.deliveryDate), 'dd/MM/yyyy') : undefined,
          status: order.status || 'pending',
          items: [],
          totalItems: 0,
          totalQuantity: 0,
          purchaseOrderId: order.id
        });
      }

      const dealerData = dealerMap.get(key)!;
      dealerData.items.push(item);
      dealerData.totalItems += 1;
      dealerData.totalQuantity += item.quantity || 0;
    });

    return Array.from(dealerMap.values());
  }, [purchaseOrders, purchaseOrderItems]);

  // Filter dealers by search term
  const filteredDealers = dealerOrderData.filter(dealer =>
    searchTerm === '' || 
    dealer.dealerName.toLowerCase().includes(searchTerm.toLowerCase()) ||
    dealer.status.toLowerCase().includes(searchTerm.toLowerCase()) ||
    dealer.items.some(item => 
      (item.productName ?? '').toLowerCase().includes(searchTerm.toLowerCase()) ||
      (item.productCode ?? '').toLowerCase().includes(searchTerm.toLowerCase())
    )
  );

  const [expandedDealers, setExpandedDealers] = useState<Set<string>>(new Set());

  const toggleDealerExpansion = (dealerKey: string) => {
    const newExpanded = new Set(expandedDealers);
    if (newExpanded.has(dealerKey)) {
      newExpanded.delete(dealerKey);
    } else {
      newExpanded.add(dealerKey);
    }
    setExpandedDealers(newExpanded);
  };

  const handleDateChange = (date: Date | null) => {
    setSelectedDate(date);
  };

  const handleImportSuccess = () => {
    // Invalidate and refetch both purchase orders and items
    queryClient.invalidateQueries({ queryKey: ['/api/dealer-purchase-orders', { date: formattedDate }] });
    queryClient.invalidateQueries({ queryKey: ['/api/dealer-purchase-order-items', { date: formattedDate }] });
    refetch();
    setShowImport(false);
  };

  const getStatusBadgeVariant = (status: string) => {
    switch (status.toLowerCase()) {
      case 'completed': return 'default';
      case 'confirmed': return 'secondary';
      case 'processed': return 'outline';
      case 'pending': return 'destructive';
      case 'cancelled': return 'destructive';
      default: return 'secondary';
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
        <div className="max-w-6xl mx-auto">
          <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between mb-6">
            <div>
              <h2 className="text-2xl font-bold" data-testid="heading-purchases">Dealer Purchase Orders</h2>
              <p className="text-gray-600">Manage dealer purchase orders and Excel imports</p>
            </div>
            <div className="mt-4 sm:mt-0 flex flex-col sm:flex-row gap-2">
              <Button
                onClick={() => setShowImport(!showImport)}
                variant={showImport ? "secondary" : "default"}
                data-testid="button-toggle-import"
              >
                <Upload className="h-4 w-4 mr-2" />
                {showImport ? 'Hide Import' : 'Import Excel'}
              </Button>
            </div>
          </div>
          
          {/* Import Section */}
          {showImport && (
            <Card className="mb-6" data-testid="card-import">
              <CardHeader>
                <CardTitle>Import Purchase Orders from Excel</CardTitle>
              </CardHeader>
              <CardContent>
                <PurchaseOrdersImport onImportSuccess={handleImportSuccess} />
              </CardContent>
            </Card>
          )}
          
          {/* Filters and Search */}
          <div className="mb-6 bg-white p-4 rounded-lg border border-gray-200" data-testid="filters-section">
            <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
              <div className="relative">
                <Search className="absolute left-3 top-1/2 transform -translate-y-1/2 text-gray-400 h-4 w-4" />
                <Input 
                  className="pl-9" 
                  placeholder="Search purchase orders" 
                  value={searchTerm}
                  onChange={(e) => setSearchTerm(e.target.value)}
                  data-testid="input-search"
                />
              </div>
              <div className="flex justify-start">
                <SingleDateFilter
                  pageKey="purchases"
                  selectedDate={selectedDate}
                  onDateChange={handleDateChange}
                  className="w-full"
                  data-testid="filter-date"
                />
              </div>
            </div>
          </div>

          {/* Loading State */}
          {(isLoading || isLoadingItems) && (
            <Card data-testid="loading-state">
              <CardContent className="p-6">
                <div className="space-y-4">
                  <Skeleton className="h-4 w-full" />
                  <Skeleton className="h-4 w-3/4" />
                  <Skeleton className="h-4 w-1/2" />
                </div>
              </CardContent>
            </Card>
          )}

          {/* Error State */}
          {error && (
            <Alert variant="destructive" data-testid="error-state">
              <AlertCircle className="h-4 w-4" />
              <AlertDescription>
                Failed to load purchase orders: {error.message}
              </AlertDescription>
            </Alert>
          )}

          {/* Empty State */}
          {!isLoading && !isLoadingItems && !error && filteredDealers.length === 0 && (
            <Card data-testid="empty-state">
              <CardContent className="p-6 text-center">
                <Package className="h-12 w-12 text-gray-400 mx-auto mb-4" />
                <h3 className="text-lg font-medium text-gray-900 mb-2">No Purchase Orders Found</h3>
                <p className="text-gray-600 mb-4">
                  {selectedDate 
                    ? `No purchase orders found for ${format(selectedDate, 'dd/MM/yyyy')}`
                    : 'No purchase orders found. Import an Excel file to get started.'}
                </p>
                <Button
                  onClick={() => setShowImport(true)}
                  variant="outline"
                  data-testid="button-show-import-empty"
                >
                  <Upload className="h-4 w-4 mr-2" />
                  Import Excel File
                </Button>
              </CardContent>
            </Card>
          )}

          {/* Purchase Orders List - Desktop */}
          {!isLoading && !isLoadingItems && !error && filteredDealers.length > 0 && (
            <div className="hidden md:block" data-testid="desktop-view">
              <Card>
                <CardContent className="p-0">
                  <Table>
                    <TableHeader>
                      <TableRow>
                        <TableHead>Dealer Name</TableHead>
                        <TableHead>Order Date</TableHead>
                        <TableHead>Delivery Date</TableHead>
                        <TableHead>Total Items</TableHead>
                        <TableHead>Total Quantity</TableHead>
                        <TableHead>Status</TableHead>
                        <TableHead className="text-right">Actions</TableHead>
                      </TableRow>
                    </TableHeader>
                    <TableBody>
                      {filteredDealers.map((dealer, index) => {
                        const dealerKey = `${dealer.dealerName}_${dealer.purchaseOrderId}`;
                        return (
                          <React.Fragment key={dealerKey}>
                            <TableRow 
                              className="cursor-pointer hover:bg-gray-50"
                              onClick={() => toggleDealerExpansion(dealerKey)}
                              data-testid={`row-dealer-${index}`}
                            >
                              <TableCell className="font-medium">{dealer.dealerName}</TableCell>
                              <TableCell>{dealer.orderDate}</TableCell>
                              <TableCell>{dealer.deliveryDate || 'N/A'}</TableCell>
                              <TableCell>
                                <div className="flex items-center gap-1">
                                  <Package className="h-4 w-4 text-gray-500" />
                                  <span>{dealer.totalItems}</span>
                                </div>
                              </TableCell>
                              <TableCell>
                                <div className="flex items-center gap-1">
                                  <Truck className="h-4 w-4 text-gray-500" />
                                  <span>{dealer.totalQuantity}</span>
                                </div>
                              </TableCell>
                              <TableCell>
                                <Badge variant={getStatusBadgeVariant(dealer.status)} data-testid={`badge-status-${index}`}>
                                  {dealer.status}
                                </Badge>
                              </TableCell>
                              <TableCell className="text-right">
                                <div className="flex justify-end items-center gap-2">
                                  <Button variant="ghost" size="sm" data-testid={`button-view-${index}`}>
                                    <Eye className="h-4 w-4" />
                                  </Button>
                                  {expandedDealers.has(dealerKey) ? 
                                    <ChevronUp className="h-4 w-4" /> : 
                                    <ChevronDown className="h-4 w-4" />
                                  }
                                </div>
                              </TableCell>
                            </TableRow>
                            {expandedDealers.has(dealerKey) && (
                              <TableRow data-testid={`expanded-dealer-${index}`}>
                                <TableCell colSpan={7} className="bg-gray-50">
                                  <div className="p-4">
                                    <h4 className="font-medium mb-3">Items & Quantities for {dealer.dealerName}</h4>
                                    <div className="grid gap-3">
                                      <div className="grid grid-cols-4 gap-2 text-xs font-medium text-gray-500 uppercase tracking-wide">
                                        <div>Product Code</div>
                                        <div>Product Name</div>
                                        <div>Quantity</div>
                                        <div>Unit Price</div>
                                      </div>
                                      {dealer.items.map((item, itemIndex) => (
                                        <div key={itemIndex} className="grid grid-cols-4 gap-2 py-2 border-b border-gray-200 last:border-b-0">
                                          <div className="text-sm font-mono">{item.productCode || 'N/A'}</div>
                                          <div className="text-sm">{item.productName || 'Unknown Product'}</div>
                                          <div className="text-sm font-medium">{item.quantity || 0}</div>
                                          <div className="text-sm">{item.unitPrice || 'N/A'}</div>
                                        </div>
                                      ))}
                                    </div>
                                    <div className="mt-3 pt-3 border-t border-gray-200">
                                      <div className="flex justify-between text-sm">
                                        <span>Total Items: <strong>{dealer.totalItems}</strong></span>
                                        <span>Total Quantity: <strong>{dealer.totalQuantity}</strong></span>
                                      </div>
                                    </div>
                                  </div>
                                </TableCell>
                              </TableRow>
                            )}
                          </React.Fragment>
                        )
                      })}
                    </TableBody>
                  </Table>
                </CardContent>
              </Card>
            </div>
          )}

          {/* Purchase Orders List - Mobile */}
          {!isLoading && !isLoadingItems && !error && filteredDealers.length > 0 && (
            <div className="md:hidden space-y-4" data-testid="mobile-view">
              {filteredDealers.map((dealer, index) => {
                const dealerKey = `${dealer.dealerName}_${dealer.purchaseOrderId}`;
                return (
                  <Card key={dealerKey} data-testid={`card-dealer-${index}`}>
                    <CardContent className="p-4">
                      <div className="flex justify-between items-start mb-3">
                        <div>
                          <h3 className="font-medium">{dealer.dealerName}</h3>
                          <p className="text-sm text-gray-600">{dealer.orderDate}</p>
                        </div>
                        <Badge variant={getStatusBadgeVariant(dealer.status)} data-testid={`badge-status-mobile-${index}`}>
                          {dealer.status}
                        </Badge>
                      </div>
                      
                      <div className="grid grid-cols-2 gap-4 mb-3">
                        <div className="flex items-center gap-2">
                          <Package className="h-4 w-4 text-gray-500" />
                          <span className="text-sm">{dealer.totalItems} items</span>
                        </div>
                        <div className="flex items-center gap-2">
                          <Truck className="h-4 w-4 text-gray-500" />
                          <span className="text-sm">{dealer.totalQuantity} qty</span>
                        </div>
                        {dealer.deliveryDate && dealer.deliveryDate !== 'N/A' && (
                          <div className="flex items-center gap-2 col-span-2">
                            <CalendarIcon className="h-4 w-4 text-gray-500" />
                            <span className="text-sm">Delivery: {dealer.deliveryDate}</span>
                          </div>
                        )}
                      </div>

                      <Collapsible>
                        <CollapsibleTrigger asChild>
                          <Button variant="ghost" size="sm" className="w-full" data-testid={`button-expand-mobile-${index}`}>
                            View Items & Quantities
                            <ChevronDown className="h-4 w-4 ml-2" />
                          </Button>
                        </CollapsibleTrigger>
                        <CollapsibleContent className="pt-3">
                          <div className="space-y-3">
                            <h4 className="font-medium text-sm">Items Ordered:</h4>
                            <div className="space-y-2">
                              {dealer.items.map((item, itemIndex) => (
                                <div key={itemIndex} className="flex justify-between items-start p-2 bg-gray-50 rounded">
                                  <div className="flex-1">
                                    <div className="text-sm font-medium">{item.productName || 'Unknown Product'}</div>
                                    <div className="text-xs text-gray-500">{item.productCode || 'N/A'}</div>
                                  </div>
                                  <div className="text-right">
                                    <div className="text-sm font-medium">Qty: {item.quantity || 0}</div>
                                    {item.unitPrice && (
                                      <div className="text-xs text-gray-500">{item.unitPrice}</div>
                                    )}
                                  </div>
                                </div>
                              ))}
                            </div>
                            <div className="pt-2 border-t border-gray-200">
                              <div className="flex justify-between text-sm font-medium">
                                <span>Total: {dealer.totalItems} items</span>
                                <span>Quantity: {dealer.totalQuantity}</span>
                              </div>
                            </div>
                          </div>
                        </CollapsibleContent>
                      </Collapsible>
                    </CardContent>
                  </Card>
                )
              })}
            </div>
          )}
        </div>
      </div>
    </>
  );
};

export default Purchases;