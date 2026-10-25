import { drawPdfHeader, drawPdfFooter, greenTotalRow, setPdfProperties } from "@/lib/pdfBranding";
import { PlantBadge } from "@/components/PlantBadge";
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
import { Accordion, AccordionItem, AccordionTrigger, AccordionContent } from "@/components/ui/accordion";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription } from "@/components/ui/dialog";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { DropdownMenu, DropdownMenuTrigger, DropdownMenuContent, DropdownMenuItem } from "@/components/ui/dropdown-menu";
import {
  Download, FileBarChart, Truck, Clock, Loader2, ChevronDown,
  Package, ListChecks, CalendarClock, FileSpreadsheet, Eye, RotateCw,
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
  partyName?: string | null;
  plant: string | null;
  stockPlant?: string | null;   // unloading: where the stock lands, when it differs from the purchase plant
  orderCount: number;
  expectedQty: number;
  actualQty: number;
  extraQty?: number;
  eventCount: number;
  startTime: string | null;
  endTime: string | null;
  expectedPallets?: number;
  receivedPallets?: number;
  extraPallets?: number;
};
// `pallets` = pallets actually received (scanned); `expectedPallets` = expected qty / pallet size.
type ItemTotal = { barcode: string; itemName: string | null; sapCode?: string | null; srNo?: string | null; expectedQty: number; expectedPallets?: number; actualQty: number; extraQty: number; pallets: number };
type Activity = {
  barcode: string; itemName: string | null; sapCode?: string | null; qty: number; pallets?: number; stv?: string | null;
  isExtra: boolean; scannedByName: string | null; scannedAt: string;
  groupKey?: string | null; groupLabel?: string | null;
  // A voided scan stays in the activity list, clearly marked, so the report says the entry
  // happened and was cancelled; totals/item-wise figures already exclude it server-side. An
  // entry someone REMOVED from Scan History is dropped by the server and never arrives here.
  voided?: boolean; voidReason?: string | null; voidedAt?: string | null;
  // A quantity correction (Adjust), saved as its own entry; adjustedAt = when the correction was made.
  isAdjust?: boolean; adjustedAt?: string | null;
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
  date: string; vehicle: string; plant: string | null; stockPlant?: string | null;
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

// Purchase plant, and - when the stock lands at a different plant - "RAJKOT -> VALSAD" (purchase -> stock).
function PlantRoute({ plant, stockPlant, className }: { plant: string | null; stockPlant?: string | null; className?: string }) {
  if (!plant) return null;
  const differs = !!stockPlant && stockPlant.toUpperCase() !== plant.toUpperCase();
  return (
    <span className="inline-flex flex-wrap items-center gap-1">
      <PlantBadge plant={plant} className={className} />
      {differs && (<><span className="text-gray-400">→</span><PlantBadge plant={stockPlant} className={className} /></>)}
    </span>
  );
}

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

// Hourly report: rolling 1-hour windows anchored to when scanning actually started (e.g. a 03:28 start gives
// 03:28 – 04:28, 04:28 – 05:28 ...), not clock-hour boundaries - the same windows the per-order Reports dialog uses.
// Voided entries are left out, matching every total on this page. Hours with no scans stay in the list so gaps show.
type HourWindow = { idx: number; label: string; events: Activity[]; qty: number; pallets: number };
const HOUR_MS = 3_600_000;

const fmtClock = (ms: number) => new Date(ms).toLocaleTimeString("en-IN", { timeZone: "Asia/Kolkata", hour: "2-digit", minute: "2-digit", hour12: true });

function istHourOfDay(dt: string): number | null {
  const d = new Date(dt);
  if (isNaN(d.getTime())) return null;
  return Number(new Intl.DateTimeFormat("en-GB", { timeZone: "Asia/Kolkata", hour: "2-digit", hourCycle: "h23" }).format(d));
}

// Keeps only the entries scanned within [from, to] o'clock (IST, both hours inclusive: 9 to 17 = 09:00 up to 17:59).
function withinHours(activities: Activity[], from: number, to: number): Activity[] {
  if (from <= 0 && to >= 23) return activities;
  return activities.filter((a) => {
    const h = istHourOfDay(a.scannedAt);
    return h !== null && h >= from && h <= to;
  });
}
const hourOptionLabel = (h: number) => `${String(h).padStart(2, "0")}:00`;

function buildHourWindows(activities: Activity[], startIso: string | null): HourWindow[] {
  const real = activities.filter((a) => !a.voided && !isNaN(new Date(a.scannedAt).getTime()));
  if (real.length === 0) return [];
  const times = real.map((a) => new Date(a.scannedAt).getTime());
  const startMs = startIso ? new Date(startIso).getTime() : NaN;
  const anchor = Math.min(...times, ...(isNaN(startMs) ? [] : [startMs]));
  const byIdx = new Map<number, Activity[]>();
  let maxIdx = 0;
  real.forEach((a, i) => {
    const idx = Math.floor((times[i] - anchor) / HOUR_MS);
    maxIdx = Math.max(maxIdx, idx);
    byIdx.set(idx, [...(byIdx.get(idx) ?? []), a]);
  });
  const out: HourWindow[] = [];
  for (let idx = 0; idx <= maxIdx; idx++) {
    const events = (byIdx.get(idx) ?? []).slice().sort((x, y) => new Date(x.scannedAt).getTime() - new Date(y.scannedAt).getTime());
    out.push({
      idx, events,
      label: `${fmtClock(anchor + idx * HOUR_MS)} – ${fmtClock(anchor + (idx + 1) * HOUR_MS)}`,
      qty: events.reduce((n, e) => n + e.qty, 0),
      pallets: events.reduce((n, e) => n + (e.pallets ?? 0), 0),
    });
  }
  return out;
}

const hourlySourceHeader = (tab: Tab) => (tab === "scan" ? "CSV File" : tab === "loading" ? "Order / Slip" : "Vehicle");

// Flat rows for a download: each window's scans, then its Subtotal, then one grand TOTAL.
function hourlyExportRows(tab: Tab, windows: HourWindow[], meta: ExportRow): ExportRow[] {
  const rows: ExportRow[] = [
    meta, [],
    ["Hour (IST)", "Time", hourlySourceHeader(tab), "Barcode", "Item Name", "SAP Code", "Type", "Scanned By", "Pallets", "Qty"],
  ];
  for (const w of windows) {
    if (w.events.length === 0) { rows.push([w.label, "", "", "", "— no scans this hour —", "", "", "", 0, 0], []); continue; }
    for (const e of w.events) rows.push([w.label, fmtIST(e.scannedAt), e.groupLabel ?? "", barcodeCell(e.barcode), e.itemName ?? "", e.sapCode ?? "", entryKind(e), e.scannedByName ?? "", (e.pallets ?? 0).toFixed(2), e.qty]);
    rows.push(["", "", "", "", "Subtotal", "", "", "", w.pallets.toFixed(2), w.qty], []);
  }
  rows.push(["TOTAL", "", "", "", "", "", "", "", windows.reduce((n, w) => n + w.pallets, 0).toFixed(2), windows.reduce((n, w) => n + w.qty, 0)]);
  return rows;
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

// What an activity entry IS: a regular scan, an Extra, or an Adjust (a quantity correction); and whether it was voided afterwards. A voided Extra stays an Extra
// (and Voided), so it is never mistaken for an ordinary received entry.
const entryKind = (a: { isExtra?: boolean; isAdjust?: boolean }): string => (a.isExtra ? "Extra" : a.isAdjust ? "Adjust" : "Regular");
const entryTypeText = (a: { isExtra?: boolean; isAdjust?: boolean; voided?: boolean }): string => (a.voided ? `Voided (${entryKind(a)})` : entryKind(a));
function EntryTypeBadges({ a }: { a: Activity }) {
  const kind = a.isExtra ? "Extra" : a.isAdjust ? "Adjust" : null;
  if (!kind && !a.voided) return null;
  const tone = kind === "Extra" ? (a.voided ? "bg-amber-50 text-amber-400" : "bg-amber-100 text-amber-700") : (a.voided ? "bg-sky-50 text-sky-400" : "bg-sky-100 text-sky-700");
  return (
    <span className="ml-1.5 inline-flex flex-wrap items-center gap-1 align-middle">
      {kind && <span className={`rounded-full px-1.5 py-0.5 text-[10px] font-semibold ${tone}`}>{kind}</span>}
      {a.voided && (
        <span title={a.voidReason ?? undefined} className="rounded-full bg-red-100 px-1.5 py-0.5 text-[10px] font-semibold text-red-700">Voided</span>
      )}
    </span>
  );
}

// The Activities rows of every download (main report, vehicle and CSV popups): the Type of each entry, and for a voided one its void reason and time. A voided
// entry stays in the file with its original quantity, marked "Voided (...)", and is left out of the Total row, so the file's total matches the screen.
// `stvHeader` = the Dispatch Directory column's heading (null = the file has no such column).
function activityExportRows(list: Activity[], stvHeader: string | null): ExportRow[] {
  const header: ExportRow = ["Time", "Barcode", "Item Name", "Type", "SAP Code", "Qty", "Pallets", ...(stvHeader ? [stvHeader] : []), "Extra Qty", "Scanned By", "Void Reason", "Voided At"];
  const body: ExportRow[] = list.map((a) => [
    fmtIST(a.scannedAt), barcodeCell(a.barcode), a.itemName ?? "", entryTypeText(a), a.sapCode ?? "", a.qty, a.pallets?.toFixed(2) ?? "",
    ...(stvHeader ? [a.stv ?? ""] : []),
    a.isExtra ? a.qty : 0, a.scannedByName ?? "", a.voided ? (a.voidReason ?? "") : "", a.voided && a.voidedAt ? fmtIST(a.voidedAt) : "",
  ]);
  const counted = list.filter((a) => !a.voided);
  const total: ExportRow = [
    "Total", "", "", "", "", counted.reduce((s, a) => s + a.qty, 0), counted.reduce((s, a) => s + (a.pallets ?? 0), 0).toFixed(2),
    ...(stvHeader ? [""] : []),
    counted.reduce((s, a) => s + (a.isExtra ? a.qty : 0), 0), "", "", "",
  ];
  return [header, ...body, total];
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
    const margin = 14;
    const separatorIndex = plain.findIndex((row) => row.length === 0);
    const headerIndex = separatorIndex >= 0 ? separatorIndex + 1 : 0;
    const metadata = plain.slice(0, headerIndex).filter((row) => row.length > 0);
    const header = plain[headerIndex] ?? [];
    const body = plain.slice(headerIndex + 1);

    const scope = metadata
      .map((row) => row.reduce<string[]>((parts, cell, index) => {
        if (index % 2 === 0 && row[index + 1] !== undefined) parts.push(`${String(cell)}: ${String(row[index + 1])}`);
        return parts;
      }, []).join("  |  "))
      .join("  |  ");
    setPdfProperties(doc, title, scope);
    const startY = drawPdfHeader(doc, { title, subtitle: scope, margin, generated: fmtIST(new Date().toISOString()) });

    const columnStyles: Record<number, { halign: "right" }> = {};
    header.forEach((cell, index) => {
      if (/(qty|pallet|expected|actual|extra|order|event)/i.test(String(cell))) columnStyles[index] = { halign: "right" };
    });
    autoTable(doc, {
      head: [header as string[]],
      body: body as string[][],
      startY,
      theme: "grid",
      styles: { fontSize: 7, cellPadding: 2.2, lineColor: [210, 210, 210], lineWidth: 0.15 },
      headStyles: { fillColor: [226, 232, 244], textColor: [0, 29, 110], fontStyle: "bold", halign: "left" },
      alternateRowStyles: { fillColor: [248, 250, 252] },
      columnStyles,
      margin: { left: margin, right: margin },
      didParseCell: greenTotalRow,
    });
    drawPdfFooter(doc, margin);
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

// A quantity with its pallets written underneath it (2 decimals, small grey type). Nothing under a 0 or a missing figure.
const qtyWithPallets = (qty: number, pallets: number | null | undefined, tone = "") => (
  <div className="flex flex-col items-end leading-tight">
    <span className={tone}>{qty}</span>
    {qty && pallets != null ? <span className="text-[10px] font-medium text-[#001d6e]">{pallets.toFixed(2)} plt</span> : null}
  </div>
);

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
  const [reportTab, setReportTab] = usePersistentFilter<"summary" | "activities" | "breakdown" | "hourly">("dailyReports:reportTab", "summary");
  // The date you picked is kept while the browser stays open (leave the page and come back to the same day); a fresh
  // visit — a new browser session — starts on today (IST) again.
  const [date, setDate] = usePersistentFilter<string>("dailyReports:date", todayIST());
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
    : reportTab === "activities" || reportTab === "hourly" ? reportTab : "summary";

  const selectTab = (next: Tab) => {
    setTab(next);
    if (next !== "scan" && reportTab === "breakdown") setReportTab("summary");
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
    // A void or an Adjust made after Complete must show here: re-read on open, every 30 seconds, and before a download.
    staleTime: 0, refetchOnMount: "always", refetchInterval: 30000,
  });
  const data = reportQuery.data;

  const handleExportSummaryReport = async (fmt: Fmt) => {
    // Re-read first, so the file always has the latest voids and adjustments.
    const fresh = (await reportQuery.refetch()).data ?? data;
    if (!fresh?.itemTotals) return;
    const totals = fresh.itemTotals.reduce(
      (acc, i) => ({ expectedQty: acc.expectedQty + i.expectedQty, actualQty: acc.actualQty + receivedIncludingExtra(i), extraQty: acc.extraQty + i.extraQty, expectedPallets: acc.expectedPallets + (i.expectedPallets ?? 0), pallets: acc.pallets + i.pallets }),
      { expectedQty: 0, actualQty: 0, extraQty: 0, expectedPallets: 0, pallets: 0 },
    );
    const rows: ExportRow[] = [
      ["Start", fmtIST(fresh.activitySummary.startTime), "End", fmtIST(fresh.activitySummary.endTime), "Total Time", fmtTotalTime(fresh.activitySummary.startTime, fresh.activitySummary.endTime)],
      [],
      ["Barcode", "Item Name", "SAP Code", "Expected Qty", "Expected Pallets", "Received Qty", "Extra Qty", "Received Pallets"],
      ...fresh.itemTotals.map((i) => [barcodeCell(i.barcode), i.itemName ?? "", i.sapCode ?? "", i.expectedQty, (i.expectedPallets ?? 0).toFixed(2), receivedIncludingExtra(i), i.extraQty, i.pallets.toFixed(2)]),
      ["TOTAL", "", "", totals.expectedQty, totals.expectedPallets.toFixed(2), totals.actualQty, totals.extraQty, totals.pallets.toFixed(2)],
    ];
    exportRows(fmt, `${tab}-summary-report-${fresh.date}`, `${activeTab.label} — Total Summary Report — ${fresh.date}`, rows);
  };

  const handleExportActivitiesReport = async (fmt: Fmt) => {
    // Re-read first, so the file always has the latest voids and adjustments.
    const fresh = (await reportQuery.refetch()).data ?? data;
    if (!fresh?.activities) return;
    const rows: ExportRow[] = [
      ["Start", fmtIST(fresh.activitySummary.startTime), "End", fmtIST(fresh.activitySummary.endTime), "Total Time", fmtTotalTime(fresh.activitySummary.startTime, fresh.activitySummary.endTime)],
      [],
      ...activityExportRows(fresh.activities, "Dispatch Directory"),
    ];
    exportRows(fmt, `${tab}-activities-report-${fresh.date}`, `${activeTab.label} — Activities Report — ${fresh.date}`, rows);
  };

  const [hourFrom, setHourFrom] = usePersistentFilter<number>("dailyReports:hourFrom", 0);
  const [hourTo, setHourTo] = usePersistentFilter<number>("dailyReports:hourTo", 23);
  const hourSpanLabel = `${hourOptionLabel(hourFrom)} – ${String(hourTo).padStart(2, "0")}:59`;
  const hourWindowsFor = (d: ReportData) => {
    const inSpan = withinHours(d.activities ?? [], hourFrom, hourTo);
    // The anchor is the real start of scanning; with a span chosen it is the first scan inside the span instead.
    return buildHourWindows(inSpan, hourFrom <= 0 && hourTo >= 23 ? d.activitySummary.startTime : null);
  };
  const hourWindows = data ? hourWindowsFor(data) : [];
  const hourTotals = hourWindows.reduce((acc, w) => ({ scans: acc.scans + w.events.length, qty: acc.qty + w.qty, pallets: acc.pallets + w.pallets }), { scans: 0, qty: 0, pallets: 0 });

  const handleExportHourlyReport = async (fmt: Fmt) => {
    // Re-read first, so the file always has the latest voids and adjustments.
    const fresh = (await reportQuery.refetch()).data ?? data;
    if (!fresh?.activities) return;
    const meta: ExportRow = ["Date", fresh.date, "Plant", selectedPlant || "All plants", "Hours", hourSpanLabel];
    exportRows(fmt, `${tab}-hourly-report-${fresh.date}`, `${activeTab.label} — Hourly Report — ${fresh.date}`, hourlyExportRows(tab, hourWindowsFor(fresh), meta));
  };

  const summaryTotals = data?.itemTotals?.reduce(
    (acc, i) => ({ expectedQty: acc.expectedQty + i.expectedQty, actualQty: acc.actualQty + receivedIncludingExtra(i), extraQty: acc.extraQty + i.extraQty, expectedPallets: acc.expectedPallets + (i.expectedPallets ?? 0), pallets: acc.pallets + i.pallets }),
    { expectedQty: 0, actualQty: 0, extraQty: 0, expectedPallets: 0, pallets: 0 },
  );

  // Same shared DataTable/TableCard the rest of the app's tables use (Stock Overview, Scan
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
    {
      id: "sapCode", header: "SAP Code", width: 110, accessor: (r) => r.sapCode ?? "", totalable: false,
      cellClassName: "font-mono text-xs text-gray-600", render: (r) => r.sapCode || "—",
    },
    { id: "expectedQty", header: "Expected", align: "right", accessor: (r) => r.expectedQty, cellClassName: "tabular-nums text-gray-700" },
    { id: "expectedPallets", header: "Expected Pallets", align: "right", accessor: (r) => r.expectedPallets ?? 0, cellClassName: "tabular-nums text-[#001d6e]", render: (r) => (r.expectedPallets ?? 0).toFixed(2), total: (rows) => rows.reduce((x, r) => x + (r.expectedPallets ?? 0), 0).toFixed(2) },
    { id: "actualQty", header: "Received", align: "right", accessor: receivedIncludingExtra, cellClassName: "tabular-nums font-medium text-emerald-600" },
    { id: "pallets", header: "Received Pallets", align: "right", accessor: (r) => r.pallets, cellClassName: "tabular-nums text-[#001d6e]", render: (r) => r.pallets.toFixed(2), total: (rows) => rows.reduce((sum, r) => sum + r.pallets, 0).toFixed(2) },
    {
      id: "extraQty", header: "Extra", align: "right", accessor: (r) => r.extraQty,
      render: (r) => <span className={r.extraQty > 0 ? "font-medium text-amber-600" : "text-gray-400"}>{r.extraQty}</span>,
    },
  ];

  const activitiesColumns: DataTableColumn<Activity>[] = [
    { id: "scannedAt", header: "Time", width: 150, accessor: (r) => r.scannedAt, totalable: false, cellClassName: "whitespace-nowrap text-xs text-gray-500", render: (r) => fmtIST(r.scannedAt) },
    { id: "barcode", header: "Barcode", width: 150, accessor: (r) => r.barcode, totalable: false, cellClassName: "font-mono text-xs text-gray-500" },
    {
      id: "itemName", header: "Item Name", accessor: (r) => r.itemName, totalable: false,
      cellClassName: "text-gray-900",
      render: (r) => (
        <>{r.itemName || "—"}</>
      ),
    },
    { id: "entryType", header: "Type", width: 150, accessor: (r) => entryTypeText(r), totalable: false, render: (r) => <EntryTypeBadges a={r} /> },
    { id: "sapCode", header: "SAP Code", width: 110, accessor: (r) => r.sapCode ?? "", totalable: false, cellClassName: "font-mono text-xs text-gray-600", render: (r) => r.sapCode || "—" },
    { id: "qty", header: "Qty", align: "right", accessor: (r) => r.qty, cellClassName: "tabular-nums font-medium text-emerald-600", render: qtyCellFor },
    { id: "pallets", header: "Pallets", align: "right", accessor: (r) => r.pallets ?? null, cellClassName: "tabular-nums text-[#001d6e]", render: (r) => r.pallets?.toFixed(2) ?? "—" },
    { id: "stv", header: "Dispatch Directory", width: 100, accessor: (r) => r.stv, totalable: false, cellClassName: "text-gray-500", render: (r) => r.stv || "—" },
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
    ...(tab === "loading"
      ? [{ id: "partyName", header: "Party Name", width: 220, accessor: (r: ReportRow) => r.partyName ?? "", totalable: false, cellClassName: "text-gray-800", render: (r: ReportRow) => r.partyName || "—" } as DataTableColumn<ReportRow>]
      : []),
    { id: "plant", header: "Plant", width: 210, accessor: (r) => (r.stockPlant && r.stockPlant !== r.plant ? `${r.plant} → ${r.stockPlant}` : r.plant), totalable: false, render: (r) => (r.plant ? <PlantRoute plant={r.plant} stockPlant={r.stockPlant} /> : "—") },
    { id: "orderCount", header: "Orders", align: "right", accessor: (r) => r.orderCount, cellClassName: "tabular-nums" },
    { id: "expectedQty", header: "Expected", align: "right", accessor: (r) => r.expectedQty, cellClassName: "tabular-nums text-gray-700" },
    { id: "expectedPallets", header: "Expected Pallets", align: "right", accessor: (r) => r.expectedPallets ?? 0, cellClassName: "tabular-nums text-[#001d6e]", render: (r) => (r.expectedPallets ?? 0).toFixed(2), total: (rows) => rows.reduce((x, r) => x + (r.expectedPallets ?? 0), 0).toFixed(2) },
    { id: "actualQty", header: "Received", align: "right", accessor: (r) => r.actualQty, cellClassName: "tabular-nums font-medium text-emerald-600" },
    { id: "receivedPallets", header: "Received Pallets", align: "right", accessor: (r) => r.receivedPallets ?? 0, cellClassName: "tabular-nums text-[#001d6e]", render: (r) => (r.receivedPallets ?? 0).toFixed(2), total: (rows) => rows.reduce((x, r) => x + (r.receivedPallets ?? 0), 0).toFixed(2) },
    {
      id: "extraQty", header: "Extra", align: "right", accessor: (r) => r.extraQty ?? 0,
      render: (r) => <span className={(r.extraQty ?? 0) > 0 ? "tabular-nums font-medium text-amber-600" : "text-gray-400"}>{r.extraQty ?? 0}</span>,
    },
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
          <Button type="button" variant="outline" size="icon" className="h-9 w-9" title="Refresh the report" aria-label="Refresh the report" onClick={() => reportQuery.refetch()} disabled={reportQuery.isFetching}>
            <RotateCw className={`h-4 w-4 ${reportQuery.isFetching ? "animate-spin" : ""}`} />
          </Button>
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
            <button
              type="button"
              onClick={() => setReportTab("hourly")}
              className={
                effectiveReportTab === "hourly"
                  ? "rounded-full bg-[#001d6e] px-4 py-1.5 text-sm font-semibold text-white ring-2 ring-[#001d6e]/30"
                  : "rounded-full border border-gray-200 bg-white px-4 py-1.5 text-sm font-medium text-gray-600 hover:bg-gray-50"
              }
            >
              Hourly Report
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

          {effectiveReportTab === "hourly" ? (
            <TableCard
              key={`rpt-hourly-${tab}`}
              icon={Clock}
              title="Hourly Report"
              subtitle={`${hourWindows.length} hour window${hourWindows.length === 1 ? "" : "s"} · ${hourTotals.scans} scan${hourTotals.scans === 1 ? "" : "s"} · ${hourTotals.qty} item(s) · ${hourTotals.pallets.toFixed(2)} plt for ${data.date}`}
              className="rounded-xl border-gray-300 shadow-none"
              headerActions={<DownloadMenu onExport={handleExportHourlyReport} />}
            >
              <div className="flex flex-wrap items-center justify-end gap-1.5 border-b border-gray-200 px-3 py-2 text-xs text-gray-500">
                Hours
                <Select value={String(hourFrom)} onValueChange={(v) => { const n = Number(v); setHourFrom(n); if (n > hourTo) setHourTo(n); }}>
                  <SelectTrigger className="h-8 w-[5.5rem] text-xs"><SelectValue /></SelectTrigger>
                  <SelectContent>{Array.from({ length: 24 }, (_, h) => <SelectItem key={h} value={String(h)}>{hourOptionLabel(h)}</SelectItem>)}</SelectContent>
                </Select>
                to
                <Select value={String(hourTo)} onValueChange={(v) => { const n = Number(v); setHourTo(n); if (n < hourFrom) setHourFrom(n); }}>
                  <SelectTrigger className="h-8 w-[5.5rem] text-xs"><SelectValue /></SelectTrigger>
                  <SelectContent>{Array.from({ length: 24 }, (_, h) => <SelectItem key={h} value={String(h)}>{`${String(h).padStart(2, "0")}:59`}</SelectItem>)}</SelectContent>
                </Select>
                {(hourFrom !== 0 || hourTo !== 23) && (
                  <button type="button" className="text-[#001d6e] underline" onClick={() => { setHourFrom(0); setHourTo(23); }}>All day</button>
                )}
              </div>
              {hourWindows.length === 0 ? (
                <p className="p-4 text-sm text-gray-400">No scans recorded</p>
              ) : (
                <div className="max-h-[560px] overflow-auto px-2">
                  <Accordion type="multiple">
                    {hourWindows.map((w) => (
                      <AccordionItem key={w.idx} value={String(w.idx)}>
                        <AccordionTrigger className="py-2.5 text-sm hover:no-underline">
                          <span className="font-medium">{w.label}</span>
                          <span className="mr-2 text-xs font-normal text-gray-500">
                            {w.events.length === 0
                              ? "no scans"
                              : `${w.events.length} scan${w.events.length === 1 ? "" : "s"} · ${w.qty} item(s) · ${w.pallets.toFixed(2)} plt`}
                          </span>
                        </AccordionTrigger>
                        <AccordionContent className="pb-3">
                          {w.events.length === 0 ? (
                            <p className="text-xs text-gray-400">No scans in this hour.</p>
                          ) : (
                            <div className="overflow-x-auto">
                              <div className="mb-2 flex justify-end">
                                <DownloadMenu onExport={(fmt) => exportRows(
                                  fmt,
                                  `${tab}-hourly-${w.label.replace(/[^\w]+/g, "_")}-${data.date}`,
                                  `${activeTab.label} — ${w.label} — ${data.date}`,
                                  hourlyExportRows(tab, [w], ["Date", data.date, "Plant", selectedPlant || "All plants"]),
                                )} />
                              </div>
                              <table className="w-full text-xs">
                                <thead>
                                  <tr className="text-left text-gray-400">
                                    <th className="py-1 pr-3 font-medium">Time</th>
                                    <th className="py-1 pr-3 font-medium">{hourlySourceHeader(tab)}</th>
                                    <th className="py-1 pr-3 font-medium">Barcode</th>
                                    <th className="py-1 pr-3 font-medium">Item Name</th>
                                    <th className="py-1 pr-3 font-medium">SAP Code</th>
                                    <th className="py-1 pr-3 font-medium">Scanned By</th>
                                    <th className="py-1 pr-3 text-right font-medium">Pallets</th>
                                    <th className="py-1 pr-3 text-right font-medium">Qty</th>
                                  </tr>
                                </thead>
                                <tbody>
                                  {w.events.map((e, i) => (
                                    <tr key={i} className="border-t border-gray-100">
                                      <td className="whitespace-nowrap py-1 pr-3 text-gray-500">{fmtIST(e.scannedAt)}</td>
                                      <td className="py-1 pr-3">{e.groupLabel || "—"}</td>
                                      <td className="py-1 pr-3 font-mono">{e.barcode || "—"}</td>
                                      <td className="py-1 pr-3">{e.itemName || "—"}<EntryTypeBadges a={e} /></td>
                                      <td className="py-1 pr-3 font-mono">{e.sapCode || "—"}</td>
                                      <td className="py-1 pr-3">{e.scannedByName || "—"}</td>
                                      <td className="py-1 pr-3 text-right">{(e.pallets ?? 0).toFixed(2)}</td>
                                      <td className="py-1 pr-3 text-right">{e.qty}</td>
                                    </tr>
                                  ))}
                                </tbody>
                              </table>
                            </div>
                          )}
                        </AccordionContent>
                      </AccordionItem>
                    ))}
                  </Accordion>
                </div>
              )}
            </TableCard>
          ) : effectiveReportTab === "summary" && (tab === "loading" || tab === "unloading") ? (
            <TableCard
              key={`rpt-summary-rows-${tab}`}
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
              key={`rpt-scan-summary-${tab}`}
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
              key={`rpt-scan-activities-${tab}`}
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
                      <span className={activity.voided ? "text-base font-semibold text-gray-400" : "text-base font-semibold text-gray-900"}>{activity.itemName || "—"}<EntryTypeBadges a={activity} /></span>
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
              key={`rpt-rows-activities-${tab}`}
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
              key={`rpt-breakdown-${tab}`}
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
              <span className={`text-sm font-semibold leading-snug ${a.voided ? "text-gray-400" : "text-gray-900"}`}>{a.itemName || "—"}<EntryTypeBadges a={a} /></span>
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
    staleTime: 0, refetchOnMount: "always", refetchInterval: 30000,
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
  { id: "sapCode", header: "SAP Code", width: 110, accessor: (r) => r.sapCode ?? "", totalable: false, cellClassName: "font-mono text-xs text-gray-600", render: (r) => r.sapCode || "—" },
  { id: "expectedQty", header: "Expected", align: "right", accessor: (r) => r.expectedQty },
  { id: "expectedPallets", header: "Expected Pallets", align: "right", accessor: (r) => r.expectedPallets ?? 0, cellClassName: "tabular-nums text-[#001d6e]", render: (r) => (r.expectedPallets ?? 0).toFixed(2), total: (rows) => rows.reduce((x, r) => x + (r.expectedPallets ?? 0), 0).toFixed(2) },
  { id: "actualQty", header: "Received", align: "right", accessor: receivedIncludingExtra },
  { id: "pallets", header: "Received Pallets", align: "right", accessor: (r) => r.pallets, render: (r) => r.pallets.toFixed(2), total: (rows) => rows.reduce((sum, r) => sum + r.pallets, 0).toFixed(2) },
  { id: "extraQty", header: "Extra", align: "right", accessor: (r) => r.extraQty },
];

// Voided scans stay listed (so the report shows the entry existed and was cancelled) but are
// greyed out with a Voided badge (see EntryTypeBadges); the server already leaves them out of every total.
const voidedRowClass = (r: Activity) => (r.voided ? "bg-red-50/60 text-gray-400" : undefined);
const qtyCellFor = (r: Activity) => (r.voided ? <span className="text-gray-400 line-through">{r.qty}</span> : r.qty);

const activitiesColumnsForDetail: DataTableColumn<Activity>[] = [
  { id: "scannedAt", header: "Time", width: 150, accessor: (r) => r.scannedAt, totalable: false, render: (r) => fmtIST(r.scannedAt) },
  { id: "barcode", header: "Barcode", width: 150, accessor: (r) => r.barcode, totalable: false, cellClassName: "font-mono text-xs text-gray-500" },
  { id: "itemName", header: "Item", accessor: (r) => r.itemName, totalable: false, render: (r) => <>{r.itemName || "—"}</> },
  { id: "entryType", header: "Type", width: 150, accessor: (r) => entryTypeText(r), totalable: false, render: (r) => <EntryTypeBadges a={r} /> },
  { id: "sapCode", header: "SAP Code", width: 110, accessor: (r) => r.sapCode ?? "", totalable: false, cellClassName: "font-mono text-xs text-gray-600", render: (r) => r.sapCode || "—" },
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
    staleTime: 0, refetchOnMount: "always", refetchInterval: 30000,
  });
  const detail = detailQuery.data;

  // Downloads only whichever tab (Item-wise Total or Activity Report) is currently open, not
  // both combined — matches the tab you're actually looking at, not an "everything" file.
  const handleExport = (fmt: Fmt) => {
    if (!detail) return;
    const header: ExportRow = ["Vehicle", detail.vehicle, "Plant", detail.stockPlant && detail.stockPlant !== detail.plant ? `${detail.plant} → ${detail.stockPlant}` : detail.plant ?? ""];
    const timing: ExportRow = ["Start", fmtIST(detail.startTime), "End", fmtIST(detail.endTime), "Total Time", fmtTotalTime(detail.startTime, detail.endTime)];
    const rows: ExportRow[] = detailTab === "items"
      ? [
          header, timing, [],
          ["Barcode", "Item Name", "SAP Code", "Expected Qty", "Expected Pallets", "Received Qty", "Extra Qty", "Received Pallets"],
          ...detail.itemTotals.map((i) => [barcodeCell(i.barcode), i.itemName ?? "", i.sapCode ?? "", i.expectedQty, (i.expectedPallets ?? 0).toFixed(2), receivedIncludingExtra(i), i.extraQty, i.pallets.toFixed(2)]),
        ]
      : [
          header, timing, [],
          ...activityExportRows(detail.activities, null),
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
          <DialogDescription>{detail?.plant ? <PlantRoute plant={detail.plant} stockPlant={detail.stockPlant} className="px-2 py-0 text-[11px]" /> : ""} · {date}</DialogDescription>
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
    staleTime: 0, refetchOnMount: "always", refetchInterval: 30000,
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
          ["Barcode", "Item Name", "SAP Code", "Expected Qty", "Expected Pallets", "Received Qty", "Extra Qty", "Received Pallets"],
          ...detail.itemTotals.map((i) => [barcodeCell(i.barcode), i.itemName ?? "", i.sapCode ?? "", i.expectedQty, (i.expectedPallets ?? 0).toFixed(2), receivedIncludingExtra(i), i.extraQty, i.pallets.toFixed(2)]),
        ]
      : [
          header, timing, [],
          ...activityExportRows(detail.activities, "STV"),
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
              {row.partyName && <span className="block truncate text-xs font-medium text-gray-800">{row.partyName}</span>}
              <span className="text-[11px] leading-none text-gray-500">{identityLabel}</span>
            </div>
            {row.key !== "—" && (
              <Button type="button" size="sm" variant="outline" className="h-7 shrink-0 gap-1 px-2.5 text-xs" onClick={() => onOpen(row)}>
                <Eye className="h-3.5 w-3.5" /> View
              </Button>
            )}
          </div>
          <div className="mt-1.5 grid grid-cols-3 items-center gap-x-2 gap-y-1 text-xs text-gray-600">
            <span className={`flex items-center ${row.stockPlant && row.stockPlant !== row.plant ? "col-span-3" : ""}`}>{row.plant ? <PlantRoute plant={row.plant} stockPlant={row.stockPlant} className="px-1.5 py-0 text-[11px]" /> : <strong className="text-gray-900">—</strong>}</span>
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
