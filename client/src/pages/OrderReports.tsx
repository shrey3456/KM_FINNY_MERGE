import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { Link } from "wouter";
import {
  ArrowLeft, CalendarDays, ChevronDown, Download, Layers, ListChecks, Loader2, RefreshCw, Search, X,
} from "lucide-react";
import { apiRequest } from "@/lib/queryClient";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  Select, SelectContent, SelectItem, SelectTrigger, SelectValue,
} from "@/components/ui/select";
import {
  DropdownMenu, DropdownMenuTrigger, DropdownMenuContent, DropdownMenuItem,
} from "@/components/ui/dropdown-menu";
import { useToast } from "@/hooks/use-toast";
import * as XLSX from "xlsx";
import jsPDF from "jspdf";
import autoTable from "jspdf-autotable";

// ─── Types (mirror the server report shapes) ────────────────────────────────
type ImportSessionRow = {
  id: number; plant: string; csvFileName: string; rowCount: number | null;
  importedByName: string | null; createdAt: string | null; scanStatus: string | null;
  receivingSessionId: number | null; partIndex: number | null;
};
type GroupReportEntry = {
  barcode: string; itemName: string; expectedQty: number; receivedQty: number;
  extraQty: number; missingQty: number;
  adjustedTo: { toPartId: number; toCsvFileName: string; qty: number }[];
  adjustedFrom: { fromPartId: number; fromCsvFileName: string; qty: number }[];
  remainingExtra: number; remainingMissing: number;
};
type GroupReportPart = {
  id: number; partIndex: number; csvFileName: string; plant: string;
  scanStatus: string | null; rowCount: number | null;
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
    productWise: { barcode: string; itemName: string; totalExpected: number; totalReceived: number; totalExtra: number; totalMissing: number; totalAdjusted: number }[];
  };
};

type ScanEvent = {
  sessionId: number; barcode: string | null; itemName: string | null;
  pallets: number | null; looseQty: number | null; totalQty: number | null;
  isExtra: boolean | null; stv: string | null;
  scannedByCode: string | null; scannedByName: string | null; scannedAt: string | null;
  partIndex: number | null; csvFileName: string | null;
};
type ScanActivity = { scope: string; totalEvents: number; events: ScanEvent[] };

type Fmt = "CSV" | "Excel" | "PDF";
type Row = (string | number)[];

// ─── Helpers ────────────────────────────────────────────────────────────────
function getLocalISODate(d = new Date()) {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}
function fmtIST(dt: string | null | undefined): string {
  if (!dt) return "—";
  const s = String(dt);
  const d = new Date(/Z$|[+-]\d{2}:\d{2}$/.test(s) ? s : s.replace(" ", "T") + "Z");
  return isNaN(d.getTime()) ? "—" : d.toLocaleString("en-IN", { timeZone: "UTC" });
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

// ─── Component ──────────────────────────────────────────────────────────────
export default function OrderReports() {
  const { toast } = useToast();
  const [date, setDate] = useState(getLocalISODate());
  const [plant, setPlant] = useState("");
  const [search, setSearch] = useState("");
  const [busy, setBusy] = useState<string | null>(null); // key of the report currently downloading

  const plantsQuery = useQuery<{ name: string }[]>({
    queryKey: ["/api/plants"],
    queryFn: async () => (await apiRequest("GET", "/api/plants")).json(),
  });
  const plantOptions = (plantsQuery.data ?? []).filter((p) => p.name && p.name.trim() !== "");

  const sessionsQuery = useQuery<{ sessions: ImportSessionRow[] }>({
    queryKey: ["/api/order-import/sessions", "order-reports", date, plant],
    queryFn: async () => {
      const p = new URLSearchParams({ page: "1", pageSize: "100" });
      if (date) p.set("date", date);
      if (plant) p.set("plant", plant);
      return (await apiRequest("GET", `/api/order-import/sessions?${p}`)).json();
    },
    staleTime: 0,
    refetchInterval: 15000,
  });

  const allSessions = sessionsQuery.data?.sessions ?? [];
  const sessions = search
    ? allSessions.filter((s) => [s.csvFileName, s.plant, s.importedByName].some((v) => v?.toLowerCase().includes(search.toLowerCase())))
    : allSessions;

  // Split into FIFO groups (receivingSessionId set) and standalone single imports.
  const groups = new Map<number, ImportSessionRow[]>();
  const standalone: ImportSessionRow[] = [];
  for (const s of sessions) {
    if (s.receivingSessionId) {
      if (!groups.has(s.receivingSessionId)) groups.set(s.receivingSessionId, []);
      groups.get(s.receivingSessionId)!.push(s);
    } else {
      standalone.push(s);
    }
  }
  groups.forEach((arr) => arr.sort((a, b) => (a.partIndex ?? 0) - (b.partIndex ?? 0)));

  // ── Download actions ──
  async function downloadPart(session: ImportSessionRow, fmt: Fmt) {
    const key = `part-${session.id}-${fmt}`;
    setBusy(key);
    try {
      const part: GroupReportPart = await (await apiRequest("GET", `/api/order-import/sessions/${session.id}/part-report`)).json();
      const rows: Row[] = [[
        "Barcode", "Item Name", "Expected", "Received", "Extra", "Missing",
        "Adj To Next", "Adj From Prev", "Net Extra", "Net Missing",
      ]];
      part.items.forEach((i) => rows.push([
        i.barcode, i.itemName, i.expectedQty, i.receivedQty, i.extraQty, i.missingQty,
        i.adjustedTo.reduce((s, a) => s + a.qty, 0), i.adjustedFrom.reduce((s, a) => s + a.qty, 0),
        i.remainingExtra, i.remainingMissing,
      ]));
      rows.push([]);
      rows.push(["TOTAL", "", part.summary.totalExpected, part.summary.totalReceived, part.summary.totalExtra, part.summary.totalMissing, part.summary.totalAdjustedTo, part.summary.totalAdjustedFrom, part.summary.netExtraAfterAdjustment, part.summary.netMissingAfterAdjustment]);
      exportRows(fmt, `part-report-${safe(session.csvFileName)}`, `Part Report — ${session.csvFileName}`, rows);
    } catch {
      toast({ title: "Failed to download report", variant: "destructive" });
    } finally { setBusy(null); }
  }

  async function downloadGroup(groupId: number, kind: "partwise" | "final", fmt: Fmt) {
    const key = `group-${groupId}-${kind}-${fmt}`;
    setBusy(key);
    try {
      const report: GroupReport = await (await apiRequest("GET", `/api/order-import/sessions/${groupId}/group-report`)).json();
      let rows: Row[];
      if (kind === "partwise") {
        rows = [["Part", "File", "Status", "Barcode", "Item Name", "Expected", "Received", "Extra", "Missing", "Adj To Next", "Adj From Prev", "Net Extra", "Net Missing"]];
        report.parts.forEach((p) => p.items.forEach((i) => rows.push([
          p.partIndex, p.csvFileName, p.scanStatus ?? "", i.barcode, i.itemName,
          i.expectedQty, i.receivedQty, i.extraQty, i.missingQty,
          i.adjustedTo.reduce((s, a) => s + a.qty, 0), i.adjustedFrom.reduce((s, a) => s + a.qty, 0),
          i.remainingExtra, i.remainingMissing,
        ])));
      } else {
        rows = [["Barcode", "Item Name", "Total Expected", "Total Received", "Total Extra", "Total Missing", "Total Adjusted"]];
        report.consolidated.productWise.forEach((pw) => rows.push([pw.barcode, pw.itemName, pw.totalExpected, pw.totalReceived, pw.totalExtra, pw.totalMissing, pw.totalAdjusted]));
        rows.push([]);
        rows.push(["CONSOLIDATED", "", report.consolidated.totalExpected, report.consolidated.totalReceived, report.consolidated.totalExtra, report.consolidated.totalMissing, report.consolidated.totalAdjustments]);
        rows.push(["Final Stock Added", report.consolidated.finalStockAdded, "Net Extra", report.consolidated.netExtraAfterAdjustment, "Net Missing", report.consolidated.netMissingAfterAdjustment, ""]);
      }
      exportRows(fmt, `fifo-${kind}-group${groupId}`, `FIFO ${kind === "partwise" ? "CSV-wise" : "Final"} Report`, rows);
    } catch {
      toast({ title: "Failed to download report", variant: "destructive" });
    } finally { setBusy(null); }
  }

  // Scan Activity report — full scan history (who/when/qty/extra/STV). scope=part for one
  // CSV, scope=group for the whole FIFO batch (each row tagged with its Part # + file).
  async function downloadActivity(sessionId: number, scope: "part" | "group", baseName: string, fmt: Fmt) {
    setBusy(`activity-${scope}-${sessionId}-${fmt}`);
    try {
      const data: ScanActivity = await (await apiRequest("GET", `/api/order-import/sessions/${sessionId}/scan-activity?scope=${scope}`)).json();
      const groupCols = scope === "group";
      const header: Row = [
        "#", ...(groupCols ? ["Part", "File"] : []),
        "Scanned By", "User Code", "Barcode", "Item Name", "Pallets", "Loose", "Total Qty", "Type", "STV", "Time",
      ];
      const rows: Row[] = [header];
      data.events.forEach((e, idx) => rows.push([
        idx + 1, ...(groupCols ? [e.partIndex ?? "", e.csvFileName ?? ""] : []),
        e.scannedByName ?? "", e.scannedByCode ?? "", e.barcode ?? "", e.itemName ?? "",
        e.pallets ?? 0, e.looseQty ?? 0, e.totalQty ?? 0, e.isExtra ? "Extra" : "Regular",
        e.stv ?? "", fmtIST(e.scannedAt),
      ]));
      if (data.events.length === 0) rows.push(["No scans recorded"]);
      exportRows(fmt, `scan-activity-${baseName}`, `Scan Activity — ${baseName}`, rows);
    } catch {
      toast({ title: "Failed to download activity", variant: "destructive" });
    } finally { setBusy(null); }
  }

  const statusPill = (status: string | null) => {
    const map: Record<string, string> = {
      completed: "bg-green-100 text-green-700",
      active: "bg-amber-100 text-amber-700",
      available: "bg-gray-100 text-gray-500",
    };
    return <span className={`rounded-full px-2 py-0.5 text-[10px] font-semibold capitalize ${map[status ?? "available"] ?? "bg-gray-100 text-gray-500"}`}>{status ?? "available"}</span>;
  };

  // One button → dropdown to pick CSV / Excel / PDF.
  const DownloadMenu = ({ label, icon, onPick, busyKey, variant = "outline" }: {
    label: string; icon?: React.ReactNode; onPick: (f: Fmt) => void; busyKey: string;
    variant?: "outline" | "default";
  }) => {
    const isBusy = busy?.startsWith(busyKey) ?? false;
    return (
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <Button size="sm" variant={variant}
            className={`h-7 gap-1 px-2.5 text-[11px] ${variant === "default" ? "bg-[#001d6e] hover:bg-[#00154b] text-white" : ""}`}
            disabled={isBusy}>
            {isBusy ? <Loader2 className="h-3 w-3 animate-spin" /> : (icon ?? <Download className="h-3 w-3" />)}
            {label}
            <ChevronDown className="h-3 w-3 opacity-60" />
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end" className="min-w-[8rem]">
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
    <div className="flex-1 overflow-y-auto bg-gray-50 p-3 sm:p-4 lg:p-6">
      <div className="mx-auto max-w-5xl space-y-5">

        {/* Header */}
        <div className="flex flex-wrap items-center gap-2">
          <Link href="/">
            <Button variant="outline" size="sm" className="h-8 px-2.5 text-xs gap-1.5 border-gray-200 bg-white hover:bg-gray-50">
              <ArrowLeft className="h-3.5 w-3.5" /> Back
            </Button>
          </Link>
          <div className="flex items-center gap-2">
            <div className="flex h-9 w-9 items-center justify-center rounded-lg bg-[#001d6e] text-white">
              <Layers className="h-5 w-5" />
            </div>
            <div>
              <h1 className="text-xl sm:text-2xl font-semibold text-gray-950">Order Reports</h1>
              <p className="text-xs text-gray-500">Download per-CSV and FIFO batch reports (expected vs received vs extra, with cross-part adjustments).</p>
            </div>
          </div>
        </div>

        {/* Filters */}
        <div className="flex flex-wrap items-center gap-2">
          <div className="relative">
            <CalendarDays className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-gray-400 pointer-events-none" />
            <Input type="date" className="pl-9 w-[165px] text-sm" value={date} onChange={(e) => setDate(e.target.value)} />
          </div>
          {date && (
            <Button variant="ghost" size="sm" className="h-9 px-2 text-gray-400 hover:text-gray-700" onClick={() => setDate("")}>
              <X className="h-4 w-4" />
            </Button>
          )}
          {plantOptions.length > 0 ? (
            <Select value={plant || "_all_"} onValueChange={(v) => setPlant(v === "_all_" ? "" : v)}>
              <SelectTrigger className="h-9 w-[150px] text-sm"><SelectValue placeholder="All plants" /></SelectTrigger>
              <SelectContent>
                <SelectItem value="_all_">All plants</SelectItem>
                {plantOptions.map((p) => <SelectItem key={p.name} value={p.name}>{p.name}</SelectItem>)}
              </SelectContent>
            </Select>
          ) : (
            <Input className="h-9 w-[130px] text-sm" value={plant} onChange={(e) => setPlant(e.target.value)} placeholder="Plant…" />
          )}
          <div className="relative flex-1 min-w-[160px] max-w-xs">
            <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-gray-400" />
            <Input className="pl-9 text-sm" placeholder="Search file / plant / user…" value={search} onChange={(e) => setSearch(e.target.value)} />
          </div>
          <Button variant="outline" size="sm" className="h-9 w-9 p-0 ml-auto"
            onClick={() => sessionsQuery.refetch()} disabled={sessionsQuery.isFetching}>
            <RefreshCw className={`h-4 w-4 ${sessionsQuery.isFetching ? "animate-spin" : ""}`} />
          </Button>
        </div>

        {sessionsQuery.isLoading ? (
          <div className="flex justify-center py-16"><Loader2 className="h-6 w-6 animate-spin text-[#001d6e]" /></div>
        ) : sessions.length === 0 ? (
          <div className="rounded-xl border bg-white py-16 text-center text-sm text-gray-400">
            No imports found{date ? ` for ${date}` : ""}.
          </div>
        ) : (
          <div className="space-y-5">

            {/* FIFO groups */}
            {groups.size > 0 && (
              <div className="space-y-3">
                <h2 className="text-sm font-semibold text-purple-900 flex items-center gap-1.5">
                  <Layers className="h-4 w-4" /> FIFO Sessions
                </h2>
                {Array.from(groups.entries()).map(([groupId, parts]) => (
                  <div key={groupId} className="rounded-xl border border-purple-200 bg-white shadow-sm overflow-hidden">
                    <div className="flex flex-wrap items-center justify-between gap-2 border-b bg-purple-50/50 px-4 py-3">
                      <div className="text-sm font-medium text-purple-900">
                        Group #{groupId} <span className="text-xs font-normal text-gray-500">· {parts[0]?.plant} · {parts.length} part{parts.length === 1 ? "" : "s"}</span>
                      </div>
                      <div className="flex flex-wrap items-center gap-2">
                        <span className="text-[11px] font-medium text-gray-500">Final:</span>
                        <DownloadMenu label="Summary" variant="default" busyKey={`group-${groupId}-final`}
                          onPick={(f) => downloadGroup(groupId, "final", f)} />
                        <DownloadMenu label="Activity" icon={<ListChecks className="h-3 w-3" />} busyKey={`activity-group-${groupId}`}
                          onPick={(f) => downloadActivity(groupId, "group", `group${groupId}-all`, f)} />
                        <DownloadMenu label="CSV-wise" busyKey={`group-${groupId}-partwise`}
                          onPick={(f) => downloadGroup(groupId, "partwise", f)} />
                      </div>
                    </div>
                    <div className="divide-y">
                      {parts.map((p) => (
                        <div key={p.id} className="flex flex-wrap items-center gap-2 px-4 py-2.5">
                          <span className="inline-flex h-6 min-w-[24px] items-center justify-center rounded-full bg-purple-100 px-1.5 text-[11px] font-semibold text-purple-700">{p.partIndex ?? "?"}</span>
                          <div className="flex-1 min-w-0">
                            <p className="truncate text-sm font-medium text-gray-900">{p.csvFileName}</p>
                            <p className="text-xs text-gray-400">{p.rowCount ?? 0} rows · {fmtIST(p.createdAt)}</p>
                          </div>
                          {statusPill(p.scanStatus)}
                          <DownloadMenu label="Summary" busyKey={`part-${p.id}`} onPick={(f) => downloadPart(p, f)} />
                          <DownloadMenu label="Activity" icon={<ListChecks className="h-3 w-3" />} busyKey={`activity-part-${p.id}`}
                            onPick={(f) => downloadActivity(p.id, "part", safe(p.csvFileName), f)} />
                        </div>
                      ))}
                    </div>
                  </div>
                ))}
              </div>
            )}

            {/* Standalone single imports */}
            {standalone.length > 0 && (
              <div className="space-y-2">
                <h2 className="text-sm font-semibold text-gray-800">Single CSV Imports</h2>
                <div className="rounded-xl border bg-white shadow-sm divide-y overflow-hidden">
                  {standalone.map((s) => (
                    <div key={s.id} className="flex flex-wrap items-center gap-2 px-4 py-3">
                      <div className="flex-1 min-w-0">
                        <p className="truncate text-sm font-medium text-gray-900">{s.csvFileName}</p>
                        <p className="text-xs text-gray-400">
                          <span className="rounded bg-[#001d6e]/10 px-1.5 py-0.5 text-[10px] font-semibold text-[#001d6e] uppercase mr-1.5">{s.plant}</span>
                          {s.rowCount ?? 0} rows · {fmtIST(s.createdAt)}{s.importedByName ? ` · ${s.importedByName}` : ""}
                        </p>
                      </div>
                      {statusPill(s.scanStatus)}
                      <DownloadMenu label="Summary" busyKey={`part-${s.id}`} onPick={(f) => downloadPart(s, f)} />
                      <DownloadMenu label="Activity" icon={<ListChecks className="h-3 w-3" />} busyKey={`activity-part-${s.id}`}
                        onPick={(f) => downloadActivity(s.id, "part", safe(s.csvFileName), f)} />
                    </div>
                  ))}
                </div>
              </div>
            )}
          </div>
        )}
      </div>
    </div>
  );
}
