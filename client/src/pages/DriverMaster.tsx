import { useMemo } from "react";
import { useMutation, useQuery } from "@tanstack/react-query";
import { Loader2, RefreshCw, UserRound } from "lucide-react";
import PageHeader from "@/components/PageHeader";
import { Button } from "@/components/ui/button";
import { DataTable, type DataTableColumn } from "@/components/ui/data-table";
import { SyncProgressDialog } from "@/components/SyncProgressDialog";
import { useToast } from "@/hooks/use-toast";
import { usePersistentFilter } from "@/hooks/usePersistentFilter";
import { apiRequest, queryClient } from "@/lib/queryClient";
import { parseApiErrorMessage } from "@/lib/apiError";
import { hasPageWriteAccess } from "@/lib/permissions";

// Driver Master: every driver of the Notion driver database, kept in our own table so a driver can be assigned (Vehicle Planning, Vehicle Master) without reading Notion each
// time. "Sync from Notion" is the only thing that reads Notion. The table's columns can be resized by dragging the heading edges, like the other pages.

type DriverRow = {
  id: number; notionPageId: string; name: string; company: string | null; phone: string | null; phone2: string | null;
  licenceType: string | null; licenceExp: string | null; driverNo: string | null; inNotion: boolean; syncedAt: string | null;
};
type DriversResponse = { drivers: DriverRow[]; lastSyncedAt: string | null; syncing: boolean };

const TABLE_HEADER_CLASS = "bg-[#001d6e] text-white border-[#1a3a9c] hover:bg-[#0a2b7e] hover:text-white";
const driversKey = ["/api/driver-master"];

// The licence date is typed into Notion as text ("2027-01-06 @NIKUNJ PATEL"): the leading date is read out for the red / amber warning, the rest is shown as written.
function licenceInfo(raw: string | null): { date: string | null; label: string; tone: "ok" | "soon" | "expired" | "none"; rest: string } {
  if (!raw) return { date: null, label: "—", tone: "none", rest: "" };
  const m = raw.match(/^(\d{4})-(\d{2})-(\d{2})/);
  if (!m) return { date: null, label: raw, tone: "none", rest: "" };
  const date = `${m[1]}-${m[2]}-${m[3]}`;
  const days = Math.round((Date.parse(`${date}T00:00:00Z`) - Date.parse(`${new Date(Date.now() + 330 * 60000).toISOString().slice(0, 10)}T00:00:00Z`)) / 86400000);
  return { date, label: `${m[3]}-${m[2]}-${m[1]}`, tone: days < 0 ? "expired" : days <= 30 ? "soon" : "ok", rest: raw.slice(m[0].length).trim() };
}

export default function DriverMaster() {
  const { toast } = useToast();
  const canWrite = hasPageWriteAccess("driver-master");
  const [company, setCompany] = usePersistentFilter<string>("driverMaster:company", "");
  const [search, setSearch] = usePersistentFilter<string>("driverMaster:search", "");

  const query = useQuery<DriversResponse>({
    queryKey: driversKey,
    queryFn: async () => (await apiRequest("GET", "/api/driver-master")).json(),
  });
  const all = (query.data?.drivers ?? []).filter((d) => d.inNotion);
  const companies = useMemo(() => {
    const counts = new Map<string, number>();
    for (const d of all) counts.set(d.company ?? "—", (counts.get(d.company ?? "—") ?? 0) + 1);
    return Array.from(counts.entries()).sort((a, b) => b[1] - a[1]);
  }, [all.length, query.data]);
  const rows = all.filter((d) => !company || (d.company ?? "—") === company);

  const syncMutation = useMutation({
    mutationFn: async () => {
      const res = await apiRequest("POST", "/api/driver-master/sync");
      if (!res.ok) throw new Error((await res.json().catch(() => ({})))?.message || "Failed to sync the drivers from Notion");
      return res.json() as Promise<{ total: number; created: number; changed: number; unchanged: number; removed: number }>;
    },
    onSuccess: (r) => {
      toast({ title: "Drivers synced from Notion", description: `${r.total} drivers read · ${r.created} new · ${r.changed} changed${r.removed ? ` · ${r.removed} no longer in Notion` : ""}` });
      queryClient.invalidateQueries({ queryKey: driversKey });
      queryClient.invalidateQueries({ queryKey: ["/api/driver-master/options"] });
      queryClient.invalidateQueries({ queryKey: ["/api/vehicle-planning/drivers"] });
    },
    onError: (err: any) => toast({ title: "Could not sync the drivers", description: parseApiErrorMessage(err), variant: "destructive" }),
  });

  const columns: DataTableColumn<DriverRow>[] = [
    { id: "name", header: "Driver", width: 240, sortable: true, accessor: (r) => r.name, cellClassName: "font-medium text-[#001d6e]", render: (r) => r.name },
    { id: "company", header: "Company", width: 170, sortable: true, accessor: (r) => r.company ?? "", render: (r) => r.company ?? "—" },
    { id: "phone", header: "Phone", width: 140, sortable: true, accessor: (r) => r.phone ?? "", cellClassName: "tabular-nums", render: (r) => r.phone ?? "—" },
    { id: "phone2", header: "Phone 2", width: 140, sortable: true, accessor: (r) => r.phone2 ?? "", cellClassName: "tabular-nums", render: (r) => r.phone2 ?? "—" },
    { id: "licenceType", header: "Licence", width: 120, sortable: true, accessor: (r) => r.licenceType ?? "", render: (r) => r.licenceType ?? "—" },
    {
      id: "licenceExp", header: "Licence expires", width: 230, sortable: true, accessor: (r) => licenceInfo(r.licenceExp).date ?? "",
      render: (r) => {
        const l = licenceInfo(r.licenceExp);
        const tone = l.tone === "expired" ? "bg-red-100 text-red-700" : l.tone === "soon" ? "bg-amber-100 text-amber-800" : l.tone === "ok" ? "bg-emerald-50 text-emerald-700" : "text-gray-500";
        return (
          <span className="flex flex-wrap items-center gap-1.5">
            <span className={`rounded-full px-2 py-0.5 text-xs font-medium tabular-nums ${tone}`}>{l.label}</span>
            {l.tone === "expired" && <span className="text-[11px] font-semibold text-red-600">Expired</span>}
            {l.tone === "soon" && <span className="text-[11px] font-semibold text-amber-700">Expires soon</span>}
            {l.rest && <span className="max-w-[10rem] truncate text-[11px] text-gray-500" title={l.rest}>{l.rest}</span>}
          </span>
        );
      },
    },
    { id: "driverNo", header: "Notion ID", width: 110, sortable: true, accessor: (r) => r.driverNo ?? "", cellClassName: "text-gray-500", render: (r) => r.driverNo ?? "—" },
  ];

  const lastSynced = query.data?.lastSyncedAt
    ? new Date(query.data.lastSyncedAt).toLocaleString("en-IN", { timeZone: "Asia/Kolkata", day: "2-digit", month: "short", hour: "numeric", minute: "2-digit", hour12: true })
    : null;

  return (
    <div className="container mx-auto px-3 sm:px-4 py-4 sm:py-6 pb-24">
      <PageHeader
        icon={UserRound}
        title="Driver Master"
        description="Every driver from Notion, kept here so a driver can be assigned (Vehicle Planning, Vehicle Master) without reading Notion each time. Press Sync from Notion to refresh the list."
        actions={(
          <>
            <span className="text-xs text-gray-500">{lastSynced ? `Last synced: ${lastSynced}` : "Never synced"}</span>
            {canWrite && (
              <Button size="sm" className="h-8 rounded-full bg-[#001d6e] px-3 text-xs hover:bg-[#0a2b7e]" disabled={syncMutation.isPending} onClick={() => syncMutation.mutate()}>
                {syncMutation.isPending ? <Loader2 className="mr-1.5 h-3.5 w-3.5 animate-spin" /> : <RefreshCw className="mr-1.5 h-3.5 w-3.5" />}
                Sync from Notion
              </Button>
            )}
          </>
        )}
      />

      <SyncProgressDialog open={syncMutation.isPending} title="Reading the drivers from Notion…" note="This takes a few seconds." />

      <div className="mb-3 flex flex-wrap items-center gap-1.5">
        <button type="button" onClick={() => setCompany("")}
          className={`rounded-full border px-3 py-1 text-xs font-medium ${company === "" ? "border-[#001d6e] bg-[#001d6e] text-white" : "border-gray-200 bg-white text-gray-600 hover:bg-gray-50"}`}>
          All ({all.length})
        </button>
        {companies.map(([name, n]) => (
          <button key={name} type="button" onClick={() => setCompany(company === name ? "" : name)}
            className={`rounded-full border px-3 py-1 text-xs font-medium ${company === name ? "border-[#001d6e] bg-[#001d6e] text-white" : "border-gray-200 bg-white text-gray-600 hover:bg-gray-50"}`}>
            {name} ({n})
          </button>
        ))}
      </div>

      <DataTable<DriverRow>
        columns={columns}
        data={rows}
        getRowId={(r) => String(r.id)}
        isLoading={query.isLoading}
        loadingLabel="Loading the drivers…"
        emptyState={query.isError ? (query.error as Error).message : (query.data?.drivers.length ?? 0) === 0 ? "No drivers yet. Press Sync from Notion to bring them in." : "No drivers match."}
        enableSearch
        searchPlaceholder="Search driver, company, phone…"
        searchValue={search}
        onSearchChange={setSearch}
        sortMode="client"
        defaultSort={{ columnId: "name", direction: "asc" }}
        paginationMode="client"
        defaultPageSize={50}
        pageSizeOptions={[25, 50, 100, 200]}
        enableZebraStripes
        enableColumnResizing
        showMobileSwipeHint
        isStickyHeader
        maxHeight="calc(100vh - 300px)"
        headerClassName={TABLE_HEADER_CLASS}
      />
    </div>
  );
}
