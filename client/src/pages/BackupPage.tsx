import React, { useState } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { apiRequest } from '@/lib/queryClient';
import { getPermissionsForRole } from '@/lib/permissions';
import { useToast } from '@/hooks/use-toast';
import { useUser } from '../hooks/use-user';
import { format, isValid, parse } from 'date-fns';
import { DateRange } from 'react-day-picker';
import { subDays } from 'date-fns';

// Helper function to safely format dates with multiple format support
const formatSafeDate = (dateStr: string | null | undefined, formatStr: string = 'MMM dd, yyyy'): string => {
  if (!dateStr) return 'N/A';
  
  try {
    // First try to handle date formats like "30-03-25" or "30/03/25"
    const parts = dateStr.toString().split(/[-\/]/);
    if (parts.length === 3) {
      const day = parseInt(parts[0]);
      const month = parseInt(parts[1]) - 1; // Months are 0-indexed in JS Date
      let year = parseInt(parts[2]);
      
      // Handle two-digit years
      if (year < 100) {
        year = year + 2000;
      }
      
      const date = new Date(year, month, day);
      if (isValid(date)) {
        return format(date, formatStr);
      }
    }
    
    // If the above parsing fails, try standard ISO format
    const date = new Date(dateStr);
    if (isValid(date)) {
      return format(date, formatStr);
    }
    
    // If all else fails, return the original string
    return dateStr.toString();
  } catch (e) {
    console.warn('Error parsing date:', dateStr, e);
    return dateStr?.toString() || 'N/A';
  }
};
import { AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent, AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle } from '@/components/ui/alert-dialog';

// For typescript hack to fix apiRequest typing
interface ApiRequestOptions {
  method?: string;
  data?: any;
  headers?: Record<string, string>;
}

interface BackupOperationResult {
  message: string;
  scansBackedUp: number;
  loadingOpsBackedUp: number;
  salesBackedUp: number;
  proformaSlipsBackedUp: number;
}

interface RetentionPolicyResult {
  message: string;
  loadingOpsDeleted: number;
}

// Interface for sale items
interface SaleItemDetails {
  id: number;
  productId: number;
  productName: string;
  name?: string; // Alternative product name property
  srNo?: string; // Serial number
  barcode?: string; // Barcode
  quantity: number;
  price: number;
  unitPrice?: number; // Alternative price property
  category?: string;
  hsn?: string;
}

// State for holding sale items details modal
interface SaleDetailsModalState {
  isOpen: boolean;
  saleId: number | null;
  items: SaleItemDetails[];
  isLoading: boolean;
  saleName: string;
}

// UI Components
import { Card, CardContent, CardDescription, CardFooter, CardHeader, CardTitle } from '@/components/ui/card';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Calendar } from '@/components/ui/calendar';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Switch } from '@/components/ui/switch';
import { Separator } from '@/components/ui/separator';
import { ScrollArea } from '@/components/ui/scroll-area';
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';
import { 
  AlertCircle, 
  Check, 
  Clock, 
  Database, 
  Eye, 
  FileArchive, 
  FileBox, 
  Loader2, 
  Package, 
  RefreshCw, 
  Trash2, 
  Truck 
} from 'lucide-react';
import { 
  Dialog, 
  DialogContent, 
  DialogDescription, 
  DialogHeader, 
  DialogTitle 
} from '@/components/ui/dialog';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover';
// Import the DataTable directly since it's a local component
import { DataTable } from '../components/DataTable';
import { SelectableDataTable } from '../components/SelectableDataTable';
import { SectionSkeleton } from "@/components/ui/loading-skeletons";

interface BackupSettings {
  id: number;
  lastBackupDate: string | Date;
  autoBackupEnabled: boolean;
  backupFrequencyHours: number;
  createdAt: string | Date;
  updatedAt: string | Date;
}

interface ScanHistoryBackup {
  id: number;
  originalId: number;
  barcode: string;
  productId: number | null;
  productName: string | null;
  productSku: string | null;
  scannedById: number | null;
  scannerName: string | null;
  scannerDepartment: string | null;
  scannedAt: string | Date;
  action: string;
  quantity: number;
  notes: string | null;
  backupDate: string | Date;
}

interface LoadingOperationBackup {
  id: number;
  originalId: number;
  status: string;
  referenceNumber: string;
  createdById: number;
  createdAt: string | Date;
  completedAt: string | Date | null;
  notes: string | null;
  backupDate: string | Date;
}

interface SaleBackup {
  id: number;
  originalId: number;
  orderNumber: string;
  date: string | Date;
  dealer: string;
  plant: string;
  status: string;
  quantity: number;
  amount: number;
  createdById: number;
  createdAt: string | Date;
  notes: string | null;
  backupDate: string | Date;
}

export default function BackupPage() {
  const { user } = useUser();
  const { toast } = useToast();
  const queryClient = useQueryClient();
  const [startDate, setStartDate] = useState<Date | undefined>(undefined);
  const [endDate, setEndDate] = useState<Date | undefined>(undefined);
  const [currentTab, setCurrentTab] = useState('settings');
  const [dateRange, setDateRange] = useState<DateRange | undefined>(undefined);
  
  // State for sale items details modal
  const [saleDetailsModal, setSaleDetailsModal] = useState<SaleDetailsModalState>({
    isOpen: false,
    saleId: null,
    items: [],
    isLoading: false,
    saleName: '',
  });
  
  // State for delete confirmation dialog
  const [deleteDialogState, setDeleteDialogState] = useState({
    isOpen: false,
    backupIds: [] as number[],
    message: '',
    title: ''
  });
  
  // State for selected proforma slip backups
  const [selectedProformaSlipBackups, setSelectedProformaSlipBackups] = useState<number[]>([]);
  
  // Get user permissions
  const permissions = getPermissionsForRole(user?.role);
  
  // Fetch backup settings
  const { 
    data: backupSettings,
    isLoading: isLoadingSettings
  } = useQuery({
    queryKey: ['/api/backup/settings'],
    refetchInterval: 60000, // Refresh every minute
    queryFn: async () => {
      try {
        // Use the updated apiRequest with parseJson=true
        const response = await apiRequest('GET', '/api/backup/settings', undefined, false, true) as any;
        return Array.isArray(response) && response.length > 0 ? response[0] : null;
      } catch (error) {
        console.error('Error fetching backup settings:', error);
        return null;
      }
    },
    select: (data: any): BackupSettings | null => {
      // Type cast the response to BackupSettings
      return data as BackupSettings;
    }
  });
  
  // Update backup settings
  const { mutate: updateSettings, isPending: isUpdatingSettings } = useMutation({
    mutationFn: async (updatedSettings: Partial<BackupSettings>) => {
      if (!backupSettings || !backupSettings.id) return null;
      
      // Type assertion to fix the typing issues
      const options = {
        method: 'PUT',
        data: updatedSettings
      } as any;
      
      try {
        const result = await apiRequest(`/api/backup/settings/${backupSettings.id}`, options);
        return result;
      } catch (error) {
        console.error('Error updating backup settings:', error);
        throw error;
      }
    },
    onSuccess: () => {
      queryClient.invalidateQueries({queryKey: ['/api/backup/settings']});
      toast({
        title: 'Settings Updated',
        description: 'Backup settings have been updated successfully.',
        // @ts-ignore - variant in our custom toast component
        variant: 'success'
      });
    },
    onError: () => {
      toast({
        title: 'Error',
        description: 'Failed to update backup settings.',
        variant: 'destructive'
      });
    }
  });
  
  // Run backup operation
  const { mutate: runBackup, isPending: isRunningBackup } = useMutation({
    mutationFn: async () => {
      try {
        // Use the updated apiRequest with parseJson=true
        const data = await apiRequest('POST', '/api/backup/run', undefined, false, true) as any;
        return data as BackupOperationResult;
      } catch (error) {
        console.error('Error running backup:', error);
        throw error;
      }
    },
    onSuccess: (data: BackupOperationResult) => {
      queryClient.invalidateQueries({queryKey: ['/api/backup/settings']});
      queryClient.invalidateQueries({queryKey: ['/api/backup/scans']});
      queryClient.invalidateQueries({queryKey: ['/api/backup/loading-operations']});
      queryClient.invalidateQueries({queryKey: ['/api/backup/sales']});
      queryClient.invalidateQueries({queryKey: ['/api/backup/proforma-slips']});
      
      toast({
        title: 'Backup Completed',
        description: `Backup completed successfully! ${data.scansBackedUp} scans, ${data.loadingOpsBackedUp} loading operations, ${data.salesBackedUp} sales, and ${data.proformaSlipsBackedUp} proforma slips backed up.`,
        // @ts-ignore - variant in our custom toast component
        variant: 'success'
      });
    },
    onError: () => {
      toast({
        title: 'Error',
        description: 'Failed to run backup operation.',
        variant: 'destructive'
      });
    }
  });
  
  // Apply data retention policies
  const { mutate: applyRetentionPolicies, isPending: isApplyingRetentionPolicies } = useMutation({
    mutationFn: async () => {
      try {
        // Use the updated apiRequest with parseJson=true
        const data = await apiRequest('POST', '/api/backup/apply-retention-policies', undefined, false, true) as any;
        return data as RetentionPolicyResult;
      } catch (error) {
        console.error('Error applying retention policies:', error);
        throw error;
      }
    },
    onSuccess: (data: RetentionPolicyResult) => {
      queryClient.invalidateQueries({queryKey: ['/api/backup/loading-operations']});
      
      toast({
        title: 'Retention Policies Applied',
        description: `Successfully applied data retention policies. ${data.loadingOpsDeleted} loading operations deleted.`,
        // @ts-ignore - variant in our custom toast component
        variant: 'success'
      });
    },
    onError: () => {
      toast({
        title: 'Error',
        description: 'Failed to apply data retention policies.',
        variant: 'destructive'
      });
    }
  });
  
  // Fetch backup data based on current tab and date filters
  const {
    data: scanBackups,
    isLoading: isLoadingScans
  } = useQuery({
    queryKey: ['/api/backup/scans', startDate?.toISOString(), endDate?.toISOString()],
    queryFn: async () => {
      const params = new URLSearchParams();
      if (startDate) params.append('startDate', startDate.toISOString());
      if (endDate) params.append('endDate', endDate.toISOString());
      
      // Use the updated apiRequest with parseJson=true
      const data = await apiRequest('GET', `/api/backup/scans?${params.toString()}`, undefined, false, true) as any;
      const result = Array.isArray(data) ? data as ScanHistoryBackup[] : [];
      return result || [];
    },
    select: (data: any) => {
      // Ensure we always return an array
      return Array.isArray(data) ? data : [];
    },
    enabled: currentTab === 'scans'
  });
  
  const {
    data: loadingOpBackups,
    isLoading: isLoadingLoadingOps
  } = useQuery({
    queryKey: ['/api/backup/loading-operations', startDate?.toISOString(), endDate?.toISOString()],
    queryFn: async () => {
      const params = new URLSearchParams();
      if (startDate) params.append('startDate', startDate.toISOString());
      if (endDate) params.append('endDate', endDate.toISOString());
      
      // Use the updated apiRequest with parseJson=true
      const data = await apiRequest('GET', `/api/backup/loading-operations?${params.toString()}`, undefined, false, true) as any;
      const result = Array.isArray(data) ? data as LoadingOperationBackup[] : [];
      return result || [];
    },
    select: (data: any) => {
      // Ensure we always return an array
      return Array.isArray(data) ? data : [];
    },
    enabled: currentTab === 'loading-operations'
  });
  
  const {
    data: saleBackups,
    isLoading: isLoadingSales
  } = useQuery({
    queryKey: ['/api/backup/sales', startDate?.toISOString(), endDate?.toISOString()],
    queryFn: async () => {
      const params = new URLSearchParams();
      if (startDate) params.append('startDate', startDate.toISOString());
      if (endDate) params.append('endDate', endDate.toISOString());
      
      // Use the updated apiRequest with parseJson=true
      const data = await apiRequest('GET', `/api/backup/sales?${params.toString()}`, undefined, false, true) as any;
      const result = Array.isArray(data) ? data as SaleBackup[] : [];
      return result || [];
    },
    select: (data: any) => {
      // Ensure we always return an array
      return Array.isArray(data) ? data : [];
    },
    enabled: currentTab === 'sales'
  });
  
  const {
    data: proformaSlipBackups,
    isLoading: isLoadingProformaSlips
  } = useQuery({
    queryKey: ['/api/backup/proforma-slips', startDate?.toISOString(), endDate?.toISOString()],
    queryFn: async () => {
      const params = new URLSearchParams();
      if (startDate) params.append('startDate', startDate.toISOString());
      if (endDate) params.append('endDate', endDate.toISOString());
      
      // Use the updated apiRequest with parseJson=true
      const data = await apiRequest('GET', `/api/backup/proforma-slips?${params.toString()}`, undefined, false, true) as any;
      const result = Array.isArray(data) ? data : [];
      return result || [];
    },
    select: (data: any) => {
      // Ensure we always return an array
      return Array.isArray(data) ? data : [];
    },
    enabled: currentTab === 'proforma-slips'
  });
  
  // Prepare scan history data table columns
  const scanColumns = [
    {
      accessorKey: 'barcode',
      header: 'Barcode'
    },
    {
      accessorKey: 'productName',
      header: 'Product'
    },
    {
      accessorKey: 'action',
      header: 'Action',
      cell: ({ row }: any) => {
        const action = row.getValue('action');
        return (
          <Badge
            variant={
              action === 'add' ? 'success' : 
              action === 'remove' ? 'destructive' : 
              'outline'
            }
          >
            {action}
          </Badge>
        );
      }
    },
    {
      accessorKey: 'quantity',
      header: 'Quantity'
    },
    {
      accessorKey: 'scannerName',
      header: 'Scanned By'
    },
    {
      accessorKey: 'scannedAt',
      header: 'Scan Date',
      cell: ({ row }: any) => {
        const date = row.getValue('scannedAt');
        if (!date) return 'N/A';
        return format(new Date(date), 'MMM dd, yyyy HH:mm');
      }
    },
    {
      accessorKey: 'backupDate',
      header: 'Backup Date',
      cell: ({ row }: any) => {
        const date = row.getValue('backupDate');
        if (!date) return 'N/A';
        return format(new Date(date), 'MMM dd, yyyy HH:mm');
      }
    }
  ];
  
  // Prepare loading operations data table columns
  const loadingOpColumns = [
    {
      accessorKey: 'referenceNumber',
      header: 'Reference #'
    },
    {
      accessorKey: 'status',
      header: 'Status',
      cell: ({ row }: any) => {
        const status = row.getValue('status');
        return (
          <Badge
            variant="secondary" // Always use purple (secondary) for consistency
            className="bg-purple-100 text-purple-800 hover:bg-purple-200"
          >
            {status}
          </Badge>
        );
      }
    },
    {
      accessorKey: 'createdAt',
      header: 'Created Date',
      cell: ({ row }: any) => {
        const date = row.getValue('createdAt');
        if (!date) return 'N/A';
        return format(new Date(date), 'MMM dd, yyyy HH:mm');
      }
    },
    {
      accessorKey: 'completedAt',
      header: 'Completed Date',
      cell: ({ row }: any) => {
        const date = row.getValue('completedAt');
        if (!date) return '-';
        return format(new Date(date), 'MMM dd, yyyy HH:mm');
      }
    },
    {
      accessorKey: 'backupDate',
      header: 'Backup Date',
      cell: ({ row }: any) => {
        const date = row.getValue('backupDate');
        if (!date) return 'N/A';
        return format(new Date(date), 'MMM dd, yyyy HH:mm');
      }
    },
    {
      id: 'actions',
      header: 'Actions',
      cell: ({ row }: any) => {
        const operation = row.original;
        return (
          <div className="flex space-x-2">
            <Button 
              variant="outline" 
              size="sm"
              onClick={() => fetchLoadingOperationItems(operation.originalId, `Order #${operation.referenceNumber}`)}
              className="flex items-center"
            >
              <Eye className="h-4 w-4 mr-1" />
              Details
            </Button>
            <Button 
              variant="destructive" 
              size="sm"
              onClick={() => {
                if (window.confirm(`Are you sure you want to delete the backup for reference "${operation.referenceNumber}"? This cannot be undone.`)) {
                  deleteLoadingOpBackup(operation.id);
                }
              }}
              disabled={isDeletingLoadingOpBackup}
              className="flex items-center"
            >
              <Trash2 className="h-4 w-4 mr-1" />
              Delete
            </Button>
          </div>
        );
      }
    }
  ];
  
  // Fetch loading operation items details
  const fetchLoadingOperationItems = async (operationId: number, operationName: string) => {
    // We'll use the same modal but with a different source
    setSaleDetailsModal(prev => ({ 
      ...prev, 
      isOpen: true, 
      saleId: operationId, // Reuse the saleId field
      isLoading: true,
      saleName: operationName, // Reuse the saleName field
      items: []
    }));
    
    try {
      // Get the original loading operation to fetch its items
      const data = await apiRequest('GET', `/api/loading-operations/${operationId}`, undefined, false, true) as any;
      
      // Check if we have items attached to this operation
      if (data && data.items && Array.isArray(data.items)) {
        // Transform the items to match the sales items format for display
        const items = data.items.map((item: any) => ({
          id: item.id,
          productId: item.productId,
          productName: item.name,
          quantity: item.quantity || 0,
          price: item.price || 0,
          category: item.category || '',
          hsn: item.hsn || ''
        }));
        
        setSaleDetailsModal(prev => ({ 
          ...prev, 
          items,
          isLoading: false
        }));
      } else {
        setSaleDetailsModal(prev => ({ 
          ...prev, 
          items: [],
          isLoading: false
        }));
        toast({
          title: 'No Items',
          description: 'No item details available for this loading operation.',
          variant: 'default'
        });
      }
    } catch (error) {
      console.error('Error fetching loading operation items:', error);
      toast({
        title: 'Error',
        description: 'Failed to fetch loading operation item details.',
        variant: 'destructive'
      });
      setSaleDetailsModal(prev => ({ ...prev, isLoading: false }));
    }
  };
  
  // Fetch proforma slip items details
  const fetchProformaSlipItems = async (slipId: number, slipName: string) => {
    // We'll use the same modal but with a different source
    setSaleDetailsModal(prev => ({ 
      ...prev, 
      isOpen: true, 
      saleId: slipId, // Reuse the saleId field
      isLoading: true,
      saleName: slipName, // Reuse the saleName field
      items: []
    }));
    
    try {
      // Get the original proforma slip items
      const data = await apiRequest('GET', `/api/proforma-slips/${slipId}/items`, undefined, false, true) as any;
      
      // Check if we have items
      if (data && Array.isArray(data) && data.length > 0) {
        // Transform the items to match the sales items format for display
        const items = data.map((item: any) => ({
          id: item.id,
          productId: item.productId,
          productName: item.productName,
          quantity: item.quantity || 0,
          price: item.rate || 0,
          category: item.category || '',
          hsn: item.hsn || ''
        }));
        
        setSaleDetailsModal(prev => ({ 
          ...prev, 
          items,
          isLoading: false
        }));
      } else {
        setSaleDetailsModal(prev => ({ 
          ...prev, 
          items: [],
          isLoading: false
        }));
        toast({
          title: 'No Items',
          description: 'No item details available for this proforma slip.',
          variant: 'default'
        });
      }
    } catch (error) {
      console.error('Error fetching proforma slip items:', error);
      toast({
        title: 'Error',
        description: 'Failed to fetch proforma slip item details.',
        variant: 'destructive'
      });
      setSaleDetailsModal(prev => ({ ...prev, isLoading: false }));
    }
  };

  // Fetch sale items details
  const fetchSaleItems = async (saleId: number, saleName: string) => {
    setSaleDetailsModal(prev => ({ 
      ...prev, 
      isOpen: true, 
      saleId, 
      isLoading: true,
      saleName,
      items: []
    }));
    
    try {
      // Use the updated apiRequest with parseJson=true
      const data = await apiRequest('GET', `/api/backup/sales/${saleId}/items`, undefined, false, true) as any;
      const items = Array.isArray(data) ? data : [];
      
      setSaleDetailsModal(prev => ({ 
        ...prev, 
        items,
        isLoading: false
      }));
    } catch (error) {
      console.error('Error fetching sale items:', error);
      toast({
        title: 'Error',
        description: 'Failed to fetch sale items details.',
        variant: 'destructive'
      });
      setSaleDetailsModal(prev => ({ ...prev, isLoading: false }));
    }
  };
  
  // Delete a loading operation backup entry
  const { mutate: deleteLoadingOpBackup, isPending: isDeletingLoadingOpBackup } = useMutation({
    mutationFn: async (backupId: number) => {
      return await apiRequest('DELETE', `/api/backup/loading-operations/${backupId}`);
    },
    onSuccess: () => {
      toast({
        title: 'Loading Operation Backup Deleted',
        description: 'The loading operation backup has been permanently deleted.',
        variant: 'default'
      });
      queryClient.invalidateQueries({queryKey: ['/api/backup/loading-operations']});
    },
    onError: (error) => {
      console.error('Error deleting loading operation backup:', error);
      toast({
        title: 'Error',
        description: 'Failed to delete the loading operation backup.',
        variant: 'destructive'
      });
    }
  });
  
  // Delete a single proforma slip backup
  const { mutate: deleteProformaSlipBackup, isPending: isDeletingProformaSlipBackup } = useMutation({
    mutationFn: async (backupId: number) => {
      return await apiRequest('DELETE', `/api/backup/proforma-slips/${backupId}`);
    },
    onSuccess: () => {
      toast({
        title: 'Proforma Slip Backup Deleted',
        description: 'The proforma slip backup has been permanently deleted.',
        variant: 'default'
      });
      queryClient.invalidateQueries({queryKey: ['/api/backup/proforma-slips']});
    },
    onError: (error) => {
      console.error('Error deleting proforma slip backup:', error);
      toast({
        title: 'Error',
        description: 'Failed to delete the proforma slip backup.',
        variant: 'destructive'
      });
    }
  });
  
  // Batch delete multiple proforma slip backups
  const { mutate: batchDeleteProformaSlipBackups, isPending: isBatchDeletePending } = useMutation({
    mutationFn: async (backupIds: number[]) => {
      // Log what we're sending to help debug
      console.log('Sending batch delete request with IDs:', backupIds);
      return await apiRequest('POST', '/api/backup/proforma-slips/batch-delete', { 
        ids: backupIds 
      });
    },
    onSuccess: (data: any) => {
      // Close any open delete dialog
      setDeleteDialogState(prev => ({ ...prev, isOpen: false }));
      
      // Clear selection
      setSelectedProformaSlipBackups([]);
      
      // Show success message
      toast({
        title: 'Backups Deleted',
        description: `${data.deletedCount} proforma slip backup(s) have been deleted successfully.`,
        variant: 'default'
      });
      
      // Force immediate refetch of data
      queryClient.invalidateQueries({queryKey: ['/api/backup/proforma-slips']});
      queryClient.refetchQueries({queryKey: ['/api/backup/proforma-slips']});
    },
    onError: (error) => {
      console.error('Error batch deleting proforma slip backups:', error);
      setDeleteDialogState(prev => ({ ...prev, isOpen: false }));
      
      toast({
        title: 'Error',
        description: 'Failed to delete proforma slip backups.',
        variant: 'destructive'
      });
    }
  });
  
  // Delete a sale backup entry
  const { mutate: deleteSaleBackup, isPending: isDeletingSaleBackup } = useMutation({
    mutationFn: async (saleId: number) => {
      return await apiRequest('DELETE', `/api/backup/sales/${saleId}`);
    },
    onSuccess: () => {
      toast({
        title: 'Sales Backup Deleted',
        description: 'The sales backup has been permanently deleted.',
        variant: 'default'
      });
      queryClient.invalidateQueries({queryKey: ['/api/backup/sales']});
    },
    onError: (error) => {
      console.error('Error deleting sales backup:', error);
      toast({
        title: 'Error',
        description: 'Failed to delete the sales backup.',
        variant: 'destructive'
      });
    }
  });
  
  // Handle date range change
  const handleDateRangeChange = (range: DateRange | undefined) => {
    setDateRange(range);
    setStartDate(range?.from);
    setEndDate(range?.to);
  };
  
  // Refresh current tab data
  const refreshData = () => {
    switch (currentTab) {
      case 'scans':
        queryClient.invalidateQueries({queryKey: ['/api/backup/scans']});
        break;
      case 'loading-operations':
        queryClient.invalidateQueries({queryKey: ['/api/backup/loading-operations']});
        break;
      case 'sales':
        queryClient.invalidateQueries({queryKey: ['/api/backup/sales']});
        break;
      case 'proforma-slips':
        queryClient.invalidateQueries({queryKey: ['/api/backup/proforma-slips']});
        break;
      default:
        break;
    }
    
    toast({
      title: 'Refreshed',
      description: 'Data has been refreshed.',
      variant: 'default'
    });
  };
  
  // Prepare proforma slips data table columns
  const proformaSlipColumns = [
    {
      accessorKey: 'orderNumber',
      header: 'Order #'
    },
    {
      accessorKey: 'partyName',
      header: 'Party Name'
    },
    {
      accessorKey: 'orderDate',
      header: 'Order Date',
      cell: ({ row }: any) => {
        const dateStr = row.getValue('orderDate');
        if (!dateStr) return 'N/A';
        
        try {
          // Handle date formats like "30-03-25" or "30/03/25"
          const parts = dateStr.toString().split(/[-\/]/);
          if (parts.length === 3) {
            const day = parseInt(parts[0]);
            const month = parseInt(parts[1]) - 1; // Months are 0-indexed in JS Date
            let year = parseInt(parts[2]);
            
            // Handle two-digit years
            if (year < 100) {
              year = year + 2000;
            }
            
            const date = new Date(year, month, day);
            if (!isNaN(date.getTime())) {
              return format(date, 'MMM dd, yyyy');
            }
          }
          
          // Fallback to standard date parsing (ISO format)
          return format(new Date(dateStr), 'MMM dd, yyyy');
        } catch (e) {
          // If date parsing fails, return the original string
          console.warn('Error parsing date:', dateStr, e);
          return dateStr;
        }
      }
    },
    {
      accessorKey: 'plant',
      header: 'Plant'
    },
    {
      accessorKey: 'totalQuantity',
      header: 'Quantity',
    },
    {
      accessorKey: 'totalVolume',
      header: 'Volume'
    },
    {
      accessorKey: 'createdAt',
      header: 'Created Date',
      cell: ({ row }: any) => {
        const date = row.getValue('createdAt');
        if (!date) return 'N/A';
        return format(new Date(date), 'MMM dd, yyyy HH:mm');
      }
    },
    {
      accessorKey: 'backupDate',
      header: 'Backup Date',
      cell: ({ row }: any) => {
        const date = row.getValue('backupDate');
        if (!date) return 'N/A';
        return format(new Date(date), 'MMM dd, yyyy HH:mm');
      }
    },
    {
      id: 'actions',
      header: 'Actions',
      cell: ({ row }: any) => {
        const slip = row.original;
        return (
          <Button 
            variant="outline" 
            size="sm"
            onClick={() => fetchProformaSlipItems(slip.originalId, `Order #${slip.orderNumber} - ${slip.partyName}`)}
            className="flex items-center"
          >
            <Eye className="h-4 w-4 mr-1" />
            Details
          </Button>
        );
      }
    }
  ];
  
  // Prepare sales data table columns
  const salesColumns = [
    {
      accessorKey: 'orderNumber',
      header: 'Order #',
      cell: ({ row }: any) => {
        const orderNumber = row.getValue('orderNumber');
        return (
          <div className="font-medium">{orderNumber}</div>
        );
      }
    },
    {
      accessorKey: 'dealer',
      header: 'Party Name',
      cell: ({ row }: any) => {
        const dealer = row.getValue('dealer');
        return (
          <div className="font-medium text-purple-800">{dealer || 'N/A'}</div>
        );
      }
    },
    {
      accessorKey: 'plant',
      header: 'Plant',
      cell: ({ row }: any) => {
        const plant = row.getValue('plant');
        return plant || 'N/A';
      }
    },
    {
      accessorKey: 'status',
      header: 'Status',
      cell: ({ row }: any) => {
        const status = row.getValue('status');
        return (
          <Badge
            variant="secondary" // Always use purple (secondary) for consistency
            className="bg-purple-100 text-purple-800 hover:bg-purple-200"
          >
            {status}
          </Badge>
        );
      }
    },
    {
      accessorKey: 'quantity',
      header: 'Quantity',
      cell: ({ row }: any) => {
        const quantity = row.getValue('quantity');
        return (
          <div className="font-medium text-right">{quantity}</div>
        );
      }
    },
    {
      accessorKey: 'amount',
      header: 'Amount',
      cell: ({ row }: any) => {
        const amount = row.getValue('amount');
        return (
          <div className="font-medium text-right">
            {new Intl.NumberFormat('en-IN', {
              style: 'currency',
              currency: 'INR'
            }).format(amount || 0)}
          </div>
        );
      }
    },
    {
      accessorKey: 'date',
      header: 'Date',
      cell: ({ row }: any) => {
        const dateStr = row.getValue('date');
        if (!dateStr) return 'N/A';
        
        try {
          // Handle date formats like "30-03-25" or "30/03/25"
          const parts = dateStr.toString().split(/[-\/]/);
          if (parts.length === 3) {
            const day = parseInt(parts[0]);
            const month = parseInt(parts[1]) - 1; // Months are 0-indexed in JS Date
            let year = parseInt(parts[2]);
            
            // Handle two-digit years
            if (year < 100) {
              year = year + 2000;
            }
            
            const date = new Date(year, month, day);
            if (!isNaN(date.getTime())) {
              return format(date, 'MMM dd, yyyy');
            }
          }
          
          // Fallback to standard date parsing (ISO format)
          return format(new Date(dateStr), 'MMM dd, yyyy');
        } catch (e) {
          // If date parsing fails, return the original string
          console.warn('Error parsing date:', dateStr, e);
          return dateStr;
        }
      }
    },
    {
      accessorKey: 'notes',
      header: 'Creator',
      cell: ({ row }: any) => {
        const notes = row.getValue('notes');
        // Extract creator name from notes if possible
        const sale = row.original;
        if (sale.createdBy) {
          return sale.createdBy;
        }
        return 'Unknown';
      }
    },
    {
      accessorKey: 'backupDate',
      header: 'Backup Date',
      cell: ({ row }: any) => {
        const date = row.getValue('backupDate');
        if (!date) return 'N/A';
        return format(new Date(date), 'MMM dd, yyyy HH:mm');
      }
    },
    {
      id: 'actions',
      header: 'Actions',
      cell: ({ row }: any) => {
        const sale = row.original;
        return (
          <div className="flex space-x-2">
            <Button 
              variant="outline" 
              size="sm"
              onClick={() => fetchSaleItems(sale.id, `${sale.orderNumber} - ${sale.dealer}`)}
              className="flex items-center"
            >
              <Eye className="h-4 w-4 mr-1" />
              Details
            </Button>
            <Button 
              variant="destructive" 
              size="sm"
              onClick={() => {
                if (window.confirm(`Are you sure you want to delete the backup for "${sale.orderNumber}"? This cannot be undone.`)) {
                  deleteSaleBackup(sale.id);
                }
              }}
              disabled={isDeletingSaleBackup}
              className="flex items-center"
            >
              <Trash2 className="h-4 w-4 mr-1" />
              Delete
            </Button>
          </div>
        );
      }
    }
  ];
  
  // Handle frequency change
  const handleFrequencyChange = (value: string) => {
    if (!backupSettings) return;
    
    const frequencyHours = parseInt(value);
    if (isNaN(frequencyHours) || frequencyHours < 1) return;
    
    updateSettings({
      backupFrequencyHours: frequencyHours
    });
  };
  
  // Handle auto backup toggle
  const handleAutoBackupToggle = () => {
    if (!backupSettings) return;
    
    updateSettings({
      autoBackupEnabled: !backupSettings.autoBackupEnabled
    });
  };
  
  // Reset date filters
  const resetDateFilters = () => {
    setStartDate(undefined);
    setEndDate(undefined);
  };
  
  // Render a different UI based on user permissions
  if (!permissions.canManageSettings) {
    return (
      <div className="container mx-auto py-6">
        <Alert variant="destructive">
          <AlertCircle className="h-4 w-4" />
          <AlertTitle>Access Denied</AlertTitle>
          <AlertDescription>
            You do not have permission to access the backup system.
          </AlertDescription>
        </Alert>
      </div>
    );
  }

  return (
    <div className="container mx-auto py-6">
      <h1 className="text-3xl font-bold mb-6">Backup System</h1>
      
      {/* Item Details Modal (for Sales, Loading Operations, and Proforma Slips) */}
      <Dialog open={saleDetailsModal.isOpen} onOpenChange={(open) => setSaleDetailsModal(prev => ({ ...prev, isOpen: open }))}>
        <DialogContent className="max-w-3xl">
          <DialogHeader>
            <DialogTitle className="flex items-center">
              <FileBox className="mr-2 h-5 w-5" />
              Item Details
            </DialogTitle>
            <DialogDescription>
              {saleDetailsModal.saleName}
            </DialogDescription>
          </DialogHeader>
          
          {saleDetailsModal.isLoading ? (
            <SectionSkeleton lines={3} />
          ) : saleDetailsModal.items.length > 0 ? (
            <ScrollArea className="h-96">
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead className="w-[200px]">Item Name</TableHead>
                    <TableHead>Sr. No</TableHead>
                    <TableHead>Barcode</TableHead>
                    <TableHead>Category</TableHead>
                    <TableHead>HSN</TableHead>
                    <TableHead className="text-right">Quantity</TableHead>
                    <TableHead className="text-right">Price</TableHead>
                    <TableHead className="text-right">Total</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {saleDetailsModal.items.map((item, index) => (
                    <TableRow key={index}>
                      <TableCell className="font-medium">{item.productName || item.name}</TableCell>
                      <TableCell>{item.srNo || '-'}</TableCell>
                      <TableCell>{item.barcode || '-'}</TableCell>
                      <TableCell>{item.category || '-'}</TableCell>
                      <TableCell>{item.hsn || '-'}</TableCell>
                      <TableCell className="text-right">{item.quantity}</TableCell>
                      <TableCell className="text-right">
                        {new Intl.NumberFormat('en-IN', {
                          style: 'currency',
                          currency: 'INR'
                        }).format(item.price || item.unitPrice || 0)}
                      </TableCell>
                      <TableCell className="text-right">
                        {new Intl.NumberFormat('en-IN', {
                          style: 'currency',
                          currency: 'INR'
                        }).format((item.price || item.unitPrice || 0) * (item.quantity || 0))}
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </ScrollArea>
          ) : (
            <div className="py-8 text-center">
              <p className="text-muted-foreground">No item details available for this sale.</p>
            </div>
          )}
        </DialogContent>
      </Dialog>
      
      <Tabs value={currentTab} onValueChange={setCurrentTab}>
        <TabsList className="mb-4">
          <TabsTrigger value="settings">
            <Database className="h-4 w-4 mr-2" />
            Settings
          </TabsTrigger>
          <TabsTrigger value="scans">
            <Package className="h-4 w-4 mr-2" />
            Scan History
          </TabsTrigger>
          <TabsTrigger value="loading-operations">
            <Truck className="h-4 w-4 mr-2" />
            Loading Operations
          </TabsTrigger>
          <TabsTrigger value="sales">
            <FileBox className="h-4 w-4 mr-2" />
            Sales
          </TabsTrigger>
          <TabsTrigger value="proforma-slips">
            <FileBox className="h-4 w-4 mr-2" />
            Proforma Slips
          </TabsTrigger>
        </TabsList>
        
        {/* Settings Tab */}
        <TabsContent value="settings">
          <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
            <Card>
              <CardHeader>
                <CardTitle>Backup Settings</CardTitle>
                <CardDescription>Configure automatic backup schedule and preferences</CardDescription>
              </CardHeader>
              <CardContent>
                {isLoadingSettings ? (
                  <SectionSkeleton lines={3} />
                ) : backupSettings ? (
                  <div className="space-y-4">
                    <div className="flex items-center justify-between">
                      <div className="space-y-0.5">
                        <Label htmlFor="auto-backup">Automatic Backups</Label>
                        <p className="text-sm text-muted-foreground">
                          Enable scheduled backups of operational data
                        </p>
                      </div>
                      <Switch
                        id="auto-backup"
                        checked={backupSettings.autoBackupEnabled}
                        onCheckedChange={handleAutoBackupToggle}
                        disabled={isUpdatingSettings}
                      />
                    </div>
                    
                    <Separator />
                    
                    <div className="space-y-2">
                      <Label htmlFor="frequency">Backup Frequency (hours)</Label>
                      <Input
                        id="frequency"
                        type="number"
                        min="1"
                        value={backupSettings.backupFrequencyHours}
                        onChange={(e) => handleFrequencyChange(e.target.value)}
                        disabled={isUpdatingSettings || !backupSettings.autoBackupEnabled}
                      />
                      <p className="text-sm text-muted-foreground">
                        How often to run automatic backups (in hours)
                      </p>
                    </div>
                    
                    <Separator />
                    
                    <div className="space-y-2">
                      <div className="flex items-center">
                        <Clock className="h-4 w-4 mr-2" />
                        <Label>Last Backup</Label>
                      </div>
                      <div className="flex items-center pl-6">
                        <Badge variant="outline" className="font-mono">
                          {backupSettings.lastBackupDate ?
                            format(new Date(backupSettings.lastBackupDate), 'PPP p') :
                            'Never'
                          }
                        </Badge>
                      </div>
                    </div>
                    
                    <Separator />
                    
                    <div className="space-y-2">
                      <div className="flex items-center">
                        <Database className="h-4 w-4 mr-2" />
                        <Label>Data Retention Policies</Label>
                      </div>
                      <div className="pl-6 space-y-2">
                        <p className="text-sm text-muted-foreground">
                          • Scan history data stored indefinitely
                        </p>
                        <p className="text-sm text-muted-foreground">
                          • Sales data stored indefinitely
                        </p>
                        <p className="text-sm text-muted-foreground">
                          • Proforma slips stored indefinitely
                        </p>
                        <p className="text-sm text-muted-foreground">
                          • Loading operations data deleted after 6 months
                        </p>
                        <Button
                          variant="outline"
                          size="sm"
                          onClick={() => applyRetentionPolicies()}
                          disabled={isApplyingRetentionPolicies}
                          className="mt-2"
                        >
                          {isApplyingRetentionPolicies ? (
                            <>
                              <Loader2 className="mr-2 h-3 w-3 animate-spin" />
                              Applying Policies...
                            </>
                          ) : (
                            <>
                              <RefreshCw className="mr-2 h-3 w-3" />
                              Apply Retention Policies
                            </>
                          )}
                        </Button>
                      </div>
                    </div>
                  </div>
                ) : (
                  <Alert>
                    <AlertCircle className="h-4 w-4" />
                    <AlertTitle>No Settings Found</AlertTitle>
                    <AlertDescription>
                      No backup settings found. Please reload the page or contact an administrator.
                    </AlertDescription>
                  </Alert>
                )}
              </CardContent>
              <CardFooter>
                <Button
                  onClick={() => runBackup()}
                  disabled={isRunningBackup}
                  className="w-full"
                >
                  {isRunningBackup ? (
                    <>
                      <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                      Running Backup...
                    </>
                  ) : (
                    <>
                      <FileArchive className="mr-2 h-4 w-4" />
                      Run Backup Now
                    </>
                  )}
                </Button>
              </CardFooter>
            </Card>
            
            <Card>
              <CardHeader>
                <CardTitle>Date Filter</CardTitle>
                <CardDescription>Filter backup data by date range</CardDescription>
              </CardHeader>
              <CardContent>
                <div className="space-y-4">
                  <div className="grid grid-cols-2 gap-4">
                    <div className="space-y-2">
                      <Label>Start Date</Label>
                      <Calendar
                        mode="single"
                        selected={startDate}
                        onSelect={setStartDate}
                        className="border rounded-md p-2"
                      />
                    </div>
                    <div className="space-y-2">
                      <Label>End Date</Label>
                      <Calendar
                        mode="single"
                        selected={endDate}
                        onSelect={setEndDate}
                        disabled={(date) => startDate ? date < startDate : false}
                        className="border rounded-md p-2"
                      />
                    </div>
                  </div>
                  
                  <div className="pt-2">
                    <Button
                      variant="outline"
                      onClick={resetDateFilters}
                      className="w-full"
                    >
                      Reset Date Filters
                    </Button>
                  </div>
                </div>
              </CardContent>
              <CardFooter className="text-sm text-muted-foreground">
                Select both start and end dates to filter backup data by a specific date range.
              </CardFooter>
            </Card>
          </div>
        </TabsContent>
        
        {/* Scan History Backups Tab */}
        <TabsContent value="scans">
          <Card>
            <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
              <div>
                <CardTitle>Scan History Backups</CardTitle>
                <CardDescription>
                  Historical scan data stored in the backup system
                  {startDate && endDate && (
                    <span className="ml-2 font-medium">
                      (Filtered: {format(startDate, 'MMM dd, yyyy')} - {format(endDate, 'MMM dd, yyyy')})
                    </span>
                  )}
                </CardDescription>
              </div>
              <Button
                variant="outline"
                size="sm"
                onClick={() => queryClient.invalidateQueries({queryKey: ['/api/backup/scans']})}
                className="flex items-center"
              >
                <RefreshCw className="h-4 w-4 mr-1" />
                Refresh
              </Button>
            </CardHeader>
            <CardContent>
              {isLoadingScans ? (
                <SectionSkeleton lines={5} />
              ) : scanBackups && scanBackups.length > 0 ? (
                <ScrollArea className="h-[500px]">
                  <DataTable
                    columns={scanColumns}
                    data={scanBackups}
                    searchColumn="barcode"
                  />
                </ScrollArea>
              ) : (
                <div className="py-6 text-center">
                  <FileArchive className="h-12 w-12 mx-auto opacity-20 mb-2" />
                  <h3 className="font-medium">No Backup Data</h3>
                  <p className="text-sm text-muted-foreground mt-1">
                    {startDate || endDate 
                      ? "No scan history backup records found for the selected date range." 
                      : "No scan history backup records found. Run a backup to archive scan data."}
                  </p>
                </div>
              )}
            </CardContent>
          </Card>
        </TabsContent>
        
        {/* Loading Operations Backups Tab */}
        <TabsContent value="loading-operations">
          <Card>
            <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
              <div>
                <CardTitle>Loading Operations Backups</CardTitle>
                <CardDescription>
                  Historical loading operation data stored in the backup system
                  {startDate && endDate && (
                    <span className="ml-2 font-medium">
                      (Filtered: {format(startDate, 'MMM dd, yyyy')} - {format(endDate, 'MMM dd, yyyy')})
                    </span>
                  )}
                </CardDescription>
              </div>
              <Button
                variant="outline"
                size="sm"
                onClick={() => queryClient.invalidateQueries({queryKey: ['/api/backup/loading-operations']})}
                className="flex items-center"
              >
                <RefreshCw className="h-4 w-4 mr-1" />
                Refresh
              </Button>
            </CardHeader>
            <CardContent>
              {isLoadingLoadingOps ? (
                <SectionSkeleton lines={5} />
              ) : loadingOpBackups && loadingOpBackups.length > 0 ? (
                <ScrollArea className="h-[500px]">
                  <DataTable
                    columns={loadingOpColumns}
                    data={loadingOpBackups}
                    searchColumn="referenceNumber"
                  />
                </ScrollArea>
              ) : (
                <div className="py-6 text-center">
                  <FileArchive className="h-12 w-12 mx-auto opacity-20 mb-2" />
                  <h3 className="font-medium">No Backup Data</h3>
                  <p className="text-sm text-muted-foreground mt-1">
                    {startDate || endDate 
                      ? "No loading operation backup records found for the selected date range." 
                      : "No loading operation backup records found. Run a backup to archive loading operation data."}
                  </p>
                </div>
              )}
            </CardContent>
          </Card>
        </TabsContent>
        
        {/* Sales Backups Tab */}
        <TabsContent value="sales">
          <Card>
            <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
              <div>
                <CardTitle>Sales Backups</CardTitle>
                <CardDescription>
                  Historical sales data stored in the backup system
                  {startDate && endDate && (
                    <span className="ml-2 font-medium">
                      (Filtered: {format(startDate, 'MMM dd, yyyy')} - {format(endDate, 'MMM dd, yyyy')})
                    </span>
                  )}
                </CardDescription>
              </div>
              <Button
                variant="outline"
                size="sm"
                onClick={() => queryClient.invalidateQueries({queryKey: ['/api/backup/sales']})}
                className="flex items-center"
              >
                <RefreshCw className="h-4 w-4 mr-1" />
                Refresh
              </Button>
            </CardHeader>
            <CardContent>
              {isLoadingSales ? (
                <SectionSkeleton lines={5} />
              ) : saleBackups && saleBackups.length > 0 ? (
                <ScrollArea className="h-[500px]">
                  <DataTable
                    columns={salesColumns}
                    data={saleBackups}
                    searchColumn="orderNumber"
                  />
                </ScrollArea>
              ) : (
                <div className="py-6 text-center">
                  <FileArchive className="h-12 w-12 mx-auto opacity-20 mb-2" />
                  <h3 className="font-medium">No Backup Data</h3>
                  <p className="text-sm text-muted-foreground mt-1">
                    {startDate || endDate 
                      ? "No sales backup records found for the selected date range." 
                      : "No sales backup records found. Run a backup to archive sales data."}
                  </p>
                </div>
              )}
            </CardContent>
          </Card>
        </TabsContent>

        {/* Proforma Slips Backups Tab */}
        <TabsContent value="proforma-slips">
          <Card>
            <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
              <div>
                <CardTitle>Proforma Slips Backups</CardTitle>
                <CardDescription>
                  Historical proforma slip data stored in the backup system
                  {startDate && endDate && (
                    <span className="ml-2 font-medium">
                      (Filtered: {format(startDate, 'MMM dd, yyyy')} - {format(endDate, 'MMM dd, yyyy')})
                    </span>
                  )}
                </CardDescription>
              </div>
              <div className="flex space-x-2">
                {selectedProformaSlipBackups.length > 0 && (
                  <Button
                    variant="destructive"
                    size="sm"
                    onClick={() => {
                      setDeleteDialogState({
                        isOpen: true,
                        backupIds: selectedProformaSlipBackups,
                        title: 'Delete Selected Backups',
                        message: `Are you sure you want to delete ${selectedProformaSlipBackups.length} selected proforma slip backup(s)? This action cannot be undone.`
                      });
                    }}
                    className="flex items-center"
                    disabled={isBatchDeletePending}
                  >
                    <Trash2 className="h-4 w-4 mr-1" />
                    Delete Selected ({selectedProformaSlipBackups.length})
                  </Button>
                )}
                <Button
                  variant="outline"
                  size="sm"
                  onClick={() => queryClient.invalidateQueries({queryKey: ['/api/backup/proforma-slips']})}
                  className="flex items-center"
                >
                  <RefreshCw className="h-4 w-4 mr-1" />
                  Refresh
                </Button>
              </div>
            </CardHeader>
            <CardContent>
              {isLoadingProformaSlips ? (
                <SectionSkeleton lines={5} />
              ) : proformaSlipBackups && proformaSlipBackups.length > 0 ? (
                <ScrollArea className="h-[500px]">
                  <SelectableDataTable
                    columns={proformaSlipColumns}
                    data={proformaSlipBackups || []}
                    searchColumn="orderNumber"
                    onDeleteSelected={(selectedRows) => {
                      // Extract the ids from the selected rows
                      const selectedIds = selectedRows.map((row: any) => row.id);
                      setSelectedProformaSlipBackups(selectedIds);
                      
                      setDeleteDialogState({
                        isOpen: true,
                        backupIds: selectedIds,
                        title: 'Delete Selected Backups',
                        message: `Are you sure you want to delete ${selectedIds.length} selected proforma slip backup(s)? This action cannot be undone.`
                      });
                    }}
                  />
                </ScrollArea>
              ) : (
                <div className="py-6 text-center">
                  <FileArchive className="h-12 w-12 mx-auto opacity-20 mb-2" />
                  <h3 className="font-medium">No Backup Data</h3>
                  <p className="text-sm text-muted-foreground mt-1">
                    {startDate || endDate 
                      ? "No proforma slip backup records found for the selected date range." 
                      : "No proforma slip backup records found. Run a backup to archive proforma slip data."}
                  </p>
                </div>
              )}
            </CardContent>
          </Card>
        </TabsContent>
      </Tabs>
      
      {/* Confirmation Dialog for Batch Deletion */}
      <AlertDialog open={deleteDialogState.isOpen} onOpenChange={(isOpen) => 
        setDeleteDialogState(prev => ({ ...prev, isOpen }))
      }>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>{deleteDialogState.title}</AlertDialogTitle>
            <AlertDialogDescription>
              {deleteDialogState.message}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction
              onClick={() => {
                if (currentTab === 'proforma-slips' && deleteDialogState.backupIds.length > 0) {
                  batchDeleteProformaSlipBackups(deleteDialogState.backupIds);
                }
              }}
              className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
            >
              Delete
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}