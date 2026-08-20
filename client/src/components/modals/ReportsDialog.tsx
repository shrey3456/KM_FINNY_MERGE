import { useState } from "react";
import {
  ChevronDown, Download, Eye, ListChecks, Loader2,
} from "lucide-react";
import { apiRequest } from "@/lib/queryClient";
import { Button } from "@/components/ui/button";
import {
  Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription, DialogFooter,
} from "@/components/ui/dialog";
import {
  DropdownMenu, DropdownMenuTrigger, DropdownMenuContent, DropdownMenuItem, DropdownMenuSeparator,
} from "@/components/ui/dropdown-menu";
import { useToast } from "@/hooks/use-toast";
import { DataTable, type DataTableColumn } from "@/components/ui/data-table";
import * as XLSX from "xlsx";
import jsPDF from "jspdf";
import autoTable from "jspdf-autotable";

// ─── Types (mirror the server report shapes) ────────────────────────────────
type GroupReportEntry = {
  barcode: string; itemName: string; itemsPerPallet: number; expectedQty: number; receivedQty: number;
  extraQty: number; missingQty: number;
  adjustedTo: { toPartId: number; toCsvFileName: string; qty: number }[];
  adjustedFrom: { fromPartId: number; fromCsvFileName: string; qty: number }[];
  remainingExtra: number; remainingMissing: number;
};
type GroupReportPart = {
  id: number; partIndex: number; csvFileName: string; plant: string;
  scanStatus: string | null; rowCount: number | null;
  scanActivatedAt: string | null; scanCompletedAt: string | null;
  items: GroupReportEntry[];
  summary: {
    totalExpected: number; totalReceived: number; totalExtra: number; totalMissing: number;
    totalAdjustedTo: number; totalAdjustedFrom: number;
    netExtraAfterAdjustment: number; netMissingAfterAdjustment: number;
  };
};
type GroupReport = {
  groupId: number; plant: string;
  parts: GroupReportPart[];
  consolidated: {
    totalExpected: number; totalReceived: number; totalExtra: number; totalMissing: number;
    totalAdjustments: number; finalStockAdded: number;
    netExtraAfterAdjustment: number; netMissingAfterAdjustment: number;
    allComplete: boolean;
    productWise: { barcode: string; itemName: string; itemsPerPallet: number; totalExpected: number; totalReceived: number; totalExtra: number; totalMissing: number; totalAdjusted: number }[];
  };
};
type ScanEvent = {
  sessionId: number; barcode: string | null; itemName: string | null;
  pallets: number | null; looseQty: number | null; totalQty: number | null;
  isExtra: boolean | null; stv: string | null;
  scannedByCode: string | null; scannedByName: string | null; scannedAt: string | null;
  partIndex: number | null; csvFileName: string | null;
  // Voided scans are kept in this list (never dropped — same "kept in history" rule as Scan
  // History), just clearly marked, so the raw event count here can differ from the Summary
  // report's Received total (which already excludes voided) without looking unexplained.
  voided: boolean | null; voidedAt: string | null; voidReason: string | null;
};
type ScanActivitySession = {
  id: number; partIndex: number | null; csvFileName: string | null;
  scanActivatedAt: string | null; scanCompletedAt: string | null;
};
type ScanActivity = { scope: string; totalEvents: number; events: ScanEvent[]; sessions?: ScanActivitySession[] };

type Fmt = "CSV" | "Excel" | "PDF";
type Row = (string | number)[];

function fmtIST(dt: string | null | undefined): string {
  if (!dt) return "—";
  const d = new Date(dt);
  return isNaN(d.getTime()) ? "—" : d.toLocaleString("en-IN", { timeZone: "Asia/Kolkata" });
}
function fmtDuration(startedAt: string | null | undefined, completedAt: string | null | undefined): string {
  if (!startedAt || !completedAt) return "—";
  const start = new Date(startedAt).getTime();
  const end = new Date(completedAt).getTime();
  if (isNaN(start) || isNaN(end) || end < start) return "—";
  const totalMinutes = Math.round((end - start) / 60000);
  const hours = Math.floor(totalMinutes / 60);
  const minutes = totalMinutes % 60;
  return hours > 0 ? `${hours}h ${minutes}m` : `${minutes}m`;
}
// One row per part, prepended above the report's own header row — "Started"/"Completed"/
// "Active For" for every export, matching what's shown on Scan Order/Scan Viewer. A single
// blank row separates it from the report's real column header so exports don't misread it as
// a data row.
function buildTimingRows(parts: { partIndex: number; csvFileName: string; scanActivatedAt: string | null; scanCompletedAt: string | null }[]): Row[] {
  const rows: Row[] = [["Part", "File", "Started", "Completed", "Active For"]];
  parts.forEach((p) => rows.push([
    p.partIndex, p.csvFileName, fmtIST(p.scanActivatedAt), fmtIST(p.scanCompletedAt), fmtDuration(p.scanActivatedAt, p.scanCompletedAt),
  ]));
  rows.push([]);
  return rows;
}
function exportRows(fmt: Fmt, baseName: string, title: string, rows: Row[]) {
  if (fmt === "CSV") {
    const csv = rows.map((r) => r.map((c) => `"${String(c ?? "").replace(/"/g, '""')}"`).join(",")).join("\n");
    const a = document.createElement("a");
    a.href = URL.createObjectURL(new Blob([csv], { type: "text/csv;charset=utf-8;" }));
    a.download = `${baseName}.csv`;
    a.click();
    URL.revokeObjectURL(a.href);
  } else if (fmt === "Excel") {
    const sheet = XLSX.utils.aoa_to_sheet(rows);
    const book = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(book, sheet, "Report");
    XLSX.writeFile(book, `${baseName}.xlsx`);
  } else {
    const doc = new jsPDF({ orientation: "landscape" });
    doc.setFontSize(12);
    doc.text(title, 14, 12);
    const [header, ...body] = rows;
    autoTable(doc, { head: [header as string[]], body: body as string[][], startY: 18, styles: { fontSize: 8 }, headStyles: { fillColor: [0, 29, 110] } });
    doc.save(`${baseName}.pdf`);
  }
}
function safe(name: string) { return name.replace(/\.csv$/i, "").replace(/[^\w.-]+/g, "_"); }

// A qty cell that also carries its pallet count on a second line ("40\n1.00 plt"), rendered as
// two lines in the report view/exports. Plain qty when the pallet size is unknown (ipp <= 0).
// items-per-pallet comes straight from the server report (derived there from each CSV row's
// quantity ÷ expectedPallets) — no separate products lookup needed.
const qtyWithPlt = (qty: number, ipp: number): string =>
  ipp > 0 ? `${qty}\n${(qty / ipp).toFixed(2)} plt` : String(qty);

// includeTiming defaults on for downloads; the "View" dialog passes false and shows the same
// info in its own header instead (see viewPart etc.) — the DataTable there always treats
// rows[0] as the column header, so prepending the timing block would make it misread that
// as the header and the real header as a data row.
function buildPartRows(part: GroupReportPart, includeTiming = true): Row[] {
  // Each qty cell also shows its pallet equivalent below (qty ÷ items-per-pallet). The TOTAL row
  // sums pallets PER-ITEM (each with its own pallet size) so it lines up with the rows above.
  const rows: Row[] = [
    ...(includeTiming ? buildTimingRows([{ partIndex: part.partIndex, csvFileName: part.csvFileName, scanActivatedAt: part.scanActivatedAt, scanCompletedAt: part.scanCompletedAt }]) : []),
    ["Barcode", "Item Name", "Expected", "Received", "Extra", "Missing",
    "Adj To Next", "Adj From Prev", "Net Extra", "Net Missing"],
  ];
  const pltSum = { exp: 0, rec: 0, ext: 0, mis: 0, adjTo: 0, adjFrom: 0, netE: 0, netM: 0 };
  let anyPlt = false;
  part.items.forEach((i) => {
    const ipp = i.itemsPerPallet ?? 0;
    const adjTo = i.adjustedTo.reduce((s, a) => s + a.qty, 0);
    const adjFrom = i.adjustedFrom.reduce((s, a) => s + a.qty, 0);
    if (ipp > 0) {
      anyPlt = true;
      pltSum.exp += i.expectedQty / ipp; pltSum.rec += i.receivedQty / ipp;
      pltSum.ext += i.extraQty / ipp; pltSum.mis += i.missingQty / ipp;
      pltSum.adjTo += adjTo / ipp; pltSum.adjFrom += adjFrom / ipp;
      pltSum.netE += i.remainingExtra / ipp; pltSum.netM += i.remainingMissing / ipp;
    }
    rows.push([
      i.barcode, i.itemName,
      qtyWithPlt(i.expectedQty, ipp), qtyWithPlt(i.receivedQty, ipp), qtyWithPlt(i.extraQty, ipp), qtyWithPlt(i.missingQty, ipp),
      qtyWithPlt(adjTo, ipp), qtyWithPlt(adjFrom, ipp), qtyWithPlt(i.remainingExtra, ipp), qtyWithPlt(i.remainingMissing, ipp),
    ]);
  });
  rows.push([]);
  const s = part.summary;
  const totalCell = (qty: number, plt: number) => (anyPlt ? `${qty}\n${plt.toFixed(2)} plt` : String(qty));
  rows.push(["TOTAL", "",
    totalCell(s.totalExpected, pltSum.exp), totalCell(s.totalReceived, pltSum.rec), totalCell(s.totalExtra, pltSum.ext), totalCell(s.totalMissing, pltSum.mis),
    totalCell(s.totalAdjustedTo, pltSum.adjTo), totalCell(s.totalAdjustedFrom, pltSum.adjFrom), totalCell(s.netExtraAfterAdjustment, pltSum.netE), totalCell(s.netMissingAfterAdjustment, pltSum.netM),
  ]);
  return rows;
}

function buildGroupRows(report: GroupReport, kind: "partwise" | "final", includeTiming = true): Row[] {
  const timingRows = includeTiming ? buildTimingRows(report.parts.map((p) => ({
    partIndex: p.partIndex, csvFileName: p.csvFileName, scanActivatedAt: p.scanActivatedAt, scanCompletedAt: p.scanCompletedAt,
  }))) : [];
  if (kind === "partwise") {
    // Each qty cell also carries its pallet equivalent on a second line (qty ÷ items-per-pallet).
    const rows: Row[] = [...timingRows, ["Part", "File", "Status", "Barcode", "Item Name", "Expected", "Received", "Extra", "Missing", "Adj To Next", "Adj From Prev", "Net Extra", "Net Missing"]];
    report.parts.forEach((p) => p.items.forEach((i) => {
      const ipp = i.itemsPerPallet ?? 0;
      rows.push([
        p.partIndex, p.csvFileName, p.scanStatus ?? "", i.barcode, i.itemName,
        qtyWithPlt(i.expectedQty, ipp), qtyWithPlt(i.receivedQty, ipp), qtyWithPlt(i.extraQty, ipp), qtyWithPlt(i.missingQty, ipp),
        qtyWithPlt(i.adjustedTo.reduce((s, a) => s + a.qty, 0), ipp), qtyWithPlt(i.adjustedFrom.reduce((s, a) => s + a.qty, 0), ipp),
        qtyWithPlt(i.remainingExtra, ipp), qtyWithPlt(i.remainingMissing, ipp),
      ]);
    }));
    return rows;
  }
  // Final Summary: each qty cell also shows its pallet equivalent on a second line (qty ÷
  // items-per-pallet). The consolidated TOTAL row sums pallets PER-PRODUCT (each with its own
  // pallet size) rather than dividing the grand total by one size, so it matches the rows above.
  const rows: Row[] = [...timingRows, ["Barcode", "Item Name", "Total Expected", "Total Received", "Total Extra", "Total Missing", "Total Adjusted"]];
  const pltSum = { exp: 0, rec: 0, ext: 0, mis: 0, adj: 0 };
  let anyPlt = false;
  report.consolidated.productWise.forEach((pw) => {
    const ipp = pw.itemsPerPallet ?? 0;
    if (ipp > 0) {
      anyPlt = true;
      pltSum.exp += pw.totalExpected / ipp;
      pltSum.rec += pw.totalReceived / ipp;
      pltSum.ext += pw.totalExtra / ipp;
      pltSum.mis += pw.totalMissing / ipp;
      pltSum.adj += pw.totalAdjusted / ipp;
    }
    rows.push([
      pw.barcode, pw.itemName,
      qtyWithPlt(pw.totalExpected, ipp), qtyWithPlt(pw.totalReceived, ipp), qtyWithPlt(pw.totalExtra, ipp),
      qtyWithPlt(pw.totalMissing, ipp), qtyWithPlt(pw.totalAdjusted, ipp),
    ]);
  });
  rows.push([]);
  const c = report.consolidated;
  const totalCell = (qty: number, plt: number) => (anyPlt ? `${qty}\n${plt.toFixed(2)} plt` : String(qty));
  rows.push(["CONSOLIDATED", "",
    totalCell(c.totalExpected, pltSum.exp), totalCell(c.totalReceived, pltSum.rec), totalCell(c.totalExtra, pltSum.ext),
    totalCell(c.totalMissing, pltSum.mis), totalCell(c.totalAdjustments, pltSum.adj),
  ]);
  rows.push(["Final Stock Added", c.finalStockAdded, "Net Extra", c.netExtraAfterAdjustment, "Net Missing", c.netMissingAfterAdjustment, ""]);
  return rows;
}

function buildActivityRows(data: ScanActivity, scope: "part" | "group", includeTiming = true): Row[] {
  const groupCols = scope === "group";
  const header: Row = [
    "#", ...(groupCols ? ["Part", "File"] : []),
    "Scanned By", "User Code", "Barcode", "Item Name", "Pallets", "Loose", "Total Qty", "Type", "STV", "Time", "Void",
  ];
  const timingRows = includeTiming && data.sessions
    ? buildTimingRows(data.sessions.map((s) => ({
        partIndex: s.partIndex ?? 0, csvFileName: s.csvFileName ?? "", scanActivatedAt: s.scanActivatedAt, scanCompletedAt: s.scanCompletedAt,
      })))
    : [];
  const rows: Row[] = [...timingRows, header];
  data.events.forEach((e, idx) => rows.push([
    idx + 1, ...(groupCols ? [e.partIndex ?? "", e.csvFileName ?? ""] : []),
    e.scannedByName ?? "", e.scannedByCode ?? "", e.barcode ?? "", e.itemName ?? "",
    e.pallets ?? 0, e.looseQty ?? 0, e.totalQty ?? 0, e.isExtra ? "Extra" : "Regular",
    e.stv ?? "", fmtIST(e.scannedAt),
    e.voided ? `Voided${e.voidedAt ? ` (${fmtIST(e.voidedAt)})` : ""}${e.voidReason ? ` — ${e.voidReason}` : ""}` : "",
  ]));
  if (data.events.length === 0) rows.push(["No scans recorded"]);
  return rows;
}

export type ReportsDialogSession = {
  id: number;
  csvFileName: string;
  plant: string;
  receivingSessionId?: number | null;
  partIndex?: number | null;
};

type ReportsDialogProps = {
  session: ReportsDialogSession | null;
  onClose: () => void;
};

// Per-CSV (and, when the CSV is part of a FIFO batch, per-group) Summary/Activity reports —
// view in-browser or download CSV/Excel/PDF. Opened from a row's Reports action in
// OrderImport.tsx's Active/Completed/History tabs; replaces the old standalone Order Reports
// page, minus its delete button (deleting a CSV stays Order Import's own, more careful,
// replace-vs-discard flow).
export default function ReportsDialog({ session, onClose }: ReportsDialogProps) {
  const { toast } = useToast();
  const [busy, setBusy] = useState<string | null>(null);
  const [viewData, setViewData] = useState<{ title: string; rows: Row[] } | null>(null);

  const fetchPartReport = (sessionId: number) =>
    apiRequest("GET", `/api/order-import/sessions/${sessionId}/part-report`).then((r) => r.json()) as Promise<GroupReportPart>;
  const fetchGroupReport = (groupId: number) =>
    apiRequest("GET", `/api/order-import/sessions/${groupId}/group-report`).then((r) => r.json()) as Promise<GroupReport>;
  const fetchActivity = (sessionId: number, scope: "part" | "group") =>
    apiRequest("GET", `/api/order-import/sessions/${sessionId}/scan-activity?scope=${scope}`).then((r) => r.json()) as Promise<ScanActivity>;

  async function downloadPart(fmt: Fmt) {
    if (!session) return;
    setBusy(`part-${fmt}`);
    try {
      const rows = buildPartRows(await fetchPartReport(session.id));
      exportRows(fmt, `part-report-${safe(session.csvFileName)}`, `Part Report — ${session.csvFileName}`, rows);
    } catch {
      toast({ title: "Failed to download report", variant: "destructive" });
    } finally { setBusy(null); }
  }

  async function downloadPartActivity(fmt: Fmt) {
    if (!session) return;
    setBusy(`activity-part-${fmt}`);
    try {
      const rows = buildActivityRows(await fetchActivity(session.id, "part"), "part");
      exportRows(fmt, `scan-activity-${safe(session.csvFileName)}`, `Scan Activity — ${session.csvFileName}`, rows);
    } catch {
      toast({ title: "Failed to download activity", variant: "destructive" });
    } finally { setBusy(null); }
  }

  async function downloadGroup(kind: "partwise" | "final", fmt: Fmt) {
    if (!session?.receivingSessionId) return;
    const groupId = session.receivingSessionId;
    setBusy(`group-${kind}-${fmt}`);
    try {
      const rows = buildGroupRows(await fetchGroupReport(groupId), kind);
      exportRows(fmt, `fifo-${kind}-group${groupId}`, `FIFO ${kind === "partwise" ? "CSV-wise" : "Final"} Report`, rows);
    } catch {
      toast({ title: "Failed to download report", variant: "destructive" });
    } finally { setBusy(null); }
  }

  async function downloadGroupActivity(fmt: Fmt) {
    if (!session?.receivingSessionId) return;
    const groupId = session.receivingSessionId;
    setBusy(`activity-group-${fmt}`);
    try {
      const rows = buildActivityRows(await fetchActivity(groupId, "group"), "group");
      exportRows(fmt, `scan-activity-group${groupId}-all`, `Scan Activity — Group #${groupId} (all parts)`, rows);
    } catch {
      toast({ title: "Failed to download activity", variant: "destructive" });
    } finally { setBusy(null); }
  }

  async function viewPart() {
    if (!session) return;
    setBusy("view-part");
    try {
      // includeTiming false — the View table always reads rows[0] as its column header, so the
      // timing block (only meaningful in the flat CSV/Excel/PDF exports) is left out here.
      const rows = buildPartRows(await fetchPartReport(session.id), false);
      setViewData({ title: `Part Report — ${session.csvFileName}`, rows });
    } catch {
      toast({ title: "Failed to load report", variant: "destructive" });
    } finally { setBusy(null); }
  }

  async function viewPartActivity() {
    if (!session) return;
    setBusy("view-activity-part");
    try {
      const rows = buildActivityRows(await fetchActivity(session.id, "part"), "part", false);
      setViewData({ title: `Scan Activity — ${session.csvFileName}`, rows });
    } catch {
      toast({ title: "Failed to load activity", variant: "destructive" });
    } finally { setBusy(null); }
  }

  async function viewGroup(kind: "partwise" | "final") {
    if (!session?.receivingSessionId) return;
    const groupId = session.receivingSessionId;
    setBusy(`view-group-${kind}`);
    try {
      const rows = buildGroupRows(await fetchGroupReport(groupId), kind, false);
      setViewData({ title: `FIFO ${kind === "partwise" ? "CSV-wise" : "Final"} Report — Group #${groupId}`, rows });
    } catch {
      toast({ title: "Failed to load report", variant: "destructive" });
    } finally { setBusy(null); }
  }

  async function viewGroupActivity() {
    if (!session?.receivingSessionId) return;
    const groupId = session.receivingSessionId;
    setBusy("view-activity-group");
    try {
      const rows = buildActivityRows(await fetchActivity(groupId, "group"), "group", false);
      setViewData({ title: `Scan Activity — Group #${groupId} (all parts)`, rows });
    } catch {
      toast({ title: "Failed to load activity", variant: "destructive" });
    } finally { setBusy(null); }
  }

  // One button → dropdown offering "View" (opens in-browser, no file) plus CSV/Excel/PDF
  // download.
  const DownloadMenu = ({ label, icon, onPick, onView, busyKey, variant = "outline" }: {
    label: string; icon?: React.ReactNode; onPick: (f: Fmt) => void; onView?: () => void;
    busyKey: string; variant?: "outline" | "default";
  }) => {
    const isBusy = busy === busyKey || busy?.startsWith(`${busyKey}-`);
    return (
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <Button size="sm" variant={variant}
            className={`h-8 gap-1 px-2.5 text-xs ${variant === "default" ? "bg-[#001d6e] hover:bg-[#00154b] text-white" : ""}`}
            disabled={isBusy}>
            {isBusy ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : (icon ?? <Download className="h-3.5 w-3.5" />)}
            {label}
            <ChevronDown className="h-3 w-3 opacity-60" />
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="start" className="min-w-[9rem]">
          {onView && (
            <>
              <DropdownMenuItem onClick={onView} className="text-xs cursor-pointer">
                <Eye className="mr-2 h-3.5 w-3.5" /> View
              </DropdownMenuItem>
              <DropdownMenuSeparator />
            </>
          )}
          {(["CSV", "Excel", "PDF"] as Fmt[]).map((f) => (
            <DropdownMenuItem key={f} onClick={() => onPick(f)} className="text-xs cursor-pointer">
              <Download className="mr-2 h-3.5 w-3.5" /> {f}
            </DropdownMenuItem>
          ))}
        </DropdownMenuContent>
      </DropdownMenu>
    );
  };

  return (
    <>
      <Dialog open={session != null} onOpenChange={(open) => { if (!open) onClose(); }}>
        <DialogContent className="max-w-lg">
          <DialogHeader>
            <DialogTitle className="text-[#001d6e]">
              {session ? `Reports — ${session.plant} · ${session.csvFileName}` : "Reports"}
            </DialogTitle>
            <DialogDescription className="text-xs">
              {session?.receivingSessionId ? `Part ${session.partIndex ?? "?"} of a FIFO batch — group-wide reports below too.` : "Standalone CSV import."}
            </DialogDescription>
          </DialogHeader>

          <div className="space-y-4">
            <div>
              <p className="mb-1.5 text-xs font-semibold uppercase tracking-wide text-gray-400">This CSV</p>
              <div className="flex flex-wrap gap-2">
                <DownloadMenu label="Summary" busyKey="part" onPick={downloadPart} onView={viewPart} />
                <DownloadMenu label="Activity" icon={<ListChecks className="h-3.5 w-3.5" />} busyKey="activity-part"
                  onPick={downloadPartActivity} onView={viewPartActivity} />
              </div>
            </div>

            {session?.receivingSessionId && (
              <div>
                <p className="mb-1.5 text-xs font-semibold uppercase tracking-wide text-gray-400">
                  Whole Order (Group #{session.receivingSessionId})
                </p>
                <div className="flex flex-wrap gap-2">
                  <DownloadMenu label="Final Summary" variant="default" busyKey="group-final"
                    onPick={(f) => downloadGroup("final", f)} onView={() => viewGroup("final")} />
                  <DownloadMenu label="CSV-wise" busyKey="group-partwise"
                    onPick={(f) => downloadGroup("partwise", f)} onView={() => viewGroup("partwise")} />
                  <DownloadMenu label="Activity" icon={<ListChecks className="h-3.5 w-3.5" />} busyKey="activity-group"
                    onPick={downloadGroupActivity} onView={viewGroupActivity} />
                </div>
              </div>
            )}
          </div>

          <DialogFooter>
            <Button variant="outline" onClick={onClose}>Close</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* View-in-browser — same data as the downloads, rendered with the shared DataTable
          (sortable/resizable columns) instead of a hand-rolled table. The report shape varies
          per kind (part/group summary vs activity), so columns are built dynamically from the
          header row rather than a fixed column list. */}
      <Dialog open={!!viewData} onOpenChange={(open) => { if (!open) setViewData(null); }}>
        <DialogContent className="max-w-5xl max-h-[85vh] flex flex-col">
          <DialogHeader>
            <DialogTitle className="text-base">{viewData?.title}</DialogTitle>
            <DialogDescription className="text-xs">
              {viewData ? `${Math.max(0, viewData.rows.length - 1)} row(s)` : ""}
            </DialogDescription>
          </DialogHeader>
          <div className="min-h-0 flex-1 overflow-auto">
            {viewData && (
              <DataTable<Row>
                className="space-y-0"
                containerClassName="rounded-none border"
                columns={viewData.rows[0].map((h, i): DataTableColumn<Row> => ({
                  id: String(i),
                  header: String(h),
                  width: 140,
                  // Right-align numeric columns — including the Final Summary's "qty\nN plt"
                  // two-line cells (strings containing "plt"), which would otherwise read as text.
                  align: (typeof viewData.rows[1]?.[i] === "number"
                    || (typeof viewData.rows[1]?.[i] === "string" && String(viewData.rows[1][i]).includes("plt")))
                    ? "right" : "left",
                  accessor: (row) => row[i],
                  render: (row) => {
                    const cell = row[i];
                    if (cell === "" || cell == null) return <span className="text-gray-300">—</span>;
                    const s = String(cell);
                    // Final Summary qty cells carry their pallet count on a second line
                    // ("40\n1.00 plt") — render both, the plt line smaller/muted below the qty.
                    if (s.includes("\n")) {
                      const [qty, plt] = s.split("\n");
                      return (
                        <span className="block leading-tight">
                          <span className="block">{qty}</span>
                          <span className="block text-[11px] font-medium text-gray-500">{plt}</span>
                        </span>
                      );
                    }
                    return s;
                  },
                }))}
                data={viewData.rows.slice(1).filter((r) => r.length > 0)}
                getRowId={(_row, index) => String(index)}
                rowClassName={(row) =>
                  typeof row[0] === "string" && /^(TOTAL|CONSOLIDATED|Final Stock Added|No scans recorded)$/i.test(String(row[0]))
                    ? "bg-slate-50 font-semibold"
                    // Activity rows' "Void" column starts with "Voided" when set — grey these
                    // out so a cancelled scan reads as cancelled at a glance, same treatment
                    // Scan History gives voided rows, instead of looking like a normal one.
                    : row.some((c) => typeof c === "string" && c.startsWith("Voided"))
                    ? "bg-red-50/50 text-gray-400"
                    : undefined
                }
                enableZebraStripes
                enableColumnResizing
                paginationMode="none"
                headerClassName="bg-[#001d6e] text-white border-[#1a3a9c] hover:bg-[#0a2b7e] hover:text-white"
              />
            )}
          </div>
          <DialogFooter className="mt-2">
            <Button variant="outline" onClick={() => setViewData(null)}>Close</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}
