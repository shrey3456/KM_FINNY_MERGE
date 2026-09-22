import { useState } from 'react';
import { useLocation } from 'wouter';
import ScannerView from '@/components/ScannerView';
import { useToast } from '@/hooks/use-toast';
import { Button } from '@/components/ui/button';
import { Pencil } from 'lucide-react';

const Scanner = () => {
  const { toast } = useToast();
  const [, setLocation] = useLocation();
  const [scannedOperation, setScannedOperation] = useState<any>(null);
  const [scannedItems, setScannedItems] = useState<any[]>([]);

  // Handler for when an order is scanned
  const handleOrderScanned = (operation: any, items: any[]) => {
    setScannedOperation(operation);
    setScannedItems(items);
    
    toast({
      title: "Order Ready for Edit",
      description: `Tap the button below to open the edit dialog for order #${operation.referenceNumber}`,
      duration: 5000,
    });
  };
  
  // Navigate to LoadOperations and open edit dialog for the scanned operation
  const navigateToEdit = () => {
    if (scannedOperation) {
      // Store operation info in localStorage to pass to LoadOperations page
      localStorage.setItem('scannerTargetOperation', JSON.stringify({
        operationId: scannedOperation.id,
        referenceNumber: scannedOperation.referenceNumber,
        timestamp: Date.now()
      }));
      
      // Navigate to the Load Operations page. /load-operations was the retired screen and no
      // longer exists as a route, so this pointed at nothing.
      setLocation('/loading');
    }
  };

  return (
    <div className="flex-1 overflow-y-auto">
      <div className="w-full">
        {/* Scanner Component - Full width for maximum scanning area */}
        <div className="px-4 pt-4 pb-4">
          <ScannerView 
            onScanComplete={(result) => {
              console.log('Scan completed:', result);
            }}
            onOrderScanned={handleOrderScanned}
          />
          
          {scannedOperation && (
            <div className="mt-4 p-4 bg-blue-50 rounded-lg shadow-sm border border-blue-200">
              <h3 className="text-lg font-semibold text-blue-800">Order #{scannedOperation.referenceNumber}</h3>
              <p className="text-sm text-blue-600 mt-1">
                {scannedItems.length} items ready for edit
              </p>
              <Button 
                className="w-full mt-3 bg-[#001d6e] hover:bg-[#00154b]"
                onClick={navigateToEdit}
              >
                <Pencil className="h-4 w-4 mr-2" />
                Edit Operation
              </Button>
            </div>
          )}
        </div>
      </div>
    </div>
  );
};

export default Scanner;
