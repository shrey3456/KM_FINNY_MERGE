import { useState, useEffect } from 'react';
import { 
  Dialog, 
  DialogContent, 
  DialogTitle, 
  DialogDescription
} from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Switch } from '@/components/ui/switch';
import { Separator } from '@/components/ui/separator'; 
import { 
  Select, 
  SelectContent, 
  SelectItem, 
  SelectTrigger, 
  SelectValue 
} from '@/components/ui/select';
import { ScanEntry } from '@shared/schema';
import { useForm } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import { z } from 'zod';
import { Search, Package, Barcode, ShoppingCart, CheckCircle, Plus, Minus } from 'lucide-react';
import { useQuery } from '@tanstack/react-query';
import { useToast } from "@/hooks/use-toast";
import {
  Form,
  FormControl,
  FormField,
  FormItem,
  FormLabel,
  FormMessage
} from "@/components/ui/form";
import {
  Command,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList
} from "@/components/ui/command";

// Blue color theme to match the app's main theme
const THEME_COLOR = '#001D6E';

type ManualEntryModalProps = {
  isOpen: boolean;
  onClose: () => void;
  onSubmit: (data: ScanEntry) => void;
};

const formSchema = z.object({
  barcodeType: z.string(),
  action: z.enum(["add", "remove", "update"]).default("add"),
  quantity: z.number().int().positive().default(1),
});

type FormValues = z.infer<typeof formSchema>;

const ManualEntryModal = ({ isOpen, onClose, onSubmit }: ManualEntryModalProps) => {
  const [searchQuery, setSearchQuery] = useState('');
  const [selectedProduct, setSelectedProduct] = useState<any>(null);
  const [isSearchOpen, setIsSearchOpen] = useState(false);
  const { toast } = useToast();
  
  // For pallet quantity toggle
  const [usePalletQty, setUsePalletQty] = useState(false);
  const [quantity, setQuantity] = useState(1);
  const [manualQuantity, setManualQuantity] = useState('1');
  
  // Fetch products from API for search
  const { data: products = [], isLoading } = useQuery({
    queryKey: ['/api/products'],
    staleTime: 60000, // 1 minute
  });

  // Filter products based on search query
  const filteredProducts = searchQuery.length > 0
    ? (products as any[]).filter((product: any) => 
        (product.name?.toLowerCase() || '').includes(searchQuery.toLowerCase()) || 
        (product.itemNo?.toLowerCase() || '').includes(searchQuery.toLowerCase()) ||
        (product.barcode?.toLowerCase() || '').includes(searchQuery.toLowerCase()) ||
        (product.category?.toLowerCase() || '').includes(searchQuery.toLowerCase())
      )
    : (products as any[]).slice(0, 10); // Show first 10 products when search is empty

  const form = useForm<FormValues>({
    resolver: zodResolver(formSchema),
    defaultValues: {
      barcodeType: "EAN13",
      action: "add",
      quantity: 1,
    }
  });
  
  // Handle toggle change
  const handleToggleChange = (checked: boolean) => {
    setUsePalletQty(checked);
    if (checked && selectedProduct?.itemsPerPallet) {
      // When turning toggle ON, reset to pallet quantity
      const newQty = selectedProduct.itemsPerPallet;
      setQuantity(newQty);
      setManualQuantity(newQty.toString());
      form.setValue('quantity', newQty);
    }
  };
  
  // Handle manual quantity change
  const handleManualQuantityChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const value = e.target.value;
    setManualQuantity(value);
    // Update quantity state with numeric value (default to 1 if invalid)
    const numValue = parseInt(value, 10);
    if (!isNaN(numValue) && numValue > 0) {
      setQuantity(numValue);
      form.setValue('quantity', numValue);
    } else {
      setQuantity(1);
      form.setValue('quantity', 1);
    }
  };
  
  const handleIncrement = () => {
    const newQty = quantity + 1;
    setQuantity(newQty);
    setManualQuantity(newQty.toString());
    form.setValue('quantity', newQty);
  };
  
  const handleDecrement = () => {
    if (quantity > 1) {
      const newQty = quantity - 1;
      setQuantity(newQty);
      setManualQuantity(newQty.toString());
      form.setValue('quantity', newQty);
    }
  };
  
  // Update form when a product is selected
  useEffect(() => {
    if (selectedProduct) {
      const hasPalletInfo = selectedProduct.itemsPerPallet && selectedProduct.itemsPerPallet > 1;
      // Initialize toggle to ON if product has itemsPerPallet value
      setUsePalletQty(hasPalletInfo);
      
      // Set quantity to itemsPerPallet if available, otherwise 1
      const newQty = hasPalletInfo ? selectedProduct.itemsPerPallet : 1;
      setQuantity(newQty);
      setManualQuantity(newQty.toString());
      form.setValue('quantity', newQty);
    }
  }, [selectedProduct, form]);

  const handleSubmit = (values: FormValues) => {
    if (!selectedProduct) {
      // Require product selection before submission
      toast({
        title: "No product selected",
        description: "Please search and select a product first",
        variant: "destructive",
      });
      return;
    }
    
    onSubmit({
      barcode: selectedProduct.barcode,
      name: selectedProduct.name,
      quantity: quantity, // Use the quantity from our state
      action: values.action,
      productId: selectedProduct.id,
    });
  };
  
  const handleProductSelect = (product: any) => {
    setSelectedProduct(product);
    setIsSearchOpen(false);
  };

  return (
    <Dialog open={isOpen} onOpenChange={onClose}>
      <DialogContent className="sm:max-w-md">
        <DialogTitle>Manual Entry</DialogTitle>
        <DialogDescription>
          Search for a product or enter details manually:
        </DialogDescription>
        
        {/* Product Search Section */}
        <div className="mb-4">
          <Label className="text-sm font-medium mb-1.5 flex items-center text-gray-800">
            <Search className="h-4 w-4 mr-1.5" style={{ color: THEME_COLOR }} />
            <span className="font-semibold">Search & Select an Item (Required)</span>
          </Label>
          <p className="text-xs text-gray-500 mb-2">
            Search by product name, SKU, barcode or category
          </p>
          
          <div className="relative">
            <Command className="rounded-lg border shadow-md" style={{ borderColor: `${THEME_COLOR}40` }}>
              <CommandInput 
                placeholder="Type to search inventory..." 
                value={searchQuery}
                onValueChange={setSearchQuery}
                onFocus={() => setIsSearchOpen(true)}
                className="border-0 focus:ring-2"
                style={{ "--ring-color": `${THEME_COLOR}30` } as React.CSSProperties}
              />
              
              {isSearchOpen && (
                <CommandList className="absolute w-full z-50 bg-white rounded-b-lg border-t max-h-[200px] overflow-y-auto">
                  {isLoading ? (
                    <div className="p-2 text-center text-sm text-gray-500">
                      Loading products...
                    </div>
                  ) : filteredProducts.length === 0 ? (
                    <CommandEmpty className="py-3 text-center text-sm">
                      No products found.
                    </CommandEmpty>
                  ) : (
                    <CommandGroup>
                      {filteredProducts.slice(0, 10).map((product: any) => (
                        <CommandItem
                          key={product.id}
                          value={product.id.toString()}
                          onSelect={() => handleProductSelect(product)}
                          className="flex justify-between items-center p-2 cursor-pointer hover:bg-gray-100"
                        >
                          <div className="flex flex-col">
                            <span className="font-medium text-[#001d6e]">{product.name}</span>
                            <div className="flex space-x-3 text-xs text-gray-500">
                              <span>SKU: {product.itemNo || 'N/A'}</span>
                              <span>Barcode: {product.barcode}</span>
                            </div>
                          </div>
                          <span className="text-xs bg-gray-100 px-2 py-1 rounded">
                            Stock: {product.inStock || 0}
                          </span>
                        </CommandItem>
                      ))}
                    </CommandGroup>
                  )}
                </CommandList>
              )}
            </Command>
          </div>
        </div>
        
        {/* Selected Product Details */}
        {selectedProduct && (
          <div className="mt-4 mb-4">
            <div className="flex items-center justify-center w-16 h-16 mx-auto rounded-full" style={{ backgroundColor: `${THEME_COLOR}20` }}>
              <CheckCircle className="w-8 h-8" style={{ color: THEME_COLOR }} />
            </div>
            
            <DialogTitle className="mt-4 text-xl font-medium text-center">Product Selected</DialogTitle>
            <DialogDescription className="text-center">
              Please review the product details below.
            </DialogDescription>
            
            <div className="mt-4 p-4 bg-gray-50 rounded-lg">
              <div className="grid grid-cols-2 gap-4">
                <div>
                  <p className="text-xs text-gray-500">Item Category</p>
                  <p className="font-medium">{selectedProduct?.category || 'N/A'}</p>
                </div>
                <div>
                  <p className="text-xs text-gray-500">Current Stock</p>
                  <p className="font-medium">{selectedProduct?.inStock || 0}</p>
                </div>
                <div className="col-span-2">
                  <p className="text-xs text-gray-500">Barcode</p>
                  <p className="font-mono bg-white p-2 rounded border border-gray-200 text-center">
                    {selectedProduct.barcode}
                  </p>
                </div>
                <div className="col-span-2">
                  <p className="text-xs text-gray-500">Product</p>
                  <p className="font-medium">
                    {selectedProduct?.name || 'Unknown product'}
                  </p>
                  <div className="text-xs mt-1">
                    <span className="text-gray-500">SKU: {selectedProduct.itemNo || 'N/A'}</span>
                  </div>
                </div>
                
                {/* Units Per Pallet Info */}
                {selectedProduct?.itemsPerPallet > 0 && (
                  <div className="col-span-2 mt-2 border-t border-gray-100 pt-2">
                    <div className="flex items-center justify-between">
                      <div className="flex items-center">
                        <span className="text-sm font-medium">Units per pallet: </span>
                        <span className="text-sm font-bold ml-2">{selectedProduct.itemsPerPallet}</span>
                      </div>
                    </div>
                  </div>
                )}
              </div>
            </div>
          </div>
        )}
        
        <Separator className="my-2" />
        
        <Form {...form}>
          <form onSubmit={form.handleSubmit(handleSubmit)} className="space-y-4">
            <div className="grid grid-cols-2 gap-4">
              <FormField
                control={form.control}
                name="barcodeType"
                render={({ field }) => (
                  <FormItem>
                    <FormLabel className="flex items-center">
                      <Barcode className="h-3.5 w-3.5 mr-1" />
                      Type
                    </FormLabel>
                    <Select 
                      onValueChange={field.onChange} 
                      defaultValue={field.value}
                    >
                      <FormControl>
                        <SelectTrigger>
                          <SelectValue placeholder="Select type" />
                        </SelectTrigger>
                      </FormControl>
                      <SelectContent>
                        <SelectItem value="EAN13">EAN-13</SelectItem>
                        <SelectItem value="UPC">UPC-A</SelectItem>
                        <SelectItem value="CODE128">Code 128</SelectItem>
                        <SelectItem value="QR">QR Code</SelectItem>
                        <SelectItem value="OTHER">Other</SelectItem>
                      </SelectContent>
                    </Select>
                    <FormMessage />
                  </FormItem>
                )}
              />
              
              <FormField
                control={form.control}
                name="action"
                render={({ field }) => (
                  <FormItem>
                    <FormLabel className="flex items-center">
                      <ShoppingCart className="h-3.5 w-3.5 mr-1" />
                      Action
                    </FormLabel>
                    <Select 
                      onValueChange={field.onChange} 
                      defaultValue={field.value}
                    >
                      <FormControl>
                        <SelectTrigger>
                          <SelectValue placeholder="Select action" />
                        </SelectTrigger>
                      </FormControl>
                      <SelectContent>
                        <SelectItem value="add">Add to inventory</SelectItem>
                        <SelectItem value="remove">Remove from inventory</SelectItem>
                        <SelectItem value="update">Update quantity</SelectItem>
                      </SelectContent>
                    </Select>
                    <FormMessage />
                  </FormItem>
                )}
              />
            </div>
            
            {/* Barcode and product name fields removed as they're already shown in product details */}
            
            {/* Pallet Toggle */}
            {selectedProduct?.itemsPerPallet > 0 && (
              <div className="col-span-2 mt-2 mb-3">
                <div className="flex items-center justify-between">
                  <div className="flex items-center space-x-2">
                    <Switch 
                      id="pallet-mode" 
                      checked={usePalletQty} 
                      onCheckedChange={handleToggleChange}
                      style={{ 
                        backgroundColor: usePalletQty ? THEME_COLOR : undefined,
                        borderColor: THEME_COLOR
                      }}
                    />
                    <Label 
                      htmlFor="pallet-mode" 
                      className="text-sm font-medium cursor-pointer"
                    >
                      Use pallet quantity ({selectedProduct?.itemsPerPallet})
                    </Label>
                  </div>
                </div>
              </div>
            )}
            
            {/* Quantity Control */}
            <div className="col-span-2 mt-2">
              <p className="text-xs text-gray-500 mb-1">
                {usePalletQty ? "Items Per Pallet" : "Quantity"}
              </p>
              
              {usePalletQty ? (
                <div className="flex items-center justify-between mt-1 bg-white p-2 rounded border border-gray-200">
                  <Button 
                    type="button"
                    variant="outline" 
                    size="icon" 
                    className="h-8 w-8 rounded-full"
                    onClick={handleDecrement}
                    style={{ borderColor: THEME_COLOR }}
                  >
                    <Minus className="h-4 w-4" style={{ color: THEME_COLOR }} />
                  </Button>
                  <span className="font-medium text-lg">{quantity}</span>
                  <Button 
                    type="button"
                    variant="outline" 
                    size="icon" 
                    className="h-8 w-8 rounded-full"
                    onClick={handleIncrement}
                    style={{ borderColor: THEME_COLOR }}
                  >
                    <Plus className="h-4 w-4" style={{ color: THEME_COLOR }} />
                  </Button>
                </div>
              ) : (
                <div className="mt-1">
                  <Input
                    type="number"
                    value={manualQuantity}
                    onChange={handleManualQuantityChange}
                    min="1"
                    placeholder="Enter quantity"
                    className="w-full"
                    style={{ 
                      borderColor: `${THEME_COLOR}80`, 
                      outline: `1px solid ${THEME_COLOR}` 
                    }}
                  />
                </div>
              )}
            </div>
            
            <div className="flex justify-end space-x-3 pt-2">
              <Button type="button" variant="outline" onClick={onClose}>
                Cancel
              </Button>
              <Button 
                type="submit"
                style={{ backgroundColor: THEME_COLOR, color: 'white' }}
              >
                Submit
              </Button>
            </div>
          </form>
        </Form>
      </DialogContent>
    </Dialog>
  );
};

export default ManualEntryModal;
