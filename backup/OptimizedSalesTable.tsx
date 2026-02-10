import React, { useState, useEffect, useMemo } from "react";
import { apiRequest } from "@/lib/queryClient";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
  TableFooter
} from "@/components/ui/table";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { PlantBadge } from "@/components/PlantBadge";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogTrigger } from "@/components/ui/dialog";
import { Loader2, ChevronDown, ChevronLeft, ChevronRight, ChevronUp, Truck, Trash } from "lucide-react";
import { useQuery } from "@tanstack/react-query";

// Status Badge Component
const StatusBadge: React.FC<{ status: string | null | undefined }> = ({ status }) => {
  // Replace PENDING DESP with READY≈DESP
  let displayStatus = status;
  if (status === "PENDING DESP") {
    displayStatus = "READY≈DESP";
  }
  
  return (
    <span className="inline-flex items-center justify-center px-2.5 py-0.5 rounded-md text-xs font-medium bg-purple-100 text-purple-800 border border-purple-500">
      {displayStatus ? displayStatus.toUpperCase() : "UNKNOWN"}
    </span>
  );
};

// Optimized Sale Details Dialog
const OptimizedSaleDetailsDialog: React.FC<{ saleId: number, orderNumber: string, saleData: any, isBackup?: boolean }> = ({ 
  saleId, 
  orderNumber, 
  saleData, 
  isBackup = false 
}) => {
  // Fetch sale details only when dialog is opened
  const [isOpen, setIsOpen] = useState(false);
  
  // Fetch sale details when dialog is open
  const { data: saleDetails, isLoading: saleLoading } = useQuery({
    queryKey: [`/api/${isBackup ? 'backup/' : ''}sales/${saleId}`],
    queryFn: async () => {
      const res = await apiRequest('GET', `/api/${isBackup ? 'backup/' : ''}sales/${saleId}`);
      return res.json();
    },
    enabled: isOpen // Only fetch when dialog is open
  });
  
  // Also fetch items separately to ensure we get them, with generateMissing=true to generate items if missing
  const { data: itemsData, isLoading: itemsLoading } = useQuery({
    queryKey: [`/api/${isBackup ? 'backup/' : ''}sales/${saleId}/items`],
    queryFn: async () => {
      // First try with generateMissing=true to attempt automatic regeneration of missing items
      const res = await apiRequest('GET', `/api/${isBackup ? 'backup/' : ''}sales/${saleId}/items?generateMissing=true`);
      const data = await res.json();
      
      // If we got a response with 'generated' flag, log it for debugging
      if (data.generated) {
        console.log(`Successfully generated missing items for Sale #${saleId}`, data.items);
        // Return just the items array to match the expected format
        return data.items;
      }
      
      return data;
    },
    enabled: isOpen, // Only fetch when dialog is open
    retry: 1 // One retry is enough since we're already generating missing items
  });
  
  const isLoading = saleLoading || itemsLoading;
  
  // Extract sale data with items from the API response
  const sale = saleDetails || saleData;
  
  // Use items from separate API call if available, otherwise use items from sale object
  // Let's console log the items data for debugging
  console.log("itemsData:", itemsData);
  console.log("sale?.items:", sale?.items);
  
  // Also normalize the data format to handle both database field names (snake_case) and client field names (camelCase)
  const items = (itemsData?.length > 0 ? itemsData : sale?.items || []).map((item: any) => {
    console.log("Processing item:", item);
    return {
      // Normalize field names to ensure consistent access in the template
      id: item.id,
      saleId: item.saleId || item.sale_id,
      sku: item.sku,
      barcode: item.barcode,
      name: item.name,
      productId: item.productId || item.product_id,
      quantity: item.quantity || 0,
      unitPrice: item.unitPrice !== undefined ? item.unitPrice : 
                (item.unit_price !== undefined ? parseFloat(item.unit_price) : 0),
      totalPrice: item.totalPrice !== undefined ? item.totalPrice : 
                (item.total_price !== undefined ? parseFloat(item.total_price) : 0),
      category: item.category,
      hsn: item.hsn,
      originalQuantity: item.originalQuantity || item.original_quantity || item.quantity || 0,
      itemName: item.itemName || item.item_name || item.name
    };
  });

  // Format function for dates
  const formatDate = (dateStr: string) => {
    if (!dateStr) return "N/A";
    
    // Handle ISO format with time (2025-04-03T09:09:41.370Z)
    if (dateStr.includes('T')) {
      try {
        const date = new Date(dateStr);
        if (!isNaN(date.getTime())) {
          const day = date.getDate().toString().padStart(2, '0');
          const month = (date.getMonth() + 1).toString().padStart(2, '0');
          const year = date.getFullYear();
          return `${day}/${month}/${year}`;
        }
      } catch (e) {
        // Ignore parsing errors, continue with other methods
      }
    }
    
    // Parse date with hyphen format (DD-MM-YYYY or YYYY-MM-DD)
    if (dateStr.includes('-')) {
      const parts = dateStr.split('-');
      if (parts.length === 3) {
        // Check if it's YYYY-MM-DD format (first part is 4-digit year)
        if (parts[0].length === 4 && !isNaN(parseInt(parts[0]))) {
          return `${parts[2]}/${parts[1]}/${parts[0]}`;
        }
        // Assume it's DD-MM-YYYY format
        return `${parts[0]}/${parts[1]}/${parts[2]}`;
      }
    }
    // Parse date with slash format (YYYY/MM/DD or DD/MM/YYYY)
    else if (dateStr.includes('/')) {
      const parts = dateStr.split('/');
      if (parts.length === 3) {
        // Check if it's YYYY/MM/DD format (first part is 4-digit year)
        if (parts[0].length === 4 && !isNaN(parseInt(parts[0]))) {
          return `${parts[2]}/${parts[1]}/${parts[0]}`; // Convert to DD/MM/YYYY
        }
        // Already in DD/MM/YYYY format
        return dateStr;
      }
    }
    
    // Last resort: try to parse using standard Date
    try {
      const date = new Date(dateStr);
      if (!isNaN(date.getTime())) {
        const day = date.getDate().toString().padStart(2, '0');
        const month = (date.getMonth() + 1).toString().padStart(2, '0');
        const year = date.getFullYear();
        return `${day}/${month}/${year}`;
      }
    } catch (e) {
      // Ignore parsing errors
    }
    
    return dateStr; // If format is unexpected, just show the original
  };

  return (
    <Dialog open={isOpen} onOpenChange={setIsOpen}>
      <DialogTrigger asChild>
        <Button 
          variant="ghost" 
          size="icon"
          className="h-8 w-8 text-blue-600 hover:text-blue-800 hover:bg-blue-100"
        >
          <svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <path d="M2 12s3-7 10-7 10 7 10 7-3 7-10 7-10-7-10-7Z" />
            <circle cx="12" cy="12" r="3" />
          </svg>
        </Button>
      </DialogTrigger>
      <DialogContent className="max-w-6xl max-h-[90vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle>Sale Details - #{orderNumber}</DialogTitle>
        </DialogHeader>
        
        {isLoading ? (
          <div className="flex justify-center py-10">
            <Loader2 className="h-8 w-8 animate-spin text-muted-foreground" />
          </div>
        ) : (
          <>
            <div className="grid grid-cols-1 md:grid-cols-3 gap-4 py-4">
              <div className="space-y-3 md:col-span-2">
                <div className="grid grid-cols-2 gap-2">
                  <div className="font-medium text-muted-foreground">Order No.:</div>
                  <div>#{sale.orderNumber}</div>
                </div>
                <div className="grid grid-cols-2 gap-2">
                  <div className="font-medium text-muted-foreground">Date:</div>
                  <div>{formatDate(sale.date)}</div>
                </div>
                <div className="grid grid-cols-2 gap-2">
                  <div className="font-medium text-muted-foreground">Party Name:</div>
                  <div className="font-semibold">{sale.dealer && sale.dealer !== "Unknown" ? sale.dealer : sale.party && sale.party !== "Unknown" ? sale.party : sale.party_name && sale.party_name !== "Unknown" ? sale.party_name : "N/A"}</div>
                </div>
                <div className="grid grid-cols-2 gap-2">
                  <div className="font-medium text-muted-foreground">Plant:</div>
                  <div>
                    {sale.plant && sale.plant !== "Unknown" ? (
                      <PlantBadge plant={sale.plant} />
                    ) : (
                      <span className="text-gray-500">-</span>
                    )}
                  </div>
                </div>
                <div className="grid grid-cols-2 gap-2">
                  <div className="font-medium text-muted-foreground">Vehicle Number:</div>
                  <div>{sale.vehicleNumber || "Not assigned"}</div>
                </div>
                {sale.notes && (
                  <div className="grid grid-cols-2 gap-2">
                    <div className="font-medium text-muted-foreground">Storekeeper:</div>
                    <div>
                      {(() => {
                        const storekeeperMatch = sale.notes.match(/Storekeeper: (.*?) \((.*?)\)/);
                        if (storekeeperMatch && storekeeperMatch.length >= 3) {
                          return (
                            <div className="flex items-center gap-2">
                              <span>{storekeeperMatch[1]}</span>
                              <span className="text-xs bg-purple-100 text-purple-800 px-2 py-0.5 rounded">
                                {storekeeperMatch[2]}
                              </span>
                            </div>
                          );
                        }
                        return "Unknown";
                      })()}
                    </div>
                  </div>
                )}
              </div>
              <div className="bg-muted/10 p-4 rounded-md border border-muted">
                <div className="space-y-3">
                  <div className="grid grid-cols-2 gap-2">
                    <div className="font-medium text-muted-foreground">Status:</div>
                    <div>
                      <StatusBadge status={sale.status} />
                    </div>
                  </div>
                  <div className="grid grid-cols-2 gap-2">
                    <div className="font-medium text-muted-foreground">Total Quantity:</div>
                    <div className="font-semibold text-green-600">{sale.quantity}</div>
                  </div>
                  <div className="grid grid-cols-2 gap-2">
                    <div className="font-medium text-muted-foreground">Total Amount:</div>
                    <div className="font-bold text-blue-600">
                      {parseFloat(sale.amount || '0') > 0 
                        ? `₹${parseFloat(sale.amount).toLocaleString()}`
                        : <span className="text-gray-500">Not available</span>}
                    </div>
                  </div>
                </div>
              </div>
            </div>
            
            <div className="border rounded-md mt-4">
              <div className="p-3 bg-muted/30 font-medium flex items-center justify-between">
                <div>Item Details</div>
                <div className="text-sm text-muted-foreground">
                  Total Items: {items?.length || 0}
                </div>
              </div>
              <div className="p-2 max-h-[50vh] overflow-y-auto">
                <Table>
                  <TableHeader>
                    <TableRow>
                      <TableHead className="w-[60px]">Sr. No.</TableHead>
                      <TableHead className="w-[100px]">SKU</TableHead>
                      <TableHead className="min-w-[250px]">Item Name</TableHead>
                      <TableHead className="text-center w-[80px] text-green-600">Quantity</TableHead>
                      <TableHead className="text-right w-[120px]">Unit Price</TableHead>
                      <TableHead className="text-right w-[120px]">Total</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {items && items.length > 0 ? (
                      items.map((item: any, index: number) => (
                        <TableRow key={index} className="hover:bg-muted/30">
                          <TableCell>{item.srNo || index + 1}</TableCell>
                          <TableCell className="font-medium">{item.sku || item.barcode || "N/A"}</TableCell>
                          <TableCell className="break-words max-w-[200px]">
                            <div className="font-medium">{item.itemName || item.name || "Unknown Item"}</div>
                            {item.category && <div className="text-xs text-muted-foreground mt-1">Category: {item.category}</div>}
                            {item.hsn && <div className="text-xs text-muted-foreground">HSN: {item.hsn}</div>}
                          </TableCell>
                          <TableCell className="text-center">
                            <span className="text-green-600 font-semibold">{item.quantity || 0}</span>
                          </TableCell>
                          <TableCell className="text-right">₹{(item.unitPrice || 0).toLocaleString()}</TableCell>
                          <TableCell className="text-right">₹{(item.totalPrice || (item.unitPrice || 0) * (item.quantity || 0)).toLocaleString()}</TableCell>
                        </TableRow>
                      ))
                    ) : (
                      <TableRow>
                        <TableCell colSpan={6} className="text-center py-4 text-muted-foreground">
                          No items found
                        </TableCell>
                      </TableRow>
                    )}
                  </TableBody>
                  <TableFooter>
                    <TableRow>
                      <TableCell colSpan={3}>Total</TableCell>
                      <TableCell className="text-center text-green-600 font-semibold">
                        {items?.reduce((sum: number, item: any) => sum + (item.quantity || 0), 0) || 0}
                      </TableCell>
                      <TableCell></TableCell>
                      <TableCell className="text-right font-semibold">
                        ₹{items?.reduce((sum: number, item: any) => 
                          sum + (item.totalPrice || (item.unitPrice || 0) * (item.quantity || 0)), 0)?.toLocaleString() || "0"}
                      </TableCell>
                    </TableRow>
                  </TableFooter>
                </Table>
              </div>
            </div>
          </>
        )}
      </DialogContent>
    </Dialog>
  );
};

// OptimizedSalesTable Component
interface OptimizedSalesTableProps {
  data: any[];
  isLoading: boolean;
  handleDeleteSale: (id: number) => void;
  limit?: number;
  onLimitChange?: (limit: number) => void;
  sortField?: string;
  sortDirection?: 'asc' | 'desc';
  onSortChange?: (field: string, direction: 'asc' | 'desc') => void;
  selectedDate?: Date | null;
}

const OptimizedSalesTable: React.FC<OptimizedSalesTableProps> = ({
  data,
  isLoading,
  handleDeleteSale,
  limit = 50,
  onLimitChange,
  sortField = 'date',
  sortDirection = 'desc',
  onSortChange,
  selectedDate
}) => {
  const [currentPage, setCurrentPage] = useState(1);
  const [internalLimit, setInternalLimit] = useState<number>(limit);
  
  // Update internal limit when external limit changes
  useEffect(() => {
    setInternalLimit(limit);
    setCurrentPage(1);
  }, [limit]);

  // Filter data by selected date if present
  const filteredData = useMemo(() => {
    if (!selectedDate) return data;
    
    // Convert the selected date to a string format for comparison
    const selectedDateFormatted = selectedDate ? 
      `${selectedDate.getDate().toString().padStart(2, '0')}/${(selectedDate.getMonth() + 1).toString().padStart(2, '0')}/${selectedDate.getFullYear()}` 
      : null;
    
    return data.filter(sale => {
      // Parse the sale date into a comparable format
      // Handle different date formats
      if (sale.date) {
        // Extract day/month/year
        let saleDate: string | null = null;
        
        // Handle ISO format
        if (typeof sale.date === 'string' && sale.date.includes('T')) {
          const date = new Date(sale.date);
          saleDate = `${date.getDate().toString().padStart(2, '0')}/${(date.getMonth() + 1).toString().padStart(2, '0')}/${date.getFullYear()}`;
        } 
        // Handle DD/MM/YYYY format
        else if (typeof sale.date === 'string' && sale.date.includes('/')) {
          saleDate = sale.date;
        }
        // Handle DD-MM-YYYY format
        else if (typeof sale.date === 'string' && sale.date.includes('-')) {
          const parts = sale.date.split('-');
          if (parts.length === 3) {
            saleDate = `${parts[0]}/${parts[1]}/${parts[2]}`;
          }
        }
        
        return saleDate === selectedDateFormatted;
      }
      return false;
    });
  }, [data, selectedDate]);

  // Sort data based on sort field and direction
  const sortedData = useMemo(() => {
    if (!filteredData) return [];
    
    return [...filteredData].sort((a, b) => {
      let aValue = a[sortField];
      let bValue = b[sortField];
      
      // Special handling for date field
      if (sortField === 'date') {
        // Parse dates for comparison
        const parseDate = (dateStr: string | Date) => {
          if (dateStr instanceof Date) return dateStr;
          
          // Handle ISO format (2025-04-03T09:09:41.370Z)
          if (typeof dateStr === 'string' && dateStr.includes('T')) {
            return new Date(dateStr);
          }
          
          // Handle DD/MM/YYYY format
          if (typeof dateStr === 'string' && dateStr.includes('/')) {
            const parts = dateStr.split('/');
            if (parts.length === 3) {
              // Convert DD/MM/YYYY to YYYY-MM-DD for proper Date parsing
              return new Date(`${parts[2]}-${parts[1]}-${parts[0]}`);
            }
          }
          
          // Handle DD-MM-YYYY format
          if (typeof dateStr === 'string' && dateStr.includes('-')) {
            const parts = dateStr.split('-');
            if (parts.length === 3) {
              // Check if it's YYYY-MM-DD format (first part is 4-digit year)
              if (parts[0].length === 4 && !isNaN(parseInt(parts[0]))) {
                return new Date(dateStr);
              }
              // Convert DD-MM-YYYY to YYYY-MM-DD for proper Date parsing
              return new Date(`${parts[2]}-${parts[1]}-${parts[0]}`);
            }
          }
          
          // Fallback
          return new Date(dateStr);
        };
        
        aValue = parseDate(aValue);
        bValue = parseDate(bValue);
      }
      
      // Special handling for numeric fields
      if (sortField === 'quantity' || sortField === 'amount') {
        aValue = parseFloat(aValue) || 0;
        bValue = parseFloat(bValue) || 0;
      }
      
      // Compare values based on sort direction
      if (sortDirection === 'asc') {
        return aValue > bValue ? 1 : aValue < bValue ? -1 : 0;
      } else {
        return aValue < bValue ? 1 : aValue > bValue ? -1 : 0;
      }
    });
  }, [filteredData, sortField, sortDirection]);

  // Calculate pagination
  const totalPages = Math.ceil(sortedData.length / internalLimit);
  
  // Get current page of data
  const displayData = sortedData.slice(
    (currentPage - 1) * internalLimit, 
    Math.min(currentPage * internalLimit, sortedData.length)
  );

  // Handle sort change
  const handleSortChange = (field: string) => {
    if (onSortChange) {
      if (field === sortField) {
        // Toggle direction if clicking on the same field
        onSortChange(field, sortDirection === 'asc' ? 'desc' : 'asc');
      } else {
        // Default to descending for new sort field
        onSortChange(field, 'desc');
      }
    }
  };

  // Get sort icon for a field
  const getSortIcon = (field: string) => {
    if (field !== sortField) {
      return <ChevronDown className="h-4 w-4 text-muted-foreground opacity-50" />;
    }
    return sortDirection === 'asc' 
      ? <ChevronUp className="h-4 w-4 text-blue-600" />
      : <ChevronDown className="h-4 w-4 text-blue-600" />;
  };
  
  // Format the date for display
  const formatDate = (dateStr: string | Date) => {
    if (!dateStr) return "N/A";
    
    try {
      // If it's already a Date object
      if (dateStr instanceof Date) {
        return `${dateStr.getDate().toString().padStart(2, '0')}/${(dateStr.getMonth() + 1).toString().padStart(2, '0')}/${dateStr.getFullYear()}`;
      }
      
      // Handle ISO format (2025-04-03T09:09:41.370Z)
      if (dateStr.includes('T')) {
        const date = new Date(dateStr);
        return `${date.getDate().toString().padStart(2, '0')}/${(date.getMonth() + 1).toString().padStart(2, '0')}/${date.getFullYear()}`;
      }
      
      // Handle DD/MM/YYYY format - return as is
      if (dateStr.includes('/')) {
        return dateStr;
      }
      
      // Handle DD-MM-YYYY format - convert to DD/MM/YYYY
      if (dateStr.includes('-')) {
        const parts = dateStr.split('-');
        if (parts.length === 3) {
          return `${parts[0]}/${parts[1]}/${parts[2]}`;
        }
      }
      
      // Fallback - try to parse as Date
      const date = new Date(dateStr);
      if (!isNaN(date.getTime())) {
        return `${date.getDate().toString().padStart(2, '0')}/${(date.getMonth() + 1).toString().padStart(2, '0')}/${date.getFullYear()}`;
      }
      
      // If all else fails, return as is
      return dateStr;
      
    } catch (e) {
      console.error("Error formatting date:", e);
      return dateStr.toString();
    }
  };

  return (
    <div className="space-y-4">
      {/* Show total records and pagination info */}
      <div className="flex flex-col sm:flex-row justify-between items-center mb-2 gap-2">
        <div className="text-sm text-muted-foreground">
          {selectedDate ? (
            <span className="font-medium">
              Showing {sortedData.length} sales for {formatDate(selectedDate)}
            </span>
          ) : (
            <span>
              Showing page {currentPage} of {totalPages || 1} ({sortedData.length} total records)
            </span>
          )}
        </div>
        
        {/* Pagination controls */}
        <div className="flex items-center gap-1">
          <Button
            variant="outline"
            size="sm"
            onClick={() => setCurrentPage(1)}
            disabled={currentPage === 1}
          >
            <ChevronLeft className="h-4 w-4 mr-1" />
            First
          </Button>
          <Button
            variant="outline"
            size="sm"
            onClick={() => setCurrentPage(prev => Math.max(prev - 1, 1))}
            disabled={currentPage === 1}
          >
            <ChevronLeft className="h-4 w-4" />
          </Button>
          <span className="px-2 text-sm">
            Page {currentPage} of {totalPages || 1}
          </span>
          <Button
            variant="outline"
            size="sm"
            onClick={() => setCurrentPage(prev => Math.min(prev + 1, totalPages))}
            disabled={currentPage === totalPages || totalPages === 0}
          >
            <ChevronRight className="h-4 w-4" />
          </Button>
          <Button
            variant="outline"
            size="sm"
            onClick={() => setCurrentPage(totalPages)}
            disabled={currentPage === totalPages || totalPages === 0}
          >
            Last
            <ChevronRight className="h-4 w-4 ml-1" />
          </Button>
          
          {/* Page size select */}
          <select
            className="ml-2 bg-background text-sm border rounded-md px-2 py-1"
            value={internalLimit}
            onChange={(e) => {
              const newLimit = parseInt(e.target.value);
              setInternalLimit(newLimit);
              setCurrentPage(1);
              if (onLimitChange) onLimitChange(newLimit);
            }}
          >
            <option value={15}>15</option>
            <option value={25}>25</option>
            <option value={50}>50</option>
            <option value={100}>100</option>
            <option value={200}>200</option>
          </select>
        </div>
      </div>
      
      {/* Table */}
      <div className="border rounded-md overflow-hidden">
        <div className="overflow-x-auto">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead 
                  className="w-[150px] cursor-pointer"
                  onClick={() => handleSortChange('orderNumber')}
                >
                  <div className="flex items-center">
                    <span>Order No.</span>
                    {getSortIcon('orderNumber')}
                  </div>
                </TableHead>
                <TableHead 
                  className="w-[120px] cursor-pointer"
                  onClick={() => handleSortChange('date')}
                >
                  <div className="flex items-center">
                    <span>Date</span>
                    {getSortIcon('date')}
                  </div>
                </TableHead>
                <TableHead
                  className="min-w-[200px] cursor-pointer"
                  onClick={() => handleSortChange('dealer')}
                >
                  <div className="flex items-center">
                    <span>Party Name</span>
                    {getSortIcon('dealer')}
                  </div>
                </TableHead>
                <TableHead
                  className="w-[100px] cursor-pointer"
                  onClick={() => handleSortChange('plant')}
                >
                  <div className="flex items-center">
                    <span>Plant</span>
                    {getSortIcon('plant')}
                  </div>
                </TableHead>
                <TableHead 
                  className="w-[100px] cursor-pointer"
                  onClick={() => handleSortChange('status')}
                >
                  <div className="flex items-center">
                    <span>Status</span>
                    {getSortIcon('status')}
                  </div>
                </TableHead>
                <TableHead 
                  className="text-center w-[100px] cursor-pointer"
                  onClick={() => handleSortChange('quantity')}
                >
                  <div className="flex items-center justify-center">
                    <span>Quantity</span>
                    {getSortIcon('quantity')}
                  </div>
                </TableHead>
                <TableHead 
                  className="text-right w-[130px] cursor-pointer"
                  onClick={() => handleSortChange('amount')}
                >
                  <div className="flex items-center justify-end">
                    <span>Amount</span>
                    {getSortIcon('amount')}
                  </div>
                </TableHead>
                <TableHead className="w-[60px] text-right">Actions</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {isLoading ? (
                <TableRow>
                  <TableCell colSpan={8} className="h-24 text-center">
                    <Loader2 className="h-6 w-6 animate-spin mx-auto" />
                    <div className="mt-2 text-sm text-muted-foreground">
                      Loading sales data...
                    </div>
                  </TableCell>
                </TableRow>
              ) : displayData.length === 0 ? (
                <TableRow>
                  <TableCell colSpan={8} className="h-24 text-center">
                    <div className="text-muted-foreground">
                      {selectedDate ? (
                        `No sales found for ${formatDate(selectedDate)}`
                      ) : (
                        "No sales found"
                      )}
                    </div>
                  </TableCell>
                </TableRow>
              ) : (
                displayData.map((sale) => (
                  <TableRow key={sale.id} className="hover:bg-muted/30">
                    <TableCell>
                      <span 
                        className="flex items-center gap-1 text-blue-600 font-medium"
                      >
                        #{sale.orderNumber}
                      </span>
                        <DialogContent className="max-w-6xl max-h-[90vh] overflow-y-auto">
                          <DialogHeader>
                            <DialogTitle>Sale Details - #{sale.orderNumber}</DialogTitle>
                          </DialogHeader>
                          
                          <div className="grid grid-cols-1 md:grid-cols-3 gap-4 py-4">
                            <div className="space-y-3 md:col-span-2">
                              <div className="grid grid-cols-2 gap-2">
                                <div className="font-medium text-muted-foreground">Order No.:</div>
                                <div>#{sale.orderNumber}</div>
                              </div>
                              <div className="grid grid-cols-2 gap-2">
                                <div className="font-medium text-muted-foreground">Date:</div>
                                <div>{formatDate(sale.date)}</div>
                              </div>
                              <div className="grid grid-cols-2 gap-2">
                                <div className="font-medium text-muted-foreground">Party Name:</div>
                                <div className="font-semibold">{sale.dealer || sale.party || "N/A"}</div>
                              </div>
                              <div className="grid grid-cols-2 gap-2">
                                <div className="font-medium text-muted-foreground">Plant:</div>
                                <div>
                                  {sale.plant ? (
                                    <PlantBadge plant={sale.plant} />
                                  ) : (
                                    <span className="text-gray-500">-</span>
                                  )}
                                </div>
                              </div>
                              <div className="grid grid-cols-2 gap-2">
                                <div className="font-medium text-muted-foreground">Vehicle Number:</div>
                                <div>{sale.vehicleNumber || "Not assigned"}</div>
                              </div>
                              {sale.notes && (
                                <div className="grid grid-cols-2 gap-2">
                                  <div className="font-medium text-muted-foreground">Storekeeper:</div>
                                  <div>
                                    {(() => {
                                      const storekeeperMatch = sale.notes.match(/Storekeeper: (.*?) \((.*?)\)/);
                                      if (storekeeperMatch && storekeeperMatch.length >= 3) {
                                        return (
                                          <div className="flex items-center gap-2">
                                            <span>{storekeeperMatch[1]}</span>
                                            <span className="text-xs bg-purple-100 text-purple-800 px-2 py-0.5 rounded">
                                              {storekeeperMatch[2]}
                                            </span>
                                          </div>
                                        );
                                      }
                                      return <span className="text-gray-500">-</span>;
                                    })()}
                                  </div>
                                </div>
                              )}
                            </div>
                            <div className="bg-muted/10 p-4 rounded-md border border-muted">
                              <div className="space-y-3">
                                <div className="grid grid-cols-2 gap-2">
                                  <div className="font-medium text-muted-foreground">Status:</div>
                                  <div>
                                    <StatusBadge status={sale.status} />
                                  </div>
                                </div>
                                <div className="grid grid-cols-2 gap-2">
                                  <div className="font-medium text-muted-foreground">Total Quantity:</div>
                                  <div className="font-semibold text-green-600">{sale.quantity}</div>
                                </div>
                                <div className="grid grid-cols-2 gap-2">
                                  <div className="font-medium text-muted-foreground">Total Amount:</div>
                                  <div className="font-bold text-blue-600">₹{parseFloat(sale.amount || '0').toLocaleString()}</div>
                                </div>
                              </div>
                            </div>
                          </div>
                        </DialogContent>
                      </Dialog>
                    </TableCell>
                    <TableCell>{formatDate(sale.date)}</TableCell>
                    <TableCell className="font-medium">
                      {sale.dealer && sale.dealer !== "Unknown" 
                        ? sale.dealer 
                        : sale.party && sale.party !== "Unknown" 
                          ? sale.party 
                          : sale.party_name && sale.party_name !== "Unknown" 
                            ? sale.party_name 
                            : "N/A"}
                    </TableCell>
                    <TableCell>
                      {sale.plant && sale.plant !== "Unknown" ? (
                        <PlantBadge plant={sale.plant} />
                      ) : (
                        <span className="text-gray-500">-</span>
                      )}
                    </TableCell>
                    <TableCell>
                      <StatusBadge status={sale.status} />
                    </TableCell>
                    <TableCell className="text-center font-medium text-green-600">
                      {sale.quantity || 0}
                    </TableCell>
                    <TableCell className="text-right font-medium">
                      {parseFloat(sale.amount || '0') > 0 
                        ? `₹${parseFloat(sale.amount).toLocaleString()}`
                        : <span className="text-gray-500">-</span>}
                    </TableCell>
                    <TableCell className="text-right">
                      <div className="flex items-center justify-end gap-1">
                        {/* Sale Details Dialog */}
                        <Dialog>
                          <DialogTrigger asChild>
                            <Button
                              variant="ghost"
                              size="icon"
                              className="h-8 w-8 text-blue-600 hover:text-blue-800 hover:bg-blue-100"
                            >
                              <svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                                <path d="M2 12s3-7 10-7 10 7 10 7-3 7-10 7-10-7-10-7Z" />
                                <circle cx="12" cy="12" r="3" />
                              </svg>
                            </Button>
                          </DialogTrigger>
                          <DialogContent className="max-w-6xl max-h-[90vh] overflow-y-auto">
                            <DialogHeader>
                              <DialogTitle>Sale Details - #{sale.orderNumber}</DialogTitle>
                            </DialogHeader>
                            
                            <div className="grid grid-cols-1 md:grid-cols-3 gap-4 py-4">
                              <div className="space-y-3 md:col-span-2">
                                <div className="grid grid-cols-2 gap-2">
                                  <div className="font-medium text-muted-foreground">Order No.:</div>
                                  <div>#{sale.orderNumber}</div>
                                </div>
                                <div className="grid grid-cols-2 gap-2">
                                  <div className="font-medium text-muted-foreground">Date:</div>
                                  <div>{formatDate(sale.date)}</div>
                                </div>
                                <div className="grid grid-cols-2 gap-2">
                                  <div className="font-medium text-muted-foreground">Party Name:</div>
                                  <div className="font-semibold">
                                    {sale.dealer && sale.dealer !== "Unknown" 
                                      ? sale.dealer 
                                      : sale.party && sale.party !== "Unknown" 
                                        ? sale.party 
                                        : sale.party_name && sale.party_name !== "Unknown" 
                                          ? sale.party_name 
                                          : "N/A"}
                                  </div>
                                </div>
                                <div className="grid grid-cols-2 gap-2">
                                  <div className="font-medium text-muted-foreground">Plant:</div>
                                  <div>
                                    {sale.plant && sale.plant !== "Unknown" ? (
                                      <PlantBadge plant={sale.plant} />
                                    ) : (
                                      <span className="text-gray-500">-</span>
                                    )}
                                  </div>
                                </div>
                                <div className="grid grid-cols-2 gap-2">
                                  <div className="font-medium text-muted-foreground">Vehicle Number:</div>
                                  <div>{sale.vehicleNumber || "Not assigned"}</div>
                                </div>
                                {sale.notes && (
                                  <div className="grid grid-cols-2 gap-2">
                                    <div className="font-medium text-muted-foreground">Storekeeper:</div>
                                    <div>
                                      {(() => {
                                        const storekeeperMatch = sale.notes.match(/Storekeeper: (.*?) \((.*?)\)/);
                                        if (storekeeperMatch && storekeeperMatch.length >= 3) {
                                          return (
                                            <div className="flex items-center gap-2">
                                              <span>{storekeeperMatch[1]}</span>
                                              <span className="text-xs bg-purple-100 text-purple-800 px-2 py-0.5 rounded">
                                                {storekeeperMatch[2]}
                                              </span>
                                            </div>
                                          );
                                        }
                                        return <span className="text-gray-500">-</span>;
                                      })()}
                                    </div>
                                  </div>
                                )}
                              </div>
                              <div className="bg-muted/10 p-4 rounded-md border border-muted">
                                <div className="space-y-3">
                                  <div className="grid grid-cols-2 gap-2">
                                    <div className="font-medium text-muted-foreground">Status:</div>
                                    <div>
                                      <StatusBadge status={sale.status} />
                                    </div>
                                  </div>
                                  <div className="grid grid-cols-2 gap-2">
                                    <div className="font-medium text-muted-foreground">Total Quantity:</div>
                                    <div className="font-semibold text-green-600">{sale.quantity || 0}</div>
                                  </div>
                                  <div className="grid grid-cols-2 gap-2">
                                    <div className="font-medium text-muted-foreground">Total Amount:</div>
                                    <div className="font-bold text-blue-600">
                                      {parseFloat(sale.amount || '0') > 0 
                                        ? `₹${parseFloat(sale.amount).toLocaleString()}`
                                        : <span className="text-gray-500">Not available</span>}
                                    </div>
                                  </div>
                                </div>
                              </div>
                            </div>
                            
                            {/* Item Details Section */}
                            <div className="mt-4 p-4 border rounded-md bg-muted/5">
                              <h3 className="text-sm font-semibold mb-3">Sale Items</h3>
                              {(!sale.items || sale.items.length === 0) ? (
                                <div className="py-10 text-center">
                                  <div className="mb-3 text-muted-foreground">
                                    <svg xmlns="http://www.w3.org/2000/svg" width="40" height="40" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1" strokeLinecap="round" strokeLinejoin="round" className="mx-auto mb-2 opacity-50">
                                      <path d="M9 17H7A5 5 0 0 1 7 7h8a5 5 0 0 1 4 8" />
                                      <path d="M15 17h2a3 3 0 1 0 0-6h-2" />
                                      <line x1="9" y1="12" x2="15" y2="12" />
                                    </svg>
                                    <p className="text-sm">No item details available for this sale</p>
                                  </div>
                                  <p className="text-xs text-muted-foreground">
                                    This sale was created before item details were tracked, or items were not properly migrated.
                                  </p>
                                </div>
                              ) : (
                                <div className="overflow-x-auto">
                                  <table className="w-full text-sm">
                                    <thead>
                                      <tr className="border-b">
                                        <th className="px-2 py-2 text-left font-medium">Product</th>
                                        <th className="px-2 py-2 text-center font-medium">HSN</th>
                                        <th className="px-2 py-2 text-center font-medium">Quantity</th>
                                        <th className="px-2 py-2 text-right font-medium">Unit Price</th>
                                        <th className="px-2 py-2 text-right font-medium">Total</th>
                                      </tr>
                                    </thead>
                                    <tbody>
                                      {sale.items.map((item: any, idx: number) => {
                                        // Normalize field access to handle both snake_case and camelCase
                                        const name = item.name || item.itemName || item.product_name || "Unknown Product";
                                        const hsn = item.hsn || "-";
                                        const quantity = item.quantity || 0;
                                        const unitPrice = typeof item.unitPrice !== 'undefined' ? item.unitPrice : 
                                                         (typeof item.unit_price !== 'undefined' ? parseFloat(item.unit_price) : 0);
                                        const totalPrice = typeof item.totalPrice !== 'undefined' ? item.totalPrice : 
                                                          (typeof item.total_price !== 'undefined' ? parseFloat(item.total_price) : 
                                                          (unitPrice * quantity));
                                        
                                        return (
                                          <tr key={idx} className="border-b border-gray-100">
                                            <td className="px-2 py-1.5">{name}</td>
                                            <td className="px-2 py-1.5 text-center">{hsn}</td>
                                            <td className="px-2 py-1.5 text-center">{quantity}</td>
                                            <td className="px-2 py-1.5 text-right">₹{unitPrice.toLocaleString()}</td>
                                            <td className="px-2 py-1.5 text-right font-medium">
                                              ₹{totalPrice.toLocaleString()}
                                            </td>
                                          </tr>
                                        );
                                      })}
                                    </tbody>
                                  </table>
                                </div>
                              )}
                            </div>
                          </DialogContent>
                        </Dialog>
                        
                        {/* Delete button */}
                        {!sale.isBackup && (
                          <Button
                            variant="ghost"
                            size="icon"
                            className="h-8 w-8 text-red-600 hover:text-red-800 hover:bg-red-100"
                            onClick={() => {
                              if (window.confirm(`Are you sure you want to delete sale #${sale.orderNumber}? This action cannot be undone.`)) {
                                handleDeleteSale(sale.id);
                              }
                            }}
                          >
                            <Trash className="h-4 w-4" />
                          </Button>
                        )}
                      </div>
                    </TableCell>
                  </TableRow>
                ))
              )}
            </TableBody>
          </Table>
        </div>
      </div>
      
      {/* Bottom pagination */}
      {totalPages > 1 && (
        <div className="flex justify-center mt-4">
          <div className="flex items-center gap-1">
            <Button
              variant="outline"
              size="sm"
              onClick={() => setCurrentPage(prev => Math.max(prev - 1, 1))}
              disabled={currentPage === 1}
            >
              <ChevronLeft className="h-4 w-4 mr-1" />
              Previous
            </Button>
            
            {/* Generate page buttons */}
            {(() => {
              const buttons = [];
              const startPage = Math.max(1, currentPage - 2);
              const endPage = Math.min(totalPages, startPage + 4);
              
              for (let page = startPage; page <= endPage; page++) {
                buttons.push(
                  <Button
                    key={page}
                    variant={page === currentPage ? "default" : "outline"}
                    size="sm"
                    onClick={() => setCurrentPage(page)}
                    className="w-8 h-8 p-0"
                  >
                    {page}
                  </Button>
                );
              }
              return buttons;
            })()}
            
            <Button
              variant="outline"
              size="sm"
              onClick={() => setCurrentPage(prev => Math.min(prev + 1, totalPages))}
              disabled={currentPage === totalPages}
            >
              Next
              <ChevronRight className="h-4 w-4 ml-1" />
            </Button>
          </div>
        </div>
      )}
    </div>
  );
};

export default OptimizedSalesTable;