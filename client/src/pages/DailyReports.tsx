import { useEffect, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { apiRequest } from "@/lib/queryClient";
import { usePersistentFilter } from "@/hooks/usePersistentFilter";
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
  Package, ListChecks, CalendarClock, FileSpreadsheet,
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
};
type ItemTotal = { barcode: string; itemName: string | null; expectedQty: number; actualQty: number; extraQty: number; pallets: number };
type Activity = {
  barcode: string; itemName: string | null; qty: number; pallets?: number; stv?: string | null;
  isExtra: boolean; scannedByName: string | null; scannedAt: string;
  groupKey?: string | null; groupLabel?: string | null;
};
type ReportData = {
  date: string;
  totalSummary: { orderCount: number; expectedQty: number; actualQty: number; vehicleCount: number };
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
function DownloadMenu({ onExport }: { onExport: (fmt: Fmt) => void }) {
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button variant="outline" size="sm" className="h-7 px-2" title="Download">
          <Download className="h-3.5 w-3.5" /> <ChevronDown className="ml-1 h-3 w-3" />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end">
        <DropdownMenuItem onClick={() => onExport("CSV")}>CSV</DropdownMenuItem>
        <DropdownMenuItem onClick={() => onExport("Excel")}>Excel</DropdownMenuItem>
        <DropdownMenuItem onClick={() => onExport("PDF")}>PDF</DropdownMenuItem>
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

export default function DailyReports() {
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
      (acc, i) => ({ expectedQty: acc.expectedQty + i.expectedQty, actualQty: acc.actualQty + i.actualQty, extraQty: acc.extraQty + i.extraQty, pallets: acc.pallets + i.pallets }),
      { expectedQty: 0, actualQty: 0, extraQty: 0, pallets: 0 },
    );
    const rows: ExportRow[] = [
      ["Start", fmtIST(data.activitySummary.startTime), "End", fmtIST(data.activitySummary.endTime)],
      [],
      ["Barcode", "Item Name", "Expected Qty", "Actual Qty", "Extra Qty", "Pallets"],
      ...data.itemTotals.map((i) => [barcodeCell(i.barcode), i.itemName ?? "", i.expectedQty, i.actualQty, i.extraQty, i.pallets.toFixed(2)]),
      ["TOTAL", "", totals.expectedQty, totals.actualQty, totals.extraQty, totals.pallets.toFixed(2)],
    ];
    exportRows(fmt, `${tab}-summary-report-${data.date}`, `${activeTab.label} — Total Summary Report — ${data.date}`, rows);
  };

  const handleExportActivitiesReport = (fmt: Fmt) => {
    if (!data?.activities) return;
    const rows: ExportRow[] = [
      ["Start", fmtIST(data.activitySummary.startTime), "End", fmtIST(data.activitySummary.endTime)],
      [],
      ["Time", "Barcode", "Item Name", "Qty", "Pallets", "STV", "Extra?", "Scanned By"],
      ...data.activities.map((a) => [
        fmtIST(a.scannedAt), barcodeCell(a.barcode), a.itemName ?? "", a.qty, a.pallets?.toFixed(2) ?? "", a.stv ?? "",
        a.isExtra ? "Yes" : "No", a.scannedByName ?? "",
      ]),
    ];
    exportRows(fmt, `${tab}-activities-report-${data.date}`, `${activeTab.label} — Activities Report — ${data.date}`, rows);
  };

  const summaryTotals = data?.itemTotals?.reduce(
    (acc, i) => ({ expectedQty: acc.expectedQty + i.expectedQty, actualQty: acc.actualQty + i.actualQty, extraQty: acc.extraQty + i.extraQty, pallets: acc.pallets + i.pallets }),
    { expectedQty: 0, actualQty: 0, extraQty: 0, pallets: 0 },
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
    { id: "actualQty", header: "Actual", align: "right", accessor: (r) => r.actualQty, cellClassName: "tabular-nums font-medium text-emerald-600" },
    {
      id: "extraQty", header: "Extra", align: "right", accessor: (r) => r.extraQty,
      render: (r) => <span className={r.extraQty > 0 ? "font-medium text-amber-600" : "text-gray-400"}>{r.extraQty}</span>,
    },
    { id: "pallets", header: "Pallets", align: "right", accessor: (r) => r.pallets, cellClassName: "tabular-nums text-[#001d6e]", render: (r) => r.pallets.toFixed(2) },
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
          {r.isExtra && <span className="ml-1.5 rounded-full bg-amber-100 px-1.5 py-0.5 text-[10px] font-semibold text-amber-700">Extra</span>}
        </>
      ),
    },
    { id: "qty", header: "Qty", align: "right", accessor: (r) => r.qty, cellClassName: "tabular-nums font-medium text-emerald-600" },
    { id: "pallets", header: "Pallets", align: "right", accessor: (r) => r.pallets ?? null, cellClassName: "tabular-nums text-[#001d6e]", render: (r) => r.pallets?.toFixed(2) ?? "—" },
    { id: "stv", header: "STV", width: 100, accessor: (r) => r.stv, totalable: false, cellClassName: "text-gray-500", render: (r) => r.stv || "—" },
    { id: "scannedByName", header: "By", width: 140, accessor: (r) => r.scannedByName, totalable: false, cellClassName: "text-gray-500", render: (r) => r.scannedByName || "—" },
  ];

  const breakdownColumns: DataTableColumn<ReportRow>[] = [
    {
      id: "label", header: activeTab.breakdownLabel, accessor: (r) => r.label, totalable: false,
      cellClassName: "font-medium text-gray-900",
      render: (r) => {
        const clickable = (tab === "loading" || tab === "unloading" || tab === "scan") && r.key !== "—";
        return clickable ? <span className="text-[#001d6e] underline decoration-dotted">{r.label}</span> : r.label;
      },
    },
    { id: "plant", header: "Plant", width: 120, accessor: (r) => r.plant, totalable: false, render: (r) => r.plant ?? "—" },
    { id: "orderCount", header: "Orders", align: "right", accessor: (r) => r.orderCount, cellClassName: "tabular-nums" },
    { id: "expectedQty", header: "Expected", align: "right", accessor: (r) => r.expectedQty, cellClassName: "tabular-nums text-gray-700" },
    { id: "actualQty", header: "Actual", align: "right", accessor: (r) => r.actualQty, cellClassName: "tabular-nums font-medium text-emerald-600" },
    { id: "eventCount", header: "Events", align: "right", accessor: (r) => r.eventCount, cellClassName: "tabular-nums" },
    { id: "startTime", header: "Start", width: 140, accessor: (r) => r.startTime, totalable: false, cellClassName: "whitespace-nowrap text-xs text-gray-500", render: (r) => fmtIST(r.startTime) },
    { id: "endTime", header: "End", width: 140, accessor: (r) => r.endTime, totalable: false, cellClassName: "whitespace-nowrap text-xs text-gray-500", render: (r) => fmtIST(r.endTime) },
  ];

  return (
    <div className="container-fluid max-w-full space-y-5 overflow-x-hidden px-3 py-6 sm:px-4 md:px-6">
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
          <div className="grid gap-3 lg:grid-cols-2">
            <Card className="border-gray-200 shadow-sm">
              <CardContent className="p-3">
                <p className="mb-2 flex items-center gap-1.5 text-xs font-semibold uppercase tracking-wide text-gray-500">
                  <SectionIcon icon={Package} /> Total Summary
                </p>
                <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
                  <StatBox label="Orders" value={data.totalSummary.orderCount} />
                  <StatBox label={activeTab.key === "scan" ? "CSVs" : activeTab.key === "loading" ? "Slips" : "Vehicles"} value={data.totalSummary.vehicleCount} />
                  <StatBox label="Expected" value={data.totalSummary.expectedQty} />
                  <StatBox label="Actual" value={data.totalSummary.actualQty} />
                </div>
              </CardContent>
            </Card>
            <Card className="border-gray-200 shadow-sm">
              <CardContent className="p-3">
                <p className="mb-2 flex items-center gap-1.5 text-xs font-semibold uppercase tracking-wide text-gray-500">
                  <SectionIcon icon={CalendarClock} /> Activities Summary
                </p>
                <div className="grid grid-cols-3 gap-2">
                  <StatBox label="Events" value={data.activitySummary.eventCount} />
                  <StatBox label="Start Time" text={fmtIST(data.activitySummary.startTime)} />
                  <StatBox label="End Time" text={fmtIST(data.activitySummary.endTime)} />
                </div>
              </CardContent>
            </Card>
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
              <div className="hidden md:block">
              <DataTable<ReportRow>
                className="space-y-0"
                containerClassName="rounded-none border-0"
                columns={breakdownColumns}
                data={data.breakdown}
                getRowId={(row, idx) => `${row.key}-${idx}`}
                emptyState="No activity for this date"
                onRowClick={(row) => {
                  setOpenDetailTab("items");
                  if (tab === "unloading") setOpenVehicle(row.key);
                  else setOpenOrder(row.key);
                }}
                isRowClickable={() => true}
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
              <div className="md:hidden">
                <ReportRowCards rows={data.breakdown} tab={tab} onRowClick={(row) => {
                  setOpenDetailTab("items");
                  if (tab === "unloading") setOpenVehicle(row.key); else setOpenOrder(row.key);
                }} />
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
              <div className="hidden md:block">
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
              <div className="space-y-2 p-3 md:hidden">
                {(data.itemTotals ?? []).map((item) => (
                  <div key={item.barcode} className="rounded-lg border border-gray-200 p-3 text-sm">
                    <p className="font-medium text-gray-900">{item.itemName || "—"}</p>
                    <p className="mt-1 break-all font-mono text-xs text-gray-500">{item.barcode}</p>
                    <div className="mt-2 grid grid-cols-2 gap-1 text-xs text-gray-600">
                      <span>Expected: <strong>{item.expectedQty}</strong></span>
                      <span>Actual: <strong className="text-emerald-600">{item.actualQty}</strong></span>
                      <span>Extra: <strong className="text-amber-600">{item.extraQty}</strong></span>
                      <span>Pallets: <strong>{item.pallets.toFixed(2)}</strong></span>
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
              <div className="hidden md:block">
                <DataTable<Activity>
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
              <div className="space-y-2 p-3 md:hidden">
                {(data.activities ?? []).map((activity, index) => (
                  <div key={`${activity.barcode}-${index}`} className="rounded-lg border border-gray-200 p-3 text-xs">
                    <div className="flex justify-between gap-3">
                      <span className="font-medium text-gray-900">{activity.itemName || "—"}</span>
                      <span className="font-semibold text-emerald-600">{activity.qty}</span>
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
              <div className="hidden md:block">
              <DataTable<ReportRow>
                className="space-y-0"
                containerClassName="rounded-none border-0"
                columns={breakdownColumns}
                data={data.breakdown}
                getRowId={(row, idx) => `${row.key}-${idx}`}
                emptyState="No activity for this date"
                onRowClick={(row) => {
                  setOpenDetailTab("activities");
                  if (tab === "unloading") setOpenVehicle(row.key);
                  else if (tab === "loading") setOpenOrder(row.key);
                  else setOpenCsv(row.key);
                }}
                isRowClickable={() => true}
                enableZebraStripes
                enableColumnResizing
                showMobileSwipeHint
                headerClassName={REPORT_TABLE_HEADER_CLASS}
              />
              </div>
              <div className="md:hidden">
                <ReportRowCards rows={data.breakdown} tab={tab} onRowClick={(row) => {
                  setOpenDetailTab("activities");
                  if (tab === "unloading") setOpenVehicle(row.key);
                  else if (tab === "loading") setOpenOrder(row.key); else setOpenCsv(row.key);
                }} />
              </div>
            </TableCard>
          ) : (
            <TableCard
              icon={Truck}
              title={`${activeTab.breakdownLabel} Breakdown`}
              subtitle={`${data.breakdown.length} row${data.breakdown.length === 1 ? "" : "s"}`}
              className="rounded-xl shadow-none border-gray-300"
            >
              <div className="hidden md:block">
              <DataTable<ReportRow>
                className="space-y-0"
                containerClassName="rounded-none border-0"
                columns={breakdownColumns}
                data={data.breakdown}
                getRowId={(row, idx) => `${row.key}-${idx}`}
                emptyState="No activity for this date"
                onRowClick={(row) => {
                  if (row.key === "—") return;
                  if (tab === "scan") setOpenCsv(row.key);
                }}
                isRowClickable={(row) => tab === "scan" && row.key !== "—"}
                enableZebraStripes
                enableColumnResizing
                showMobileSwipeHint
                headerClassName={REPORT_TABLE_HEADER_CLASS}
              />
              </div>
              <div className="md:hidden">
                <ReportRowCards rows={data.breakdown} tab={tab} onRowClick={(row) => {
                  if (tab === "scan") { setOpenDetailTab("activities"); setOpenCsv(row.key); }
                }} />
              </div>
            </TableCard>
          )}
        </>
      ) : null}

      <VehicleDetailDialog date={date} vehicle={openVehicle} initialTab={openDetailTab} onClose={() => setOpenVehicle(null)} />
      <LoadingSlipDetailDialog date={date} order={openOrder} initialTab={openDetailTab} onClose={() => setOpenOrder(null)} />
      <CsvDetailDialog date={date} csv={openCsv} initialTab={openDetailTab} onClose={() => setOpenCsv(null)} />
    </div>
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
            {detail?.partyName ?? ""}{detail?.vehicleNumber ? ` · ${detail.vehicleNumber}` : ""} · {detail?.plant ?? ""} · {date}
          </DialogDescription>
        </DialogHeader>

        {detailQuery.isLoading ? (
          <div className="flex items-center justify-center py-10 text-gray-400"><Loader2 className="mr-2 h-4 w-4 animate-spin" /> Loading…</div>
        ) : detailQuery.isError ? (
          <p className="text-sm text-red-600">{(detailQuery.error as Error).message}</p>
        ) : detail ? (
          <div className="space-y-4">
            <div className="grid grid-cols-2 gap-3 sm:flex sm:gap-4">
              <StatBox label="Expected" value={detail.itemTotals.reduce((sum, item) => sum + item.expectedQty, 0)} />
              <StatBox label="Received" value={detail.itemTotals.reduce((sum, item) => sum + item.actualQty, 0)} />
              <StatBox label="Extra" value={detail.itemTotals.reduce((sum, item) => sum + item.extraQty, 0)} />
              <StatBox label="Pallets" text={detail.itemTotals.reduce((sum, item) => sum + item.pallets, 0).toFixed(2)} />
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
            {detailTab === "items" ? (
              <DataTable<ItemTotal>
                columns={summaryColumnsForDetail}
                data={detail.itemTotals}
                getRowId={(row) => row.barcode}
                enableZebraStripes
                enableTotalsRow
                totalsLabel="TOTAL"
                totalsLabelColumnId="itemName"
                emptyState="No items"
                headerClassName={REPORT_TABLE_HEADER_CLASS}
                maxHeight="calc(100vh - 300px)"
              />
            ) : (
              <DataTable<Activity>
                columns={activitiesColumnsForDetail}
                data={detail.activities}
                getRowId={(_row, idx) => String(idx)}
                enableZebraStripes
                emptyState="No scans"
                headerClassName={REPORT_TABLE_HEADER_CLASS}
                maxHeight="calc(100vh - 300px)"
              />
            )}
          </div>
        ) : null}
      </DialogContent>
    </Dialog>
  );
}

const summaryColumnsForDetail: DataTableColumn<ItemTotal>[] = [
  { id: "barcode", header: "Barcode", width: 150, accessor: (r) => r.barcode, totalable: false, cellClassName: "font-mono text-xs text-gray-500" },
  { id: "itemName", header: "Item", accessor: (r) => r.itemName, totalable: false, render: (r) => r.itemName || "—" },
  { id: "expectedQty", header: "Expected", align: "right", accessor: (r) => r.expectedQty },
  { id: "actualQty", header: "Received", align: "right", accessor: (r) => r.actualQty },
  { id: "extraQty", header: "Extra", align: "right", accessor: (r) => r.extraQty },
  { id: "pallets", header: "Pallets", align: "right", accessor: (r) => r.pallets, render: (r) => r.pallets.toFixed(2) },
];

const activitiesColumnsForDetail: DataTableColumn<Activity>[] = [
  { id: "scannedAt", header: "Time", width: 150, accessor: (r) => r.scannedAt, totalable: false, render: (r) => fmtIST(r.scannedAt) },
  { id: "barcode", header: "Barcode", width: 150, accessor: (r) => r.barcode, totalable: false, cellClassName: "font-mono text-xs text-gray-500" },
  { id: "itemName", header: "Item", accessor: (r) => r.itemName, totalable: false, render: (r) => r.itemName || "—" },
  { id: "qty", header: "Qty", align: "right", accessor: (r) => r.qty },
  { id: "pallets", header: "Pallets", align: "right", accessor: (r) => r.pallets ?? 0, render: (r) => r.pallets?.toFixed(2) ?? "—" },
  { id: "scannedByName", header: "By", accessor: (r) => r.scannedByName, totalable: false, render: (r) => r.scannedByName || "—" },
];

// The drill-down behind clicking a vehicle in Unloading's Summary table — that vehicle's own
// Start/End time (End = when its session was actually marked Complete, not its last scan), an
// item-wise total, and the full list of its individual scan events, with its own CSV download
// separate from the main page's summary export.
function VehicleDetailDialog({ date, vehicle, initialTab, onClose }: { date: string; vehicle: string | null; initialTab: "items" | "activities"; onClose: () => void }) {
  const [detailTab, setDetailTab] = useState<"items" | "activities">(initialTab);
  useEffect(() => { if (vehicle) setDetailTab(initialTab); }, [vehicle, initialTab]);
  const detailQuery = useQuery({
    queryKey: ["/api/daily-reports/unloading/vehicle", date, vehicle],
    enabled: !!vehicle,
    queryFn: async () => {
      const res = await apiRequest("GET", `/api/daily-reports/unloading/vehicle?date=${encodeURIComponent(date)}&vehicle=${encodeURIComponent(vehicle!)}`);
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
    const timing: ExportRow = ["Start", fmtIST(detail.startTime), "End", fmtIST(detail.endTime)];
    const rows: ExportRow[] = detailTab === "items"
      ? [
          header, timing, [],
          ["Barcode", "Item Name", "Expected Qty", "Actual Qty", "Extra Qty", "Pallets"],
          ...detail.itemTotals.map((i) => [barcodeCell(i.barcode), i.itemName ?? "", i.expectedQty, i.actualQty, i.extraQty, i.pallets.toFixed(2)]),
        ]
      : [
          header, timing, [],
          ["Time", "Barcode", "Item Name", "Qty", "Extra?", "Scanned By"],
          ...detail.activities.map((a) => [fmtIST(a.scannedAt), barcodeCell(a.barcode), a.itemName ?? "", a.qty, a.isExtra ? "Yes" : "No", a.scannedByName ?? ""]),
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
          <DialogDescription>{detail?.plant ?? ""} · {date}</DialogDescription>
        </DialogHeader>

        {detailQuery.isLoading ? (
          <div className="flex items-center justify-center py-10 text-gray-400">
            <Loader2 className="mr-2 h-4 w-4 animate-spin" /> Loading…
          </div>
        ) : detailQuery.isError ? (
          <p className="text-sm text-red-600">{(detailQuery.error as Error).message}</p>
        ) : detail ? (
          <div className="space-y-4">
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
              </div>
              <DownloadMenu onExport={handleExport} />
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

            {detailTab === "items" ? (
              <DataTable<ItemTotal>
                className="space-y-0"
                columns={summaryColumnsForDetail}
                data={detail.itemTotals}
                getRowId={(row) => row.barcode}
                emptyState="No items"
                enableZebraStripes
                enableTotalsRow
                totalsLabel="TOTAL"
                totalsLabelColumnId="itemName"
                enableColumnResizing
                isStickyHeader
                maxHeight="16rem"
                headerClassName={REPORT_TABLE_HEADER_CLASS}
              />
            ) : (
              <DataTable<Activity>
                className="space-y-0"
                columns={activitiesColumnsForDetail}
                data={detail.activities}
                getRowId={(_row, index) => String(index)}
                emptyState="No scans yet"
                enableZebraStripes
                enableColumnResizing
                isStickyHeader
                maxHeight="16rem"
                headerClassName={REPORT_TABLE_HEADER_CLASS}
              />
            )}
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
function CsvDetailDialog({ date, csv, initialTab, onClose }: { date: string; csv: string | null; initialTab: "items" | "activities"; onClose: () => void }) {
  const [detailTab, setDetailTab] = useState<"items" | "activities">(initialTab);
  useEffect(() => { if (csv) setDetailTab(initialTab); }, [csv, initialTab]);
  const detailQuery = useQuery({
    queryKey: ["/api/daily-reports/scan/csv", date, csv],
    enabled: !!csv,
    queryFn: async () => {
      const res = await apiRequest("GET", `/api/daily-reports/scan/csv?date=${encodeURIComponent(date)}&csv=${encodeURIComponent(csv!)}`);
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
    const timing: ExportRow = ["Start", fmtIST(detail.startTime), "End", fmtIST(detail.endTime)];
    const rows: ExportRow[] = detailTab === "items"
      ? [
          header, timing, [],
          ["Barcode", "Item Name", "Expected Qty", "Actual Qty", "Extra Qty", "Pallets"],
          ...detail.itemTotals.map((i) => [barcodeCell(i.barcode), i.itemName ?? "", i.expectedQty, i.actualQty, i.extraQty, i.pallets.toFixed(2)]),
        ]
      : [
          header, timing, [],
          ["Time", "Barcode", "Item Name", "Qty", "Pallets", "STV", "Extra?", "Scanned By"],
          ...detail.activities.map((a) => [
            fmtIST(a.scannedAt), barcodeCell(a.barcode), a.itemName ?? "", a.qty, a.pallets?.toFixed(2) ?? "", a.stv ?? "",
            a.isExtra ? "Yes" : "No", a.scannedByName ?? "",
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
          <DialogDescription>{detail?.plant ?? ""} · {date}</DialogDescription>
        </DialogHeader>

        {detailQuery.isLoading ? (
          <div className="flex items-center justify-center py-10 text-gray-400">
            <Loader2 className="mr-2 h-4 w-4 animate-spin" /> Loading…
          </div>
        ) : detailQuery.isError ? (
          <p className="text-sm text-red-600">{(detailQuery.error as Error).message}</p>
        ) : detail ? (
          <div className="space-y-4">
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
              </div>
              <DownloadMenu onExport={handleExport} />
            </div>

            <div className="flex items-center gap-2">
              {initialTab === "items" && <button
                type="button"
                onClick={() => setDetailTab("items")}
                className={
                  detailTab === "items"
                    ? "rounded-full bg-[#001d6e] px-3 py-1 text-xs font-semibold text-white ring-2 ring-[#001d6e]/30"
                    : "rounded-full border border-gray-200 bg-white px-3 py-1 text-xs font-medium text-gray-600 hover:bg-gray-50"
                }
              >
                Item-wise Total ({detail.itemTotals.length})
              </button>}
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

            {detailTab === "items" ? (
              <DataTable<ItemTotal>
                className="space-y-0"
                columns={summaryColumnsForDetail}
                data={detail.itemTotals}
                getRowId={(row) => row.barcode}
                emptyState="No items"
                enableZebraStripes
                enableTotalsRow
                totalsLabel="TOTAL"
                totalsLabelColumnId="itemName"
                enableColumnResizing
                isStickyHeader
                maxHeight="16rem"
                headerClassName={REPORT_TABLE_HEADER_CLASS}
              />
            ) : (
              <DataTable<Activity>
                className="space-y-0"
                columns={activitiesColumnsForDetail}
                data={detail.activities}
                getRowId={(_row, index) => String(index)}
                emptyState="No scans yet"
                enableZebraStripes
                enableColumnResizing
                isStickyHeader
                maxHeight="16rem"
                headerClassName={REPORT_TABLE_HEADER_CLASS}
              />
            )}
          </div>
        ) : null}
      </DialogContent>
    </Dialog>
  );
}

function ReportRowCards({ rows, tab, onRowClick }: { rows: ReportRow[]; tab: Tab; onRowClick: (row: ReportRow) => void }) {
  if (rows.length === 0) return <p className="py-10 text-center text-sm text-gray-400">No activity for this date</p>;
  const identityLabel = tab === "unloading" ? "Vehicle" : tab === "loading" ? "Slip / Order" : "CSV / Order";
  return (
    <div className="space-y-2 p-3">
      {rows.map((row, index) => (
        <button
          key={`${row.key}-${index}`}
          type="button"
          onClick={() => onRowClick(row)}
          className="block w-full rounded-lg border border-gray-200 bg-white p-3 text-left shadow-sm transition-colors hover:border-[#001d6e]/40 hover:bg-[#001d6e]/5"
        >
          <div className="flex min-w-0 items-center justify-between gap-3">
            <span className="min-w-0 truncate font-semibold text-[#001d6e]">{row.label}</span>
            <span className="shrink-0 text-[11px] text-gray-500">{identityLabel}</span>
          </div>
          <div className="mt-2 grid grid-cols-2 gap-x-4 gap-y-1 text-xs text-gray-600">
            <span>Plant: <strong className="text-gray-900">{row.plant ?? "—"}</strong></span>
            <span>Orders: <strong className="text-gray-900">{row.orderCount}</strong></span>
            <span>Expected: <strong className="text-gray-900">{row.expectedQty.toLocaleString()}</strong></span>
            <span>Actual: <strong className="text-emerald-600">{row.actualQty.toLocaleString()}</strong></span>
            <span>Events: <strong className="text-gray-900">{row.eventCount}</strong></span>
            <span>Start: <strong className="text-gray-900">{fmtIST(row.startTime)}</strong></span>
          </div>
        </button>
      ))}
    </div>
  );
}

function StatBox({ label, value, text }: { label: string; value?: number; text?: string }) {
  return (
    <div className="rounded-lg border border-gray-100 bg-gray-50/70 px-2.5 py-1.5">
      <p className="text-[10px] font-semibold uppercase tracking-wide text-gray-500">{label}</p>
      <p className="mt-0.5 truncate text-base font-bold tabular-nums text-gray-900">
        {text ?? value!.toLocaleString()}
      </p>
    </div>
  );
}
