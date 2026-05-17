import { useState, useEffect } from 'react';
import { useQuery } from '@tanstack/react-query';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Separator } from '@/components/ui/separator';
import { Printer, Search, Truck, User, Receipt, Lock, RefreshCw } from 'lucide-react';
import { Progress } from '@/components/ui/progress';
import { apiRequest } from '@/lib/queryClient';
import { useToast } from '@/hooks/use-toast';
import logoPath from '@assets/logo_wo_bg_1757152661130.png';
import { borderBottomLeftRadius } from 'html2canvas/dist/types/css/property-descriptors/border-radius';
import { text } from 'stream/consumers';
import { TruckLoadingAnimation } from '@/components/TruckLoadingAnimation';

interface TollVoucherData {
  orderNumber: string;
  driver: string;
  vehicle: string;
  tollTax: number;
  party: string;
  order: string;
  plant: string;
  tollTaxInWords: string;
  orderDate: string;
}

interface TollVoucherResponse {
  success: boolean;
  message: string;
  data: TollVoucherData | null;
}

// Access control hook
function useAccessControl() {
  const [hasAccess, setHasAccess] = useState(false);
  const [isLoading, setIsLoading] = useState(true);

  useEffect(() => {
    const checkAccess = () => {
      try {
        const userString = localStorage.getItem('currentUser');
        if (!userString) {
          setHasAccess(false);
          setIsLoading(false);
          return;
        }

        const user = JSON.parse(userString);
        const userRole = user.role?.toLowerCase();
        const userDepartment = user.department?.toLowerCase();

        const allowedRoles = ['admin', 'super-admin', 'superadmin', 'super_admin'];
        const allowedDepartments = ['steer', 'management', 'it'];

        const isAdmin = allowedRoles.includes(userRole);
        const hasAllowedDepartment = allowedDepartments.includes(userDepartment);

        setHasAccess(isAdmin || hasAllowedDepartment);
        setIsLoading(false);
      } catch (error) {
        console.error('Error checking access:', error);
        setHasAccess(false);
        setIsLoading(false);
      }
    };

    checkAccess();
  }, []);

  return { hasAccess, isLoading };
}


const getFontSize = (text: string) => {
  if (!text) return 12;
  const length = text.length;
  
  if (length < 100) return 18;
  if (length < 200) return 16;
  if (length < 300) return 12;
  if (length < 400) return 10;
  return 6;
};

export default function TollVoucher() {
  const [selectedPlant, setSelectedPlant] = useState('valsad');
  //const [voucherPrefix, setVoucherPrefix] = useState('KM2526-EV-');
  const [voucherNumber, setVoucherNumber] = useState('');
  const [selectedOrder, setSelectedOrder] = useState('');
  const [searchProgress, setSearchProgress] = useState(0);
  const [searchStage, setSearchStage] = useState('');
  const { toast } = useToast();
  const { hasAccess, isLoading: accessLoading } = useAccessControl();
  const [voucherPrefix, setVoucherPrefix] = useState<string>('KM2526-EV-');
  const [isAdminUser, setIsAdminUser] = useState(false);

  useEffect(() => {
    (async () => {
      try {
        const res = await apiRequest('GET', '/api/voucher-prefixes', undefined, false, true);
        if (res && res.data && res.data.toll) {
          setVoucherPrefix(res.data.toll);
        }
      } catch (e) {
        console.error('Failed to fetch voucher prefixes:', e);
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

    // Listen for updates from other tabs in the same browser
    const storageHandler = (e: StorageEvent) => {
      if (e.key === 'voucher_prefixes_updated') {
        (async () => {
          try {
            const res = await apiRequest('GET', '/api/voucher-prefixes', undefined, false, true);
            if (res && res.data && res.data.toll) {
              setVoucherPrefix(res.data.toll);
            }
          } catch (err) {
            // ignore
          }
        })();
      }
    };

    window.addEventListener('storage', storageHandler);

    // Poll every 30 seconds for changes from other devices/browsers
    const pollInterval = setInterval(async () => {
      try {
        const res = await apiRequest('GET', '/api/voucher-prefixes', undefined, false, true);
        if (res && res.data && res.data.toll) {
          setVoucherPrefix(res.data.toll);
        }
      } catch (e) {
        // ignore
      }
    }, 30000);

    return () => {
      window.removeEventListener('storage', storageHandler);
      clearInterval(pollInterval);
    };
  }, []);

  // Fetch toll voucher data
  const { 
    data: tollVoucherData, 
    isLoading: tollVoucherLoading, 
    isFetching,
    refetch,
    isError,
    error 
  } = useQuery<TollVoucherResponse>({
    queryKey: ['/api/toll-voucher', selectedOrder],
    enabled: !!selectedOrder && hasAccess,
    queryFn: async () => {
      if (!selectedOrder) throw new Error('No order selected');
      try {
        const response = await apiRequest('POST', '/api/toll-voucher', { orderNumber: selectedOrder }, false, true);
        return response as TollVoucherResponse;
      } catch (error: any) {
        setSearchProgress(0);
        setSearchStage('');
        console.error('❌ Frontend: API error:', error);
        throw new Error(error?.message || 'Failed to fetch toll voucher data');
      }
    },
    retry: false,
  });

  // ✅ Moved AFTER useQuery so tollVoucherLoading & isFetching are defined
  useEffect(() => {
    if (tollVoucherLoading || isFetching) {
      setSearchProgress(0);
      const interval = setInterval(() => {
        setSearchProgress((prev) => {
          if (prev >= 75) {
            clearInterval(interval);
            return 75;
          }
          return prev + 1;
        });
      }, 80);
      return () => clearInterval(interval);
    } else if (searchProgress > 0) {
      setSearchProgress(100);
      const timer = setTimeout(() => setSearchProgress(0), 800);
      return () => clearTimeout(timer);
    }
  }, [tollVoucherLoading, isFetching]);

  const handleSearch = () => {
    if (!voucherNumber.trim()) {
      toast({
        title: "Voucher Number Required",
        description: "Please enter a voucher number to search",
        variant: "destructive",
      });
      return;
    }

    // Combine prefix with voucher number
    const fullVoucherNumber = `${voucherPrefix}${voucherNumber.trim()}`;

    if (fullVoucherNumber === selectedOrder) {
      setSearchProgress(0);
      setSearchStage('Refreshing...');
      refetch();
    } else {
      setSearchProgress(0);
      setSelectedOrder(fullVoucherNumber);
    }
  };

  const handleRefresh = () => {
    if (voucherNumber.trim()) {
      handleSearch();
    } else {
       toast({
        title: "Voucher Number Required",
        description: "Please enter a voucher number to refresh",
        variant: "destructive"
      });
    }
  };

  const handlePrint = async () => {
    if (!tollVoucherData?.data) return;

    const partyText = tollVoucherData.data.party || "";
    const length = partyText.length;
    
    // Better calculation based on actual character length
    let partyFontPt = 16; // default large size
    if (length > 800) partyFontPt = 7;
    else if (length > 600) partyFontPt = 9;
    else if (length > 400) partyFontPt = 10;
    else if (length > 300) partyFontPt = 11;
    else if (length > 200)   partyFontPt = 12;
console.log(length, partyFontPt);
    let logoDataUrl = "";
    try {
      const response = await fetch(logoPath);
      const blob = await response.blob();
      logoDataUrl = await new Promise((resolve) => {
        const reader = new FileReader();
        reader.onload = () => resolve(reader.result as string);
        reader.readAsDataURL(blob);
      }) as string;
    } catch {
      logoDataUrl = logoPath;
    }

    const printOrderNumber = tollVoucherData.data.orderNumber
      ? tollVoucherData.data.orderNumber.replace('EV', 'TV')
      : '';

    const printContent = `
      <!DOCTYPE html>
      <html>
        <head>
          <title>Toll Voucher - ${printOrderNumber}</title>
          <style>
            @page { size: 220mm 110mm; margin: 2mm; }
            body { margin: 0; padding: 2mm; font-family: "Times New Roman", Times, serif; }
            * { box-sizing: border-box; }
            
            .voucher-container {
              width: 210mm;
              height: 100mm;
              border: 2px solid #000;
              display: flex;
              flex-direction: column;
              overflow: hidden;
              margin-top: 1.5mm;
            }

            .grid-row { display: flex; width: 100%; border-bottom: 1px solid #000; }
            .col { padding: 4px; display: flex; align-items: center; justify-content: center; border-right: 1px solid #000; }
            .col:last-child { border-right: none; }
            
            .bg-brown { background-color: #8b4513; color: white; }
            .bg-indigo { background-color: #6366f1; color: white; }
            .bg-orange { background-color: #ea580c; color: white; }
            .bg-yellow { background-color: #eab309; color: white; }
            
            .title-text { font-size: 24pt; font-weight: bold; letter-spacing: 2px;color: white; justify-content: center; padding: 8px; text-align: center;padding-top: 12px; padding-bottom: 12px; }
            .label-text { font-size: 14pt; font-weight: 600; }
            .value-text { font-size: 16pt; font-weight: bold; }
            
            .company-section { display: flex; align-items: center; gap: 10px; padding: 8px; }
            .company-info h2 { font-size: 22pt; font-weight: bold; margin: 0 0 5px 0; }
            .company-info p { font-size: 10pt; margin: 0; line-height: 1.2; }
            
            .flex-col { display: flex; flex-direction: column; }
            .flex-grow { flex-grow: 1; }
            
            .order-details-content { font-size: ${partyFontPt}pt; font-weight: bold; text-align: center; width: 100%; margin: 0; line-height: 1.1; white-space: pre-line; }
            
            .w-2-1-a { width: 66.66%; }
            .w-2-1-b { width: 33.33%; }
            .w-2-1-c { width: 66.66%; background: ${selectedPlant === "indore"
                ? "linear-gradient(135deg, #693c11ff 0%, #c58e61ff 100%)"
                : "linear-gradient(135deg, #e76e2eff 0%, #d26b42ff 100%)"
              } !important;}
            
            .w-1-2-a { width: 31%; }
            .w-1-2-b { width: 80%; }
            
            .w-tax-a { width: 15%; }
            .w-tax-b { width: 13%; }
            .w-tax-c { width: 72%; }

            img { max-height: 80px; width: auto; }
          </style>
        </head>
        <body>
          <div class="voucher-container">
            <div class="grid-row" style="height: auto;">
              <div class="w-2-1-c">
                <div class="title-text">TOLL TAX VOUCHER</div>
              </div>
              <div class="col w-2-1-b" style="padding: 0; display: block;">
                <div style="background-color: #6366f1; color: white; padding: 4px; text-align: center; border-bottom: 1px solid #000;">
                  <span class="label-text">${tollVoucherData.data.orderDate || new Date().toLocaleDateString('en-GB')}</span>
                </div>
                <div style="padding: 4px; text-align: center;">
                  <span class="value-text">${printOrderNumber}</span>
                </div>
              </div>
            </div>

            <div class="grid-row">
              <div class="col w-2-1-a company-section">
                <img src="${logoDataUrl}" alt="Logo" />
                <div class="company-info">
                  <h2>KRUPA MARKETING</h2>
                  <p>OPP. SUGAR & SPICE, 286,287, NEAR BALAJI WAFERS PVT LTD, N.H. NO 48,</p>
                  <p>SHANKAR TALAV, VALSAD, GUJARAT, 396375</p>
                  <p style="font-size: 12pt; font-weight: 600; margin-top: 4px;">Email : steer@krupamarketing.com</p>
                </div>
              </div>
              <div class="col w-2-1-b" style="padding: 0; display: block;">
                <div style="display: flex; flex-direction: column; height: 100%;">
                  <div style="flex: 1; display: flex; flex-direction: column; border-bottom: 1px solid #000;">
                    <div class="bg-orange" style="text-align: center; padding: 2px; font-weight: 600;">Vehicle:</div>
                    <div style="text-align: center; padding: 2px; font-weight: bold; font-size: 14pt; flex-grow: 1; display: flex; align-items: center; justify-content: center;">${tollVoucherData.data.vehicle || "N/A"}</div>
                  </div>
                  <div style="flex: 1; display: flex; flex-direction: column;">
                    <div class="bg-yellow" style="text-align: center; padding: 2px; font-weight: 600;">Driver:</div>
                    <div style="text-align: center; padding: 2px; font-weight: bold; font-size: 14pt; flex-grow: 1; display: flex; align-items: center; justify-content: center;">${tollVoucherData.data.driver || "N/A"}</div>
                  </div>
                </div>
              </div>
            </div>

            <div class="grid-row flex-grow" style="min-height: 40mm;">
              <div class="col w-1-2-a">
                <span class="label-text" style="font-size: 18pt;">Order Details:</span>
              </div>
              <div class="col w-1-2-b" style="overflow: hidden; position: relative;">
                <p id="order-details-content" class="order-details-content">${partyText || 'N/A'}</p>
              </div>
            </div>

            <div class="grid-row" style="height: 15mm; border-bottom: none;">
              <div class="col w-tax-a">
                <span class="label-text">Toll Tax:</span>
              </div>
              <div class="col w-tax-b">
                <span class="value-text" style="color: #dc2626;">₹${tollVoucherData.data.tollTax.toFixed(2)}</span>
              </div>
              <div class="col w-tax-c">
                <span class="label-text" style="font-weight: 600;">${tollVoucherData.data.tollTaxInWords}</span>
              </div>
            </div>
          </div>

          <script>
            (function adjustFontSize() {
              const element = document.getElementById('order-details-content');
              if (!element || !element.parentElement) return;
              
              const parent = element.parentElement;
              let size = ${partyFontPt}; // Start with the calculated size
              
              // Ensure we start applying from this size
              element.style.fontSize = size + 'pt';
              
              // Allow shrinking further if it still overflows, down to 5pt
              while (element.scrollHeight > parent.clientHeight && size > 4) {
                size -= 0.5;
                element.style.fontSize = size + 'pt';
              }
            })();
          </script>
        </body>
      </html>
    `;

    try {
      const iframe = document.createElement("iframe");
      iframe.style.display = "none";
      document.body.appendChild(iframe);

      const iframeDoc = iframe.contentDocument || iframe.contentWindow?.document;
      if (!iframeDoc) throw new Error("Could not access iframe document");

      iframeDoc.open();
      iframeDoc.write(printContent);
      iframeDoc.close();

      iframe.onload = () => {
        setTimeout(() => {
          try {
            iframe.contentWindow?.focus();
            iframe.contentWindow?.print();
            setTimeout(() => {
              if (document.body.contains(iframe)) document.body.removeChild(iframe);
            }, 3000);
          } catch (e) {
            console.error("Print error:", e);
          }
        }, 500);
      };
    } catch (error) {
      console.error("Failed to create print iframe:", error);
      toast({
        title: "Print Error",
        description: "Failed to open print dialog.",
        variant: "destructive",
      });
    }
  };

  // Access control
  if (accessLoading) {
    return (
      <div className="min-h-screen bg-gradient-to-br from-blue-50 to-indigo-100 flex items-center justify-center">
        <div className="text-center">
          <div className="animate-spin rounded-full h-12 w-12 border-b-2 border-blue-600 mx-auto"></div>
          <p className="mt-4 text-gray-600">Loading...</p>
        </div>
      </div>
    );
  }

  if (!hasAccess) {
    return (
      <div className="min-h-screen bg-gradient-to-br from-red-50 to-orange-100 flex items-center justify-center p-4">
        <Card className="max-w-md w-full">
          <CardHeader>
            <div className="flex items-center justify-center mb-4">
              <div className="w-16 h-16 bg-red-100 rounded-full flex items-center justify-center">
                <Lock className="w-8 h-8 text-red-600" />
              </div>
            </div>
            <CardTitle className="text-red-600 text-center">Access Denied</CardTitle>
          </CardHeader>
          <CardContent>
            <p className="text-center text-gray-600 mb-2">
              You don't have permission to access this page.
            </p>
            <p className="text-center text-sm text-gray-500">
              This page is restricted to Management, IT, and Steer departments only.
            </p>
          </CardContent>
        </Card>
      </div>
    );
  }

  return (
    <div className="min-h-screen bg-white p-4 md:p-8">
      {/* Header Section */}
      <div className="max-w-7xl mx-auto mb-6">
        <div className="flex items-center justify-between mb-4">
          <div className="flex items-center gap-3">
            <Receipt className="h-8 w-8 text-[#001d6e]" style={{fill: "#16a34a"}} />
            <h1 className="text-3xl font-bold text-[#001d6e]">Toll Voucher</h1>
          </div>
          <div className="flex gap-3">
            <Button
              onClick={() => setSelectedPlant('valsad')}
              variant={selectedPlant === 'valsad' ? 'default' : 'outline'}
              className={`flex items-center gap-2 ${selectedPlant === 'valsad' ? 'bg-orange-500 hover:bg-orange-600' : 'border-orange-500 text-orange-600 hover:bg-orange-50'}`}
              data-testid="button-plant-valsad"
            >
              <div className="w-3 h-3 rounded-full bg-orange-500"></div>
              Valsad
            </Button>
            <Button
              onClick={() => setSelectedPlant('indore')}
              variant={selectedPlant === 'indore' ? 'default' : 'outline'}
              className={`flex items-center gap-2 ${selectedPlant === 'indore' ? 'bg-amber-700 hover:bg-amber-800' : 'border-amber-700 text-amber-700 hover:bg-amber-50'}`}
              data-testid="button-plant-indore"
            >
              <div className="w-3 h-3 rounded-full bg-amber-700"></div>
              Indore
            </Button>
          </div>
        </div>
      </div>

      {/* Search Section */}
      <div className="max-w-7xl mx-auto mb-6">
        <Card className="shadow-lg">
          <CardContent className="pt-6">
            <div className="space-y-4">
              <div className="flex gap-4 items-end">
                <div className="flex-1">
                  <div className="flex items-center">
                    <Input
                      type="text"
                      value={voucherPrefix}
                      onChange={(e) => setVoucherPrefix(e.target.value)}
                      onKeyDown={(e) => e.key === 'Enter' && handleSearch()}
                      className="rounded-r-none text-sm font-mono bg-gray-50 w-32 border-r-0 focus-visible:ring-2 focus-visible:ring-green-500"
                      placeholder="Prefix"
                      data-testid="input-voucher-prefix"
                      // Prefixs are managed centrally in Settings — make this read-only
                      disabled={true}
                    />
                    <Input
                      type="text"
                      value={voucherNumber}
                      onChange={(e) => setVoucherNumber(e.target.value)}
                      onKeyDown={(e) => e.key === 'Enter' && handleSearch()}
                      placeholder="Enter voucher number"
                      className="rounded-l-none text-lg font-semibold focus-visible:ring-2 focus-visible:ring-green-500"
                      data-testid="input-voucher-number"
                    />
                  </div>
                </div>
                <Button 
                  onClick={handleSearch} 
                  disabled={tollVoucherLoading || isFetching}
                  className="px-8 bg-green-600 hover:bg-green-700"
                  data-testid="button-search"
                >
                  <Search className="h-4 w-4 mr-2" />
                  {tollVoucherLoading || isFetching ? 'Searching...' : 'Search'}
                </Button>
                <Button
                  onClick={handleRefresh}
                  disabled={tollVoucherLoading || isFetching || !voucherNumber.trim()}
                  variant="outline"
                  title="Refresh Data"
                >
                  <RefreshCw className={`w-4 h-4 ${tollVoucherLoading || isFetching ? 'animate-spin' : ''}`} />
                </Button>
              </div>
              
              {/* Search Progress */}
              {(tollVoucherLoading || isFetching) && (
                <div className="mt-2">
                  <div className="flex items-center justify-between text-sm text-gray-600 mb-1">
                    <span>{isFetching && !tollVoucherLoading ? 'Refreshing data...' : 'Fetching voucher data from Notion...'}</span>
                    <span className="font-mono text-green-600">{selectedOrder}</span>
                  </div>
                  <div className="flex items-center justify-center">
                    <TruckLoadingAnimation
                      label={isFetching && !tollVoucherLoading ? "Refreshing data..." : "Fetching voucher data..."}
                    />
                  </div>
                </div>
              )}
            </div>
          </CardContent>
        </Card>
      </div>

      {/* Error / Not Found State */}
      {((tollVoucherData && !tollVoucherData.success) || isError) && (
        <div className="max-w-7xl mx-auto mt-6 animate-in fade-in slide-in-from-bottom-4 duration-500">
          <Card className="border-red-200 shadow-lg bg-white overflow-hidden">
            <div className="h-2 bg-red-500 w-full"></div>
            <CardContent className="p-12 flex flex-col items-center justify-center text-center">
              <div className="w-24 h-24 bg-red-50 rounded-full flex items-center justify-center mb-6 shadow-inner">
                <Search className="h-12 w-12 text-red-500" />
              </div>
              
              <h3 className="text-2xl font-bold text-gray-900 mb-3">
                Voucher Not Found
              </h3>
              
              <p className="text-gray-600 max-w-md mb-8 text-lg">
                We couldn't locate a toll voucher with number <span className="font-mono font-bold text-red-600 bg-red-50 px-2 py-1 rounded">{selectedOrder}</span>
              </p>
              
              <div className="grid gap-4 w-full max-w-lg">
                {/* <div className="bg-blue-50 p-4 rounded-lg border border-blue-100 flex items-start gap-3 text-left">
                  
                </div> */}

                <div className="bg-orange-50 p-4 rounded-lg border border-orange-100 flex items-start gap-3 text-left">
                  <div className="mt-1 bg-orange-100 p-1 rounded">
                    <Receipt className="h-4 w-4 text-orange-600" />
                  </div>
                  <div>
                    <p className="font-semibold text-orange-900">Verify Voucher Number</p>
                    <p className="text-sm text-orange-700">Ensure the number is correct. Try adding or removing suffixes like 'A' or 'B' if applicable.</p>
                  </div>
                </div>
              </div>
              
              {isError && (
                 <p className="mt-6 text-xs text-gray-400">
                   Technical details: {(error as Error)?.message || 'Unknown error'}
                 </p>
              )}
            </CardContent>
          </Card>
        </div>
      )}

      {/* Voucher Display - Landscape */}
      {tollVoucherData && tollVoucherData.success && tollVoucherData.data && (
        <div className="max-w-7xl mx-auto">
          {/* Print Button */}
          <div className="mb-4 flex justify-end">
            <Button onClick={handlePrint} data-testid="button-print">
              <Printer className="h-4 w-4 mr-2" />
              Print
            </Button>
          </div>

          {/* Screen Preview - Simple */}
          <div className="bg-white p-8 rounded-lg shadow-lg">
            {/* Header */}
            <div className="flex items-center justify-between mb-6 border-b-2 border-gray-300 pb-4">
              <img src={logoPath} alt="KM Finny" className="h-16" />
              <div className="text-right">
                <h1 className="text-3xl font-bold text-gray-800">TOLL VOUCHER</h1>
              </div>
            </div>

            {/* Voucher Details - Simple Layout */}
            <div className="grid grid-cols-2 gap-8 mb-8">
              <div className="space-y-4">
                <div>
                  <label className="text-sm font-semibold text-gray-600 uppercase">Voucher No.</label>
                  <p className="text-xl font-bold text-gray-900 mt-1">{tollVoucherData.data.orderNumber}</p>
                </div>
                <div>
                  <label className="text-sm font-semibold text-gray-600 uppercase">Driver</label>
                  <p className="text-lg font-semibold text-gray-900 mt-1">{tollVoucherData.data.driver || 'N/A'}</p>
                </div>
                <div>
                  <label className="text-sm font-semibold text-gray-600 uppercase">Vehicle No.</label>
                  <p className="text-lg font-semibold text-gray-900 mt-1 mb-10">{tollVoucherData.data.vehicle || 'N/A'}</p>
                  <label className="text-sm font-semibold text-gray-600 uppercase">
                    Voucher Date:
                  </label>
                  <p className="text-lg font-semibold text-gray-900 mt-1">{tollVoucherData.data.orderDate || 'N/A'}</p>
                </div>
              </div>
              <div className="space-y-4">
                <div>
                  <label className="text-sm font-semibold text-gray-600 uppercase">Order Details</label>
                  <p className="text-lg font-semibold text-gray-900 mt-1">{tollVoucherData.data.party || 'N/A'}</p>
                </div>
                <div className="bg-green-50 p-4 rounded-lg border-2 border-green-200">
                  <label className="text-sm font-semibold text-green-700 uppercase">Toll Tax</label>
                  <p className="text-3xl font-bold text-green-900 mt-1">₹ {tollVoucherData.data.tollTax.toLocaleString('en-IN')}</p>
                </div>
              </div>
            </div>

            <Separator className="my-6" />

            {/* Amount in Words */}
            <div className="bg-gray-50 p-6 rounded-lg border border-gray-300">
              <label className="text-sm font-semibold text-gray-600 uppercase">Amount in Words</label>
              <p className="text-lg font-semibold text-gray-900 mt-2">{tollVoucherData.data.tollTaxInWords}</p>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

const countParties = (text: string) =>
  (text || "")
    .split(/[,;\n]+/)
    .map(s => s.trim())
    .filter(s => s && s.toLowerCase() !== "n/a").length;

const fontSizeForPartyCount = (count: number) => {
  if (count <= 10) return 16;   // large
  if (count <= 15) return 14;   // medium
  if (count <= 20) return 12;   // small
  return 10;                    // extra small
};

