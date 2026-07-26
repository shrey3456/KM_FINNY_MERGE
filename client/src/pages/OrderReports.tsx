import { useEffect, useMemo, useState } from "react";
import { useLocation, useSearch } from "wouter";
import { useQuery } from "@tanstack/react-query";
import { format } from "date-fns";
import { ChevronDown, FileBarChart, Layers, PieChart, X } from "lucide-react";
import PageHeader from "@/components/PageHeader";
import { PlantBadge } from "@/components/PlantBadge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { TableCard } from "@/components/ui/table-card";
import { CollapsibleSearch } from "@/components/ui/collapsible-search";
import { cn } from "@/lib/utils";
import { apiRequest } from "@/lib/queryClient";
import ReportsDialog, { type ReportsDialogSession } from "@/components/modals/ReportsDialog";
import type { OrderImportSession } from "@shared/schema";

// Own page for Order Import's per-CSV/FIFO-group reports — previously only reachable as a
// dialog opened from a row inside Order Import; separated out so it has its own table (same
// DataTable/TableCard structure as Overall Stock/Scan History) instead of a hand-rolled list.
// Rows are now grouped one-per-ORDER instead of one-per-CSV: every part-CSV sharing the same
// receivingSessionId (same plant + Order Date — the same FIFO grouping Scan Order and Master
// View already use) collapses into a single row that expands to reveal all of its parts,
// rather than each part showing up as its own unrelated top-level row. The actual report
// content (Summary/Activity, View/Download) is unchanged — still ReportsDialog, opened
// per-part from inside the expanded order.

type SessionRow = OrderImportSession & {
  importedByName: string | null;
  scanStatus: string;
  orderDate: string | null;
};

type GroupRow = {
  groupId: number;
  plant: string;
  orderDate: string | null;
  totalParts: number;
  latestUploadedAt: string;
  importedByName: string | null;
  groupStatus: "available" | "active" | "completed";
  // Order-level, not per-part — when the first item was scanned across ANY of this order's
  // CSVs, and when the LAST of its parts was marked complete (i.e. the whole order is done).
  // Null until scanning has actually started / until every part has finished, respectively.
  scanStartedAt: string | null;
  scanCompletedAt: string | null;
  parts: SessionRow[];
};

type GroupedResponse = {
  groups: GroupRow[];
  total: number;
  page: number;
  pageSize: number;
  totalPages: number;
};

const PAGE_SIZE_OPTIONS = [10, 25, 50];

// scanStatus only ever takes one of these three values (see shared/schema.ts) — labels here
// match the badges rendered below (Ready/Loaded/Done), now rolled up to describe a whole
// order (Loaded the moment any part is being scanned, Done only once every part is).
const STATUS_OPTIONS = [
  { value: "available", label: "Ready" },
  { value: "active", label: "Loaded" },
  { value: "completed", label: "Done" },
];

// Squared, thin-bordered, uppercase-tracked tags rather than shadcn's default rounded-full
// pill — reads as a status column in a formal report/statement instead of an app chip, and
// matches the uppercase-tracked-label treatment already used on the tiles above each row.
function StatusBadge({ status }: { status: string }) {
  if (status === "active")
    return (
      <span className="inline-flex items-center rounded-sm border border-amber-300 bg-amber-50 px-2 py-0.5 text-[11px] font-semibold uppercase tracking-wide text-amber-700">
        Loaded
      </span>
    );
  if (status === "completed")
    return (
      <span className="inline-flex items-center rounded-sm border border-emerald-300 bg-emerald-50 px-2 py-0.5 text-[11px] font-semibold uppercase tracking-wide text-emerald-700">
        Done
      </span>
    );
  return (
    <span className="inline-flex items-center rounded-sm border border-gray-300 bg-gray-50 px-2 py-0.5 text-[11px] font-semibold uppercase tracking-wide text-gray-500">
      Ready
    </span>
  );
}

const dash = <span className="text-gray-300">—</span>;

// One part-CSV inside an expanded order — a compact record row (label-over-value, same
// language as the order tiles above it) instead of squeezing it into a data-grid row. A dense
// multi-column table read poorly at this width; this reads more like a receipt line item.
function PartRow({ part, onOpenReports }: { part: SessionRow; onOpenReports: () => void }) {
  const canOpenReports = part.scanStatus === "completed" || part.scanStatus === "active";
  return (
    <div className="flex flex-col gap-3 py-3 pl-8 pr-4 sm:flex-row sm:items-center sm:gap-4 sm:pl-14 sm:pr-5">
      <div className="flex min-w-0 flex-1 flex-wrap items-center gap-x-6 gap-y-2">
        <div className="min-w-0">
          <p className="text-[10px] font-semibold uppercase tracking-wide text-gray-400">
            {part.partIndex ? `Part ${part.partIndex}` : "File"}
          </p>
          <p className="max-w-[260px] truncate text-sm font-semibold text-gray-900" title={part.csvFileName}>
            {part.csvFileName}
          </p>
        </div>
        <div className="min-w-0">
          <p className="text-[10px] font-semibold uppercase tracking-wide text-gray-400">Uploaded</p>
          <p className="whitespace-nowrap text-xs tabular-nums text-gray-600">
            {part.createdAt ? format(new Date(part.createdAt), "MMM d, yyyy h:mm a") : dash}
          </p>
        </div>
        <div className="min-w-0">
          <p className="text-[10px] font-semibold uppercase tracking-wide text-gray-400">Imported By</p>
          <p className="whitespace-nowrap text-xs text-gray-600">{part.importedByName ?? "Unknown"}</p>
        </div>
        <div className="min-w-0">
          <p className="text-[10px] font-semibold uppercase tracking-wide text-gray-400">Status</p>
          <StatusBadge status={part.scanStatus} />
        </div>
      </div>
      {canOpenReports && (
        <Button size="sm" variant="outline" className="h-7 shrink-0 self-start rounded-none px-2 text-xs sm:self-center" onClick={onOpenReports}>
          <FileBarChart className="mr-1 h-3.5 w-3.5" /> Reports
        </Button>
      )}
    </div>
  );
}

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
  const [expandedGroupId, setExpandedGroupId] = useState<number | null>(null);

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

  const groupsQuery = useQuery<GroupedResponse>({
    queryKey: ["/api/order-import/sessions/grouped", currentPage, pageSize, filterDate, filterPlant, filterStatus],
    queryFn: async () => {
      const params = new URLSearchParams({ page: String(currentPage), pageSize: String(pageSize) });
      if (filterDate) params.set("date", filterDate);
      if (filterPlant) params.set("plant", filterPlant);
      if (filterStatus) params.set("status", filterStatus);
      return apiRequest("GET", `/api/order-import/sessions/grouped?${params}`, undefined, false, true);
    },
    placeholderData: (previous) => previous,
  });

  const groups = groupsQuery.data?.groups ?? [];
  const total = groupsQuery.data?.total ?? 0;
  const totalPages = groupsQuery.data?.totalPages ?? 1;

  // Search is client-side, over just the current page of orders — same limitation Scan
  // History's search would have had if it weren't sent to the server; the order list here is
  // small/paginated enough (10–50 orders) that this is a non-issue in practice. Matches
  // against any part within the order, not just the order's own summary fields.
  const filtered = useMemo(() => {
    if (!searchText) return groups;
    const q = searchText.toLowerCase();
    return groups.filter(
      (g) =>
        g.plant.toLowerCase().includes(q) ||
        g.parts.some(
          (p) =>
            p.csvFileName.toLowerCase().includes(q) ||
            (p.importedByName ?? "").toLowerCase().includes(q),
        ),
    );
  }, [groups, searchText]);

  // Collapse whatever was open if it scrolled out of the current page/filter/search results.
  useEffect(() => {
    if (expandedGroupId != null && !filtered.some((g) => g.groupId === expandedGroupId)) {
      setExpandedGroupId(null);
    }
  }, [filtered, expandedGroupId]);

  return (
    <div className="flex-1 overflow-y-auto p-4 lg:p-6">
      <div className="max-w-7xl mx-auto space-y-4">
        <PageHeader
          icon={PieChart}
          title="Order Reports"
          description="Per-order summary/activity reports — every part-CSV in an order lives under one row. View in-browser or download CSV/Excel/PDF."
        />

        <TableCard
          icon={PieChart}
          title="Orders"
          subtitle={`${filtered.length} of ${total} orders`}
          className="rounded-none shadow-none border-gray-300"
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
                  dropdown, same as Plant, rather than the Excel-style column-filter engine.
                  Now describes the whole order's rolled-up status, not one CSV's. */}
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
          {/* Corporate/report treatment (same squared-border, uppercase-tracked-label,
              tabular-number style used on Stock Overview's summary tiles) applied to each
              order row. Clicking a row expands it to reveal every part-CSV nested inside —
              same accordion pattern as the Part Order tab in Scan Order. */}
          <div className="divide-y divide-gray-200 border-t border-gray-200">
            {groupsQuery.isLoading ? (
              <div className="py-16 text-center text-sm text-gray-400">Loading orders…</div>
            ) : filtered.length === 0 ? (
              <div className="py-16 text-center text-sm text-gray-400">
                {filterDate ? `No imports found for ${filterDate}.` : searchText ? "No orders match your search." : "No imports yet."}
              </div>
            ) : (
              filtered.map((g) => {
                const isOpen = expandedGroupId === g.groupId;
                return (
                  <div key={g.groupId} className="bg-white">
                    <button
                      onClick={() => setExpandedGroupId(isOpen ? null : g.groupId)}
                      className="flex w-full items-center gap-3 px-4 py-3 text-left transition-colors hover:bg-gray-50 sm:gap-4 sm:px-5"
                    >
                      <div className="flex h-9 w-9 shrink-0 items-center justify-center bg-[#001d6e]/5">
                        <Layers className="h-4 w-4 text-[#001d6e]" />
                      </div>
                      <div className="grid flex-1 grid-cols-2 items-center gap-x-3 gap-y-2 sm:grid-cols-6">
                        <div className="min-w-0">
                          <p className="text-[11px] font-semibold uppercase tracking-wide text-gray-400">Order Date</p>
                          <p className="text-sm font-semibold tabular-nums text-gray-900">{g.orderDate ?? dash}</p>
                        </div>
                        <div className="min-w-0">
                          <p className="text-[11px] font-semibold uppercase tracking-wide text-gray-400">Plant</p>
                          <PlantBadge plant={g.plant} />
                        </div>
                        <div className="min-w-0">
                          <p className="text-[11px] font-semibold uppercase tracking-wide text-gray-400">Parts</p>
                          <p className="text-sm font-semibold tabular-nums text-gray-900">{g.totalParts}</p>
                        </div>
                        {/* When the first item was scanned across ANY of this order's CSVs — not
                            when a part merely became eligible for scanning. */}
                        <div className="hidden min-w-0 sm:block">
                          <p className="text-[11px] font-semibold uppercase tracking-wide text-gray-400">Scan Start</p>
                          <p className="text-sm font-semibold tabular-nums text-gray-900">
                            {g.scanStartedAt ? format(new Date(g.scanStartedAt), "MMM d, h:mm a") : dash}
                          </p>
                        </div>
                        {/* Only set once every part is completed — the completion time of
                            whichever part finished last, i.e. when the whole order was done. */}
                        <div className="hidden min-w-0 sm:block">
                          <p className="text-[11px] font-semibold uppercase tracking-wide text-gray-400">Scan End</p>
                          <p className="text-sm font-semibold tabular-nums text-gray-900">
                            {g.scanCompletedAt ? format(new Date(g.scanCompletedAt), "MMM d, h:mm a") : dash}
                          </p>
                        </div>
                        <div className="min-w-0">
                          <p className="text-[11px] font-semibold uppercase tracking-wide text-gray-400">Status</p>
                          <StatusBadge status={g.groupStatus} />
                        </div>
                      </div>
                      <ChevronDown className={cn("h-4 w-4 shrink-0 text-gray-400 transition-transform", isOpen && "rotate-180")} />
                    </button>
                    {isOpen && (
                      // A list of compact record rows instead of a data-grid table — a dense
                      // multi-column table cramped into this width read poorly; this is the
                      // same label-over-value language as the order tiles above, just indented
                      // to show it's nested under this order.
                      <div className="border-t border-gray-200 bg-gray-50/50">
                        {g.parts.length === 0 ? (
                          <p className="py-6 text-center text-sm text-gray-400">No parts</p>
                        ) : (
                          <div className="divide-y divide-gray-200">
                            {g.parts.map((p) => (
                              <PartRow
                                key={p.id}
                                part={p}
                                onOpenReports={() =>
                                  setReportsSession({
                                    id: p.id, csvFileName: p.csvFileName, plant: p.plant,
                                    receivingSessionId: p.receivingSessionId, partIndex: p.partIndex,
                                  })
                                }
                              />
                            ))}
                          </div>
                        )}
                      </div>
                    )}
                  </div>
                );
              })
            )}
          </div>

          {!groupsQuery.isLoading && filtered.length > 0 && (
            <div className="flex items-center justify-between border-t border-gray-300 bg-white px-4 py-2.5 text-xs text-gray-500">
              <span>Page {currentPage} of {totalPages} · {total} orders</span>
              <div className="flex gap-2">
                <Button variant="outline" size="sm" className="rounded-none" disabled={currentPage <= 1}
                  onClick={() => setCurrentPage((p) => Math.max(1, p - 1))}>Prev</Button>
                <Button variant="outline" size="sm" className="rounded-none" disabled={currentPage >= totalPages}
                  onClick={() => setCurrentPage((p) => p + 1)}>Next</Button>
              </div>
            </div>
          )}
        </TableCard>
      </div>

      <ReportsDialog session={reportsSession} onClose={() => setReportsSession(null)} />
    </div>
  );
}
