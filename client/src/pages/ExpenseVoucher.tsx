import { useState, useEffect, useRef } from "react";
import { useQuery } from "@tanstack/react-query";
import { format } from "date-fns";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Separator } from "@/components/ui/separator";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover";
import { Calendar as DatePickerCalendar } from "@/components/ui/calendar";
import {
  Printer,
  Search,
  Package,
  Building,
  Calendar,
  CalendarIcon,
  Users,
  FileText,
  IndianRupee,
  Phone,
  Truck,
  User,
  Mail,
  MapPin,
  Edit3,
  Check,
  X,
  Receipt,
  RefreshCw,
} from "lucide-react";
import { apiRequest } from "@/lib/queryClient";
import { useToast } from "@/hooks/use-toast";
import { useSingleDateFilter } from "@/hooks/useSingleDateFilter";
import { TruckLoadingAnimation } from "@/components/TruckLoadingAnimation";
import * as QRCode from "qrcode";
import logoPath from "@assets/logo_wo_bg_1757152661130.png";
import { usePersistentFilter } from "@/hooks/usePersistentFilter";
import { PageSkeleton } from "@/components/ui/loading-skeletons";

interface ExpenseVoucherItem {
  productCode: string;
  productName: string;
  quantity: number;
}

interface VehicleOption {
  vehicleNumber: string;
  voucherInfo: Record<string, string>;
  mergedVoucherCount: number;
}

interface ExpenseVoucherData {
  orderNumber: string;
  plant: string;
  status: string;
  items: ExpenseVoucherItem[];
  voucherInfo: Record<string, string>;
  mergedVoucherCount?: number;
  vehicleOptions?: VehicleOption[];
}

interface ExpenseVoucherResponse {
  success: boolean;
  message: string;
  data: ExpenseVoucherData | null;
  itemCount: number;
}

function useAccessControl() {
  const [hasAccess, setHasAccess] = useState(false);
  const [isLoading, setIsLoading] = useState(true);

  useEffect(() => {
    const checkAccess = () => {
      try {
        const userString = localStorage.getItem("currentUser");
        if (!userString) {
          setHasAccess(false);
          setIsLoading(false);
          return;
        }

        const user = JSON.parse(userString);
        const userRole = user.role?.toLowerCase();

        const allowedRoles = [
          "admin",
          "super-admin",
          "superadmin",
          "super_admin",
        ];

        const isAdmin = allowedRoles.includes(userRole);

        // Access is controlled by admin via User Management's Allowed Pages —
        // route-level access is already enforced by ProtectedRoute before this
        // component ever renders; this just mirrors that for the page's own state.
        let allowedPages: string[] = [];
        try { allowedPages = JSON.parse(user.allowedPages || "[]"); } catch { /* default [] */ }
        const hasPageGrant = allowedPages.includes("expense-voucher");

        setHasAccess(isAdmin || hasPageGrant);
        setIsLoading(false);
      } catch (error) {
        console.error("Error checking access:", error);
        setHasAccess(false);
        setIsLoading(false);
      }
    };

    checkAccess();
  }, []);

  return { hasAccess, isLoading };
}

const getPlantColor = (plant: string) => {
  switch (plant?.toUpperCase()) {
    case "VALSAD":
      return "bg-green-500";
    case "INDORE":
      return "bg-amber-700";
    case "RAJKOT":
      return "bg-red-500";
    case "BARODA":
      return "bg-blue-500";
    case "LUCKNOW":
      return "bg-orange-500";
    default:
      return "bg-green-500";
  }
};

const countParties = (text: string) =>
  (text || "")
    .split(/[,;\n]+/)
    .map(s => s.trim())
    .filter(s => s && s.toLowerCase() !== "n/a").length;

const fontSizeForPartyCount = (count: number) => {
  if (count <= 10) return 16;
  if (count <= 15) return 14;
  if (count <= 20) return 12;
  return 10;
};

// Diesel litres formatted to 2 decimal places; passes through non-numeric
// values (e.g. "N/A") unchanged.
const formatDieselLtr = (value?: string) => {
  if (value === undefined || value === null || value === "") return "N/A";
  const n = parseFloat(String(value).replace(/[^0-9.-]/g, ""));
  if (isNaN(n)) return value;
  return n.toFixed(2);
};

const getPartyTextFromVoucherInfo = (info?: Record<string, string>) => {
  if (!info) return "";
  const entry = Object.entries(info).find(([k]) => /party/i.test(k));
  return entry?.[1] || "";
};

export default function ExpenseVoucher() {
  const [selectedPlant, setSelectedPlant] = usePersistentFilter("expenseVoucher:plant", "valsad");
  // const [voucherPrefix, setVoucherPrefix] = useState("KM2526-EV-");
  const [voucherNumber, setVoucherNumber] = useState("");
  const [selectedOrder, setSelectedOrder] = useState("");
  // Whether the current search term is a voucher number or a driver name
  const [searchMode, setSearchMode] = usePersistentFilter<"voucher" | "driver">("expenseVoucher:searchMode", "voucher");
  const [searchProgress, setSearchProgress] = useState(0);
  const [searchStage, setSearchStage] = useState("");
  // null = not chosen yet; when a search returns multiple vehicles, the
  // voucher details stay hidden behind a "pick a vehicle" prompt until set.
  const [selectedVehicleIndex, setSelectedVehicleIndex] = useState<number | null>(0);
  const [editableInvoiceAmount, setEditableInvoiceAmount] = useState("");
  const [isEditingAmount, setIsEditingAmount] = useState(false);
  const [editableVehicleDriver, setEditableVehicleDriver] = useState("");
  const [isEditingVehicleDriver, setIsEditingVehicleDriver] = useState(false);
  const [editableFinalPayment, setEditableFinalPayment] = useState("");
  const [isEditingFinalPayment, setIsEditingFinalPayment] = useState(false);
  const [editableConveyanceAllowance, setEditableConveyanceAllowance] =
    useState("");
  const [isEditingConveyanceAllowance, setIsEditingConveyanceAllowance] =
    useState(false);
  const { toast } = useToast();
  const { hasAccess, isLoading: accessLoading } = useAccessControl();
  const [voucherPrefix, setVoucherPrefix] = useState<string>("KM2526-EV-");
  const [isAdminUser, setIsAdminUser] = useState(false);

  // Date filter: which day's vouchers to search. Defaults to today and
  // persists across page refreshes (per-page localStorage key).
  const [todayMidnight] = useState(() => {
    const d = new Date();
    d.setHours(0, 0, 0, 0);
    return d;
  });
  const { savedDate: selectedDate, saveDateFilter: setSelectedDate } =
    useSingleDateFilter("expense-voucher", todayMidnight);
  const [isDatePickerOpen, setIsDatePickerOpen] = useState(false);
  // Date is optional. When no date is selected the search spans ALL dates
  // (the server drops its date filter for an empty voucherDate). The calendar
  // still opens on today when nothing is picked.
  const calendarMonth = selectedDate || todayMidnight;
  const selectedDateStr = selectedDate ? format(selectedDate, "yyyy-MM-dd") : "";

  // Driver-name autocomplete for the search bar.
  const [driverSuggestions, setDriverSuggestions] = useState<string[]>([]);
  const [showSuggestions, setShowSuggestions] = useState(false);

  useEffect(() => {
    const term = voucherNumber.trim();
    // Only worth suggesting once there's a letter to match against (a purely
    // numeric term is a voucher number, not a driver name).
    if (term.length < 2 || !/[a-zA-Z]/.test(term)) {
      setDriverSuggestions([]);
      return;
    }

    let cancelled = false;
    const timer = setTimeout(async () => {
      try {
        const res = await apiRequest(
          "GET",
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

  // Fetch global prefixes from server
  useEffect(() => {
    (async () => {
      try {
        const res = await apiRequest("GET", "/api/voucher-prefixes", undefined, false, true);
        if (res && res.data && res.data.expense) {
          setVoucherPrefix(res.data.expense);
        }
      } catch (e) {
        // keep default
        console.error("Failed to fetch voucher prefixes:", e);
      }
    })();

    // determine admin role from localStorage user cache
    try {
      const userString = localStorage.getItem("currentUser");
      if (userString) {
        const user = JSON.parse(userString);
        const role = (user?.role || "").toString().toLowerCase();
        setIsAdminUser(["admin", "super-admin", "superadmin", "super_admin"].includes(role));
      }
    } catch (e) {
      // ignore
    }
    // Listen for prefix updates from other tabs/windows
    const storageHandler = async (e: StorageEvent) => {
      if (e.key === 'voucher_prefixes_updated') {
        try {
          const res = await apiRequest("GET", "/api/voucher-prefixes", undefined, false, true);
          if (res && res.data && res.data.expense) {
            setVoucherPrefix(res.data.expense);
          }
        } catch (err) {
          // ignore
        }
      }
    };

    window.addEventListener('storage', storageHandler);

    // Poll every 30 seconds for changes from other devices/browsers
    const pollInterval = setInterval(async () => {
      try {
        const res = await apiRequest("GET", "/api/voucher-prefixes", undefined, false, true);
        if (res && res.data && res.data.expense) {
          setVoucherPrefix(res.data.expense);
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

  const {
    data: expenseVoucherData,
    isLoading: expenseVoucherLoading,
    isFetching,
    error,
    refetch,
    isError,
  } = useQuery<ExpenseVoucherResponse>({
    queryKey: ["/api/expense-voucher", searchMode, selectedOrder, selectedDateStr],
    enabled: !!selectedOrder && hasAccess,
    queryFn: async () => {
      if (!selectedOrder) throw new Error("No order selected");
      try {
        const body =
          searchMode === "driver"
            ? { driverName: selectedOrder, voucherDate: selectedDateStr }
            : { orderNumber: selectedOrder, voucherDate: selectedDateStr };
        const response = await apiRequest(
          "POST",
          "/api/expense-voucher",
          body,
          false,
          true
        );
        if (response && typeof response === "object") {
          return response as ExpenseVoucherResponse;
        }
        throw new Error("Invalid response format");
      } catch (error: any) {
        setSearchProgress(0);
        setSearchStage("");
        console.error("❌ Frontend: API error:", error);
        throw new Error(
          error?.message || "Failed to fetch expense voucher data"
        );
      }
    },
  });

  // A search can turn up multiple vehicles (e.g. same driver, different
  // trucks). Whenever a fresh search result comes in, hide the voucher
  // details behind a "pick a vehicle" prompt if there's more than one;
  // otherwise there's nothing to choose, so go straight to the details.
  useEffect(() => {
    const options = expenseVoucherData?.data?.vehicleOptions;
    setSelectedVehicleIndex(options && options.length > 1 ? null : 0);
  }, [expenseVoucherData]);

  const handleVehicleOptionChange = (index: number) => {
    const option = expenseVoucherData?.data?.vehicleOptions?.[index];
    if (!expenseVoucherData?.data || !option) return;
    expenseVoucherData.data.voucherInfo = option.voucherInfo;
    expenseVoucherData.data.mergedVoucherCount = option.mergedVoucherCount;
    setSelectedVehicleIndex(index);
  };

  useEffect(() => {
    if (expenseVoucherLoading || isFetching) {
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
  }, [expenseVoucherLoading, isFetching]);

  useEffect(() => {
    if (expenseVoucherData?.data?.voucherInfo) {
      const amountVal = expenseVoucherData.data.voucherInfo["Amount >"];
      if (amountVal !== undefined && amountVal !== null) {
        const amount = amountVal.toString().replace(/[^\d.-]/g, "");
        setEditableInvoiceAmount(amount);
      } else {
        setEditableInvoiceAmount("");
      }
    }
  }, [expenseVoucherData]);

  useEffect(() => {
    if (expenseVoucherData?.data?.voucherInfo) {
      const vehicleDriver =
        expenseVoucherData.data.voucherInfo["Vehi x Dri :"] || "N/A";
      setEditableVehicleDriver(vehicleDriver);
    }
  }, [expenseVoucherData]);

  useEffect(() => {
    if (expenseVoucherData?.data?.voucherInfo) {
      const paymentVal = expenseVoucherData.data.voucherInfo["ECS Payment :"];
      if (paymentVal !== undefined && paymentVal !== null) {
        const payment = paymentVal.toString().replace(/[^\d.-]/g, "");
        setEditableFinalPayment(payment);
      } else {
        setEditableFinalPayment("");
      }
    }
  }, [expenseVoucherData]);

  useEffect(() => {
    if (expenseVoucherData?.data?.voucherInfo) {
      const allowanceVal =
        expenseVoucherData.data.voucherInfo["Conveyance Allowance:"];
      if (allowanceVal !== undefined && allowanceVal !== null) {
        const allowance = allowanceVal.toString().replace(/[^\d.-]/g, "");
        setEditableConveyanceAllowance(allowance);
      } else {
        setEditableConveyanceAllowance("");
      }
    }
  }, [expenseVoucherData]);

  const handleSaveInvoiceAmount = () => {
    if (editableInvoiceAmount.trim() && expenseVoucherData?.data) {
      expenseVoucherData.data.voucherInfo["Amount >"] = editableInvoiceAmount;
      setIsEditingAmount(false);
      toast({
        title: "Invoice Amount Updated",
        description: `Amount updated to ₹${new Intl.NumberFormat(
          "en-IN"
        ).format(parseFloat(editableInvoiceAmount) || 0)}`,
      });
    }
  };

  const handleCancelEdit = () => {
    if (expenseVoucherData?.data?.voucherInfo?.["Amount >"]) {
      const amount = expenseVoucherData.data.voucherInfo["Amount >"]
        .toString()
        .replace(/[^\d.-]/g, "");
      setEditableInvoiceAmount(amount);
    }
    setIsEditingAmount(false);
  };

  const handleSaveVehicleDriver = () => {
    if (editableVehicleDriver.trim() && expenseVoucherData?.data) {
      expenseVoucherData.data.voucherInfo["Vehi x Dri :"] =
        editableVehicleDriver;
      setIsEditingVehicleDriver(false);
      toast({
        title: "Vehicle & Driver Updated",
        description: `Updated to ${editableVehicleDriver}`,
      });
    }
  };

  const handleCancelVehicleDriverEdit = () => {
    if (expenseVoucherData?.data?.voucherInfo) {
      const vehicleDriver =
        expenseVoucherData.data.voucherInfo["Vehi x Dri :"] || "N/A";
      setEditableVehicleDriver(vehicleDriver);
    }
    setIsEditingVehicleDriver(false);
  };

  const handleSaveFinalPayment = () => {
    if (editableFinalPayment.trim() && expenseVoucherData?.data) {
      expenseVoucherData.data.voucherInfo["ECS Payment :"] =
        editableFinalPayment;
      setIsEditingFinalPayment(false);
      toast({
        title: "Final Payment Updated",
        description: `Amount updated to ₹${new Intl.NumberFormat(
          "en-IN"
        ).format(parseFloat(editableFinalPayment) || 0)}`,
      });
    }
  };

  const handleCancelFinalPaymentEdit = () => {
    if (expenseVoucherData?.data?.voucherInfo?.["ECS Payment :"]) {
      const payment = expenseVoucherData.data.voucherInfo["ECS Payment :"]
        .toString()
        .replace(/[^\d.-]/g, "");
      setEditableFinalPayment(payment);
    }
    setIsEditingFinalPayment(false);
  };

  const handleSaveConveyanceAllowance = () => {
    if (editableConveyanceAllowance.trim() && expenseVoucherData?.data) {
      if (expenseVoucherData.data.voucherInfo["Conveyance Allowance:"]) {
        expenseVoucherData.data.voucherInfo["Conveyance Allowance:"] =
          editableConveyanceAllowance;
      } else {
        expenseVoucherData.data.voucherInfo["Conveyance :"] =
          editableConveyanceAllowance;
      }
      setIsEditingConveyanceAllowance(false);
      toast({
        title: "Conveyance Allowance Updated",
        description: `Amount updated to ₹${new Intl.NumberFormat(
          "en-IN"
        ).format(parseFloat(editableConveyanceAllowance) || 0)}`,
      });
    }
  };

  const handleCancelConveyanceAllowanceEdit = () => {
    if (expenseVoucherData?.data?.voucherInfo?.["Conveyance Allowance:"]) {
      const allowance = expenseVoucherData.data.voucherInfo["Conveyance Allowance:"]
        .toString()
        .replace(/[^\d.-]/g, "");
      setEditableConveyanceAllowance(allowance);
    }
    setIsEditingConveyanceAllowance(false);
  };

  const handleSearch = async (termOverride?: string) => {
    const term = (termOverride ?? voucherNumber).trim();
    if (!term) {
      toast({
        title: "Search Term Required",
        description: "Please enter a voucher number or driver name to search",
        variant: "destructive",
      });
      return;
    }

    // Auto-detect: a term containing letters is treated as a driver name,
    // UNLESS it starts with a digit -- voucher numbers always start with a
    // digit (and some carry a trailing letter suffix, e.g. "102547A" /
    // "102547B" for split vouchers), while driver names never do. Without
    // this guard, "102547A" was misread as a driver search (found nothing),
    // while the unsuffixed "102547" matched *both* 102547A and 102547B via
    // a `contains` filter and silently returned whichever came back first.
    //
    // A complete voucher number typed or pasted whole ("KM2627-AEV-RV2609") starts with a letter
    // too, so it needs its own check ahead of the driver rule: letters+digits, then one or more
    // hyphenated parts. Driver names never contain a digit, so this can't swallow one. It is sent
    // as-is — the prefix box must NOT be prepended to a number that already carries its own.
    const isFullVoucherNumber = /^[a-zA-Z]+\d+(-[a-zA-Z0-9]+)+$/.test(term);
    const isDriverSearch = !isFullVoucherNumber && /[a-zA-Z]/.test(term) && !/^\d/.test(term);

    if (isDriverSearch) {
      // Driver name is searched as-is; the server merges ALL of that driver's
      // vouchers into one and returns the same shape as a voucher search.
      setSearchProgress(0);
      if (searchMode === "driver" && selectedOrder === term) {
        setSearchStage("Refreshing...");
        refetch();
      } else {
        setSearchMode("driver");
        setSelectedOrder(term);
      }
      return;
    }

    // Voucher-number search
    const fullVoucherNumber = isFullVoucherNumber ? term.toUpperCase() : `${voucherPrefix}${term}`;
    setSearchProgress(0);
    if (searchMode === "voucher" && fullVoucherNumber === selectedOrder) {
      setSearchStage("Refreshing...");
      refetch();
    } else {
      setSearchMode("voucher");
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
        variant: "destructive",
      });
    }
  };

  const handlePrint = async () => {
    if (!expenseVoucherData?.data) {
      toast({
        title: "No Data",
        description: "No expense voucher data to print",
        variant: "destructive",
      });
      return;
    }

    const data = expenseVoucherData.data;
    const voucherInfo = data.voucherInfo || {};
    const partyText = getPartyTextFromVoucherInfo(voucherInfo);

    const partyCount = countParties(partyText);

    // Size the party font so the list fits the fixed cell (~47mm) WITHOUT
    // overflowing or leaving extra empty space, keeping the voucher layout
    // intact. Scale by BOTH the number of party lines (vertical fit) and the
    // total text length (horizontal wrap), and take the smaller of the two.
    const partyRaw = voucherInfo["For Party x Ord Date"] || "";
    const partyTextLength = partyRaw.length;
    const partyLineCount = partyRaw
      .split(/\r?\n/)
      .filter((l) => l.trim()).length;

    const fontByLines =
      partyLineCount <= 8 ? 13
      : partyLineCount <= 11 ? 11
      : partyLineCount <= 14 ? 10
      : partyLineCount <= 17 ? 9
      : partyLineCount <= 20 ? 8
      : partyLineCount <= 24 ? 7
      : 6;

    const fontByLength =
      partyTextLength > 900 ? 6
      : partyTextLength > 750 ? 7
      : partyTextLength > 600 ? 8
      : partyTextLength > 450 ? 9
      : partyTextLength > 320 ? 10
      : partyTextLength > 200 ? 11
      : 13;

    let partyFontPt = Math.min(fontByLines, fontByLength);

    // Voucher No. cell font sized by length so every number fits (the print
    // runs in a hidden iframe, so runtime measurement can't be used here).
    const voucherNoLength = (voucherInfo["Voucher No. :"] || "").length;
    let voucherNoFontPt = 15; // default (single voucher)
    if (voucherNoLength > 110) voucherNoFontPt = 5;
    else if (voucherNoLength > 90) voucherNoFontPt = 6;
    else if (voucherNoLength > 72) voucherNoFontPt = 7;
    else if (voucherNoLength > 55) voucherNoFontPt = 8;
    else if (voucherNoLength > 42) voucherNoFontPt = 9.5;
    else if (voucherNoLength > 30) voucherNoFontPt = 11;
    else if (voucherNoLength > 20) voucherNoFontPt = 13;

    // Remark can hold several merged vouchers' remarks -> shrink to fit its row.
    const remarkLength = (voucherInfo["Remark :"] || "").length;
    let remarkFontPt = 7.5;
    if (remarkLength > 220) remarkFontPt = 4.5;
    else if (remarkLength > 160) remarkFontPt = 5;
    else if (remarkLength > 110) remarkFontPt = 6;
    else if (remarkLength > 70) remarkFontPt = 6.8;

    const voucherDate =
      voucherInfo["Voucher Date :"] ||
      new Date().toLocaleDateString("en-GB", {
        day: "2-digit",
        month: "2-digit",
        year: "2-digit",
      });

    const formattedDate = (() => {
      if (voucherDate && voucherDate !== "N/A") {
        if (typeof voucherDate === "string" && voucherDate.includes("/")) {
          return voucherDate;
        }
        try {
          const date = new Date(voucherDate);
          if (!isNaN(date.getTime())) {
            return date.toLocaleDateString("en-GB", {
              day: "2-digit",
              month: "2-digit",
              year: "2-digit",
            });
          }
        } catch (e) {
          return voucherDate;
        }
      }
      return new Date().toLocaleDateString("en-GB", {
        day: "2-digit",
        month: "2-digit",
        year: "2-digit",
      });
    })();

    let logoDataUrl = "";
    try {
      const response = await fetch(logoPath);
      if (!response.ok) throw new Error(`Failed`);
      const blob = await response.blob();
      logoDataUrl = (await new Promise((resolve) => {
        const reader = new FileReader();
        reader.onload = () => resolve(reader.result as string);
        reader.readAsDataURL(blob);
      })) as string;
    } catch (error) {
      logoDataUrl = logoPath;
    }

    const printContent = `
      <!DOCTYPE html>
      <html>
        <head>
          <title>Expense Voucher - ${voucherInfo["Voucher No. :"] || "N/A"}</title>
          <meta name="viewport" content="width=device-width,initial-scale=1" />
          <style>
            @page {
              size: 110mm 220mm;
              margin: 4mm;
              padding :auto;
            }
            html, body {
              height: 100%;
              margin: 0;
              padding: 0;
              -webkit-print-color-adjust: exact;
              print-color-adjust: exact;
              box-sizing: border-box;
            }
            * { box-sizing: border-box; }

            .voucher-container {
              width: 97mm;
              height: 212mm;
              padding: 0;
              margin-left : 2mm;
              margin-right : 2mm;
              border: 0.5px solid #000;
              background: white;
              overflow: hidden;
              page-break-inside: avoid;
              display: block;
            }

            table {
              width: 100%;
              height: 100%;
              border-collapse: collapse;
              table-layout: fixed;
            }

            td {
              border-top: 0.5px solid #000;
              border-bottom: 0.5px solid #000;
              border-left: 0.5px solid #000;
              border-right: 0.5px solid #000;
              padding: 2px 4px;
              vertical-align: middle;
              word-wrap: break-word;
              overflow: hidden;
            }

            .no-border { border: none; }

            .logo-cell {
              background: ${selectedPlant === "indore"
                ? "linear-gradient(135deg, #693c11ff 0%, #c58e61ff 100%)"
                : "linear-gradient(135deg, #ea580c 0%, #c2410c 100%)"
              } !important;
              width: 50%;
              text-align: center;
              padding: 4px;
              height: 15mm;
            }
            .logo-img { max-width: 100%; max-height: 40mm; object-fit: contain; }

            .expense-voucher-cell {
              background: #001d6e !important;
              color: white !important;
              font-weight: bold;
              font-size: 15pt;
              text-align: center;
              width: 18%; 
              writing-mode: vertical-rl;  
              text-orientation: mixed;
              transform: rotate(180deg);
              height: 15mm;
            }

            .date-voucher-cell { padding: 1px; width: 60%; height: 15mm; }

            .label-text { font-weight: 800; font-size: 13pt; color: #374151; }
            .value-text { font-size: 18pt; font-weight: 800; }
            .voucher-number { color: #dc2626 !important; font-size: ${voucherNoFontPt}pt; font-weight: 900; white-space: normal; word-break: break-word; overflow: hidden; line-height: 1.12; }

            .driver-vehicle-row { background: #bfdbfe !important; font-size: 11pt; padding: 3px 6px; height: 7mm; }
            .order-details-header { background: #4f2f88ff !important; color: white !important; font-weight: 800; font-size: 12pt; text-align: center; padding: 2px; height: 9mm; }
            .order-date-header, .party-name-header { padding: 3px; font-weight: 700; font-size: 12pt; height: 9mm;text-align: center; }
            .party-details-cell {
              font-size: ${partyFontPt}pt !important;
              line-height: 1.15;
              height: 47mm;
              overflow: hidden;
              position: relative;
              vertical-align: top;
            }


            .diesel-header { background: #fbbf24 !important; font-weight: 800; text-align: center; padding: 3px; font-size: 9pt; height: 6mm; }
            .route-kms-header, .avg-header { text-align: center; padding: 3px; font-weight: 800; font-size: 9pt; height: 6mm; }

            .diesel-bills { background: #fef3c7 !important; font-weight: 800; text-align: center; padding: 3px; font-size: 8pt; height: 7mm; word-break: break-word; overflow: hidden; line-height: 1.1; }
            .route-value, .avg-value { text-align: center; padding: 3px; font-weight: 700, font-size: 11pt; height: 7mm; }
            .diesel-amount { background: #fbbf24 !important; font-weight: 800; text-align: center; padding: 4px; font-size: 13pt; height: 8mm; }

            .expenses-header { background:#ddd9c3 !important; font-weight: 800; text-align: center; padding: 3px; font-size: 11pt; height: 6mm; }
            .amount-header { background:#ddd9c3 !important; font-weight: 800; text-align: center; padding: 3px; font-size: 11pt; height: 6mm; }

            .expense-row { height: 7mm; }
            .expense-row td { padding: 3px 5px; font-size: 11pt; }
            .expense-label { color: #dc2626 !important; font-weight: 800; margin-right: 2px; font-size: 7pt; }
            .expense-amount { text-align: right; font-weight: 800; font-size: 11pt; }

            .final-payment-row {  !important; color: white !important; font-weight: 900; height: 9mm; }
            .final-payment-label { background: #5f5fe5ff !important; text-align: center; padding: 4px; font-size: 12pt; }
            .final-payment-amount { color: black !important; text-align: center; font-size: 12pt; padding: 2px; }

            .remark-row { height: auto; min-height: 7mm; max-height: 7mm; }
            .remark-row td { padding: 3px 5px; font-weight: bold; color: #dc2626; background-color: #fff1f2; text-align: left; font-size: 7.5pt; overflow: hidden; }

            .signature-cell { padding: 7px; text-align: center; border-bottom: 1.54px solid #000; border : 1 px solid #000; height: 15mm; }
            .signature-text { color: #9ca3af !important; font-size: 9pt; letter-spacing: 1.2px; }

            @media print {
              html, body { height: 100%; margin: 0; padding: 0; }
              .voucher-container { padding: 0; border-width: 1.5px; page-break-inside: avoid; }
              table { height: 100%; page-break-inside: avoid; }
              td { page-break-inside: avoid; break-inside: avoid; }
            }
          </style>
        </head>
        <body>
          <div class="voucher-container" id="voucher">
            <table>
              <tr>
                <td class="logo-cell" rowspan="2">
                  ${logoDataUrl ? `<img src="${logoDataUrl}" alt="Company Logo" class="logo-img" />` : ""}
                </td>
                <td class="expense-voucher-cell" rowspan="2">EXPENSE<br/>VOUCHER</td>
                <td class="date-voucher-cell" colspan="2" rowspan="2">
                  <table style="width:100%; height:100%; border-collapse:collapse;">
                    <tr>
                      <td class="no-border" style="border-bottom: 1px solid #000; padding:4px;">
                        <div class="label-text">Date :</div>
                        <div class="value-text">${formattedDate}</div>
                      </td>
                    </tr>
                    <tr>
                      <td class="no-border" style="padding:3px;">
                        <div class="label-text">Vouc. No :</div>
                        <div class="voucher-number" id="voucher-number">${voucherInfo["Voucher No. :"] || "N/A"}</div>
                      </td>
                    </tr>
                  </table>
                </td>
              </tr>
              <tr></tr>

              <tr>
                <td colspan="4" class="driver-vehicle-row" style="font-weight: bold; text-align: left; padding-left: 6px;">
                  <span style="font-weight: bold; color: #1e40af; margin-right: 6px;">Driver :</span>
                  ${voucherInfo["Link to Driver :"] || "N/A"}
                </td>
              </tr>

              <tr>
                <td colspan="4" class="driver-vehicle-row" style="font-weight: bold; text-align: left; padding-left: 6px;">
                  <span style="font-weight: bold; color: #1e40af; margin-right: 6px;">Vehicle :</span>
                  ${voucherInfo["For Vehicle "] || "N/A"}
                </td>
              </tr>

              <tr>
                <td colspan="4" class="order-details-header" >ORDER DETAILS</td>
              </tr>

              <tr>
                <td colspan="2" class="order-date-header" style="background-color: #ddd9c3">Order Date :</td>
                <td colspan="2" class="party-name-header" style="background-color: #1f5724 ;color: white;">Party Name :</td>
              </tr>

              <tr>
                <td colspan="4" class="party-details-cell" id="party-details">
                  ${(() => {
                    const partyOrderDate = voucherInfo["For Party x Ord Date"] || "N/A";
                    if (partyOrderDate && partyOrderDate !== "N/A") {
                      const lines = partyOrderDate
                        .split(/\s*[\n\r]+\s*/)
                        .filter((line) => line.trim());
                      return lines.map((line) => line.trim()).join(",<br/>");
                    }
                    return "N/A";
                  })()}
                </td>
              </tr>

              <tr>
                <td colspan="2" class="diesel-header">Diesel Bill Details :</td>
                <td class="route-kms-header">Route<br/>KM's</td>
                <td class="avg-header">Avg .</td>
              </tr>

              <tr>
                <td colspan="2" class="diesel-bills" id="diesel-bills">${voucherInfo["For Diesel Bill No. :"] || "N/A"
                  }</td>
                <td class="route-value">${voucherInfo["KM's SUM"] || "0"}</td>
                <td class="avg-value">${(() => {
                    const avg = voucherInfo["Average :"];
                    if (avg && avg !== "N/A" && !isNaN(parseFloat(avg))) {
                      return parseFloat(avg).toFixed(2);
                    }
                    return "0.00";
                  })()}</td>
              </tr>

              <tr>
                <td colspan="4" class="diesel-amount">${formatDieselLtr(voucherInfo["Diesel {Ltr's} :"])}</td>
              </tr>

              <tr>
                <td colspan="3" class="expenses-header">Expenses Description</td>
                <td class="amount-header">Amount</td>
              </tr>

              <tr class="expense-row">
                <td colspan="3"><span class="expense-label">{A}</span> Toll Tax</td>
                <td class="expense-amount">₹${(() => {
                    const amount = voucherInfo["Toll Tax :"] || "0.00";
                    if (amount && amount !== "N/A" && !isNaN(parseFloat(amount))) {
                      return new Intl.NumberFormat("en-IN", {
                        minimumFractionDigits: 2,
                        maximumFractionDigits: 2,
                      }).format(parseFloat(amount));
                    }
                    return "0.00";
                  })()}</td>
              </tr>

              <tr class="expense-row">
                <td colspan="3"><span class="expense-label">{B}</span> On Road Work</td>
                <td class="expense-amount">₹${(() => {
                    const amount = voucherInfo["OnRoad Work :"] || "0.00";
                    if (amount && amount !== "N/A" && !isNaN(parseFloat(amount))) {
                      return new Intl.NumberFormat("en-IN", {
                        minimumFractionDigits: 2,
                        maximumFractionDigits: 2,
                      }).format(parseFloat(amount));
                    }
                    return "0.00";
                  })()}</td>
              </tr>

              <tr class="expense-row">
                <td colspan="3"><span class="expense-label">{C}</span> Conveyance Allowance</td>
                <td class="expense-amount">₹${(() => {
                    // Print always reflects the live merged voucher data, not
                    // the "editable" state (which mirrors the last-loaded
                    // voucher and can be stale by the time Print is clicked).
                    const amount = voucherInfo["Conveyance Allowance:"] || "0.00";
                    if (amount && amount !== "N/A" && !isNaN(parseFloat(amount))) {
                      return new Intl.NumberFormat("en-IN", {
                        minimumFractionDigits: 2,
                        maximumFractionDigits: 2,
                      }).format(parseFloat(amount));
                    }
                    return "0.00";
                  })()}</td>
              </tr>

              <tr class="expense-row">
                <td colspan="3"><span class="expense-label">{D}</span> Deduction</td>
                <td class="expense-amount">₹${(() => {
                    const amount = voucherInfo["Deduction :"] || "0.00";
                    if (amount && amount !== "N/A" && !isNaN(parseFloat(amount))) {
                      return new Intl.NumberFormat("en-IN", {
                        minimumFractionDigits: 2,
                        maximumFractionDigits: 2,
                      }).format(parseFloat(amount));
                    }
                    return "0.00";
                  })()}</td>
              </tr>

              <tr class="final-payment-row">
                <td colspan="3" class="final-payment-label" style="color: black">Final Payment :</td>
                <td class="final-payment-amount">₹${(() => {
                    // Same reasoning as Conveyance Allowance above: read the
                    // live merged value, not the possibly-stale editable state.
                    const amount = voucherInfo["ECS Payment :"] || "0.00";
                    if (amount && amount !== "N/A" && !isNaN(parseFloat(amount))) {
                      return new Intl.NumberFormat("en-IN", {
                        minimumFractionDigits: 2,
                        maximumFractionDigits: 2,
                      }).format(parseFloat(amount));
                    }
                    return "0.00";
                  })()}</td>
              </tr>

              ${(() => {
                    const remark = voucherInfo["Remark :"];
                    if (remark && remark !== "N/A" && remark.trim() !== "") {
                      return `
                    <tr class="remark-row">
                      <td colspan="4" style="font-size: ${remarkFontPt}pt; line-height: 1.1;">
                        <span style="font-weight: bold; color: #7c3aed;">Remark:</span> ${remark}
                      </td>
                    </tr>
                  `;
                    }
                    return "";
                  })()}

              <tr style="border-bottom: none">
                <td colspan="4" class="signature-cell" ">
                  <div class="signature-text">SIGN HERE</div>
                </td>
              </tr>
            </table>
          </div>

          <script>
            (function adjustPartyDetails() {
              try {
                const partyDetailsCell = document.getElementById('party-details');
                if (!partyDetailsCell) return;

                function checkAndAdjustFontSize() {
                  const maxHeight = partyDetailsCell.offsetHeight;
                  let currentFontSize = 8;
                  const minFontSize = 4;

                  partyDetailsCell.style.fontSize = currentFontSize + 'pt';
                  partyDetailsCell.style.lineHeight = '1.15';

                  while (partyDetailsCell.scrollHeight > maxHeight && currentFontSize > minFontSize) {
                    currentFontSize -= 0.25;
                    partyDetailsCell.style.fontSize = currentFontSize + 'pt';
                  }

                  if (partyDetailsCell.scrollHeight > maxHeight) {
                    partyDetailsCell.style.lineHeight = '1.05';
                  }

                  if (partyDetailsCell.scrollHeight > maxHeight && currentFontSize > minFontSize) {
                    while (partyDetailsCell.scrollHeight > maxHeight && currentFontSize > minFontSize) {
                      currentFontSize -= 0.25;
                      partyDetailsCell.style.fontSize = currentFontSize + 'pt';
                    }
                  }
                }

                setTimeout(checkAndAdjustFontSize, 100);
                setTimeout(checkAndAdjustFontSize, 300);
                setTimeout(checkAndAdjustFontSize, 600);
              } catch (e) {
                console.error('adjustPartyDetails error:', e);
              }
            })();

            // Shrink cells that grow when multiple vouchers are merged (the
            // voucher-number list and the diesel-bill list) so the fixed voucher
            // layout is preserved instead of overflowing/clipping.
            (function adjustMergedCells() {
              try {
                function fit(id, startPt, minPt) {
                  var el = document.getElementById(id);
                  if (!el) return;
                  var maxHeight = el.offsetHeight;
                  var size = startPt;
                  el.style.fontSize = size + 'pt';
                  var guard = 0;
                  while (el.scrollHeight > maxHeight && size > minPt && guard < 200) {
                    size -= 0.25;
                    guard++;
                    el.style.fontSize = size + 'pt';
                  }
                }
                function run() {
                  // voucher-number is sized by length via inline CSS (works in
                  // the hidden print iframe); only measure-fit the diesel cell.
                  fit('diesel-bills', 8, 4);
                }
                setTimeout(run, 120);
                setTimeout(run, 320);
                setTimeout(run, 620);
              } catch (e) {
                console.error('adjustMergedCells error:', e);
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

      const iframeDoc =
        iframe.contentDocument || iframe.contentWindow?.document;
      if (!iframeDoc) {
        throw new Error("Could not access iframe document");
      }

      iframeDoc.open();
      iframeDoc.write(printContent);
      iframeDoc.close();

      let fallbackTimerId: NodeJS.Timeout;

      iframe.onload = () => {
        if (fallbackTimerId) clearTimeout(fallbackTimerId);
        setTimeout(() => {
          try {
            iframe.contentWindow?.focus();
            if (iframe.contentWindow) {
              let printExecuted = false;
              iframe.contentWindow.addEventListener("beforeprint", () => {
                printExecuted = true;
              });
              iframe.contentWindow.addEventListener("afterprint", () => {
                setTimeout(() => {
                  if (document.body.contains(iframe)) {
                    document.body.removeChild(iframe);
                  }
                }, 100);
              });
            }
            iframe.contentWindow?.print();
            setTimeout(() => {
              if (document.body.contains(iframe)) {
                document.body.removeChild(iframe);
              }
            }, 3000);
          } catch (printError) {
            console.error("Print error:", printError);
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

      fallbackTimerId = setTimeout(() => {
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
          console.error("Fallback print error:", fallbackError);
          if (document.body.contains(iframe)) {
            document.body.removeChild(iframe);
          }
        }
      }, 2000);
    } catch (error) {
      console.error("Failed to create print iframe:", error);
      toast({
        title: "Print Error",
        description: "Failed to open print dialog. Please try again.",
        variant: "destructive",
      });
    }
  };

  if (accessLoading) {
    return (
      <PageSkeleton />
    );
  }

  if (!hasAccess) {
    return (
      <div className="flex items-center justify-center min-h-screen">
        <Card className="w-full max-w-md">
          <CardHeader className="text-center">
            <CardTitle className="text-red-600">Access Denied</CardTitle>
            <CardDescription>
              This page is restricted to administrators and users granted access
              via User Management.
            </CardDescription>
          </CardHeader>
          <CardContent className="text-center">
            <div className="flex justify-center mb-4">
              <div className="bg-red-100 p-3 rounded-full">
                <Receipt className="h-8 w-8 text-red-600" />
              </div>
            </div>
            <p className="text-sm text-gray-600">
              Please contact your administrator if you believe you should have
              access to this page.
            </p>
          </CardContent>
        </Card>
      </div>
    );
  }

  return (
    <div className="w-full p-6">
      <div className="flex items-center justify-between mb-6">
        <div className="flex items-center gap-2">
          <Receipt
            className="h-6 w-6 text-[#001d6e]"
            style={{ fill: "#ea580c" }}
          />
          <h1 className="text-3xl font-bold text-[#001d6e]">Expense Voucher</h1>
        </div>
        <div className="flex gap-3">
          <Button
            onClick={() => setSelectedPlant("valsad")}
            variant={selectedPlant === "valsad" ? "default" : "outline"}
            className={`flex items-center gap-2 ${selectedPlant === "valsad"
              ? "bg-orange-500 hover:bg-orange-600"
              : "border-orange-500 text-orange-600 hover:bg-orange-50"
              }`}
          >
            <div className="w-3 h-3 rounded-full bg-orange-500"></div>
            Valsad
          </Button>
          <Button
            onClick={() => setSelectedPlant("indore")}
            variant={selectedPlant === "indore" ? "default" : "outline"}
            className={`flex items-center gap-2 ${selectedPlant === "indore"
              ? "bg-amber-700 hover:bg-amber-800"
              : "border-amber-700 text-amber-700 hover:bg-amber-50"
              }`}
          >
            <div className="w-3 h-3 rounded-full bg-amber-700"></div>
            Indore
          </Button>
        </div>
      </div>

      <Card className="mb-6">
        <CardHeader>
          <CardDescription>
            Enter a voucher number, or a driver name to list all of that
            driver's vouchers. Data is fetched live from Notion.
          </CardDescription>
        </CardHeader>
        <CardContent>
          <div className="flex flex-col sm:flex-row sm:items-center gap-2 mb-4">
            <span className="text-sm font-medium text-gray-600 whitespace-nowrap">
              Voucher Date:
            </span>
            <Popover open={isDatePickerOpen} onOpenChange={setIsDatePickerOpen}>
              <PopoverTrigger asChild>
                <Button
                  variant="outline"
                  className="w-full sm:w-[220px] justify-start text-left font-normal"
                >
                  <CalendarIcon className="mr-2 h-4 w-4" />
                  {selectedDate ? format(selectedDate, "dd/MM/yyyy") : "All dates"}
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
                  onKeyDown={(e) => e.key === "Enter" && handleSearch()}
                  className="rounded-r-none text-sm font-mono bg-gray-50 w-32 border-r-0 focus-visible:ring-2 focus-visible:ring-blue-500"
                  placeholder="Prefix"
                  // Prefixs are managed centrally in Settings — make this read-only
                  disabled={true}
                />
                <Input
                  type="text"
                  placeholder="Voucher number or driver name..."
                  value={voucherNumber}
                  onChange={(e) => setVoucherNumber(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === "Enter") {
                      setShowSuggestions(false);
                      handleSearch();
                    } else if (e.key === "Escape") {
                      setShowSuggestions(false);
                    }
                  }}
                  onFocus={() => setShowSuggestions(true)}
                  onBlur={() => {
                    // Delay so a click on a suggestion registers before the
                    // dropdown unmounts.
                    setTimeout(() => setShowSuggestions(false), 150);
                  }}
                  className="rounded-l-none focus-visible:ring-2 focus-visible:ring-blue-500"
                />
              </div>
              {showSuggestions && driverSuggestions.length > 0 && (
                <div className="absolute z-10 mt-1 w-full rounded-md border bg-white shadow-lg max-h-56 overflow-y-auto">
                  {driverSuggestions.map((name) => (
                    <button
                      key={name}
                      type="button"
                      className="w-full text-left px-3 py-2 text-sm hover:bg-orange-50 flex items-center gap-2"
                      onMouseDown={(e) => {
                        // onMouseDown (not onClick) fires before the input's
                        // onBlur, so the click isn't lost to the blur timeout.
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
              disabled={
                expenseVoucherLoading || isFetching || !voucherNumber.trim()
              }
              className="bg-[#001d6e] hover:bg-[#001d6e]/90"
            >
              <Search className="w-4 h-4 mr-2" />
              {expenseVoucherLoading || isFetching ? "Searching..." : "Search"}
            </Button>
            <Button
              onClick={handleRefresh}
              disabled={
                expenseVoucherLoading || isFetching || !voucherNumber.trim()
              }
              variant="outline"
              title="Refresh Data"
            >
              <RefreshCw
                className={`w-4 h-4 ${expenseVoucherLoading || isFetching ? "animate-spin" : ""
                  }`}
              />
            </Button>
          </div>

          {(expenseVoucherLoading || isFetching) && (
            <div className="mt-2">
              <div className="flex items-center justify-between text-sm text-gray-600 mb-1">
                <span>
                  {isFetching && !expenseVoucherLoading
                    ? "Refreshing data..."
                    : "Fetching voucher data from Notion..."}
                </span>
                <span className="font-mono text-orange-600">{selectedOrder}</span>
              </div>
              <div className="flex items-center justify-center">
                <TruckLoadingAnimation
                  label={
                    isFetching && !expenseVoucherLoading
                      ? "Refreshing data..."
                      : "Fetching voucher data..."
                  }
                />
              </div>
            </div>
          )}
        </CardContent>
      </Card>

      {expenseVoucherData?.data &&
        expenseVoucherData.data.vehicleOptions &&
        expenseVoucherData.data.vehicleOptions.length > 1 &&
        selectedVehicleIndex === null && (
          <Card>
            <CardHeader>
              <CardTitle className="flex items-center gap-2">
                <Truck className="h-5 w-5" />
                Multiple Vehicles Found
              </CardTitle>
              <CardDescription>
                This search matched vouchers from more than one vehicle. Pick a
                vehicle to view its voucher details.
              </CardDescription>
            </CardHeader>
            <CardContent>
              <div className="grid grid-cols-1 sm:grid-cols-2 md:grid-cols-3 gap-4">
                {expenseVoucherData.data.vehicleOptions.map((option, idx) => (
                  <button
                    key={option.vehicleNumber + idx}
                    type="button"
                    onClick={() => handleVehicleOptionChange(idx)}
                    className="text-left p-4 rounded-lg border-2 border-orange-200 bg-orange-50 hover:border-orange-500 hover:bg-orange-100 transition-colors"
                  >
                    <div className="flex items-center gap-2 text-orange-900 font-semibold text-base">
                      <Truck className="h-4 w-4" />
                      {option.vehicleNumber}
                    </div>
                    <div className="text-sm text-gray-600 mt-1">
                      {option.mergedVoucherCount} voucher
                      {option.mergedVoucherCount === 1 ? "" : "s"}
                    </div>
                  </button>
                ))}
              </div>
            </CardContent>
          </Card>
        )}

      {expenseVoucherData?.data && selectedVehicleIndex !== null && (
        <div className="space-y-6">
          <Card>
            <CardHeader>
              <div className="flex items-center justify-between">
                <CardTitle className="flex items-center gap-2">
                  <Receipt className="h-5 w-5" />
                  Voucher Details
                </CardTitle>
                <div className="flex items-center gap-2">
                  {expenseVoucherData.data.vehicleOptions &&
                    expenseVoucherData.data.vehicleOptions.length > 1 && (
                      <Button
                        variant="outline"
                        onClick={() => setSelectedVehicleIndex(null)}
                      >
                        Change Vehicle
                      </Button>
                    )}
                  <Button
                    onClick={handlePrint}
                    className="bg-orange-600 hover:bg-orange-700"
                  >
                    <Printer className="w-4 h-4 mr-2" />
                    Print Expense Voucher
                  </Button>
                </div>
              </div>
              <div className="border-t pt-4 mt-4"></div>
            </CardHeader>
            <CardContent>
              <div className="space-y-8">
                <div className="bg-orange-50 p-4 rounded-lg border border-orange-200">
                  <h4 className="font-semibold text-orange-900 mb-3 text-sm flex items-center gap-2">
                    <Receipt className="h-4 w-4" />
                    Voucher Details
                  </h4>
                  <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
                    <div className="space-y-1">
                      <span className="text-sm font-medium text-gray-600">
                        Voucher Date:
                      </span>
                      <div className="text-base font-semibold">
                        {expenseVoucherData.data.voucherInfo?.[
                          "Voucher Date :"
                        ] || "N/A"}
                      </div>
                    </div>
                    <div className="space-y-1">
                      <span className="text-sm font-medium text-gray-600">
                        Voucher No.:
                      </span>
                      <div className="text-base font-semibold">
                        {expenseVoucherData.data.voucherInfo?.[
                          "Voucher No. :"
                        ] || "N/A"}
                      </div>
                    </div>
                    <div className="space-y-1">
                      <span className="text-sm font-medium text-gray-600">
                        Location:
                      </span>
                      <div className="text-base font-semibold">
                        {expenseVoucherData.data.voucherInfo?.["Location :"] ||
                          "N/A"}
                      </div>
                    </div>
                  </div>
                </div>

                <div className="bg-orange-50 p-4 rounded-lg border border-orange-200">
                  <h4 className="font-semibold text-orange-900 mb-3 text-sm flex items-center gap-2">
                    <Truck className="h-4 w-4" />
                    Driver & Vehicle Information
                  </h4>
                  <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                    <div className="space-y-1">
                      <span className="text-sm font-medium text-gray-600">
                        Driver:
                      </span>
                      <div className="text-base font-semibold">
                        {expenseVoucherData.data.voucherInfo?.[
                          "Link to Driver :"
                        ] || "N/A"}
                      </div>
                    </div>
                    <div className="space-y-1">
                      <span className="text-sm font-medium text-gray-600">
                        Vehicle:
                      </span>
                      <div className="text-base font-semibold">
                        {expenseVoucherData.data.voucherInfo?.[
                          "For Vehicle "
                        ] || "N/A"}
                      </div>
                    </div>
                  </div>
                </div>

                <div className="bg-orange-50 p-4 rounded-lg border border-orange-200">
                  <h4 className="font-semibold text-orange-900 mb-3 text-sm flex items-center gap-2">
                    <IndianRupee className="h-4 w-4" />
                    Fuel & Avg Details
                  </h4>
                  <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                    <div className="space-y-1">
                      <span className="text-sm font-medium text-gray-600">
                        Diesel Bill No.:
                      </span>
                      <div className="text-base font-semibold">
                        {expenseVoucherData.data.voucherInfo?.[
                          "For Diesel Bill No. :"
                        ] || "N/A"}
                      </div>
                    </div>
                    <div className="space-y-1">
                      <span className="text-sm font-medium text-gray-600">
                        Diesel (Ltrs):
                      </span>
                      <div className="text-base font-semibold">
                        {formatDieselLtr(
                          expenseVoucherData.data.voucherInfo?.[
                            "Diesel {Ltr's} :"
                          ]
                        )}
                      </div>
                    </div>
                    <div className="space-y-1">
                      <span className="text-sm font-medium text-gray-600">
                        Average:
                      </span>
                      <div className="text-base font-semibold">
                        {(() => {
                          const avg =
                            expenseVoucherData.data.voucherInfo?.["Average :"];
                          if (avg && avg !== "N/A" && !isNaN(parseFloat(avg))) {
                            return parseFloat(avg).toFixed(2);
                          }
                          return "N/A";
                        })()}
                      </div>
                    </div>
                    <div className="space-y-1">
                      <span className="text-sm font-medium text-gray-600">
                        KM's:
                      </span>
                      <div className="text-base font-semibold">
                        {expenseVoucherData.data.voucherInfo?.["KM's SUM"] ||
                          "N/A"}
                      </div>
                    </div>
                    <div className="space-y-1">
                      <span className="text-sm font-medium text-gray-600">
                        Toll Tax:
                      </span>
                      <div className="text-base font-semibold">
                        {expenseVoucherData.data.voucherInfo?.["Toll Tax :"] ||
                          "N/A"}
                      </div>
                    </div>
                    <div className="space-y-1">
                      <span className="text-sm font-medium text-gray-600">
                        OnRoad Work:
                      </span>
                      <div className="text-base font-semibold">
                        {expenseVoucherData.data.voucherInfo?.[
                          "OnRoad Work :"
                        ] || "N/A"}
                      </div>
                    </div>
                  </div>
                </div>

                <div className="bg-orange-50 p-4 rounded-lg border border-orange-200">
                  <h4 className="font-semibold text-orange-900 mb-3 text-sm flex items-center gap-2">
                    <Users className="h-4 w-4" />
                    Party Information
                  </h4>
                  <div className="grid grid-cols-1 gap-4">
                    <div className="space-y-1">
                      <span className="text-sm font-medium text-gray-600">
                        Party x Order Date:
                      </span>
                      <div className="text-base font-semibold">
                        {(() => {
                          const partyOrderDate =
                            expenseVoucherData.data.voucherInfo?.[
                            "For Party x Ord Date"
                            ] || "N/A";
                          if (partyOrderDate && partyOrderDate !== "N/A") {
                            const lines = partyOrderDate
                              .split(/\s*[\n\r]+\s*/)
                              .filter((line) => line.trim());
                            if (lines.length === 1) {
                              return lines[0];
                            } else {
                              const firstLine = lines[0];
                              const additionalLines = lines.slice(1).join(", ");
                              return (
                                <div>
                                  <div>{firstLine}</div>
                                  <div>{additionalLines}</div>
                                </div>
                              );
                            }
                          }
                          return partyOrderDate;
                        })()}
                      </div>
                    </div>
                  </div>
                </div>

                <div className="bg-purple-50 p-4 rounded-lg border border-purple-200">
                  <h4 className="font-semibold text-purple-900 mb-3 text-sm flex items-center gap-2">
                    <IndianRupee className="h-4 w-4" />
                    Financial Information
                  </h4>
                  <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                    <div className="space-y-1">
                      <span className="text-sm font-medium text-gray-600">
                        Conveyance:
                      </span>
                      <div className="text-base font-semibold">
                        ₹
                        {expenseVoucherData.data.voucherInfo?.[
                          "For Conveyance (MAY24):"
                        ] || "N/A"}
                      </div>
                    </div>
                    <div className="space-y-1">
                      <span className="text-sm font-medium text-gray-600">
                        Conveyance Allowance:
                      </span>
                        <div className="flex items-center gap-2">
                          <div className="text-base font-semibold">
                            ₹
                            {new Intl.NumberFormat("en-IN").format(
                              // Read the live merged value directly -- editableConveyanceAllowance
                              // has no edit UI wired to it, so it's just a display mirror that can
                              // lag behind (still showing the previous voucher's amount) and
                              // disagree with Final Payment, which was computed from the real value.
                              parseFloat(
                                expenseVoucherData.data.voucherInfo?.[
                                "Conveyance Allowance:"
                                ] || "0"
                              ) ||
                              0
                            )}
                          </div>
                        </div>
                    </div>
                    <div className="space-y-1">
                      <span className="text-sm font-medium text-gray-600">
                        CA +/-:
                      </span>
                      <div className="text-base font-semibold">
                        ₹
                        {expenseVoucherData.data.voucherInfo?.["CA +/-"] ||
                          "N/A"}
                      </div>
                    </div>
                    <div className="space-y-1">
                      <span className="text-sm font-medium text-gray-600">
                        Deduction:
                      </span>
                      <div className="text-base font-semibold">
                        ₹
                        {expenseVoucherData.data.voucherInfo?.["Deduction :"] ||
                          "N/A"}
                      </div>
                    </div>
                    <div className="space-y-1">
                      <span className="text-sm font-medium text-gray-600">
                        Final Payment:
                      </span>
                        <div className="flex items-center gap-2">
                          <div className="text-base font-semibold text-green-700">
                            ₹
                            {new Intl.NumberFormat("en-IN").format(
                              parseFloat(
                                expenseVoucherData.data.voucherInfo?.[
                                "ECS Payment :"
                                ] || "0"
                              ) ||
                              0
                            )}
                          </div>
                        </div>
                    </div>
                    {(() => {
                      const remark =
                        expenseVoucherData.data.voucherInfo?.["Remark :"] || "";
                      if (remark && remark.trim() && remark !== "N/A") {
                        return (
                          <div className="space-y-1 md:col-span-2">
                            <span className="text-sm font-medium text-gray-600">
                              Remark:
                            </span>
                            <div className="text-base font-semibold text-red-600">
                              {remark.trim()}
                            </div>
                          </div>
                        );
                      }
                      return null;
                    })()}
                  </div>
                </div>
              </div>
            </CardContent>
          </Card>
        </div>
      )}

      {/* Unified Error / Not Found State - Replaces previous separate error/empty blocks */}
      {((expenseVoucherData && !expenseVoucherData.data) || isError) && !expenseVoucherLoading && !isFetching && (
        <div className="max-w-7xl mx-auto mt-6 animate-in fade-in slide-in-from-bottom-4 duration-500">
          <Card className="border-red-200 shadow-lg bg-white overflow-hidden">
            <div className="h-2 bg-red-500 w-full"></div>
            <CardContent className="p-12 flex flex-col items-center justify-center text-center">
              <div className="w-24 h-24 bg-red-50 rounded-full flex items-center justify-center mb-6 shadow-inner">
                <Search className="h-12 w-12 text-red-500" />
              </div>
              
              <h3 className="text-2xl font-bold text-gray-900 mb-3">
                No Records Found
              </h3>

              <p className="text-gray-600 max-w-md mb-8 text-lg">
                We couldn't locate an expense voucher with number <span className="font-mono font-bold text-red-600 bg-red-50 px-2 py-1 rounded">{selectedOrder}</span> on <span className="font-mono font-bold text-red-600 bg-red-50 px-2 py-1 rounded">{selectedDate ? format(selectedDate, "dd/MM/yyyy") : "the selected date"}</span>
              </p>
              
              <div className="grid gap-4 w-full max-w-lg">
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
                 <p className="mt-6 text-xs text-gray-500">
                  An error occurred while fetching the voucher data. Please try again later.
                </p>
              )}
            </CardContent>
          </Card>
        </div>
      )}
    </div>
  );
}
