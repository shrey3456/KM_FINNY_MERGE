import React, { useState, useEffect, useRef, useMemo } from "react";
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
import { DataTable, DataTableColumnToggle, DATA_TABLE_TOTALS_ROW, type DataTableColumn, type DataTableFooterContext } from "@/components/ui/data-table";
import { toast } from "@/hooks/use-toast";
import { apiRequest, queryClient } from "@/lib/queryClient";
import { hasPageWriteAccess } from "@/lib/permissions";
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
  Calendar as CalendarIcon,
  CalendarDays,
  FilterX,
  FileText,
  Calculator,
  RefreshCw,
  ListFilter,
} from "lucide-react";
import { format, isWithinInterval, startOfDay, endOfDay, parseISO } from "date-fns";
import { type ProformaSlip, type ProformaSlipItem, type Product } from "@shared/schema";
import { PlantBadge } from "@/components/PlantBadge";
import { ColumnFilterPopoverContent, ColumnHeaderFilterButton } from "@/components/filters/ColumnFilterChip";
import { CollapsibleSearch } from "@/components/ui/collapsible-search";
import { type FilterableColumn, type FilterCondition, conditionSummary, isConditionEmpty, matchAllConditions } from "@/lib/columnFilters";

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

// Solid navy fill, matching the Product Master action buttons (Import CSV / Export / Sync Notion).
const FILTER_BTN_CLASS = "h-8 border-0 bg-[#001d6e] text-white hover:bg-[#001552] hover:text-white text-xs";

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

// Filters survive leaving the page and coming back. They live in component state, so navigating
// away used to drop whatever you had narrowed the table to, and you had to set it all up again.
//
// sessionStorage rather than localStorage on purpose: a filter is working context, not a saved
// preference. Keeping it for the life of the tab matches "I'll go look at something else and come
// straight back"; keeping it forever would mean opening the app tomorrow to a table that's
// mysteriously filtered, with no memory of having done it.
const SLIP_FILTERS_KEY = "proformaSlips:filters";

type SavedSlipFilters = {
  search?: string;
  plant?: string;
  date?: string;
  conditions?: Record<string, FilterCondition>;
};

function readSavedSlipFilters(): SavedSlipFilters {
  try {
    return JSON.parse(sessionStorage.getItem(SLIP_FILTERS_KEY) ?? "{}") as SavedSlipFilters;
  } catch {
    // Corrupt or unreadable (private-mode storage throws) — start clean rather than break the page.
    return {};
  }
}

/**
 * Which page numbers a pager should offer, given the current page and how many there are — all of
 * them when they fit, otherwise the first, the last, a window around the current page, and "gap"
 * where the run is broken. Both indexes are 0-based, matching DataTable's own pageIndex.
 *
 * e.g. page 1 of 442 → 1 2 3 … 442, and page 10 → 1 … 9 10 11 … 442.
 */
function buildPageList(pageIndex: number, pageCount: number, window = 1): Array<number | "gap"> {
  // Small enough to list in full — an ellipsis is never narrower than just showing the numbers.
  const maxWithoutGaps = window * 2 + 5;
  if (pageCount <= maxWithoutGaps) return Array.from({ length: pageCount }, (_, i) => i);

  const last = pageCount - 1;
  // Near either end the window would be clipped by the edge, leaving a stubby "1 2 … 442". Extend
  // it inward instead so the run of numbers stays the same length wherever you are.
  let from: number;
  let to: number;
  if (pageIndex <= window) {
    from = 1;
    to = Math.min(last - 1, window * 2);
  } else if (pageIndex >= last - window) {
    from = Math.max(1, last - window * 2);
    to = last - 1;
  } else {
    from = pageIndex - window;
    to = pageIndex + window;
  }

  const pages: Array<number | "gap"> = [0];
  // A gap standing in for a single page would take as much room as the page itself, so only use
  // one where at least two pages are actually being hidden — otherwise show that page.
  if (from > 2) pages.push("gap");
  else if (from === 2) pages.push(1);
  for (let i = from; i <= to; i++) pages.push(i);
  if (to < last - 2) pages.push("gap");
  else if (to === last - 2) pages.push(last - 1);
  pages.push(last);
  return pages;
}

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
  const [slipSearchQuery, setSlipSearchQuery] = useState(() => readSavedSlipFilters().search ?? '');
  const [filteredProducts, setFilteredProducts] = useState<Product[] | null>(null);
  const [searchFocused, setSearchFocused] = useState(false);
  const [selectedSlipIds, setSelectedSlipIds] = useState<number[]>([]);
  const [isMultipleDeleteDialogOpen, setIsMultipleDeleteDialogOpen] = useState(false);
  const [sortConfig, setSortConfig] = useState<{column: string, direction: 'asc' | 'desc'}>({
    column: 'orderNumber',
    direction: 'asc'
  });

  const [visibleColumnIds, setVisibleColumnIds] = useState<Set<string>>(
    () => new Set(['orderDate', 'orderNumber', 'partyName', 'plant', 'totalQuantity', 'totalVolume', 'vehicleNumber', 'driverName', 'actions']),
  );
  
  // Function to handle sorting by column
  const handleSort = (column: string) => {
    setSortConfig(prev => ({
      column,
      direction: prev.column === column && prev.direction === 'desc' ? 'asc' : 'desc'
    }));
  };
  
  // ── Filters — same model as Overall Stock ────────────────────────────────────
  // Plant is a tab strip (single active plant, "" = All). Date is its own standalone control
  // (single day "d:YYYY-MM-DD" or range "r:from:to", both editable, plus quick-range presets).
  // Every other column gets an Excel-style per-column filter via the shared column-filter engine.
  // Seeded from whatever was left applied last time this page was open — see SLIP_FILTERS_KEY.
  const [activePlantTab, setActivePlantTab] = useState<string>(() => readSavedSlipFilters().plant ?? "");
  const [dateValue, setDateValue] = useState<string>(() => readSavedSlipFilters().date ?? "");
  const [dateOpen, setDateOpen] = useState(false);
  const [datePickMode, setDatePickMode] = useState<"single" | "range">("single");
  const [columnConditions, setColumnConditions] = useState<Record<string, FilterCondition>>(
    () => readSavedSlipFilters().conditions ?? {},
  );
  const [filterPickerOpen, setFilterPickerOpen] = useState(false);
  const [filterPickerKey, setFilterPickerKey] = useState("");
  const [filterPickerSearch, setFilterPickerSearch] = useState("");

  const { from: fromStr, to: toStr } = (() => {
    if (dateValue.startsWith("d:")) { const d = dateValue.slice(2); return { from: d, to: d }; }
    if (dateValue.startsWith("r:")) { const [, f, t] = dateValue.split(":"); return { from: f ?? "", to: t ?? "" }; }
    return { from: "", to: "" };
  })();
  const dateIsRange = dateValue.startsWith("r:");
  const isoOf = (x: Date) => format(x, "yyyy-MM-dd");
  const datePresetValue = (key: string): string => {
    const d = new Date();
    if (key === "today") return `d:${isoOf(d)}`;
    if (key === "yday") { const y = new Date(d); y.setDate(y.getDate() - 1); return `d:${isoOf(y)}`; }
    if (key === "week") { const w = new Date(d); w.setDate(w.getDate() - 6); return `r:${isoOf(w)}:${isoOf(d)}`; }
    if (key === "month") return `r:${isoOf(new Date(d.getFullYear(), d.getMonth(), 1))}:${isoOf(d)}`;
    return "";
  };
  const DATE_PRESETS = [
    { value: "today", label: "Today" },
    { value: "yday", label: "Yesterday" },
    { value: "week", label: "This week" },
    { value: "month", label: "This month" },
  ];
  const describeDate = (v: string) => {
    if (v.startsWith("d:")) { try { return format(new Date(v.slice(2)), "MMM d, yyyy"); } catch { return v.slice(2); } }
    if (v.startsWith("r:")) { const [, f, t] = v.split(":"); const fmt = (s: string) => { try { return s ? format(new Date(s), "MMM d") : "…"; } catch { return s || "…"; } }; return `${fmt(f)} → ${fmt(t)}`; }
    return v;
  };
  const setColumnCondition = (columnId: string, condition: FilterCondition) =>
    setColumnConditions((prev) => ({ ...prev, [columnId]: condition }));
  const clearColumnCondition = (columnId: string) =>
    setColumnConditions((prev) => { const next = { ...prev }; delete next[columnId]; return next; });
  
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
  const userDept = String(currentUserInfo?.department || '').toLowerCase().trim();
  const userDesig = String(currentUserInfo?.designation || '').toLowerCase().trim();

  // Write access to Proforma Slips is granted per-page by admin (Allowed Pages /
  // Write Access on the User Management page) rather than by department/designation.
  const isReadWriteUser = hasPageWriteAccess("proforma");
  const isread = !hasPageWriteAccess("proforma") && !isAdminOrSuper;

  // Adding, editing, deleting a slip, and adding/editing/deleting its line items are all
  // ONE permission — Write Access to "proforma" (or admin/super-admin). No more separate
  // canAddSlips/canEditSlips (they were always the same check under two different names).
  const canWriteSlips = isAdminOrSuper || isReadWriteUser;

  // Lock/Unlock: admin/super-admin, OR Write Access to BOTH "print-operations" AND
  // "proforma" — needs both page grants, not just one. No more department/designation
  // special-casing (IT/Management/Billing-Head are gone — grant Write Access on both of
  // those page keys instead).
  const canLockUnlockSlips = isAdminOrSuper || (hasPageWriteAccess('print-operations') && hasPageWriteAccess('proforma'));

  console.log('DEBUG PROFORMA PERMISSIONS:', {
    source: remoteUser ? 'remote' : 'local',
    role: currentUserRole,
    dept: userDept,
    desig: userDesig,
    isAdminOrSuper,
    isReadWriteUser,
    canLockUnlockSlips,
    canWriteSlips,
  });

  // Plant tab options (name + configured colors), derived from the loaded slips + Plant Management.
  const [plantOptions, setPlantOptions] = useState<Array<{value: string; label: string; bgColor?: string; textColor?: string; borderColor?: string}>>([]);
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
    queryKey: ['/api/proforma-slips', fromStr, toStr],
    queryFn: async () => {
      // Base URL with high limit (100000) to tell the server we want all proforma slips
      let url = `/api/proforma-slips?limit=100000&_t=${Date.now()}`;
      // Date window (from the standalone Date control) narrows the payload server-side; the
      // client re-filters too (it parses every stored orderDate format), so this is just an
      // optimization, not the source of truth.
      if (fromStr) url += `&startOrderDate=${fromStr}`;
      if (toStr)   url += `&endOrderDate=${toStr}`;

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
      
      // Convert to array of option objects, attaching each plant's configured colors (matched
      // by name, case-insensitively) from Plant Management so the filter shows the same styling.
      const colorByName = new Map((dbPlants ?? []).map((p) => [p.name.toUpperCase(), p]));
      const plantOptionsList = Array.from(plants).map(plant => {
        const c = colorByName.get(plant.toUpperCase());
        return {
          value: plant,
          label: plant,
          bgColor: c?.bgColor,
          textColor: c?.textColor,
          borderColor: c?.borderColor,
        };
      });

      // Sort alphabetically
      plantOptionsList.sort((a, b) => a.label.localeCompare(b.label));

      setPlantOptions(plantOptionsList);
    }
  }, [proformaSlips, dbPlants]);
  
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
  
  // Excel-style per-column filters — every column except Plant (tab strip) and Order Date (its
  // own Date control). Options are the column's own distinct values, same as Overall Stock.
  const filterableColumns: FilterableColumn<LockedProformaSlip>[] = useMemo(() => {
    const slips = (proformaSlips ?? []) as LockedProformaSlip[];
    const textOptions = (pick: (s: LockedProformaSlip) => string | null | undefined) =>
      Array.from(new Set(slips.map(pick).filter((v): v is string => !!v)))
        .sort((a, b) => a.localeCompare(b))
        .map((v) => ({ value: v, label: v }));
    const numberOptions = (pick: (s: LockedProformaSlip) => number | null | undefined) =>
      Array.from(new Set(slips.map(pick).filter((v): v is number => v != null)))
        .sort((a, b) => a - b)
        .map((v) => ({ value: String(v), label: v.toLocaleString() }));
    return [
      { id: "orderNumber", label: "Order No.", filterType: "text", options: textOptions((s) => s.orderNumber), accessor: (s) => s.orderNumber },
      { id: "partyName", label: "Party Name", filterType: "enum", options: textOptions((s) => s.partyName), accessor: (s) => s.partyName },
      { id: "totalQuantity", label: "Total Qty", filterType: "number", options: numberOptions((s) => s.totalQuantity), accessor: (s) => s.totalQuantity ?? null },
      { id: "totalVolume", label: "Total Volume", filterType: "text", options: textOptions((s) => s.totalVolume), accessor: (s) => s.totalVolume },
      { id: "vehicleNumber", label: "Vehicle No.", filterType: "text", options: textOptions((s) => s.vehicleNumber), accessor: (s) => s.vehicleNumber },
      { id: "driverName", label: "Driver", filterType: "text", options: textOptions((s) => s.driverName), accessor: (s) => s.driverName },
    ];
  }, [proformaSlips]);

  const filterPickerOptions = useMemo(() => {
    // Already-filtered columns are left OUT of this list: "+ Filter" adds a new one, while
    // changing or removing an existing filter happens in the "Filters (N)" dropdown, which lists
    // them all and opens each one's builder pre-filled.
    const q = filterPickerSearch.trim().toLowerCase();
    return filterableColumns
      .filter((c) => !columnConditions[c.id])
      .filter((c) => !q || c.label.toLowerCase().includes(q))
      .map((c) => ({ key: c.id, label: c.label }));
  }, [filterableColumns, columnConditions, filterPickerSearch]);
  const pickedFilterColumn = filterableColumns.find((c) => c.id === filterPickerKey) ?? null;

  // The "Filters (N)" popover doubles as the editor: it lists everything applied, and drilling
  // into one swaps the list for that filter's own builder (editFilterKey), with a Back link — a
  // drill-down inside the same popover rather than a popover within a popover.
  const [editFilterOpen, setEditFilterOpen] = useState(false);
  const [editFilterKey, setEditFilterKey] = useState("");
  const editFilterColumn = filterableColumns.find((c) => c.id === editFilterKey) ?? null;

  const columnConditionList = useMemo(() => Object.values(columnConditions), [columnConditions]);

  // Renders a column header's label plus its Excel-style filter icon (for filterable columns).
  const columnHeader = (id: string, label: string) => {
    const col = filterableColumns.find((c) => c.id === id);
    if (!col) return label;
    return (
      <span className="inline-flex items-center gap-1">
        {label}
        <ColumnHeaderFilterButton
          column={col}
          condition={columnConditions[id]}
          onChange={(c) => setColumnCondition(id, c)}
          onRemove={() => clearColumnCondition(id)}
        />
      </span>
    );
  };

  // Slip's order date within the active Date-control window (inclusive), parsing whatever format
  // it's stored in. yyyy-MM-dd string comparison keeps date ordering correct.
  const slipInDateRange = (slip: ProformaSlip): boolean => {
    if (!fromStr && !toStr) return true;
    const d = parseSlipDate(slip.orderDate);
    if (!d) return false;
    const day = isoOf(d);
    if (fromStr && day < fromStr) return false;
    if (toStr && day > toStr) return false;
    return true;
  };

  const getFilteredSlips = () => {
    if (!proformaSlips) return [];
    const q = slipSearchQuery.trim().toLowerCase();
    return (proformaSlips as LockedProformaSlip[]).filter((slip) => {
      if (q) {
        const hit = [slip.orderNumber, slip.partyName, slip.plant, slip.vehicleNumber, slip.driverName]
          .some((v) => v && v.toLowerCase().includes(q));
        if (!hit) return false;
      }
      if (activePlantTab && (slip.plant ?? "").toUpperCase() !== activePlantTab.toUpperCase()) return false;
      if (!slipInDateRange(slip)) return false;
      if (!matchAllConditions(slip, columnConditionList, filterableColumns)) return false;
      return true;
    });
  };
  
  // Pagination state variable
  const [currentPage, setCurrentPage] = useState(1);
  const [entriesLimit, setEntriesLimit] = useState<number>(15);

  // Calculate total number of pages based on entries limit
  const getTotalPages = () => Math.ceil(getFilteredSlips().length / entriesLimit);

  // Ensure current page is valid when the entries limit or the filtered set changes — otherwise
  // shrinking either one can leave you stranded on a page that no longer exists.
  useEffect(() => {
    const totalPages = getTotalPages();
    if (totalPages > 0 && currentPage > totalPages) {
      setCurrentPage(totalPages);
    }
  }, [entriesLimit, getFilteredSlips]);

  // Narrowing the list to a different set of slips restarts it — landing on page 4 of a plant you
  // just switched to shows a slice of results with no relation to what you were looking at, and
  // reads as an empty tab whenever the new set is shorter. Covers the plant tabs plus the other
  // controls that re-cut the list: search, the date range, and the column filters.
  useEffect(() => {
    setCurrentPage(1);
  }, [activePlantTab, slipSearchQuery, dateValue, columnConditionList]);

  // Keep the saved copy in step with whatever is applied right now, so coming back to this page
  // restores it. The page number itself is deliberately NOT saved — returning to a filtered table
  // should start at the top of the results, not partway down where you happened to leave off.
  useEffect(() => {
    try {
      sessionStorage.setItem(
        SLIP_FILTERS_KEY,
        JSON.stringify({
          search: slipSearchQuery,
          plant: activePlantTab,
          date: dateValue,
          conditions: columnConditions,
        } satisfies SavedSlipFilters),
      );
    } catch {
      // Storage unavailable (private mode / quota) — the filters just won't outlive the page.
    }
  }, [slipSearchQuery, activePlantTab, dateValue, columnConditions]);

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

    return sortedSlips;
  };

  const renderOrderDate = (slip: LockedProformaSlip) => {
    if (!slip.orderDate) return ' ';
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
  };

  const slipColumns: DataTableColumn<LockedProformaSlip>[] = [
    {
      id: 'orderDate',
      header: 'Order Date',
      sortable: true,
      width: 110,
      render: (slip) => <span className="whitespace-nowrap">{renderOrderDate(slip)}</span>,
    },
    {
      id: 'orderNumber',
      header: columnHeader('orderNumber', 'Order No.'),
      sortable: true,
      width: 130,
      render: (slip) => (
        <div className="flex items-center gap-2 whitespace-nowrap">
          <span>{slip.orderNumber}</span>
          {slip.isPrintLocked ? (
            <span title="Locked after print"><Lock className="h-3.5 w-3.5 text-red-600" /></span>
          ) : (
            <span title="Unlocked"><Unlock className="h-3.5 w-3.5 text-emerald-600 opacity-30" /></span>
          )}
        </div>
      ),
    },
    {
      id: 'partyName',
      header: columnHeader('partyName', 'Party Name'),
      sortable: true,
      width: 160,
      render: (slip) => slip.partyName,
    },
    {
      id: 'plant',
      header: 'Plant',
      sortable: true,
      width: 110,
      render: (slip) => <PlantBadge plant={slip.plant} />,
    },
    {
      id: 'totalQuantity',
      header: columnHeader('totalQuantity', 'Total Qty'),
      sortable: true,
      width: 100,
      align: 'right',
      render: (slip) => (slip.totalQuantity ?? 0),
    },
    {
      id: 'totalVolume',
      header: columnHeader('totalVolume', 'Total Volume'),
      width: 110,
      render: (slip) => slip.totalVolume || ' ',
    },
    {
      id: 'vehicleNumber',
      header: columnHeader('vehicleNumber', 'Vehicle No.'),
      width: 120,
      render: (slip) => slip.vehicleNumber || ' ',
    },
    {
      id: 'driverName',
      header: columnHeader('driverName', 'Driver'),
      width: 120,
      render: (slip) => slip.driverName || ' ',
    },
    {
      id: 'actions',
      header: '',
      width: 60,
      hideable: false,
      preventRowClick: true,
      render: (slip) => (
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

            {canWriteSlips && (
              <DropdownMenuItem onClick={() => openEditDialog(slip)}>
                <FileEdit className="mr-2 h-4 w-4" /> Edit Details
              </DropdownMenuItem>
            )}

            <DropdownMenuItem
              onClick={() => toggleRowExpansion(slip)}
            >
              {canWriteSlips ? (
                <>
                  <Edit className="mr-2 h-4 w-4" /> Manage Items
                </>
              ) : (
                <>
                  <FileText className="mr-2 h-4 w-4" /> View Items
                </>
              )}
            </DropdownMenuItem>

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

            {canWriteSlips && (
              <DropdownMenuItem
                onClick={() => openDeleteDialog(slip)}
                className="text-destructive focus:text-destructive"
              >
                <Trash className="mr-2 h-4 w-4" /> Delete
              </DropdownMenuItem>
            )}
          </DropdownMenuContent>
        </DropdownMenu>
      ),
    },
  ];

  const renderSlipExpandedRow = (rawSlip: ProformaSlip) => {
    const slip = rawSlip as LockedProformaSlip;
    return (
      <div className="px-4 py-3 bg-muted/20">
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

          {canWriteSlips && (
            <div className="rounded-xl border p-4 bg-white">
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
                        product.newSr?.toLowerCase().includes(e.target.value.toLowerCase()) ||
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
                              Sr.No: {product.newSr || ' '} | Barcode: {product.barcode || ' '}
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
              {slipItems[slip.id]?.map((item) => {
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
                      {canWriteSlips ? (
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
                      {canWriteSlips && (
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
                    {canWriteSlips ? "No items in this slip. Use the search bar above to add items." : "No items in this slip."}
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
    );
  };

  const renderSlipFooter = (ctx: DataTableFooterContext) => {
    const filteredSlips = getFilteredSlips();
    // Which columns are ACTUALLY rendering right now — mirrors data-table.tsx's own
    // visibleColumns logic exactly (visibility-toggle set, plus anything hideable:false which
    // always shows regardless) — so a totals cell only ever lands under the column it's meant
    // for, even as columns get hidden/shown via the toggle. Selection adds its own leading
    // (empty) cell when enabled, matching the checkbox column DataTable renders in that case.
    const visibleCols = slipColumns.filter((c) => visibleColumnIds.has(c.id) || c.hideable === false);
    const totalQty = filteredSlips.reduce((sum, slip) => sum + (slip.totalQuantity || 0), 0);
    const uniqueParties = Array.from(new Set(filteredSlips.map((slip) => slip.partyName))).length;
    const uniqueVehicles = Array.from(new Set(filteredSlips.filter((slip) => slip.vehicleNumber).map((slip) => slip.vehicleNumber))).length;
    // A figure with its unit underneath, rather than "6623 slips" run together on one line — the
    // number is what's being read, so it carries the weight and the unit stays a quiet caption.
    const stat = (value: number, unit: string) => (
      <>
        <span className="block text-base font-bold leading-tight tabular-nums text-[#001d6e]">
          {value.toLocaleString()}
        </span>
        <span className="block text-[10px] font-semibold uppercase tracking-wide text-gray-500">{unit}</span>
      </>
    );

    return (
      <TableFooter className="bg-transparent">
        {filteredSlips.length > 0 && (
          // DATA_TABLE_TOTALS_ROW is the app-wide totals look (faint navy wash, heavier rule on
          // top, bold dark figures) — shared so this row matches every other table's.
          <TableRow className={`${DATA_TABLE_TOTALS_ROW} hover:bg-[#f5f6f9]`}>
            {canWriteSlips && <TableCell className="py-2.5"></TableCell>}
            {visibleCols.map((col) => {
              switch (col.id) {
                case 'orderDate':
                  return (
                    <TableCell key={col.id} className="whitespace-nowrap py-2.5 text-sm font-bold uppercase tracking-wide text-gray-900">
                      Total
                    </TableCell>
                  );
                case 'orderNumber':
                  return <TableCell key={col.id} className="whitespace-nowrap py-2.5">{stat(filteredSlips.length, "slips")}</TableCell>;
                case 'partyName':
                  return <TableCell key={col.id} className="whitespace-nowrap py-2.5">{stat(uniqueParties, "parties")}</TableCell>;
                case 'totalQuantity':
                  // Right-aligned to sit under its column's own right-aligned figures.
                  return <TableCell key={col.id} className="py-2.5 text-right">{stat(totalQty, "qty")}</TableCell>;
                case 'vehicleNumber':
                  return <TableCell key={col.id} className="whitespace-nowrap py-2.5">{stat(uniqueVehicles, "vehicles")}</TableCell>;
                default:
                  // Includes 'actions': the entries-per-page control moved down to the pagination
                  // row, where it sits with the other paging controls instead of competing with
                  // the figures for attention.
                  return <TableCell key={col.id} className="py-2.5"></TableCell>;
              }
            })}
          </TableRow>
        )}

        <TableRow>
          <TableCell colSpan={ctx.columnCount} className="text-center py-2">
            {/* Three tracks so the pager sits in the TRUE centre of the row — with a plain
                justify-between it would only be centred when the left-hand text happened to match
                the empty right-hand side. The outer tracks share the leftover space evenly. */}
            <div className="grid grid-cols-1 items-center gap-2 sm:grid-cols-[1fr_auto_1fr]">
              <div className="flex items-center gap-3">
                <div className="text-sm text-muted-foreground">
                  Showing {ctx.totalRows > 0 ? (ctx.pageIndex * ctx.pageSize + 1).toLocaleString() : 0} to {Math.min((ctx.pageIndex + 1) * ctx.pageSize, ctx.totalRows).toLocaleString()} of {ctx.totalRows.toLocaleString()} entries
                </div>
                {/* Rows-per-page — moved out of the totals row so the figures there aren't sharing
                    space with a control, and so it sits with the paging it actually affects. */}
                <label className="flex items-center gap-1.5 text-sm text-muted-foreground">
                  <span className="whitespace-nowrap">Rows</span>
                  <select
                    className="h-7 rounded-md border bg-background px-1.5 text-sm"
                    value={ctx.pageSize}
                    onChange={(e) => ctx.setPageSize(Number(e.target.value))}
                    aria-label="Number of entries to display"
                  >
                    <option value={15}>15</option>
                    <option value={25}>25</option>
                    <option value={50}>50</option>
                    <option value={100}>100</option>
                  </select>
                </label>
              </div>
              {/* Numbered pages rather than a bare "Page 1 of 442": with 442 pages you can now
                  see where you are, step a page at a time, or jump straight to the last one. */}
              <nav className="flex items-center justify-center gap-1" aria-label="Pagination">
                <Button
                  variant="outline"
                  size="sm"
                  className="h-8 w-8 p-0"
                  onClick={() => ctx.setPageIndex(Math.max(0, ctx.pageIndex - 1))}
                  disabled={ctx.pageIndex === 0}
                  aria-label="Previous page"
                >
                  <ChevronLeft className="h-4 w-4" />
                </Button>

                {buildPageList(ctx.pageIndex, ctx.pageCount).map((p, i) =>
                  p === "gap" ? (
                    // Not a button: it stands for pages that aren't offered, so it mustn't look
                    // clickable. aria-hidden keeps it out of the screen-reader page list.
                    <span key={`gap-${i}`} aria-hidden className="px-1 text-sm text-muted-foreground select-none">
                      …
                    </span>
                  ) : (
                    <Button
                      key={p}
                      variant={p === ctx.pageIndex ? "default" : "outline"}
                      size="sm"
                      className={`h-8 min-w-8 px-2 tabular-nums ${
                        p === ctx.pageIndex ? "bg-[#001d6e] text-white hover:bg-[#00154b]" : ""
                      }`}
                      onClick={() => ctx.setPageIndex(p)}
                      aria-label={`Page ${p + 1}`}
                      aria-current={p === ctx.pageIndex ? "page" : undefined}
                    >
                      {p + 1}
                    </Button>
                  ),
                )}

                <Button
                  variant="outline"
                  size="sm"
                  className="h-8 w-8 p-0"
                  onClick={() => ctx.setPageIndex(Math.min(ctx.pageCount - 1, ctx.pageIndex + 1))}
                  disabled={ctx.pageIndex >= ctx.pageCount - 1}
                  aria-label="Next page"
                >
                  <ChevronRight className="h-4 w-4" />
                </Button>
              </nav>

              {/* Balances the left-hand track so the pager above lands dead centre. */}
              <div className="hidden sm:block" />
            </div>
          </TableCell>
        </TableRow>
      </TableFooter>
    );
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
          {canWriteSlips && (
            <Button onClick={() => setIsNewSlipDialogOpen(true)} size="sm">
              <Plus className="mr-2 h-4 w-4" /> New Slip
            </Button>
          )}
        </div>
      </div>

      {/* Plant tabs — single-select (All + each plant), coloured per Plant Management. Sits
          between the page header and the table (same placement as Overall Stock). */}
      {plantOptions.length > 0 && (
        <div className="flex flex-wrap items-center gap-1.5 mb-3">
          <span className="mr-1 text-[11px] font-semibold uppercase tracking-wide text-gray-400">Plant</span>
          <button
            onClick={() => setActivePlantTab("")}
            className={
              activePlantTab === ""
                ? "rounded-full bg-[#001d6e] px-3.5 py-1.5 text-xs font-semibold text-white ring-2 ring-[#001d6e]/30"
                : "rounded-full border border-gray-200 bg-white px-3.5 py-1.5 text-xs font-medium text-gray-600 hover:bg-gray-50"
            }
          >
            All
          </button>
          {plantOptions.map((p) => {
            const isSel = activePlantTab.toUpperCase() === p.value.toUpperCase();
            return (
              <button
                key={p.value}
                onClick={() => setActivePlantTab(p.value)}
                style={p.bgColor ? { backgroundColor: p.bgColor, color: p.textColor, borderColor: p.borderColor } : undefined}
                className={`rounded-full px-3.5 py-1.5 text-xs font-semibold ${
                  p.bgColor ? "border" : "border border-gray-200 bg-white text-gray-600 hover:bg-gray-50"
                } ${isSel ? "ring-2 ring-[#001d6e] ring-offset-1" : ""}`}
              >
                {p.label}
              </button>
            );
          })}
        </div>
      )}

      <Card className="overflow-hidden rounded-xl border-gray-300 shadow-none">
        {/* Header bar — title + search on top, filters directly beneath (matches Product Master) */}
        <div className="bg-white border-b border-gray-200 px-3 sm:px-5 py-3 sm:py-3.5">
          <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-2">
            <div className="flex items-center gap-3">
              <div className="flex h-8 w-8 sm:h-9 sm:w-9 items-center justify-center rounded-full bg-[#001d6e] text-white">
                <FileText className="h-4 w-4 sm:h-5 sm:w-5" />
              </div>
              <div>
                <div className="text-lg sm:text-xl font-bold tracking-tight text-gray-900">Proforma Slips</div>
                <div className="text-xs text-gray-400 leading-none mt-0.5">
                  View and manage all proforma slips. Click on a row to view details.
                </div>
              </div>
            </div>

            {/* Controls — on the same line as the title, pushed right. Collapsible search first,
                then Date, + Filter, active filters, and Columns. */}
            <div className="flex flex-wrap items-center justify-end gap-2">
            {/* Collapsible search — starts as an icon button, click to reveal the input. */}
            <CollapsibleSearch
              value={slipSearchQuery}
              onChange={setSlipSearchQuery}
              placeholder="Search slips by order number or party…"
            />

            {/* Standalone Date control — single date or from/to range + quick-range presets. */}
            <Popover open={dateOpen} onOpenChange={(o) => { setDateOpen(o); if (o) setDatePickMode(dateIsRange ? "range" : "single"); }}>
              <PopoverTrigger asChild>
                <Button
                  size="sm"
                  variant="outline"
                  className={`h-8 gap-1 rounded-md text-xs font-medium ${dateValue ? "border-[#001d6e] bg-[#001d6e]/5 text-[#001d6e]" : "border-gray-300 text-gray-600 hover:bg-gray-50"}`}
                >
                  <CalendarDays className="h-3.5 w-3.5" />
                  {dateValue ? describeDate(dateValue) : "Date"}
                  {dateValue && (
                    <span
                      role="button"
                      aria-label="Clear date"
                      onClick={(e) => { e.stopPropagation(); setDateValue(""); }}
                      className="ml-0.5 rounded p-0.5 hover:bg-[#001d6e]/10"
                    >
                      <X className="h-3 w-3" />
                    </span>
                  )}
                </Button>
              </PopoverTrigger>
              <PopoverContent align="start" sideOffset={6} avoidCollisions={false} className="w-72">
                <div className="space-y-3">
                  <div className="grid grid-cols-2 gap-1.5">
                    {(["single", "range"] as const).map((m) => (
                      <button
                        key={m}
                        type="button"
                        onClick={() => setDatePickMode(m)}
                        className={`rounded-md border px-2 py-1 text-xs font-medium ${
                          datePickMode === m ? "border-[#001d6e] bg-[#001d6e]/5 text-[#001d6e]" : "border-gray-300 text-gray-600 hover:bg-gray-50"
                        }`}
                      >
                        {m === "single" ? "Single date" : "Date range"}
                      </button>
                    ))}
                  </div>
                  {datePickMode === "single" ? (
                    <div className="space-y-1">
                      <label className="text-[11px] font-semibold uppercase tracking-wide text-gray-500">Date</label>
                      <input
                        type="date"
                        value={fromStr}
                        onChange={(e) => { setDateValue(e.target.value ? `d:${e.target.value}` : ""); if (e.target.value) setDateOpen(false); }}
                        className="h-8 w-full rounded-md border border-gray-300 bg-white px-2 text-xs"
                      />
                    </div>
                  ) : (
                    <div className="grid grid-cols-2 gap-2">
                      <div className="space-y-1">
                        <label className="text-[11px] font-semibold uppercase tracking-wide text-gray-500">From</label>
                        <input type="date" value={fromStr} max={toStr || undefined} onChange={(e) => setDateValue(`r:${e.target.value}:${toStr}`)} className="h-8 w-full rounded-md border border-gray-300 bg-white px-2 text-xs" />
                      </div>
                      <div className="space-y-1">
                        <label className="text-[11px] font-semibold uppercase tracking-wide text-gray-500">To</label>
                        <input type="date" value={toStr} min={fromStr || undefined} onChange={(e) => setDateValue(`r:${fromStr}:${e.target.value}`)} className="h-8 w-full rounded-md border border-gray-300 bg-white px-2 text-xs" />
                      </div>
                    </div>
                  )}
                  <div className="space-y-1">
                    <label className="text-[11px] font-semibold uppercase tracking-wide text-gray-500">Quick ranges</label>
                    <div className="grid grid-cols-2 gap-1.5">
                      {DATE_PRESETS.map((o) => (
                        <button
                          key={o.value}
                          type="button"
                          onClick={() => { const v = datePresetValue(o.value); setDateValue(v); setDatePickMode(v.startsWith("r:") ? "range" : "single"); setDateOpen(false); }}
                          className="rounded-md border border-gray-300 px-2 py-1 text-xs text-gray-700 hover:border-[#001d6e]/40 hover:bg-[#001d6e]/5 hover:text-[#001d6e]"
                        >
                          {o.label}
                        </button>
                      ))}
                    </div>
                  </div>
                  {dateValue && (
                    <div className="flex items-center justify-end pt-1">
                      <button type="button" onClick={() => { setDateValue(""); setDateOpen(false); }} className="text-[11px] text-red-500 hover:underline">Clear date</button>
                    </div>
                  )}
                </div>
              </PopoverContent>
            </Popover>

            {/* + Filter — every column except Plant (tab) and Order Date (Date control). */}
            <Popover open={filterPickerOpen} onOpenChange={(open) => { setFilterPickerOpen(open); if (!open) { setFilterPickerKey(""); setFilterPickerSearch(""); } }}>
              <PopoverTrigger asChild>
                <Button size="sm" variant="outline" className="h-8 gap-1 rounded-md border-dashed border-[#001d6e]/40 bg-white text-xs font-medium text-[#001d6e] hover:bg-[#001d6e]/5 hover:text-[#001d6e]">
                  <Plus className="h-3.5 w-3.5" /> Filter
                </Button>
              </PopoverTrigger>
              <PopoverContent align="start" className="w-64">
                {filterPickerKey === "" ? (
                  <div className="space-y-1.5">
                    <Input className="h-8 text-xs" placeholder="Find a filter…" value={filterPickerSearch} onChange={(e) => setFilterPickerSearch(e.target.value)} autoFocus />
                    <div className="max-h-56 overflow-y-auto">
                      {filterPickerOptions.length === 0 ? (
                        <div className="px-2 py-1.5 text-xs text-gray-400">{filterPickerSearch ? "No matches" : "All filters added"}</div>
                      ) : (
                        filterPickerOptions.map((d) => (
                          <button key={d.key} type="button" onClick={() => setFilterPickerKey(d.key)} className="block w-full rounded px-2 py-1.5 text-left text-xs text-gray-700 hover:bg-[#001d6e]/5 hover:text-[#001d6e]">
                            {d.label}
                          </button>
                        ))
                      )}
                    </div>
                  </div>
                ) : pickedFilterColumn ? (
                  <div className="space-y-2">
                    <button type="button" onClick={() => setFilterPickerKey("")} className="flex items-center gap-1 text-[11px] text-gray-400 hover:text-gray-600">
                      <ChevronLeft className="h-3 w-3" /> Back
                    </button>
                    <ColumnFilterPopoverContent
                      column={pickedFilterColumn}
                      onApply={(c) => { setColumnCondition(pickedFilterColumn.id, c); setFilterPickerOpen(false); setFilterPickerKey(""); }}
                      onCancel={() => setFilterPickerKey("")}
                    />
                  </div>
                ) : null}
              </PopoverContent>
            </Popover>

            {/* Active column filters */}
            {Object.keys(columnConditions).length > 0 && (
              <Popover open={editFilterOpen} onOpenChange={(o) => { setEditFilterOpen(o); if (!o) setEditFilterKey(""); }}>
                <PopoverTrigger asChild>
                  <Button size="sm" variant="outline" className={FILTER_BTN_CLASS}>
                    <ListFilter className="h-3.5 w-3.5 mr-1" /> Filters ({Object.keys(columnConditions).length})
                  </Button>
                </PopoverTrigger>
                {/* One place to see AND change every applied filter. */}
                <PopoverContent align="start" className="w-72">
                  {editFilterColumn ? (
                    <div className="space-y-2">
                      <button
                        type="button"
                        onClick={() => setEditFilterKey("")}
                        className="flex items-center gap-1 text-[11px] text-gray-400 hover:text-gray-600"
                      >
                        <ChevronLeft className="h-3 w-3" /> Back to filters
                      </button>
                      <ColumnFilterPopoverContent
                        column={editFilterColumn}
                        initial={columnConditions[editFilterColumn.id]}
                        onApply={(c) => { setColumnCondition(editFilterColumn.id, c); setEditFilterKey(""); }}
                        onClear={() => { clearColumnCondition(editFilterColumn.id); setEditFilterKey(""); }}
                        onCancel={() => setEditFilterKey("")}
                      />
                    </div>
                  ) : (
                    <div className="space-y-1.5">
                      <div className="flex items-center justify-between pb-1">
                        <span className="text-xs font-semibold text-gray-700">Active filters</span>
                        <button type="button" onClick={() => setColumnConditions({})} className="text-[11px] text-red-500 hover:underline">Clear all</button>
                      </div>
                      {Object.entries(columnConditions).map(([columnId, condition]) => (
                        <div key={columnId} className="flex items-center justify-between gap-2 rounded border border-gray-200">
                          {/* The summary itself is the edit control — clicking it opens this
                              filter's builder pre-filled, so it can be changed in place. */}
                          <button
                            type="button"
                            onClick={() => setEditFilterKey(columnId)}
                            className="flex min-w-0 flex-1 items-center gap-1.5 px-2 py-1 text-left text-xs text-gray-700 hover:text-[#001d6e]"
                            title="Edit this filter"
                          >
                            <Pencil className="h-3 w-3 shrink-0 opacity-40" />
                            <span className="truncate">{conditionSummary(condition, filterableColumns)}</span>
                          </button>
                          <button type="button" onClick={() => clearColumnCondition(columnId)} className="mr-2 shrink-0 text-gray-400 hover:text-red-500" aria-label="Remove filter">
                            <X className="h-3 w-3" />
                          </button>
                        </div>
                      ))}
                    </div>
                  )}
                </PopoverContent>
              </Popover>
            )}

            <DataTableColumnToggle
              columns={slipColumns}
              visibleColumnIds={visibleColumnIds}
              onToggleColumn={(id) =>
                setVisibleColumnIds((prev) => {
                  const next = new Set(prev);
                  if (next.has(id)) next.delete(id);
                  else next.add(id);
                  return next;
                })
              }
              onSetAll={(visible) =>
                setVisibleColumnIds(visible ? new Set(slipColumns.map((c) => c.id)) : new Set())
              }
              buttonClassName={FILTER_BTN_CLASS}
            />
            </div>
          </div>
        </div>
        <CardContent className="p-0">
          <DataTable<LockedProformaSlip>
            className="space-y-0"
            containerClassName="rounded-none border-0"
            columns={slipColumns}
            data={getSortedSlips() as LockedProformaSlip[]}
            getRowId={(slip) => String(slip.id)}
            isLoading={isLoading}
            emptyState="No proforma slips found. Create your first one!"
            onRowClick={(slip) => toggleRowExpansion(slip)}
            renderExpandedRow={renderSlipExpandedRow}
            expandedRowId={selectedSlip ? String(selectedSlip.id) : null}
            enableRowSelection={canWriteSlips}
            selectedRowIds={selectedSlipIds.map(String)}
            onSelectedRowIdsChange={(ids) => setSelectedSlipIds(ids.map(Number))}
            renderFooter={renderSlipFooter}
            renderBulkActions={() => (
              <>
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
              </>
            )}
            sortMode="external"
            sortState={{ columnId: sortConfig.column, direction: sortConfig.direction }}
            onSortColumnClick={handleSort}
            // Paginated rather than one long scrolling list, and with no isStickyHeader/maxHeight,
            // so the table has no inner scroll box of its own — matching develop.
            paginationMode="client"
            pageIndex={currentPage - 1}
            onPageIndexChange={(idx) => setCurrentPage(idx + 1)}
            pageSize={entriesLimit}
            onPageSizeChange={setEntriesLimit}
            pageSizeOptions={[15, 25, 50, 100]}
            enableColumnResizing
            enableColumnVisibility
            columnVisibility={visibleColumnIds}
            onColumnVisibilityChange={setVisibleColumnIds}
            showMobileSwipeHint
            enableZebraStripes
            headerClassName="bg-[#001d6e] text-white border-[#1a3a9c] hover:bg-[#0a2b7e] hover:text-white"
          />
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
                              <SelectItem value="__none__" disabled>No plants configured</SelectItem>
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
                              <SelectItem value="__none__" disabled>No plants configured</SelectItem>
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