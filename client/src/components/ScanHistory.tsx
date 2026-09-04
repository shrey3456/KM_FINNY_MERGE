import { useQuery } from '@tanstack/react-query';
import { Card, CardContent, CardHeader } from '@/components/ui/card';
import { ScanLine, ArrowRight } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Link } from 'wouter';
import { format } from 'date-fns';

const ScanHistoryItem = ({ scan }: { scan: any }) => {
  // Format the timestamp
  const formattedDateTime = scan.scannedAt ? 
    format(new Date(scan.scannedAt), 'MMM d, yyyy h:mm a') : 
    'Unknown time';
  
  const formattedDate = scan.scannedAt ?
    format(new Date(scan.scannedAt), 'dd/MM/yyyy h:mm a') :
    'Unknown date';
    
  // Determine status message and color based on action
  let statusText = 'Scanned';
  let statusColor = 'text-gray-600';
  
  if (scan.action === 'add') {
    statusText = 'Added to inventory';
    statusColor = 'text-green-600';
  } else if (scan.action === 'remove') {
    statusText = 'Removed from inventory';
    statusColor = 'text-[#001d6e]';
  } else if (scan.action === 'update') {
    statusText = 'Updated quantity';
    statusColor = 'text-blue-600';
  }
  
  return (
    <div className="p-4 border-b border-gray-100">
      <div className="flex items-start justify-between mb-2">
        <div className="flex items-center space-x-3">
          <div className="w-10 h-10 bg-gray-100 rounded-lg flex items-center justify-center text-gray-500">
            <ScanLine className="h-5 w-5" />
          </div>
          <div>
            <p className="font-medium text-[#001d6e]">{scan.productName || 'Unknown product'}</p>
            <div className="flex items-center space-x-2 text-sm text-gray-500">
              <span>SKU: {scan.productSku || 'N/A'}</span>
              <span className="w-1 h-1 bg-gray-300 rounded-full"></span>
              <span>Barcode: {scan.barcode}</span>
            </div>
          </div>
        </div>
        <div className="text-right">
          <p className={`text-sm font-medium ${statusColor}`}>{statusText}</p>
          <p className="text-xs text-gray-500">{formattedDateTime}</p>
        </div>
      </div>
      
      <div className="ml-13 pl-13 grid grid-cols-2 gap-4 mt-2">
        <div className="col-span-2 sm:col-span-1">
          <div className="flex flex-col space-y-1">
            <div className="flex justify-between">
              <span className="text-xs text-gray-500">Units per pallet:</span>
              <span className="text-xs font-medium">{scan.itemsPerPallet || 0}</span>
            </div>
            <div className="flex justify-between">
              <span className="text-xs text-gray-500">Pallets:</span>
              <span className="text-xs font-medium">{scan.pallets || 0}</span>
            </div>
            <div className="flex justify-between">
              <span className="text-xs text-gray-500">Quantity:</span>
              <span className="text-xs font-medium">{scan.quantity || 1}</span>
            </div>
          </div>
        </div>
        
        <div className="col-span-2 sm:col-span-1">
          <div className="flex flex-col space-y-1">
            <div className="flex justify-between">
              <span className="text-xs text-gray-500">Scanned by:</span>
              <span className="text-xs font-semibold text-purple-700">{scan.scannerName || 'Unknown'}</span>
            </div>
            <div className="flex justify-between">
              <span className="text-xs text-gray-500">Department:</span>
              <span className="text-xs font-medium">{scan.scannerDepartment || 'N/A'}</span>
            </div>
            {scan.notes && (
              <div className="flex justify-between">
                <span className="text-xs text-gray-500">Notes:</span>
                <span className="text-xs font-medium">{scan.notes}</span>
              </div>
            )}
          </div>
        </div>
      </div>
    </div>
  );
};

const EmptyState = () => (
  <div className="p-8 text-center">
    <ScanLine className="mx-auto h-12 w-12 text-gray-400" />
    <h3 className="mt-2 text-lg font-medium text-gray-900">No scans yet</h3>
    <p className="mt-1 text-gray-500">Start scanning barcodes to see your history here.</p>
    <div className="mt-6">
      <Link href="/scan">
        <Button>Start Scanning</Button>
      </Link>
    </div>
  </div>
);

const ScanHistory = () => {
  const { data: scanHistory = [], isLoading, error } = useQuery({
    queryKey: ['/api/scans'],
    staleTime: 10000 // 10 seconds
  });

  // Cast to array for type safety
  const scans = scanHistory as any[];

  return (
    <Card>
      <CardHeader className="p-4 border-b border-gray-200 flex justify-between items-center">
        <h3 className="text-lg font-medium">Recent Scans</h3>
        <Link href="/scan-history">
          <Button variant="link" className="text-primary p-0">
            View All <ArrowRight className="ml-1 h-4 w-4" />
          </Button>
        </Link>
      </CardHeader>
      
      {isLoading ? (
        <CardContent className="p-4">
          <p className="text-center text-gray-500">Loading scan history...</p>
        </CardContent>
      ) : error ? (
        <CardContent className="p-4">
          <p className="text-center text-blue-500">Error loading scan history</p>
        </CardContent>
      ) : scans.length > 0 ? (
        <div className="divide-y divide-gray-200">
          {scans.slice(0, 3).map((scan: any) => (
            <ScanHistoryItem key={scan.id} scan={scan} />
          ))}
        </div>
      ) : (
        <EmptyState />
      )}
    </Card>
  );
};

export default ScanHistory;
