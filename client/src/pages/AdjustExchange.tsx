import { useMemo, useState } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { apiRequest } from "@/lib/queryClient";
import { useAuth } from "@/hooks/use-auth";
import { useToast } from "@/hooks/use-toast";
import { hasPageWriteAccess } from "@/lib/permissions";
import { usePersistentFilter } from "@/hooks/usePersistentFilter";
import { usePageWidth } from "@/hooks/usePageWidth";
import PageHeader from "@/components/PageHeader";
import { PlantBadge } from "@/components/PlantBadge";
import { ProductPhoto } from "@/components/ProductPhoto";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { DateInput } from "@/components/ui/date-input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter } from "@/components/ui/dialog";
import { DataTable, type DataTableColumn } from "@/components/ui/data-table";
import { ArrowLeftRight, Loader2, Ban, Trash2, RotateCcw, ArrowRight, Repeat, Search, ChevronDown } from "lucide-react";

// Below this page width, the wide table (7 columns, 2 of them action buttons) gets cramped or
// forces a sideways scroll — a tablet in portrait (an iPad, a Realme Pad 2) reports a page width
// well under a laptop's despite a "big" screen. Cards replace the table there instead of trying
// to squeeze it. Higher than DailyReports' own 900px on purpose: this table's columns run wider.
const TABLE_MIN_PAGE_WIDTH = 1024;

const TABLE_HEADER_CLASS = "bg-[#001d6e] text-white border-[#1a3a9c] hover:bg-[#0a2b7e] hover:text-white";

// "Adjust Exchange Extra" — manually crediting an Extra scanned on one date toward a still-open
// shortfall on an EARLIER date, for the same plant and product. Distinct from Overall Scan Ops'
// own "Adjust Remaining" (which fabricates a fulfillment out of nothing, for an old CSV nobody
// will ever finish scanning) — this instead reassigns REAL, already-scanned stock (an Extra) to
// close out a real shortfall elsewhere, so nothing is fabricated and no stock figure moves twice.
// See server/routes/order-scan.ts's own "Adjust Exchange" section for the full mechanism (it
// reuses the existing is_credit/credited_qty columns the automatic FIFO-group credit already
// uses, generalized to any earlier session instead of just a later part of the same group).
//
// One list (the product/Extra items for the picked date+plant) with a side panel next to it
// (below it on narrow screens) — clicking Adjust on a row loads its matching earlier shortfalls
// into that panel, right there, instead of a separate tab or a modal dialog.

function todayIST(): string {
  return new Date().toLocaleDateString("en-CA", { timeZone: "Asia/Kolkata" });
}
function fmtIST(dt: string | null | undefined): string {
  if (!dt) return "—";
  const d = new Date(dt);
  return isNaN(d.getTime()) ? "—" : d.toLocaleString("en-IN", { timeZone: "Asia/Kolkata", day: "2-digit", month: "short", year: "numeric", hour: "2-digit", minute: "2-digit", hour12: true });
}
function fmtDate(dt: string | null | undefined): string {
  if (!dt) return "—";
  const d = new Date(dt);
  return isNaN(d.getTime()) ? String(dt).slice(0, 10) : d.toLocaleDateString("en-IN", { timeZone: "Asia/Kolkata", day: "2-digit", month: "short", year: "numeric" });
}

type ExtraRow = {
  id: number; sessionId: number; barcode: string; itemName: string | null;
  totalQty: number; creditedQty: number; available: number;
  scannedAt: string; scannedByName: string | null;
  voided: boolean; voidReason: string | null;
  plant: string; csvFileName: string; orderDate: string;
  srNo: string | null;
  itemsPerPallet: number | null;
};
type ShortfallRow = {
  itemId: number; sessionId: number; barcode: string; itemName: string | null;
  expectedQty: number; totalScannedQty: number;
  plant: string; csvFileName: string; orderDate: string;
  reopenQty: number; reopenEventId: number | null; shortfallReal: number;
};
// One row per distinct product (barcode+plant) on the picked date, not one row per scan — a
// product scanned as Extra several times that day (different STVs, different moments) used to
// list every single entry separately. Clicking a product's row expands it to that full history.
type GroupedExtra = {
  key: string; barcode: string; itemName: string | null; srNo: string | null; plant: string;
  totalQty: number; totalAvailable: number; entryCount: number; anyVoided: boolean;
  extraPallets: number; availablePallets: number; creditedQty: number;
};

// Pallets for a quantity of one product: qty ÷ items per pallet (0 when the pallet size is unknown).
const palletsOf = (qty: number, itemsPerPallet: number | null | undefined) =>
  itemsPerPallet && itemsPerPallet > 0 ? qty / itemsPerPallet : 0;
const fmtPallets = (n: number) => (Math.round(n * 100) / 100).toLocaleString(undefined, { maximumFractionDigits: 2 });

export default function AdjustExchange() {
  const [rootRef, pageWidth] = usePageWidth();
  const useCards = pageWidth > 0 ? pageWidth < TABLE_MIN_PAGE_WIDTH : false;
  const { user } = useAuth();
  const { toast } = useToast();
  const qc = useQueryClient();
  const role = String((user as any)?.role ?? "").toLowerCase();
  const isAdmin = ["admin", "super-admin"].includes(role);
  const canWrite = isAdmin || hasPageWriteAccess("adjust-exchange");

  // Persisted like the plant filter below, so a refresh or a page change keeps the chosen date.
  const [date, setDate] = usePersistentFilter("adjustExchange:date", todayIST());
  const [selectedPlant, setSelectedPlant] = usePersistentFilter("adjustExchange:plant", "");

  const { data: allPlants = [] } = useQuery<Array<{ name: string; bgColor: string; textColor: string; borderColor: string }>>({
    queryKey: ["/api/plants", "adjust-exchange"],
    queryFn: () => apiRequest("GET", "/api/plants").then((r) => r.json()),
    staleTime: 60000,
  });
  const plantOptions = allPlants.map((p) => p.name).sort((a, b) => a.localeCompare(b));
  // Same colors Plant Management sets, so the picker matches the plant badges in the table.
  const plantChipStyle = (name: string) => {
    const cfg = allPlants.find((p) => p.name.toUpperCase() === name.toUpperCase());
    return cfg ? { backgroundColor: cfg.bgColor, color: cfg.textColor, borderColor: cfg.borderColor } : undefined;
  };

  // ── The product/Extra item list ────────────────────────────────────────────────────────────
  const extrasQuery = useQuery<ExtraRow[]>({
    queryKey: ["/api/order-scan/exchange/extras", "date", date, selectedPlant],
    queryFn: async () => {
      const q = new URLSearchParams({ date });
      if (selectedPlant) q.set("plant", selectedPlant);
      const res = await apiRequest("GET", `/api/order-scan/exchange/extras?${q}`);
      if (!res.ok) throw new Error((await res.json().catch(() => ({})))?.message || "Failed to load extras");
      return res.json();
    },
  });

  const groupedExtras = useMemo<GroupedExtra[]>(() => {
    const map = new Map<string, GroupedExtra>();
    for (const r of extrasQuery.data ?? []) {
      const key = `${r.plant}::${r.barcode}`;
      const g = map.get(key) ?? { key, barcode: r.barcode, itemName: r.itemName, srNo: r.srNo, plant: r.plant, totalQty: 0, totalAvailable: 0, entryCount: 0, anyVoided: false, extraPallets: 0, availablePallets: 0, creditedQty: 0 };
      g.totalQty += r.totalQty;
      g.totalAvailable += r.available;
      g.extraPallets += palletsOf(r.totalQty, r.itemsPerPallet);
      g.availablePallets += palletsOf(r.available, r.itemsPerPallet);
      g.creditedQty += r.creditedQty;
      g.entryCount += 1;
      if (r.voided) g.anyVoided = true;
      if (!g.itemName && r.itemName) g.itemName = r.itemName;
      map.set(key, g);
    }
    return Array.from(map.values()).sort((a, b) => (a.itemName ?? a.barcode).localeCompare(b.itemName ?? b.barcode));
  }, [extrasQuery.data]);
  // Search narrows the product list (table and cards) by Sr No, item name, or barcode. The
  // status card above keeps the full date/plant totals.
  const [search, setSearch] = usePersistentFilter("adjustExchange:search", "");
  const visibleGroups = useMemo(() => {
    // A product with nothing left to give (all of it closed to earlier shortfalls, or moved to
    // another product) drops off the list. One with a voided scan stays, so its history is reachable.
    const open = groupedExtras.filter((g) => g.totalAvailable > 0 || g.anyVoided);
    const q = search.trim().toLowerCase();
    if (!q) return open;
    return open.filter((g) =>
      (g.srNo ?? "").toLowerCase().includes(q) ||
      (g.itemName ?? "").toLowerCase().includes(q) ||
      g.barcode.toLowerCase().includes(q),
    );
  }, [groupedExtras, search]);
  const [expandedGroupKey, setExpandedGroupKey] = useState<string | null>(null);

  // ── The side panel — appears next to the list once an Extra's Adjust is clicked ────────────
  const [selectedExtra, setSelectedExtra] = useState<ExtraRow | null>(null);
  const [selectedShortfall, setSelectedShortfall] = useState<ShortfallRow | null>(null);
  const [qty, setQty] = useState(0);

  const candidatesQuery = useQuery<ShortfallRow[]>({
    queryKey: ["/api/order-scan/exchange/shortfalls", "for-extra", selectedExtra?.id],
    queryFn: async () => {
      if (!selectedExtra) return [];
      const q = new URLSearchParams({ plant: selectedExtra.plant, beforeDate: selectedExtra.orderDate, barcode: selectedExtra.barcode });
      const res = await apiRequest("GET", `/api/order-scan/exchange/shortfalls?${q}`);
      if (!res.ok) throw new Error((await res.json().catch(() => ({})))?.message || "Failed to load candidates");
      const rows: ShortfallRow[] = await res.json();
      return rows.filter((r) => r.sessionId !== selectedExtra.sessionId);
    },
    enabled: !!selectedExtra,
  });

  const maxQty = selectedExtra && selectedShortfall ? Math.max(0, Math.min(selectedExtra.available, selectedShortfall.shortfallReal)) : 0;

  function openPanel(row: ExtraRow) {
    setSelectedExtra(row);
    setSelectedShortfall(null);
    setQty(0);
  }
  function pickShortfall(row: ShortfallRow) {
    setSelectedShortfall(row);
    setQty(Math.max(0, Math.min(selectedExtra?.available ?? 0, row.shortfallReal)));
  }
  function closePanel() {
    setSelectedExtra(null);
    setSelectedShortfall(null);
    setQty(0);
  }

  const invalidateExchangeQueries = () => {
    qc.invalidateQueries({ queryKey: ["/api/order-scan/exchange/extras"] });
    qc.invalidateQueries({ queryKey: ["/api/order-scan/exchange/shortfalls"] });
  };

  // ── Exchange — relabel this Extra to a DIFFERENT product, any product in Product Master ────
  // (a mis-scan correction: the box turned out to be something else entirely, not necessarily
  // anything this order expected). Distinct from Adjust: no shortfall gets credited here — just
  // "this is actually item X, not item Y", with its stock moving to match. Same all-products
  // search Loading's own Add Extra uses (GET /api/products?all=true, filtered client-side).
  const [exchangeTarget, setExchangeTarget] = useState<ExtraRow | null>(null);
  const [exchangeSearch, setExchangeSearch] = useState("");
  function openExchangeDialog(row: ExtraRow) {
    setExchangeTarget(row);
    setExchangeSearch("");
  }
  const allProductsQuery = useQuery<Array<{ id: number; barcode: string; name: string | null }>>({
    queryKey: ["/api/products", "all", "adjust-exchange"],
    queryFn: async () => (await apiRequest("GET", "/api/products?all=true")).json(),
    enabled: !!exchangeTarget,
    staleTime: 60000,
  });
  const exchangeCandidates = (() => {
    const q = exchangeSearch.trim().toLowerCase();
    if (!q) return [];
    return (allProductsQuery.data ?? [])
      .filter((p) => p.barcode?.toLowerCase() !== exchangeTarget?.barcode.toLowerCase())
      .filter((p) => (p.name ?? "").toLowerCase().includes(q) || (p.barcode ?? "").toLowerCase().includes(q))
      .slice(0, 30);
  })();

  const exchangeMutation = useMutation({
    mutationFn: async (payload: { eventId: number; newBarcode: string }) => {
      const res = await apiRequest("POST", `/api/order-scan/exchange/events/${payload.eventId}/reassign-product`, { newBarcode: payload.newBarcode });
      if (!res.ok) throw new Error((await res.json().catch(() => ({})))?.message || "Failed to exchange this product");
      return res.json();
    },
    onSuccess: () => {
      toast({ title: "Product exchanged", description: "This Extra now counts toward the item you picked; its stock moved with it." });
      invalidateExchangeQueries();
      setExchangeTarget(null);
      setExchangeSearch("");
      // Collapse whatever product was open, so the move does not leave another one expanded.
      setExpandedGroupKey(null);
    },
    onError: (err: any) => toast({ title: "Could not exchange this product", description: err?.message ?? String(err), variant: "destructive" }),
  });

  const voidMutation = useMutation({
    mutationFn: async ({ id, reason }: { id: number; reason: string }) => {
      const res = await apiRequest("POST", `/api/order-scan/events/${id}/void`, { reason });
      if (!res.ok) throw new Error((await res.json().catch(() => ({})))?.message || "Failed to void");
      return res.json();
    },
  });

  const creditMutation = useMutation({
    mutationFn: async (payload: { extraEventId: number; targetItemId: number; qty: number; reopenEventId?: number | null }) => {
      // Reopening an old Adjust Remaining closure is just voiding that event first — the void
      // endpoint already reverses its fabricated stock and drops the item's total_scanned_qty
      // back down, which IS "reopening" it. No separate reopen endpoint needed.
      if (payload.reopenEventId) {
        await voidMutation.mutateAsync({ id: payload.reopenEventId, reason: "Reopened for Adjust Exchange Extra — a real Extra was found for this item" });
      }
      const res = await apiRequest("POST", "/api/order-scan/exchange/credit", {
        extraEventId: payload.extraEventId, targetItemId: payload.targetItemId, qty: payload.qty,
      });
      if (!res.ok) throw new Error((await res.json().catch(() => ({})))?.message || "Failed to credit this exchange");
      return res.json();
    },
    onSuccess: () => {
      toast({ title: "Exchange recorded", description: "The shortfall dropped and a Credited via Extra entry now shows in its history." });
      invalidateExchangeQueries();
      closePanel();
      // Collapse whatever product was open, so the move does not leave another one expanded.
      setExpandedGroupKey(null);
    },
    onError: (err: any) => toast({ title: "Could not record this exchange", description: err?.message ?? String(err), variant: "destructive" }),
  });

  // ── Row-level Void ───────────────────────────────────────────────────────────────────────────
  const [voidTarget, setVoidTarget] = useState<ExtraRow | null>(null);
  const [voidReason, setVoidReason] = useState("");
  const rowVoidMutation = useMutation({
    mutationFn: (payload: { id: number; reason: string }) => voidMutation.mutateAsync(payload),
    onSuccess: () => {
      toast({ title: "Extra voided", description: "Excluded from totals and stock; kept in history." });
      invalidateExchangeQueries();
      setVoidTarget(null);
      setVoidReason("");
    },
    onError: (err: any) => toast({ title: "Could not void this Extra", description: err?.message ?? String(err), variant: "destructive" }),
  });

  // ── Permanent delete (admin only, already-voided rows only) ────────────────────────────────
  const [deleteTarget, setDeleteTarget] = useState<ExtraRow | null>(null);
  const deleteMutation = useMutation({
    mutationFn: async (id: number) => {
      const res = await apiRequest("POST", `/api/order-scan/exchange/events/${id}/delete-permanent`, {});
      if (!res.ok) throw new Error((await res.json().catch(() => ({})))?.message || "Failed to delete");
      return res.json();
    },
    onSuccess: () => {
      toast({ title: "Deleted permanently", description: "The row is gone from the database and every report." });
      invalidateExchangeQueries();
      setDeleteTarget(null);
    },
    onError: (err: any) => toast({ title: "Could not delete this row", description: err?.message ?? String(err), variant: "destructive" }),
  });

  // Which entry a group's own Adjust button acts on — the oldest not-yet-voided entry that still
  // has something left to give. A specific OTHER entry can still be reached by expanding the row
  // and using that entry's own Adjust button (e.g. to work through a second, separate scan of the
  // same product once the first is fully claimed).
  const bestEntryFor = (key: string) =>
    (extrasQuery.data ?? [])
      .filter((e) => `${e.plant}::${e.barcode}` === key && !e.voided && e.available > 0 && e.creditedQty === 0)
      .sort((a, b) => a.scannedAt.localeCompare(b.scannedAt))[0];

  const groupColumns: DataTableColumn<GroupedExtra>[] = [
    // Numeric accessor so Sort goes by number (10 after 9), not as text. A non-numeric Sr No
    // sorts to the end.
    { id: "srNo", header: "Sr No", align: "center", width: 31, sortable: true, totalable: false, accessor: (r) => (r.srNo && Number.isFinite(Number(r.srNo)) ? Number(r.srNo) : null), cellClassName: "tabular-nums text-gray-700", render: (r) => r.srNo ?? "—" },
    {
      id: "item", header: "Item / Barcode", sortable: true, accessor: (r) => `${r.itemName ?? ""} ${r.barcode}`, totalable: false,
      cellClassName: "text-gray-900",
      render: (r) => (
        <div className="flex items-center gap-2">
          <ProductPhoto name={r.itemName} className="h-10 w-10 shrink-0 rounded border border-gray-200 bg-white object-contain" zoomable />
          <div className="min-w-0">
            <p className="truncate font-medium">{r.itemName || "—"}</p>
            <p className="break-all font-mono text-xs text-gray-500">{r.barcode}</p>
          </div>
        </div>
      ),
    },
    { id: "plant", header: "Plant", align: "center", width: 110, sortable: true, totalable: false, accessor: (r) => r.plant, render: (r) => <PlantBadge plant={r.plant} className="px-2 py-0 text-[11px]" /> },
    { id: "entries", header: "Entries", align: "center", width: 80, sortable: true, accessor: (r) => r.entryCount, cellClassName: "tabular-nums text-gray-700" },
    // Extra Qty is what is still left to give here — qty already closed to an earlier shortfall (or
    // moved to another product) comes off it straight away. Full history stays in the expanded rows.
    { id: "extraQty", header: "Extra Qty", align: "center", width: 90, sortable: true, accessor: (r) => r.totalAvailable, cellClassName: "tabular-nums text-amber-600 font-medium" },
    { id: "extraPallets", header: "Extra Plt", align: "right", width: 90, sortable: true, accessor: (r) => Math.round(r.availablePallets * 100) / 100, render: (r) => fmtPallets(r.availablePallets), cellClassName: "tabular-nums text-amber-600" },
    {
      // "Status": whether every scan of this product on this date is still a normal, active
      // Extra ("Active"), or whether at least one of them has been Voided ("Includes voided") —
      // expand the row to see which entry and why.
      id: "status", header: "Status", width: 130, totalable: false, accessor: (r) => (r.anyVoided ? 1 : 0),
      render: (r) => r.anyVoided
        ? <span className="rounded-full bg-amber-100 px-2 py-0.5 text-[11px] font-semibold text-amber-700">Includes voided</span>
        : <span className="rounded-full bg-emerald-100 px-2 py-0.5 text-[11px] font-semibold text-emerald-700">Active</span>,
    },
  ];

  // Card form of one Extra entry's own action row — same buttons entryColumns' actions column
  // has, just stacked for a phone/tablet card instead of laid across a table cell.
  function EntryActions({ e }: { e: ExtraRow }) {
    if (!canWrite) return null;
    return (
      <div className="mt-2 flex flex-wrap gap-1.5">
        {!e.voided && e.available > 0 && e.creditedQty === 0 && (
          <Button
            size="sm"
            className={`h-7 gap-1 px-2 text-xs ${selectedExtra?.id === e.id ? "bg-[#00154b] ring-2 ring-[#001d6e]/40" : "bg-[#001d6e] hover:bg-[#001552]"}`}
            onClick={() => openPanel(e)}
          >
            <ArrowLeftRight className="h-3.5 w-3.5" /> Close earlier shortfall
          </Button>
        )}
        {!e.voided && e.creditedQty === 0 && (
          <Button size="sm" variant="outline" className="h-7 gap-1 px-2 text-xs text-[#001d6e] hover:bg-[#001d6e]/5" onClick={() => openExchangeDialog(e)}>
            <Repeat className="h-3.5 w-3.5" /> Change product
          </Button>
        )}
        {!e.voided && (
          <Button size="sm" variant="outline" className="h-7 gap-1 px-2 text-xs text-red-600 hover:bg-red-50" onClick={() => setVoidTarget(e)}>
            <Ban className="h-3.5 w-3.5" /> Void
          </Button>
        )}
        {e.voided && isAdmin && (
          <Button size="sm" variant="outline" className="h-7 gap-1 px-2 text-xs text-red-700 hover:bg-red-50" onClick={() => setDeleteTarget(e)}>
            <Trash2 className="h-3.5 w-3.5" /> Delete
          </Button>
        )}
      </div>
    );
  }

  // Card form of a product's full scan-entry history (what the DataTable's renderExpandedRow
  // shows as a nested table on a wide screen) — used both there is no room for that table at all.
  function EntryHistoryCards({ entries }: { entries: ExtraRow[] }) {
    return (
      <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
        {entries.map((e) => (
          <div key={e.id} className={`rounded-lg border p-3 ${e.voided ? "border-red-200 bg-red-50/50" : "border-gray-200 bg-white"}`}>
            <div className="flex items-start justify-between gap-2">
              <div className="text-sm">
                <p className="font-medium text-gray-900">{e.csvFileName}</p>
                <p className="text-xs text-gray-500">{fmtDate(e.orderDate)}</p>
              </div>
              {e.voided
                ? <span className="shrink-0 rounded-full bg-red-100 px-2 py-0.5 text-[11px] font-semibold text-red-700">Voided</span>
                : <span className="shrink-0 rounded-full bg-emerald-100 px-2 py-0.5 text-[11px] font-semibold text-emerald-700">Active</span>}
            </div>
            <div className="mt-2 grid grid-cols-2 gap-x-3 gap-y-1 text-xs text-gray-600">
              <span>Extra Qty: <strong className="text-sm text-amber-600">{e.totalQty}</strong></span>
              <span>Available: <strong className="text-sm text-[#001d6e]">{e.available}</strong></span>
              <span className="col-span-2">By: <strong className="text-gray-900">{e.scannedByName || "—"}</strong> · {fmtIST(e.scannedAt)}</span>
            </div>
            {e.voided && e.voidReason && <p className="mt-1 text-xs text-red-700">{e.voidReason}</p>}
            <EntryActions e={e} />
          </div>
        ))}
      </div>
    );
  }

  // The whole page as cards — a product per card, its own history expanding underneath, same
  // data and actions the table gives on a wider screen.
  function GroupedExtraCards() {
    if (visibleGroups.length === 0) {
      return <p className="py-10 text-center text-sm text-gray-400">{extrasQuery.isLoading ? "Loading…" : extrasQuery.isError ? (extrasQuery.error as Error).message : `No Extra scans on ${fmtDate(date)}.`}</p>;
    }
    return (
      // 2 columns once there's room for them (a phone stays 1) — an open card spans both so its
      // history has full width to lay out in, instead of being squeezed into half the row.
      <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
        {visibleGroups.map((g) => {
          const isOpen = expandedGroupKey === g.key;
          const entries = (extrasQuery.data ?? []).filter((e) => `${e.plant}::${e.barcode}` === g.key);
          const entry = bestEntryFor(g.key);
          return (
            <div key={g.key} className={`overflow-hidden rounded-xl border shadow-sm ${isOpen ? "sm:col-span-2" : ""} ${g.anyVoided ? "border-amber-200 bg-amber-50/20" : "border-gray-200 bg-white"}`}>
              <button type="button" className="flex w-full items-start gap-3 p-3 text-left" onClick={() => setExpandedGroupKey(isOpen ? null : g.key)}>
                <ProductPhoto name={g.itemName} className="h-12 w-12 shrink-0 rounded border border-gray-200 bg-white object-contain" />
                <div className="min-w-0 flex-1">
                  <div className="flex items-start justify-between gap-2">
                    <div className="min-w-0">
                      <p className="truncate font-semibold text-gray-900">{g.itemName || "—"}</p>
                      <p className="break-all font-mono text-xs text-gray-500">{g.barcode}</p>
                    </div>
                    <PlantBadge plant={g.plant} className="shrink-0 px-2 py-0 text-[11px]" />
                  </div>
                  <div className="mt-2 grid grid-cols-3 gap-x-2 gap-y-1 text-xs text-gray-600">
                    <span>Entries: <strong className="text-sm text-gray-900">{g.entryCount}</strong></span>
                    <span>Extra: <strong className="text-sm text-amber-600">{g.totalQty}</strong></span>
                    <span>Available: <strong className="text-sm text-[#001d6e]">{g.totalAvailable}</strong></span>
                  </div>
                  {g.anyVoided && (
                    <span className="mt-1.5 inline-block rounded-full bg-amber-100 px-2 py-0.5 text-[11px] font-semibold text-amber-700">Includes voided</span>
                  )}
                </div>
                <ChevronDown className={`mt-1 h-4 w-4 shrink-0 text-gray-400 transition-transform ${isOpen ? "rotate-180" : ""}`} />
              </button>
              {canWrite && entry && (
                <div className="flex flex-wrap gap-1.5 border-t border-gray-100 px-3 py-2">
                  <Button size="sm" className="h-7 gap-1 bg-[#001d6e] px-2 text-xs hover:bg-[#001552]" onClick={() => openPanel(entry)}>
                    <ArrowLeftRight className="h-3.5 w-3.5" /> Close earlier shortfall
                  </Button>
                  <Button size="sm" variant="outline" className="h-7 gap-1 px-2 text-xs text-[#001d6e] hover:bg-[#001d6e]/5" onClick={() => openExchangeDialog(entry)}>
                    <Repeat className="h-3.5 w-3.5" /> Change product
                  </Button>
                </div>
              )}
              {isOpen && (
                <div className="border-t border-gray-100 bg-slate-50/70 p-3">
                  <p className="mb-2 text-xs font-semibold uppercase tracking-wide text-gray-500">
                    Every Extra scan of this product on {fmtDate(date)} — its full history
                  </p>
                  <EntryHistoryCards entries={entries} />
                </div>
              )}
            </div>
          );
        })}
      </div>
    );
  }

  const entryColumns: DataTableColumn<ExtraRow>[] = [
    { id: "csv", header: "CSV", width: 190, totalable: false, accessor: (r) => r.csvFileName, cellClassName: "text-xs text-gray-600", render: (r) => r.csvFileName },
    { id: "orderDate", header: "Date", width: 100, totalable: false, accessor: (r) => r.orderDate, cellClassName: "text-xs text-gray-600", render: (r) => fmtDate(r.orderDate) },
    { id: "extraQty", header: "Extra Qty", align: "right", width: 90, accessor: (r) => r.totalQty, cellClassName: "tabular-nums text-amber-600 font-medium" },
    { id: "available", header: "Available", align: "right", width: 90, accessor: (r) => r.available, cellClassName: "tabular-nums text-[#001d6e] font-semibold" },
    { id: "scannedBy", header: "Scanned By / At", width: 170, totalable: false, accessor: (r) => r.scannedByName, cellClassName: "text-xs text-gray-600", render: (r) => <>{r.scannedByName || "—"}<br /><span className="text-gray-400">{fmtIST(r.scannedAt)}</span></> },
    {
      id: "status", header: "Status", width: 100, totalable: false, accessor: (r) => (r.voided ? 1 : 0),
      render: (r) => r.voided
        ? <span className="rounded-full bg-red-100 px-2 py-0.5 text-[11px] font-semibold text-red-700">Voided</span>
        : <span className="rounded-full bg-emerald-100 px-2 py-0.5 text-[11px] font-semibold text-emerald-700">Active</span>,
    },
    {
      id: "actions", header: "", width: 260, fixedWidth: true, sortable: false, totalable: false,
      render: (r) => !canWrite ? null : (
        <div className="flex flex-wrap gap-1.5">
          {!r.voided && r.available > 0 && r.creditedQty === 0 && (
            <Button
              size="sm"
              className={`h-7 gap-1 px-2 text-xs ${selectedExtra?.id === r.id ? "bg-[#00154b] ring-2 ring-[#001d6e]/40" : "bg-[#001d6e] hover:bg-[#001552]"}`}
              onClick={() => openPanel(r)}
            >
              <ArrowLeftRight className="h-3.5 w-3.5" /> Close earlier shortfall
            </Button>
          )}
          {!r.voided && r.creditedQty === 0 && (
            <Button size="sm" variant="outline" className="h-7 gap-1 px-2 text-xs text-[#001d6e] hover:bg-[#001d6e]/5" onClick={() => openExchangeDialog(r)}>
              <Repeat className="h-3.5 w-3.5" /> Change product
            </Button>
          )}
          {!r.voided && (
            <Button size="sm" variant="outline" className="h-7 gap-1 px-2 text-xs text-red-600 hover:bg-red-50" onClick={() => setVoidTarget(r)}>
              <Ban className="h-3.5 w-3.5" /> Void
            </Button>
          )}
          {r.voided && isAdmin && (
            <Button size="sm" variant="outline" className="h-7 gap-1 px-2 text-xs text-red-700 hover:bg-red-50" onClick={() => setDeleteTarget(r)}>
              <Trash2 className="h-3.5 w-3.5" /> Delete
            </Button>
          )}
        </div>
      ),
    },
  ];

  return (
    <div ref={rootRef} className="container-fluid max-w-full space-y-5 overflow-x-hidden px-3 py-6 sm:px-4 md:px-6">
      <PageHeader
        icon={ArrowLeftRight}
        title="Adjust Exchange Extra"
        subtitle="Move a real Extra scan to close a shortfall on a different, earlier CSV — same plant, same product, nothing counted twice."
      />

      <div className="flex flex-wrap items-center gap-2">
        <Select value={selectedPlant || "__all__"} onValueChange={(v) => setSelectedPlant(v === "__all__" ? "" : v)}>
          <SelectTrigger className="h-9 w-[min(11rem,calc(100vw-2rem))] text-sm">
            <SelectValue placeholder="Choose a plant" />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="__all__">All plants</SelectItem>
            {plantOptions.map((p) => (
              <SelectItem key={p} value={p}>
                <span className="inline-flex items-center rounded-full border px-2 py-0 text-xs font-medium" style={plantChipStyle(p)}>{p}</span>
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        <DateInput value={date} onChange={setDate} clearable={false} />
        <div className="relative min-w-[12rem] flex-1 sm:max-w-xs">
          <Search className="pointer-events-none absolute left-2.5 top-2.5 h-4 w-4 text-gray-400" />
          <Input
            value={search} onChange={(e) => setSearch(e.target.value)}
            placeholder="Search Sr No, item name or barcode…" className="h-9 pl-8 text-sm"
          />
        </div>
      </div>

      {/* Status card — what this date/plant selection holds at a glance. Counts come from the
          same list the table shows, so they always match it. */}
      <div className="grid grid-cols-2 gap-2 sm:grid-cols-3 lg:grid-cols-6">
        {[
          { label: "Products with Extra", value: groupedExtras.length.toLocaleString(), sub: null, tone: "text-gray-900" },
          { label: "Extra scans", value: (extrasQuery.data?.length ?? 0).toLocaleString(), sub: null, tone: "text-gray-900" },
          { label: "Extra qty", value: groupedExtras.reduce((n, g) => n + g.totalQty, 0).toLocaleString(), sub: `${fmtPallets(groupedExtras.reduce((n, g) => n + g.extraPallets, 0))} plt`, tone: "text-amber-600" },
          { label: "Still available", value: groupedExtras.reduce((n, g) => n + g.totalAvailable, 0).toLocaleString(), sub: `${fmtPallets(groupedExtras.reduce((n, g) => n + g.availablePallets, 0))} plt`, tone: "text-[#001d6e]" },
          { label: "Adjusted to previous date", value: groupedExtras.reduce((n, g) => n + g.creditedQty, 0).toLocaleString(), sub: `${fmtPallets((extrasQuery.data ?? []).reduce((n, e) => n + palletsOf(e.creditedQty, e.itemsPerPallet), 0))} plt`, tone: "text-emerald-700" },
          { label: "Voided scans", value: (extrasQuery.data ?? []).filter((e) => e.voided).length.toLocaleString(), sub: null, tone: "text-red-600" },
        ].map((t) => (
          <div key={t.label} className="rounded-lg border border-gray-200 bg-white px-3 py-2 shadow-sm">
            <p className="text-[11px] font-medium uppercase tracking-wide text-gray-500">{t.label}</p>
            <p className={`text-lg font-semibold tabular-nums ${t.tone}`}>{t.value}</p>
            {t.sub && <p className="text-[11px] tabular-nums text-gray-500">{t.sub}</p>}
          </div>
        ))}
      </div>

      {/* Below TABLE_MIN_PAGE_WIDTH (tablets included, e.g. a Realme Pad 2 in portrait) this is
          cards, each expanding to its own full history as more cards — never a sideways scroll.
          At full width it's one table whose rows expand in place to a nested history table. */}
      {useCards ? (
        <GroupedExtraCards />
      ) : (
        <DataTable<GroupedExtra>
          columns={groupColumns}
          sortMode="client"
          data={visibleGroups}
          getRowId={(r) => r.key}
          emptyState={extrasQuery.isLoading ? "Loading…" : extrasQuery.isError ? (extrasQuery.error as Error).message : `No Extra scans on ${fmtDate(date)}.`}
          enableZebraStripes
          enableColumnResizing
          showMobileSwipeHint
          isStickyHeader
          maxHeight="calc(100vh - 280px)"
          headerClassName={TABLE_HEADER_CLASS}
          rowClassName={(r) => (r.anyVoided ? "bg-amber-50/30" : undefined)}
          onRowClick={(r) => setExpandedGroupKey((cur) => (cur === r.key ? null : r.key))}
          isRowExpandable={() => true}
          expandedRowId={expandedGroupKey}
          renderExpandedRow={(r) => {
            const entries = (extrasQuery.data ?? []).filter((e) => `${e.plant}::${e.barcode}` === r.key);
            return (
              <div className="border-y border-[#001d6e]/20 bg-slate-50/70 p-3">
                <p className="mb-2 text-xs font-semibold uppercase tracking-wide text-gray-500">
                  Every Extra scan of this product on {fmtDate(date)} — its full history
                </p>
                <DataTable<ExtraRow>
                  className="space-y-0"
                  columns={entryColumns}
                  data={entries}
                  getRowId={(e) => String(e.id)}
                  emptyState="No entries"
                  enableZebraStripes
                  headerClassName={TABLE_HEADER_CLASS}
                  rowClassName={(e) => (e.voided ? "bg-red-50/40" : undefined)}
                  maxHeight="260px"
                  isStickyHeader
                />
              </div>
            );
          }}
        />
      )}

      {/* ── The exchange popup — Adjust on an entry opens this ─────────────────────────────── */}
      <Dialog open={!!selectedExtra} onOpenChange={(o) => { if (!o) closePanel(); }}>
        <DialogContent className="max-h-[90vh] w-[calc(100vw-1rem)] max-w-lg overflow-y-auto sm:max-w-xl">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2 text-[#001d6e]"><ArrowLeftRight className="h-5 w-5" /> Adjust Exchange Extra</DialogTitle>
          </DialogHeader>

          {selectedExtra && (
            <div className="space-y-4">
              <div className="rounded-lg border border-[#001d6e]/20 bg-[#001d6e]/5 p-3 text-sm">
                <p className="text-[11px] font-semibold uppercase tracking-wide text-[#001d6e]">Extra in hand</p>
                <p className="mt-1 font-semibold text-gray-900">{selectedExtra.itemName || "—"}</p>
                <p className="font-mono text-xs text-gray-500">{selectedExtra.barcode}</p>
                <p className="mt-1 text-xs text-gray-500">{selectedExtra.csvFileName} · {fmtDate(selectedExtra.orderDate)} · available <strong className="text-[#001d6e]">{selectedExtra.available}</strong></p>
              </div>

              {!selectedShortfall ? (
                <div>
                  <p className="mb-2 text-sm font-medium text-gray-700">Pick which earlier shortfall this should fill:</p>
                  {candidatesQuery.isLoading ? (
                    <div className="flex items-center py-6 text-gray-400"><Loader2 className="mr-2 h-4 w-4 animate-spin" /> Loading candidates…</div>
                  ) : candidatesQuery.isError ? (
                    <p className="text-sm text-red-600">{(candidatesQuery.error as Error).message}</p>
                  ) : (candidatesQuery.data ?? []).length === 0 ? (
                    <p className="rounded-lg border border-gray-200 bg-gray-50 p-3 text-sm text-gray-500">No earlier open shortfall matches this product at this plant.</p>
                  ) : (
                    <div className="max-h-64 space-y-1.5 overflow-y-auto pr-1">
                      {candidatesQuery.data!.map((row) => (
                        <button key={row.itemId} type="button" onClick={() => pickShortfall(row)} className="flex w-full items-center justify-between gap-2 rounded-lg border border-gray-200 p-2.5 text-left text-sm hover:border-[#001d6e]/40 hover:bg-[#001d6e]/5">
                          <span className="min-w-0">
                            <span className="block truncate font-medium text-gray-900">{row.csvFileName} · {fmtDate(row.orderDate)}</span>
                            <span className="text-xs text-gray-500">Short by <strong className="text-red-600">{row.shortfallReal}</strong>{row.reopenEventId ? " · closed via Adjust Remaining" : ""}</span>
                          </span>
                          <ArrowRight className="h-4 w-4 shrink-0 text-gray-300" />
                        </button>
                      ))}
                    </div>
                  )}
                </div>
              ) : (
                <>
                  <div className="rounded-lg border border-gray-200 bg-gray-50 p-3 text-sm">
                    <div className="flex items-start justify-between gap-2">
                      <p className="text-[11px] font-semibold uppercase tracking-wide text-gray-500">Shortfall picked</p>
                      <button type="button" className="text-xs font-medium text-[#001d6e] underline" onClick={() => setSelectedShortfall(null)}>Change</button>
                    </div>
                    <p className="mt-1 font-semibold text-gray-900">{selectedShortfall.itemName || "—"}</p>
                    <p className="text-xs text-gray-500">{selectedShortfall.csvFileName} · {fmtDate(selectedShortfall.orderDate)}</p>
                    {selectedShortfall.reopenEventId && (
                      <p className="mt-1 flex items-center gap-1 text-[11px] font-semibold text-slate-600">
                        <RotateCcw className="h-3 w-3" /> Closed via Adjust Remaining — will be reopened when you confirm.
                      </p>
                    )}
                  </div>

                  <div className="grid grid-cols-2 gap-3 text-sm">
                    <div className="rounded-lg border border-gray-100 bg-white p-2.5">
                      <p className="text-[11px] font-semibold uppercase tracking-wide text-gray-500">Available to give</p>
                      <p className="text-lg font-bold text-[#001d6e]">{selectedExtra.available}</p>
                    </div>
                    <div className="rounded-lg border border-gray-100 bg-white p-2.5">
                      <p className="text-[11px] font-semibold uppercase tracking-wide text-gray-500">Being asked for</p>
                      <p className="text-lg font-bold text-red-600">{selectedShortfall.shortfallReal}</p>
                    </div>
                  </div>

                  <div className="space-y-1.5">
                    <Label className="text-sm">Quantity to give (max {maxQty})</Label>
                    <Input
                      type="number" min={1} max={maxQty} value={qty || ""}
                      onChange={(e) => setQty(Math.max(0, Math.min(maxQty, Number(e.target.value) || 0)))}
                      placeholder={`up to ${maxQty}`}
                    />
                  </div>
                </>
              )}
            </div>
          )}

          <DialogFooter className="gap-2">
            <Button variant="outline" onClick={closePanel} disabled={creditMutation.isPending}>Cancel</Button>
            {selectedShortfall && (
              <Button
                className="bg-[#001d6e] hover:bg-[#001552]"
                disabled={!qty || qty <= 0 || qty > maxQty || creditMutation.isPending}
                onClick={() => selectedExtra && creditMutation.mutate({
                  extraEventId: selectedExtra.id, targetItemId: selectedShortfall.itemId, qty,
                  reopenEventId: selectedShortfall.reopenEventId,
                })}
              >
                {creditMutation.isPending && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
                Confirm Exchange
              </Button>
            )}
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* ── Exchange — relabel this Extra to a different item on the same order ────────────── */}
      <Dialog open={!!exchangeTarget} onOpenChange={(o) => { if (!o) { setExchangeTarget(null); setExchangeSearch(""); } }}>
        <DialogContent className="max-h-[90vh] w-[calc(100vw-1rem)] max-w-lg overflow-y-auto sm:max-w-xl">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2 text-[#001d6e]"><Repeat className="h-5 w-5" /> Exchange this Extra's product</DialogTitle>
          </DialogHeader>

          {exchangeTarget && (
            <div className="space-y-4">
              <div className="rounded-lg border border-[#001d6e]/20 bg-[#001d6e]/5 p-3 text-sm">
                <p className="text-[11px] font-semibold uppercase tracking-wide text-[#001d6e]">Currently scanned as</p>
                <p className="mt-1 font-semibold text-gray-900">{exchangeTarget.itemName || "—"}</p>
                <p className="font-mono text-xs text-gray-500">{exchangeTarget.barcode}</p>
                <p className="mt-1 text-xs text-gray-500">{exchangeTarget.csvFileName} · qty {exchangeTarget.totalQty}</p>
              </div>

              <div>
                <p className="mb-2 text-sm font-medium text-gray-700">What is it actually — search any product:</p>
                <div className="relative mb-2">
                  <Search className="pointer-events-none absolute left-2.5 top-2.5 h-4 w-4 text-gray-400" />
                  <Input
                    value={exchangeSearch} onChange={(e) => setExchangeSearch(e.target.value)}
                    placeholder="Search item name or barcode…" className="pl-8"
                    autoFocus
                  />
                </div>
                {allProductsQuery.isLoading ? (
                  <div className="flex items-center py-6 text-gray-400"><Loader2 className="mr-2 h-4 w-4 animate-spin" /> Loading products…</div>
                ) : allProductsQuery.isError ? (
                  <p className="text-sm text-red-600">{(allProductsQuery.error as Error).message}</p>
                ) : !exchangeSearch.trim() ? (
                  <p className="rounded-lg border border-gray-200 bg-gray-50 p-3 text-sm text-gray-500">Start typing to search every product.</p>
                ) : exchangeCandidates.length === 0 ? (
                  <p className="rounded-lg border border-gray-200 bg-gray-50 p-3 text-sm text-gray-500">No product matches that search.</p>
                ) : (
                  <div className="max-h-72 space-y-1.5 overflow-y-auto pr-1">
                    {exchangeCandidates.map((p) => (
                      <button
                        key={p.id} type="button"
                        disabled={exchangeMutation.isPending}
                        onClick={() => exchangeMutation.mutate({ eventId: exchangeTarget.id, newBarcode: p.barcode })}
                        className="flex w-full items-center gap-2.5 rounded-lg border border-gray-200 p-2.5 text-left text-sm hover:border-[#001d6e]/40 hover:bg-[#001d6e]/5 disabled:opacity-50"
                      >
                        <ProductPhoto name={p.name} className="h-9 w-9 shrink-0 rounded border bg-white object-contain" />
                        <span className="min-w-0 flex-1">
                          <span className="block truncate font-medium text-gray-900">{p.name || "—"}</span>
                          <span className="font-mono text-xs text-gray-500">{p.barcode}</span>
                        </span>
                        <ArrowRight className="h-4 w-4 shrink-0 text-gray-300" />
                      </button>
                    ))}
                  </div>
                )}
              </div>
            </div>
          )}

          <DialogFooter>
            <Button variant="outline" onClick={() => { setExchangeTarget(null); setExchangeSearch(""); }} disabled={exchangeMutation.isPending}>Cancel</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* ── Void an Extra ───────────────────────────────────────────────────────────────────── */}
      <Dialog open={!!voidTarget} onOpenChange={(o) => { if (!o) { setVoidTarget(null); setVoidReason(""); } }}>
        <DialogContent className="max-w-sm">
          <DialogHeader><DialogTitle>Void this Extra?</DialogTitle></DialogHeader>
          <p className="text-sm text-gray-600">
            <span className="font-semibold text-gray-900">{voidTarget?.itemName ?? voidTarget?.barcode}</span> — {voidTarget?.totalQty ?? 0} scanned by {voidTarget?.scannedByName ?? "—"}.
          </p>
          <p className="text-sm text-gray-500">This removes it from stock, but it stays here marked "Voided" for the record — never deleted.</p>
          <div className="space-y-1.5">
            <Label className="text-sm">Reason (optional)</Label>
            <Input value={voidReason} onChange={(e) => setVoidReason(e.target.value)} placeholder="e.g. double-scanned by mistake" />
          </div>
          <DialogFooter className="gap-2">
            <Button variant="outline" onClick={() => { setVoidTarget(null); setVoidReason(""); }} disabled={rowVoidMutation.isPending}>Cancel</Button>
            <Button
              className="bg-red-600 text-white hover:bg-red-700"
              disabled={rowVoidMutation.isPending}
              onClick={() => voidTarget && rowVoidMutation.mutate({ id: voidTarget.id, reason: voidReason })}
            >
              {rowVoidMutation.isPending && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
              Void Scan
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* ── Permanent delete ────────────────────────────────────────────────────────────────── */}
      <Dialog open={!!deleteTarget} onOpenChange={(o) => { if (!o) setDeleteTarget(null); }}>
        <DialogContent className="max-w-sm">
          <DialogHeader><DialogTitle className="text-red-700">Delete this row permanently?</DialogTitle></DialogHeader>
          <p className="text-sm text-gray-600">
            <span className="font-semibold text-gray-900">{deleteTarget?.itemName ?? deleteTarget?.barcode}</span> — {deleteTarget?.totalQty ?? 0}, voided.
          </p>
          <p className="text-sm font-medium text-red-600">
            This actually removes the row from the database — it will not appear anywhere, ever again, even in Scan History or on this page. This cannot be undone.
          </p>
          <DialogFooter className="gap-2">
            <Button variant="outline" onClick={() => setDeleteTarget(null)} disabled={deleteMutation.isPending}>Cancel</Button>
            <Button
              className="bg-red-700 text-white hover:bg-red-800"
              disabled={deleteMutation.isPending}
              onClick={() => deleteTarget && deleteMutation.mutate(deleteTarget.id)}
            >
              {deleteMutation.isPending && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
              <Trash2 className="mr-1.5 h-4 w-4" /> Delete Permanently
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
