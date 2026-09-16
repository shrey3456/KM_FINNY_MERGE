import { useState } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { AlertCircle, Download, CheckCircle, XCircle, RefreshCw, Shield } from "lucide-react";
import { apiRequest } from "@/lib/queryClient";
import { Progress } from "@/components/ui/progress";
import { useUser } from "@/hooks/use-user";
import { format } from "date-fns";
import { getPermissionsForRole } from "@/lib/permissions";

interface ProformaSlipAPIImportProps {
  onImportSuccess: () => void;
}

export function ProformaSlipAPIImport({ onImportSuccess }: ProformaSlipAPIImportProps) {
  const { user } = useUser();
  const permissions = getPermissionsForRole(user?.role);
  const [importing, setImporting] = useState(false);
  const [importStatus, setImportStatus] = useState<'idle' | 'success' | 'error'>('idle');
  const [statusMessage, setStatusMessage] = useState<string>('');
  const [importCount, setImportCount] = useState<number>(0);
  const [progress, setProgress] = useState<number>(0);
  // Today's LOCAL date — toISOString() is UTC, which in India is still yesterday until 5:30 am.
  const [dateRange, setDateRange] = useState({
    startDate: format(new Date(), 'yyyy-MM-dd'),
    endDate: format(new Date(), 'yyyy-MM-dd')
  });

  // Check if user has admin or super-admin role
  const canImportFromNotion = user?.role === 'admin' || user?.role === 'super-admin';

  const handleAPIImport = async () => {
    try {
      setImporting(true);
      setProgress(10);
      setImportStatus('idle');
      setStatusMessage('Connecting to API...');
      
      // Call fast backend API endpoint that will fetch from Notion
      const response = await apiRequest('POST', '/api/fast-notion-import', {
        startDate: dateRange.startDate,
        endDate: dateRange.endDate
      });
      
      setProgress(50);
      setStatusMessage('Processing API data...');
      
      const data = await response.json();
      setProgress(100);
      
      if (response.ok) {
        setImportStatus('success');
        setStatusMessage(`Successfully imported ${data.slipsCreated ?? 0} slips and ${data.itemsCreated ?? 0} items from API.`);
        setImportCount(data.slipsCreated ?? 0);
        
        // Trigger success callback
        onImportSuccess();
      } else {
        throw new Error(data.message || 'Error importing from API');
      }
    } catch (error) {
      console.error('API Import error:', error);
      setImportStatus('error');
      setStatusMessage(error instanceof Error ? error.message : 'Failed to import from API');
    } finally {
      setImporting(false);
    }
  };

  const handleRefreshToday = async () => {
    const today = format(new Date(), 'yyyy-MM-dd');
    setDateRange({ startDate: today, endDate: today });
    
    // Auto-trigger import for today's data
    setTimeout(() => {
      if (!importing) {
        handleAPIImport();
      }
    }, 100);
  };

  // Show access restricted message for non-admin users
  if (!canImportFromNotion) {
    return (
      <div className="space-y-4 p-4 border rounded-lg bg-gray-50">
        <div className="flex items-center space-x-2">
          <Shield className="h-5 w-5 text-gray-400" />
          <h3 className="text-lg font-semibold text-gray-600">Import from Notion</h3>
        </div>
        
        <Alert>
          <Shield className="h-4 w-4" />
          <AlertTitle>Access Restricted</AlertTitle>
          <AlertDescription>
            Only administrators and super-administrators can import data from Notion. 
            Current role: <span className="font-medium">{user?.role || 'unknown'}</span>
          </AlertDescription>
        </Alert>
      </div>
    );
  }

  return (
    <div className="space-y-4 p-4 border rounded-lg bg-white">
      <div className="flex items-center space-x-2">
        <Download className="h-5 w-5 text-[#001d6e]" />
        <h3 className="text-lg font-semibold text-[#001d6e]">Import from Notion</h3>
      </div>
      
      <div className="space-y-4">
        {/* Date Range Selection */}
        <div className="grid grid-cols-2 gap-4">
          <div className="space-y-2">
            <label className="text-sm font-medium text-gray-700">Start Date</label>
            <Input
              type="date"
              value={dateRange.startDate}
              onChange={(e) => setDateRange(prev => ({ ...prev, startDate: e.target.value }))}
              disabled={importing}
              className="w-full"
            />
          </div>
          <div className="space-y-2">
            <label className="text-sm font-medium text-gray-700">End Date</label>
            <Input
              type="date"
              value={dateRange.endDate}
              onChange={(e) => setDateRange(prev => ({ ...prev, endDate: e.target.value }))}
              disabled={importing}
              className="w-full"
            />
          </div>
        </div>

        {/* Quick Actions */}
        <div className="flex space-x-2">
          <Button
            onClick={handleRefreshToday}
            disabled={importing}
            variant="outline"
            size="sm"
            className="flex items-center space-x-2"
          >
            <RefreshCw className="h-4 w-4" />
            <span>Today's Data</span>
          </Button>
        </div>

        {/* Import Button */}
        <Button
          onClick={handleAPIImport}
          disabled={importing}
          className="w-full bg-[#001d6e] hover:bg-blue-700"
        >
          {importing ? (
            <>
              <RefreshCw className="mr-2 h-4 w-4 animate-spin" />
              Importing...
            </>
          ) : (
            <>
              <Download className="mr-2 h-4 w-4" />
              Import from Notion
            </>
          )}
        </Button>

        {/* Progress Bar */}
        {importing && (
          <div className="space-y-2">
            <Progress value={progress} className="w-full" />
            <p className="text-sm text-gray-600 text-center">{statusMessage}</p>
          </div>
        )}

        {/* Status Messages */}
        {importStatus === 'success' && (
          <Alert className="border-green-200 bg-green-50">
            <CheckCircle className="h-4 w-4 text-green-600" />
            <AlertTitle className="text-green-800">Import Successful</AlertTitle>
            <AlertDescription className="text-green-700">
              {statusMessage}
            </AlertDescription>
          </Alert>
        )}

        {importStatus === 'error' && (
          <Alert className="border-red-200 bg-red-50" variant="destructive">
            <XCircle className="h-4 w-4" />
            <AlertTitle>Import Failed</AlertTitle>
            <AlertDescription>
              {statusMessage}
            </AlertDescription>
          </Alert>
        )}
      </div>
    </div>
  );
}