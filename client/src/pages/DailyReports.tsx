import { PlantBadge } from "@/components/PlantBadge";
import { PageScrollButtons } from "@/components/PageScrollButtons";
import { useEffect, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { apiRequest } from "@/lib/queryClient";
import { usePersistentFilter } from "@/hooks/usePersistentFilter";
import { usePageWidth } from "@/hooks/usePageWidth";
import { useIsMobile } from "@/hooks/use-mobile";
import { DateInput } from "@/components/ui/date-input";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { TableCard } from "@/components/ui/table-card";
import { DataTable, type DataTableColumn } from "@/components/ui/data-table";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription } from "@/components/ui/dialog";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { DropdownMenu, DropdownMenuTrigger, DropdownMenuContent, DropdownMenuItem } from "@/components/ui/dropdown-menu";
import {
  Download, FileBarChart, Truck, Clock, Loader2, ChevronDown,
  Package, ListChecks, CalendarClock, FileSpreadsheet, Eye,
} from "lucide-react";
import * as XLSX from "xlsx";
import jsPDF from "jspdf";
import autoTable from "jspdf-autotable";

type Tab = "loading" | "unloading" | "scan";
type Fmt = "CSV" | "Excel" | "PDF";
// A plain string/number cell exports as-is; { text } marks a value (a barcode) that must stay
// literal text even though it looks like a number — see exportRows' CSV branch for why.
type Cell = string | number | { text: string };
type ExportRow = Cell[];
const REPORT_TABLE_HEADER_CLASS = "bg-[#001d6e] text-white border-[#1a3a9c] hover:bg-[#0a2b7e] hover:text-white";
// Wraps a barcode for export — Excel's own CSV importer auto-detects a long all-digit cell as a
// number and renders it in scientific notation (e.g. "8906010500221" becomes "8.91E+12"),
// regardless of CSV quoting (quoting only protects delimiter-splitting, not Excel's type
// inference on open). Every barcode column across this page's exports goes through this so the
// full number always survives.
const barcodeCell = (barcode: string): Cell => ({ text: barcode });

type ReportRow = {
  key: string;
  label: string;
  plant: string | null;
  orderCount: number;
  expectedQty: number;
  actualQty: number;
  eventCount: number;
  startTime: string | null;
  endTime: string | null;
  expectedPallets?: number;
  receivedPallets?: number;
  extraPallets?: number;
};
// `pallets` = pallets actually received (scanned); `expectedPallets` = expected qty / pallet size.
type ItemTotal = { barcode: string; itemName: string | null; srNo?: string | null; expectedQty: number; expectedPallets?: number; actualQty: number; extraQty: number; pallets: number };
type Activity = {
  barcode: string; itemName: string | null; qty: number; pallets?: number; stv?: string | null;
  isExtra: boolean; scannedByName: string | null; scannedAt: string;
  groupKey?: string | null; groupLabel?: string | null;
  // A voided scan stays in the activity list, clearly marked, so the report says the entry
  // happened and was cancelled; totals/item-wise figures already exclude it server-side. An
  // entry someone REMOVED from Scan History is dropped by the server and never arrives here.
  voided?: boolean; voidReason?: string | null; voidedAt?: string | null;
};
type ReportData = {
  date: string;
  totalSummary: { orderCount: number; expectedQty: number; actualQty: number; extraQty: number; vehicleCount: number };
  activitySummary: { eventCount: number; startTime: string | null; endTime: string | null };
  breakdown: ReportRow[];
  // Undefined (not [] ) for a tab whose backend hasn't been extended with these yet — kept
  // distinct from "extended, but nothing happened on this date" so the UI can say which.
  itemTotals?: ItemTotal[];
  activities?: Activity[];
};
type VehicleDetail = {
  date: string; vehicle: string; plant: string | null;
  startTime: string | null; endTime: string | null;
  itemTotals: ItemTotal[]; activities: Activity[];
};
type LoadingSlipDetail = {
  date: string; order: string; partyName: string | null; plant: string | null; vehicleNumber: string | null;
  startTime: string | null; endTime: string | null;
  itemTotals: ItemTotal[]; activities: Activity[];
};
type CsvDetail = {
  date: string; csv: string; plant: string | null;
  startTime: string | null; endTime: string | null;
  itemTotals: ItemTotal[]; activities: Activity[];
};

// "Today" in IST, not the browser's own local date — matching the app-wide Asia/Kolkata
// convention, so the default date shown here agrees with every other page.
function todayIST(): string {
  return new Date().toLocaleDateString("en-CA", { timeZone: "Asia/Kolkata" }); // en-CA -> YYYY-MM-DD
}
// Forces Asia/Kolkata regardless of the viewer's own machine timezone — same convention every
// other export/display in the app uses (ReportsDialog's fmtIST, Activities' export, etc.).
function fmtIST(dt: string | null): string {
  if (!dt) return "—";
  const d = new Date(dt);
  return isNaN(d.getTime()) ? "—" : d.toLocaleString("en-IN", { timeZone: "Asia/Kolkata" });
}

// Date AND clock time in IST — an order's scanning can start on one day and finish days later
// (an order dated the 19th completed on the 25th), so a bare clock time made End look earlier
// than Start.
function fmtISTDateTime(dt: string | null): string {
  if (!dt) return "—";
  const d = new Date(dt);
  if (isNaN(d.getTime())) return "—";
  const date = d.toLocaleDateString("en-GB", { timeZone: "Asia/Kolkata", day: "2-digit", month: "short", year: "numeric" });
  const time = d.toLocaleTimeString("en-IN", { timeZone: "Asia/Kolkata", hour: "2-digit", minute: "2-digit", second: "2-digit", hour12: true });
  return `${date}, ${time}`;
}

// Elapsed time from Start to End, e.g. "6d 0h 49m" / "3h 12m 05s" / "4m 10s". "—" until both
// ends exist (a not-yet-completed CSV/vehicle has no End).
function fmtTotalTime(start: string | null, end: string | null): string {
  if (!start || !end) return "—";
  const ms = new Date(end).getTime() - new Date(start).getTime();
  if (!Number.isFinite(ms) || ms < 0) return "—";
  const total = Math.round(ms / 1000);
  const d = Math.floor(total / 86400), h = Math.floor((total % 86400) / 3600), m = Math.floor((total % 3600) / 60), sec = total % 60;
  if (d > 0) return `${d}d ${h}h ${m}m`;
  if (h > 0) return `${h}h ${m}m ${String(sec).padStart(2, "0")}s`;
  return `${m}m ${String(sec).padStart(2, "0")}s`;
}

// An item's physical received quantity includes both its regular receipt and any extra receipt.
// Extra stays visible in its own column, so the operator can still see that split.
const receivedIncludingExtra = (item: ItemTotal): number => item.actualQty + item.extraQty;

function dailyReportPlantsFromUser(): string[] | null {
  try {
    const user = JSON.parse(localStorage.getItem("currentUser") || "{}");
    const role = String(user.role ?? "").trim().toLowerCase();
    if (["admin", "super-admin", "superadmin", "super_admin", "super admin"].includes(role)) return null;
    const raw = typeof user.plants === "string" ? JSON.parse(user.plants) : user.plants;
    return Array.isArray(raw) ? raw.map((p) => String(p).trim()).filter(Boolean) : [];
  } catch {
    return [];
  }
}

// Same CSV/Excel/PDF export mechanism the existing per-order Reports dialog uses
// (client/src/components/modals/ReportsDialog.tsx's exportRows), so a downloaded file here looks
// and behaves the same as every other report export in the app.
function exportRows(fmt: Fmt, baseName: string, title: string, rows: ExportRow[]) {
  if (fmt === "CSV") {
    // A { text } cell gets Excel's ="..." formula trick — it evaluates to the literal string, so
    // the barcode still displays in full instead of being auto-numbered into scientific notation.
    // Plain cells are untouched.
    const csv = rows
      .map((r) => r.map((c) => {
        const raw = c !== null && typeof c === "object" ? `="${c.text.replace(/"/g, '""')}"` : String(c ?? "");
        return `"${raw.replace(/"/g, '""')}"`;
      }).join(","))
      .join("\n");
    const a = document.createElement("a");
    a.href = URL.createObjectURL(new Blob([csv], { type: "text/csv;charset=utf-8;" }));
    a.download = `${baseName}.csv`;
    a.click();
    URL.revokeObjectURL(a.href);
  } else if (fmt === "Excel") {
    // aoa_to_sheet keeps a plain JS string as a text cell (not auto-numbered) already, so { text }
    // just needs unwrapping to its plain string here — no formula trick needed for this format.
    const plain = rows.map((r) => r.map((c) => (c !== null && typeof c === "object" ? c.text : c)));
    const sheet = XLSX.utils.aoa_to_sheet(plain);
    const book = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(book, sheet, "Report");
    XLSX.writeFile(book, `${baseName}.xlsx`);
  } else {
    const plain = rows.map((r) => r.map((c) => (c !== null && typeof c === "object" ? c.text : c)));
    const doc = new jsPDF({ orientation: "landscape" });
    const pageWidth = doc.internal.pageSize.getWidth();
    const pageHeight = doc.internal.pageSize.getHeight();
    const margin = 14;
    const separatorIndex = plain.findIndex((row) => row.length === 0);
    const headerIndex = separatorIndex >= 0 ? separatorIndex + 1 : 0;
    const metadata = plain.slice(0, headerIndex).filter((row) => row.length > 0);
    const header = plain[headerIndex] ?? [];
    const body = plain.slice(headerIndex + 1);

    doc.setFillColor(0, 29, 110);
    doc.rect(0, 0, pageWidth, 24, "F");
    doc.setTextColor(255, 255, 255);
    doc.setFont("helvetica", "bold");
    doc.setFontSize(15);
    doc.text(title, margin, 14);
    doc.setFont("helvetica", "normal");
    doc.setFontSize(9);
    const scope = metadata
      .map((row) => row.reduce<string[]>((parts, cell, index) => {
        if (index % 2 === 0 && row[index + 1] !== undefined) parts.push(`${String(cell)}: ${String(row[index + 1])}`);
        return parts;
      }, []).join("  |  "))
      .join("  |  ");
    if (scope) doc.text(scope, margin, 20);
    doc.setFontSize(8);
    doc.text(`Generated ${fmtIST(new Date().toISOString())}`, pageWidth - margin, 17, { align: "right" });
    doc.setTextColor(0, 0, 0);

    const columnStyles: Record<number, { halign: "right" }> = {};
    header.forEach((cell, index) => {
      if (/(qty|pallet|expected|actual|extra|order|event)/i.test(String(cell))) columnStyles[index] = { halign: "right" };
    });
    autoTable(doc, {
      head: [header as string[]],
      body: body as string[][],
      startY: 30,
      theme: "grid",
      styles: { fontSize: 7, cellPadding: 2.2, lineColor: [210, 210, 210], lineWidth: 0.15 },
      headStyles: { fillColor: [0, 29, 110], textColor: 255, fontStyle: "bold", halign: "left" },
      alternateRowStyles: { fillColor: [245, 247, 251] },
      columnStyles,
      margin: { left: margin, right: margin },
    });
    const pageCount = doc.getNumberOfPages();
    for (let page = 1; page <= pageCount; page++) {
      doc.setPage(page);
      doc.setFontSize(8);
      doc.setTextColor(150, 150, 150);
      doc.text("KM Finny - Confidential", margin, pageHeight - 8);
      doc.text(`Page ${page} of ${pageCount}`, pageWidth - margin, pageHeight - 8, { align: "right" });
    }
    doc.save(`${baseName}.pdf`);
  }
}

// A small icon-only dropdown (not a full labeled button) — every report on this page gets one of
// these next to its own header instead of one big button up top, so downloading a specific
// report is a click on that report, not a separate control elsewhere on the page.
function DownloadMenu({ onExport, formats = ["CSV", "Excel", "PDF"] }: { onExport: (fmt: Fmt) => void; formats?: Fmt[] }) {
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button variant="outline" size="sm" className="h-7 px-2" title="Download">
          <Download className="h-3.5 w-3.5" /> <ChevronDown className="ml-1 h-3 w-3" />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end">
        {formats.map((fmt) => <DropdownMenuItem key={fmt} onClick={() => onExport(fmt)}>{fmt}</DropdownMenuItem>)}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

// A small colored chip behind a section's icon — the "professional" treatment used for every
// section header on this page instead of a bare icon sitting directly on white.
function SectionIcon({ icon: Icon, tone = "text-[#001d6e] bg-[#001d6e]/10" }: { icon: typeof Package; tone?: string }) {
  return (
    <span className={`flex h-6 w-6 shrink-0 items-center justify-center rounded-md ${tone}`}>
      <Icon className="h-3.5 w-3.5" />
    </span>
  );
}

const TABS: { key: Tab; label: string; breakdownLabel: string }[] = [
  { key: "loading", label: "Loading", breakdownLabel: "Slip / Order" },
  { key: "unloading", label: "Unloading", breakdownLabel: "Vehicle" },
  // Scan Operation has no vehicle concept in its schema — it's the scanning phase of a CSV
  // import session, so its breakdown groups by CSV/order instead.
  { key: "scan", label: "Scan Operations", breakdownLabel: "CSV / Order" },
];

// The wide tables only fit when the page itself is wide enough — below this width the row cards
// are used instead, so nothing ever needs scrolling sideways. usePageWidth itself now lives in
// its own hook file, shared with AdjustExchange.tsx.
const TABLE_MIN_PAGE_WIDTH = 900;

export default function DailyReports() {
  const [rootRef, pageWidth] = usePageWidth();
  // Until measured (first paint) fall back to the old viewport rule so nothing flashes.
  const useCards = pageWidth > 0 ? pageWidth < TABLE_MIN_PAGE_WIDTH : false;
  const tableBoxClass = pageWidth > 0 ? (useCards ? "hidden" : "block") : "hidden md:block";
  const cardBoxClass = pageWidth > 0 ? (useCards ? "" : "hidden") : "md:hidden";
  // Which top-level tab and which report sub-tab were open last — remembered across visits
  // (sessionStorage, same convention as every other page's filter/view state) rather than
  // always resetting to Loading/Total Summary.
  const [tab, setTab] = usePersistentFilter<Tab>("dailyReports:tab", "loading");
  const [reportTab, setReportTab] = usePersistentFilter<"summary" | "activities" | "breakdown">("dailyReports:reportTab", "summary");
  // The date always defaults to today (IST) on a fresh visit — it is not remembered, since
  // "today" changing every day is exactly the point of that default.
  const [date, setDate] = useState(todayIST());
  const [selectedPlant, setSelectedPlant] = usePersistentFilter("dailyReports:plant", "");
  const activeTab = TABS.find((t) => t.key === tab)!;
  // Every tab (Loading, Unloading, Scan) has the Total Summary + Activities Summary pair.
  const showActivitySummary = true;
  const { data: allPlants = [] } = useQuery<Array<{ name: string }>>({
    queryKey: ["/api/plants", "daily-reports"],
    queryFn: () => apiRequest("GET", "/api/plants").then((r) => r.json()),
    staleTime: 60000,
  });
  const assignedPlants = dailyReportPlantsFromUser();
  const plantOptions = (assignedPlants === null ? allPlants.map((p) => p.name) : assignedPlants)
    .filter((name, index, list) => list.findIndex((v) => v.toLowerCase() === name.toLowerCase()) === index)
    .sort((a, b) => a.localeCompare(b));
  useEffect(() => {
    if (selectedPlant && !plantOptions.some((plant) => plant.toLowerCase() === selectedPlant.toLowerCase())) setSelectedPlant("");
  }, [selectedPlant, plantOptions.join("|")]);

  // Which vehicle's/CSV's own detail popup is open — Unloading and Scan respectively.
  const [openVehicle, setOpenVehicle] = useState<string | null>(null);
  const [openOrder, setOpenOrder] = useState<string | null>(null);
  const [openCsv, setOpenCsv] = useState<string | null>(null);
  // The row's own plant travels with the drill-down: the same CSV file name (or vehicle number)
  // can exist in two plants on one date, and without it the popup mixed both plants' scans.
  const [openPlant, setOpenPlant] = useState<string | null>(null);
  // Small screens only: which of the two summary cards is showing (both show from lg up).
  const [summaryCard, setSummaryCard] = useState<"total" | "activity">("total");
  const pickVehicle = (row: ReportRow) => { setOpenPlant(row.plant); setOpenVehicle(row.key); };
  const pickCsv = (row: ReportRow) => { setOpenPlant(row.plant); setOpenCsv(row.key); };
  const [openDetailTab, setOpenDetailTab] = useState<"items" | "activities">("items");
  const effectiveReportTab = tab === "scan"
    ? reportTab
    : reportTab === "activities" ? "activities" : "summary";

  const selectTab = (next: Tab) => {
    setTab(next);
    if (next !== "scan") setReportTab("summary");
  };

  const reportQuery = useQuery({
    queryKey: ["/api/daily-reports", tab, date, selectedPlant],
    queryFn: async () => {
      const plantQuery = selectedPlant ? `&plant=${encodeURIComponent(selectedPlant)}` : "";
      const res = await apiRequest("GET", `/api/daily-reports/${tab}?date=${encodeURIComponent(date)}${plantQuery}`);
      if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        throw new Error(body.message ?? "Failed to load the report");
      }
      return res.json() as Promise<ReportData>;
    },
  });
  const data = reportQuery.data;

  const handleExportSummaryReport = (fmt: Fmt) => {
    if (!data?.itemTotals) return;
    const totals = data.itemTotals.reduce(
      (acc, i) => ({ expectedQty: acc.expectedQty + i.expectedQty, actualQty: acc.actualQty + receivedIncludingExtra(i), extraQty: acc.extraQty + i.extraQty, expectedPallets: acc.expectedPallets + (i.expectedPallets ?? 0), pallets: acc.pallets + i.pallets }),
      { expectedQty: 0, actualQty: 0, extraQty: 0, expectedPallets: 0, pallets: 0 },
    );
    const rows: ExportRow[] = [
      ["Start", fmtIST(data.activitySummary.startTime), "End", fmtIST(data.activitySummary.endTime), "Total Time", fmtTotalTime(data.activitySummary.startTime, data.activitySummary.endTime)],
      [],
      ["Barcode", "Item Name", "Expected Qty", "Received Qty", "Extra Qty", "Expected Pallets", "Received Pallets"],
      ...data.itemTotals.map((i) => [barcodeCell(i.barcode), i.itemName ?? "", i.expectedQty, receivedIncludingExtra(i), i.extraQty, (i.expectedPallets ?? 0).toFixed(2), i.pallets.toFixed(2)]),
      ["TOTAL", "", totals.expectedQty, totals.actualQty, totals.extraQty, totals.expectedPallets.toFixed(2), totals.pallets.toFixed(2)],
    ];
    exportRows(fmt, `${tab}-summary-report-${data.date}`, `${activeTab.label} — Total Summary Report — ${data.date}`, rows);
  };

  const handleExportActivitiesReport = (fmt: Fmt) => {
    if (!data?.activities) return;
    const rows: ExportRow[] = [
      ["Start", fmtIST(data.activitySummary.startTime), "End", fmtIST(data.activitySummary.endTime), "Total Time", fmtTotalTime(data.activitySummary.startTime, data.activitySummary.endTime)],
      [],
      ["Time", "Barcode", "Item Name", "Qty", "Pallets", "STV", "Extra?", "Scanned By", "Voided"],
      ...data.activities.map((a) => [
        fmtIST(a.scannedAt), barcodeCell(a.barcode), a.itemName ?? "", a.qty, a.pallets?.toFixed(2) ?? "", a.stv ?? "",
        a.isExtra ? "Yes" : "No", a.scannedByName ?? "", voidedCell(a),
      ]),
    ];
    exportRows(fmt, `${tab}-activities-report-${data.date}`, `${activeTab.label} — Activities Report — ${data.date}`, rows);
  };

  const summaryTotals = data?.itemTotals?.reduce(
    (acc, i) => ({ expectedQty: acc.expectedQty + i.expectedQty, actualQty: acc.actualQty + receivedIncludingExtra(i), extraQty: acc.extraQty + i.extraQty, expectedPallets: acc.expectedPallets + (i.expectedPallets ?? 0), pallets: acc.pallets + i.pallets }),
    { expectedQty: 0, actualQty: 0, extraQty: 0, expectedPallets: 0, pallets: 0 },
  );

  // Same shared DataTable/TableCard the rest of the app's tables use (Overall Stock, Scan
  // History) — sortable/resizable/hideable columns, zebra stripes, a totals row — instead of
  // this page's own hand-built <table>s.
  const summaryColumns: DataTableColumn<ItemTotal>[] = [
    {
      id: "barcode", header: "Barcode", width: 150, accessor: (r) => r.barcode,
      totalable: false, cellClassName: "font-mono text-xs text-gray-500",
    },
    {
      id: "itemName", header: "Item Name", accessor: (r) => r.itemName, totalable: false,
      cellClassName: "text-gray-900", render: (r) => r.itemName || "—",
    },
    { id: "expectedQty", header: "Expected", align: "right", accessor: (r) => r.expectedQty, cellClassName: "tabular-nums text-gray-700" },
    { id: "actualQty", header: "Received", align: "right", accessor: receivedIncludingExtra, cellClassName: "tabular-nums font-medium text-emerald-600" },
    {
      id: "extraQty", header: "Extra", align: "right", accessor: (r) => r.extraQty,
      render: (r) => <span className={r.extraQty > 0 ? "font-medium text-amber-600" : "text-gray-400"}>{r.extraQty}</span>,
    },
    { id: "expectedPallets", header: "Expected Pallets", align: "right", accessor: (r) => r.expectedPallets ?? 0, cellClassName: "tabular-nums text-gray-700", render: (r) => (r.expectedPallets ?? 0).toFixed(2), total: (rows) => rows.reduce((sum, r) => sum + (r.expectedPallets ?? 0), 0).toFixed(2) },
    { id: "pallets", header: "Received Pallets", align: "right", accessor: (r) => r.pallets, cellClassName: "tabular-nums text-[#001d6e]", render: (r) => r.pallets.toFixed(2), total: (rows) => rows.reduce((sum, r) => sum + r.pallets, 0).toFixed(2) },
  ];

  const activitiesColumns: DataTableColumn<Activity>[] = [
    { id: "scannedAt", header: "Time", width: 150, accessor: (r) => r.scannedAt, totalable: false, cellClassName: "whitespace-nowrap text-xs text-gray-500", render: (r) => fmtIST(r.scannedAt) },
    { id: "barcode", header: "Barcode", width: 150, accessor: (r) => r.barcode, totalable: false, cellClassName: "font-mono text-xs text-gray-500" },
    {
      id: "itemName", header: "Item Name", accessor: (r) => r.itemName, totalable: false,
      cellClassName: "text-gray-900",
      render: (r) => (
        <>
          {r.itemName || "—"}
          {r.isExtra && !r.voided && <span className="ml-1.5 rounded-full bg-amber-100 px-1.5 py-0.5 text-[10px] font-semibold text-amber-700">Extra</span>}
          <VoidedBadge a={r} />
        </>
      ),
    },
    { id: "qty", header: "Qty", align: "right", accessor: (r) => r.qty, cellClassName: "tabular-nums font-medium text-emerald-600", render: qtyCellFor },
    { id: "pallets", header: "Pallets", align: "right", accessor: (r) => r.pallets ?? null, cellClassName: "tabular-nums text-[#001d6e]", render: (r) => r.pallets?.toFixed(2) ?? "—" },
    { id: "stv", header: "STV", width: 100, accessor: (r) => r.stv, totalable: false, cellClassName: "text-gray-500", render: (r) => r.stv || "—" },
    { id: "scannedByName", header: "By", width: 140, accessor: (r) => r.scannedByName, totalable: false, cellClassName: "text-gray-500", render: (r) => r.scannedByName || "—" },
  ];

  // Opens the vehicle / slip / CSV popup for a row. Only the "View" button calls this — the row
  // itself is not clickable, so selecting text or scrolling never opens a popup by accident.
  const openRow = (row: ReportRow, detailTab: "items" | "activities") => {
    if (row.key === "—") return;
    // A CSV opens on its item list (the activities are one tab over, in the same popup).
    setOpenDetailTab(tab === "scan" ? "items" : detailTab);
    if (tab === "unloading") pickVehicle(row);
    else if (tab === "loading") setOpenOrder(row.key);
    else pickCsv(row);
  };

  const breakdownColumnsFor = (detailTab: "items" | "activities"): DataTableColumn<ReportRow>[] => [
    {
      id: "label", header: activeTab.breakdownLabel, accessor: (r) => r.label, totalable: false,
      cellClassName: "font-medium text-gray-900",
    },
    { id: "plant", header: "Plant", width: 120, accessor: (r) => r.plant, totalable: false, render: (r) => (r.plant ? <PlantBadge plant={r.plant} /> : "—") },
    { id: "orderCount", header: "Orders", align: "right", accessor: (r) => r.orderCount, cellClassName: "tabular-nums" },
    { id: "expectedQty", header: "Expected", align: "right", accessor: (r) => r.expectedQty, cellClassName: "tabular-nums text-gray-700" },
    { id: "actualQty", header: "Received", align: "right", accessor: (r) => r.actualQty, cellClassName: "tabular-nums font-medium text-emerald-600" },
    { id: "eventCount", header: "Events", align: "right", accessor: (r) => r.eventCount, cellClassName: "tabular-nums" },
    { id: "startTime", header: "Start", width: 140, accessor: (r) => r.startTime, totalable: false, cellClassName: "whitespace-nowrap text-xs text-gray-500", render: (r) => fmtIST(r.startTime) },
    { id: "endTime", header: "End", width: 140, accessor: (r) => r.endTime, totalable: false, cellClassName: "whitespace-nowrap text-xs text-gray-500", render: (r) => fmtIST(r.endTime) },
    {
      id: "open", header: "", width: 96, fixedWidth: true, sortable: false, hideable: false, totalable: false,
      render: (r) => r.key === "—" ? null : (
        <Button type="button" size="sm" variant="outline" className="h-7 gap-1 px-2 text-xs" onClick={() => openRow(r, detailTab)}>
          <Eye className="h-3.5 w-3.5" /> View
        </Button>
      ),
    },
  ];
  const summaryBreakdownColumns = breakdownColumnsFor("items");
  const activitiesBreakdownColumns = breakdownColumnsFor("activities");

  return (
    <div ref={rootRef} className="container-fluid max-w-full space-y-5 overflow-x-hidden px-3 py-6 sm:px-4 md:px-6">
      <PageScrollButtons />
      <div className="flex flex-wrap items-center justify-between gap-3">
        <h2 className="flex items-center text-2xl font-bold tracking-tight">
          <FileBarChart className="mr-2 h-6 w-6 text-[#001d6e]" />
          <span className="text-[#001d6e]">Reports</span>
        </h2>
        <div className="flex min-w-0 flex-wrap items-center justify-end gap-2">
          <Select value={selectedPlant || "__all__"} onValueChange={(value) => setSelectedPlant(value === "__all__" ? "" : value)}>
            <SelectTrigger className="h-9 w-[min(12rem,calc(100vw-2rem))] text-sm">
              <SelectValue placeholder="All plants" />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="__all__">All plants</SelectItem>
              {plantOptions.map((plant) => <SelectItem key={plant} value={plant}>{plant}</SelectItem>)}
            </SelectContent>
          </Select>
          <DateInput value={date} onChange={setDate} clearable={false} />
        </div>
      </div>

      {/* Loading / Unloading / Scan — whichever tab is selected, that section's report opens. */}
      <div className="flex items-center gap-2">
        {TABS.map((t) => (
          <button
            key={t.key}
            type="button"
            onClick={() => selectTab(t.key)}
            className={
              tab === t.key
                ? "rounded-full bg-[#001d6e] px-4 py-1.5 text-sm font-semibold text-white ring-2 ring-[#001d6e]/30"
                : "rounded-full border border-gray-200 bg-white px-4 py-1.5 text-sm font-medium text-gray-600 hover:bg-gray-50"
            }
          >
            {t.label}
          </button>
        ))}
      </div>

      {reportQuery.isLoading ? (
        <p className="text-sm text-gray-400">Loading report…</p>
      ) : reportQuery.isError ? (
        <p className="text-sm text-red-600">{(reportQuery.error as Error).message}</p>
      ) : data ? (
        <>
          {/* Total Summary + Activities Summary, side by side in one row. */}
          {/* Below lg the two summary cards are too tall stacked, so a small switch shows one at a
              time (same pill style as the Loading/Unloading/Scan switch); from lg up both show. */}
          {showActivitySummary && (
            <div className="flex items-center gap-2 lg:hidden">
              {([["total", "Total Summary"], ["activity", "Activities Summary"]] as const).map(([key, label]) => (
                <button
                  key={key}
                  type="button"
                  onClick={() => setSummaryCard(key)}
                  className={
                    summaryCard === key
                      ? "rounded-full bg-[#001d6e] px-3 py-1 text-xs font-semibold text-white ring-2 ring-[#001d6e]/30"
                      : "rounded-full border border-gray-200 bg-white px-3 py-1 text-xs font-medium text-gray-600 hover:bg-gray-50"
                  }
                >
                  {label}
                </button>
              ))}
            </div>
          )}
          <div className={`grid gap-3 ${showActivitySummary ? "lg:grid-cols-2" : "grid-cols-1"}`}>
            <Card className={`border-gray-200 shadow-sm ${showActivitySummary && summaryCard === "activity" ? "hidden lg:block" : ""}`}>
              <CardContent className="p-3">
                <p className="mb-2 flex items-center gap-1.5 text-xs font-semibold uppercase tracking-wide text-gray-500">
                  <SectionIcon icon={Package} /> Total Summary
                </p>
                <div className="grid grid-cols-2 gap-2 sm:grid-cols-5">
                  <StatBox label="Orders" value={data.totalSummary.orderCount} />
                  <StatBox label={activeTab.key === "scan" ? "CSVs" : activeTab.key === "loading" ? "Slips" : "Vehicles"} value={data.totalSummary.vehicleCount} />
                  <StatBox label="Expected" value={data.totalSummary.expectedQty} />
                  <StatBox label="Received" value={data.totalSummary.actualQty} />
                  <StatBox label="Extra" value={data.totalSummary.extraQty} />
                </div>
              </CardContent>
            </Card>
            {showActivitySummary && <Card className={`border-gray-200 shadow-sm ${summaryCard === "total" ? "hidden lg:block" : ""}`}>
              <CardContent className="p-3">
                <p className="mb-2 flex items-center gap-1.5 text-xs font-semibold uppercase tracking-wide text-gray-500">
                  <SectionIcon icon={CalendarClock} /> Activities Summary
                </p>
                <div className="grid grid-cols-2 gap-2 sm:grid-cols-[auto_minmax(0,1.5fr)_minmax(0,1.5fr)_minmax(0,1fr)]">
                  <StatBox label="Events" value={data.activitySummary.eventCount} />
                  <StatBox label="Start Time" text={fmtISTDateTime(data.activitySummary.startTime)} />
                  <StatBox label="End Time" text={fmtISTDateTime(data.activitySummary.endTime)} />
                  <StatBox label="Total Time" text={fmtTotalTime(data.activitySummary.startTime, data.activitySummary.endTime)} />
                </div>
              </CardContent>
            </Card>}
          </div>

          {/* Loading/Unloading use Summary + Activities. Scan Operations also keeps its CSV breakdown. */}
          <div className="flex items-center gap-2">
            <button
              type="button"
              onClick={() => setReportTab("summary")}
              className={
                effectiveReportTab === "summary"
                  ? "rounded-full bg-[#001d6e] px-4 py-1.5 text-sm font-semibold text-white ring-2 ring-[#001d6e]/30"
                  : "rounded-full border border-gray-200 bg-white px-4 py-1.5 text-sm font-medium text-gray-600 hover:bg-gray-50"
              }
            >
              Total Summary Report
            </button>
            <button
              type="button"
              onClick={() => setReportTab("activities")}
              className={
                effectiveReportTab === "activities"
                  ? "rounded-full bg-[#001d6e] px-4 py-1.5 text-sm font-semibold text-white ring-2 ring-[#001d6e]/30"
                  : "rounded-full border border-gray-200 bg-white px-4 py-1.5 text-sm font-medium text-gray-600 hover:bg-gray-50"
              }
            >
              Activities Report
            </button>
            {tab === "scan" && <button
              type="button"
              onClick={() => setReportTab("breakdown")}
              className={
                effectiveReportTab === "breakdown"
                  ? "rounded-full bg-[#001d6e] px-4 py-1.5 text-sm font-semibold text-white ring-2 ring-[#001d6e]/30"
                  : "rounded-full border border-gray-200 bg-white px-4 py-1.5 text-sm font-medium text-gray-600 hover:bg-gray-50"
              }
            >
              {activeTab.breakdownLabel} Breakdown
            </button>}
          </div>

          {effectiveReportTab === "summary" && (tab === "loading" || tab === "unloading") ? (
            <TableCard
              icon={tab === "unloading" ? Truck : FileSpreadsheet}
              title={tab === "unloading" ? "Vehicle Summary" : "Loading Slip Summary"}
              subtitle={
                <span>
                  {data.breakdown.length} {tab === "unloading" ? "vehicle" : "slip"}{data.breakdown.length === 1 ? "" : "s"} for {data.date}
                </span>
              }
              className="rounded-xl border-gray-300 shadow-none"
            >
              <div className={tableBoxClass}>
              <DataTable<ReportRow>
                className="space-y-0"
                containerClassName="rounded-none border-0"
                columns={summaryBreakdownColumns}
                data={data.breakdown}
                getRowId={(row, idx) => `${row.key}-${idx}`}
                emptyState="No activity for this date"
                enableZebraStripes
                enableTotalsRow
                totalsLabel="TOTAL"
                totalsLabelColumnId="label"
                enableColumnResizing
                showMobileSwipeHint
                isStickyHeader
                maxHeight="420px"
                headerClassName={REPORT_TABLE_HEADER_CLASS}
              />
              </div>
              <div className={cardBoxClass}>
                <ReportRowCards rows={data.breakdown} tab={tab} onOpen={(row) => openRow(row, "items")} />
              </div>
            </TableCard>
          ) : effectiveReportTab === "summary" && tab === "scan" ? (
            <TableCard
              icon={FileSpreadsheet}
              title="Total Summary Report"
              subtitle={`${data.itemTotals?.length ?? 0} merged item${(data.itemTotals?.length ?? 0) === 1 ? "" : "s"} across all CSVs for ${data.date}`}
              className="rounded-xl border-gray-300 shadow-none"
              headerActions={<DownloadMenu onExport={handleExportSummaryReport} />}
            >
              <div className={tableBoxClass}>
                <DataTable<ItemTotal>
                  className="space-y-0"
                  containerClassName="rounded-none border-0"
                  columns={summaryColumns}
                  data={data.itemTotals ?? []}
                  getRowId={(row) => row.barcode}
                  emptyState={data.itemTotals === undefined ? "Not available yet for this operation" : "No items for this date"}
                  enableZebraStripes
                  enableTotalsRow
                  totalsLabel="TOTAL"
                  totalsLabelColumnId="itemName"
                  enableColumnResizing
                  showMobileSwipeHint
                  isStickyHeader
                  maxHeight="420px"
                  headerClassName={REPORT_TABLE_HEADER_CLASS}
                />
              </div>
              <div className={`space-y-2 p-3 ${cardBoxClass}`}>
                {(data.itemTotals ?? []).map((item) => (
                  <div key={item.barcode} className="rounded-lg border border-gray-200 p-3">
                    <p className="text-base font-semibold text-gray-900">{item.itemName || "—"}</p>
                    <p className="mt-1 break-all font-mono text-sm text-gray-500">{item.barcode}</p>
                    <div className="mt-2 grid grid-cols-2 gap-x-3 gap-y-1.5 text-sm text-gray-600">
                      <span>Expected: <strong className="text-base text-gray-900">{item.expectedQty}</strong></span>
                      <span>Received: <strong className="text-base text-emerald-600">{receivedIncludingExtra(item)}</strong></span>
                      <span>Extra: <strong className="text-base text-amber-600">{item.extraQty}</strong></span>
                      <span>Expected Pallets: <strong className="text-base text-gray-900">{(item.expectedPallets ?? 0).toFixed(2)}</strong></span>
                      <span className="col-span-2">Received Pallets: <strong className="text-base text-[#001d6e]">{item.pallets.toFixed(2)}</strong></span>
                    </div>
                  </div>
                ))}
              </div>
            </TableCard>
          ) : effectiveReportTab === "activities" && tab === "scan" ? (
            <TableCard
              icon={ListChecks}
              title="Activities Report"
              subtitle={`${data.activities?.length ?? 0} merged events across all CSVs for ${data.date}`}
              className="rounded-xl shadow-none border-gray-300"
              headerActions={<DownloadMenu onExport={handleExportActivitiesReport} />}
            >
              <div className={tableBoxClass}>
                <DataTable<Activity>
                rowClassName={voidedRowClass}
                  className="space-y-0"
                  containerClassName="rounded-none border-0"
                  columns={activitiesColumns}
                  data={data.activities ?? []}
                  getRowId={(_row, idx) => String(idx)}
                  emptyState={data.activities === undefined ? "Not available yet for this operation" : "No scans for this date"}
                  enableZebraStripes
                  enableColumnResizing
                  showMobileSwipeHint
                  isStickyHeader
                  maxHeight="420px"
                  headerClassName={REPORT_TABLE_HEADER_CLASS}
                />
              </div>
              <div className={`space-y-2 p-3 ${cardBoxClass}`}>
                {(data.activities ?? []).map((activity, index) => (
                  <div key={`${activity.barcode}-${index}`} className={`rounded-lg border p-3 text-sm ${activity.voided ? "border-red-200 bg-red-50/60 text-gray-400" : "border-gray-200"}`}>
                    <div className="flex justify-between gap-3">
                      <span className={activity.voided ? "text-base font-semibold text-gray-400" : "text-base font-semibold text-gray-900"}>{activity.itemName || "—"}<VoidedBadge a={activity} /></span>
                      <span className={activity.voided ? "text-lg font-bold text-gray-400 line-through" : "text-lg font-bold text-emerald-600"}>{activity.qty}</span>
                    </div>
                    <p className="mt-1 break-all font-mono text-gray-500">{activity.barcode}</p>
                    <p className="mt-1 text-gray-500">{fmtIST(activity.scannedAt)} · {activity.scannedByName || "—"}</p>
                  </div>
                ))}
              </div>
            </TableCard>
          ) : effectiveReportTab === "activities" ? (
            <TableCard
              icon={ListChecks}
              title="Activities Report"
              subtitle={`${data.breakdown.length} ${tab === "unloading" ? "vehicle" : tab === "loading" ? "slip" : "CSV"}${data.breakdown.length === 1 ? "" : "s"}`}
              className="rounded-xl shadow-none border-gray-300"
            >
              <div className={tableBoxClass}>
              <DataTable<ReportRow>
                className="space-y-0"
                containerClassName="rounded-none border-0"
                columns={activitiesBreakdownColumns}
                data={data.breakdown}
                getRowId={(row, idx) => `${row.key}-${idx}`}
                emptyState="No activity for this date"
                enableZebraStripes
                enableColumnResizing
                showMobileSwipeHint
                headerClassName={REPORT_TABLE_HEADER_CLASS}
              />
              </div>
              <div className={cardBoxClass}>
                <ReportRowCards rows={data.breakdown} tab={tab} onOpen={(row) => openRow(row, "activities")} />
              </div>
            </TableCard>
          ) : (
            <TableCard
              icon={Truck}
              title={`${activeTab.breakdownLabel} Breakdown`}
              subtitle={`${data.breakdown.length} row${data.breakdown.length === 1 ? "" : "s"}`}
              className="rounded-xl shadow-none border-gray-300"
            >
              <div className={tableBoxClass}>
              <DataTable<ReportRow>
                className="space-y-0"
                containerClassName="rounded-none border-0"
                columns={activitiesBreakdownColumns}
                data={data.breakdown}
                getRowId={(row, idx) => `${row.key}-${idx}`}
                emptyState="No activity for this date"
                enableZebraStripes
                enableColumnResizing
                showMobileSwipeHint
                headerClassName={REPORT_TABLE_HEADER_CLASS}
              />
              </div>
              <div className={cardBoxClass}>
                <ReportRowCards rows={data.breakdown} tab={tab} onOpen={(row) => openRow(row, "activities")} />
              </div>
            </TableCard>
          )}
        </>
      ) : null}

      <VehicleDetailDialog date={date} plant={openPlant} vehicle={openVehicle} initialTab={openDetailTab} onClose={() => setOpenVehicle(null)} />
      <LoadingSlipDetailDialog date={date} order={openOrder} initialTab={openDetailTab} onClose={() => setOpenOrder(null)} />
      <CsvDetailDialog date={date} plant={openPlant} csv={openCsv} initialTab={openDetailTab} onClose={() => setOpenCsv(null)} />
    </div>
  );
}

// The item list / activity list inside a View popup. On a phone the wide tables forced sideways
// scrolling (and a scroll box inside the popup's own scroll, which swallowed touch scrolling), so
// small screens get plain cards that fit the width and scroll with the popup; wider screens keep
// the tables.
function DetailLists({ detailTab, itemTotals, activities, maxHeight }: { detailTab: "items" | "activities"; itemTotals: ItemTotal[]; activities: Activity[]; maxHeight: string }) {
  const isMobile = useIsMobile();
  if (isMobile) {
    if (detailTab === "items") {
      if (itemTotals.length === 0) return <p className="py-6 text-center text-sm text-gray-400">No items</p>;
      return (
        <div className="space-y-2">
          {itemTotals.map((item) => (
            <div key={item.barcode} className="rounded-lg border border-gray-200 px-3 py-2">
              <p className="text-sm font-semibold leading-snug text-gray-900">
                {item.srNo && <span className="mr-1.5 rounded bg-gray-100 px-1.5 py-0.5 text-xs font-bold text-gray-600">{item.srNo}</span>}
                {item.itemName || "—"}
              </p>
              <p className="break-all font-mono text-xs text-gray-500">{item.barcode}</p>
              <div className="mt-1.5 grid grid-cols-2 gap-x-3 gap-y-1 text-xs text-gray-600">
                <span>Expected: <strong className="text-sm text-gray-900">{item.expectedQty}</strong></span>
                <span>Received: <strong className="text-sm text-emerald-600">{receivedIncludingExtra(item)}</strong></span>
                <span>Extra: <strong className="text-sm text-amber-600">{item.extraQty}</strong></span>
                <span>Exp. Pallets: <strong className="text-sm text-gray-900">{(item.expectedPallets ?? 0).toFixed(2)}</strong></span>
                <span className="col-span-2">Received Pallets: <strong className="text-sm text-[#001d6e]">{item.pallets.toFixed(2)}</strong></span>
              </div>
            </div>
          ))}
        </div>
      );
    }
    if (activities.length === 0) return <p className="py-6 text-center text-sm text-gray-400">No scans</p>;
    return (
      <div className="space-y-2">
        {activities.map((a, index) => (
          <div key={`${a.barcode}-${index}`} className={`rounded-lg border px-3 py-2 text-xs ${a.voided ? "border-red-200 bg-red-50/60 text-gray-400" : "border-gray-200"}`}>
            <div className="flex justify-between gap-3">
              <span className={`text-sm font-semibold leading-snug ${a.voided ? "text-gray-400" : "text-gray-900"}`}>{a.itemName || "—"}<VoidedBadge a={a} /></span>
              <span className={`text-base font-bold ${a.voided ? "text-gray-400 line-through" : "text-emerald-600"}`}>{a.qty}</span>
            </div>
            <p className="break-all font-mono text-gray-500">{a.barcode}</p>
            <p className="text-gray-500">
              {fmtIST(a.scannedAt)} · {a.scannedByName || "—"}
              {a.pallets != null ? ` · ${a.pallets.toFixed(2)} pallets` : ""}
            </p>
          </div>
        ))}
      </div>
    );
  }
  return detailTab === "items" ? (
    <DataTable<ItemTotal>
      className="space-y-0"
      columns={itemTotals.some((i) => i.srNo) ? summaryColumnsForDetail : summaryColumnsForDetail.filter((c) => c.id !== "srNo")}
      data={itemTotals}
      getRowId={(row) => row.barcode}
      emptyState="No items"
      enableZebraStripes
      enableTotalsRow
      totalsLabel="TOTAL"
      totalsLabelColumnId="itemName"
      enableColumnResizing
      isStickyHeader
      maxHeight={maxHeight}
      headerClassName={REPORT_TABLE_HEADER_CLASS}
    />
  ) : (
    <DataTable<Activity>
      rowClassName={voidedRowClass}
      className="space-y-0"
      columns={activitiesColumnsForDetail}
      data={activities}
      getRowId={(_row, index) => String(index)}
      emptyState="No scans"
      enableZebraStripes
      enableColumnResizing
      isStickyHeader
      maxHeight={maxHeight}
      headerClassName={REPORT_TABLE_HEADER_CLASS}
    />
  );
}

// The drill-down behind clicking a Loading Summary slip/order.
function LoadingSlipDetailDialog({ date, order, initialTab, onClose }: { date: string; order: string | null; initialTab: "items" | "activities"; onClose: () => void }) {
  const [detailTab, setDetailTab] = useState<"items" | "activities">(initialTab);
  useEffect(() => { if (order) setDetailTab(initialTab); }, [order, initialTab]);
  const detailQuery = useQuery({
    queryKey: ["/api/daily-reports/loading/slip", date, order],
    enabled: !!order,
    queryFn: async () => {
      const res = await apiRequest("GET", `/api/daily-reports/loading/slip?date=${encodeURIComponent(date)}&order=${encodeURIComponent(order!)}`);
      if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        throw new Error(body.message ?? "Failed to load this loading slip's report");
      }
      return res.json() as Promise<LoadingSlipDetail>;
    },
  });
  const detail = detailQuery.data;

  return (
    <Dialog open={!!order} onOpenChange={(open) => { if (!open) onClose(); }}>
      <DialogContent className="flex max-h-[96vh] w-[calc(100vw-1rem)] max-w-[96vw] flex-col overflow-hidden p-4 sm:max-w-6xl sm:p-6">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2 text-[#001d6e]">
            <FileSpreadsheet className="h-5 w-5" /> {order}
          </DialogTitle>
          <DialogDescription>
            {detail?.partyName ?? ""}{detail?.vehicleNumber ? ` · ${detail.vehicleNumber}` : ""} · {detail?.plant ? <PlantBadge plant={detail.plant} className="px-2 py-0 text-[11px]" /> : ""} · {date}
          </DialogDescription>
        </DialogHeader>

        {detailQuery.isLoading ? (
          <div className="flex items-center justify-center py-10 text-gray-400"><Loader2 className="mr-2 h-4 w-4 animate-spin" /> Loading…</div>
        ) : detailQuery.isError ? (
          <p className="text-sm text-red-600">{(detailQuery.error as Error).message}</p>
        ) : detail ? (
          <div className="min-h-0 flex-1 space-y-4 overflow-y-auto overflow-x-hidden">
            <div className="grid grid-cols-2 gap-3 sm:flex sm:gap-4">
              <StatBox label="Expected" value={detail.itemTotals.reduce((sum, item) => sum + item.expectedQty, 0)} />
              <StatBox label="Received" value={detail.itemTotals.reduce((sum, item) => sum + receivedIncludingExtra(item), 0)} />
              <StatBox label="Extra" value={detail.itemTotals.reduce((sum, item) => sum + item.extraQty, 0)} />
              <StatBox label="Expected Pallets" text={detail.itemTotals.reduce((sum, item) => sum + (item.expectedPallets ?? 0), 0).toFixed(2)} />
              <StatBox label="Received Pallets" text={detail.itemTotals.reduce((sum, item) => sum + item.pallets, 0).toFixed(2)} />
            </div>
            <div className="flex items-center gap-2">
              {initialTab === "items" && (
                <Button size="sm" variant={detailTab === "items" ? "default" : "outline"} onClick={() => setDetailTab("items")}>
                  Item-wise Total ({detail.itemTotals.length})
                </Button>
              )}
              {initialTab === "activities" && (
                <Button size="sm" variant={detailTab === "activities" ? "default" : "outline"} onClick={() => setDetailTab("activities")}>
                  Activity Report ({detail.activities.length})
                </Button>
              )}
            </div>
            <DetailLists detailTab={detailTab} itemTotals={detail.itemTotals} activities={detail.activities} maxHeight="calc(100vh - 300px)" />
          </div>
        ) : null}
      </DialogContent>
    </Dialog>
  );
}

const summaryColumnsForDetail: DataTableColumn<ItemTotal>[] = [
  // Loading slips carry the proforma slip's Sr. No.; the list already arrives in that order.
  { id: "srNo", header: "Sr", width: 60, fixedWidth: true, sortable: true, totalable: false, accessor: (r) => r.srNo ?? "", cellClassName: "text-xs font-semibold text-gray-600", render: (r) => r.srNo || "—" },
  { id: "barcode", header: "Barcode", width: 150, accessor: (r) => r.barcode, totalable: false, cellClassName: "font-mono text-xs text-gray-500" },
  { id: "itemName", header: "Item", accessor: (r) => r.itemName, totalable: false, render: (r) => r.itemName || "—" },
  { id: "expectedQty", header: "Expected", align: "right", accessor: (r) => r.expectedQty },
  { id: "actualQty", header: "Received", align: "right", accessor: receivedIncludingExtra },
  { id: "extraQty", header: "Extra", align: "right", accessor: (r) => r.extraQty },
  { id: "expectedPallets", header: "Expected Pallets", align: "right", accessor: (r) => r.expectedPallets ?? 0, render: (r) => (r.expectedPallets ?? 0).toFixed(2), total: (rows) => rows.reduce((sum, r) => sum + (r.expectedPallets ?? 0), 0).toFixed(2) },
  { id: "pallets", header: "Received Pallets", align: "right", accessor: (r) => r.pallets, render: (r) => r.pallets.toFixed(2), total: (rows) => rows.reduce((sum, r) => sum + r.pallets, 0).toFixed(2) },
];

// Voided scans stay listed (so the report shows the entry existed and was cancelled) but are
// greyed out with a badge; the server already leaves them out of every total.
const voidedRowClass = (r: Activity) => (r.voided ? "bg-red-50/60 text-gray-400" : undefined);
const voidedCell = (a: Activity) => (a.voided ? `Voided${a.voidReason ? ` — ${a.voidReason}` : ""}` : "");
function VoidedBadge({ a }: { a: Activity }) {
  if (!a.voided) return null;
  return (
    <span title={a.voidReason ?? undefined} className="ml-1.5 rounded-full bg-red-100 px-1.5 py-0.5 text-[10px] font-semibold text-red-700">
      Voided
    </span>
  );
}
const qtyCellFor = (r: Activity) => (r.voided ? <span className="text-gray-400 line-through">{r.qty}</span> : r.qty);

const activitiesColumnsForDetail: DataTableColumn<Activity>[] = [
  { id: "scannedAt", header: "Time", width: 150, accessor: (r) => r.scannedAt, totalable: false, render: (r) => fmtIST(r.scannedAt) },
  { id: "barcode", header: "Barcode", width: 150, accessor: (r) => r.barcode, totalable: false, cellClassName: "font-mono text-xs text-gray-500" },
  { id: "itemName", header: "Item", accessor: (r) => r.itemName, totalable: false, render: (r) => <>{r.itemName || "—"}<VoidedBadge a={r} /></> },
  { id: "qty", header: "Qty", align: "right", accessor: (r) => r.qty, render: qtyCellFor },
  { id: "pallets", header: "Pallets", align: "right", accessor: (r) => r.pallets ?? 0, render: (r) => r.pallets?.toFixed(2) ?? "—" },
  { id: "scannedByName", header: "By", accessor: (r) => r.scannedByName, totalable: false, render: (r) => r.scannedByName || "—" },
];

// The drill-down behind clicking a vehicle in Unloading's Summary table — that vehicle's own
// Start/End time (End = when its session was actually marked Complete, not its last scan), an
// item-wise total, and the full list of its individual scan events, with its own CSV download
// separate from the main page's summary export.
function VehicleDetailDialog({ date, plant, vehicle, initialTab, onClose }: { date: string; plant: string | null; vehicle: string | null; initialTab: "items" | "activities"; onClose: () => void }) {
  const [detailTab, setDetailTab] = useState<"items" | "activities">(initialTab);
  useEffect(() => { if (vehicle) setDetailTab(initialTab); }, [vehicle, initialTab]);
  const detailQuery = useQuery({
    queryKey: ["/api/daily-reports/unloading/vehicle", date, vehicle, plant],
    enabled: !!vehicle,
    queryFn: async () => {
      const res = await apiRequest("GET", `/api/daily-reports/unloading/vehicle?date=${encodeURIComponent(date)}&vehicle=${encodeURIComponent(vehicle!)}${plant ? `&plant=${encodeURIComponent(plant)}` : ""}`);
      if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        throw new Error(body.message ?? "Failed to load this vehicle's report");
      }
      return res.json() as Promise<VehicleDetail>;
    },
  });
  const detail = detailQuery.data;

  // Downloads only whichever tab (Item-wise Total or Activity Report) is currently open, not
  // both combined — matches the tab you're actually looking at, not an "everything" file.
  const handleExport = (fmt: Fmt) => {
    if (!detail) return;
    const header: ExportRow = ["Vehicle", detail.vehicle, "Plant", detail.plant ?? ""];
    const timing: ExportRow = ["Start", fmtIST(detail.startTime), "End", fmtIST(detail.endTime), "Total Time", fmtTotalTime(detail.startTime, detail.endTime)];
    const rows: ExportRow[] = detailTab === "items"
      ? [
          header, timing, [],
          ["Barcode", "Item Name", "Expected Qty", "Received Qty", "Extra Qty", "Expected Pallets", "Received Pallets"],
          ...detail.itemTotals.map((i) => [barcodeCell(i.barcode), i.itemName ?? "", i.expectedQty, receivedIncludingExtra(i), i.extraQty, (i.expectedPallets ?? 0).toFixed(2), i.pallets.toFixed(2)]),
        ]
      : [
          header, timing, [],
          ["Time", "Barcode", "Item Name", "Qty", "Pallets", "Extra?", "Scanned By", "Voided"],
          ...detail.activities.map((a) => [fmtIST(a.scannedAt), barcodeCell(a.barcode), a.itemName ?? "", a.qty, a.pallets?.toFixed(2) ?? "", a.isExtra ? "Yes" : "No", a.scannedByName ?? "", voidedCell(a)]),
        ];
    const suffix = detailTab === "items" ? "items" : "activities";
    exportRows(fmt, `unloading-${detail.vehicle}-${suffix}-${detail.date}`, `Unloading — ${detail.vehicle} — ${detailTab === "items" ? "Item-wise Total" : "Activity Report"} — ${detail.date}`, rows);
  };

  return (
    <Dialog open={!!vehicle} onOpenChange={(open) => { if (!open) onClose(); }}>
      <DialogContent className="flex max-h-[96vh] w-[calc(100vw-1rem)] max-w-[96vw] flex-col overflow-hidden p-4 sm:max-w-6xl sm:p-6">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2 text-[#001d6e]">
            <Truck className="h-5 w-5" /> {vehicle}
          </DialogTitle>
          <DialogDescription>{detail?.plant ? <PlantBadge plant={detail.plant} className="px-2 py-0 text-[11px]" /> : ""} · {date}</DialogDescription>
        </DialogHeader>

        {detailQuery.isLoading ? (
          <div className="flex items-center justify-center py-10 text-gray-400">
            <Loader2 className="mr-2 h-4 w-4 animate-spin" /> Loading…
          </div>
        ) : detailQuery.isError ? (
          <p className="text-sm text-red-600">{(detailQuery.error as Error).message}</p>
        ) : detail ? (
          <div className="min-h-0 flex-1 space-y-4 overflow-y-auto overflow-x-hidden">
            <div className="flex items-center justify-between gap-3">
              <div className="grid grid-cols-2 gap-3 sm:flex sm:gap-4">
                <div className="rounded-xl border border-gray-100 bg-gray-50/70 px-3 py-1.5">
                  <p className="flex items-center gap-1 text-[10px] font-semibold uppercase tracking-wide text-gray-500">
                    <Clock className="h-3 w-3" /> Start
                  </p>
                  <p className="text-xs font-bold text-gray-900">{fmtIST(detail.startTime)}</p>
                </div>
                <div className="rounded-xl border border-gray-100 bg-gray-50/70 px-3 py-1.5">
                  <p className="flex items-center gap-1 text-[10px] font-semibold uppercase tracking-wide text-gray-500">
                    <Clock className="h-3 w-3" /> End
                  </p>
                  <p className="text-xs font-bold text-gray-900">{fmtIST(detail.endTime)}</p>
                </div>
                <div className="rounded-xl border border-gray-100 bg-gray-50/70 px-3 py-1.5">
                  <p className="flex items-center gap-1 text-[10px] font-semibold uppercase tracking-wide text-gray-500">
                    <Clock className="h-3 w-3" /> Total Time
                  </p>
                  <p className="text-xs font-bold text-gray-900">{fmtTotalTime(detail.startTime, detail.endTime)}</p>
                </div>
              </div>
              <DownloadMenu onExport={handleExport} formats={["CSV", "PDF"]} />
            </div>

            <div className="flex items-center gap-2">
              {initialTab === "items" && (
                <button
                  type="button"
                  onClick={() => setDetailTab("items")}
                  className={
                    detailTab === "items"
                      ? "rounded-full bg-[#001d6e] px-3 py-1 text-xs font-semibold text-white ring-2 ring-[#001d6e]/30"
                      : "rounded-full border border-gray-200 bg-white px-3 py-1 text-xs font-medium text-gray-600 hover:bg-gray-50"
                  }
                >
                  Item-wise Total ({detail.itemTotals.length})
                </button>
              )}
              {initialTab === "activities" && <button
                type="button"
                onClick={() => setDetailTab("activities")}
                className={
                  detailTab === "activities"
                    ? "rounded-full bg-[#001d6e] px-3 py-1 text-xs font-semibold text-white ring-2 ring-[#001d6e]/30"
                    : "rounded-full border border-gray-200 bg-white px-3 py-1 text-xs font-medium text-gray-600 hover:bg-gray-50"
                }
              >
                Activity Report ({detail.activities.length})
              </button>}
            </div>

            <DetailLists detailTab={detailTab} itemTotals={detail.itemTotals} activities={detail.activities} maxHeight="16rem" />
          </div>
        ) : null}
      </DialogContent>
    </Dialog>
  );
}

// The drill-down behind clicking a CSV/order in Scan Operations' breakdown table — the Scan
// equivalent of VehicleDetailDialog above (Order Scan has no vehicle concept, so this groups by
// CSV/session instead), with its own Start/End, item-wise total, and activity report (including
// Pallets/STV per event, which Scan's events actually carry).
function CsvDetailDialog({ date, plant, csv, initialTab, onClose }: { date: string; plant: string | null; csv: string | null; initialTab: "items" | "activities"; onClose: () => void }) {
  const [detailTab, setDetailTab] = useState<"items" | "activities">(initialTab);
  useEffect(() => { if (csv) setDetailTab(initialTab); }, [csv, initialTab]);
  const detailQuery = useQuery({
    queryKey: ["/api/daily-reports/scan/csv", date, csv, plant],
    enabled: !!csv,
    queryFn: async () => {
      const res = await apiRequest("GET", `/api/daily-reports/scan/csv?date=${encodeURIComponent(date)}&csv=${encodeURIComponent(csv!)}${plant ? `&plant=${encodeURIComponent(plant)}` : ""}`);
      if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        throw new Error(body.message ?? "Failed to load this CSV's report");
      }
      return res.json() as Promise<CsvDetail>;
    },
  });
  const detail = detailQuery.data;

  // Downloads only whichever tab (Item-wise Total or Activity Report) is currently open, not
  // both combined — matches the tab you're actually looking at, not an "everything" file.
  const handleExport = (fmt: Fmt) => {
    if (!detail) return;
    const header: ExportRow = ["CSV / Order", detail.csv, "Plant", detail.plant ?? ""];
    const timing: ExportRow = ["Start", fmtIST(detail.startTime), "End", fmtIST(detail.endTime), "Total Time", fmtTotalTime(detail.startTime, detail.endTime)];
    const rows: ExportRow[] = detailTab === "items"
      ? [
          header, timing, [],
          ["Barcode", "Item Name", "Expected Qty", "Received Qty", "Extra Qty", "Expected Pallets", "Received Pallets"],
          ...detail.itemTotals.map((i) => [barcodeCell(i.barcode), i.itemName ?? "", i.expectedQty, receivedIncludingExtra(i), i.extraQty, (i.expectedPallets ?? 0).toFixed(2), i.pallets.toFixed(2)]),
        ]
      : [
          header, timing, [],
          ["Time", "Barcode", "Item Name", "Qty", "Pallets", "STV", "Extra?", "Scanned By", "Voided"],
          ...detail.activities.map((a) => [
            fmtIST(a.scannedAt), barcodeCell(a.barcode), a.itemName ?? "", a.qty, a.pallets?.toFixed(2) ?? "", a.stv ?? "",
            a.isExtra ? "Yes" : "No", a.scannedByName ?? "", voidedCell(a),
          ]),
        ];
    const suffix = detailTab === "items" ? "items" : "activities";
    exportRows(fmt, `scan-${detail.csv}-${suffix}-${detail.date}`, `Scan Operations — ${detail.csv} — ${detailTab === "items" ? "Item-wise Total" : "Activity Report"} — ${detail.date}`, rows);
  };

  return (
    <Dialog open={!!csv} onOpenChange={(open) => { if (!open) onClose(); }}>
      <DialogContent className="flex max-h-[96vh] w-[calc(100vw-1rem)] max-w-[96vw] flex-col overflow-hidden p-4 sm:max-w-6xl sm:p-6">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2 text-[#001d6e]">
            <FileSpreadsheet className="h-5 w-5" /> {csv}
          </DialogTitle>
          <DialogDescription>{detail?.plant ? <PlantBadge plant={detail.plant} className="px-2 py-0 text-[11px]" /> : ""} · {date}</DialogDescription>
        </DialogHeader>

        {detailQuery.isLoading ? (
          <div className="flex items-center justify-center py-10 text-gray-400">
            <Loader2 className="mr-2 h-4 w-4 animate-spin" /> Loading…
          </div>
        ) : detailQuery.isError ? (
          <p className="text-sm text-red-600">{(detailQuery.error as Error).message}</p>
        ) : detail ? (
          <div className="min-h-0 flex-1 space-y-4 overflow-y-auto overflow-x-hidden">
            <div className="flex items-center justify-between gap-3">
              <div className="grid grid-cols-2 gap-3 sm:flex sm:gap-4">
                <div className="rounded-xl border border-gray-100 bg-gray-50/70 px-3 py-1.5">
                  <p className="flex items-center gap-1 text-[10px] font-semibold uppercase tracking-wide text-gray-500">
                    <Clock className="h-3 w-3" /> Start
                  </p>
                  <p className="text-xs font-bold text-gray-900">{fmtIST(detail.startTime)}</p>
                </div>
                <div className="rounded-xl border border-gray-100 bg-gray-50/70 px-3 py-1.5">
                  <p className="flex items-center gap-1 text-[10px] font-semibold uppercase tracking-wide text-gray-500">
                    <Clock className="h-3 w-3" /> End
                  </p>
                  <p className="text-xs font-bold text-gray-900">{fmtIST(detail.endTime)}</p>
                </div>
                <div className="rounded-xl border border-gray-100 bg-gray-50/70 px-3 py-1.5">
                  <p className="flex items-center gap-1 text-[10px] font-semibold uppercase tracking-wide text-gray-500">
                    <Clock className="h-3 w-3" /> Total Time
                  </p>
                  <p className="text-xs font-bold text-gray-900">{fmtTotalTime(detail.startTime, detail.endTime)}</p>
                </div>
              </div>
              <DownloadMenu onExport={handleExport} formats={["CSV", "PDF"]} />
            </div>

            <div className="flex items-center gap-2">
              {/* Both tabs, whichever way the popup was opened — the CSV's item list AND its activities
                  live behind the one View button. */}
              <button
                type="button"
                onClick={() => setDetailTab("items")}
                className={
                  detailTab === "items"
                    ? "rounded-full bg-[#001d6e] px-3 py-1 text-xs font-semibold text-white ring-2 ring-[#001d6e]/30"
                    : "rounded-full border border-gray-200 bg-white px-3 py-1 text-xs font-medium text-gray-600 hover:bg-gray-50"
                }
              >
                Item-wise Total ({detail.itemTotals.length})
              </button>
              <button
                type="button"
                onClick={() => setDetailTab("activities")}
                className={
                  detailTab === "activities"
                    ? "rounded-full bg-[#001d6e] px-3 py-1 text-xs font-semibold text-white ring-2 ring-[#001d6e]/30"
                    : "rounded-full border border-gray-200 bg-white px-3 py-1 text-xs font-medium text-gray-600 hover:bg-gray-50"
                }
              >
                Activity Report ({detail.activities.length})
              </button>
            </div>

            <DetailLists detailTab={detailTab} itemTotals={detail.itemTotals} activities={detail.activities} maxHeight="16rem" />
          </div>
        ) : null}
      </DialogContent>
    </Dialog>
  );
}

function ReportRowCards({ rows, tab, onOpen }: { rows: ReportRow[]; tab: Tab; onOpen: (row: ReportRow) => void }) {
  if (rows.length === 0) return <p className="py-10 text-center text-sm text-gray-400">No activity for this date</p>;
  const identityLabel = tab === "unloading" ? "Vehicle" : tab === "loading" ? "Slip / Order" : "CSV / Order";
  return (
    <div className="space-y-2 p-3">
      {rows.map((row, index) => (
        <div
          key={`${row.key}-${index}`}
          className="block w-full rounded-lg border border-gray-200 bg-white px-3 py-2 text-left shadow-sm"
        >
          <div className="flex min-w-0 items-center justify-between gap-3">
            <div className="min-w-0">
              <span className="block truncate text-sm font-bold text-[#001d6e]">{row.label}</span>
              <span className="text-[11px] leading-none text-gray-500">{identityLabel}</span>
            </div>
            {row.key !== "—" && (
              <Button type="button" size="sm" variant="outline" className="h-7 shrink-0 gap-1 px-2.5 text-xs" onClick={() => onOpen(row)}>
                <Eye className="h-3.5 w-3.5" /> View
              </Button>
            )}
          </div>
          <div className="mt-1.5 grid grid-cols-3 items-center gap-x-2 gap-y-1 text-xs text-gray-600">
            <span className="flex items-center">{row.plant ? <PlantBadge plant={row.plant} className="px-1.5 py-0 text-[11px]" /> : <strong className="text-gray-900">—</strong>}</span>
            <span>Orders: <strong className="text-sm text-gray-900">{row.orderCount}</strong></span>
            <span>Events: <strong className="text-sm text-gray-900">{row.eventCount}</strong></span>
            <span>Expected: <strong className="text-sm text-gray-900">{row.expectedQty.toLocaleString()}</strong></span>
            <span className="col-span-2">Received: <strong className="text-sm text-emerald-600">{row.actualQty.toLocaleString()}</strong></span>
            <span className="col-span-3 flex flex-wrap gap-x-4">
              <span>Start: <strong className="text-gray-900">{fmtIST(row.startTime)}</strong></span>
              <span>End: <strong className="text-gray-900">{fmtIST(row.endTime)}</strong></span>
            </span>
          </div>
        </div>
      ))}
    </div>
  );
}

function StatBox({ label, value, text, title }: { label: string; value?: number; text?: string; title?: string }) {
  return (
    <div className="rounded-lg border border-gray-100 bg-gray-50/70 px-2.5 py-1.5">
      <p className="text-[10px] font-semibold uppercase tracking-wide text-gray-500">{label}</p>
      <p title={title} className={`mt-0.5 font-bold tabular-nums text-gray-900 ${text !== undefined ? "text-xs" : "whitespace-nowrap text-base"}`}>
        {text ?? value!.toLocaleString()}
      </p>
    </div>
  );
}
