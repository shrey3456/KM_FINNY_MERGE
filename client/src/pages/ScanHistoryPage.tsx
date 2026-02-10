import { useLocation, Link } from 'wouter';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { getCurrentUserPermissions } from '../lib/permissions';
import { 
  Card, 
  CardContent, 
  CardHeader, 
  CardTitle,
  CardDescription, 
  CardFooter 
} from '@/components/ui/card';
import PageHeader from '../components/PageHeader';

import finnyLogo from '@assets/finny-logo.png';
import { format } from 'date-fns';
import { 
  ScanLine, 
  Search, 
  SlidersHorizontal, 
  Download,
  ArrowUpDown,
  Calendar,
  UserCircle,
  Package,
  RefreshCw,
  History
} from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Badge } from '@/components/ui/badge';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { useState, useMemo } from 'react';
import { Separator } from '@/components/ui/separator';

// Minimal scan item component
const ScanHistoryItem = ({ scan, onDelete }: { scan: any, onDelete: (id: number) => void }) => {
  // Fetch product details to get itemsPerPallet
  const { data: productData } = useQuery({
    queryKey: ['/api/products', scan.productId],
    enabled: !!scan.productId,
    queryFn: async () => {
      const response = await fetch(`/api/products/${scan.productId}`);
      if (!response.ok) return null;
      return response.json();
    }
  });
  
  // Format the timestamp
  const formattedTime = scan.scannedAt ? 
    format(new Date(scan.scannedAt), 'h:mm a') : 
    'Unknown time';
  
  const formattedDate = scan.scannedAt ?
    format(new Date(scan.scannedAt), 'dd/MM/yyyy h:mm a') :
    'Unknown date';
    
  // Determine status badge based on action
  let badgeVariant = 'secondary';
  let statusText = 'Scanned';
  
  if (scan.action === 'add') {
    statusText = 'Added';
    badgeVariant = 'default'; // Green
  } else if (scan.action === 'remove') {
    statusText = 'Removed';
    badgeVariant = 'destructive'; // Red
  } else if (scan.action === 'update') {
    statusText = 'Updated';
    badgeVariant = 'outline'; // Blue
  }
  
  // Use the itemsPerPallet from the product data if available
  const itemsPerPallet = productData?.itemsPerPallet || 0;
  
  // Get user permissions from our utility
  const userPermissions = getCurrentUserPermissions();
  const canDelete = userPermissions.canDeleteOperationalItems;
  
  return (
    <div className="p-3 mb-2 bg-white border border-gray-200 rounded-md hover:shadow-sm transition-shadow">
      <div className="flex justify-between items-center">
        <div className="flex items-center space-x-2">
          <ScanLine className="h-4 w-4 text-[#001d6e]" />
          <span className="text-sm text-gray-500">ID: {scan.id}</span>
        </div>
        <div className="flex items-center gap-2">
          <Badge variant={badgeVariant as any} className="text-xs">{statusText}</Badge>
          {canDelete && (
            <Button 
              variant="ghost" 
              size="icon" 
              className="h-6 w-6 text-gray-400 hover:text-red-500"
              onClick={() => onDelete(scan.id)}
            >
              <svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className="lucide lucide-trash-2">
                <path d="M3 6h18"></path>
                <path d="M19 6v14c0 1-1 2-2 2H7c-1 0-2-1-2-2V6"></path>
                <path d="M8 6V4c0-1 1-2 2-2h4c1 0 2 1 2 2v2"></path>
                <line x1="10" y1="11" x2="10" y2="17"></line>
                <line x1="14" y1="11" x2="14" y2="17"></line>
              </svg>
            </Button>
          )}
        </div>
      </div>
      
      <div className="mt-2 grid grid-cols-1 sm:grid-cols-12 gap-2">
        {/* Product info - 7 columns */}
        <div className="sm:col-span-7">
          <p className="font-medium text-[#001d6e] truncate">{scan.productName || 'Unknown product'}</p>
          <div className="flex flex-wrap gap-x-4 gap-y-1 text-xs text-gray-500 mt-1">
            <span>SKU: {scan.productSku || 'N/A'}</span>
            <span className="flex items-center gap-1">
              <UserCircle className="h-3 w-3" />
              <span className="font-semibold text-purple-700">{scan.scannerName || 'Unknown'}</span>
            </span>
            <span className="flex items-center gap-1">
              <Calendar className="h-3 w-3" />
              {formattedDate}
            </span>
          </div>
        </div>
        
        {/* Quantity info - 5 columns */}
        <div className="sm:col-span-5 flex items-center justify-end">
          <div className="text-right">
            <div className="text-xs text-gray-500">
              Qty: <span className="font-medium">{scan.quantity || 0} boxes</span>
            </div>
            <div className="text-xs text-gray-500">
              {scan.quantity && itemsPerPallet && itemsPerPallet > 0 ? (
                <>
                  {Math.floor(scan.quantity / itemsPerPallet)} pallet{Math.floor(scan.quantity / itemsPerPallet) !== 1 ? 's' : ''}
                  {(scan.quantity % itemsPerPallet) > 0 && 
                    ` + ${scan.quantity % itemsPerPallet} box${(scan.quantity % itemsPerPallet) !== 1 ? 'es' : ''}`
                  }
                </>
              ) : (
                scan.pallets ? `${scan.pallets} pallet${scan.pallets !== 1 ? 's' : ''}` : '0 pallets'
              )}
            </div>
          </div>
        </div>
      </div>
    </div>
  );
};

// Empty state component
const EmptyState = () => {
  const [_, navigate] = useLocation();
  
  return (
    <div className="p-8 text-center border rounded-lg bg-white">
      <ScanLine className="mx-auto h-12 w-12 text-gray-400" />
      <h3 className="mt-2 text-lg font-medium text-gray-900">No scan history found</h3>
      <p className="mt-1 text-gray-500">Try adjusting your filters or start scanning new items.</p>
      <div className="mt-6">
        <Button variant="default" onClick={() => navigate('/scan')}>
          Go to Scanner
        </Button>
      </div>
    </div>
  );
};

const ScanHistoryPage = () => {
  const [location] = useLocation();
  const [searchQuery, setSearchQuery] = useState('');
  const [filterAction, setFilterAction] = useState('all');
  const queryClient = useQueryClient();
  
  // For delete confirmation
  const [isDeleting, setIsDeleting] = useState(false);
  const [scanToDelete, setScanToDelete] = useState<number | null>(null);
  
  // Fetch scan history
  const { data: scanHistory = [], isLoading, error, refetch } = useQuery({
    queryKey: ['/api/scans'],
    staleTime: 5000 // 5 seconds
  });
  
  // Track the productId of the scan being deleted
  const [deletingProductId, setDeletingProductId] = useState<number | null>(null);
  
  // Delete mutation
  const deleteMutation = useMutation({
    mutationFn: async (id: number) => {
      // First fetch the scan record to get its details
      const scanResponse = await fetch(`/api/scans/${id}`);
      if (!scanResponse.ok) {
        throw new Error('Failed to fetch scan record details');
      }
      
      // Try to parse as array first (for /api/scans endpoint)
      let scanData;
      const responseText = await scanResponse.text();
      try {
        const parsedData = JSON.parse(responseText);
        // If it's an array, we're getting all scans, so find by ID
        if (Array.isArray(parsedData)) {
          scanData = parsedData.find(scan => scan.id === id);
        } else {
          // Otherwise it's just the single scan
          scanData = parsedData;
        }
      } catch (e) {
        console.error('Error parsing scan data:', e);
        throw new Error('Failed to parse scan data');
      }
      
      // Store the productId for later use
      if (scanData && scanData.productId) {
        console.log(`Found scan with productId: ${scanData.productId}`);
        setDeletingProductId(scanData.productId);
      }
      
      // Now delete the scan
      const deleteResponse = await fetch(`/api/scans/${id}`, {
        method: 'DELETE',
      });
      
      if (!deleteResponse.ok) {
        throw new Error('Failed to delete scan record');
      }
      
      return { id, productId: scanData?.productId };
    },
    onSuccess: (data) => {
      console.log('Scan deletion successful, refreshing data...', data);
      // Refresh scan history and invalidate products to update stock values
      refetch();

      // Invalidate product data and force immediate refetches
      console.log('Invalidating and refetching product queries');
      queryClient.invalidateQueries({ queryKey: ['/api/products'] });
      
      // Wait a brief moment to allow the invalidation to take effect
      setTimeout(() => {
        console.log('Force refetching product queries after delay');
        // Force a refetch of all products queries
        queryClient.refetchQueries({ 
          queryKey: ['/api/products'],
          exact: false,
          type: 'all'
        });
        
        // Also explicitly refetch the specific products endpoint used by Inventory
        queryClient.refetchQueries({
          queryKey: ['/api/products?limit=1000&offset=0'],
          exact: true
        });
        
        // And fetch the specific product that was affected
        const productId = data.productId || deletingProductId;
        if (productId) {
          console.log(`Refetching specific product: ${productId}`);
          queryClient.refetchQueries({
            queryKey: ['/api/products', productId],
            exact: true
          });
        } else {
          console.warn('No productId found for refetching specific product');
        }
      }, 300); // Longer delay to ensure database operations complete
      
      setIsDeleting(false);
      setScanToDelete(null);
      // Reset the productId
      setDeletingProductId(null);
    },
    onError: (error: Error) => {
      console.error('Error deleting scan record:', error);
      setIsDeleting(false);
      setScanToDelete(null);
    }
  });
  
  // Handle delete action
  const handleDelete = (id: number) => {
    setScanToDelete(id);
    setIsDeleting(true);
    
    // Fetch the scan first to ensure we capture productId before deletion
    fetch(`/api/scans`)
      .then(response => response.json())
      .then(data => {
        const scanToDelete = Array.isArray(data) 
          ? data.find(scan => scan.id === id)
          : null;
          
        if (scanToDelete && scanToDelete.productId) {
          setDeletingProductId(scanToDelete.productId);
        }
        
        // Now proceed with deletion
        deleteMutation.mutate(id);
      })
      .catch(error => {
        console.error("Error fetching scan before deletion:", error);
        // Still try to delete even if the pre-fetch fails
        deleteMutation.mutate(id);
      });
  };
  
  // Cast to array for type safety and sorting
  const scans = (scanHistory as any[]).slice().sort((a, b) => {
    // Sort by most recent first
    return new Date(b.scannedAt || 0).getTime() - new Date(a.scannedAt || 0).getTime();
  });
  
  // Apply filters
  const filteredScans = useMemo(() => {
    return scans.filter(scan => {
      const matchesSearch = searchQuery === '' || 
        (scan.productName && scan.productName.toLowerCase().includes(searchQuery.toLowerCase())) || 
        (scan.barcode && scan.barcode.toLowerCase().includes(searchQuery.toLowerCase())) ||
        (scan.productSku && scan.productSku.toLowerCase().includes(searchQuery.toLowerCase()));
        
      const matchesAction = filterAction === 'all' || scan.action === filterAction;
      
      return matchesSearch && matchesAction;
    });
  }, [scans, searchQuery, filterAction]);
  
  return (
    <>
      {/* Mobile Header removed as requested */}
      
      <div className="flex-1 overflow-y-auto p-4 lg:p-6">
        <div className="max-w-6xl mx-auto">
          <PageHeader
            icon={History}
            title="Scan History" 
            description="View all barcode scan history"
          />
          
          {/* Filter Controls */}
          <Card className="mb-6">
            <CardContent className="p-4">
              <div className="flex flex-col md:flex-row gap-4 items-end">
                <div className="flex-1">
                  <label className="text-sm font-medium mb-1.5 block">Search</label>
                  <div className="relative">
                    <Search className="absolute left-2.5 top-2.5 h-4 w-4 text-gray-400" />
                    <Input 
                      type="text" 
                      placeholder="Search by product name, SKU or barcode" 
                      className="pl-9"
                      value={searchQuery}
                      onChange={(e) => setSearchQuery(e.target.value)}
                    />
                  </div>
                </div>
                
                <div className="w-full md:w-48">
                  <label className="text-sm font-medium mb-1.5 block">Filter by Action</label>
                  <Select 
                    value={filterAction} 
                    onValueChange={setFilterAction}
                  >
                    <SelectTrigger>
                      <SelectValue placeholder="Select action" />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="all">All Actions</SelectItem>
                      <SelectItem value="add">Added to Inventory</SelectItem>
                      <SelectItem value="remove">Removed from Inventory</SelectItem>
                      <SelectItem value="update">Updated Quantity</SelectItem>
                    </SelectContent>
                  </Select>
                </div>
                
                <Button variant="outline" className="md:ml-2 w-full md:w-auto"  onClick={() => {
                  setSearchQuery('');
                  setFilterAction('all');
                }}>
                  <SlidersHorizontal className="h-4 w-4 mr-2" />
                  Reset Filters
                </Button>
                
                <Button variant="outline" className="w-full md:w-auto">
                  <Download className="h-4 w-4 mr-2" />
                  Export CSV
                </Button>
              </div>
            </CardContent>
          </Card>
          
          {/* Scan History */}
          <div className="mb-6">
            {isLoading ? (
              <Card>
                <CardContent className="p-8 text-center">
                  <p className="text-gray-500">Loading scan history...</p>
                </CardContent>
              </Card>
            ) : error ? (
              <Card>
                <CardContent className="p-8 text-center">
                  <p className="text-red-500">Error loading scan history</p>
                </CardContent>
              </Card>
            ) : filteredScans.length > 0 ? (
              <>
                <div className="mb-2 flex justify-between">
                  <p className="text-sm text-gray-500">{filteredScans.length} scan{filteredScans.length !== 1 ? 's' : ''} found</p>
                  <div className="flex items-center gap-2">
                    <Button 
                      variant="outline" 
                      size="icon"
                      className="h-7 w-7"
                      onClick={() => queryClient.invalidateQueries({ queryKey: ['/api/scans'] })}
                      title="Refresh scan history"
                    >
                      <RefreshCw className="h-3.5 w-3.5" />
                    </Button>
                    <Button variant="ghost" size="sm" className="h-7 px-2 text-gray-500">
                      <ArrowUpDown className="h-3.5 w-3.5 mr-1.5" />
                      <span className="text-xs">Sort by date</span>
                    </Button>
                  </div>
                </div>
              
                {filteredScans.map((scan: any) => (
                  <ScanHistoryItem key={scan.id} scan={scan} onDelete={handleDelete} />
                ))}
              </>
            ) : (
              <EmptyState />
            )}
          </div>
          
          {filteredScans.length > 10 && (
            <div className="flex justify-center">
              <Button variant="outline">Load More Scans</Button>
            </div>
          )}
        </div>
      </div>
    </>
  );
};

export default ScanHistoryPage;