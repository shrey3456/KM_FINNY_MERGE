import { useLocation } from 'wouter';
import { useQuery } from '@tanstack/react-query';
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
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import {
  ScrollArea
} from '@/components/ui/scroll-area';
import { Badge } from '@/components/ui/badge';
import PageHeader from '../components/PageHeader';

import { BarChart4, Truck, Package, DollarSign, Loader2, Coins, ClipboardList, PieChart } from 'lucide-react';
import { format } from 'date-fns';
import { useState } from 'react';

const Reports = () => {
  const [location] = useLocation();
  const [currentTab, setCurrentTab] = useState('scan-history');

  // Fetch scan history
  const { data: scans, isLoading: isLoadingScans } = useQuery({
    queryKey: ['/api/scans'],
  });

  // Fetch loading operations
  const { data: loadingOperations, isLoading: isLoadingOperations } = useQuery({
    queryKey: ['/api/loading-operations'],
  });

  // Fetch products for stock value calculation
  const { data: products, isLoading: isLoadingProducts } = useQuery({
    queryKey: ['/api/products'],
  });

  // Calculate total stock value
  const calculateStockValue = () => {
    if (!products || !Array.isArray(products)) return 0;

    return products.reduce((total, product) => {
      const stockValue = (product.stock || 0) * (product.price || 0);
      return total + stockValue;
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

          {/* Scan History Tab */}
          <TabsContent value="scan-history">
            <Card>
              <CardHeader>
                <CardTitle>Scan History</CardTitle>
                <CardDescription>
                  Recent inventory scanning activities and product movements
                </CardDescription>
              </CardHeader>
              <CardContent>
                {isLoadingScans ? (
                  <div className="py-12 flex items-center justify-center">
                    <Loader2 className="h-6 w-6 animate-spin" />
                  </div>
                ) : !scans || scans.length === 0 ? (
                  <div className="text-center py-8">
                    <p className="text-gray-500">No scan history available</p>
                  </div>
                ) : (
                  <ScrollArea className="h-[550px]">
                    <Table>
                      <TableHeader>
                        <TableRow>
                          <TableHead>Timestamp</TableHead>
                          <TableHead>Barcode</TableHead>
                          <TableHead>Product</TableHead>
                          <TableHead>Action</TableHead>
                          <TableHead className="text-right">Quantity</TableHead>
                          <TableHead>Scanned By</TableHead>
                        </TableRow>
                      </TableHeader>
                      <TableBody>
                        {scans.map((scan) => (
                          <TableRow key={scan.id}>
                            <TableCell>
                              {format(new Date(scan.scannedAt), 'MMM d, yyyy HH:mm')}
                            </TableCell>
                            <TableCell className="font-mono">{scan.barcode}</TableCell>
                            <TableCell>{scan.productName || '-'}</TableCell>
                            <TableCell>
                              <Badge
                                variant="secondary"
                                className="bg-purple-100 text-purple-800 hover:bg-purple-200"
                              >
                                {scan.action}
                              </Badge>
                            </TableCell>
                            <TableCell className="text-right">{scan.quantity}</TableCell>
                            <TableCell>{scan.scannerName || '-'}</TableCell>
                          </TableRow>
                        ))}
                      </TableBody>
                    </Table>
                  </ScrollArea>
                )}
              </CardContent>
            </Card>
          </TabsContent>

          {/* Load Operations Tab */}
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
                    onClick={async () => {
                      try {
                        // Use window.open for direct download
                        window.open('/api/loading-operations/export-csv', '_blank');
                      } catch (error: any) {
                        console.error("Export error:", error);
                        alert(`Failed to export CSV: ${error.message}`);
                      }
                    }}
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
                ) : !loadingOperations || loadingOperations.length === 0 ? (
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
                        {loadingOperations.map((op) => (
                          <TableRow key={op.id}>
                            <TableCell className="font-medium">{op.referenceNumber}</TableCell>
                            <TableCell>
                              <Badge
                                variant="secondary"
                                className="bg-purple-100 text-purple-800 hover:bg-purple-200"
                              >
                                {op.status}
                              </Badge>
                            </TableCell>
                            <TableCell>
                              {op.createdAt ? format(new Date(op.createdAt), 'MMM d, yyyy') : '-'}
                            </TableCell>
                            <TableCell>
                              {op.completedAt ? format(new Date(op.completedAt), 'MMM d, yyyy') : '-'}
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

          {/* Stock Value Tab */}
          <TabsContent value="stock-value">
            <div className="grid grid-cols-1 gap-6">
              {/* Summary Card */}
              <Card>
                <CardHeader>
                  <CardTitle>Stock Value Summary</CardTitle>
                  <CardDescription>
                    Current inventory valuation and stock statistics
                  </CardDescription>
                </CardHeader>
                <CardContent>
                  <div className="grid grid-cols-1 md:grid-cols-3 gap-6">
                    <div className="bg-primary/5 rounded-lg p-6 flex flex-col">
                      <div className="text-sm font-medium text-muted-foreground mb-1">Total Stock Value</div>
                      <div className="text-3xl font-bold">
                        {isLoadingProducts ? (
                          <Loader2 className="h-6 w-6 animate-spin" />
                        ) : (
                          <>
                            ₹{new Intl.NumberFormat('en-IN').format(calculateStockValue())}
                          </>
                        )}
                      </div>
                    </div>

                    <div className="bg-primary/5 rounded-lg p-6 flex flex-col">
                      <div className="text-sm font-medium text-muted-foreground mb-1">Total Items</div>
                      <div className="text-3xl font-bold">
                        {isLoadingProducts ? (
                          <Loader2 className="h-6 w-6 animate-spin" />
                        ) : (
                          products?.length || 0
                        )}
                      </div>
                    </div>

                    <div className="bg-primary/5 rounded-lg p-6 flex flex-col">
                      <div className="text-sm font-medium text-muted-foreground mb-1">Average Item Value</div>
                      <div className="text-3xl font-bold">
                        {isLoadingProducts ? (
                          <Loader2 className="h-6 w-6 animate-spin" />
                        ) : (
                          products && products.length > 0 ? 
                          `₹${new Intl.NumberFormat('en-IN').format(
                            Math.round(calculateStockValue() / products.length)
                          )}` : 
                          '₹0'
                        )}
                      </div>
                    </div>
                  </div>
                </CardContent>
              </Card>

              {/* Items Table */}
              <Card>
                <CardHeader>
                  <CardTitle>Item Value Breakdown</CardTitle>
                  <CardDescription>
                    Detailed inventory with stock quantity and value per item
                  </CardDescription>
                </CardHeader>
                <CardContent>
                  {isLoadingProducts ? (
                    <div className="py-12 flex items-center justify-center">
                      <Loader2 className="h-6 w-6 animate-spin" />
                    </div>
                  ) : !products || products.length === 0 ? (
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
                          {products.map((product) => (
                            <TableRow key={product.id}>
                              <TableCell className="font-medium">{product.name}</TableCell>
                              <TableCell>{product.category || '-'}</TableCell>
                              <TableCell className="text-right">{product.stock || 0}</TableCell>
                              <TableCell className="text-right">
                                ₹{new Intl.NumberFormat('en-IN').format(product.price || 0)}
                              </TableCell>
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
    </div>
  );
};

export default Reports;