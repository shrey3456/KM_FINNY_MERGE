import { useState, useEffect } from 'react';
import { useQuery } from '@tanstack/react-query';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Separator } from '@/components/ui/separator';
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover';
import { Calendar as DatePickerCalendar } from '@/components/ui/calendar';
import { format } from 'date-fns';
import { Printer, Search, Truck, User, Receipt, Lock, RefreshCw, CalendarIcon, X } from 'lucide-react';
import { Progress } from '@/components/ui/progress';
import { apiRequest } from '@/lib/queryClient';
import { PlantChoice } from '@/components/PlantBadge';
import { plantShortCode, useTabSubtitle } from '@/lib/appTabs';
import { useToast } from '@/hooks/use-toast';
const logoPath = '/logo_wo_bg_1757152661130.png'; // served from client/public
import { useSingleDateFilter } from '@/hooks/useSingleDateFilter';
import { TruckLoadingAnimation } from '@/components/TruckLoadingAnimation';
import { usePersistentFilter } from "@/hooks/usePersistentFilter";
import { PageSkeleton } from "@/components/ui/loading-skeletons";

interface TollVoucherFields {
  orderNumber: string;
  driver: string;
  vehicle: string;
  tollTax: number;
  party: string;
  order: string;
  tollTaxInWords: string;
  orderDate: string;
}

// One vehicle's voucher when a search turns up several (same driver, different trucks) — those are
// never blended into one voucher, so the user picks which vehicle to view/print.
interface TollVehicleOption extends TollVoucherFields {
  vehicleNumber: string;
  mergedVoucherCount: number;
}

interface TollVoucherData extends TollVoucherFields {
  plant: string;
  mergedVoucherCount?: number;
  vehicleOptions?: TollVehicleOption[];
}

interface TollVoucherResponse {
  success: boolean;
  message: string;
  data: TollVoucherData | null;
}

// Access control hook. Read synchronously on first render (it is only localStorage), so the page
// never flashes a loading skeleton before drawing — that flash was the glitch when switching here.
function useAccessControl() {
  const [hasAccess] = useState(() => {
    try {
      const userString = localStorage.getItem('currentUser');
      if (!userString) return false;
      const user = JSON.parse(userString);
      const userRole = user.role?.toLowerCase();
      const allowedRoles = ['admin', 'super-admin', 'superadmin', 'super_admin'];
      const isAdmin = allowedRoles.includes(userRole);
      // Access is controlled by admin via User Management's Allowed Pages —
      // route-level access is already enforced by ProtectedRoute before this
      // component ever renders; this just mirrors that for the page's own state.
      let allowedPages: string[] = [];
      try { allowedPages = JSON.parse(user.allowedPages || "[]"); } catch { /* default [] */ }
      return isAdmin || allowedPages.includes("toll-voucher");
    } catch (error) {
      console.error('Error checking access:', error);
      return false;
    }
  });
  return { hasAccess, isLoading: false };
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
  const [selectedPlant, setSelectedPlant] = usePersistentFilter('tollVoucher:plant', 'valsad');
  // Show the chosen plant on this page's tab in short form, e.g. "VAL" / "IND" / "LKW".
  useTabSubtitle(plantShortCode(selectedPlant));
  //const [voucherPrefix, setVoucherPrefix] = useState('KM2526-EV-');
  const [voucherNumber, setVoucherNumber] = useState('');
  const [selectedOrder, setSelectedOrder] = useState('');
  // Whether the current search term is a voucher number or a driver name
  const [searchMode, setSearchMode] = usePersistentFilter<'voucher' | 'driver'>('tollVoucher:searchMode', 'voucher');
  // null = not chosen yet; when a search returns multiple vehicles, the voucher stays hidden
  // behind a "pick a vehicle" prompt until set.
  const [selectedVehicleIndex, setSelectedVehicleIndex] = useState<number | null>(0);
  const [searchProgress, setSearchProgress] = useState(0);
  const [searchStage, setSearchStage] = useState('');
  const { toast } = useToast();
  const { hasAccess, isLoading: accessLoading } = useAccessControl();
  const [voucherPrefix, setVoucherPrefix] = useState<string>('KM2526-EV-');
  const [isAdminUser, setIsAdminUser] = useState(false);

  // Date filter: which day's vouchers to search. Defaults to today and persists across page
  // refreshes. Optional — with no date the search spans ALL dates (the server drops its date
  // filter for an empty voucherDate). The calendar still opens on today when nothing is picked.
  const [todayMidnight] = useState(() => {
    const d = new Date();
    d.setHours(0, 0, 0, 0);
    return d;
  });
  const { savedDate: selectedDate, saveDateFilter: setSelectedDate } =
    useSingleDateFilter('toll-voucher', todayMidnight);
  const [isDatePickerOpen, setIsDatePickerOpen] = useState(false);
  const calendarMonth = selectedDate || todayMidnight;
  const selectedDateStr = selectedDate ? format(selectedDate, 'yyyy-MM-dd') : '';

  // Driver-name autocomplete for the search bar (same endpoint the Expense Voucher page uses).
  const [driverSuggestions, setDriverSuggestions] = useState<string[]>([]);
  const [showSuggestions, setShowSuggestions] = useState(false);

  useEffect(() => {
    const term = voucherNumber.trim();
    // Only worth suggesting once there's a letter to match against (a purely numeric term is a
    // voucher number, not a driver name).
    if (term.length < 2 || !/[a-zA-Z]/.test(term)) {
      setDriverSuggestions([]);
      return;
    }

    let cancelled = false;
    const timer = setTimeout(async () => {
      try {
        const res = await apiRequest(
          'GET',
          `/api/expense-voucher/driver-suggestions?q=${encodeURIComponent(term)}`,
          undefined,
          false,
          true
        );
        if (!cancelled && res?.success) {
          setDriverSuggestions(res.suggestions || []);
        }
      } catch (e) {
        if (!cancelled) setDriverSuggestions([]);
      }
    }, 250);

    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [voucherNumber]);

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
    queryKey: ['/api/toll-voucher', searchMode, selectedOrder, selectedDateStr],
    enabled: !!selectedOrder && hasAccess,
    queryFn: async () => {
      if (!selectedOrder) throw new Error('No order selected');
      try {
        const body =
          searchMode === 'driver'
            ? { driverName: selectedOrder, voucherDate: selectedDateStr }
            : { orderNumber: selectedOrder, voucherDate: selectedDateStr };
        const response = await apiRequest('POST', '/api/toll-voucher', body, false, true);
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

  // A search can turn up multiple vehicles (e.g. same driver, different trucks). Whenever a fresh
  // result comes in, hide the voucher behind a "pick a vehicle" prompt if there's more than one;
  // otherwise there's nothing to choose, so go straight to the voucher.
  useEffect(() => {
    const options = tollVoucherData?.data?.vehicleOptions;
    setSelectedVehicleIndex(options && options.length > 1 ? null : 0);
  }, [tollVoucherData]);

  // The voucher being shown/printed: the picked vehicle's own voucher when there are several,
  // otherwise the single (possibly merged) voucher the search returned.
  const voucher: TollVoucherFields | null = (() => {
    const data = tollVoucherData?.data;
    if (!data) return null;
    if (data.vehicleOptions && data.vehicleOptions.length > 1) {
      return selectedVehicleIndex !== null ? data.vehicleOptions[selectedVehicleIndex] ?? null : null;
    }
    return data;
  })();

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

  const handleSearch = (termOverride?: string) => {
    const term = (termOverride ?? voucherNumber).trim();
    if (!term) {
      toast({
        title: "Search Term Required",
        description: "Please enter a voucher number or driver name to search",
        variant: "destructive",
      });
      return;
    }

    // Auto-detect: a term containing letters is a driver name, UNLESS it starts with a
    // digit -- voucher numbers always start with a digit (some carry a trailing letter
    // suffix, e.g. "102547A" / "102547B" for split vouchers), while driver names never
    // do (same rule as the Expense Voucher page).
    if (/[a-zA-Z]/.test(term) && !/^\d/.test(term)) {
      // Driver name is searched as-is; the server merges ALL of that driver's vouchers.
      setSearchProgress(0);
      if (searchMode === 'driver' && selectedOrder === term) {
        setSearchStage('Refreshing...');
        refetch();
      } else {
        setSearchMode('driver');
        setSelectedOrder(term);
      }
      return;
    }

    // Voucher-number search
    const fullVoucherNumber = `${voucherPrefix}${term}`;
    setSearchProgress(0);
    if (searchMode === 'voucher' && fullVoucherNumber === selectedOrder) {
      setSearchStage('Refreshing...');
      refetch();
    } else {
      setSearchMode('voucher');
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
    if (!voucher) return;

    const partyText = voucher.party || "";
    const length = partyText.length;
    
    // Entries flow side by side and wrap across the whole Order Details box instead of stacking one per line.
    // Starting font = the largest whose wrapped text fits (box ~460pt wide x ~78pt tall, bold caps ~0.64em/char);
    // the script in the print page then refines it against the real layout.
    const partyEntries = partyText.split("\n").map((l) => l.trim()).filter(Boolean);
    const partyFlow = partyEntries.join("  |  ");
    let partyFontPt = 6;
    for (let size = 20; size >= 6; size -= 0.5) {
      const charsPerLine = Math.floor(460 / (size * 0.64));
      const lines = Math.max(1, Math.ceil(partyFlow.length / charsPerLine));
      if (lines * size * 1.15 <= 70) { partyFontPt = size; break; }
    }
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

    const printOrderNumber = voucher.orderNumber
      ? voucher.orderNumber.replace('EV', 'TV')
      : '';

    // Each voucher number stays whole: lines break only between numbers, never inside one.
    const voucherNoHtml = printOrderNumber
      .split(/\s*,\s*/)
      .filter(Boolean)
      .map((n) => `<span style="white-space: nowrap;">${n}</span>`)
      .join(", ");

    // Voucher No. cell font sized by length so every number of a merged voucher fits (the print runs
    // in a hidden iframe, so runtime measurement can't be used here).
    const voucherNoLength = printOrderNumber.length;
    let voucherNoFontPt = 16; // default (single voucher)
    if (voucherNoLength > 110) voucherNoFontPt = 5;
    else if (voucherNoLength > 90) voucherNoFontPt = 6;
    else if (voucherNoLength > 72) voucherNoFontPt = 7;
    else if (voucherNoLength > 55) voucherNoFontPt = 8;
    else if (voucherNoLength > 42) voucherNoFontPt = 9.5;
    else if (voucherNoLength > 30) voucherNoFontPt = 11;
    else if (voucherNoLength > 20) voucherNoFontPt = 13;

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

            .grid-row { display: flex; width: 100%; border-bottom: 1px solid #000; flex-shrink: 0; }
            .details-row { flex: 1 1 0; min-height: 0; overflow: hidden; flex-shrink: 1; }
            .details-row .col { min-height: 0; overflow: hidden; }
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
            
            .order-details-content { font-size: ${partyFontPt}pt; font-weight: bold; text-align: center; width: 100%; margin: 0; line-height: 1.1; overflow-wrap: anywhere; }
            
            .w-2-1-a { width: 66.66%; }
            .w-2-1-b { width: 33.33%; }
            .w-2-1-c { width: 66.66%; background: ${selectedPlant === "indore"
                ? "linear-gradient(135deg, #693c11ff 0%, #c58e61ff 100%)"
                : "linear-gradient(135deg, #e76e2eff 0%, #d26b42ff 100%)"
              } !important;}
            
            .w-1-2-a { width: 20%; }
            .w-1-2-b { width: 80%; }
            
            .w-tax-a { width: 15%; }
            .w-tax-b { width: 13%; }
            .w-tax-c { width: 72%; }

            img { max-height: 80px; width: auto; }
          </style>
        </head>
        <body>
          <div class="voucher-container">
            <div class="grid-row" style="height: 22mm;">
              <div class="w-2-1-c" style="display: flex; align-items: center; justify-content: center;">
                <div class="title-text">TOLL TAX VOUCHER</div>
              </div>
              <div class="col w-2-1-b" style="padding: 0; display: flex; flex-direction: column; align-items: stretch;">
                <div style="background-color: #6366f1; color: white; padding: 3px; text-align: center; border-bottom: 1px solid #000;">
                  <span class="label-text" style="font-size: 12pt;">${voucher.orderDate || new Date().toLocaleDateString('en-GB')}</span>
                </div>
                <div id="voucher-no-box" style="flex: 1; min-height: 0; overflow: hidden; padding: 3px 6px; display: flex; align-items: center; justify-content: center;">
                  <p id="voucher-no" class="value-text" style="margin: 0; text-align: center; line-height: 1.15; font-size: ${voucherNoFontPt}pt;">${voucherNoHtml}</p>
                </div>
              </div>
            </div>

            <div class="grid-row">
              <div class="col w-2-1-a company-section">
                <img src="${logoDataUrl}" alt="Logo" />
                <div class="company-info">
                  <h2>KRUPA MARKETING</h2>
                  <p style="white-space: nowrap; font-size: 9pt;">OPP. SUGAR & SPICE, 286,287, NEAR BALAJI WAFERS PVT LTD,</p>
                  <p style="white-space: nowrap; font-size: 9pt;">N.H. NO 48, SHANKAR TALAV, VALSAD, GUJARAT, 396375</p>
                  <p style="font-size: 12pt; font-weight: 600; margin-top: 4px;">Email : steer@krupamarketing.com</p>
                </div>
              </div>
              <div class="col w-2-1-b" style="padding: 0; display: block;">
                <div style="display: flex; flex-direction: column; height: 100%;">
                  <div style="flex: 1; display: flex; flex-direction: column; border-bottom: 1px solid #000;">
                    <div class="bg-orange" style="text-align: center; padding: 2px; font-weight: 600;">Vehicle:</div>
                    <div style="text-align: center; padding: 2px; font-weight: bold; font-size: 14pt; flex-grow: 1; display: flex; align-items: center; justify-content: center;">${voucher.vehicle || "N/A"}</div>
                  </div>
                  <div style="flex: 1; display: flex; flex-direction: column;">
                    <div class="bg-yellow" style="text-align: center; padding: 2px; font-weight: 600;">Driver:</div>
                    <div style="text-align: center; padding: 2px; font-weight: bold; font-size: 14pt; flex-grow: 1; display: flex; align-items: center; justify-content: center;">${voucher.driver || "N/A"}</div>
                  </div>
                </div>
              </div>
            </div>

            <div class="grid-row details-row">
              <div class="col w-1-2-a">
                <span class="label-text">Order Details:</span>
              </div>
              <div class="col w-1-2-b" style="overflow: hidden; position: relative; padding: 6px 8px;">
                <p id="order-details-content" class="order-details-content">${partyFlow || 'N/A'}</p>
              </div>
            </div>

            <div class="grid-row" style="height: 9mm; border-bottom: none;">
              <div class="col w-tax-a" style="padding: 2px;">
                <span class="label-text" style="font-size: 11pt;">Toll Tax:</span>
              </div>
              <div class="col w-tax-b" style="padding: 2px;">
                <span class="value-text" style="font-size: 12pt; color: #dc2626;">₹${voucher.tollTax.toFixed(2)}</span>
              </div>
              <div class="col w-tax-c" style="padding: 2px;">
                <span style="font-size: 9pt; font-weight: 600;">${voucher.tollTaxInWords}</span>
              </div>
            </div>
          </div>

          <script>
            (function fitVoucherNo() {
              const el = document.getElementById('voucher-no');
              const box = document.getElementById('voucher-no-box');
              if (!el || !box || !box.clientHeight) return; // no layout
              let size = 18;
              el.style.fontSize = size + 'pt';
              while ((el.scrollHeight + 6 > box.clientHeight || el.scrollWidth + 12 > box.clientWidth) && size > 7) {
                size -= 0.5;
                el.style.fontSize = size + 'pt';
              }
            })();
            (function adjustFontSize() {
              const element = document.getElementById('order-details-content');
              if (!element || !element.parentElement || !element.parentElement.clientHeight) return; // hidden iframe has no layout
              
              const parent = element.parentElement;
              // Start large and shrink until the text fits, so it fills the box without being cut off.
              let size = 22;
              element.style.fontSize = size + 'pt';
              while ((element.scrollHeight + 18 > parent.clientHeight || element.scrollWidth + 16 > parent.clientWidth) && size > 6) {
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
      // Off-screen but laid out at the page size (not display:none), so the fit script can measure the box.
      iframe.style.cssText = "position: fixed; left: -10000px; top: 0; width: 220mm; height: 110mm; border: 0;";
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
      <PageSkeleton />
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
    <div className="w-full p-6">
      {/* Header Section */}
      <div className="w-full mb-6">
        <div className="flex items-center justify-between mb-4">
          <div className="flex items-center gap-3">
            <Receipt className="h-8 w-8 text-[#001d6e]" style={{fill: "#16a34a"}} />
            <h1 className="text-3xl font-bold text-[#001d6e]">Toll Voucher</h1>
          </div>
          <div className="flex gap-3">
            {/* Plant capsules — same colours as Plant Master (PlantBadge). */}
            <PlantChoice plant="VALSAD" selected={selectedPlant === 'valsad'} onSelect={() => setSelectedPlant('valsad')} />
            <PlantChoice plant="INDORE" selected={selectedPlant === 'indore'} onSelect={() => setSelectedPlant('indore')} />
            <PlantChoice plant="LUCKNOW" selected={selectedPlant === 'lucknow'} onSelect={() => setSelectedPlant('lucknow')} />
          </div>
        </div>
      </div>

      {/* Search Section */}
      <div className="w-full mb-6">
        <Card>
          <CardHeader>
            <CardDescription>
              Enter a voucher number, or a driver name to list all of that driver's vouchers. Data is fetched live from Notion.
            </CardDescription>
          </CardHeader>
          <CardContent>
            <div className="space-y-4">
              <div className="flex flex-col sm:flex-row sm:items-center gap-2">
                <span className="text-sm font-medium text-gray-600 whitespace-nowrap">Voucher Date:</span>
                <Popover open={isDatePickerOpen} onOpenChange={setIsDatePickerOpen}>
                  <PopoverTrigger asChild>
                    <Button
                      variant="outline"
                      className="w-full sm:w-[220px] justify-start text-left font-normal"
                      data-testid="button-voucher-date"
                    >
                      <CalendarIcon className="mr-2 h-4 w-4" />
                      {selectedDate ? format(selectedDate, 'dd/MM/yyyy') : 'All dates'}
                    </Button>
                  </PopoverTrigger>
                  <PopoverContent className="w-auto p-0" align="start">
                    <DatePickerCalendar
                      mode="single"
                      selected={selectedDate ?? undefined}
                      defaultMonth={calendarMonth}
                      onSelect={(date) => {
                        if (date) {
                          setSelectedDate(date);
                          setIsDatePickerOpen(false);
                        }
                      }}
                      initialFocus
                    />
                  </PopoverContent>
                </Popover>
                {selectedDate && (
                  <Button
                    variant="ghost"
                    size="sm"
                    className="text-gray-500 hover:text-gray-700"
                    onClick={() => setSelectedDate(null)}
                    title="Clear date — search across all dates"
                  >
                    <X className="h-4 w-4 mr-1" />
                    Clear
                  </Button>
                )}
              </div>
              <div className="flex gap-4 items-end">
                <div className="flex-1 relative">
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
                      onKeyDown={(e) => {
                        if (e.key === 'Enter') {
                          setShowSuggestions(false);
                          handleSearch();
                        } else if (e.key === 'Escape') {
                          setShowSuggestions(false);
                        }
                      }}
                      onFocus={() => setShowSuggestions(true)}
                      // Delay so a click on a suggestion registers before the dropdown unmounts.
                      onBlur={() => setTimeout(() => setShowSuggestions(false), 150)}
                      placeholder="Voucher number or driver name..."
                      className="rounded-l-none text-lg font-semibold focus-visible:ring-2 focus-visible:ring-green-500"
                      data-testid="input-voucher-number"
                    />
                  </div>
                  {showSuggestions && driverSuggestions.length > 0 && (
                    <div className="absolute z-10 mt-1 w-full rounded-md border bg-white shadow-lg max-h-56 overflow-y-auto">
                      {driverSuggestions.map((name) => (
                        <button
                          key={name}
                          type="button"
                          className="w-full text-left px-3 py-2 text-sm hover:bg-green-50 flex items-center gap-2"
                          onMouseDown={(e) => {
                            // onMouseDown (not onClick) fires before the input's onBlur, so the
                            // click isn't lost to the blur timeout.
                            e.preventDefault();
                            setVoucherNumber(name);
                            setShowSuggestions(false);
                            handleSearch(name);
                          }}
                        >
                          <User className="h-3.5 w-3.5 text-gray-400 shrink-0" />
                          {name}
                        </button>
                      ))}
                    </div>
                  )}
                </div>
                <Button 
                  onClick={() => handleSearch()} 
                  disabled={tollVoucherLoading || isFetching || !voucherNumber.trim()}
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
        <div className="w-full mt-6 animate-in fade-in slide-in-from-bottom-4 duration-500">
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
                We couldn't locate {searchMode === 'driver' ? 'any toll vouchers for driver' : 'a toll voucher with number'} <span className="font-mono font-bold text-red-600 bg-red-50 px-2 py-1 rounded">{selectedOrder}</span>{selectedDate ? <> on <span className="font-semibold">{format(selectedDate, 'dd/MM/yyyy')}</span></> : null}
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
                    <p className="text-sm text-orange-700">Ensure the number is correct and the Voucher Date matches — or clear the date to search across all dates. Try adding or removing suffixes like 'A' or 'B' if applicable.</p>
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

      {/* Multiple vehicles found — pick one before any voucher is shown */}
      {tollVoucherData?.data?.vehicleOptions &&
        tollVoucherData.data.vehicleOptions.length > 1 &&
        selectedVehicleIndex === null && (
          <div className="w-full">
            <Card>
              <CardHeader>
                <CardTitle className="flex items-center gap-2">
                  <Truck className="h-5 w-5" />
                  Multiple Vehicles Found
                </CardTitle>
                <CardDescription>
                  This search matched vouchers from more than one vehicle. Pick a vehicle to view its toll voucher.
                </CardDescription>
              </CardHeader>
              <CardContent>
                <div className="grid grid-cols-1 sm:grid-cols-2 md:grid-cols-3 gap-4">
                  {tollVoucherData.data.vehicleOptions.map((option, idx) => (
                    <button
                      key={option.vehicleNumber + idx}
                      type="button"
                      onClick={() => setSelectedVehicleIndex(idx)}
                      className="text-left p-4 rounded-lg border-2 border-green-200 bg-green-50 hover:border-green-500 hover:bg-green-100 transition-colors"
                    >
                      <div className="flex items-center gap-2 text-green-900 font-semibold text-base">
                        <Truck className="h-4 w-4" />
                        {option.vehicleNumber}
                      </div>
                      <div className="text-sm text-gray-600 mt-1">
                        {option.mergedVoucherCount} voucher{option.mergedVoucherCount === 1 ? '' : 's'}
                      </div>
                    </button>
                  ))}
                </div>
              </CardContent>
            </Card>
          </div>
        )}

      {/* Voucher Display - Landscape */}
      {voucher && (
        <div className="w-full">
          {/* Print Button */}
          <div className="mb-4 flex justify-end gap-2">
            {tollVoucherData?.data?.vehicleOptions && tollVoucherData.data.vehicleOptions.length > 1 && (
              <Button variant="outline" onClick={() => setSelectedVehicleIndex(null)}>
                Change Vehicle
              </Button>
            )}
            <Button onClick={handlePrint} data-testid="button-print">
              <Printer className="h-4 w-4 mr-2" />
              Print
            </Button>
          </div>

          {/* Screen Preview - Simple */}
          <div className="bg-white p-8 rounded-lg shadow-lg">
            {/* Header */}
            <div className="flex items-center justify-between mb-6 border-b-2 border-gray-300 pb-4">
              <img src={logoPath} alt="Team Finny" className="h-16" />
              <div className="text-right">
                <h1 className="text-3xl font-bold text-gray-800">TOLL VOUCHER</h1>
              </div>
            </div>

            {/* Voucher Details - Simple Layout */}
            <div className="grid grid-cols-2 gap-8 mb-8">
              <div className="space-y-4">
                <div>
                  <label className="text-sm font-semibold text-gray-600 uppercase">Voucher No.</label>
                  <p className="text-xl font-bold text-gray-900 mt-1">{voucher.orderNumber}</p>
                </div>
                <div>
                  <label className="text-sm font-semibold text-gray-600 uppercase">Driver</label>
                  <p className="text-lg font-semibold text-gray-900 mt-1">{voucher.driver || 'N/A'}</p>
                </div>
                <div>
                  <label className="text-sm font-semibold text-gray-600 uppercase">Vehicle No.</label>
                  <p className="text-lg font-semibold text-gray-900 mt-1 mb-10">{voucher.vehicle || 'N/A'}</p>
                  <label className="text-sm font-semibold text-gray-600 uppercase">
                    Voucher Date:
                  </label>
                  <p className="text-lg font-semibold text-gray-900 mt-1">{voucher.orderDate || 'N/A'}</p>
                </div>
              </div>
              <div className="space-y-4">
                <div>
                  <label className="text-sm font-semibold text-gray-600 uppercase">Order Details</label>
                  <p className="text-lg font-semibold text-gray-900 mt-1">{voucher.party || 'N/A'}</p>
                </div>
                <div className="bg-green-50 p-4 rounded-lg border-2 border-green-200">
                  <label className="text-sm font-semibold text-green-700 uppercase">Toll Tax</label>
                  <p className="text-3xl font-bold text-green-900 mt-1">₹ {voucher.tollTax.toLocaleString('en-IN')}</p>
                </div>
              </div>
            </div>

            <Separator className="my-6" />

            {/* Amount in Words */}
            <div className="bg-gray-50 p-6 rounded-lg border border-gray-300">
              <label className="text-sm font-semibold text-gray-600 uppercase">Amount in Words</label>
              <p className="text-lg font-semibold text-gray-900 mt-2">{voucher.tollTaxInWords}</p>
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

