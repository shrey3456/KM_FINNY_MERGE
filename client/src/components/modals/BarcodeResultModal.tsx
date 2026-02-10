import { 
  Dialog, 
  DialogContent, 
  DialogTitle, 
  DialogDescription
} from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { Link } from 'wouter';
import { CheckCircle, Plus, Minus } from 'lucide-react';
import { format } from 'date-fns';
import { useState, useEffect } from 'react';
import { Switch } from '@/components/ui/switch';
import { Label } from '@/components/ui/label';
import { Input } from '@/components/ui/input';

type BarcodeResultModalProps = {
  isOpen: boolean;
  onClose: () => void;
  scanResult: {
    barcode: string;
    format: string;
    text: string;
    timestamp: Date;
    type?: 'order' | 'product'; // Added type property
  } | null;
  productDetails: any;
  onConfirm?: (quantity?: number) => void;
  currentOrderNumber?: string | null;
};

// Blue color theme to match the app's main theme
const THEME_COLOR = '#001D6E';

const BarcodeResultModal = ({ 
  isOpen, 
  onClose, 
  scanResult, 
  productDetails,
  onConfirm,
  currentOrderNumber
}: BarcodeResultModalProps) => {
  if (!scanResult) return null;

  const formattedTime = format(scanResult.timestamp, 'MMM d, yyyy HH:mm');

  const hasPalletQty = productDetails?.itemsPerPallet && productDetails.itemsPerPallet > 1;
  // Initialize toggle to ON if product has itemsPerPallet value
  const [usePalletQty, setUsePalletQty] = useState(hasPalletQty);
  // Initialize quantity state
  const [quantity, setQuantity] = useState<number>(hasPalletQty ? productDetails.itemsPerPallet : 1);
  // For manual quantity entry when toggle is off
  const [manualQuantity, setManualQuantity] = useState<string>(quantity.toString());

  // Reset values when product details change
  useEffect(() => {
    if (productDetails) {
      const hasPalletInfo = productDetails.itemsPerPallet && productDetails.itemsPerPallet > 1;
      setUsePalletQty(hasPalletInfo);
      const newQty = hasPalletInfo ? productDetails.itemsPerPallet : 1;
      setQuantity(newQty);
      setManualQuantity(newQty.toString());
    }
  }, [productDetails]);

  // Handle toggle change
  const handleToggleChange = (checked: boolean) => {
    setUsePalletQty(checked);
    if (checked && productDetails?.itemsPerPallet) {
      // When turning toggle ON, reset to pallet quantity
      setQuantity(productDetails.itemsPerPallet);
      setManualQuantity(productDetails.itemsPerPallet.toString());
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

  return (
    <Dialog open={isOpen} onOpenChange={onClose}>
      <DialogContent className="sm:max-w-md">
        <div className="flex items-center justify-center w-16 h-16 mx-auto rounded-full" style={{ backgroundColor: `${THEME_COLOR}20` }}>
          <CheckCircle className="w-8 h-8" style={{ color: THEME_COLOR }} />
        </div>

        <DialogTitle className="mt-4 text-xl font-medium text-center">
          {scanResult.type === 'order' ? 'Order Selected' : 'Barcode Detected'}
        </DialogTitle>
        <DialogDescription className="text-center">
          {scanResult.type === 'order'
            ? "Order has been selected. You can now scan product barcodes."
            : onConfirm 
              ? "Please review the scan and approve to save it."
              : "Barcode has been successfully scanned."}
        </DialogDescription>

        <div className="mt-4 p-4 bg-gray-50 rounded-lg">
          <div className="grid grid-cols-2 gap-4">
            <div>
              <p className="text-xs text-gray-500">Item Category</p>
              <p className="font-medium">{productDetails?.category || 'N/A'}</p>
            </div>
            <div>
              <p className="text-xs text-gray-500">Timestamp</p>
              <p className="font-medium">{formattedTime}</p>
            </div>
            <div className="col-span-2">
              <p className="text-xs text-gray-500">Barcode</p>
              <p className="font-mono bg-white p-2 rounded border border-gray-200 text-center">
                {scanResult.barcode}
              </p>
            </div>
            <div className="col-span-2">
              <p className="text-xs text-gray-500">Product</p>
              <p className="font-medium">
                {productDetails?.name || 'Unknown product'}
              </p>
              {productDetails && (
                <div className="text-xs mt-1">
                  <span className="text-gray-500">SKU: {productDetails.itemNo || productDetails.sku || 'N/A'}</span>
                </div>
              )}
              
              {/* Order context when scanning products */}
              {currentOrderNumber && scanResult?.type === 'product' && productDetails?.item && (
                <div className="mt-2 pt-2 border-t border-gray-200">
                  <div className="bg-blue-50 p-2 rounded-md">
                    <p className="text-xs text-blue-700 font-medium">Order #{currentOrderNumber} Item Details</p>
                    <div className="flex justify-between text-xs mt-1">
                      <span className="text-blue-800">From Order:</span>
                      <span className="font-medium">{productDetails.item.quantity || 1} units</span>
                    </div>
                    {productDetails.item.expectedLoad && (
                      <div className="flex justify-between text-xs mt-1">
                        <span className="text-blue-800">Expected Load:</span>
                        <span className="font-medium">{productDetails.item.expectedLoad} units</span>
                      </div>
                    )}
                  </div>
                </div>
              )}
            </div>
            {/* Pallet Toggle */}
            {hasPalletQty && (
              <div className="col-span-2 mt-2 border-t border-gray-100 pt-2">
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
                      Use pallet quantity ({productDetails?.itemsPerPallet})
                    </Label>
                  </div>
                </div>
              </div>
            )}

            {/* Quantity Control */}
            <div className="col-span-2 mt-2">
              <p className="text-xs text-gray-500">
                {usePalletQty ? "Items Per Pallet" : "Quantity"}
              </p>

              {usePalletQty ? (
                <div className="flex items-center justify-between mt-1 bg-white p-2 rounded border border-gray-200">
                  <Button 
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

        <div className="mt-6 flex flex-wrap gap-3">
          <Button variant="outline" className="flex-1" onClick={onClose}>
            Cancel
          </Button>

          {onConfirm && (
            <Button 
              variant="default" 
              className="flex-1" 
              style={{ backgroundColor: THEME_COLOR, color: 'white' }}
              onClick={() => {
                onConfirm(quantity);
                onClose();
              }}
            >
              Approve & Save
            </Button>
          )}
        </div>
      </DialogContent>
    </Dialog>
  );
};

export default BarcodeResultModal;