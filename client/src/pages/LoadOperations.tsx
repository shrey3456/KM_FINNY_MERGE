// import { useQuery } from "@tanstack/react-query";
// import { Button } from "@/components/ui/button";
// import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
// import { Badge } from "@/components/ui/badge";
// import { Checkbox } from "@/components/ui/checkbox";
// import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
// import { cn } from "@/lib/utils";
// import { 
//   preloadProformaData, 
//   getCachedProformaData, 
//   processProformaItems,
//   preloadAllOperationsData,
//   updateProformaSlipItemCache,
//   batchLoadProducts
// } from "@/lib/data-loader";
// import { updateItemWithExtraQuantity, saveExtraQuantity } from "@/utils/extraQuantityHandler";
// import { 
//   Table, 
//   TableBody, 
//   TableCell, 
//   TableHead, 
//   TableHeader, 
//   TableRow,
//   TableFooter
// } from "@/components/ui/table";
// import { 
//   Dialog, 
//   DialogContent, 
//   DialogHeader, 
//   DialogTitle, 
//   DialogTrigger, 
//   DialogFooter,
//   DialogDescription,
//  } from "@/components/ui/dialog";
// import {
//   Select,
//   SelectContent,
//   SelectItem,
//   SelectTrigger,
//   SelectValue,
// } from "@/components/ui/select";
// import {
//   Tabs,
//   TabsContent,
//   TabsList,
//   TabsTrigger,
// } from "@/components/ui/tabs";
// import { PlantFilter } from "@/components/PlantFilter";
// import { SingleDateFilter } from "@/components/SingleDateFilter";
// import { useSingleDateFilter, SingleDateFilterStorage } from "@/hooks/useSingleDateFilter";
// import { OperationsFilter } from "@/components/OperationsFilter";
// import PageHeader from "../components/PageHeader";
// import { Input } from "@/components/ui/input";
// import { Label } from "@/components/ui/label";
// import { Switch } from "@/components/ui/switch";
// import { useState, useEffect, useRef, useMemo, useCallback } from "react";
// import { useToast } from "@/hooks/use-toast";
// import { format, addDays, subDays, startOfDay, endOfDay, isToday, isTomorrow, isYesterday, parseISO } from "date-fns";
// import { apiRequest, queryClient } from "@/lib/queryClient";
// // Use loadingOperations schema from the shared schema
// import { loadingOperations } from "@shared/schema";
// import { getCurrentUserPermissions, isAdminOrSuperAdmin } from "../lib/permissions";
// // Import custom basket checkbox with green background and dark blue border
// import { BasketCheckbox } from "@/components/BasketCheckbox";
// import {
//   Command,
//   CommandEmpty,
//   CommandGroup,
//   CommandInput,
//   CommandItem,
//   CommandList,
//   CommandSeparator,
// } from "@/components/ui/command";

// // Using standardized interfaces from productLoaderHelper for consistency across the application
// import {
//   ProformaSlipItem, 
//   ProformaSlip, 
//   getItemName, 
//   getBarcode, 
//   preloadProductData, 
//   productCache, 
//   enhancedOrderLookup 
// } from "@/lib/productLoaderHelper";

// // Helper functions for item names, barcodes, and product loading have been moved to productLoaderHelper.ts
// // and imported above in the consolidated import

// // Local versions of getSrNo and getSrNoDisplay to avoid conflicts
// // We'll keep these for now to prevent breaking existing code
// function getSrNo(item: ProformaSlipItem, idx?: number): number | string | null {
//   return item.sr_no !== undefined && item.sr_no !== null 
//     ? item.sr_no 
//     : item.srNo !== undefined && item.srNo !== null 
//       ? item.srNo 
//       : idx !== undefined ? idx : null;
// }

// // Helper function to get the Sr. No Display value using either field format
// function getSrNoDisplay(item: ProformaSlipItem): string | null {
//   return item.sr_no_display !== undefined && item.sr_no_display !== null 
//     ? item.sr_no_display 
//     : item.srNoDisplay !== undefined && item.srNoDisplay !== null 
//       ? item.srNoDisplay 
//       : null;
// }

// /**
//  * Calculate volume from product volumeInCuFt and quantity
//  * @param volumeInCuFt The volume value from product (can be string or number)
//  * @param quantity The quantity to multiply with volume
//  * @returns Formatted volume string with 2 decimal places
//  */
// function calculateVolume(volumeInCuFt: string | number | null | undefined, quantity: number): string {
//   // Handle missing or invalid values
//   if (volumeInCuFt === null || volumeInCuFt === undefined || quantity === 0) {
//     return "0.00";
//   }
  
//   // Convert volume to number if it's a string
//   const volumeAsNumber = typeof volumeInCuFt === 'string' 
//     ? parseFloat(volumeInCuFt.replace(/[^\d.-]/g, '')) 
//     : volumeInCuFt;
  
//   // Handle NaN or non-numeric values
//   if (isNaN(volumeAsNumber)) {
//     return "0.00";
//   }
  
//   // Calculate total volume and format to 2 decimal places
//   const totalVolume = volumeAsNumber * quantity;
//   return totalVolume.toFixed(2);
// }
// import { PlantBadge } from "@/components/PlantBadge";
// import { KrupaMarketingHeader } from "@/components/KrupaMarketingHeader";

// // Helper function to safely check if a value is a Date object
// // This avoids using the instanceof operator which can cause TypeScript errors
// const isDateObject = (value: any): value is Date => {
//   return value && typeof value === 'object' && 'getTime' in value && typeof value.getTime === 'function';
// };

// import { 
//   ChevronLeftIcon, 
//   ChevronRightIcon, 
//   Loader2, 
//   FileTextIcon, 
//   TruckIcon,
//   SearchIcon,
//   Search,
//   Eye,
//   ClipboardList,
//   CheckSquare,
//   Calculator,
//   Square,
//   Trash,
//   MoreVertical,
//   PlusCircle,
//   MinusCircle,
//   Save,
//   Plus,
//   FileText,
//   CheckCircle,
//   AlertCircle,
//   Layers,
//   Package,
//   Truck,
//   Factory,
//   Check,
//   ChevronDown,
//   ChevronUp,
//   ChevronLeft,
//   ChevronRight,
//   ChevronFirst,
//   ChevronLast,
//   CalendarRange,
//   CalendarIcon,
//   XCircle,
//   Tag,
//   User,
//   UserCircle2,
//   Receipt,
//   ReceiptText,
//   ArrowDown,
//   ArrowUp,
//   ArrowLeft,
//   ArrowRight
// } from "lucide-react";
// import { all } from "axios";
// // Date filtering removed as per client requirements
// // loadingOperations already imported at the top of file
// type LoadOperationType = typeof loadingOperations.$inferSelect;

// // Date utility functions for the new dropdown filter
// // Format date to DD/MM/YYYY format for consistency
// const formatDateToDDMMYYYY = (date: Date): string => {
//   return format(date, 'dd/MM/yyyy');
// };

// // Check if a date string in DD/MM/YYYY format matches today
// const isDateToday = (dateStr: string | null): boolean => {
//   if (!dateStr) return false;
//   // Convert DD/MM/YYYY to Date object
//   const [day, month, year] = dateStr.split('/').map(num => parseInt(num, 10));
//   if (!day || !month || !year) return false;
  
//   const date = new Date(year, month - 1, day); // month is 0-indexed in JS Date
//   return isToday(date);
// };

// // Check if a date string in DD/MM/YYYY format matches tomorrow
// const isDateTomorrow = (dateStr: string | null): boolean => {
//   if (!dateStr) return false;
//   // Convert DD/MM/YYYY to Date object
//   const [day, month, year] = dateStr.split('/').map(num => parseInt(num, 10));
//   if (!day || !month || !year) return false;
  
//   const date = new Date(year, month - 1, day); // month is 0-indexed in JS Date
//   return isTomorrow(date);
// };

// // Check if a date string in DD/MM/YYYY format matches yesterday
// const isDateYesterday = (dateStr: string | null): boolean => {
//   if (!dateStr) return false;
//   // Convert DD/MM/YYYY to Date object
//   const [day, month, year] = dateStr.split('/').map(num => parseInt(num, 10));
//   if (!day || !month || !year) return false;
  
//   const date = new Date(year, month - 1, day); // month is 0-indexed in JS Date
//   return isYesterday(date);
// };

// // Add window types
// declare global {
//   interface Window {
//     addItemToSlip: (operationId: number, productId: number, referenceNumber: string, productName: string, sku: string) => void;
//     deviceId?: string; // Add deviceId for broadcast channel identification
//   }
// }

// export default function LoadOperations() {
//   // Universal handler for updating item loaded status
//   // This function consolidates the logic for updating the loaded status of items
//   // to ensure consistency across all parts of the UI
  
//   // Add the forceUpdateCounter here so it's available for all functions
//   // This will trigger re-renders in the BasketSummary component
//   const [forceUpdateCounter, setForceUpdateCounter] = useState<number>(Date.now());
  
//   // Track when data was last refreshed for polling
//   const [lastPollingUpdate, setLastPollingUpdate] = useState<number>(0);

//   // Completely rewritten handleUpdateItemLoadedStatus function
//   const handleUpdateItemLoadedStatus = (
//     item: ProformaSlipItem,
//     operation: any,
//     checked: boolean
//   ): void => {
//     console.log(`Updating loaded status for item ${item.id} to ${checked}`);
    
//     // Create a forceUpdate counter for BasketSummary
//     const forceUpdateTimestamp = Date.now();
    
//     // When loading an item, set loadedQuantity to the current quantity
//     // When unloading, preserve the loadedQuantity (don't set to 0)
//     const loadedQty = checked ? item.quantity || 0 : (item.loadedQuantity || 0);
    
//     // 1. Create an updated item with the new loaded status and proper loadedQuantity
//     const updatedItem: ProformaSlipItem = { 
//       ...item, 
//       loaded: checked,
//       loadedQuantity: loadedQty
//     };
    
//     console.log(`Item ${item.id}: setting loaded=${checked}, loadedQuantity=${loadedQty}`);
    
//     // 2. Update UI immediately for a responsive feel
    
//     // 2a. Update card background in mobile view if applicable
//     const card = document.querySelector(`div[data-item-id="basket-mobile-${item.id}"]`);
//     if (card) {
//       if (checked) {
//         card.classList.add('bg-highlight-green-50');
//       } else {
//         card.classList.remove('bg-highlight-green-50');
//       }
//     }
    
//     // 2b. Update row background in desktop view if applicable
//     const row = document.querySelector(`tr[data-item-id="${item.id}"]`);
//     if (row) {
//       if (checked) {
//         row.classList.add('bg-highlight-green-50');
        
//         // Add highlighting to all table cells within this row
//         const cells = row.querySelectorAll('td');
//         cells.forEach(cell => {
//           cell.classList.add('bg-highlight-green-50');
//         });
//       } else {
//         row.classList.remove('bg-highlight-green-50');
        
//         // Remove highlighting from all table cells within this row
//         const cells = row.querySelectorAll('td');
//         cells.forEach(cell => {
//           cell.classList.remove('bg-highlight-green-50');
//         });
//       }
//     }
    
//     // 3. Update the local view state with our changes IMMEDIATELY for a responsive UI
//     setViewProformaDetails(prev => {
//       if (!prev) return prev;
      
//       // Create a completely new items array with our update
//       const updatedItems = prev.items.map(i => 
//         i.id === item.id ? updatedItem : i
//       );
      
//       // Calculate summary values directly for logging
//       const loadedTotal = updatedItems.reduce((total, i) => {
//         if (i.loaded) {
//           return total + (i.loadedQuantity || i.quantity || 0);
//         }
//         return total;
//       }, 0);
      
//       console.log(`Updated item loaded status. New loaded total: ${loadedTotal}`);
      
//       // Return an entirely new object to ensure React detects the change
//       return {
//         ...prev,
//         items: updatedItems,
//         // Add a timestamp to force child components to re-render
//         _updateTimestamp: forceUpdateTimestamp
//       };
//     });
    
//     // 4. Force a refresh of the forceUpdateCounter to make sure BasketSummary re-renders
//     setForceUpdateCounter(forceUpdateTimestamp);
    
//     // 5. Update the cache to ensure data consistency across components
//     if (operation?.referenceNumber) {
//       updateProformaSlipItemCache(operation.referenceNumber, item.id, checked);
//     }
    
//     // Common functions for handling success and error
//     const handleSuccess = () => {
//       console.log('Successfully updated item loaded status');
      
//       // Refresh any related data that might depend on this change
//       if (operation && operation.id) {
//         // Invalidate both the specific operation items AND the overall operations list
//         // to ensure mobile view tabs update correctly
//         queryClient.invalidateQueries({ queryKey: [`/api/loading-operations/${operation.id}/items`] });
//         queryClient.invalidateQueries({ queryKey: ['/api/loading-operations'] });
//         queryClient.invalidateQueries({ queryKey: ['/api/loading-operations/status/count'] });
        
//         // If we have an open operation, immediately refresh its items
//         if (viewProformaDetails && operation.referenceNumber) {
//           // Force a refresh of the operation items
//           fetchLoadOperationDetails(operation.referenceNumber, operation.id)
//             .then(details => {
//               if (details) {
//                 console.log('Refreshing view data after item status change');
                
//                 // Update the viewProformaDetails with fresh data
//                 setViewProformaDetails(details);
                
//                 // Also update the cached data
//                 setProformaSlipsData(prev => ({
//                   ...prev,
//                   [operation.referenceNumber]: details
//                 }));
//               }
//             })
//             .catch(err => {
//               console.error('Error refreshing operation details:', err);
//             });
//         }
        
//         // Force a refresh of the operation tab counts
//         setTimeout(() => {
//           // Use timeout to ensure UI updates before we fetch new data
//           const loadingCountQuery = queryClient.getQueryCache().find({ queryKey: ['/api/loading-operations/status/count', 'IN_PROGRESS'] });
//           const readyCountQuery = queryClient.getQueryCache().find({ queryKey: ['/api/loading-operations/status/count', 'READY_FOR_DISPATCHED'] });
          
//           if (loadingCountQuery) {
//             loadingCountQuery.fetch();
//           }
//           if (readyCountQuery) {
//             readyCountQuery.fetch();
//           }
          
//           // Also invalidate the operation itself to update its metadata
//           queryClient.invalidateQueries({ queryKey: [`/api/loading-operations/${operation.id}`] });
//         }, 200);
        
//         // Broadcast the change to other devices for real-time updates
//         if (broadcastChannelRef.current && operation.referenceNumber) {
//           // Create and send the broadcast message
//           broadcastChannelRef.current.postMessage({
//             type: 'ITEM_LOADED_STATUS_UPDATED',
//             data: {
//               itemId: item.id,
//               loaded: checked,
//               referenceNumber: operation.referenceNumber,
//               loadOperationId: operation.id
//             },
//             operationId: operation.id,
//             timestamp: Date.now(),
//             sender: window.deviceId
//           });
          
//           console.log(`[BroadcastSent] Item ${item.id} loaded status changed to ${checked}`);
//         }
//       }
//     };
    
//     const handleError = (error: any) => {
//       console.error('Error updating item loaded status:', error);
//       toast({
//         title: "Failed to save",
//         description: "There was an error updating item status. Please try again.",
//         variant: "destructive"
//       });
//     };
    
//     // 4. Update the backend via API - EXCLUSIVELY use load operation items when available
//     if (operation && operation.id) {
//       // First try to get the load operation items
//       apiRequest('GET', `/api/loading-operations/${operation.id}/items`)
//         .then(response => response.json())
//         .then(loadOpItems => {
//           // Find the matching item by product ID
//           const loadOpItemsArray = Array.isArray(loadOpItems) ? loadOpItems : [];
//           const matchingLoadOpItem = loadOpItemsArray.find(
//             loadItem => loadItem.productId === item.productId
//           );
          
//           if (matchingLoadOpItem) {
//             // Update the load operation item
//             console.log(`Updating load operation item #${matchingLoadOpItem.id} instead of proforma slip item #${item.id}`);
            
//             // Make a direct API call but ensure extraQuantity is preserved
//             apiRequest('PATCH', `/api/loading-operation-items/${matchingLoadOpItem.id}`, {
//               loaded: checked,
//               loadedQuantity: checked ? matchingLoadOpItem.quantity || item.quantity : 0,
//               // Explicitly include extraQuantity to preserve it
//               extraQuantity: matchingLoadOpItem.extraQuantity
//             })
            
//             .then(handleSuccess)
//             .catch(handleError);
//           } else {
//             // If no matching load operation item is found, we need to create it
//             console.warn(`No matching load operation item found for product ID ${item.productId}, creating new load operation item`);
            
//             // Create a new load operation item based on the proforma item
//             const newLoadOpItem = {
//               loadOperationsId: operation.id,
//               productId: item.productId,
//               quantity: item.quantity,
//               originalQuantity: item.quantity,
//               loadedQuantity: checked ? (item.quantity || 0) : 0, // Start with loaded quantity based on checked state
//               loaded: checked, // Use the checked state
//               srNo: item.srNo,
//               barcode: item.barcode,
//               itemName: item.itemName,
//               srNoDisplay: item.srNo // Use srNo as srNoDisplay if not available
//             };
            
//             // Create a new load operation item
//             apiRequest('POST', `/api/loading-operations/${operation.id}/items`, newLoadOpItem)
//               .then(() => {
//                 console.log(`Successfully created new load operation item for product ID ${item.productId}`);
//                 handleSuccess();
//               })
//               .catch(error => {
//                 console.error('Error creating load operation item:', error);
                
//                 // As a last resort, fall back to updating proforma slip item
//                 console.warn(`Unable to create load operation item, falling back to proforma slip update`);
//                 apiRequest('PATCH', `/api/loading-operation-items/${item.id}`, {
//                   loaded: checked,
//                   loadedQuantity: checked ? item.quantity || 0 : 0
//                 })
//                 .then(handleSuccess)
//                 .catch(handleError);
//               });
//           }
//         })
//         .catch(error => {
//           // Error fetching load operation items, fall back to updating proforma item
//           console.error('Error looking up load operation items:', error);
          
//           // Update the loading operation item instead of proforma slip
//           apiRequest('PATCH', `/api/loading-operation-items/${item.id}`, {
//             loaded: checked,
//             loadedQuantity: checked ? item.quantity || 0 : 0
//           })
//           .then(handleSuccess)
//           .catch(handleError);
//         });
//     } else {
//       // No operation ID, we still need to update loading operation item
//       apiRequest('PATCH', `/api/loading-operation-items/${item.id}`, {
//         loaded: checked,
//         loadedQuantity: checked ? item.quantity || 0 : 0
//       })
//       .then(handleSuccess)
//       .catch(handleError);
//     }
//   };

//   // Date filtering removed per client requirements
  
//   // State variables
//   const [isOrderLookupDialogOpen, setIsOrderLookupDialogOpen] = useState(false);
//   const [isDeleteDialogOpen, setIsDeleteDialogOpen] = useState(false);
//   const [isMultipleDeleteDialogOpen, setIsMultipleDeleteDialogOpen] = useState(false);
//   // State to track which edit dialogs should stay open
//   const [editDialogOpenStates, setEditDialogOpenStates] = useState<{[key: number]: boolean}>({})
//   const [newlyCreatedLoadingId, setNewlyCreatedLoadingId] = useState<number | null>(null);
  
//   // Date filter states - Use page-specific filter hook
//   const { savedDate, isInitialized } = useSingleDateFilter('load-operations-page');
//   const [selectedDate, setSelectedDate] = useState<Date | null>(null);
//   const [isDateFilterActive, setIsDateFilterActive] = useState(false);
  
//   // Legacy date filter dropdown state (kept for backward compatibility)
//   const [dateFilterOption, setDateFilterOption] = useState<string>("all"); // Options: "all", "today", "tomorrow", "yesterday"
//   const [userInteracting, setUserInteracting] = useState(false);
  
//   // Show more/less functionality for table
//   const [showAll, setShowAll] = useState<boolean>(false);
  
//   // Plant filter state
//   const [selectedPlants, setSelectedPlants] = useState<string[]>([]);
//   const [plantOptions, setPlantOptions] = useState<Array<{value: string, label: string}>>([]);
//   const [entriesLimit, setEntriesLimit] = useState<number>(15); // Default is 15 entries
//   const [currentPage, setCurrentPage] = useState(1);
//   const [totalVolume, setTotalVolume] = useState<string>("0.00"); // Store calculated total volume
//   const [originalVolumeCalculation, setOriginalVolumeCalculation] = useState<string>("0.00 cu ft"); // Store expected volume based on original quantities
//   const [isCalculatingVolume, setIsCalculatingVolume] = useState(false); // Track if volume calculation is in progress
//   const [activeTabs, setActiveTabs] = useState<Record<number, string>>({});
//   const [activeViewTab, setActiveViewTab] = useState<string>("overall");
//   const [activeItemFilter, setActiveItemFilter] = useState<string>("all");
//   const [visibleItems, setVisibleItems] = useState<{[key: string]: number}>({});
//   const [sortOrder, setSortOrder] = useState<'asc' | 'desc'>('desc');
//   const [sortBy, setSortBy] = useState<'orderNumber' | 'creationDate'>('creationDate'); // Default to sort by creation date
//   const ITEMS_PER_PAGE = 10; // Show only 10 items in mobile UI initially
//   const [orderNumberToSearch, setOrderNumberToSearch] = useState('');
//   const [searchQuery, setSearchQuery] = useState('');
//   const [isOrderSearchLoading, setIsOrderSearchLoading] = useState(false);
//   const [selectedOperationIds, setSelectedOperationIds] = useState<number[]>([]);
//   // Initialize with cached data from sessionStorage for better performance
//   const [proformaSlipsData, setProformaSlipsData] = useState<Record<string, any>>(() => {
//     try {
//       const savedData = sessionStorage.getItem('loadOperations_proformaSlipsData');
//       if (savedData) {
//         console.log("Restored proforma slips data cache");
//         return JSON.parse(savedData);
//       }
//     } catch (error) {
//       console.error("Error loading cached proforma data:", error);
//     }
//     return {};
//   });
//   const [proformaSlipDetails, setProformaSlipDetails] = useState<{
//     slip: ProformaSlip;
//     items: ProformaSlipItem[];
//     operation?: {
//       status: string;
//     };
//   } | null>(null);
//   // For viewing operation details
//   const [selectedOperation, setSelectedOperation] = useState<LoadOperationType | null>(null);
//   const [viewProformaDetails, setViewProformaDetails] = useState<{
//     slip: ProformaSlip;
//     items: ProformaSlipItem[];
//     operation?: {
//       status: string;
//     };
//   } | null>(null);
  
//   // Track whether operation status is being changed to prevent duplicate error notifications
//   const [operationStatusChanging, setOperationStatusChanging] = useState<boolean>(false);
//   const [loadingProformaDetails, setLoadingProformaDetails] = useState(false);
//   // This state definition was already handled above
//   const [userId, setUserId] = useState<number>(0);
//   const [userRole, setUserRole] = useState<string>("user");
//   const [userName, setUserName] = useState<string>("");
//   const [userDesignation, setUserDesignation] = useState<string>("");
//   const [userDepartment, setUserDepartment] = useState<string>("");
//   const [userPermissions, setUserPermissions] = useState<any>({
//     canDelete: false,
//     canDeleteOperationalItems: false
//   });
//   const [uniqueCategories, setUniqueCategories] = useState<string[]>([]);
//   const [slipItemSearchQuery, setSlipItemSearchQuery] = useState<string>("");
//   const [isUpdating, setIsUpdating] = useState<boolean>(false);
//   const [users, setUsers] = useState<Record<number, {id: number, name: string, username: string}>>({});
//   // User code for operation creation
//   const [userCode, setUserCode] = useState<string | null>(null);
  
//   // WebSocket setup for real-time updates (DISABLED - commented out for now)
//   // const wsRef = useRef<WebSocket | null>(null);
//   // const [wsConnected, setWsConnected] = useState<boolean>(false);
//   // const [lastMessageReceived, setLastMessageReceived] = useState<number>(0);
  
//   // Temporary stub to prevent undefined variable errors in commented WebSocket code
//   const wsRef = { current: null };
//   const [refreshing, setRefreshing] = useState<boolean>(false);
  
//   // Create a unique device ID for this browser session if none exists (DISABLED)
//   /* WEBSOCKET DISABLED - uncomment this useEffect to re-enable WebSocket functionality
//   useEffect(() => {
//     if (!window.deviceId) {
//       window.deviceId = `device-${Math.random().toString(36).substring(2, 8)}`;
//     }
    
//     // Set up WebSocket connection for real-time updates
//     const protocol = window.location.protocol === "https:" ? "wss:" : "ws:";
//     const wsUrl = `${protocol}//${window.location.host}/ws`;
    
//     const setupWebSocket = () => {
//       // Clean up any existing connection
//       if (wsRef.current && wsRef.current.readyState === WebSocket.OPEN) {
//         wsRef.current.close();
//       }
      
//       console.log(`[WebSocket] Setting up WebSocket connection to ${wsUrl}`);
//       const ws = new WebSocket(wsUrl);
//       wsRef.current = ws;
      
//       ws.onopen = () => {
//         console.log('[WebSocket] Connection established');
//         setWsConnected(true);
        
//         // Send an initial message to identify this client
//         ws.send(JSON.stringify({
//           type: 'CONNECT',
//           device: window.deviceId,
//           timestamp: Date.now()
//         }));
//       };
      
//       ws.onclose = () => {
//         console.log('[WebSocket] Connection closed, will attempt to reconnect...');
//         setWsConnected(false);
        
//         // Attempt to reconnect after a delay
//         setTimeout(() => {
//           if (document.visibilityState === 'visible') {
//             // setupWebSocket();
//           }
//         }, 3000);
//       };
      
//       ws.onerror = (error) => {
//         console.error('[WebSocket] Connection error:', error);
//         setWsConnected(false);
//       };
      
//       ws.onmessage = (event) => {
//         try {
//           const message = JSON.parse(event.data);
          
//           // Ignore messages from this device to avoid echo
//           if (message.sender === window.deviceId) {
//             return;
//           }
          
//           console.log(`[WebSocket] Received message: ${message.type}`);
//           setLastMessageReceived(Date.now());
          
//           // Process various message types for real-time updates
//           processWebSocketMessage(message);
          
//         } catch (error) {
//           console.error('[WebSocket] Error processing message:', error);
//         }
//       };
//     };
    
//     // Initial setup - temporarily disabled WebSocket to fix connection issues
//     // setupWebSocket();
    
//     // Reconnect when the page becomes visible again after being hidden
//     const handleVisibilityChange = () => {
//       if (document.visibilityState === 'visible' && 
//           (!wsRef.current || wsRef.current.readyState !== WebSocket.OPEN)) {
//         console.log('[WebSocket] Page visible, reconnecting...');
//         // setupWebSocket();
//       }
//     };
    
//     document.addEventListener('visibilitychange', handleVisibilityChange);
    
//     // Cleanup on unmount
//     return () => {
//       document.removeEventListener('visibilitychange', handleVisibilityChange);
//       if (wsRef.current) {
//         wsRef.current.close();
//       }
//     };
//   }, []);
//   */ // END WEBSOCKET DISABLED SECTION
  
//   // Function to handle incoming WebSocket messages (DISABLED)
//   /* WEBSOCKET DISABLED - uncomment to re-enable message processing
//   const processWebSocketMessage = useCallback((message: any) => {
//     switch (message.type) {
//       case 'ITEM_QUANTITY_UPDATED':
//         // Handle quantity updates for open dialogs
//         if (selectedOperation?.id === message.data.operationId) {
//           console.log(`[WebSocket] Received quantity update for item ${message.data.itemId}`);
          
//           // If we have the edit dialog open for this operation, update it
//           if (viewProformaDetails) {
//             setViewProformaDetails(prevDetails => {
//               if (!prevDetails) return prevDetails;
              
//               // Update the specific item with new data
//               const updatedItems = prevDetails.items.map(item => {
//                 if (item.id === message.data.itemId) {
//                   console.log(`[WebSocket] Updating item ${item.id} in dialog: 
//                     quantity: ${message.data.newQuantity}, 
//                     loaded: ${message.data.loaded}, 
//                     loadedQuantity: ${message.data.loadedQuantity}`);
                  
//                   return {
//                     ...item,
//                     quantity: message.data.newQuantity,
//                     extraQuantity: message.data.extraQuantity,
//                     originalQuantity: message.data.originalQuantity,
//                     loaded: message.data.loaded,
//                     loadedQuantity: message.data.loadedQuantity
//                   };
//                 }
//                 return item;
//               });
              
//               return {
//                 ...prevDetails,
//                 items: updatedItems
//               };
//             });
            
//             // Force UI refresh
//             setForceUpdateCounter(Date.now());
//           }
//         }
//         break;
        
//       case 'ITEM_LOADED_STATUS_UPDATED':
//         // Handle loaded status changes for open dialogs
//         if (selectedOperation?.id === message.data.loadOperationId) {
//           console.log(`[WebSocket] Received loaded status update for item ${message.data.itemId}: ${message.data.loaded}`);
          
//           // If we have the edit dialog open for this operation, update it
//           if (viewProformaDetails) {
//             setViewProformaDetails(prevDetails => {
//               if (!prevDetails) return prevDetails;
              
//               // Update the specific item with new loaded status
//               const updatedItems = prevDetails.items.map(item => {
//                 if (item.id === message.data.itemId) {
//                   console.log(`[WebSocket] Updating item ${item.id} loaded status in dialog: ${message.data.loaded}`);
                  
//                   // If item is being marked as loaded, ensure loadedQuantity equals quantity
//                   const updatedLoadedQuantity = message.data.loaded ? item.quantity : (item.loadedQuantity || 0);
                  
//                   return {
//                     ...item,
//                     loaded: message.data.loaded,
//                     loadedQuantity: updatedLoadedQuantity
//                   };
//                 }
//                 return item;
//               });
              
//               return {
//                 ...prevDetails,
//                 items: updatedItems
//               };
//             });
            
//             // Force UI refresh
//             setForceUpdateCounter(Date.now());
//           }
//         }
//         break;
        
//       case 'OPERATION_STATUS_UPDATED':
//         // Force a refresh when any operation status changes
//         console.log('[WebSocket] Operation status updated, refreshing data');
//         manualRefresh();
//         break;
        
//       case 'OPERATION_UPDATED':
//         // Handle vehicle number and driver name updates
//         console.log(`[WebSocket] Received operation update for operation ${message.operationId}:`, message.data);
        
//         // Update the operations list if it's loaded
//         if (data) {
//           const updatedOperations = data.map(op => 
//             op.id === message.operationId 
//               ? { ...op, ...message.data } 
//               : op
//           );
          
//           // Update the operations list in the UI
//           queryClient.setQueryData(['/api/loading-operations'], updatedOperations);
//         }
        
//         // If this is the operation we're currently viewing in the edit dialog,
//         // update the view details as well
//         if (selectedOperation?.id === message.operationId && viewProformaDetails) {
//           console.log('[WebSocket] Updating vehicle details in open dialog');
          
//           setViewProformaDetails({
//             ...viewProformaDetails,
//             slip: {
//               ...viewProformaDetails.slip,
//               ...message.data  // This contains vehicleNumber and driverName
//             }
//           });
          
//           // Update input fields directly for immediate visual feedback
//           try {
//             const vehicleNumberInput = document.getElementById(`vehicle-number-${message.operationId}`) as HTMLInputElement;
//             if (vehicleNumberInput && message.data.vehicleNumber !== undefined) {
//               vehicleNumberInput.value = message.data.vehicleNumber;
//             }
            
//             const driverNameInput = document.getElementById(`driver-name-${message.operationId}`) as HTMLInputElement;
//             if (driverNameInput && message.data.driverName !== undefined) {
//               driverNameInput.value = message.data.driverName;
//             }
//           } catch (err) {
//             console.error('[WebSocket] Error updating input fields:', err);
//           }
//         }
        
//         // Also update the vehicle number display in the main table
//         try {
//           const vehicleNumberCell = document.querySelector(`#vehicle-number-display-${message.operationId}`);
//           if (vehicleNumberCell && message.data.vehicleNumber !== undefined) {
//             vehicleNumberCell.textContent = message.data.vehicleNumber || '';
//           }
          
//           // Update in mobile card view as well
//           const mobileVehicleDisplay = document.querySelector(`#mobile-vehicle-number-${message.operationId}`);
//           if (mobileVehicleDisplay && message.data.vehicleNumber !== undefined) {
//             mobileVehicleDisplay.textContent = message.data.vehicleNumber || '';
//           }
//         } catch (err) {
//           console.error('[WebSocket] Error updating vehicle number display:', err);
//         }
//         break;
        
//       default:
//         // Ignore unknown message types
//         break;
//     }
//   }, [selectedOperation, viewProformaDetails]);
//   */ // END WEBSOCKET MESSAGE PROCESSING
  
//   // Backwards compatibility for BroadcastChannel references in existing code (DISABLED)
//   /* WEBSOCKET DISABLED - uncomment to re-enable broadcast channel compatibility
//   const broadcastChannelRef = { 
//     current: { 
//       postMessage: (message: any) => {
//         // Forward to WebSocket if connected
//         if (wsRef.current && wsRef.current.readyState === WebSocket.OPEN) {
//           wsRef.current.send(JSON.stringify(message));
//         }
//       } 
//     } 
//   };
//   const [lastBroadcastReceived, setLastBroadcastReceived] = useState<number>(0);
//   */ // END BROADCAST CHANNEL COMPATIBILITY
  
//   // Temporary stub for broadcastChannelRef to prevent undefined reference errors
//   const broadcastChannelRef = { 
//     current: { 
//       postMessage: (message: any) => {
//         // WebSocket functionality disabled - no-op
//         console.log('[WebSocket] Disabled - would have sent:', message.type);
//       } 
//     } 
//   };
  
//   // This will be initialized later in the component with the real refetch function
//   const refetchRef = useRef<() => Promise<any>>(async () => { 
//     console.log("Refetch not initialized yet"); 
//     return null;
//   });

//   // Manual refresh function for immediate data updates
//   const manualRefresh = useCallback(async () => {
//     try {
//       setRefreshing(true);
//       console.log("Manual refresh triggered");
      
//       // Invalidate all relevant queries
//       await queryClient.invalidateQueries({ queryKey: ['/api/loading-operations'] });
      
//       // Force refetch to get fresh data - use the ref version
//       if (refetchRef.current) {
//         await refetchRef.current();
//       }
      
//       // WebSocket notification removed as requested
      
//       toast({
//         title: "Data refreshed",
//         description: "Latest data has been loaded",
//       });
//     } catch (error) {
//       console.error("Error during manual refresh:", error);
//       toast({
//         title: "Refresh failed",
//         description: "Unable to refresh data. Please try again.",
//         variant: "destructive"
//       });
//     } finally {
//       setRefreshing(false);
//     }
//   }, []);
  
//   // References for saving quantities
//   let table: HTMLTableElement | null = null;
//   let mobileItems: HTMLDivElement | null = null;
  
//   // Safety function to prevent crashes when accessing missing properties
//   const safeSearchOperations = (operations: LoadOperationType[], searchText: string) => {
//     if (!searchText) return operations;
//     try {
//       return operations.filter(op => 
//         op.referenceNumber?.toLowerCase().includes(searchText.toLowerCase()) || 
//         op.status?.toLowerCase().includes(searchText.toLowerCase())
//       );
//     } catch (error) {
//       console.error("Error filtering operations:", error);
//       return operations;
//     }
//   };
  
//   // Safety functions moved to a better location below
  
//   // Add polling mechanism for real-time updates in dialog
//   useEffect(() => {
//     // Only poll if dialog is open and we have an operation
//     if (!viewProformaDetails || !selectedOperation) return;
    
//     console.log("Starting dialog data polling");
    
//     // Create polling interval for fresh data updates
//     const pollTimer = setInterval(async () => {
//       if (!viewProformaDetails || !selectedOperation) {
//         clearInterval(pollTimer);
//         return;
//       }
      
//       try {
//         // Fetch fresh operation items data directly
//         const response = await fetch(`/api/loading-operations/${selectedOperation.id}/items`);
        
//         if (!response.ok) {
//           console.warn("Failed to fetch latest item data");
//           return;
//         }
        
//         const freshItems = await response.json();
        
//         // Check if data has actually changed before updating
//         const hasChanges = freshItems.some((freshItem: any) => {
//           const currentItem = viewProformaDetails.items.find(item => item.id === freshItem.id);
//           if (!currentItem) return true;
          
//           return (
//             currentItem.loaded !== freshItem.loaded ||
//             currentItem.loadedQuantity !== freshItem.loadedQuantity ||
//             currentItem.quantity !== freshItem.quantity ||
//             currentItem.extraQuantity !== freshItem.extraQuantity
//           );
//         });
        
//         if (hasChanges) {
//           console.log("Dialog data has changed, updating view...");
          
//           // Update dialog with fresh data
//           setViewProformaDetails(prevDetails => {
//             if (!prevDetails) return prevDetails;
            
//             // Map current items to updated ones
//             const updatedItems = prevDetails.items.map(existingItem => {
//               // Find matching fresh item
//               const freshItem = freshItems.find((item: any) => item.id === existingItem.id);
              
//               if (freshItem) {
//                 return {
//                   ...existingItem,
//                   loaded: freshItem.loaded,
//                   loadedQuantity: freshItem.loadedQuantity,
//                   quantity: freshItem.quantity,
//                   extraQuantity: freshItem.extraQuantity,
//                   originalQuantity: freshItem.originalQuantity
//                 };
//               }
              
//               return existingItem;
//             });
            
//             // Update last polling time
//             setLastPollingUpdate(Date.now());
            
//             // Force BasketSummary to re-render
//             setForceUpdateCounter(Date.now());
            
//             return {
//               ...prevDetails,
//               items: updatedItems
//             };
//           });
//         }
//       } catch (error) {
//         console.error("Error polling for dialog updates:", error);
//       }
//     }, 2000); // Poll every 2 seconds
    
//     // Cleanup interval on unmount or dialog close
//     return () => {
//       clearInterval(pollTimer);
//       console.log("Stopped dialog data polling");
//     };
//   }, [selectedOperation, viewProformaDetails?.slip?.id]);
  
//   // Auto calculate volume when operation details are loaded or items are checked/unchecked
//   useEffect(() => {
//     const autoCalculateVolume = async () => {
//       if (viewProformaDetails?.items && viewProformaDetails.items.length > 0) {
//         try {
//           // Set calculation in progress
//           setIsCalculatingVolume(true);
            
//           // Calculate the current volume based on loaded items
//           const volume = await calculateTotalVolume(viewProformaDetails.items);
            
//           // Update volume in state
//           setTotalVolume(volume);
          
//           // Calculate original volume based on original quantities
//           const calculateOriginalVolume = async () => {
//             try {
//               // Get all product IDs from items
//               const productIds: number[] = viewProformaDetails.items
//                 .filter(item => item.productId && item.originalQuantity)
//                 .map(item => item.productId);
                
//               if (productIds.length === 0) {
//                 setOriginalVolumeCalculation("0.00 cu ft");
//                 return;
//               }
              
//               // Fetch products with volume data
//               const batchProductResponse = await fetch('/api/products/batch', {
//                 method: 'POST',
//                 headers: {
//                   'Content-Type': 'application/json'
//                 },
//                 body: JSON.stringify({ productIds })
//               });
              
//               if (!batchProductResponse.ok) {
//                 console.error("Failed to fetch products for original volume calculation");
//                 setOriginalVolumeCalculation("Error");
//                 return;
//               }
              
//               const productsMap = await batchProductResponse.json();
              
//               // Calculate the expected volume based on original quantities
//               let expectedVolume = 0;
//               for (const item of viewProformaDetails.items) {
//                 if (item.productId && item.originalQuantity) {
//                   const product = productsMap[item.productId];
//                   if (product && product.volumeInCuFt) {
//                     const volumeInCuFt = parseFloat(product.volumeInCuFt || "0");
//                     expectedVolume += item.originalQuantity * volumeInCuFt;
//                     console.log(`Expected: Item ${product.name}, Volume: ${volumeInCuFt} cu ft, Original Qty: ${item.originalQuantity}, Total: ${item.originalQuantity * volumeInCuFt} cu ft`);
//                   }
//                 }
//               }
              
//               // Format the expected volume to 2 decimal places
//               const formattedExpectedVolume = Math.round(expectedVolume * 100) / 100;
//               setOriginalVolumeCalculation(`${formattedExpectedVolume} cu ft`);
//             } catch (error) {
//               console.error("Error calculating original volume:", error);
//               setOriginalVolumeCalculation("Error");
//             }
//           };
          
//           // Run the original volume calculation
//           await calculateOriginalVolume();
            
//           // Set calculation complete
//           setIsCalculatingVolume(false);
//         } catch (error) {
//           console.error("Error in auto-calculating volume:", error);
//           setIsCalculatingVolume(false);
//         }
//       }
//     };
    
//     autoCalculateVolume();
//   }, [viewProformaDetails]);

//   useEffect(() => {
//     // WebSocket functionality has been removed as requested
//     // This maintains the same dependency array but without the WebSocket logic
    
//     // No cleanup needed since we removed WebSocket functionality
//     return () => {
//       // No cleanup required
//     };
//   }, [selectedOperation]);
  
//   // Initialize date filter based on saved filter
//   useEffect(() => {
//     if (isInitialized) {
//       // If we have a saved filter, always use it when navigating to this page
//       if (savedDate) {
//         console.log("Using saved date filter:", savedDate);
//         setSelectedDate(savedDate);
//         setIsDateFilterActive(true);
//       } 
//       // We no longer set today as the default date - require explicit user selection
//       else if (!selectedDate) {
//         console.log("No default date filter applied");
//         setIsDateFilterActive(false);
//       }
//     }
//   }, [isInitialized, savedDate]);
  
//   // Save on every change INCLUDING a clear — saveDateFilter(null) removes the key. Guarding
//   // this on `selectedDate` (as it used to) meant clearing the filter left the old date in
//   // storage, and the restore effect above then re-applied it on the next visit: the filter
//   // could be turned on but never off.
//   useEffect(() => {
//     if (isInitialized) {
//       SingleDateFilterStorage.saveDateFilter('load-operations-page', selectedDate);
//     }
//   }, [isInitialized, selectedDate]);

//   // Setup user interaction tracking for the auto-refresh feature
//   useEffect(() => {
//     // Events that indicate user interaction
//     const interactionEvents = ['mousedown', 'mousemove', 'keydown', 'scroll', 'touchstart'];
    
//     // Function to indicate user started interacting
//     const handleInteractionStart = () => {
//       setUserInteracting(true);
//     };
    
//     // Function to indicate user stopped interacting (with debounce)
//     let interactionTimer: ReturnType<typeof setTimeout>;
//     const handleInteractionEnd = () => {
//       clearTimeout(interactionTimer);
//       interactionTimer = setTimeout(() => {
//         setUserInteracting(false);
//       }, 5000); // 5 second debounce
//     };
    
//     // Add event listeners for user interaction
//     interactionEvents.forEach(event => {
//       window.addEventListener(event, handleInteractionStart);
//       window.addEventListener(event, handleInteractionEnd);
//     });
    
//     // Clean up event listeners on unmount
//     return () => {
//       interactionEvents.forEach(event => {
//         window.removeEventListener(event, handleInteractionStart);
//         window.removeEventListener(event, handleInteractionEnd);
//       });
//       clearTimeout(interactionTimer);
//     };
//   }, []);
  
//   // This function used to handle broadcast updates but has been removed
//   // Keeping as a no-op placeholder to avoid breaking existing code
//   const handleBroadcastUpdates = (type: string, data: any, operationId: number) => {
//     // No-op - WebSocket functionality has been completely removed
//     return;
//     // Only update if we're viewing this operation
//     if (selectedOperation && selectedOperation.id === operationId) {
//       if (type === 'LOADED_STATUS_UPDATED' && Array.isArray(data)) {
//         // Handle loaded status updates for items
//         setViewProformaDetails(prev => {
//           if (!prev) return prev;
          
//           // Create a map for fast lookup
//           const updatedItemsMap = data.reduce((map, item) => {
//             if (item.id) {
//               map[item.id] = item;
//             }
//             return map;
//           }, {} as Record<number, any>);
          
//           // Update items with the broadcast data
//           const newItems = prev.items.map(item => {
//             if (item.id && updatedItemsMap[item.id]) {
//               // IMPORTANT: Also update DOM elements directly for immediate visual feedback 
//               // without waiting for React re-render
//               try {
//                 // Update mobile checkbox directly if it exists
//                 const mobileCheckbox = document.getElementById(`confirm-loaded-mobile-${item.id}`) as HTMLInputElement;
//                 if (mobileCheckbox) {
//                   mobileCheckbox.checked = !!updatedItemsMap[item.id].loaded;
//                 }
                
//                 // Update desktop checkbox directly if it exists
//                 const desktopCheckbox = document.getElementById(`confirm-loaded-${item.id}`) as HTMLInputElement;
//                 if (desktopCheckbox) {
//                   desktopCheckbox.checked = !!updatedItemsMap[item.id].loaded;
//                 }
                
//                 // Update mobile card background if it exists
//                 const mobileCard = document.querySelector(`div[data-item-id="basket-mobile-${item.id}"]`);
//                 if (mobileCard) {
//                   if (updatedItemsMap[item.id].loaded) {
//                     mobileCard.classList.add('bg-green-50');
//                   } else {
//                     mobileCard.classList.remove('bg-green-50');
//                   }
//                 }
                
//                 // If quantity is provided, update the input fields directly too
//                 if (updatedItemsMap[item.id].quantity !== undefined) {
//                   const quantityInputMobile = document.getElementById(`item-quantity-mobile-${item.id}`) as HTMLInputElement;
//                   if (quantityInputMobile) {
//                     quantityInputMobile.value = String(updatedItemsMap[item.id].quantity || 0);
//                   }
                  
//                   const quantityInputDesktop = document.getElementById(`item-quantity-${item.id}`) as HTMLInputElement;
//                   if (quantityInputDesktop) {
//                     quantityInputDesktop.value = String(updatedItemsMap[item.id].quantity || 0);
//                   }
//                 }
//               } catch (err) {
//                 console.error(`Error directly updating DOM elements for item ${item.id}:`, err);
//               }
              
//               return {
//                 ...item,
//                 loaded: updatedItemsMap[item.id].loaded,
//                 // Only update quantity if it's provided in the update
//                 ...(updatedItemsMap[item.id].quantity !== undefined ? { quantity: updatedItemsMap[item.id].quantity } : {})
//               };
//             }
//             return item;
//           });
          
//           return {
//             ...prev,
//             items: newItems
//           };
//         });
//       } else if (type === 'ITEM_LOADED_STATUS_UPDATED' && data) {
//         // Handle single item loaded status update from other clients
//         console.log('[BroadcastReceived] Item loaded status update:', data);
        
//         // Extract data from the broadcast message
//         const { itemId, loaded, referenceNumber } = data;
        
//         if (itemId !== undefined && loaded !== undefined) {
//           // Update the UI to reflect the changes
//           setViewProformaDetails(prev => {
//             if (!prev) return prev;
            
//             // Find and update the specific item
//             const updatedItems = prev.items.map(item => 
//               item.id === itemId ? { ...item, loaded } : item
//             );
            
//             // Sort items (unloaded first, loaded last) to maintain consistent view
//             return {
//               ...prev,
//               items: [
//                 ...updatedItems.filter(i => !i.loaded),
//                 ...updatedItems.filter(i => i.loaded)
//               ]
//             };
//           });
          
//           // Update DOM elements directly for immediate visual feedback
//           try {
//             // Update mobile checkbox directly
//             const mobileCheckbox = document.getElementById(`confirm-loaded-mobile-${itemId}`) as HTMLInputElement;
//             if (mobileCheckbox) {
//               mobileCheckbox.checked = loaded;
//             }
            
//             // Update desktop checkbox directly
//             const desktopCheckbox = document.getElementById(`confirm-loaded-${itemId}`) as HTMLInputElement;
//             if (desktopCheckbox) {
//               desktopCheckbox.checked = loaded;
//             }
            
//             // Update basket checkbox
//             const basketCheckbox = document.getElementById(`basket-confirm-loaded-${itemId}`) as HTMLInputElement;
//             if (basketCheckbox) {
//               basketCheckbox.checked = loaded;
//             }
            
//             // Update mobile card background
//             const mobileCard = document.querySelector(`div[data-item-id="basket-mobile-${itemId}"]`);
//             if (mobileCard) {
//               if (loaded) {
//                 mobileCard.classList.add('bg-green-50');
//               } else {
//                 mobileCard.classList.remove('bg-green-50');
//               }
//             }
//           } catch (err) {
//             console.error(`Error directly updating DOM elements for item ${itemId}:`, err);
//           }
          
//           // Update the cache for this proforma item
//           if (referenceNumber) {
//             updateProformaSlipItemCache(referenceNumber, itemId, loaded);
//           }
//         }
//       } else if (type === 'ITEM_QUANTITY_UPDATED' && data) {
//         // Handle item quantity updates from other clients
//         console.log('Received ITEM_QUANTITY_UPDATED broadcast:', data);
        
//         // Extract data from the broadcast message
//         const { itemId, newQuantity, originalQuantity, referenceNumber, isNewlyAdded: broadcastNewlyAdded } = data;
        
//         // Update the newly added items tracking in localStorage
//         if (referenceNumber) {
//           try {
//             // Key for newly added items
//             const newItemsKey = `proforma-new-items-${referenceNumber.trim()}`;
//             let newlyAddedItems: number[] = [];
            
//             // Get existing newly added items list
//             const storedNewItems = localStorage.getItem(newItemsKey);
//             if (storedNewItems) {
//               newlyAddedItems = JSON.parse(storedNewItems);
//             }
            
//             // If the broadcast indicates this is a newly added item and it's not in our local list, add it
//             if (broadcastNewlyAdded && !newlyAddedItems.includes(itemId)) {
//               newlyAddedItems.push(itemId);
//               localStorage.setItem(newItemsKey, JSON.stringify(newlyAddedItems));
//               console.log(`Added item ${itemId} to newly added items list from quantity update broadcast`);
              
//               // Invalidate related queries to ensure data consistency across devices
//               queryClient.invalidateQueries({ 
//                 queryKey: [`/api/proforma-slips/order/${encodeURIComponent(referenceNumber)}`],
//                 refetchType: 'active'
//               });
//             }
            
//             // Also get original quantities from storage
//             const storageKey = `proforma-original-quantities-${referenceNumber.trim()}`;
//             let storedOriginalQuantities: Record<number, number> = {};
            
//             const storedData = localStorage.getItem(storageKey);
//             if (storedData) {
//               storedOriginalQuantities = JSON.parse(storedData);
//             }
            
//             // Check if item is newly added (its originalQuantity should be 0)
//             const isNewlyAdded = newlyAddedItems.includes(itemId) || broadcastNewlyAdded;
            
//             // If the broadcast included originalQuantity info and it's not already stored, update storage
//             if (originalQuantity !== undefined && (!storedOriginalQuantities[itemId] || isNewlyAdded)) {
//               storedOriginalQuantities[itemId] = isNewlyAdded ? 0 : originalQuantity;
//               localStorage.setItem(storageKey, JSON.stringify(storedOriginalQuantities));
//               console.log(`Stored original quantity for item ${itemId} from broadcast: ${storedOriginalQuantities[itemId]}`);
//             }
            
//             // Update UI state
//             setViewProformaDetails(prev => {
//               if (!prev) return prev;
              
//               // Update the item in the array with the new quantity
//               const updatedItems = prev.items.map(item => {
//                 if (item.id === itemId) {
//                   // Determine the correct original quantity to use
//                   const correctOriginalQty = isNewlyAdded 
//                     ? 0 // Newly added items have originalQuantity=0
//                     : (storedOriginalQuantities[itemId] !== undefined
//                         ? storedOriginalQuantities[itemId] // Use stored value if available
//                         : (originalQuantity !== undefined 
//                             ? originalQuantity  // Use broadcast value if provided
//                             : item.originalQuantity)); // Fallback to current value
                  
//                   // IMPORTANT: Also update DOM elements directly for immediate visual feedback
//                   try {
//                     // Update mobile quantity input directly if it exists
//                     const mobileQuantityInput = document.getElementById(`item-quantity-mobile-${itemId}`) as HTMLInputElement;
//                     if (mobileQuantityInput) {
//                       mobileQuantityInput.value = String(newQuantity || 0);
//                     }
                    
//                     // Update desktop quantity input directly if it exists
//                     const desktopQuantityInput = document.getElementById(`item-quantity-${itemId}`) as HTMLInputElement;
//                     if (desktopQuantityInput) {
//                       desktopQuantityInput.value = String(newQuantity || 0);
//                     }
                    
//                     // Update any displayed quantity indicators or totals
//                     const quantityDisplays = document.querySelectorAll(`[data-quantity-display="${itemId}"]`);
//                     quantityDisplays.forEach(display => {
//                       display.textContent = String(newQuantity || 0);
//                     });
                    
//                     console.log(`[Fast Sync] Directly updated DOM elements for item ${itemId} quantity to ${newQuantity}`);
//                   } catch (err) {
//                     console.error(`Error directly updating DOM elements for item ${itemId} quantity:`, err);
//                   }
                  
//                   return {
//                     ...item,
//                     quantity: newQuantity,
//                     originalQuantity: correctOriginalQty
//                   };
//                 }
//                 return item;
//               });
              
//               return {
//                 ...prev,
//                 items: updatedItems
//               };
//             });
//           } catch (err) {
//             console.error('Error processing quantity update from broadcast:', err);
//           }
//         }
//       } else if (type === 'NEW_ITEM_ADDED' && data && data.itemId) {
//         console.log('Received NEW_ITEM_ADDED broadcast:', data);
        
//         // Handle newly added item
//         const { itemId, quantity, originalQuantity, isNewlyAdded, referenceNumber } = data;
        
//         // Update the newly added items in localStorage
//         if (isNewlyAdded && referenceNumber) {
//           try {
//             const newItemsKey = `proforma-new-items-${referenceNumber.trim()}`;
//             let newlyAddedItems: number[] = [];
            
//             const storedNewItems = localStorage.getItem(newItemsKey);
//             if (storedNewItems) {
//               newlyAddedItems = JSON.parse(storedNewItems);
//             }
            
//             if (!newlyAddedItems.includes(itemId)) {
//               newlyAddedItems.push(itemId);
//               localStorage.setItem(newItemsKey, JSON.stringify(newlyAddedItems));
//               console.log(`Added item ${itemId} to newly added items list from broadcast`);
              
//               // Invalidate related queries to ensure data consistency across devices
//               queryClient.invalidateQueries({ 
//                 queryKey: [`/api/proforma-slips/order/${encodeURIComponent(referenceNumber)}`],
//                 refetchType: 'active'
//               });
//             }
            
//             // Also update the original quantities storage
//             const storageKey = `proforma-original-quantities-${referenceNumber.trim()}`;
//             let storedOriginalQuantities: Record<number, number> = {};
            
//             const storedData = localStorage.getItem(storageKey);
//             if (storedData) {
//               storedOriginalQuantities = JSON.parse(storedData);
//             }
            
//             // Set the original quantity to 0 for newly added items
//             storedOriginalQuantities[itemId] = 0;
//             localStorage.setItem(storageKey, JSON.stringify(storedOriginalQuantities));
//             console.log(`Updated original quantities for new item ${itemId} with quantity ${quantity} from broadcast`);
//           } catch (err) {
//             console.error('Error updating localStorage from broadcast:', err);
//           }
//         }
        
//         // First attempt to add the new item directly to the DOM for immediate display
//         // while the fetch is in progress
//         try {
//           // Create and append a temporary element for the new item 
//           // if we have enough info from the broadcast
//           if (data.productName && data.sku && selectedOperation?.referenceNumber) {
//             // Find the container where items are displayed
//             const mobileItemsContainer = document.querySelector('[data-items-container="mobile"]');
//             const desktopItemsContainer = document.querySelector('[data-items-container="desktop"]');
            
//             if (mobileItemsContainer) {
//               // Create a temporary UI element for mobile view
//               const tempElement = document.createElement('div');
//               tempElement.className = 'p-3 mb-2 border rounded-lg relative animate-pulse bg-yellow-50';
//               tempElement.setAttribute('data-temp-item-id', `temp-${itemId}`);
//               tempElement.innerHTML = `
//                 <div class="flex items-center justify-between">
//                   <div class="flex-1">
//                     <div class="font-medium">${data.productName}</div>
//                     <div class="text-sm text-gray-500">SKU: ${data.sku}</div>
//                     <div class="text-sm">Quantity: ${quantity || 0}</div>
//                   </div>
//                   <div class="flex items-center space-x-2">
//                     <span class="text-xs bg-yellow-200 px-2 py-1 rounded">New Item</span>
//                   </div>
//                 </div>
//               `;
              
//               // Insert at the top for visibility
//               mobileItemsContainer.insertBefore(tempElement, mobileItemsContainer.firstChild);
              
//               console.log(`[Fast Sync] Added temporary UI element for new item ${itemId}`);
//             }
            
//             if (desktopItemsContainer) {
//               // Create a temporary row for desktop view
//               const tempRow = document.createElement('tr');
//               tempRow.className = 'animate-pulse bg-yellow-50';
//               tempRow.setAttribute('data-temp-item-id', `temp-${itemId}`);
//               tempRow.innerHTML = `
//                 <td class="p-2 text-center">-</td>
//                 <td class="p-2">${data.productName}</td>
//                 <td class="p-2">${data.sku || ''}</td>
//                 <td class="p-2 text-center">${quantity || 0}</td>
//                 <td class="p-2 text-center">0</td>
//                 <td class="p-2 text-center" colspan="2">
//                   <span class="text-xs bg-yellow-200 px-2 py-1 rounded">New Item</span>
//                 </td>
//               `;
              
//               // Insert at the top for visibility
//               if (desktopItemsContainer.querySelector('tbody')) {
//                 desktopItemsContainer.querySelector('tbody')?.insertBefore(tempRow, desktopItemsContainer.querySelector('tbody')?.firstChild);
//               } else {
//                 desktopItemsContainer.insertBefore(tempRow, desktopItemsContainer.firstChild);
//               }
              
//               console.log(`[Fast Sync] Added temporary UI row for new item ${itemId}`);
//             }
//           }
//         } catch (err) {
//           console.error('Error creating temporary UI element for new item:', err);
//         }
        
//         // Then refresh the slip details to show the new item properly
//         if (selectedOperation?.referenceNumber) {
//           fetchLoadOperationDetails(selectedOperation.referenceNumber, selectedOperation.id)
//             .then(details => {
//               if (details) {
//                 setViewProformaDetails(details);
                
//                 // Remove any temporary elements after the real data is loaded
//                 setTimeout(() => {
//                   document.querySelectorAll(`[data-temp-item-id="temp-${itemId}"]`).forEach(el => {
//                     el.remove();
//                   });
//                 }, 300);
//               }
//             })
//             .catch(err => {
//               console.error('Error refreshing operation details after new item added:', err);
//             });
//         }
//       } else if (type === 'OPERATION_STATUS_UPDATED' && data) {
//         // Handle operation status updates
//         console.log('[BroadcastReceived] Operation status update:', data);
        
//         // Update local state first
//         setViewProformaDetails(prev => {
//           if (!prev) return prev;
          
//           // Update the operation status and vehicle/driver info
//           return {
//             ...prev,
//             slip: {
//               ...prev.slip,
//               vehicleNumber: data.vehicleNumber || prev.slip.vehicleNumber,
//               driverName: data.driverName || prev.slip.driverName
//             },
//             operation: {
//               ...prev.operation,
//               status: data.status || prev.operation?.status
//             }
//           };
//         });
        
//         // Also update the selected operation status
//         setSelectedOperation(prev => {
//           if (!prev) return prev;
//           return {
//             ...prev,
//             status: data.status || prev.status
//           };
//         });
        
//         // Important: Invalidate React Query cache to ensure data consistency across devices
//         // First, cancel any in-flight requests to avoid race conditions
//         queryClient.cancelQueries({ queryKey: ['/api/loading-operations'] });
        
//         // Then invalidate the cache and fetch fresh data with stronger invalidation
//         queryClient.invalidateQueries({ 
//           queryKey: ['/api/loading-operations'],
//           refetchType: 'all' // Force all queries to refetch, not just active ones
//         });
        
//         // Also invalidate status count queries if they exist
//         queryClient.invalidateQueries({ 
//           queryKey: ['/api/loading-operations/status/count'],
//           refetchType: 'all' // Force all status count queries to refetch
//         });
        
//         // Log the invalidation for debugging
//         console.log('[BroadcastReceived] Forcefully invalidated all loading operations queries');
        
//         // Update proformaSlipsData for immediate UI reflection without waiting for refetch
//         if (data.vehicleNumber || data.driverName) {
//           // Get reference number directly from the selected operation or the operations list
//           let referenceNumber = null;
          
//           // If we're already editing an operation, use its reference number
//           if (selectedOperation && selectedOperation.id === operationId) {
//             referenceNumber = selectedOperation.referenceNumber;
//           } else if (data && Array.isArray(data)) {
//             // Try to find the operation in the loaded data
//             // Type guard to ensure data is a proper array with operations
//             const operation = (data as LoadOperationType[]).find((op: LoadOperationType) => op.id === operationId);
//             if (operation) {
//               referenceNumber = operation.referenceNumber;
//             }
//           }
          
//           if (referenceNumber && proformaSlipsData[referenceNumber]) {
//             setProformaSlipsData(prev => {
//               const refData = prev[referenceNumber];
//               if (!refData || !refData.slip) return prev;
              
//               return {
//                 ...prev,
//                 [referenceNumber]: {
//                   ...refData,
//                   slip: {
//                     ...refData.slip,
//                     vehicleNumber: data.vehicleNumber || refData.slip.vehicleNumber,
//                     driverName: data.driverName || refData.slip.driverName
//                   },
//                   // Make sure we preserve the items array
//                   items: refData.items || []
//                 }
//               };
//             });
            
//             console.log(`Updated vehicle number in proformaSlipsData for ${referenceNumber}: ${data.vehicleNumber}`);
//           }
//         }
        
//         // Update main operations list
//         refetchRef.current();
//       }
//     } else if (type === 'OPERATION_CREATED') {
//       // Handle new operation created event
//       console.log(`[BroadcastReceived] New operation created: ${data?.referenceNumber || 'Unknown'}`);
      
//       // Don't refresh while viewing an operation's details
//       if (!selectedOperation) {
//         // Log the timestamp for performance monitoring
//         console.log(`[BroadcastReceived] Received at ${new Date().toISOString()}`);
        
//         // OPTIMIZATION: Don't wait for promises to resolve sequentially
//         // Cancel any in-flight requests immediately
//         queryClient.cancelQueries({ queryKey: ['/api/loading-operations'] });
        
//         // Force immediate invalidation with stronger cache settings
//         queryClient.invalidateQueries({ 
//           queryKey: ['/api/loading-operations'],
//           refetchType: 'all' // Force all queries to refetch, not just active ones
//         });
        
//         // Force immediate refetch without waiting
//         refetchRef.current()
//           .then(newData => {
//             console.log(`[BroadcastReceived] Refetch completed at ${new Date().toISOString()}`);
//             console.log(`[BroadcastReceived] Operation data refreshed successfully`);
            
//             // Force update of operation counts to refresh tabs
//             queryClient.invalidateQueries({ 
//               queryKey: ['/api/loading-operations/status/count'],
//               refetchType: 'all'
//             });
            
//             // If we have reference number, prefetch the proforma slip data
//             if (data?.referenceNumber) {
//               // Use the batch endpoint to fetch the proforma slip data
//               fetch('/api/proforma-slips/batch', {
//                 method: 'POST',
//                 headers: {
//                   'Content-Type': 'application/json',
//                 },
//                 body: JSON.stringify({ orderNumbers: [data.referenceNumber] }),
//               })
//                 .then(res => res.json())
//                 .then(batchResults => {
//                   // Update the proformaSlipsData state directly
//                   if (batchResults[data.referenceNumber]?.slip) {
//                     setProformaSlipsData(prev => ({
//                       ...prev,
//                       ...batchResults
//                     }));
//                     console.log(`[BroadcastReceived] Prefetched proforma data for ${data.referenceNumber}`);
//                   }
//                 })
//                 .catch(err => {
//                   console.error('[BroadcastReceived] Error prefetching proforma data:', err);
//                 });
//             }
//           })
//           .catch(err => {
//             console.error('[BroadcastReceived] Error during refetch:', err);
//           });
        
//         toast({
//           title: "New Operation Created",
//           description: `Load slip for Order #${data?.referenceNumber || ''} was created on another device`,
//         });
//       }
//     }
//   };
  
//   // Get current user from localStorage and set permissions
//   useEffect(() => {
//     const fetchAndSetUser = async () => {
//       // Try to get current user from localStorage
//       const currentUserJson = localStorage.getItem('currentUser');
//       let currentUser = null;
//       console.log("Fetching current user from localStorage:", currentUserJson);
//       let userId = 0;

//       if (currentUserJson) {
//         try {
//           currentUser = JSON.parse(currentUserJson);
//           setUserId(currentUser.userCode || 0);
//           setUserRole(currentUser.role || "user");
//           setUserName(currentUser.name || currentUser.username || "");
//           setUserDesignation(currentUser.designation || "");
//           setUserDepartment(currentUser.department || "");
//           userId = currentUser.userCode || 0;
//         } catch (error) {
//           console.error("Error parsing current user:", error);
//         }
//       }
//       console.log("current user",currentUser);
//       // If no user found in localStorage or userId is 0, fetch the first available user
//       if (!currentUser || userId === 0) {
//         console.log("Current user",currentUser);
//         try {
//           console.log("No valid user ID found in localStorage, fetching users...");
//           const response = await apiRequest('GET', '/api/users');
//           const users = await response.json();
          
//           if (users && users.length > 0) {
//             const firstUser = users[0];
//             console.log("Found existing user:", firstUser);
//             setUserId(firstUser.id);
//             setUserRole(firstUser.role || "user");
//             setUserName(firstUser.name || firstUser.username || "");
//             setUserDesignation(firstUser.designation || "");
//             setUserDepartment(firstUser.department || "");
            
//             // Save to localStorage for future use
//             // localStorage.setItem('currentUser', JSON.stringify(firstUser));
//           } else {
//             console.log("No users found in the system, creating a default user...");
//             // Create a default user if none exists
//             try {
//               const createResponse = await apiRequest('POST', '/api/users', {
//                 username: "admin",
//                 password: "admin123",
//                 name: "Admin User",
//                 role: "admin",
//                 department: "MANAGEMENT",
//                 designation: "Admin"
//               });
              
//               if (createResponse.ok) {
//                 const newUser = await createResponse.json();
//                 console.log("Created default user:", newUser);
//                 setUserId(newUser.id);
//                 setUserRole(newUser.role || "admin");
//                 setUserName(newUser.name || newUser.username || "Admin User");
//                 setUserDesignation(newUser.designation || "Admin");
//                 setUserDepartment(newUser.department || "MANAGEMENT");
                
//                 // Save to localStorage for future use
//                 localStorage.setItem('currentUser', JSON.stringify(newUser));
//               }
//             } catch (createError) {
//               console.error("Error creating default user:", createError);
//             }
//           }
//         } catch (error) {
//           console.error("Error fetching users:", error);
//         }
//       }
      
//       // Set permissions based on user role and designation
//       const permissions = getCurrentUserPermissions();
//       setUserPermissions(permissions);
//     };
    
//     fetchAndSetUser();
//   }, []);
//   // Removed pagination limit
//   const { toast } = useToast();

//   // Auto-refresh interval in milliseconds (30 seconds)
//   // Reduced refresh interval for more frequent updates, especially on mobile
//   const AUTO_REFRESH_INTERVAL = 15000; // 15 seconds for faster updates
//   const MOBILE_REFRESH_INTERVAL = 10000; // Even faster refresh for mobile
  
//   // Track if user is currently interacting with the page
//   // User interaction tracking variable already defined
  
//   // Reference to store the last refresh timestamp
//   const lastRefreshTimeRef = useRef<number>(Date.now());
  
//   // Reference to track order numbers being processed in batches
//   const orderNumbersInProgress = useRef<Set<string>>(new Set());
  
//   // State for backup loading operations
//   const [backupData, setBackupData] = useState<LoadOperationType[]>([]);
//   const [showBackupData, setShowBackupData] = useState(false);
  
//   // Reference to track user interaction timer
//   const interactionTimerRef = useRef<NodeJS.Timeout | null>(null);
  
//   // Fetch backup data
//   const { data: backupOperations, isLoading: isBackupLoading } = useQuery<LoadOperationType[]>({
//     queryKey: ['/api/backup/loading-operations'],
//     queryFn: async () => {
//       const res = await apiRequest('GET', `/api/backup/loading-operations?limit=1000`);
//       const responseData = await res.json();
//       // Update state when data is fetched
//       setBackupData(responseData || []);
//       return responseData;
//     },
//     // Don't auto-refresh backup data as frequently
//     refetchInterval: userInteracting ? false : AUTO_REFRESH_INTERVAL * 2,
//     refetchOnWindowFocus: false
//   });
  
//   // Setup user interaction tracking
//   useEffect(() => {
//     // Function to check for user interactions
//     const handleUserInteraction = () => {
//       setUserInteracting(true);
      
//       // Use debounce to reset the flag after 5 seconds of no interaction
//       if (interactionTimerRef.current) {
//         clearTimeout(interactionTimerRef.current);
//       }
      
//       interactionTimerRef.current = setTimeout(() => {
//         setUserInteracting(false);
//       }, 5000); // 5 seconds
//     };
    
//     // Add event listeners for common user interactions
//     window.addEventListener('mousemove', handleUserInteraction);
//     window.addEventListener('keydown', handleUserInteraction);
//     window.addEventListener('scroll', handleUserInteraction);
//     window.addEventListener('touchstart', handleUserInteraction);
//     window.addEventListener('click', handleUserInteraction);
    
//     // Cleanup function
//     return () => {
//       if (interactionTimerRef.current) {
//         clearTimeout(interactionTimerRef.current);
//       }
//       window.removeEventListener('mousemove', handleUserInteraction);
//       window.removeEventListener('keydown', handleUserInteraction);
//       window.removeEventListener('scroll', handleUserInteraction);
//       window.removeEventListener('touchstart', handleUserInteraction);
//       window.removeEventListener('click', handleUserInteraction);
//     };
//   }, []);
  
//   // Detect if we're on a mobile device for optimized data fetching
//   const isMobileDevice = useMemo(() => {
//     return window.innerWidth <= 768 || /iPhone|iPad|iPod|Android/i.test(navigator.userAgent);
//   }, []);
  
//   // Function to calculate total loaded quantity for an operation
//   const calculateTotalLoadedQuantity = async (operationId: number): Promise<number> => {
//     try {
//       const response = await apiRequest('GET', `/api/loading-operations/${operationId}/items`);
//       const items = await response.json();
      
//       if (!Array.isArray(items) || items.length === 0) {
//         return 0;
//       }
      
//       // Sum up all loadedQuantity values for items that are marked as loaded
//       const totalLoaded = items.reduce((sum, item) => {
//         // Make sure loaded is a boolean
//         const isLoaded = item.loaded === true || item.loaded === 1;
//         // Only count loadedQuantity for items marked as loaded
//         if (isLoaded && item.loadedQuantity !== undefined && item.loadedQuantity !== null) {
//           return sum + (parseInt(item.loadedQuantity) || 0);
//         }
//         return sum;
//       }, 0);
      
//       return totalLoaded;
//     } catch (error) {
//       console.error(`Error calculating loaded quantity for operation ${operationId}:`, error);
//       return 0;
//     }
//   };
  
//   // Calculate total loaded, extra, and remaining quantities from items in memory 
//   // This function synchronously calculates from the viewProformaDetails data for immediate UI feedback
//   const calculateSummaryFromViewItems = (items: ProformaSlipItem[], referenceNumber: string | null | undefined): { loaded: number, extra: number, remaining: number } => {
//     if (!items || !Array.isArray(items)) {
//       return { loaded: 0, extra: 0, remaining: 0 };
//     }
    
//     // Calculate loaded quantity from items that are marked as loaded
//     // Use loadedQuantity if available (which should match quantity when an item is loaded)
//     const loadedQty = items.reduce((sum, item) => {
//       // Only count quantity for items marked as loaded
//       if (item.loaded) {
//         // Use the actual loadedQuantity value for the total if available
//         const qtyToAdd = item.loadedQuantity !== undefined && item.loadedQuantity !== null 
//           ? item.loadedQuantity 
//           : (item.quantity || 0);
        
//         return sum + qtyToAdd;
//       }
//       return sum;
//     }, 0);
    
//     // Extra quantity calculation (explicitly pass referenceNumber)
//     const extraQty = calculateExtraQuantity(items, referenceNumber);
    
//     // Remaining quantity calculation (explicitly pass referenceNumber)
//     const remainingQty = calculateRemainingQuantity(items, referenceNumber);
    
//     return { 
//       loaded: loadedQty,
//       extra: extraQty,
//       remaining: remainingQty
//     };
//   };
  
//   // Create a separate component for basket summary to ensure proper updates
//   interface BasketSummaryProps {
//     items: ProformaSlipItem[];
//     referenceNumber: string | null | undefined;
//     calculateSummary: (items: ProformaSlipItem[], ref: string | null | undefined) => { loaded: number; extra: number; remaining: number };
//     forceUpdateCounter?: number; // Added to force re-render on external changes
//   }
  
//   // Enhanced BasketSummary component with direct calculation and deep item tracking
//   const BasketSummary = ({ items, referenceNumber, calculateSummary, forceUpdateCounter }: BasketSummaryProps) => {
//     // Calculate loaded value directly by examining each item's loaded state and quantity
//     // This ensures we get a real-time calculation rather than relying on cached values
//     const loaded = items.reduce((sum, item) => {
//       if (item.loaded) {
//         // Use loadedQuantity if available, otherwise fall back to quantity
//         const qtyToAdd = item.loadedQuantity !== undefined && item.loadedQuantity !== null 
//           ? item.loadedQuantity 
//           : (item.quantity || 0);
        
//         return sum + qtyToAdd;
//       }
//       return sum;
//     }, 0);
    
//     // Calculate extra and remaining using the full calculation function
//     const summary = calculateSummary(items, referenceNumber);
    
//     // Use the directly calculated loaded value for more responsive UI
//     const displayValues = {
//       loaded: loaded, 
//       extra: summary.extra,
//       remaining: summary.remaining
//     };
    
//     // Log the current state for debugging
//     useEffect(() => {
//       console.log(`BasketSummary re-rendered with: loaded=${displayValues.loaded}, extra=${displayValues.extra}, remaining=${displayValues.remaining}, items count=${items.length}`);
      
//       // Debug loaded items
//       const loadedItems = items.filter(item => item.loaded);
//       console.log(`Currently loaded items: ${loadedItems.length}`);
//       loadedItems.forEach(item => {
//         console.log(`  Item ${item.id}: loaded=${item.loaded}, quantity=${item.quantity}, loadedQuantity=${item.loadedQuantity}`);
//       });
//     }, [items, displayValues, forceUpdateCounter]);
    
//     return (
//       <>
//         <div className="bg-green-50 border border-green-200 rounded-lg p-3 flex flex-col items-center">
//           <span className="text-xs text-green-700">Loaded</span>
//           <span className="text-lg font-semibold text-green-700">{displayValues.loaded}</span>
//         </div>
//         <div className="bg-blue-50 border border-blue-200 rounded-lg p-3 flex flex-col items-center">
//           <span className="text-xs text-blue-700">Extra</span>
//           <span className="text-lg font-semibold text-blue-700">{displayValues.extra}</span>
//         </div>
//         <div className="bg-amber-50 border border-amber-200 rounded-lg p-3 flex flex-col items-center">
//           <span className="text-xs text-amber-700">Remaining</span>
//           <span className="text-lg font-semibold text-amber-700">{displayValues.remaining}</span>
//         </div>
//       </>
//     );
//   };

//   // Fetch all loading operations with optimized strategy for mobile
//   const { data, isLoading, isFetching, refetch: rawRefetch } = useQuery<LoadOperationType[]>({
//     queryKey: ['/api/loading-operations'],
//     queryFn: async () => {
//       // On mobile, we fetch fewer operations initially for faster response
//       const limit = isMobileDevice ? 500 : 1000;
//       const url = `/api/loading-operations?limit=${limit}`;
//       console.log(`Loading Operations request with params: limit=${limit}, offset=0, no date filtering (mobile: ${isMobileDevice})`);
      
//       // Make the API request with timeout handling for mobile
//       const controller = new AbortController();
//       const timeoutId = setTimeout(() => controller.abort(), 15000); // 15 second timeout for mobile
      
//       try {
//         const res = await apiRequest('GET', url, undefined, { signal: controller.signal });
//         lastRefreshTimeRef.current = Date.now();
        
//         // Log performance metrics
//         const results = await res.json();
//         const fetchTime = Date.now() - lastRefreshTimeRef.current;
//         console.log(`Returning ${results.length} load operations with no date filtering (fetch time: ${fetchTime}ms)`);
        
//         // For operations with READY≈DESP status, calculate and add totalLoadedQuantity
//         // We do this asynchronously to not block the initial render
//         if (Array.isArray(results) && results.length > 0) {
//           // First, return results immediately so UI can render
//           setTimeout(async () => {
//             // Start with the first 25 operations to improve performance
//             const operationsToProcess = results.slice(0, 25);
            
//             for (const operation of operationsToProcess) {
//               if (operation.id) {
//                 const totalLoadedQty = await calculateTotalLoadedQuantity(operation.id);
                
//                 // Update the React Query cache with the enhanced operation
//                 queryClient.setQueryData(['/api/loading-operations'], (oldData: any) => {
//                   if (!Array.isArray(oldData)) return oldData;
                  
//                   return oldData.map(op => {
//                     if (op.id === operation.id) {
//                       return { ...op, totalLoadedQuantity: totalLoadedQty };
//                     }
//                     return op;
//                   });
//                 });
//               }
//             }
            
//             console.log(`Enhanced ${operationsToProcess.length} operations with totalLoadedQuantity`);
//           }, 100);
//         }
        
//         return results;
//       } catch (error) {
//         // If request times out or fails on mobile, try to return cached data
//         console.error('Error fetching load operations:', error);
        
//         if (isMobileDevice && queryClient.getQueryData(['/api/loading-operations'])) {
//           console.log('Using cached data for mobile due to fetch error');
//           return queryClient.getQueryData(['/api/loading-operations']);
//         }
//         throw error;
//       } finally {
//         clearTimeout(timeoutId);
//       }
//     },
//     // Enable auto-refresh with different intervals based on device type
//     refetchInterval: userInteracting ? false : (isMobileDevice ? MOBILE_REFRESH_INTERVAL : AUTO_REFRESH_INTERVAL),
//     // Don't refetch on window focus to avoid disrupting user work
//     refetchOnWindowFocus: false,
//     // Optimize stale time based on device
//     staleTime: isMobileDevice ? MOBILE_REFRESH_INTERVAL : AUTO_REFRESH_INTERVAL * 2,
//     // Use cacheTime to keep data in cache longer when navigating away
//     gcTime: 1000 * 60 * 10, // Keep cache for 10 minutes even when component unmounts
//     // Initialize with previous data while loading to prevent blank table on refetch
//     placeholderData: (prev) => prev,
//   });
  
//   // Store the refetch function in our ref for use throughout the component
//   useEffect(() => {
//     if (rawRefetch) {
//       refetchRef.current = rawRefetch;
//     }
//   }, [rawRefetch]);
  
//   // State for assigned operations filter
//   const [showAssignedOnly, setShowAssignedOnly] = useState(false);
  
//   // Reference to track if background loading should be paused
//   const shouldPauseBackgroundLoading = useRef(false);

//   // Function to preload all operations data in the background for faster navigation
//   const preloadAllOperationsData = async (operations: LoadOperationType[]) => {
//     // Skip background loading if the dialog is open or if explicitly paused
//     if (isOrderLookupDialogOpen || shouldPauseBackgroundLoading.current) {
//       console.log('Skipping background data preloading because a dialog is open');
//       return;
//     }
    
//     // Prioritize operations with references
//     const operationsWithRef = operations.filter(op => op.referenceNumber);
    
//     // Start with just the first 10 operations to reduce network load
//     const batchSize = 10; // Reduced from 25 to 10
//     const initialBatch = operationsWithRef.slice(0, batchSize);
    
//     // Preload data for initial batch of operations
//     for (const operation of initialBatch) {
//       // Check again if loading should pause (in case dialog opens during processing)
//       if (isOrderLookupDialogOpen || shouldPauseBackgroundLoading.current) {
//         console.log('Pausing background data preloading because a dialog opened');
//         return;
//       }
      
//       if (operation.referenceNumber) {
//         try {
//           // Skip if we already have the data cached
//           if (proformaSlipsData[operation.referenceNumber]) {
//             continue;
//           }
          
//           // Fetch in background - don't await
//           fetchLoadOperationDetails(operation.referenceNumber, operation.id)
//             .then(details => {
//               // Cache the result in memory if the dialog isn't open
//               if (details && !isOrderLookupDialogOpen && !shouldPauseBackgroundLoading.current) {
//                 setProformaSlipsData(prev => ({
//                   ...prev,
//                   [operation.referenceNumber!]: details
//                 }));
//               }
//             })
//             .catch(err => {
//               console.error(`Error preloading data for operation ${operation.id} (${operation.referenceNumber}):`, err);
//             });
//         } catch (err) {
//           console.error(`Error in preload loop for operation ${operation.id}:`, err);
//         }
//       }
//     }
    
//     // Set up a task to process remaining operations in batches with delays
//     // Only if dialog is not open
//     if (!isOrderLookupDialogOpen && !shouldPauseBackgroundLoading.current) {
//       setTimeout(() => {
//         // Check again if loading should be paused
//         if (isOrderLookupDialogOpen || shouldPauseBackgroundLoading.current) {
//           console.log('Canceling background batch processing because a dialog is open');
//           return;
//         }
        
//         const remainingOperations = operationsWithRef.slice(batchSize);
//         let currentIndex = 0;
        
//         // Process remaining operations in smaller batches with delays
//         const processBatch = async () => {
//           // Always check if we should cancel before processing each batch
//           if (isOrderLookupDialogOpen || shouldPauseBackgroundLoading.current) {
//             console.log('Canceling background batch processing because a dialog is open');
//             return;
//           }
          
//           const batch = remainingOperations.slice(currentIndex, currentIndex + 5); // Reduced from 10 to 5
//           currentIndex += 5;
          
//           for (const operation of batch) {
//             // Check again before each item
//             if (isOrderLookupDialogOpen || shouldPauseBackgroundLoading.current) {
//               return;
//             }
            
//             if (operation.referenceNumber && !proformaSlipsData[operation.referenceNumber]) {
//               fetchLoadOperationDetails(operation.referenceNumber, operation.id)
//                 .then(details => {
//                   // Only cache the result if dialog isn't open
//                   if (details && !isOrderLookupDialogOpen && !shouldPauseBackgroundLoading.current) {
//                     setProformaSlipsData(prev => ({
//                       ...prev,
//                       [operation.referenceNumber!]: details
//                     }));
//                   }
//                 })
//                 .catch(err => {
//                   console.error(`Error preloading data for operation ${operation.id} (${operation.referenceNumber}):`, err);
//                 });
//             }
//           }
          
//           // Continue processing if more operations left and dialog isn't open
//           if (currentIndex < remainingOperations.length && !isOrderLookupDialogOpen && !shouldPauseBackgroundLoading.current) {
//             setTimeout(processBatch, 3000); // Increased from 2 to 3 seconds between batches
//           }
//         };
        
//         // Start processing the batches
//         processBatch();
//       }, 5000);
//     } // Start processing the remaining operations after a 5 second delay
//   };
  
//   // Effect to preload operations data for faster navigation
//   useEffect(() => {
//     const preloadAllData = async () => {
//       if (data && Array.isArray(data)) {
//         console.log(`Starting background preload of ${data.length} operations' proforma data...`);
        
//         // Preload all operations data in the background
//         preloadAllOperationsData(data)
//           .then(() => {
//             console.log("Successfully preloaded all operations data in background");
//           })
//           .catch(err => {
//             console.error("Error preloading operations data:", err);
//           });
//       }
//     };
    
//     // Only start preloading if we have data and we're not already loading
//     if (data && Array.isArray(data) && !isLoading && !isFetching) {
//       preloadAllData();
//     }
//   }, [data, isLoading, isFetching]);

//   // Function to handle operations filter changes
//   const handleOperationsFilterChange = (filters) => {
//     // Set the assigned operations filter
//     setShowAssignedOnly(filters.assignedToMe);
    
//     // You can handle other filters here if needed
//     if (filters.status) {
//       setActiveViewTab(filters.status.toLowerCase() === "loading" ? "loading" : 
//                        filters.status.toLowerCase() === "ready≈desp" ? "ready-desp" : "overall");
//     }
//   };

//   // Calculate filtered operations for multiple delete feature and table display
//   const filteredOperations = useMemo(() => {
//     if (!data) return [];
    
//     return data.filter(operation => {
//       // Apply new date filter - SingleDateFilter takes precedence over dropdown
//       if (isDateFilterActive && selectedDate) {
//         // First try to get the date from proforma slip data
//         let orderDate = operation.referenceNumber && 
//           proformaSlipsData[operation.referenceNumber]?.slip?.orderDate;
        
//         // If no order date is found in proforma data, use the operation's createdAt date
//         // This ensures newly created operations appear under their creation date
//         if (!orderDate && operation.createdAt) {
//           orderDate = operation.createdAt;
//           console.log(`Using createdAt date for operation ${operation.id} with ref ${operation.referenceNumber}`);
//         }
        
//         // If we still don't have a date, skip this operation in filtered results
//         if (!orderDate) return false;
        
//         // Parse the order date string to a Date object for comparison
//         let orderDateObj: Date;
        
//         // Convert string dates to Date objects for comparison
//         if (typeof orderDate === 'string') {
//           // Try to parse DD/MM/YYYY format first
//           const [day, month, year] = orderDate.split('/').map(num => parseInt(num, 10));
//           if (day && month && year) {
//             orderDateObj = new Date(year, month - 1, day); // month is 0-indexed in JS Date
//           } else {
//             // Try to parse as ISO string as fallback
//             orderDateObj = new Date(orderDate);
//           }
//         } else if (isDateObject(orderDate)) {
//           orderDateObj = orderDate;
//         } else {
//           return false;
//         }
        
//         // Compare dates at day level (ignoring time)
//         const selectedDay = selectedDate.getDate();
//         const selectedMonth = selectedDate.getMonth();
//         const selectedYear = selectedDate.getFullYear();
        
//         const orderDay = orderDateObj.getDate();
//         const orderMonth = orderDateObj.getMonth();
//         const orderYear = orderDateObj.getFullYear();
        
//         // Only include operations with matching date
//         if (selectedDay !== orderDay || selectedMonth !== orderMonth || selectedYear !== orderYear) {
//           return false;
//         }
//       }
      
//       // Next filter by tab selection
//       if (activeViewTab === "ready-desp" && operation.status !== "READY≈DESP") {
//         return false;
//       }
//       if (activeViewTab === "loading" && operation.status !== "LOADING") {
//         return false;
//       }
      
//       // Filter by plant if plants are selected
//       if (selectedPlants.length > 0) {
//         // Check if reference number exists
//         if (!operation.referenceNumber) {
//           return false;
//         }
        
//         // Check if proforma slip data exists for this reference number
//         const proformaData = proformaSlipsData[operation.referenceNumber];
//         if (!proformaData || !proformaData.slip) {
//           return false;
//         }
        
//         // Check if plant exists and is not null/empty
//         const operationPlant = proformaData.slip.plant;
//         if (!operationPlant || operationPlant.trim() === '') {
//           return false;
//         }
        
//         // Finally check if selected plants includes this plant
//         if (!selectedPlants.includes(operationPlant)) {
//           return false;
//         }
//       }
      
//       // Filter by assigned operations if enabled
//       if (showAssignedOnly) {
//         // Check if operation is assigned to current user
//         if (operation.createdById !== userId && operation.assignedToId !== userId) {
//           return false;
//         }
//       }
      
//       // Then filter by search query
//       if (!searchQuery) return true;
//       return (
//         (operation.referenceNumber && operation.referenceNumber.includes(searchQuery)) || 
//         (operation.status && operation.status.toLowerCase().includes(searchQuery.toLowerCase())) ||
//         (operation.referenceNumber && 
//          proformaSlipsData[operation.referenceNumber] && 
//          proformaSlipsData[operation.referenceNumber]?.slip?.partyName?.toLowerCase().includes(searchQuery.toLowerCase()))
//       );
//     });
//   }, [data, isDateFilterActive, selectedDate, activeViewTab, selectedPlants, searchQuery, proformaSlipsData, showAssignedOnly, userId]);
  
//   // Same filter logic for backup data
//   const filteredBackupData = useMemo(() => {
//     if (!backupOperations) return [];
    
//     return backupOperations.filter(operation => {
//       // Apply date filter and other filters (similar to the main data filter)
//       if (isDateFilterActive && selectedDate) {
//         // First try to get the date from proforma slip data
//         let orderDate = operation.referenceNumber && 
//           proformaSlipsData[operation.referenceNumber]?.slip?.orderDate;
        
//         // If no order date is found in proforma data, use the operation's createdAt date
//         // This ensures newly created operations appear under their creation date
//         if (!orderDate && operation.createdAt) {
//           orderDate = operation.createdAt;
//           console.log(`Using createdAt date for backup operation ${operation.id} with ref ${operation.referenceNumber}`);
//         }
        
//         // If we still don't have a date, skip this operation in filtered results
//         if (!orderDate) return false;
        
//         // Parse the order date string to a Date object for comparison
//         let orderDateObj: Date;
        
//         // Convert string dates to Date objects for comparison
//         if (typeof orderDate === 'string') {
//           // Try to parse DD/MM/YYYY format first
//           const [day, month, year] = orderDate.split('/').map(num => parseInt(num, 10));
//           if (day && month && year) {
//             orderDateObj = new Date(year, month - 1, day); // month is 0-indexed in JS Date
//           } else {
//             // Try to parse as ISO string as fallback
//             orderDateObj = new Date(orderDate);
//           }
//         } else if (isDateObject(orderDate)) {
//           orderDateObj = orderDate;
//         } else {
//           return false;
//         }
        
//         // Compare dates at day level (ignoring time)
//         const selectedDay = selectedDate.getDate();
//         const selectedMonth = selectedDate.getMonth();
//         const selectedYear = selectedDate.getFullYear();
        
//         const orderDay = orderDateObj.getDate();
//         const orderMonth = orderDateObj.getMonth();
//         const orderYear = orderDateObj.getFullYear();
        
//         // Only include operations with matching date
//         if (selectedDay !== orderDay || selectedMonth !== orderMonth || selectedYear !== orderYear) {
//           return false;
//         }
//       }
      
//       // Apply all the other filters like we did for main data
//       // Tab selection
//       if (activeViewTab === "ready-desp" && operation.status !== "READY≈DESP") {
//         return false;
//       }
//       if (activeViewTab === "loading" && operation.status !== "LOADING") {
//         return false;
//       }
      
//       // Plant filtering
//       if (selectedPlants.length > 0) {
//         // Check if reference number exists
//         if (!operation.referenceNumber) {
//           return false;
//         }
        
//         // Check if proforma slip data exists for this reference number
//         const proformaData = proformaSlipsData[operation.referenceNumber];
//         if (!proformaData || !proformaData.slip) {
//           return false;
//         }
        
//         // Check if plant exists and is not null/empty
//         const operationPlant = proformaData.slip.plant;
//         if (!operationPlant || operationPlant.trim() === '') {
//           return false;
//         }
        
//         // Finally check if selected plants includes this plant
//         if (!selectedPlants.includes(operationPlant)) {
//           return false;
//         }
//       }
      
//       // Search query filtering
//       if (!searchQuery) return true;
//       return (
//         (operation.referenceNumber && operation.referenceNumber.includes(searchQuery)) || 
//         (operation.status && operation.status.toLowerCase().includes(searchQuery.toLowerCase())) ||
//         (operation.referenceNumber && 
//          proformaSlipsData[operation.referenceNumber] && 
//          proformaSlipsData[operation.referenceNumber]?.slip?.partyName?.toLowerCase().includes(searchQuery.toLowerCase()))
//       );
//     });
//   }, [backupOperations, isDateFilterActive, selectedDate, activeViewTab, selectedPlants, searchQuery, proformaSlipsData]);

//   // Extract unique plant values from the proforma slips data when it changes
//   useEffect(() => {
//     if (data && data.length > 0 && Object.keys(proformaSlipsData).length > 0) {
//       // Get all plant values from the operations data
//       const plants = new Set<string>();
      
//       // Loop through the operations data to get reference numbers
//       data.forEach(operation => {
//         if (operation.referenceNumber && 
//             proformaSlipsData[operation.referenceNumber]?.slip?.plant && 
//             proformaSlipsData[operation.referenceNumber]?.slip?.plant?.trim() !== '') {
//           const plant = proformaSlipsData[operation.referenceNumber]?.slip?.plant;
//           if (plant) {
//             plants.add(plant);
//           }
//         }
//       });
      
//       // Convert to array of option objects
//       const plantOptionsList = Array.from(plants).map(plant => ({
//         value: plant,
//         label: plant
//       }));
      
//       // Sort alphabetically
//       plantOptionsList.sort((a, b) => a.label.localeCompare(b.label));
      
//       setPlantOptions(plantOptionsList);
//     }
//   }, [data, proformaSlipsData]);
  


//   const { data: inProgressCount } = useQuery<{status: string, count: number}>({
//     queryKey: ['/api/loading-operations/status/count', 'IN_PROGRESS'],
//     queryFn: async () => {
//       // Make the API request without date filtering
//       const res = await apiRequest('GET', `/api/loading-operations/status/count?status=LOADING`);
//       return res.json();
//     },
//     // Apply the same auto-refresh settings as the main query
//     refetchInterval: userInteracting ? false : AUTO_REFRESH_INTERVAL,
//     refetchOnWindowFocus: false,
//     staleTime: AUTO_REFRESH_INTERVAL / 2,
//   });

//   const { data: readyDespCount } = useQuery<{status: string, count: number}>({
//     queryKey: ['/api/loading-operations/status/count', 'READY_FOR_DISPATCHED'],
//     queryFn: async () => {
//       // Make the API request without date filtering
//       const res = await apiRequest('GET', `/api/loading-operations/status/count?status=READY≈DESP`);
//       return res.json();
//     },
//     // Apply the same auto-refresh settings as the main query
//     refetchInterval: userInteracting ? false : AUTO_REFRESH_INTERVAL,
//     refetchOnWindowFocus: false,
//     staleTime: AUTO_REFRESH_INTERVAL / 2,
//   });
  

  
//   // Remove duplicate query - already have inProgressCount for LOADING status
  


//   // Define the global addItemToSlip function for use in searched items
//   useEffect(() => {
//     window.addItemToSlip = async (operationId, productId, referenceNumber, productName, sku) => {
//       try {
//         // Get the product to fetch its itemsPerPallet value
//         const productResponse = await apiRequest("GET", `/api/products/${productId}`);
//         const productData = await productResponse.json();
        
//         // Use itemsPerPallet as the default quantity, or 1 if itemsPerPallet is not available
//         const defaultQuantity = productData.itemsPerPallet || 1;
        
//         console.log(`Adding item ${productName} to operation ${operationId} with default quantity from itemsPerPallet: ${defaultQuantity}`);
        
//         // Create a new item in the loading operation directly using the correct endpoint
//         const response = await apiRequest("POST", `/api/loading-operations/${operationId}/items`, {
//           loadOperationsId: operationId,
//           productId: productId,
//           quantity: defaultQuantity,
//           originalQuantity: 0, // Set original quantity to 0 for newly added items
//           extraQuantity: defaultQuantity, // All quantity is extra for new items
//           loaded: false,
//           loadedQuantity: 0,
//           barcode: sku,
//           itemName: productName
//         });
        
//         const newItem = await response.json();
        
//         // Add the new item ID to the list of newly added items in localStorage
//         try {
//           // Create a key for tracking newly added items to this reference number
//           const newItemsKey = `proforma-new-items-${referenceNumber.trim()}`;
          
//           // Get current list of newly added items or initialize if not exists
//           let newlyAddedItems: number[] = [];
//           const storedNewItems = localStorage.getItem(newItemsKey);
//           if (storedNewItems) {
//             newlyAddedItems = JSON.parse(storedNewItems);
//           }
          
//           // Add the new item ID if it's not already in the list
//           if (newItem && newItem.id && !newlyAddedItems.includes(newItem.id)) {
//             newlyAddedItems.push(newItem.id);
//             localStorage.setItem(newItemsKey, JSON.stringify(newlyAddedItems));
//             console.log(`Added item ${newItem.id} to newly added items list for ${referenceNumber}:`, newlyAddedItems);
            
//             // Also update the original quantities storage with the initial quantity
//             const storageKey = `proforma-original-quantities-${referenceNumber.trim()}`;
//             let storedOriginalQuantities: Record<number, number> = {};
//             try {
//               const storedData = localStorage.getItem(storageKey);
//               if (storedData) {
//                 storedOriginalQuantities = JSON.parse(storedData);
//               }
//               // Set the original quantity to 0 for newly added items
//               storedOriginalQuantities[newItem.id] = 0;
//               localStorage.setItem(storageKey, JSON.stringify(storedOriginalQuantities));
//               console.log(`Updated original quantities for new item ${newItem.id} with quantity ${defaultQuantity}`);
//             } catch (err) {
//               console.error("Error updating original quantities for new item:", err);
//             }
//           }
//         } catch (err) {
//           console.error("Error updating newly added items list:", err);
//         }
        
//         // Update the view if it's open
//         if (viewProformaDetails && selectedOperation && selectedOperation.id === operationId) {
//           // First, update the view immediately with the new item
//           setViewProformaDetails(prev => {
//             if (!prev) return prev;
            
//             // Create a new copy of existing items plus the new item
//             const updatedItems = [...prev.items, {
//               id: newItem.id,
//               productId: productId,
//               loadOperationsId: operationId,
//               quantity: defaultQuantity,
//               originalQuantity: 0, // New items have original quantity of 0
//               extraQuantity: defaultQuantity, // All quantity is extra for new items
//               loaded: false,
//               loadedQuantity: 0,
//               srNo: "0",
//               barcode: sku,
//               itemName: productName,
//               // Add other item properties
//               productName: productData?.name || productName,
//               sku: productData?.sku || sku,
//               price: productData?.price || 0,
//               unit: productData?.unit || null
//             }];
            
//             return {
//               ...prev,
//               items: updatedItems
//             };
//           });
          
//           // Then fetch full details to ensure consistency
//           setTimeout(async () => {
//             const details = await fetchLoadOperationDetails(referenceNumber, operationId);
//             if (details) {
//               setViewProformaDetails(details);
//             }
//           }, 500);
//         }
        
//         // Broadcast the new item addition to other views/devices
//         if (broadcastChannelRef.current && newItem && newItem.id) {
//           // Generate a unique device ID if none exists
//           if (!window.deviceId) {
//             window.deviceId = `device-${Math.random().toString(36).substring(2, 8)}`;
//           }
          
//           broadcastChannelRef.current.postMessage({
//             type: 'NEW_ITEM_ADDED',
//             operationId: operationId,
//             referenceNumber,
//             data: {
//               itemId: newItem.id,
//               quantity: defaultQuantity,
//               originalQuantity: 0, // Set original quantity to 0 for newly added items
//               extraQuantity: defaultQuantity, // All quantity is extra for new items
//               isNewlyAdded: true,
//               // Include product details for immediate UI updates on other devices
//               productName: productData?.name || productName,
//               sku: productData?.sku || sku,
//               barcode: productData?.barcode || sku,
//               price: productData?.price || 0,
//               unit: productData?.unit || null
//             },
//             timestamp: Date.now(),
//             sender: window.deviceId
//           });
//           console.log(`[BroadcastSent] New item added: id=${newItem.id}, qty=${defaultQuantity} at ${new Date().toISOString()}`);
//         }
        
//         // Hide the search results
//         const searchResultsEl = document.getElementById(`search-results-${operationId}`);
//         if (searchResultsEl) {
//           searchResultsEl.classList.add('hidden');
//         }
        
//         toast({
//           title: "Success",
//           description: "Item added to operation",
//         });
        
//         // Refresh the operations list to get updated counts
//         refetchRef.current();
        
//         // Invalidate queries to reflect the new item
//         queryClient.invalidateQueries({ queryKey: [`/api/loading-operations/${operationId}/items`] });
//         queryClient.invalidateQueries({ queryKey: [`/api/loading-operations/${operationId}`] });
//         queryClient.invalidateQueries({ queryKey: ['/api/loading-operations'] });
        
//       } catch (error) {
//         console.error("Error adding item to operation:", error);
//         toast({
//           title: "Error",
//           description: "Failed to add item to operation",
//           variant: "destructive",
//         });
//       }
//     };
    
//     return () => {
//       // Clean up the global function when the component unmounts
//       window.addItemToSlip = () => {}; // Use an empty function instead of delete
//     };
//   }, [viewProformaDetails, selectedOperation, refetchRef, toast]);
  
//   // Function to perform combined search with text query and category filter
//   const performSearch = (operationId: number, query: string | null, categoryFilter: string | null, referenceNumber: string | null | undefined) => {
//     // Normalize reference number
//     const refNumber = referenceNumber || "";
//     const searchQuery = query?.toLowerCase() || "";
    
//     // Construct search URL
//     let searchUrl = "/api/products?limit=1000";
    
//     // Fetch all products
//     apiRequest("GET", searchUrl)
//       .then(response => response.json())
//       .then(data => {
//         // Apply filters client-side
//         let filteredData = [...data];
        
//         // Apply category filter if specified
//         if (categoryFilter) {
//           filteredData = filteredData.filter((product: any) => 
//             product.category && product.category.toLowerCase() === categoryFilter.toLowerCase()
//           );
//         }
        
//         // Apply text search filter if query is provided
//         if (searchQuery) {
//           filteredData = filteredData.filter((product: any) => 
//             (product.name && product.name.toLowerCase().includes(searchQuery)) || 
//             (product.barcode && product.barcode.toLowerCase().includes(searchQuery))
//           );
//         }
        
//         // Display the filtered results
//         handleSearchResults(filteredData, operationId, refNumber);
//       })
//       .catch(error => {
//         console.error("Error fetching products:", error);
//         toast({
//           title: "Error",
//           description: "Failed to fetch products",
//           variant: "destructive",
//         });
//       });
//   };

//   // Function to handle search results display
//   const handleSearchResults = (data: any[], operationId: number, referenceNumber: string | null) => {
//     // Normalize reference number
//     const refNumber = referenceNumber || "";
//     const searchResultsEl = document.getElementById(`search-results-${operationId}`);
//     if (searchResultsEl) {
//       if (data && data.length > 0) {
//         searchResultsEl.classList.remove('hidden');
        
//         // Check if we're on mobile or desktop view
//         const isMobileView = window.innerWidth < 768;
//         let resultsHTML = '';
        
//         if (isMobileView) {
//           // Mobile card view
//           resultsHTML = `<div class="divide-y">`;
          
//           data.forEach((product: any) => {
//             resultsHTML += `
//               <div class="p-2 space-y-1">
//                 <div class="flex justify-between items-center">
//                   <div class="font-medium text-sm">${product.name}</div>
//                   <button 
//                     class="inline-flex items-center justify-center gap-1 whitespace-nowrap rounded-md text-xs font-medium ring-offset-background transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 disabled:pointer-events-none disabled:opacity-50 border border-input bg-primary text-primary-foreground hover:bg-primary/90 h-7 px-2"
//                     onclick="window.addItemToSlip(${operationId}, ${product.id}, '${refNumber}', '${product.name.replace(/'/g, "\\'")}', '${product.barcode || "N/A"}', ${product.itemsPerPallet || 0})"
//                   >
//                     <svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" class="h-3 w-3"><path d="M5 12h14"></path><path d="M12 5v14"></path></svg>
//                     Add
//                   </button>
//                 </div>
//                 <div class="flex justify-between text-xs text-muted-foreground">
//                   <span>SKU: ${product.barcode || "N/A"}</span>
//                   <span class="whitespace-nowrap">Category: ${product.category || "N/A"}</span>
//                 </div>
//               </div>
//             `;
//           });
          
//           resultsHTML += `</div>`;
//         } else {
//           // Desktop table view
//           resultsHTML = `
//             <table class="w-full text-sm">
//               <thead>
//                 <tr class="border-b">
//                   <th class="text-left p-1">SKU</th>
//                   <th class="text-left p-1">Item Name</th>
//                   <th class="text-left p-1">Category</th>
//                   <th class="text-left p-1"></th>
//                 </tr>
//               </thead>
//               <tbody>
//           `;
          
//           data.forEach((product: any) => {
//             resultsHTML += `
//               <tr class="border-b hover:bg-muted/30">
//                 <td class="p-1 text-xs">${product.barcode || "N/A"}</td>
//                 <td class="p-1 max-w-[200px] break-words whitespace-normal">${product.name}</td>
//                 <td class="p-1 text-xs whitespace-nowrap">${product.category || "N/A"}</td>
//                 <td class="p-1">
//                   <button 
//                     class="inline-flex items-center justify-center whitespace-nowrap rounded-md text-xs font-medium ring-offset-background transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 disabled:pointer-events-none disabled:opacity-50 border border-input bg-background hover:bg-accent hover:text-accent-foreground h-7 px-2"
//                     onclick="window.addItemToSlip(${operationId}, ${product.id}, '${refNumber}', '${product.name.replace(/'/g, "\\'")}', '${product.barcode || "N/A"}', ${product.itemsPerPallet || 0})"
//                   >
//                     <svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" class="h-3 w-3"><path d="M5 12h14"></path><path d="M12 5v14"></path></svg>
//                     Add
//                   </button>
//                 </td>
//               </tr>
//             `;
//           });
          
//           resultsHTML += `
//               </tbody>
//             </table>
//           `;
//         }
        
//         searchResultsEl.innerHTML = resultsHTML;
//       } else {
//         searchResultsEl.innerHTML = '<div class="p-4 text-center text-muted-foreground">No items found</div>';
//         searchResultsEl.classList.remove('hidden');
//       }
//     }
//   };

//   // Handle Order Lookup
//   const handleOrderLookup = async (orderNumber: string) => {
//     try {
//       setIsOrderSearchLoading(true);
//       if (!orderNumber.trim()) {
//         toast({
//           title: "Error",
//           description: "Please enter an order number",
//           variant: "destructive",
//         });
//         setIsOrderSearchLoading(false);
//         return;
//       }
      
//       // Use batch API for better performance
//       const response = await fetch('/api/proforma-slips/batch', {
//         method: 'POST',
//         headers: {
//           'Content-Type': 'application/json',
//         },
//         body: JSON.stringify({ orderNumbers: [orderNumber.trim()] }),
//       });
      
//       const batchResults = await response.json();
//       const data = batchResults[orderNumber.trim()];
      
//       if (!data) {
//         throw new Error(`No data found for order number ${orderNumber.trim()}`);
//       }
      
//       // Check if operation already exists
//       const opResponse = await apiRequest(
//         'GET',
//         `/api/loading-operations/reference/${orderNumber.trim()}`
//       );
      
//       const opData = await opResponse.json();
      
//       // Process the items to ensure they have names and SKUs
//       const processedData = {
//         slip: data.slip,
//         items: data.items.map((item: any, idx: number) => {
//           // Make sure all item properties are populated
//           return {
//             ...item,
//             srNo: item.srNo || idx + 1,
//             srNoDisplay: item.srNo || idx + 1};
//         }),
//         operation: opData.exists ? opData.operation : undefined
//       };
      
//       setProformaSlipDetails(processedData);
      
//       toast({
//         title: "Success",
//         description: `Found proforma slip #${data.slip.orderNumber}`,
//       });
//     } catch (error) {
//       toast({
//         title: "Error",
//         description: "Proforma slip not found with that order number",
//         variant: "destructive",
//       });
//     } finally {
//       setIsOrderSearchLoading(false);
//     }
//   };

//   // Handle order lookup for creating a new loading operation - optimized version
//   const handleOrderLookupForOperation = async (orderNumber: string) => {
//     try {
//       if (!orderNumber.trim()) {
//         toast({
//           title: "Error",
//           description: "Please enter an order number",
//           variant: "destructive",
//         });
//         return;
//       }
      
//       // Show loading indicator immediately
//       setIsOrderSearchLoading(true);
      
//       // First check if we already have this in our state (fastest path)
//       const trimmedOrderNumber = orderNumber.trim();
//       const existingData = proformaSlipsData[trimmedOrderNumber];
      
//       if (existingData) {
//         console.log("Using cached proforma slip data from state");
        
//         // Check operation existence in parallel after returning immediately
//         setTimeout(async () => {
//           try {
//             const opResponse = await apiRequest(
//               'GET',
//               `/api/loading-operations/reference/${trimmedOrderNumber}`
//             );
            
//             const opData = await opResponse.json();
            
//             // Update with operation info
//             setProformaSlipDetails(prev => prev ? {
//               ...prev,
//               operation: opData.exists ? opData.operation : undefined
//             } : null);
//           } catch (err) {
//             console.error("Error checking operation existence:", err);
//           }
//         }, 0);
        
//         // Process the items for immediate display
//         const quickProcessedData = {
//           slip: existingData.slip,
//           items: existingData.items.map((item: any, idx: number) => ({
//             ...item,
//             srNo: item.srNo || item.sr_no || idx + 1,
//             srNoDisplay: item.srNoDisplay || item.sr_no_display || String(item.srNo || item.sr_no || idx + 1),
//             itemName: item.itemName || item.item_name || `Item ${item.productId || idx}`,
//             sku: item.sku || item.barcode || "",
//             // Ensure quantity fields are always properly set
//             originalQuantity: item.originalQuantity !== undefined ? item.originalQuantity : 
//                            (item.original_quantity !== undefined ? item.original_quantity : 
//                            (item.quantity !== undefined ? item.quantity : 0)),
//             original_quantity: item.originalQuantity !== undefined ? item.originalQuantity : 
//                            (item.original_quantity !== undefined ? item.original_quantity : 
//                            (item.quantity !== undefined ? item.quantity : 0)),
//             extraQuantity: item.extraQuantity !== undefined ? item.extraQuantity : 
//                          (item.extra_quantity !== undefined ? item.extra_quantity : 0),
//             extra_quantity: item.extraQuantity !== undefined ? item.extraQuantity : 
//                          (item.extra_quantity !== undefined ? item.extra_quantity : 0),
//             loaded: item.loaded === true || item.loaded === 'true' // Handle both boolean and string representations
//           }))
//         };
        
//         // Update UI immediately
//         setProformaSlipDetails(quickProcessedData);
//         setIsOrderSearchLoading(false);
        
//         toast({
//           title: "Success",
//           description: `Found proforma slip #${existingData.slip.orderNumber}`,
//         });
//         return;
//       }
      
//       // If not in state, use the API to fetch it
//       // Use batch API for better performance - direct fetch for faster response
//       console.log(`Fetching proforma slip data for order #${trimmedOrderNumber}`);
//       const response = await fetch('/api/proforma-slips/batch', {
//         method: 'POST',
//         headers: {
//           'Content-Type': 'application/json',
//         },
//         body: JSON.stringify({ orderNumbers: [trimmedOrderNumber] }),
//       });
      
//       const batchResults = await response.json();
//       const data = batchResults[trimmedOrderNumber];
      
//       if (!data) {
//         throw new Error(`No data found for order number ${trimmedOrderNumber}`);
//       }
      
//       // Store in state for future use (caching)
//       setProformaSlipsData(prev => ({
//         ...prev,
//         [trimmedOrderNumber]: data
//       }));
      
//       // Process the items for immediate display
//       const quickProcessedData = {
//         slip: data.slip,
//         items: data.items.map((item: any, idx: number) => ({
//           ...item,
//           srNo: item.srNo || item.sr_no || idx + 1,
//           srNoDisplay: item.srNoDisplay || item.sr_no_display || String(item.srNo || item.sr_no || idx + 1),
//           itemName: item.itemName || item.item_name || `Item ${item.productId || idx}`,
//           sku: item.sku || item.barcode || "",
//           // Ensure quantity fields are always properly set
//           originalQuantity: item.originalQuantity !== undefined ? item.originalQuantity : 
//                          (item.original_quantity !== undefined ? item.original_quantity : 
//                          (item.quantity !== undefined ? item.quantity : 0)),
//           original_quantity: item.originalQuantity !== undefined ? item.originalQuantity : 
//                          (item.original_quantity !== undefined ? item.original_quantity : 
//                          (item.quantity !== undefined ? item.quantity : 0)),
//           extraQuantity: item.extraQuantity !== undefined ? item.extraQuantity : 
//                        (item.extra_quantity !== undefined ? item.extra_quantity : 0),
//           extra_quantity: item.extraQuantity !== undefined ? item.extraQuantity : 
//                        (item.extra_quantity !== undefined ? item.extra_quantity : 0),
//           loaded: item.loaded === true || item.loaded === 'true' // Handle both boolean and string representations
//         }))
//       };
      
//       // Update UI immediately
//       setProformaSlipDetails(quickProcessedData);
//       setIsOrderSearchLoading(false);
      
//       // Check operation existence in parallel after returning
//       setTimeout(async () => {
//         try {
//           const opResponse = await apiRequest(
//             'GET',
//             `/api/loading-operations/reference/${trimmedOrderNumber}`
//           );
          
//           const opData = await opResponse.json();
          
//           // Update with operation info
//           setProformaSlipDetails(prev => prev ? {
//             ...prev,
//             operation: opData.exists ? opData.operation : undefined
//           } : null);
//         } catch (err) {
//           console.error("Error checking operation existence:", err);
//         }
//       }, 0);
      
//       toast({
//         title: "Success",
//         description: `Found proforma slip #${data.slip.orderNumber}`,
//       });
//     } catch (error) {
//       console.error("Error searching for order:", error);
//       toast({
//         title: "Error",
//         description: error instanceof Error ? error.message : "Proforma slip not found with that order number",
//         variant: "destructive",
//       });
//       setIsOrderSearchLoading(false);
//     }
//   };

//   const handleCreateOperation = async (slip: ProformaSlip) => {
//     try {
//       // Plant restriction removed - operations can be created for any plant
      
//       // First check if a load slip already exists for this order number
//       const checkResponse = await apiRequest('GET', `/api/loading-operations/reference/${slip.orderNumber}`);
//       const checkData = await checkResponse.json();
      
//       if (checkData.exists) {
//         // Get user information who created it
//         let createdByInfo = "another user";
//         let isCurrentUserTheCreator = false;
        
//         if (checkData.operation.createdById) {
//           try {
//             const userResponse = await apiRequest('GET', `/api/users/${checkData.operation.createdById}`);
//             const userData = await userResponse.json();
//             createdByInfo = userData.name || userData.username || "another user";
            
//             // Check if the current user is the one who created the existing load slip
//             isCurrentUserTheCreator = checkData.operation.createdById === userId;
//           } catch (error) {
//             console.error("Error fetching user info:", error);
//           }
//         }
        
//         // Format creation date
//         let creationDate = "an unknown date";
//         if (checkData.operation.createdAt) {
//           const date = new Date(checkData.operation.createdAt);
//           creationDate = date.toLocaleDateString();
//         }
        
//         let errorMessage = "";
        
//         if (isCurrentUserTheCreator) {
//           // If it's the same user, provide a specific message
//           errorMessage = `You have already generated a Load Slip for Order No. #${slip.orderNumber} on ${creationDate}. The existing slip must be deleted before creating a new one.`;
//         } else {
//           // If it's a different user
//           errorMessage = `Load Slip for Order No. #${slip.orderNumber} already generated by ${createdByInfo} on ${creationDate}. This slip must be deleted by an authorized user before creating a new one.`;
//         }
        
//         toast({
//           title: "Duplicate Order Number",
//           description: errorMessage,
//           variant: "destructive",
//         });
//         return;
//       }
      
//       // Get the item count from the proformaSlipDetails
//       const itemCount = proformaSlipDetails?.items.length || 0;
      
//       // Get user information for the notes field
//       const userInfo = `${userName} (${userDepartment})`;
//       const operationNotes = `Storekeeper: ${userInfo}\nItems: ${itemCount}\nTotal quantity: ${slip.totalQuantity ?? 0}`;
      
//       // Before proceeding, ensure we have a valid user ID
//       let validUserId = userId;
      
//       // If userId is 0 or null, try to get a valid user ID
//       if (!validUserId) {
//         try {
//           console.log("No valid user ID found, fetching users...");
//           const response = await apiRequest('GET', '/api/users');
//           const users = await response.json();
//           console.log("Fetched users:", users);
//           setUsers(users.reduce((acc: Record<number, {id: number, name: string, username: string}>, user: any) => {
//             acc[user.id] = user;
//             return acc;
//           }, {}));
          
//           const match=users.find((user: any) => user.username === userName || user.name === userName);
//           console.log("Matching user found:", match);
//           if (users && users.length > 0) {
//             validUserId = match.userCode ;
//             console.log("Using existing user ID:", validUserId);
//           } else {
//             console.log("No users found, creating a default user...");
//             // Create a default user if none exists
//             const createResponse = await apiRequest('POST', '/api/users', {
//               username: "admin",
//               password: "admin123",
//               name: "Admin User",
//               role: "admin",
//               department: "MANAGEMENT",
//               designation: "Admin"
//             });
            
//             if (createResponse.ok) {
//               const newUser = await createResponse.json();
//               console.log("Created default user:", newUser);
//               validUserId = newUser.id;
              
//               // Update state variables
//               setUserId(newUser.id);
//               setUserRole(newUser.role || "admin");
//               setUserName(newUser.name || newUser.username || "Admin User");
//               setUserDesignation(newUser.designation || "Admin");
//               setUserDepartment(newUser.department || "MANAGEMENT");
//               setUserCode(newUser.userCode || "ADMIN001");
//               // Save to localStorage for future use
//               localStorage.setItem('currentUser', JSON.stringify(newUser));
//             }
//           }
//         } catch (error) {
//           console.error("Error fetching or creating user:", error);
//           toast({
//             title: "Error",
//             description: "Failed to create or fetch a valid user for this operation",
//             variant: "destructive",
//           });
//           return;
//         }
//       }
      
//       if (!validUserId) {
//         toast({
//           title: "Error",
//           description: "Cannot create loading operation: No valid user ID found.",
//           variant: "destructive",
//         });
//         return;
//       }
      
//       // Use the order date from the slip if available
//       console.log(`Slip order date from proforma: ${slip.orderDate}`);
      
//       // Format the date to ISO string format that can be properly parsed by the server
//       let formattedDate = null;
//       if (slip.orderDate) {
//         try {
//           // Convert to a proper Date object first
//           const dateObj = new Date(slip.orderDate);
//           // Then format as ISO string (YYYY-MM-DDTHH:mm:ss.sssZ)
//           formattedDate = dateObj.toISOString();
//           console.log(`Formatted date as ISO string: ${formattedDate}`);
//         } catch (error) {
//           console.error(`Error formatting date: ${slip.orderDate}`, error);
//           // Fallback - use today's date
//           formattedDate = new Date().toISOString();
//           console.log(`Using fallback date: ${formattedDate}`);
//         }
//       } else {
//         // If no date provided, use today
//         formattedDate = new Date().toISOString();
//         console.log(`No date provided, using today: ${formattedDate}`);
//       }
      
//       // Use the vehicle number from the slip if available, otherwise use a placeholder
//       const vehicleNumber = slip.vehicleNumber || 'MH-46-BF-3825';
      
//       console.log("Creating new loading operation with data:", {
//         status: 'LOADING',
//         referenceNumber: slip.orderNumber,
//         createdById: validUserId,
//         notes: operationNotes,
//         vehicleNumber: vehicleNumber,
//         orderDate: formattedDate
//       });
      
//       const response = await apiRequest('POST', '/api/loading-operations', {
//         referenceNumber: slip.orderNumber,
//         notes: operationNotes,
//         status: 'LOADING', // Default status is LOADING for all new operations
//         createdById: validUserId, // Use the actual user ID instead of hardcoded value
//         vehicleNumber: vehicleNumber, // Use vehicle number from proforma slip
//         driverName: slip.driverName || "", // Include driver name from proforma slip for independence
//         orderDate: formattedDate, // Pass properly formatted ISO date string
//         plant: slip.plant, // Include the plant from proforma slip
//         partyName: slip.partyName // Include party name from proforma slip
//       });
      
//       if (!response.ok) {
//         try {
//           const errorData = await response.json();
//           toast({
//             title: errorData.message || "Error",
//             description: errorData.error || "Failed to create loading operation",
//             variant: "destructive",
//           });
//           return;
//         } catch (error) {
//           toast({
//             title: "Error",
//             description: "Failed to create loading operation",
//             variant: "destructive",
//           });
//           return;
//         }
//       } else {
//         // Parse the response to get the created operation data
//         const createdOperation = await response.json();
        
//         toast({
//           title: "Success",
//           description: "Load slip created successfully",
//         });
        
//         // Set the newly created loading operation ID
//         setNewlyCreatedLoadingId(createdOperation.id);
        
//         // Broadcast the operation creation to all other tabs/devices
//         if (broadcastChannelRef.current) {
//           // Generate a unique device ID if none exists
//           if (!window.deviceId) {
//             window.deviceId = `device-${Math.random().toString(36).substring(2, 8)}`;
//           }
          
//           // Send broadcast with timestamp and sender ID for performance tracking
//           broadcastChannelRef.current.postMessage({
//             type: 'OPERATION_CREATED',
//             operationId: createdOperation.id,
//             data: {
//               referenceNumber: createdOperation.referenceNumber,
//               id: createdOperation.id,
//               status: createdOperation.status
//             },
//             timestamp: Date.now(),
//             sender: window.deviceId
//           });
          
//           console.log(`[BroadcastSent] New operation created broadcast: ${createdOperation.referenceNumber} at ${new Date().toISOString()}`);
//         }
        
//         // Automatically open the edit form for the newly created loading operation
//         // Find and click the edit button after a small delay to ensure the component is updated
//         setTimeout(() => {
//           console.log(`Looking for edit button for newly created loading operation #${createdOperation.id} (ref: ${createdOperation.referenceNumber})`);
          
//           // Add specific data attribute to the edit buttons to target them precisely
//           // This will make future edits easier by adding data-operation-id attributes to all operation edit buttons
//           document.querySelectorAll('button[title="Edit Load Slip"]').forEach((button) => {
//             const row = button.closest('tr');
//             if (row) {
//               const orderNumberCell = row.querySelector('td:nth-child(2)'); // Order number is usually in the 2nd column
//               if (orderNumberCell && orderNumberCell.textContent === createdOperation.referenceNumber) {
//                 console.log(`Found edit button for order #${createdOperation.referenceNumber}`);
//                 (button as HTMLButtonElement).click();
//               }
//             }
//           });
//         }, 800); // Increased timeout for better reliability
//       }

//       setIsOrderLookupDialogOpen(false);
//       setProformaSlipDetails(null);
//       setOrderNumberToSearch('');
//       refetchRef.current();
//     } catch (error) {
//       toast({
//         title: "Error",
//         description: "Failed to create loading operation",
//         variant: "destructive",
//       });
//     }
//   };

//   // Utility function to update the loaded status in both cache and UI
//   const cacheUpdateItemLoadedStatus = useCallback((operation: any, itemId: number, loaded: boolean) => {
//     // Update both the cached data and the session storage
//     if (operation?.referenceNumber) {
//       // Use the cache update utility to ensure the cache is immediately updated
//       updateProformaSlipItemCache(operation.referenceNumber, itemId, loaded);
      
//       // Also update our React state for the proformaSlipsData
//       if (proformaSlipsData[operation.referenceNumber]) {
//         const updatedProformaData = { ...proformaSlipsData[operation.referenceNumber] };
        
//         // Check if slip and items exist before updating
//         if (updatedProformaData && updatedProformaData.items) {
//           // Update the specific item in the cache
//           const updatedItems = updatedProformaData.items.map(i => 
//             i.id === itemId ? { ...i, loaded } : i
//           );
          
//           // Update the in-memory state with the new items
//           const updatedSlipData = {
//             ...updatedProformaData,
//             items: updatedItems
//           };
          
//           // Apply to the proformaSlipsData state
//           setProformaSlipsData(prev => ({
//             ...prev,
//             [operation.referenceNumber!]: updatedSlipData
//           }));
          
//           // Also update session storage
//           try {
//             const existingData = sessionStorage.getItem('loadOperations_proformaSlipsData') || 
//               sessionStorage.getItem('gjOperations_proformaSlipsData'); // For backward compatibility
//             if (existingData) {
//               const parsedData = JSON.parse(existingData);
//               parsedData[operation.referenceNumber!] = updatedSlipData;
//               // Save to the new key
//               sessionStorage.setItem('loadOperations_proformaSlipsData', JSON.stringify(parsedData));
//               // Also save to legacy key for backward compatibility
//               sessionStorage.setItem('gjOperations_proformaSlipsData', JSON.stringify(parsedData));
//               console.log('Updated proforma slip cache in session storage');
//             }
//           } catch (err) {
//             console.error('Error saving to session storage:', err);
//           }
//         }
//       }
//     }
    
//     // Also invalidate the loading operations items cache
//     if (operation && operation.id) {
//       queryClient.invalidateQueries({ queryKey: [`/api/loading-operations/${operation.id}/items`] });
//     }
//   }, [proformaSlipsData]);

//   // Type for badge variants that includes our new "warning" variant
//   type BadgeVariant = "default" | "destructive" | "outline" | "success" | "secondary" | "warning";
  
//   const getBadgeVariant = (status: string | null): BadgeVariant => {
//     // Always return 'secondary' (purple) for all status badges
//     return "secondary";
//   };
  
//   // Legacy handler - replaced by the comprehensive handler at the component start
//   const legacyUpdateItemLoadedStatus = (item: any, operation: any, isLoaded: boolean, options?: { skipUiUpdate?: boolean }) => {
//     console.log(`Updating item ${item.id} loaded status to ${isLoaded}`);
    
//     // Skip UI updates if specified (used when UI is already updated)
//     if (!options?.skipUiUpdate) {
//       // Find UI elements to update (for both desktop and mobile views)
//       const itemRow = document.querySelector(`tr[data-item-id="${item.id}"]`);
//       if (itemRow) {
//         if (isLoaded) {
//           itemRow.classList.add('bg-green-50');
//         } else {
//           itemRow.classList.remove('bg-green-50');
//         }
//       }
      
//       // Also update the mobile card if exists
//       const mobileCard = document.querySelector(`.mobile-item-card[data-item-id="${item.id}"]`);
//       if (mobileCard) {
//         if (isLoaded) {
//           mobileCard.classList.add('bg-green-50');
//         } else {
//           mobileCard.classList.remove('bg-green-50');
//         }
//       }
      
//       // Update local React state
//       setViewProformaDetails(prev => {
//         if (!prev) return prev;
        
//         // Create a new updated item
//         const updatedItem = { ...item, loaded: isLoaded };
        
//         // Map through the items and update the matching one
//         const updatedItems = prev.items.map(i => 
//           i.id === item.id ? updatedItem : i
//         );
        
//         // Sort items (unloaded first, loaded last) for better UI organization
//         return {
//           ...prev,
//           items: [
//             ...updatedItems.filter(i => !i.loaded),
//             ...updatedItems.filter(i => i.loaded)
//           ]
//         };
//       });
//     }
    
//     // Update the cache for this item (both in-memory and session storage)
//     if (operation?.referenceNumber) {
//       updateProformaSlipItemCache(operation.referenceNumber, item.id, isLoaded);
//     }
    
//     // Send the update to the server
//     apiRequest('PUT', `/api/loading-operation-items/${item.id}`, {
//       loaded: isLoaded
//     })
//     .then(() => {
//       console.log('Successfully updated item loaded status in backend');
      
//       // Broadcast the update to other tabs/devices if needed
//       if (broadcastChannelRef.current) {
//         broadcastChannelRef.current.postMessage({
//           type: 'LOADED_STATUS_UPDATED',
//           operationId: operation?.id,
//           data: [{ id: item.id, loaded: isLoaded }],
//           timestamp: Date.now(),
//           sender: window.deviceId
//         });
//       }
      
//       // Invalidate queries if needed for immediate UI updates in related components
//       if (operation && operation.id) {
//         queryClient.invalidateQueries({ queryKey: [`/api/loading-operations/${operation.id}/items`] });
//       }
//     })
//     .catch(error => {
//       console.error('Error updating item loaded status:', error);
//       toast({
//         title: "Error updating status",
//         description: "There was a problem updating the item status.",
//         variant: "destructive"
//       });
//     });
//   };

//   const handlePageChange = (page: number) => {
//     setCurrentPage(page);
//   };
  
//   // Update item quantity
//   const updateItemQuantity = async (itemId: number, newQuantity: number, operationId: number) => {
//     console.log(`updateItemQuantity called for item ${itemId} with new quantity ${newQuantity}`);
    
//     // Force a UI refresh immediately by updating the forceUpdateCounter
//     setForceUpdateCounter(Date.now());
    
//     // First, check if the item is currently loaded
//     const currentItem = viewProformaDetails?.items?.find(i => i.id === itemId);
//     const isItemLoaded = currentItem?.loaded || false;
//     const currentLoadedQty = currentItem?.loadedQuantity || 0;
    
//     // Update UI immediately
//     setViewProformaDetails(prev => {
//       if (!prev) return prev;
      
//       // Find the current operation to get its reference number for storage
//       const operation = data?.find(op => op.id === operationId);
//       let referenceNumber = operation?.referenceNumber || "";
      
//       // Create a key for storing original quantities in localStorage, ensuring it persists across page reloads
//       const storageKey = `proforma-original-quantities-${referenceNumber.trim()}`;
      
//       // Create another key to track which items were newly added to this reference number
//       const newItemsKey = `proforma-new-items-${referenceNumber.trim()}`;
      
//       // Try to get previously stored original quantities from localStorage
//       let storedOriginalQuantities: Record<number, number> = {};
//       try {
//         const storedData = localStorage.getItem(storageKey);
//         if (storedData) {
//           storedOriginalQuantities = JSON.parse(storedData);
//         }
//       } catch (err) {
//         console.error("Error loading stored original quantities:", err);
//       }
      
//       // Get the list of newly added items from localStorage
//       let newlyAddedItems: number[] = [];
//       try {
//         const storedNewItems = localStorage.getItem(newItemsKey);
//         if (storedNewItems) {
//           newlyAddedItems = JSON.parse(storedNewItems);
//         }
//       } catch (err) {
//         console.error("Error loading newly added items list:", err);
//       }
      
//       const updatedItems = prev.items.map(item => {
//         if (item.id === itemId) {
//           // Check if this is a newly added item based on our tracking list
//           // or if originalQuantity is undefined
//           const isNewlyAddedItem = 
//             (item.id !== null && newlyAddedItems.includes(item.id)) || 
//             item.originalQuantity === undefined;
          
//           if (isNewlyAddedItem && item.id !== null && item.id !== undefined) {
//             // For newly added items, add to tracking list if not already there
//             if (!newlyAddedItems.includes(item.id)) {
//               newlyAddedItems.push(item.id);
//               localStorage.setItem(newItemsKey, JSON.stringify(newlyAddedItems));
//             }
            
//             // For newly added items, originalQuantity should always be 0 
//             // Store the updated quantity in localStorage for persistence
//             if (referenceNumber && item.id !== null && item.id !== undefined) {
//               storedOriginalQuantities[item.id as number] = 0; // Set to 0 for newly added items
//               localStorage.setItem(storageKey, JSON.stringify(storedOriginalQuantities));
//             }
            
//             // Update quantity, keep originalQuantity as 0, and set extraQuantity to full quantity
//             // For newly added items, extraQuantity equals the full quantity
//             // If item is loaded, set loadedQuantity to match the new quantity
//             return { 
//               ...item, 
//               quantity: newQuantity,
//               originalQuantity: 0, // For new items, originalQuantity is always 0
//               extraQuantity: newQuantity, // For new items, extraQuantity equals the full quantity
//               loadedQuantity: item.loaded ? newQuantity : 0 // Set loadedQuantity if item is marked as loaded
//             };
//           } else {
//             // For existing proforma items, we need to ensure the originalQuantity is preserved
//             // and correctly stored for future reference
//             if (referenceNumber && item.id !== null && item.id !== undefined) {
//               const itemId = item.id as number;
              
//               // If we don't have the original quantity stored yet, store it now
//               if (storedOriginalQuantities[itemId] === undefined && item.originalQuantity !== undefined) {
//                 storedOriginalQuantities[itemId] = item.originalQuantity as number;
//                 localStorage.setItem(storageKey, JSON.stringify(storedOriginalQuantities));
//                 console.log(`Stored original quantity for item ${itemId}: ${item.originalQuantity}`);
//               }
              
//               // For existing items that have been loaded before, preserve their original quantity
//               // to ensure any increases show up as "extra" quantity
//               const originalQty = storedOriginalQuantities[itemId] !== undefined 
//                 ? storedOriginalQuantities[itemId] 
//                 : item.originalQuantity;
                
//               // Calculate extra quantity for this existing item
//               const extraQuantity = newQuantity > (originalQty || 0) ? newQuantity - (originalQty || 0) : 0;
//               console.log(`Calculated extraQuantity=${extraQuantity} for item ${itemId}: newQty=${newQuantity}, originalQty=${originalQty}`);
              
//               // If item is loaded, set loadedQuantity to match the new quantity
//               const loadedQuantity = item.loaded ? newQuantity : (item.loadedQuantity || 0);
              
//               return { 
//                 ...item, 
//                 quantity: newQuantity,
//                 // Use the stored/preserved original quantity to ensure consistent "extra" display
//                 originalQuantity: originalQty,
//                 // Include the calculated extraQuantity
//                 extraQuantity: extraQuantity,
//                 // Update loadedQuantity if item is loaded
//                 loadedQuantity: loadedQuantity
//               };
//             } else {
//               // Fallback if we don't have reference number info
//               // Still calculate extraQuantity even in fallback case
//               const originalQty = item.originalQuantity || 0;
//               const extraQuantity = newQuantity > originalQty ? newQuantity - originalQty : 0;
//               console.log(`Fallback: Calculated extraQuantity=${extraQuantity} for item: newQty=${newQuantity}, originalQty=${originalQty}`);
              
//               // If item is loaded, set loadedQuantity to match the new quantity
//               const loadedQuantity = item.loaded ? newQuantity : (item.loadedQuantity || 0);
              
//               return { 
//                 ...item, 
//                 quantity: newQuantity,
//                 originalQuantity: item.originalQuantity,
//                 extraQuantity: extraQuantity, // Include extraQuantity in fallback case too
//                 loadedQuantity: loadedQuantity
//               };
//             }
//           }
//         }
//         return item;
//       });
      
//       // Broadcast the update to other views using BroadcastChannel
//       if (broadcastChannelRef.current) {
//         // Generate a unique device ID if none exists
//         if (!window.deviceId) {
//           window.deviceId = `device-${Math.random().toString(36).substring(2, 8)}`;
//         }
        
//         // Calculate extraQuantity for broadcast using original quantity
//         const originalQty = storedOriginalQuantities[itemId] !== undefined 
//           ? storedOriginalQuantities[itemId] 
//           : viewProformaDetails?.items?.find(i => i.id === itemId)?.originalQuantity || 0;
        
//         const extraQty = newlyAddedItems.includes(itemId) ? newQuantity : 
//           (newQuantity > originalQty ? newQuantity - originalQty : 0);
        
//         // Calculate loadedQuantity based on loaded status for broadcast
//         const loadedQty = isItemLoaded ? newQuantity : currentLoadedQty;
        
//         broadcastChannelRef.current.postMessage({
//           type: 'ITEM_QUANTITY_UPDATED',
//           data: {
//             itemId,
//             newQuantity,
//             originalQuantity: originalQty, // Include original quantity in broadcast
//             extraQuantity: extraQty, // Include extraQuantity in broadcast
//             loadedQuantity: loadedQty, // Include loadedQuantity in broadcast
//             loaded: isItemLoaded, // Include loaded status in broadcast
//             operationId,
//             referenceNumber,
//             isNewlyAdded: newlyAddedItems.includes(itemId),
//             forceUpdateCounter: Date.now() // Add timestamp to force refresh on other devices
//           },
//           timestamp: Date.now(),
//           sender: window.deviceId
//         });
        
//         console.log(`[BroadcastSent] Item quantity updated: ${itemId}, quantity: ${newQuantity}, loadedQuantity: ${loadedQty}`);
//       }
      
//       // Force dialog refresh
//       setTimeout(() => {
//         setForceUpdateCounter(Date.now());
//       }, 50);
      
//       return {
//         ...prev,
//         items: updatedItems
//       };
//     });
    
//     // Store updates for later save
//     const itemUpdateKey = `item-updates-${operationId}`;
//     const currentUpdates = JSON.parse(sessionStorage.getItem(itemUpdateKey) || '{}');
//     sessionStorage.setItem(itemUpdateKey, JSON.stringify({
//       ...currentUpdates,
//       [itemId]: newQuantity
//     }));
    
//     // Get the item and determine whether it's a newly added item
//     const foundItem = viewProformaDetails?.items?.find(i => i.id === itemId);
//     if (foundItem) {
//       const operation = data?.find(op => op.id === operationId);
//       let referenceNumber = operation?.referenceNumber || "";
      
//       // Create another key to track which items were newly added to this reference number
//       const newItemsKey = `proforma-new-items-${referenceNumber.trim()}`;
      
//       // Get the list of newly added items from localStorage
//       let newlyAddedItems: number[] = [];
//       try {
//         const storedNewItems = localStorage.getItem(newItemsKey);
//         if (storedNewItems) {
//           newlyAddedItems = JSON.parse(storedNewItems);
//         }
//       } catch (err) {
//         console.error("Error loading newly added items list:", err);
//       }
      
//       // Check if this is a newly added item
//       const isNewlyAddedItem = foundItem.id !== null && newlyAddedItems.includes(foundItem.id);
      
//       // Calculate correct values for the API call
//       const originalQty = foundItem.originalQuantity || 0;
//       const extraQty = newQuantity > originalQty ? newQuantity - originalQty : 0;
//       const loadedQty = isItemLoaded ? newQuantity : currentLoadedQty;
      
//       try {
//         // CRITICAL FIX: Explicitly include loaded status and loadedQuantity in the API call
//         // This ensures buttons and manual input behave the same way
//         console.log(`Making direct API call to update item ${itemId} with loadedQty=${loadedQty}, isLoaded=${isItemLoaded}`);
        
//         await apiRequest("PATCH", `/api/loading-operation-items/${itemId}`, {
//           quantity: newQuantity,
//           originalQuantity: originalQty,
//           extraQuantity: extraQty,
//           loaded: isItemLoaded,
//           loadedQuantity: loadedQty
//         });
        
//         console.log(`Successfully updated item ${itemId} with complete data`);
        
//         // Force another update after saving to database to ensure UI consistency
//         setTimeout(() => {
//           setForceUpdateCounter(Date.now());
//         }, 100);
//       } catch (error) {
//         console.error("Error directly updating item:", error);
        
//         // Fallback to the utility function if direct update fails
//         try {
//           await updateItemWithExtraQuantity(
//             itemId, 
//             newQuantity, 
//             foundItem.originalQuantity,
//             isNewlyAddedItem
//           );
//           console.log(`Fallback: Extra quantity saved for item ${itemId}`);
//         } catch (fallbackError) {
//           console.error("Error in fallback update method:", fallbackError);
//         }
//       }
//     }
//   };
  
//   // Delete item from slip
//   const deleteItem = async (itemId: number, operationId: number, referenceNumber: string | null) => {
//     // Debug logging
//     console.log(`Attempting to delete item with ID: ${itemId} from operation: ${operationId}, reference: ${referenceNumber}`);
    
//     // Get the item name for a more descriptive confirmation message
//     const item = viewProformaDetails?.items?.find(i => i.id === itemId);
//     const itemName = item ? getItemName(item) : `Item #${itemId}`;
    
//     // Show confirmation dialog before deletion
//     const confirmDelete = window.confirm(`Are you sure you want to delete "${itemName}"?`);
//     if (!confirmDelete) {
//       console.log('Delete operation cancelled by user');
//       return; // Exit if user cancels
//     }
    
//     // Normalize reference number
//     const refNumber = referenceNumber || "";
//     const trimmedRef = refNumber.trim();
    
//     // Create storage keys
//     const storageKey = `proforma-original-quantities-${trimmedRef}`;
//     const newItemsKey = `proforma-new-items-${trimmedRef}`;
    
//     console.log(`Storage key for original quantities: ${storageKey}`);
      
//     try {
//       // 1. First send the delete request to the API
//       console.log(`Sending DELETE request to /api/loading-operation-items/${itemId}`);
//       const response = await apiRequest("DELETE", `/api/loading-operation-items/${itemId}`);
      
//       // Check if the response is successful (status 200 or 204)
//       if (response.ok) {
//         console.log(`DELETE response successful:`, response.status);
        
//         // 2. Show success toast immediately for instant feedback
//         toast({
//           title: "Item Deleted",
//           description: "Item was successfully removed",
//           variant: "default",
//         });
        
//         // 3. Update the UI immediately to provide visual feedback
//         setViewProformaDetails(prev => {
//           if (!prev) {
//             console.log(`No view operation details to update`);
//             return prev;
//           }
          
//           console.log(`Updating UI by removing item ${itemId} from list of ${prev.items.length} items`);
//           return {
//             ...prev,
//             items: prev.items.filter(item => item.id !== itemId)
//           };
//         });
        
//         // 4. Clean up localStorage
//         try {
//           // Get stored original quantities
//           let storedOriginalQuantities: Record<number, number> = {};
//           const storedData = localStorage.getItem(storageKey);
//           if (storedData) {
//             storedOriginalQuantities = JSON.parse(storedData);
//             console.log(`Found stored original quantities:`, storedOriginalQuantities);
            
//             // Remove the item from localStorage if it exists
//             if (storedOriginalQuantities[itemId] !== undefined) {
//               delete storedOriginalQuantities[itemId];
//               localStorage.setItem(storageKey, JSON.stringify(storedOriginalQuantities));
//               console.log(`Removed item ${itemId} from stored original quantities`);
//             }
//           }
          
//           // Check for newly added items
//           let newlyAddedItems: number[] = [];
//           const storedNewItems = localStorage.getItem(newItemsKey);
//           if (storedNewItems) {
//             newlyAddedItems = JSON.parse(storedNewItems);
            
//             // Remove the item from newly added items if it exists
//             const updatedNewItems = newlyAddedItems.filter(id => id !== itemId);
//             localStorage.setItem(newItemsKey, JSON.stringify(updatedNewItems));
//             console.log(`Updated newly added items storage`, updatedNewItems);
//           }
//         } catch (err) {
//           console.error("Error cleaning up localStorage:", err);
//           // Non-critical error, continue execution
//         }
        
//         // 5. Refresh the operations list to reflect changes
//         console.log(`Refreshing operations list after item deletion`);
//         if (refetchRef.current) {
//           refetchRef.current();
//         }
        
//         // 6. Broadcast the change to other devices (if WebSocket capabilities exist)
//         if (window.BroadcastChannel && operationId) {
//           try {
//             const bc = new BroadcastChannel('proforma-updates');
//             bc.postMessage({
//               type: 'item-deleted',
//               operationId,
//               itemId,
//               timestamp: Date.now()
//             });
//             console.log(`[Broadcast] Sent item-deleted message for item ${itemId} in operation ${operationId}`);
//           } catch (err) {
//             console.error('[Broadcast] Error sending item-deleted message:', err);
//             // Non-critical error, continue execution
//           }
//         }
//       } else {
//         // Handle error response (non-2xx status)
//         console.error(`Error deleting item: API returned status ${response.status}`);
//         const errorData = await response.json().catch(() => ({}));
//         toast({
//           title: "Error",
//           description: errorData.message || "Failed to delete item",
//           variant: "destructive",
//         });
//       }
//     } catch (error) {
//       console.error("Error deleting item:", error);
//       toast({
//         title: "Error",
//         description: "Failed to delete item. Please try again.",
//         variant: "destructive",
//       });
//     }
//   };
  
//   // Save all changes to the item quantities and loaded states
//   const saveAllChanges = async (operationId: number) => {
//     try {
//       // Start timer for performance measuring
//       const startTime = performance.now();
//       console.log(`Starting batch save operation for operation ID ${operationId}`);
      
//       // Show loading toast to indicate processing
//       toast({
//         title: "Saving changes",
//         description: "Please wait while your changes are being saved...",
//       });
      
//       // Find the current operation to get its reference number
//       const operation = data?.find(op => op.id === operationId);
//       const referenceNumber = operation?.referenceNumber || "";
      
//       // Get newly added items from localStorage
//       const newItemsKey = `proforma-new-items-${referenceNumber.trim()}`;
//       let newlyAddedItems: number[] = [];
//       try {
//         const storedNewItems = localStorage.getItem(newItemsKey);
//         if (storedNewItems) {
//           newlyAddedItems = JSON.parse(storedNewItems);
//           console.log(`Loaded newly added items for saving: ${referenceNumber}:`, newlyAddedItems);
//         }
//       } catch (err) {
//         console.error("Error loading newly added items list for saving:", err);
//       }
      
//       const itemUpdateKey = `item-updates-${operationId}`;
//       const updates = JSON.parse(sessionStorage.getItem(itemUpdateKey) || '{}');
//       const table = document.getElementById(`items-table-${operationId}`);
//       const mobileItems = document.getElementById(`mobile-items-${operationId}`);
      
//       // Collect all item updates for batch processing
//       const batchUpdates: any[] = [];
//       // Also keep track of updated items for broadcasting to other tabs
//       const updatedItems: any[] = [];
      
//       // First, capture current values from all quantity inputs in desktop view
//       // This ensures we save the actual current values, not just the ones stored in updates
//       if (table) {
//         const quantityInputs = table.querySelectorAll('input[type="number"]');
//         quantityInputs.forEach((input) => {
//           const inputEl = input as HTMLInputElement;
//           const itemRow = inputEl.closest('tr');
//           if (itemRow) {
//             const itemId = itemRow.getAttribute('data-item-id');
//             if (itemId) {
//               const newQuantity = parseInt(inputEl.value) || 1;
//               // Update our updates object with the current input value
//               updates[itemId] = newQuantity;
//             }
//           }
//         });
//       }
      
//       // Also capture current values from mobile view inputs
//       if (mobileItems) {
//         const mobileQuantityInputs = mobileItems.querySelectorAll('input[type="number"]');
//         mobileQuantityInputs.forEach((input) => {
//           const inputEl = input as HTMLInputElement;
//           const itemCard = inputEl.closest('[data-item-id]');
//           if (itemCard) {
//             const itemId = itemCard.getAttribute('data-item-id');
//             if (itemId) {
//               const newQuantity = parseInt(inputEl.value) || 1;
//               // Update our updates object with the current input value
//               updates[itemId] = newQuantity;
//             }
//           }
//         });
//       }
      
//       // Update the session storage with the latest values
//       sessionStorage.setItem(itemUpdateKey, JSON.stringify(updates));
      
//       // Now, collect checkbox states and updated quantities from desktop view
//       if (table) {
//         const checkboxes = table.querySelectorAll('input[type="checkbox"][id^="confirm-loaded-"]');
//         checkboxes.forEach((element) => {
//           const checkbox = element as HTMLInputElement;
//           const itemId = checkbox.id.replace('confirm-loaded-', '');
//           const itemIdNum = parseInt(itemId);
//           const isLoaded = checkbox.checked;
          
//           // Check if this is a newly added item
//           const isNewlyAdded = newlyAddedItems.includes(itemIdNum);
          
//           if (isNewlyAdded) {
//             // For newly added items, always save originalQuantity as 0
//             console.log(`Setting originalQuantity to 0 for newly added item ${itemId} during save`);
            
//             // For new items, extraQty = full quantity since all of it is "extra"
//             const quantity = updates[itemId] || 0;
            
//             batchUpdates.push({
//               id: itemIdNum,
//               loaded: isLoaded,
//               quantity: quantity,
//               originalQuantity: 0,  // Set to 0 for newly added items
//               extraQuantity: quantity  // For new items, extraQty = full quantity
//             });
//           } else {
//             // For regular items, don't update originalQuantity
//             // Calculate extra quantity for regular items
//             const originalItem = viewProformaDetails?.items?.find(i => i.id === itemIdNum);
//             const origQty = originalItem?.originalQuantity || 0;
//             const currentQty = updates[itemId] || (originalItem?.quantity || 0);
//             const extraQty = currentQty > origQty ? currentQty - origQty : 0;
            
//             batchUpdates.push({
//               id: itemIdNum,
//               loaded: isLoaded,
//               quantity: updates[itemId] || undefined,
//               extraQuantity: extraQty
//             });
//           }
//         });
//       }
      
//       // Then collect from mobile view
//       if (mobileItems) {
//         const mobileCheckboxes = mobileItems.querySelectorAll('input[type="checkbox"][id^="confirm-loaded-mobile-"]');
//         mobileCheckboxes.forEach((element) => {
//           const checkbox = element as HTMLInputElement;
//           const itemId = checkbox.id.replace('confirm-loaded-mobile-', '');
//           const itemIdNum = parseInt(itemId);
//           const isLoaded = checkbox.checked;
          
//           // Check if this is a newly added item
//           const isNewlyAdded = newlyAddedItems.includes(itemIdNum);
          
//           // Only add if not already added from desktop view
//           if (!document.getElementById(`confirm-loaded-${itemId}`)) {
//             if (isNewlyAdded) {
//               // For newly added items, always save originalQuantity as 0
//               console.log(`Setting originalQuantity to 0 for newly added mobile item ${itemId} during save`);
              
//               // For new items, extraQty = full quantity since all of it is "extra"
//               const quantity = updates[itemId] || 0;
              
//               batchUpdates.push({
//                 id: itemIdNum,
//                 loaded: isLoaded,
//                 quantity: quantity,
//                 originalQuantity: 0,  // Set to 0 for newly added items
//                 extraQuantity: quantity  // For new items, extraQty = full quantity
//               });
//             } else {
//               // For regular items, don't update originalQuantity
//               // Calculate extra quantity for regular items
//               const originalItem = viewProformaDetails?.items?.find(i => i.id === itemIdNum);
//               const origQty = originalItem?.originalQuantity || 0;
//               const currentQty = updates[itemId] || (originalItem?.quantity || 0);
//               const extraQty = currentQty > origQty ? currentQty - origQty : 0;
              
//               batchUpdates.push({
//                 id: itemIdNum,
//                 loaded: isLoaded,
//                 quantity: updates[itemId] || undefined,
//                 extraQuantity: extraQty
//               });
              
//               // Also track for broadcasting to other tabs
//               updatedItems.push({
//                 id: itemIdNum,
//                 loaded: isLoaded,
//                 quantity: updates[itemId] || undefined
//               });
//             }
//           }
//         });
//       }
      
//       // Add any remaining quantity updates that weren't covered by the checkboxes
//       Object.entries(updates).forEach(([itemId, quantity]) => {
//         if (!document.getElementById(`confirm-loaded-${itemId}`) && 
//             !document.getElementById(`confirm-loaded-mobile-${itemId}`)) {
          
//           const itemIdNum = parseInt(itemId);
          
//           // Only add quantities to batch updates that weren't already included
//           const existingItemIndex = batchUpdates.findIndex(item => item.id === itemIdNum);
//           if (existingItemIndex === -1) {
//             // Calculate extra quantity for item
//             const originalItem = viewProformaDetails?.items?.find(i => i.id === itemIdNum);
//             const origQty = originalItem?.originalQuantity || 0;
//             const extraQty = quantity > origQty ? quantity - origQty : 0;
            
//             batchUpdates.push({
//               id: itemIdNum,
//               quantity,
//               extraQuantity: extraQty
//             });
            
//             // Also track for broadcasting to other tabs
//             updatedItems.push({
//               id: itemIdNum,
//               quantity
//             });
//           }
//         }
//       });
      
//       // Process collected desktop view quantity inputs
//       if (table) {
//         const quantityInputs = table.querySelectorAll('input[type="number"]');
//         quantityInputs.forEach((input) => {
//           const inputEl = input as HTMLInputElement;
//           const itemRow = inputEl.closest('tr');
//           if (itemRow) {
//             const itemId = itemRow.getAttribute('data-item-id');
//             if (itemId) {
//               const newQuantity = parseInt(inputEl.value) || 1;
              
//               // Add or update in batch updates
//               const existingItemIndex = batchUpdates.findIndex(item => item.id === parseInt(itemId));
//               if (existingItemIndex === -1) {
//                 batchUpdates.push({
//                   id: parseInt(itemId),
//                   quantity: newQuantity
//                 });
//               } else {
//                 batchUpdates[existingItemIndex].quantity = newQuantity;
//               }
              
//               // Add to updated items if not already there
//               const existingUpdateIndex = updatedItems.findIndex(item => item.id === parseInt(itemId));
//               if (existingUpdateIndex === -1) {
//                 updatedItems.push({
//                   id: parseInt(itemId),
//                   quantity: newQuantity
//                 });
//               } else {
//                 updatedItems[existingUpdateIndex].quantity = newQuantity;
//               }
//             }
//           }
//         });
//       }
      
//       // Process collected mobile view quantity inputs
//       if (mobileItems) {
//         const mobileQuantityInputs = mobileItems.querySelectorAll('input[type="number"]');
//         mobileQuantityInputs.forEach((input) => {
//           const inputEl = input as HTMLInputElement;
//           const itemCard = inputEl.closest('[data-item-id]');
//           if (itemCard) {
//             const itemId = itemCard.getAttribute('data-item-id');
//             if (itemId) {
//               const newQuantity = parseInt(inputEl.value) || 1;
              
//               // Add or update in batch updates
//               const existingItemIndex = batchUpdates.findIndex(item => item.id === parseInt(itemId));
//               if (existingItemIndex === -1) {
//                 batchUpdates.push({
//                   id: parseInt(itemId),
//                   quantity: newQuantity
//                 });
//               } else {
//                 batchUpdates[existingItemIndex].quantity = newQuantity;
//               }
              
//               // Only add quantities to updated items that weren't already included
//               const existingUpdateIndex = updatedItems.findIndex(item => item.id === parseInt(itemId));
//               if (existingUpdateIndex === -1) {
//                 updatedItems.push({
//                   id: parseInt(itemId),
//                   quantity: newQuantity
//                 });
//               } else {
//                 updatedItems[existingUpdateIndex].quantity = newQuantity;
//               }
//             }
//           }
//         });
//       };
      
//       // Organize batch updates into different categories for optimized processing
//       const batchUpdateTime = performance.now();
//       console.log(`Prepared ${batchUpdates.length} items for batch update in ${(batchUpdateTime - startTime).toFixed(1)}ms`);
      
//       if (batchUpdates.length > 0) {
//         try {
//           // Separate updates into different categories based on what needs to be updated
//           const quantityOnlyItems: {id: number, quantity: number}[] = [];
//           const loadedOnlyItems: any[] = [];
//           const combinedUpdateItems: any[] = [];
//           const newlyAddedWithOriginalItems: any[] = [];
          
//           // Categorize each item into the appropriate update array
//           batchUpdates.forEach(item => {
//             // Find the original item to get its originalQuantity for extraQuantity calculation
//             const originalItem = viewProformaDetails?.items?.find(i => i.id === item.id);
//             const origQty = originalItem?.originalQuantity || 0;
//             const currentQty = item.quantity || (originalItem?.quantity || 0);
            
//             // Calculate extra quantity - if current quantity exceeds original quantity
//             const extraQty = currentQty > origQty ? currentQty - origQty : 0;
//             console.log(`Item ${item.id}: origQty=${origQty}, currentQty=${currentQty}, extraQty=${extraQty}`);
            
//             if (item.originalQuantity !== undefined) {
//               // New items with original quantity set to 0
//               newlyAddedWithOriginalItems.push({
//                 ...item,
//                 extraQuantity: extraQty
//               });
//             } else if (item.loaded !== undefined && item.quantity !== undefined) {
//               // Items with both loaded status and quantity updates
//               combinedUpdateItems.push({
//                 ...item,
//                 originalQuantity: origQty,
//                 extraQuantity: extraQty
//               });
//             } else if (item.loaded !== undefined) {
//               // Items with only loaded status updates
//               loadedOnlyItems.push({
//                 ...item,
//                 originalQuantity: origQty,
//                 extraQuantity: extraQty
//               });
//             } else if (item.quantity !== undefined) {
//               // Items with only quantity updates - include loaded status from original item
//               const originalLoaded = originalItem?.loaded || false;
//               quantityOnlyItems.push({
//                 id: item.id,
//                 quantity: item.quantity,
//                 originalQuantity: origQty,
//                 extraQuantity: extraQty,
//                 loaded: originalItem?.loaded // Preserve the current loaded state
//               });
//             }
//           });
          
//           // Performance timing for batch processing
//           console.log(`Categorized updates: ${quantityOnlyItems.length} quantity-only, ${loadedOnlyItems.length} loaded-only, ${combinedUpdateItems.length} combined, ${newlyAddedWithOriginalItems.length} newly-added`);
          
//           // Process each category of updates using the most efficient method
//           const updatePromises: Promise<any>[] = [];
          
//           // 1. Process quantity-only updates using our new batch function
//           if (quantityOnlyItems.length > 0) {
//             const qtyUpdateStart = performance.now();
//             console.log(`Processing ${quantityOnlyItems.length} quantity-only updates in batch`);
            
//             updatePromises.push(
//               batchUpdateItemsWithOriginalQuantity(quantityOnlyItems, referenceNumber)
//                 .then(response => {
//                   if (!response.ok) {
//                     return response.text().then(text => {
//                       throw new Error(`Batch quantity update failed: ${text}`);
//                     });
//                   }
//                   return response.json();
//                 })
//                 .then(result => {
//                   console.log(`Batch quantity update completed in ${(performance.now() - qtyUpdateStart).toFixed(1)}ms`);
//                   return result;
//                 })
//             );
//           }
          
//           // 2. Process all other updates using the standard batch API
//           const otherItems = [...loadedOnlyItems, ...combinedUpdateItems, ...newlyAddedWithOriginalItems];
//           if (otherItems.length > 0) {
//             const otherUpdateStart = performance.now();
//             console.log(`Processing ${otherItems.length} other updates in batch`);
            
//             updatePromises.push(
//               // Use batch API with enhanced performance options
//               fetch('/api/loading-operation-items/batch-update', {
//                 method: 'POST',
//                 headers: {
//                   'Content-Type': 'application/json',
//                   'X-Priority': 'high',  // Signal high priority to server
//                   'X-Batch-Operation': 'true' // Signal this is a batch operation
//                 },
//                 body: JSON.stringify({ items: otherItems, loadOperationId: operationId }),
//                 keepalive: true, // Keep connection alive for large requests
//                 priority: 'high', // Client-side priority hint
//               })
//               .then(response => {
//                 if (!response.ok) {
//                   return response.text().then(text => {
//                     throw new Error(`Batch update failed: ${text}`);
//                   });
//                 }
//                 return response.json();
//               })
//               .then(result => {
//                 console.log(`Batch "other items" update completed in ${(performance.now() - otherUpdateStart).toFixed(1)}ms`);
//                 return result;
//               })
//             );
//           }
          
//           // Wait for all batch operations to complete
//           await Promise.all(updatePromises);
          
//           // Performance logging
//           const endTime = performance.now();
//           console.log(`All batch updates completed in ${(endTime - batchUpdateTime).toFixed(1)}ms`);
//           console.log(`Total save operation took ${(endTime - startTime).toFixed(1)}ms`);
//         } catch (error) {
//           console.error('Batch update failed:', error);
//           toast({
//             title: "Error",
//             description: "Failed to save some items. Please try again.",
//             variant: "destructive",
//           });
          
//           // Fallback to individual updates if batch fails
//           console.log("Falling back to individual updates...");
//           const updatePromises: Promise<any>[] = [];
          
//           for (const item of batchUpdates) {
//             // Find the original item to get its originalQuantity for extraQuantity calculation
//             const originalItem = viewProformaDetails?.items?.find(i => i.id === item.id);
//             const origQty = originalItem?.originalQuantity || 0;
//             const currentQty = item.quantity || (originalItem?.quantity || 0);
            
//             // Calculate extra quantity - if current quantity exceeds original quantity
//             const extraQty = currentQty > origQty ? currentQty - origQty : 0;
            
//             if (item.originalQuantity !== undefined) {
//               // For newly added items with originalQuantity
//               updatePromises.push(
//                 fetch(`/api/loading-operation-items/${item.id}`, {
//                   method: 'PATCH',
//                   headers: {
//                     'Content-Type': 'application/json',
//                     'X-Priority': 'high',  // Signal high priority to server
//                   },
//                   body: JSON.stringify({
//                     loaded: item.loaded,
//                     quantity: item.quantity,
//                     originalQuantity: item.originalQuantity,
//                     extraQuantity: extraQty,
//                     loadOperationId: operationId
//                   }),
//                   keepalive: true, // Keep connection alive for large requests
//                   priority: 'high', // Client-side priority hint
//                 }).then(response => {
//                   if (!response.ok) {
//                     throw new Error(`Failed to update item ${item.id}: ${response.status}`);
//                   }
//                   return response.json();
//                 })
//               );
//             } else if (item.loaded !== undefined && item.quantity !== undefined) {
//               // For items with both loaded state and quantity
//               updatePromises.push(
//                 apiRequest("PATCH", `/api/loading-operation-items/${item.id}`, {
//                   loaded: item.loaded,
//                   quantity: item.quantity,
//                   extraQuantity: extraQty,
//                   loadOperationId: operationId
//                 })
//               );
//             } else if (item.loaded !== undefined) {
//               // For items with only loaded state
//               updatePromises.push(
//                 apiRequest("PATCH", `/api/loading-operation-items/${item.id}`, {
//                   loaded: item.loaded,
//                   extraQuantity: extraQty,
//                   loadOperationId: operationId
//                 })
//               );
//             } else if (item.quantity !== undefined) {
//               // For items with only quantity
//               updatePromises.push(
//                 apiRequest("PATCH", `/api/loading-operation-items/${item.id}`, {
//                   quantity: item.quantity,
//                   extraQuantity: extraQty,
//                   loadOperationId: operationId
//                 })
//               );
//             }
//           }
          
//           await Promise.all(updatePromises);
//         }
//       } else {
//         console.log("No items to update");
//       }
      
//       // Clear the updates
//       sessionStorage.removeItem(itemUpdateKey);
      
//       // Broadcast changes to other tabs using BroadcastChannel
//       if (broadcastChannelRef.current && updatedItems.length > 0) {
//         // Generate a unique device ID if none exists
//         if (!window.deviceId) {
//           window.deviceId = `device-${Math.random().toString(36).substring(2, 8)}`;
//         }
        
//         broadcastChannelRef.current.postMessage({
//           type: 'LOADED_STATUS_UPDATED',
//           operationId,
//           data: updatedItems,
//           timestamp: Date.now(),
//           sender: window.deviceId
//         });
        
//         console.log(`[BroadcastSent] Updated loaded statuses for ${updatedItems.length} items at ${new Date().toISOString()}`);
//       }
      
//       // Show success message
//       const successElement = document.getElementById(`update-success-${operationId}`);
//       if (successElement) {
//         successElement.classList.remove('hidden');
//         setTimeout(() => {
//           successElement.classList.add('hidden');
//         }, 3000);
//       }
      
//       // Show success toast with performance metrics
//       const endTime = performance.now();
//       const totalTime = (endTime - startTime).toFixed(0);
//       toast({
//         title: "Changes Saved",
//         description: `${batchUpdates.length} items updated in ${totalTime}ms`,
//         variant: "default",
//       });
      
//       // Refresh operations list with stronger cache invalidation
//       try {
//         // First, cancel any ongoing queries to prevent race conditions
//         queryClient.cancelQueries({ queryKey: ['/api/loading-operations'] });
        
//         // Then forcefully invalidate the cache to ensure we get fresh data
//         queryClient.invalidateQueries({ 
//           queryKey: ['/api/loading-operations'],
//           refetchType: 'all' // Force immediate refetch of all queries
//         });
        
//         // Also update the operation counts to refresh tabs
//         queryClient.invalidateQueries({ 
//           queryKey: ['/api/loading-operations/status/count'],
//           refetchType: 'all'
//         });
        
//         // Finally trigger the refetch using our ref
//         if (refetchRef.current) {
//           console.log("Forcefully refetching operations list after save...");
//           await refetchRef.current();
//         }
//       } catch (err) {
//         console.error("Error refreshing operations list:", err);
//       }
      
//       // Find the current operation in the data to get its reference number
//       const currentOperation = data?.find(op => op.id === operationId);
//       if (currentOperation && currentOperation.referenceNumber) {
//         // First remove the cached data to force a fresh fetch
//         if (currentOperation.referenceNumber) {
//           setProformaSlipsData(prev => {
//             const newData = {...prev};
//             delete newData[currentOperation.referenceNumber!.trim()];
//             return newData;
//           });
//         }
//         const refreshedDetails = await fetchLoadOperationDetails(currentOperation.referenceNumber, currentOperation.id);
//         if (refreshedDetails) {
//           setViewProformaDetails(refreshedDetails);
//           console.log("Updated operation details after save:", refreshedDetails.items.map((item: any) => ({ id: item.id, quantity: item.quantity })));
          
//           // Broadcast the updates to other tabs/devices via BroadcastChannel and WebSocket
//           if (broadcastChannelRef.current && updatedItems.length > 0) {
//             // Generate a unique device ID if none exists
//             if (!window.deviceId) {
//               window.deviceId = `device-${Math.random().toString(36).substring(2, 8)}`;
//             }
            
//             // Create the update message
//             const updateMessage = {
//               type: 'LOADED_STATUS_UPDATED',
//               operationId: operationId,
//               data: updatedItems,
//               timestamp: Date.now(),
//               sender: window.deviceId
//             };
            
//             // Send via BroadcastChannel for same-device tabs
//             broadcastChannelRef.current.postMessage(updateMessage);
//             console.log(`[BroadcastSent] Bulk updates for ${updatedItems.length} items at ${new Date().toISOString()}`);
            
//             // Also send via WebSocket for cross-device communication (DISABLED)
//             // if (wsRef.current && wsRef.current.readyState === WebSocket.OPEN) {
//             //   wsRef.current.send(JSON.stringify(updateMessage));
//             //   console.log(`[WebSocketSent] Bulk updates for ${updatedItems.length} items at ${new Date().toISOString()}`);
//             // }
            
//             // Ensure the dialog remains open by explicitly setting its state
//             setEditDialogOpenStates(prev => ({
//               ...prev,
//               [operationId]: true
//             }));
//           }
//         }
//       }
//     } catch (error) {
//       console.error("Error updating items:", error);
//       // Suppress error toast when updating items during status change to READY≈DESP
//       // This avoids showing unnecessary error notifications during sales entry generation
//       if (!operationStatusChanging) {
//         toast({
//           title: "Error",
//           description: "Failed to update items",
//           variant: "destructive",
//         });
//       }
//     }
//   };

//   // Function to fetch proforma slip details based on reference number
//   // Performance optimization: Added loading state to show dialog immediately
//   // Helper function to check if we have cached data
//   const hasCachedProformaData = (orderNumber: string | null): boolean => {
//     if (!orderNumber) return false;
//     return !!proformaSlipsData[orderNumber.trim()];
//   };
  
//   // Function to fetch load operation details based on reference number and operationId
//   const fetchLoadOperationDetails = async (referenceNumber: string | null, operationId?: number) => {
//     try {
//       // Performance metrics
//       const startTime = performance.now();
      
//       if (!referenceNumber) {
//         throw new Error("Reference number is required");
//       }
      
//       const trimmedRef = referenceNumber.trim();
//       const storageKey = `proforma-original-quantities-${trimmedRef}`;
//       const newItemsKey = `proforma-new-items-${trimmedRef}`;
      
//       // PERFORMANCE OPTIMIZATION: Check if we already have cached data for immediate display
      
//       // Check if we already have this data cached in state
//       let data = proformaSlipsData[trimmedRef];
      
//       // Aggressively try to get operation items first if we have an operation ID
//       // This ensures we show the load operation's actual items with the correct loaded states
//       if (operationId) {
//         try {
//           console.log(`Fetching load operation items for operation ID ${operationId}`);
//           const loadItemsResponse = await apiRequest('GET', `/api/loading-operations/${operationId}/items`);
//           const loadItems = await loadItemsResponse.json();
          
//           // Debug: Log number of load items received
//           console.log(`Received ${Array.isArray(loadItems) ? loadItems.length : 0} load operation items for operation ID ${operationId}`);
          
//           if (Array.isArray(loadItems) && loadItems.length > 0) {
//             console.log(`Found ${loadItems.length} load operation items - using these instead of proforma data`);
            
//             // Process each item to ensure consistent field naming between snake_case and camelCase
//             // This fixes a key issue where snake_case fields from server aren't recognized by client code
//             const normalizedItems = loadItems.map(item => {
//               // Create a normalized version with both snake_case and camelCase fields
//               const normalized = {
//                 ...item,
//                 // Ensure camelCase fields exist even if server returns snake_case
//                 extraQuantity: item.extraQuantity !== undefined ? item.extraQuantity : 
//                               (item.extra_quantity !== undefined ? item.extra_quantity : 0),
//                 originalQuantity: item.originalQuantity !== undefined ? item.originalQuantity : 
//                                  (item.original_quantity !== undefined ? item.original_quantity : 
//                                  (item.quantity !== undefined ? item.quantity : 0)),
//                 loadedQuantity: item.loadedQuantity !== undefined ? item.loadedQuantity : 
//                               (item.loaded_quantity !== undefined ? item.loaded_quantity : 0),
//                 // Ensure both versions of the field exist
//                 extra_quantity: item.extraQuantity !== undefined ? item.extraQuantity : 
//                               (item.extra_quantity !== undefined ? item.extra_quantity : 0),
//                 original_quantity: item.originalQuantity !== undefined ? item.originalQuantity : 
//                                  (item.original_quantity !== undefined ? item.original_quantity : 
//                                  (item.quantity !== undefined ? item.quantity : 0)),
//                 loaded_quantity: item.loadedQuantity !== undefined ? item.loadedQuantity : 
//                               (item.loaded_quantity !== undefined ? item.loaded_quantity : 0),
//               };
              
//               // Debug info to help diagnose missing data
//               console.log(`Normalized item ${item.id}: loaded=${normalized.loaded}, quantity=${normalized.quantity}, extraQty=${normalized.extraQuantity}, origQty=${normalized.originalQuantity}`);
              
//               return normalized;
//             });
            
//             // If we have load items, we'll use these as our primary data source
//             // No need to even fetch proforma data in this case, since load operations are completely independent
            
//             // Prepare product fetching - collect all product IDs to fetch
//             const productIds = normalizedItems
//               .filter(item => item.productId)
//               .map(item => Number(item.productId))
//               .filter(id => id !== null && !isNaN(id));
            
//             console.log(`Found ${productIds.length} unique product IDs to fetch for operation ${operationId}`);
            
//             // Map to store product data
//             const productDataMap = new Map();
            
//             // Use batch API to fetch all products at once
//             if (productIds.length > 0) {
//               try {
//                 // Log performance metrics
//                 const productFetchStart = performance.now();
//                 console.log(`Using batch API to fetch ${productIds.length} products`);
                
//                 const batchProductResponse = await fetch('/api/products/batch', {
//                   method: 'POST',
//                   headers: {
//                     'Content-Type': 'application/json',
//                   },
//                   body: JSON.stringify({ productIds }),
//                 });
                
//                 if (batchProductResponse.ok) {
//                   const productBatchResults = await batchProductResponse.json();
//                   const productFetchEnd = performance.now();
//                   console.log(`Successfully fetched products via batch API in ${(productFetchEnd - productFetchStart).toFixed(2)}ms`);
                  
//                   // Debug: Log product data received
//                   console.log(`Received product data for ${Object.keys(productBatchResults).length} products`);
                  
//                   // Process all products in one go
//                   for (const productId of Object.keys(productBatchResults)) {
//                     const product = productBatchResults[productId];
                    
//                     // Find the load operation items matching this product and add the data to our map
//                     const matchingItems = normalizedItems.filter(item => 
//                       item.productId === parseInt(productId) || item.productId === productId
//                     );
                    
//                     for (const item of matchingItems) {
//                       productDataMap.set(item.id, {
//                         itemName: product.name,
//                         barcode: product.barcode,
//                         srNo: product.srNo,
//                         srNoDisplay: product.srNo ? product.srNo.toString() : ""
//                       });
//                     }
//                   }
//                 }
//               } catch (error) {
//                 console.error(`Error fetching products in batch:`, error);
//               }
//             }
            
//             // Map the load items with product data
//             const enrichedItems = normalizedItems.map((loadItem, idx) => {
//               // Get the product data we fetched earlier
//               const productData = productDataMap.get(loadItem.id);
              
//               // Ensure consistent field values by normalizing snake_case and camelCase fields
//               const normalizedExtraQuantity = loadItem.extraQuantity !== undefined ? loadItem.extraQuantity : 
//                                             (loadItem.extra_quantity !== undefined ? loadItem.extra_quantity : 0);
              
//               const normalizedOriginalQuantity = loadItem.originalQuantity !== undefined ? loadItem.originalQuantity : 
//                                                (loadItem.original_quantity !== undefined ? loadItem.original_quantity : 
//                                                (loadItem.quantity !== undefined ? loadItem.quantity : 0));
              
//               // Debug the normalized values to confirm proper field access
//               console.log(`Item ${loadItem.id}: quantity=${loadItem.quantity}, originalQuantity=${normalizedOriginalQuantity}, extraQuantity=${normalizedExtraQuantity}, loaded=${loadItem.loaded}`);
              
//               // Create the enriched item with all the data we have
//               return {
//                 id: loadItem.id,
//                 proformaSlipId: loadItem.proformaSlipId,
//                 productId: loadItem.productId,
//                 // Always populate both database field naming conventions (sr_no, item_name) and legacy camelCase fields
//                 // Database field naming (primary)
//                 sr_no: loadItem.sr_no || loadItem.srNo || productData?.srNo || idx + 1,
//                 sr_no_display: loadItem.sr_no_display || loadItem.srNoDisplay || productData?.srNoDisplay || (idx + 1).toString(),
//                 item_name: loadItem.item_name || loadItem.itemName || productData?.itemName || "Unknown Product",
//                 barcode: loadItem.barcode || loadItem.sku || productData?.barcode || "",
                
//                 // Legacy camelCase fields (for backwards compatibility)
//                 srNo: loadItem.sr_no || loadItem.srNo || productData?.srNo || idx + 1,
//                 srNoDisplay: loadItem.sr_no_display || loadItem.srNoDisplay || productData?.srNoDisplay || (idx + 1).toString(),
//                 itemName: loadItem.item_name || loadItem.itemName || productData?.itemName || "Unknown Product",
//                 sku: loadItem.barcode || loadItem.sku || productData?.barcode || "",
                
//                 // Critical fields for load operations - ensure we have default values for each
//                 loaded: loadItem.loaded === true || loadItem.loaded === 'true', // Handle both boolean and string representations
//                 originalQuantity: typeof loadItem.originalQuantity === 'number' ? loadItem.originalQuantity : 
//                                  (typeof loadItem.original_quantity === 'number' ? loadItem.original_quantity : 0),
//                 quantity: typeof loadItem.quantity === 'number' ? loadItem.quantity : 0,
//                 loadedQuantity: typeof loadItem.loadedQuantity === 'number' ? loadItem.loadedQuantity :
//                               (typeof loadItem.loaded_quantity === 'number' ? loadItem.loaded_quantity : 
//                               (loadItem.loaded ? (typeof loadItem.quantity === 'number' ? loadItem.quantity : 0) : 0)),
//                 extraQuantity: typeof loadItem.extraQuantity === 'number' ? loadItem.extraQuantity : 
//                               (typeof loadItem.extra_quantity === 'number' ? loadItem.extra_quantity : 0),
//                 // Add both snake_case versions for database consistency
//                 loaded_quantity: typeof loadItem.loadedQuantity === 'number' ? loadItem.loadedQuantity :
//                               (typeof loadItem.loaded_quantity === 'number' ? loadItem.loaded_quantity : 
//                               (loadItem.loaded ? (typeof loadItem.quantity === 'number' ? loadItem.quantity : 0) : 0)),
//                 extra_quantity: typeof loadItem.extraQuantity === 'number' ? loadItem.extraQuantity : 
//                               (typeof loadItem.extra_quantity === 'number' ? loadItem.extra_quantity : 0),
//                 original_quantity: typeof loadItem.originalQuantity === 'number' ? loadItem.originalQuantity : 
//                                  (typeof loadItem.original_quantity === 'number' ? loadItem.original_quantity : 0),
//                 createdAt: loadItem.createdAt || null
//               } as ProformaSlipItem;
//             });
            
//             console.log(`Successfully processed ${enrichedItems.length} load operation items`);
            
//             // Even if load operations has items, we need proper slip info from proforma data
//             // If we don't have data cached already, fetch it
//             if (!data) {
//               try {
//                 console.log(`No cached proforma data for ${trimmedRef}, fetching from API for order details`);
//                 const batchResponse = await fetch('/api/proforma-slips/batch', {
//                   method: 'POST',
//                   headers: {
//                     'Content-Type': 'application/json',
//                   },
//                   body: JSON.stringify({ orderNumbers: [trimmedRef] }),
//                 });
                
//                 const batchResults = await batchResponse.json();
//                 data = batchResults[trimmedRef];
                
//                 if (data) {
//                   console.log(`Successfully fetched proforma slip data for ${trimmedRef}`);
//                   // Store the fetched data in state for future use
//                   setProformaSlipsData(prev => ({
//                     ...prev,
//                     [trimmedRef]: data
//                   }));
//                 }
//               } catch (error) {
//                 console.error(`Error fetching proforma data for slip details:`, error);
//               }
//             }
            
//             // Get load operation details directly instead of relying on proforma slip
//             try {
//               // Fetch the load operation details to get orderDate, plant, etc.
//               console.log(`Fetching complete load operation details for operation ID ${operationId}`);
//               const loadOpResponse = await apiRequest('GET', `/api/loading-operations/${operationId}`);
//               const loadOp = await loadOpResponse.json();
              
//               // Construct a slip-like object from the load operation data
//               // This ensures that we only rely on load operation data, not proforma data
//               const slipInfo = {
//                 orderNumber: trimmedRef,
//                 orderDate: loadOp.orderDate,
//                 plant: loadOp.plant,
//                 partyName: loadOp.partyName || (data?.slip?.partyName || ""),
//                 vehicleNumber: loadOp.vehicleNumber || (data?.slip?.vehicleNumber || ""),
//                 driverName: loadOp.driverName || (data?.slip?.driverName || "")
//               };
              
//               console.log(`Using load operation data for ${trimmedRef} with order date ${slipInfo.orderDate}`);
              
//               // Log the fact that we are returning this data
//               console.log(`Returning load operation data with ${enrichedItems.length} items for operation ID ${operationId}`);
              
//               // Return the processed data with both slip info and load operation items
//               const result = {
//                 slip: slipInfo,
//                 items: enrichedItems,
//                 operation: { id: operationId, status: loadOp.status }
//               };
              
//               // Debug: Log the items we're returning
//               console.log(`Returning ${result.items.length} items with data`);
              
//               return result;
//             } catch (error) {
//               console.error(`Error fetching complete load operation details:`, error);
              
//               // Fallback to minimal data if we can't get the load operation details
//               const slipInfo = data ? data.slip : { orderNumber: trimmedRef };
              
//               // Return the processed data with both slip info and load operation items
//               return {
//                 slip: slipInfo,
//                 items: enrichedItems,
//                 operation: { id: operationId }
//               };
//             }
//           } else {
//             console.log(`No load operation items found for operation ID ${operationId}, falling back to proforma data`);
//           }
//         } catch (error) {
//           console.error(`Error fetching load operation items:`, error);
//           // Continue with proforma data fallback
//         }
//       }
      
//       // Only use proforma data if we don't already have load operation data
//       // This fixes the issue where edit dialog shows proforma values instead of load operation values
//       if (data && !operationId) {
//         console.log(`Using cached data for proforma slip (no operation ID available): ${trimmedRef}`);
        
//         // Create a processed data object for immediate display
//         const quickProcessedData = {
//           slip: data.slip,
//           items: data.items.map((item: ProformaSlipItem, idx: number) => ({
//             ...item,
//             // Enhanced processing for consistent display
//             sr_no: item.sr_no || item.srNo || idx + 1,
//             sr_no_display: item.sr_no_display || item.srNoDisplay || (idx + 1).toString(),
//             item_name: item.item_name || item.itemName,
//             barcode: item.barcode || item.sku,
//             srNo: item.sr_no || item.srNo || idx + 1,
//             srNoDisplay: item.sr_no_display || item.srNoDisplay || (idx + 1).toString(),
//             itemName: item.item_name || item.itemName,
//             sku: item.barcode || item.sku,
//             loaded: item.loaded === true || item.loaded === 'true', // Handle both boolean and string representations
//             originalQuantity: item.originalQuantity !== undefined ? item.originalQuantity : 
//                            (item.original_quantity !== undefined ? item.original_quantity : 
//                            (item.quantity !== undefined ? item.quantity : 0)),
//             quantity: item.quantity !== undefined ? item.quantity : 0,
//             loadedQuantity: item.loadedQuantity !== undefined ? item.loadedQuantity :
//                           (item.loaded_quantity !== undefined ? item.loaded_quantity : 
//                           (item.loaded ? (item.quantity !== undefined ? item.quantity : 0) : 0)),
//             extraQuantity: item.extraQuantity !== undefined ? item.extraQuantity : 
//                          (item.extra_quantity !== undefined ? item.extra_quantity : 0),
//             // Add snake_case versions for database consistency
//             loaded_quantity: item.loadedQuantity !== undefined ? item.loadedQuantity :
//                           (item.loaded_quantity !== undefined ? item.loaded_quantity : 
//                           (item.loaded ? (item.quantity !== undefined ? item.quantity : 0) : 0)),
//             extra_quantity: item.extraQuantity !== undefined ? item.extraQuantity : 
//                           (item.extra_quantity !== undefined ? item.extra_quantity : 0),
//             original_quantity: item.originalQuantity !== undefined ? item.originalQuantity : 
//                              (item.original_quantity !== undefined ? item.original_quantity : 
//                              (item.quantity !== undefined ? item.quantity : 0))
//           })),
//           // Make sure to include the operation ID for proper identification
//           operation: operationId ? { id: operationId } : undefined
//         };
        
//         // Get stored data from localStorage asynchronously while dialog is already open
//         setTimeout(async () => {
//           try {
//             // Try to get previously stored original quantities and newly added items from localStorage
//             let storedOriginalQuantities: Record<number, number> = {};
//             let newlyAddedItems: number[] = [];
            
//             const storedData = localStorage.getItem(storageKey);
//             const storedNewItems = localStorage.getItem(newItemsKey);
            
//             if (storedData) {
//               storedOriginalQuantities = JSON.parse(storedData);
//             }
            
//             if (storedNewItems) {
//               newlyAddedItems = JSON.parse(storedNewItems);
//             }
            
//             // Enhance the data with loaded states and original quantities - using the helper function we added
//             const enhancedData = enhanceProformaData(data, viewProformaDetails, storedOriginalQuantities, newlyAddedItems);
            
//             // Include the operation ID
//             if (operationId) {
//               enhancedData.operation = { id: operationId };
//             }
            
//             // Only update view if we didn't already update it with load operation items
//             if (!operationId || !viewProformaDetails?.operation?.id) {
//               setViewProformaDetails(enhancedData);
//             }
            
//             // Fetch operation items if needed - this happens in background while dialog is already open
//             if (operationId) {
//               fetchOperationItemsInBackground(data, trimmedRef);
//             }
            
//           } catch (err) {
//             console.error("Error loading stored data:", err);
//           }
//         }, 100);
        
//         return quickProcessedData;
//       }
      
//       console.log(`No cached data found. Using batch API to fetch proforma slip with order number: ${trimmedRef}`);
      
//       // No cached data, fetch from API
//       const batchResponse = await fetch('/api/proforma-slips/batch', {
//         method: 'POST',
//         headers: {
//           'Content-Type': 'application/json',
//         },
//         body: JSON.stringify({ orderNumbers: [trimmedRef] }),
//       });
      
//       const batchResults = await batchResponse.json();
//       data = batchResults[trimmedRef];
      
//       // Store the fetched data in state for future use
//       if (data) {
//         setProformaSlipsData(prev => ({
//           ...prev,
//           [trimmedRef]: data
//         }));
//       } else {
//         console.error(`Failed to fetch proforma slip data for ${trimmedRef}`);
//         return null;
//       }
      
//       // Create maps to preserve current states and values
//       // Try to get previously stored original quantities and newly added items from localStorage
//       let storedOriginalQuantities: Record<number, number> = {};
//       let newlyAddedItems: number[] = [];
      
//       try {
//         const storedData = localStorage.getItem(storageKey);
//         const storedNewItems = localStorage.getItem(newItemsKey);
        
//         if (storedData) {
//           storedOriginalQuantities = JSON.parse(storedData);
//         }
        
//         if (storedNewItems) {
//           newlyAddedItems = JSON.parse(storedNewItems);
//         }
//       } catch (err) {
//         console.error("Error loading stored data:", err);
//       }
      
//       // Enhance the data with loaded states and original quantities
//       const processedData = enhanceProformaData(data, viewProformaDetails, storedOriginalQuantities, newlyAddedItems);
      
//       // Start background loading operation items - this happens after dialog is open
//       if (operationId) {
//         setTimeout(() => {
//           fetchOperationItemsInBackground(data, trimmedRef);
//         }, 200);
//       }
      
//       const dialogFetchTime = performance.now() - startTime;
//       console.log(`Fetched and processed proforma slip in ${dialogFetchTime}ms`);
      
//       // Save updated originalQuantities back to localStorage (only once per fetch)
//       localStorage.setItem(storageKey, JSON.stringify(storedOriginalQuantities));
      
//       // Add the operation data to the processed data
//       return {
//         ...processedData,
//         operation: operationId ? { id: operationId } : undefined
//       };
//     } catch (error) {
//       console.error("Error fetching load operation:", error);
//       return null;
//     }
//   };
  
//   // Filter slip items based on search query
//   const filterSlipItems = (items: ProformaSlipItem[], searchQuery: string) => {
//     if (!searchQuery || searchQuery.trim() === "") return items;
    
//     const query = searchQuery.toLowerCase().trim();
//     return items.filter(item => 
//       (item.item_name && item.item_name.toLowerCase().includes(query)) || 
//       (item.itemName && item.itemName.toLowerCase().includes(query)) || 
//       (item.barcode && item.barcode.toLowerCase().includes(query)) ||
//       (item.sku && item.sku.toLowerCase().includes(query)) || 
//       (item.sr_no && item.sr_no.toString().includes(query)) ||
//       (item.srNo && item.srNo.toString().includes(query))
//     );
//   };

//   // Function to calculate extra quantity consistently
//   // Get the original quantity for an item from localStorage
//   const getOriginalQuantity = (itemId: number, referenceNumber: string | undefined | null): number | undefined => {
//     if (!referenceNumber) return undefined;
    
//     try {
//       const storageKey = `proforma-original-quantities-${referenceNumber.trim() ?? ""}`;
//       const storedData = localStorage.getItem(storageKey);
//       if (storedData) {
//         const storedOriginalQuantities = JSON.parse(storedData);
//         return storedOriginalQuantities[itemId];
//       }
//     } catch (err) {
//       console.error("Error getting original quantity from localStorage:", err);
//     }
    
//     return undefined;
//   };
  
//   // Helper function to update an item with proper original quantity
//   const updateItemWithOriginalQuantity = (itemId: number, newQuantity: number, referenceNumber: string): Promise<any> => {
//     // Get the operation ID from the selected operation state
//     const operationId = selectedOperation?.id;
    
//     if (!operationId) {
//       console.error("Cannot update item: No operation ID available");
//       return Promise.reject(new Error("No operation ID available"));
//     }
    
//     console.log(`Updating item ${itemId} with quantity ${newQuantity}, operationId ${operationId}`);
    
//     // Get the original quantity for this item using our helper function
//     const originalQty = getOriginalQuantity(parseInt(itemId.toString()), referenceNumber);
    
//     // Create the API request with originalQuantity preserved - now using load operations items endpoint
//     return apiRequest("PATCH", `/api/loading-operation-items/${itemId}`, {
//       quantity: newQuantity,
//       originalQuantity: originalQty !== undefined ? originalQty : newQuantity, // Preserve originalQuantity if available
//       loadOperationId: operationId // Include the operation ID
//     });
//   };
  
//   // Batch version of updateItemWithOriginalQuantity for better performance
//   const batchUpdateItemsWithOriginalQuantity = (items: {id: number, quantity: number, originalQuantity?: number, extraQuantity?: number, loaded?: boolean, loadedQuantity?: number}[], referenceNumber: string): Promise<any> => {
//     // Get the operation ID from the selected operation state
//     const operationId = selectedOperation?.id;
    
//     if (!operationId) {
//       console.error("Cannot update items: No operation ID available");
//       return Promise.reject(new Error("No operation ID available"));
//     }
    
//     console.log(`Batch updating ${items.length} items for operation ID ${operationId}`);
    
//     // Convert array of items to batch format with preserved originalQuantity and calculated extraQuantity
//     const batchItems = items.map(item => {
//       // Get original quantity either from the item or from the storage function
//       const originalQty = item.originalQuantity ?? getOriginalQuantity(parseInt(item.id.toString()), referenceNumber) ?? item.quantity;
      
//       // Calculate extra quantity - if current quantity exceeds original quantity
//       const extraQty = item.extraQuantity ?? (item.quantity > originalQty ? item.quantity - originalQty : 0);
      
//       // Calculate loaded quantity based on loaded state and quantity
//       const loadedQty = item.loadedQuantity ?? (item.loaded ? item.quantity : 0);
      
//       console.log(`Batch item ${item.id}: originalQty=${originalQty}, currentQty=${item.quantity}, extraQty=${extraQty}, loadedQty=${loadedQty}`);
      
//       return {
//         id: item.id,
//         quantity: item.quantity,
//         originalQuantity: originalQty, // Preserve originalQuantity if available
//         original_quantity: originalQty, // Snake case version
//         extraQuantity: extraQty, // Include calculated extraQuantity
//         extra_quantity: extraQty, // Snake case version
//         loaded: item.loaded, // Include loaded status
//         loadedQuantity: loadedQty, // Include loaded quantity
//         loaded_quantity: loadedQty // Snake case version
//       };
//     });
    
//     // Use batch API for better performance with load operations items
//     // Performance enhancement: Set custom timeout for fetch and use keepalive
//     const controller = new AbortController();
//     const timeoutId = setTimeout(() => controller.abort(), 10000); // 10 second timeout
    
//     const fetchPromise = fetch('/api/loading-operation-items/batch-update', {
//       method: 'POST',
//       headers: {
//         'Content-Type': 'application/json',
//         'X-Priority': 'high', // Signal high priority to server (if supported)
//         'Pragma': 'no-cache',
//         'Cache-Control': 'no-cache',
//       },
//       body: JSON.stringify({ 
//         items: batchItems, 
//         loadOperationId: operationId  // Pass the operation ID for context
//       }),
//       signal: controller.signal,
//       keepalive: true,
//       credentials: 'same-origin'
//     });
    
//     // Clear timeout when fetch completes to prevent memory leaks
//     fetchPromise.then(() => clearTimeout(timeoutId)).catch(() => clearTimeout(timeoutId));
    
//     // Start performance measurement
//     const startTime = performance.now();
    
//     // Add timing info to the response
//     return fetchPromise.then(response => {
//       const endTime = performance.now();
//       console.log(`Batch update completed in ${Math.round(endTime - startTime)}ms`);
//       return response;
//     });
//   };

//   // Calculate total proforma quantity (original quantities) for a list of items
//   const calculateProformaQuantity = (items: ProformaSlipItem[], referenceNumber: string | undefined | null) => {
//     console.log("Calculating proforma quantity for", referenceNumber);
    
//     // Calculate the total and log each item's contribution
//     const result = items.reduce((total, item) => {
//       if (!item.id) return total;
      
//       // Use the nullish coalescing operator to ensure we have a number
//       // First check originalQuantity, fall back to current quantity if not available
//       // This handles both null/undefined originalQuantity values and correctly displays values in both mobile and desktop views
//       const originalQuantity = item.originalQuantity ?? item.quantity ?? 0;
      
//       // If originalQuantity is 0, this is an extra item (not in original proforma)
//       if (originalQuantity === 0) {
//         console.log(`Item ${item.id}: originalQuantity=${originalQuantity}, proforma=0 (counted as extra item)`);
//         return total;
//       }
      
//       console.log(`Item ${item.id}: quantity=${item.quantity}, originalQuantity=${originalQuantity}, proforma=preserved`);
      
//       // Add to total
//       return total + originalQuantity;
//     }, 0);
    
//     console.log(`Total proforma quantity: ${result}`);
//     return result;
//   };

//   const calculateItemRemainingQuantity = (item: ProformaSlipItem, referenceNumber: string | undefined | null) => {
//     // Get the original quantity from either originalQuantity or current quantity if originalQuantity is null
//     const originalQty = item.originalQuantity ?? item.quantity ?? 0;
    
//     // Only count remaining for items that have an original quantity > 0 (not extra items)
//     if (originalQty === 0) return 0;
    
//     // Calculate remaining: original minus loaded qty (if loaded)
//     // Use loadedQuantity if available, fall back to quantity for backward compatibility
//     const loadedQty = item.loaded ? (item.loadedQuantity ?? item.quantity ?? 0) : 0;
//     return Math.max(0, originalQty - loadedQty);
//   };

//   const calculateRemainingQuantity = (items: ProformaSlipItem[], referenceNumber: string | undefined | null) => {
//     return items.reduce((total, item) => {
//       // Get the original quantity from either originalQuantity or current quantity if originalQuantity is null
//       const originalQty = item.originalQuantity ?? item.quantity ?? 0;
      
//       // Only count remaining for items that have an original quantity > 0 (not extra items)
//       if (originalQty === 0) return total;
      
//       // Calculate remaining: original minus loaded qty (if loaded)
//       // Use loadedQuantity if available, fall back to quantity for backward compatibility
//       const loadedQty = item.loaded ? (item.loadedQuantity ?? item.quantity ?? 0) : 0;
//       const remaining = Math.max(0, originalQty - loadedQty);
      
//       return total + remaining;
//     }, 0);
//   };

//   const calculateItemExtraQuantity = (item: ProformaSlipItem, referenceNumber: string | undefined | null) => {
//     // If extraQuantity is explicitly provided from database, use it directly
//     // This is critical for correct persistence - we trust the stored value first
//     if (item.extraQuantity !== undefined && item.extraQuantity !== null) {
//       console.log(`Using stored extraQuantity=${item.extraQuantity} for item ${item.id}`);
//       return item.extraQuantity;
//     }
    
//     // If we have loadedQuantity and extraQuantity in the item (GJ operation item format)
//     if ('loadedQuantity' in item && 'extraQuantity' in item) {
//       if (item.extraQuantity !== undefined && item.extraQuantity !== null) {
//         console.log(`Using loadOp extraQuantity=${item.extraQuantity} for item ${item.id}`);
//         return item.extraQuantity;
//       }
//     }
    
//     // Skip if not loaded (we only want to show extra quantity for loaded items)
//     if (!item.loaded) return 0;
    
//     if (!item.id) return 0;
    
//     // Get the original quantity from either originalQuantity or current quantity if originalQuantity is null
//     const originalQty = item.originalQuantity ?? 0;

//     // Check if this is a newly added item (originalQuantity === 0)
//     const isNewlyAdded = originalQty === 0;
    
//     // For newly added items (originalQuantity = 0), count ALL of the quantity as "extra"
//     if (isNewlyAdded) {
//       const extraQty = item.quantity ?? 0;
//       console.log(`Calculated extraQuantity=${extraQty} for newly added item ${item.id}`);
//       return extraQty;
//     }
    
//     // For existing items, only count as extra if loaded quantity > original quantity
//     const extraQty = Math.max(0, (item.quantity ?? 0) - originalQty);
//     console.log(`Calculated extraQuantity=${extraQty} for existing item ${item.id}: quantity=${item.quantity}, originalQty=${originalQty}`);
//     return extraQty;
//   };

//   const calculateExtraQuantity = (items: ProformaSlipItem[], referenceNumber: string | undefined | null) => {
//     console.log("Calculating total extra quantity for items:", items.map(item => ({ 
//       id: item.id, 
//       quantity: item.quantity, 
//       originalQuantity: item.originalQuantity,
//       extraQuantity: item.extraQuantity,
//       loaded: item.loaded
//     })));
    
//     return items.reduce((total, item) => {
//       // Skip if not loaded
//       if (!item.loaded) return total;
      
//       if (!item.id) return total;
      
//       // If extraQuantity is explicitly stored, use that value directly
//       if (item.extraQuantity !== undefined && item.extraQuantity !== null) {
//         console.log(`Using stored extraQuantity=${item.extraQuantity} for item ${item.id} in total calculation`);
//         return total + item.extraQuantity;
//       }
      
//       // If we have loadedQuantity and extraQuantity in the item (GJ operation item format)
//       if ('loadedQuantity' in item && 'extraQuantity' in item) {
//         if (item.extraQuantity !== undefined && item.extraQuantity !== null) {
//           console.log(`Using loadOp extraQuantity=${item.extraQuantity} for item ${item.id} in total calculation`);
//           return total + item.extraQuantity;
//         }
//       }
      
//       // Get the original quantity from either originalQuantity or current quantity if originalQuantity is null
//       const originalQty = item.originalQuantity ?? 0;
      
//       // Check if this is a newly added item (originalQuantity === 0)
//       const isNewlyAdded = originalQty === 0;
      
//       // For newly added items (originalQuantity = 0), count ALL of the loaded quantity as "extra"
//       if (isNewlyAdded) {
//         const extraQuantity = item.quantity ?? 0;
//         console.log(`Item ${item.id} is newly added with quantity ${item.quantity}, counting ALL as extra in total calculation`);
//         return total + extraQuantity;
//       }
      
//       // For existing items, only count as extra if loaded quantity > original quantity 
//       const extraQuantity = (item.quantity ?? 0) > originalQty 
//         ? ((item.quantity ?? 0) - originalQty) 
//         : 0;
        
//       if (extraQuantity > 0) {
//         console.log(`Item ${item.id} calculated extra: quantity=${item.quantity}, originalQuantity=${originalQty}, extra=${extraQuantity}`);
//       }
      
//       return total + extraQuantity;
//     }, 0);
//   };
  
//   // Function to calculate total volume from loaded items based on product volume data
//   const calculateTotalVolume = async (items: ProformaSlipItem[]) => {
//     let totalVolume = 0;
//     const loadedItems = [];
//     const productIds: number[] = [];
    
//     // Collect all loaded items and their product IDs
//     for (const item of items) {
//       if (item.loaded && item.productId && (item.loadedQuantity || item.quantity)) {
//         loadedItems.push(item);
//         if (item.productId) {
//           productIds.push(item.productId);
//         }
//       }
//     }
    
//     // If no loaded items, return 0
//     if (loadedItems.length === 0) {
//       return "0.00";
//     }
    
//     try {
//       // Log performance metrics for volume calculation
//       const volumeCalcStart = performance.now();
//       console.log(`Using batch API to fetch ${productIds.length} products for volume calculation`);
      
//       // Use batch API to fetch all products at once
//       const batchProductResponse = await fetch('/api/products/batch', {
//         method: 'POST',
//         headers: {
//           'Content-Type': 'application/json',
//         },
//         body: JSON.stringify({ productIds }),
//       });
      
//       if (!batchProductResponse.ok) {
//         throw new Error('Failed to fetch products in batch');
//       }
      
//       const productBatchResults = await batchProductResponse.json();
      
//       // Calculate volume using product data and item loaded quantities
//       for (const item of loadedItems) {
//         if (item.productId) {
//           const productId = item.productId.toString();
//           const product = productBatchResults[productId];
//           // Use loadedQuantity for loaded items, falling back to quantity if loadedQuantity is not available
//           const quantity = item.loadedQuantity !== undefined ? item.loadedQuantity : (item.quantity || 0);
          
//           if (product && quantity > 0) {
//             const volumeInCuFt = parseFloat(product.volumeInCuFt || "0");
//             const itemVolume = volumeInCuFt * quantity;
//             totalVolume += itemVolume;
            
//             console.log(`Item: ${product.name}, Volume: ${volumeInCuFt} cu ft, Loaded Qty: ${quantity}, Total: ${itemVolume} cu ft`);
//           }
//         }
//       }
      
//       // Log performance metrics for volume calculation
//       const volumeCalcEnd = performance.now();
//       console.log(`Volume calculation completed in ${(volumeCalcEnd - volumeCalcStart).toFixed(2)}ms for ${loadedItems.length} items`);
      
//       // Format to 2 decimal places
//       return totalVolume.toFixed(2);
//     } catch (error) {
//       console.error("Error calculating volume:", error);
//       return "0.00";
//     }
//   };
  
//   // Apply item filters for displaying items based on the selected filter
//   const filterItemsByType = (items: ProformaSlipItem[], filter: string, referenceNumber: string | undefined | null): ProformaSlipItem[] => {
//     try {
//       if (!items || items.length === 0) return [];
      
//       // Check if we have any items with null originalQuantity values
//       // This indicates we need to use current quantities instead
//       const hasNullOriginalQty = items.some(item => 
//         item.originalQuantity === null || item.originalQuantity === undefined
//       );
      
//       switch (filter) {
//         case 'all':
//           return items;
//         case 'proforma':
//           // If we have null originalQuantity values, use all items that have quantity > 0 (or are loaded)
//           if (hasNullOriginalQty) {
//             return items.filter(item => (item?.quantity || 0) > 0 || item?.loaded === true);
//           }
//           // Otherwise, show only items that have original quantity > 0
//           return items.filter(item => (item?.originalQuantity || 0) > 0);
//         case 'loaded':
//           // Show only loaded items
//           return items.filter(item => item?.loaded === true);
//         case 'remaining':
//           // Show items with remaining quantity (original > loaded)
//           return items.filter(item => {
//             try {
//               const remaining = calculateItemRemainingQuantity(item, referenceNumber);
//               return remaining > 0;
//             } catch (err) {
//               console.error("Error calculating remaining quantity:", err);
//               return false;
//             }
//           });
//         case 'extra':
//           // Show only extra items as determined by calculateItemExtraQuantity
//           // Will use current qty as fallback if originalQty is null
//           return items.filter(item => {
//             try {
//               const extra = calculateItemExtraQuantity(item, referenceNumber);
//               return extra > 0;
//             } catch (err) {
//               console.error("Error calculating extra quantity:", err);
//               return false;
//             }
//           });
//         default:
//           return items;
//       }
//     } catch (err) {
//       console.error("Error during item filtering:", err);
//       return []; // Return empty array on error
//     }
//   };

//   // Function to format dates to DD/MM/YYYY
//   const formatDateToDDMMYYYY = (dateValue: string | Date | null | undefined): string => {
//     if (!dateValue) return "N/A";
    
//     try {
//       const date = isDateObject(dateValue) ? dateValue : new Date(dateValue);
//       return date.toLocaleDateString('en-IN', {
//         day: '2-digit',
//         month: '2-digit',
//         year: 'numeric'
//       });
//     } catch (error) {
//       return typeof dateValue === 'string' ? dateValue : "N/A";
//     }
//   };
  
//   /**
//    * Helper function to enhance operation data with consistent field values and metadata
//    * @param data The raw operation data from API
//    * @param currentData Any existing view data to maintain state
//    * @param storedOriginalQuantities Map of original quantities from localStorage
//    * @param newlyAddedItems Array of newly added item IDs
//    * @returns Enhanced operation data with consistent field values
//    */
//   const enhanceProformaData = (
//     data: any, 
//     currentData: any, 
//     storedOriginalQuantities: Record<number, number>,
//     newlyAddedItems: number[]
//   ): any => {
//     if (!data) return null;
    
//     // Use process helper from data-loader if available
//     if (typeof processProformaItems === 'function') {
//       return {
//         slip: data.slip,
//         items: processProformaItems(data.items || []).map((item: any) => {
//           // For newly added items, set originalQuantity to 0
//           if (newlyAddedItems.includes(item.id)) {
//             return { ...item, originalQuantity: 0 };
//           }
          
//           // If we have a stored original quantity for this item, use it
//           if (storedOriginalQuantities[item.id] !== undefined) {
//             return { ...item, originalQuantity: storedOriginalQuantities[item.id] };
//           }
          
//           // Otherwise, use item's existing originalQuantity or fallback to quantity
//           return {
//             ...item,
//             originalQuantity: item.originalQuantity !== undefined ? item.originalQuantity : item.quantity
//           };
//         })
//       };
//     }
    
//     // Fallback to basic processing (if processProformaItems not available)
//     return {
//       slip: data.slip,
//       items: (data.items || []).map((item: any, idx: number) => {
//         // Create a processed item with consistent field names
//         const processedItem = {
//           ...item,
//           // Ensure all required fields are present with both naming conventions
//           sr_no: item.sr_no || item.srNo || idx + 1,
//           sr_no_display: item.sr_no_display || item.srNoDisplay || (idx + 1).toString(),
//           item_name: item.item_name || item.itemName,
//           barcode: item.barcode || item.sku,
//           srNo: item.sr_no || item.srNo || idx + 1,
//           srNoDisplay: item.sr_no_display || item.srNoDisplay || (idx + 1).toString(),
//           itemName: item.item_name || item.itemName,
//           sku: item.barcode || item.sku,
//           loaded: item.loaded || false,
//           originalQuantity: item.originalQuantity !== undefined ? item.originalQuantity : (item.quantity || 0),
//           // Explicitly preserve loadedQuantity and extraQuantity from the database if they exist
//           loadedQuantity: item.loadedQuantity !== undefined ? item.loadedQuantity : 
//                         (item.loaded_quantity !== undefined ? item.loaded_quantity : 
//                         (item.loaded ? (item.quantity || 0) : 0)),
//           extraQuantity: item.extraQuantity !== undefined ? item.extraQuantity : 
//                         (item.extra_quantity !== undefined ? item.extra_quantity : null),
//           // Add snake_case versions for database consistency
//           loaded_quantity: item.loadedQuantity !== undefined ? item.loadedQuantity : 
//                         (item.loaded_quantity !== undefined ? item.loaded_quantity : 
//                         (item.loaded ? (item.quantity || 0) : 0)),
//           extra_quantity: item.extraQuantity !== undefined ? item.extraQuantity : 
//                         (item.extra_quantity !== undefined ? item.extra_quantity : null),
//           original_quantity: item.originalQuantity !== undefined ? item.originalQuantity : (item.quantity || 0)
//         };
        
//         // For newly added items, set originalQuantity to 0 and extraQuantity to the full quantity
//         if (newlyAddedItems.includes(item.id)) {
//           processedItem.originalQuantity = 0;
//           processedItem.original_quantity = 0;
//           processedItem.extraQuantity = item.quantity || 0;
//           processedItem.extra_quantity = item.quantity || 0;
//           // For newly added items, set loadedQuantity based on loaded state
//           processedItem.loadedQuantity = item.loaded ? (item.quantity || 0) : 0;
//           processedItem.loaded_quantity = item.loaded ? (item.quantity || 0) : 0;
//           console.log(`Enhanced newly added item ${item.id}: extraQuantity = ${processedItem.extraQuantity}, loadedQuantity = ${processedItem.loadedQuantity}`);
//         } 
//         // If we have a stored original quantity for this item, use it
//         else if (storedOriginalQuantities[item.id] !== undefined) {
//           processedItem.originalQuantity = storedOriginalQuantities[item.id];
//           processedItem.original_quantity = storedOriginalQuantities[item.id];
          
//           // Calculate extraQuantity if not already set
//           if (processedItem.extraQuantity === null || processedItem.extraQuantity === undefined) {
//             const currentQty = item.quantity || 0;
//             const origQty = processedItem.originalQuantity || 0;
//             processedItem.extraQuantity = currentQty > origQty ? currentQty - origQty : 0;
//             processedItem.extra_quantity = processedItem.extraQuantity;
//             console.log(`Enhanced item ${item.id} with calculated extraQuantity: ${processedItem.extraQuantity}`);
//           } else {
//             // Make sure both camelCase and snake_case versions are set
//             processedItem.extra_quantity = processedItem.extraQuantity;
//             console.log(`Enhanced item ${item.id} with preserved extraQuantity: ${processedItem.extraQuantity}`);
//           }
          
//           // Update loadedQuantity to match loaded state and quantity
//           if (processedItem.loaded) {
//             processedItem.loadedQuantity = processedItem.quantity || 0;
//             processedItem.loaded_quantity = processedItem.quantity || 0;
//           } else if (processedItem.loadedQuantity === undefined || processedItem.loadedQuantity === null) {
//             processedItem.loadedQuantity = 0;
//             processedItem.loaded_quantity = 0;
//           }
//         }
        
//         return processedItem;
//       })
//     };
//   };
  
//   /**
//    * Fetch operation items in background to enhance operation data
//    * @param data The operation data to enhance
//    * @param trimmedRef Trimmed reference number for the operation
//    */
//   const fetchOperationItemsInBackground = async (data: any, trimmedRef: string) => {
//     // Store dialog open time to track performance
//     const dialogOpenTime = performance.now();
    
//     try {
//       // Find the matching operation ID for this reference number
//       // IMPORTANT: Only use loadOperationId or operation.id, never use slip.id
//       // as that refers to the proforma slip ID, not the load operation ID
//       const gjOperationId = data?.operation?.id || data?.slip?.loadOperationId;
      
//       // If we don't have an operation ID, we can't fetch operation items
//       if (!gjOperationId) {
//         console.log(`No load operation ID found for ${trimmedRef}, skipping background fetch`);
//         return;
//       }
      
//       console.log(`Background fetching load operation items for operation ID ${gjOperationId}`);
      
//       // Fetch the operation items in the background
//       const gjItemsResponse = await apiRequest('GET', `/api/loading-operations/${gjOperationId}/items`);
//       const gjItems = await gjItemsResponse.json();
      
//       if (!Array.isArray(gjItems) || gjItems.length === 0) {
//         console.log(`No load operation items found for operation ID ${gjOperationId}`);
//         return;
//       }
      
//       console.log(`Found ${gjItems.length} load operation items for ${trimmedRef}`);
      
//       // We need to fetch product data for all the items using batch API
//       const productIds = Array.from(new Set(
//         gjItems
//           .filter(gjItem => gjItem.productId)
//           .map(gjItem => Number(gjItem.productId))
//       ));
      
//       // Use batchLoadProducts if available (from data-loader)
//       let productMap: Record<number, any> = {};
//       if (typeof batchLoadProducts === 'function') {
//         try {
//           productMap = await batchLoadProducts(productIds);
//         } catch (error) {
//           console.error('Error batch loading products:', error);
//         }
//       } else {
//         // Fallback to manual batch loading
//         try {
//           const batchResponse = await fetch('/api/products/batch', {
//             method: 'POST',
//             headers: { 'Content-Type': 'application/json' },
//             body: JSON.stringify({ productIds }),
//           });
          
//           if (batchResponse.ok) {
//             productMap = await batchResponse.json();
//           }
//         } catch (error) {
//           console.error('Error fetching products in batch:', error);
//         }
//       }
      
//       // If we don't have any products, we can't enhance the items
//       if (Object.keys(productMap).length === 0) {
//         console.log('No product data found for operation items');
//         return;
//       }
      
//       // Now enhance the GJ items with product data
//       const enhancedItems = gjItems.map((gjItem: any, idx: number) => {
//         const productId = gjItem.productId;
//         const product = productMap[productId];
        
//         return {
//           ...gjItem,
//           // Add product data to the item
//           sr_no: gjItem.sr_no || gjItem.srNo || (product?.srNo) || idx + 1,
//           sr_no_display: gjItem.sr_no_display || gjItem.srNoDisplay || (product?.srNoDisplay) || (idx + 1).toString(),
//           item_name: gjItem.item_name || gjItem.itemName || (product?.name),
//           barcode: gjItem.barcode || gjItem.sku || (product?.barcode),
//           srNo: gjItem.sr_no || gjItem.srNo || (product?.srNo) || idx + 1,
//           srNoDisplay: gjItem.sr_no_display || gjItem.srNoDisplay || (product?.srNoDisplay) || (idx + 1).toString(),
//           itemName: gjItem.item_name || gjItem.itemName || (product?.name),
//           sku: gjItem.barcode || gjItem.sku || (product?.barcode),
//         };
//       });
      
//       // Update the view operation details with the enhanced data while preserving loaded state and quantities
//       setViewProformaDetails((prevState: any) => {
//         if (!prevState) return null;
        
//         // Create a map of existing items by ID to preserve critical values like loaded state and quantities
//         const existingItemsMap = new Map();
        
//         if (prevState.items && Array.isArray(prevState.items)) {
//           prevState.items.forEach((item: any) => {
//             if (item && item.id) {
//               existingItemsMap.set(item.id.toString(), item);
//             }
//           });
//         }
        
//         // Preserve critical values like loaded state, extraQuantity, and loadedQuantity
//         const mergedItems = enhancedItems.map((newItem: any) => {
//           if (!newItem.id) return newItem;
          
//           const existingItem = existingItemsMap.get(newItem.id.toString());
//           if (!existingItem) return newItem;
          
//           // Preserve loaded state and quantities from existing items
//           return {
//             ...newItem,
//             loaded: existingItem.loaded === true || existingItem.loaded === 'true' ? true : newItem.loaded === true || newItem.loaded === 'true',
//             loadedQuantity: existingItem.loadedQuantity !== undefined ? existingItem.loadedQuantity : 
//                            (existingItem.loaded_quantity !== undefined ? existingItem.loaded_quantity : 
//                            (existingItem.loaded ? (existingItem.quantity || 0) : 0)),
//             extraQuantity: existingItem.extraQuantity !== undefined ? existingItem.extraQuantity : 
//                           (existingItem.extra_quantity !== undefined ? existingItem.extra_quantity : 
//                           newItem.extraQuantity),
//             originalQuantity: existingItem.originalQuantity !== undefined ? existingItem.originalQuantity : 
//                              (existingItem.original_quantity !== undefined ? existingItem.original_quantity : 
//                              newItem.originalQuantity),
//             // Also preserve snake_case versions
//             loaded_quantity: existingItem.loadedQuantity !== undefined ? existingItem.loadedQuantity : 
//                            (existingItem.loaded_quantity !== undefined ? existingItem.loaded_quantity : 
//                            (existingItem.loaded ? (existingItem.quantity || 0) : 0)),
//             extra_quantity: existingItem.extraQuantity !== undefined ? existingItem.extraQuantity : 
//                           (existingItem.extra_quantity !== undefined ? existingItem.extra_quantity : 
//                           newItem.extraQuantity),
//             original_quantity: existingItem.originalQuantity !== undefined ? existingItem.originalQuantity : 
//                              (existingItem.original_quantity !== undefined ? existingItem.original_quantity : 
//                              newItem.originalQuantity)
//           };
//         });
        
//         console.log(`Merged ${mergedItems.length} items with preserved loaded states and quantities`);
        
//         return {
//           ...prevState,
//           operation: data?.operation,
//           // Use the merged items that preserve loaded state and quantities
//           items: mergedItems
//         };
//       });
      
//       console.log(`Successfully enhanced items with product data in ${(performance.now() - dialogOpenTime).toFixed(1)}ms`);
//     } catch (error) {
//       console.error(`Error in background fetch:`, error);
//     }
//   };
  
//   // Function to extract creator info from operation notes
//   const extractCreatorInfo = (notes: string | null) => {
//     if (!notes) return { name: "Unknown", department: "Unknown" };
    
//     // Storekeeper: Vraj (MANAGEMENT)
//     const storekeeperMatch = notes.match(/Storekeeper: (.*?) \((.*?)\)/);
//     if (storekeeperMatch && storekeeperMatch.length >= 3) {
//       return {
//         name: storekeeperMatch[1],
//         department: storekeeperMatch[2]
//       };
//     }
    
//     return { name: "Unknown", department: "Unknown" };
//   };
  
//   // Helper function to safely check if a slip party name contains a search query
  
  
  
  
//   // We now get user data from localStorage in the useEffect at the top of the component

//   // We now use database for all operations instead of localStorage
//   // No need to fix any localStorage values

//   // Fetch unique categories from inventory
//   useEffect(() => {
//     // Fetch all products to extract categories
//     apiRequest("GET", "/api/products?limit=1000")
//       .then(response => response.json())
//       .then(data => {
//         // Extract unique categories
//         const categories = data
//           .map((product: any) => product.category)
//           .filter((category: string | null) => category) // Filter out null or empty categories
//           .filter((category: string, index: number, self: string[]) => 
//             self.indexOf(category) === index
//           ) // Get unique values
//           .sort(); // Sort alphabetically
        
//         setUniqueCategories(categories);
//       })
//       .catch(error => {
//         console.error("Error fetching product categories:", error);
//       });
//   }, []);

//   // Save proforma slips data to session storage whenever it changes
//   useEffect(() => {
//     // Only save to session storage if we have data to save
//     if (Object.keys(proformaSlipsData).length > 0) {
//       try {
//         // Save to the new key
//         sessionStorage.setItem('loadOperations_proformaSlipsData', JSON.stringify(proformaSlipsData));
//         // Also save to legacy key for backward compatibility
//         sessionStorage.setItem('gjOperations_proformaSlipsData', JSON.stringify(proformaSlipsData));
//         console.log("Saved proforma slips data to session storage");
//       } catch (error) {
//         console.error("Error saving proforma slips data to session storage:", error);
//       }
//     }
//   }, [proformaSlipsData]);

//   // Fetch proforma slip data for all operations in batch - optimized version
//   useEffect(() => {
//     const fetchAllProformaSlips = async () => {
//       if (!data) return;
      
//       // Only fetch data for visible operations initially based on current page and limit
//       // This dramatically improves initial load performance
//       const visibleStart = (currentPage - 1) * entriesLimit;
//       const visibleEnd = visibleStart + entriesLimit;
      
//       // Get operation reference numbers we need to fetch, prioritizing visible ones
//       const orderNumbersToFetch: string[] = [];
//       const secondaryOrderNumbers: string[] = [];
//       const dataLength = data.length;
      
//       // First identify all reference numbers needing data
//       for (let i = 0; i < dataLength; i++) {
//         const operation = data[i];
//         if (operation.referenceNumber && !proformaSlipsData[operation.referenceNumber]) {
//           // Prioritize visible operations (ones on current page)
//           if (i >= visibleStart && i < visibleEnd) {
//             orderNumbersToFetch.push(operation.referenceNumber);
//           } else {
//             // Queue up other operations for background loading
//             secondaryOrderNumbers.push(operation.referenceNumber);
//           }
//         }
//       }
      
//       // If nothing to fetch, exit early
//       if (orderNumbersToFetch.length === 0 && secondaryOrderNumbers.length === 0) return;
      
//       // Log the fetch operations for debugging
//       if (orderNumbersToFetch.length > 0) {
//         console.log(`Batch fetching ${orderNumbersToFetch.length} priority proforma slips for visible operations`);
//       }
      
//       // Function to fetch a batch of order numbers
//       const fetchBatch = async (orderNumbers: string[]) => {
//         if (orderNumbers.length === 0) return;
        
//         try {
//           // Measure performance of batch fetching
//           const batchFetchStart = performance.now();
//           console.log(`Batch fetching ${orderNumbers.length} proforma slips`);
          
//           // Use the optimized batch API endpoint 
//           const response = await fetch('/api/proforma-slips/batch', {
//             method: 'POST',
//             headers: {
//               'Content-Type': 'application/json',
//             },
//             body: JSON.stringify({ orderNumbers }),
//           });
          
//           if (!response.ok) {
//             throw new Error(`Failed to fetch proforma slips in batch: ${response.statusText}`);
//           }
          
//           const batchResults = await response.json();
          
//           // Update state with new data - use functional update for better React performance
//           if (Object.keys(batchResults).length > 0) {
//             const batchFetchEnd = performance.now();
//             console.log(`Successfully fetched ${Object.keys(batchResults).length} of ${orderNumbers.length} requested proforma slips in ${(batchFetchEnd - batchFetchStart).toFixed(2)}ms`);
            
//             setProformaSlipsData(prev => ({
//               ...prev,
//               ...batchResults
//             }));
//           }
          
//           // Clear progress after successful fetch
//           orderNumbers.forEach(orderNumber => {
//             if (orderNumbersInProgress.current) {
//               orderNumbersInProgress.current.delete(orderNumber);
//             }
//           });
//         } catch (error) {
//           console.error('Error batch fetching proforma slips:', error);
          
//           // Clear progress even on error
//           orderNumbers.forEach(orderNumber => {
//             if (orderNumbersInProgress.current) {
//               orderNumbersInProgress.current.delete(orderNumber);
//             }
//           });
//         }
//       };
      
//       // First fetch the high-priority visible operations
//       await fetchBatch(orderNumbersToFetch);
      
//       // Then in the background, fetch the rest in smaller batches
//       if (secondaryOrderNumbers.length > 0) {
//         // Fetch secondary operations in smaller batches to avoid overloading the server
//         const batchSize = 25;
//         for (let i = 0; i < secondaryOrderNumbers.length; i += batchSize) {
//           const batch = secondaryOrderNumbers.slice(i, i + batchSize);
//           // Use setTimeout to give the UI time to breathe between batch requests
//           setTimeout(() => {
//             fetchBatch(batch);
//           }, 300 * (i / batchSize)); // Stagger the requests with 300ms delay between batches
//         }
//       }
//     };
    
//     fetchAllProformaSlips();
//   }, [data, currentPage, entriesLimit]);

//   return (
//     <div className="container-fluid px-2 py-6 space-y-6">
//       {/* User info panel */}
// {/* User details moved to search bar */}
      
//       <div className="flex flex-col sm:flex-row justify-between gap-2 items-start sm:items-center">
//         <div>
//           <div className="flex items-start w-full">
//             <div className="flex-1 relative">
//                 <PageHeader
//                   icon={Factory}
//                   title="Load Operations"
//                   subtitle={
//                     <div className="text-xs text-muted-foreground flex flex-col md:flex-row md:items-center md:gap-1 mt-0.5">
//                       <span>Auto-refresh {userInteracting ? 'paused' : 'active'}</span>
//                       <span className="hidden md:inline">·</span>
//                       <span title={`Next refresh in ${Math.max(0, Math.floor((AUTO_REFRESH_INTERVAL - (Date.now() - lastRefreshTimeRef.current)) / 1000))} seconds`}>
//                         Last updated: {new Date(lastRefreshTimeRef.current).toLocaleTimeString([], {hour12: false})}
//                       </span>
//                     </div>
//                   }
//                 >
//                   <div className="md:hidden">
//                     <OperationsFilter onFilterChange={handleOperationsFilterChange} />
//                   </div>
//                 </PageHeader>
//             </div>
//           </div>
//         </div>
        
//         {/* Search bar for mobile view moved below status buttons */}
        
//         <div className="flex flex-col sm:flex-row w-full sm:w-auto gap-2 md:flex">
//           {selectedOperationIds.length > 0 && (
//             <Button
//               variant="outline"
//               onClick={() => setIsMultipleDeleteDialogOpen(true)}
//               className="gap-1 w-full sm:w-auto text-[#001d6e] border-blue-200 hover:bg-blue-50"
//             >
//               <Trash className="h-6 w-6 text-[#001d6e]" style={{height: '1.5rem', width: '1.5rem'}} />
//               <span className="text-[#001d6e]">Delete ({selectedOperationIds.length})</span>
//             </Button>
//           )}
//           {/* User info removed per request */}
          
//           {/* Dialog for creating load slip */}
//           <Dialog 
//             open={isOrderLookupDialogOpen} 
//             onOpenChange={(open) => {
//               // When dialog opens, pause background fetching to improve performance
//               if (open) {
//                 shouldPauseBackgroundLoading.current = true;
//                 console.log('Paused background data loading while dialog is open');
//               } else {
//                 shouldPauseBackgroundLoading.current = false;
//                 console.log('Resumed background data loading after dialog closed');
//               }
//               setIsOrderLookupDialogOpen(open);
//             }}
//           >
//             <DialogContent className="sm:max-w-[700px] w-full overflow-y-auto max-h-[90vh]">
//               <DialogHeader>
//                 <DialogTitle>Create Load Operation from Proforma</DialogTitle>
//                 <DialogDescription>
//                   Search for a proforma slip by order number to create a Load operation.
//                 </DialogDescription>
//               </DialogHeader>
//               <div className="space-y-4 pt-2">
//                 {!proformaSlipDetails ? (
//                   // Search form when no slip is selected
//                   <>
//                     <div className="space-y-2">
//                       <Label htmlFor="orderNumber">Order Number</Label>
//                       <div className="relative">
//                         <span className="absolute left-3 top-1/2 -translate-y-1/2 text-gray-500">#</span>
//                         <Input
//                           id="orderNumber"
//                           name="orderNumber"
//                           placeholder="Enter order number"
//                           className="pl-6"
//                           value={orderNumberToSearch}
//                           onChange={(e) => setOrderNumberToSearch(e.target.value)}
//                         />
//                       </div>
//                     </div>
//                     <div className="flex flex-col sm:flex-row sm:justify-end space-y-2 sm:space-y-0 sm:space-x-2 pt-2">
//                       <Button 
//                         type="button" 
//                         variant="outline" 
//                         className="w-full sm:w-auto"
//                         onClick={() => {
//                           setOrderNumberToSearch('');
//                           setProformaSlipDetails(null);
//                           setIsOrderLookupDialogOpen(false);
//                         }}
//                       >
//                         Cancel
//                       </Button>
//                       <Button 
//                         className="w-full sm:w-auto"
//                         onClick={() => handleOrderLookupForOperation(orderNumberToSearch)}
//                       >
//                         {isOrderSearchLoading ? (
//                           <>
//                             <Loader2 className="mr-2 h-4 w-4 animate-spin" />
//                             Searching...
//                           </>
//                         ) : (
//                           <>Find Slip</>
//                         )}
//                       </Button>
//                     </div>
//                   </>
//                 ) : (
//                   // Show slip details after one is found
//                   <div className="space-y-6">

//                     <div className="border rounded-md p-4 bg-muted/30">
//                       <h3 className="text-lg font-semibold mb-2">Proforma Slip Details</h3>
//                       <div className="grid gap-2">
//                         <div className="flex justify-between items-center">
//                           <span className="text-muted-foreground">Order Number:</span>
//                           <span className="font-medium">#{proformaSlipDetails?.slip?.orderNumber || 'N/A'}</span>
//                         </div>
//                         <div className="flex justify-between items-center">
//                           <span className="text-muted-foreground">Order Date:</span>
//                           <span className="font-medium">
//                             {proformaSlipDetails?.slip?.orderDate ? formatDateToDDMMYYYY(proformaSlipDetails.slip.orderDate) : 'N/A'}
//                           </span>
//                         </div>
//                         <div className="flex justify-between items-center">
//                           <span className="text-muted-foreground">Party Name:</span>
//                           <span className="font-medium">{proformaSlipDetails?.slip?.partyName || "N/A"}</span>
//                         </div>
//                         <div className="flex justify-between items-center">
//                           <span className="text-muted-foreground">Plant:</span>
//                           <span className="font-medium"><PlantBadge plant={proformaSlipDetails?.slip?.plant || ""} /></span>
//                         </div>
//                         <div className="flex justify-between items-center">
//                           <span className="text-muted-foreground">Vehicle Number:</span>
//                           <span className="font-medium">{proformaSlipDetails?.slip?.vehicleNumber || "Not assigned"}</span>
//                         </div>
//                         <div className="flex justify-between items-center">
//                           <span className="text-muted-foreground">Driver Name:</span>
//                           <span className="font-medium">{proformaSlipDetails?.slip?.driverName || "Not assigned"}</span>
//                         </div>
//                         <div className="flex justify-between items-center">
//                           <span className="text-muted-foreground">Status:</span>
//                           <Badge variant="secondary" className="bg-purple-100 text-purple-800 hover:bg-purple-200">
//                             {proformaSlipDetails?.operation?.status || "PENDING"}
//                           </Badge>
//                         </div>
//                         <div className="flex justify-between items-center">
//                           <span className="text-muted-foreground">Total Items:</span>
//                           <span className="font-medium">{proformaSlipDetails?.items?.length || 0}</span>
//                         </div>
//                       </div>
//                     </div>
                    
//                     <div className="border rounded-md">
//                       <h4 className="text-sm font-medium p-3 border-b bg-muted/30">Items in Slip</h4>
//                       <div className="max-h-60 overflow-y-auto">
//                         <Table>
//                           <TableHeader>
//                             <TableRow>
//                               <TableHead className="w-24">Sr. No.</TableHead>
//                               <TableHead>Name</TableHead>
//                               <TableHead className="w-20 text-right">Qty</TableHead>
//                             </TableRow>
//                           </TableHeader>
//                           <TableBody>
//                             {proformaSlipDetails?.items?.length > 0 ? (
//                               proformaSlipDetails?.items.map((item, idx) => (
//                                 <TableRow key={item.id}>
//                                   <TableCell>{getSrNo(item, idx + 1)}</TableCell>
//                                   <TableCell className="max-w-[200px] break-words whitespace-normal">{getItemName(item)}</TableCell>
//                                   <TableCell className="text-right">{item.originalQuantity ?? item.quantity ?? 0}</TableCell>
//                                 </TableRow>
//                               ))
//                             ) : (
//                               <TableRow>
//                                 <TableCell colSpan={3} className="text-center py-4">
//                                   No items in this slip
//                                 </TableCell>
//                               </TableRow>
//                             )}
//                           </TableBody>
//                         </Table>
//                       </div>
//                     </div>
                    
//                     <div className="flex flex-col space-y-4 pt-2">
//                       <Button 
//                         variant="outline"
//                         className="w-full"
//                         onClick={() => {
//                           setOrderNumberToSearch('');
//                           setProformaSlipDetails(null);
//                           setIsOrderLookupDialogOpen(false);
//                         }}
//                       >
//                         Cancel
//                       </Button>
//                       <Button 
//                         variant="default"
//                         className="w-full bg-[#001d6e] hover:bg-[#001d6e]/90"
//                         onClick={() => proformaSlipDetails?.slip && handleCreateOperation(proformaSlipDetails.slip)}
//                         disabled={isLoading}
//                       >
//                         {isLoading ? (
//                           <>
//                             <Loader2 className="mr-2 h-4 w-4 animate-spin" />
//                             Creating...
//                           </>
//                         ) : (
//                           <>Create Operation</>
//                         )}
//                       </Button>
//                       <Button 
//                         type="button" 
//                         variant="ghost"
//                         className="w-full"
//                         onClick={() => {
//                           setOrderNumberToSearch('');
//                           setProformaSlipDetails(null);
//                         }}
//                       >
//                         <ArrowLeft className="h-4 w-4 mr-1" />
//                         Back to Search
//                       </Button>
//                     </div>
//                   </div>
//                 )}
//               </div>
//             </DialogContent>
//           </Dialog>
//         </div>
//       </div>
      
//       {/* Status badges removed per user request */}
      
//       {/* Mobile View - Loading Operations Cards */}
//       <div className="space-y-1 md:hidden -mt-7">
//         {/* Status Indicators (Search bar is already at the top) */}
//         <div className="mb-0">
//           {/* Filter Components */}
//           <div className="mb-1">
//             {/* Operations Filter moved up beside title */}
            
//             {/* Filter row with Date filter */}
//             <div className="flex items-center gap-2 flex-wrap mt-2">
//               {/* SingleDateFilter component - consistent with Proforma page */}
//               <div className="flex-grow md:flex-grow-0">
//                 <SingleDateFilter
//                   pageKey="load-operations-page"
//                   selectedDate={selectedDate}
//                   onDateChange={(date: Date | null) => {
//                     setSelectedDate(date);
//                     setIsDateFilterActive(!!date);
//                     // Update the saved date filter
//                     if (date) {
//                       SingleDateFilterStorage.saveDateFilter('load-operations-page', date);
//                     }
//                   }}
//                 >
//                   {/* Plant Filter added next to the SingleDateFilter clear icon */}
//                   <div className="w-10 h-10">
//                     <PlantFilter 
//                       selectedPlants={selectedPlants}
//                       onPlantChange={setSelectedPlants}
//                       plantOptions={plantOptions}
//                     />
//                   </div>
//                 </SingleDateFilter>
//               </div>
              
//               {/* Legacy Date filter dropdown - hidden on mobile, visible on md+ screens */}
//               <div className="hidden w-32 min-w-[128px]">
//                 <Select
//                   value={dateFilterOption}
//                   onValueChange={(value) => setDateFilterOption(value)}
//                 >
//                   <SelectTrigger className="h-9">
//                     <SelectValue placeholder="Date Filter" />
//                   </SelectTrigger>
//                   <SelectContent>
//                     <SelectItem value="all">All Dates</SelectItem>
//                     <SelectItem value="today">Today</SelectItem>
//                     <SelectItem value="tomorrow">Tomorrow</SelectItem>
//                     <SelectItem value="yesterday">Yesterday</SelectItem>
//                   </SelectContent>
//                 </Select>
//               </div>
//             </div>
//           </div>
          
//           {/* Status indicator buttons */}
//           <div className="flex justify-between mt-2 text-xs">
//             <div className="flex items-center space-x-2">
//               <Button 
//                 variant="outline" 
//                 size="sm" 
//                 className="h-auto py-1.5 px-2 flex items-center bg-gray-50 hover:bg-gray-100"
//                 onClick={() => setActiveViewTab("overall")}
//               >
//                 <Layers className="h-4 w-4 mr-1 text-gray-700" />
//                 <div className="flex flex-col items-start">
//                   <span className="text-[11px] font-bold">ORDERS</span>
//                   <span className="font-medium text-sm">
//                     {(showBackupData ? backupData || [] : data || [])
//                       .filter(op => {
//                         // Apply new date filter - SingleDateFilter takes precedence over dropdown
//                         if (isDateFilterActive && selectedDate) {
//                           // First try to get the order date directly from the operation
//                           const orderDate = op.orderDate || 
//                             (op.referenceNumber && proformaSlipsData[op.referenceNumber]?.slip?.orderDate);
                          
//                           if (!orderDate) return false;
                          
//                           // Parse the order date string to a Date object for comparison
//                           let orderDateObj: Date;
                          
//                           // Convert string dates to Date objects for comparison
//                           if (typeof orderDate === 'string') {
//                             // Try to parse DD/MM/YYYY format first
//                             const [day, month, year] = orderDate.split('/').map(num => parseInt(num, 10));
//                             if (day && month && year) {
//                               orderDateObj = new Date(year, month - 1, day); // month is 0-indexed in JS Date
//                             } else {
//                               // Try to parse as ISO string as fallback
//                               orderDateObj = new Date(orderDate);
//                             }
//                           } else if (isDateObject(orderDate)) {
//                             orderDateObj = orderDate;
//                           } else {
//                             return false;
//                           }
                          
//                           // Compare dates at day level (ignoring time)
//                           const selectedDay = selectedDate.getDate();
//                           const selectedMonth = selectedDate.getMonth();
//                           const selectedYear = selectedDate.getFullYear();
                          
//                           const orderDay = orderDateObj.getDate();
//                           const orderMonth = orderDateObj.getMonth();
//                           const orderYear = orderDateObj.getFullYear();
                          
//                           // Only include operations with matching date
//                           if (selectedDay !== orderDay || selectedMonth !== orderMonth || selectedYear !== orderYear) {
//                             return false;
//                           }
//                         }
//                         // Legacy dropdown date filter - only apply if the SingleDateFilter is not active
//                         else if (!isDateFilterActive && dateFilterOption !== "all") {
//                           // Get the order date from proforma slip data
//                           const orderDate = op.referenceNumber && 
//                             proformaSlipsData[op.referenceNumber]?.slip?.orderDate;
                          
//                           if (!orderDate) return false;
                          
//                           const orderDateStr = typeof orderDate === 'string' ? orderDate : 
//                             (isDateObject(orderDate) ? formatDateToDDMMYYYY(orderDate) : null);
                            
//                           if (!orderDateStr) return false;
                          
//                           // Check if the date matches the selected filter
//                           if (dateFilterOption === "today" && !isDateToday(orderDateStr)) return false;
//                           if (dateFilterOption === "tomorrow" && !isDateTomorrow(orderDateStr)) return false;
//                           if (dateFilterOption === "yesterday" && !isDateYesterday(orderDateStr)) return false;
//                         }
                        
//                         // Filter by plant if plants are selected
//                         // Filter by plant if plants are selected
//                         if (selectedPlants.length > 0) {
//                           const operationPlant = op.referenceNumber && proformaSlipsData[op.referenceNumber]?.slip?.plant;
//                           if (!operationPlant || !selectedPlants.includes(operationPlant)) {
//                             return false;
//                           }
//                         }
                        
//                         // Apply search query filter
//                         if (searchQuery && searchQuery.trim() !== '') {
//                           return (
//                             (op.referenceNumber && op.referenceNumber.toLowerCase().includes(searchQuery.toLowerCase())) ||
//                             (op.status && op.status.toLowerCase().includes(searchQuery.toLowerCase())) ||
//                             (op.referenceNumber && 
//                           proformaSlipsData[op.referenceNumber] && 
//                           proformaSlipsData[op.referenceNumber]?.slip?.partyName?.toLowerCase().includes(searchQuery.toLowerCase()))
//                           );
//                         }
                        
//                         return true;
//                       }).length}
//                   </span>
//                 </div>
//               </Button>
//               <Button 
//                 variant="outline" 
//                 size="sm" 
//                 className="h-auto py-1.5 px-2 flex items-center bg-blue-50 hover:bg-blue-100"
//                 onClick={() => setActiveViewTab("loading")}
//               >
//                 <Package className="h-4 w-4 mr-1 text-blue-600" />
//                 <div className="flex flex-col items-start">
//                   <span className="text-[11px] font-bold">LOADING</span>
//                   <span className="font-medium text-sm">
//                     {/* Count unique vehicles in LOADING status */}
//                     {(() => {
//                       // Get all operations with LOADING status
//                       const loadingOps = (showBackupData ? backupData || [] : data || [])
//                         .filter(op => {
//                           // First check status
//                           if (op.status !== "LOADING") return false;
                          
//                           // Apply new date filter - SingleDateFilter takes precedence over dropdown
//                           if (isDateFilterActive && selectedDate) {
//                             // First try to get the order date directly from the operation
//                             const orderDate = op.orderDate || 
//                               (op.referenceNumber && proformaSlipsData[op.referenceNumber]?.slip?.orderDate);
                            
//                             if (!orderDate) return false;
                            
//                             // Parse the order date string to a Date object for comparison
//                             let orderDateObj: Date;
                            
//                             // Convert string dates to Date objects for comparison
//                             if (typeof orderDate === 'string') {
//                               // Try to parse DD/MM/YYYY format first
//                               const [day, month, year] = orderDate.split('/').map(num => parseInt(num, 10));
//                               if (day && month && year) {
//                                 orderDateObj = new Date(year, month - 1, day); // month is 0-indexed in JS Date
//                               } else {
//                                 // Try to parse as ISO string as fallback
//                                 orderDateObj = new Date(orderDate);
//                               }
//                             } else if (isDateObject(orderDate)) {
//                               orderDateObj = orderDate;
//                             } else {
//                               return false;
//                             }
                            
//                             // Compare dates at day level (ignoring time)
//                             const selectedDay = selectedDate.getDate();
//                             const selectedMonth = selectedDate.getMonth();
//                             const selectedYear = selectedDate.getFullYear();
                            
//                             const orderDay = orderDateObj.getDate();
//                             const orderMonth = orderDateObj.getMonth();
//                             const orderYear = orderDateObj.getFullYear();
                            
//                             // Only include operations with matching date
//                             if (selectedDay !== orderDay || selectedMonth !== orderMonth || selectedYear !== orderYear) {
//                               return false;
//                             }
//                           }
                          
//                           // Filter by plant if plants are selected
//                         // Filter by plant if plants are selected
//                         if (selectedPlants.length > 0) {
//                           const operationPlant = op.referenceNumber && proformaSlipsData[op.referenceNumber]?.slip?.plant;
//                           if (!operationPlant || !selectedPlants.includes(operationPlant)) {
//                             return false;
//                           }
//                         }
                          
//                           // Apply search query filter
//                           if (searchQuery && searchQuery.trim() !== '') {
//                             return (
//                               (op.referenceNumber && op.referenceNumber.toLowerCase().includes(searchQuery.toLowerCase())) ||
//                               (op.status && op.status.toLowerCase().includes(searchQuery.toLowerCase())) ||
//                               (op.referenceNumber && 
//                           proformaSlipsData[op.referenceNumber] && 
//                           proformaSlipsData[op.referenceNumber]?.slip?.partyName?.toLowerCase().includes(searchQuery.toLowerCase()))
//                             );
//                           }
                          
//                           return true;
//                         });
                      
//                       // Extract unique vehicle numbers
//                       const uniqueVehicles = new Set<string>();
                      
//                       loadingOps.forEach(op => {
//                         if (op.referenceNumber && proformaSlipsData[op.referenceNumber]?.slip?.vehicleNumber) {
//                           const vehicleNumber = proformaSlipsData[op.referenceNumber]?.slip?.vehicleNumber;
//                           if (vehicleNumber && vehicleNumber.trim() !== '') {
//                             uniqueVehicles.add(vehicleNumber);
//                           }
//                         }
//                       });
                      
//                       return uniqueVehicles.size;
//                     })()}
//                   </span>
//                 </div>
//               </Button>
//               <Button 
//                 variant="outline" 
//                 size="sm" 
//                 className="h-auto py-1.5 px-2 flex items-center bg-amber-50 hover:bg-amber-100"
//                 onClick={() => setActiveViewTab("ready-desp")}
//               >
//                 <TruckIcon className="h-4 w-4 mr-1 text-amber-600" />
//                 <div className="flex flex-col items-start">
//                   <span className="text-[11px] font-bold">READY≈DESP</span>
//                   <span className="font-medium text-sm">
//                     {/* Count unique vehicles in READY≈DESP status */}
//                     {(() => {
//                       // Get all operations with READY≈DESP status
//                       const readyDespOps = (showBackupData ? backupData || [] : data || [])
//                         .filter(op => {
//                           // First check status
//                           if (op.status !== "READY≈DESP") return false;
                          
//                           // Apply new date filter - SingleDateFilter takes precedence over dropdown
//                           if (isDateFilterActive && selectedDate) {
//                             // First try to get the order date directly from the operation
//                             const orderDate = op.orderDate || 
//                               (op.referenceNumber && proformaSlipsData[op.referenceNumber]?.slip?.orderDate);
                            
//                             if (!orderDate) return false;
                            
//                             // Parse the order date string to a Date object for comparison
//                             let orderDateObj: Date;
                            
//                             // Convert string dates to Date objects for comparison
//                             if (typeof orderDate === 'string') {
//                               // Try to parse DD/MM/YYYY format first
//                               const [day, month, year] = orderDate.split('/').map(num => parseInt(num, 10));
//                               if (day && month && year) {
//                                 orderDateObj = new Date(year, month - 1, day); // month is 0-indexed in JS Date
//                               } else {
//                                 // Try to parse as ISO string as fallback
//                                 orderDateObj = new Date(orderDate);
//                               }
//                             } else if (isDateObject(orderDate)) {
//                               orderDateObj = orderDate;
//                             } else {
//                               return false;
//                             }
                            
//                             // Compare dates at day level (ignoring time)
//                             const selectedDay = selectedDate.getDate();
//                             const selectedMonth = selectedDate.getMonth();
//                             const selectedYear = selectedDate.getFullYear();
                            
//                             const orderDay = orderDateObj.getDate();
//                             const orderMonth = orderDateObj.getMonth();
//                             const orderYear = orderDateObj.getFullYear();
                            
//                             // Only include operations with matching date
//                             if (selectedDay !== orderDay || selectedMonth !== orderMonth || selectedYear !== orderYear) {
//                               return false;
//                             }
//                           }
                          
//                           // Filter by plant if plants are selected
//                         // Filter by plant if plants are selected
//                         if (selectedPlants.length > 0) {
//                           const operationPlant = op.referenceNumber && proformaSlipsData[op.referenceNumber]?.slip?.plant;
//                           if (!operationPlant || !selectedPlants.includes(operationPlant)) {
//                             return false;
//                           }
//                         }
                          
//                           // Apply search query filter
//                           if (searchQuery && searchQuery.trim() !== '') {
//                             return (
//                               (op.referenceNumber && op.referenceNumber.toLowerCase().includes(searchQuery.toLowerCase())) ||
//                               (op.status && op.status.toLowerCase().includes(searchQuery.toLowerCase())) ||
//                               (op.referenceNumber && 
//                           proformaSlipsData[op.referenceNumber] && 
//                           proformaSlipsData[op.referenceNumber]?.slip?.partyName?.toLowerCase().includes(searchQuery.toLowerCase()))
//                             );
//                           }
                          
//                           return true;
//                         });
                      
//                       // Extract unique vehicle numbers
//                       const uniqueVehicles = new Set<string>();
                      
//                       readyDespOps.forEach(op => {
//                         if (op.referenceNumber && proformaSlipsData[op.referenceNumber]?.slip?.vehicleNumber) {
//                           const vehicleNumber = proformaSlipsData[op.referenceNumber]?.slip?.vehicleNumber;
//                           if (vehicleNumber && vehicleNumber.trim() !== '') {
//                             uniqueVehicles.add(vehicleNumber);
//                           }
//                         }
//                       });
                      
//                       return uniqueVehicles.size;
//                     })()}
//                   </span>
//                 </div>
//               </Button>
//             </div>
//           </div>
          
//           {/* Search bar and create button below status buttons */}
//           <div className="flex items-center gap-2 w-full mt-3">
//             <div className="flex-1">
//               <Input
//                 placeholder="Search operations..."
//                 value={searchQuery}
//                 onChange={(e) => setSearchQuery(e.target.value)}
//                 className="w-full h-10 text-sm"
//               />
//             </div>
            
//             <Dialog open={isOrderLookupDialogOpen} onOpenChange={setIsOrderLookupDialogOpen}>
//               <DialogTrigger asChild>
//                 <Button variant="default" className="bg-[#001d6e] hover:bg-[#001d6e]/90 h-12 w-12 flex items-center justify-center">
//                   <PlusCircle className="w-7 h-7 text-white" />
//                 </Button>
//               </DialogTrigger>
//             </Dialog>
//           </div>
//         </div>
        
//         {/* Navigation Tabs */}
//         <div className="mb-2">
//           <Tabs value={activeViewTab} onValueChange={setActiveViewTab} className="w-full">
//             <TabsList className="w-full">
//               <TabsTrigger value="overall" className="flex-1">
//                 All Operations
//               </TabsTrigger>
//               <TabsTrigger value="loading" className="flex-1">
//                 Loading
//               </TabsTrigger>
//               <TabsTrigger value="ready-desp" className="flex-1">
//                 Ready for Dispatch
//               </TabsTrigger>
//             </TabsList>
//           </Tabs>
//         </div>
        
//         {!isLoading && (showBackupData ? (!isBackupLoading && backupData) : data) && (showBackupData ? backupData || [] : data || []).length > 0 ? (
//           (() => {
//             // Filter and sort operations
//             const filteredOperations = (showBackupData ? backupData || [] : data || [])
//               .filter(operation => {
//                 // First filter by tab selection
//                 if (activeViewTab === "ready-desp" && operation.status !== "READY≈DESP") {
//                   return false;
//                 }
//                 if (activeViewTab === "loading" && operation.status !== "LOADING") {
//                   return false;
//                 }
                
//                 // Filter by plant if plants are selected
//                 if (selectedPlants.length > 0) {
//                   // Check if plant exists and is not null/empty
//                   const operationPlant = operation.plant;
//                   if (!operationPlant || operationPlant.trim() === '') {
//                     return false;
//                   }
                  
//                   // Finally check if selected plants includes this plant
//                   if (!selectedPlants.includes(operationPlant)) {
//                     return false;
//                   }
//                 }
                
//                 // Apply new date filter - SingleDateFilter takes precedence over dropdown
//                 if (isDateFilterActive && selectedDate) {
//                   // Use only the order date directly from the operation
//                   const orderDate = operation.orderDate;
                  
//                   if (!orderDate) return false;
                  
//                   // Parse the order date string to a Date object for comparison
//                   let orderDateObj: Date;
                  
//                   // Convert string dates to Date objects for comparison
//                   if (typeof orderDate === 'string') {
//                     // Try to parse DD/MM/YYYY format first
//                     const [day, month, year] = orderDate.split('/').map(num => parseInt(num, 10));
//                     if (day && month && year) {
//                       orderDateObj = new Date(year, month - 1, day); // month is 0-indexed in JS Date
//                     } else {
//                       // Try to parse as ISO string as fallback
//                       orderDateObj = new Date(orderDate);
//                     }
//                   } else if (isDateObject(orderDate)) {
//                     orderDateObj = orderDate;
//                   } else {
//                     return false;
//                   }
                  
//                   // Compare dates at day level (ignoring time)
//                   const selectedDay = selectedDate.getDate();
//                   const selectedMonth = selectedDate.getMonth();
//                   const selectedYear = selectedDate.getFullYear();
                  
//                   const orderDay = orderDateObj.getDate();
//                   const orderMonth = orderDateObj.getMonth();
//                   const orderYear = orderDateObj.getFullYear();
                  
//                   // Only include operations with matching date
//                   if (selectedDay !== orderDay || selectedMonth !== orderMonth || selectedYear !== orderYear) {
//                     return false;
//                   }
//                 }
                
//                 // Then filter by search query
//                 if (!searchQuery) return true;
//                 return (
//                   (operation.referenceNumber && operation.referenceNumber.includes(searchQuery)) || 
//                   (operation.status && operation.status.toLowerCase().includes(searchQuery.toLowerCase())) ||
//                   (operation.partyName && operation.partyName.toLowerCase().includes(searchQuery.toLowerCase()))
//                 );
//               })
//               // Clear the old sort order and apply new sorting logic
//               // This ensures we're overriding any other sorting that might be happening
//               .sort((a, b) => {
//                 // First - Sort by newly created flag
//                 if (newlyCreatedLoadingId) {
//                   if (a.id === newlyCreatedLoadingId) return -1; // a comes first
//                   if (b.id === newlyCreatedLoadingId) return 1;  // b comes first
//                 }
                
//                 // Sort by ID based on sortOrder (desc = newest first, asc = oldest first)
//                 // Higher IDs are newer since they're auto-incremented
//                 return sortOrder === 'desc' ? b.id - a.id : a.id - b.id;
//               });
              
//               // Log the operations after sorting
//               console.log('Sorted operations order (newest first):', 
//                 filteredOperations.map(op => `ID: ${op.id}, RefNum: ${op.referenceNumber}`));
            
//             // Get visible items based on ITEMS_PER_PAGE
//             const visibleCount = visibleItems[activeViewTab] || ITEMS_PER_PAGE;
//             const hasMore = filteredOperations.length > visibleCount;
            
//             return (
//               <>
//                 {filteredOperations.slice(0, visibleCount).map((operation) => (
//             <Card key={operation.id} className="overflow-hidden">
//               <CardHeader className="pb-2 pt-3">
//                 <div className="flex justify-between items-start">
//                   <div>
//                     <div className="font-medium text-md flex items-center">
//                       #{operation.referenceNumber}
//                       {operation.plant && (
//                         <span className="ml-2">
//                           <PlantBadge plant={operation.plant} />
//                         </span>
//                       )}
//                     </div>
//                     <div className="text-sm text-muted-foreground mt-1">
//                       {/* Use party name directly from load operations table */}
//                       {operation.partyName ? operation.partyName : "-"}
//                     </div>
//                   </div>
//                   <div className="flex flex-col items-end">
//                     <Badge variant={getBadgeVariant(operation.status)} className="bg-purple-100 text-purple-800 hover:bg-purple-200 text-xs">
//                       {operation.status || "Unknown"}
//                     </Badge>
//                   </div>
//                 </div>
//               </CardHeader>
//               <CardContent className="pb-4 pt-0">
//                 {/* Vehicle number display removed from here - will be shown with buttons */}
                
//                 {/* Moving date display to after buttons */}
                
//                 <div className="flex justify-between items-center mt-2">
//                   <div className="flex items-center gap-2">
//                     {/* Vehicle number with yellow background and orange text in a perfect circle */}
//                     {operation.vehicleNumber && (
//                       <div 
//                         className="h-10 w-10 rounded-full bg-amber-50 flex items-center justify-center overflow-hidden"
//                         title={operation.vehicleNumber || ""}
//                       >
//                         <span className="text-orange-600 font-medium text-xs truncate px-1">
//                           {operation.vehicleNumber}
//                         </span>
//                       </div>
//                     )}
                    
//                     <Button 
//                       variant="ghost" 
//                       size="icon"
//                       style={{height: '2.5rem', width: '2.5rem', padding: '0'}}
//                       className="h-10 w-10 p-0 rounded-full bg-blue-50 hover:bg-blue-100 !important"
//                       title={operation.status === "READY≈DESP" && !userPermissions.canEditReadyDespOperations ? 
//                         "View Load Operation (only admin can edit READY≈DESP status)" : 
//                         "Edit Load Operation"}
//                       onClick={async () => {
//                         setSelectedOperation(operation);
//                         setLoadingProformaDetails(true);
                        
//                         try {
//                           // Fetch the proforma slip details for the edit form
//                           // Pass the operation ID to prioritize loading operation items
//                           const details = await fetchLoadOperationDetails(operation.referenceNumber, operation.id);
//                           if (details) {
//                             // Process items to ensure all required properties are available
//                             // No need to map items here since now fetchLoadOperationDetails will handle this properly
//                             setViewProformaDetails(details);
//                           }
//                         } catch (error) {
//                           console.error("Error fetching operation details:", error);
//                           toast({
//                             title: "Error",
//                             description: "Failed to load load operation details",
//                             variant: "destructive",
//                           });
//                         } finally {
//                           setLoadingProformaDetails(false);
//                         }
                        
//                         // Trigger the edit dialog on the desktop view
//                         // Find and click the desktop edit button for this operation
//                         const desktopEditButton = document.querySelector(`#edit-operation-${operation.id}`);
//                         if (desktopEditButton instanceof HTMLButtonElement) {
//                           desktopEditButton.click();
//                         }
//                       }}
//                     >
//                       <FileText className="h-6 w-6 text-[#001d6e]" style={{height: '1.5rem', width: '1.5rem'}} />
//                     </Button>
                    
//                     {userPermissions.canDelete && (
//                       <Dialog
//                         onOpenChange={(open) => {
//                           if (!open) {
//                             // Reset filter when dialog is closed
//                             setActiveItemFilter("all");
//                           }
//                         }}
//                       >
//                         <DialogTrigger asChild>
//                           <Button 
//                             variant="ghost" 
//                             size="icon" 
//                             style={{height: '2.5rem', width: '2.5rem', padding: '0'}}
//                             className="text-red-500 h-10 w-10 p-0 rounded-full bg-red-50 hover:bg-red-100 !important">
//                             <Trash className="h-6 w-6 text-red-500" style={{height: '1.5rem', width: '1.5rem'}} />
//                           </Button>
//                         </DialogTrigger>
//                         <DialogContent>
//                           <DialogHeader>
//                             <DialogTitle>Confirm Deletion</DialogTitle>
//                             <DialogDescription>
//                               Are you sure you want to delete this loading operation? This action cannot be undone.
//                             </DialogDescription>
//                           </DialogHeader>
//                           <DialogFooter>
//                             <Button
//                               variant="outline"
//                               onClick={() => {
//                                 const closeButton = document.querySelector<HTMLButtonElement>('[data-state="open"]');
//                                 if (closeButton) closeButton.click();
//                               }}
//                             >
//                               Cancel
//                             </Button>
//                             <Button
//                               variant="destructive"
//                               onClick={async () => {
//                                 try {
//                                   await apiRequest('DELETE', `/api/loading-operations/${operation.id}`);
                                  
//                                   toast({
//                                     title: "Deleted",
//                                     description: "Loading operation deleted successfully",
//                                   });
                                  
//                                   refetchRef.current();
                                  
//                                   const closeButton = document.querySelector<HTMLButtonElement>('[data-state="open"]');
//                                   if (closeButton) closeButton.click();
//                                 } catch (error) {
//                                   console.error("Error deleting operation:", error);
//                                   toast({
//                                     title: "Error",
//                                     description: "Failed to delete operation",
//                                     variant: "destructive",
//                                   });
//                                 }
//                               }}
//                             >
//                               Delete
//                             </Button>
//                           </DialogFooter>
//                         </DialogContent>
//                       </Dialog>
//                     )}
//                   </div>
//                   <div className="flex flex-col items-end">
//                     {/* Date display with icon */}
//                     <div className="flex flex-col items-end text-xs">
//                       <div className="flex items-center">
//                         <CalendarIcon className="h-3 w-3 mr-1 text-muted-foreground" />
//                         <span className="font-medium">
//                           {operation.orderDate ? 
//                             formatDateToDDMMYYYY(operation.orderDate) : "N/A"}
//                         </span>
//                       </div>
//                       <div className="text-muted-foreground mt-0.5">
//                         Gen: {formatDateToDDMMYYYY(operation.createdAt)}
//                       </div>
//                     </div>
                    
//                     {/* Creator name and time */}
//                     <div className="text-xs text-muted-foreground mt-2 flex items-center">
//                       <UserCircle2 className="h-3 w-3 mr-1" />
//                       <span>
//                         {extractCreatorInfo(operation.notes).name}
//                         • {new Date(operation.createdAt || '').toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit', hour12: false })}
//                       </span>
//                     </div>
//                   </div>
//                 </div>
//               </CardContent>
//             </Card>
//           ))}
          
//           {hasMore && (
//             <Button 
//               variant="outline" 
//               className="w-full mt-2" 
//               onClick={() => {
//                 setVisibleItems({
//                   ...visibleItems,
//                   [activeViewTab]: (visibleItems[activeViewTab] || ITEMS_PER_PAGE) + ITEMS_PER_PAGE
//                 });
//               }}
//             >
//               View More ({filteredOperations.length - visibleCount} remaining)
//             </Button>
//           )}
//           </>
//           );
//           })()
//         ) : (
//           <div className="text-center py-6 text-muted-foreground border rounded-md">
//             {isLoading ? 
//               <div className="flex justify-center items-center py-4">
//                 <Loader2 className="h-6 w-6 animate-spin text-muted-foreground" />
//                 <span className="ml-2">Load slips...</span>
//               </div>
//               : 
//               "No load slips found"
//             }
//           </div>
//         )}
//       </div>

//       {/* Desktop View - Search Bar Above Tabs */}
//       <div className="mb-2 block">
//         {/* Search Bar and Status Indicators */}
//         <div className="mb-3 flex flex-col space-y-3">
//           {/* Search Bar - Full Width (hidden on mobile) */}
//           <div className="w-full hidden md:block">
//             <Input
//               placeholder="Search by order number, status or party name..."
//               value={searchQuery}
//               onChange={(e) => setSearchQuery(e.target.value)}
//               className="w-full"
//             />
//           </div>
          
//           {/* Row with Date Filter, Plant Filter, Status Buttons, and User Info */}
//           <div className="flex items-center flex-wrap gap-2 hidden md:flex">
            
//             {/* Operations Filter */}
//             <div className="flex-grow-0">
//               <OperationsFilter onFilterChange={handleOperationsFilterChange} />
//             </div>
            
//             {/* Date Filter */}
//             <div className="flex-grow-0">
//               <SingleDateFilter
//                 pageKey="load-operations-page"
//                 selectedDate={selectedDate}
//                 onDateChange={(date: Date | null) => {
//                   setSelectedDate(date);
//                   setIsDateFilterActive(!!date);
//                   // Update the saved date filter
//                   if (date) {
//                     SingleDateFilterStorage.saveDateFilter('load-operations-page', date);
//                   }
//                 }}
//               />
//             </div>
            
//             {/* Plant Filter */}
//             <PlantFilter 
//               selectedPlants={selectedPlants}
//               onPlantChange={setSelectedPlants}
//               plantOptions={plantOptions}
//             />
            

//             {/* Status Buttons */}
//             <Button 
//               variant="outline" 
//               size="sm" 
//               className="h-auto py-1.5 px-3 flex items-center bg-gray-50 hover:bg-gray-100"
//               onClick={() => setActiveViewTab("overall")}
//             >
//               <Layers className="h-4 w-4 mr-2 text-gray-700" />
//               <div className="flex flex-col items-start">
//                 <span className="text-xs font-bold">ORDERS</span>
//                 <span className="text-sm font-semibold">
//                   {(showBackupData ? backupData || [] : data || [])
//                     .filter(op => {
//                       // Apply new date filter - SingleDateFilter takes precedence over dropdown
//                       if (isDateFilterActive && selectedDate) {
//                         // Special case for known problematic operation IDs like #65908
//                         if (op.referenceNumber === "65908") {
//                           console.log(`Found operation #65908, showing it regardless of date filter`);
//                           return true;
//                         }
                        
//                         // Get the order date from proforma slip data
//                         const orderDate = op.referenceNumber && 
//                           proformaSlipsData[op.referenceNumber]?.slip?.orderDate;
                        
//                         // If we don't have order date info yet, show the operation anyway to avoid hiding valid items
//                         // This ensures operations will still show up even if we haven't loaded their proforma data yet
//                         if (!orderDate) return true;
                        
//                         // Parse the order date string to a Date object for comparison
//                         let orderDateObj: Date;
                        
//                         // Convert string dates to Date objects for comparison
//                         if (typeof orderDate === 'string') {
//                           // Try to parse DD/MM/YYYY format first
//                           const [day, month, year] = orderDate.split('/').map(num => parseInt(num, 10));
//                           if (day && month && year) {
//                             orderDateObj = new Date(year, month - 1, day); // month is 0-indexed in JS Date
//                           } else {
//                             // Try to parse as ISO string as fallback
//                             orderDateObj = new Date(orderDate);
//                           }
//                         } else if (isDateObject(orderDate)) {
//                           orderDateObj = orderDate;
//                         } else {
//                           // If we can't parse the date, include the operation by default
//                           return true;
//                         }
                        
//                         // Compare dates at day level (ignoring time)
//                         const selectedDay = selectedDate.getDate();
//                         const selectedMonth = selectedDate.getMonth();
//                         const selectedYear = selectedDate.getFullYear();
                        
//                         const orderDay = orderDateObj.getDate();
//                         const orderMonth = orderDateObj.getMonth();
//                         const orderYear = orderDateObj.getFullYear();
                        
//                         // Only include operations with matching date
//                         if (selectedDay !== orderDay || selectedMonth !== orderMonth || selectedYear !== orderYear) {
//                           return false;
//                         }
//                       }
                      
//                       // Filter by plant if plants are selected
//                         // Filter by plant if plants are selected
//                         if (selectedPlants.length > 0) {
//                           const operationPlant = op.referenceNumber && proformaSlipsData[op.referenceNumber]?.slip?.plant;
//                           if (!operationPlant || !selectedPlants.includes(operationPlant)) {
//                             return false;
//                           }
//                         }
                      
//                       // Apply search query filter
//                       if (searchQuery && searchQuery.trim() !== '') {
//                         return (
//                           (op.referenceNumber && op.referenceNumber.toLowerCase().includes(searchQuery.toLowerCase())) ||
//                           (op.status && op.status.toLowerCase().includes(searchQuery.toLowerCase())) ||
//                           (op.referenceNumber && 
//                           proformaSlipsData[op.referenceNumber] && 
//                           proformaSlipsData[op.referenceNumber]?.slip?.partyName?.toLowerCase().includes(searchQuery.toLowerCase()))
//                         );
//                       }
                      
//                       return true;
//                     }).length}
//                 </span>
//               </div>
//             </Button>
//             <Button 
//               variant="outline" 
//               size="sm" 
//               className="h-auto py-1.5 px-3 flex items-center bg-blue-50 hover:bg-blue-100"
//               onClick={() => setActiveViewTab("loading")}
//             >
//               <Package className="h-4 w-4 mr-2 text-[#001d6e]" />
//               <div className="flex flex-col items-start">
//                 <span className="text-xs font-bold">LOADING</span>
//                 <span className="text-sm font-semibold">
//                   {(() => {
//                     // Get filtered operations with LOADING status
//                     const loadingOps = (showBackupData ? backupData || [] : data || [])
//                       .filter(op => {
//                         // First check if it's a LOADING item
//                         if (op.status !== "LOADING") return false;
                        
//                         // Apply new date filter - SingleDateFilter takes precedence over dropdown
//                         if (isDateFilterActive && selectedDate) {
//                           // Get the order date from proforma slip data
//                           const orderDate = op.referenceNumber && 
//                             proformaSlipsData[op.referenceNumber]?.slip?.orderDate;
                          
//                           if (!orderDate) return false;
                          
//                           // Parse the order date string to a Date object for comparison
//                           let orderDateObj: Date;
                          
//                           // Convert string dates to Date objects for comparison
//                           if (typeof orderDate === 'string') {
//                             // Try to parse DD/MM/YYYY format first
//                             const [day, month, year] = orderDate.split('/').map(num => parseInt(num, 10));
//                             if (day && month && year) {
//                               orderDateObj = new Date(year, month - 1, day); // month is 0-indexed in JS Date
//                             } else {
//                               // Try to parse as ISO string as fallback
//                               orderDateObj = new Date(orderDate);
//                             }
//                           } else if (isDateObject(orderDate)) {
//                             orderDateObj = orderDate;
//                           } else {
//                             return false;
//                           }
                          
//                           // Compare dates at day level (ignoring time)
//                           const selectedDay = selectedDate.getDate();
//                           const selectedMonth = selectedDate.getMonth();
//                           const selectedYear = selectedDate.getFullYear();
                          
//                           const orderDay = orderDateObj.getDate();
//                           const orderMonth = orderDateObj.getMonth();
//                           const orderYear = orderDateObj.getFullYear();
                          
//                           // Only include operations with matching date
//                           if (selectedDay !== orderDay || selectedMonth !== orderMonth || selectedYear !== orderYear) {
//                             return false;
//                           }
//                         }
                        
//                         // Filter by plant if plants are selected
//                         // Filter by plant if plants are selected
//                         if (selectedPlants.length > 0) {
//                           const operationPlant = op.referenceNumber && proformaSlipsData[op.referenceNumber]?.slip?.plant;
//                           if (!operationPlant || !selectedPlants.includes(operationPlant)) {
//                             return false;
//                           }
//                         }
                        
//                         // Apply search query filter
//                         if (searchQuery && searchQuery.trim() !== '') {
//                           return (
//                             (op.referenceNumber && op.referenceNumber.toLowerCase().includes(searchQuery.toLowerCase())) ||
//                             (op.status && op.status.toLowerCase().includes(searchQuery.toLowerCase())) ||
//                             (op.referenceNumber && 
//                           proformaSlipsData[op.referenceNumber] && 
//                           proformaSlipsData[op.referenceNumber]?.slip?.partyName?.toLowerCase().includes(searchQuery.toLowerCase()))
//                           );
//                         }
                        
//                         return true;
//                       });
                    
//                     // Count unique vehicle numbers
//                     const uniqueVehicles = new Set();
                    
//                     loadingOps.forEach(op => {
//                       if (op.referenceNumber && proformaSlipsData[op.referenceNumber]?.slip?.vehicleNumber) {
//                         uniqueVehicles.add(proformaSlipsData[op.referenceNumber]?.slip?.vehicleNumber);
//                       }
//                     });
                    
//                     return uniqueVehicles.size;
//                   })()}
//                 </span>
//               </div>
//             </Button>
//             <Button 
//               variant="outline" 
//               size="sm" 
//               className="h-auto py-1.5 px-3 flex items-center bg-amber-50 hover:bg-amber-100"
//               onClick={() => setActiveViewTab("ready-desp")}
//             >
//               <TruckIcon className="h-4 w-4 mr-2 text-amber-600" />
//               <div className="flex flex-col items-start">
//                 <span className="text-xs font-bold">READY≈DESP</span>
//                 <span className="text-sm font-semibold">
//                   {(() => {
//                     // Get filtered operations with READY≈DESP status
//                     const readyDespOps = (showBackupData ? backupData || [] : data || [])
//                       .filter(op => {
//                         // First check if it's a READY≈DESP item
//                         if (op.status !== "READY≈DESP") return false;
                        
//                         // Apply new date filter - SingleDateFilter takes precedence over dropdown
//                         if (isDateFilterActive && selectedDate) {
//                           // Get the order date from proforma slip data
//                           const orderDate = op.referenceNumber && 
//                             proformaSlipsData[op.referenceNumber]?.slip?.orderDate;
                          
//                           if (!orderDate) return false;
                          
//                           // Parse the order date string to a Date object for comparison
//                           let orderDateObj: Date;
                          
//                           // Convert string dates to Date objects for comparison
//                           if (typeof orderDate === 'string') {
//                             // Try to parse DD/MM/YYYY format first
//                             const [day, month, year] = orderDate.split('/').map(num => parseInt(num, 10));
//                             if (day && month && year) {
//                               orderDateObj = new Date(year, month - 1, day); // month is 0-indexed in JS Date
//                             } else {
//                               // Try to parse as ISO string as fallback
//                               orderDateObj = new Date(orderDate);
//                             }
//                           } else if (isDateObject(orderDate)) {
//                             orderDateObj = orderDate;
//                           } else {
//                             return false;
//                           }
                          
//                           // Compare dates at day level (ignoring time)
//                           const selectedDay = selectedDate.getDate();
//                           const selectedMonth = selectedDate.getMonth();
//                           const selectedYear = selectedDate.getFullYear();
                          
//                           const orderDay = orderDateObj.getDate();
//                           const orderMonth = orderDateObj.getMonth();
//                           const orderYear = orderDateObj.getFullYear();
                          
//                           // Only include operations with matching date
//                           if (selectedDay !== orderDay || selectedMonth !== orderMonth || selectedYear !== orderYear) {
//                             return false;
//                           }
//                         }
                        
//                         // Filter by plant if plants are selected
//                         // Filter by plant if plants are selected
//                         if (selectedPlants.length > 0) {
//                           const operationPlant = op.referenceNumber && proformaSlipsData[op.referenceNumber]?.slip?.plant;
//                           if (!operationPlant || !selectedPlants.includes(operationPlant)) {
//                             return false;
//                           }
//                         }
                        
//                         // Apply search query filter
//                         if (searchQuery && searchQuery.trim() !== '') {
//                           return (
//                             (op.referenceNumber && op.referenceNumber.toLowerCase().includes(searchQuery.toLowerCase())) ||
//                             (op.status && op.status.toLowerCase().includes(searchQuery.toLowerCase())) ||
//                             (op.referenceNumber && 
//                           proformaSlipsData[op.referenceNumber] && 
//                           proformaSlipsData[op.referenceNumber]?.slip?.partyName?.toLowerCase().includes(searchQuery.toLowerCase()))
//                           );
//                         }
                        
//                         return true;
//                       });
                    
//                     // Count unique vehicle numbers
//                     const uniqueVehicles = new Set();
                    
//                     readyDespOps.forEach(op => {
//                       if (op.referenceNumber && proformaSlipsData[op.referenceNumber]?.slip?.vehicleNumber) {
//                         uniqueVehicles.add(proformaSlipsData[op.referenceNumber]?.slip?.vehicleNumber);
//                       }
//                     });
                    
//                     return uniqueVehicles.size;
//                   })()}
//                 </span>
//               </div>
//             </Button>
            
//             {/* Create Load Slip button moved beside the Ready for Dispatch button */}
//             <Dialog open={isOrderLookupDialogOpen} onOpenChange={setIsOrderLookupDialogOpen}>
//               <DialogTrigger asChild>
//                 <Button variant="default" className="ml-2 space-x-2 bg-[#001d6e] hover:bg-[#001d6e]/90 h-12 md:h-12">
//                   <PlusCircle className="w-5 h-5 text-white" />
//                   <span className="text-white">Create Load Slip</span>
//                 </Button>
//               </DialogTrigger>
//             </Dialog>
//           </div>
//         </div>
        
//         {/* Navigation Tabs (hidden on mobile) */}
//         <div className="mb-2 hidden md:block">
//           <Tabs value={activeViewTab} onValueChange={setActiveViewTab} className="w-full">
//             <TabsList className="w-full justify-start">
//               <TabsTrigger value="overall" className="flex-1 max-w-[200px]">
//                 All Operations
//               </TabsTrigger>
//               <TabsTrigger value="loading" className="flex-1 max-w-[200px]">
//                 Loading
//               </TabsTrigger>
//               <TabsTrigger value="ready-desp" className="flex-1 max-w-[200px]">
//                 Ready for Dispatch
//               </TabsTrigger>
//             </TabsList>
//           </Tabs>
//         </div>
//       </div>
      


//       {/* Desktop View - Loading Operations Table */}
//       <div className="hidden md:block border rounded-md w-full">
//         <Table className="hidden md:table">
//           <TableHeader>
//             <TableRow>
//               <TableHead className="w-12">
//                 <Checkbox 
//                   checked={
//                     showBackupData 
//                       ? (filteredBackupData && filteredBackupData.length > 0) 
//                         ? selectedOperationIds.length === filteredBackupData.length && 
//                           filteredBackupData.every(op => selectedOperationIds.includes(op.id))
//                         : false
//                       : (filteredOperations && filteredOperations.length > 0)
//                         ? selectedOperationIds.length === filteredOperations.length && 
//                           filteredOperations.every(op => selectedOperationIds.includes(op.id))
//                         : false
//                   }
//                   onCheckedChange={(checked) => {
//                     if (checked) {
//                       // Only select visible/filtered operations
//                       if (showBackupData && filteredBackupData) {
//                         setSelectedOperationIds(filteredBackupData.map(op => op.id));
//                       } else if (!showBackupData && filteredOperations) {
//                         setSelectedOperationIds(filteredOperations.map(op => op.id));
//                       }
//                     } else {
//                       setSelectedOperationIds([]);
//                     }
//                   }}
//                 />
//               </TableHead>
//               <TableHead>Order Date</TableHead>
//               <TableHead 
//                 className="cursor-pointer"
//                 onClick={() => {
//                   setSortBy('orderNumber');
//                   setSortOrder(prev => prev === 'asc' ? 'desc' : 'asc');
//                 }}
//               >
//                 Order Number {sortBy === 'orderNumber' && (sortOrder === 'asc' ? <ChevronUp className="inline h-4 w-4" /> : <ChevronDown className="inline h-4 w-4" />)}
//               </TableHead>
//               <TableHead>Party Name</TableHead>
//               <TableHead>Plant</TableHead>
//               <TableHead>Vehicle No.</TableHead>
//               <TableHead>Loaded Qty</TableHead>
//               <TableHead>Status</TableHead>
//               <TableHead 
//                 className="cursor-pointer"
//                 onClick={() => {
//                   setSortBy('creationDate');
//                   setSortOrder(prev => prev === 'asc' ? 'desc' : 'asc');
//                 }}
//               >
//                 Creator {sortBy === 'creationDate' && (sortOrder === 'asc' ? <ChevronUp className="inline h-4 w-4" /> : <ChevronDown className="inline h-4 w-4" />)}
//               </TableHead>
//               <TableHead className="text-right">Actions</TableHead>
//             </TableRow>
//           </TableHeader>
//           <TableBody>
//             {!isLoading && (showBackupData ? !isBackupLoading && filteredBackupData : filteredOperations) && 
//              (showBackupData ? filteredBackupData.length > 0 : filteredOperations.length > 0) ? (
//               (showBackupData ? filteredBackupData : filteredOperations)
//               // Apply sorting
//               .sort((a, b) => {
//                 try {
//                   if (sortBy === 'orderNumber') {
//                     // Sort by order number
//                     const numA = a?.referenceNumber ? parseInt(a.referenceNumber) : 0;
//                     const numB = b?.referenceNumber ? parseInt(b.referenceNumber) : 0;
//                     return sortOrder === 'asc' ? numA - numB : numB - numA;
//                   } else {
//                     // Sort by creation date
//                     const dateA = a?.createdAt ? new Date(a.createdAt).getTime() : 0;
//                     const dateB = b?.createdAt ? new Date(b.createdAt).getTime() : 0;
//                     return sortOrder === 'asc' ? dateA - dateB : dateB - dateA;
//                   }
//                 } catch (err) {
//                   console.error("Error during sorting:", err);
//                   return 0; // Return 0 on error to keep the original order
//                 }
//               })
//               // Apply pagination
//               .slice((currentPage - 1) * entriesLimit, showAll ? undefined : currentPage * entriesLimit)
//               .map((operation) => (
//                 <TableRow key={operation.id}>
//                   <TableCell>
//                     <Checkbox 
//                       checked={selectedOperationIds.includes(operation.id)}
//                       onCheckedChange={(checked) => {
//                         if (checked) {
//                           setSelectedOperationIds(prev => [...prev, operation.id]);
//                         } else {
//                           setSelectedOperationIds(prev => prev.filter(id => id !== operation.id));
//                         }
//                       }}
//                     />
//                   </TableCell>
//                   <TableCell>
//                     {operation.orderDate ? (
//                       formatDateToDDMMYYYY(new Date(operation.orderDate))
//                     ) : operation.referenceNumber && proformaSlipsData[operation.referenceNumber]?.slip?.orderDate ? (
//                       formatDateToDDMMYYYY(proformaSlipsData[operation.referenceNumber]?.slip?.orderDate)
//                     ) : (
//                       formatDateToDDMMYYYY(operation.createdAt)
//                     )}
//                   </TableCell>
//                   <TableCell>
//                     #{operation.referenceNumber}
//                   </TableCell>
//                   <TableCell>
//                     {operation.partyName || "-"}
//                   </TableCell>
//                   <TableCell>
//                     {operation.plant ? (
//                       <PlantBadge plant={operation.plant} />
//                     ) : "-"}
//                   </TableCell>
//                   <TableCell>
//                     {operation.vehicleNumber || "-"}
//                   </TableCell>
//                   <TableCell>
//                     {operation.totalLoadedQuantity !== undefined && operation.totalLoadedQuantity !== null 
//                       ? operation.totalLoadedQuantity 
//                       : operation.items && operation.items.length > 0 
//                         ? operation.items.reduce((total, item) => 
//                             item.loaded ? total + (Number(item.loadedQuantity) || 0) : total, 0)
//                         : "0"}
//                   </TableCell>
//                   <TableCell>
//                     <Badge variant={getBadgeVariant(operation.status)} className="bg-purple-100 text-purple-800 hover:bg-purple-200">
//                       {operation.status || "Unknown"}
//                     </Badge>
//                   </TableCell>
//                   <TableCell>
//                     {operation.notes ? (
//                       <div className="flex flex-col">
//                         <span className="font-medium">{extractCreatorInfo(operation.notes).name}</span>
//                         <span className="text-xs text-muted-foreground">
//                           {operation.createdAt ? new Date(operation.createdAt).toLocaleDateString('en-IN', {
//                             day: '2-digit',
//                             month: '2-digit',
//                             year: 'numeric',
//                           }) + ' ' + new Date(operation.createdAt).toLocaleTimeString('en-IN', {
//                             hour: '2-digit',
//                             minute: '2-digit',
//                             hour12: false
//                           }) : "N/A"}
//                         </span>
//                       </div>
//                     ) : "Unknown"}
//                   </TableCell>
//                   <TableCell>
//                     <div className="flex space-x-2">
//                       <Dialog
//                         open={editDialogOpenStates[operation.id]}
//                         onOpenChange={(open) => {
//                           // Update the open state for this specific operation
//                           setEditDialogOpenStates(prev => ({
//                             ...prev,
//                             [operation.id]: open
//                           }));
                          
//                           if (open) {
//                             // Initialize or update WebSocket connection when dialog opens (DISABLED)
//                             // WebSocket disabled - no initialization needed
//                             // if (!wsRef.current || wsRef.current.readyState !== WebSocket.OPEN) {
//                             //   initializeWebSocket();
//                             // }
//                           } else {
//                             // Reset filter when dialog is closed
//                             setActiveItemFilter("all");
//                           }
//                         }}
//                       >
//                         <DialogTrigger asChild>
//                           <Button 
//                             id={`edit-operation-${operation.id}`}
//                             variant="ghost" 
//                             size="icon"
//                             className="h-9 w-9 rounded-full bg-blue-50 hover:bg-blue-100"
//                             // Always enabled for viewing, but editing will be controlled inside the form
//                             onClick={async () => {
//                               // Mark the start time to measure performance
//                               const dialogOpenTime = performance.now();
                              
//                               // Store operation ID for debugging and optimization purposes
//                               const gjOperationId = operation.id;
                              
//                               // Set selected operation immediately to start opening the dialog
//                               setSelectedOperation(operation);
//                               setLoadingProformaDetails(true);
                              
//                               console.log(`Starting to open dialog for operation #${gjOperationId} (ref: ${operation.referenceNumber})`);
                              
//                               // Start preloading data in the background right away
//                               // This will populate the cache for faster rendering
//                               if (operation.referenceNumber) {
//                                 preloadProformaData(operation.referenceNumber).catch(err => 
//                                   console.error("Error preloading proforma data:", err)
//                                 );
//                               }
                              
//                               // First check if we already have data cached for this operation
//                               const cachedData = operation.referenceNumber ? 
//                                   getCachedProformaData(operation.referenceNumber) || 
//                                   proformaSlipsData[operation.referenceNumber] : null;
                              
//                               if (cachedData) {
//                                 console.log(`Using cached data for operation #${gjOperationId}, dialog open time: ${Math.round(performance.now() - dialogOpenTime)}ms`);
                                
//                                 // Use cached data to immediately populate the form
//                                 const processedDetails = {
//                                   slip: cachedData.slip,
//                                   items: processProformaItems(cachedData.items) || cachedData.items.map((item: any, idx: number) => ({
//                                     ...item,
//                                     srNo: item.srNo || idx + 1,
//                                     srNoDisplay: item.srNo || idx + 1
//                                   }))
//                                 };
                                
//                                 // Update state immediately from cache
//                                 setViewProformaDetails(processedDetails);
                                
//                                 // Preload product data for items to avoid showing fallback values
//                                 preloadProductData(processedDetails.items)
//                                   .then(() => {
//                                     // After preloading, stop showing the loader
//                                     setLoadingProformaDetails(false);
//                                   })
//                                   .catch(() => {
//                                     // Even if preloading fails, remove the loader
//                                     setLoadingProformaDetails(false);
//                                   });
                                
//                                 // Then refresh in background to ensure latest data
//                                 // OPTIMIZATION: Get the latest load operation items directly first
//                               // This is much faster than fetching the full details
//                               apiRequest('GET', `/api/loading-operations/${operation.id}/items`)
//                                 .then(response => response.json())
//                                 .then(loadItems => {
//                                   if (Array.isArray(loadItems) && loadItems.length > 0) {
//                                     console.log(`Quick refresh with ${loadItems.length} items for operation #${operation.id}`);
                                    
//                                     // Update just the items with the latest data while keeping the rest of the structure
//                                     const normalizedItems = loadItems.map((item: any) => ({
//                                       ...item,
//                                       extraQuantity: item.extraQuantity ?? item.extra_quantity ?? 0,
//                                       originalQuantity: item.originalQuantity ?? item.original_quantity ?? item.quantity ?? 0,
//                                       loadedQuantity: item.loadedQuantity ?? item.loaded_quantity ?? 0,
//                                       loaded: item.loaded === true || item.loaded === 'true',
//                                       srNo: item.srNo || item.sr_no || '',
//                                       srNoDisplay: item.srNoDisplay || item.sr_no_display || item.srNo || item.sr_no || ''
//                                     }));
                                    
//                                     // Only update if the dialog is still open
//                                     if (selectedOperation?.id === operation.id) {
//                                       // Update just the items array with the latest data
//                                       setViewProformaDetails(prevDetails => ({
//                                         ...prevDetails,
//                                         items: normalizedItems
//                                       }));
//                                       console.log(`Quick refresh completed in ${(performance.now() - dialogOpenTime).toFixed(1)}ms`);
//                                     }
//                                   }
//                                 })
//                                 .catch(err => {
//                                   console.error("Error in quick refresh:", err);
//                                 });
                                
//                               // Also fetch the complete details in the background (slower but more complete)
//                               fetchLoadOperationDetails(operation.referenceNumber, operation.id)
//                                 .then(details => {
//                                   if (details) {
//                                     // Update with fresh data
//                                     const refreshedDetails = {
//                                       slip: details.slip,
//                                       items: details.items.map((item: any, idx: number) => ({
//                                         ...item,
//                                         srNo: item.srNo || idx + 1,
//                                         srNoDisplay: item.srNo || idx + 1
//                                       }))
//                                     };
                                    
//                                     // Preload product data for the fresh items too
//                                     preloadProductData(refreshedDetails.items);
                                    
//                                     // Only update if the dialog is still open
//                                     if (selectedOperation?.id === operation.id) {
//                                       setViewProformaDetails(refreshedDetails);
//                                       console.log(`Full refresh completed in ${(performance.now() - dialogOpenTime).toFixed(1)}ms`);
//                                     }
//                                   }
//                                 })
//                                   .catch(error => {
//                                     console.error("Error refreshing operation details:", error);
//                                   });
//                               } else {
//                                 // No cached data, fetch it the normal way
//                                 fetchLoadOperationDetails(operation.referenceNumber, operation.id)
//                                   .then(details => {
//                                     if (details) {
//                                       const processedDetails = {
//                                         slip: details.slip,
//                                         items: details.items.map((item: any, idx: number) => ({
//                                           ...item,
//                                           srNo: item.sr_no || item.srNo,
//                                           itemName: item.item_name || item.itemName,
//                                           sku: item.barcode || item.sku
//                                         }))
//                                       };
                                      
//                                       // Set the details to display the data immediately
//                                       setViewProformaDetails(processedDetails);
                                      
//                                       // Preload product data for each item to ensure proper display
//                                       preloadProductData(processedDetails.items)
//                                         .then(() => {
//                                           // Ensure we update the UI if product data changed
//                                           setViewProformaDetails(currentDetails => {
//                                             if (!currentDetails) return processedDetails;
//                                             return {...currentDetails};
//                                           });
//                                         })
//                                         .catch(err => {
//                                           console.error("Error preloading product data:", err);
//                                         })
//                                         .finally(() => {
//                                           // Regardless of preload success, hide loading indicator
//                                           setLoadingProformaDetails(false);
//                                         });
//                                     } else {
//                                       setLoadingProformaDetails(false);
//                                     }
//                                   })
//                                   .catch(error => {
//                                     console.error("Error fetching operation details:", error);
//                                     toast({
//                                       title: "Error",
//                                       description: "Failed to load proforma slip details",
//                                       variant: "destructive",
//                                     });
//                                     setLoadingProformaDetails(false);
//                                   });
//                               }
//                             }}
//                             title={operation.status === "READY≈DESP" && !userPermissions.canEditReadyDespOperations ? 
//                               "View Load Operation (only admin can edit READY≈DESP status)" : 
//                               "Edit Load Operation"}
//                           >
//                             <FileText className="h-6 w-6 text-[#001d6e]" style={{height: '1.5rem', width: '1.5rem'}} />
//                           </Button>
//                         </DialogTrigger>
//                         <DialogContent className="sm:max-w-[90%] md:max-w-[800px] w-full overflow-y-auto max-h-[95vh] p-2 sm:p-6">
//                           <DialogHeader className="mb-2 sm:mb-4">
//                             <DialogTitle className="text-lg sm:text-xl">Edit Load Operation</DialogTitle>
                            
//                             {/* Display order information in header */}
//                             {viewProformaDetails && (
//                               <div className="border rounded-md p-3 sm:p-4 bg-muted/30 mt-3 sm:mt-4">
//                                 {/* Krupa Marketing Header - show on all devices */}
//                                 <div className="mb-3">
//                                   <KrupaMarketingHeader plant={operation.plant} />
//                                 </div>
//                                 <div className="grid gap-1 sm:gap-2 text-sm sm:text-base">
//                                   <div className="flex justify-between items-center">
//                                     <span className="text-muted-foreground">Order Number:</span>
//                                     <span className="font-medium">#{operation.referenceNumber}</span>
//                                   </div>

//                                   <div className="flex justify-between items-center">
//                                     <span className="text-muted-foreground">Generated:</span>
//                                     <span className="font-medium">
//                                       {operation.createdAt ? new Date(operation.createdAt).toLocaleDateString('en-IN', {
//                                         day: '2-digit',
//                                         month: '2-digit',
//                                         year: 'numeric',
//                                       }) : "N/A"}
//                                     </span>
//                                   </div>
//                                   <div className="flex justify-between items-center">
//                                     <span className="text-muted-foreground">Order Date:</span>
//                                     <span className="font-medium">
//                                       {operation.orderDate ? formatDateToDDMMYYYY(new Date(operation.orderDate)) : "N/A"}
//                                     </span>
//                                   </div>
//                                   <div className="flex justify-between items-center">
//                                     <span className="text-muted-foreground">Party:</span>
//                                     <span className="font-medium max-w-[60%] text-right break-words">{operation.partyName || "N/A"}</span>
//                                   </div>
//                                   <div className="flex justify-between items-center">
//                                     <span className="text-muted-foreground">Vehicle:</span>
//                                     <span className="font-medium">{operation.vehicleNumber || "Not assigned"}</span>
//                                   </div>
//                                   <div className="flex justify-between items-center">
//                                     <span className="text-muted-foreground">Plant:</span>
//                                     <span className="font-medium">
//                                       {operation.plant ? (
//                                         <PlantBadge plant={operation.plant} />
//                                       ) : (
//                                         "N/A"
//                                       )}
//                                     </span>
//                                   </div>
//                                   <div className="flex justify-between items-center">
//                                     <span className="text-muted-foreground">Storekeeper:</span>
//                                     <div className="flex items-center gap-1 sm:gap-2">
//                                       {selectedOperation && (
//                                         <>
//                                           <span className="font-medium text-sm sm:text-base">{extractCreatorInfo(selectedOperation.notes).name}</span>
//                                           <span className="text-[10px] sm:text-xs bg-purple-100 text-purple-800 px-1 sm:px-2 py-0.5 rounded">{extractCreatorInfo(selectedOperation.notes).department}</span>
//                                         </>
//                                       )}
//                                     </div>
//                                   </div>
//                                 </div>
//                               </div>
//                             )}
                            
//                             {/* Volume Information Display */}
//                             {viewProformaDetails && (
//                               <div className="mt-4 mb-2">
//                                 <div className="w-full p-1 border rounded-md bg-[#f0f4ff]">
//                                   {/* Mobile-first layout with reduced height */}
//                                   <div className="grid grid-cols-6 items-center justify-items-center">
//                                     {/* First column: Text above icon for reduced height */}
//                                     <div className="flex flex-col items-center justify-center pl-2 col-span-1">
//                                       <span className="text-xs text-slate-500 mb-1">Volume</span>
//                                       <div className="flex items-center">
//                                         <Calculator className="h-6 w-6 text-[#001d6e]" />
//                                         {isCalculatingVolume ? <Loader2 className="h-4 w-4 ml-1 animate-spin text-[#001d6e]" /> : null}
//                                       </div>
//                                     </div>
                                    
//                                     {/* Second column: Expected volume */}
//                                     <div className="flex flex-col items-center py-1 col-span-2 justify-center pr-0">
//                                       <span className="text-xs text-slate-500">Expected (approx)</span>
//                                       <span className="text-base md:text-base font-semibold text-green-600">
//                                         {originalVolumeCalculation ? originalVolumeCalculation : "Calculating..."}
//                                       </span>
//                                     </div>
                                    
//                                     {/* Separator between Expected and Loaded */}
//                                     <div className="flex items-center justify-center col-span-1 p-0 m-0 -mx-1">
//                                       <span className="text-slate-400 font-medium text-lg">/</span>
//                                     </div>
                                    
//                                     {/* Fourth column: Loaded volume */}
//                                     <div className="flex flex-col items-center py-1 col-span-2 justify-center pl-0">
//                                       <span className="text-xs text-slate-500">Loaded</span>
//                                       <span className="text-base md:text-base font-semibold text-[#001d6e]">
//                                         {totalVolume} cu ft
//                                       </span>
//                                     </div>
//                                   </div>
//                                 </div>
//                               </div>
//                             )}
                            
//                             {/* Total Items Summary - Matching the design in the image */}
//                             {viewProformaDetails && (
//                               <div className="mb-1">
//                                 <div className="grid grid-cols-5 gap-1 rounded-lg p-1">
//                                   {/* Total Items Card */}
//                                   <div 
//                                     className={`flex flex-col items-center justify-center py-2 px-3 rounded-md border shadow-sm cursor-pointer hover:shadow-md transition-all ${activeItemFilter === "all" ? "bg-amber-50 ring-2 ring-amber-500" : "bg-white"}`}
//                                     onClick={() => setActiveItemFilter(activeItemFilter === "all" ? "all" : "all")}
//                                   >
//                                     <div className="text-[10px] text-gray-600 font-medium mb-1">Total Items</div>
//                                     <Layers className="h-8 w-8 text-amber-500 mb-1" />
//                                     <div className="text-lg font-semibold text-gray-800">{viewProformaDetails.items.length}</div>
//                                   </div>
                                  
//                                   {/* Proforma Card */}
//                                   <div 
//                                     className={`flex flex-col items-center justify-center py-2 px-3 rounded-md border shadow-sm cursor-pointer hover:shadow-md transition-all ${activeItemFilter === "proforma" ? "bg-blue-50 ring-2 ring-blue-500" : "bg-white"}`}
//                                     onClick={() => setActiveItemFilter(activeItemFilter === "proforma" ? "all" : "proforma")}
//                                   >
//                                     <div className="text-[10px] text-gray-600 font-medium mb-1">Proforma</div>
//                                     <FileText className="h-6 w-6 text-blue-600 mb-1" />
//                                     <div className="text-lg font-semibold text-gray-800">
//                                       {calculateProformaQuantity(viewProformaDetails.items, viewProformaDetails.slip.orderNumber)}
//                                     </div>
//                                   </div>
                                  
//                                   {/* Loaded Card */}
//                                   <div 
//                                     className={`flex flex-col items-center justify-center py-2 px-3 rounded-md border shadow-sm cursor-pointer hover:shadow-md transition-all ${activeItemFilter === "loaded" ? "bg-green-50 ring-2 ring-green-500" : "bg-white"}`}
//                                     onClick={() => setActiveItemFilter(activeItemFilter === "loaded" ? "all" : "loaded")}
//                                   >
//                                     <div className="text-[10px] text-gray-600 font-medium mb-1">Loaded</div>
//                                     <CheckCircle className="h-8 w-8 text-green-600 mb-1" />
//                                     <div className="text-lg font-semibold text-gray-800">
//                                       {viewProformaDetails.items.reduce((total, item) => item.loaded ? total + (item.loadedQuantity ?? 0) : total, 0) ?? 0}
//                                     </div>
//                                   </div>
                                  
//                                   {/* Remain Card */}
//                                   <div 
//                                     className={`flex flex-col items-center justify-center py-2 px-3 rounded-md border shadow-sm cursor-pointer hover:shadow-md transition-all ${activeItemFilter === "remaining" ? "bg-red-50 ring-2 ring-red-500" : "bg-white"}`}
//                                     onClick={() => setActiveItemFilter(activeItemFilter === "remaining" ? "all" : "remaining")}
//                                   >
//                                     <div className="text-[10px] text-gray-600 font-medium mb-1">Remain</div>
//                                     <AlertCircle className="h-8 w-8 text-red-500 mb-1" />
//                                     <div className="text-lg font-semibold text-gray-800">
//                                       {calculateRemainingQuantity(viewProformaDetails.items, viewProformaDetails.slip.orderNumber)}
//                                     </div>
//                                   </div>
                                  
//                                   {/* Extra Card */}
//                                   <div 
//                                     className={`flex flex-col items-center justify-center py-2 px-3 rounded-md border shadow-sm cursor-pointer hover:shadow-md transition-all ${activeItemFilter === "extra" ? "bg-purple-50 ring-2 ring-purple-500" : "bg-white"}`}
//                                     onClick={() => setActiveItemFilter(activeItemFilter === "extra" ? "all" : "extra")}
//                                   >
//                                     <div className="text-[10px] text-gray-600 font-medium mb-1">Extra</div>
//                                     <PlusCircle className="h-8 w-8 text-purple-600 mb-1" />
//                                     <div className="text-lg font-semibold text-gray-800">
//                                       {calculateExtraQuantity(viewProformaDetails.items, viewProformaDetails.slip.orderNumber)}
//                                     </div>
//                                   </div>
//                                 </div>
//                               </div>
//                             )}
//                           </DialogHeader>
                          
//                           <Tabs 
//                             defaultValue="items" 
//                             className="pt-2"
//                             value={activeTabs[operation.id] || "items"}
//                             onValueChange={(value) => {
//                               // Store the active tab in state for better performance
//                               setActiveTabs(prev => ({
//                                 ...prev,
//                                 [operation.id]: value
//                               }));
//                             }}
//                           >
//                             <TabsList className="grid grid-cols-3 w-full">
//                               <TabsTrigger value="items">Items</TabsTrigger>
//                               <TabsTrigger value="basket">Basket</TabsTrigger>
//                               <TabsTrigger value="status">Status</TabsTrigger>
//                             </TabsList>
                            
//                             {/* Status Tab - Mobile Optimized */}
//                             <TabsContent value="status" className="space-y-5 py-4 px-2">
//                               <div className="bg-white border rounded-lg shadow-sm p-4 space-y-5">
//                                 {/* Status Field */}
//                                 <div className="space-y-2">
//                                   <div className="flex items-center mb-1">
//                                     <FileText className="h-5 w-5 mr-2 text-[#001d6e]" />
//                                     <Label htmlFor="status" className="font-medium text-sm">Delivery Status</Label>
//                                   </div>
//                                   <Select
//                                     defaultValue={operation.status || "LOADING"}
//                                     onValueChange={(value) => {
//                                       // Store the selected value in a data attribute for later use
//                                       const selectElement = document.getElementById(`status-select-${operation.id}`);
//                                       if (selectElement) {
//                                         selectElement.setAttribute("data-selected-value", value);
//                                       }
//                                     }}
//                                   >
//                                     <SelectTrigger id={`status-select-${operation.id}`} className="h-11 text-base">
//                                       <SelectValue placeholder="Select status" />
//                                     </SelectTrigger>
//                                     <SelectContent>
//                                       <SelectItem value="LOADING">LOADING</SelectItem>
//                                       <SelectItem value="READY≈DESP">READY≈DESP</SelectItem>
//                                     </SelectContent>
//                                   </Select>
//                                 </div>

//                                 {/* Vehicle Number Field */}
//                                 <div className="space-y-2">
//                                   <div className="flex items-center mb-1">
//                                     <Truck className="h-4 w-4 mr-2 text-[#001d6e]" />
//                                     <Label htmlFor={`vehicle-number-${operation.id}`} className="font-medium text-sm">Vehicle Number</Label>
//                                   </div>
//                                   <Input
//                                     id={`vehicle-number-${operation.id}`}
//                                     type="text"
//                                     defaultValue={operation.vehicleNumber || ""}
//                                     placeholder="Enter vehicle number"
//                                     className="h-11 text-base"
//                                   />
//                                 </div>

//                                 {/* Driver Name Field */}
//                                 <div className="space-y-2">
//                                   <div className="flex items-center mb-1">
//                                     <User className="h-4 w-4 mr-2 text-[#001d6e]" />
//                                     <Label htmlFor={`driver-name-${operation.id}`} className="font-medium text-sm">Driver Name</Label>
//                                   </div>
//                                   <Input
//                                     id={`driver-name-${operation.id}`}
//                                     type="text"
//                                     defaultValue={operation.driverName || ""}
//                                     placeholder="Enter driver name"
//                                     className="h-11 text-base"
//                                   />
//                                 </div>
                                
//                                 {/* Save Button */}
//                                 <Button 
//                                   className="w-full h-12 flex items-center justify-center gap-2 mt-4 text-base"
//                                   onClick={async () => {
//                                     try {
//                                       // Get the selected status value from the data attribute
//                                       const selectElement = document.getElementById(`status-select-${operation.id}`);
//                                       if (!selectElement) {
//                                         throw new Error("Status select element not found");
//                                       }
                                      
//                                       const statusValue = selectElement.getAttribute("data-selected-value") || operation.status || "LOADING";
                                      
//                                       // Get vehicle number and driver name values
//                                       const vehicleNumberInput = document.getElementById(`vehicle-number-${operation.id}`) as HTMLInputElement;
//                                       const driverNameInput = document.getElementById(`driver-name-${operation.id}`) as HTMLInputElement;
                                      
//                                       const vehicleNumber = vehicleNumberInput?.value || "";
//                                       const driverName = driverNameInput?.value || "";

//                                       // Update local state first for immediate responsive UI
//                                       // This makes the app feel faster to users
//                                       if (viewProformaDetails) {
//                                         setViewProformaDetails({
//                                           ...viewProformaDetails,
//                                           slip: {
//                                             ...viewProformaDetails.slip,
//                                             vehicleNumber,
//                                             driverName
//                                           },
//                                           operation: {
//                                             ...viewProformaDetails.operation,
//                                             status: statusValue
//                                           }
//                                         });
//                                       }
                                      
//                                       // If we have the operations data in cache, update it immediately
//                                       if (data) {
//                                         const updatedOperations = data.map(op => 
//                                           op.id === operation.id 
//                                             ? { 
//                                                 ...op, 
//                                                 status: statusValue,
//                                                 vehicleNumber, 
//                                                 driverName 
//                                               } 
//                                             : op
//                                         );
                                        
//                                         // Update the operations list visually first
//                                         // @ts-ignore - we know this is safe as we're preserving the structure
//                                         queryClient.setQueryData(['/api/loading-operations'], updatedOperations);
//                                       }
                                      
//                                       // Show feedback to the user immediately
//                                       toast({
//                                         title: "Operation updated",
//                                         description: `Operation details have been updated successfully`
//                                       });
                                      
//                                       // Update operation status, vehicle number, and driver name
//                                       await apiRequest('PUT', `/api/loading-operations/${operation.id}`, {
//                                         status: statusValue,
//                                         vehicleNumber,
//                                         driverName
//                                       });
                                      
//                                       // We no longer update proforma slips from loading operations
//                                       // Load operations are independent after initial generation
                                      
//                                       // Broadcast the status change to all clients
//                                       if (broadcastChannelRef.current) {
//                                         // Generate a unique device ID if none exists
//                                         if (!window.deviceId) {
//                                           window.deviceId = `device-${Math.random().toString(36).substring(2, 8)}`;
//                                         }
                                        
//                                         broadcastChannelRef.current.postMessage({
//                                           type: 'OPERATION_STATUS_UPDATED',
//                                           operationId: operation.id,
//                                           data: {
//                                             status: statusValue,
//                                             vehicleNumber,
//                                             driverName
//                                           },
//                                           timestamp: Date.now(),
//                                           sender: window.deviceId
//                                         });
                                        
//                                         console.log(`[BroadcastSent] Operation status updated for #${operation.id}: ${statusValue} at ${new Date().toISOString()}`);
//                                       }
                                      
//                                       // Force immediate data refresh with priority
//                                       Promise.all([
//                                         // First, cancel any in-flight requests to avoid race conditions
//                                         queryClient.cancelQueries({ queryKey: ['/api/loading-operations'] }),
                                        
//                                         // Then, directly invalidate the cache and fetch fresh data
//                                         queryClient.invalidateQueries({ 
//                                           queryKey: ['/api/loading-operations'],
//                                           refetchType: 'active'
//                                         })
//                                       ]).then(() => {
//                                         // After invalidation, force an immediate refetch
//                                         refetchRef.current();
                                        
//                                         // Also force a refetch of any count queries
//                                         queryClient.invalidateQueries({ 
//                                           queryKey: ['/api/loading-operations/status/count'],
//                                           refetchType: 'all'
//                                         });
//                                       });
//                                     } catch (error) {
//                                       console.error("Error updating operation:", error);
//                                       toast({
//                                         title: "Error",
//                                         description: "Failed to update operation details",
//                                         variant: "destructive"
//                                       });
//                                     }
//                                   }}
//                                 >
//                                   <Save className="h-4 w-4" />
//                                   Save Changes
//                                 </Button>
//                               </div>
//                             </TabsContent>
                            
//                             {/* Basket Tab - Shows items with quantity less than 15 */}
//                             <TabsContent value="basket" className="space-y-3 py-3">
//                               {operation.referenceNumber && (
//                                 <div className="space-y-4">
                                  
//                                   <div className="bg-yellow-50 rounded-lg border border-yellow-200 p-3 mb-2">
//                                     <div className="flex items-center">
//                                       <span className="text-sm text-yellow-700 font-medium">Items with quantity less than 15</span>
//                                     </div>
//                                   </div>

//                                   {viewProformaDetails ? (
//                                     <div className="bg-white border rounded-lg shadow-sm">
//                                       <div className="overflow-x-auto">
//                                         {/* Desktop Table View - Hidden on Small Screens */}
//                                         <table className="w-full text-sm hidden md:table">
//                                           <thead>
//                                             <tr className="bg-muted/50 border-b">
//                                               <th className="px-3 py-2 text-left font-medium text-muted-foreground" style={{minWidth: '60px'}}>Sr.No</th>
//                                               <th className="px-3 py-2 text-left font-medium text-muted-foreground" style={{minWidth: '200px'}}>Item</th>
//                                               <th className="px-3 py-2 text-left font-medium text-muted-foreground" style={{width: '90px'}}>Quantity</th>
//                                               <th className="px-3 py-2 text-center font-medium text-muted-foreground" style={{width: '80px'}}>Loaded</th>
//                                             </tr>
//                                           </thead>
//                                           <tbody>
//                                             {viewProformaDetails.items
//                                               .filter(item => {
//                                                 // Filter items with quantity less than 15
//                                                 const qty = item.quantity || 0;
//                                                 return qty < 15 && qty > 0;
//                                               })
//                                               .map((item, idx) => (
//                                               <tr 
//                                                 key={`basket-item-${item.id}-${idx}`} 
//                                                 data-item-id={`basket-${item.id}`} 
//                                                 className={`border-b ${item.loaded ? 'bg-green-50' : ''}`}>
//                                                 <td className="px-3 py-3 align-middle text-xs">
//                                                   {getSrNoDisplay(item)}
//                                                 </td>
//                                                 <td className="px-3 py-3 align-middle">
//                                                   <div className="flex flex-col">
//                                                     <span className="font-medium text-gray-800">{getItemName(item)}</span>
//                                                     <span className="text-xs text-gray-500">{getBarcode(item)}</span>
//                                                   </div>
//                                                 </td>
//                                                 <td className="px-3 py-3 align-middle">
//                                                   <Badge variant={item.quantity && item.quantity < 5 ? "destructive" : "outline"} className="flex items-center justify-center">
//                                                     {item.quantity || 0}
//                                                   </Badge>
//                                                 </td>
//                                                 <td className="px-3 py-3 align-middle text-center">
//                                                   <div className="flex items-center justify-center">
//                                                     <div className="flex items-center space-x-2 p-1 border rounded-md bg-muted/50">
//                                                       <BasketCheckbox 
//                                                         id={`basket-confirm-loaded-${item.id}`}
//                                                         checked={item.loaded || false}
//                                                         className="h-5 w-5" 
//                                                         onCheckedChange={(isChecked) => {
//                                                           // Handle the "indeterminate" state by treating it as false
//                                                           const checked = isChecked === true;
                                                          
//                                                           // Use our universal handler for consistent behavior
//                                                           handleUpdateItemLoadedStatus(item, operation, checked);
//                                                         }}
//                                                       />
//                                                     </div>
//                                                   </div>
//                                                 </td>
//                                               </tr>
//                                             ))}
                                            
//                                             {/* Show message if no items with qty < 15 */}
//                                             {viewProformaDetails.items.filter(item => {
//                                               const qty = item.quantity || 0;
//                                               return qty < 15 && qty > 0;
//                                             }).length === 0 && (
//                                               <tr>
//                                                 <td colSpan={4} className="px-3 py-4 text-center text-muted-foreground">
//                                                   No items with quantity less than 15
//                                                 </td>
//                                               </tr>
//                                             )}
//                                           </tbody>
//                                         </table>
                                        
//                                         {/* Mobile Card View - Shown only on Small Screens */}
//                                         <div className="md:hidden">
//                                           {viewProformaDetails.items
//                                             .filter(item => {
//                                               // Filter items with quantity less than 15
//                                               const qty = item.quantity || 0;
//                                               return qty < 15 && qty > 0;
//                                             })
//                                             .map((item, idx) => (
//                                               <div 
//                                                 key={`basket-item-mobile-${item.id}-${idx}`}
//                                                 data-item-id={`basket-mobile-${item.id}`}
//                                                 className={`border-b p-3 ${item.loaded ? 'bg-green-50' : ''}`}>
//                                                 <div className="flex justify-between items-start mb-2">
//                                                   <div className="flex flex-col">
//                                                     <span className="font-medium text-gray-800">{getItemName(item)}</span>
//                                                     <span className="text-xs text-gray-500">{getBarcode(item)}</span>
//                                                   </div>
//                                                   <Badge variant={item.quantity && item.quantity < 5 ? "destructive" : "outline"} className="flex items-center justify-center">
//                                                     {item.quantity || 0}
//                                                   </Badge>
//                                                 </div>
//                                                 <div className="flex justify-between items-center mt-2">
//                                                   <span className="text-xs text-gray-500">Sr.No: {getSrNoDisplay(item)}</span>
//                                                   <div className="flex items-center">
//                                                     <span className="text-xs text-gray-500 mr-2">Loaded:</span>
//                                                     <div className="flex items-center space-x-2 p-1 border rounded-md bg-muted/50">
//                                                       <BasketCheckbox 
//                                                         id={`basket-mobile-confirm-loaded-${item.id}`}
//                                                         checked={item.loaded || false}
//                                                         className="h-5 w-5" 
//                                                         onCheckedChange={(isChecked) => {
//                                                           // Handle the "indeterminate" state by treating it as false
//                                                           const checked = isChecked === true;
                                                          
//                                                           // Use our universal handler for consistent behavior
//                                                           handleUpdateItemLoadedStatus(item, operation, checked);
//                                                         }}
//                                                       />
//                                                     </div>
//                                                   </div>
//                                                 </div>
//                                               </div>
//                                             ))}
                                            
//                                           {/* Show message if no items with qty < 15 - Mobile View */}
//                                           {viewProformaDetails.items.filter(item => {
//                                             const qty = item.loadedQuantity || 0;
//                                             return qty < 15 && qty > 0;
//                                           }).length === 0 && (
//                                             <div className="px-3 py-4 text-center text-muted-foreground">
//                                               No items with quantity less than 15
//                                             </div>
//                                           )}
//                                         </div>
//                                       </div>
//                                     </div>
//                                   ) : (
//                                     <div className="flex items-center justify-center p-6">
//                                       <Loader2 className="h-6 w-6 animate-spin text-primary" />
//                                     </div>
//                                   )}
//                                 </div>
//                               )}
//                             </TabsContent>
                            
//                             {/* Items Tab */}
//                             <TabsContent value="items" className="space-y-3 py-3">
//                               {operation.referenceNumber && (
//                                 <div className="space-y-4">

                                  
//                                   <div className="flex flex-col sm:flex-row justify-between items-center gap-2">

//                                     <div className="flex items-center gap-2 w-full sm:w-auto">
//                                       <div className="relative flex-1">
//                                         <Search className="absolute left-2 top-2.5 h-4 w-4 text-muted-foreground" />
//                                         <Input
//                                           id={`item-search-${operation.id}`}
//                                           placeholder="Search items..."
//                                           className="pl-8 h-9"
//                                           onChange={(e) => {
//                                             const query = e.target.value.trim();
//                                             const categoryFilter = sessionStorage.getItem(`category-filter-${operation.id}`) || null;
                                            
//                                             // Filter the items in the proforma slip
//                                             if (viewProformaDetails && viewProformaDetails.items) {
//                                               const items = viewProformaDetails.items;
//                                               const filteredItems = items.filter(item => 
//                                                 (item.item_name && item.item_name.toLowerCase().includes(query.toLowerCase())) || 
//                                                 (item.itemName && item.itemName.toLowerCase().includes(query.toLowerCase())) || 
//                                                 (item.barcode && item.barcode.toLowerCase().includes(query.toLowerCase())) ||
//                                                 (item.sku && item.sku.toLowerCase().includes(query.toLowerCase())) ||
//                                                 (item.sr_no !== undefined && item.sr_no !== null && item.sr_no.toString().includes(query.toLowerCase())) ||
//                                                 (item.srNo !== undefined && item.srNo !== null && item.srNo.toString().includes(query.toLowerCase()))
//                                               );
                                              
//                                               // If there are search matches, reorder the items in the view to bring matches to top
//                                               if (query !== '' && filteredItems.length > 0) {
//                                                 // First, separate matching items into loaded and unloaded
//                                                 const matchingLoaded = filteredItems.filter(item => item.loaded);
//                                                 const matchingUnloaded = filteredItems.filter(item => !item.loaded);
                                                
//                                                 // Then get all other items that don't match (also separate as loaded and unloaded)
//                                                 const nonMatchingItems = items.filter(item => !filteredItems.some(match => match.id === item.id));
//                                                 const nonMatchingLoaded = nonMatchingItems.filter(item => item.loaded);
//                                                 const nonMatchingUnloaded = nonMatchingItems.filter(item => !item.loaded);
                                                
//                                                 // Create a reordered array with:
//                                                 // 1. Matching unloaded items at the top
//                                                 // 2. Non-matching unloaded items in the middle
//                                                 // 3. All loaded items at the bottom (matching first, then non-matching)
//                                                 const reorderedItems = [
//                                                   ...matchingUnloaded,
//                                                   ...nonMatchingUnloaded,
//                                                   ...matchingLoaded,
//                                                   ...nonMatchingLoaded
//                                                 ];
                                                
//                                                 // Update the viewProformaDetails with the reordered items
//                                                 setViewProformaDetails({
//                                                   ...viewProformaDetails,
//                                                   items: reorderedItems
//                                                 });
//                                               } else if (query === '') {
//                                                 // If query is cleared, organize items as follows:
//                                                 // 1. Regular unloaded items (with originalQuantity > 0) at top
//                                                 // 2. Regular loaded items in middle
//                                                 // 3. Newly added items (originalQuantity == 0) at bottom
                                                
//                                                 // Get reference number for checking newly added items
//                                                 const refNumber = operation?.referenceNumber || "";
                                                
//                                                 // Import the utility to check for newly added items
//                                                 const newlyAddedItemIds = getNewlyAddedItems(refNumber);
//                                                 console.log(`Newly added items for ${refNumber}:`, newlyAddedItemIds);
                                                
//                                                 // Split items into three groups
//                                                 const regularUnloadedItems = [...items].filter(item => 
//                                                   !item.loaded && 
//                                                   (item.originalQuantity > 0) && 
//                                                   !newlyAddedItemIds.includes(item.id)
//                                                 );
                                                
//                                                 const regularLoadedItems = [...items].filter(item => 
//                                                   item.loaded && 
//                                                   !newlyAddedItemIds.includes(item.id)
//                                                 );
                                                
//                                                 const newlyAddedItems = [...items].filter(item =>
//                                                   newlyAddedItemIds.includes(item.id) || 
//                                                   item.originalQuantity === 0
//                                                 );
                                                
//                                                 // Sort each group by SR.No
//                                                 const sortBySrNo = (a: any, b: any) => {
//                                                   const srNoA = (a.sr_no !== undefined && a.sr_no !== null) 
//                                                     ? Number(a.sr_no) 
//                                                     : (a.srNo !== undefined && a.srNo !== null) 
//                                                       ? Number(a.srNo) 
//                                                       : 9999;
                                                  
//                                                   const srNoB = (b.sr_no !== undefined && b.sr_no !== null) 
//                                                     ? Number(b.sr_no) 
//                                                     : (b.srNo !== undefined && b.srNo !== null) 
//                                                       ? Number(b.srNo) 
//                                                       : 9999;
                                                  
//                                                   return srNoA - srNoB;
//                                                 };
                                                
//                                                 const sortedRegularUnloaded = regularUnloadedItems.sort(sortBySrNo);
//                                                 const sortedRegularLoaded = regularLoadedItems.sort(sortBySrNo);
//                                                 const sortedNewlyAdded = newlyAddedItems.sort(sortBySrNo);
                                                
//                                                 // Update with sorted items in the desired order
//                                                 setViewProformaDetails({
//                                                   ...viewProformaDetails,
//                                                   items: [...sortedRegularUnloaded, ...sortedRegularLoaded, ...sortedNewlyAdded]
//                                                 });
//                                               }
                                              
//                                               // Highlight matching items in the table
//                                               const tableRows = document.querySelectorAll(`[data-item-id]`);
//                                               tableRows.forEach(row => {
//                                                 if (query === '') {
//                                                   row.classList.remove('bg-yellow-50');
//                                                 } else {
//                                                   const itemId = row.getAttribute('data-item-id');
//                                                   const matchingItem = filteredItems.find(item => item.id.toString() === itemId);
//                                                   if (matchingItem) {
//                                                     row.classList.add('bg-yellow-50');
//                                                   } else {
//                                                     row.classList.remove('bg-yellow-50');
//                                                   }
//                                                 }
//                                               });
//                                             }
//                                           }}
//                                         />
//                                       </div>
//                                       <Button 
//                                         size="sm" 
//                                         variant="outline" 
//                                         onClick={() => {
//                                           // Add item search functionality
//                                           const showAddItemsEl = document.getElementById(`show-add-items-${operation.id}`);
//                                           if (showAddItemsEl) {
//                                             showAddItemsEl.classList.toggle('hidden');
//                                           }
//                                         }}
//                                         className="space-x-1"
//                                       >
//                                         <PlusCircle className="h-4 w-4" />
//                                         <span>Add Items</span>
//                                       </Button>
//                                     </div>
//                                   </div>
                                  
//                                   <div id={`show-add-items-${operation.id}`} className="border rounded-md p-4 space-y-4 hidden">
//                                     <div className="space-y-3">
//                                       <div className="flex justify-between items-center">
//                                         <Label>Search Items to Add</Label>
//                                       </div>
                                      
//                                       <div className="flex flex-col sm:flex-row gap-2">
//                                         {/* Add search input field for items */}
//                                         <div className="relative flex-1">
//                                           <Search className="absolute left-2 top-2.5 h-4 w-4 text-muted-foreground" />
//                                           <Input
//                                             id={`add-item-search-${operation.id}`}
//                                             placeholder="Search by item name or SKU..."
//                                             className="pl-8 h-10"
//                                             onChange={(e) => {
//                                               const query = e.target.value.trim();
//                                               // Get the category filter from session storage
//                                               const categoryFilter = sessionStorage.getItem(`category-filter-${operation.id}`) || null;
                                              
//                                               // Perform the search with the query and category filter
//                                               performSearch(operation.id, query, categoryFilter, operation.referenceNumber?.toString());
                                              
//                                               // Make sure search results are visible
//                                               const searchResultsEl = document.getElementById(`search-results-${operation.id}`);
//                                               if (searchResultsEl) {
//                                                 searchResultsEl.classList.remove('hidden');
//                                               }
//                                             }}
//                                           />
//                                         </div>
                                        
//                                         <div className="w-full sm:w-1/3">
//                                           <Select
//                                             onValueChange={(value) => {
//                                               if (value === "all") {
//                                                 // Clear category filter
//                                                 sessionStorage.removeItem(`category-filter-${operation.id}`);
//                                               } else {
//                                                 // Store category filter
//                                                 sessionStorage.setItem(`category-filter-${operation.id}`, value);
//                                               }
                                              
//                                               const categoryFilter = value === "all" ? null : value;
                                              
//                                               // Get the current search query
//                                               const searchInput = document.getElementById(`add-item-search-${operation.id}`) as HTMLInputElement;
//                                               const query = searchInput ? searchInput.value.trim() : "";
                                              
//                                               // Perform search with category filter and current query
//                                               performSearch(operation.id, query, categoryFilter, operation.referenceNumber?.toString());
                                              
//                                               // Make sure search results are visible
//                                               const searchResultsEl = document.getElementById(`search-results-${operation.id}`);
//                                               if (searchResultsEl) {
//                                                 searchResultsEl.classList.remove('hidden');
//                                               }
//                                             }}
//                                             defaultValue="all"
//                                           >
//                                             <SelectTrigger className="h-10">
//                                               <SelectValue placeholder="Select a Category" />
//                                             </SelectTrigger>
//                                             <SelectContent>
//                                               <SelectItem value="all">All Categories</SelectItem>
//                                               {uniqueCategories.map((category) => (
//                                                 <SelectItem key={category} value={category}>{category}</SelectItem>
//                                               ))}
//                                             </SelectContent>
//                                           </Select>
//                                         </div>
//                                       </div>
//                                     </div>
                                    
//                                     <div id={`search-results-${operation.id}`} className="border rounded-md mt-3 max-h-[300px] overflow-y-auto hidden">
//                                       {/* Search results will be populated here */}
//                                     </div>
//                                   </div>
                                  


                                  
//                                   <div className="border rounded-md">
//                                     <h4 className="text-sm font-medium p-3 border-b bg-muted/30">
//                                       Items in Proforma Slip ({viewProformaDetails?.items ? filterItemsByType(viewProformaDetails.items, activeItemFilter, viewProformaDetails?.slip?.orderNumber || "").length : 0} / {viewProformaDetails?.items?.length || 0})
//                                     </h4>
//                                     <div className="max-h-[60vh] md:max-h-[40vh] overflow-y-auto">
//                                       {/* Mobile view - Card layout */}
//                                       <div className="md:hidden" ref={(el) => mobileItems = el}>
//                                         {viewProformaDetails?.items && viewProformaDetails.items.length > 0 ? (
//                                           <div className="divide-y">
//                                             {filterItemsByType(viewProformaDetails.items, activeItemFilter, viewProformaDetails?.slip?.orderNumber || "").map((item: ProformaSlipItem, idx) => {
//                                               // Get reference number from operation
//                                               const referenceNumber = operation.referenceNumber || "";
//                                               const newItemsKey = `proforma-new-items-${referenceNumber.trim()}`;
                                              
//                                               // Get newly added items list
//                                               let newlyAddedItems: number[] = [];
//                                               try {
//                                                 const storedNewItems = localStorage.getItem(newItemsKey);
//                                                 if (storedNewItems) {
//                                                   newlyAddedItems = JSON.parse(storedNewItems);
//                                                 }
//                                               } catch (err) {
//                                                 console.error("Error loading newly added items list:", err);
//                                               }
                                              
//                                               // Check if this is a newly added item
//                                               const isNewlyAdded = item.id !== null && 
//                                                 item.id !== undefined && 
//                                                 newlyAddedItems.includes(item.id);
                                              
//                                               // For newly added items, originalQuantity should be 0
//                                               const originalQty = isNewlyAdded ? 0 : item.originalQuantity;
                                              
//                                               // Calculate extra quantity
//                                               const extraQty = isNewlyAdded 
//                                                 ? (item.quantity ?? 0) 
//                                                 : Math.max(0, (item.quantity ?? 0) - (originalQty ?? 0));
                                              
//                                               // Calculate remain quantity
//                                               const remainQty = Math.max(0, (originalQty ?? 0) - (item.loaded ? (item.loadedQuantity ?? item.quantity ?? 0) : 0));
                                              
//                                               return (
//                                                 <div key={item.id} data-item-id={item.id} className={`p-3 space-y-2 ${item.loaded ? 'bg-green-50' : ''} border-b last:border-b-0`}>
//                                                   {/* Item name and delete button */}
//                                                   <div className="flex items-start justify-between">
//                                                     <div>
//                                                       <div className="text-xs text-gray-500 mb-1 flex">
//                                                         <span>{getBarcode(item)}</span>
//                                                         <span className="mx-1">•</span>
//                                                         <span>{getSrNo(item, idx + 1)}</span>
//                                                       </div>
//                                                       <div className="font-medium text-sm whitespace-normal overflow-hidden text-ellipsis max-w-[95%]" title={getItemName(item)}>{getItemName(item)}</div>
//                                                     </div>
                                                    
//                                                     {/* Delete button moved here from bottom row */}
//                                                     <Button 
//                                                       size="sm"
//                                                       variant="ghost"
//                                                       onClick={() => {
//                                                         if (operation.referenceNumber) {
//                                                           deleteItem(item.id, operation.id, operation.referenceNumber);
//                                                         }
//                                                       }}
//                                                       className="h-8 w-8 p-0"
//                                                       title="Remove item"
//                                                     >
//                                                       <Trash className="h-5 w-5 text-red-500" />
//                                                     </Button>
//                                                   </div>
                                                  
//                                                   {/* Quantity indicators and quantity controls - Vertical layout with controls next to indicators */}
//                                                   {item.originalQuantity !== undefined && (
//                                                     <div className="flex justify-between mt-2 pl-1">
//                                                       <div className="flex gap-6">
//                                                         <div className="flex flex-col items-center">
//                                                           <FileText className="h-4 w-4 text-blue-600 mb-1" />
//                                                           <span className="text-sm font-medium">{originalQty ?? 0}</span>
//                                                         </div>
//                                                         <div className="flex flex-col items-center">
//                                                           <CheckCircle className="h-4 w-4 text-green-600 mb-1" />
//                                                           <span className="text-sm font-medium">{item.loaded ? (item.loadedQuantity ?? item.quantity ?? 0) : 0}</span>
//                                                         </div>
//                                                         <div className="flex flex-col items-center">
//                                                           <AlertCircle className="h-4 w-4 text-red-500 mb-1" />
//                                                           <span className="text-sm font-medium">{remainQty}</span>
//                                                         </div>
//                                                         <div className="flex flex-col items-center">
//                                                           <PlusCircle className="h-4 w-4 text-purple-600 mb-1" />
//                                                           <span className="text-sm font-medium">{extraQty}</span>
//                                                         </div>
//                                                       </div>
                                                      
//                                                       {/* Quantity controls moved beside the indicators */}
//                                                       <div className="flex items-center">
//                                                         {/* Conditional rendering: Either show Load Item button (not loaded) or value capsule (loaded) */}
//                                                         {item.loaded ? (
//                                                           /* Show value capsule container with tick icon when loaded */
//                                                           <div className="flex items-center border rounded-full overflow-hidden border-green-500 transition-all duration-300 ease-in-out">
//                                                             <div 
//                                                               className="px-2 cursor-pointer"
//                                                               onClick={() => {
//                                                                 // Show confirmation dialog before unloading
//                                                                 const itemName = getItemName(item);
//                                                                 const confirmUnload = window.confirm(`Unload this item: "${itemName}"?`);
                                                                
//                                                                 if (confirmUnload && viewProformaDetails?.items) {
//                                                                   // Set loaded to false, reset loadedQuantity to original quantity, and extraQuantity to 0
//                                                                   const updatedItem: ProformaSlipItem = { 
//                                                                     ...item, 
//                                                                     loaded: false,
//                                                                     loadedQuantity: item.originalQuantity || item.quantity,
//                                                                     quantity: item.originalQuantity || item.quantity,
//                                                                     extraQuantity: 0
//                                                                   };
                                                                  
//                                                                   const updatedItems = viewProformaDetails.items.map(i => 
//                                                                     i.id === item.id ? updatedItem : i
//                                                                   );
                                                                  
//                                                                   // Keep original item order - don't sort by loaded status
//                                                                   setViewProformaDetails({
//                                                                     ...viewProformaDetails,
//                                                                     items: updatedItems
//                                                                   });
                                                                  
//                                                                   // Save to server
//                                                                   apiRequest('PATCH', `/api/loading-operation-items/${item.id}`, {
//                                                                     loaded: false,
//                                                                     loadedQuantity: item.originalQuantity || item.quantity,
//                                                                     quantity: item.originalQuantity || item.quantity,
//                                                                     extraQuantity: 0,
//                                                                     loadOperationId: operation.id
//                                                                   })
//                                                                   .then(() => {
//                                                                     console.log('Item unloaded successfully');
                                                                    
//                                                                     // Animation and UI update
//                                                                     const card = document.querySelector(`[data-item-id="${item.id}"]`);
//                                                                     if (card) {
//                                                                       card.classList.add('animate-pulse');
//                                                                       setTimeout(() => {
//                                                                         card.classList.remove('animate-pulse');
//                                                                         card.classList.remove('bg-green-50');
//                                                                       }, 300);
//                                                                     }
//                                                                   })
//                                                                   .catch(error => {
//                                                                     console.error('Error unloading item:', error);
//                                                                     toast({
//                                                                       title: "Failed to unload item",
//                                                                       description: "Please try again",
//                                                                       variant: "destructive"
//                                                                     });
//                                                                   });
//                                                                 }
//                                                               }}
//                                                               title="Click to unload item"
//                                                             >
//                                                               <CheckCircle className="h-5 w-5 text-green-500 hover:text-red-500 transition-colors" />
//                                                             </div>
                                                            
//                                                             <Button
//                                                               size="icon"
//                                                               variant="ghost"
//                                                               className="h-9 w-9 rounded-l-full"
//                                                               onClick={() => {
//                                                                 // Always use loadedQuantity when item is loaded
//                                                                 const currentQuantity = item.loadedQuantity ?? item.quantity ?? 1;
//                                                                 updateItemQuantity(item.id, Math.max(1, currentQuantity - 1), operation.id);
//                                                               }}
//                                                               disabled={(item.loadedQuantity ?? item.quantity ?? 0) <= 1}
//                                                               title="Decrease quantity"
//                                                             >
//                                                               <MinusCircle className="h-5 w-5" />
//                                                             </Button>
                                                            
//                                                             <Input
//                                                               type="number"
//                                                               min="1"
//                                                               id={`item-quantity-mobile-${item.id}`}
//                                                               className="w-16 h-9 text-center text-base font-medium border-0 focus:ring-0 p-0"
//                                                               value={item.loadedQuantity ?? item.quantity ?? 1}
//                                                               onChange={(e) => {
//                                                                 updateItemQuantity(item.id, parseInt(e.target.value) || 1, operation.id);
//                                                               }}
//                                                             />
                                                            
//                                                             <Button
//                                                               size="icon"
//                                                               variant="ghost"
//                                                               className="h-9 w-9"
//                                                               onClick={() => {
//                                                                 const currentQty = item.loadedQuantity ?? item.quantity ?? 1;
//                                                                 updateItemQuantity(item.id, currentQty + 1, operation.id);
//                                                               }}
//                                                               title="Increase quantity"
//                                                             >
//                                                               <PlusCircle className="h-5 w-5" />
//                                                             </Button>
//                                                           </div>
//                                                         ) : (
//                                                           /* Show Load Item button if not loaded */
//                                                           <div className="flex items-center space-x-2 border rounded-full overflow-hidden border-gray-300 transition-all duration-300 ease-in-out">
//                                                             <Button
//                                                               variant="ghost"
//                                                               className="h-9 px-3 text-base font-medium"
//                                                               onClick={() => {
//                                                                 // Directly call the handler without trying to find a checkbox element
//                                                                 const isChecked = true;
                                                                
//                                                                 // Update UI element background with animation
//                                                                 const card = document.querySelector(`[data-item-id="${item.id}"]`);
//                                                                 if (card) {
//                                                                   card.classList.add('animate-pulse');
//                                                                   setTimeout(() => {
//                                                                     card.classList.remove('animate-pulse');
//                                                                     card.classList.add('bg-green-50');
//                                                                   }, 300);
//                                                                 }
                                                                
//                                                                 // Update local state immediately
//                                                                 if (viewProformaDetails?.items) {
//                                                                   // When marking as loaded, also set loadedQuantity to match quantity
//                                                                   const updatedItem: ProformaSlipItem = { 
//                                                                     ...item, 
//                                                                     loaded: isChecked,
//                                                                     loadedQuantity: item.quantity || 0
//                                                                   };
                                                                  
//                                                                   const updatedItems = viewProformaDetails.items.map(i => 
//                                                                     i.id === item.id ? updatedItem : i
//                                                                   );
                                                                  
//                                                                   console.log('Updating item to loaded status with quantity:', updatedItem.loadedQuantity);
                                                                  
//                                                                   // Keep original item order - don't sort by loaded status
//                                                                   setViewProformaDetails({
//                                                                     ...viewProformaDetails,
//                                                                     items: updatedItems
//                                                                   });
//                                                                 }

//                                                                 // CRITICAL FIX: Update the cache immediately to prevent polling from resetting the UI
//                                                                 // This ensures that when the background polling happens, it sees the updated state
//                                                                 if (operation) {
//                                                                   cacheUpdateItemLoadedStatus(operation, item.id, isChecked);
//                                                                 }
                                                                
//                                                                 // Also save changes to server
//                                                                 apiRequest('PATCH', `/api/loading-operation-items/${item.id}`, {
//                                                                   loaded: isChecked,
//                                                                   loadedQuantity: item.quantity || 0,
//                                                                   loadOperationId: operation.id
//                                                                 })
//                                                                 .then(() => {
//                                                                   console.log('Server updated successfully');
//                                                                   // Force entire component to re-render to ensure capsule appears
//                                                                   setForceUpdateCounter(prev => prev + 1);
//                                                                 })
//                                                                 .catch(err => {
//                                                                   console.error('Failed to update item:', err);
//                                                                 });
//                                                               }}
//                                                             >
//                                                               <span className="flex items-center">
//                                                                 <span className="mr-2">Load Item</span>
//                                                                 <Plus className="h-5 w-5" />
//                                                               </span>
//                                                             </Button>
//                                                           </div>
//                                                         )}
//                                                       </div>
//                                                     </div>
//                                                   )}
                                                  
//                                                   {/* No bottom row or status message - removed as requested */}
//                                                 </div>
//                                               );
//                                             })}
//                                           </div>
//                                         ) : (
//                                           <div className="text-center py-4 text-muted-foreground text-sm">
//                                             {activeItemFilter !== "all" ? `No items matching the "${activeItemFilter}" filter` : "No items found"}
//                                           </div>
//                                         )}
//                                       </div>
                                      
//                                       {/* Desktop view - Table layout */}
//                                       <div className="hidden md:block">
//                                         <Table id={`items-table-${operation.id}`} ref={(el) => table = el}>
//                                           <TableHeader>
//                                             <TableRow>
//                                               <TableHead className="w-16">Sr. No.</TableHead>
//                                               <TableHead>Name</TableHead>
//                                               <TableHead className="w-[140px]">Quantity</TableHead>
//                                               <TableHead className="w-20">Actions</TableHead>
//                                             </TableRow>
//                                           </TableHeader>
//                                           <TableBody>
//                                             {viewProformaDetails?.items && viewProformaDetails.items.length > 0 ? (
//                                               filterItemsByType(viewProformaDetails.items, activeItemFilter, viewProformaDetails?.slip?.orderNumber || "").map((item: ProformaSlipItem, idx) => (
//                                                 <TableRow key={item.id} data-item-id={item.id} className={item.loaded ? 'bg-highlight-green-50' : ''}>
//                                                   <TableCell>{getSrNo(item, idx + 1)}</TableCell>
//                                                   <TableCell className="max-w-[200px] break-words whitespace-normal">
//                                                     <div>
//                                                       {getItemName(item)}
//                                                       <div className="text-xs mt-2 flex flex-wrap gap-4">
//                                                         <div className="flex flex-col items-center">
//                                                           <FileText className="h-4 w-4 text-blue-600 mb-1" />
//                                                           <div className="font-medium">{item.originalQuantity ?? item.quantity ?? 0}</div>
//                                                         </div>
//                                                         <div className="flex flex-col items-center">
//                                                           <CheckCircle className="h-4 w-4 text-green-600 mb-1" />
//                                                           <div className="font-medium">{item.loaded ? (item.loadedQuantity ?? item.quantity ?? 0) : 0}</div>
//                                                         </div>
//                                                         <div className="flex flex-col items-center">
//                                                           <AlertCircle className="h-4 w-4 text-red-500 mb-1" />
//                                                           <div className="font-medium">{calculateItemRemainingQuantity(item, viewProformaDetails.slip.orderNumber)}</div>
//                                                         </div>
//                                                         <div className="flex flex-col items-center">
//                                                           <PlusCircle className="h-4 w-4 text-purple-600 mb-1" />
//                                                           <div className="font-medium">
//                                                             {calculateItemExtraQuantity(item, operation.referenceNumber)}
//                                                           </div>
//                                                         </div>
//                                                       </div>
//                                                       <div className="text-xs text-muted-foreground mt-1">
//                                                         SKU: {getBarcode(item)}
//                                                       </div>
//                                                     </div>
//                                                   </TableCell>
//                                                   <TableCell>
//                                                     <div className="flex items-center space-x-2">
//                                                       {/* Conditional rendering for quantity control: Only show when item is loaded */}
//                                                       {item.loaded ? (
//                                                         /* Show value capsule container with tick icon when loaded - matching mobile view */
//                                                         <div className="flex items-center border rounded-full overflow-hidden border-green-500 transition-all duration-300 ease-in-out">
//                                                           <div 
//                                                             className="px-2 cursor-pointer"
//                                                             onClick={() => {
//                                                               // Show confirmation dialog before unloading
//                                                               const itemName = getItemName(item);
//                                                               const confirmUnload = window.confirm(`Unload this item: "${itemName}"?`);
                                                              
//                                                               if (confirmUnload && viewProformaDetails?.items) {
//                                                                 // Set loaded to false, reset loadedQuantity to original quantity, and extraQuantity to 0
//                                                                 const updatedItem: ProformaSlipItem = { 
//                                                                   ...item, 
//                                                                   loaded: false,
//                                                                   loadedQuantity: item.originalQuantity || item.quantity,
//                                                                   quantity: item.originalQuantity || item.quantity,
//                                                                   extraQuantity: 0
//                                                                 };
                                                                
//                                                                 const updatedItems = viewProformaDetails.items.map(i => 
//                                                                   i.id === item.id ? updatedItem : i
//                                                                 );
                                                                
//                                                                 // Keep original item order - don't sort by loaded status
//                                                                 setViewProformaDetails({
//                                                                   ...viewProformaDetails,
//                                                                   items: updatedItems
//                                                                 });
                                                                
//                                                                 // Save to server
//                                                                 apiRequest('PATCH', `/api/loading-operation-items/${item.id}`, {
//                                                                   loaded: false,
//                                                                   loadedQuantity: item.originalQuantity || item.quantity,
//                                                                   quantity: item.originalQuantity || item.quantity,
//                                                                   extraQuantity: 0,
//                                                                   loadOperationId: operation.id
//                                                                 })
//                                                                 .then(() => {
//                                                                   console.log('Item unloaded successfully');
                                                                  
//                                                                   // Animation and UI update
//                                                                   const row = document.querySelector(`tr[data-item-id="${item.id}"]`);
//                                                                   if (row) {
//                                                                     row.classList.add('animate-pulse');
//                                                                     setTimeout(() => {
//                                                                       row.classList.remove('animate-pulse');
//                                                                       row.classList.remove('bg-highlight-green-50');
                                                                      
//                                                                       // Also remove highlight from all table cells
//                                                                       const cells = row.querySelectorAll('td');
//                                                                       cells.forEach(cell => {
//                                                                         cell.classList.remove('bg-highlight-green-50');
//                                                                       });
//                                                                     }, 300);
//                                                                   }
//                                                                 })
//                                                                 .catch(error => {
//                                                                   console.error('Error unloading item:', error);
//                                                                   toast({
//                                                                     title: "Failed to unload item",
//                                                                     description: "Please try again",
//                                                                     variant: "destructive"
//                                                                   });
//                                                                 });
//                                                               }
//                                                             }}
//                                                             title="Click to unload item"
//                                                           >
//                                                             <CheckCircle className="h-5 w-5 text-green-500 hover:text-red-500 transition-colors" />
//                                                           </div>
                                                          
//                                                           <Button
//                                                             size="icon"
//                                                             variant="ghost"
//                                                             className="h-9 w-9"
//                                                             onClick={() => {
//                                                               // Always use loadedQuantity when item is loaded
//                                                               const currentQuantity = item.loadedQuantity ?? item.quantity ?? 1;
//                                                               updateItemQuantity(item.id, Math.max(1, currentQuantity - 1), operation.id);
//                                                             }}
//                                                             disabled={(item.loadedQuantity ?? item.quantity ?? 0) <= 1}
//                                                             title="Decrease quantity"
//                                                           >
//                                                             <MinusCircle className="h-5 w-5" />
//                                                           </Button>
                                                          
//                                                           <Input
//                                                             type="number"
//                                                             min="1"
//                                                             id={`item-quantity-${item.id}`}
//                                                             className="w-16 h-9 text-center text-base font-medium border-0 focus:ring-0 p-0"
//                                                             value={item.loadedQuantity ?? item.quantity ?? 1}
//                                                             onChange={(e) => {
//                                                               updateItemQuantity(item.id, parseInt(e.target.value) || 1, operation.id);
//                                                             }}
//                                                           />
                                                          
//                                                           <Button
//                                                             size="icon"
//                                                             variant="ghost"
//                                                             className="h-9 w-9"
//                                                             onClick={() => {
//                                                               const currentQty = item.loadedQuantity ?? item.quantity ?? 1;
//                                                               updateItemQuantity(item.id, currentQty + 1, operation.id);
//                                                             }}
//                                                             title="Increase quantity"
//                                                           >
//                                                             <PlusCircle className="h-5 w-5" />
//                                                           </Button>
//                                                         </div>
//                                                       ) : (
//                                                         // Empty placeholder when not loaded - quantity controls are merged into Load Item button
//                                                         <div className="w-24"></div>
//                                                       )}
//                                                       {/* In desktop view, we now use a capsule container for Load Item button to match mobile view */}
//                                                       {!item.loaded && (
//                                                         /* Show Load Item button in a capsule container */
//                                                         <div className="flex items-center border rounded-full overflow-hidden border-gray-300 transition-all duration-300 ease-in-out">
//                                                          <Button
//                                                             variant="ghost"
//                                                             className="h-9 px-3 rounded-full"
//                                                             onClick={() => {
//                                                               // Update UI element background with animation
//                                                               const row = document.querySelector(`tr[data-item-id="${item.id}"]`);
//                                                               if (row) {
//                                                                 row.classList.add('animate-pulse');
//                                                                 setTimeout(() => {
//                                                                   row.classList.remove('animate-pulse');
//                                                                   row.classList.add('bg-highlight-green-50');
                                                                  
//                                                                   // Also add highlight to all table cells
//                                                                   const cells = row.querySelectorAll('td');
//                                                                   cells.forEach(cell => {
//                                                                     cell.classList.add('bg-highlight-green-50');
//                                                                   });
//                                                                 }, 300);
//                                                               }
                                                              
//                                                               // Update local state to mark item as loaded
//                                                               if (viewProformaDetails?.items) {
//                                                                 const updatedItem: ProformaSlipItem = { 
//                                                                   ...item, 
//                                                                   loaded: true,
//                                                                   loadedQuantity: item.quantity ?? 0
//                                                                 };
                                                                
//                                                                 const updatedItems = viewProformaDetails.items.map((i: ProformaSlipItem) => 
//                                                                   i.id === item.id ? updatedItem : i
//                                                                 );
                                                                
//                                                                 // Keep original item order - don't sort by loaded status
//                                                                 setViewProformaDetails({
//                                                                   ...viewProformaDetails,
//                                                                   items: updatedItems
//                                                                 });
                                                                
//                                                                 // Save to server
//                                                                 apiRequest('PATCH', `/api/loading-operation-items/${item.id}`, {
//                                                                   loaded: true,
//                                                                   loadedQuantity: item.quantity,
//                                                                   loadOperationId: operation.id
//                                                                 })
//                                                                 .then(() => {
//                                                                   console.log('Server updated successfully');
//                                                                   // Force re-render to ensure UI is updated correctly
//                                                                   setForceUpdateCounter(prev => prev + 1);
//                                                                 })
//                                                                 .catch(console.error);
//                                                               }
//                                                             }}
//                                                           >
//                                                             <span className="flex items-center">
//                                                               <span className="mr-2">Load Item</span>
//                                                               <Plus className="h-5 w-5" />
//                                                             </span>
//                                                           </Button>
//                                                         </div>
//                                                       )}
//                                                     </div>
//                                                   </TableCell>
//                                                   <TableCell>
//                                                     <Button 
//                                                       size="sm"
//                                                       variant="ghost"
//                                                       onClick={() => {
//                                                         // Delete item
//                                                         if (operation.referenceNumber) {
//                                                           deleteItem(item.id, operation.id, operation.referenceNumber);
//                                                         }
//                                                       }}
//                                                     >
//                                                       <Trash className="h-6 w-6 text-red-500" style={{height: '1.5rem', width: '1.5rem'}} />
//                                                     </Button>
//                                                   </TableCell>
//                                                 </TableRow>
//                                               ))
//                                             ) : (
//                                               <TableRow>
//                                                 <TableCell colSpan={4} className="text-center py-4">
//                                                   {activeItemFilter !== "all" ? `No items matching the "${activeItemFilter}" filter` : "No items found"}
//                                                 </TableCell>
//                                               </TableRow>
//                                             )}
//                                           </TableBody>
//                                         </Table>
//                                       </div>
//                                     </div>
//                                   </div>
                                  
//                                   <div className="space-y-3">
//                                     <div className="w-full">
//                                       <Button 
//                                         onClick={async () => {
//                                           // Show immediate feedback of saving in progress
//                                           toast({
//                                             title: "Saving changes",
//                                             description: "Please wait while your changes are saved...",
//                                           });
                                          
//                                           // Ensure dialog stays open by setting state explicitly
//                                           setEditDialogOpenStates(prev => ({
//                                             ...prev,
//                                             [operation.id]: true
//                                           }));
                                          
//                                           // Get vehicle number input value
//                                           const vehicleNumberInput = document.getElementById(`vehicle-number-${operation.id}`) as HTMLInputElement;
//                                           const driverNameInput = document.getElementById(`driver-name-${operation.id}`) as HTMLInputElement;
                                          
//                                           const vehicleNumber = vehicleNumberInput?.value || "";
//                                           const driverName = driverNameInput?.value || "";
                                          
//                                           try {
//                                             // Step 1: Get the list of items we need to update
//                                             // Only collect the data, don't save yet - we want to coordinate this with vehicle update
//                                             const itemUpdateKey = `item-updates-${operation.id}`;
//                                             const updates = JSON.parse(sessionStorage.getItem(itemUpdateKey) || '{}');
                                            
//                                             const table = document.getElementById(`items-table-${operation.id}`);
//                                             const mobileItems = document.getElementById(`mobile-items-${operation.id}`);
                                            
//                                             // Create a fresh batch updates array from the current UI state
//                                             const batchUpdates: any[] = [];
//                                             const newItemsKey = `proforma-new-items-${operation.referenceNumber?.trim()}`;
//                                             let newlyAddedItems: number[] = [];
                                            
//                                             try {
//                                               const storedNewItems = localStorage.getItem(newItemsKey);
//                                               if (storedNewItems) {
//                                                 newlyAddedItems = JSON.parse(storedNewItems);
//                                               }
//                                             } catch (err) {
//                                               console.error("Error loading newly added items:", err);
//                                             }
                                            
//                                             // Collect checkbox states from desktop view
//                                             if (table) {
//                                               const checkboxes = table.querySelectorAll('input[type="checkbox"][id^="confirm-loaded-"]');
//                                               checkboxes.forEach((element) => {
//                                                 const checkbox = element as HTMLInputElement;
//                                                 const itemId = checkbox.id.replace('confirm-loaded-', '');
//                                                 const itemIdNum = parseInt(itemId);
//                                                 const isLoaded = checkbox.checked;
                                                
//                                                 const isNewlyAdded = newlyAddedItems.includes(itemIdNum);
//                                                 const quantity = updates[itemId] || 0;
                                                
//                                                 if (isNewlyAdded) {
//                                                   batchUpdates.push({
//                                                     id: itemIdNum,
//                                                     loaded: isLoaded,
//                                                     quantity: quantity,
//                                                     originalQuantity: 0,
//                                                     extraQuantity: quantity
//                                                   });
//                                                 } else {
//                                                   // For regular items
//                                                   const originalItem = viewProformaDetails?.items?.find(i => i.id === itemIdNum);
//                                                   const origQty = originalItem?.originalQuantity || 0;
//                                                   const currentQty = updates[itemId] || (originalItem?.quantity || 0);
//                                                   const extraQty = currentQty > origQty ? currentQty - origQty : 0;
                                                  
//                                                   batchUpdates.push({
//                                                     id: itemIdNum,
//                                                     loaded: isLoaded,
//                                                     quantity: updates[itemId] || undefined,
//                                                     extraQuantity: extraQty
//                                                   });
//                                                 }
//                                               });
//                                             }
                                            
//                                             // IMPORTANT: Create the operation object with vehicle info BEFORE sending the API request
//                                             // This ensures we have it for UI updates even if the request might take time
//                                             const updatedOperation = {
//                                               ...operation,
//                                               vehicleNumber,
//                                               driverName
//                                             };
                                            
//                                             // Update the cached operation state IMMEDIATELY to reflect vehicle changes
//                                             // This is a new approach that directly updates the caches at all levels
//                                             import('../utils/tableStatePreservation').then(({ updateCachedOperation }) => {
//                                               updateCachedOperation(updatedOperation);
//                                               console.log("Updated cached operation directly with vehicleNumber:", vehicleNumber);
//                                             });
                                            
//                                             // Update all local state right away for instant UI feedback
//                                             // 1. Update the main operations list
//                                             if (data) {
//                                               const updatedOperations = data.map(op => 
//                                                 op.id === operation.id ? updatedOperation : op
//                                               );
//                                               queryClient.setQueryData(['/api/loading-operations'], updatedOperations);
//                                             }
                                            
//                                             // 2. Update viewProformaDetails for the details view
//                                             if (viewProformaDetails) {
//                                               setViewProformaDetails(prev => ({
//                                                 ...prev,
//                                                 slip: {
//                                                   ...prev.slip,
//                                                   vehicleNumber,
//                                                   driverName
//                                                 }
//                                               }));
//                                             }
                                            
//                                             // Step 2: Update operation with vehicle number and driver name (server-side)
//                                             await apiRequest('PUT', `/api/loading-operations/${operation.id}`, {
//                                               vehicleNumber,
//                                               driverName
//                                             });
                                            
//                                             console.log(`Updated operation ${operation.id} with vehicle number: ${vehicleNumber}`);
                                            
//                                             // Step 3: Update all items if we have any
//                                             if (batchUpdates.length > 0) {
//                                               await saveAllChanges(
//                                                 operation.id, 
//                                                 batchUpdates,
//                                                 // Success callback
//                                                 () => {
//                                                   console.log("Items saved successfully");
//                                                 },
//                                                 // Error callback
//                                                 (error) => {
//                                                   console.error("Error saving items:", error);
//                                                 }
//                                               );
//                                             }
                                            
//                                             // Broadcast the changes to other clients
//                                             if (broadcastChannelRef.current) {
//                                               broadcastChannelRef.current.postMessage({
//                                                 type: 'OPERATION_UPDATED',
//                                                 operationId: operation.id,
//                                                 data: {
//                                                   vehicleNumber,
//                                                   driverName
//                                                 },
//                                                 timestamp: Date.now(),
//                                                 sender: window.deviceId
//                                               });
//                                             }
                                            
//                                             // Show success indicator
//                                             const successIndicator = document.getElementById(`update-success-${operation.id}`);
//                                             if (successIndicator) {
//                                               successIndicator.classList.remove('hidden');
//                                               // Hide the success message after 3 seconds
//                                               setTimeout(() => {
//                                                 successIndicator.classList.add('hidden');
//                                               }, 3000);
//                                             }
//                                           } catch (error) {
//                                             console.error("Error in save changes process:", error);
//                                             toast({
//                                               variant: "destructive",
//                                               title: "Error saving changes",
//                                               description: "An error occurred while saving your changes. Please try again.",
//                                             });
//                                           }
//                                         }} 
//                                         className="space-x-1 w-full"
//                                       >
//                                         <Save className="h-4 w-4" />
//                                         <span>Save Changes</span>
//                                       </Button>
//                                     </div>
//                                   </div>
                                  
//                                   <div id={`update-success-${operation.id}`} className="p-3 bg-muted/30 rounded-md text-green-500 text-sm flex items-center space-x-2 hidden">
//                                     <CheckSquare className="h-4 w-4" />
//                                     <span>All changes saved successfully</span>
//                                   </div>
//                                 </div>
//                               )}
//                             </TabsContent>
//                           </Tabs>
                          
//                           <DialogFooter className="flex w-full">
//                             <Button
//                               type="button"
//                               variant="outline"
//                               className="w-full"
//                               onClick={() => {
//                                 // Clear dialog open state for this operation
//                                 setEditDialogOpenStates(prev => ({
//                                   ...prev,
//                                   [operation.id]: false
//                                 }));
                                
//                                 // Also close via DOM for legacy behavior support
//                                 const closeButton = document.querySelector<HTMLButtonElement>('[data-state="open"]');
//                                 if (closeButton) closeButton.click();
//                               }}
//                             >
//                               Close
//                             </Button>
//                           </DialogFooter>
//                         </DialogContent>
//                       </Dialog>
                      
//                       {userPermissions.canDeleteOperationalItems ? (
//                         <Dialog 
//                           open={isDeleteDialogOpen && selectedOperation?.id === operation.id} 
//                           onOpenChange={(open) => {
//                             if (open) {
//                               setSelectedOperation(operation);
//                             } else {
//                               // Reset filter when dialog is closed
//                               setActiveItemFilter("all");
//                             }
//                             setIsDeleteDialogOpen(open);
//                           }}>
//                           <DialogTrigger asChild>
//                             <Button 
//                               variant="ghost" 
//                               size="icon"
//                               className="h-9 w-9 text-red-500 rounded-full bg-red-50 hover:bg-red-100"
//                             >
//                               <Trash className="h-6 w-6 text-red-500" style={{height: '1.5rem', width: '1.5rem'}} />
//                             </Button>
//                           </DialogTrigger>
//                           <DialogContent>
//                             <DialogHeader>
//                               <DialogTitle>Delete Load Slip</DialogTitle>
//                               <DialogDescription>
//                                 Are you sure you want to delete this load slip? This action cannot be undone.
//                               </DialogDescription>
//                             </DialogHeader>
//                             <div className="flex justify-end space-x-2 pt-4">
//                               <Button 
//                                 variant="outline" 
//                                 onClick={() => setIsDeleteDialogOpen(false)}
//                               >
//                                 Cancel
//                               </Button>
//                               <Button 
//                                 variant="destructive"
//                                 onClick={async () => {
//                                   try {
//                                     if (selectedOperation) {
//                                       // First close the dialog to prevent multiple clicks
//                                       setIsDeleteDialogOpen(false);
                                      
//                                       // Then attempt to delete the operation
//                                       const response = await apiRequest('DELETE', `/api/loading-operations/${selectedOperation.id}`);
                                      
//                                       // Clear the selected operation
//                                       setSelectedOperation(null);
                                      
//                                       // Show success message
//                                       toast({
//                                         title: "Success",
//                                         description: "Load slip deleted successfully",
//                                       });
                                      
//                                       // Refetch the data to update the list
//                                       await refetchRef.current();
                                      
//                                       // Clear any stored quantities in localStorage related to this operation
//                                       if (selectedOperation.referenceNumber) {
//                                         const storageKey = `proforma-original-quantities-${selectedOperation.referenceNumber.trim()}`;
//                                         const newItemsKey = `proforma-new-items-${selectedOperation.referenceNumber.trim()}`;
//                                         try {
//                                           localStorage.removeItem(storageKey);
//                                           localStorage.removeItem(newItemsKey);
//                                           console.log(`Cleaned up localStorage keys for deleted operation: ${selectedOperation.referenceNumber}`);
//                                         } catch (err) {
//                                           console.error("Error cleaning up localStorage:", err);
//                                         }
//                                       }
//                                     }
//                                   } catch (error) {
//                                     console.error("Error deleting operation:", error);
//                                     toast({
//                                       title: "Error",
//                                       description: "Failed to delete load slip",
//                                       variant: "destructive",
//                                     });
//                                   }
//                                 }}
//                               >
//                                 Delete
//                               </Button>
//                             </div>
//                           </DialogContent>
//                         </Dialog>
//                       ) : null}
//                     </div>
//                   </TableCell>
//                 </TableRow>
//               ))
//             ) : (
//               <TableRow>
//                 <TableCell colSpan={5} className="text-center py-10">
//                   {isLoading ? (
//                     <div className="flex justify-center">
//                       <Loader2 className="h-8 w-8 animate-spin text-muted-foreground" />
//                     </div>
//                   ) : (
//                     "No load slips found"
//                   )}
//                 </TableCell>
//               </TableRow>
//             )}
//           </TableBody>
//           <TableFooter className="bg-muted/30 hidden md:table-footer-group">
//             {(showBackupData ? backupData || [] : data || []).filter(operation => {
//               // Special handling for order #65908
//               if (operation.referenceNumber && operation.referenceNumber.includes("65908")) {
//                 // Always show order #65908 regardless of filter
//                 console.log("Found order #65908 - ensuring it's visible regardless of date filter");
//                 return true;
//               }
              
//               // Apply new date filter - SingleDateFilter takes precedence over dropdown
//               if (isDateFilterActive && selectedDate) {
//                 // Get the order date from proforma slip data
//                 const orderDate = operation.referenceNumber && 
//                   proformaSlipsData[operation.referenceNumber]?.slip?.orderDate;
                
//                 // If there's no order date data yet, we'll temporarily keep the item visible
//                 // This improves the user experience when data is still loading
//                 if (!orderDate && operation.referenceNumber) {
//                   console.log(`No order date found for ${operation.referenceNumber} - keeping visible while data loads`);
//                   return true;
//                 }
                
//                 // Parse the order date string to a Date object for comparison
//                 let orderDateObj: Date;
                
//                 // Try multiple date formats to improve compatibility
//                 try {
//                   // Convert string dates to Date objects for comparison
//                   if (typeof orderDate === 'string') {
//                     // Try to parse DD/MM/YYYY format first
//                     const [day, month, year] = orderDate.split('/').map(num => parseInt(num, 10));
//                     if (day && month && year) {
//                       orderDateObj = new Date(year, month - 1, day); // month is 0-indexed in JS Date
//                     } else {
//                       // Try to parse as ISO string as fallback
//                       orderDateObj = new Date(orderDate);
//                     }
//                   } else if (isDateObject(orderDate)) {
//                     orderDateObj = orderDate;
//                   } else {
//                     // Keep items visible if we can't parse their date
//                     return true;
//                   }
                  
//                   // Compare dates at day level (ignoring time)
//                   const selectedDay = selectedDate.getDate();
//                   const selectedMonth = selectedDate.getMonth();
//                   const selectedYear = selectedDate.getFullYear();
                  
//                   const orderDay = orderDateObj.getDate();
//                   const orderMonth = orderDateObj.getMonth();
//                   const orderYear = orderDateObj.getFullYear();
                  
//                   // Only include operations with matching date
//                   return (selectedDay === orderDay && selectedMonth === orderMonth && selectedYear === orderYear);
//                 } catch (error) {
//                   console.error(`Error parsing date for ${operation.referenceNumber}:`, error);
//                   // Keep items visible if there's an error parsing dates
//                   return true;
//                 }
//               }
//               // Fall back to legacy date filter if SingleDateFilter is not active
//               else if (dateFilterOption !== "all") {
//                 try {
//                   const proformaData = operation.referenceNumber ? proformaSlipsData[operation.referenceNumber]?.slip : null;
                  
//                   if (!proformaData?.orderDate && operation.referenceNumber) {
//                     // Keep visible while data loads
//                     return true;
//                   }
                  
//                   if (proformaData?.orderDate) {
//                     // Use order date from the proforma slip
//                     const orderDateStr = typeof proformaData.orderDate === 'string' ? proformaData.orderDate : 
//                       (isDateObject(proformaData.orderDate) ? formatDateToDDMMYYYY(proformaData.orderDate as Date) : null);
                    
//                     if (!orderDateStr) return true; // Keep visible while data loads
                    
//                     // Check if the date matches the selected filter
//                     if (dateFilterOption === "today" && !isDateToday(orderDateStr)) return false;
//                     if (dateFilterOption === "tomorrow" && !isDateTomorrow(orderDateStr)) return false;
//                     if (dateFilterOption === "yesterday" && !isDateYesterday(orderDateStr)) return false;
                    
//                     // If it passes all filters, keep it
//                     return true;
//                   } else {
//                     return true; // Keep visible if no date data
//                   }
//                 } catch (error) {
//                   console.error(`Error in date filtering for ${operation.referenceNumber}:`, error);
//                   return true; // Keep visible on error
//                 }
//               }

//               // Then filter by tab - this should work for all tabs
//               if (activeViewTab === "ready-desp" && operation.status !== "READY≈DESP") {
//                 return false;
//               }
//               if (activeViewTab === "loading" && operation.status !== "LOADING") {
//                 return false;
//               }
              
//               // Filter by plant if plants are selected
//               if (selectedPlants.length > 0) {
//                 // Check if reference number exists
//                 if (!operation.referenceNumber) {
//                   return false;
//                 }
                
//                 // Check if proforma slip data exists for this reference number
//                 const proformaData = proformaSlipsData[operation.referenceNumber];
//                 if (!proformaData || !proformaData.slip) {
//                   return false;
//                 }
                
//                 // Check if plant exists and is not null/empty
//                 const operationPlant = proformaData.slip.plant;
//                 if (!operationPlant || operationPlant.trim() === '') {
//                   return false;
//                 }
                
//                 // Finally check if selected plants includes this plant
//                 if (!selectedPlants.includes(operationPlant)) {
//                   return false;
//                 }
//               }
              
//               if (!searchQuery) return true;
//               return (
//                 (operation.referenceNumber && operation.referenceNumber.includes(searchQuery)) || 
//                 (operation.status && operation.status.toLowerCase().includes(searchQuery.toLowerCase())) ||
//                 (operation.referenceNumber && 
//                  proformaSlipsData[operation.referenceNumber] && 
//                  proformaSlipsData[operation.referenceNumber]?.slip?.partyName?.toLowerCase().includes(searchQuery.toLowerCase()))
//               );
//             }).length > 0 && (
//               <TableRow className="font-medium border-t-2">
//                 <TableCell className="font-bold">Total</TableCell>
//                 {/* Date Cell */}
//                 <TableCell className="text-center">
//                   {(showBackupData ? backupData || [] : data || []).filter(operation => {
//                     // Special handling for order #65908
//                     if (operation.referenceNumber && operation.referenceNumber.includes("65908")) {
//                       // Always show order #65908 regardless of filter
//                       return true;
//                     }
                    
//                     // Apply new date filter - SingleDateFilter takes precedence over dropdown
//                     if (isDateFilterActive && selectedDate) {
//                       // Get the order date from proforma slip data
//                       const orderDate = operation.referenceNumber && 
//                         proformaSlipsData[operation.referenceNumber]?.slip?.orderDate;
                      
//                       // If there's no order date data yet, we'll temporarily keep the item visible
//                       // This improves the user experience when data is still loading
//                       if (!orderDate && operation.referenceNumber) {
//                         return true;
//                       }
                      
//                       // Parse the order date string to a Date object for comparison
//                       let orderDateObj: Date;
                      
//                       // Try multiple date formats to improve compatibility
//                       try {
//                         // Convert string dates to Date objects for comparison
//                         if (typeof orderDate === 'string') {
//                           // Try to parse DD/MM/YYYY format first
//                           const [day, month, year] = orderDate.split('/').map(num => parseInt(num, 10));
//                           if (day && month && year) {
//                             orderDateObj = new Date(year, month - 1, day); // month is 0-indexed in JS Date
//                           } else {
//                             // Try to parse as ISO string as fallback
//                             orderDateObj = new Date(orderDate);
//                           }
//                         } else if (isDateObject(orderDate)) {
//                           orderDateObj = orderDate;
//                         } else {
//                           // Keep items visible if we can't parse their date
//                           return true;
//                         }
                        
//                         // Compare dates at day level (ignoring time)
//                         const selectedDay = selectedDate.getDate();
//                         const selectedMonth = selectedDate.getMonth();
//                         const selectedYear = selectedDate.getFullYear();
                        
//                         const orderDay = orderDateObj.getDate();
//                         const orderMonth = orderDateObj.getMonth();
//                         const orderYear = orderDateObj.getFullYear();
                        
//                         // Only include operations with matching date
//                         return (selectedDay === orderDay && selectedMonth === orderMonth && selectedYear === orderYear);
//                       } catch (error) {
//                         console.error(`Error parsing date for ${operation.referenceNumber}:`, error);
//                         // Keep items visible if there's an error parsing dates
//                         return true;
//                       }
//                     }
//                     // Fall back to legacy date filter if SingleDateFilter is not active
//                     else if (dateFilterOption !== "all") {
//                       try {
//                         const proformaData = operation.referenceNumber ? proformaSlipsData[operation.referenceNumber]?.slip : null;
                        
//                         if (!proformaData?.orderDate && operation.referenceNumber) {
//                           // Keep visible while data loads
//                           return true;
//                         }
                        
//                         if (proformaData?.orderDate) {
//                           // Use order date from the proforma slip
//                           const orderDateStr = typeof proformaData.orderDate === 'string' ? proformaData.orderDate : 
//                             (isDateObject(proformaData.orderDate) ? formatDateToDDMMYYYY(proformaData.orderDate as Date) : null);
                          
//                           if (!orderDateStr) return true; // Keep visible while data loads
                          
//                           // Check if the date matches the selected filter
//                           if (dateFilterOption === "today" && !isDateToday(orderDateStr)) return false;
//                           if (dateFilterOption === "tomorrow" && !isDateTomorrow(orderDateStr)) return false;
//                           if (dateFilterOption === "yesterday" && !isDateYesterday(orderDateStr)) return false;
                          
//                           // If it passes all filters, keep it
//                           return true;
//                         } else {
//                           return true; // Keep visible if no date data
//                         }
//                       } catch (error) {
//                         console.error(`Error in date filtering for ${operation.referenceNumber}:`, error);
//                         return true; // Keep visible on error
//                       }
//                     }
                    
//                     if ((activeViewTab === "ready-desp" && operation.status !== "READY≈DESP") ||
//                         (activeViewTab === "loading" && operation.status !== "LOADING") ||
//                         (activeViewTab === "cancelled" && operation.status !== "CANCELLED")) {
//                       return false;
//                     }
                    
//                     // Filter by plant if plants are selected
//                     if (selectedPlants.length > 0) {
//                       // Check if reference number exists
//                       if (!operation.referenceNumber) {
//                         return false;
//                       }
                      
//                       // Check if proforma slip data exists for this reference number
//                       const proformaData = proformaSlipsData[operation.referenceNumber];
//                       if (!proformaData || !proformaData.slip) {
//                         return false;
//                       }
                      
//                       // Check if plant exists and is not null/empty
//                       const operationPlant = proformaData.slip.plant;
//                       if (!operationPlant || operationPlant.trim() === '') {
//                         return false;
//                       }
                      
//                       // Finally check if selected plants includes this plant
//                       if (!selectedPlants.includes(operationPlant)) {
//                         return false;
//                       }
//                     }
                    
//                     if (!searchQuery) return true;
//                     return (
//                       (operation.referenceNumber && operation.referenceNumber.includes(searchQuery)) || 
//                       (operation.status && operation.status.toLowerCase().includes(searchQuery.toLowerCase())) ||
//                       (operation.referenceNumber && 
//                       proformaSlipsData[operation.referenceNumber] && 
//                       proformaSlipsData[operation.referenceNumber]?.slip?.partyName?.toLowerCase().includes(searchQuery.toLowerCase()))
//                     );
//                   }).length}
//                 </TableCell>
//                 {/* Order Number Cell */}
//                 <TableCell className="text-center">
//                   {Array.from(new Set((showBackupData ? backupData || [] : data || [])
//                     .filter(operation => {
//                       // First filter by tab selection
//                       if ((activeViewTab === "ready-desp" && operation.status !== "READY≈DESP") ||
//                           (activeViewTab === "loading" && operation.status !== "LOADING") ||
//                           (activeViewTab === "cancelled" && operation.status !== "CANCELLED")) {
//                         return false;
//                       }
                      
//                       // Apply new date filter - SingleDateFilter takes precedence over dropdown
//                       if (isDateFilterActive && selectedDate) {
//                         // Get the order date from proforma slip data
//                         const orderDate = operation.referenceNumber && 
//                           proformaSlipsData[operation.referenceNumber]?.slip?.orderDate;
                        
//                         if (!orderDate) return false;
                        
//                         // Parse the order date string to a Date object for comparison
//                         let orderDateObj: Date;
                        
//                         // Convert string dates to Date objects for comparison
//                         if (typeof orderDate === 'string') {
//                           // Try to parse DD/MM/YYYY format first
//                           const [day, month, year] = orderDate.split('/').map(num => parseInt(num, 10));
//                           if (day && month && year) {
//                             orderDateObj = new Date(year, month - 1, day); // month is 0-indexed in JS Date
//                           } else {
//                             // Try to parse as ISO string as fallback
//                             orderDateObj = new Date(orderDate);
//                           }
//                         } else if (isDateObject(orderDate)) {
//                           orderDateObj = orderDate;
//                         } else {
//                           return false;
//                         }
                        
//                         // Compare dates at day level (ignoring time)
//                         const selectedDay = selectedDate.getDate();
//                         const selectedMonth = selectedDate.getMonth();
//                         const selectedYear = selectedDate.getFullYear();
                        
//                         const orderDay = orderDateObj.getDate();
//                         const orderMonth = orderDateObj.getMonth();
//                         const orderYear = orderDateObj.getFullYear();
                        
//                         // Only include operations with matching date
//                         if (selectedDay !== orderDay || selectedMonth !== orderMonth || selectedYear !== orderYear) {
//                           return false;
//                         }
//                       }
//                       // Fall back to legacy date filter if SingleDateFilter is not active
//                       else if (dateFilterOption !== "all") {
//                         // Check if we have proforma data with an order date for this operation
//                         if (operation.referenceNumber && proformaSlipsData[operation.referenceNumber]?.slip?.orderDate) {
//                           // Make sure orderDate exists and is not null
//                           const orderDateStr = proformaSlipsData[operation.referenceNumber]?.slip?.orderDate;
//                           if (!orderDateStr) return false;
                          
//                           // Check if the date matches the selected filter option
//                           if (dateFilterOption === "today" && !isDateToday(orderDateStr)) return false;
//                           if (dateFilterOption === "tomorrow" && !isDateTomorrow(orderDateStr)) return false;
//                           if (dateFilterOption === "yesterday" && !isDateYesterday(orderDateStr)) return false;
//                         } else {
//                           // If we can't find order date for this operation, exclude it from filtered results
//                           return false;
//                         }
//                       }

















                      
//                       // Filter by plant if plants are selected
//                       if (selectedPlants.length > 0) {
//                         const operationPlant = operation.referenceNumber && 
//                           proformaSlipsData[operation.referenceNumber]?.slip?.plant;
                          
//                         if (!operationPlant || !selectedPlants.includes(operationPlant)) {
//                           return false;
//                         }
//                       }
                      
//                       // Apply search query filter
//                       if (searchQuery && searchQuery.trim() !== '') {
//                         return (
//                           (operation.referenceNumber && operation.referenceNumber.includes(searchQuery)) || 
//                           (operation.status && operation.status.toLowerCase().includes(searchQuery.toLowerCase())) ||
//                           (operation.referenceNumber && 
//                           proformaSlipsData[operation.referenceNumber] && 
//                           proformaSlipsData[operation.referenceNumber]?.slip?.partyName?.toLowerCase().includes(searchQuery.toLowerCase()))
//                         );
//                       }
                      
//                       return true;
//                     })
//                     .map(operation => operation.referenceNumber)
//                   )).length}
//                 </TableCell>
//                 {/* Party Name Cell */}
//                 <TableCell className="text-center">
//                   {Array.from(new Set((showBackupData ? backupData || [] : data || [])
//                     .filter(operation => {
//                       // First filter by tab selection
//                       if ((activeViewTab === "ready-desp" && operation.status !== "READY≈DESP") ||
//                           (activeViewTab === "loading" && operation.status !== "LOADING") ||
//                           (activeViewTab === "cancelled" && operation.status !== "CANCELLED")) {
//                         return false;
//                       }
                      
//                       // Apply new date filter - SingleDateFilter takes precedence over dropdown
//                       if (isDateFilterActive && selectedDate) {
//                         // Get the order date from proforma slip data
//                         const orderDate = operation.referenceNumber && 
//                           proformaSlipsData[operation.referenceNumber]?.slip?.orderDate;
                        
//                         if (!orderDate) return false;
                        
//                         // Parse the order date string to a Date object for comparison
//                         let orderDateObj: Date;
                        
//                         // Convert string dates to Date objects for comparison
//                         if (typeof orderDate === 'string') {
//                           // Try to parse DD/MM/YYYY format first
//                           const [day, month, year] = orderDate.split('/').map(num => parseInt(num, 10));
//                           if (day && month && year) {
//                             orderDateObj = new Date(year, month - 1, day); // month is 0-indexed in JS Date
//                           } else {
//                             // Try to parse as ISO string as fallback
//                             orderDateObj = new Date(orderDate);
//                           }
//                         } else if (isDateObject(orderDate)) {
//                           orderDateObj = orderDate;
//                         } else {
//                           return false;
//                         }
                        
//                         // Compare dates at day level (ignoring time)
//                         const selectedDay = selectedDate.getDate();
//                         const selectedMonth = selectedDate.getMonth();
//                         const selectedYear = selectedDate.getFullYear();
                        
//                         const orderDay = orderDateObj.getDate();
//                         const orderMonth = orderDateObj.getMonth();
//                         const orderYear = orderDateObj.getFullYear();
                        
//                         // Only include operations with matching date
//                         if (selectedDay !== orderDay || selectedMonth !== orderMonth || selectedYear !== orderYear) {
//                           return false;
//                         }
//                       }
//                       // Fall back to legacy date filter if SingleDateFilter is not active
//                       else if (dateFilterOption !== "all") {
//                         // Check if we have proforma data with an order date for this operation
//                         if (operation.referenceNumber && proformaSlipsData[operation.referenceNumber]?.slip?.orderDate) {
//                           // Make sure orderDate exists and is not null
//                           const orderDateStr = proformaSlipsData[operation.referenceNumber]?.slip?.orderDate;
//                           if (!orderDateStr) return false;
                          
//                           // Check if the date matches the selected filter option
//                           if (dateFilterOption === "today" && !isDateToday(orderDateStr)) return false;
//                           if (dateFilterOption === "tomorrow" && !isDateTomorrow(orderDateStr)) return false;
//                           if (dateFilterOption === "yesterday" && !isDateYesterday(orderDateStr)) return false;
//                         } else {
//                           // If we can't find order date for this operation, exclude it from filtered results
//                           return false;
//                         }
//                       }

















                      
//                       // Filter by plant if plants are selected
//                       if (selectedPlants.length > 0) {
//                         const operationPlant = operation.referenceNumber && 
//                           proformaSlipsData[operation.referenceNumber]?.slip?.plant;
                          
//                         if (!operationPlant || !selectedPlants.includes(operationPlant)) {
//                           return false;
//                         }
//                       }
                      
//                       // Apply search query filter
//                       if (searchQuery && searchQuery.trim() !== '') {
//                         return (
//                           (operation.referenceNumber && operation.referenceNumber.includes(searchQuery)) || 
//                           (operation.status && operation.status.toLowerCase().includes(searchQuery.toLowerCase())) ||
//                           (operation.referenceNumber && 
//                           proformaSlipsData[operation.referenceNumber] && 
//                           proformaSlipsData[operation.referenceNumber]?.slip?.partyName?.toLowerCase().includes(searchQuery.toLowerCase()))
//                         );
//                       }
                      
//                       return true;
//                     })
//                     .map(operation => 
//                       operation.referenceNumber && proformaSlipsData[operation.referenceNumber] ? 
//                       proformaSlipsData[operation.referenceNumber]?.slip?.partyName : null
//                     )
//                     .filter(Boolean)
//                   )).length}
//                 </TableCell>
//                 {/* Plant Cell */}
//                 <TableCell className="text-center">_</TableCell>
//                 {/* Vehicle No. Cell */}
//                 <TableCell className="text-center">
//                   {Array.from(new Set((showBackupData ? backupData || [] : data || [])
//                     .filter(operation => {
//                       // First filter by tab selection
//                       if ((activeViewTab === "ready-desp" && operation.status !== "READY≈DESP") ||
//                           (activeViewTab === "loading" && operation.status !== "LOADING") ||
//                           (activeViewTab === "cancelled" && operation.status !== "CANCELLED")) {
//                         return false;
//                       }
                      
//                       // Apply new date filter - SingleDateFilter takes precedence over dropdown
//                       if (isDateFilterActive && selectedDate) {
//                         // Get the order date from proforma slip data
//                         const orderDate = operation.referenceNumber && 
//                           proformaSlipsData[operation.referenceNumber]?.slip?.orderDate;
                        
//                         if (!orderDate) return false;
                        
//                         // Parse the order date string to a Date object for comparison
//                         let orderDateObj: Date;
                        
//                         // Convert string dates to Date objects for comparison
//                         if (typeof orderDate === 'string') {
//                           // Try to parse DD/MM/YYYY format first
//                           const [day, month, year] = orderDate.split('/').map(num => parseInt(num, 10));
//                           if (day && month && year) {
//                             orderDateObj = new Date(year, month - 1, day); // month is 0-indexed in JS Date
//                           } else {
//                             // Try to parse as ISO string as fallback
//                             orderDateObj = new Date(orderDate);
//                           }
//                         } else if (isDateObject(orderDate)) {
//                           orderDateObj = orderDate;
//                         } else {
//                           return false;
//                         }
                        
//                         // Compare dates at day level (ignoring time)
//                         const selectedDay = selectedDate.getDate();
//                         const selectedMonth = selectedDate.getMonth();
//                         const selectedYear = selectedDate.getFullYear();
                        
//                         const orderDay = orderDateObj.getDate();
//                         const orderMonth = orderDateObj.getMonth();
//                         const orderYear = orderDateObj.getFullYear();
                        
//                         // Only include operations with matching date
//                         if (selectedDay !== orderDay || selectedMonth !== orderMonth || selectedYear !== orderYear) {
//                           return false;
//                         }
//                       }
//                       // Fall back to legacy date filter if SingleDateFilter is not active
//                       else if (dateFilterOption !== "all") {
//                         // Check if we have proforma data with an order date for this operation
//                         if (operation.referenceNumber && proformaSlipsData[operation.referenceNumber]?.slip?.orderDate) {
//                           // Make sure orderDate exists and is not null
//                           const orderDateStr = proformaSlipsData[operation.referenceNumber]?.slip?.orderDate;
//                           if (!orderDateStr) return false;
                          
//                           // Check if the date matches the selected filter option
//                           if (dateFilterOption === "today" && !isDateToday(orderDateStr)) return false;
//                           if (dateFilterOption === "tomorrow" && !isDateTomorrow(orderDateStr)) return false;
//                           if (dateFilterOption === "yesterday" && !isDateYesterday(orderDateStr)) return false;
//                         } else {
//                           // If we can't find order date for this operation, exclude it from filtered results
//                           return false;
//                         }
//                       }

















                      
//                       // Filter by plant if plants are selected
//                       if (selectedPlants.length > 0) {
//                         const operationPlant = operation.referenceNumber && 
//                           proformaSlipsData[operation.referenceNumber]?.slip?.plant;
                          
//                         if (!operationPlant || !selectedPlants.includes(operationPlant)) {
//                           return false;
//                         }
//                       }
                      
//                       // Apply search query filter
//                       if (searchQuery && searchQuery.trim() !== '') {
//                         return (
//                           (operation.referenceNumber && operation.referenceNumber.includes(searchQuery)) || 
//                           (operation.status && operation.status.toLowerCase().includes(searchQuery.toLowerCase())) ||
//                           (operation.referenceNumber && 
//                           proformaSlipsData[operation.referenceNumber] && 
//                           proformaSlipsData[operation.referenceNumber]?.slip?.partyName?.toLowerCase().includes(searchQuery.toLowerCase()))
//                         );
//                       }
                      
//                       return true;
//                     })
//                     .map(operation => 
//                       operation.referenceNumber && proformaSlipsData[operation.referenceNumber] && proformaSlipsData[operation.referenceNumber]?.slip?.vehicleNumber
//                         ? proformaSlipsData[operation.referenceNumber]?.slip?.vehicleNumber 
//                         : null
//                     )
//                     .filter(Boolean)
//                   )).length}
//                 </TableCell>
//                 {/* Loaded Qty Cell */}
//                 <TableCell className="text-center">
//                   {(showBackupData ? backupData || [] : data || [])
//                     .filter(operation => {
//                       // First filter by tab selection
//                       if ((activeViewTab === "ready-desp" && operation.status !== "READY≈DESP") ||
//                           (activeViewTab === "loading" && operation.status !== "LOADING") ||
//                           (activeViewTab === "cancelled" && operation.status !== "CANCELLED")) {
//                         return false;
//                       }
                      
//                       // Apply new date filter - SingleDateFilter takes precedence over dropdown
//                       if (isDateFilterActive && selectedDate) {
//                         // Get the order date from proforma slip data
//                         const orderDate = operation.referenceNumber && 
//                           proformaSlipsData[operation.referenceNumber]?.slip?.orderDate;
                        
//                         if (!orderDate) return false;
                        
//                         // Parse the order date string to a Date object for comparison
//                         let orderDateObj: Date;
                        
//                         // Convert string dates to Date objects for comparison
//                         if (typeof orderDate === 'string') {
//                           // Try to parse DD/MM/YYYY format first
//                           const [day, month, year] = orderDate.split('/').map(num => parseInt(num, 10));
//                           if (day && month && year) {
//                             orderDateObj = new Date(year, month - 1, day); // month is 0-indexed in JS Date
//                           } else {
//                             // Try to parse as ISO string as fallback
//                             orderDateObj = new Date(orderDate);
//                           }
//                         } else if (isDateObject(orderDate)) {
//                           orderDateObj = orderDate;
//                         } else {
//                           return false;
//                         }
                        
//                         // Compare dates at day level (ignoring time)
//                         const selectedDay = selectedDate.getDate();
//                         const selectedMonth = selectedDate.getMonth();
//                         const selectedYear = selectedDate.getFullYear();
                        
//                         const orderDay = orderDateObj.getDate();
//                         const orderMonth = orderDateObj.getMonth();
//                         const orderYear = orderDateObj.getFullYear();
                        
//                         // Only include operations with matching date
//                         if (selectedDay !== orderDay || selectedMonth !== orderMonth || selectedYear !== orderYear) {
//                           return false;
//                         }
//                       }
//                       // Fall back to legacy date filter if SingleDateFilter is not active
//                       else if (dateFilterOption !== "all") {
//                         // Check if we have proforma data with an order date for this operation
//                         if (operation.referenceNumber && proformaSlipsData[operation.referenceNumber]?.slip?.orderDate) {
//                           // Make sure orderDate exists and is not null
//                           const orderDateStr = proformaSlipsData[operation.referenceNumber]?.slip?.orderDate;
//                           if (!orderDateStr) return false;
                          
//                           // Check if the date matches the selected filter option
//                           if (dateFilterOption === "today" && !isDateToday(orderDateStr)) return false;
//                           if (dateFilterOption === "tomorrow" && !isDateTomorrow(orderDateStr)) return false;
//                           if (dateFilterOption === "yesterday" && !isDateYesterday(orderDateStr)) return false;
//                         } else {
//                           // If we can't find order date for this operation, exclude it from filtered results
//                           return false;
//                         }
//                       }

















                      
//                       // Filter by plant if plants are selected
//                       if (selectedPlants.length > 0) {
//                         const operationPlant = operation.referenceNumber && 
//                           proformaSlipsData[operation.referenceNumber]?.slip?.plant;
                          
//                         if (!operationPlant || !selectedPlants.includes(operationPlant)) {
//                           return false;
//                         }
//                       }
                      
//                       // Apply search query filter
//                       if (searchQuery && searchQuery.trim() !== '') {
//                         return (
//                           (operation.referenceNumber && operation.referenceNumber.includes(searchQuery)) || 
//                           (operation.status && operation.status.toLowerCase().includes(searchQuery.toLowerCase())) ||
//                           (operation.referenceNumber && 
//                           proformaSlipsData[operation.referenceNumber] && 
//                           proformaSlipsData[operation.referenceNumber]?.slip?.partyName?.toLowerCase().includes(searchQuery.toLowerCase()))
//                         );
//                       }
                      
//                       return true;
//                     })
//                     .reduce((total, operation) => {
//                       if (operation.referenceNumber) {
//                         // Safely access proformaSlipsData
//                         // Ensure proformaSlipsData is defined
//                         if (!proformaSlipsData) {
//                           return total;
//                         }
                        
//                         // Use bracket notation to safely access the referenceNumber
//                         const slipData = proformaSlipsData[operation.referenceNumber];
                        
//                         // If slipData or items is undefined/null, return current total
//                         if (!slipData || !slipData.items) {
//                           return total;
//                         }
                        
//                         // Now we can safely use items
//                         return total + slipData.items
//                           .filter(item => item.loaded)
//                           .reduce((itemTotal, item) => itemTotal + (item.loadedQuantity || item.quantity || 0), 0);
//                       }
//                       return total;
//                     }, 0)
//                   }
//                 </TableCell>
//                 {/* Status Cell */}
//                 <TableCell className="text-center">_</TableCell>
//                 {/* Actions Cell */}
//                 <TableCell>
//                   {/* Show entries dropdown */}
//                   <div className="flex items-center justify-end gap-1 ml-auto">
//                     <span className="text-xs whitespace-nowrap">Show entries:</span>
//                     <select
//                       className="h-6 text-xs border rounded px-1 bg-background"
//                       value={entriesLimit}
//                       onChange={(e) => setEntriesLimit(Number(e.target.value))}
//                       aria-label="Number of entries to display"
//                     >
//                       <option value={15}>15</option>
//                       <option value={25}>25</option>
//                       <option value={50}>50</option>
//                       <option value={100}>100</option>
//                     </select>
//                   </div>
//                 </TableCell>
//               </TableRow>
//             )}
//             {/* Pagination Controls */}
//             <TableRow>
//               <TableCell colSpan={8} className="px-4 py-2">
//                 {(() => {
//                   // Calculate total filtered items
//                   const filteredItems = (showBackupData ? backupData || [] : data || []).filter(operation => {
//                     // Apply new date filter - SingleDateFilter takes precedence over dropdown
//                     if (isDateFilterActive && selectedDate) {
//                       // Get the order date from proforma slip data
//                       const orderDate = operation.referenceNumber && 
//                         proformaSlipsData[operation.referenceNumber]?.slip?.orderDate;
                      
//                       if (!orderDate) return false;
                      
//                       // Parse the order date string to a Date object for comparison
//                       let orderDateObj: Date;
                      
//                       // Convert string dates to Date objects for comparison
//                       if (typeof orderDate === 'string') {
//                         // Try to parse DD/MM/YYYY format first
//                         const [day, month, year] = orderDate.split('/').map(num => parseInt(num, 10));
//                         if (day && month && year) {
//                           orderDateObj = new Date(year, month - 1, day); // month is 0-indexed in JS Date
//                         } else {
//                           // Try to parse as ISO string as fallback
//                           orderDateObj = new Date(orderDate);
//                         }
//                       } else if (isDateObject(orderDate)) {
//                         orderDateObj = orderDate;
//                       } else {
//                         return false;
//                       }
                      
//                       // Compare dates at day level (ignoring time)
//                       const selectedDay = selectedDate.getDate();
//                       const selectedMonth = selectedDate.getMonth();
//                       const selectedYear = selectedDate.getFullYear();
                      
//                       const orderDay = orderDateObj.getDate();
//                       const orderMonth = orderDateObj.getMonth();
//                       const orderYear = orderDateObj.getFullYear();
                      
//                       // Only include operations with matching date
//                       if (selectedDay !== orderDay || selectedMonth !== orderMonth || selectedYear !== orderYear) {
//                         return false;
//                       }
//                     }
//                     // Fall back to legacy date filter if SingleDateFilter is not active
//                     else if (dateFilterOption !== "all") {
//                       // Get proforma data for this operation
//                       const proformaData = operation.referenceNumber ? 
//                         proformaSlipsData[operation.referenceNumber]?.slip : null;
                      
//                       if (proformaData?.orderDate) {
//                         // Check if order date matches the filter
//                         const orderDate = proformaData.orderDate;
//                         const orderDateStr = typeof orderDate === 'string' ? 
//                           orderDate : 
//                           (isDateObject(orderDate) ? 
//                             formatDateToDDMMYYYY(orderDate) : null);
                        
//                         if (!orderDateStr) return false;
                        
//                         // Apply the date filter options
//                         if (dateFilterOption === "today" && !isDateToday(orderDateStr)) return false;
//                         if (dateFilterOption === "tomorrow" && !isDateTomorrow(orderDateStr)) return false;
//                         if (dateFilterOption === "yesterday" && !isDateYesterday(orderDateStr)) return false;
//                       } else {
//                         // If we can't find order date for this operation, exclude it
//                         return false;
//                       }
//                     }
                    
//                     // Then filter by tab
//                     if (activeViewTab === "ready-desp" && operation.status !== "READY≈DESP") {
//                       return false;
//                     }
//                     if (activeViewTab === "loading" && operation.status !== "LOADING") {
//                       return false;
//                     }
//                     if (activeViewTab === "cancelled" && operation.status !== "CANCELLED") {
//                       return false;
//                     }
                    
//                     // Filter by plant if plants are selected
//                     if (selectedPlants.length > 0) {
//                       const operationPlant = operation.referenceNumber && 
//                         proformaSlipsData[operation.referenceNumber]?.slip?.plant;
                        
//                       if (!operationPlant || !selectedPlants.includes(operationPlant)) {
//                         return false;
//                       }
//                     }
                    
//                     // Apply search query filter
//                     if (searchQuery && searchQuery.trim() !== '') {
//                       return (
//                         (operation.referenceNumber && operation.referenceNumber.includes(searchQuery)) || 
//                         (operation.status && operation.status.toLowerCase().includes(searchQuery.toLowerCase())) ||
//                         (operation.referenceNumber && 
//                           proformaSlipsData[operation.referenceNumber] && 
//                           proformaSlipsData[operation.referenceNumber]?.slip?.partyName?.toLowerCase().includes(searchQuery.toLowerCase()))
//                       );
//                     }
                    
//                     return true;
//                   });
                  
//                   // Calculate pagination values
//                   const totalPages = Math.ceil(filteredItems.length / entriesLimit) || 1;
//                   const startItem = (currentPage - 1) * entriesLimit + 1;
//                   const endItem = Math.min(startItem + entriesLimit - 1, filteredItems.length);
                  
//                   return (
//                     <div className="flex items-center justify-between w-full px-2">
//                       <div className="text-sm text-muted-foreground">
//                         Showing {startItem} to {endItem} of {filteredItems.length} entries
//                       </div>
//                       <div className="flex items-center space-x-2">
//                         <Button
//                           variant="outline"
//                           size="sm"
//                           onClick={() => setCurrentPage(prev => Math.max(prev - 1, 1))}
//                           disabled={currentPage === 1}
//                           aria-label="Previous page"
//                         >
//                           Previous
//                         </Button>
//                         <div className="text-sm font-medium">
//                           Page {currentPage} of {totalPages}
//                         </div>
//                         <Button
//                           variant="outline"
//                           size="sm"
//                           onClick={() => setCurrentPage(prev => Math.min(prev + 1, totalPages))}
//                           disabled={currentPage === totalPages}
//                           aria-label="Next page"
//                         >
//                           Next
//                         </Button>
//                       </div>
//                     </div>
//                   );
//                 })()}
//               </TableCell>
//             </TableRow>
//           </TableFooter>
//         </Table>
//       </div>

//       {/* Data source toggle indicator */}
//       {showBackupData && (
//         <div className="flex items-center justify-center space-x-2 my-4 bg-amber-50 border border-amber-200 p-2 rounded-md">
//           <span className="text-amber-800 text-sm">
//             Currently viewing backup data. Use the toggle in the header to return to active data.
//           </span>
//         </div>
//       )}
      
//       {/* Multiple Delete Dialog */}
//       <Dialog 
//         open={isMultipleDeleteDialogOpen} 
//         onOpenChange={(open) => {
//           setIsMultipleDeleteDialogOpen(open);
//           if (!open) {
//             // Reset filter when dialog is closed
//             setActiveItemFilter("all");
//           }
//         }}>
//         <DialogContent>
//           <DialogHeader>
//             <DialogTitle>Delete Selected Load Slips ({selectedOperationIds.length})</DialogTitle>
//             <DialogDescription>
//               Are you sure you want to delete {selectedOperationIds.length} load slips? This action cannot be undone.
//             </DialogDescription>
//           </DialogHeader>
//           <div className="flex justify-end space-x-2 pt-4">
//             <Button 
//               variant="outline" 
//               onClick={() => setIsMultipleDeleteDialogOpen(false)}
//             >
//               Cancel
//             </Button>
//             <Button 
//               variant="destructive"
//               onClick={async () => {
//                 try {
//                   // First close the dialog to prevent multiple clicks
//                   setIsMultipleDeleteDialogOpen(false);
                  
//                   // Collect reference numbers for cleanup
//                   const operationsToDelete = data?.filter(op => selectedOperationIds.includes(op.id)) || [];
//                   const referenceNumbers = operationsToDelete
//                     .map(op => op.referenceNumber)
//                     .filter(ref => ref !== null && ref !== undefined) as string[];
                  
//                   // Delete each selected operation
//                   const deletePromises = selectedOperationIds.map(id => 
//                     apiRequest('DELETE', `/api/loading-operations/${id}`)
//                   );
                  
//                   await Promise.all(deletePromises);
                  
//                   // Success message
//                   toast({
//                     title: "Success",
//                     description: `${selectedOperationIds.length} load slips deleted successfully`,
//                   });
                  
//                   // Clear selected IDs
//                   setSelectedOperationIds([]);
                  
//                   // Refetch data
//                   await refetchRef.current();
                  
//                   // Clean up localStorage for all deleted operations
//                   for (const refNum of referenceNumbers) {
//                     if (refNum) {
//                       const storageKey = `proforma-original-quantities-${refNum.trim()}`;
//                       const newItemsKey = `proforma-new-items-${refNum.trim()}`;
//                       try {
//                         localStorage.removeItem(storageKey);
//                         localStorage.removeItem(newItemsKey);
//                         console.log(`Cleaned up localStorage keys for deleted operation: ${refNum}`);
//                       } catch (err) {
//                         console.error(`Error cleaning up localStorage for ${refNum}:`, err);
//                       }
//                     }
//                   }
//                 } catch (error) {
//                   console.error("Error deleting operations:", error);
//                   toast({
//                     title: "Error",
//                     description: "Failed to delete some load slips",
//                     variant: "destructive",
//                   });
//                 }
//               }}
//             >
//               Delete All ({selectedOperationIds.length})
//             </Button>
//           </div>
//         </DialogContent>
//       </Dialog>
//     </div>
//   );
// }