import { useState } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { AlertCircle, Upload, CheckCircle, XCircle } from "lucide-react";
import { apiRequest } from "@/lib/queryClient";
import { Progress } from "@/components/ui/progress";

interface ProformaSlipCSVImportProps {
  onImportSuccess: () => void;
}

export function ProformaSlipCSVImport({ onImportSuccess }: ProformaSlipCSVImportProps) {
  const [file, setFile] = useState<File | null>(null);
  const [importing, setImporting] = useState(false);
  const [importStatus, setImportStatus] = useState<'idle' | 'success' | 'error'>('idle');
  const [statusMessage, setStatusMessage] = useState<string>('');
  const [importCount, setImportCount] = useState<number>(0);
  const [progress, setProgress] = useState<number>(0);

  const handleFileChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    if (e.target.files && e.target.files.length > 0) {
      setFile(e.target.files[0]);
      setImportStatus('idle');
      setStatusMessage('');
    }
  };

  const handleImport = async () => {
    if (!file) {
      setImportStatus('error');
      setStatusMessage('Please select a CSV file to import');
      return;
    }

    try {
      setImporting(true);
      setProgress(10);
      
      const formData = new FormData();
      formData.append('file', file);

      setProgress(30);
      
      const response = await apiRequest('POST', '/api/proforma-slips/import-csv', formData, true);
      
      setProgress(80);
      
      const data = await response.json();
      setProgress(100);
      
      if (response.ok) {
        setImportStatus('success');
        setStatusMessage(`Successfully imported ${data.slipsCreated ?? 0} slips and ${data.itemsCreated ?? 0} items.`);
        setImportCount(data.slipsCreated ?? 0);
        
        // Immediate success callback without delay
        onImportSuccess();
        
        // Reset file input
        setFile(null);
        const fileInput = document.getElementById('csv-file') as HTMLInputElement;
        if (fileInput) fileInput.value = '';
      } else {
        throw new Error(data.message || 'Error importing CSV file');
      }
    } catch (error) {
      console.error('Import error:', error);
      setImportStatus('error');
      setStatusMessage(error instanceof Error ? error.message : 'Failed to import CSV file');
    } finally {
      setImporting(false);
    }
  };

  return (
    <div className="space-y-6">
      <div className="grid w-full max-w-sm items-center gap-1.5">
        <Input
          id="csv-file"
          type="file"
          accept=".csv"
          onChange={handleFileChange}
          disabled={importing}
          className="cursor-pointer"
        />
        <p className="text-sm text-muted-foreground mt-1">
          The CSV file should include columns for slip details (orderNumber, orderDate, partyName, etc.) 
          and item details (productId, quantity, etc.).
        </p>
      </div>

      {importing && (
        <div className="space-y-2">
          <Progress value={progress} className="w-full" />
          <p className="text-sm text-center text-muted-foreground">
            Importing... Please wait.
          </p>
        </div>
      )}

      {importStatus === 'success' && (
        <Alert variant="default" className="bg-green-50 border-green-300">
          <CheckCircle className="h-4 w-4 text-green-600" />
          <AlertTitle className="text-green-800">Import Successful</AlertTitle>
          <AlertDescription className="text-green-700">
            {statusMessage}
          </AlertDescription>
        </Alert>
      )}

      {importStatus === 'error' && (
        <Alert variant="destructive">
          <XCircle className="h-4 w-4" />
          <AlertTitle>Import Failed</AlertTitle>
          <AlertDescription>
            {statusMessage}
          </AlertDescription>
        </Alert>
      )}

      <div className="flex justify-end space-x-2">
        <Button
          variant="default"
          disabled={!file || importing}
          onClick={handleImport}
          className="space-x-1"
        >
          <Upload className="h-4 w-4" />
          <span>Upload and Import</span>
        </Button>
      </div>
    </div>
  );
}

export default ProformaSlipCSVImport;