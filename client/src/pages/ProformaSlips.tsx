import React, { useState, useEffect, useRef } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import ProformaSlipCSVImport from "@/components/ProformaSlipCSVImport";
import { ProformaSlipAPIImport } from "@/components/ProformaSlipAPIImport";
import PageHeader from "../components/PageHeader";
import { Lock, Unlock } from "lucide-react";

import {
  Table,
  TableHeader,
  TableRow,
  TableHead,
  TableBody,
  TableCell,
  TableFooter,
} from "@/components/ui/table";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
  DialogClose,
} from "@/components/ui/dialog";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import {
  Form,
  FormControl,
  FormDescription,
  FormField,
  FormItem,
  FormLabel,
  FormMessage,
} from "@/components/ui/form";
import { Label } from "@/components/ui/label";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { 
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Calendar } from "@/components/ui/calendar";
import { Popover, PopoverTrigger, PopoverContent } from "@/components/ui/popover";
import { toast } from "@/hooks/use-toast";
import { apiRequest, queryClient } from "@/lib/queryClient";
import { zodResolver } from "@hookform/resolvers/zod";
import { useForm } from "react-hook-form";
import { z } from "zod";
import { 
  MoreVertical, 
  Plus, 
  Pencil, 
  Trash, 
  ChevronDown, 
  ChevronLeft,
  ChevronRight,
  ChevronFirst,
  ChevronLast,
  Check, 
  X, 
  Save, 
  Edit, 
  PlusCircle,
  FileEdit,
  Upload,
  Download,
  FileUp,
  FileDown,
  Search,
  CheckCircle,
  CheckSquare,
  Square,
  Calendar as CalendarIcon,
  FilterX,
  FileText,
  Calculator,
  RefreshCw,
} from "lucide-react";
import { format, isWithinInterval, startOfDay, endOfDay, parseISO } from "date-fns";
import { type ProformaSlip, type ProformaSlipItem, type Product } from "@shared/schema";
import { PlantBadge } from "@/components/PlantBadge";
import { SingleDateFilter } from "@/components/SingleDateFilter";
import { PlantFilter } from "@/components/PlantFilter";
import { useSingleDateFilter, SingleDateFilterStorage } from "@/hooks/useSingleDateFilter";

// Form schema for creating/editing proforma slips
const proformaSlipFormSchema = z.object({
  orderDate: z.string().min(1, "Order date is required"),
  orderNumber: z.string().min(1, "Order number is required"),
  partyName: z.string().min(1, "Party name is required"),
  plant: z.string().optional(),
  totalQuantity: z.coerce.number().int().nonnegative().optional(),
  totalVolume: z.string().optional(),
  vehicleNumber: z.string().optional(),
  driverName: z.string().optional(),
  createdById: z.coerce.number().int().positive().default(1),
  notes: z.string().optional(),
});

type ProformaSlipFormValues = z.infer<typeof proformaSlipFormSchema>;

// Extend basic ProformaSlip type to include lock and audit fields loaded from API
type LockedProformaSlip = ProformaSlip & {
  isPrintLocked?: boolean;
  printedByCode?: string | null;
  printedAt?: string | Date | null;
  printCount?: number;
};

// Form schema for adding/editing slip items
const proformaSlipItemFormSchema = z.object({
  proformaSlipId: z.coerce.number().int().positive(),
  productId: z.coerce.number().int().positive(),
  quantity: z.coerce.number().int().positive().default(1),
});

async function unlockSlip(orderNumber: string) {
  const res = await apiRequest('POST', `/api/proforma-slips/order/${orderNumber}/unlock`);
  if (!res.ok) {
    const text = await res.text();
    throw new Error(text || 'Failed to unlock');
  }
}

async function lockSlip(orderNumber: string, printedByCode?: string) {
  const res = await apiRequest('POST', `/api/proforma-slips/order/${orderNumber}/lock`, {
    printedByCode
  });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(text || 'Failed to lock');
  }
  return res.json();
}

type ProformaSlipItemFormValues = z.infer<typeof proformaSlipItemFormSchema>;

export default function ProformaSlips() {
  const [selectedSlip, setSelectedSlip] = useState<ProformaSlip | null>(null);
  const [isNewSlipDialogOpen, setIsNewSlipDialogOpen] = useState(false);
  const [isEditSlipDialogOpen, setIsEditSlipDialogOpen] = useState(false);
  const [isDeleteDialogOpen, setIsDeleteDialogOpen] = useState(false);
  const [isImportDialogOpen, setIsImportDialogOpen] = useState(false);
  const [importFile, setImportFile] = useState<File | null>(null);
  const [isImporting, setIsImporting] = useState(false);
  const fileInputRef = React.useRef<HTMLInputElement>(null);

  const [slipItems, setSlipItems] = useState<Record<number, ProformaSlipItem[]>>({});
  const [editableSlipData, setEditableSlipData] = useState<Record<number, Partial<ProformaSlipFormValues>>>({});
  const [searchQuery, setSearchQuery] = useState('');
  const [slipSearchQuery, setSlipSearchQuery] = useState('');
  const [filteredProducts, setFilteredProducts] = useState<Product[] | null>(null);
  const [searchFocused, setSearchFocused] = useState(false);
  const [selectedSlipIds, setSelectedSlipIds] = useState<number[]>([]);
  const [isMultipleDeleteDialogOpen, setIsMultipleDeleteDialogOpen] = useState(false);
  const [sortConfig, setSortConfig] = useState<{column: string, direction: 'asc' | 'desc'}>({
    column: 'orderNumber',
    direction: 'asc'
  });
  
  // Function to handle sorting by column
  const handleSort = (column: string) => {
    setSortConfig(prev => ({
      column,
      direction: prev.column === column && prev.direction === 'desc' ? 'asc' : 'desc'
    }));
  };
  
  //
  const { savedDate, isLocked, isInitialized, setLocked } = useSingleDateFilter('proforma-page');
  const [selectedDate, setSelectedDate] = useState<Date | null>(null);
  const [isDateFilterActive, setIsDateFilterActive] = useState(false);
  
  // Fetch fresh user data to ensure permissions are up to date
  const { data: remoteUser } = useQuery<any>({
    queryKey: ['/api/user'],
    queryFn: async () => {
      try {
        const res = await fetch('/api/user');
        if (res.ok) return await res.json();
        return null; 
      } catch (e) {
        return null;
      }
    },
    // Don't refetch too often, but ensure we have it
    staleTime: 60000 
  });

  const currentUserInfo = (() => {
    // Priority to remote user data which has latest fields
    if (remoteUser && remoteUser.userCode) return remoteUser;
    
    try {
      const raw = localStorage.getItem('km-user') || localStorage.getItem('currentUser');
      return raw ? JSON.parse(raw) : null;
    } catch {
      return null;
    }
  })();
  
  const currentUserRole = String(currentUserInfo?.role || '').toLowerCase();
  
  const isAdminOrSuper = ['admin', 'super-admin', 'super admin', 'super_admin'].includes(currentUserRole);
  console.log(currentUserRole);
  const userDept = String(currentUserInfo?.department || '').toLowerCase().trim();
  const userDesig = String(currentUserInfo?.designation || '').toLowerCase().trim();
  
  // Define users who have edit access (Read-Write permissions)
  const isReadWriteUser = ['read/write', 'read-write', 'editor', 'edit', 'rw', 'write'].includes(currentUserRole);

  // NEW: Define isread for read-only users
  const isread = ['read-only', 'readonly', 'read', 'r'].includes(currentUserRole);

  const isITDep= ['IT', 'information technology', 'it'].includes(userDept);
  const ismanagment = ['management', 'manager', 'head', 'director'].includes(userDept);
  // Department: Billing, Designation: Head (Case insensitive check)
  const isBillingHead = userDept === 'billing' && userDesig === 'head';
  
  // Lock/Unlock permissions: Admin, Super-Admin, IT, Management, Billing Head
  const canLockUnlockSlips = (isAdminOrSuper || isITDep || ismanagment || isBillingHead) && (isReadWriteUser || isAdminOrSuper);


  // Add new slips: Admin, Super-Admin, and Read-Write users
  const canAddSlips = isAdminOrSuper || isReadWriteUser;
  
  // Only Admin/Super-Admin can edit and delete slips
  const canEditSlips = isAdminOrSuper || isReadWriteUser;

  console.log('DEBUG PROFORMA PERMISSIONS:', { 
    source: remoteUser ? 'remote' : 'local',
    role: currentUserRole, 
    dept: userDept, 
    desig: userDesig, 
    isAdminOrSuper,
    isReadWriteUser,
    canLockUnlockSlips,
    canAddSlips,
    canEditSlips,
    isITDep,
    ismanagment,
    isBillingHead
  });

  
  // Initialize date filter based on saved filter
  useEffect(() => {
    if (isInitialized) {
      // If we have a saved filter (locked or not), always use it when navigating to this page
      if (savedDate) {
        console.log("Using saved date filter:", savedDate, "locked:", isLocked);
        setSelectedDate(savedDate);
        setIsDateFilterActive(true);
      } 
      // We no longer set today as the default date - require explicit user selection
      else if (!selectedDate) {
        console.log("No default date filter applied today");
        const today = new Date();
        setSelectedDate(today);
        setIsDateFilterActive(true);
      }
    }
  }, [isInitialized, isLocked, savedDate]);
  
  // When the page is unmounted or date filter changes, save the current filter if it's locked
  useEffect(() => {
    if (isInitialized && isLocked && selectedDate) {
      // Save the current filter to ensure it persists when navigating pages
      console.log("Saving proforma date filter:", selectedDate);
      SingleDateFilterStorage.saveDateFilter('proforma-page', selectedDate);
    }
  }, [isInitialized, isLocked, selectedDate]);
  
  // Extra effect to handle lock changes specifically
  useEffect(() => {
    if (isInitialized && isLocked && selectedDate) {
      // When locking, explicitly save the current date filter again
      console.log("Locking changed - saving proforma date filter:", selectedDate, "locked:", isLocked);
      SingleDateFilterStorage.saveDateFilter('proforma-page', selectedDate);
    }
  }, [isInitialized, isLocked]);
  
  // Cleanup effect to save current filter on page unmount
  useEffect(() => {
    return () => {
      if (isLocked && selectedDate) {
        console.log("Saving proforma date filter on unmount:", selectedDate);
        SingleDateFilterStorage.saveDateFilter('proforma-page', selectedDate);
      }
    };
  }, [isLocked, selectedDate]);
  
  // Plant filter states
  const [selectedPlants, setSelectedPlants] = useState<string[]>([]);
  const [plantOptions, setPlantOptions] = useState<Array<{value: string, label: string}>>([]);
  
  // Entries limit state - Default to 15 entries
  const [entriesLimit, setEntriesLimit] = useState<number>(15);
  
  // Auto-refresh interval in milliseconds (10 seconds for real-time collaboration)
  const AUTO_REFRESH_INTERVAL = 10000;
  
  // Track if user is currently interacting with the page
  const [userInteracting, setUserInteracting] = useState(false);
  
  // Reference to store the last refresh timestamp
  const lastRefreshTimeRef = useRef<number>(Date.now());
  
  // Setup user interaction tracking for the auto-refresh feature
  useEffect(() => {
    // Only pause auto-refresh when user is actively typing/editing, not just viewing
    // Focus on input/textarea = user is typing
    // Click on dialog/button = user is interacting
    let interactionTimer: ReturnType<typeof setTimeout>;
    
    const handleInteractionStart = () => {
      setUserInteracting(true);
    };
    
    const handleInteractionEnd = () => {
      clearTimeout(interactionTimer);
      interactionTimer = setTimeout(() => {
        setUserInteracting(false);
      }, 2000); // 2 second debounce - shorter for faster auto-refresh resume
    };

    // Only pause on actual editing actions - typing and clicking
    const handleFocus = (e: FocusEvent) => {
      const target = e.target as HTMLElement;
      if (target.tagName === 'INPUT' || target.tagName === 'TEXTAREA' || target.tagName === 'SELECT') {
        handleInteractionStart();
      }
    };

    const handleBlur = () => {
      handleInteractionEnd();
    };

    const handleKeyDown = () => {
      handleInteractionStart();
      handleInteractionEnd();
    };
    
    // Add event listeners
    window.addEventListener('focusin', handleFocus);
    window.addEventListener('focusout', handleBlur);
    window.addEventListener('keydown', handleKeyDown);
    
    // Clean up event listeners on unmount
    return () => {
      window.removeEventListener('focusin', handleFocus);
      window.removeEventListener('focusout', handleBlur);
      window.removeEventListener('keydown', handleKeyDown);
      clearTimeout(interactionTimer);
    };
  }, []);
  
  // Fetch all proforma slips
  const { data: proformaSlips, isLoading } = useQuery<ProformaSlip[]>({
    queryKey: ['/api/proforma-slips', selectedDate, isDateFilterActive],
    queryFn: async () => {
      // Base URL with high limit (100000) to tell the server we want all proforma slips
      let url = `/api/proforma-slips?limit=100000&_t=${Date.now()}`;
      
      // Always include date filter parameters if available
      if (selectedDate) {
        const formattedDate = format(selectedDate, 'yyyy-MM-dd');
        url += `&startOrderDate=${formattedDate}&endOrderDate=${formattedDate}`;
        console.log(`Proforma slips request with filter: date=${formattedDate}`);
      } else {
        console.log('No date filter applied to proforma slips request');
      }
      
      const res = await apiRequest('GET', url);
      lastRefreshTimeRef.current = Date.now();
      return res.json();
    },
    // Enable auto-refresh with React Query's refetchInterval
    refetchInterval: userInteracting ? false : AUTO_REFRESH_INTERVAL,
    refetchOnWindowFocus: true, // Refresh when user focuses window/tab
    staleTime: AUTO_REFRESH_INTERVAL / 2,
  });
  
  // Fetch all products for inventory items (setting a large limit to get all items)
  const { data: products, isLoading: isLoadingProducts } = useQuery<Product[]>({
    queryKey: ['/api/products'],
    queryFn: async () => {
      const res = await apiRequest('GET', '/api/products?limit=1000');
      return res.json();
    },
    // Apply the same auto-refresh settings
    refetchInterval: userInteracting ? false : AUTO_REFRESH_INTERVAL,
    refetchOnWindowFocus: true, // Refresh when user focuses window/tab
    staleTime: AUTO_REFRESH_INTERVAL / 2,
  });
  
  // Fetch all plants from database
  const { data: dbPlants } = useQuery<Array<{id: number; name: string; bgColor: string; textColor: string; borderColor: string; isLockingEnabled: boolean}>>({
    queryKey: ['/api/plants'],
    queryFn: async () => {
      const res = await apiRequest('GET', '/api/plants');
      return res.json();
    },
    staleTime: 5 * 60 * 1000, // Cache for 5 minutes
  });
  
  // Create new proforma slip mutation
  const createProformaSlipMutation = useMutation({
    mutationFn: async (data: ProformaSlipFormValues) => {
      return apiRequest('POST', '/api/proforma-slips', data);
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['/api/proforma-slips'] });
      toast({
        title: "Success",
        description: "Proforma slip created successfully",
      });
      setIsNewSlipDialogOpen(false);
    },
    onError: (error) => {
      toast({
        title: "Error",
        description: `Failed to create proforma slip: ${error.message}`,
        variant: "destructive",
      });
    },
  });
  
  // Update proforma slip mutation
  const updateProformaSlipMutation = useMutation({
    mutationFn: async ({ id, data }: { id: number, data: Partial<ProformaSlipFormValues> }) => {
      return apiRequest('PUT', `/api/proforma-slips/${id}`, data);
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['/api/proforma-slips'] });
      toast({
        title: "Success",
        description: "Proforma slip updated successfully",
      });
      setIsEditSlipDialogOpen(false);
    },
    onError: (error) => {
      toast({
        title: "Error",
        description: `Failed to update proforma slip: ${error.message}`,
        variant: "destructive",
      });
    },
  });
  
  // Delete proforma slip mutation
  const deleteProformaSlipMutation = useMutation({
    mutationFn: async (id: number) => {
      return apiRequest('DELETE', `/api/proforma-slips/${id}`);
    },
    onSuccess: (_, id) => {
      // Update cache immediately to remove the deleted item
      queryClient.setQueriesData({ queryKey: ['/api/proforma-slips'] }, (oldData: any) => {
        if (!Array.isArray(oldData)) return oldData;
        return oldData.filter((slip: ProformaSlip) => slip.id !== id);
      });

      toast({
        title: "Success",
        description: "Proforma slip deleted successfully",
      });
      setIsDeleteDialogOpen(false);
      setSelectedSlip(null);
    },
    onError: (error) => {
      toast({
        title: "Error",
        description: `Failed to delete proforma slip: ${error.message}`,
        variant: "destructive",
      });
    },
  });
  
  // Delete multiple proforma slips mutation
  const deleteMultipleProformaSlipsMutation = useMutation({
    mutationFn: async (ids: number[]) => {
      // Execute all delete requests in sequence
      for (const id of ids) {
        await apiRequest('DELETE', `/api/proforma-slips/${id}`);
      }
      return ids.length;
    },
    onSuccess: (count, ids) => {
      // Update cache immediately to remove the deleted items
      queryClient.setQueriesData({ queryKey: ['/api/proforma-slips'] }, (oldData: any) => {
        if (!Array.isArray(oldData)) return oldData;
        return oldData.filter((slip: ProformaSlip) => !ids.includes(slip.id));
      });

      toast({
        title: "Success",
        description: `${count} proforma slip(s) deleted successfully`,
      });
      setIsMultipleDeleteDialogOpen(false);
      setSelectedSlipIds([]);
    },
    onError: (error) => {
      toast({
        title: "Error",
        description: `Failed to delete proforma slips: ${error.message}`,
        variant: "destructive",
      });
    },
  });
  
  // Form for creating new proforma slips
  const newSlipForm = useForm<ProformaSlipFormValues>({
    resolver: zodResolver(proformaSlipFormSchema),
    defaultValues: {
      orderDate: format(new Date(), 'yyyy-MM-dd'),
      orderNumber: '',
      partyName: '',
      plant: '',
      totalQuantity: 0,
      totalVolume: '',
      vehicleNumber: '',
      driverName: '',
      createdById: 1,
      notes: '',
    },
  });
  
  // Form for editing proforma slips
  const editSlipForm = useForm<ProformaSlipFormValues>({
    resolver: zodResolver(proformaSlipFormSchema),
    defaultValues: {
      orderDate: '',
      orderNumber: '',
      partyName: '',
      plant: '',
      totalQuantity: 0,
      totalVolume: '',
      vehicleNumber: '',
      driverName: '',
      notes: '',
    },
  });
  
  // Handle creating a new slip
  const handleCreateSlip = (data: ProformaSlipFormValues) => {
    createProformaSlipMutation.mutate(data);
  };
  
  // Handle editing a slip
  const handleEditSlip = (data: ProformaSlipFormValues) => {
    if (selectedSlip) {
      updateProformaSlipMutation.mutate({ id: selectedSlip.id, data });
    }
  };
  
  // Open edit dialog with selected slip data
  const openEditDialog = (slip: ProformaSlip) => {
    setSelectedSlip(slip);
    editSlipForm.reset({
      orderDate: slip.orderDate ? 
        (typeof slip.orderDate === 'string' && slip.orderDate.includes('/') 
          ? slip.orderDate.split('/').reverse().join('-')  // Convert dd/MM/yyyy to yyyy-MM-dd
          : (() => {
              try {
                return format(new Date(slip.orderDate), 'yyyy-MM-dd');
              } catch (error) {
                return ''; // Fallback to empty string on parsing error
              }
            })()
        ) : '',
      orderNumber: slip.orderNumber || '',
      partyName: slip.partyName || '',
      plant: slip.plant || '',
      totalQuantity: slip.totalQuantity ?? 0,
      totalVolume: slip.totalVolume || '',
      vehicleNumber: slip.vehicleNumber || '',
      driverName: slip.driverName || '',
      notes: slip.notes || '',
    });
    setIsEditSlipDialogOpen(true);
  };
  
  // Open delete confirmation dialog
  const openDeleteDialog = (slip: ProformaSlip) => {
    setSelectedSlip(slip);
    setIsDeleteDialogOpen(true);
  };
  
  // Fetch proforma slip items for a given slip
  const fetchSlipItems = async (slipId: number) => {
    try {
      console.log(`Fetching items for proforma slip ID: ${slipId}`);
      const res = await apiRequest('GET', `/api/proforma-slips/${slipId}`);
      
      if (!res.ok) {
        const errorText = await res.text();
        throw new Error(`Server error: ${res.status} - ${errorText}`);
      }
      
      const response = await res.json();
      
      // Check if the response has the expected structure with items array
      if (response && response.items && Array.isArray(response.items)) {
        setSlipItems(prev => ({ ...prev, [slipId]: response.items }));
        return response.items;
      } 
      // Fallback for older API format where items might be directly in the response
      else if (response && Array.isArray(response)) {
        setSlipItems(prev => ({ ...prev, [slipId]: response }));
        return response;
      } else {
        setSlipItems(prev => ({ ...prev, [slipId]: [] }));
        return [];
      }
    } catch (error) {
      console.error(`Error fetching slip items for ID ${slipId}:`, error);
      toast({
        title: "Error",
        description: `Failed to fetch slip items: ${error instanceof Error ? error.message : String(error)}`,
        variant: "destructive",
      });
      setSlipItems(prev => ({ ...prev, [slipId]: [] }));
      return [];
    }
  };
  
  // Mutation for creating new slip items
  const createSlipItemMutation = useMutation({
    mutationFn: async (data: ProformaSlipItemFormValues) => {
      return apiRequest('POST', `/api/proforma-slips/${data.proformaSlipId}/items`, data);
    },
    onSuccess: async (_, variables) => {
      // Fetch updated items to calculate total quantity
      const items = await fetchSlipItems(variables.proformaSlipId);
      const totalQuantity = items.reduce((sum: number, item: any) => sum + (item.quantity ?? 0), 0);
      
      // Calculate total volume 
      let totalVolume = 0;
      for (const item of items) {
        if (item.quantity && item.volumeInCuFt) {
          const volumeInCuFt = parseFloat(item.volumeInCuFt || "0");
          totalVolume += volumeInCuFt * item.quantity;
        }
      }
      
      const formattedTotalVolume = totalVolume.toFixed(2);
      
      // Update the slip's total quantity and volume
      await updateProformaSlipMutation.mutateAsync({
        id: variables.proformaSlipId,
        data: { 
          totalQuantity,
          totalVolume: formattedTotalVolume
        }
      });
      
      queryClient.invalidateQueries({ queryKey: ['/api/proforma-slips'] });
      
      toast({
        title: "Success",
        description: "Item added successfully",
      });
    },
    onError: (error) => {
      toast({
        title: "Error",
        description: `Failed to add item: ${error.message}`,
        variant: "destructive",
      });
    },
  });
  
  // Mutation for updating slip items
  const updateSlipItemMutation = useMutation({
    mutationFn: async ({ id, data }: { id: number, data: Partial<ProformaSlipItemFormValues> }) => {
      return apiRequest('PUT', `/api/proforma-slip-items/${id}`, data);
    },
    onSuccess: async (_, variables) => {
      // Find the proforma slip ID associated with this item
      let slipId = 0;
      Object.entries(slipItems).forEach(([key, items]) => {
        if (items.some(item => item.id === variables.id)) {
          slipId = parseInt(key);
        }
      });
      
      if (slipId) {
        const items = await fetchSlipItems(slipId);
        const totalQuantity = items.reduce((sum: number, item: any) => sum + (item.quantity ?? 0), 0);
        
        // Calculate total volume
        let totalVolume = 0;
        for (const item of items) {
          if (item.quantity && item.volumeInCuFt) {
            const volumeInCuFt = parseFloat(item.volumeInCuFt || "0");
            totalVolume += volumeInCuFt * item.quantity;
          }
        }
        
        const formattedTotalVolume = totalVolume.toFixed(2);
        
        await updateProformaSlipMutation.mutateAsync({
          id: slipId,
          data: { 
            totalQuantity,
            totalVolume: formattedTotalVolume
          }
        });
      }
      
      queryClient.invalidateQueries({ queryKey: ['/api/proforma-slips'] });
      toast({
        title: "Success",
        description: "Item updated successfully",
      });
    },
    onError: (error) => {
      toast({
        title: "Error",
        description: `Failed to update item: ${error.message}`,
        variant: "destructive",
      });
    },
  });
  
  // Mutation for deleting slip items
  const deleteSlipItemMutation = useMutation({
    mutationFn: async (id: number) => {
      return apiRequest('DELETE', `/api/proforma-slip-items/${id}`);
    },
    onSuccess: async (_, id) => {
      // Find the proforma slip ID associated with this item
      let slipId = 0;
      Object.entries(slipItems).forEach(([key, items]) => {
        if (items.some(item => item.id === id)) {
          slipId = parseInt(key);
        }
      });
      
      if (slipId) {
        const items = await fetchSlipItems(slipId);
        const totalQuantity = items.reduce((sum: number, item: any) => sum + (item.quantity ?? 0), 0);
        
        let totalVolume = 0;
        for (const item of items) {
          if (item.quantity && item.volumeInCuFt) {
            const volumeInCuFt = parseFloat(item.volumeInCuFt || "0");
            totalVolume += volumeInCuFt * item.quantity;
          }
        }
        
        const formattedTotalVolume = totalVolume.toFixed(2);
        
        await updateProformaSlipMutation.mutateAsync({
          id: slipId,
          data: { 
            totalQuantity,
            totalVolume: formattedTotalVolume
          }
        });
      }
      
      queryClient.invalidateQueries({ queryKey: ['/api/proforma-slips'] });
      toast({
        title: "Success",
        description: "Item deleted successfully",
      });
    },
    onError: (error) => {
      toast({
        title: "Error",
        description: `Failed to delete item: ${error.message}`,
        variant: "destructive",
      });
    },
  });
  
  // Handle saving edited item
  const handleSaveItem = (id: number, data: Partial<ProformaSlipItemFormValues>) => {
    updateSlipItemMutation.mutate({ id, data });
  };
  
  // Handle adding new item
  const handleAddItem = (slipId: number, data: Omit<ProformaSlipItemFormValues, 'proformaSlipId'>) => {
    createSlipItemMutation.mutate({
      proformaSlipId: slipId,
      ...data,
    });
  };
  
  // Handle deleting an item
  const handleDeleteItem = (id: number) => {
    deleteSlipItemMutation.mutate(id);
  };
  
  // Toggle row expansion to show items
  const toggleRowExpansion = (slip: ProformaSlip) => {
    if (!slipItems[slip.id]) {
      fetchSlipItems(slip.id);
    }
    
    setSelectedSlip(selectedSlip?.id === slip.id ? null : slip);
  };
  
  // Extract unique plant options from proforma slips
  useEffect(() => {
    if (proformaSlips && proformaSlips.length > 0) {
      // Get all plant values from the proforma slips data
      const plants = new Set<string>();
      
      // Loop through slips to collect unique plant values
      proformaSlips.forEach(slip => {
        if (slip.plant && slip.plant.trim() !== '') {
          plants.add(slip.plant);
        }
      });
      
      // Convert to array of option objects
      const plantOptionsList = Array.from(plants).map(plant => ({
        value: plant,
        label: plant
      }));
      
      // Sort alphabetically
      plantOptionsList.sort((a, b) => a.label.localeCompare(b.label));
      
      setPlantOptions(plantOptionsList);
    }
  }, [proformaSlips]);
  
  // Handle CSV export
  const handleExportCSV = async () => {
    try {
      const response = await fetch('/api/proforma-slips/export-csv');
      
      if (!response.ok) {
        throw new Error('Failed to export CSV');
      }
      
      const blob = await response.blob();
      const url = window.URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = 'proforma-slips.csv';
      
      document.body.appendChild(a);
      a.click();
      
      window.URL.revokeObjectURL(url);
      document.body.removeChild(a);
      
      toast({
        title: "Success",
        description: "All proforma slips exported successfully",
      });
    } catch (error: any) {
      console.error("Export error:", error);
      toast({
        title: "Error",
        description: `Failed to export CSV: ${error.message}`,
        variant: "destructive",
      });
    }
  };
  
  // State for volume recalculation loading
  const [isRecalculatingVolumes, setIsRecalculatingVolumes] = useState(false);
  
  // Function to recalculate all slip volumes
  const handleRecalculateVolumes = async () => {
    try {
      setIsRecalculatingVolumes(true);
      toast({
        title: "Processing",
        description: "Recalculating volumes for all slips...",
      });
      
      const response = await fetch('/api/proforma-slips/recalculate-volumes', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
      });
      
      if (!response.ok) {
        throw new Error('Failed to recalculate volumes');
      }
      
      const result = await response.json();
      
      toast({
        title: "Success",
        description: result.message || `Successfully recalculated volumes for ${result.updatedCount} proforma slips`,
      });
      
      // Refresh the slips data
      queryClient.invalidateQueries({ queryKey: ['/api/proforma-slips'] });
    } catch (error) {
      console.error("Error recalculating volumes:", error);
      toast({
        title: "Error",
        description: `Failed to recalculate volumes: ${error instanceof Error ? error.message : String(error)}`,
        variant: "destructive",
      });
    } finally {
      setIsRecalculatingVolumes(false);
    }
  };
  
  // Get unique order dates for dropdown filter
  const getUniqueOrderDates = () => {
    if (!proformaSlips) return [];
    
    const uniqueDates = new Set<string>();
    proformaSlips.forEach(slip => {
      if (slip.orderDate) {
        uniqueDates.add(slip.orderDate);
      }
    });
    
    return Array.from(uniqueDates).sort((a, b) => {
      if (a.includes('-') && b.includes('-')) {
        try {
          const [dayA, monthA, yearA] = a.split('-').map(Number);
          const [dayB, monthB, yearB] = b.split('-').map(Number);
          
          const dateA = new Date(2000 + yearA, monthA - 1, dayA);
          const dateB = new Date(2000 + yearB, monthB - 1, dayB);
          
          return dateB.getTime() - dateA.getTime(); 
        } catch {
          return b.localeCompare(a); 
        }
      }
      return b.localeCompare(a);
    });
  };
  
  // State for order date filter
  const [selectedOrderDate, setSelectedOrderDate] = useState<string | null>(null);
  
  // Reset date filters
  const resetDateFilters = () => {
    setSelectedDate(null);
    setIsDateFilterActive(false);
    setSelectedOrderDate(null);
  };
  
  // Filter slips by date range and specific order date
  useEffect(() => {
    if (proformaSlips && proformaSlips.length > 0) {
      const uniquePlants = Array.from(
        new Set(
          proformaSlips
            .filter(slip => slip.plant && slip.plant.trim() !== '')
            .map(slip => slip.plant)
        )
      );
      
      const sorted = uniquePlants
        .filter((plant): plant is string => !!plant) 
        .sort((a, b) => a.localeCompare(b));
      
      const plantOpts = sorted.map(plant => ({
        value: plant,
        label: plant
      }));
      
      setPlantOptions(plantOpts);
    }
  }, [proformaSlips]);

  const getFilteredSlips = () => {
    if (!proformaSlips) return [];
    
    // First filter by search query
    const searchFiltered = proformaSlips.filter(slip => {
      if (!slipSearchQuery) return true;
      const searchLower = slipSearchQuery.toLowerCase();
      return (
        (slip.orderNumber && slip.orderNumber.toLowerCase().includes(searchLower)) ||
        (slip.partyName && slip.partyName.toLowerCase().includes(searchLower)) ||
        (slip.plant && slip.plant.toLowerCase().includes(searchLower)) ||
        (slip.vehicleNumber && slip.vehicleNumber.toLowerCase().includes(searchLower)) ||
        (slip.driverName && slip.driverName.toLowerCase().includes(searchLower))
      );
    });
    
    // Apply plant filter if any plants are selected
    const plantFiltered = selectedPlants.length > 0
      ? searchFiltered.filter(slip => 
          slip.plant && selectedPlants.includes(slip.plant)
        )
      : searchFiltered;
    
    // Filter by date if active
    if (isDateFilterActive && selectedDate) {
      return plantFiltered.filter(slip => {
        if (!slip.orderDate) return false;
        
        let slipDate: Date;
        try {
          if (typeof slip.orderDate === 'string') {
            if (slip.orderDate.includes('-') && slip.orderDate.split('-')[0].length === 4) {
              slipDate = new Date(slip.orderDate);
            } 
            else if (slip.orderDate.includes('-') && slip.orderDate.split('-').length === 3) {
              const [day, month, yearShort] = slip.orderDate.split('-').map(Number);
              const fullYear = yearShort < 50 ? 2000 + yearShort : 1900 + yearShort;
              slipDate = new Date(fullYear, month - 1, day);
            } 
            else if (slip.orderDate.includes('/') && slip.orderDate.split('/').length === 3) {
              const [day, month, year] = slip.orderDate.split('/').map(Number);
              const fullYear = year < 100 ? (year < 50 ? 2000 + year : 1900 + year) : year;
              slipDate = new Date(fullYear, month - 1, day);
            } 
            else {
              slipDate = new Date(slip.orderDate);
            }
          } else {
            slipDate = new Date(slip.orderDate);
          }
          
          return (
            slipDate.getDate() === selectedDate.getDate() &&
            slipDate.getMonth() === selectedDate.getMonth() &&
            slipDate.getFullYear() === selectedDate.getFullYear()
          );
        } catch (error) {
          console.error("Error parsing date:", error, slip.orderDate);
          return false;
        }
      });
    }
    
    return plantFiltered;
  };
  
  // Pagination state variable
  const [currentPage, setCurrentPage] = useState(1);
  
  // Calculate total number of pages based on entries limit
  const getTotalPages = () => {
    const filteredLength = getFilteredSlips().length;
    return Math.ceil(filteredLength / entriesLimit);
  };
  
  // Ensure current page is valid when entries limit changes
  useEffect(() => {
    const totalPages = getTotalPages();
    if (totalPages > 0 && currentPage > totalPages) {
      setCurrentPage(totalPages);
    }
  }, [entriesLimit, getFilteredSlips]);
  
  // Helper: parse various orderDate formats into a Date (returns null on failure)
  function parseSlipDate(value: any): Date | null {
    try {
      if (!value) return null;
      if (typeof value === 'string') {
        // dd/MM/yyyy
        if (value.includes('/') && value.split('/').length === 3) {
          const [d, m, y] = value.split('/').map(Number);
          const fullYear = y < 100 ? (y < 50 ? 2000 + y : 1900 + y) : y;
          return new Date(fullYear, m - 1, d);
        }
        // dd-MM-yy or dd-MM-yyyy or yyyy-MM-dd
        if (value.includes('-')) {
          const parts = value.split('-').map(Number);
          if (parts.length === 3) {
            // ISO yyyy-MM-dd
            if (String(parts[0]).length === 4) {
              return new Date(parts[0], parts[1] - 1, parts[2]);
            }
            // dd-MM-yy or dd-MM-yyyy
            const day = parts[0];
            const month = parts[1];
            const yearPart = parts[2];
            const fullYear = yearPart < 100 ? (yearPart < 50 ? 2000 + yearPart : 1900 + yearPart) : yearPart;
            return new Date(fullYear, month - 1, day);
          }
        }
        // fallback parse
        const parsed = new Date(value);
        return isNaN(parsed.getTime()) ? null : parsed;
      } else if (value instanceof Date) {
        return value;
      } else {
        const parsed = new Date(value);
        return isNaN(parsed.getTime()) ? null : parsed;
      }
    } catch {
      return null;
    }
  }

  function isOrderDateToday(orderDate: any): boolean {
    const d = parseSlipDate(orderDate);
    if (!d) return false;
    const today = new Date();
    return d.getFullYear() === today.getFullYear() &&
           d.getMonth() === today.getMonth() &&
           d.getDate() === today.getDate();
  }

  const getSortedSlips = () => {
    const filteredSlips = getFilteredSlips();

    // Sort the slips
    const sortedSlips = [...filteredSlips].sort((a, b) => {
      // PRIORITIZE today's orders first
      const todayA = isOrderDateToday(a.orderDate) ? 0 : 1;
      const todayB = isOrderDateToday(b.orderDate) ? 0 : 1;
      if (todayA !== todayB) return todayA - todayB;

      const getValueByColumn = (slip: ProformaSlip, column: string) => {
        switch (column) {
          case 'orderNumber':
            if (slip.orderNumber && !isNaN(parseInt(slip.orderNumber))) {
              return parseInt(slip.orderNumber);
            }
            return slip.orderNumber || '';
          case 'orderDate':
            return slip.orderDate ? (parseSlipDate(slip.orderDate)?.getTime() || 0) : 0;
          case 'partyName':
            return slip.partyName || '';
          case 'plant':
            return slip.plant || '';
          case 'totalQuantity':
            return slip.totalQuantity ?? 0;
          default:
            return '';
        }
      };

      const valueA = getValueByColumn(a, sortConfig.column);
      const valueB = getValueByColumn(b, sortConfig.column);

      if (sortConfig.direction === 'asc') {
        return valueA < valueB ? -1 : valueA > valueB ? 1 : 0;
      } else {
        return valueA > valueB ? -1 : valueA < valueB ? 1 : 0;
      }
    });

    const startIndex = (currentPage - 1) * entriesLimit;
    return sortedSlips.slice(startIndex, startIndex + entriesLimit);
  };
  
  return (
    <div className="container mx-auto py-6">
      <div className="flex justify-between items-center mb-6">
        <div>
          <PageHeader
            icon={FileText}
            title="Proforma Slips"
          />
          <div className="text-xs text-muted-foreground flex items-center gap-2 mt-1">
            <span className="flex items-center gap-1">
              {!userInteracting && <span className="inline-block w-2 h-2 rounded-full bg-green-500 animate-pulse"></span>}
              Auto-refresh {userInteracting ? 'paused' : 'active'} (every 10s)
            </span>
            <span>·</span>
            <span title={`Next refresh in ${Math.max(0, Math.floor((AUTO_REFRESH_INTERVAL - (Date.now() - lastRefreshTimeRef.current)) / 1000))} seconds`}>
              Last updated: {new Date(lastRefreshTimeRef.current).toLocaleTimeString()}
            </span>
          </div>
        </div>
        <div className="flex gap-2">
          {/* Refresh Button */}
          <Button 
            variant="outline" 
            size="sm"
            onClick={() => {
              queryClient.invalidateQueries({ queryKey: ['/api/proforma-slips'] });
              queryClient.invalidateQueries({ queryKey: ['/api/products'] });
              lastRefreshTimeRef.current = Date.now();
              toast({ 
                title: "Refreshed", 
                description: "Data has been updated from server" 
              });
            }}
            title="Refresh now"
          >
              <RefreshCw className="mr-2 h-4 w-4" /> Refresh
          </Button>

          {/* Export button - Visible to Read-Only AND Admin/Super */}
          {(isread || isAdminOrSuper || isReadWriteUser) && (
            <Button variant="outline" size="sm" onClick={() => handleExportCSV()}>
              <FileDown className="mr-2 h-4 w-4" /> Export All
            </Button>
          )}

          {/* Admin/Super/Write Access only buttons */}
          {(isAdminOrSuper || isReadWriteUser) && !isread && (
            <>
              <Dialog>
                <DialogTrigger asChild>
                  <Button variant="outline" size="sm">
                    <FileUp className="mr-2 h-4 w-4" /> Import Notion
                  </Button>
                </DialogTrigger>
                <DialogContent className="max-w-2xl">
                  <DialogHeader>
                    <DialogTitle>Import Proforma Slips from Notion</DialogTitle>
                    <DialogDescription>
                      Fetch proforma slip data directly from your Notion database.
                    </DialogDescription>
                  </DialogHeader>
                  <ProformaSlipAPIImport 
                    onImportSuccess={() => {
                      queryClient.invalidateQueries({ queryKey: ['/api/proforma-slips'] });
                    }} 
                  />
                </DialogContent>
              </Dialog>

              <Dialog>
                <DialogTrigger asChild>
                  <Button variant="outline" size="sm">
                    <FileUp className="mr-2 h-4 w-4" /> Import CSV
                  </Button>
                </DialogTrigger>
                <DialogContent>
                  <DialogHeader>
                    <DialogTitle>Import Proforma Slips from CSV</DialogTitle>
                    <DialogDescription>
                      Upload a CSV file containing proforma slip data.
                    </DialogDescription>
                  </DialogHeader>
                  <ProformaSlipCSVImport 
                    onImportSuccess={() => {
                      queryClient.invalidateQueries({ queryKey: ['/api/proforma-slips'] });
                    }} 
                  />
                </DialogContent>
              </Dialog>

              <Button
                variant="outline"
                size="sm"
                onClick={handleRecalculateVolumes}
                disabled={isRecalculatingVolumes}
              >
                <RefreshCw className={`mr-2 h-4 w-4 ${isRecalculatingVolumes ? 'animate-spin' : ''}`} />
                Recalc Volumes
              </Button>
            </>
          )}

          {/* New Slips: available to admins and read-write users */}
          {canAddSlips && (
            <Button onClick={() => setIsNewSlipDialogOpen(true)} size="sm">
              <Plus className="mr-2 h-4 w-4" /> New Slip
            </Button>
          )}
        </div>
      </div>

      <Card>
        <CardHeader>
          <CardTitle>All Proforma Slips</CardTitle>
          <CardDescription>
            View and manage all proforma slips. Click on a row to view details.
          </CardDescription>
        </CardHeader>
        <CardContent>
          <div className="flex flex-col gap-4 mb-4">
            <div className="relative w-full">
              <Search className="absolute left-2 top-2.5 h-4 w-4 text-muted-foreground" />
              <Input
                placeholder="Search slips by order number or party name"
                className="pl-8"
                value={slipSearchQuery}
                onChange={(e) => setSlipSearchQuery(e.target.value)}
              />
            </div>
            
            <div className="flex flex-col md:flex-row justify-between items-center gap-4">
              <div className="flex flex-col md:flex-row gap-2 w-full">
                <SingleDateFilter
                  selectedDate={selectedDate}
                  onDateChange={(date: Date | null) => {
                    setSelectedDate(date);
                    setIsDateFilterActive(!!date);
                    if (date && !isLocked) {
                      SingleDateFilterStorage.saveDateFilter('proforma-slips', date);
                    }
                  }}
                  isLocked={isLocked}
                  onLockChange={(locked: boolean) => setLocked(locked)}
                  pageKey="proforma-slips"
                />
                <PlantFilter
                  selectedPlants={selectedPlants}
                  onPlantChange={setSelectedPlants}
                  plantOptions={plantOptions}
                />
              </div>
            </div>
            
            {selectedSlipIds.length > 0 && canEditSlips && (
              <div className="flex items-center gap-2">
                <span className="text-sm text-muted-foreground">
                  {selectedSlipIds.length} selected
                </span>
                <Button
                  variant="destructive"
                  size="sm"
                  onClick={() => setIsMultipleDeleteDialogOpen(true)}
                >
                  <Trash className="h-4 w-4 mr-2" />
                  Delete Selected
                </Button>
              </div>
            )}
          </div>
          {isLoading ? (
            <div className="flex justify-center py-8">Loading...</div>
          ) : proformaSlips && proformaSlips.length > 0 ? (
            <div className="overflow-auto">
              <Table className="min-w-full">
                <TableHeader>
                  <TableRow>
                    {/* Checkbox column only for editors */}
                    <TableHead className="whitespace-nowrap w-[40px]">
                      <div className="flex items-center justify-center">
                        {canEditSlips ? (
                          <div 
                            className="cursor-pointer hover:bg-muted p-1 rounded-sm"
                            onClick={(e) => {
                              e.stopPropagation();
                              const filteredSlips = getFilteredSlips();
                              if (filteredSlips.length > 0) {
                                const filteredIds = filteredSlips.map(slip => slip.id);
                                const allFilteredSelected = filteredIds.every(id => selectedSlipIds.includes(id));
                                if (allFilteredSelected) {
                                  setSelectedSlipIds(selectedSlipIds.filter(id => !filteredIds.includes(id)));
                                } else {
                                  const currentSelected = new Set(selectedSlipIds);
                                  filteredIds.forEach(id => currentSelected.add(id));
                                  setSelectedSlipIds(Array.from(currentSelected));
                                }
                              }
                            }}
                          >
                            {getFilteredSlips().length > 0 && selectedSlipIds.length === getFilteredSlips().length ? (
                              <CheckSquare className="h-4 w-4" />
                            ) : (
                              <Square className="h-4 w-4" />
                            )}
                          </div>
                        ) : null}
                      </div>
                    </TableHead>
                    <TableHead 
                      className="whitespace-nowrap w-[100px] cursor-pointer hover:bg-muted/50"
                      onClick={() => handleSort('orderDate')}
                    >
                      Order Date
                      {sortConfig.column === 'orderDate' && (
                        <span className="ml-1">{sortConfig.direction === 'asc' ? '↑' : '↓'}</span>
                      )}
                    </TableHead>
                    <TableHead 
                      className="whitespace-nowrap w-[120px] cursor-pointer hover:bg-muted/50"
                      onClick={() => handleSort('orderNumber')}
                    >
                      Order No.
                      {sortConfig.column === 'orderNumber' && (
                        <span className="ml-1">{sortConfig.direction === 'asc' ? '↑' : '↓'}</span>
                      )}
                    </TableHead>
                    <TableHead 
                      className="whitespace-nowrap cursor-pointer hover:bg-muted/50"
                      onClick={() => handleSort('partyName')}
                    >
                      Party Name
                      {sortConfig.column === 'partyName' && (
                        <span className="ml-1">{sortConfig.direction === 'asc' ? '↑' : '↓'}</span>
                      )}
                    </TableHead>
                    <TableHead 
                      className="whitespace-nowrap cursor-pointer hover:bg-muted/50"
                      onClick={() => handleSort('plant')}
                    >
                      Plant
                      {sortConfig.column === 'plant' && (
                        <span className="ml-1">{sortConfig.direction === 'asc' ? '↑' : '↓'}</span>
                      )}
                    </TableHead>
                    <TableHead 
                      className="whitespace-nowrap w-[100px] cursor-pointer hover:bg-muted/50"
                      onClick={() => handleSort('totalQuantity')}
                    >
                      Total Qty
                      {sortConfig.column === 'totalQuantity' && (
                        <span className="ml-1">{sortConfig.direction === 'asc' ? '↑' : '↓'}</span>
                      )}
                    </TableHead>
                    <TableHead className="whitespace-nowrap w-[100px]">Total Volume</TableHead>
                    <TableHead className="whitespace-nowrap w-[120px]">Vehicle No.</TableHead>
                    <TableHead className="whitespace-nowrap">Driver</TableHead>
                    <TableHead className="whitespace-nowrap w-[70px]"></TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {getSortedSlips().map((rawSlip) => {
                    const slip = rawSlip as LockedProformaSlip;
                    return (
                    <React.Fragment key={slip.id}>
                      <TableRow 
                        className="cursor-pointer hover:bg-muted/50"
                        onClick={() => toggleRowExpansion(slip)}
                      >
                        <TableCell className="p-2" onClick={(e) => e.stopPropagation()}>
                          <div className="flex items-center justify-center">
                            {canEditSlips ? (
                              <div 
                                className="cursor-pointer hover:bg-muted p-1 rounded-sm"
                                onClick={(e) => {
                                  e.stopPropagation();
                                  if (selectedSlipIds.includes(slip.id)) {
                                    setSelectedSlipIds(selectedSlipIds.filter(id => id !== slip.id));
                                  } else {
                                    setSelectedSlipIds([...selectedSlipIds, slip.id]);
                                  }
                                }}
                              >
                                {selectedSlipIds.includes(slip.id) ? (
                                  <CheckSquare className="h-4 w-4" />
                                ) : (
                                  <Square className="h-4 w-4" />
                                )}
                              </div>
                            ) : null}
                          </div>
                        </TableCell>
                        <TableCell className="whitespace-nowrap">
                          {slip.orderDate ? (
                            (() => {
                              try {
                                if (typeof slip.orderDate === 'string') {
                                  if (slip.orderDate.includes('/')) {
                                    const parts = slip.orderDate.split('/');
                                    if (parts.length === 3) {
                                      const day = parseInt(parts[0], 10);
                                      const month = parseInt(parts[1], 10);
                                      const year = parseInt(parts[2], 10);
                                      if (day >= 1 && day <= 31 && month >= 1 && month <= 12) {
                                        return `${day.toString().padStart(2, '0')}/${month.toString().padStart(2, '0')}/${year}`;
                                      }
                                    }
                                  }
                                  if (slip.orderDate.includes('-')) {
                                    const parts = slip.orderDate.split('-');
                                    if (parts.length === 3) {
                                      if (parts[0].length === 4) {
                                        const year = parts[0];
                                        const month = parts[1];
                                        const day = parts[2];
                                        return `${day}/${month}/${year}`;
                                      } else {
                                        const day = parts[0];
                                        const month = parts[1];
                                        const year = parts[2].length === 2 ? `20${parts[2]}` : parts[2];
                                        return `${day}/${month}/${year}`;
                                      }
                                    }
                                  }
                                  const date = new Date(slip.orderDate);
                                  if (!isNaN(date.getTime())) {
                                    return format(date, 'dd/MM/yyyy');
                                  }
                                  return slip.orderDate;
                                } else {
                                  return format(new Date(slip.orderDate), 'dd/MM/yyyy');
                                }
                              } catch (error) {
                                return String(slip.orderDate);
                              }
                            })()
                          ) : ' '}
                        </TableCell>
                        <TableCell className="whitespace-nowrap">
                          <div className="flex items-center gap-2">
                            <span>{slip.orderNumber}</span>
                            {/* Lock Icon Logic */}
                            {slip.isPrintLocked ? (
                              <Lock className="h-3.5 w-3.5 text-red-600" title="Locked after print" />
                            ) : (
                              <Unlock className="h-3.5 w-3.5 text-emerald-600 opacity-30" title="Unlocked" />
                            )}
                          </div>
                        </TableCell>
                        <TableCell>{slip.partyName}</TableCell>
                        <TableCell><PlantBadge plant={slip.plant} /></TableCell>
                        <TableCell className="text-right">
                          {slip.totalQuantity !== null && slip.totalQuantity !== undefined 
                            ? slip.totalQuantity 
                            : 0}
                        </TableCell>
                        <TableCell>{slip.totalVolume || ' '}</TableCell>
                        <TableCell>{slip.vehicleNumber || ' '}</TableCell>
                        <TableCell>{slip.driverName || ' '}</TableCell>
                        <TableCell onClick={(e) => e.stopPropagation()}>
                          <DropdownMenu>
                            <DropdownMenuTrigger asChild>
                              <Button variant="ghost" className="h-8 w-8 p-0">
                                <span className="sr-only">Open menu</span>
                                <MoreVertical className="h-4 w-4" />
                              </Button>
                            </DropdownMenuTrigger>
                            <DropdownMenuContent align="end">
                              <DropdownMenuLabel>Actions</DropdownMenuLabel>
                              <DropdownMenuSeparator />
                              
                              {/* Lock/Unlock Options First - Available to Admin, Super-Admin, IT, Management, Billing Head */}
                              {!slip.isPrintLocked && canLockUnlockSlips && (
                                <DropdownMenuItem 
                                  onClick={async () => {
                                    try {
                                      await lockSlip(slip.orderNumber, currentUserInfo?.userCode);
                                      queryClient.invalidateQueries({ queryKey: ['/api/proforma-slips'] });
                                      toast({ 
                                        title: "Locked", 
                                        description: `Slip #${slip.orderNumber} has been locked.` 
                                      });
                                    } catch (err: any) {
                                      toast({ 
                                        title: "Error", 
                                        description: err.message || "Failed to lock", 
                                        variant: "destructive" 
                                      });
                                    }
                                  }}
                                >
                                  <Lock className="mr-2 h-4 w-4" /> Lock Slip
                                </DropdownMenuItem>
                              )}

                              {/* Unlock Option - Available to Admin, Super-Admin, IT, Management, Billing Head */}
                              {slip.isPrintLocked && canLockUnlockSlips && (
                                <DropdownMenuItem 
                                  onClick={async () => {
                                    try {
                                      await unlockSlip(slip.orderNumber);
                                      queryClient.invalidateQueries({ queryKey: ['/api/proforma-slips'] });
                                      toast({ 
                                        title: "Unlocked", 
                                        description: `Slip #${slip.orderNumber} unlocked.` 
                                      });
                                    } catch (err: any) {
                                      toast({ 
                                        title: "Error", 
                                        description: err.message || "Failed to unlock", 
                                        variant: "destructive" 
                                      });
                                    }
                                  }}
                                >
                                  <Unlock className="mr-2 h-4 w-4" /> Unlock Slip
                                </DropdownMenuItem>
                              )}

                              {/* Edit Details - Admin/Super-Admin only */}
                              {canEditSlips && (
                                <DropdownMenuItem onClick={() => openEditDialog(slip)}>
                                  <FileEdit className="mr-2 h-4 w-4" /> Edit Details
                                </DropdownMenuItem>
                              )}

                              {/* Manage/View Items */}
                              <DropdownMenuItem 
                                onClick={() => toggleRowExpansion(slip)}
                              >
                                {canAddSlips ? (
                                  <>
                                    <Edit className="mr-2 h-4 w-4" /> Manage Items
                                  </>
                                ) : (
                                  <>
                                    <FileText className="mr-2 h-4 w-4" /> View Items
                                  </>
                                )}
                              </DropdownMenuItem>

                              {/* Export This Slip */}
                              <DropdownMenuItem 
                                onClick={() => {
                                  window.open(`/api/proforma-slips/export-csv/${slip.id}`, '_blank');
                                  toast({
                                    title: "Export Started",
                                    description: `Exporting proforma slip #${slip.orderNumber}`,
                                  });
                                }}
                              >
                                <FileDown className="mr-2 h-4 w-4" /> Export This Slip
                              </DropdownMenuItem>
                              
                              {/* Delete - Admin/Super-Admin only */}
                              {canEditSlips && (
                                <DropdownMenuItem 
                                  onClick={() => openDeleteDialog(slip)}
                                  className="text-destructive focus:text-destructive"
                                >
                                  <Trash className="mr-2 h-4 w-4" /> Delete
                                </DropdownMenuItem>
                              )}
                            </DropdownMenuContent>
                          </DropdownMenu>
                        </TableCell>
                      </TableRow>
                      
                      {/* Expanded row to show slip items */}
                      {selectedSlip?.id === slip.id && (
                        <TableRow>
                          <TableCell colSpan={10} className="p-0">
                            <div className="px-4 py-3 bg-muted/20">
                              {/* Print Audit Info Header */}
                              {(slip.printedAt || slip.printedByCode) && (
                                <div className="mb-2 px-2 py-1 text-xs text-muted-foreground border-l-2 border-primary/20 pl-2">
                                  {slip.printedAt && (
                                    <>Last printed: {new Date(slip.printedAt as any).toLocaleString()}</>
                                  )}
                                  {slip.printedByCode && (
                                    <> by <span className="font-medium">{slip.printedByCode}</span></>
                                  )}
                                  {typeof slip.printCount === 'number' && (
                                    <> • Print count: {slip.printCount}</>
                                  )}
                                  {slip.isPrintLocked && (
                                    <span className="ml-2 text-red-600 font-medium flex items-center inline-flex gap-1">
                                      <Lock className="h-3 w-3" /> Locked
                                    </span>
                                  )}
                                </div>
                              )}

                              <div className="grid grid-cols-1 gap-4 mb-3">
                                <div className="flex justify-between items-center">
                                  <h3 className="text-lg font-medium">Inventory Items</h3>
                                </div>
                                
                                {canAddSlips && (
                                  <div className="rounded-lg border p-4 bg-white">
                                    <h4 className="text-sm font-semibold mb-2">Add Items to Proforma Slip</h4>
                                    <div className="relative">
                                      <Input 
                                        type="text" 
                                        placeholder="Search items by name or Sr.No..." 
                                        value={searchQuery}
                                        onChange={(e) => {
                                          setSearchQuery(e.target.value);
                                          if (e.target.value.trim() !== '' && products) {
                                            const filtered = products.filter(product => 
                                              product.name?.toLowerCase().includes(e.target.value.toLowerCase()) || 
                                              product.srNo?.toLowerCase().includes(e.target.value.toLowerCase()) || 
                                              product.barcode?.toLowerCase().includes(e.target.value.toLowerCase())
                                            );
                                            setFilteredProducts(filtered);
                                          } else if (searchFocused && products) {
                                            setFilteredProducts(products);
                                          } else {
                                            setFilteredProducts(null);
                                          }
                                        }}
                                        onFocus={() => {
                                          setSearchFocused(true);
                                          if (products) {
                                            setFilteredProducts(products);
                                          }
                                        }}
                                        onBlur={() => {
                                          setTimeout(() => {
                                            if (!searchQuery.trim()) {
                                              setSearchFocused(false);
                                              setFilteredProducts(null);
                                            }
                                          }, 200);
                                        }}
                                        className="w-full"
                                      />
                                      
                                      {/* Searchable dropdown */}
                                      {((searchQuery.trim() !== '' || searchFocused) && filteredProducts && filteredProducts.length > 0) && (
                                        <div className="absolute z-10 w-full mt-1 bg-white rounded-md shadow-lg max-h-60 overflow-auto border border-gray-300">
                                          <div className="sticky top-0 bg-slate-100 px-3 py-2 text-sm font-semibold border-b border-gray-200">
                                            {searchQuery.trim() !== '' ? 'Search Results' : 'All Items'} - Click to select
                                          </div>
                                          <ul className="py-1">
                                            {filteredProducts.map(product => (
                                              <li 
                                                key={product.id}
                                                className="px-3 py-2 hover:bg-gray-100 cursor-pointer border-b border-gray-100"
                                                onClick={() => {
                                                  const itemsPerPallet = product?.itemsPerPallet || 1;
                                                  const existingItem = slipItems[slip.id]?.find(item => item.productId === product.id);
                                                  
                                                  if (existingItem) {
                                                    const newQuantity = (existingItem.quantity ?? 0) + itemsPerPallet;
                                                    handleSaveItem(existingItem.id, { quantity: newQuantity });
                                                    toast({
                                                      title: "Item Updated",
                                                      description: `Quantity updated for ${product.name}`,
                                                    });
                                                  } else {
                                                    const newItemData = {
                                                      productId: product.id,
                                                      quantity: itemsPerPallet
                                                    };
                                                    handleAddItem(slip.id, newItemData);
                                                  }
                                                  setSearchQuery('');
                                                  setFilteredProducts(null);
                                                }}
                                              >
                                                <div className="flex flex-col">
                                                  <span className="font-medium">{product.name}</span>
                                                  <span className="text-xs text-muted-foreground">
                                                    Sr.No: {product.srNo || ' '} | Barcode: {product.barcode || ' '}
                                                  </span>
                                                </div>
                                              </li>
                                            ))}
                                          </ul>
                                        </div>
                                      )}
                                      
                                      {searchQuery.trim() !== '' && (!filteredProducts || filteredProducts.length === 0) && (
                                        <div className="absolute z-10 w-full mt-1 bg-white rounded-md shadow-lg border border-gray-300">
                                          <div className="sticky top-0 bg-slate-100 px-3 py-2 text-sm font-semibold border-b border-gray-200">
                                            Search Results
                                          </div>
                                          <div className="px-3 py-4 text-center text-gray-500">
                                            No products found matching your search.
                                          </div>
                                        </div>
                                      )}
                                    </div>
                                    <div className="mt-2 text-xs text-muted-foreground">
                                      Click on the search field to see all items or type to filter by name or Sr.No.
                                    </div>
                                  </div>
                                )}
                              </div>
                              
                              <div className="rounded-md border overflow-hidden">
                                <Table>
                                  <TableHeader>
                                    <TableRow>
                                      <TableHead className="w-[10%]">Sr. No.</TableHead>
                                      <TableHead className="w-[15%]">SKU</TableHead>
                                      <TableHead className="w-[35%]">Product</TableHead>
                                      <TableHead className="w-[20%] text-center">Quantity</TableHead>
                                      <TableHead className="w-[10%]"></TableHead>
                                    </TableRow>
                                  </TableHeader>
                                  <TableBody>
                                    {slipItems[slip.id]?.map((item, index) => {
                                      return (
                                        <TableRow key={item.id}>
                                          <TableCell>{item.srNo || ' '}</TableCell>
                                          <TableCell className="break-words">
                                            {item.barcode || ' '}
                                          </TableCell>
                                          <TableCell className="max-w-[300px] break-words">
                                            {item.itemName || `Product #${item.productId}`}
                                          </TableCell>
                                          <TableCell className="text-center">
                                            {canAddSlips ? (
                                              <div className="flex items-center justify-center">
                                                <Button
                                                  variant="outline"
                                                  size="sm"
                                                  className="h-8 w-8 p-0"
                                                  onClick={() => {
                                                    const currentQuantity = item.quantity || 1;
                                                    if (currentQuantity > 1) {
                                                      handleSaveItem(item.id, { quantity: currentQuantity - 1 });
                                                    }
                                                  }}
                                                >
                                                  <span>-</span>
                                                </Button>
                                                <span className="min-w-[3rem] text-center mx-1">
                                                  {item.quantity ?? 0}
                                                </span>
                                                <Button
                                                  variant="outline"
                                                  size="sm"
                                                  className="h-8 w-8 p-0"
                                                  onClick={() => {
                                                    const currentQuantity = item.quantity || 1;
                                                    handleSaveItem(item.id, { quantity: currentQuantity + 1 });
                                                  }}
                                                >
                                                  <span>+</span>
                                                </Button>
                                              </div>
                                            ) : (
                                              <span className="text-center">
                                                {item.quantity ?? 0}
                                              </span>
                                            )}
                                          </TableCell>
                                          <TableCell>
                                            {canAddSlips && (
                                              <div className="flex justify-end gap-2">
                                                <Button
                                                  variant="ghost"
                                                  size="icon"
                                                  className="text-destructive"
                                                  onClick={() => handleDeleteItem(item.id)}
                                                >
                                                  <Trash className="h-4 w-4" />
                                                  <span className="sr-only">Delete</span>
                                                </Button>
                                              </div>
                                            )}
                                          </TableCell>
                                        </TableRow>
                                      );
                                    })}

                                    {(!slipItems[slip.id] || slipItems[slip.id].length === 0) && (
                                      <TableRow>
                                        <TableCell colSpan={5} className="h-24 text-center">
                                          {canAddSlips ? "No items in this slip. Use the search bar above to add items." : "No items in this slip."}
                                        </TableCell>
                                      </TableRow>
                                    )}
                                  </TableBody>
                                </Table>
                                
                                {slipItems[slip.id] && slipItems[slip.id].length > 0 && (
                                  <div className="bg-muted px-4 py-3 border-t">
                                    <div className="flex justify-between items-center">
                                      <div className="text-sm font-medium">
                                        Total Items: <span className="text-primary font-semibold">{slipItems[slip.id].length}</span>
                                      </div>
                                      <div className="text-sm font-medium">
                                        Total Quantity: <span className="text-primary font-semibold">
                                          {slipItems[slip.id].reduce((sum, item) => sum + (item.quantity ?? 0), 0)}
                                        </span>
                                      </div>
                                    </div>
                                  </div>
                                )}
                              </div>
                            </div>
                          </TableCell>
                        </TableRow>
                      )}
                    </React.Fragment>
                  );
                  })}
                </TableBody>
                <TableFooter className="bg-muted/30">
                  {getFilteredSlips().length > 0 && (
                    <TableRow className="font-medium border-t-2">
                      <TableCell className="font-bold text-center">Total</TableCell>
                      <TableCell></TableCell> {/* Order Date */}
                      <TableCell className="text-center">
                        {getFilteredSlips().length}
                      </TableCell>
                      <TableCell className="text-center">
                        {Array.from(new Set(getFilteredSlips().map(slip => slip.partyName))).length}
                      </TableCell>
                      <TableCell></TableCell> {/* Plant */}
                      <TableCell className="text-center">
                        {getFilteredSlips().reduce((sum, slip) => sum + (slip.totalQuantity || 0), 0)}
                      </TableCell>
                      <TableCell></TableCell> {/* Total Volume */}
                      <TableCell className="text-center">
                        {Array.from(new Set(getFilteredSlips().filter(slip => slip.vehicleNumber).map(slip => slip.vehicleNumber))).length}
                      </TableCell>
                      <TableCell></TableCell> {/* Driver */}
                      <TableCell>
                        <div className="flex items-center justify-end gap-1 ml-auto">
                          <span className="text-xs whitespace-nowrap">Show entries:</span>
                          <select 
                            className="h-6 text-xs border rounded px-1 bg-background"
                            value={entriesLimit}
                            onChange={(e) => setEntriesLimit(Number(e.target.value))}
                            aria-label="Number of entries to display"
                          >
                            <option value={15}>15</option>
                            <option value={25}>25</option>
                            <option value={50}>50</option>
                            <option value={100}>100</option>
                          </select>
                        </div>
                      </TableCell>
                    </TableRow>
                  )}
                  
                  <TableRow>
                    <TableCell colSpan={10} className="text-center py-2">
                      <div className="flex items-center justify-between">
                        <div className="text-sm text-muted-foreground">
                          Showing {getSortedSlips().length > 0 ? (currentPage - 1) * entriesLimit + 1 : 0} to {Math.min(currentPage * entriesLimit, getFilteredSlips().length)} of {getFilteredSlips().length} entries
                        </div>
                        <div className="flex items-center space-x-2">
                          <Button
                            variant="outline"
                            size="sm"
                            onClick={() => setCurrentPage(1)}
                            disabled={currentPage === 1}
                          >
                            <ChevronFirst className="h-4 w-4" />
                          </Button>
                          <Button
                            variant="outline"
                            size="sm"
                            onClick={() => setCurrentPage(prev => Math.max(1, prev - 1))}
                            disabled={currentPage === 1}
                          >
                            <ChevronLeft className="h-4 w-4" />
                          </Button>
                          <span className="text-sm text-muted-foreground px-2">
                            Page {currentPage} of {getTotalPages()}
                          </span>
                          <Button
                            variant="outline"
                            size="sm"
                            onClick={() => setCurrentPage(prev => Math.min(getTotalPages(), prev + 1))}
                            disabled={currentPage === getTotalPages()}
                          >
                            <ChevronRight className="h-4 w-4" />
                          </Button>
                          <Button
                            variant="outline"
                            size="sm"
                            onClick={() => setCurrentPage(getTotalPages())}
                            disabled={currentPage === getTotalPages()}
                          >
                            <ChevronLast className="h-4 w-4" />
                          </Button>
                        </div>
                      </div>
                    </TableCell>
                  </TableRow>
                </TableFooter>
              </Table>
            </div>
          ) : (
            <div className="text-center py-8 text-muted-foreground">
              No proforma slips found. Create your first one!
            </div>
          )}
        </CardContent>
      </Card>
      
      {/* New Proforma Slip Dialog */}
      <Dialog open={isNewSlipDialogOpen} onOpenChange={setIsNewSlipDialogOpen}>
        <DialogContent className="sm:max-w-[600px]">
          <DialogHeader>
            <DialogTitle>Create New Proforma Slip</DialogTitle>
            <DialogDescription>
              Fill in the details to create a new proforma slip.
            </DialogDescription>
          </DialogHeader>
          <Form {...newSlipForm}>
            <form onSubmit={newSlipForm.handleSubmit(handleCreateSlip)} className="space-y-4">
              <div className="grid grid-cols-2 gap-4">
                <FormField
                  control={newSlipForm.control}
                  name="orderDate"
                  render={({ field }) => (
                    <FormItem>
                      <FormLabel>Order Date</FormLabel>
                      <FormControl>
                        <Input type="date" {...field} />
                      </FormControl>
                      <FormMessage />
                    </FormItem>
                  )}
                />
                <FormField
                  control={newSlipForm.control}
                  name="orderNumber"
                  render={({ field }) => (
                    <FormItem>
                      <FormLabel>Order Number</FormLabel>
                      <FormControl>
                        <div className="relative">
                          <span className="absolute left-3 top-1/2 -translate-y-1/2 text-gray-500">#</span>
                          <Input {...field} className="pl-6" />
                        </div>
                      </FormControl>
                      <FormMessage />
                    </FormItem>
                  )}
                />
              </div>
              
              <div className="grid grid-cols-2 gap-4">
                <FormField
                  control={newSlipForm.control}
                  name="partyName"
                  render={({ field }) => (
                    <FormItem>
                      <FormLabel>Party Name</FormLabel>
                      <FormControl>
                        <Input {...field} />
                      </FormControl>
                      <FormMessage />
                    </FormItem>
                  )}
                />
                <FormField
                  control={newSlipForm.control}
                  name="plant"
                  render={({ field }) => (
                    <FormItem>
                      <FormLabel>Plant</FormLabel>
                      <FormControl>
                        <Select
                          onValueChange={field.onChange}
                          defaultValue={field.value}
                        >
                          <SelectTrigger>
                            <SelectValue placeholder="Select a plant" />
                          </SelectTrigger>
                          <SelectContent>
                            {dbPlants && dbPlants.length > 0 ? (
                              dbPlants.map((plant) => (
                                <SelectItem key={plant.id} value={plant.name}>
                                  <div className="flex items-center gap-2">
                                    <div 
                                      className="w-3 h-3 rounded-full" 
                                      style={{ backgroundColor: plant.bgColor }}
                                    />
                                    {plant.name}
                                  </div>
                                </SelectItem>
                              ))
                            ) : (
                              <SelectItem value="" disabled>No plants configured</SelectItem>
                            )}
                          </SelectContent>
                        </Select>
                      </FormControl>
                      <FormMessage />
                    </FormItem>
                  )}
                />
              </div>
              
              <div className="grid grid-cols-2 gap-4">
                <FormField
                  control={newSlipForm.control}
                  name="totalVolume"
                  render={({ field }) => (
                    <FormItem>
                      <FormLabel>Total Volume</FormLabel>
                      <FormControl>
                        <Input {...field} />
                      </FormControl>
                      <FormMessage />
                    </FormItem>
                  )}
                />
                <FormField
                  control={newSlipForm.control}
                  name="totalQuantity"
                  render={({ field }) => (
                    <FormItem>
                      <FormLabel>Total Quantity</FormLabel>
                      <FormControl>
                        <Input type="number" {...field} onChange={(e) => field.onChange(parseInt(e.target.value) ?? 0)} />
                      </FormControl>
                      <FormMessage />
                    </FormItem>
                  )}
                />
              </div>
              
              <div className="grid grid-cols-2 gap-4">
                <FormField
                  control={newSlipForm.control}
                  name="vehicleNumber"
                  render={({ field }) => (
                    <FormItem>
                      <FormLabel>Vehicle Number</FormLabel>
                      <FormControl>
                        <Input {...field} />
                      </FormControl>
                      <FormMessage />
                    </FormItem>
                  )}
                />
                <FormField
                  control={newSlipForm.control}
                  name="driverName"
                  render={({ field }) => (
                    <FormItem>
                      <FormLabel>Driver Name</FormLabel>
                      <FormControl>
                        <Input {...field} />
                      </FormControl>
                      <FormMessage />
                    </FormItem>
                  )}
                />
              </div>
              
              <div className="grid grid-cols-2 gap-4">
                <FormField
                  control={newSlipForm.control}
                  name="createdById"
                  render={({ field }) => (
                    <FormItem>
                      <FormLabel>Created By</FormLabel>
                      <FormControl>
                        <Input type="number" {...field} disabled />
                      </FormControl>
                      <FormMessage />
                    </FormItem>
                  )}
                />
                <FormField
                  control={newSlipForm.control}
                  name="notes"
                  render={({ field }) => (
                    <FormItem>
                      <FormLabel>Notes</FormLabel>
                      <FormControl>
                        <Textarea {...field} />
                      </FormControl>
                      <FormMessage />
                    </FormItem>
                  )}
                />
              </div>
              
              <DialogFooter>
                <Button type="submit" disabled={createProformaSlipMutation.isPending}>
                  {createProformaSlipMutation.isPending ? "Creating..." : "Create Proforma Slip"}
                </Button>
              </DialogFooter>
            </form>
          </Form>
        </DialogContent>
      </Dialog>
      
      {/* Edit Proforma Slip Dialog */}
      <Dialog open={isEditSlipDialogOpen} onOpenChange={setIsEditSlipDialogOpen}>
        <DialogContent className="sm:max-w-[600px]">
          <DialogHeader>
            <DialogTitle>Edit Proforma Slip</DialogTitle>
            <DialogDescription>
              Update the details of the proforma slip.
            </DialogDescription>
          </DialogHeader>
          <Form {...editSlipForm}>
            <form onSubmit={editSlipForm.handleSubmit(handleEditSlip)} className="space-y-4">
              <div className="grid grid-cols-2 gap-4">
                <FormField
                  control={editSlipForm.control}
                  name="orderDate"
                  render={({ field }) => (
                    <FormItem>
                      <FormLabel>Order Date</FormLabel>
                      <FormControl>
                        <Input type="date" {...field} />
                      </FormControl>
                      <FormMessage />
                    </FormItem>
                  )}
                />
                <FormField
                  control={editSlipForm.control}
                  name="orderNumber"
                  render={({ field }) => (
                    <FormItem>
                      <FormLabel>Order Number</FormLabel>
                      <FormControl>
                        <div className="relative">
                          <span className="absolute left-3 top-1/2 -translate-y-1/2 text-gray-500">#</span>
                          <Input {...field} className="pl-6" />
                        </div>
                      </FormControl>
                      <FormMessage />
                    </FormItem>
                  )}
                />
              </div>
              
              <div className="grid grid-cols-2 gap-4">
                <FormField
                  control={editSlipForm.control}
                  name="partyName"
                  render={({ field }) => (
                    <FormItem>
                      <FormLabel>Party Name</FormLabel>
                      <FormControl>
                        <Input {...field} />
                      </FormControl>
                      <FormMessage />
                    </FormItem>
                  )}
                />
                <FormField
                  control={editSlipForm.control}
                  name="plant"
                  render={({ field }) => (
                    <FormItem>
                      <FormLabel>Plant</FormLabel>
                      <FormControl>
                        <Select
                          onValueChange={field.onChange}
                          defaultValue={field.value}
                        >
                          <SelectTrigger>
                            <SelectValue placeholder="Select a plant" />
                          </SelectTrigger>
                          <SelectContent>
                            {dbPlants && dbPlants.length > 0 ? (
                              dbPlants.map((plant) => (
                                <SelectItem key={plant.id} value={plant.name}>
                                  <div className="flex items-center gap-2">
                                    <div 
                                      className="w-3 h-3 rounded-full" 
                                      style={{ backgroundColor: plant.bgColor }}
                                    />
                                    {plant.name}
                                  </div>
                                </SelectItem>
                              ))
                            ) : (
                              <SelectItem value="" disabled>No plants configured</SelectItem>
                            )}
                          </SelectContent>
                        </Select>
                      </FormControl>
                      <FormMessage />
                    </FormItem>
                  )}
                />
              </div>
              
              <div className="grid grid-cols-2 gap-4">
                <FormField
                  control={editSlipForm.control}
                  name="totalVolume"
                  render={({ field }) => (
                    <FormItem>
                      <FormLabel>Total Volume</FormLabel>
                      <FormControl>
                        <Input {...field} />
                      </FormControl>
                      <FormMessage />
                    </FormItem>
                  )}
                />
                <FormField
                  control={editSlipForm.control}
                  name="totalQuantity"
                  render={({ field }) => (
                    <FormItem>
                      <FormLabel>Total Quantity</FormLabel>
                      <FormControl>
                        <Input type="number" {...field} onChange={(e) => field.onChange(parseInt(e.target.value) ?? 0)} />
                      </FormControl>
                      <FormMessage />
                    </FormItem>
                  )}
                />
              </div>
              
              <div className="grid grid-cols-2 gap-4">
                <FormField
                  control={editSlipForm.control}
                  name="vehicleNumber"
                  render={({ field }) => (
                    <FormItem>
                      <FormLabel>Vehicle Number</FormLabel>
                      <FormControl>
                        <Input {...field} />
                      </FormControl>
                      <FormMessage />
                    </FormItem>
                  )}
                />
                <FormField
                  control={editSlipForm.control}
                  name="driverName"
                  render={({ field }) => (
                    <FormItem>
                      <FormLabel>Driver Name</FormLabel>
                      <FormControl>
                        <Input {...field} />
                      </FormControl>
                      <FormMessage />
                    </FormItem>
                  )}
                />
              </div>
              
              <FormField
                control={editSlipForm.control}
                name="notes"
                render={({ field }) => (
                  <FormItem>
                    <FormLabel>Notes</FormLabel>
                    <FormControl>
                      <Textarea {...field} />
                    </FormControl>
                    <FormMessage />
                  </FormItem>
                )}
              />
              
              <DialogFooter>
                <Button type="submit" disabled={updateProformaSlipMutation.isPending}>
                  {updateProformaSlipMutation.isPending ? "Saving..." : "Save Changes"}
                </Button>
              </DialogFooter>
            </form>
          </Form>
        </DialogContent>
      </Dialog>
      
      {/* Delete Confirmation Dialog */}
      <Dialog open={isDeleteDialogOpen} onOpenChange={setIsDeleteDialogOpen}>
        <DialogContent className="sm:max-w-[425px]">
          <DialogHeader>
            <DialogTitle>Delete Proforma Slip</DialogTitle>
            <DialogDescription>
              Are you sure you want to delete this proforma slip? This action cannot be undone.
            </DialogDescription>
          </DialogHeader>
          <div className="py-4">
            {selectedSlip && (
              <div className="space-y-2">
                <div className="grid grid-cols-2 gap-1">
                  <div className="text-sm font-medium">Order Number:</div>
                  <div>#{selectedSlip.orderNumber}</div>
                </div>
                <div className="grid grid-cols-2 gap-1">
                  <div className="text-sm font-medium">Party Name:</div>
                  <div>{selectedSlip.partyName}</div>
                </div>
                <div className="grid grid-cols-2 gap-1">
                  <div className="text-sm font-medium">Order Date:</div>
                  <div>
                    {selectedSlip.orderDate ? (
                      (() => {
                        try {
                          if (typeof selectedSlip.orderDate === 'string' && selectedSlip.orderDate.includes('/')) {
                            return selectedSlip.orderDate;
                          } else {
                            return format(new Date(selectedSlip.orderDate), 'dd/MM/yyyy');
                          }
                        } catch (error) {
                          return String(selectedSlip.orderDate);
                        }
                      })()
                    ) : ' '}
                  </div>
                </div>
              </div>
            )}
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setIsDeleteDialogOpen(false)}>
              Cancel
            </Button>
            <Button 
              variant="destructive" 
              onClick={() => selectedSlip && deleteProformaSlipMutation.mutate(selectedSlip.id)}
              disabled={deleteProformaSlipMutation.isPending}
            >
              {deleteProformaSlipMutation.isPending ? "Deleting..." : "Delete"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
      
      {/* Multiple Delete Confirmation Dialog */}
      <Dialog open={isMultipleDeleteDialogOpen} onOpenChange={setIsMultipleDeleteDialogOpen}>
        <DialogContent className="sm:max-w-[425px]">
          <DialogHeader>
            <DialogTitle>Delete Multiple Proforma Slips</DialogTitle>
            <DialogDescription>
              Are you sure you want to delete {selectedSlipIds.length} proforma slip(s)? This action cannot be undone.
            </DialogDescription>
          </DialogHeader>
          <div className="py-4">
            <div className="max-h-[200px] overflow-y-auto border rounded-md p-2">
              <ul className="space-y-1 text-sm">
                {proformaSlips?.filter(slip => selectedSlipIds.includes(slip.id)).map(slip => (
                  <li key={slip.id} className="flex justify-between border-b pb-1 last:border-0">
                    <span>#{slip.orderNumber}</span>
                    <span className="text-muted-foreground">{slip.partyName}</span>
                  </li>
                ))}
              </ul>
            </div>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setIsMultipleDeleteDialogOpen(false)}>
              Cancel
            </Button>
            <Button 
              variant="destructive"
              onClick={() => {
                if (selectedSlipIds.length > 0) {
                  deleteMultipleProformaSlipsMutation.mutate(selectedSlipIds);
                }
              }}
              disabled={deleteMultipleProformaSlipsMutation.isPending}
            >
              {deleteMultipleProformaSlipsMutation.isPending ? "Deleting..." : "Delete All Selected"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}