import { useState, useRef, useEffect } from "react";
import { useQuery, useMutation } from "@tanstack/react-query";
import { format } from "date-fns";
import PageHeader from "@/components/PageHeader";
import { SingleDateFilter } from "@/components/SingleDateFilter";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import { Search, FileBarChart, Package } from "lucide-react";
import { cn } from "@/lib/utils";
import { useToast } from "@/hooks/use-toast";
import { CategoryBadge } from "@/components/CategoryBadge";
import { apiRequest, queryClient } from "@/lib/queryClient";
import { usePersistentFilter } from "@/hooks/usePersistentFilter";

// Types for API response
interface StockSheetItem {
  id: number; // Product ID for API updates
  sr: string | number; // Can be Sr. No. like "A001" or sequential number
  itemName: string;
  category?: string;
  companyRemaining: number;
  purchase: number;
  sale: number;
  stock: number;
}

export default function StockSheets() {
  const { toast } = useToast();
  const [selectedDate, setSelectedDate] = useState<Date | null>(new Date());
  const [category, setCategory] = useState<string>("");
  const [searchQuery, setSearchQuery] = usePersistentFilter<string>("stockSheets:search", "");
  const [editingId, setEditingId] = useState<number | null>(null);
  const [editValue, setEditValue] = useState<string>("");
  const inputRef = useRef<HTMLInputElement>(null);

  // Build query parameters for API call
  const queryParams = new URLSearchParams();
  if (selectedDate) {
    queryParams.set('date', format(selectedDate, 'yyyy-MM-dd'));
  }
  if (category) {
    queryParams.set('category', category);
  }
  if (searchQuery.trim()) {
    queryParams.set('q', searchQuery.trim());
  }

  // Fetch stock sheets data  
  const {
    data: stockData,
    isLoading,
    error,
    refetch
  } = useQuery({
    queryKey: ['/api/stock-sheets', selectedDate?.toISOString(), category, searchQuery],
    queryFn: async (): Promise<StockSheetItem[]> => {
      const url = `/api/stock-sheets${queryParams.toString() ? `?${queryParams.toString()}` : ''}`;
      const response = await fetch(url, { credentials: 'include' });
      if (!response.ok) {
        throw new Error(`Failed to fetch stock sheets: ${response.statusText}`);
      }
      return response.json();
    },
  });

  // Mutation for updating company remaining stock
  const updateStockMutation = useMutation({
    mutationFn: async ({ productId, inStock }: { productId: number; inStock: number }) => {
      return apiRequest('PATCH', `/api/products/${productId}`, { inStock }, false, true);
    },
    onMutate: async ({ productId, inStock }) => {
      // Cancel any outgoing refetches
      await queryClient.cancelQueries({ queryKey: ['/api/stock-sheets'] });
      
      // Snapshot the previous values
      const previousStockData = queryClient.getQueriesData({ queryKey: ['/api/stock-sheets'] });
      
      // Optimistically update the cache
      queryClient.setQueriesData<StockSheetItem[]>(
        { queryKey: ['/api/stock-sheets'] },
        (old) => {
          if (!old) return old;
          
          return old.map((item) => {
            if (item.id === productId) {
              const newCompanyRemaining = inStock;
              const newStock = newCompanyRemaining + item.purchase - item.sale;
              return {
                ...item,
                companyRemaining: newCompanyRemaining,
                stock: newStock,
              };
            }
            return item;
          });
        }
      );
      
      return { previousStockData };
    },
    onError: (err, { productId, inStock }, context) => {
      // Restore the previous cache snapshot
      if (context?.previousStockData) {
        context.previousStockData.forEach(([queryKey, data]) => {
          queryClient.setQueryData(queryKey, data);
        });
      }
      
      toast({
        title: "Update failed",
        description: err instanceof Error ? err.message : "Failed to update stock",
        variant: "destructive",
      });
    },
    onSuccess: () => {
      // Invalidate all stock-sheets queries to ensure fresh data
      queryClient.invalidateQueries({ 
        queryKey: ['/api/stock-sheets'], 
        exact: false 
      });
      
      toast({
        title: "Stock updated",
        description: "Company remaining has been updated successfully.",
      });
    },
    onSettled: () => {
      // Always cancel editing when mutation completes
      cancelEdit();
    }
  });

  // Handle date filter change
  const handleDateChange = (date: Date | null) => {
    setSelectedDate(date);
  };

  // Handle category change
  const handleCategoryChange = (value: string) => {
    setCategory(value === "all" ? "" : value);
  };

  // Handle search input change
  const handleSearchChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    setSearchQuery(e.target.value);
  };

  // Clear all filters
  const clearFilters = () => {
    setSelectedDate(null);
    setCategory("");
    setSearchQuery("");
    toast({
      title: "Filters cleared",
      description: "All filters have been cleared.",
    });
  };

  // Focus input when editing starts
  useEffect(() => {
    if (editingId && inputRef.current) {
      inputRef.current.focus();
      inputRef.current.select();
    }
  }, [editingId]);

  // Start editing a cell
  const startEditing = (item: StockSheetItem) => {
    setEditingId(item.id);
    setEditValue(item.companyRemaining.toString());
  };

  // Save edit using mutation
  const saveEdit = (item: StockSheetItem) => {
    // Prevent double-save during pending mutation
    if (updateStockMutation.isPending) {
      return;
    }

    const newValue = parseInt(editValue, 10);
    
    if (isNaN(newValue) || newValue < 0) {
      toast({
        title: "Invalid value",
        description: "Please enter a valid number (0 or greater).",
        variant: "destructive",
      });
      return;
    }

    if (newValue === item.companyRemaining) {
      // No change, just cancel
      cancelEdit();
      return;
    }

    // Trigger the mutation with optimistic updates
    updateStockMutation.mutate({
      productId: item.id,
      inStock: newValue
    });
  };

  // Cancel editing
  const cancelEdit = () => {
    setEditingId(null);
    setEditValue("");
  };

  // Handle key down events
  const handleKeyDown = (e: React.KeyboardEvent, item: StockSheetItem) => {
    if (e.key === "Enter") {
      e.preventDefault();
      saveEdit(item);
      // Blur input after save to consolidate save flow
      inputRef.current?.blur();
    } else if (e.key === "Escape") {
      e.preventDefault();
      cancelEdit();
    }
  };

  // Handle input change
  const handleEditValueChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    setEditValue(e.target.value);
  };

  // Show error toast when query fails (moved to useEffect to prevent render spam)
  useEffect(() => {
    if (error) {
      toast({
        title: "Error loading stock sheets",
        description: error instanceof Error ? error.message : "Failed to load stock sheets data",
        variant: "destructive",
      });
    }
  }, [error]);

  return (
    <div className="w-full px-4 lg:px-6 xl:px-8 py-4 space-y-6">
      <PageHeader 
        title="Stock Sheets" 
        subtitle="View current stock levels and transactions"
        icon={FileBarChart}
      />

      {/* Filters Section */}
      <div className="space-y-4">
        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-4">
          {/* Date Filter */}
          <div className="space-y-2">
            <Label htmlFor="date-filter">Date</Label>
            <SingleDateFilter
              pageKey="stock-sheets"
              onDateChange={handleDateChange}
              selectedDate={selectedDate}
              data-testid="date-filter"
            />
          </div>

          {/* Category Filter */}
          <div className="space-y-2">
            <Label htmlFor="category-filter">Category</Label>
            <Select value={category || "all"} onValueChange={handleCategoryChange}>
              <SelectTrigger data-testid="category-filter" className="h-11 touch-manipulation">
                <SelectValue placeholder="Select category" />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="all">All Categories</SelectItem>
                <SelectItem value="ADV">ADV</SelectItem>
                <SelectItem value="AMAIZE">AMAIZE</SelectItem>
                <SelectItem value="BANANA">BANANA</SelectItem>
                <SelectItem value="BHEL">BHEL</SelectItem>
                <SelectItem value="C.P.NAMKIN">C.P.NAMKIN</SelectItem>
                <SelectItem value="CANDY">CANDY</SelectItem>
                <SelectItem value="CHANA JOR">CHANA JOR</SelectItem>
                <SelectItem value="CHIKKI">CHIKKI</SelectItem>
                <SelectItem value="CHOCOLATE">CHOCOLATE</SelectItem>
                <SelectItem value="CHUTNEY">CHUTNEY</SelectItem>
                <SelectItem value="CRUNCHEM">CRUNCHEM</SelectItem>
                <SelectItem value="CRUNCHEX">CRUNCHEX</SelectItem>
                <SelectItem value="FARALI">FARALI</SelectItem>
                <SelectItem value="FUNNE">FUNNE</SelectItem>
                <SelectItem value="GATHIYA">GATHIYA</SelectItem>
                <SelectItem value="GIPPI">GIPPI</SelectItem>
                <SelectItem value="HEALTHY BITES">HEALTHY BITES</SelectItem>
                <SelectItem value="KATAK BATAK">KATAK BATAK</SelectItem>
                <SelectItem value="NAMKIN">NAMKIN</SelectItem>
                <SelectItem value="NOODLE STICKS">NOODLE STICKS</SelectItem>
                <SelectItem value="NUMYUMS">NUMYUMS</SelectItem>
                <SelectItem value="OLEE">OLEE</SelectItem>
                <SelectItem value="PAPAD">PAPAD</SelectItem>
                <SelectItem value="POP RINGS">POP RINGS</SelectItem>
                <SelectItem value="PUNJABI">PUNJABI</SelectItem>
                <SelectItem value="RUMBLES">RUMBLES</SelectItem>
                <SelectItem value="SCOOPITOS">SCOOPITOS</SelectItem>
                <SelectItem value="SEV">SEV</SelectItem>
                <SelectItem value="SEV MURMURA">SEV MURMURA</SelectItem>
                <SelectItem value="SHING">SHING</SelectItem>
                <SelectItem value="SHING BHUJIA">SHING BHUJIA</SelectItem>
                <SelectItem value="SNACK'EM">SNACK'EM</SelectItem>
                <SelectItem value="WHEELOS">WHEELOS</SelectItem>
                <SelectItem value="YUMSTIX">YUMSTIX</SelectItem>
              </SelectContent>
            </Select>
          </div>

          {/* Search Filter */}
          <div className="space-y-2">
            <Label htmlFor="search-filter">Search Item</Label>
            <div className="relative">
              <Search className="absolute left-3 top-3 h-4 w-4 text-muted-foreground" />
              <Input
                id="search-filter"
                placeholder="Search by item name..."
                value={searchQuery}
                onChange={handleSearchChange}
                className="pl-10 h-11 touch-manipulation"
                data-testid="search-filter"
              />
            </div>
          </div>
        </div>

      </div>

      {/* Stock Data Table */}
      <Card data-testid="stock-table-card">
        <CardHeader>
          <CardTitle className="text-lg flex items-center gap-2 text-black font-bold">
            <Package className="h-5 w-5" />
            Stock Data
          </CardTitle>
          <CardDescription>
            {isLoading ? (
              "Loading stock data..."
            ) : stockData ? (
              `Showing ${stockData.length} items`
            ) : (
              "No stock data available"
            )}
          </CardDescription>
        </CardHeader>
        <CardContent>
          {isLoading ? (
            /* Loading State */
            <div className="space-y-3">
              {Array.from({ length: 5 }).map((_, i) => (
                <div key={i} className="flex space-x-4">
                  <Skeleton className="h-4 w-12" />
                  <Skeleton className="h-4 flex-1" />
                  <Skeleton className="h-4 w-32" />
                  <Skeleton className="h-4 w-20" />
                  <Skeleton className="h-4 w-20" />
                  <Skeleton className="h-4 w-20" />
                  <Skeleton className="h-4 w-20" />
                </div>
              ))}
            </div>
          ) : stockData && stockData.length > 0 ? (
            /* Table with Data */
            <div className="overflow-x-auto rounded-md border">
              <Table data-testid="stock-table">
                <TableHeader>
                  <TableRow>
                    <TableHead className="w-16 text-center sticky left-0 z-20 bg-background border-r shadow-sm">Sr. No.</TableHead>
                    <TableHead className="min-w-[200px] sticky left-16 z-20 bg-background border-r shadow-sm">Item Name</TableHead>
                    <TableHead className="w-36 sticky left-[264px] z-20 bg-background border-r shadow-sm">Category</TableHead>
                    <TableHead className="text-right w-36 min-w-[144px]">Company Remaining</TableHead>
                    <TableHead className="text-right w-28 min-w-[112px]">Purchase</TableHead>
                    <TableHead className="text-right w-28 min-w-[112px]">Sale</TableHead>
                    <TableHead className="text-right w-28 min-w-[112px] font-semibold">Stock</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {stockData.map((item, index) => (
                    <TableRow 
                      key={`${item.sr}-${index}`}
                      data-testid={`stock-row-${item.sr}`}
                      className="hover:bg-muted/50"
                    >
                      <TableCell 
                        className="text-center font-medium sticky left-0 z-10 bg-background border-r shadow-sm py-3"
                        data-testid={`sr-${item.sr}`}
                      >
                        {item.sr}
                      </TableCell>
                      <TableCell 
                        className="font-medium break-words sticky left-16 z-10 bg-background border-r shadow-sm py-3"
                        data-testid={`item-name-${item.sr}`}
                      >
                        {item.itemName}
                      </TableCell>
                      <TableCell 
                        className="sticky left-[264px] z-10 bg-background border-r shadow-sm py-3"
                        data-testid={`category-${item.sr}`}
                      >
                        {item.category ? (
                          <CategoryBadge category={item.category} />
                        ) : (
                          <span className="text-muted-foreground">—</span>
                        )}
                      </TableCell>
                      <TableCell 
                        className="text-right tabular-nums py-3"
                        data-testid={`company-remaining-${item.sr}`}
                      >
                        {editingId === item.id ? (
                          <Input
                            ref={inputRef}
                            type="number"
                            min="0"
                            step="1"
                            value={editValue}
                            onChange={handleEditValueChange}
                            onBlur={() => saveEdit(item)}
                            onKeyDown={(e) => handleKeyDown(e, item)}
                            disabled={updateStockMutation.isPending}
                            className={cn(
                              "w-full text-right border-2 border-blue-500 focus:border-blue-600 tabular-nums h-10 touch-manipulation",
                              updateStockMutation.isPending && "opacity-50 cursor-not-allowed"
                            )}
                            data-testid={`input-company-remaining-${item.sr}`}
                          />
                        ) : (
                          <div
                            onClick={() => startEditing(item)}
                            className="cursor-pointer hover:bg-muted/80 rounded px-3 py-2 -mx-3 -my-2 transition-colors min-h-[44px] flex items-center justify-end touch-manipulation"
                            data-testid={`display-company-remaining-${item.sr}`}
                            title="Click to edit"
                          >
                            {item.companyRemaining.toLocaleString()}
                          </div>
                        )}
                      </TableCell>
                      <TableCell 
                        className="text-right tabular-nums py-3"
                        data-testid={`purchase-${item.sr}`}
                      >
                        {item.purchase.toLocaleString()}
                      </TableCell>
                      <TableCell 
                        className="text-right tabular-nums py-3"
                        data-testid={`sale-${item.sr}`}
                      >
                        {item.sale.toLocaleString()}
                      </TableCell>
                      <TableCell 
                        className={cn(
                          "text-right tabular-nums font-semibold py-3",
                          item.stock > 0 ? "text-green-600" : 
                          item.stock < 0 ? "text-red-600" : 
                          "text-gray-600"
                        )}
                        data-testid={`stock-${item.sr}`}
                      >
                        {item.stock.toLocaleString()}
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </div>
          ) : error ? (
            /* Error State */
            <div className="text-center py-12" data-testid="error-state">
              <Package className="h-12 w-12 text-muted-foreground mx-auto mb-4" />
              <h3 className="text-lg font-semibold text-muted-foreground">
                Failed to load stock data
              </h3>
              <p className="text-sm text-muted-foreground mb-4">
                {error instanceof Error ? error.message : "An unknown error occurred"}
              </p>
              <Button onClick={() => refetch()} variant="outline" data-testid="retry-button">
                Try Again
              </Button>
            </div>
          ) : (
            /* Empty State */
            <div className="text-center py-12" data-testid="empty-state">
              <Package className="h-12 w-12 text-muted-foreground mx-auto mb-4" />
              <h3 className="text-lg font-semibold text-muted-foreground">
                No stock data found
              </h3>
              <p className="text-sm text-muted-foreground mb-4">
                {selectedDate || category || searchQuery 
                  ? "Try adjusting your filters to see results."
                  : "No stock data available at this time."
                }
              </p>
              {(selectedDate || category || searchQuery) && (
                <Button onClick={clearFilters} variant="outline" data-testid="clear-filters-empty">
                  Clear Filters
                </Button>
              )}
            </div>
          )}
        </CardContent>
      </Card>
    </div>
  );
}