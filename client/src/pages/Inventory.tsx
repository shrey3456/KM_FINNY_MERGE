import { useLocation } from 'wouter';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { 
  Table, 
  TableBody, 
  TableCell, 
  TableHead, 
  TableHeader, 
  TableRow,
  TableFooter
} from '@/components/ui/table';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { 
  Card, 
  CardContent, 
  CardHeader, 
  CardTitle 
} from '@/components/ui/card';
import PageHeader from '../components/PageHeader';
import { getCurrentUserPermissions, isAdminOrSuperAdmin } from '../lib/permissions';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { useToast } from '@/hooks/use-toast';
import { useForm } from "react-hook-form";
import { CategoryBadge } from '@/components/CategoryBadge';
import { zodResolver } from "@hookform/resolvers/zod";
import { z } from "zod";
import {
  Form,
  FormControl,
  FormField,
  FormItem,
  FormLabel,
  FormMessage,
} from "@/components/ui/form";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  Search, Plus, Package, Pencil, Trash, Upload, Loader2, RefreshCw,
  ChevronLeft, ChevronRight, ChevronFirst, ChevronLast, CloudDownload, Bell, CheckCircle2
} from 'lucide-react';
import { Badge } from '@/components/ui/badge';
import { useState, useRef, useEffect } from 'react';
import { apiRequest } from '@/lib/queryClient';
import { Product } from '@shared/schema';

// Form schema for product creation/editing
const productFormSchema = z.object({
  srNo: z.string().optional(),
  itemNo: z.string().optional(),
  barcode: z.string().min(1, "Barcode is required"),
  name: z.string().min(1, "Product name is required"),
  category: z.string().optional(),
  volumeInCuFt: z.string().optional(),
  hsnCode: z.string().optional(),
  sapCode: z.string().optional(),
  purchased: z.number().optional().default(0),
  sold: z.number().optional().default(0),
  inStock: z.number().optional().default(0),
  itemsPerPallet: z.number().optional().default(0),
  pallets: z.number().optional().default(0),
  purchasePrice: z.string().optional(),
  sellingPrice: z.string().optional(),
  description: z.string().optional(),
  status: z.string().optional().default("in stock"),
});

const Inventory = () => {
  const [location] = useLocation();
  const [searchTerm, setSearchTerm] = useState('');
  const [isImportDialogOpen, setIsImportDialogOpen] = useState(false);
  const [isAddProductDialogOpen, setIsAddProductDialogOpen] = useState(false);
  const [isImporting, setIsImporting] = useState(false);
  const [importFile, setImportFile] = useState<File | null>(null);
  const [sortOrder, setSortOrder] = useState<'asc' | 'desc'>('asc');
  const [isEditDialogOpen, setIsEditDialogOpen] = useState(false);
  const [currentProduct, setCurrentProduct] = useState<Product | null>(null);
  
  // Pagination state
  const [currentPage, setCurrentPage] = useState(1);
  const [entriesLimit, setEntriesLimit] = useState(15);

  const fileInputRef = useRef<HTMLInputElement>(null);
  const { toast } = useToast();
  const queryClient = useQueryClient();

  // Get current user permissions
  const userPermissions = getCurrentUserPermissions();
  const currentUserStr = localStorage.getItem('currentUser');
  const currentUser = currentUserStr ? JSON.parse(currentUserStr) : null;
  const isAdmin = currentUser && isAdminOrSuperAdmin(currentUser.role);

  // Add product form initialization with zod resolver
  const addProductForm = useForm<z.infer<typeof productFormSchema>>({
    resolver: zodResolver(productFormSchema),
    defaultValues: {
      srNo: '',
      name: '',
      barcode: '',
      category: '',
      volumeInCuFt: '',
      hsnCode: '',
      sapCode: '',
      itemsPerPallet: 0,
      purchased: 0,
      sold: 0,
      inStock: 0,
      purchasePrice: '',
      sellingPrice: '',
      description: '',
    }
  });

  // Edit form initialization with zod resolver
  const editForm = useForm<z.infer<typeof productFormSchema>>({
    resolver: zodResolver(productFormSchema),
    defaultValues: {
      srNo: '',
      name: '',
      barcode: '',
      category: '',
      volumeInCuFt: '',
      hsnCode: '',
      sapCode: '',
      itemsPerPallet: 0,
      purchasePrice: '',
      sellingPrice: '',
      description: '',
    }
  });

  // Reset form values when a product is selected for editing
  useEffect(() => {
    if (currentProduct) {
      editForm.reset({
        srNo: currentProduct.srNo || '',
        name: currentProduct.name || '',
        barcode: currentProduct.barcode || '',
        category: currentProduct.category || '',
        volumeInCuFt: currentProduct.volumeInCuFt || '',
        hsnCode: currentProduct.hsnCode || '',
        sapCode: currentProduct.sapCode || '',
        itemsPerPallet: currentProduct.itemsPerPallet || 0,
        purchasePrice: currentProduct.purchasePrice ? currentProduct.purchasePrice.toString() : '',
        sellingPrice: currentProduct.sellingPrice ? currentProduct.sellingPrice.toString() : '',
        description: currentProduct.description || '',
      });
    }
  }, [currentProduct, editForm]);

  // Handle form submission for editing
  const handleSubmitEdit = (data: z.infer<typeof productFormSchema>) => {
    if (!currentProduct) return;

    const updatedProduct = {
      ...data,
      id: currentProduct.id,
      // Preserve values that are not editable through the form
      purchased: currentProduct.purchased,
      sold: currentProduct.sold,
      inStock: currentProduct.inStock,
      pallets: currentProduct.pallets,
      // Use current date for last updated - make sure to use a standard format 
      // that the backend can process properly
      lastUpdated: new Date().toISOString(),
      // Keep prices as strings as defined in the schema
      purchasePrice: data.purchasePrice ? data.purchasePrice.toString() : '',
      sellingPrice: data.sellingPrice ? data.sellingPrice.toString() : '',
    };

    // Remove any undefined or null values that might cause issues
    const cleanedProduct = Object.fromEntries(
      Object.entries(updatedProduct).filter(([_, v]) => v !== undefined && v !== null)
    );

    console.log('Submitting update with data:', cleanedProduct);
    updateProductMutation.mutate(cleanedProduct);
  };

  const { data: products, isLoading, error, refetch: refetchProducts } = useQuery({
    queryKey: ['/api/products'],
    queryFn: async () => {
      // Base URL with high limit (100000) to tell the server we want all products
      // Add timestamp to prevent browser caching
      const url = `/api/products?limit=100000&_t=${Date.now()}`;
      const res = await apiRequest('GET', url);
      return res.json();
    },
    staleTime: 5000, // Only 5 seconds stale time
    refetchInterval: 15000, // Refetch every 15 seconds
    refetchOnWindowFocus: false,
  });

  // Add a refetching mechanism
  const handleRefresh = () => {
    console.log('Manual refresh of product data requested');
    refetchProducts();
  };

  // Notion sync report dialog state
  const [syncReport, setSyncReport] = useState<any | null>(null);
  const [isSyncReportOpen, setIsSyncReportOpen] = useState(false);

  // Pending-changes confirmation dialog state
  const [isPendingDialogOpen, setIsPendingDialogOpen] = useState(false);

  // Full-import confirmation dialog
  const [isFullImportConfirmOpen, setIsFullImportConfirmOpen] = useState(false);

  // Poll for pending Notion changes every 5 minutes
  const { data: pendingData, refetch: refetchPending } = useQuery({
    queryKey: ['/api/notion-inventory-sync/pending'],
    queryFn: async () => {
      const res = await apiRequest('GET', '/api/notion-inventory-sync/pending');
      return res.json();
    },
    refetchInterval: 5 * 60 * 1000,
    staleTime: 60 * 1000,
  });
  const hasPending = pendingData?.hasPending && pendingData?.report?.updated > 0;

  // Detect-only mutation (dry run — stores pending, no DB writes)
  const detectMutation = useMutation({
    mutationFn: async () => {
      const res = await apiRequest('POST', '/api/notion-inventory-sync/detect');
      return res.json();
    },
    onSuccess: async () => {
      await refetchPending();
      setIsPendingDialogOpen(true);
    },
    onError: (error: any) => {
      toast({
        title: 'Detection Failed',
        description: error.message || 'Could not detect Notion changes.',
        variant: 'destructive',
      });
    },
  });

  // Apply pending changes mutation
  const applyPendingMutation = useMutation({
    mutationFn: async () => {
      const res = await apiRequest('POST', '/api/notion-inventory-sync/apply');
      return res.json();
    },
    onSuccess: async (data) => {
      setSyncReport(data);
      setIsPendingDialogOpen(false);
      setIsSyncReportOpen(true);
      refetchPending();
      await queryClient.invalidateQueries({ queryKey: ['/api/products'] });
      refetchProducts();
      toast({
        title: 'Changes Applied',
        description: `${data.created ?? 0} created, ${data.updated} updated from Notion.`,
        className: 'bg-green-50 border-green-200 text-green-900',
      });
    },
    onError: (error: any) => {
      toast({
        title: 'Apply Failed',
        description: error.message || 'Could not apply pending changes.',
        variant: 'destructive',
      });
    },
  });

  // Full Import mutation (clear DB + import all from Notion — use once to seed notionPageId on all products)
  const fullSyncMutation = useMutation({
    mutationFn: async () => {
      const res = await apiRequest('POST', '/api/notion-inventory-sync/full-sync');
      return res.json();
    },
    onSuccess: async (data) => {
      setSyncReport(data);
      setIsFullImportConfirmOpen(false);
      setIsSyncReportOpen(true);
      refetchPending();
      await queryClient.invalidateQueries({ queryKey: ['/api/products'] });
      refetchProducts();
      toast({
        title: 'Full Import Complete',
        description: `${data.created} products imported from Notion.`,
        className: 'bg-green-50 border-green-200 text-green-900',
      });
    },
    onError: (error: any) => {
      setIsFullImportConfirmOpen(false);
      toast({
        title: 'Full Import Failed',
        description: error.message || 'Could not complete full import.',
        variant: 'destructive',
      });
    },
  });

  // Import CSV mutation
  const importMutation = useMutation({
    mutationFn: async (formData: FormData) => {
      const response = await apiRequest('POST', '/api/products/import-csv', formData, true);
      const data = await response.json();
      return data;
    },
    onSuccess: async (data) => {
      const count = data?.successCount ?? data?.totalCount ?? 'multiple';
      toast({
        title: 'Import Successful ✅',
        description: `${count} products have been imported successfully.`,
        variant: 'default',
        className: 'bg-green-50 border-green-200 text-green-900',
      });
      setIsImportDialogOpen(false);
      setImportFile(null);
      
      // Invalidate queries to ensure cache is cleared
      await queryClient.invalidateQueries({ queryKey: ['/api/products'] });
      
      // Directly refetch the products to update the UI immediately
      await refetchProducts();
    },
    onError: (error) => {
      toast({
        title: 'Import Failed',
        description: error.message || 'An error occurred during import.',
        variant: 'destructive',
      });
    },
    onSettled: () => {
      setIsImporting(false);
    }
  });

  const handleFileChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    if (e.target.files && e.target.files.length > 0) {
      setImportFile(e.target.files[0]);
    }
  };

  const handleImport = () => {
    if (!importFile) {
      toast({
        title: 'No File Selected',
        description: 'Please select a CSV file to import.',
        variant: 'destructive',
      });
      return;
    }

    setIsImporting(true);
    const formData = new FormData();
    formData.append('file', importFile);
    importMutation.mutate(formData);
  };

  // Add product mutation
  const addProductMutation = useMutation({
    mutationFn: async (data: z.infer<typeof productFormSchema>) => {
      return apiRequest('POST', '/api/products', data);
    },
    onSuccess: async () => {
      toast({
        title: 'Product Added',
        description: 'The new product has been successfully added to inventory.',
        variant: 'default',
        className: 'bg-green-50 border-green-200 text-green-900',
      });
      setIsAddProductDialogOpen(false);
      addProductForm.reset({
        srNo: '',
        name: '',
        barcode: '',
        category: '',
        volumeInCuFt: '',
        hsnCode: '',
        sapCode: '',
        itemsPerPallet: 0,
        purchased: 0,
        sold: 0,
        inStock: 0,
        purchasePrice: '',
        sellingPrice: '',
        description: '',
      });
      // Explicitly invalidate the specific list query
      await queryClient.invalidateQueries({ queryKey: ['/api/products'] });
    },
    onError: (error) => {
      toast({
        title: 'Add Product Failed',
        description: error.message || 'An error occurred while adding the product.',
        variant: 'destructive',
      });
    }
  });

  // Handle form submission for adding a new product
  const handleSubmitAddProduct = (data: z.infer<typeof productFormSchema>) => {
    console.log('Submitting new product with data:', data);
    addProductMutation.mutate(data);
  };

  // Update product mutation
  const updateProductMutation = useMutation({
    mutationFn: async (data: any) => {
      return apiRequest('PUT', `/api/products/${data.id}`, data);
    },
    onSuccess: async () => {
      toast({
        title: 'Product Updated',
        description: 'The product details have been successfully updated.',
        variant: 'default',
        className: 'bg-green-50 border-green-200 text-green-900',
      });
      setIsEditDialogOpen(false);
      setCurrentProduct(null);
      // Explicitly invalidate the specific list query
      await queryClient.invalidateQueries({ queryKey: ['/api/products'] });
    },
    onError: (error) => {
      toast({
        title: 'Update Failed',
        description: error.message || 'An error occurred while updating the product.',
        variant: 'destructive',
      });
    }
  });

  // Delete product mutation
  const deleteProductMutation = useMutation({
    mutationFn: async (id: number) => {
      return apiRequest('DELETE', `/api/products/${id}`);
    },
    onSuccess: async () => {
      toast({
        title: 'Product Deleted',
        description: 'The product has been successfully removed from inventory.',
        variant: 'default',
        className: 'bg-blue-50 border-blue-200 text-blue-900',
      });
      // Explicitly invalidate the specific list query
      await queryClient.invalidateQueries({ queryKey: ['/api/products'] });
    },
    onError: (error) => {
      toast({
        title: 'Delete Failed',
        description: error.message || 'An error occurred while deleting the product.',
        variant: 'destructive',
      });
    }
  });

  // Handle edit product button click
  const handleEditProduct = (product: Product) => {
    setCurrentProduct(product);
    setIsEditDialogOpen(true);
  };

  // Handle delete product
  const [productToDelete, setProductToDelete] = useState<Product | null>(null);
  const [isDeleteDialogOpen, setIsDeleteDialogOpen] = useState(false);

  const handleDeleteProduct = (product: Product) => {
    setProductToDelete(product);
    setIsDeleteDialogOpen(true);
  };

  const confirmDeleteProduct = () => {
    if (productToDelete) {
      deleteProductMutation.mutate(productToDelete.id);
      setIsDeleteDialogOpen(false);
      setProductToDelete(null);
    }
  };

  // Format price in Indian Rupees (₹)
  const formatIndianRupees = (price: string | number | undefined): string => {
    if (!price) return '₹0.00';
    const numPrice = typeof price === 'string' ? parseFloat(price) : price;
    return new Intl.NumberFormat('en-IN', {
      style: 'currency',
      currency: 'INR',
      minimumFractionDigits: 2,
      maximumFractionDigits: 2
    }).format(numPrice);
  };

  // Query sales data for the inventory page
  const { data: salesData } = useQuery({
    queryKey: ['/api/sales'],
    queryFn: async () => {
      const res = await apiRequest('GET', '/api/sales');
      return res.json();
    }
  });

  // Calculate totals
  const calculateTotals = (products: any[]) => {
    if (!Array.isArray(products) || products.length === 0) {
      return {
        totalPurchased: 0,
        totalSold: 0,
        totalInStock: 0,
        totalPurchaseValue: 0,
        totalSellingValue: 0,
        totalSales: 0,
        totalSalesAmount: 0,
        totalItemsSold: 0,
        latestSaleDate: 'N/A'
      };
    }

    // Calculate inventory totals
    const inventoryTotals = products.reduce((acc, product) => {
      const purchased = parseInt(product.purchased) || 0;
      const sold = parseInt(product.sold) || 0;
      const inStock = parseInt(product.inStock) || 0;
      const purchasePrice = parseFloat(product.purchasePrice) || 0;
      const sellingPrice = parseFloat(product.sellingPrice) || 0;
      const salesCount = parseInt(product.salesCount) || 0;

      return {
        totalPurchased: acc.totalPurchased + purchased,
        totalSold: acc.totalSold + sold,
        totalInStock: acc.totalInStock + inStock,
        totalPurchaseValue: acc.totalPurchaseValue + (inStock * purchasePrice),
        totalSellingValue: acc.totalSellingValue + (sold * sellingPrice)
      };
    }, {
      totalPurchased: 0,
      totalSold: 0,
      totalInStock: 0,
      totalPurchaseValue: 0,
      totalSellingValue: 0
    });

    // Calculate sales totals from sales data
    let salesTotals = {
      totalSales: 0,
      totalSalesAmount: 0,
      totalItemsSold: 0,
      latestSaleDate: 'N/A'
    };

    if (salesData && Array.isArray(salesData)) {
      const totalSales = salesData.length;
      const totalSalesAmount = salesData.reduce((sum, sale) => sum + (parseFloat(sale.amount) || 0), 0);
      const totalItemsSold = salesData.reduce((sum, sale) => sum + (parseInt(sale.quantity) || 0), 0);

      // Find latest sale date
      let latestDate: Date | null = null;
      salesData.forEach(sale => {
        if (sale.date) {
          const saleDate = new Date(sale.date);
          if (!latestDate || saleDate > latestDate) {
            latestDate = saleDate;
          }
        }
      });

      salesTotals = {
        totalSales,
        totalSalesAmount,
        totalItemsSold,
        latestSaleDate: latestDate ? (latestDate as Date).toLocaleDateString() : 'N/A'
      };
    }

    // Combine both totals
    return {
      ...inventoryTotals,
      ...salesTotals
    };
  };

  // Filter products based on search term
  const filteredProducts = Array.isArray(products) ? products.filter((product: any) => 
    (product.name?.toLowerCase().includes(searchTerm.toLowerCase())) ||
    (product.barcode?.includes(searchTerm)) ||
    (product.sapCode?.includes(searchTerm)) ||
    (product.category?.toLowerCase().includes(searchTerm.toLowerCase()))
  ) : [];

  // Sort products by Sr.No.
  const sortedProducts = [...filteredProducts].sort((a, b) => {
    // Convert to strings in case they're numbers, and use localeCompare 
    const aValue = (a.srNo || '').toString();
    const bValue = (b.srNo || '').toString();

    // If sorting in ascending order
    if (sortOrder === 'asc') {
      return aValue.localeCompare(bValue, undefined, { numeric: true });
    }
    // If sorting in descending order
    return bValue.localeCompare(aValue, undefined, { numeric: true });
  });

  // Pagination logic
  const totalPages = Math.ceil(sortedProducts.length / entriesLimit);
  
  // Ensure current page is valid when entries limit changes or data changes
  useEffect(() => {
    if (totalPages > 0 && currentPage > totalPages) {
      setCurrentPage(totalPages);
    } else if (currentPage < 1) {
      setCurrentPage(1);
    }
  }, [entriesLimit, sortedProducts.length, totalPages, currentPage]);

  const paginatedProducts = sortedProducts.slice(
    (currentPage - 1) * entriesLimit,
    currentPage * entriesLimit
  );

  // Calculate totals for the filtered products
  const totals = calculateTotals(filteredProducts);

  return (
    <>
      {/* Mobile Header removed as requested */}

      <div className="flex-1 overflow-y-auto p-4 lg:p-6">
        <div className="max-w-[1800px] mx-auto">
          <PageHeader 
            icon={Package} 
            title="Inventory"
          />

          <Card className="mb-6 overflow-hidden w-full">
            <CardHeader className="pb-3">
              <div className="flex flex-col sm:flex-row sm:justify-between sm:items-center gap-4">
                <CardTitle>Product List</CardTitle>
                <div className="flex gap-2">
                  <div className="relative">
                    <Search className="absolute left-2.5 top-2.5 h-4 w-4 text-gray-500" />
                    <Input
                      type="search"
                      placeholder="Search products..."
                      className="pl-8 w-full sm:w-[250px]"
                      value={searchTerm}
                      onChange={(e) => setSearchTerm(e.target.value)}
                    />
                  </div>
                  <Button
                    variant="outline"
                    size="icon"
                    onClick={handleRefresh}
                    title="Refresh inventory"
                  >
                    <RefreshCw className="h-4 w-4" />
                  </Button>
                  {/* Pending-changes bell — shown when 24h detection found changes */}
                  {hasPending && (
                    <Button
                      variant="outline"
                      className="relative flex items-center gap-1 border-amber-400 text-amber-700 hover:bg-amber-50"
                      onClick={() => setIsPendingDialogOpen(true)}
                      title={`${pendingData.report.updated} Notion change(s) ready to review`}
                    >
                      <Bell className="h-4 w-4" />
                      <span>Review Changes</span>
                      <Badge className="ml-1 bg-amber-500 text-white px-1.5 py-0 text-xs">
                        {pendingData.report.updated}
                      </Badge>
                    </Button>
                  )}
                  <Button
                    variant="outline"
                    className="flex items-center gap-1"
                    onClick={() => detectMutation.mutate()}
                    disabled={detectMutation.isPending || fullSyncMutation.isPending}
                    title="Fetch changes from Notion — review before applying"
                  >
                    {detectMutation.isPending
                      ? <Loader2 className="h-4 w-4 animate-spin" />
                      : <CloudDownload className="h-4 w-4" />}
                    <span>{detectMutation.isPending ? 'Fetching...' : 'Sync from Notion'}</span>
                  </Button>
                  <Button
                    variant="outline"
                    className="flex items-center gap-1 border-red-300 text-red-700 hover:bg-red-50"
                    onClick={() => setIsFullImportConfirmOpen(true)}
                    disabled={detectMutation.isPending || fullSyncMutation.isPending}
                    title="Clear all products and import everything fresh from Notion"
                  >
                    <CloudDownload className="h-4 w-4" />
                    <span>Full Import from Notion</span>
                  </Button>
                  {syncReport && (
                    <Button
                      variant="ghost"
                      size="sm"
                      className="text-xs text-muted-foreground"
                      onClick={() => setIsSyncReportOpen(true)}
                    >
                      Last Report
                    </Button>
                  )}
                  <Dialog open={isImportDialogOpen} onOpenChange={setIsImportDialogOpen}>
                    <DialogTrigger asChild>
                      <Button variant="outline" className="flex items-center gap-1">
                        <Upload className="h-4 w-4" />
                        <span>Import CSV</span>
                      </Button>
                    </DialogTrigger>
                    <DialogContent>
                      <DialogHeader>
                        <DialogTitle>Import Products from CSV</DialogTitle>
                        <DialogDescription>
                          Upload a CSV file to import products into your inventory.
                          <div className="mt-2 text-sm text-gray-500">
                            The CSV should have headers matching the expected format:
                            <ul className="list-disc pl-5 mt-1 space-y-1">
                              <li>Sr.No.</li>
                              <li>ItemName</li> 
                              <li>SKU</li>
                              <li>Category</li>
                              <li>HSNCode</li>
                              <li>SAPCode</li>
                              <li>Purchased</li>
                              <li>Sold</li>
                              <li>InStock</li>
                              <li>ItemsPerPallet</li>
                              <li>Pallets</li>
                              <li>PurchasePrice</li>
                              <li>SellingPrice</li>
                            </ul>
                          </div>
                        </DialogDescription>
                      </DialogHeader>
                      <div className="mt-4 space-y-4">
                        <div className="flex flex-col space-y-2">
                          <label htmlFor="csv-file" className="text-sm font-medium">
                            CSV File
                          </label>
                          <Input
                            id="csv-file"
                            type="file"
                            accept=".csv"
                            ref={fileInputRef}
                            onChange={handleFileChange}
                          />
                          {importFile && (
                            <p className="text-sm text-gray-500">
                              Selected file: {importFile.name}
                            </p>
                          )}
                        </div>
                      </div>
                      <DialogFooter>
                        <Button
                          variant="outline"
                          onClick={() => setIsImportDialogOpen(false)}
                          disabled={isImporting}
                        >
                          Cancel
                        </Button>
                        <Button onClick={handleImport} disabled={isImporting}>
                          {isImporting ? (
                            <>
                              <Loader2 className="h-4 w-4 mr-2 animate-spin" />
                              Importing...
                            </>
                          ) : 'Import'}
                        </Button>
                      </DialogFooter>
                    </DialogContent>
                  </Dialog>
                  {/* Only admin and super-admin can add products */}
                  {isAdmin ? (
                    <Dialog open={isAddProductDialogOpen} onOpenChange={setIsAddProductDialogOpen}>
                      <DialogTrigger asChild>
                        <Button className="flex items-center gap-1">
                          <Plus className="h-4 w-4" />
                          <span>Add Product</span>
                        </Button>
                      </DialogTrigger>
                      <DialogContent className="max-w-2xl">
                      <DialogHeader>
                        <DialogTitle>Add New Product</DialogTitle>
                        <DialogDescription>
                          Enter the details of the new product to add to inventory.
                        </DialogDescription>
                      </DialogHeader>
                      <Form {...addProductForm}>
                        <form onSubmit={addProductForm.handleSubmit(handleSubmitAddProduct)} className="space-y-6">
                          <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                            <FormField
                              control={addProductForm.control}
                              name="srNo"
                              render={({ field }) => (
                                <FormItem>
                                  <FormLabel>Sr. No.</FormLabel>
                                  <FormControl>
                                    <Input placeholder="Enter SR number (e.g. A001)" {...field} />
                                  </FormControl>
                                  <FormMessage />
                                </FormItem>
                              )}
                            />
                            <FormField
                              control={addProductForm.control}
                              name="barcode"
                              render={({ field }) => (
                                <FormItem>
                                  <FormLabel>Barcode *</FormLabel>
                                  <FormControl>
                                    <Input placeholder="Enter barcode" {...field} required />
                                  </FormControl>
                                  <FormMessage />
                                </FormItem>
                              )}
                            />
                            <FormField
                              control={addProductForm.control}
                              name="name"
                              render={({ field }) => (
                                <FormItem>
                                  <FormLabel>Product Name *</FormLabel>
                                  <FormControl>
                                    <Input placeholder="Enter product name" {...field} required />
                                  </FormControl>
                                  <FormMessage />
                                </FormItem>
                              )}
                            />
                            <FormField
                              control={addProductForm.control}
                              name="category"
                              render={({ field }) => (
                                <FormItem>
                                  <FormLabel>Category</FormLabel>
                                  <FormControl>
                                    <Input placeholder="Enter product category" {...field} />
                                  </FormControl>
                                  <FormMessage />
                                </FormItem>
                              )}
                            />
                            <FormField
                              control={addProductForm.control}
                              name="volumeInCuFt"
                              render={({ field }) => (
                                <FormItem>
                                  <FormLabel>Volume (cu ft)</FormLabel>
                                  <FormControl>
                                    <Input placeholder="Enter volume" {...field} />
                                  </FormControl>
                                  <FormMessage />
                                </FormItem>
                              )}
                            />
                            <FormField
                              control={addProductForm.control}
                              name="hsnCode"
                              render={({ field }) => (
                                <FormItem>
                                  <FormLabel>HSN Code</FormLabel>
                                  <FormControl>
                                    <Input placeholder="Enter HSN code" {...field} />
                                  </FormControl>
                                  <FormMessage />
                                </FormItem>
                              )}
                            />
                            <FormField
                              control={addProductForm.control}
                              name="sapCode"
                              render={({ field }) => (
                                <FormItem>
                                  <FormLabel>SAP Code</FormLabel>
                                  <FormControl>
                                    <Input placeholder="Enter SAP code" {...field} />
                                  </FormControl>
                                  <FormMessage />
                                </FormItem>
                              )}
                            />
                            <FormField
                              control={addProductForm.control}
                              name="itemsPerPallet"
                              render={({ field }) => (
                                <FormItem>
                                  <FormLabel>Items Per Pallet</FormLabel>
                                  <FormControl>
                                    <Input
                                      type="number"
                                      placeholder="0"
                                      {...field}
                                      onChange={(e) => field.onChange(e.target.valueAsNumber)}
                                    />
                                  </FormControl>
                                  <FormMessage />
                                </FormItem>
                              )}
                            />
                            <FormField
                              control={addProductForm.control}
                              name="purchasePrice"
                              render={({ field }) => (
                                <FormItem>
                                  <FormLabel>Purchase Price</FormLabel>
                                  <FormControl>
                                    <Input placeholder="Enter purchase price" {...field} />
                                  </FormControl>
                                  <FormMessage />
                                </FormItem>
                              )}
                            />
                            <FormField
                              control={addProductForm.control}
                              name="sellingPrice"
                              render={({ field }) => (
                                <FormItem>
                                  <FormLabel>Selling Price</FormLabel>
                                  <FormControl>
                                    <Input placeholder="Enter selling price" {...field} />
                                  </FormControl>
                                  <FormMessage />
                                </FormItem>
                              )}
                            />
                            <FormField
                              control={addProductForm.control}
                              name="description"
                              render={({ field }) => (
                                <FormItem className="md:col-span-2">
                                  <FormLabel>Description</FormLabel>
                                  <FormControl>
                                    <Input placeholder="Enter product description" {...field} />
                                  </FormControl>
                                  <FormMessage />
                                </FormItem>
                              )}
                            />
                          </div>
                          <DialogFooter>
                            <Button type="button" variant="outline" onClick={() => setIsAddProductDialogOpen(false)}>
                              Cancel
                            </Button>
                            <Button type="submit">
                              Add Product
                            </Button>
                          </DialogFooter>
                        </form>
                      </Form>
                    </DialogContent>
                  </Dialog>
                  ) : null}



                </div>
              </div>
            </CardHeader>
            <CardContent>
              {isLoading ? (
                <div className="text-center py-8">
                  <p className="text-gray-500">Loading products...</p>
                </div>
              ) : error ? (
                <div className="text-center py-8">
                  <p className="text-red-500">Error loading products</p>
                </div>
              ) : filteredProducts.length === 0 ? (
                <div className="text-center py-12">
                  <Package className="mx-auto h-12 w-12 text-gray-400" />
                  <h3 className="mt-2 text-lg font-medium">No products found</h3>
                  {searchTerm ? (
                    <p className="mt-1 text-gray-500">
                      No products match your search criteria. Try a different search term.
                    </p>
                  ) : (
                    <p className="mt-1 text-gray-500">
                      You haven't added any products yet. Scan a barcode or add one manually.
                    </p>
                  )}
                  <div className="mt-6">
                    <Button asChild>
                      <a href="/scan">Start Scanning</a>
                    </Button>
                  </div>
                </div>
              ) : (
                <div className="inventory-table-container w-full max-w-[95vw] md:max-w-[95vw] lg:max-w-[98vw] overflow-x-auto">
                  <Table className="inventory-table w-max min-w-full">
                    <TableHeader>
                      <TableRow>
                        {/* ── Core ── */}
                        <TableHead className="whitespace-nowrap frozen-header">
                          <div className="flex items-center gap-1 cursor-pointer" onClick={() => setSortOrder(sortOrder === 'asc' ? 'desc' : 'asc')}>
                            New Sr.{sortOrder === 'asc' ? ' ↑' : ' ↓'}
                          </div>
                        </TableHead>
                        <TableHead className="whitespace-nowrap frozen-header">Item Name</TableHead>
                        <TableHead className="whitespace-nowrap">SKU</TableHead>
                        <TableHead className="whitespace-nowrap">Brand</TableHead>
                        <TableHead className="whitespace-nowrap">Category</TableHead>
                        <TableHead className="whitespace-nowrap">Sale Cat.</TableHead>
                        <TableHead className="whitespace-nowrap">Plant</TableHead>
                        <TableHead className="whitespace-nowrap">Type</TableHead>
                        <TableHead className="whitespace-nowrap">Volume<br/>(cu. ft.)</TableHead>
                        <TableHead className="whitespace-nowrap">Packets</TableHead>
                        <TableHead className="whitespace-nowrap">IND PLT</TableHead>
                        <TableHead className="whitespace-nowrap">VAL PLT</TableHead>
                        <TableHead className="whitespace-nowrap">Pallets</TableHead>
                        {/* ── GJ Region ── */}
                        <TableHead className="whitespace-nowrap bg-blue-50">GJ Sr</TableHead>
                        <TableHead className="whitespace-nowrap bg-blue-50">GJ HSN</TableHead>
                        <TableHead className="whitespace-nowrap bg-blue-50">GJ SAP</TableHead>
                        <TableHead className="whitespace-nowrap bg-blue-50">GJ Sale Rate</TableHead>
                        <TableHead className="whitespace-nowrap bg-blue-50">GJ IGST</TableHead>
                        <TableHead className="whitespace-nowrap bg-blue-50">GJ-GA PUR</TableHead>
                        <TableHead className="whitespace-nowrap bg-blue-50">GJ-MH PUR</TableHead>
                        <TableHead className="whitespace-nowrap bg-blue-50">GJ-NAGAR PUR</TableHead>
                        {/* ── MP Region ── */}
                        <TableHead className="whitespace-nowrap bg-green-50">MP Sr</TableHead>
                        <TableHead className="whitespace-nowrap bg-green-50">MP HSN</TableHead>
                        <TableHead className="whitespace-nowrap bg-green-50">MP SAP</TableHead>
                        <TableHead className="whitespace-nowrap bg-green-50">MP-JH PUR</TableHead>
                        <TableHead className="whitespace-nowrap bg-green-50">MP-MH PUR</TableHead>
                        <TableHead className="whitespace-nowrap bg-green-50">MP-MP Jabalpur</TableHead>
                        <TableHead className="whitespace-nowrap bg-green-50">MP-MP Khargone</TableHead>
                        <TableHead className="whitespace-nowrap bg-green-50">MP-WB PUR</TableHead>
                        <TableHead className="whitespace-nowrap bg-green-50">Sale MP-JH</TableHead>
                        <TableHead className="whitespace-nowrap bg-green-50">Sale MP-MH</TableHead>
                        <TableHead className="whitespace-nowrap bg-green-50">Sale MP-MP</TableHead>
                        <TableHead className="whitespace-nowrap bg-green-50">MP-JH IGST</TableHead>
                        <TableHead className="whitespace-nowrap bg-green-50">MP-MH IGST</TableHead>
                        <TableHead className="whitespace-nowrap bg-green-50">MP-MP CGST</TableHead>
                        <TableHead className="whitespace-nowrap bg-green-50">MP-MP SGST</TableHead>
                        <TableHead className="whitespace-nowrap bg-green-50">MP-WB IGST</TableHead>
                        <TableHead className="whitespace-nowrap bg-green-50">MP-WB Sale</TableHead>
                        {/* ── UP Region ── */}
                        <TableHead className="whitespace-nowrap bg-orange-50">UP Sr</TableHead>
                        <TableHead className="whitespace-nowrap bg-orange-50">UP HSN</TableHead>
                        <TableHead className="whitespace-nowrap bg-orange-50">UP SAP</TableHead>
                        <TableHead className="whitespace-nowrap bg-orange-50">UP Rate</TableHead>
                        <TableHead className="whitespace-nowrap bg-orange-50">UP IGST</TableHead>
                        {/* ── Generic ── */}
                        <TableHead className="whitespace-nowrap">HSN Code</TableHead>
                        <TableHead className="whitespace-nowrap">SAP Code</TableHead>
                        <TableHead className="whitespace-nowrap">Purchase Price</TableHead>
                        <TableHead className="whitespace-nowrap">Selling Price</TableHead>
                        <TableHead className="whitespace-nowrap">Last Updated</TableHead>
                        <TableHead className="text-right min-w-[100px]">Actions</TableHead>
                      </TableRow>
                    </TableHeader>
                    <TableBody>
                      {paginatedProducts.map((product: any) => (
                        <TableRow key={product.id}>
                          {/* ── Core ── */}
                          <TableCell className="text-xs">{product.newSr || product.srNo || '—'}</TableCell>
                          <TableCell className="font-medium whitespace-nowrap">{product.name}</TableCell>
                          <TableCell className="text-xs">{product.barcode || 'N/A'}</TableCell>
                          <TableCell className="text-xs">{product.brand || '—'}</TableCell>
                          <TableCell>
                            {product.category ? <CategoryBadge category={product.category} /> : '—'}
                          </TableCell>
                          <TableCell className="text-xs">{product.saleCategory || '—'}</TableCell>
                          <TableCell className="text-xs">{product.plant || '—'}</TableCell>
                          <TableCell className="text-xs">{product.type || '—'}</TableCell>
                          <TableCell className="text-xs">{product.volumeInCuFt || '—'}</TableCell>
                          <TableCell className="text-xs text-center">{product.itemsPerPallet || 0}</TableCell>
                          <TableCell className="text-xs text-center">{product.indPlt ?? '—'}</TableCell>
                          <TableCell className="text-xs text-center">{product.valPlt ?? '—'}</TableCell>
                          <TableCell className="text-xs text-center">{product.pallets || 0}</TableCell>
                          {/* ── GJ Region ── */}
                          <TableCell className="text-xs bg-blue-50/40">{product.gjSr || '—'}</TableCell>
                          <TableCell className="text-xs bg-blue-50/40">{product.gjHsn || '—'}</TableCell>
                          <TableCell className="text-xs bg-blue-50/40">{product.gjSap || '—'}</TableCell>
                          <TableCell className="text-xs bg-blue-50/40">{product.gjSaleRate || '—'}</TableCell>
                          <TableCell className="text-xs bg-blue-50/40">{product.gjIgst || '—'}</TableCell>
                          <TableCell className="text-xs bg-blue-50/40">{product.gjGaPur || '—'}</TableCell>
                          <TableCell className="text-xs bg-blue-50/40">{product.gjMhPur || '—'}</TableCell>
                          <TableCell className="text-xs bg-blue-50/40">{product.gjNagarPur || '—'}</TableCell>
                          {/* ── MP Region ── */}
                          <TableCell className="text-xs bg-green-50/40">{product.mpSr || '—'}</TableCell>
                          <TableCell className="text-xs bg-green-50/40">{product.mpHsn || '—'}</TableCell>
                          <TableCell className="text-xs bg-green-50/40">{product.mpSap || '—'}</TableCell>
                          <TableCell className="text-xs bg-green-50/40">{product.mpJhPur || '—'}</TableCell>
                          <TableCell className="text-xs bg-green-50/40">{product.mpMhPur || '—'}</TableCell>
                          <TableCell className="text-xs bg-green-50/40">{product.mpMpPurJabalpur || '—'}</TableCell>
                          <TableCell className="text-xs bg-green-50/40">{product.mpMpPurKhargone || '—'}</TableCell>
                          <TableCell className="text-xs bg-green-50/40">{product.mpWbPur || '—'}</TableCell>
                          <TableCell className="text-xs bg-green-50/40">{product.saleMpJh || '—'}</TableCell>
                          <TableCell className="text-xs bg-green-50/40">{product.saleMpMh || '—'}</TableCell>
                          <TableCell className="text-xs bg-green-50/40">{product.saleMpMp || '—'}</TableCell>
                          <TableCell className="text-xs bg-green-50/40">{product.mpJhIgst || '—'}</TableCell>
                          <TableCell className="text-xs bg-green-50/40">{product.mpMhIgst || '—'}</TableCell>
                          <TableCell className="text-xs bg-green-50/40">{product.mpMpCgst || '—'}</TableCell>
                          <TableCell className="text-xs bg-green-50/40">{product.mpMpSgst || '—'}</TableCell>
                          <TableCell className="text-xs bg-green-50/40">{product.mpWbIgst || '—'}</TableCell>
                          <TableCell className="text-xs bg-green-50/40">{product.mpWbSale || '—'}</TableCell>
                          {/* ── UP Region ── */}
                          <TableCell className="text-xs bg-orange-50/40">{product.upSr || '—'}</TableCell>
                          <TableCell className="text-xs bg-orange-50/40">{product.upHsn || '—'}</TableCell>
                          <TableCell className="text-xs bg-orange-50/40">{product.upSap || '—'}</TableCell>
                          <TableCell className="text-xs bg-orange-50/40">{product.upRate || '—'}</TableCell>
                          <TableCell className="text-xs bg-orange-50/40">{product.upIgst || '—'}</TableCell>
                          {/* ── Generic ── */}
                          <TableCell className="text-xs">{product.hsnCode || '—'}</TableCell>
                          <TableCell className="text-xs">{product.sapCode || '—'}</TableCell>
                          <TableCell className="text-xs">{formatIndianRupees(product.purchasePrice)}</TableCell>
                          <TableCell className="text-xs">{formatIndianRupees(product.sellingPrice)}</TableCell>
                          <TableCell className="text-xs">
                            {product.lastUpdated ? new Date(product.lastUpdated).toLocaleDateString() : '—'}
                          </TableCell>
                          <TableCell className="text-right">
                            <div className="flex justify-end gap-2">
                              <Button 
                                variant="ghost" 
                                size="icon"
                                className="h-8 w-8" 
                                title="Edit product"
                                onClick={() => handleEditProduct(product)}
                              >
                                <Pencil className="h-4 w-4" />
                              </Button>
                              <Button 
                                variant="ghost" 
                                size="icon"
                                className="h-8 w-8 text-red-500 hover:text-red-700 hover:bg-red-50" 
                                title="Delete product"
                                onClick={() => handleDeleteProduct(product)}
                              >
                                <Trash className="h-4 w-4" />
                              </Button>
                            </div>
                          </TableCell>
                        </TableRow>
                      ))}
                    </TableBody>
                    <TableFooter className="bg-muted/30">
                      <TableRow>
                        <TableCell colSpan={52} className="p-2">
                          <div className="flex flex-col sm:flex-row items-center justify-between w-full gap-4">
                             <div className="flex items-center gap-2">
                                <span className="text-xs whitespace-nowrap">Show entries:</span>
                                <select 
                                  className="h-8 text-xs border rounded px-1 bg-background"
                                  value={entriesLimit}
                                  onChange={(e) => {
                                    setEntriesLimit(Number(e.target.value));
                                    setCurrentPage(1);
                                  }}
                                >
                                  <option value={15}>15</option>
                                  <option value={25}>25</option>
                                  <option value={50}>50</option>
                                  <option value={100}>100</option>
                                </select>
                             </div>

                            <div className="text-sm text-muted-foreground">
                              Showing {sortedProducts.length > 0 ? (currentPage - 1) * entriesLimit + 1 : 0} to {Math.min(currentPage * entriesLimit, sortedProducts.length)} of {sortedProducts.length} entries
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
                                Page {currentPage} of {totalPages || 1}
                              </span>
                              <Button
                                variant="outline"
                                size="sm"
                                onClick={() => setCurrentPage(prev => Math.min(totalPages, prev + 1))}
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
                                <ChevronLast className="h-4 w-4" />
                              </Button>
                            </div>
                          </div>
                        </TableCell>
                      </TableRow>
                    </TableFooter>
                  </Table>

                  {/* Table Totals */}
                  <div className="mt-6 border-t pt-4">
                    <div className="flex justify-between items-center">
                      <h3 className="text-lg font-semibold">Table Totals</h3>
                      <div className="bg-gray-50 p-3 rounded-md">
                        <p className="text-sm text-gray-500">Total Products</p>
                        <p className="text-lg font-semibold">
                          {filteredProducts.length}
                        </p>
                      </div>
                    </div>
                  </div>
                </div>
              )}
            </CardContent>
          </Card>
        </div>
      </div>

      {/* Edit Product Dialog */}
      <Dialog open={isEditDialogOpen} onOpenChange={setIsEditDialogOpen}>
        <DialogContent className="max-w-2xl">
          <DialogHeader>
            <DialogTitle>Edit Product Details</DialogTitle>
            <DialogDescription>
              Update the information for this product.
            </DialogDescription>
          </DialogHeader>

          {currentProduct && (
            <Form {...editForm}>
              <form onSubmit={editForm.handleSubmit(handleSubmitEdit)} className="space-y-4">
                <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                  <FormField
                    control={editForm.control}
                    name="srNo"
                    render={({ field }) => (
                      <FormItem>
                        <FormLabel>Sr. No.</FormLabel>
                        <FormControl>
                          <Input placeholder="Sr. No." {...field} />
                        </FormControl>
                        <FormMessage />
                      </FormItem>
                    )}
                  />

                  <FormField
                    control={editForm.control}
                    name="name"
                    render={({ field }) => (
                      <FormItem>
                        <FormLabel>Product Name</FormLabel>
                        <FormControl>
                          <Input placeholder="Product name" {...field} />
                        </FormControl>
                        <FormMessage />
                      </FormItem>
                    )}
                  />

                  <FormField
                    control={editForm.control}
                    name="barcode"
                    render={({ field }) => (
                      <FormItem>
                        <FormLabel>SKU / Barcode</FormLabel>
                        <FormControl>
                          <Input placeholder="SKU or barcode" {...field} />
                        </FormControl>
                        <FormMessage />
                      </FormItem>
                    )}
                  />

                  <FormField
                    control={editForm.control}
                    name="category"
                    render={({ field }) => (
                      <FormItem>
                        <FormLabel>Category</FormLabel>
                        <FormControl>
                          <Input placeholder="Category" {...field} />
                        </FormControl>
                        <FormMessage />
                      </FormItem>
                    )}
                  />

                  <FormField
                    control={editForm.control}
                    name="volumeInCuFt"
                    render={({ field }) => (
                      <FormItem>
                        <FormLabel>Volume (cu. ft.)</FormLabel>
                        <FormControl>
                          <Input placeholder="Volume in cubic feet" {...field} />
                        </FormControl>
                        <FormMessage />
                      </FormItem>
                    )}
                  />

                  <FormField
                    control={editForm.control}
                    name="hsnCode"
                    render={({ field }) => (
                      <FormItem>
                        <FormLabel>HSN Code</FormLabel>
                        <FormControl>
                          <Input placeholder="HSN Code" {...field} />
                        </FormControl>
                        <FormMessage />
                      </FormItem>
                    )}
                  />

                  <FormField
                    control={editForm.control}
                    name="sapCode"
                    render={({ field }) => (
                      <FormItem>
                        <FormLabel>SAP Code</FormLabel>
                        <FormControl>
                          <Input placeholder="SAP Code" {...field} />
                        </FormControl>
                        <FormMessage />
                      </FormItem>
                    )}
                  />

                  <FormField
                    control={editForm.control}
                    name="itemsPerPallet"
                    render={({ field }) => (
                      <FormItem>
                        <FormLabel>Items Per Pallet</FormLabel>
                        <FormControl>
                          <Input 
                            type="number" 
                            placeholder="Items per pallet" 
                            {...field}
                            onChange={(e) => field.onChange(e.target.value === '' ? undefined : parseInt(e.target.value, 10))}
                          />
                        </FormControl>
                        <FormMessage />
                      </FormItem>
                    )}
                  />

                  <FormField
                    control={editForm.control}
                    name="purchasePrice"
                    render={({ field }) => (
                      <FormItem>
                        <FormLabel>Purchase Price (₹)</FormLabel>
                        <FormControl>
                          <Input 
                            placeholder="Purchase price" 
                            {...field} 
                          />
                        </FormControl>
                        <FormMessage />
                      </FormItem>
                    )}
                  />

                  <FormField
                    control={editForm.control}
                    name="sellingPrice"
                    render={({ field }) => (
                      <FormItem>
                        <FormLabel>Selling Price (₹)</FormLabel>
                        <FormControl>
                          <Input 
                            placeholder="Selling price" 
                            {...field} 
                          />
                        </FormControl>
                        <FormMessage />
                      </FormItem>
                    )}
                  />
                </div>

                <DialogFooter>
                  <Button
                    type="button"
                    variant="outline"
                    onClick={() => setIsEditDialogOpen(false)}
                  >
                    Cancel
                  </Button>
                  <Button 
                    type="submit"
                    disabled={updateProductMutation.isPending}
                  >
                    {updateProductMutation.isPending ? (
                      <>
                        <Loader2 className="h-4 w-4 mr-2 animate-spin" />
                        Saving...
                      </>
                    ) : 'Save Changes'}
                  </Button>
                </DialogFooter>
              </form>
            </Form>
          )}
        </DialogContent>
      </Dialog>

      {/* Delete Product Confirmation Dialog */}
      <AlertDialog open={isDeleteDialogOpen} onOpenChange={setIsDeleteDialogOpen}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Delete Product</AlertDialogTitle>
            <AlertDialogDescription>
              Are you sure you want to delete the product: {productToDelete?.name}?
              This action cannot be undone.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction
              onClick={confirmDeleteProduct}
              className="bg-[#001d6e] hover:bg-red-700"
              disabled={deleteProductMutation.isPending}
            >
              {deleteProductMutation.isPending ? (
                <>
                  <Loader2 className="h-4 w-4 mr-2 animate-spin" />
                  Deleting...
                </>
              ) : 'Delete Product'}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      {/* Notion Sync Report Dialog */}
      <Dialog open={isSyncReportOpen} onOpenChange={setIsSyncReportOpen}>
        <DialogContent className="max-w-3xl max-h-[80vh] flex flex-col">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2">
              <CloudDownload className="h-5 w-5 text-blue-600" />
              Notion Sync Report
            </DialogTitle>
            <DialogDescription>
              {syncReport?.syncTime
                ? `Synced on ${new Date(syncReport.syncTime).toLocaleString()}`
                : 'Last sync details'}
            </DialogDescription>
          </DialogHeader>

          {syncReport && (
            <div className="flex flex-col gap-4 overflow-hidden">
              {/* Summary badges */}
              <div className="flex flex-wrap gap-3">
                {syncReport.created > 0 && (
                  <div className="flex flex-col items-center px-4 py-2 bg-purple-50 border border-purple-200 rounded-lg">
                    <span className="text-2xl font-bold text-purple-700">{syncReport.created}</span>
                    <span className="text-xs text-purple-600">Created</span>
                  </div>
                )}
                <div className="flex flex-col items-center px-4 py-2 bg-green-50 border border-green-200 rounded-lg">
                  <span className="text-2xl font-bold text-green-700">{syncReport.updated}</span>
                  <span className="text-xs text-green-600">Updated</span>
                </div>
                <div className="flex flex-col items-center px-4 py-2 bg-gray-50 border border-gray-200 rounded-lg">
                  <span className="text-2xl font-bold text-gray-600">{syncReport.skipped}</span>
                  <span className="text-xs text-gray-500">No Change</span>
                </div>
                <div className="flex flex-col items-center px-4 py-2 bg-yellow-50 border border-yellow-200 rounded-lg">
                  <span className="text-2xl font-bold text-yellow-700">{syncReport.notFound}</span>
                  <span className="text-xs text-yellow-600">Unmatched</span>
                </div>
                <div className="flex flex-col items-center px-4 py-2 bg-blue-50 border border-blue-200 rounded-lg">
                  <span className="text-2xl font-bold text-blue-700">{syncReport.total}</span>
                  <span className="text-xs text-blue-600">Total Pages</span>
                </div>
                {syncReport.errors?.length > 0 && (
                  <div className="flex flex-col items-center px-4 py-2 bg-red-50 border border-red-200 rounded-lg">
                    <span className="text-2xl font-bold text-red-700">{syncReport.errors.length}</span>
                    <span className="text-xs text-red-600">Errors</span>
                  </div>
                )}
              </div>

              {/* Newly created products */}
              {syncReport.createdProducts?.length > 0 && (
                <div className="border rounded-md overflow-y-auto max-h-40">
                  <div className="bg-purple-50 px-3 py-1.5 text-xs font-semibold text-purple-700 border-b">
                    New products added ({syncReport.createdProducts.length})
                  </div>
                  {syncReport.createdProducts.map((cp: any, i: number) => (
                    <div key={i} className="flex items-center gap-2 px-3 py-1.5 text-xs border-b last:border-0">
                      <span className="font-medium">{cp.productName}</span>
                      <span className="text-muted-foreground">·</span>
                      <span className="text-muted-foreground">{cp.barcode}</span>
                    </div>
                  ))}
                </div>
              )}

              {/* Changed products table */}
              {syncReport.changedProducts?.length > 0 ? (
                <div className="overflow-y-auto flex-1 border rounded-md">
                  <Table>
                    <TableHeader>
                      <TableRow className="bg-muted/50">
                        <TableHead className="w-[180px]">Product</TableHead>
                        <TableHead className="w-[100px]">SKU</TableHead>
                        <TableHead>Changes</TableHead>
                      </TableRow>
                    </TableHeader>
                    <TableBody>
                      {syncReport.changedProducts.map((pc: any) => (
                        <TableRow key={pc.productId}>
                          <TableCell className="font-medium text-sm align-top py-3">
                            {pc.productName}
                          </TableCell>
                          <TableCell className="text-xs text-muted-foreground align-top py-3">
                            {pc.barcode || pc.srNo || '—'}
                          </TableCell>
                          <TableCell className="align-top py-3">
                            <div className="flex flex-col gap-1">
                              {pc.changes.map((ch: any, i: number) => (
                                <div key={i} className="flex items-start gap-1 text-xs">
                                  <span className="font-medium text-muted-foreground min-w-[110px]">
                                    {ch.label}:
                                  </span>
                                  <span className="line-through text-red-500 max-w-[120px] truncate" title={String(ch.oldValue ?? '—')}>
                                    {ch.oldValue != null && ch.oldValue !== '' ? String(ch.oldValue) : '—'}
                                  </span>
                                  <span className="text-gray-400 mx-1">→</span>
                                  <span className="text-green-700 font-medium max-w-[120px] truncate" title={String(ch.newValue)}>
                                    {String(ch.newValue)}
                                  </span>
                                </div>
                              ))}
                            </div>
                          </TableCell>
                        </TableRow>
                      ))}
                    </TableBody>
                  </Table>
                </div>
              ) : (
                <div className="flex flex-col items-center justify-center py-10 text-muted-foreground">
                  <CloudDownload className="h-10 w-10 mb-2 opacity-30" />
                  <p className="text-sm">No products were changed in this sync.</p>
                  <p className="text-xs mt-1">All inventory data already matches Notion.</p>
                </div>
              )}

              {/* Errors section */}
              {syncReport.errors?.length > 0 && (
                <div className="bg-red-50 border border-red-200 rounded-md p-3">
                  <p className="text-xs font-semibold text-red-700 mb-1">Errors ({syncReport.errors.length})</p>
                  {syncReport.errors.slice(0, 5).map((err: string, i: number) => (
                    <p key={i} className="text-xs text-red-600">{err}</p>
                  ))}
                  {syncReport.errors.length > 5 && (
                    <p className="text-xs text-red-400 mt-1">...and {syncReport.errors.length - 5} more</p>
                  )}
                </div>
              )}
            </div>
          )}

          <DialogFooter>
            <Button variant="outline" onClick={() => setIsSyncReportOpen(false)}>Close</Button>
            <Button
              onClick={() => { setIsSyncReportOpen(false); detectMutation.mutate(); }}
              disabled={detectMutation.isPending}
              className="flex items-center gap-1"
            >
              <CloudDownload className="h-4 w-4" />
              Sync Again
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Pending Changes Confirmation Dialog */}
      <Dialog open={isPendingDialogOpen} onOpenChange={setIsPendingDialogOpen}>
        <DialogContent className="max-w-3xl max-h-[80vh] flex flex-col">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2">
              <Bell className="h-5 w-5 text-amber-500" />
              Review Pending Notion Changes
            </DialogTitle>
            <DialogDescription>
              {pendingData?.report?.syncTime
                ? `Detected on ${new Date(pendingData.report.syncTime).toLocaleString()} — review before applying`
                : 'Changes detected from Notion. Review and confirm before applying.'}
            </DialogDescription>
          </DialogHeader>

          {pendingData?.report && (
            <div className="flex flex-col gap-4 overflow-hidden">
              {/* Summary badges */}
              <div className="flex flex-wrap gap-3">
                {pendingData.report.created > 0 && (
                  <div className="flex flex-col items-center px-4 py-2 bg-purple-50 border border-purple-200 rounded-lg">
                    <span className="text-2xl font-bold text-purple-700">{pendingData.report.created}</span>
                    <span className="text-xs text-purple-600">To Create</span>
                  </div>
                )}
                <div className="flex flex-col items-center px-4 py-2 bg-amber-50 border border-amber-200 rounded-lg">
                  <span className="text-2xl font-bold text-amber-700">{pendingData.report.updated}</span>
                  <span className="text-xs text-amber-600">To Update</span>
                </div>
                <div className="flex flex-col items-center px-4 py-2 bg-gray-50 border border-gray-200 rounded-lg">
                  <span className="text-2xl font-bold text-gray-600">{pendingData.report.skipped}</span>
                  <span className="text-xs text-gray-500">No Change</span>
                </div>
                <div className="flex flex-col items-center px-4 py-2 bg-yellow-50 border border-yellow-200 rounded-lg">
                  <span className="text-2xl font-bold text-yellow-700">{pendingData.report.notFound}</span>
                  <span className="text-xs text-yellow-600">Unmatched</span>
                </div>
                <div className="flex flex-col items-center px-4 py-2 bg-blue-50 border border-blue-200 rounded-lg">
                  <span className="text-2xl font-bold text-blue-700">{pendingData.report.total}</span>
                  <span className="text-xs text-blue-600">Total Pages</span>
                </div>
              </div>

              {/* Changed products table */}
              {pendingData.report.changedProducts?.length > 0 ? (
                <div className="overflow-y-auto flex-1 border rounded-md">
                  <Table>
                    <TableHeader>
                      <TableRow className="bg-muted/50">
                        <TableHead className="w-[180px]">Product</TableHead>
                        <TableHead className="w-[100px]">SKU</TableHead>
                        <TableHead>Proposed Changes</TableHead>
                      </TableRow>
                    </TableHeader>
                    <TableBody>
                      {pendingData.report.changedProducts.map((pc: any) => (
                        <TableRow key={pc.productId}>
                          <TableCell className="font-medium text-sm align-top py-3">
                            {pc.productName}
                          </TableCell>
                          <TableCell className="text-xs text-muted-foreground align-top py-3">
                            {pc.barcode || pc.srNo || '—'}
                          </TableCell>
                          <TableCell className="align-top py-3">
                            <div className="flex flex-col gap-1">
                              {pc.changes.map((ch: any, i: number) => (
                                <div key={i} className="flex items-start gap-1 text-xs">
                                  <span className="font-medium text-muted-foreground min-w-[110px]">
                                    {ch.label}:
                                  </span>
                                  <span className="line-through text-red-500 max-w-[120px] truncate" title={String(ch.oldValue ?? '—')}>
                                    {ch.oldValue != null && ch.oldValue !== '' ? String(ch.oldValue) : '—'}
                                  </span>
                                  <span className="text-gray-400 mx-1">→</span>
                                  <span className="text-green-700 font-medium max-w-[120px] truncate" title={String(ch.newValue)}>
                                    {String(ch.newValue)}
                                  </span>
                                </div>
                              ))}
                            </div>
                          </TableCell>
                        </TableRow>
                      ))}
                    </TableBody>
                  </Table>
                </div>
              ) : (
                <div className="flex flex-col items-center justify-center py-10 text-muted-foreground">
                  <CheckCircle2 className="h-10 w-10 mb-2 text-green-400" />
                  <p className="text-sm">No field changes detected.</p>
                  <p className="text-xs mt-1">Products already match Notion data.</p>
                </div>
              )}
            </div>
          )}

          <DialogFooter>
            <Button variant="outline" onClick={() => setIsPendingDialogOpen(false)}>
              Dismiss
            </Button>
            <Button
              onClick={() => applyPendingMutation.mutate()}
              disabled={applyPendingMutation.isPending || (!pendingData?.report?.updated && !pendingData?.report?.created)}
              className="flex items-center gap-1 bg-amber-600 hover:bg-amber-700 text-white"
            >
              {applyPendingMutation.isPending ? (
                <><Loader2 className="h-4 w-4 animate-spin" /> Applying...</>
              ) : (
                <><CheckCircle2 className="h-4 w-4" />
                  Apply ({(pendingData?.report?.created ?? 0)} new + {pendingData?.report?.updated ?? 0} changed)
                </>
              )}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Full Import Confirmation Dialog */}
      <AlertDialog open={isFullImportConfirmOpen} onOpenChange={setIsFullImportConfirmOpen}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle className="text-red-700 flex items-center gap-2">
              <CloudDownload className="h-5 w-5" />
              Full Import from Notion
            </AlertDialogTitle>
            <AlertDialogDescription asChild>
              <div className="space-y-3 text-sm">
                <p>This will <strong>permanently delete all products</strong> in the inventory and reimport everything fresh from Notion.</p>
                <div className="bg-red-50 border border-red-200 rounded-md p-3 text-red-700 text-xs space-y-1">
                  <p>• All existing products will be deleted</p>
                  <p>• Stock counts (purchased / sold / in-stock) will reset to 0</p>
                  <p>• Only products with a valid SKU and name in Notion will be imported</p>
                  <p>• Every product will have its Notion Page ID stored for future syncs</p>
                </div>
                <p className="text-muted-foreground">Use this for the initial setup or when products are missing their Notion link.</p>
              </div>
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction
              className="bg-red-600 hover:bg-red-700 text-white"
              onClick={() => fullSyncMutation.mutate()}
              disabled={fullSyncMutation.isPending}
            >
              {fullSyncMutation.isPending ? (
                <><Loader2 className="h-4 w-4 mr-2 animate-spin" /> Importing...</>
              ) : 'Yes, Clear & Import'}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

    </>
  );
};

export default Inventory;