import { useEffect, useMemo, useState } from "react";
import { useLocation, useSearch } from "wouter";
import { useQuery } from "@tanstack/react-query";
import { format } from "date-fns";
import { FileBarChart, PieChart, X } from "lucide-react";
import PageHeader from "@/components/PageHeader";
import { PlantBadge } from "@/components/PlantBadge";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { DataTable, type DataTableColumn } from "@/components/ui/data-table";
import { TableCard } from "@/components/ui/table-card";
import { CollapsibleSearch } from "@/components/ui/collapsible-search";
import { apiRequest } from "@/lib/queryClient";
import ReportsDialog, { type ReportsDialogSession } from "@/components/modals/ReportsDialog";
import type { OrderImportSession } from "@shared/schema";

// Own page for Order Import's per-CSV/FIFO-group reports — previously only reachable as a
// dialog opened from a row inside Order Import; separated out so it has its own table (same
// DataTable/TableCard structure as Overall Stock/Scan History) instead of a hand-rolled list.
// The actual report content (Summary/Activity, View/Download) is unchanged — still ReportsDialog.

type SessionRow = OrderImportSession & {
  importedByName: string | null;
  scanStatus: string;
  orderDate: string | null;
};

type SessionsResponse = {
  sessions: SessionRow[];
  total: number;
  page: number;
  pageSize: number;
  totalPages: number;
};

const PAGE_SIZE_OPTIONS = [10, 25, 50];

// scanStatus only ever takes one of these three values (see shared/schema.ts) — labels here
// match the badges rendered in the Status column below (Ready/Loaded/Done).
const STATUS_OPTIONS = [
  { value: "available", label: "Ready" },
  { value: "active", label: "Loaded" },
  { value: "completed", label: "Done" },
];

export default function OrderReports() {
  const search = useSearch();
  const [, navigate] = useLocation();

  const [pageSize, setPageSize] = useState(10);
  const [currentPage, setCurrentPage] = useState(1);
  const [filterDate, setFilterDate] = useState("");
  const [filterPlant, setFilterPlant] = useState("");
  const [filterStatus, setFilterStatus] = useState("");
  const [searchText, setSearchText] = useState("");
  const [reportsSession, setReportsSession] = useState<ReportsDialogSession | null>(null);

  // Arriving from Order Import's "Reports" button — it passes every field this dialog needs
  // straight in the URL, so this opens directly without a second fetch. The query string is
  // cleared right after so a page refresh doesn't reopen it.
  useEffect(() => {
    const params = new URLSearchParams(search);
    const id = params.get("sessionId");
    if (!id) return;
    setReportsSession({
      id: Number(id),
      csvFileName: params.get("csvFileName") ?? "",
      plant: params.get("plant") ?? "",
      receivingSessionId: params.get("groupId") ? Number(params.get("groupId")) : null,
      partIndex: params.get("partIndex") ? Number(params.get("partIndex")) : null,
    });
    navigate("/order-reports", { replace: true });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [search]);

  const { data: plants = [] } = useQuery<{ id: number; name: string }[]>({
    queryKey: ["/api/plants"],
    queryFn: () => apiRequest("GET", "/api/plants", undefined, false, true),
  });

  const sessionsQuery = useQuery<SessionsResponse>({
    queryKey: ["/api/order-import/sessions", currentPage, pageSize, filterDate, filterPlant, filterStatus],
    queryFn: async () => {
      const params = new URLSearchParams({ page: String(currentPage), pageSize: String(pageSize) });
      if (filterDate) params.set("date", filterDate);
      if (filterPlant) params.set("plant", filterPlant);
      if (filterStatus) params.set("status", filterStatus);
      return apiRequest("GET", `/api/order-import/sessions?${params}`, undefined, false, true);
    },
    placeholderData: (previous) => previous,
  });

  const sessions = sessionsQuery.data?.sessions ?? [];
  const total = sessionsQuery.data?.total ?? 0;
  const totalPages = sessionsQuery.data?.totalPages ?? 1;

  // Search is client-side, over just the current page — same limitation Scan History's search
  // would have had if it weren't sent to the server; the session list here is small/paginated
  // enough (10–50 rows) that this is a non-issue in practice.
  const filtered = useMemo(() => {
    if (!searchText) return sessions;
    const q = searchText.toLowerCase();
    return sessions.filter((s) =>
      s.csvFileName.toLowerCase().includes(q) ||
      s.plant.toLowerCase().includes(q) ||
      (s.importedByName ?? "").toLowerCase().includes(q),
    );
  }, [sessions, searchText]);

  const dash = <span className="text-gray-300">—</span>;

  const columns: DataTableColumn<SessionRow>[] = [
    {
      id: "srNo", header: "#", hideable: false, width: 44,
      cellClassName: "text-gray-400 tabular-nums",
      render: (_row, rowIndex) => (currentPage - 1) * pageSize + rowIndex + 1,
    },
    {
      id: "csvFileName", header: "CSV File", hideable: false, width: 240,
      accessor: (r) => r.csvFileName,
      cellClassName: "font-medium text-gray-900 whitespace-normal break-words",
    },
    {
      id: "plant", header: "Plant", width: 90,
      accessor: (r) => r.plant,
      render: (r) => <PlantBadge plant={r.plant} />,
    },
    {
      id: "orderDate", header: "Order Date", width: 110,
      accessor: (r) => r.orderDate,
      render: (r) => r.orderDate ?? dash,
    },
    {
      id: "uploadedAt", header: "Uploaded At", width: 160,
      accessor: (r) => r.createdAt,
      cellClassName: "whitespace-nowrap text-gray-500",
      render: (r) => (r.createdAt ? format(new Date(r.createdAt), "MMM d, yyyy h:mm a") : dash),
    },
    {
      id: "importedBy", header: "Imported By", width: 130,
      accessor: (r) => r.importedByName,
      render: (r) => r.importedByName ?? "Unknown",
    },
    {
      id: "part", header: "Part", width: 90,
      render: (r) =>
        r.receivingSessionId ? (
          <Badge className="border-0 bg-purple-50 text-[11px] text-purple-700 hover:bg-purple-50">Part {r.partIndex ?? "?"}</Badge>
        ) : dash,
    },
    {
      id: "rows", header: "Rows", width: 70, align: "right",
      accessor: (r) => r.rowCount ?? 0,
    },
    {
      id: "status", header: "Status", width: 100,
      render: (r) =>
        r.scanStatus === "active" ? (
          <Badge className="border-0 bg-amber-100 text-[11px] text-amber-700 hover:bg-amber-100">Loaded</Badge>
        ) : r.scanStatus === "completed" ? (
          <Badge className="border-0 bg-green-100 text-[11px] text-green-700 hover:bg-green-100">Done</Badge>
        ) : (
          <Badge className="border-0 bg-gray-100 text-[11px] text-gray-500 hover:bg-gray-100">Ready</Badge>
        ),
    },
    {
      id: "actions", header: "", hideable: false, width: 100, align: "center",
      render: (r) =>
        (r.scanStatus === "completed" || r.scanStatus === "active") ? (
          <Button
            size="sm" variant="outline" className="h-7 px-2 text-xs"
            onClick={() =>
              setReportsSession({
                id: r.id, csvFileName: r.csvFileName, plant: r.plant,
                receivingSessionId: r.receivingSessionId, partIndex: r.partIndex,
              })
            }
          >
            <FileBarChart className="h-3.5 w-3.5 mr-1" /> Reports
          </Button>
        ) : null,
    },
  ];

  return (
    <div className="flex-1 overflow-y-auto p-4 lg:p-6">
      <div className="max-w-7xl mx-auto space-y-4">
        <PageHeader
          icon={PieChart}
          title="Order Reports"
          description="Per-CSV and FIFO-group summary/activity reports — view in-browser or download CSV/Excel/PDF."
        />

        <TableCard
          icon={PieChart}
          title="Order Import Sessions"
          subtitle={`${filtered.length} of ${total} sessions`}
          className="rounded-xl shadow-none border-gray-300"
          headerActions={
            <>
              <CollapsibleSearch value={searchText} onChange={setSearchText} placeholder="File, plant, importer…" />

              <Input
                type="date"
                value={filterDate}
                onChange={(e) => { setFilterDate(e.target.value); setCurrentPage(1); }}
                className="h-8 w-[140px] text-xs"
              />
              {filterDate && (
                <Button size="sm" variant="ghost" className="h-8 w-8 p-0" onClick={() => { setFilterDate(""); setCurrentPage(1); }}>
                  <X className="h-3.5 w-3.5" />
                </Button>
              )}

              <Select value={filterPlant || "_all_"} onValueChange={(v) => { setFilterPlant(v === "_all_" ? "" : v); setCurrentPage(1); }}>
                <SelectTrigger className="h-8 w-[130px] text-xs"><SelectValue placeholder="All plants" /></SelectTrigger>
                <SelectContent>
                  <SelectItem value="_all_">All plants</SelectItem>
                  {plants.map((p) => <SelectItem key={p.id} value={p.name}>{p.name}</SelectItem>)}
                </SelectContent>
              </Select>

              {/* Status only ever takes one of 3 fixed values (see shared/schema.ts) — a plain
                  dropdown, same as Plant, rather than the Excel-style column-filter engine. */}
              <Select value={filterStatus || "_all_"} onValueChange={(v) => { setFilterStatus(v === "_all_" ? "" : v); setCurrentPage(1); }}>
                <SelectTrigger className="h-8 w-[120px] text-xs"><SelectValue placeholder="All statuses" /></SelectTrigger>
                <SelectContent>
                  <SelectItem value="_all_">All statuses</SelectItem>
                  {STATUS_OPTIONS.map((o) => <SelectItem key={o.value} value={o.value}>{o.label}</SelectItem>)}
                </SelectContent>
              </Select>

              <Select value={String(pageSize)} onValueChange={(v) => { setPageSize(Number(v)); setCurrentPage(1); }}>
                <SelectTrigger className="h-8 w-[70px] text-xs"><SelectValue /></SelectTrigger>
                <SelectContent>
                  {PAGE_SIZE_OPTIONS.map((n) => <SelectItem key={n} value={String(n)}>{n}</SelectItem>)}
                </SelectContent>
              </Select>
            </>
          }
        >
          <DataTable<SessionRow>
            className="space-y-0"
            containerClassName="rounded-none border-0"
            columns={columns}
            data={filtered}
            getRowId={(r) => String(r.id)}
            isLoading={sessionsQuery.isLoading}
            loadingLabel="Loading sessions…"
            emptyState={filterDate ? `No imports found for ${filterDate}.` : "No imports yet."}
            noResultsState="No sessions match your search."
            hasActiveFilters={!!searchText}
            enableZebraStripes
            enableColumnResizing
            paginationMode="none"
            headerClassName="bg-[#001d6e] text-white border-[#1a3a9c] hover:bg-[#0a2b7e] hover:text-white"
            renderFooter={(ctx) => (
              <tfoot>
                <tr>
                  <td colSpan={ctx.columnCount} className="border-t border-gray-300 bg-white px-4 py-2.5">
                    <div className="flex items-center justify-between text-xs text-gray-500">
                      <span>Page {currentPage} of {totalPages} · {total} sessions</span>
                      <div className="flex gap-2">
                        <Button variant="outline" size="sm" className="rounded-xl" disabled={currentPage <= 1}
                          onClick={() => setCurrentPage((p) => Math.max(1, p - 1))}>Prev</Button>
                        <Button variant="outline" size="sm" className="rounded-xl" disabled={currentPage >= totalPages}
                          onClick={() => setCurrentPage((p) => p + 1)}>Next</Button>
                      </div>
                    </div>
                  </td>
                </tr>
              </tfoot>
            )}
          />
        </TableCard>
      </div>

      <ReportsDialog session={reportsSession} onClose={() => setReportsSession(null)} />
    </div>
  );
}
