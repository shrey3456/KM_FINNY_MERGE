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
import { 
  CheckCircle, 
  Plus, 
  Minus, 
  Search,
  ShoppingCart,
  Package,
  Tag
} from 'lucide-react';
import { useState, useEffect } from 'react';
import { useToast } from '@/hooks/use-toast';
import {
  Command,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
} from "@/components/ui/command";
import { useQuery } from '@tanstack/react-query';

export type ScanEntry = {
  barcode: string;
  name: string;
  quantity: number;
  action: "add" | "remove" | "update";
  productId: number;
};

type NewManualEntryModalProps = {
  isOpen: boolean;
  onClose: () => void;
  onSubmit: (data: ScanEntry) => void;
};

// Blue theme color to match app's main theme
const THEME_COLOR = '#001D6E';

const NewManualEntryModal = ({ 
  isOpen, 
  onClose, 
  onSubmit 
}: NewManualEntryModalProps) => {
  const [searchQuery, setSearchQuery] = useState('');
  const [selectedProduct, setSelectedProduct] = useState<any>(null);
  const [isSearchOpen, setIsSearchOpen] = useState(false);
  const { toast } = useToast();
  
  // Always use "add" as the action since we removed the action buttons
  
  // For pallet quantity toggle
  const [usePalletQty, setUsePalletQty] = useState(false);
  const [quantity, setQuantity] = useState(1);
  const [manualQuantity, setManualQuantity] = useState('1');
  
  // Fetch products from API for search - request all products (up to 1000)
  const { data: products = [], isLoading } = useQuery({
    queryKey: ['/api/products', { limit: 1000 }],
    staleTime: 60000, // 1 minute
  });
  
  // Filter products based on search query - only by name, category, and barcode
  const filteredProducts = searchQuery.length > 0
    ? (products as any[]).filter((product: any) => 
        (product.name?.toLowerCase() || '').includes(searchQuery.toLowerCase()) || 
        (product.barcode?.toLowerCase() || '').includes(searchQuery.toLowerCase()) ||
        (product.category?.toLowerCase() || '').includes(searchQuery.toLowerCase())
      )
    : (products as any[]); // Show all products when search is empty
  
  // Handle toggle change
  const handleToggleChange = (checked: boolean) => {
    setUsePalletQty(checked);
    if (checked && selectedProduct?.itemsPerPallet) {
      // When turning toggle ON, reset to pallet quantity
      const newQty = selectedProduct.itemsPerPallet;
      setQuantity(newQty);
      setManualQuantity(newQty.toString());
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
    } else {
      setQuantity(1);
    }
  };
  
  const handleIncrement = () => {
    const newQty = quantity + 1;
    setQuantity(newQty);
    setManualQuantity(newQty.toString());
  };
  
  const handleDecrement = () => {
    if (quantity > 1) {
      const newQty = quantity - 1;
      setQuantity(newQty);
      setManualQuantity(newQty.toString());
    }
  };
  
  // Update values when a product is selected
  useEffect(() => {
    if (selectedProduct) {
      const hasPalletInfo = selectedProduct.itemsPerPallet && selectedProduct.itemsPerPallet > 0;
      // Initialize toggle to ON if product has itemsPerPallet value
      setUsePalletQty(hasPalletInfo);
      
      // Always set quantity to itemsPerPallet if available, otherwise 1
      const newQty = hasPalletInfo ? selectedProduct.itemsPerPallet : 1;
      setQuantity(newQty);
      setManualQuantity(newQty.toString());
    }
  }, [selectedProduct]);
  
  const handleSubmit = () => {
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
      quantity: quantity,
      action: "add", // Always use "add" action as we removed action buttons
      productId: selectedProduct.id,
    });
    
    onClose();
  };
  
  const handleProductSelect = (product: any) => {
    setSelectedProduct(product);
    setIsSearchOpen(false);
  };

  return (
    <Dialog open={isOpen} onOpenChange={onClose}>
      <DialogContent className="sm:max-w-md">
        <DialogTitle className="text-xl font-medium text-center">Manual Entry</DialogTitle>
        <DialogDescription className="text-center">
          Search for a product or enter details manually.
        </DialogDescription>
        
        {/* Product Search Section */}
        {!selectedProduct && (
          <div className="mt-4 mb-4">
            <div className="flex items-center justify-center w-16 h-16 mx-auto rounded-full" style={{ backgroundColor: `${THEME_COLOR}20` }}>
              <Search className="w-8 h-8" style={{ color: THEME_COLOR }} />
            </div>
            
            <DialogTitle className="mt-4 text-xl font-medium text-center">Search Product</DialogTitle>
            <DialogDescription className="text-center">
              Find a product by name, barcode or category
            </DialogDescription>
            
            <div className="mt-6 relative">
              <div className="relative">
                <Search className="w-5 h-5 absolute left-3 top-1/2 transform -translate-y-1/2 text-gray-400" />
                <Input 
                  placeholder="Type to search products..." 
                  value={searchQuery}
                  onChange={(e) => setSearchQuery(e.target.value)}
                  onFocus={() => setIsSearchOpen(true)}
                  className="pl-10 py-6 text-base border-2"
                  style={{ 
                    borderColor: `${THEME_COLOR}40`,
                    boxShadow: `0 0 0 2px ${THEME_COLOR}10`
                  }}
                />
              </div>
              
              {isSearchOpen && (
                <div className="absolute w-full z-50 mt-1 bg-white rounded-lg border shadow-lg max-h-[300px] overflow-y-auto">
                  {isLoading ? (
                    <div className="p-4 text-center text-sm text-gray-500">
                      Loading products...
                    </div>
                  ) : filteredProducts.length === 0 ? (
                    <div className="py-4 text-center text-sm">
                      No products found matching "{searchQuery}"
                    </div>
                  ) : (
                    <div>
                      {filteredProducts.map((product: any) => (
                        <div
                          key={product.id}
                          onClick={() => handleProductSelect(product)}
                          className="flex flex-col p-3 cursor-pointer hover:bg-gray-50 border-b border-gray-100 last:border-0"
                        >
                          <span className="font-medium text-[#001d6e]">{product.name}</span>
                          <div className="mt-1 text-xs text-gray-500">
                            <span>Barcode: {product.barcode}</span>
                            {product.itemsPerPallet > 0 && (
                              <span className="ml-3 bg-blue-100 text-blue-800 px-1.5 py-0.5 rounded-full text-[10px] font-medium">
                                Pallet Qty: {product.itemsPerPallet}
                              </span>
                            )}
                          </div>
                        </div>
                      ))}
                    </div>
                  )}
                </div>
              )}
            </div>
          </div>
        )}
        
        {/* Selected Product Details */}
        {selectedProduct && (
          <>
            <div className="flex items-center justify-center w-16 h-16 mx-auto rounded-full" style={{ backgroundColor: `${THEME_COLOR}20` }}>
              <CheckCircle className="w-8 h-8" style={{ color: THEME_COLOR }} />
            </div>
            
            <DialogTitle className="mt-4 text-xl font-medium text-center">Product Selected</DialogTitle>
            <DialogDescription className="text-center">
              Please review the product details below.
            </DialogDescription>
            
            <div className="mt-4 p-4 bg-gray-50 rounded-lg">
              <div className="grid grid-cols-1 gap-4">
                <div>
                  <p className="text-xs text-gray-500">Item Category</p>
                  <p className="font-medium">{selectedProduct?.category || 'N/A'}</p>
                </div>
                <div>
                  <p className="text-xs text-gray-500">Barcode</p>
                  <p className="font-mono bg-white p-2 rounded border border-gray-200 text-center">
                    {selectedProduct.barcode}
                  </p>
                </div>
                <div>
                  <p className="text-xs text-gray-500">Product</p>
                  <p className="font-medium">
                    {selectedProduct?.name || 'Unknown product'}
                  </p>
                  <div className="text-xs mt-1">
                    <span className="text-gray-500">SKU: {selectedProduct.itemNo || 'N/A'}</span>
                  </div>
                </div>
                
                {/* Pallet Toggle */}
                {selectedProduct?.itemsPerPallet > 0 && (
                  <div className="mt-2 border-t border-gray-100 pt-2">
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
                <div className="mt-2">
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
              </div>
            </div>
          </>
        )}
        
        {/* Action Buttons */}
        <div className="mt-6 flex flex-wrap gap-3">
          <Button 
            variant="outline" 
            className="flex-1" 
            onClick={onClose}
          >
            Cancel
          </Button>
          
          <Button 
            variant="default" 
            className="flex-1" 
            style={{ backgroundColor: THEME_COLOR, color: 'white' }}
            onClick={handleSubmit}
            disabled={!selectedProduct}
          >
            {selectedProduct ? "Approve & Save" : "Select Product"}
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  );
};

export default NewManualEntryModal;