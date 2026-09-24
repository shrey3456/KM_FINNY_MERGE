import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { apiRequest } from "@/lib/queryClient";
import { usePersistentFilter } from "@/hooks/usePersistentFilter";
import { DateInput } from "@/components/ui/date-input";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription } from "@/components/ui/dialog";
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
    doc.setFontSize(12);
    doc.text(title, 14, 12);
    const [header, ...body] = plain;
    autoTable(doc, { head: [header as string[]], body: body as string[][], startY: 18, styles: { fontSize: 8 }, headStyles: { fillColor: [0, 29, 110] } });
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
  { key: "loading", label: "Loading", breakdownLabel: "Vehicle" },
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
  const activeTab = TABS.find((t) => t.key === tab)!;

  // Which vehicle's/CSV's own detail popup is open — Unloading and Scan respectively.
  const [openVehicle, setOpenVehicle] = useState<string | null>(null);
  const [openCsv, setOpenCsv] = useState<string | null>(null);

  const reportQuery = useQuery({
    queryKey: ["/api/daily-reports", tab, date],
    queryFn: async () => {
      const res = await apiRequest("GET", `/api/daily-reports/${tab}?date=${encodeURIComponent(date)}`);
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

  return (
    <div className="container-fluid max-w-full space-y-5 px-4 py-6 md:px-6">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <h2 className="flex items-center text-2xl font-bold tracking-tight">
          <FileBarChart className="mr-2 h-6 w-6 text-[#001d6e]" />
          <span className="text-[#001d6e]">Reports</span>
        </h2>
        <DateInput value={date} onChange={setDate} clearable={false} />
      </div>

      {/* Loading / Unloading / Scan — whichever tab is selected, that section's report opens. */}
      <div className="flex items-center gap-2">
        {TABS.map((t) => (
          <button
            key={t.key}
            type="button"
            onClick={() => setTab(t.key)}
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
                  <StatBox label={activeTab.key === "scan" ? "CSVs" : "Vehicles"} value={data.totalSummary.vehicleCount} />
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

          {/* Total Summary Report / Activities Report / Breakdown — one tab row, all three. */}
          <div className="flex items-center gap-2">
            <button
              type="button"
              onClick={() => setReportTab("summary")}
              className={
                reportTab === "summary"
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
                reportTab === "activities"
                  ? "rounded-full bg-[#001d6e] px-4 py-1.5 text-sm font-semibold text-white ring-2 ring-[#001d6e]/30"
                  : "rounded-full border border-gray-200 bg-white px-4 py-1.5 text-sm font-medium text-gray-600 hover:bg-gray-50"
              }
            >
              Activities Report
            </button>
            <button
              type="button"
              onClick={() => setReportTab("breakdown")}
              className={
                reportTab === "breakdown"
                  ? "rounded-full bg-[#001d6e] px-4 py-1.5 text-sm font-semibold text-white ring-2 ring-[#001d6e]/30"
                  : "rounded-full border border-gray-200 bg-white px-4 py-1.5 text-sm font-medium text-gray-600 hover:bg-gray-50"
              }
            >
              {activeTab.breakdownLabel} Breakdown
            </button>
          </div>

          {reportTab === "summary" ? (
            <Card className="border-gray-200 shadow-sm overflow-hidden">
              <div className="flex flex-wrap items-center justify-between gap-3 border-b border-gray-100 bg-gray-50/70 px-4 py-3">
                <div className="flex items-center gap-4">
                  <span className="flex items-center gap-1.5 text-sm font-semibold text-gray-900">
                    <SectionIcon icon={Package} /> Total Summary Report
                  </span>
                  <span className="text-xs text-gray-500">
                    Start: <span className="font-medium text-gray-700">{fmtIST(data.activitySummary.startTime)}</span>
                    {"  ·  "}End: <span className="font-medium text-gray-700">{fmtIST(data.activitySummary.endTime)}</span>
                  </span>
                </div>
                <DownloadMenu onExport={handleExportSummaryReport} />
              </div>
              <div className="max-h-[420px] overflow-y-auto">
                <table className="w-full text-sm">
                  <thead className="sticky top-0 bg-gray-50">
                    <tr className="text-left text-xs font-semibold uppercase tracking-wide text-gray-500">
                      <th className="px-4 py-2">Barcode</th>
                      <th className="px-4 py-2">Item Name</th>
                      <th className="px-4 py-2 text-right">Expected</th>
                      <th className="px-4 py-2 text-right">Actual</th>
                      <th className="px-4 py-2 text-right">Extra</th>
                      <th className="px-4 py-2 text-right">Pallets</th>
                    </tr>
                  </thead>
                  <tbody>
                    {data.itemTotals === undefined ? (
                      <tr><td colSpan={6} className="px-4 py-6 text-center text-gray-400">Not available yet for this operation</td></tr>
                    ) : data.itemTotals.length === 0 ? (
                      <tr><td colSpan={6} className="px-4 py-6 text-center text-gray-400">No items for this date</td></tr>
                    ) : (
                      <>
                        {data.itemTotals.map((i, idx) => (
                          <tr key={i.barcode} className={`border-t border-gray-50 ${idx % 2 === 1 ? "bg-gray-50/40" : ""}`}>
                            <td className="px-4 py-2 font-mono text-xs text-gray-500">{i.barcode}</td>
                            <td className="px-4 py-2 text-gray-900">{i.itemName || "—"}</td>
                            <td className="px-4 py-2 text-right tabular-nums text-gray-700">{i.expectedQty}</td>
                            <td className="px-4 py-2 text-right tabular-nums font-medium text-emerald-600">{i.actualQty}</td>
                            <td className={`px-4 py-2 text-right tabular-nums ${i.extraQty > 0 ? "font-medium text-amber-600" : "text-gray-400"}`}>{i.extraQty}</td>
                            <td className="px-4 py-2 text-right tabular-nums text-[#001d6e]">{i.pallets.toFixed(2)}</td>
                          </tr>
                        ))}
                        {summaryTotals && (
                          <tr className="border-t-2 border-gray-200 bg-[#001d6e]/[0.04] font-bold">
                            <td className="px-4 py-2" colSpan={2}>TOTAL</td>
                            <td className="px-4 py-2 text-right tabular-nums text-gray-900">{summaryTotals.expectedQty}</td>
                            <td className="px-4 py-2 text-right tabular-nums text-emerald-700">{summaryTotals.actualQty}</td>
                            <td className={`px-4 py-2 text-right tabular-nums ${summaryTotals.extraQty > 0 ? "text-amber-700" : "text-gray-400"}`}>{summaryTotals.extraQty}</td>
                            <td className="px-4 py-2 text-right tabular-nums text-[#001d6e]">{summaryTotals.pallets.toFixed(2)}</td>
                          </tr>
                        )}
                      </>
                    )}
                  </tbody>
                </table>
              </div>
            </Card>
          ) : reportTab === "activities" ? (
            <Card className="border-gray-200 shadow-sm overflow-hidden">
              <div className="flex flex-wrap items-center justify-between gap-3 border-b border-gray-100 bg-gray-50/70 px-4 py-3">
                <span className="flex items-center gap-1.5 text-sm font-semibold text-gray-900">
                  <SectionIcon icon={ListChecks} /> Activities Report
                  {data.activities && <span className="text-xs font-normal text-gray-400">({data.activities.length})</span>}
                </span>
                <DownloadMenu onExport={handleExportActivitiesReport} />
              </div>
              <div className="max-h-[420px] overflow-y-auto">
                <table className="w-full text-sm">
                  <thead className="sticky top-0 bg-gray-50">
                    <tr className="text-left text-xs font-semibold uppercase tracking-wide text-gray-500">
                      <th className="px-4 py-2">Time</th>
                      <th className="px-4 py-2">Barcode</th>
                      <th className="px-4 py-2">Item Name</th>
                      <th className="px-4 py-2 text-right">Qty</th>
                      <th className="px-4 py-2 text-right">Pallets</th>
                      <th className="px-4 py-2">STV</th>
                      <th className="px-4 py-2">By</th>
                    </tr>
                  </thead>
                  <tbody>
                    {data.activities === undefined ? (
                      <tr><td colSpan={7} className="px-4 py-6 text-center text-gray-400">Not available yet for this operation</td></tr>
                    ) : data.activities.length === 0 ? (
                      <tr><td colSpan={7} className="px-4 py-6 text-center text-gray-400">No scans for this date</td></tr>
                    ) : (
                      data.activities.map((a, idx) => (
                        <tr key={idx} className={`border-t border-gray-50 ${idx % 2 === 1 ? "bg-gray-50/40" : ""}`}>
                          <td className="whitespace-nowrap px-4 py-2 text-xs text-gray-500">{fmtIST(a.scannedAt)}</td>
                          <td className="px-4 py-2 font-mono text-xs text-gray-500">{a.barcode}</td>
                          <td className="px-4 py-2 text-gray-900">
                            {a.itemName || "—"}
                            {a.isExtra && <span className="ml-1.5 rounded-full bg-amber-100 px-1.5 py-0.5 text-[10px] font-semibold text-amber-700">Extra</span>}
                          </td>
                          <td className="px-4 py-2 text-right tabular-nums font-medium text-emerald-600">{a.qty}</td>
                          <td className="px-4 py-2 text-right tabular-nums text-[#001d6e]">{a.pallets?.toFixed(2) ?? "—"}</td>
                          <td className="px-4 py-2 text-gray-500">{a.stv || "—"}</td>
                          <td className="px-4 py-2 text-gray-500">{a.scannedByName || "—"}</td>
                        </tr>
                      ))
                    )}
                  </tbody>
                </table>
              </div>
            </Card>
          ) : (
            <Card className="border-gray-200 shadow-sm overflow-hidden">
              <div className="flex items-center gap-2 border-b border-gray-100 bg-gray-50/70 px-4 py-3">
                <SectionIcon icon={Truck} />
                <span className="text-sm font-semibold text-gray-900">
                  {activeTab.breakdownLabel} Breakdown ({data.breakdown.length})
                </span>
              </div>
              <div className="overflow-x-auto">
                <table className="w-full text-sm">
                  <thead className="bg-gray-50">
                    <tr className="text-left text-xs font-semibold uppercase tracking-wide text-gray-500">
                      <th className="px-4 py-2">{activeTab.breakdownLabel}</th>
                      <th className="px-4 py-2">Plant</th>
                      <th className="px-4 py-2 text-right">Orders</th>
                      <th className="px-4 py-2 text-right">Expected</th>
                      <th className="px-4 py-2 text-right">Actual</th>
                      <th className="px-4 py-2 text-right">Events</th>
                      <th className="px-4 py-2">Start</th>
                      <th className="px-4 py-2">End</th>
                    </tr>
                  </thead>
                  <tbody>
                    {data.breakdown.length === 0 ? (
                      <tr>
                        <td colSpan={8} className="px-4 py-6 text-center text-gray-400">No activity for this date</td>
                      </tr>
                    ) : (
                      data.breakdown.map((r, idx) => {
                        const clickable = (tab === "unloading" || tab === "scan") && r.key !== "—";
                        const openRow = tab === "unloading" ? () => setOpenVehicle(r.key) : () => setOpenCsv(r.key);
                        return (
                          <tr
                            key={r.key}
                            onClick={clickable ? openRow : undefined}
                            className={`border-t border-gray-50 ${idx % 2 === 1 ? "bg-gray-50/40" : ""} ${clickable ? "cursor-pointer hover:bg-[#001d6e]/[0.04]" : ""}`}
                          >
                            <td className="px-4 py-2 font-medium text-gray-900">
                              {clickable ? <span className="text-[#001d6e] underline decoration-dotted">{r.label}</span> : r.label}
                            </td>
                            <td className="px-4 py-2">{r.plant ?? "—"}</td>
                            <td className="px-4 py-2 text-right tabular-nums">{r.orderCount}</td>
                            <td className="px-4 py-2 text-right tabular-nums text-gray-700">{r.expectedQty}</td>
                            <td className="px-4 py-2 text-right tabular-nums font-medium text-emerald-600">{r.actualQty}</td>
                            <td className="px-4 py-2 text-right tabular-nums">{r.eventCount}</td>
                            <td className="whitespace-nowrap px-4 py-2 text-xs text-gray-500">{fmtIST(r.startTime)}</td>
                            <td className="whitespace-nowrap px-4 py-2 text-xs text-gray-500">{fmtIST(r.endTime)}</td>
                          </tr>
                        );
                      })
                    )}
                  </tbody>
                </table>
              </div>
            </Card>
          )}
        </>
      ) : null}

      <VehicleDetailDialog date={date} vehicle={openVehicle} onClose={() => setOpenVehicle(null)} />
      <CsvDetailDialog date={date} csv={openCsv} onClose={() => setOpenCsv(null)} />
    </div>
  );
}

// The drill-down behind clicking a vehicle in Unloading's breakdown table — that vehicle's own
// Start/End time (End = when its session was actually marked Complete, not its last scan), an
// item-wise total, and the full list of its individual scan events, with its own CSV download
// separate from the main page's summary export.
function VehicleDetailDialog({ date, vehicle, onClose }: { date: string; vehicle: string | null; onClose: () => void }) {
  const [detailTab, setDetailTab] = useState<"items" | "activities">("items");
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
      <DialogContent className="max-h-[85vh] overflow-y-auto sm:max-w-3xl">
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

            {detailTab === "items" ? (
              <div className="overflow-hidden rounded-xl border border-gray-200">
                <div className="max-h-64 overflow-y-auto">
                  <table className="w-full text-xs">
                    <thead className="sticky top-0 bg-gray-50">
                      <tr className="text-left text-[10px] font-semibold uppercase tracking-wide text-gray-500">
                        <th className="px-3 py-1.5">Item</th>
                        <th className="px-3 py-1.5 text-right">Expected</th>
                        <th className="px-3 py-1.5 text-right">Actual</th>
                        <th className="px-3 py-1.5 text-right">Extra</th>
                        <th className="px-3 py-1.5 text-right">Pallets</th>
                      </tr>
                    </thead>
                    <tbody>
                      {detail.itemTotals.length === 0 ? (
                        <tr><td colSpan={5} className="px-3 py-4 text-center text-gray-400">No items</td></tr>
                      ) : detail.itemTotals.map((i, idx) => (
                        <tr key={i.barcode} className={`border-t border-gray-50 ${idx % 2 === 1 ? "bg-gray-50/40" : ""}`}>
                          <td className="px-3 py-1.5 text-gray-900">{i.itemName || i.barcode}</td>
                          <td className="px-3 py-1.5 text-right tabular-nums text-gray-700">{i.expectedQty}</td>
                          <td className="px-3 py-1.5 text-right tabular-nums font-medium text-emerald-600">{i.actualQty}</td>
                          <td className={`px-3 py-1.5 text-right tabular-nums ${i.extraQty > 0 ? "font-medium text-amber-600" : "text-gray-400"}`}>{i.extraQty}</td>
                          <td className="px-3 py-1.5 text-right tabular-nums text-[#001d6e]">{i.pallets.toFixed(2)}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </div>
            ) : (
              <div className="overflow-hidden rounded-xl border border-gray-200">
                <div className="max-h-64 overflow-y-auto">
                  <table className="w-full text-xs">
                    <thead className="sticky top-0 bg-gray-50">
                      <tr className="text-left text-[10px] font-semibold uppercase tracking-wide text-gray-500">
                        <th className="px-3 py-1.5">Time</th>
                        <th className="px-3 py-1.5">Item</th>
                        <th className="px-3 py-1.5 text-right">Qty</th>
                        <th className="px-3 py-1.5">By</th>
                      </tr>
                    </thead>
                    <tbody>
                      {detail.activities.length === 0 ? (
                        <tr><td colSpan={4} className="px-3 py-4 text-center text-gray-400">No scans yet</td></tr>
                      ) : detail.activities.map((a, idx) => (
                        <tr key={idx} className={`border-t border-gray-50 ${idx % 2 === 1 ? "bg-gray-50/40" : ""}`}>
                          <td className="whitespace-nowrap px-3 py-1.5 text-gray-500">{fmtIST(a.scannedAt)}</td>
                          <td className="px-3 py-1.5 text-gray-900">{a.itemName || a.barcode}{a.isExtra && <span className="ml-1 text-amber-600">(Extra)</span>}</td>
                          <td className="px-3 py-1.5 text-right tabular-nums font-medium text-emerald-600">{a.qty}</td>
                          <td className="px-3 py-1.5 text-gray-500">{a.scannedByName || "—"}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </div>
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
function CsvDetailDialog({ date, csv, onClose }: { date: string; csv: string | null; onClose: () => void }) {
  const [detailTab, setDetailTab] = useState<"items" | "activities">("items");
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
      <DialogContent className="max-h-[85vh] overflow-y-auto sm:max-w-3xl">
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

            {detailTab === "items" ? (
              <div className="overflow-hidden rounded-xl border border-gray-200">
                <div className="max-h-64 overflow-y-auto">
                  <table className="w-full text-xs">
                    <thead className="sticky top-0 bg-gray-50">
                      <tr className="text-left text-[10px] font-semibold uppercase tracking-wide text-gray-500">
                        <th className="px-3 py-1.5">Item</th>
                        <th className="px-3 py-1.5 text-right">Expected</th>
                        <th className="px-3 py-1.5 text-right">Actual</th>
                        <th className="px-3 py-1.5 text-right">Extra</th>
                        <th className="px-3 py-1.5 text-right">Pallets</th>
                      </tr>
                    </thead>
                    <tbody>
                      {detail.itemTotals.length === 0 ? (
                        <tr><td colSpan={5} className="px-3 py-4 text-center text-gray-400">No items</td></tr>
                      ) : detail.itemTotals.map((i, idx) => (
                        <tr key={i.barcode} className={`border-t border-gray-50 ${idx % 2 === 1 ? "bg-gray-50/40" : ""}`}>
                          <td className="px-3 py-1.5 text-gray-900">{i.itemName || i.barcode}</td>
                          <td className="px-3 py-1.5 text-right tabular-nums text-gray-700">{i.expectedQty}</td>
                          <td className="px-3 py-1.5 text-right tabular-nums font-medium text-emerald-600">{i.actualQty}</td>
                          <td className={`px-3 py-1.5 text-right tabular-nums ${i.extraQty > 0 ? "font-medium text-amber-600" : "text-gray-400"}`}>{i.extraQty}</td>
                          <td className="px-3 py-1.5 text-right tabular-nums text-[#001d6e]">{i.pallets.toFixed(2)}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </div>
            ) : (
              <div className="overflow-hidden rounded-xl border border-gray-200">
                <div className="max-h-64 overflow-y-auto">
                  <table className="w-full text-xs">
                    <thead className="sticky top-0 bg-gray-50">
                      <tr className="text-left text-[10px] font-semibold uppercase tracking-wide text-gray-500">
                        <th className="px-3 py-1.5">Time</th>
                        <th className="px-3 py-1.5">Item</th>
                        <th className="px-3 py-1.5 text-right">Qty</th>
                        <th className="px-3 py-1.5 text-right">Pallets</th>
                        <th className="px-3 py-1.5">STV</th>
                        <th className="px-3 py-1.5">By</th>
                      </tr>
                    </thead>
                    <tbody>
                      {detail.activities.length === 0 ? (
                        <tr><td colSpan={6} className="px-3 py-4 text-center text-gray-400">No scans yet</td></tr>
                      ) : detail.activities.map((a, idx) => (
                        <tr key={idx} className={`border-t border-gray-50 ${idx % 2 === 1 ? "bg-gray-50/40" : ""}`}>
                          <td className="whitespace-nowrap px-3 py-1.5 text-gray-500">{fmtIST(a.scannedAt)}</td>
                          <td className="px-3 py-1.5 text-gray-900">{a.itemName || a.barcode}{a.isExtra && <span className="ml-1 text-amber-600">(Extra)</span>}</td>
                          <td className="px-3 py-1.5 text-right tabular-nums font-medium text-emerald-600">{a.qty}</td>
                          <td className="px-3 py-1.5 text-right tabular-nums text-[#001d6e]">{a.pallets?.toFixed(2) ?? "—"}</td>
                          <td className="px-3 py-1.5 text-gray-500">{a.stv || "—"}</td>
                          <td className="px-3 py-1.5 text-gray-500">{a.scannedByName || "—"}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </div>
            )}
          </div>
        ) : null}
      </DialogContent>
    </Dialog>
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
