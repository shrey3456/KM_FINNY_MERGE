import { useState, useEffect } from 'react';
import { useQuery } from '@tanstack/react-query';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Separator } from '@/components/ui/separator';
import { Printer, Search, Package, Building, Calendar, Users, FileText, IndianRupee, Phone, Truck, User, Mail, MapPin, Edit3, Check, X, RefreshCw } from 'lucide-react';
import { apiRequest } from '@/lib/queryClient';
import { useToast } from '@/hooks/use-toast';
import { TruckLoadingAnimation } from '@/components/TruckLoadingAnimation';
import * as QRCode from 'qrcode';
import logoPath from '@assets/logo_og_1756804412382.jpeg';

interface DispatchItem {
  productCode: string;
  productName: string;
  quantity: number;
}

interface DispatchData {
  orderNumber: string;
  plant: string;
  status: string;
  items: DispatchItem[];
  orderInfo: Record<string, string>;
}

interface DispatchResponse {
  success: boolean;
  message: string;
  data: DispatchData | null;
  itemCount: number;
}



export default function Dispatch() {
  const [orderNumber, setOrderNumber] = useState('');
  const [selectedOrder, setSelectedOrder] = useState('');
  const [editableInvoiceAmount, setEditableInvoiceAmount] = useState('');
  const [isEditingAmount, setIsEditingAmount] = useState(false);
  const [editableVehicleDriver, setEditableVehicleDriver] = useState('');
  const [isEditingVehicleDriver, setIsEditingVehicleDriver] = useState(false);
  const [searchProgress, setSearchProgress] = useState(0);
  const [searchStage, setSearchStage] = useState('');
  const { toast } = useToast();

  // Fetch dispatch data for selected order
  const { data: dispatchData, isLoading: dispatchLoading, isFetching, error, refetch } = useQuery<DispatchResponse>({
    queryKey: ['/api/dispatch', selectedOrder],
    enabled: !!selectedOrder,
    queryFn: async () => {
      if (!selectedOrder) throw new Error('No order selected');
      try {
        const response = await apiRequest('POST', '/api/dispatch', { orderNumber: selectedOrder }, false, true);
        if (response && typeof response === 'object') {
          return response as DispatchResponse;
        }
        throw new Error('Invalid response format');
      } catch (error: any) {
        setSearchProgress(0);
        setSearchStage('');
        console.error('❌ Frontend: API error:', error);
        throw new Error(error?.message || 'Failed to fetch dispatch data');
      }
    }
  });

  // Smooth progress animation while loading
  useEffect(() => {
    if (dispatchLoading || isFetching) {
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
  }, [dispatchLoading, isFetching]);

  // NEW: Handle search errors (e.g., Not Found)
  useEffect(() => {
    if (error) {
      // Check if the error message indicates a 404/Not Found scenario
      // The backend likely returns a 404 status which queryFn throws as an error
      const errorMessage = (error as any).message || '';
      const isNotFound = errorMessage.includes('404') || errorMessage.includes('not found');
      
      if (isNotFound) {
        toast({
          title: "Order Not Found",
          description: `Order number #${selectedOrder} could not be found. Please check the number.`,
          variant: "destructive",
        });
      } else {
        toast({
          title: "Search Failed",
          description: errorMessage || "An error occurred while searching for the order.",
          variant: "destructive",
        });
      }
      // Reset progress on error
      setSearchProgress(0);
      setSearchStage('');
    }
  }, [error, selectedOrder, toast]);

  // Update editable amount when dispatch data changes
  useEffect(() => {
    if (dispatchData?.data?.orderInfo?.['Amount >']) {
      const amount = dispatchData.data.orderInfo['Amount >'].toString().replace(/[^\d.-]/g, '');
      setEditableInvoiceAmount(amount);
    }
  }, [dispatchData]);

  // Update editable vehicle & driver when dispatch data changes
  useEffect(() => {
    if (dispatchData?.data?.orderInfo) {
      const vehicleDriver = dispatchData.data.orderInfo['Vehi x Dri :'] || 
                           (dispatchData.data.orderInfo['Vehicle No. :'] || 'N/A') + ' x ' + (dispatchData.data.orderInfo['Driver :'] || 'N/A');
      setEditableVehicleDriver(vehicleDriver);
    }
  }, [dispatchData]);

  // Handle invoice amount editing
  const handleSaveInvoiceAmount = () => {
    if (editableInvoiceAmount.trim() && dispatchData?.data) {
      // Update the local data (in a real app, you'd save to backend)
      dispatchData.data.orderInfo['Amount >'] = editableInvoiceAmount;
      setIsEditingAmount(false);
      toast({
        title: "Invoice Amount Updated",
        description: `Amount updated to ₹${new Intl.NumberFormat('en-IN').format(parseFloat(editableInvoiceAmount) || 0)}`,
      });
    }
  };

  const handleCancelEdit = () => {
    if (dispatchData?.data?.orderInfo?.['Amount >']) {
      const amount = dispatchData.data.orderInfo['Amount >'].toString().replace(/[^\d.-]/g, '');
      setEditableInvoiceAmount(amount);
    }
    setIsEditingAmount(false);
  };

  // Handle vehicle & driver editing
  const handleSaveVehicleDriver = () => {
    if (editableVehicleDriver.trim() && dispatchData?.data) {
      // Update the local data (in a real app, you'd save to backend)
      dispatchData.data.orderInfo['Vehi x Dri :'] = editableVehicleDriver;
      setIsEditingVehicleDriver(false);
      toast({
        title: "Vehicle & Driver Updated",
        description: `Updated to ${editableVehicleDriver}`,
      });
    }
  };

  const handleCancelVehicleDriverEdit = () => {
    if (dispatchData?.data?.orderInfo) {
      const vehicleDriver = dispatchData.data.orderInfo['Vehi x Dri :'] || 
                           (dispatchData.data.orderInfo['Vehicle No. :'] || 'N/A') + ' x ' + (dispatchData.data.orderInfo['Driver :'] || 'N/A');
      setEditableVehicleDriver(vehicleDriver);
    }
    setIsEditingVehicleDriver(false);
  };

  // No automatic orders fetching - only fetch data when user enters order number

  const handleSearch = async () => {
    if (!orderNumber.trim()) {
      toast({
        title: "Order Number Required",
        description: "Please enter an order number to search",
        variant: "destructive"
      });
      return;
    }

    // Set selected order - this will trigger the query automatically due to enabled: !!selectedOrder
    setSelectedOrder(orderNumber.trim());
  };
  const handleRefresh = () => {
    if (!orderNumber.trim()) {
      toast({
        title: "Order Number Required",
        description: "Please enter an order number to refresh",
        variant: "destructive"
      });
      return;
    }

    // If the requested order is already selected, trigger a refetch and show progress.
    if (orderNumber.trim() === selectedOrder) {
      setSearchProgress(0);
      setSearchStage('Refreshing...');
      if (typeof refetch === 'function') {
        refetch();
      }
      return;
    }

    // Otherwise set the order which will trigger the query
    setSelectedOrder(orderNumber.trim());
  };
  const handlePrint = async () => {
    if (!dispatchData?.data) {
      return;
    }

    const { data } = dispatchData;
    
    // Generate QR code for order number (optimized for speed)
    let qrCodeDataUrl = '';
    try {
      qrCodeDataUrl = await QRCode.toDataURL(data.orderNumber, {
        width: 80,
        margin: 0,
        errorCorrectionLevel: 'L',
        type: 'image/png',
        color: {
          dark: '#000000',
          light: '#FFFFFF'
        }
      });
    } catch (error) {
      console.error('Failed to generate QR code:', error);
      // Fallback to text if QR generation fails
      qrCodeDataUrl = '';
    }

    // Convert logo to data URL for print
    let logoDataUrl = '';
    try {
      const response = await fetch(logoPath);
      if (!response.ok) {
        throw new Error(`Failed to fetch logo: ${response.status}`);
      }
      const blob = await response.blob();
      logoDataUrl = await new Promise((resolve) => {
        const reader = new FileReader();
        reader.onload = () => {
          const result = reader.result as string;
          resolve(result);
        };
        reader.readAsDataURL(blob);
      });
    } catch (error) {
      console.error('Failed to load logo:', error);
      // Fallback: try to use the imported path directly
      logoDataUrl = logoPath;
    }
    
    // Calculate dynamic font size for driver text to keep it on one line
    const driverText = editableVehicleDriver || data.orderInfo?.['Vehi x Dri :'] || ((data.orderInfo?.['Vehicle No. :'] || 'N/A') + ' x ' + (data.orderInfo?.['Driver :'] || 'N/A'));
    let driverFontSize = '14px';
    const dLen = driverText.length;
    if (dLen > 50) driverFontSize = '9px';
    else if (dLen > 40) driverFontSize = '10px';
    else if (dLen > 35) driverFontSize = '11px';
    else if (dLen > 30) driverFontSize = '12px';
    else if (dLen > 25) driverFontSize = '13px';

     const htmlContent = `
    <!DOCTYPE html>
    <html>
      <head>
        <meta name="viewport" content="width=device-width,initial-scale=1" />
        <title>${data.orderNumber}</title>
        <style>
          /* minimize browser reserved margins; still ask user to disable headers/footers in print dialog */
          @page { 
          size: 220mm 110mm;
          margin: auto; /* We handle spacing via padding/scaling to ensure fit */
          padding-left:5mm;
          padding-top : 5mm;
          }

          html, body {
            margin: 0;
            padding: 0;
            -webkit-print-color-adjust: exact;
            background: #fff;
            color: #000;
            box-sizing: border-box;
            height: 100%;
            width: 100%;
            overflow: hidden; /* CRITICAL: Never allow a second page */
          }

          /* Party details colour strip and plant variants */
          .plant-divider {
            height: 21px;
            margin: 2px 0;
            border-radius: 4px;
            display: flex;
            align-items: center;
            justify-content: center;
            font-size: 15px;
            font-weight: bold;
            color: black;
            text-shadow: none;
            flex-shrink: 0;
          }
          .plant-valsad {
            background: linear-gradient(90deg, #48bb78, #c6f6d5, #22543d);
          }
          .plant-indore {
            background: linear-gradient(90deg, #8b5a2b, #f5f0e6, #8b5a2b);
          }
          .plant-rajkot {
            background: linear-gradient(90deg, #f56565, #fed7d7, #742a2a);
          }
          .plant-baroda {
            background: linear-gradient(90deg, #4299e1, #bee3f8, #2a4365);
          }
          .plant-lucknow {
            background: linear-gradient(90deg, #ed8936, #feebc8, #7b341e);
          }

          /* natural-flow container — no fixed height values */
          .envelope-container {
            width: 100%;
            max-width: 210mm;
            box-sizing: border-box;
            padding: 4mm;
            display: flex;
            flex-direction: column;
            gap: 6px;
            transform-origin: top left;
            /* avoid internal page breaks */
            page-break-inside: avoid;
            page-break-after: avoid;
          }

          /* sections size naturally; remove any fixed min/max heights */
          .top-section, .middle-section, .bottom-section {
            box-sizing: border-box;
            padding: 0;
            margin: 0;
            overflow: visible;
          }

          .top-section { display:flex; align-items:center; gap:10px; }
          .company-logo { width:80px; height:80px; flex-shrink:0; display:flex; align-items:center; justify-content:center; }
          .company-logo img { max-width:80px; height:auto; display:block; border-radius:8px; }
          .company-center { flex:1 1 auto; min-width:0; text-align:center; padding:0 8px; }
          .company-name { font-size:22px; font-weight:800; margin:0; }
          .company-address { font-size:13px; line-height:1.12; color:#222; margin-top:6px; }

          .qr-code { width:90px; flex-shrink:0; display:flex; flex-direction:column; align-items:center; justify-content:center; }
          .qr-order-number { font-size:18px; font-weight:800; margin-top:6px; }

          .dispatch-header { text-align:center; font-weight:800; padding:2px 2px; background:#444; color:#fff; border-radius:4px; margin:8px 0; font-size:15px; }
          .invoice-no{
           font-size: clamp(9px, 2.5vw, 13px); 
          }
          .middle-section { display:flex; justify-content:space-between; align-items:flex-start; gap:12px; }
          .party-info { display:flex; justify-content:space-between; align-items:center; gap:8px; }
          .party-contact, .party-name, .party-area { min-width:0; }
          .party-name { font-size:18px; font-weight:800; }
          .party-area{font-size:16px; font-weight:800;}
          .party-address-container { font-size:14px; line-height:1.18; word-break:break-word; white-space:pre-wrap; overflow:visible; text-align:center; }

          .divider { border-top:1px solid #ddd; margin:6px 0; }

          .user-info-section { display:flex; justify-content:space-between; align-items:center; font-size:12px; margin-top:8px; }
          .order-date {font-size:15px; font-weight:800};

          /* Print tweaks: ensure content fits and nothing forces a new page */
          @media print {
            html, body { 
              height: 100%; 
              width: 100%;
              margin: 0; 
              padding: 0; 
              overflow: hidden !important; /* Force single page */
            }
            .envelope-container { 
              padding: 4mm !important; 
              height: 100%;
              display: flex;
              flex-direction: column;
              justify-content: space-between; /* Distribute vertical space if loose */
            }
            /* avoid breaks inside main content */
            * { page-break-inside: avoid; page-break-after: avoid; }
          }
        </style>
      </head>
      <body>
        <div class="envelope-container" id="envelope">
          <!-- First Section: Company logo, name & address, QR code -->
          <div class="top-section">
            <div class="company-logo">${logoDataUrl ? `<img src="${logoDataUrl}" alt="Company Logo" />` : '<div style="width:80px;height:80px;background:#ccc;border-radius:8px;"></div>'}</div>
            <div class="company-center">
              <div class="company-name">KRUPA MARKETING</div>
              <div class="gst-details">GST DETAILS : ${data.plant === 'INDORE' ? 'MP - 23AAXFK0360J1Z5' : 'GJ - 24AAXFK0360J1Z3'}</div>
              <div class="company-address">
                ${data.plant === 'INDORE' ? 
                  'D-274-B, AMRAPALI TOWNSHIP, MHOW PITHAMPUR<br/>SONVAYE, INDORE, MADHYA PRADESH- 452 001' : 
                  'OPP. SUGAR & SPICE, 286,287, NEAR BALAJI WAFERS<br/>N.H. NO 48, SHANKAR TALAV, VALSAD, GUJARAT, 396375'
                }<br/><div style="margin-top:4px;font-size:12px;">Email : bill@krupamarketing.com</div>
              </div>
            </div>
            <div class="qr-code">
              ${qrCodeDataUrl ? `<img src="${qrCodeDataUrl}" alt="QR Code for ${data.orderNumber}" style="width:82px;height:auto;" />` : `<div style="font-size:12px;text-align:center;">#${data.orderNumber}</div>`}
              <div class="qr-order-number">#${data.orderNumber}</div>
            </div>
          </div>

          <div class="dispatch-header">DISPATCH</div>

          <div class="middle-section">
            <div style="flex:0 0 35%; min-width:0;">
              <div style="font-weight:800;font-size:14px;">Vehi x Dri:</div>
              <div style="font-size:${driverFontSize}; white-space:nowrap; overflow:hidden; text-overflow:ellipsis;" title="${driverText}">${driverText}</div>
            </div>
            <div style="flex:1; text-align:right; min-width:0; font-size:14px;">
              <div class="invoice-no" style="word-break:break-word; line-height:1.3; margin-bottom:2px;"><strong>Invoice No:</strong> ${data.orderInfo?.['Invoice No :'] || 'N/A'}</div>
              <div style="margin-top:4px;"><strong>Amount:</strong> ₹${editableInvoiceAmount ? new Intl.NumberFormat('en-IN').format(parseFloat(editableInvoiceAmount) || 0) : (data.orderInfo?.['Amount >'] ? new Intl.NumberFormat('en-IN').format(parseFloat(data.orderInfo['Amount >'].toString().replace(/[^\d.-]/g, '')) || 0) : 'N/A')}</div>
            </div>
          </div>

          <div class="divider"></div>

          <div class="plant-divider ${
            data.plant === 'VALSAD' ? 'plant-valsad' :
            data.plant === 'INDORE' ? 'plant-indore' :
            data.plant === 'RAJKOT' ? 'plant-rajkot' :
            data.plant === 'BARODA' ? 'plant-baroda' :
            data.plant === 'LUCKNOW' ? 'plant-lucknow' :
            'plant-valsad'
          }">PARTY DETAILS</div>

          <div class="bottom-section">
            <div class="party-info">
              <div class="party-contact">${data.orderInfo?.['Party Contact :'] || data.orderInfo?.['Contact :'] || 'N/A'}</div>
              <div class="party-name">${data.orderInfo?.['Party Name :'] || 'N/A'}</div>
              <div class="party-area"><span class="party-area-hindi">${data.orderInfo?.['{inhindi Area} :'] || data.orderInfo?.['Area :'] || ''}</span></div>
            </div>

            <div class="divider"></div>

            <div class="party-address-container">${data.orderInfo?.['Party Address :'] || ''}</div>

            <div class="divider"></div>

            <div class="user-info-section">
              <div class="order-date">Order Date: ${data.orderInfo?.['Order Date :'] || ''}</div>
              <div style="text-align:right;"><strong>${JSON.parse(localStorage.getItem('currentUser') || '{}').name || JSON.parse(localStorage.getItem('currentUser') || '{}').username || 'Unknown User'}</strong> | ${new Date().toLocaleString('en-IN', { timeZone: 'Asia/Kolkata', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit' })}</div>
            </div>

            ${(function() {
              const remarkKey = Object.keys(data.orderInfo ?? {}).find(function(k) { return /remark/i.test(k); });
              const remark = remarkKey ? String((data.orderInfo as any)[remarkKey] ?? '').trim() : '';
              if (!remark) return '';
              return '<div style="margin-top:10px;padding:6px 0 0 0;font-size:13px;font-weight:bold;color:red;"><strong>Remark:</strong> ' + remark + '</div>';
            })()}
          </div>
        </div>
      </body>
    </html>
    `;
    
    // Direct print using invisible iframe to avoid preview window
    try {
      // Create invisible iframe for direct printing
      const iframe = document.createElement('iframe');
      iframe.style.display = 'none';
      document.body.appendChild(iframe);
      
      // Get iframe document and write content
      const iframeDoc = iframe.contentWindow?.document;
      if (!iframeDoc) {
        throw new Error('Unable to access iframe document');
      }
      
      iframeDoc.open();
      iframeDoc.write(htmlContent);
      iframeDoc.close();
      
      let printAttempted = false;

      // Wait for content to load, then print directly
      iframe.onload = () => {
        if (printAttempted) return;
        printAttempted = true;

        setTimeout(() => {
          try {
            iframe.contentWindow?.focus();
            // Add beforeprint and afterprint event listeners to handle dialog cancellation
            if (iframe.contentWindow) {
              let printExecuted = false;
              iframe.contentWindow.addEventListener('beforeprint', () => {
                printExecuted = true;
              });
              iframe.contentWindow.addEventListener('afterprint', () => {
                // Clean up iframe after print dialog is closed (whether printed or cancelled)
                setTimeout(() => {
                  if (document.body.contains(iframe)) {
                    document.body.removeChild(iframe);
                  }
                }, 100);
              });
            }
            iframe.contentWindow?.print();
            // Fallback cleanup if events don't fire
            setTimeout(() => {
              if (document.body.contains(iframe)) {
                document.body.removeChild(iframe);
              }
            }, 3000);
          } catch (printError) {
            console.error('Print error:', printError);
            if (document.body.contains(iframe)) {
              document.body.removeChild(iframe);
            }
            toast({
              title: "Print Error", 
              description: "Failed to print. Please try again.",
              variant: "destructive",
            });
          }
        }, 500);
      };
      
      // Fallback: print after a delay if onload doesn't fire
      setTimeout(() => {
        if (printAttempted) return;
        printAttempted = true;

        try {
          if (document.body.contains(iframe)) {
            iframe.contentWindow?.print();
            setTimeout(() => {
              if (document.body.contains(iframe)) {
                document.body.removeChild(iframe);
              }
            }, 3000);
          }
        } catch (fallbackError) {
          console.error('Fallback print error:', fallbackError);
          if (document.body.contains(iframe)) {
            document.body.removeChild(iframe);
          }
        }
      }, 2000);
      
    } catch (error) {
      console.error('Print setup error:', error);
      // Fallback - download as HTML file
      const blob = new Blob([htmlContent], { type: 'text/html' });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = `dispatch-${data.orderNumber}.html`;
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
      URL.revokeObjectURL(url);
      
      toast({
        title: "Print Alternative",
        description: "Downloaded HTML file for printing. Open and print from your browser.",
      });
    }
  };


  return (
    <div className="w-full p-6">
      <div className="flex items-center gap-2 mb-6">
        <Truck className="h-6 w-6 text-[#001d6e]" style={{fill: "#eab308"}} />
        <h1 className="text-3xl font-bold text-[#001d6e]">Dispatch</h1>
      </div>

      <Card className="mb-6">
        <CardHeader>
          <CardDescription>
            Enter an order number to fetch live data from Notion for dispatch
          </CardDescription>
        </CardHeader>
        <CardContent>
          <div className="flex gap-4 items-end">
            <div className="flex-1">
              <Input
                id="orderNumber"
                value={orderNumber}
                onChange={(e) => setOrderNumber(e.target.value)}
                placeholder="Enter order number"
                onKeyDown={(e) => e.key === 'Enter' && handleSearch()}
                className="w-full"
              />
            </div>
            <Button 
              onClick={handleSearch}
              disabled={dispatchLoading || !orderNumber.trim()}
            >
              <Search className="w-4 h-4 mr-2" />
              {dispatchLoading ? 'Searching...' : 'Search'}
            </Button>

             <Button
              onClick={handleRefresh}
              disabled={dispatchLoading || isFetching || !orderNumber.trim()}
              variant="outline"
              title="Refresh Data"
            >
              <RefreshCw className={`w-4 h-4 ${dispatchLoading || isFetching ? 'animate-spin' : ''}`} />
            </Button>
          </div>

          {/* Progress indicator during search */}
          {(dispatchLoading || isFetching) && (
            <div className="mt-2">
              <div className="flex items-center justify-between text-sm text-gray-600 mb-1">
                <span>{isFetching && !dispatchLoading ? 'Refreshing data...' : 'Fetching dispatch data from Notion...'}</span>
                <span className="font-mono text-blue-600">#{selectedOrder}</span>
              </div>
              <div className="flex items-center justify-center">
                <TruckLoadingAnimation
                  label={isFetching && !dispatchLoading ? "Refreshing data..." : "Fetching dispatch data..."}
                />
              </div>
            </div>
          )}
        </CardContent>
      </Card>





      {/* Dispatch Data Display */}
      {dispatchData?.success && dispatchData.data && (
        <Card>
          <CardHeader className="flex flex-row items-start justify-between">
            <div>
              <CardTitle className="flex items-center gap-2">
                <Package className="h-5 w-5" />
                Order #{dispatchData.data.orderNumber}
              </CardTitle>
            </div>
            <Button 
              onClick={handlePrint}
              className="bg-yellow-500 hover:bg-yellow-600 text-black"
            >
              <Printer className="h-4 w-4 mr-2 text-black" />
              Print Dispatch
            </Button>
          </CardHeader>
          <CardContent>


            {/* Comprehensive Order Information */}
            {dispatchData.data.orderInfo && (
              <>
                <Separator className="my-4" />
                <div>
                  <h3 className="font-semibold mb-4 flex items-center gap-2">
                    <Users className="h-4 w-4" />
                    Order Details
                  </h3>
                  
                  {/* Order Information Section */}
                  <div className="space-y-6">
                    {/* Basic Order Details */}
                    <div className="bg-blue-50 p-4 rounded-lg border border-blue-200">
                      <h4 className="font-semibold text-blue-900 mb-3 text-sm">Basic Order Information</h4>
                      <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                        {/* Order Date */}
                        {dispatchData.data.orderInfo['Order Date :'] && (
                          <div className="flex items-center gap-2">
                            <Calendar className="h-4 w-4 text-blue-600" />
                            <div>
                              <p className="text-xs text-gray-600">Order Date</p>
                              <p className="font-medium text-base">{dispatchData.data.orderInfo['Order Date :']}</p>
                            </div>
                          </div>
                        )}
                        
                        {/* Order Number */}
                        <div className="flex items-center gap-2">
                          <Package className="h-4 w-4 text-green-600" />
                          <div>
                            <p className="text-xs text-gray-600">Order Number</p>
                            <p className="font-medium text-base">#{dispatchData.data.orderNumber}</p>
                          </div>
                        </div>
                      </div>
                    </div>

                    {/* Operational Details */}
                    <div className="bg-blue-50 p-4 rounded-lg border border-blue-200">
                      <h4 className="font-semibold text-blue-900 mb-3 text-sm">Operational Details</h4>
                      <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
                        {/* Plant */}
                        <div className="flex items-center gap-2">
                          <Building className="h-4 w-4 text-purple-600" />
                          <div>
                            <p className="text-xs text-gray-600">Plant</p>
                            <p className="font-medium text-base">{dispatchData.data.plant}</p>
                          </div>
                        </div>
                        
                        {/* Status */}
                        <div className="flex items-center gap-2">
                          <Package className="h-4 w-4 text-orange-600" />
                          <div>
                            <p className="text-xs text-gray-600">Status</p>
                            <Badge variant={dispatchData.data.status === 'DISPATCHED' ? 'default' : 'secondary'} className="text-sm">
                              {dispatchData.data.status}
                            </Badge>
                          </div>
                        </div>

                        {/* Vehicle x Driver - Editable */}
                        {editableVehicleDriver && (
                          <div className="flex items-center gap-2">
                            <Truck className="h-4 w-4 text-gray-600" />
                            <div className="flex-1">
                              <p className="text-xs text-gray-600">Vehicle x Driver</p>
                              {isEditingVehicleDriver ? (
                                <div className="flex items-start gap-2 mt-1">
                                  <textarea
                                    value={editableVehicleDriver}
                                    onChange={(e) => setEditableVehicleDriver(e.target.value)}
                                    className="min-h-[60px] text-sm w-64 p-2 border border-input bg-background rounded-md resize-none"
                                    placeholder="Enter vehicle x driver"
                                    rows={3}
                                  />
                                  <Button size="sm" onClick={handleSaveVehicleDriver} className="h-8 w-8 p-0">
                                    <Check className="h-4 w-4" />
                                  </Button>
                                  <Button size="sm" variant="outline" onClick={handleCancelVehicleDriverEdit} className="h-8 w-8 p-0">
                                    <X className="h-4 w-4" />
                                  </Button>
                                </div>
                              ) : (
                                <div className="flex items-center gap-2">
                                  <p className="font-medium text-base">
                                    {editableVehicleDriver}
                                  </p>
                                  <Button 
                                    size="sm" 
                                    variant="ghost" 
                                    onClick={() => setIsEditingVehicleDriver(true)}
                                    className="h-6 w-6 p-0 hover:bg-gray-100"
                                  >
                                    <Edit3 className="h-3 w-3" />
                                  </Button>
                                </div>
                              )}
                            </div>
                          </div>
                        )}
                      </div>
                    </div>

                    {/* Party Information */}
                    <div className="bg-blue-50 p-4 rounded-lg border border-blue-200">
                      <h4 className="font-semibold text-blue-900 mb-3 text-sm">Party Information</h4>
                      <div className="space-y-4">
                        <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                          {/* Party Name */}
                          {dispatchData.data.orderInfo['Party Name :'] && (
                            <div className="flex items-center gap-2">
                              <Users className="h-4 w-4 text-indigo-600" />
                              <div>
                                <p className="text-xs text-gray-600">Party Name</p>
                                <p className="font-medium text-base">{dispatchData.data.orderInfo['Party Name :']}</p>
                              </div>
                            </div>
                          )}
                          
                          {/* Party Area */}
                          {(dispatchData.data.orderInfo['{inhindi Area} :'] || dispatchData.data.orderInfo['Area :']) && (
                            <div className="flex items-center gap-2">
                              <MapPin className="h-4 w-4 text-teal-600" />
                              <div>
                                <p className="text-xs text-gray-600">Party Area</p>
                                <p className="font-medium text-base">{dispatchData.data.orderInfo['{inhindi Area} :'] || dispatchData.data.orderInfo['Area :']}</p>
                              </div>
                            </div>
                          )}
                        </div>
                        
                        {/* Party Address */}
                        {dispatchData.data.orderInfo['Party Address :'] && (
                          <div className="p-3 bg-white rounded border">
                            <p className="text-xs text-gray-600 mb-1">Party Address</p>
                            <p className="font-medium text-base break-words whitespace-pre-wrap overflow-wrap-anywhere">{dispatchData.data.orderInfo['Party Address :']}</p>
                          </div>
                        )}
                        
                        {/* Party Contact */}
                        {dispatchData.data.orderInfo['Party Contact :'] && (
                          <div className="flex items-center gap-2">
                            <Phone className="h-4 w-4 text-blue-600" />
                            <div>
                              <p className="text-xs text-gray-600">Party Contact</p>
                              <p className="font-medium text-base">{dispatchData.data.orderInfo['Party Contact :']}</p>
                            </div>
                          </div>
                        )}
                      </div>
                    </div>



                    {/* Financial Information */}
                    <div className="bg-purple-50 p-4 rounded-lg border border-purple-200">
                      <h4 className="font-semibold text-purple-900 mb-3 text-sm">Financial Information</h4>
                      <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                        {/* Invoice Number */}
                        {dispatchData.data.orderInfo['Invoice No :'] && (
                          <div className="flex items-center gap-2">
                            <FileText className="h-4 w-4 text-red-600" />
                            <div>
                              <p className="text-xs text-gray-600">Invoice Number</p>
                              <p className="font-medium text-base">{dispatchData.data.orderInfo['Invoice No :']}</p>
                            </div>
                          </div>
                        )}
                        
                        {/* Invoice Amount - Editable */}
                        {dispatchData.data.orderInfo['Amount >'] && (
                          <div className="flex items-center gap-2">
                            <IndianRupee className="h-4 w-4 text-green-600" />
                            <div className="flex-1">
                              <p className="text-xs text-gray-600">Invoice Amount</p>
                              {isEditingAmount ? (
                                <div className="flex items-center gap-2 mt-1">
                                  <Input
                                    type="number"
                                    value={editableInvoiceAmount}
                                    onChange={(e) => setEditableInvoiceAmount(e.target.value)}
                                    className="h-8 text-sm w-32"
                                    placeholder="Enter amount"
                                  />
                                  <Button size="sm" onClick={handleSaveInvoiceAmount} className="h-8 w-8 p-0">
                                    <Check className="h-4 w-4" />
                                  </Button>
                                  <Button size="sm" variant="outline" onClick={handleCancelEdit} className="h-8 w-8 p-0">
                                    <X className="h-4 w-4" />
                                  </Button>
                                </div>
                              ) : (
                                <div className="flex items-center gap-2">
                                  <p className="font-medium text-base">
                                    ₹{new Intl.NumberFormat('en-IN').format(parseFloat(editableInvoiceAmount) || 0)}
                                  </p>
                                  <Button 
                                    size="sm" 
                                    variant="ghost" 
                                    onClick={() => setIsEditingAmount(true)}
                                    className="h-6 w-6 p-0 hover:bg-gray-100"
                                  >
                                    <Edit3 className="h-3 w-3" />
                                  </Button>
                                </div>
                              )}
                            </div>
                          </div>
                        )}
                      </div>
                    </div>
                  </div>

                  {/* Remark — find any property whose name contains remark/note */}
                  {(() => {
                    const info = dispatchData.data.orderInfo;
                    const remarkKey = Object.keys(info).find(k =>
                      /remark|note/i.test(k)
                    );
                    const remark = remarkKey ? String(info[remarkKey] ?? '').trim() : '';
                    return remark ? (
                      <div className="bg-red-50 p-4 rounded-lg border border-red-300 mt-6">
                        <h4 className="font-semibold text-red-700 mb-1 text-sm uppercase tracking-wide">Remark</h4>
                        <p className="text-base font-semibold text-red-600 whitespace-pre-wrap">{remark}</p>
                      </div>
                    ) : null;
                  })()}

                </div>
              </>
            )}


          </CardContent>
        </Card>
      )}

      {/* Not Found UI - Shows when order data is not found */}
      {selectedOrder && ((dispatchData && !dispatchData.data) || error) && !dispatchLoading && !isFetching && (
        <div className="mt-6 animate-in fade-in slide-in-from-bottom-4 duration-500">
          <Card className="border-orange-200 shadow-lg bg-white overflow-hidden">
            <div className="h-2 bg-gradient-to-r from-orange-500 to-yellow-500 w-full"></div>
            <CardContent className="p-12 flex flex-col items-center justify-center text-center">
              <div className="w-24 h-24 bg-gradient-to-br from-orange-50 to-yellow-50 rounded-full flex items-center justify-center mb-6 shadow-inner">
                <Package className="h-12 w-12 text-orange-600" />
              </div>
              
              <h3 className="text-2xl font-bold text-gray-900 mb-3">
                Dispatch Order Not Found
              </h3>
              
              <p className="text-gray-600 max-w-md mb-8 text-lg">
                Unable to find dispatch information for order <span className="font-mono font-bold text-orange-600 bg-orange-50 px-3 py-1 rounded-md">{selectedOrder}</span>
              </p>
              
              <div className="grid gap-4 w-full max-w-lg">
                <div className="bg-blue-50 p-4 rounded-lg border border-blue-100 flex items-start gap-3 text-left">
                  <div className="mt-1 bg-blue-100 p-1.5 rounded">
                    <Truck className="h-4 w-4 text-blue-600" />
                  </div>
                  <div className="flex-1">
                    <p className="font-semibold text-blue-900 mb-1">Verify Order Number</p>
                    <p className="text-sm text-blue-700">Double-check the order number format and ensure the dispatch has been created.</p>
                  </div>
                </div>
                
                <div className="bg-purple-50 p-4 rounded-lg border border-purple-100 flex items-start gap-3 text-left">
                  <div className="mt-1 bg-purple-100 p-1.5 rounded">
                    <FileText className="h-4 w-4 text-purple-600" />
                  </div>
                  <div className="flex-1">
                    <p className="font-semibold text-purple-900 mb-1">Order Status</p>
                    <p className="text-sm text-purple-700">Ensure the order has progressed to dispatch stage in the system.</p>
                  </div>
                </div>
              </div>
              
              <Button
                variant="outline"
                className="mt-8"
                onClick={() => {
                  setOrderNumber('');
                  setSelectedOrder('');
                }}
              >
                <Search className="h-4 w-4 mr-2" />
                Try Another Order
              </Button>
            </CardContent>
          </Card>
        </div>
      )}


    </div>
  );
}
