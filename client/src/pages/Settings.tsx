import { useLocation } from 'wouter';
import MobileMenu from '@/components/ui/mobile-menu';
import { 
  Card, 
  CardContent, 
  CardDescription, 
  CardHeader, 
  CardTitle 
} from '@/components/ui/card';
import { 
  Tabs, 
  TabsContent, 
  TabsList, 
  TabsTrigger 
} from '@/components/ui/tabs';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { 
  Form, 
  FormControl, 
  FormDescription, 
  FormField, 
  FormItem, 
  FormLabel, 
  FormMessage 
} from '@/components/ui/form';
import { Switch } from '@/components/ui/switch';
import { Label } from '@/components/ui/label';
import { useToast } from '@/hooks/use-toast';
import { useForm } from 'react-hook-form';
import { useEffect, useState } from 'react';
import { Smartphone, Radio, QrCode, Zap, Shield, Database } from 'lucide-react';
import { apiRequest } from '@/lib/queryClient';
import { useQueryClient } from '@tanstack/react-query';
import { hasPageWriteAccess } from '@/lib/permissions';
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

const Settings = () => {
  const [location] = useLocation();
  const form = useForm();
  const { toast } = useToast();
  const queryClient = useQueryClient();
  const [isClearing, setIsClearing] = useState(false);
  const [isResetting, setIsResetting] = useState(false);
  const [showClearDialog, setShowClearDialog] = useState(false);
  const canWrite = hasPageWriteAccess('settings');

  // Voucher prefixes state
  const [prefixes, setPrefixes] = useState<{ expense?: string; toll?: string } | null>(null);
  const [saving, setSaving] = useState(false);
  const [isAdminUser, setIsAdminUser] = useState(false);
  const [originalPrefixes, setOriginalPrefixes] = useState<{ expense?: string; toll?: string } | null>(null);

  useEffect(() => {
    (async () => {
      try {
        const res = await apiRequest('GET', '/api/voucher-prefixes', undefined, false, true);
        if (res && res.data) {
          setPrefixes(res.data as any);
          setOriginalPrefixes(res.data as any);
        }
      } catch (e) {
        // ignore
      }
    })();

    try {
      const userString = localStorage.getItem('currentUser');
      if (userString) {
        const user = JSON.parse(userString);
        const role = (user?.role || '').toString().toLowerCase();
        setIsAdminUser(['admin', 'super-admin', 'superadmin', 'super_admin'].includes(role));
      }
    } catch (e) {
      // ignore
    }
  }, []);

  // NEW: dialog UI state
  const [confirmText, setConfirmText] = useState('');
  const [acknowledge, setAcknowledge] = useState(false);

  // NEW: counts (read from cache)
  const productCount = (() => {
    const d = queryClient.getQueryData(['/api/products']) as any;
    return Array.isArray(d) ? d.length : 0;
  })();
  const salesCount = (() => {
    const d = queryClient.getQueryData(['/api/sales']) as any;
    return Array.isArray(d) ? d.length : 0;
  })();
  const scanCount = (() => {
    const d = queryClient.getQueryData(['/api/scans']) as any;
    return Array.isArray(d) ? d.length : 0;
  })();

  // NEW: reset dialog when closed
  const handleClearDialogOpenChange = (open: boolean) => {
    setShowClearDialog(open);
    if (!open) {
      setConfirmText('');
      setAcknowledge(false);
    }
  };

  const clearInventory = async () => {
    // Native confirm removed
    setIsClearing(true);
    try {
      const response = await fetch('/api/products/clear', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' }
      });
      if (response.ok) {
        const data = await response.json();
        toast({ title: "Success", description: "Inventory data cleared successfully", variant: "default" });
        // OPTIMIZATION: Update cache directly to empty list instead of refetching
        // This solves the rendering issue by immediately clearing the UI without needing a refresh
        queryClient.setQueriesData({ queryKey: ['/api/products'] }, (oldData: any) => []);
        queryClient.setQueriesData({ queryKey: ['/api/sales'] }, []);
        queryClient.setQueriesData({ queryKey: ['/api/scans'] }, []);
        queryClient.invalidateQueries({ queryKey: ['/api/products'] });
        queryClient.invalidateQueries({ queryKey: ['/api/sales'] });
        queryClient.invalidateQueries({ queryKey: ['/api/scans'] });
      } else {
        const errorData = await response.text();
        toast({ title: "Error", description: "Failed to clear inventory data", variant: "destructive" });
        console.error("Error clearing inventory:", errorData);
      }
    } catch (error) {
      console.error("Error clearing inventory:", error);
      toast({ title: "Error", description: "An unexpected error occurred", variant: "destructive" });
    } finally {
      setIsClearing(false);
      setShowClearDialog(false);
      setConfirmText('');
      setAcknowledge(false);
    }
  };
  
  const resetStock = async () => {
    if (!confirm("Are you sure you want to reset all stock values to zero? This action cannot be undone.")) {
      return;
    }
    
    setIsResetting(true);
    try {
      const response = await fetch('/api/products/reset-stock', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' }
      });
      
      if (response.ok) {
        const data = await response.json();
        toast({
          title: "Success",
          description: `Stock values reset successfully. ${data.updatedCount} products updated.`,
          variant: "default"
        });
        console.log("Stock reset:", data);

        // OPTIMIZATION: Update cache directly to reset values locally
        // This makes the UI update instantly without waiting for a refetch
        queryClient.setQueriesData({ queryKey: ['/api/products'] }, (oldData: any) => {
          if (Array.isArray(oldData)) {
            return oldData.map((product: any) => ({
              ...product,
              inStock: 0,
              purchased: 0,
              sold: 0,
              pallets: 0,
              // Update timestamp to now
              lastUpdated: new Date().toISOString()
            }));
          }
          return oldData;
        });
      } else {
        const errorData = await response.text();
        toast({
          title: "Error",
          description: "Failed to reset stock values",
          variant: "destructive"
        });
        console.error("Error resetting stock:", errorData);
      }
    } catch (error) {
      console.error("Error resetting stock:", error);
      toast({
        title: "Error",
        description: "An unexpected error occurred",
        variant: "destructive"
      });
    } finally {
      setIsResetting(false);
    }
  };
  
  return (
    <>
      {/* Mobile Header */}
      <header className="lg:hidden bg-white border-b border-gray-200 p-4">
        <div className="flex items-center justify-between">
          <div className="flex items-center space-x-3">
            <div className="w-10 h-10 rounded-lg bg-primary flex items-center justify-center text-white font-bold">
              KM
            </div>
            <h1 className="text-xl font-bold">KM-Tribe</h1>
          </div>
          <MobileMenu currentPath={location} />
        </div>
      </header>
      
      <div className="flex-1 overflow-y-auto p-4 lg:p-6">
        <div className="max-w-4xl mx-auto">
          <div className="mb-6">
            <h2 className="text-2xl font-bold">Settings</h2>
            <p className="text-gray-600">Configure application preferences</p>
          </div>
          
          <Tabs defaultValue="scanner">
            <TabsList className="mb-6">
              <TabsTrigger value="scanner">Scanner</TabsTrigger>
              <TabsTrigger value="app">Application</TabsTrigger>
              <TabsTrigger value="data">Data Management</TabsTrigger>
            </TabsList>
            
            <TabsContent value="scanner">
              <Card>
                <CardHeader>
                  <CardTitle>Scanner Settings</CardTitle>
                  <CardDescription>Configure how the barcode scanner functions</CardDescription>
                </CardHeader>
                <CardContent className="space-y-6">
                  <div className="space-y-4">
                    <div className="flex items-center justify-between">
                      <div className="space-y-0.5">
                        <Label htmlFor="camera-flash">Camera Flash</Label>
                        <p className="text-sm text-muted-foreground">
                          Enable camera flash by default when scanning
                        </p>
                      </div>
                      <Switch id="camera-flash" />
                    </div>
                    
                    <div className="flex items-center justify-between">
                      <div className="space-y-0.5">
                        <Label htmlFor="continuous-scan">Continuous Scanning</Label>
                        <p className="text-sm text-muted-foreground">
                          Allow scanning multiple barcodes without closing dialog
                        </p>
                      </div>
                      <Switch id="continuous-scan" />
                    </div>
                    
                    <div className="flex items-center justify-between">
                      <div className="space-y-0.5">
                        <Label htmlFor="auto-detect">Auto Detection</Label>
                        <p className="text-sm text-muted-foreground">
                          Automatically detect and scan barcodes without pressing button
                        </p>
                      </div>
                      <Switch id="auto-detect" defaultChecked />
                    </div>
                    
                    <div className="border-t pt-4">
                      <h4 className="text-sm font-medium mb-2">Supported Barcode Types</h4>
                      <div className="grid grid-cols-1 md:grid-cols-2 gap-y-2">
                        <div className="flex items-center space-x-2">
                          <input type="checkbox" id="ean13" defaultChecked />
                          <label htmlFor="ean13" className="text-sm">EAN-13</label>
                        </div>
                        <div className="flex items-center space-x-2">
                          <input type="checkbox" id="ean8" defaultChecked />
                          <label htmlFor="ean8" className="text-sm">EAN-8</label>
                        </div>
                        <div className="flex items-center space-x-2">
                          <input type="checkbox" id="upc" defaultChecked />
                          <label htmlFor="upc" className="text-sm">UPC-A/UPC-E</label>
                        </div>
                        <div className="flex items-center space-x-2">
                          <input type="checkbox" id="code128" defaultChecked />
                          <label htmlFor="code128" className="text-sm">Code 128</label>
                        </div>
                        <div className="flex items-center space-x-2">
                          <input type="checkbox" id="code39" defaultChecked />
                          <label htmlFor="code39" className="text-sm">Code 39</label>
                        </div>
                        <div className="flex items-center space-x-2">
                          <input type="checkbox" id="qr" defaultChecked />
                          <label htmlFor="qr" className="text-sm">QR Code</label>
                        </div>
                      </div>
                    </div>
                  </div>
                  
                  <div className="flex justify-end">
                    <Button>Save Settings</Button>
                  </div>
                </CardContent>
              </Card>
            </TabsContent>
            
            <TabsContent value="app">
              <Card>
                <CardHeader>
                  <CardTitle>Application Settings</CardTitle>
                  <CardDescription>Configure general application preferences</CardDescription>
                </CardHeader>
                <CardContent className="space-y-6">
                  <div className="space-y-4">
                    <div className="flex items-center justify-between">
                      <div className="space-y-0.5">
                        <Label htmlFor="dark-mode">Dark Mode</Label>
                        <p className="text-sm text-muted-foreground">
                          Switch between light and dark theme
                        </p>
                      </div>
                      <Switch id="dark-mode" />
                    </div>
                    
                    <div className="flex items-center justify-between">
                      <div className="space-y-0.5">
                        <Label htmlFor="notifications">Notifications</Label>
                        <p className="text-sm text-muted-foreground">
                          Enable notifications for important events
                        </p>
                      </div>
                      <Switch id="notifications" defaultChecked />
                    </div>
                    
                    <div className="space-y-2">
                      <Label htmlFor="language">Language</Label>
                      <select 
                        id="language" 
                        className="w-full flex h-10 rounded-md border border-input bg-background px-3 py-2 text-sm ring-offset-background focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2"
                      >
                        <option value="en">English</option>
                        <option value="es">Español</option>
                        <option value="fr">Français</option>
                      </select>
                    </div>
                  </div>
                  
                  <div className="flex justify-end">
                    <Button>Save Settings</Button>
                  </div>
                </CardContent>
              </Card>

              {/* Voucher Prefixes - centrally managed by admin */}
              <Card className="mt-6">
                <CardHeader>
                  <CardTitle>Voucher Prefixes</CardTitle>
                  <CardDescription>Set canonical prefixes for Expense and Toll vouchers (admin only)</CardDescription>
                </CardHeader>
                <CardContent>
                  <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                    <div>
                      <Label>Expense Prefix</Label>
                      <Input
                        value={prefixes?.expense || ''}
                        onChange={(e) => setPrefixes((p: any) => ({ ...(p||{}), expense: e.target.value }))}
                        disabled={!isAdminUser && !canWrite}
                        placeholder="e.g. KM2526-EV-"
                      />
                    </div>
                    <div>
                      <Label>Toll Prefix</Label>
                      <Input
                        value={prefixes?.toll || ''}
                        onChange={(e) => setPrefixes((p: any) => ({ ...(p||{}), toll: e.target.value }))}
                        disabled={!isAdminUser && !canWrite}
                        placeholder="e.g. KM2526-TV-"
                      />
                    </div>
                  </div>

                  <div className="mt-4 flex gap-2 justify-end">
                    <Button
                      type="button"
                      onClick={async (e) => {
                        e.preventDefault();
                        setSaving(true);
                        try {
                          const toSave: string[] = [];
                          const types: Array<'expense' | 'toll'> = ['expense', 'toll'];
                          for (const t of types) {
                            const current = (prefixes as any)?.[t];
                            const original = (originalPrefixes as any)?.[t];
                            // If original is null (never loaded), treat non-empty as changed
                            if (original === undefined || original === null) {
                              if (current) toSave.push(t);
                            } else if (String(current || '') !== String(original || '')) {
                              toSave.push(t);
                            }
                          }

                          if (toSave.length === 0) {
                            toast({ title: 'No changes', description: 'Nothing to save' });
                            setSaving(false);
                            return;
                          }

                          let finalData: any = originalPrefixes ? { ...(originalPrefixes as any) } : {};
                          for (const t of toSave) {
                            try {
                              const res = await apiRequest('PUT', `/api/voucher-prefixes/${t}`, { prefix: (prefixes as any)?.[t] || '' }, false, true);
                              if (res && res.data) {
                                // server returns full set; merge
                                finalData = { ...(finalData || {}), ...(res.data || {}) };
                              }
                            } catch (err) {
                              console.error(`Failed to save prefix ${t}:`, err);
                              // continue with others
                            }
                          }

                          if (finalData) {
                            setPrefixes(finalData);
                            setOriginalPrefixes(finalData);
                          }

                          try { localStorage.setItem('voucher_prefixes_updated', String(Date.now())); } catch (e) {}
                          toast({ title: 'Saved', description: 'Voucher prefixes updated' });
                        } catch (e: any) {
                          console.error('Failed to save voucher prefixes', e);
                          toast({ title: 'Error', description: 'Failed to save prefixes', variant: 'destructive' });
                        } finally {
                          setSaving(false);
                        }
                      }}
                      disabled={(!isAdminUser && !canWrite) || saving}
                    >
                      {saving ? 'Saving...' : 'Save Prefixes'}
                    </Button>
                  </div>
                </CardContent>
              </Card>
            </TabsContent>
            
            <TabsContent value="data">
              <Card>
                <CardHeader>
                  <CardTitle>Data Management</CardTitle>
                  <CardDescription>Manage your application data</CardDescription>
                </CardHeader>
                <CardContent className="space-y-6">
                  <div className="space-y-4">
                    <div className="p-4 border rounded-lg bg-gray-50">
                      <h4 className="font-medium flex items-center"><Database className="h-4 w-4 mr-2" /> Data Export</h4>
                      <p className="text-sm text-gray-600 mt-1 mb-3">Export your scan history and inventory data</p>
                      <div className="flex space-x-2">
                        <Button variant="outline" size="sm">Export Inventory</Button>
                        <Button variant="outline" size="sm">Export Scan History</Button>
                      </div>
                    </div>
                    
                    <div className="p-4 border rounded-lg bg-gray-50">
                      <h4 className="font-medium flex items-center"><Database className="h-4 w-4 mr-2" /> Data Import</h4>
                      <p className="text-sm text-gray-600 mt-1 mb-3">Import inventory data from CSV</p>
                      <Button variant="outline" size="sm">Import Data</Button>
                    </div>
                    
                    <div className="p-4 border border-red-200 rounded-lg bg-red-50">
                      <h4 className="font-medium text-[#001d6e] flex items-center"><Shield className="h-4 w-4 mr-2" /> Danger Zone</h4>
                      <p className="text-sm text-[#001d6e] mt-1 mb-3">These actions are irreversible</p>
                      <div className="flex flex-wrap gap-2">
                        <Button 
                          variant="destructive" 
                          size="sm"
                        >
                          Clear Scan History
                        </Button>
                        <Button
                          variant="destructive"
                          size="sm"
                          onClick={() => setShowClearDialog(true)}
                          disabled={isClearing || !canWrite}
                          title={!canWrite ? "You have read-only access to Settings" : undefined}
                        >
                          {isClearing ? "Clearing..." : "Clear Inventory"}
                        </Button>
                        <Button
                          variant="destructive"
                          size="sm"
                          onClick={resetStock}
                          disabled={isResetting || !canWrite}
                          title={!canWrite ? "You have read-only access to Settings" : undefined}
                        >
                          {isResetting ? "Resetting..." : "Reset Stock Values"}
                        </Button>
                        <Button 
                          variant="destructive" 
                          size="sm"
                        >
                          Reset Application
                        </Button>
                      </div>
                    </div>
                  </div>
                </CardContent>
              </Card>
            </TabsContent>
          </Tabs>
        </div>
      </div>

      <AlertDialog open={showClearDialog} onOpenChange={handleClearDialogOpenChange}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Clear Inventory?</AlertDialogTitle>
            <AlertDialogDescription>
              This will permanently delete all products and related data. This action cannot be undone.
            </AlertDialogDescription>
          </AlertDialogHeader>

          {/* NEW: details and guards */}
          <div className="space-y-4 mt-2">
            <div className="grid grid-cols-1 sm:grid-cols-3 gap-2 text-sm">
              <div className="p-2 rounded border bg-white">
                <div className="font-medium">Products</div>
                <div className="text-muted-foreground">{productCount}</div>
              </div>
              <div className="p-2 rounded border bg-white">
                <div className="font-medium">Sales</div>
                <div className="text-muted-foreground">{salesCount}</div>
              </div>
              <div className="p-2 rounded border bg-white">
                <div className="font-medium">Scans</div>
                <div className="text-muted-foreground">{scanCount}</div>
              </div>
            </div>

            <div className="p-3 rounded border border-yellow-200 bg-yellow-50 text-sm">
              Deleting inventory is permanent. Export your data first if needed.
            </div>

            <div className="space-y-2">
              <Label htmlFor="confirmText">Type CLEAR to confirm</Label>
              <Input
                id="confirmText"
                value={confirmText}
                onChange={(e) => setConfirmText(e.target.value)}
                placeholder="CLEAR"
              />
              <label className="flex items-center gap-2 text-sm">
                <input
                  type="checkbox"
                  checked={acknowledge}
                  onChange={(e) => setAcknowledge(e.target.checked)}
                />
                I understand this action cannot be undone.
              </label>
            </div>
          </div>

          <AlertDialogFooter>
            <AlertDialogCancel disabled={isClearing}>Cancel</AlertDialogCancel>
            <AlertDialogAction
              onClick={clearInventory}
              className="bg-red-600 hover:bg-red-700"
              disabled={isClearing || confirmText !== 'CLEAR' || !acknowledge}
            >
              {isClearing ? "Clearing..." : "Clear Inventory"}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </>
  );
};

export default Settings;
