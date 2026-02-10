import React from 'react';
import { useQuery } from "@tanstack/react-query";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Checkbox } from "@/components/ui/checkbox";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { cn } from "@/lib/utils";
import { 
  preloadProformaData, 
  getCachedProformaData, 
  processProformaItems,
  preloadAllOperationsData,
  updateProformaSlipItemCache,
  batchLoadProducts
} from "@/lib/data-loader";
import { updateItemWithExtraQuantity, saveExtraQuantity } from "@/utils/extraQuantityHandler";
import { parseDate, isToday, isTomorrow, isYesterday, isDateObject, formatDateForAPI, areDatesEqual } from "@/utils/dateUtils";
import { 
  Table, 
  TableBody, 
  TableCell, 
  TableHead, 
  TableHeader, 
  TableRow,
  TableFooter
} from "@/components/ui/table";
import { 
  Dialog, 
  DialogContent, 
  DialogHeader, 
  DialogTitle, 
  DialogTrigger, 
  DialogFooter,
  DialogDescription,
 } from "@/components/ui/dialog";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  Tabs,
  TabsContent,
  TabsList,
  TabsTrigger,
} from "@/components/ui/tabs";
import { PlantFilter } from "@/components/PlantFilter";
import { DateDisplay } from "@/components/DateDisplay";
import { SingleDateFilter } from "@/components/SingleDateFilter";
import { useSingleDateFilter } from "@/hooks/useSingleDateFilter";
import { SimpleOperationsFilter } from "@/components/SimpleOperationsFilter";
import { OperationSummaryCards } from "@/components/OperationSummaryCards";
import PageHeader from "../components/PageHeader";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import { useState, useEffect, useRef, useMemo, useCallback } from "react";
import { useToast } from "@/hooks/use-toast";
import { format } from "date-fns";
import { createCleanDate, formatDateToYYYYMMDD, isSameDay, parseDateSafe } from "@/utils/dateUtils";
import { apiRequest, queryClient } from "@/lib/queryClient";
import { loadingOperations } from "@shared/schema";
import { getCurrentUserPermissions, isAdminOrSuperAdmin } from "../lib/permissions";
import { BasketCheckbox } from "@/components/BasketCheckbox";
import {
  Command,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
  CommandSeparator,
} from "@/components/ui/command";
import { Truck } from "lucide-react";

import {
  ProformaSlipItem, 
  ProformaSlip, 
  getItemName, 
  getBarcode, 
  preloadProductData, 
  productCache, 
  enhancedOrderLookup 
} from "@/lib/productLoaderHelper";

function getSrNo(item: ProformaSlipItem, idx?: number): number | string | null {
  return item.sr_no !== undefined && item.sr_no !== null 
    ? item.sr_no 
    : item.srNo !== undefined && item.srNo !== null 
      ? item.srNo 
      : idx !== undefined ? idx : null;
}

function getSrNoDisplay(item: ProformaSlipItem): string | null {
  const srNo = getSrNo(item);
  if (srNo === null || srNo === undefined) return null;
  return typeof srNo === 'number' ? srNo.toString() : srNo;
}

type LoadOperationType = typeof loadingOperations.$inferSelect;

const formatDateToDDMMYYYY = (date: Date): string => {
  const day = date.getDate().toString().padStart(2, '0');
  const month = (date.getMonth() + 1).toString().padStart(2, '0');
  const year = date.getFullYear();
  return `${day}/${month}/${year}`;
};

declare global {
  interface Window {
    addItemToSlip: (operationId: number, productId: number, referenceNumber: string, productName: string, sku: string) => void;
    deviceId?: string;
  }
}

export default function LoadOperations() {
  const dateFilter = useSingleDateFilter({
    key: 'loadOperations',
    defaultDate: null,
    storageType: 'local',
    onChange: undefined,
    defaultLocked: false
  });
  
  const [selectedPlant, setSelectedPlant] = useState<string | null>(null);
  const [selectedStatus, setSelectedStatus] = useState<string | null>(null);
  const [searchTerm, setSearchTerm] = useState<string>("");
  const [selectedOperationIds, setSelectedOperationIds] = useState<(number | null)[]>([]);
  const [newOperationStatus, setNewOperationStatus] = useState<string>("");
  const [newVehicleNumber, setNewVehicleNumber] = useState<string>("");
  const [newDriverName, setNewDriverName] = useState<string>("");
  const [isCreateOperationOpen, setIsCreateOperationOpen] = useState<boolean>(false);
  const [isBulkUpdateOpen, setIsBulkUpdateOpen] = useState<boolean>(false);
  const [viewProformaDetails, setViewProformaDetails] = useState<{
    slip: ProformaSlip;
    items: ProformaSlipItem[];
    operation?: { status: string };
  } | null>(null);
  
  const [selectedOperation, setSelectedOperation] = useState<LoadOperationType | null>(null);
  const [activeItemFilter, setActiveItemFilter] = useState<string>("all");
  const [newlyAddedItems, setNewlyAddedItems] = useState<number[]>([]);
  
  const [userInteracting, setUserInteracting] = useState<boolean>(false);
  const [autoRefreshEnabled, setAutoRefreshEnabled] = useState<boolean>(true);
  
  const AUTO_REFRESH_INTERVAL = 30000;
  const MOBILE_REFRESH_INTERVAL = 60000;
  const INTERACTION_TIMEOUT = 5000;
  
  const isMobileDevice = useMemo(() => {
    return /Android|webOS|iPhone|iPad|iPod|BlackBerry|IEMobile|Opera Mini/i.test(navigator.userAgent);
  }, []);
  
  const refetchRef = useRef<(() => void) | null>(null);
  const interactionTimeoutRef = useRef<NodeJS.Timeout | null>(null);
  
  const handleUserInteraction = useCallback(() => {
    setUserInteracting(true);
    
    if (interactionTimeoutRef.current) {
      clearTimeout(interactionTimeoutRef.current);
    }
    
    interactionTimeoutRef.current = setTimeout(() => {
      setUserInteracting(false);
    }, INTERACTION_TIMEOUT);
  }, []);
  
  useEffect(() => {
    const events = ['mousedown', 'mousemove', 'keypress', 'scroll', 'touchstart', 'click'];
    
    events.forEach(event => {
      document.addEventListener(event, handleUserInteraction, true);
    });
    
    return () => {
      events.forEach(event => {
        document.removeEventListener(event, handleUserInteraction, true);
      });
      
      if (interactionTimeoutRef.current) {
        clearTimeout(interactionTimeoutRef.current);
      }
    };
  }, [handleUserInteraction]);
  
  const { toast } = useToast();

  const {
    data: rawData,
    isLoading,
    error,
    refetch: rawRefetch,
  } = useQuery({
    queryKey: ['/api/loading-operations'],
    queryFn: async ({ signal }) => {
      const timeoutId = setTimeout(() => {
        if (signal) {
          (signal as any).abort?.();
        }
      }, isMobileDevice ? 15000 : 10000);
      
      try {
        const response = await fetch('/api/loading-operations', { 
          signal: signal as any
        });
        
        if (!response.ok) {
          throw new Error(`Failed to fetch operations: ${response.status}`);
        }
        
        const data = await response.json();
        
        if (data && Array.isArray(data)) {
          preloadAllOperationsData(data);
        }
        
        return data;
      } catch (error: any) {
        console.error('Error fetching loading operations:', error);
        
        if (isMobileDevice && queryClient.getQueryData(['/api/loading-operations'])) {
          console.log('Using cached data for mobile due to fetch error');
          return queryClient.getQueryData(['/api/loading-operations']);
        }
        throw error;
      } finally {
        clearTimeout(timeoutId);
      }
    },
    refetchInterval: userInteracting ? false : (isMobileDevice ? MOBILE_REFRESH_INTERVAL : AUTO_REFRESH_INTERVAL),
    refetchOnWindowFocus: false,
    staleTime: isMobileDevice ? MOBILE_REFRESH_INTERVAL : AUTO_REFRESH_INTERVAL * 2,
    gcTime: 1000 * 60 * 10,
    placeholderData: (prev) => prev,
  });
  
  useEffect(() => {
    if (rawRefetch) {
      refetchRef.current = rawRefetch;
    }
  }, [rawRefetch]);
  
  const [showAssignedOnly, setShowAssignedOnly] = useState(false);
  
  const preloadAllOperationsData = async (operations: LoadOperationType[]) => {
    try {
      const referenceNumbers = operations
        .map(op => op.referenceNumber)
        .filter((ref): ref is string => ref !== null && ref !== undefined);
      
      const batchSize = 5;
      for (let i = 0; i < referenceNumbers.length; i += batchSize) {
        const batch = referenceNumbers.slice(i, i + batchSize);
        await Promise.all(
          batch.map(ref => preloadProformaData(ref).catch(console.error))
        );
      }
      
      console.log(`Preloaded data for ${referenceNumbers.length} operations`);
    } catch (error) {
      console.error('Error preloading operations data:', error);
    }
  };

  const data = useMemo(() => {
    if (!rawData || !Array.isArray(rawData)) return [];
    return rawData;
  }, [rawData]);

  const currentUser = JSON.parse(localStorage.getItem('currentUser') || '{}');
  const currentUserId = currentUser.id;

  const filteredOperations = useMemo(() => {
    let filtered = data;

    if (selectedPlant) {
      filtered = filtered.filter(operation => operation.plant === selectedPlant);
    }

    if (selectedStatus) {
      filtered = filtered.filter(operation => operation.status === selectedStatus);
    }

    if (searchTerm) {
      const term = searchTerm.toLowerCase();
      filtered = filtered.filter(operation =>
        operation.referenceNumber?.toLowerCase().includes(term) ||
        operation.vehicleNumber?.toLowerCase().includes(term) ||
        operation.driverName?.toLowerCase().includes(term) ||
        operation.partyName?.toLowerCase().includes(term)
      );
    }

    if (dateFilter.date) {
      filtered = filtered.filter(operation => {
        if (!operation.orderDate) return false;
        try {
          const operationDate = parseDate(operation.orderDate.toString());
          return isSameDay(operationDate!, dateFilter.date!);
        } catch (error) {
          console.error('Error parsing operation date:', error);
          return false;
        }
      });
    }

    if (showAssignedOnly && currentUserId) {
      filtered = filtered.filter(operation => 
        (operation as any).assignedToId === currentUserId
      );
    }

    return filtered;
  }, [data, selectedPlant, selectedStatus, searchTerm, dateFilter.date, showAssignedOnly, currentUserId]);

  const formatOrderDate = (orderDate: string | Date | null | undefined): string => {
    if (!orderDate) return '';
    
    try {
      let dateObj: Date;
      
      if (orderDate instanceof Date) {
        dateObj = orderDate;
      } else if (typeof orderDate === 'string') {
        if (orderDate.includes('T') || orderDate.includes('Z')) {
          dateObj = new Date(orderDate);
        } else if (orderDate.includes('/')) {
          const parts = orderDate.split('/').map(Number);
          if (parts.length === 3) {
            dateObj = new Date(parts[2], parts[1] - 1, parts[0]);
          } else {
            dateObj = new Date(orderDate);
          }
        } else {
          dateObj = new Date(orderDate);
        }
      } else {
        return '';
      }
      
      if (isNaN(dateObj.getTime())) {
        return '';
      }
      
      return formatDateToDDMMYYYY(dateObj);
    } catch (error) {
      console.error('Error formatting order date:', error);
      return '';
    }
  };

  const handleManualRefresh = useCallback(() => {
    if (refetchRef.current) {
      console.log('Manual refresh triggered');
      refetchRef.current();
      toast({
        title: "Refreshing data",
        description: "Loading latest operations...",
      });
    }
  }, [toast]);

  const handleSelectAll = () => {
    if (selectedOperationIds.length === filteredOperations.length) {
      setSelectedOperationIds([]);
    } else {
      setSelectedOperationIds(filteredOperations.map(op => op.id));
    }
  };

  const handleOperationSelect = (operationId: number) => {
    setSelectedOperationIds(prev => {
      if (prev.includes(operationId)) {
        return prev.filter(id => id !== operationId);
      } else {
        return [...prev, operationId];
      }
    });
  };

  const handleCreateOperation = async (slip: ProformaSlip) => {
    if (!newOperationStatus || !newVehicleNumber) {
      toast({
        title: "Error",
        description: "Please fill in all required fields",
        variant: "destructive",
      });
      return;
    }

    try {
      const orderDateValue = slip.orderDate ? formatDateForAPI(slip.orderDate.toString()) : null;
      
      const newOperation = {
        status: newOperationStatus,
        referenceNumber: slip.orderNumber || "",
        vehicleNumber: newVehicleNumber,
        driverName: newDriverName || "",
        createdById: currentUser.id,
        orderDate: orderDateValue,
        plant: (slip as any).plant || "",
        partyName: (slip as any).partyName || "",
      };

      const response = await apiRequest("POST", "/api/loading-operations", newOperation);
      
      if (response.ok) {
        toast({
          title: "Success",
          description: "Operation created successfully",
        });
        
        if (refetchRef.current) {
          refetchRef.current();
        }
        
        setNewOperationStatus("");
        setNewVehicleNumber("");
        setNewDriverName("");
        setIsCreateOperationOpen(false);
        setViewProformaDetails(null);
      }
    } catch (error) {
      console.error("Error creating operation:", error);
      toast({
        title: "Error",
        description: "Failed to create operation",
        variant: "destructive",
      });
    }
  };

  const handleBulkStatusUpdate = async () => {
    if (!newOperationStatus || selectedOperationIds.length === 0) {
      toast({
        title: "Error",
        description: "Please select operations and status",
        variant: "destructive",
      });
      return;
    }

    try {
      const operationIds: number[] = selectedOperationIds.filter((id): id is number => id !== null);
      
      const response = await apiRequest("PATCH", "/api/loading-operations/bulk-update", {
        operationIds,
        status: newOperationStatus,
      });

      if (response.ok) {
        toast({
          title: "Success",
          description: `Updated ${operationIds.length} operations`,
        });
        
        if (refetchRef.current) {
          refetchRef.current();
        }
        
        setSelectedOperationIds([]);
        setNewOperationStatus("");
        setIsBulkUpdateOpen(false);
      }
    } catch (error) {
      console.error("Error updating operations:", error);
      toast({
        title: "Error",
        description: "Failed to update operations",
        variant: "destructive",
      });
    }
  };

  type BadgeVariant = "default" | "destructive" | "outline" | "success" | "secondary" | "warning";
  
  const getBadgeVariant = (status: string | null): BadgeVariant => {
    if (!status) return "outline";
    
    switch (status.toLowerCase()) {
      case "loading":
        return "warning";
      case "ready≈desp":
      case "ready~desp":
        return "success";
      case "in transit":
        return "secondary";
      case "completed":
        return "success";
      case "cancelled":
        return "destructive";
      default:
        return "default";
    }
  };

  const checkLoadingItem = async (
    item: ProformaSlipItem, 
    isChecked: boolean, 
    operationId: number | null, 
    referenceNumber: string | null
  ) => {
    try {
      const updatedItem: ProformaSlipItem = { ...item, loaded: isChecked };
      
      console.log('Checking loading item:', {
        itemId: item.id,
        loaded: isChecked,
        operationId,
        referenceNumber
      });

      setViewProformaDetails(prev => {
        if (!prev) return prev;
        
        const updatedItems = prev.items.map((i: ProformaSlipItem) => 
          i.id === item.id ? updatedItem : i
        );
        
        return {
          ...prev,
          items: updatedItems
        };
      });

      const response = await apiRequest("PATCH", `/api/proforma-slip-items/${item.id}`, {
        loaded: isChecked,
        operationId: operationId,
        referenceNumber: referenceNumber
      });

      if (!response.ok) {
        throw new Error('Failed to update item');
      }

      if (referenceNumber) {
        updateProformaSlipItemCache(referenceNumber, item.id, updatedItem);
      }

      toast({
        title: isChecked ? "Item loaded" : "Item unloaded",
        description: `${getItemName(item)} ${isChecked ? 'marked as loaded' : 'marked as not loaded'}`,
      });

    } catch (error) {
      console.error('Error updating loading item:', error);
      
      setViewProformaDetails(prev => {
        if (!prev) return prev;
        
        const revertedItems = prev.items.map((i: ProformaSlipItem) => 
          i.id === item.id ? { ...item, loaded: !isChecked } : i
        );
        
        return {
          ...prev,
          items: revertedItems
        };
      });

      toast({
        title: "Error",
        description: "Failed to update item status",
        variant: "destructive",
      });
    }
  };

  const viewProformaDetailsForOperation = async (operation: LoadOperationType) => {
    if (!operation.referenceNumber) {
      toast({
        title: "Error",
        description: "No reference number found for this operation",
        variant: "destructive",
      });
      return;
    }

    setSelectedOperation(operation);

    try {
      const cachedData = getCachedProformaData(operation.referenceNumber);
      if (cachedData) {
        console.log('Using cached proforma data');
        
        const processedData = processProformaItems(cachedData.items);
        
        try {
          const operationItemsResponse = await fetch(`/api/loading-operations/${operation.id}/items`);
          if (operationItemsResponse.ok) {
            const operationItems = await operationItemsResponse.json();
            console.log('Found operation items:', operationItems.length);
            
            const enhancedItems = processedData.items.map((item: ProformaSlipItem, index: number) => {
              const operationItem = operationItems.find((oi: any) => oi.productId === item.productId);
              if (operationItem) {
                return {
                  ...item,
                  loaded: operationItem.loaded || false,
                  operationItemId: operationItem.id
                };
              }
              return item;
            });
            
            setViewProformaDetails({
              slip: processedData.slip,
              items: enhancedItems,
              operation: { status: operation.status || "" }
            });
          } else {
            setViewProformaDetails({
              slip: processedData.slip,
              items: processedData.items,
              operation: { status: operation.status || "" }
            });
          }
        } catch (itemsError) {
          console.warn('Could not fetch operation items:', itemsError);
          setViewProformaDetails({
            slip: processedData.slip,
            items: processedData.items,
            operation: { status: operation.status || "" }
          });
        }
        
        return;
      }

      console.log('Fetching fresh proforma data');
      const response = await fetch(`/api/proforma-slips/order/${operation.referenceNumber}`);
      
      if (!response.ok) {
        throw new Error(`HTTP error! status: ${response.status}`);
      }
      
      const details = await response.json();
      console.log('Raw proforma details:', details);

      if (!details || !details.slip) {
        throw new Error('Invalid proforma data structure');
      }

      const storedOriginalQuantities = JSON.parse(
        localStorage.getItem(`originalQuantities_${operation.referenceNumber}`) || '{}'
      );

      const enhanceProformaData = (
        data: any,
        currentData: any,
        storedOriginalQuantities: Record<string, number>,
        newlyAddedItems: number[]
      ) => {
        const enhancedItems = data.items.map((item: ProformaSlipItem) => ({
          ...item,
          itemName: item.itemName || item.item_name || 'Unknown Item',
          barcode: item.barcode || 'N/A',
          srNo: item.srNo || item.sr_no || null,
          srNoDisplay: item.srNoDisplay || item.sr_no_display || null,
          originalQuantity: storedOriginalQuantities[item.id] || item.quantity,
          isNewlyAdded: newlyAddedItems.includes(item.id),
          loaded: currentData?.items?.find((ci: ProformaSlipItem) => ci.id === item.id)?.loaded || item.loaded || false
        }));

        return {
          slip: data.slip,
          items: enhancedItems,
          operation: { status: operation.status || "" }
        };
      };

      if (details.slip.orderDate) {
        try {
          let orderDateObj: Date;
          
          if (typeof details.slip.orderDate === 'string') {
            if (details.slip.orderDate.includes('T') || details.slip.orderDate.includes('Z')) {
              orderDateObj = new Date(details.slip.orderDate);
            } else if (details.slip.orderDate.includes('/')) {
              const [day, month, year] = details.slip.orderDate.split('/').map(Number);
              orderDateObj = new Date(year, month - 1, day);
            } else {
              orderDateObj = new Date(details.slip.orderDate);
            }
          } else {
            orderDateObj = new Date(details.slip.orderDate);
          }
          
          if (!isNaN(orderDateObj.getTime())) {
            details.slip.orderDate = orderDateObj;
          }
        } catch (dateError) {
          console.error('Error parsing order date:', dateError);
        }
      }

      const processedData = processProformaItems(details.items);

      const enhancedData = enhanceProformaData(
        processedData,
        viewProformaDetails,
        storedOriginalQuantities,
        newlyAddedItems
      );

      setViewProformaDetails(enhancedData);

      try {
        const operationItemsResponse = await fetch(`/api/loading-operations/${operation.id}/items`);
        if (operationItemsResponse.ok) {
          const operationItems = await operationItemsResponse.json();
          console.log('Found operation items:', operationItems.length);
          
          const enhancedItemsWithOperation = enhancedData.items.map((item: ProformaSlipItem) => {
            const operationItem = operationItems.find((oi: any) => oi.productId === item.productId);
            if (operationItem) {
              return {
                ...item,
                loaded: operationItem.loaded || false,
                operationItemId: operationItem.id,
                loadedQuantity: operationItem.loadedQuantity || 0
              };
            }
            return item;
          });
          
          setViewProformaDetails({
            ...enhancedData,
            items: enhancedItemsWithOperation
          });
        }
      } catch (error) {
        console.warn('Could not fetch operation items in background:', error);
      }

    } catch (error) {
      console.error('Error fetching proforma details:', error);
      
      let errorMessage = 'Failed to load proforma details';
      if (error instanceof Error) {
        if (error.message.includes('404')) {
          errorMessage = 'Proforma slip not found';
        } else if (error.message.includes('500')) {
          errorMessage = 'Server error loading data';
        } else {
          errorMessage = error.message;
        }
      }
      
      toast({
        title: "Error",
        description: errorMessage,
        variant: "destructive",
      });
    }
  };

  const filterItemsByType = (items: ProformaSlipItem[], filterType: string, orderNumber: string): ProformaSlipItem[] => {
    if (filterType === "all") return items;
    
    if (filterType === "loaded") {
      return items.filter(item => item.loaded);
    }
    
    if (filterType === "unloaded") {
      return items.filter(item => !item.loaded);
    }
    
    if (filterType === "extra") {
      return items.filter(item => {
        const remainingQty = calculateItemRemainingQuantity(item, orderNumber);
        return remainingQty < 0;
      });
    }
    
    return items;
  };

  const calculateItemRemainingQuantity = (item: ProformaSlipItem, referenceNumber: string | undefined | null) => {
    const originalQty = item.originalQuantity || item.quantity || 0;
    const currentQty = item.quantity || 0;
    return originalQty - currentQty;
  };

  const calculateItemExtraQuantity = (item: ProformaSlipItem, referenceNumber: string | undefined | null) => {
    const remainingQty = calculateItemRemainingQuantity(item, referenceNumber);
    return Math.abs(Math.min(0, remainingQty));
  };

  const closeProformaDetails = () => {
    setViewProformaDetails(null);
    setSelectedOperation(null);
    setActiveItemFilter("all");
  };

  const [isFullScreen, setIsFullScreen] = useState(false);
  const [selectedItems, setSelectedItems] = useState<number[]>([]);

  const toggleItemSelection = (itemId: number) => {
    setSelectedItems(prev => 
      prev.includes(itemId) 
        ? prev.filter(id => id !== itemId)
        : [...prev, itemId]
    );
  };

  const toggleAllItems = () => {
    if (!viewProformaDetails) return;
    
    const filteredItems = filterItemsByType(
      viewProformaDetails.items, 
      activeItemFilter, 
      viewProformaDetails.slip.orderNumber || ""
    );
    
    const allSelected = filteredItems.every(item => selectedItems.includes(item.id));
    
    if (allSelected) {
      setSelectedItems(prev => prev.filter(id => 
        !filteredItems.some(item => item.id === id)
      ));
    } else {
      const newSelections = filteredItems.map(item => item.id);
      setSelectedItems(prev => [...Array.from(new Set([...prev, ...newSelections]))]);
    }
  };

  const handleBatchLoading = async (isLoaded: boolean) => {
    if (!viewProformaDetails || !selectedOperation || selectedItems.length === 0) return;
    
    try {
      const itemsToUpdate = viewProformaDetails.items.filter(item => 
        selectedItems.includes(item.id)
      );

      await Promise.all(
        itemsToUpdate.map(item => 
          checkLoadingItem(item, isLoaded, selectedOperation.id, selectedOperation.referenceNumber)
        )
      );

      setSelectedItems([]);
      
      toast({
        title: "Success",
        description: `${itemsToUpdate.length} items ${isLoaded ? 'loaded' : 'unloaded'}`,
      });

    } catch (error) {
      console.error('Error in batch loading:', error);
      toast({
        title: "Error",
        description: "Failed to update some items",
        variant: "destructive",
      });
    }
  };

  const scrollToMobileCard = (operationId: number) => {
    setTimeout(() => {
      const mobileCard = document.getElementById(`mobile-card-${operationId}`);
      if (mobileCard) {
        mobileCard.scrollIntoView({ behavior: 'smooth', block: 'center' });
        mobileCard.style.boxShadow = '0 0 10px rgba(59, 130, 246, 0.5)';
        setTimeout(() => {
          if (mobileCard) {
            mobileCard.style.boxShadow = '';
          }
        }, 2000);
      }
    }, 100);
  };

  const scrollToDesktopRow = (operationId: number) => {
    setTimeout(() => {
      const tableRow = document.querySelector(`[data-operation-id="${operationId}"]`);
      if (tableRow) {
        tableRow.scrollIntoView({ behavior: 'smooth', block: 'center' });
        (tableRow as HTMLElement).style.backgroundColor = 'rgba(59, 130, 246, 0.1)';
        setTimeout(() => {
          if (tableRow) {
            (tableRow as HTMLElement).style.backgroundColor = '';
          }
        }, 2000);
      }
    }, 100);
  };

  const scrollToItemsSection = () => {
    setTimeout(() => {
      const isMobile = window.innerWidth < 768;
      
      if (isMobile) {
        const mobileItemsContainer = document.getElementById('mobile-proforma-items');
        if (mobileItemsContainer) {
          const containerTop = mobileItemsContainer.getBoundingClientRect().top + window.pageYOffset;
          window.scrollTo({
            top: containerTop - 80,
            behavior: 'smooth'
          });
        }
      } else {
        const desktopItemsContainer = document.querySelector('.proforma-items-container');
        if (desktopItemsContainer) {
          desktopItemsContainer.scrollIntoView({ behavior: 'smooth', block: 'start' });
          const dialogContent = desktopItemsContainer.closest('.overflow-y-auto');
          if (dialogContent && desktopItemsContainer.parentElement) {
            dialogContent.scrollTo({
              top: desktopItemsContainer.getBoundingClientRect().top - 100,
              behavior: 'smooth'
            });
          }
        }
      }
    }, 300);
  };

  useEffect(() => {
    if (viewProformaDetails && selectedOperation) {
      scrollToItemsSection();
    }
  }, [viewProformaDetails, selectedOperation]);

  const handleCreateOperationFromProforma = async () => {
    if (!viewProformaDetails) return;
    
    const slip = viewProformaDetails.slip;
    const vehicleNumber = (slip as any).vehicleNumber || newVehicleNumber;
    const driverName = (slip as any).driverName || newDriverName;
    
    if (!newOperationStatus || !vehicleNumber) {
      toast({
        title: "Error", 
        description: "Status and Vehicle Number are required",
        variant: "destructive",
      });
      return;
    }

    try {
      const orderDateValue = slip.orderDate ? formatDateForAPI(slip.orderDate.toString()) : null;
      
      const newOperation = {
        status: newOperationStatus,
        referenceNumber: slip.orderNumber || "",
        vehicleNumber: vehicleNumber,
        driverName: driverName || "",
        createdById: currentUser.id,
        orderDate: orderDateValue,
        plant: (slip as any).plant || "",
        partyName: (slip as any).partyName || "",
      };

      const response = await apiRequest("POST", "/api/loading-operations", newOperation);
      
      if (response.ok) {
        const createdOperation = await response.json();
        
        toast({
          title: "Success",
          description: "Operation created successfully",
        });
        
        if (refetchRef.current) {
          refetchRef.current();
        }
        
        setNewOperationStatus("");
        setNewVehicleNumber("");
        setNewDriverName("");
        setIsCreateOperationOpen(false);
        
        setSelectedOperation(createdOperation);
        
        setViewProformaDetails(prev => prev ? {
          ...prev,
          operation: { status: createdOperation.status }
        } : null);
      }
    } catch (error) {
      console.error("Error creating operation:", error);
      toast({
        title: "Error",
        description: "Failed to create operation",
        variant: "destructive",
      });
    }
  };

  const handleOperationLookup = async (referenceNumber: string) => {
    if (!referenceNumber.trim()) {
      toast({
        title: "Error",
        description: "Please enter a reference number",
        variant: "destructive",
      });
      return;
    }

    try {
      const operation = data.find(op => op.referenceNumber === referenceNumber.trim());
      
      if (operation) {
        await viewProformaDetailsForOperation(operation);
        scrollToMobileCard(operation.id);
        return;
      }

      const response = await fetch(`/api/proforma-slips/order/${referenceNumber.trim()}`);
      
      if (!response.ok) {
        if (response.status === 404) {
          toast({
            title: "Not Found",
            description: "No proforma slip found with this reference number",
            variant: "destructive",
          });
        } else {
          throw new Error(`HTTP error! status: ${response.status}`);
        }
        return;
      }
      
      const details = await response.json();
      
      if (!details || !details.slip) {
        toast({
          title: "Error",
          description: "Invalid proforma data",
          variant: "destructive",
        });
        return;
      }

      const processedData = processProformaItems(details.items);
      
      setViewProformaDetails({
        slip: details.slip,
        items: processedData.items,
        operation: undefined
      });
      
      setIsCreateOperationOpen(true);
      
    } catch (error) {
      console.error('Error looking up operation:', error);
      toast({
        title: "Error",
        description: "Failed to lookup reference number",
        variant: "destructive",
      });
    }
  };

  const [lookupRef, setLookupRef] = useState("");

  const enhancedOrderLookup = async (referenceNumber: string) => {
    if (!referenceNumber.trim()) return;

    try {
      const existingOperation = data.find(op => 
        op.referenceNumber?.toLowerCase().trim() === referenceNumber.toLowerCase().trim()
      );

      if (existingOperation) {
        await viewProformaDetailsForOperation(existingOperation);
        return;
      }

      const response = await fetch(`/api/proforma-slips/order/${referenceNumber.trim()}`);
      
      if (response.ok) {
        const details = await response.json();
        const processedData = processProformaItems(details.items);
        
        setViewProformaDetails({
          slip: details.slip,
          items: processedData.items,
          operation: undefined
        });
        
        setIsCreateOperationOpen(true);
      } else {
        throw new Error('Proforma not found');
      }
      
    } catch (error) {
      console.error('Enhanced order lookup error:', error);
      toast({
        title: "Error",
        description: "Reference number not found",
        variant: "destructive",
      });
    }
  };

  const refreshStatus = useMemo(() => {
    if (!autoRefreshEnabled) return "Disabled";
    if (userInteracting) return "Paused (User Active)";
    return `Every ${isMobileDevice ? '60' : '30'}s`;
  }, [autoRefreshEnabled, userInteracting, isMobileDevice]);

  const uniquePlants = useMemo(() => {
    const plants = data.map(op => op.plant).filter(Boolean);
    return Array.from(new Set(plants));
  }, [data]);

  const uniqueStatuses = useMemo(() => {
    const statuses = data.map(op => op.status).filter(Boolean);
    return Array.from(new Set(statuses));
  }, [data]);

  if (isLoading && !data.length) {
    return (
      <div className="flex items-center justify-center min-h-[400px]">
        <div className="text-center">
          <div className="animate-spin rounded-full h-12 w-12 border-b-2 border-primary mx-auto mb-4"></div>
          <p className="text-muted-foreground">Loading operations...</p>
        </div>
      </div>
    );
  }

  if (error && !data.length) {
    return (
      <div className="flex items-center justify-center min-h-[400px]">
        <div className="text-center">
          <p className="text-destructive mb-4">Failed to load operations</p>
          <Button onClick={handleManualRefresh} variant="outline">
            Retry
          </Button>
        </div>
      </div>
    );
  }

  const getFilteredItemsCount = (filterType: string) => {
    if (!viewProformaDetails) return 0;
    return filterItemsByType(viewProformaDetails.items, filterType, viewProformaDetails.slip.orderNumber || "").length;
  };

  const canCreateOperations = () => {
    const permissions = getCurrentUserPermissions();
    return isAdminOrSuperAdmin(permissions);
  };

  const handleStatusUpdate = async (operationId: number, newStatus: string) => {
    try {
      const response = await apiRequest("PATCH", `/api/loading-operations/${operationId}`, {
        status: newStatus
      });

      if (response.ok) {
        toast({
          title: "Success",
          description: "Operation status updated",
        });
        
        if (refetchRef.current) {
          refetchRef.current();
        }

        if (selectedOperation?.id === operationId) {
          setSelectedOperation(prev => prev ? { ...prev, status: newStatus } : null);
          setViewProformaDetails(prev => prev ? {
            ...prev,
            operation: { status: newStatus }
          } : null);
        }
      }
    } catch (error) {
      console.error("Error updating status:", error);
      toast({
        title: "Error",
        description: "Failed to update status",
        variant: "destructive",
      });
    }
  };

  const getItemsSummary = () => {
    if (!viewProformaDetails) return { total: 0, loaded: 0, remaining: 0 };
    
    const total = viewProformaDetails.items.length;
    const loaded = viewProformaDetails.items.filter(item => item.loaded).length;
    const remaining = total - loaded;
    
    return { total, loaded, remaining };
  };

  const renderProformaDetailsContent = () => {
    if (!viewProformaDetails) return null;

    const { slip, items, operation } = viewProformaDetails;
    const itemsSummary = getItemsSummary();
    const filteredItems = filterItemsByType(items, activeItemFilter, slip.orderNumber || "");

    return (
      <div className="space-y-6">
        <div className="bg-muted/50 p-4 rounded-lg">
          <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
            <div>
              <h3 className="font-semibold text-lg mb-2">{slip.orderNumber}</h3>
              <div className="space-y-1 text-sm">
                <p><span className="font-medium">Party:</span> {(slip as any).partyName || 'N/A'}</p>
                <p><span className="font-medium">Vehicle:</span> {(slip as any).vehicleNumber || 'N/A'}</p>
                <p><span className="font-medium">Driver:</span> {(slip as any).driverName || 'N/A'}</p>
              </div>
            </div>
            <div>
              <div className="space-y-1 text-sm">
                <p><span className="font-medium">Plant:</span> {(slip as any).plant || 'N/A'}</p>
                <p><span className="font-medium">Date:</span> {formatOrderDate(slip.orderDate)}</p>
                {operation && (
                  <p><span className="font-medium">Status:</span> 
                    <Badge variant={getBadgeVariant(operation.status)} className="ml-2">
                      {operation.status}
                    </Badge>
                  </p>
                )}
              </div>
            </div>
          </div>
        </div>

        <div className="grid grid-cols-3 gap-4">
          <div className="text-center p-3 bg-blue-50 rounded-lg">
            <div className="text-2xl font-bold text-blue-600">{itemsSummary.total}</div>
            <div className="text-sm text-blue-600">Total Items</div>
          </div>
          <div className="text-center p-3 bg-green-50 rounded-lg">
            <div className="text-2xl font-bold text-green-600">{itemsSummary.loaded}</div>
            <div className="text-sm text-green-600">Loaded</div>
          </div>
          <div className="text-center p-3 bg-yellow-50 rounded-lg">
            <div className="text-2xl font-bold text-yellow-600">{itemsSummary.remaining}</div>
            <div className="text-sm text-yellow-600">Remaining</div>
          </div>
        </div>

        <Tabs value={activeItemFilter} onValueChange={setActiveItemFilter}>
          <TabsList className="w-full grid grid-cols-4">
            <TabsTrigger value="all">All ({getFilteredItemsCount("all")})</TabsTrigger>
            <TabsTrigger value="loaded">Loaded ({getFilteredItemsCount("loaded")})</TabsTrigger>
            <TabsTrigger value="unloaded">Pending ({getFilteredItemsCount("unloaded")})</TabsTrigger>
            <TabsTrigger value="extra">Extra ({getFilteredItemsCount("extra")})</TabsTrigger>
          </TabsList>
        </Tabs>

        {selectedItems.length > 0 && (
          <div className="flex gap-2 p-3 bg-blue-50 rounded-lg">
            <span className="text-sm font-medium">{selectedItems.length} items selected</span>
            <div className="flex gap-2 ml-auto">
              <Button size="sm" onClick={() => handleBatchLoading(true)} className="bg-green-600 hover:bg-green-700">
                Load Selected
              </Button>
              <Button size="sm" variant="outline" onClick={() => handleBatchLoading(false)}>
                Unload Selected
              </Button>
              <Button size="sm" variant="ghost" onClick={() => setSelectedItems([])}>
                Clear
              </Button>
            </div>
          </div>
        )}

        <div className="proforma-items-container">
          {filteredItems.length === 0 ? (
            <div className="text-center py-8 text-muted-foreground">
              No items found for the selected filter
            </div>
          ) : (
            <div className="space-y-2">
              <div className="flex items-center gap-2 p-2 bg-muted/30 rounded">
                <Checkbox
                  checked={filteredItems.length > 0 && filteredItems.every(item => selectedItems.includes(item.id))}
                  onCheckedChange={() => toggleAllItems()}
                />
                <span className="text-sm font-medium">Select All</span>
              </div>

              {filteredItems.map((item: ProformaSlipItem, idx) => {
                const remainingQty = calculateItemRemainingQuantity(item, slip.orderNumber);
                const extraQty = calculateItemExtraQuantity(item, slip.orderNumber);
                const srNoDisplay = getSrNoDisplay(item);

                return (
                  <div key={item.id} className={cn(
                    "flex items-center gap-3 p-3 border rounded-lg transition-colors",
                    item.loaded ? "bg-green-50 border-green-200" : "bg-white",
                    selectedItems.includes(item.id) ? "ring-2 ring-blue-500" : ""
                  )}>
                    <Checkbox
                      checked={selectedItems.includes(item.id)}
                      onCheckedChange={() => toggleItemSelection(item.id)}
                    />
                    
                    <BasketCheckbox
                      checked={Boolean(item.loaded)}
                      onCheckedChange={(checked) => 
                        checkLoadingItem(item, Boolean(checked), selectedOperation?.id || null, selectedOperation?.referenceNumber || null)
                      }
                    />

                    <div className="flex-1 min-w-0">
                      <div className="flex items-center gap-2 mb-1">
                        {srNoDisplay && (
                          <Badge variant="outline" className="text-xs">
                            {srNoDisplay}
                          </Badge>
                        )}
                        <span className="font-medium text-sm truncate">
                          {getItemName(item)}
                        </span>
                      </div>
                      
                      <div className="text-xs text-muted-foreground space-y-1">
                        <div>Qty: {item.quantity || 0}</div>
                        {getBarcode(item) && (
                          <div>Barcode: {getBarcode(item)}</div>
                        )}
                        {extraQty > 0 && (
                          <div className="text-orange-600 font-medium">
                            Extra: +{extraQty}
                          </div>
                        )}
                      </div>
                    </div>

                    {item.loaded && (
                      <Badge variant="success" className="text-xs">
                        Loaded
                      </Badge>
                    )}
                  </div>
                );
              })}
            </div>
          )}
        </div>

        {selectedOperation && operation && (
          <div className="space-y-3 p-4 bg-muted/30 rounded-lg">
            <Label className="text-sm font-medium">Update Operation Status</Label>
            <div className="flex gap-2">
              <Select 
                value={operation.status} 
                onValueChange={(value) => handleStatusUpdate(selectedOperation.id, value)}
              >
                <SelectTrigger className="flex-1">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="LOADING">LOADING</SelectItem>
                  <SelectItem value="READY≈DESP">READY≈DESP</SelectItem>
                  <SelectItem value="IN TRANSIT">IN TRANSIT</SelectItem>
                  <SelectItem value="COMPLETED">COMPLETED</SelectItem>
                  <SelectItem value="CANCELLED">CANCELLED</SelectItem>
                </SelectContent>
              </Select>
            </div>
          </div>
        )}
      </div>
    );
  };

  return (
    <div className="space-y-6 p-4 md:p-6">
      <PageHeader 
        icon={Truck}
        title="GJ Operations"
        description="Manage loading operations and track vehicle dispatch status"
      >
        <div className="flex items-center gap-2">
          <Button
            onClick={handleManualRefresh}
            variant="outline"
            size="sm"
            disabled={isLoading}
          >
            {isLoading ? "Loading..." : "Refresh"}
          </Button>
          
          <div className="text-xs text-muted-foreground">
            Auto-refresh: {refreshStatus}
          </div>
        </div>
      </PageHeader>

      <Card>
        <CardHeader>
          <CardTitle className="text-lg">Quick Order Lookup</CardTitle>
        </CardHeader>
        <CardContent>
          <div className="flex gap-2">
            <Input
              placeholder="Enter order/reference number..."
              value={lookupRef}
              onChange={(e) => setLookupRef(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter') {
                  enhancedOrderLookup(lookupRef);
                  setLookupRef("");
                }
              }}
              className="flex-1"
            />
            <Button
              onClick={() => {
                enhancedOrderLookup(lookupRef);
                setLookupRef("");
              }}
              disabled={!lookupRef.trim()}
            >
              Lookup
            </Button>
          </div>
        </CardContent>
      </Card>

      <OperationSummaryCards 
        data={filteredOperations} 
        isLoading={isLoading}
        onStatusClick={(status: string) => setSelectedStatus(status === selectedStatus ? null : status)}
        selectedStatus={selectedStatus}
      />

      <Card>
        <CardContent className="p-4">
          <div className="flex flex-col md:flex-row gap-4 items-start md:items-end">
            <div className="flex-1 grid grid-cols-1 md:grid-cols-4 gap-4">
              <PlantFilter
                selectedPlant={selectedPlant}
                onPlantChange={(plants: string[]) => setSelectedPlant(plants[0] || null)}
                plants={uniquePlants}
              />
              
              <SimpleOperationsFilter
                statuses={uniqueStatuses}
                selectedStatuses={selectedStatus ? [selectedStatus] : []}
                onStatusChange={(statuses: string[]) => setSelectedStatus(statuses[0] || null)}
              />
              
              <SingleDateFilter
                selectedDate={dateFilter.date}
                onDateChange={dateFilter.setDate}
              />
              
              <div className="space-y-2">
                <Label>Search</Label>
                <Input
                  placeholder="Search operations..."
                  value={searchTerm}
                  onChange={(e) => setSearchTerm(e.target.value)}
                />
              </div>
            </div>
            
            <div className="flex items-center gap-4 w-full md:w-auto">
              <div className="flex items-center space-x-2">
                <Switch
                  id="assigned-filter"
                  checked={showAssignedOnly}
                  onCheckedChange={setShowAssignedOnly}
                />
                <Label htmlFor="assigned-filter" className="text-sm">
                  My Operations
                </Label>
              </div>
              
              <div className="flex items-center space-x-2">
                <Switch
                  id="auto-refresh"
                  checked={autoRefreshEnabled}
                  onCheckedChange={setAutoRefreshEnabled}
                />
                <Label htmlFor="auto-refresh" className="text-sm">
                  Auto-refresh
                </Label>
              </div>
            </div>
          </div>
        </CardContent>
      </Card>

      {selectedOperationIds.length > 0 && (
        <Card>
          <CardContent className="p-4">
            <div className="flex items-center justify-between">
              <span className="text-sm font-medium">
                {selectedOperationIds.length} operations selected
              </span>
              <div className="flex gap-2">
                <Dialog open={isBulkUpdateOpen} onOpenChange={setIsBulkUpdateOpen}>
                  <DialogTrigger asChild>
                    <Button variant="outline" size="sm">
                      Bulk Update Status
                    </Button>
                  </DialogTrigger>
                  <DialogContent>
                    <DialogHeader>
                      <DialogTitle>Update Selected Operations</DialogTitle>
                      <DialogDescription>
                        Change status for {selectedOperationIds.length} selected operations
                      </DialogDescription>
                    </DialogHeader>
                    <div className="space-y-4">
                      <div>
                        <Label>New Status</Label>
                        <Select value={newOperationStatus} onValueChange={setNewOperationStatus}>
                          <SelectTrigger>
                            <SelectValue placeholder="Select status" />
                          </SelectTrigger>
                          <SelectContent>
                            <SelectItem value="LOADING">LOADING</SelectItem>
                            <SelectItem value="READY≈DESP">READY≈DESP</SelectItem>
                            <SelectItem value="IN TRANSIT">IN TRANSIT</SelectItem>
                            <SelectItem value="COMPLETED">COMPLETED</SelectItem>
                            <SelectItem value="CANCELLED">CANCELLED</SelectItem>
                          </SelectContent>
                        </Select>
                      </div>
                    </div>
                    <DialogFooter>
                      <Button variant="outline" onClick={() => setIsBulkUpdateOpen(false)}>
                        Cancel
                      </Button>
                      <Button onClick={handleBulkStatusUpdate}>
                        Update Operations
                      </Button>
                    </DialogFooter>
                  </DialogContent>
                </Dialog>
                
                <Button 
                  variant="ghost" 
                  size="sm"
                  onClick={() => setSelectedOperationIds([])}
                >
                  Clear Selection
                </Button>
              </div>
            </div>
          </CardContent>
        </Card>
      )}

      <div className="hidden md:block">
        <Card>
          <CardContent className="p-0">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead className="w-12">
                    <Checkbox
                      checked={
                        filteredOperations.length > 0 && 
                        selectedOperationIds.length === filteredOperations.length
                      }
                      onCheckedChange={handleSelectAll}
                    />
                  </TableHead>
                  <TableHead>Reference</TableHead>
                  <TableHead>Party</TableHead>
                  <TableHead>Vehicle</TableHead>
                  <TableHead>Driver</TableHead>
                  <TableHead>Plant</TableHead>
                  <TableHead>Date</TableHead>
                  <TableHead>Status</TableHead>
                  <TableHead>Actions</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {filteredOperations.map((operation) => (
                  <TableRow 
                    key={operation.id}
                    data-operation-id={operation.id}
                    className={cn(
                      "cursor-pointer hover:bg-muted/50",
                      selectedOperationIds.includes(operation.id) && "bg-blue-50"
                    )}
                  >
                    <TableCell>
                      <Checkbox
                        checked={selectedOperationIds.includes(operation.id)}
                        onCheckedChange={() => handleOperationSelect(operation.id)}
                      />
                    </TableCell>
                    <TableCell className="font-medium">
                      {operation.referenceNumber || 'N/A'}
                    </TableCell>
                    <TableCell>{operation.partyName || 'N/A'}</TableCell>
                    <TableCell>{operation.vehicleNumber || 'N/A'}</TableCell>
                    <TableCell>{operation.driverName || 'N/A'}</TableCell>
                    <TableCell>{operation.plant || 'N/A'}</TableCell>
                    <TableCell>{formatOrderDate(operation.orderDate)}</TableCell>
                    <TableCell>
                      <Badge variant={getBadgeVariant(operation.status)}>
                        {operation.status || 'Unknown'}
                      </Badge>
                    </TableCell>
                    <TableCell>
                      <Button
                        variant="ghost"
                        size="sm"
                        onClick={() => viewProformaDetailsForOperation(operation)}
                      >
                        View Details
                      </Button>
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
            
            {filteredOperations.length === 0 && (
              <div className="text-center py-8 text-muted-foreground">
                No operations found matching the current filters
              </div>
            )}
          </CardContent>
        </Card>
      </div>

      <div className="md:hidden space-y-3">
        {filteredOperations.map((operation) => (
          <Card 
            key={operation.id} 
            id={`mobile-card-${operation.id}`}
            className={cn(
              "cursor-pointer transition-colors",
              selectedOperationIds.includes(operation.id) && "ring-2 ring-blue-500"
            )}
          >
            <CardContent className="p-4">
              <div className="flex items-start justify-between mb-3">
                <div className="flex items-center gap-2">
                  <Checkbox
                    checked={selectedOperationIds.includes(operation.id)}
                    onCheckedChange={() => handleOperationSelect(operation.id)}
                  />
                  <div>
                    <h3 className="font-semibold">
                      {operation.referenceNumber || 'No Reference'}
                    </h3>
                    <p className="text-sm text-muted-foreground">
                      {operation.partyName || 'Unknown Party'}
                    </p>
                  </div>
                </div>
                <Badge variant={getBadgeVariant(operation.status)}>
                  {operation.status || 'Unknown'}
                </Badge>
              </div>
              
              <div className="space-y-2 text-sm">
                <div className="flex justify-between">
                  <span className="text-muted-foreground">Vehicle:</span>
                  <span>{operation.vehicleNumber || 'N/A'}</span>
                </div>
                <div className="flex justify-between">
                  <span className="text-muted-foreground">Driver:</span>
                  <span>{operation.driverName || 'N/A'}</span>
                </div>
                <div className="flex justify-between">
                  <span className="text-muted-foreground">Plant:</span>
                  <span>{operation.plant || 'N/A'}</span>
                </div>
                <div className="flex justify-between">
                  <span className="text-muted-foreground">Date:</span>
                  <span>{formatOrderDate(operation.orderDate)}</span>
                </div>
              </div>
              
              <Button
                className="w-full mt-3"
                variant="outline"
                size="sm"
                onClick={() => viewProformaDetailsForOperation(operation)}
              >
                View Details
              </Button>
            </CardContent>
          </Card>
        ))}
        
        {filteredOperations.length === 0 && (
          <Card>
            <CardContent className="p-8 text-center text-muted-foreground">
              No operations found matching the current filters
            </CardContent>
          </Card>
        )}
      </div>

      <Dialog open={!!viewProformaDetails} onOpenChange={(open) => !open && closeProformaDetails()}>
        <DialogContent className="max-w-4xl max-h-[90vh] overflow-y-auto">
          <DialogHeader>
            <DialogTitle>
              {viewProformaDetails?.slip.orderNumber || 'Proforma Details'}
            </DialogTitle>
            <DialogDescription>
              View and manage items for this operation
            </DialogDescription>
          </DialogHeader>
          
          {renderProformaDetailsContent()}
          
          <DialogFooter>
            <Button variant="outline" onClick={closeProformaDetails}>
              Close
            </Button>
            {!viewProformaDetails?.operation && canCreateOperations() && (
              <Button onClick={() => setIsCreateOperationOpen(true)}>
                Create Operation
              </Button>
            )}
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <Dialog open={isCreateOperationOpen} onOpenChange={setIsCreateOperationOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Create New Operation</DialogTitle>
            <DialogDescription>
              Create a loading operation for {viewProformaDetails?.slip.orderNumber}
            </DialogDescription>
          </DialogHeader>
          
          <div className="space-y-4">
            <div>
              <Label>Status</Label>
              <Select value={newOperationStatus} onValueChange={setNewOperationStatus}>
                <SelectTrigger>
                  <SelectValue placeholder="Select status" />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="LOADING">LOADING</SelectItem>
                  <SelectItem value="READY≈DESP">READY≈DESP</SelectItem>
                  <SelectItem value="IN TRANSIT">IN TRANSIT</SelectItem>
                  <SelectItem value="COMPLETED">COMPLETED</SelectItem>
                </SelectContent>
              </Select>
            </div>
            
            <div>
              <Label>Vehicle Number</Label>
              <Input
                value={newVehicleNumber}
                onChange={(e) => setNewVehicleNumber(e.target.value)}
                placeholder="Enter vehicle number"
              />
            </div>
            
            <div>
              <Label>Driver Name (Optional)</Label>
              <Input
                value={newDriverName}
                onChange={(e) => setNewDriverName(e.target.value)}
                placeholder="Enter driver name"
              />
            </div>
          </div>
          
          <DialogFooter>
            <Button variant="outline" onClick={() => setIsCreateOperationOpen(false)}>
              Cancel
            </Button>
            <Button onClick={handleCreateOperationFromProforma}>
              Create Operation
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}