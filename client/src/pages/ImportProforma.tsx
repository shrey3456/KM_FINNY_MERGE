import React, { useState } from 'react';
import { useMutation } from '@tanstack/react-query';
import { useToast } from '@/hooks/use-toast';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardFooter, CardHeader, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { useUser } from '@/hooks/use-user';
import { Loader2 } from 'lucide-react';
import { SidebarWrapper } from '@/components/SidebarWrapper';
import { apiRequest } from '@/lib/queryClient';

export default function ImportProforma() {
  const [file, setFile] = useState<File | null>(null);
  const { toast } = useToast();
  const { user } = useUser();

  // Check if user has admin access
  const isAdmin = user?.role === 'admin' || user?.role === 'super-admin';
  
  const importMutation = useMutation({
    mutationFn: async (formData: FormData) => {
      // Use apiRequest with the formDataFlag set to true to properly handle formData
      const response = await apiRequest('POST', '/api/proforma-slips/import-csv', formData, true);
      
      if (!response.ok) {
        const errorData = await response.json();
        throw new Error(errorData.message || 'Failed to import proforma slips');
      }
      
      return response.json();
    },
    onSuccess: (data) => {
      toast({
        title: 'Import Successful',
        description: `Successfully imported ${data.slipsCreated} slips and ${data.itemsCreated} items.`,
      });
      setFile(null);
      // Reset file input
      const fileInput = document.getElementById('file') as HTMLInputElement;
      if (fileInput) fileInput.value = '';
    },
    onError: (error: Error) => {
      toast({
        title: 'Import Failed',
        description: error.message,
        variant: 'destructive',
      });
    },
  });

  const handleFileChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    if (e.target.files && e.target.files.length > 0) {
      setFile(e.target.files[0]);
    }
  };

  const handleSubmit = (e: React.FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    
    if (!file) {
      toast({
        title: 'No File Selected',
        description: 'Please select a CSV file to import.',
        variant: 'destructive',
      });
      return;
    }
    
    const formData = new FormData();
    formData.append('file', file);
    
    importMutation.mutate(formData);
  };

  if (!isAdmin) {
    return (
      <SidebarWrapper>
        <div className="container mx-auto py-10">
          <Card>
            <CardHeader>
              <CardTitle>Access Denied</CardTitle>
              <CardDescription>
                You do not have permission to access this page.
              </CardDescription>
            </CardHeader>
          </Card>
        </div>
      </SidebarWrapper>
    );
  }

  return (
    <SidebarWrapper>
      <div className="container mx-auto py-10">
        <Card>
          <CardHeader>
            <CardTitle>Import Proforma Slips</CardTitle>
            <CardDescription>
              Upload a CSV file to import proforma slips data. The CSV file should contain all the necessary columns to create proforma slips.
            </CardDescription>
          </CardHeader>
          <form onSubmit={handleSubmit}>
            <CardContent>
              <div className="grid w-full items-center gap-4">
                <div className="flex flex-col space-y-1.5">
                  <Label htmlFor="file">CSV File</Label>
                  <Input 
                    id="file" 
                    type="file" 
                    accept=".csv" 
                    onChange={handleFileChange}
                    disabled={importMutation.isPending}
                  />
                </div>
                {file && (
                  <div className="text-sm">
                    Selected file: <span className="font-medium">{file.name}</span> ({Math.round(file.size / 1024)} KB)
                  </div>
                )}
              </div>
            </CardContent>
            <CardFooter className="flex justify-between">
              <Button variant="outline" onClick={() => setFile(null)} disabled={!file || importMutation.isPending}>
                Clear
              </Button>
              <Button type="submit" disabled={!file || importMutation.isPending}>
                {importMutation.isPending ? (
                  <>
                    <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                    Importing...
                  </>
                ) : (
                  'Import Data'
                )}
              </Button>
            </CardFooter>
          </form>
        </Card>

        <Card className="mt-6">
          <CardHeader>
            <CardTitle>Import Instructions</CardTitle>
            <CardDescription>
              Follow these instructions to properly import your proforma slip data.
            </CardDescription>
          </CardHeader>
          <CardContent>
            <div className="space-y-4">
              <div>
                <h3 className="text-lg font-semibold">CSV Format</h3>
                <p className="text-sm text-muted-foreground">
                  The CSV file should have the following format:
                </p>
                <ul className="list-disc pl-5 mt-2 text-sm">
                  <li>Each row should represent a proforma slip with its items</li>
                  <li>The file must include headers for all required fields</li>
                  <li>Multiple items for the same slip should be listed on separate rows with the same order number</li>
                </ul>
              </div>
              
              <div>
                <h3 className="text-lg font-semibold">Required Fields</h3>
                <ul className="list-disc pl-5 mt-2 text-sm">
                  <li><span className="font-medium">orderNumber</span>: The unique order number for the slip</li>
                  <li><span className="font-medium">orderDate</span>: The date in format DD-MM-YY (e.g., 30-03-25)</li>
                  <li><span className="font-medium">partyName</span>: The customer name</li>
                  <li><span className="font-medium">plant</span>: The plant location (e.g., valsad)</li>
                  <li><span className="font-medium">vehicleNumber</span>: The vehicle number with format (e.g., "162 GJ-15-AX-3425")</li>
                  <li><span className="font-medium">productId</span>: The product ID number</li>
                  <li><span className="font-medium">productSrNo</span>: The product serial number (e.g., C001)</li>
                  <li><span className="font-medium">productBarcode</span>: The product barcode</li>
                  <li><span className="font-medium">productName</span>: The name of the product</li>
                  <li><span className="font-medium">quantity</span>: The quantity of the item</li>
                </ul>
              </div>
              
              <div className="bg-muted p-3 rounded-md">
                <h3 className="text-sm font-semibold">Example Row:</h3>
                <p className="text-xs font-mono bg-black/5 p-2 mt-1 overflow-x-auto whitespace-nowrap">
                  orderNumber,orderDate,partyName,plant,totalQuantity,totalVolume,vehicleNumber,driverName,notes,productId,productSrNo,productBarcode,productName,quantity<br/>
                  64205,30-03-25,JAIN DISTRIBUTORS,valsad,,,"162 GJ-15-AX-3425",,,100215,C001,8906010500023,15GM*192 CRUNCHEM SIMPLY SALTED WAFERS,30
                </p>
                <h3 className="text-sm font-semibold mt-3">Note:</h3>
                <p className="text-xs text-muted-foreground mt-1">
                  If you're importing data from a previously exported CSV, the import should work seamlessly. 
                  For custom CSV files, ensure all required fields are present and correctly formatted.
                </p>
              </div>
            </div>
          </CardContent>
        </Card>
      </div>
    </SidebarWrapper>
  );
}