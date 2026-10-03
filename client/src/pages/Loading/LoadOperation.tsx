import { Fragment, useEffect, useRef, useState } from "react";
import { sortNatural } from "@/lib/utils";
import { useMutation, useQuery } from "@tanstack/react-query";
import {
  AlertTriangle, Calendar, Camera, CheckCircle2, ClipboardList, Factory, ChevronLeft, ChevronRight, Download, FileText,
  ChevronDown, Keyboard, Layers, Link2, Loader2, Lock, Menu, Package, PackagePlus, Pencil, Plus, RotateCcw, RotateCw, ScanLine, Search, Trash2,
  Truck, UserCircle2, X, Zap,
} from "lucide-react";
import type { Result } from "@zxing/library";
import type { Product } from "@shared/schema";
import BarcodeScanner from "@/lib/barcodeScanner";
import { useSidebarContext } from "@/lib/sidebarContext";
import { usePersistentFilter } from "@/hooks/usePersistentFilter";
import { AddColumnFilterButton, ColumnFilterChipView, ColumnHeaderFilterButton } from "@/components/filters/ColumnFilterChip";
import { type FilterableColumn, type FilterCondition, type FilterOption, matchAllConditions } from "@/lib/columnFilters";
import { format as formatDay } from "date-fns";
import PageHeader from "@/components/PageHeader";
import { PlantBadge } from "@/components/PlantBadge";
import { PageScrollButtons } from "@/components/PageScrollButtons";
import { ProductPhoto } from "@/components/ProductPhoto";
import { CircularProgress } from "@/components/ui/circular-progress";
import { CollapsibleSearch } from "@/components/ui/collapsible-search";
import { buildPageList } from "@/components/ui/data-table/data-table-pagination";
import { DataTable, type DataTableColumn } from "@/components/ui/data-table";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Checkbox } from "@/components/ui/checkbox";
import { Progress } from "@/components/ui/progress";
import { Card, CardContent, CardHeader } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { PlantFilter } from "@/components/PlantFilter";
import { SingleDateFilter } from "@/components/SingleDateFilter";
import {
  Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle,
} from "@/components/ui/dialog";
import { useToast } from "@/hooks/use-toast";
import { apiRequest, queryClient } from "@/lib/queryClient";
import { scanOrQueue } from "@/lib/offlineQueue";
import { hasPageWriteAccess } from "@/lib/permissions";
import ProductMasterMissingDialog from "@/components/modals/ProductMasterMissingDialog";
import { matchProductMasterMissingError, matchBarcodeNotInSystemError, matchExtraNotAllowedError, parseApiErrorMessage } from "@/lib/apiError";
import { SectionSkeleton } from "@/components/ui/loading-skeletons";

// Kiosk rotation — same idea and CSS mechanics as Order Scan's and Unloading's own rotate views
// (.kiosk-rotate-* in index.css): for a screen physically mounted at an angle next to the
// loading bay. Steps 0° → 90° → 180° → 270° → 0°, remembered per browser since a mounted screen
// stays in the same orientation.
const LOADING_ROTATIONS = [0, 90, 180, 270] as const;
type LoadingRotation = (typeof LOADING_ROTATIONS)[number];
const LOADING_ROTATION_STORAGE_KEY = "loadingRotation";

// STV (sub-transfer voucher) — picked once in the Create Operation dialog from the plant's own
// list (GET /api/order-scan/stvs, a generic plant-scoped lookup, not Order-Scan-specific), then
// frozen. Radix Select has no value for "nothing selected", hence this sentinel.
const NO_STV = "__none__";

// ─── Types (mirror server/routes/loading.ts responses) ───────────────────────
type ProformaSuggestion = {
  id: number; orderNumber: string; partyName: string; plant: string | null;
  orderDate: string | null; vehicleNumber: string | null;
};
// Sr. No. compare: same prefix letters, then the number by value (so C2 sorts before C10);
// items without one go last.
function compareSrNo(a: string | null | undefined, b: string | null | undefined): number {
  if (!a && !b) return 0;
  if (!a) return 1;
  if (!b) return -1;
  return a.localeCompare(b, undefined, { numeric: true, sensitivity: "base" });
}

// Small product picture beside an item name; renders nothing (no gap) when the product has none.
function ItemRowThumb({ name, className = "h-10 w-10" }: { name: string | null; className?: string }) {
  const [failed, setFailed] = useState(false);
  if (!name || failed) return null;
  return (
    <ProductPhoto
      name={name}
      zoomable
      onLoadState={setFailed}
      className={`${className} shrink-0 rounded border border-gray-200 bg-white object-contain`}
    />
  );
}

type ProformaItem = {
  id: number; barcode: string | null; itemName: string | null; sapCode: string | null;
  srNo: string | null; volumeInCuFt: string | null;
  quantity: number | null;
  // Progress fields, added by withProgress() server-side
  expected: number; loaded: number; remaining: number; itemsPerPallet: number;
  // The pallet size actually set in Product Master for this plant's state (GJ PLT / MP PLT),
  // 0 when nobody set one. itemsPerPallet falls back to the line quantity, so only this field
  // can answer "is a real pallet size set?".
  realPackSize?: number;
  isComplete: boolean; stockAvailable: number | null;
};
type ProformaSlip = {
  id: number; orderNumber: string; partyName: string; plant: string | null;
  orderDate: string | null; totalQuantity: number | null;
  // The order's OWN required cargo volume (Product Master's per-item volume, summed) — separate
  // from vehicleVolume (the linked vehicle's capacity, resolved live, never stored on the slip).
  totalVolume: string | null;
  vehicleNumber: string | null; driverName: string | null; rtoNumber: string | null;
  vehicleVolume: number | null;
  loadingCompletedAt: string | null; loadingCompletedByCode: string | null;
  vehicleAssignedByCode: string | null;
  // The order's real lifecycle stage from Notion's "Finny Status :" (this page also writes
  // LOADING/READY≈DESP into it) — DISPATCHED/DELIVERED/SHORTAGE/UNLOADING mean it has moved past
  // (or sideways from) loading, so the server refuses to start/scan/link a vehicle on it.
  notionStatus: string | null;
  // When Create Operation was first run for this order (loading_records.created_at, set by
  // withRto) — separate from orderDate, which is the slip's own order date. Null until started.
  loadDate: string | null;
  // Set server-side (see withRto in loading.ts) whenever vehicleInfoId already points at a
  // specific Vehicle Master row but nobody has confirmed it yet — the exact row to pre-select,
  // resolved by id rather than by re-matching vehicleNumber's text on the client.
  suggestedVehicle: VehicleSuggestion | null;
  // Shift handoff — who currently holds the right to scan (null on a slip from before this
  // feature existed, treated as unowned/open). loadingPausedAt set = blocked for everyone,
  // including the owner, until someone runs Claim.
  loadingOwnerCode: string | null; loadingOwnerName: string | null; loadingPausedAt: string | null;
  // Chosen once in the Create Operation dialog and frozen from then on — the scan view shows it
  // as locked text and the server stamps every scan event with it, ignoring anything the client
  // sends. Null only on slips started before this was required.
  loadingStv: string | null;
  // Who ran Create Operation for this order (server/routes/loading.ts's withRto) — used only to
  // decide whether the Complete button's creator-always-allowed rule applies to this user.
  createdByCode: string | null; createdByName: string | null;
};
type VehicleSuggestion = {
  id: number; vehicleNumber: string; rtoNumber: string | null; driver: string | null;
  company: string | null; manufacturer: string | null; volume: number | null;
  // Set only when the local Vehicle Master search found nothing and the server fell back to a
  // live Notion lookup (server/routes/loading.ts) — the row is already upserted into
  // vehicle_info by then, so it links exactly like any other suggestion; this just flags it as
  // freshly pulled in, for the "from Notion" tag in the dropdown.
  fromNotion?: boolean;
};
type LoadingRecord = {
  id: number; orderNumber: string; partyName: string | null; plant: string | null;
  vehicleNumber: string; rtoNumber: string | null; volume: string | null;
  createdByCode: string | null; createdByName: string | null;
  // createdAt is when THIS load record was created (vehicle linked / load started) — shown as
  // "Load Date", not the order's own date. orderDate is the proforma slip's real order date,
  // straight from the source order data — the two can be days apart.
  createdAt: string; orderDate: string | null;
  loadingCompletedAt: string | null;
  // Who completed the load (Complete button or the scan that finished it) — a name, or null.
  loadingCompletedByCode?: string | null; loadingCompletedByName?: string | null;
  loadingOwnerCode: string | null; loadingOwnerName: string | null; loadingPausedAt: string | null;
  // The STV this load was started on (see the Create Operation dialog) — shown in the list and
  // filterable there.
  loadingStv: string | null;
};
type ScanResponse = { slip: ProformaSlip; items: ProformaItem[]; allComplete: boolean; loadedVolume: number; event: { barcode: string; itemName: string; sapCode: string | null; totalQty: number; isExtra: boolean; remaining: number; productId: number | null } };
// One row of that order's own load-event history (the landing table's expand panel) — fetched
// from the same Scan History endpoint the Reports page's Load Event tab uses, scoped to this
// order (GET /api/scan-sessions/reports/scan-history?source=dispatch&order=X).
type LoadHistoryEvent = {
  id: number; barcode: string | null; itemName: string | null; totalQty: number;
  isExtra: boolean; voided: boolean | null; scannedByName: string | null; scannedAt: string;
  stv: string | null;
  // Written by the Items table's +/- buttons, not a scan — shown as "Loading Adjust".
  isAdjust?: boolean;
};
// One period of ownership in the full "who held this load, and how much they loaded" chain —
// see buildOwnerTimeline in server/routes/loading.ts. Display/reporting only, never used for
// access control.
type OwnerTimelineEntry = { code: string | null; name: string | null; from: string | null; to: string | null; loadedQty: number };
type LoadHandoffsResponse = {
  items: { id: number; fromUserCode: string | null; fromUserName: string | null; toUserCode: string | null; toUserName: string | null; pausedAt: string | null; claimedAt: string }[];
  timeline: OwnerTimelineEntry[];
};

// "First creator, how much they loaded, then new owner, how much they loaded" — the full
// ownership+contribution breakdown, oldest first. Shared between the scan view (a specific
// order that's open) and the landing list's expand-row scan-history panel (any order in the
// list) — same shape, same rendering, different place it's mounted.
function OwnerTimelineSummary({ timeline }: { timeline: OwnerTimelineEntry[] }) {
  if (timeline.length === 0) return null;
  const fmt = (d: string | null) =>
    d ? new Date(d).toLocaleString("en-IN", { timeZone: "Asia/Kolkata", day: "2-digit", month: "short", hour: "2-digit", minute: "2-digit" }) : "—";
  return (
    <Table>
      <TableHeader>
        <TableRow>
          <TableHead>Owner</TableHead>
          <TableHead className="text-right">Loaded Qty</TableHead>
          <TableHead>From</TableHead>
          <TableHead>To</TableHead>
        </TableRow>
      </TableHeader>
      <TableBody>
        {timeline.map((entry, idx) => (
          <TableRow key={idx}>
            <TableCell className="flex items-center gap-1.5">
              <UserCircle2 className="h-3.5 w-3.5 shrink-0 text-gray-400" />
              {entry.name ?? entry.code ?? "—"}
            </TableCell>
            <TableCell className="text-right">
              <Badge className="bg-blue-100 text-blue-800 hover:bg-blue-200">{entry.loadedQty}</Badge>
            </TableCell>
            <TableCell className="text-muted-foreground whitespace-nowrap">{fmt(entry.from)}</TableCell>
            <TableCell className="text-muted-foreground whitespace-nowrap">
              {entry.to ? fmt(entry.to) : <span className="font-medium text-emerald-600">current</span>}
            </TableCell>
          </TableRow>
        ))}
      </TableBody>
    </Table>
  );
}

// The Sort Slip side of the same order, if it has ever been sorted — who picked it and how much,
// same shape as the owner timeline above. See GET /sort-slips/by-order/:orderNumber/loader-history
// in server/routes/sort-slips.ts: gated on Loading OR Sort Slip access, so seeing this needs
// neither a separate Sort Slip grant nor exposes anything Loading doesn't already show the
// equivalent of for its own owners.
type SortLoaderEntry = { userCode: string | null; userName: string | null; from: string | null; to: string | null; pickedQty: number };
type SortLoaderHistoryResponse = {
  exists: boolean;
  status?: string;
  totalQty?: number;
  pickedQty?: number;
  timeline?: SortLoaderEntry[];
};

function SortLoaderTimelineSummary({ timeline }: { timeline: SortLoaderEntry[] }) {
  if (timeline.length === 0) return null;
  const fmt = (d: string | null) =>
    d ? new Date(d).toLocaleString("en-IN", { timeZone: "Asia/Kolkata", day: "2-digit", month: "short", hour: "2-digit", minute: "2-digit" }) : "—";
  return (
    <Table>
      <TableHeader>
        <TableRow>
          <TableHead>Loader</TableHead>
          <TableHead className="text-right">Picked Qty</TableHead>
          <TableHead>From</TableHead>
          <TableHead>To</TableHead>
        </TableRow>
      </TableHeader>
      <TableBody>
        {timeline.map((entry, idx) => (
          <TableRow key={idx}>
            <TableCell className="flex items-center gap-1.5">
              <UserCircle2 className="h-3.5 w-3.5 shrink-0 text-gray-400" />
              {entry.userName ?? entry.userCode ?? "—"}
            </TableCell>
            <TableCell className="text-right">
              <Badge className="bg-purple-100 text-purple-800 hover:bg-purple-200">{entry.pickedQty}</Badge>
            </TableCell>
            <TableCell className="text-muted-foreground whitespace-nowrap">{fmt(entry.from)}</TableCell>
            <TableCell className="text-muted-foreground whitespace-nowrap">
              {entry.to ? fmt(entry.to) : <span className="font-medium text-emerald-600">current</span>}
            </TableCell>
          </TableRow>
        ))}
      </TableBody>
    </Table>
  );
}

function currentUser(): any {
  try { return JSON.parse(localStorage.getItem("currentUser") || "{}"); } catch { return {}; }
}
// Same admin roles the server accepts (WRITE_ADMIN_ROLES in server/lib/pageAccess.ts), compared the
// same way — case-insensitive. Checking only the exact spellings "admin"/"super-admin" hid admin-only
// buttons (Reopen) from an admin whose role was saved as e.g. "Super Admin", while the server would
// have allowed the action.
const ADMIN_ROLES = ["admin", "super-admin", "superadmin", "super_admin", "super admin"];
function isAdminOrSuper(): boolean {
  const u = currentUser();
  return ADMIN_ROLES.includes(String(u.role ?? "").trim().toLowerCase());
}
// Mirrors the server's canCompleteLoad (server/routes/loading.ts) exactly, for a clean hide
// instead of a click-then-403 — real enforcement still happens server-side either way. Complete
// is restricted to whoever has a real stake in THIS load: its creator, its current owner, or
// admin/super-admin/Supervisor — needs the slip itself, not just the signed-in user.
function canCompleteLoadClient(slip: ProformaSlip | null): boolean {
  if (!slip) return false;
  if (isAdminOrSuper() || isSupervisor()) return true;
  const myCode = currentUser()?.userCode;
  if (!myCode) return false;
  return (!!slip.loadingOwnerCode && slip.loadingOwnerCode === myCode) || (!!slip.createdByCode && slip.createdByCode === myCode);
}
// Mirrors the server's isSupervisor (server/routes/loading.ts) — Supervisor gets the same
// ownership-bypass as admin here (open/view/scan/pause any load, change its STV, reopen it),
// but never delete/void/edit-quantity, which aren't gated on ownership or designation at all.
function isSupervisor(): boolean {
  const u = currentUser();
  return (u.designation ?? "").toLowerCase().trim() === "supervisor";
}

const normalize = (v?: string | number | null) => String(v ?? "").trim().toLowerCase();

// "Time taken" — wall-clock time from when the vehicle was linked (loading_records.createdAt)
// to when the load was marked complete. Same measure used on Order Management's and Unloading's
// own landing tables.
function formatDuration(startIso: string | null | undefined, endIso: string | null | undefined): string | null {
  if (!startIso || !endIso) return null;
  const ms = new Date(endIso).getTime() - new Date(startIso).getTime();
  if (!Number.isFinite(ms) || ms < 0) return null;
  const totalMinutes = Math.round(ms / 60000);
  const days = Math.floor(totalMinutes / 1440);
  const hours = Math.floor((totalMinutes % 1440) / 60);
  const minutes = totalMinutes % 60;
  if (days > 0) return `${days}d ${hours}h`;
  if (hours > 0) return `${hours}h ${minutes}m`;
  return `${minutes}m`;
}

function useDebounced<T>(value: T, delayMs: number): T {
  const [debounced, setDebounced] = useState(value);
  useEffect(() => {
    const t = setTimeout(() => setDebounced(value), delayMs);
    return () => clearTimeout(t);
  }, [value, delayMs]);
  return debounced;
}

// Remembers which order is currently open, per browser, so navigating away (another page,
// a refresh) and coming back to /loading resumes exactly where you left off instead of
// starting over at the search screen. Cleared only by an explicit "New" / reset.
const LAST_ORDER_KEY = "loading_active_order_number";

// Mirrors server/routes/loading.ts's isAlreadyLoading — Create Operation already flips
// notionStatus to "LOADING" the first time it runs for an order, so this same field doubles as
// "has someone already started this load." Checked here too so the preview dialog can warn and
// disable the button up front, instead of only failing after the click.
function isAlreadyLoading(notionStatus?: string | null): boolean {
  return String(notionStatus ?? "").trim().toUpperCase() === "LOADING";
}

// A LoadHistoryEvent's id is the combined-table offset id (3000000000 + loading_scan_events.id —
// see SCAN_HISTORY_COMBINED_SOURCE, server/routes/scan-sessions.ts). The void endpoint takes the
// real underlying id, same offset Scan History's own Load Event void uses.
const LOADING_EVENT_ID_OFFSET = 3000000000;

export default function LoadOperation() {
  const { toast } = useToast();
  // Mirrors the server's requireLoadingWrite (server/routes/loading.ts): a Supervisor gets
  // write access to Loading's own actions (scan/pause/claim/link-vehicle/STV/complete/reopen)
  // even without a separately-granted Write Access page permission — most Supervisor-designated
  // accounts have role "read" with no such grant, so without this every one of those buttons
  // would stay hidden despite the server now accepting the request.
  const canWrite = hasPageWriteAccess("loading") || isSupervisor();
  const admin = isAdminOrSuper();
  // Kept separate from `admin` — Supervisor gets the same ownership-bypass admin gets (open/
  // view/scan/pause/STV-change/reopen ANY load), but not everything `admin` implies elsewhere on
  // this page (e.g. canResetLoad below stays admin-only, mirroring the server's
  // requireLoadingVoidAccess, which never checks designation).
  const canBypassOwnership = admin || isSupervisor();
  // Mirrors the server's requireLoadingVoidAccess (server/routes/loading.ts): admin, or write
  // access to BOTH "loading" and "scan-history" — same rule individual Void uses, since Delete
  // is exactly that applied to every event on the order at once.
  const canResetLoad = admin || (hasPageWriteAccess("loading") && hasPageWriteAccess("scan-history"));

  // "list" is the landing view — records table, filters, AND the Camera/Manual order search box
  // (no separate "New Load" screen/button anymore; it's always right there). "create" is Stage
  // B(pre)/Stage B once an order's been found and confirmed. Always starts on "list": a persisted
  // mid-flow order (see LAST_ORDER_KEY) resumes automatically via the effect below, showing as
  // the "list" view's own pending-fetch skeleton in place of the table until it resolves, then
  // flips to "create" (see commitSlip) — no need to pre-guess the view up front anymore.
  const [view, setView] = useState<"list" | "create">("list");
  // The order search sits behind the "Load Operation" button rather than always occupying the top
  // of the landing page — the records table is what this page is usually opened for.
  const [searchOpen, setSearchOpen] = useState(false);
  function openOrderSearch() {
    setSearchOpen(true);
    setTimeout(() => orderInputRef.current?.focus(), 50);
  }
  function closeOrderSearch() {
    stopCamera();
    setScanMode("manual");
    setSearchOpen(false);
    setOrderSearch("");
    setOrderFocused(false);
    // Explicitly dismiss the on-screen keyboard here rather than leaving it to whatever comes
    // next (e.g. the vehicle-picker dialog's own autoFocus) — inputMode="none" on that next
    // input stops IT from opening the keyboard, but doesn't reliably force-close one that's
    // already open when focus just moves from this input to that one with no gap; blurring
    // here, before anything else takes focus, avoids the keyboard staying stuck up over the
    // next screen.
    if (document.activeElement instanceof HTMLElement) document.activeElement.blur();
  }

  // ─── Landing-view filters — same controls/layout Load Operations uses (search box, date +
  // plant filters, status count buttons, status tabs). Date/search/plant/tab are all sent to the
  // server (below) and applied in SQL before pagination — filtering only the one page of rows
  // already on screen is what made the date filter look broken (a matching row sitting on another
  // page just never got checked) and made the stat tiles never move (they summed the same
  // unfiltered page no matter what was picked). Excel-style column filters (recordColumnConditions)
  // stay client-side, over whichever page is currently loaded — a smaller, known limitation.
  // All persisted for the sitting (sessionStorage) — these narrow which loads you're looking at,
  // and rebuilding them after every hop to another page is pure friction.
  const [listSearch, setListSearch] = usePersistentFilter("loading:listSearch", "");
  const debouncedListSearch = useDebounced(listSearch, 300);
  // Stored as an ISO string, not a Date: JSON round-tripping a Date yields a string back, so
  // persisting the Date itself would silently hand the rest of this page a non-Date.
  // Defaults to today, not "all dates" — usePersistentFilter only ever applies this initial
  // value on a fresh session with nothing saved yet, so it never overwrites a date someone
  // already picked.
  const [selectedDateIso, setSelectedDateIso] = usePersistentFilter<string | null>("loading:listDate", new Date().toISOString());
  const selectedDate = selectedDateIso ? new Date(selectedDateIso) : null;
  const setSelectedDate = (d: Date | null) => setSelectedDateIso(d ? d.toISOString() : null);
  // This top calendar filter matches the proforma slip's own Order Date (ps.order_date), not
  // Load Date — send it as a plain "YYYY-MM-DD" in local time, never selectedDate.toISOString(),
  // which is a UTC moment and would
  // shift a day in any timezone ahead of or behind UTC.
  const selectedDateParam = selectedDate
    ? `${selectedDate.getFullYear()}-${String(selectedDate.getMonth() + 1).padStart(2, "0")}-${String(selectedDate.getDate()).padStart(2, "0")}`
    : "";
  const [selectedPlants, setSelectedPlants] = usePersistentFilter<string[]>("loading:listPlants", []);
  const [activeViewTab, setActiveViewTab] = usePersistentFilter("loading:listTab", "overall");
  // "My Slips" — one-click filter to just the slips the current user created (link-vehicle's own
  // created_by_code), applied server-side (see /api/loading/records) same as every other filter
  // here. Clicking it also switches the sort to newest-created-first, since that's the point of
  // the button — see each button's own onClick below.
  const [createdByMe, setCreatedByMe] = usePersistentFilter("loading:listCreatedByMe", false);
  const [sortBy, setSortBy] = usePersistentFilter<"orderNumber" | "creationDate">("loading:listSortBy", "orderNumber");
  const [sortOrder, setSortOrder] = usePersistentFilter<"asc" | "desc">("loading:listSortOrder", "asc");
  // Excel-style column filters for the landing list (see recordFilterColumns below).
  const [recordColumnConditions, setRecordColumnConditions] = usePersistentFilter<Record<string, FilterCondition>>("loading:columnFilters", {});

  // Server-paginated (20/page by default, matching Scan History) rather than fetching every
  // slip anyone's ever loaded in one request. Page size is user-selectable (same options/pattern
  // as Unloading's own "Show:" selector) — changing it resets back to page 1 since the old page
  // number wouldn't line up against a different page size.
  const RECORDS_PAGE_SIZE_OPTIONS = [10, 20, 50, 100];
  // Persisted (sessionStorage) like the filters below it — opening a slip and coming back to the
  // list later (a different page in the app, then back here) re-mounts this component, and a
  // plain useState(1) would silently throw away whatever page you were on. See the matching
  // "skip the very first run" guard below: without it, restoring this value is pointless, since
  // the reset effect would immediately stomp it back to 1 on that very same mount.
  const [recordsPage, setRecordsPage] = usePersistentFilter("loading:listPage", 1);
  const [recordsPageSize, setRecordsPageSize] = usePersistentFilter("loading:listPageSize", 20);
  const recordsOffset = (recordsPage - 1) * recordsPageSize;
  // Changing any filter can leave recordsPage pointing past the end of the now-smaller matching
  // set (or just land on a confusingly stale page) — same reasoning as the page-size reset above.
  // Guarded the same way Scan History's own page-reset effect is (see historyFilterSignature
  // there): a plain useEffect([...deps]) fires on MOUNT too, which would reset the page we just
  // restored from sessionStorage back to 1 every time this component remounts, even though
  // nothing actually changed. Comparing against a ref instead means only a REAL filter change
  // (not a remount) resets the page.
  const recordsFilterSignature = JSON.stringify([selectedDateParam, debouncedListSearch, selectedPlants.join(","), activeViewTab]);
  const lastRecordsFilterSignatureRef = useRef(recordsFilterSignature);
  useEffect(() => {
    if (recordsFilterSignature !== lastRecordsFilterSignatureRef.current) {
      lastRecordsFilterSignatureRef.current = recordsFilterSignature;
      setRecordsPage(1);
    }
  }, [recordsFilterSignature]);
  const recordsQuery = useQuery<{ records: LoadingRecord[]; total: number; slipsCount: number; loadingCount: number; readyDespCount: number }>({
    queryKey: ["/api/loading/records", recordsPage, recordsPageSize, selectedDateParam, debouncedListSearch, selectedPlants.join(","), activeViewTab, createdByMe],
    queryFn: async () => {
      const params = new URLSearchParams({ limit: String(recordsPageSize), offset: String(recordsOffset) });
      if (selectedDateParam) params.set("date", selectedDateParam);
      if (debouncedListSearch.trim()) params.set("search", debouncedListSearch.trim());
      if (selectedPlants.length > 0) params.set("plants", selectedPlants.join(","));
      if (activeViewTab !== "overall") params.set("tab", activeViewTab);
      if (createdByMe) params.set("createdBy", "me");
      return (await apiRequest("GET", `/api/loading/records?${params.toString()}`)).json();
    },
    enabled: view === "list",
  });
  const recordsTotal = recordsQuery.data?.total ?? 0;
  const recordsItems = recordsQuery.data?.records ?? [];
  const recordsHasMore = recordsOffset + recordsItems.length < recordsTotal;
  const slipsCount = recordsQuery.data?.slipsCount ?? 0;
  const inProgressCount = recordsQuery.data?.loadingCount ?? 0;
  const readyDespCount = recordsQuery.data?.readyDespCount ?? 0;

  // Plant options for PlantFilter, straight from Plant Management (same source PlantBadge reads),
  // so the filter's colors match the badges rendered in the rows.
  const { data: plantsData } = useQuery<Array<{ name: string; bgColor?: string; textColor?: string; borderColor?: string }>>({
    queryKey: ["/api/plants"],
    queryFn: () => apiRequest("GET", "/api/plants").then((r) => r.json()),
    staleTime: 60_000,
  });
  const plantOptions = (plantsData ?? []).map((p) => ({
    value: p.name, label: p.name, bgColor: p.bgColor, textColor: p.textColor, borderColor: p.borderColor,
  }));

  // "READY≈DESP" once loading is complete, "LOADING" while it's still in progress — the same two
  // Finny Status values this page pushes to Notion (server/services/notionOrderStatusSync.ts), so
  // the status shown here reads identically to Load Operations' own status column.
  const recordStatus = (r: LoadingRecord) => (r.loadingCompletedAt ? "READY≈DESP" : "LOADING");
  // Colors the status badge AND (on the mobile card list) a left accent strip by the same
  // three states — completed/paused/in-progress all looked identical purple before, which was
  // part of why the card list read as flat/plain.
  const recordStatusBadgeClass = (r: LoadingRecord) =>
    r.loadingCompletedAt
      ? "bg-emerald-100 text-emerald-800 hover:bg-emerald-200"
      : r.loadingPausedAt
      ? "bg-amber-100 text-amber-800 hover:bg-amber-200"
      : "bg-blue-100 text-blue-800 hover:bg-blue-200";
  const recordAccentBorderClass = (r: LoadingRecord) =>
    r.loadingCompletedAt ? "border-l-4 border-l-emerald-400" : r.loadingPausedAt ? "border-l-4 border-l-amber-400" : "border-l-4 border-l-blue-400";

  // Same filter engine and UI as Overall Stock / Scan History / Scan Viewer: a "+ Filter" button,
  // a filter icon on each column header, and removable chips. Options come from the records on
  // this page, so a checklist never offers a value that would filter everything away.
  const recordDistinct = (values: (string | null | undefined)[]): FilterOption[] =>
    Array.from(new Set(values.map((v) => (v ?? "").trim()).filter(Boolean))).sort((a, b) => a.localeCompare(b, undefined, { numeric: true, sensitivity: "base" })).map((v) => ({ value: v, label: v }));
  // Bucketed to a day exactly as the matcher buckets the cell (lib/columnFilters dayBucket).
  const recordDayOptions = (values: (string | null | undefined)[]) =>
    recordDistinct(values.map((v) => (v ? formatDay(new Date(v), "yyyy-MM-dd") : null)));
  const recordOwner = (r: LoadingRecord) => r.loadingOwnerName ?? r.loadingOwnerCode ?? "";
  const recordCompletedBy = (r: LoadingRecord) =>
    r.loadingCompletedAt ? (r.loadingCompletedByName ?? r.loadingCompletedByCode ?? "") : "";
  // Reopen: an admin/super-admin, Supervisor, or the load's current owner (server enforces the
  // same rule).
  const canReopenRecord = (r: LoadingRecord) =>
    !!r.loadingCompletedAt && (canBypassOwnership || (!!r.loadingOwnerCode && r.loadingOwnerCode === currentUser()?.userCode));
  const recordFilterColumns: FilterableColumn<LoadingRecord>[] = [
    { id: "orderNumber", label: "Order No.", filterType: "text", options: recordDistinct(recordsItems.map((r) => r.orderNumber)), accessor: (r) => r.orderNumber },
    { id: "orderDate", label: "Order Date", filterType: "date", options: recordDayOptions(recordsItems.map((r) => r.orderDate)), accessor: (r) => r.orderDate },
    { id: "loadDate", label: "Load Date", filterType: "date", options: recordDayOptions(recordsItems.map((r) => r.createdAt)), accessor: (r) => r.createdAt },
    { id: "party", label: "Party Name", filterType: "text", options: recordDistinct(recordsItems.map((r) => r.partyName)), accessor: (r) => r.partyName },
    { id: "plant", label: "Plant", filterType: "text", disableConditions: true, options: recordDistinct(recordsItems.map((r) => r.plant)), accessor: (r) => r.plant },
    { id: "vehicle", label: "Vehicle No.", filterType: "text", options: recordDistinct(recordsItems.map((r) => r.vehicleNumber)), accessor: (r) => r.vehicleNumber },
    { id: "stv", label: "Dispatch Directory", filterType: "text", disableConditions: true, options: recordDistinct(recordsItems.map((r) => r.loadingStv)), accessor: (r) => r.loadingStv },
    { id: "status", label: "Status", filterType: "text", disableConditions: true, options: recordDistinct(recordsItems.map((r) => recordStatus(r))), accessor: (r) => recordStatus(r) },
    { id: "owner", label: "Current Owner", filterType: "text", options: recordDistinct(recordsItems.map(recordOwner)), accessor: recordOwner },
    { id: "completedBy", label: "Completed By", filterType: "text", options: recordDistinct(recordsItems.map(recordCompletedBy)), accessor: recordCompletedBy },
    { id: "creator", label: "Creator", filterType: "text", options: recordDistinct(recordsItems.map((r) => r.createdByName)), accessor: (r) => r.createdByName },
  ];
  const recordConditionList = Object.values(recordColumnConditions);
  const setRecordCondition = (id: string, condition: FilterCondition) =>
    setRecordColumnConditions((prev) => ({ ...prev, [id]: condition }));
  const clearRecordCondition = (id: string) =>
    setRecordColumnConditions((prev) => { const next = { ...prev }; delete next[id]; return next; });
  const recordColumnHeader = (id: string, label: string) => {
    const column = recordFilterColumns.find((c) => c.id === id);
    if (!column) return label;
    return (
      <span className="inline-flex items-center gap-1">
        {label}
        <ColumnHeaderFilterButton
          column={column}
          condition={recordColumnConditions[id]}
          onChange={(c) => setRecordCondition(id, c)}
          onRemove={() => clearRecordCondition(id)}
        />
      </span>
    );
  };

  // Whether any filter narrowing the list is currently active — drives the empty-state message
  // below ("nothing loaded yet" vs "nothing matches"), now that recordsItems IS the already
  // server-filtered page rather than the raw unfiltered one.
  const listFiltersActive =
    !!selectedDateParam || !!debouncedListSearch.trim() || selectedPlants.length > 0 ||
    activeViewTab !== "overall" || recordConditionList.length > 0;

  // Date/search/plant/tab are already applied server-side (recordsQuery above) — only the
  // Excel-style column conditions and the display sort still run over the fetched page here.
  const filteredRecords = recordsItems
    .filter((r) => matchAllConditions(r, recordConditionList, recordFilterColumns))
    .sort((a, b) => {
      const dir = sortOrder === "asc" ? 1 : -1;
      if (sortBy === "orderNumber") {
        return dir * ((parseInt(a.orderNumber) || 0) - (parseInt(b.orderNumber) || 0));
      }
      return dir * (new Date(a.createdAt).getTime() - new Date(b.createdAt).getTime());
    });

  function refreshOwnerHistory(orderNumber: string | null | undefined) {
    if (!orderNumber) return;
    queryClient.invalidateQueries({ queryKey: ["/api/loading/proforma", orderNumber, "handoffs"] });
  }

  // Reopen (undo Complete) and Reset (the "Delete" action — undoes everything the order's
  // loading did: reverses stock, voids the scan history, un-assigns the vehicle, removes the
  // landing-table row). Both act on whichever order the confirm dialog is currently targeting.
  const reopenMutation = useMutation({
    mutationFn: async (orderNumber: string) => {
      const res = await apiRequest("POST", `/api/loading/proforma/${encodeURIComponent(orderNumber)}/reopen`, {});
      if (!res.ok) throw new Error((await res.json().catch(() => ({})))?.message || "Reopen failed");
      return res.json();
    },
    onSuccess: (_data, orderNumber) => {
      toast({ title: "Load reopened" });
      recordsQuery.refetch();
      refreshOwnerHistory(orderNumber);
    },
    onError: (err: any) => toast({ title: "Reopen failed", description: parseApiErrorMessage(err), variant: "destructive" }),
  });

  // Reopen and Claim used to fire straight from the button click — a confirmation dialog for
  // each, same Dialog/target pattern Reset already uses, so an accidental tap can't undo a
  // completed load or take ownership away from whoever currently has it.
  const [reopenTarget, setReopenTarget] = useState<string | null>(null);
  const [claimTarget, setClaimTarget] = useState<string | null>(null);

  const [resetTarget, setResetTarget] = useState<LoadingRecord | null>(null);
  // mode "void" keeps the scan entries (marked Voided); "remove" deletes them for good. Both return
  // the stock and put the slip back to its status from before Create Operation.
  const resetMutation = useMutation({
    mutationFn: async ({ orderNumber, mode }: { orderNumber: string; mode: "void" | "remove" }) => {
      const res = await apiRequest("POST", `/api/loading/proforma/${encodeURIComponent(orderNumber)}/reset`, { mode });
      if (!res.ok) throw new Error((await res.json().catch(() => ({})))?.message || "Delete failed");
      return res.json();
    },
    onSuccess: (data: any) => {
      toast({
        title: data?.mode === "remove" ? "Loading removed completely" : "Loading slip deleted",
        description: data?.mode === "remove"
          ? `Stock returned and all scan history deleted. Status back to ${data?.restoredStatus ?? "before loading"}.`
          : `${data?.reversedEvents ?? 0} scan(s) voided and stock returned. Status back to ${data?.restoredStatus ?? "before loading"}.`,
      });
      setResetTarget(null);
      recordsQuery.refetch();
    },
    onError: (err: any) => toast({ title: "Delete failed", description: parseApiErrorMessage(err), variant: "destructive" }),
  });

  // Void a single scan event — same action Scan History's Load Event tab offers, available here
  // too so a mistake can be corrected right from wherever it's noticed. Reverses just that one
  // event's stock (server/routes/loading.ts's POST /events/:id/void), unlike Delete above which
  // undoes the whole order.
  const [voidTarget, setVoidTarget] = useState<LoadHistoryEvent | null>(null);
  const [voidReason, setVoidReason] = useState("");
  const voidMutation = useMutation({
    mutationFn: async (payload: { id: number; reason: string }) => {
      const res = await apiRequest("POST", `/api/loading/events/${payload.id}/void`, { reason: payload.reason });
      if (!res.ok) throw new Error((await res.json().catch(() => ({})))?.message || "Void failed");
      return res.json();
    },
    onSuccess: () => {
      toast({ title: "Scan voided", description: "Excluded from totals and stock; kept in history." });
      refreshOwnerHistory(slip?.orderNumber);
      setVoidTarget(null);
      setVoidReason("");
      // Both history panels (landing table + this order's items table) read the same combined
      // endpoint under the same key prefix — one invalidation refreshes whichever is open.
      queryClient.invalidateQueries({ queryKey: ["/api/scan-sessions/reports/scan-history"] });
      // Voiding changes "loaded"/"remaining" — refresh the open order's own progress too.
      if (slip) openOrder(slip.orderNumber, { silent: true });
      // Voiding can drop an order below fully-loaded again — the server clears
      // loadingCompletedAt when that happens (see /loading/events/:id/void), so the landing
      // list's Complete/In Progress badge needs a refresh too, not just the open order's view.
      queryClient.invalidateQueries({ queryKey: ["/api/loading/records"] });
    },
    onError: (err: any) => toast({ title: "Void failed", description: parseApiErrorMessage(err), variant: "destructive" }),
  });

  // ─── Stage A: find a proforma slip ───────────────────────────────────────
  const [scanMode, setScanMode] = useState<"camera" | "manual">("manual");
  const [orderSearch, setOrderSearch] = useState("");
  const debouncedOrderSearch = useDebounced(orderSearch, 250);
  const [orderFocused, setOrderFocused] = useState(false);
  const [orderSuggIdx, setOrderSuggIdx] = useState(-1);
  const orderInputRef = useRef<HTMLInputElement>(null);

  const [slip, setSlip] = useState<ProformaSlip | null>(null);
  const [items, setItems] = useState<ProformaItem[]>([]);
  const [allComplete, setAllComplete] = useState(false);
  // Completing a load is confirmed first and announced afterwards, the same way Unloading does it.
  // A toast was too easy to miss on a busy scanning screen, and the +/- path showed nothing at all.
  const [confirmCompleteOpen, setConfirmCompleteOpen] = useState(false);
  const [completedInfo, setCompletedInfo] = useState<
    { orderNumber: string; partyName: string; vehicleNumber: string | null; loadedQty: number; expectedQty: number; auto: boolean } | null
  >(null);
  // Which order the popup has already been shown for — the "everything is loaded" state stays true
  // for every later scan/refresh on the same order, so without this it would reopen each time.
  const completeShownForRef = useRef<string | null>(null);
  function announceLoadComplete(nextSlip: ProformaSlip, nextItems: ProformaItem[], auto: boolean) {
    if (completeShownForRef.current === nextSlip.orderNumber) return;
    completeShownForRef.current = nextSlip.orderNumber;
    setCompletedInfo({
      orderNumber: nextSlip.orderNumber,
      partyName: nextSlip.partyName,
      vehicleNumber: nextSlip.vehicleNumber ?? null,
      loadedQty: nextItems.reduce((sum, i) => sum + (i.loaded ?? 0), 0),
      expectedQty: nextItems.reduce((sum, i) => sum + (i.expected ?? 0), 0),
      auto,
    });
  }
  // Volume actually scanned onto the vehicle so far (server-computed in withProgress(), server/
  // routes/loading.ts) — distinct from slip.totalVolume (the order's full planned volume) and
  // slip.vehicleVolume (the vehicle's capacity).
  const [loadedVolume, setLoadedVolume] = useState(0);
  // Total | Scanner | Owner History | Sort History — one shared tab, only one panel visible at
  // a time (merged from what used to be two independent toggles: totalsScanTab for the first
  // two, a separate historyTab for the last two — picking one used to leave the other group's
  // panel sitting open too). Defaults to "scanner", the main work surface; re-clicking the
  // active Owner/Sort History button falls back to "scanner" rather than to a "nothing open"
  // state, since Total/Scanner never had one either.
  const [activeTab, setActiveTab] = useState<"total" | "scanner" | "owner" | "sort">("scanner");
  // One compact visual system for every work-area tab: Total, Scanner and both history views.
  const workTabClass = (active: boolean) =>
    active
      ? "inline-flex items-center gap-1 rounded-full bg-[#001d6e] px-2.5 py-1 text-[11px] font-semibold text-white ring-1 ring-[#001d6e]/30"
      : "inline-flex items-center gap-1 rounded-full border border-gray-200 bg-white px-2.5 py-1 text-[11px] font-medium text-gray-600 hover:bg-gray-50";

  // "Items on this order" table — click a row to expand it and see that item's own scan history.
  // Fetched once for the whole order (same endpoint the Loading landing table's own expand panel
  // and Scan History's Load Event tab use) and filtered client-side per barcode when a row opens,
  // rather than one request per item.
  const [expandedItemBarcode, setExpandedItemBarcode] = useState<string | null>(null);
  // The Scan Items block opens and closes when its header is clicked.
  const [scannerOpen, setScannerOpen] = useState(true);
  // The Load Totals block (tiles and progress bar) opens and closes from its header.
  const [totalsOpen, setTotalsOpen] = useState(true);
  // The panel under the Total / Scanner / Owner History row opens and closes with the arrow on that row.
  const [panelsOpen, setPanelsOpen] = useState(true);
  // Same click-to-filter tiles as Order Scan's own Order Totals card (Total/Loaded/Remaining/
  // Extra) — narrows the items table below to just that bucket; clicking the active one clears it.
  const [itemStatusFilter, setItemStatusFilter] = useState<"" | "done" | "remaining" | "extra">("");
  const [itemSearchText, setItemSearchText] = useState("");

  // Kiosk rotate — a screen mounted at an angle next to the loading bay. See
  // LOADING_ROTATIONS above; mechanics match Unloading's own rotate view exactly.
  const [rotation, setRotation] = useState<LoadingRotation>(() => {
    const saved = Number(localStorage.getItem(LOADING_ROTATION_STORAGE_KEY));
    return (LOADING_ROTATIONS as readonly number[]).includes(saved) ? (saved as LoadingRotation) : 0;
  });
  useEffect(() => { localStorage.setItem(LOADING_ROTATION_STORAGE_KEY, String(rotation)); }, [rotation]);
  const rotateNext = () => setRotation((r) => LOADING_ROTATIONS[(LOADING_ROTATIONS.indexOf(r) + 1) % LOADING_ROTATIONS.length]);
  // Rotated kiosk mode is a fixed, full-viewport overlay, so it sits on top of Layout's own
  // sidebar toggle — this floating button (same trick as the rotate button itself: fixed inside
  // the rotated container, so it turns with the content) reopens a path back to real
  // navigation. Same pattern Unloading's own rotate view already uses.
  const { setKioskRotateClass: setSidebarKioskRotateClass, setPortalRotation } = useSidebarContext();
  const rotated = rotation !== 0;
  const kioskRotateClass = rotated ? `kiosk-rotate-${rotation}` : "";
  const quarterTurn = rotation === 90 || rotation === 270;
  // Natural portrait (a tablet turned upright) gets the same single-column layout as a manual
  // rotate, just without the 90° CSS turn — same pair Order Scan/Unloading use.
  const [isPortrait, setIsPortrait] = useState(
    () => typeof window !== "undefined" && window.matchMedia("(orientation: portrait)").matches,
  );
  useEffect(() => {
    const mq = window.matchMedia("(orientation: portrait)");
    const onChange = () => setIsPortrait(mq.matches);
    mq.addEventListener("change", onChange);
    return () => mq.removeEventListener("change", onChange);
  }, []);
  // Drives the single-column layout; the 90° CSS turn stays tied to `rotated` alone. Tailwind's
  // lg: breakpoints key off the real (unrotated) window width, not the rotated container's
  // effective width, so a rotated kiosk would otherwise get the desktop grid crammed narrow.
  const bigView = rotated || isPortrait;
  // Bounded, self-scrolling frame for the items table in rotated mode — the %-of-viewport cap
  // flips units on a quarter turn, since that turns the subtree 90° (content-space height then
  // runs along the viewport's WIDTH, not its height).
  // Item cards (two per row) replace the items table on tablets: from sm up in natural portrait
  // (an upright tablet is bigView here, at any width), and sm..xl in landscape where xl+ is
  // desktop. A manually rotated kiosk keeps the table.
  const itemCardsShow = isPortrait ? "sm:block" : "sm:max-xl:block";
  const itemTableHide = isPortrait ? "sm:hidden" : "sm:max-xl:hidden";
  const kioskTableMaxHeight = bigView ? (quarterTurn ? "62vw" : "62vh") : "65vh";
  // With an order open, the summary is fixed and the items grid owns the remaining viewport.
  // This keeps a long item list from scrolling the summary out of view.
  const openSlipTableMaxHeight = bigView ? kioskTableMaxHeight : "calc(100vh - 25rem)";
  // Reports this page's rotation to Layout so every popup it opens — dialogs, dropdowns, filter
  // popovers, calendars — turns to match (see lib/portalRotation). Reset on unmount so the next
  // page doesn't inherit a stale turn.
  useEffect(() => {
    setPortalRotation(rotated ? rotation : 0);
    return () => setPortalRotation(0);
  }, [rotated, rotation, setPortalRotation]);
  // The vehicle search/assign UI is collapsed behind a button now instead of always sitting
  // open under the header — the current vehicle is already shown right there in the header's
  // own slip-details line, so it doesn't need its own separate always-visible banner + search
  // box below it as well.
  const [vehiclePanelOpen, setVehiclePanelOpen] = useState(false);

  const orderLoadHistoryQuery = useQuery<{ items: LoadHistoryEvent[] }>({
    queryKey: ["/api/scan-sessions/reports/scan-history", "item-panel", slip?.orderNumber],
    queryFn: async () =>
      (await apiRequest(
        "GET",
        `/api/scan-sessions/reports/scan-history?source=dispatch&order=${encodeURIComponent(slip?.orderNumber ?? "")}&limit=200`,
      )).json(),
    enabled: !!slip,
  });

  // Shift-handoff history — empty for a load that's never actually changed hands. `timeline` is
  // the same data reshaped into the full ordered chain of every user who's held this load, each
  // with how much they personally loaded (for display only — access control never reads this,
  // only the slip's own current owner).
  const loadHandoffsQuery = useQuery<LoadHandoffsResponse>({
    queryKey: ["/api/loading/proforma", slip?.orderNumber, "handoffs"],
    queryFn: async () =>
      (await apiRequest("GET", `/api/loading/proforma/${encodeURIComponent(slip?.orderNumber ?? "")}/handoffs`)).json(),
    enabled: !!slip,
    // Also picks up changes made by someone else on another screen.
    refetchInterval: 15000,
  });

  // The Sort Slip side of this same order, if any — most orders are loaded without ever being
  // sorted, so `exists: false` is the common case, not an error (see the endpoint's own comment).
  const sortLoaderHistoryQuery = useQuery<SortLoaderHistoryResponse>({
    queryKey: ["/api/sort-slips/by-order", slip?.orderNumber, "loader-history"],
    queryFn: async () =>
      (await apiRequest("GET", `/api/sort-slips/by-order/${encodeURIComponent(slip?.orderNumber ?? "")}/loader-history`)).json(),
    enabled: !!slip,
    refetchInterval: 15000,
  });

  const orderSuggestionsQuery = useQuery<{ results: ProformaSuggestion[] }>({
    queryKey: ["/api/loading/proforma/search", debouncedOrderSearch],
    queryFn: async () => (await apiRequest("GET", `/api/loading/proforma/search?q=${encodeURIComponent(debouncedOrderSearch)}`)).json(),
    enabled: debouncedOrderSearch.trim().length >= 2 && !slip,
  });
  const orderSuggestions = orderSuggestionsQuery.data?.results ?? [];

  // Whether the in-flight lookup is a silent resume (page load restoring the last-open order)
  // rather than something the user just did — read inside the mutation's onSuccess/onError,
  // since mutate() itself doesn't pass arbitrary context through to those.
  const silentLookupRef = useRef(false);

  // Set when a lookup came from clicking a row on the landing list (openOrderFromList) — lets
  // the mutation's onError snap the view back to "list" instead of leaving the user stranded on
  // a blank "create" screen when the server refuses to open a load they don't own (see
  // checkLoadViewAccess on the server: another user's non-paused load can't be opened).
  const openedFromListRef = useRef(false);

  // A freshly-looked-up slip waiting on the "Create Load Operation from Proforma" confirmation
  // dialog — same intermediate step Load Operations puts between finding a slip and actually
  // starting work on it. Only the user-driven search/scan path goes through it (confirmRef);
  // resuming a remembered order or opening one from the landing list skips straight in.
  // sortSlipRequired/sortSlipExists: the plant's "require Sort Slip first" setting and whether
  // this order already has one — sortSlipExists is always true when the plant doesn't require it.
  type SlipLookup = {
    slip: ProformaSlip; items: ProformaItem[]; allComplete: boolean; loadedVolume: number;
    sortSlipRequired?: boolean; sortSlipExists?: boolean;
  };
  const confirmRef = useRef(false);
  const [pendingSlip, setPendingSlip] = useState<SlipLookup | null>(null);
  // The STV chosen in the Create Operation dialog. Deliberately NOT pre-filled from the
  // remembered localStorage pick — this is a write-once decision stamped into an audit field, so
  // it has to be an explicit choice each time rather than something inherited from a prior load.
  const [pendingStv, setPendingStv] = useState<string>("");

  function commitSlip(data: SlipLookup) {
    if (completeShownForRef.current !== data.slip.orderNumber) completeShownForRef.current = null;
    if (slip?.orderNumber !== data.slip.orderNumber) itemScanSeqRef.current = { seq: 0, byId: new Map() };
    setSlip(data.slip);
    setItems(data.items);
    setAllComplete(data.allComplete);
    setLoadedVolume(data.loadedVolume);
    setOrderFocused(false);
    setPendingSlip(null);
    // Always moves to "create" — the Camera/Manual search box now lives on the "list" view
    // itself (no more separate "New Load" screen/button), so this is what actually switches to
    // Stage B(pre)/Stage B once an order's been found and confirmed, regardless of whether the
    // search happened from there or a list row was clicked.
    setView("create");
    localStorage.setItem(LAST_ORDER_KEY, data.slip.orderNumber);
  }

  // Live stock refresh — while this order is open, ANY page (another Loading session on the
  // same order, Unloading, Order Scan, a manual admin adjust) can change this barcode's stock at
  // any moment. Without this, the operator keeps seeing whatever "current stock" figures were
  // true at the moment the order was opened (or last scanned), not the live truth, until their
  // own next scan happens to pull a fresh copy. Silent — no toast, doesn't touch the pending/
  // search state — just keeps slip/items in step with the server every few seconds, the same way
  // the server's own /scan response already refreshes them after this page's OWN scans.
  useEffect(() => {
    if (view !== "create" || !slip) return;
    const orderNumber = slip.orderNumber;
    const id = setInterval(async () => {
      try {
        const res = await apiRequest("GET", `/api/loading/proforma/${encodeURIComponent(orderNumber)}`);
        if (!res.ok) return;
        const data = (await res.json()) as SlipLookup;
        setSlip(data.slip);
        setItems(data.items);
        setAllComplete(data.allComplete);
        setLoadedVolume(data.loadedVolume);
      } catch {
        // Best-effort — a transient network hiccup just waits for the next tick.
      }
    }, 15000);
    return () => clearInterval(id);
  }, [view, slip?.orderNumber]);

  const fetchSlipMutation = useMutation({
    mutationFn: async (orderNumber: string) => {
      const res = await apiRequest("GET", `/api/loading/proforma/${encodeURIComponent(orderNumber)}`);
      return res.json() as Promise<SlipLookup>;
    },
    onSuccess: (data) => {
      if (confirmRef.current) {
        confirmRef.current = false;
        silentLookupRef.current = false;
        // A load operation already exists for this slip in our system (loadDate is set only by
        // Create Operation) — open that load instead of offering to create it a second time. The
        // Create dialog is only for a slip that has never been started here.
        if (data.slip.loadDate) {
          closeOrderSearch();
          commitSlip(data);
          toast({
            title: "Load operation already exists",
            description: `#${data.slip.orderNumber} was already created — opened the existing load.`,
          });
          return;
        }
        // Plant Management's "require Sort Slip first" — refused before the Create Operation
        // dialog ever opens, not as a warning banner inside it. Opening a whole vehicle/STV/items
        // dialog just to tell the operator "no, go create a Sort Slip first" was the wrong shape
        // for this: it looked like Create Operation was in progress when it never could succeed.
        if (data.sortSlipRequired && !data.sortSlipExists) {
          toast({
            title: "Sort Slip required first",
            description: `This plant requires a Sort Slip before Create Operation. Create one for order ${data.slip.orderNumber} on the Sort Slip page first.`,
            variant: "destructive",
          });
          return;
        }
        // Hold it in the dialog — nothing is opened until "Create Operation" is clicked.
        // closeOrderSearch() first: this branch used to leave the search dialog's own `open`
        // state untouched while ALSO opening the pendingSlip dialog on top of it, so the
        // search input never blurred — its keyboard stayed stuck open (and technically two
        // Dialogs were mounted open at once) straight through into this next screen.
        closeOrderSearch();
        setPendingSlip(data);
        return;
      }
      commitSlip(data); // also sets view to "create"
      openedFromListRef.current = false;
      if (!silentLookupRef.current) toast({ title: "Order found", description: `${data.slip.orderNumber} — ${data.slip.partyName}` });
      silentLookupRef.current = false;
    },
    onError: (err: any) => {
      if (silentLookupRef.current) {
        // The remembered order no longer resolves (deleted, etc.) — forget it and fall back
        // to the landing list instead of leaving an empty "create" search screen stuck up.
        localStorage.removeItem(LAST_ORDER_KEY);
        silentLookupRef.current = false;
        setView("list");
        return;
      }
      if (openedFromListRef.current) {
        // Server refused to open it (someone else owns it, not paused) — stay on the list
        // rather than landing on a blank "create" screen with nothing to show.
        openedFromListRef.current = false;
        setView("list");
      }
      confirmRef.current = false;
      toast({ title: "Could not open order", description: parseApiErrorMessage(err), variant: "destructive" });
    },
  });

  // "Create Operation" — the point the load actually starts, and the only thing that flips the
  // slip to LOADING (locally and in Notion). Looking a slip up, previewing it, or cancelling out
  // of the dialog all leave its status untouched.
  const startLoadMutation = useMutation({
    mutationFn: async ({ orderNumber, stv }: { orderNumber: string; stv: string }) => {
      const res = await apiRequest("POST", `/api/loading/proforma/${encodeURIComponent(orderNumber)}/start`, { stv });
      if (!res.ok) throw new Error((await res.json().catch(() => ({})))?.message || "Failed to start load");
      return res.json() as Promise<SlipLookup>;
    },
    onSuccess: (data) => {
      commitSlip(data);
      setPendingStv("");
      // Straight into the new load's own view — Back still returns to the landing list. Without
      // this, starting a load from the list left the user sitting on the list they started from.
      setView("create");
      // The server re-checks the vehicle's capacity too; if it is short, say so again here — the
      // dialog that warned about it has just closed.
      const capacityWarning = (data as any)?.capacityWarning as string | null | undefined;
      toast({
        title: capacityWarning ? "Load created — over capacity" : "Load operation created",
        description: capacityWarning
          ? `${data.slip.orderNumber} — ${capacityWarning}`
          : `${data.slip.orderNumber} — ${data.slip.partyName}`,
        variant: capacityWarning ? "destructive" : undefined,
      });
      queryClient.invalidateQueries({ queryKey: ["/api/loading/records"] });
    },
    onError: (err: any) => toast({ title: "Could not start load", description: parseApiErrorMessage(err), variant: "destructive" }),
  });

  // Every slip the current user owns that's still LOADING — the tab strip lets them switch
  // straight to one without going back to the list first. Only matters while an order is open
  // (and only once there's more than one to switch between — a single tab buys nothing), and
  // polls on the same 15s cadence the open order's own live-stock refresh already uses.
  const activeSlipsQuery = useQuery<{ slips: Array<{ orderNumber: string; vehicleNumber: string | null; partyName: string | null; plant: string | null }> }>({
    queryKey: ["/api/loading/my-active-slips"],
    queryFn: async () => (await apiRequest("GET", "/api/loading/my-active-slips")).json(),
    enabled: view === "create" && !!slip,
    refetchInterval: view === "create" ? 15_000 : false,
  });
  const activeSlips = activeSlipsQuery.data?.slips ?? [];

  function openOrder(orderNumber: string, opts?: { silent?: boolean; confirm?: boolean }) {
    if (!orderNumber.trim()) return;
    silentLookupRef.current = !!opts?.silent;
    confirmRef.current = !!opts?.confirm;
    fetchSlipMutation.mutate(orderNumber.trim());
  }

  useEffect(() => {
    if (admin) return; // admin never auto-resumes a remembered order — always starts on the list
    const saved = localStorage.getItem(LAST_ORDER_KEY);
    if (saved) openOrder(saved, { silent: true });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  function resetToSearch() {
    setSlip(null);
    setPendingSlip(null);
    setItems([]);
    setAllComplete(false);
    setLoadedVolume(0);
    setOrderSearch("");
    setVehicleSearch("");
    setSelectedVehicle(null);
    setExpandedItemBarcode(null);
    localStorage.removeItem(LAST_ORDER_KEY);
    // The Camera/Manual search box lives on the "list" view now (no more separate "New Load"
    // screen) — every caller of this (Stage B(pre)'s Cancel, "Back to List", etc.) means "let me
    // search for a different order", which is the list view itself.
    setView("list");
    setTimeout(() => orderInputRef.current?.focus(), 50);
  }

  // Loaded / expected / still-short for this order, used by the confirm + complete dialogs.
  const completeTotals = items.reduce(
    (acc, i) => ({
      expected: acc.expected + (i.expected ?? 0),
      loaded: acc.loaded + (i.loaded ?? 0),
      remaining: acc.remaining + (i.remaining ?? 0),
    }),
    { expected: 0, loaded: 0, remaining: 0 },
  );

  function backToList() {
    resetToSearch();
    setSearchOpen(false);
    recordsQuery.refetch();
  }

  function openOrderFromList(orderNumber: string) {
    openedFromListRef.current = true;
    openOrder(orderNumber);
  }

  // ─── Order-search camera scan — Camera/Manual toggle, same pattern as Scan Order ─────────
  const [cameraReady, setCameraReady] = useState(false);
  const [cameraError, setCameraError] = useState<string | null>(null);
  const videoRef = useRef<HTMLVideoElement>(null);
  const scannerRef = useRef<BarcodeScanner | null>(null);

  function stopCamera() {
    scannerRef.current?.stop();
    setCameraReady(false);
  }

  // Depends on whether an order is open, not on its data — the whole slip object is replaced on
  // every refresh, and depending on it restarted the camera each time.
  useEffect(() => {
    if (view !== "list" || scanMode !== "camera" || slip) { stopCamera(); return; }
    let cancelled = false;
    const scanner = new BarcodeScanner({
      onDetected: (result: Result) => {
        const code = result.getText().trim();
        if (code && !cancelled) { setOrderSearch(code); openOrder(code, { confirm: true }); }
      },
      onError: (err: Error) => { if (!cancelled) { setCameraError(err.message); setScanMode("manual"); } },
    });
    scannerRef.current = scanner;
    (async () => {
      const videoEl = videoRef.current;
      if (!videoEl) return;
      setCameraError(null);
      setCameraReady(false);
      try {
        await scanner.initialize();
        if (!cancelled) { await scanner.start(videoEl); if (!cancelled) setCameraReady(true); }
      } catch (err: any) {
        if (!cancelled) { setCameraError(err?.message ?? "Camera failed"); setScanMode("manual"); }
      }
    })();
    return () => { cancelled = true; scanner.stop(); };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [view, scanMode, !!slip]);

  // Barcode gun for finding an order — now active on the landing list too, not just once you've
  // already clicked into the "create"/search screen. A gun scan is just a burst of very fast
  // keystrokes (rapid enough that a human typing normally can't produce the same gaps), so this
  // only has to tell that burst apart from someone deliberately typing into a real field — it
  // never needs to know or care which screen happens to be showing:
  //   - Landing on the list (view === "list", no order open yet)? Straight to this listener.
  //   - Already have an order open (`slip` set)? This steps aside — the item-barcode listener
  //     below takes over instead, so a scan there adds/removes stock, not a second order lookup.
  //   - Focus is inside any real input/textarea (including the landing list's own search box,
  //     or the create screen's order box) — this listener explicitly skips those keystrokes, so
  //     manually typing/searching there behaves exactly as before: it just filters/searches,
  //     and picking an order is still a deliberate click or Enter press, never auto-triggered.
  // The dialog this opens (pendingSlip's confirm modal) is a plain state-driven Dialog, not tied
  // to `view` at all, so it pops up correctly over the list exactly like it already does over
  // the create screen's own search UI.
  useEffect(() => {
    if (view !== "list" || slip) return;
    // Barcode gun timing. A gun types a code much faster than a person, but wireless/Bluetooth guns
    // and busy tablets space characters out more than a wired gun on a fast PC — at the old 50 ms
    // limit, a slower burst was cut in half and read as a wrong or partial code. Most guns also end
    // with Enter or Tab, which now finishes the scan straight away instead of waiting for silence.
    const MAX_GAP_MS = 100;
    const BURST_END_MS = 120;
    let buffer = "";
    let lastAt = 0;
    let flushTimer: ReturnType<typeof setTimeout> | null = null;
    const finish = () => {
      if (buffer.length >= 3) {
        // A gun scan on the landing list opens the order search itself and shows what was
        // scanned, so the user sees where the lookup came from instead of a dialog appearing
        // over an apparently untouched page. (This listener only runs on the list — the create
        // screen has its own item-barcode listener.)
        setSearchOpen(true);
        setScanMode("manual");
        setOrderSearch(buffer);
        openOrder(buffer, { confirm: true });
      }
      buffer = "";
    };
    const handleKeyDown = (e: KeyboardEvent) => {
      const target = e.target as HTMLElement | null;
      if (target === orderInputRef.current) return;
      if (target && (target.tagName === "INPUT" || target.tagName === "TEXTAREA" || target.isContentEditable)) return;
      if (e.ctrlKey || e.metaKey || e.altKey) return;
      if ((e.key === "Enter" || e.key === "Tab") && buffer.length >= 3) {
        e.preventDefault();
        if (flushTimer) clearTimeout(flushTimer);
        finish();
        return;
      }
      if (e.key.length !== 1) return;
      const now = Date.now();
      if (now - lastAt > MAX_GAP_MS) buffer = "";
      lastAt = now;
      buffer += e.key;
      if (flushTimer) clearTimeout(flushTimer);
      flushTimer = setTimeout(finish, BURST_END_MS);
    };
    window.addEventListener("keydown", handleKeyDown, true);
    return () => { window.removeEventListener("keydown", handleKeyDown, true); if (flushTimer) clearTimeout(flushTimer); };
    // Only whether an order is open matters here. Depending on the whole slip object re-attached
    // this listener on every data refresh, dropping any barcode that was arriving at that moment.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [view, !!slip]);

  useEffect(() => { if (view === "list" && !slip && scanMode === "manual") orderInputRef.current?.focus(); }, [view, slip, scanMode]);

  // ─── Vehicle search + link ────────────────────────────────────────────────
  const [vehicleSearch, setVehicleSearch] = useState("");
  const debouncedVehicleSearch = useDebounced(vehicleSearch, 250);
  const [vehicleFocused, setVehicleFocused] = useState(false);
  const [vehicleSuggIdx, setVehicleSuggIdx] = useState(-1);
  const [selectedVehicle, setSelectedVehicle] = useState<VehicleSuggestion | null>(null);

  // The slip the vehicle picker acts on: the one open in the scanning view, or — before the load
  // has been started — the one being previewed in the Create-Operation dialog, so a vehicle can be
  // linked or changed from there too.
  const vehicleTargetSlip = slip ?? pendingSlip?.slip ?? null;
  // True when the previewed order was already started elsewhere — the server refuses a second
  // Create Operation for it too; this just lets the dialog warn and disable the button up front.
  const pendingSlipAlreadyLoading = isAlreadyLoading(pendingSlip?.slip?.notionStatus);
  // Does the order even fit on the vehicle it is going out on? The order's own required volume
  // (Product Master's per-item volume, summed at import) against the vehicle's capacity from
  // Vehicle Master. Checked HERE, at Create Operation, rather than only once scanning has begun
  // — that is the moment the vehicle can still be swapped for a bigger one at no cost.
  const pendingOrderVolume = parseFloat(pendingSlip?.slip?.totalVolume ?? "");
  const pendingVehicleVolume = pendingSlip?.slip?.vehicleVolume ?? null;
  const pendingOverCapacity =
    Number.isFinite(pendingOrderVolume) && pendingVehicleVolume != null && pendingOrderVolume > pendingVehicleVolume;
  // Over capacity doesn't block the load outright (a part-load onto a smaller vehicle is a real
  // thing to do) — it has to be ticked deliberately, so nobody starts one by habit.
  const [capacityAck, setCapacityAck] = useState(false);
  // Plant Management's "require Sort Slip first" setting — blocks Create Operation outright
  // (unlike the capacity warning above, there's no "carry on anyway" for this one; the server
  // refuses it the same way if this is bypassed somehow). sortSlipExists defaults true so a
  // plant with the setting off (the common case) never shows this warning.
  const pendingMissingSortSlip = !!pendingSlip?.sortSlipRequired && !pendingSlip?.sortSlipExists;

  const vehicleSuggestionsQuery = useQuery<{ results: VehicleSuggestion[] }>({
    queryKey: ["/api/loading/vehicles/search", debouncedVehicleSearch],
    queryFn: async () => (await apiRequest("GET", `/api/loading/vehicles/search?q=${encodeURIComponent(debouncedVehicleSearch)}`)).json(),
    enabled: !!vehicleTargetSlip && debouncedVehicleSearch.trim().length >= 1,
  });
  const vehicleSuggestions = vehicleSuggestionsQuery.data?.results ?? [];

  const linkVehicleMutation = useMutation({
    // Sends the picked row's id, not just its number — Vehicle Master no longer guarantees a
    // vehicle number is unique (two Notion pages can share one), so the id is what makes sure
    // the server links the EXACT row shown/picked in the dropdown, not just "some" vehicle with
    // a matching number.
    mutationFn: async (vehicle: VehicleSuggestion) => {
      const res = await apiRequest("POST", `/api/loading/proforma/${encodeURIComponent(vehicleTargetSlip!.orderNumber)}/link-vehicle`, {
        vehicleId: vehicle.id, vehicleNumber: vehicle.vehicleNumber,
      });
      return res.json() as Promise<{ slip: ProformaSlip; vehicle: VehicleSuggestion; capacityWarning: string | null }>;
    },
    onSuccess: (data) => {
      // Update whichever slip the picker was acting on — the open one, or the one still sitting
      // in the Create-Operation dialog.
      if (slip) setSlip(data.slip);
      else setPendingSlip((cur) => (cur ? { ...cur, slip: data.slip } : cur));
      setSelectedVehicle(null);
      setVehicleSearch("");
      setVehiclePanelOpen(false);
      if (data.capacityWarning) {
        toast({ title: "Vehicle linked — over capacity", description: data.capacityWarning, variant: "destructive" });
      } else {
        toast({ title: "Vehicle linked", description: `${data.vehicle.vehicleNumber} — RTO ${data.vehicle.rtoNumber ?? "—"}` });
      }
      queryClient.invalidateQueries({ queryKey: ["/api/loading/records"] });
    },
    onError: (err: any) => toast({ title: "Link failed", description: parseApiErrorMessage(err), variant: "destructive" }),
  });

  function pickVehicle(v: VehicleSuggestion) {
    setSelectedVehicle(v);
    setVehicleSearch(v.vehicleNumber);
    setVehicleFocused(false);
    setVehicleSuggIdx(-1);
  }

  // A slip can already carry a vehicleNumber straight from Notion (server/services/
  // proformaNotionSync.ts reads it off the dispatch DB's "Vehi No:" column) before anyone has
  // confirmed it through this page — vehicleAssignedByCode stays null until they do. Rather than
  // making the user re-type/re-search a vehicle number that's already sitting on the order,
  // pre-select it as soon as the slip opens, same as if the user had searched and clicked it
  // themselves — they still have to press "Link" to actually confirm it, and can clear the box
  // and search a different vehicle instead if the Notion value is wrong.
  //
  // suggestedVehicle (see withRto in loading.ts) is the server's own resolution of Notion's raw
  // text down to a specific Vehicle Master row's id — done there once at sync time, not here, so
  // this just picks it directly instead of re-deriving it from vehicleNumber text on every page
  // load. Only falls back to a client-side text search when the server couldn't resolve any row
  // at all (suggestedVehicle null) — same as a genuinely unmatched vehicle today. Runs against
  // vehicleTargetSlip so this pre-fill also happens for the slip sitting in the Create-Operation
  // dialog, not just the one already open in the scanning view.
  useEffect(() => {
    const target = vehicleTargetSlip;
    if (!target || !target.vehicleNumber || target.vehicleAssignedByCode) return;
    if (vehicleSearch) return; // don't clobber an in-progress manual search/selection
    if (target.suggestedVehicle) { pickVehicle(target.suggestedVehicle); return; }
    let cancelled = false;
    (async () => {
      try {
        const res = await apiRequest("GET", `/api/loading/vehicles/search?q=${encodeURIComponent(target.vehicleNumber!)}`);
        const data = (await res.json()) as { results: VehicleSuggestion[] };
        if (cancelled) return;
        const exact = data.results.find((v) => v.vehicleNumber.toLowerCase() === target.vehicleNumber!.toLowerCase());
        if (exact) pickVehicle(exact);
        else setVehicleSearch(target.vehicleNumber!); // show it even if Vehicle Master has no match to confirm against
      } catch {
        // Silent — user can still search manually.
      }
    })();
    return () => { cancelled = true; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [vehicleTargetSlip?.orderNumber, vehicleTargetSlip?.vehicleNumber, vehicleTargetSlip?.vehicleAssignedByCode, vehicleTargetSlip?.suggestedVehicle]);

  // ─── Item scanning — same barcode-matching / pallet-loose / auto-scan rules as Order Scan ──
  // Auto Scan itself is Plant Management's existing per-plant toggle (plants.isAutoScanEnabled)
  // — the SAME flag Order Scan reads, not a separate Loading-only setting. Off (or the plant not
  // found) falls through to the always-confirm-with-a-dialog flow, exactly like Order Scan.
  const { data: allPlants } = useQuery<any[]>({
    queryKey: ["/api/plants"],
    queryFn: () => apiRequest("GET", "/api/plants").then((r) => r.json()),
    staleTime: 60000,
  });
  const autoScanEnabled = (() => {
    const plantName = (slip?.plant ?? "").toLowerCase();
    if (!plantName) return false;
    const p = (allPlants ?? []).find((pl: any) => String(pl.name ?? "").toLowerCase() === plantName);
    return p?.isAutoScanEnabled === true;
  })();

  // Pallet size is a per-STATE fact (products.gjPlt/mpPlt), not per-plant — a plant just knows
  // which state it's in (plants.state). Same pair Order Scan/Unloading use — itemsPerPallet
  // ("Packets" in the Product Master UI) is a different concept and is NOT an equivalent
  // fallback for the actual pallet size. Used by the Add Extra dialog, whose picked product has
  // no server-resolved item snapshot to fall back to the way a matched slip item does.
  const getPlantState = (plantName: string): string | null => {
    const name = (plantName ?? "").trim().toLowerCase();
    if (!name || !allPlants) return null;
    const match = allPlants.find((p: any) => String(p.name ?? "").trim().toLowerCase() === name);
    const state = match?.state;
    return state ? String(state).trim().toUpperCase() : null;
  };
  const getStatePalletSize = (product: Product | null, stateCode: string | null): number => {
    if (!product) return 0;
    if (stateCode === "GJ") return Number(product.gjPlt) || 0;
    if (stateCode === "MP") return Number(product.mpPlt) || 0;
    return 0;
  };
  function extraProductPalletSize(product: Product | null): number {
    const state = getPlantState(slip?.plant ?? "");
    return Math.max(1, getStatePalletSize(product, state) || 1);
  }
  // Mirrors server/storage.ts's getProductByBarcode exactly — products.plant isn't always a
  // single real plant name (e.g. "VAL & IND" means this row applies to both Valsad AND Indore
  // together), so a plain plants-table lookup on that raw string finds nothing. Splits on any
  // non-letter separator and resolves each piece to a real plant (exact match, or a prefix match
  // for an abbreviation like "VAL"), collecting every state the label covers.
  function resolveStatesForPlantLabel(label: string | null | undefined): Set<string> {
    const states = new Set<string>();
    if (!label || !allPlants) return states;
    const tokens = label.split(/[^a-zA-Z]+/).map((t) => t.trim().toUpperCase()).filter(Boolean);
    for (const token of tokens) {
      const found = allPlants.find((p: any) => String(p.name ?? "").toUpperCase() === token)
        ?? allPlants.find((p: any) => String(p.name ?? "").toUpperCase().startsWith(token));
      if (found?.state) states.add(String(found.state).trim().toUpperCase());
    }
    return states;
  }
  // Add Extra's own product lookup is entirely client-side (allProductsQuery, the full catalog)
  // — when a barcode has more than one Product Master row (see the comment above), a plain
  // .find() just grabs whichever one the API happened to return first, which is how this dialog
  // kept defaulting to a row with no gj/mp PLT set (pallet size silently falling back to 1) even
  // after the server-side scan path was fixed to prefer the state-matching row. Same fix, applied
  // to this client-side lookup too.
  function resolveExtraProductForBarcode(barcode: string): Product | undefined {
    const q = barcode.trim().toLowerCase();
    const matches = (allProductsQuery.data ?? []).filter((p) => (p.barcode ?? "").toLowerCase() === q);
    if (matches.length <= 1) return matches[0];
    const targetStates = resolveStatesForPlantLabel(slip?.plant ?? "");
    if (targetStates.size === 0) return matches[0];
    for (const candidate of matches) {
      const candidateStates = resolveStatesForPlantLabel(candidate.plant);
      for (const s of candidateStates) {
        if (targetStates.has(s)) return candidate;
      }
    }
    return matches[0];
  }

  // The plant's STV list — originally needed only by the Create Operation dialog (the one place
  // an STV was ever chosen), now also reused by the "Change STV" control below, so it falls back
  // to the OPEN slip's plant too, not just pendingSlip's.
  const stvPlant = pendingSlip?.slip?.plant ?? slip?.plant ?? "";
  const stvsQuery = useQuery<string[]>({
    queryKey: ["/api/order-scan/stvs", stvPlant],
    queryFn: () => apiRequest("GET", `/api/order-scan/stvs?plant=${encodeURIComponent(stvPlant)}`).then((r) => r.json()).then((l: string[]) => sortNatural(l)),
    enabled: !!stvPlant,
  });
  const stvs = stvsQuery.data ?? [];
  // Frozen server-side once the load has started. Empty only on legacy slips started before the
  // STV became mandatory — those scan with no STV rather than being blocked, since there's no
  // longer any in-page control for someone to set one with.
  const lockedStv = slip?.loadingStv ?? "";

  // Change STV — admin/Supervisor/current-owner (server-enforced identically; see
  // requireLoadingWrite + the current-owner check in PATCH /loading/proforma/:orderNumber/stv).
  // The endpoint itself keeps every platform this load has ever used (storeKeeperInfo grows,
  // never overwrites) and pushes that to Notion, unchanged from the Proforma Slips page's own
  // Edit STV action — this is just a second entry point straight from the scan view.
  const [stvChangeOpen, setStvChangeOpen] = useState(false);
  const [stvChangeValue, setStvChangeValue] = useState("");
  const changeStvMutation = useMutation({
    mutationFn: async (newStv: string) => {
      const res = await apiRequest("PATCH", `/api/loading/proforma/${encodeURIComponent(slip!.orderNumber)}/stv`, { stv: newStv });
      if (!res.ok) throw new Error((await res.json().catch(() => ({})))?.message || "Failed to change STV");
      return res.json() as Promise<{ slip: ProformaSlip }>;
    },
    onSuccess: (data) => {
      setSlip(data.slip);
      setStvChangeOpen(false);
      toast({ title: "STV updated", description: `Now on ${data.slip.loadingStv}` });
    },
    onError: (err: any) => toast({ title: "Failed to change STV", description: parseApiErrorMessage(err), variant: "destructive" }),
  });

  const [itemScanMode, setItemScanMode] = useState<"camera" | "manual">("manual");
  const [itemBarcode, setItemBarcode] = useState("");
  const [extraNotAllowedMessage, setExtraNotAllowedMessage] = useState<string | null>(null);

  // Add Extra — a dedicated popup instead of arming the regular scanner: search by name/barcode/
  // SAP (same catalog + search-as-you-type pattern the Exchange Product dialog uses), confirm by
  // sight via the product's own image, then a qty/pallets pair defaulting to one full pallet.
  const [extraDialogOpen, setExtraDialogOpen] = useState(false);
  const [extraSearch, setExtraSearch] = useState("");
  const [extraTarget, setExtraTarget] = useState<Product | null>(null);
  const [extraQty, setExtraQty] = useState(1);
  const [extraPalletsInput, setExtraPalletsInput] = useState("");
  const allProductsQuery = useQuery<Product[]>({
    queryKey: ["/api/products", "all"],
    queryFn: async () => (await apiRequest("GET", "/api/products?all=true")).json(),
    enabled: extraDialogOpen,
    staleTime: 60_000,
  });
  const extraSearchResults = (() => {
    const q = extraSearch.trim().toLowerCase();
    if (!q) return [];
    return (allProductsQuery.data ?? [])
      .filter((p) =>
        (p.name ?? "").toLowerCase().includes(q) ||
        (p.barcode ?? "").toLowerCase().includes(q) ||
        (p.sapCode ?? "").toLowerCase().includes(q),
      )
      .slice(0, 20);
  })();
  function resetExtraDialog() {
    setExtraDialogOpen(false);
    setExtraSearch("");
    setExtraTarget(null);
    setExtraQty(1);
    setExtraPalletsInput("");
    setExtraScanMode("manual");
  }
  function pickExtraTarget(p: Product) {
    setExtraTarget(p);
    setExtraSearch("");
    const ipp = extraProductPalletSize(p);
    const qty = ipp > 0 ? ipp : 1;
    setExtraQty(qty);
    setExtraPalletsInput(ipp > 0 ? "1.00" : "");
  }
  // A gun scan (or a full barcode pasted/typed) lands as an exact catalog match the moment
  // it's complete — jump straight to the confirm step instead of making the operator click the
  // one result that's already sitting there. Substring searches (name/SAP/partial barcode)
  // still fall through to the normal results list below.
  function tryAutoPickExtraBarcode(value: string): boolean {
    const q = value.trim();
    if (!q) return false;
    const exact = resolveExtraProductForBarcode(q);
    if (exact) { pickExtraTarget(exact); return true; }
    return false;
  }
  function handleExtraSearchChange(value: string) {
    setExtraSearch(value);
    tryAutoPickExtraBarcode(value);
  }
  function changeExtraQty(v: string) {
    const q = parseInt(v, 10) || 0;
    setExtraQty(q);
    const ipp = extraTarget ? extraProductPalletSize(extraTarget) : 0;
    if (ipp > 0) setExtraPalletsInput((q / ipp).toFixed(2));
  }
  function changeExtraPallets(v: string) {
    setExtraPalletsInput(v);
    const ipp = extraTarget ? extraProductPalletSize(extraTarget) : 0;
    const p = parseFloat(v);
    if (ipp > 0 && Number.isFinite(p)) setExtraQty(Math.round(p * ipp));
  }
  const extraMutation = useMutation({
    mutationFn: async () => {
      if (!extraTarget) throw new Error("Pick an item first");
      const res = await apiRequest("POST", `/api/loading/proforma/${encodeURIComponent(slip!.orderNumber)}/scan`, {
        barcode: extraTarget.barcode, qty: extraQty, extra: true,
      });
      if (!res.ok) throw new Error((await res.json().catch(() => ({})))?.message || "Failed to add extra");
      return res.json() as Promise<ScanResponse>;
    },
    onSuccess: (data) => {
      setSlip(data.slip);
      setItems(data.items);
      setAllComplete(data.allComplete);
      queryClient.invalidateQueries({ queryKey: ["/api/scan-sessions/reports/scan-history", "item-panel", data.slip.orderNumber] });
      toast({ title: "Extra added", description: `${extraTarget?.name} · +${extraQty}` });
      resetExtraDialog();
    },
    onError: (err: any) => toast({ title: "Could not add extra", description: parseApiErrorMessage(err), variant: "destructive" }),
  });

  // Items table's own +/- on the Loaded column — a manual correction, confirmed first (same
  // write access as scanning; no extra permission gate). The dialog defaults to 1 but lets the
  // operator type any quantity before confirming either direction.
  const [adjustTarget, setAdjustTarget] = useState<{ item: ProformaItem; direction: "add" | "remove" } | null>(null);
  const [adjustQty, setAdjustQty] = useState(1);
  function openAdjustDialog(item: ProformaItem, direction: "add" | "remove") {
    setAdjustTarget({ item, direction });
    setAdjustQty(1);
  }
  const adjustLoadMutation = useMutation({
    mutationFn: async () => {
      if (!adjustTarget || !slip) throw new Error("Nothing to adjust");
      const delta = adjustTarget.direction === "add" ? adjustQty : -adjustQty;
      const res = await apiRequest("POST", `/api/loading/proforma/${encodeURIComponent(slip.orderNumber)}/adjust-load`, {
        barcode: adjustTarget.item.barcode, delta,
      });
      if (!res.ok) throw new Error((await res.json().catch(() => ({})))?.message || "Failed to adjust quantity");
      return res.json() as Promise<ScanResponse>;
    },
    onSuccess: (data) => {
      markItemScanned(adjustTarget?.item.barcode, data.items);
      refreshOwnerHistory(data.slip.orderNumber);
      setSlip(data.slip);
      setItems(data.items);
      setAllComplete(data.allComplete);
      setLoadedVolume(data.loadedVolume);
      queryClient.invalidateQueries({ queryKey: ["/api/scan-sessions/reports/scan-history", "item-panel", data.slip.orderNumber] });
      // A +/- correction can finish the load just as a scan can — same popup, same refresh.
      if (data.allComplete && !slip?.loadingCompletedAt) {
        announceLoadComplete(data.slip, data.items, true);
        queryClient.invalidateQueries({ queryKey: ["/api/loading/records"] });
      }
      toast({
        title: adjustTarget?.direction === "add" ? "Quantity added" : "Quantity removed",
        description: `${adjustTarget?.item.itemName ?? adjustTarget?.item.barcode} · ${adjustTarget?.direction === "add" ? "+" : "−"}${adjustQty}`,
      });
      setAdjustTarget(null);
    },
    onError: (err: any) => toast({ title: "Could not adjust quantity", description: parseApiErrorMessage(err), variant: "destructive" }),
  });

  const itemInputRef = useRef<HTMLInputElement>(null);
  const [itemCameraReady, setItemCameraReady] = useState(false);
  const [itemCameraError, setItemCameraError] = useState<string | null>(null);
  const itemVideoRef = useRef<HTMLVideoElement>(null);
  const itemScannerRef = useRef<BarcodeScanner | null>(null);

  // Add Extra's own Camera/Manual toggle — same pattern as the regular item scanner above, just
  // scoped to this dialog and only running during the search step (stopped once a target is
  // picked, since there's nothing left to scan for).
  const [extraScanMode, setExtraScanMode] = useState<"camera" | "manual">("manual");
  const [extraCameraReady, setExtraCameraReady] = useState(false);
  const [extraCameraError, setExtraCameraError] = useState<string | null>(null);
  const extraVideoRef = useRef<HTMLVideoElement>(null);
  const extraScannerRef = useRef<BarcodeScanner | null>(null);
  function stopExtraCamera() {
    extraScannerRef.current?.stop();
    setExtraCameraReady(false);
  }
  useEffect(() => {
    if (!extraDialogOpen || extraScanMode !== "camera" || extraTarget) { stopExtraCamera(); return; }
    let cancelled = false;
    const scanner = new BarcodeScanner({
      onDetected: (result: Result) => {
        const code = result.getText();
        if (!code || cancelled) return;
        if (!tryAutoPickExtraBarcode(code)) {
          toast({ title: "Barcode not found", description: `"${code}" has no matching entry in Product Master.`, variant: "destructive" });
        }
      },
      onError: (err: Error) => { if (!cancelled) { setExtraCameraError(err.message); setExtraScanMode("manual"); } },
    });
    extraScannerRef.current = scanner;
    (async () => {
      const videoEl = extraVideoRef.current;
      if (!videoEl) return;
      setExtraCameraError(null);
      setExtraCameraReady(false);
      try {
        await scanner.initialize();
        if (!cancelled) { await scanner.start(videoEl); if (!cancelled) setExtraCameraReady(true); }
      } catch (err: any) {
        if (!cancelled) { setExtraCameraError(err?.message ?? "Camera failed"); setExtraScanMode("manual"); }
      }
    })();
    return () => { cancelled = true; scanner.stop(); };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [extraDialogOpen, extraScanMode, extraTarget]);
  const itemsRef = useRef<ProformaItem[]>(items);
  itemsRef.current = items;
  const scanLockRef = useRef(false);
  // Same-barcode cooldown — mirrors Order Scan's own guard (SAME_BARCODE_COOLDOWN_MS in
  // Scanning/Scan.tsx): a barcode gun that double-fires, or a box scanned twice by mistake,
  // should not silently log a second scan of the same physical pallet. A repeat of the SAME
  // barcode within the window is discarded (no beep, no dialog, no toast — stays silent, same
  // as Order Scan); a DIFFERENT barcode is never affected.
  const lastScanRef = useRef<{ barcode: string; at: number } | null>(null);
  // Which item was touched most recently (see filteredItems' sort). Reset when another order is
  // opened, so one order's scan order never carries into the next.
  const itemScanSeqRef = useRef<{ seq: number; byId: Map<number, number> }>({ seq: 0, byId: new Map() });
  function markItemScanned(barcode: string | null | undefined, list: ProformaItem[]) {
    const hit = list.find((i) => normalize(i.barcode) === normalize(barcode ?? ""));
    if (!hit) return;
    const s = itemScanSeqRef.current;
    s.seq += 1;
    s.byId.set(hit.id, s.seq);
  }
  const SAME_BARCODE_COOLDOWN_MS = 5000;

  const locked = !!slip?.loadingCompletedAt;
  // Shift handoff — a slip with no owner recorded (created before this feature existed) stays
  // open to anyone with write access, same as the server's own fallback. Paused blocks scanning
  // for EVERYONE, including the owner, until someone claims it.
  const isLoadPaused = !!slip?.loadingPausedAt;
  const isLoadOwner = !slip?.loadingOwnerCode || slip.loadingOwnerCode === currentUser()?.userCode;
  const canScanThisLoad = canWrite && !locked && !isLoadPaused && (isLoadOwner || canBypassOwnership);
  // Write access to Loading at all, AND (creator/current owner/admin/super-admin/Supervisor) —
  // a read-only user never sees this button now, regardless of their designation.
  const canComplete = canWrite && canCompleteLoadClient(slip);

  function stopItemCamera() {
    itemScannerRef.current?.stop();
    setItemCameraReady(false);
  }

  // Pending confirm dialog (opens for anything that isn't a clean full-pallet auto-scan). Never
  // an extra — that goes through its own dedicated Add Extra popup instead (extraDialogOpen).
  const [pending, setPending] = useState<{ barcode: string; item: ProformaItem | null } | null>(null);
  const [dialogQty, setDialogQty] = useState(1);
  const [dialogPalletsInput, setDialogPalletsInput] = useState("");

  // 5s non-blocking feedback popup after an auto-confirmed full-pallet scan — same popup Order
  // Scan itself shows (product image + name/barcode/SAP + qty scanned/remaining), and gated by
  // the same plant-level Auto Scan toggle (autoScanEnabled above); anything less than a full
  // pallet, or Auto Scan being off for this plant, still opens the confirm dialog below.
  const [autoFeedback, setAutoFeedback] = useState<
    { name: string; barcode: string; sapCode: string | null; scannedQty: number; remaining: number; isExtra: boolean; productId: number | null } | null
  >(null);
  const autoFeedbackTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  // Tracked in state (not a direct DOM style flip on the <img> itself) so the text column
  // actually reflows to fill the freed width when the image 404s — same pattern Order Scan's
  // own confirm dialog uses (osImageFailed).
  const [autoFeedbackImageFailed, setAutoFeedbackImageFailed] = useState(false);
  function showAutoFeedback(name: string, barcode: string, sapCode: string | null, scannedQty: number, remaining: number, isExtra: boolean, productId: number | null) {
    if (autoFeedbackTimerRef.current) clearTimeout(autoFeedbackTimerRef.current);
    setAutoFeedbackImageFailed(false);
    setAutoFeedback({ name, barcode, sapCode, scannedQty, remaining, isExtra, productId });
    autoFeedbackTimerRef.current = setTimeout(() => setAutoFeedback(null), 5000);
  }

  const scanItemMutation = useMutation({
    mutationFn: async ({ barcode, qty, extra }: { barcode: string; qty: number; extra?: boolean }): Promise<
      { queued: true } | { queued: false; data: ScanResponse }
    > => {
      // Tries live first; falls back to the offline queue only on a genuine network failure —
      // see client/src/lib/offlineQueue.ts. A queued scan has no server response yet (the
      // regular/extra split is decided server-side, under a lock, against live stock/expected
      // qty — it can't be guessed client-side), so the AUTHORITATIVE regular/extra classification
      // and totals only arrive once the queue actually flushes. The optimistic bump applied in
      // onMutate below is just a best-effort local estimate so the operator sees this scan land
      // immediately; the 15s silent poll above (and the real response on a live scan) corrects it.
      const result = await scanOrQueue(
        `/api/loading/proforma/${encodeURIComponent(slip!.orderNumber)}/scan`,
        { barcode, qty, extra: !!extra },
        `${barcode} × ${qty}${extra ? " (extra)" : ""} — Loading #${slip!.orderNumber}`,
      );
      if (result.queued) return { queued: true };
      const res = result.response;
      if (!res.ok) throw new Error((await res.json().catch(() => ({})))?.message || "Scan failed");
      const data = (await res.json()) as ScanResponse;
      return { queued: false, data };
    },
    // Optimistic local bump — applied BEFORE the network attempt even starts, so it shows up for
    // a live scan too (briefly, until the real response overwrites it a moment later) and, more
    // importantly, PERSISTS for a queued one, where there is no real response for a while. Mirrors
    // the server's own "loaded" math (withProgress in loading.ts): loaded counts every scan
    // (regular or extra) toward remaining, so this needs no regular/extra guess to be accurate.
    onMutate: ({ barcode, qty }) => {
      const prevItems = itemsRef.current;
      const idx = prevItems.findIndex((i) => normalize(i.barcode) === normalize(barcode));
      if (idx === -1) return { prevItems: null };
      const item = prevItems[idx];
      const loaded = item.loaded + qty;
      const nextItems = prevItems.slice();
      nextItems[idx] = {
        ...item,
        loaded,
        remaining: Math.max(0, item.expected - loaded),
        isComplete: item.expected > 0 && loaded >= item.expected,
        stockAvailable: item.stockAvailable != null ? Math.max(0, item.stockAvailable - qty) : item.stockAvailable,
      };
      setItems(nextItems);
      return { prevItems };
    },
    onSuccess: (result, vars) => {
      if (result.queued) {
        // Text must differ scan-to-scan — TOAST_LIMIT is 1 (use-toast.ts), so a second queued
        // scan replaces the first toast in the very same tick. Identical text on both meant a
        // second scan of a different item looked exactly like nothing had happened at all.
        // A queued request has no server response, so release the same local guards here as the
        // live success path. Otherwise the confirmation dialog can remain open and block the
        // next barcode while the offline queue is waiting to flush.
        scanLockRef.current = false;
        setPending((current) => current && normalize(current.barcode) === normalize(vars.barcode) ? null : current);
        toast({
          title: "Scan saved offline",
          description: `${vars.barcode} × ${vars.qty}${vars.extra ? " (extra)" : ""} — will sync once you're back online.`,
        });
        return;
      }
      const data = result.data;
      markItemScanned(data.event?.barcode, data.items);
      refreshOwnerHistory(data.slip.orderNumber);
      setSlip(data.slip);
      setItems(data.items);
      setAllComplete(data.allComplete);
      setLoadedVolume(data.loadedVolume);
      if (data.allComplete && !slip?.loadingCompletedAt) {
        announceLoadComplete(data.slip, data.items, true);
        // The server auto-set loadingCompletedAt as a side effect of this scan — the landing
        // list's badge reads that column, so it needs a refresh too, not just this order's own
        // view, or it keeps showing "In Progress" until the user happens to navigate back to it.
        queryClient.invalidateQueries({ queryKey: ["/api/loading/records"] });
      }
      queryClient.invalidateQueries({ queryKey: ["/api/scan-sessions/reports/scan-history", "item-panel", data.slip.orderNumber] });
    },
    onError: (err: any, _vars, context) => {
      // A genuine rejection (not a queue) — the optimistic bump never happened for real, so undo it.
      if (context?.prevItems) setItems(context.prevItems);
      const productMasterMissing = matchProductMasterMissingError(err);
      if (productMasterMissing) { setProductMasterMissingMessage(productMasterMissing); return; }
      const barcodeNotInSystem = matchBarcodeNotInSystemError(err);
      if (barcodeNotInSystem) { setBarcodeNotInSystemMessage(barcodeNotInSystem); return; }
      const extraNotAllowed = matchExtraNotAllowedError(err);
      if (extraNotAllowed) { setExtraNotAllowedMessage(extraNotAllowed); return; }
      toast({ title: "Scan failed", description: parseApiErrorMessage(err), variant: "destructive" });
    },
    onSettled: () => { scanLockRef.current = false; },
  });
  const [productMasterMissingMessage, setProductMasterMissingMessage] = useState<string | null>(null);
  const [barcodeNotInSystemMessage, setBarcodeNotInSystemMessage] = useState<string | null>(null);

  const completeMutation = useMutation({
    mutationFn: async () => {
      const res = await apiRequest("POST", `/api/loading/proforma/${encodeURIComponent(slip!.orderNumber)}/complete`, {});
      if (!res.ok) throw new Error((await res.json().catch(() => ({})))?.message || "Complete failed");
      return res.json() as Promise<{ slip: ProformaSlip; items: ProformaItem[]; allComplete: boolean; loadedVolume: number }>;
    },
    onSuccess: (data) => {
      setSlip(data.slip);
      setItems(data.items);
      setAllComplete(data.allComplete);
      setLoadedVolume(data.loadedVolume);
      setConfirmCompleteOpen(false);
      announceLoadComplete(data.slip, data.items, false);
      refreshOwnerHistory(data.slip.orderNumber);
      queryClient.invalidateQueries({ queryKey: ["/api/loading/records"] });
    },
    onError: (err: any) => toast({ title: "Complete failed", description: parseApiErrorMessage(err), variant: "destructive" }),
  });

  // Shift handoff — Pause (current owner/admin steps away) and Claim (anyone with write access
  // picks up a paused load). Both just refresh this same slip/items shape, same as every other
  // load-affecting mutation on this page.
  const pauseLoadMutation = useMutation({
    mutationFn: async () => {
      const res = await apiRequest("POST", `/api/loading/proforma/${encodeURIComponent(slip!.orderNumber)}/pause`, {});
      if (!res.ok) throw new Error((await res.json().catch(() => ({})))?.message || "Pause failed");
      return res.json() as Promise<{ slip: ProformaSlip }>;
    },
    onSuccess: (data) => {
      setSlip(data.slip);
      toast({ title: "Load paused", description: "Anyone with write access can now claim it." });
      queryClient.invalidateQueries({ queryKey: ["/api/loading/records"] });
      refreshOwnerHistory(data.slip.orderNumber);
    },
    onError: (err: any) => toast({ title: "Could not pause", description: parseApiErrorMessage(err), variant: "destructive" }),
  });
  const claimLoadMutation = useMutation({
    mutationFn: async (orderNumber: string) => {
      const res = await apiRequest("POST", `/api/loading/proforma/${encodeURIComponent(orderNumber)}/claim`, {});
      if (!res.ok) throw new Error((await res.json().catch(() => ({})))?.message || "Claim failed");
      return res.json() as Promise<{ slip: ProformaSlip }>;
    },
    onSuccess: (data) => {
      if (slip?.orderNumber === data.slip.orderNumber) setSlip(data.slip);
      toast({ title: "Load claimed", description: "You now own this load." });
      queryClient.invalidateQueries({ queryKey: ["/api/loading/records"] });
      refreshOwnerHistory(data.slip.orderNumber);
    },
    onError: (err: any) => toast({ title: "Could not claim", description: parseApiErrorMessage(err), variant: "destructive" }),
  });

  function defaultDialogQty(item: ProformaItem | null): number {
    if (!item) return 1;
    // No real GJ/MP PLT in Product Master → no amount to pre-fill: leave it at 0 (the box shows
    // empty and Confirm stays off) so the operator types what they are actually loading.
    if (!((item.realPackSize ?? 0) > 0)) return 0;
    const ipp = item.itemsPerPallet || 1;
    return item.remaining > 0 && item.remaining < ipp ? item.remaining : ipp;
  }

  function openConfirmDialog(barcode: string, item: ProformaItem | null) {
    const qty = defaultDialogQty(item);
    setDialogQty(qty);
    setDialogPalletsInput(item && (item.realPackSize ?? 0) > 0 && item.itemsPerPallet > 0 ? (qty / item.itemsPerPallet).toFixed(2) : "");
    setPending({ barcode, item });
  }

  // A 404 here means this barcode genuinely isn't a real product at all — anything else
  // (network hiccup, 500) shouldn't block a legitimate scan on our own connectivity/lookup
  // failure, so those are treated as "assume known" rather than risk a false block.
  // Any failure here — a clean 404, or anything else (a timeout, a gateway error under
  // production load, an odd/garbage barcode string) — means "not known": there's nothing
  // legitimate to log either way, and letting an ambiguous error through as "assume it's a real
  // product, log it as an extra" was actually the worse failure mode (silently opening a qty
  // dialog for garbage input instead of a clear rejection the operator can just retry).
  async function isKnownProduct(barcode: string): Promise<boolean> {
    try {
      const plantQ = slip?.plant ? `?plant=${encodeURIComponent(slip.plant)}` : "";
      await apiRequest("GET", `/api/products/barcode/${encodeURIComponent(barcode)}${plantQ}`);
      return true;
    } catch {
      return false;
    }
  }

  async function handleItemBarcode(rawBarcode: string) {
    const barcode = rawBarcode.trim();
    if (!barcode || !slip || locked || scanLockRef.current || pending) return;

    // Shift handoff — the server rejects this too (checkLoadOwnership in /scan), but catching it
    // here avoids opening a confirm dialog for a scan that's just going to bounce anyway.
    if (!canScanThisLoad) {
      toast({
        title: isLoadPaused ? "This load is paused" : "Not your load",
        description: isLoadPaused
          ? "Claim it from the header above before scanning."
          : `Owned by ${slip.loadingOwnerName ?? slip.loadingOwnerCode} — ask them to pause it first.`,
        variant: "destructive",
      });
      return;
    }

    // Vehicle must be linked before anything can be scanned onto this order — server enforces
    // this too (POST /scan), but the Scan Items section is already hidden until a vehicle is
    // linked, so reaching here without one only happens via a stale gun-scan queued before the
    // section unmounted.
    if (!slip.vehicleNumber) return;


    // Same-barcode cooldown — a repeat of the exact barcode just accepted, within the window,
    // is discarded before anything else (no beep, no dialog): see SAME_BARCODE_COOLDOWN_MS above.
    const nb = normalize(barcode);
    const last = lastScanRef.current;
    if (last && normalize(last.barcode) === nb && Date.now() - last.at < SAME_BARCODE_COOLDOWN_MS) {
      return;
    }
    lastScanRef.current = { barcode, at: Date.now() };

    const item = itemsRef.current.find((i) => normalize(i.barcode) === normalize(barcode)) ?? null;

    // A stock-zero item on THIS slip is stopped right here, before even opening the dialog,
    // since there's nothing to load.
    if (item && (item.stockAvailable ?? 0) <= 0) {
      toast({ title: "No stock to load", description: `${item.itemName ?? barcode} has 0 stock at ${slip.plant} — cannot load it.`, variant: "destructive" });
      return;
    }

    scanLockRef.current = true;

    // Not on this order's manifest at all — before walking the user through picking a qty,
    // check whether it's even a real product at all. A barcode that's neither on this order NOR
    // in Product Master has nothing legitimate to log (the server would reject it anyway — see
    // BARCODE_NOT_IN_SYSTEM in loading.ts's own /scan handler); better to say so immediately
    // than let the user fill in a dialog for a scan that can only ever fail.
    if (!item) {
      const known = await isKnownProduct(barcode);
      if (!known) {
        scanLockRef.current = false;
        setItemBarcode("");
        setBarcodeNotInSystemMessage(`"${barcode}" is not on this order and not in Product Master. It cannot be scanned.`);
        return;
      }
      // A real product, but not on this slip — logging it at all can only ever be an Extra. A
      // regular scan refuses this outright (see EXTRA_NOT_ALLOWED in loading.ts's /scan); only
      // the dedicated Add Extra popup (opened straight from the "Add Extra" button, no scanning
      // involved) may add it.
      scanLockRef.current = false;
      setItemBarcode("");
      setExtraNotAllowedMessage(`"${barcode}" is not on this order. Extra items can't be scanned with a regular scan — use the "Add Extra" button instead.`);
      return;
    }

    // Full pallet (or more) still remaining → auto-scan exactly one pallet, no dialog, 5s image
    // feedback popup — same shape as Order Scan's Auto Scan path, gated by the SAME plant-level
    // Auto Scan toggle Order Scan reads. Auto Scan OFF → every scan opens the confirm dialog.
    const ipp = item?.itemsPerPallet ?? 0;
    // A pallet size that was never set in Product Master is never auto-scanned — ipp would be a
    // guess (the line's own quantity), so the dialog always opens and asks for the amount.
    const canAutoScan = autoScanEnabled && !!item && (item.realPackSize ?? 0) > 0
      && item.expected > 0 && ipp >= 1 && item.remaining >= ipp && (item.stockAvailable ?? 0) >= ipp;
    if (canAutoScan) {
      const qty = ipp;
      scanItemMutation.mutate({ barcode, qty }, {
        // Queued (offline) has no event data to show — the mutation's own onSuccess already
        // toasts "Scan saved offline" in that case, so this just skips the feedback popup.
        onSuccess: (result) => {
          if (result.queued) return;
          const { event } = result.data;
          showAutoFeedback(event.itemName, event.barcode, event.sapCode, event.totalQty, event.remaining, event.isExtra, event.productId);
        },
      });
      setItemBarcode("");
      return;
    }

    scanLockRef.current = false;
    openConfirmDialog(barcode, item);
    setItemBarcode("");
  }

  // Always the latest handleItemBarcode, so the item camera and gun below can stay attached across
  // data refreshes (after every scan, and every 15 s in the background) and still act on current
  // items. They used to depend on the whole slip object and were torn down and rebuilt on each
  // refresh — the camera restarted, and a gun scan arriving at that moment was lost.
  const handleItemBarcodeRef = useRef(handleItemBarcode);
  handleItemBarcodeRef.current = handleItemBarcode;

  useEffect(() => {
    if (view !== "create" || itemScanMode !== "camera" || !slip || locked || !slip.vehicleNumber) { stopItemCamera(); return; }
    let cancelled = false;
    const scanner = new BarcodeScanner({
      onDetected: (result: Result) => { const code = result.getText(); if (code && !cancelled) handleItemBarcodeRef.current(code); },
      onError: (err: Error) => { if (!cancelled) { setItemCameraError(err.message); setItemScanMode("manual"); } },
    });
    itemScannerRef.current = scanner;
    (async () => {
      const videoEl = itemVideoRef.current;
      if (!videoEl) return;
      setItemCameraError(null);
      setItemCameraReady(false);
      try {
        await scanner.initialize();
        if (!cancelled) { await scanner.start(videoEl); if (!cancelled) setItemCameraReady(true); }
      } catch (err: any) {
        if (!cancelled) { setItemCameraError(err?.message ?? "Camera failed"); setItemScanMode("manual"); }
      }
    })();
    return () => { cancelled = true; scanner.stop(); };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [view, itemScanMode, slip?.orderNumber, !!slip?.vehicleNumber, locked]);

  // Barcode gun for items — active once a slip is open, a vehicle is linked, and not yet complete.
  useEffect(() => {
    if (view !== "create" || !slip || locked || !slip.vehicleNumber) return;
    // Barcode gun timing. A gun types a code much faster than a person, but wireless/Bluetooth guns
    // and busy tablets space characters out more than a wired gun on a fast PC — at the old 50 ms
    // limit, a slower burst was cut in half and read as a wrong or partial code. Most guns also end
    // with Enter or Tab, which now finishes the scan straight away instead of waiting for silence.
    const MAX_GAP_MS = 100;
    const BURST_END_MS = 120;
    let buffer = "";
    let lastAt = 0;
    let flushTimer: ReturnType<typeof setTimeout> | null = null;
    const finish = () => {
      if (buffer.length >= 3) { setItemScanMode("manual"); itemInputRef.current?.focus(); handleItemBarcodeRef.current(buffer); }
      buffer = "";
    };
    const handleKeyDown = (e: KeyboardEvent) => {
      const target = e.target as HTMLElement | null;
      if (target === itemInputRef.current) return;
      if (target && (target.tagName === "INPUT" || target.tagName === "TEXTAREA" || target.isContentEditable)) return;
      if (e.ctrlKey || e.metaKey || e.altKey) return;
      if ((e.key === "Enter" || e.key === "Tab") && buffer.length >= 3) {
        e.preventDefault();
        if (flushTimer) clearTimeout(flushTimer);
        finish();
        return;
      }
      if (e.key.length !== 1) return;
      const now = Date.now();
      if (now - lastAt > MAX_GAP_MS) buffer = "";
      lastAt = now;
      buffer += e.key;
      if (flushTimer) clearTimeout(flushTimer);
      flushTimer = setTimeout(finish, BURST_END_MS);
    };
    window.addEventListener("keydown", handleKeyDown, true);
    return () => { window.removeEventListener("keydown", handleKeyDown, true); if (flushTimer) clearTimeout(flushTimer); };
    // Keyed on the order, its vehicle and the lock — not the whole slip object, which is replaced on
    // every refresh (see handleItemBarcodeRef above).
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [view, slip?.orderNumber, !!slip?.vehicleNumber, locked]);

  // Once a vehicle is CLAIMED (vehicleAssignedByCode set — someone actually confirmed it via
  // this Link/Change UI), only that user or an admin can change it — everyone else with write
  // access still sees it, just without the edit controls. A vehicleNumber can also arrive on the
  // slip unclaimed (imported straight from Notion's dispatch DB — see server/services/
  // proformaNotionSync.ts), in which case it's still open to anyone with write access to
  // confirm/change, same as if nothing were linked yet. Server-enforced too (see /link-vehicle
  // in server/routes/loading.ts, which gates on the same vehicleAssignedByCode field) — this is
  // just the matching UI gate.
  const isVehicleClaimed = !!slip?.vehicleAssignedByCode;
  const canEditVehicle = !isVehicleClaimed || canBypassOwnership || slip?.vehicleAssignedByCode === currentUser()?.userCode;

  // Keeps Layout's sidebar turning in sync with this page's own rotation. Both the landing list
  // and the Stage-B scan view now render the same rotated wrapper when `rotated`, so — unlike
  // the earlier version of this effect — no per-view gating is needed here: `rotated` alone
  // correctly reflects whether whatever's currently on screen is actually shown rotated.
  useEffect(() => {
    setSidebarKioskRotateClass(rotated ? kioskRotateClass : "");
    return () => setSidebarKioskRotateClass("");
  }, [rotated, kioskRotateClass, setSidebarKioskRotateClass]);

  // Load Totals — same shape/labels as Order Scan's own Order Totals card (Total/Loaded/
  // Remaining/Extra tiles + a progress bar), built from this order's own items instead of
  // duplicating it as three plain Items/Qty/Volume boxes.
  const itemTotals = items.reduce(
    (acc, it) => {
      const extra = Math.max(0, it.loaded - it.expected);
      const ipp = it.itemsPerPallet ?? 0;
      acc.expected += it.expected;
      acc.loaded += it.loaded;
      acc.remaining += it.remaining;
      acc.extra += extra;
      if (ipp > 0) {
        acc.pltExpected += it.expected / ipp;
        acc.pltLoaded += it.loaded / ipp;
        acc.pltRemaining += it.remaining / ipp;
        acc.pltExtra += extra / ipp;
      }
      return acc;
    },
    { expected: 0, loaded: 0, remaining: 0, extra: 0, pltExpected: 0, pltLoaded: 0, pltRemaining: 0, pltExtra: 0 },
  );
  const itemPct = itemTotals.expected > 0 ? Math.min(100, Math.round((itemTotals.loaded / itemTotals.expected) * 100)) : 0;
  // Three separate lists via one tab, based on the order's own EXPECTED quantity per item (its
  // planned amount) — not Loaded. Loaded starts at 0 for almost every item before scanning even
  // begins, so basing this on Loaded left most items with neither a pallet nor a loose count and
  // they vanished from both lists entirely. Expected is set from the start for every real item,
  // so "Pallet" (needs at least one full pallet) and "Loose" (its planned qty is only a leftover
  // that never completes one) both populate properly regardless of how far scanning has gotten.
  // "All" shows every item, both numbers merged — never both lists' items at once otherwise, only
  // one active list. An item with no pallet size configured (itemsPerPallet <= 0) has no pallet
  // concept at all — its whole expected qty counts as loose, same as the fallback everywhere else.
  const [itemUnitTab, setItemUnitTab] = useState<"all" | "pallet" | "loose">("all");
  // Which quantity the Pallet/Loose tabs judge an item by: whatever the status filter above them
  // is showing. Looking at Remaining and asking for Loose means "what is still to load that does
  // not fill a pallet" — judging that by the item's EXPECTED split (what this used to do) hid the
  // very rows being asked for: an item ordered as a clean 200 (2 full pallets, no loose at all)
  // with 50 left to load has a loose remainder, but no loose expected, so it never appeared.
  const unitBasisQty = (it: ProformaItem) =>
    itemStatusFilter === "remaining" ? it.remaining
    : itemStatusFilter === "done"    ? it.loaded
    : itemStatusFilter === "extra"   ? Math.max(0, it.loaded - it.expected)
    : it.expected;
  const palletsOfQty = (it: ProformaItem, qty: number) => {
    const ipp = it.itemsPerPallet ?? 0;
    return ipp > 0 ? Math.floor(qty / ipp) : 0;
  };
  const looseOfQty = (it: ProformaItem, qty: number) => {
    const ipp = it.itemsPerPallet ?? 0;
    return ipp > 0 ? qty % ipp : qty;
  };
  const expectedPalletsOf = (it: ProformaItem) => palletsOfQty(it, it.expected);
  const expectedLooseOf = (it: ProformaItem) => looseOfQty(it, it.expected);
  // Scan order, newest first — same as Unloading's item table (itemScanSeqRef there): each scan
  // or +/- stamps that row with a rising number, and rows are sorted by it, so whatever was just
  // handled sits at the top instead of staying wherever its Sr. No. put it. Rows nobody has
  // touched keep their original order (the sort is stable, and they all score 0).
  const filteredItems = items.filter((it) => {
    if (itemStatusFilter === "done" && !(it.loaded > 0)) return false;
    if (itemStatusFilter === "remaining" && !(it.remaining > 0)) return false;
    if (itemStatusFilter === "extra" && !(it.loaded > it.expected)) return false;
    if (itemUnitTab === "pallet" && !(palletsOfQty(it, unitBasisQty(it)) > 0)) return false;
    if (itemUnitTab === "loose" && !(looseOfQty(it, unitBasisQty(it)) > 0)) return false;
    if (itemSearchText.trim()) {
      const q = itemSearchText.trim().toLowerCase();
      const hay = `${it.itemName ?? ""} ${it.barcode ?? ""} ${it.sapCode ?? ""}`.toLowerCase();
      if (!hay.includes(q)) return false;
    }
    return true;
  }).sort((a, b) => {
    // "All" follows the proforma slip's own Sr. No. (C001, C002, …; numeric-aware so 2 < 10), so the
    // list reads in slip order. Pallet / Loose keep the newest-scanned-first order below.
    if (itemUnitTab === "all") {
      return compareSrNo(a.srNo, b.srNo) || a.id - b.id;
    }
    return (itemScanSeqRef.current.byId.get(b.id) ?? 0) - (itemScanSeqRef.current.byId.get(a.id) ?? 0);
  });

  // Items table — same shared DataTable (navy sticky header, resizable/sortable columns, totals
  // row) Order Scan and Unloading's own items tables use. Item Name and Barcode/SAP are merged
  // into one column (name on top, barcode · SAP underneath) rather than two separate ones.
  // Splits a qty into whole pallets + the leftover that doesn't fill one, instead of one combined
  // decimal ("2.33 plt") that makes the operator do the division themselves to see how much is a
  // clean pallet vs. loose boxes. On "All" both (non-zero) lines show, stacked, same as before;
  // on "Pallet"/"Loose" only that one line shows, matching the row-level filter above.
  const renderPalletLoose = (qty: number, ipp: number) => {
    if (ipp <= 0) return null;
    const pallets = Math.floor(qty / ipp);
    const loose = qty % ipp;
    return (
      <>
        {itemUnitTab !== "loose" && pallets > 0 && <span className="block text-sm font-semibold text-gray-400">{pallets} plt</span>}
        {itemUnitTab !== "pallet" && loose > 0 && <span className="block text-sm font-semibold text-gray-400">{loose} loose</span>}
      </>
    );
  };
  // Totals-row counterpart to renderPalletLoose: the column's qty summed, then whole pallets and
  // loose boxes each added up row by row at that row's OWN pallet size (never one blended size),
  // honoring the same All/Pallet/Loose tab as the cells above it.
  const renderPalletLooseTotal = (rows: ProformaItem[], pick: (row: ProformaItem) => number) => {
    let qty = 0;
    let pallets = 0;
    let loose = 0;
    for (const row of rows) {
      const q = pick(row);
      qty += q;
      const ipp = row.itemsPerPallet ?? 0;
      if (ipp <= 0) continue;
      pallets += Math.floor(q / ipp);
      loose += q % ipp;
    }
    // Pallets and loose share ONE smaller line under the total — stacked a line each, the totals
    // row grew three lines tall and took more room than any item row above it.
    const parts = [
      itemUnitTab !== "loose" && pallets > 0 ? `${pallets} plt` : null,
      itemUnitTab !== "pallet" && loose > 0 ? `${loose} loose` : null,
    ].filter(Boolean);
    return (
      <>
        <span className="block leading-tight">{qty}</span>
        {parts.length > 0 && (
          <span className="block whitespace-nowrap text-xs font-semibold leading-tight text-gray-500">{parts.join(" · ")}</span>
        )}
      </>
    );
  };

  // "All" shows the slip's Sr. No.; Pallet and Loose keep the per-item progress ring.
  const srColumn: DataTableColumn<ProformaItem> = {
    id: "srNo", header: "Sr", align: "center", width: 56, minWidth: 48, fixedWidth: true, sortable: true, totalable: false,
    accessor: (row) => row.srNo ?? "",
    cellClassName: "align-top px-1 text-xs font-semibold tabular-nums text-gray-600",
    headerClassName: "px-1",
    render: (row) => row.srNo || "—",
  };
  const progressColumn: DataTableColumn<ProformaItem> = {
      // Same ring pattern as Scan Order/Master View's own state column: one aggregate "% loaded"
      // ring in the header, each row gets its own ring showing that item's own % loaded.
      id: "pct",
      header: (
        <CircularProgress
          percent={itemTotals.expected > 0 ? Math.min(100, Math.round((itemTotals.loaded / itemTotals.expected) * 100)) : 0}
          size={20} strokeWidth={2} color="#38bdf8" textColor="#ffffff"
        />
      ),
      // align-top: the Item column next to this one stacks 2-3 lines (name/barcode-SAP/pack
      // size), which sets this row's height — align-middle's default then centered the ring in
      // all that leftover space, reading as "way too much empty space around a tiny ring." Top-
      // aligning it (matching where the Item column's own text starts) puts all the slack below
      // the ring instead of split evenly around it.
      // fixedWidth: stays 36px on any screen. Stretched in proportion with the other columns it
      // grew to ~95px of empty space around a 20px ring on a wide monitor.
      width: 36, minWidth: 36, fixedWidth: true, align: "center", cellClassName: "align-top px-1", headerClassName: "px-1", sortable: false, totalable: false,
      render: (row) => {
        const pct = row.expected > 0 ? Math.min(100, Math.round((row.loaded / row.expected) * 100)) : (row.loaded > 0 ? 100 : 0);
        return <CircularProgress percent={pct} size={20} strokeWidth={2} />;
      },
  };
  const loadingItemColumns: DataTableColumn<ProformaItem>[] = [
    itemUnitTab === "all" ? srColumn : progressColumn,
    {
      // minWidth kept low (not the ~180 a stacked name+barcode+pallet cell would suggest) so the
      // resize grip can actually shrink this column — DataTable floors a drag at minWidth, and a
      // high floor there is exactly what made this column impossible to narrow.
      // align:"center" centers the HEADER label; cellClassName's text-left overrides the
      // auto-applied text-center on the cell itself (DataTable's cn() twMerges the two, so the
      // later one — cellClassName — wins), same header-centered/cell-left split the user wants
      // only on this column, not the numeric ones.
      id: "item", header: "Item Name", align: "center", width: 150, minWidth: 90, sortable: true,
      accessor: (row) => `${row.itemName ?? ""} ${row.barcode ?? ""} ${row.sapCode ?? ""}`,
      cellClassName: "whitespace-normal break-words text-left text-gray-700 text-xs sm:text-xs leading-tight",
      totalable: false,
      render: (row) => (
        <div className="flex items-start gap-2">
          {/* Product picture — tap it to see it enlarged (the row itself expands the item history). */}
          <ItemRowThumb name={row.itemName} />
          <div className="min-w-0">
            <span className="font-medium text-gray-900">{row.itemName ?? "—"}</span>
            {(row.stockAvailable ?? 0) <= 0 && <span className="ml-1.5 rounded-full bg-red-100 px-1 py-px text-[8px] font-bold text-red-700">NO STOCK</span>}
            {row.isComplete && <CheckCircle2 className="ml-1.5 inline h-3 w-3 text-emerald-600" />}
            <p className="font-mono text-[10px] leading-tight text-gray-400">
              {row.barcode || "—"}{row.sapCode && ` · SAP ${row.sapCode}`}
            </p>
            {(row.itemsPerPallet ?? 0) > 0 && <p className="text-[10px] font-semibold leading-tight text-gray-500">{row.itemsPerPallet} per pallet</p>}
          </div>
        </div>
      ),
    },
    {
      id: "expected", header: "Expected", align: "center", width: 58, minWidth: 55, sortable: true,
      accessor: (row) => row.expected,
      total: (rows) => renderPalletLooseTotal(rows, (r) => r.expected),
      cellClassName: "text-gray-700 text-sm sm:text-sm",
      render: (row) => (
        <>
          <span className="block">{row.expected}</span>
          {renderPalletLoose(row.expected, row.itemsPerPallet ?? 0)}
        </>
      ),
    },
    {
      // No dedicated Extra column — extra only ever happens through the separate Add Extra flow
      // (see EXTRA_NOT_ALLOWED in server/routes/loading.ts), so it stays a rare inline note on
      // Loaded rather than a column that's blank for almost every row.
      id: "loaded", header: "Loaded", align: "center", width: 104, minWidth: 96, sortable: true,
      accessor: (row) => row.loaded,
      total: (rows) => renderPalletLooseTotal(rows, (r) => r.loaded),
      cellClassName: "font-medium text-gray-900 text-sm sm:text-sm",
      render: (row) => {
        const extra = Math.max(0, row.loaded - row.expected);
        return (
          <div className="flex items-center justify-center gap-1">
            {canScanThisLoad && row.barcode && (
              <Button
                size="sm" variant="ghost"
                className="h-7 w-7 shrink-0 rounded-full p-0 text-sm font-bold bg-red-100 text-red-700 hover:bg-red-200 hover:text-red-800 disabled:opacity-40"
                disabled={row.loaded <= 0}
                title="Remove from loaded quantity"
                onClick={(e) => { e.stopPropagation(); openAdjustDialog(row, "remove"); }}
              >
                −
              </Button>
            )}
            <span>
              <span className="block">{row.loaded}</span>
              {renderPalletLoose(row.loaded, row.itemsPerPallet ?? 0)}
              {extra > 0 && <span className="block text-xs font-bold text-amber-600">+{extra} extra</span>}
            </span>
            {canScanThisLoad && row.barcode && (
              <Button
                size="sm" variant="ghost"
                className="h-7 w-7 shrink-0 rounded-full p-0 text-sm font-bold bg-emerald-100 text-emerald-700 hover:bg-emerald-200 hover:text-emerald-800"
                title="Add to loaded quantity"
                onClick={(e) => { e.stopPropagation(); openAdjustDialog(row, "add"); }}
              >
                +
              </Button>
            )}
          </div>
        );
      },
    },
    {
      id: "remaining", header: "Remaining", align: "center", width: 62, minWidth: 55, sortable: true,
      accessor: (row) => row.remaining,
      total: (rows) => renderPalletLooseTotal(rows, (r) => r.remaining),
      cellClassName: "text-gray-700 text-sm sm:text-sm",
      render: (row) => (
        <>
          <span className="block">{row.remaining}</span>
          {renderPalletLoose(row.remaining, row.itemsPerPallet ?? 0)}
        </>
      ),
    },
    {
      id: "stock", header: "Stock", align: "center", width: 62, minWidth: 55, sortable: true, totalable: false,
      cellClassName: "text-sm sm:text-sm",
      accessor: (row) => row.stockAvailable ?? 0,
      render: (row) => {
        const outOfStock = (row.stockAvailable ?? 0) <= 0;
        return (
          <>
            <span className={`block ${outOfStock ? "font-semibold text-red-600" : "text-gray-500"}`}>{row.stockAvailable ?? "—"}</span>
            {renderPalletLoose(row.stockAvailable ?? 0, row.itemsPerPallet ?? 0)}
          </>
        );
      },
    },
  ];

  // Same "Export" affordance Order Scan/Master View offer on their own items tables — a plain
  // client-side CSV of whatever's currently filtered/searched, not just the full unfiltered set.
  function downloadLoadingItemsCsv() {
    const headers = ["SKU", "Item Name", "Expected", "Loaded", "Remaining", "Stock"];
    const rows = filteredItems.map((it) => [it.barcode ?? "", it.itemName ?? "", it.expected, it.loaded, it.remaining, it.stockAvailable ?? ""]);
    const csv = [headers, ...rows].map((r) => r.map((v) => `"${String(v).replace(/"/g, '""')}"`).join(",")).join("\n");
    const a = document.createElement("a");
    a.href = URL.createObjectURL(new Blob([csv], { type: "text/csv;charset=utf-8;" }));
    a.download = `${slip?.orderNumber ?? "loading"}-items.csv`;
    a.click();
    URL.revokeObjectURL(a.href);
  }

  // Column defs for the per-item scan history drill-down — a real DataTable (drag-to-resize,
  // same as every other table on this page) instead of a plain fixed-width <table>, which is
  // also what silently dropped STV: its header existed but nothing rendered a matching <td>,
  // since a plain table has no single source of truth tying a header to its own cell.
  const loadingItemHistoryColumns: DataTableColumn<LoadHistoryEvent>[] = [
    {
      id: "scannedAt", header: "Date & Time", width: 170, minWidth: 120, sortable: false, totalable: false,
      accessor: (ev) => ev.scannedAt,
      render: (ev) => <span className="whitespace-nowrap text-gray-600">{new Date(ev.scannedAt).toLocaleString("en-IN", { timeZone: "Asia/Kolkata" })}</span>,
    },
    {
      id: "scannedByName", header: "Scanned By", width: 140, minWidth: 80, totalable: false,
      accessor: (ev) => ev.scannedByName ?? "",
      render: (ev) => <span className="truncate text-gray-600">{ev.scannedByName ?? "—"}</span>,
    },
    {
      id: "totalQty", header: "Qty", width: 70, minWidth: 50, align: "right", totalable: false,
      accessor: (ev) => ev.totalQty,
      render: (ev) => (
        <span className={`inline-flex items-center justify-center rounded-full px-2 py-0.5 text-[11px] font-bold ${ev.isExtra ? "bg-amber-100 text-amber-700" : "bg-[#001d6e]/10 text-[#001d6e]"}`}>
          {(ev.isExtra || ev.isAdjust) && ev.totalQty > 0 ? "+" : ""}{ev.totalQty}
        </span>
      ),
    },
    {
      id: "stv", header: "Dispatch Directory", width: 70, minWidth: 50, totalable: false,
      accessor: (ev) => ev.stv ?? "",
      render: (ev) => <span className="text-[11px] text-gray-600">{ev.stv ?? "—"}</span>,
    },
    {
      id: "status", header: "Status", width: 90, minWidth: 60, totalable: false,
      accessor: (ev) => (ev.voided ? "Voided" : ev.isAdjust ? "Loading Adjust" : ev.isExtra ? "Extra" : ""),
      render: (ev) =>
        ev.voided ? (
          <span className="text-[11px] font-medium text-red-500">Voided</span>
        ) : ev.isAdjust ? (
          <span className="whitespace-nowrap text-[11px] font-semibold uppercase text-blue-700">Loading Adjust</span>
        ) : ev.isExtra ? (
          <span className="text-[11px] font-semibold uppercase text-amber-700">Extra</span>
        ) : (
          <span className="text-[11px] text-gray-400">—</span>
        ),
    },
    ...(canResetLoad ? [{
      id: "void", header: "", width: 56, minWidth: 56, align: "right" as const, hideable: false, totalable: false,
      render: (ev: LoadHistoryEvent) =>
        !ev.voided ? (
          <Button size="sm" variant="ghost" className="h-6 w-6 p-0 text-gray-400 hover:bg-red-50 hover:text-red-600"
            onClick={() => setVoidTarget(ev)} title="Void this scan">
            <Trash2 className="h-3.5 w-3.5" />
          </Button>
        ) : null,
    } satisfies DataTableColumn<LoadHistoryEvent>] : []),
  ];

  function renderLoadingItemHistoryPanel(item: ProformaItem) {
    const itemEvents = (orderLoadHistoryQuery.data?.items ?? []).filter((ev) => normalize(ev.barcode) === normalize(item.barcode));
    return (
      <div className="border-b border-gray-200 bg-gray-50 p-3">
        {orderLoadHistoryQuery.isLoading ? (
          <SectionSkeleton lines={3} />
        ) : (
          <DataTable<LoadHistoryEvent>
            containerClassName="border border-gray-200 bg-white"
            columns={loadingItemHistoryColumns}
            data={itemEvents}
            getRowId={(ev) => String(ev.id)}
            rowClassName={(ev) => (ev.voided ? "opacity-60" : undefined)}
            enableColumnResizing
            enableZebraStripes
            maxHeight="15rem"
            isStickyHeader
            emptyState="No scan history for this item yet."
            showMobileSwipeHint
          />
        )}
      </div>
    );
  }

  // Purely informational (never blocks scanning) — the order's own required volume (Product
  // Master, summed at import/scan time) vs. the linked vehicle's capacity (Vehicle Master).
  const isOverCapacity =
    slip?.vehicleVolume != null &&
    Number.isFinite(parseFloat(slip.totalVolume ?? "")) &&
    parseFloat(slip.totalVolume ?? "") > slip.vehicleVolume;

  // Items + Total Qty + Order Volume are always shown; Loaded Volume once a vehicle's linked,
  // Vehicle Capacity once it resolves in Vehicle Master — drives the stat grid's column count.
  const statColumnCount = 3 + (slip?.vehicleNumber ? 1 : 0) + (slip?.vehicleVolume != null ? 1 : 0);

  // Same page shell Load Operations uses  // Same page shell Load Operations uses — full width, px-2 py-6, space-y-6 between blocks (its
  // own wrapper is a container-fluid, which is a no-op here) — kept inside this page's scroll
  // container so the app shell still scrolls it the same way.
  return (
    <div className={`flex-1 px-2 pt-1 pb-4 ${view === "create" ? "overflow-hidden" : "overflow-y-auto"}`}>
      <div className={`w-full ${view === "create" ? "h-full" : "space-y-6"}`}>
        {/* ── Landing view — mirrors Load Operations' layout exactly: full-width search, a
             filter row (date + plant + status counters), status tabs, then a desktop table with
             a mobile card list below it. Same kiosk-rotate treatment the scan view has, so a
             wall-mounted station can rotate the landing list too, not just an open order. ──── */}
        {view === "list" && (
          <div className={`space-y-6 ${kioskRotateClass} ${rotated ? "bg-[#f4f5f7] p-4" : ""}`}>
            <PageScrollButtons />
            {/* Page header only on the list — nothing there competes with it for room. The
                create/scan view (an open order, often with many items to scroll through) skips
                it entirely instead; that view's only collapsible header now is the global
                "Welcome" bar (Layout.tsx's HEADER_HIDEABLE_PATHS), not this one. */}
            {/* Same name and icon as this page's sidebar entry ("Load Operations", the factory).
                Sticky: the header stays at the top while the list scrolls underneath it. */}
            <div className="sticky top-0 z-20 -mx-2 bg-[#f4f5f7] px-2 pt-1 pb-2">
            <PageHeader
              icon={Factory}
              iconClassName="h-5 w-5 fill-[#4d7eff]"
              title="Load Operations"
              description="Scan or search a proforma slip, then link a vehicle and scan its items onto it."
              actions={
                <div className="flex items-center gap-2">
                  {/* Reloads the records list and the open order's data now. The open order already
                      refreshes every 15 seconds on its own; the records list does not, so use this. */}
                  <Button
                    type="button"
                    variant="outline"
                    size="icon"
                    className="h-10 w-10 shrink-0 rounded-lg"
                    title="Refresh now"
                    onClick={() => queryClient.invalidateQueries({
                      predicate: (q) => {
                        const key = String(q.queryKey[0] ?? "");
                        return key.startsWith("/api/loading") || key.startsWith("/api/sort-slips") || key.startsWith("/api/scan-sessions/reports/scan-history") || key.startsWith("/api/order-scan/stvs");
                      },
                    })}
                  >
                    <RotateCw className={`h-4 w-4 ${recordsQuery.isFetching ? "animate-spin" : ""}`} />
                  </Button>
                  {canWrite && (
                    <Button
                      className="h-10 shrink-0 rounded-lg bg-[#001d6e] px-4 text-sm font-semibold text-white hover:bg-[#00154b]"
                      onClick={openOrderSearch}
                    >
                      <Plus className="mr-1.5 h-4 w-4" /> Load Operation
                    </Button>
                  )}
                </div>
              }
            />
            </div>
            {canWrite && (
              // A popup, not an inline card — this page is opened for the records table, and the
              // order search is something you deliberately start (the toolbar button below, or a
              // gun scan, which opens this same dialog with what was scanned already filled in).
              <Dialog open={searchOpen} onOpenChange={(o) => { if (!o) closeOrderSearch(); }}>
                <DialogContent className="sm:max-w-lg">
                  <DialogHeader>
                    <DialogTitle className="flex items-center gap-1.5">
                      <Search className="h-4 w-4" /> Find or scan an order
                    </DialogTitle>
                    <DialogDescription>
                      Scan with the gun, use the camera, or type an order number / party name.
                    </DialogDescription>
                  </DialogHeader>
                  <div className="space-y-3">
                  <div className="flex overflow-hidden rounded-xl border border-gray-300 divide-x divide-gray-300 bg-white">
                    <button
                      onClick={() => setScanMode("camera")}
                      className={`flex-1 flex items-center justify-center gap-1.5 py-2.5 text-sm font-semibold transition-colors ${scanMode === "camera" ? "bg-[#001d6e] text-white" : "text-gray-500 hover:bg-gray-50"}`}
                    >
                      <Camera className="h-4 w-4" /> Camera
                    </button>
                    <button
                      onClick={() => { stopCamera(); setScanMode("manual"); }}
                      className={`flex-1 flex items-center justify-center gap-1.5 py-2.5 text-sm font-semibold transition-colors ${scanMode === "manual" ? "bg-[#001d6e] text-white" : "text-gray-500 hover:bg-gray-50"}`}
                    >
                      <Keyboard className="h-4 w-4" /> Manual
                    </button>
                  </div>
                  <p className="text-[11px] text-gray-400">A barcode gun works in Manual mode too — just scan, no need to click the box first.</p>

                  <div className="relative w-full bg-black rounded-2xl overflow-hidden" style={{ display: scanMode === "camera" ? "block" : "none", height: "clamp(220px, 45vw, 340px)" }}>
                    <video ref={videoRef} autoPlay muted playsInline className="absolute inset-0 h-full w-full object-cover" />
                    <div className="pointer-events-none absolute inset-0" style={{ background: "radial-gradient(ellipse 70% 55% at 50% 50%, transparent 55%, rgba(0,0,0,0.55) 100%)" }} />
                    {scanMode === "camera" && !cameraReady && !cameraError && (
                      <div className="absolute inset-0 flex flex-col items-center justify-center gap-2 text-white z-10">
                        <Loader2 className="h-8 w-8 animate-spin opacity-90" />
                        <p className="text-sm font-medium opacity-80">Starting camera…</p>
                      </div>
                    )}
                    {scanMode === "camera" && cameraReady && (
                      <div className="pointer-events-none absolute inset-0 flex items-center justify-center z-10">
                        {(["tl", "tr", "bl", "br"] as const).map((pos) => (
                          <div key={pos} className="absolute" style={{
                            top: pos.startsWith("t") ? "calc(50% - 40px)" : undefined, bottom: pos.startsWith("b") ? "calc(50% - 40px)" : undefined,
                            left: pos.endsWith("l") ? "calc(50% - 90px)" : undefined, right: pos.endsWith("r") ? "calc(50% - 90px)" : undefined,
                            width: 22, height: 22, borderColor: "white", borderStyle: "solid",
                            borderTopWidth: pos.startsWith("t") ? 3 : 0, borderBottomWidth: pos.startsWith("b") ? 3 : 0,
                            borderLeftWidth: pos.endsWith("l") ? 3 : 0, borderRightWidth: pos.endsWith("r") ? 3 : 0,
                            borderRadius: pos === "tl" ? "4px 0 0 0" : pos === "tr" ? "0 4px 0 0" : pos === "bl" ? "0 0 0 4px" : "0 0 4px 0",
                          }} />
                        ))}
                      </div>
                    )}
                    {scanMode === "camera" && cameraError && (
                      <div className="absolute bottom-0 left-0 right-0 flex items-center gap-2 bg-red-900/85 px-3 py-2.5 text-xs text-white z-10">
                        <AlertTriangle className="h-3.5 w-3.5 shrink-0" /> {cameraError}
                      </div>
                    )}
                  </div>

                  {scanMode === "manual" && (
                    <div className="relative">
                      <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-gray-400" />
                      <Input
                        ref={orderInputRef}
                        // This input auto-focuses as soon as the list view opens, ready for the
                        // barcode gun — inputMode="none" keeps it focusable (so the gun's
                        // keystrokes land here) without popping the on-screen keyboard. A real
                        // tap flips it to "text" (written straight to the DOM node so it takes
                        // effect before that same tap's own focus event, showing the keyboard on
                        // the first tap rather than a second one) and it reverts to "none" on
                        // blur, so the next auto-focus starts blocked again.
                        inputMode="none"
                        onPointerDown={(e) => { (e.currentTarget as HTMLInputElement).inputMode = "text"; }}
                        value={orderSearch}
                        onChange={(e) => { setOrderSearch(e.target.value); setOrderSuggIdx(-1); }}
                        onFocus={() => setOrderFocused(true)}
                        onBlur={(e) => { (e.currentTarget as HTMLInputElement).inputMode = "none"; setTimeout(() => setOrderFocused(false), 150); }}
                        onKeyDown={(e) => {
                          if (orderFocused && orderSuggestions.length > 0) {
                            if (e.key === "ArrowDown") { e.preventDefault(); setOrderSuggIdx((i) => Math.min(i + 1, orderSuggestions.length - 1)); return; }
                            if (e.key === "ArrowUp") { e.preventDefault(); setOrderSuggIdx((i) => Math.max(i - 1, -1)); return; }
                            if (e.key === "Escape") { setOrderFocused(false); return; }
                            if (e.key === "Enter" && orderSuggIdx >= 0) { e.preventDefault(); openOrder(orderSuggestions[orderSuggIdx].orderNumber, { confirm: true }); return; }
                          }
                          if (e.key === "Enter") openOrder(orderSearch, { confirm: true });
                        }}
                        placeholder="Type an order number / party name…"
                        className="h-11 pl-9 pr-9 text-sm"
                      />
                      {orderSearch && (
                        <button onClick={() => { setOrderSearch(""); orderInputRef.current?.focus(); }} className="absolute right-3 top-1/2 -translate-y-1/2 text-gray-400 hover:text-gray-600">
                          <X className="h-4 w-4" />
                        </button>
                      )}
                      {orderFocused && debouncedOrderSearch.trim().length >= 2 && (
                        <div className="absolute z-20 mt-1 w-full rounded-lg border border-gray-200 bg-white shadow-lg overflow-hidden">
                          {orderSuggestionsQuery.isFetching ? (
                            <SectionSkeleton lines={2} />
                          ) : orderSuggestions.length === 0 ? (
                            <p className="px-4 py-3 text-xs text-gray-400">No matching orders.</p>
                          ) : (
                            orderSuggestions.map((s, i) => (
                              <button
                                key={s.id}
                                onMouseDown={(e) => e.preventDefault()}
                                onClick={() => openOrder(s.orderNumber, { confirm: true })}
                                className={`flex w-full items-center justify-between gap-2 px-4 py-2.5 text-left border-b border-gray-100 last:border-0 ${i === orderSuggIdx ? "bg-[#001d6e]/10" : "hover:bg-[#001d6e]/5"}`}
                              >
                                <div className="min-w-0">
                                  <div className="text-sm font-semibold text-[#001d6e] truncate">#{s.orderNumber}</div>
                                  <div className="text-xs text-gray-500 truncate">{s.partyName}{s.plant ? ` · ${s.plant}` : ""}</div>
                                </div>
                                <ChevronRight className="h-4 w-4 shrink-0 text-gray-300" />
                              </button>
                            ))
                          )}
                        </div>
                      )}
                    </div>
                  )}

                  <Button className="w-full h-10 bg-[#001d6e] text-white hover:bg-[#001552]"
                    disabled={!orderSearch.trim() || fetchSlipMutation.isPending}
                    onClick={() => openOrder(orderSearch, { confirm: true })}>
                    {fetchSlipMutation.isPending ? <Loader2 className="mr-1.5 h-4 w-4 animate-spin" /> : null}
                    Find Order
                  </Button>
                  </div>
                </DialogContent>
              </Dialog>
            )}
            {fetchSlipMutation.isPending ? (
                        <div className="space-y-4 skeleton-wave">
                          <div className="rounded-xl border border-gray-200 bg-white shadow-sm">
                            <div className="flex flex-col gap-3 px-4 sm:px-5 py-3.5 border-b border-gray-100 sm:flex-row sm:items-center sm:justify-between">
                              <div className="min-w-0 space-y-2">
                                <div className="h-4 w-40 rounded bg-gray-200" />
                                <div className="h-3 w-56 rounded bg-gray-100" />
                              </div>
                              <div className="flex items-center gap-2">
                                <div className="h-8 w-24 rounded-full bg-gray-100" />
                                <div className="h-8 w-24 rounded-full bg-gray-100" />
                                <div className="h-9 w-24 rounded-lg bg-gray-100" />
                              </div>
                            </div>
                          </div>
                          <div className="grid grid-cols-1 gap-3 lg:grid-cols-[38%_0.75rem_1fr]">
                            <div className="h-40 rounded-xl border border-gray-200 bg-white shadow-sm" />
                            <div className="hidden lg:block" />
                            <div className="h-40 rounded-xl border border-gray-200 bg-white shadow-sm" />
                          </div>
                          <div className="overflow-hidden rounded-xl border border-gray-200 bg-white shadow-sm">
                            <div className="flex items-center gap-2 border-b border-gray-100 px-4 sm:px-5 py-3.5">
                              <div className="h-4 w-32 rounded bg-gray-200" />
                            </div>
                            <div className="divide-y divide-gray-100">
                              {Array.from({ length: 6 }).map((_, i) => (
                                <div key={i} className="flex items-center gap-4 px-4 sm:px-5 py-3">
                                  <div className="h-3.5 flex-1 rounded bg-gray-100" />
                                  <div className="h-3.5 w-14 rounded bg-gray-100" />
                                  <div className="h-3.5 w-14 rounded bg-gray-100" />
                                  <div className="h-3.5 w-14 rounded bg-gray-100" />
                                </div>
                              ))}
                            </div>
                          </div>
                        </div>
            ) : (
              <>
            {/* Search bar (desktop) */}
            <div className={`w-full ${bigView ? "hidden" : "hidden xl:block"}`}>
              <Input
                placeholder="Search by order number, party name, vehicle or status..."
                value={listSearch}
                onChange={(e) => setListSearch(e.target.value)}
                className="w-full"
              />
            </div>

            {/* One stable toolbar for calendar, filters, statuses, and the primary action.
                Wraps onto a second row on a narrow screen instead of scrolling horizontally —
                every button stays visible without needing a left/right scroll to reach any of
                them, at the cost of the toolbar sometimes being two rows tall on mobile. */}
            <div className="flex flex-wrap items-center gap-2">
              <div className="shrink-0">
                <SingleDateFilter
                  pageKey="loading-page"
                  selectedDate={selectedDate}
                  onDateChange={(date: Date | null) => setSelectedDate(date)}
                />
              </div>

              <PlantFilter
                selectedPlants={selectedPlants}
                onPlantChange={setSelectedPlants}
                plantOptions={plantOptions}
              />

              <Select
                value={`${sortBy}:${sortOrder}`}
                onValueChange={(value) => {
                  const [column, direction] = value.split(":") as ["orderNumber" | "creationDate", "asc" | "desc"];
                  setSortBy(column);
                  setSortOrder(direction);
                }}
              >
                <SelectTrigger className="h-9 w-[180px] text-xs" aria-label="Sort loading slips">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="orderNumber:asc">Order No. — Ascending</SelectItem>
                  <SelectItem value="orderNumber:desc">Order No. — Descending</SelectItem>
                  <SelectItem value="creationDate:asc">Load Date — Ascending</SelectItem>
                  <SelectItem value="creationDate:desc">Load Date — Descending</SelectItem>
                </SelectContent>
              </Select>

              <AddColumnFilterButton
                columns={recordFilterColumns}
                conditions={recordColumnConditions}
                onApply={setRecordCondition}
                onClear={clearRecordCondition}
                className="h-9 gap-1 rounded-md border-dashed border-[#001d6e]/40 bg-white text-xs font-medium text-[#001d6e] hover:bg-[#001d6e]/5 hover:text-[#001d6e]"
              />
              {Object.entries(recordColumnConditions).map(([id, condition]) => (
                <ColumnFilterChipView
                  key={id}
                  columnId={id}
                  condition={condition}
                  columns={recordFilterColumns}
                  onEdit={(c) => setRecordCondition(id, c)}
                  onRemove={() => clearRecordCondition(id)}
                />
              ))}
              {Object.keys(recordColumnConditions).length > 1 && (
                <Button
                  size="sm" variant="ghost" className="h-9 px-2 text-xs text-gray-500 hover:text-[#001d6e]"
                  onClick={() => setRecordColumnConditions({})}
                >
                  Clear all
                </Button>
              )}

              <div className="grid shrink-0 grid-cols-4 gap-2">
                <Button
                  variant="outline"
                  size="sm"
                  className="h-auto min-w-0 justify-start bg-gray-50 px-2 py-1.5 hover:bg-gray-100 sm:px-3"
                  onClick={() => setActiveViewTab("overall")}
                >
                  <Layers className="mr-1.5 h-4 w-4 shrink-0 text-gray-700 sm:mr-2" />
                  <div className="flex flex-col items-start">
                    <span className="whitespace-nowrap text-xs font-bold">SLIPS</span>
                    <span className="text-sm font-semibold">{slipsCount}</span>
                  </div>
                </Button>
                <Button
                  variant="outline"
                  size="sm"
                  className="h-auto min-w-0 justify-start bg-blue-50 px-2 py-1.5 hover:bg-blue-100 sm:px-3"
                  onClick={() => setActiveViewTab("loading")}
                >
                  <Truck className="mr-1.5 h-4 w-4 shrink-0 text-blue-600 sm:mr-2" />
                  <div className="flex flex-col items-start">
                    <span className="whitespace-nowrap text-xs font-bold">LOADING</span>
                    <span className="text-sm font-semibold">{inProgressCount}</span>
                  </div>
                </Button>
                <Button
                  variant="outline"
                  size="sm"
                  className="h-auto min-w-0 justify-start bg-amber-50 px-2 py-1.5 hover:bg-amber-100 sm:px-3"
                  onClick={() => setActiveViewTab("ready-desp")}
                >
                  <Truck className="mr-1.5 h-4 w-4 shrink-0 text-amber-600 sm:mr-2" />
                  <div className="flex flex-col items-start">
                    <span className="whitespace-nowrap text-xs font-bold">READY≈DESP</span>
                    <span className="text-sm font-semibold">{readyDespCount}</span>
                  </div>
                </Button>
                {/* One click: only the slips THIS user created (link-vehicle's created_by_code),
                    newest first — toggles off back to everyone's, same sort/filter either way. */}
                <Button
                  variant="outline"
                  size="sm"
                  className={`h-auto min-w-0 justify-start px-2 py-1.5 sm:px-3 ${createdByMe ? "bg-emerald-100 hover:bg-emerald-200" : "bg-emerald-50 hover:bg-emerald-100"}`}
                  onClick={() => {
                    setCreatedByMe((p) => !p);
                    setSortBy("creationDate");
                    setSortOrder("desc");
                  }}
                >
                  <UserCircle2 className="mr-1.5 h-4 w-4 shrink-0 text-emerald-700 sm:mr-2" />
                  <div className="flex flex-col items-start">
                    <span className="whitespace-nowrap text-xs font-bold">MY SLIPS</span>
                    <span className="text-sm font-semibold">{createdByMe ? "On" : "Off"}</span>
                  </div>
                </Button>
              </div>
            </div>

            {/* Navigation Tabs (hidden on mobile) */}
            <div className={`mb-2 ${bigView ? "hidden" : "hidden xl:block"}`}>
              <Tabs value={activeViewTab} onValueChange={setActiveViewTab} className="w-full">
                <TabsList className="w-full justify-start">
                  <TabsTrigger value="overall" className="flex-1 max-w-[200px]">All Operations</TabsTrigger>
                  <TabsTrigger value="loading" className="flex-1 max-w-[200px]">Loading</TabsTrigger>
                  <TabsTrigger value="ready-desp" className="flex-1 max-w-[200px]">Ready for Dispatch</TabsTrigger>
                </TabsList>
              </Tabs>
            </div>

            {/* Compact search row (below xl) — the filter row above still covers Date/Plant/
                Status at every width; this is just listSearch's own box at narrower widths. */}
            <div className={`flex gap-2 ${bigView ? "" : "xl:hidden"}`}>
              <Input
                placeholder="Search order, party, vehicle..."
                value={listSearch}
                onChange={(e) => setListSearch(e.target.value)}
                className="flex-1"
              />
            </div>

            {recordsQuery.isLoading ? (
              <SectionSkeleton lines={6} />
            ) : filteredRecords.length === 0 ? (
              <div className="flex flex-col items-center justify-center py-16 text-center border rounded-md">
                <div className="mb-3 flex h-14 w-14 items-center justify-center rounded-full bg-[#001d6e]/10">
                  <Truck className="h-7 w-7 text-[#001d6e]/40" />
                </div>
                <div className="mb-1 text-sm font-semibold text-[#001d6e]">
                  {!listFiltersActive ? "No loading slips yet" : "No slips match these filters"}
                </div>
                <p className="mb-4 max-w-xs text-xs text-muted-foreground">
                  {!listFiltersActive
                    ? (canWrite ? "Start a new load to scan a proforma slip and link it to a vehicle." : "Nothing has been loaded yet.")
                    : "Try clearing the search, date or plant filter."}
                </p>
              </div>
            ) : (
              <>
                {/* Desktop View - Loading Slips Table. overflow-x-auto is a safety net, not the
                    primary fit strategy — Vehicle/RTO is merged into one stacked cell (below,
                    Order/Load Date used to be merged the same way too, but that hid Load Date
                    from its own column filter/sort and was split back out on request)
                    specifically so this fits comfortably. The switch point is xl (1280px), not
                    lg (1024px), because the app's own sidebar eats ~256px of viewport width when
                    open — a "1100px" browser window can really only offer this table ~850px,
                    well short of what 12 columns need — so this table only shows once there's
                    enough SPARE width to survive that; anything narrower gets the card list
                    instead (see the xl:hidden card view further down), which never scrolls
                    horizontally at all. */}
                <div className={`border rounded-md w-full overflow-x-auto ${bigView ? "hidden" : "hidden xl:block"}`}>
                  {/* [&_th]/[&_td]:px-2 shrinks this table's own cell padding from the shared
                      Table component's default px-4 — 12 columns × 16px saved per side adds up
                      to over 150px, which is what was pushing "Actions" past the edge at
                      ~1024-1100px laptop widths even after merging Vehicle/RTO into a single
                      cell. Scoped to this table only via the descendant selector — doesn't touch
                      the shared component or any other table on the site. */}
                  <Table className="[&_th]:px-2 [&_td]:px-2">
                    <TableHeader>
                      {/* Same navy/white uppercase header every other table on the site uses,
                          instead of the plain shadcn default (muted-gray text on white) — makes
                          the header read as a header rather than blending into the rows. */}
                      <TableRow className="border-b border-white/20 bg-[#001d6e] hover:bg-[#001d6e]">
                        <TableHead className="text-[11px] font-semibold uppercase tracking-wide text-white" title="The proforma slip's own order date">{recordColumnHeader("orderDate", "Order Date")}</TableHead>
                        <TableHead className="text-[11px] font-semibold uppercase tracking-wide text-white" title="When this load operation was started">{recordColumnHeader("loadDate", "Load Date")}</TableHead>
                        <TableHead className="text-[11px] font-semibold uppercase tracking-wide text-white">{recordColumnHeader("orderNumber", "Order Number")}</TableHead>
                        <TableHead className="text-[11px] font-semibold uppercase tracking-wide text-white">{recordColumnHeader("party", "Party Name")}</TableHead>
                        <TableHead className="text-[11px] font-semibold uppercase tracking-wide text-white">{recordColumnHeader("plant", "Plant")}</TableHead>
                        <TableHead className="text-[11px] font-semibold uppercase tracking-wide text-white" title="Vehicle number (top) and RTO number (below)">{recordColumnHeader("vehicle", "Vehicle No.")}</TableHead>
                        <TableHead className="text-[11px] font-semibold uppercase tracking-wide text-white" title="The Dispatch Directory this load was started on — set once at Create Operation">{recordColumnHeader("stv", "Dispatch Directory")}</TableHead>
                        <TableHead className="text-[11px] font-semibold uppercase tracking-wide text-white">{recordColumnHeader("status", "Status")}</TableHead>
                        <TableHead className="text-[11px] font-semibold uppercase tracking-wide text-white" title="Whoever currently has the right to scan this load">{recordColumnHeader("owner", "Current Owner")}</TableHead>
                        <TableHead className="text-[11px] font-semibold uppercase tracking-wide text-white" title="Time from when the vehicle was linked to when the load was marked complete">Time Taken</TableHead>
                        <TableHead className="text-[11px] font-semibold uppercase tracking-wide text-white" title="Who marked this load complete — the Complete button, or the scan that finished it">{recordColumnHeader("completedBy", "Completed By")}</TableHead>
                        <TableHead className="text-[11px] font-semibold uppercase tracking-wide text-white">{recordColumnHeader("creator", "Creator")}</TableHead>
                        <TableHead className="text-right text-[11px] font-semibold uppercase tracking-wide text-white">Actions</TableHead>
                      </TableRow>
                    </TableHeader>
                    <TableBody>
                      {filteredRecords.map((r) => {
                        return (
                          <Fragment key={r.id}>
                            {/* A plain row: the click-to-open History / Owners panel was removed on
                                request. The row's own action buttons are still the way in. */}
                            <TableRow>
                              <TableCell>
                                {r.orderDate
                                  ? new Date(`${String(r.orderDate).slice(0, 10)}T00:00:00`).toLocaleDateString("en-IN", { timeZone: "Asia/Kolkata", day: "2-digit", month: "2-digit", year: "numeric" })
                                  : "-"}
                              </TableCell>
                              <TableCell>
                                {new Date(r.createdAt).toLocaleDateString("en-IN", { timeZone: "Asia/Kolkata", day: "2-digit", month: "2-digit", year: "numeric" })}
                              </TableCell>
                              <TableCell>#{r.orderNumber}</TableCell>
                              <TableCell>{r.partyName || "-"}</TableCell>
                              <TableCell>{r.plant ? <PlantBadge plant={r.plant} /> : "-"}</TableCell>
                              <TableCell>
                                <div className="flex flex-col">
                                  <span>{r.vehicleNumber || "-"}</span>
                                  {r.rtoNumber && <span className="text-xs text-muted-foreground">RTO: {r.rtoNumber}</span>}
                                </div>
                              </TableCell>
                              <TableCell>
                                {r.loadingStv
                                  ? <span className="inline-flex items-center whitespace-nowrap rounded-full border border-[#001d6e] bg-[#001d6e]/5 px-2 py-0.5 text-xs font-semibold text-[#001d6e]">{r.loadingStv}</span>
                                  : <span className="text-muted-foreground">-</span>}
                              </TableCell>
                              <TableCell>
                                <Badge className={recordStatusBadgeClass(r)}>
                                  {recordStatus(r)}
                                </Badge>
                              </TableCell>
                              <TableCell onClick={(e) => e.stopPropagation()}>
                                {r.loadingCompletedAt ? (
                                  "-"
                                ) : r.loadingPausedAt ? (
                                  <div className="flex flex-col gap-1">
                                    <span className="text-xs text-amber-700">Paused · {r.loadingOwnerName ?? r.loadingOwnerCode ?? "—"}</span>
                                    {canWrite && (
                                      <Button
                                        size="sm"
                                        className="h-6 w-fit rounded-full bg-amber-500 px-2.5 text-[11px] text-white hover:bg-amber-600"
                                        disabled={claimLoadMutation.isPending}
                                        onClick={() => setClaimTarget(r.orderNumber)}
                                      >
                                        Claim
                                      </Button>
                                    )}
                                  </div>
                                ) : r.loadingOwnerName || r.loadingOwnerCode ? (
                                  <span className="text-xs text-gray-600">{r.loadingOwnerName ?? r.loadingOwnerCode}</span>
                                ) : (
                                  <span className="text-xs text-gray-300">—</span>
                                )}
                              </TableCell>
                              <TableCell>{formatDuration(r.createdAt, r.loadingCompletedAt) ?? "-"}</TableCell>
                              <TableCell>
                                {r.loadingCompletedAt ? (
                                  <div className="flex flex-col">
                                    <span className="text-xs font-medium text-gray-700">{r.loadingCompletedByName ?? r.loadingCompletedByCode ?? "—"}</span>
                                    <span className="text-[11px] text-gray-400">
                                      {new Date(r.loadingCompletedAt).toLocaleString("en-IN", { timeZone: "Asia/Kolkata", day: "2-digit", month: "2-digit", year: "numeric", hour: "2-digit", minute: "2-digit", hour12: false })}
                                    </span>
                                  </div>
                                ) : (
                                  <span className="text-xs text-gray-300">—</span>
                                )}
                              </TableCell>
                              <TableCell>
                                <div className="flex flex-col">
                                  <span className="font-medium">{r.createdByName ?? r.createdByCode ?? "Unknown"}</span>
                                  <span className="text-xs text-muted-foreground">
                                    {new Date(r.createdAt).toLocaleDateString("en-IN", { timeZone: "Asia/Kolkata", day: "2-digit", month: "2-digit", year: "numeric" })}{" "}
                                    {new Date(r.createdAt).toLocaleTimeString("en-IN", { timeZone: "Asia/Kolkata", hour: "2-digit", minute: "2-digit", hour12: false })}
                                  </span>
                                </div>
                              </TableCell>
                              <TableCell onClick={(e) => e.stopPropagation()}>
                                <div className="flex space-x-2 justify-end">
                                  <Button
                                    variant="ghost"
                                    size="icon"
                                    className="h-9 w-9 rounded-full bg-blue-50 hover:bg-blue-100"
                                    title="Open this loading slip"
                                    onClick={() => openOrderFromList(r.orderNumber)}
                                  >
                                    <FileText className="h-5 w-5 text-[#001d6e]" />
                                  </Button>
                                  {/* Reopening is admin-only (server-enforced too, see
                                      requireReopenAccess in server/routes/loading.ts) —
                                      deliberately stricter than completing a load, since it
                                      un-does a finished, audited state. */}
                                  {canReopenRecord(r) && (
                                    <Button
                                      variant="ghost"
                                      size="icon"
                                      className="h-9 w-9 rounded-full bg-amber-50 hover:bg-amber-100"
                                      disabled={reopenMutation.isPending}
                                      title="Reopen this load"
                                      onClick={() => setReopenTarget(r.orderNumber)}
                                    >
                                      <RotateCcw className="h-5 w-5 text-amber-600" />
                                    </Button>
                                  )}
                                  {canResetLoad && (
                                    <Button
                                      variant="ghost"
                                      size="icon"
                                      className="h-9 w-9 rounded-full bg-red-50 hover:bg-red-100"
                                      title="Delete this loading slip"
                                      onClick={() => setResetTarget(r)}
                                    >
                                      <Trash2 className="h-5 w-5 text-red-500" />
                                    </Button>
                                  )}
                                </div>
                              </TableCell>
                            </TableRow>
                          </Fragment>
                        );
                      })}
                    </TableBody>
                  </Table>
                </div>

                {/* Mobile View - card list */}
                <div className={`grid grid-cols-1 gap-2 md:grid-cols-2 2xl:grid-cols-3 ${bigView ? "" : "xl:hidden"}`}>
                  {filteredRecords.map((r) => {
                    return (
                      <Card key={r.id} className={`overflow-hidden ${recordAccentBorderClass(r)}`}>
                        <CardHeader className="pb-1.5 pt-2.5">
                          <div className="flex justify-between items-start gap-2">
                            <div className="min-w-0">
                              <div className="font-medium text-md flex items-center gap-2">
                                #{r.orderNumber}
                                {r.plant && <PlantBadge plant={r.plant} />}
                              </div>
                              <div className="text-sm text-muted-foreground mt-0.5 truncate">{r.partyName || "-"}</div>
                            </div>
                            <Badge className={`${recordStatusBadgeClass(r)} text-xs shrink-0`}>
                              {recordStatus(r)}
                            </Badge>
                          </div>
                        </CardHeader>
                        <CardContent className="pb-2.5 pt-0">
                          {/* Icons on their own row, date/duration/creator info on the row below
                              (flex-wrap, not squeezed against the icons) — the old side-by-side
                              layout let the right-hand text get clipped past the card edge on
                              narrow phones instead of wrapping. The chevron/expand toggle button
                              is gone too: the whole card header is already tappable to expand
                              (see CardHeader's onClick above), so a dedicated button for the
                              same action was redundant clutter, not a second way in. */}
                          <div className="flex items-center gap-1.5 mt-1.5">
                            {r.vehicleNumber && (
                              <div
                                className="h-9 w-9 rounded-full bg-amber-50 flex items-center justify-center overflow-hidden shrink-0"
                                title={`${r.vehicleNumber}${r.rtoNumber ? ` — RTO ${r.rtoNumber}` : ""}`}
                              >
                                <span className="text-orange-600 font-medium text-xs truncate px-1">{r.vehicleNumber}</span>
                              </div>
                            )}
                            {/* The ONLY thing that opens a load into the scan view — nothing
                                else on this card (not the header, not the row) does anymore,
                                so there's exactly one unambiguous way to start scanning it. */}
                            <Button
                              variant="ghost"
                              size="icon"
                              className="h-9 w-9 p-0 rounded-full bg-blue-50 hover:bg-blue-100"
                              title="Open this loading slip"
                              onClick={() => openOrderFromList(r.orderNumber)}
                            >
                              <FileText className="h-4 w-4 text-[#001d6e]" />
                            </Button>
                            {canReopenRecord(r) && (
                              <Button
                                variant="ghost"
                                size="icon"
                                className="h-9 w-9 p-0 rounded-full bg-amber-50 hover:bg-amber-100"
                                disabled={reopenMutation.isPending}
                                title="Reopen this load"
                                onClick={(e) => { e.stopPropagation(); setReopenTarget(r.orderNumber); }}
                              >
                                <RotateCcw className="h-4 w-4 text-amber-600" />
                              </Button>
                            )}
                            {canResetLoad && (
                              <Button
                                variant="ghost"
                                size="icon"
                                className="h-9 w-9 p-0 rounded-full bg-red-50 hover:bg-red-100"
                                title="Delete this loading slip"
                                onClick={(e) => { e.stopPropagation(); setResetTarget(r); }}
                              >
                                <Trash2 className="h-4 w-4 text-red-500" />
                              </Button>
                            )}
                          </div>
                          <div className="mt-1.5 flex flex-wrap items-center gap-x-2 gap-y-0.5 text-xs text-muted-foreground">
                            <span className="flex items-center whitespace-nowrap">
                              <Calendar className="h-3 w-3 mr-1 shrink-0" />
                              {r.orderDate && (
                                <>
                                  Ord{" "}
                                  <span className="font-medium text-gray-700 ml-1">
                                    {new Date(`${String(r.orderDate).slice(0, 10)}T00:00:00`).toLocaleDateString("en-IN", { timeZone: "Asia/Kolkata", day: "2-digit", month: "2-digit", year: "numeric" })}
                                  </span>
                                  <span className="mx-1 text-gray-300">·</span>
                                </>
                              )}
                              Load{" "}
                              <span className="font-medium text-gray-700 ml-1">
                                {new Date(r.createdAt).toLocaleDateString("en-IN", { timeZone: "Asia/Kolkata", day: "2-digit", month: "2-digit", year: "numeric" })}
                              </span>
                            </span>
                            <span className="whitespace-nowrap">{formatDuration(r.createdAt, r.loadingCompletedAt) ?? "-"}</span>
                            {r.loadingCompletedAt && (r.loadingCompletedByName || r.loadingCompletedByCode) && (
                              <span className="whitespace-nowrap text-emerald-700">Completed by {r.loadingCompletedByName ?? r.loadingCompletedByCode}</span>
                            )}
                            <span className="flex items-center whitespace-nowrap">
                              <UserCircle2 className="h-3 w-3 mr-1 shrink-0" />
                              {r.createdByName ?? r.createdByCode ?? "Unknown"}
                              {" • "}
                              {new Date(r.createdAt).toLocaleTimeString("en-IN", { timeZone: "Asia/Kolkata", hour: "2-digit", minute: "2-digit", hour12: false })}
                            </span>
                          </div>

                        </CardContent>
                      </Card>
                    );
                  })}
                </div>
              </>
            )}

            {!recordsQuery.isLoading && recordsItems.length > 0 && (() => {
              const recordsPageCount = Math.max(1, Math.ceil(recordsTotal / recordsPageSize));
              const recordsPageIndex = recordsPage - 1; // buildPageList/DataTablePagination are 0-based
              return (
                <div className="grid grid-cols-3 items-center gap-2 border rounded-md px-4 py-3 text-xs text-gray-500">
                  <span>
                    {recordsTotal > 0
                      ? `Showing ${recordsOffset + 1}–${Math.min(recordsOffset + recordsItems.length, recordsTotal)} of ${recordsTotal.toLocaleString()} slips`
                      : "No slips"}
                  </span>
                  {/* Same numbered-page-button pattern (buildPageList) every other table on this
                      site uses, centered in the footer — Prev/Next alone weren't a great fit once
                      there was more than a couple of pages of slips. */}
                  <nav className="flex flex-wrap items-center justify-center gap-1" aria-label="Pagination">
                    <Button variant="outline" size="sm" className="h-8 w-8 rounded-xl p-0" disabled={recordsPage <= 1}
                      onClick={() => setRecordsPage((p) => Math.max(1, p - 1))} aria-label="Previous page">
                      <ChevronLeft className="h-4 w-4" />
                    </Button>
                    {buildPageList(recordsPageIndex, recordsPageCount).map((pg, i) =>
                      pg === "gap" ? (
                        <span key={`gap-${i}`} aria-hidden className="select-none px-1 text-sm text-gray-400">…</span>
                      ) : (
                        <Button
                          key={pg}
                          variant={pg === recordsPageIndex ? "default" : "outline"}
                          size="sm"
                          className={`h-8 min-w-8 rounded-xl px-2 tabular-nums ${pg === recordsPageIndex ? "bg-[#001d6e] text-white hover:bg-[#00154b]" : ""}`}
                          onClick={() => setRecordsPage(pg + 1)}
                          aria-label={`Page ${pg + 1}`}
                          aria-current={pg === recordsPageIndex ? "page" : undefined}
                        >
                          {pg + 1}
                        </Button>
                      ),
                    )}
                    <Button variant="outline" size="sm" className="h-8 w-8 rounded-xl p-0" disabled={!recordsHasMore}
                      onClick={() => setRecordsPage((p) => p + 1)} aria-label="Next page">
                      <ChevronRight className="h-4 w-4" />
                    </Button>
                  </nav>
                  <div className="flex items-center justify-end gap-1">
                    <span className="text-xs whitespace-nowrap text-muted-foreground">Show:</span>
                    {/* The shared Select, not a native <select>: a native list is drawn by the
                        browser and stays upright on a rotated kiosk screen. */}
                    <Select value={String(recordsPageSize)} onValueChange={(v) => { setRecordsPageSize(Number(v)); setRecordsPage(1); }}>
                      <SelectTrigger className="h-7 w-[64px] px-2 text-xs" aria-label="Rows per page"><SelectValue /></SelectTrigger>
                      <SelectContent>
                        {RECORDS_PAGE_SIZE_OPTIONS.map((size) => (
                          <SelectItem key={size} value={String(size)}>{size}</SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                  </div>
                </div>
              );
            })()}
              </>
            )}
          </div>
        )}


        {/* Tab strip — switch directly between several slips you currently own (nobody's
            restricted to just one active load at a time — see the ownership checks elsewhere in
            this file, which are all scoped per-order). Only shown once there's more than one to
            switch between; clicking a different tab reuses the same open-from-list path the
            landing list itself uses, so there's no second code path to keep in sync. */}
        {view === "create" && slip && activeSlips.length > 1 && (
          <div className="flex flex-wrap items-center gap-1.5 border-b border-gray-100 pb-2">
            {activeSlips.map((s) => {
              const active = s.orderNumber === slip.orderNumber;
              return (
                <button
                  key={s.orderNumber}
                  type="button"
                  onClick={() => { if (!active) openOrderFromList(s.orderNumber); }}
                  className={`rounded-full px-3 py-1 text-xs font-semibold ${
                    active ? "bg-[#001d6e] text-white" : "border border-gray-200 text-gray-600 hover:bg-gray-50"
                  }`}
                  title={`${s.partyName ?? ""}${s.vehicleNumber ? ` — ${s.vehicleNumber}` : ""}`}
                >
                  #{s.orderNumber}{s.vehicleNumber ? ` · ${s.vehicleNumber}` : ""}
                </button>
              );
            })}
          </div>
        )}

        {/* ── Stage B(pre): order found, vehicle not yet CLAIMED — pick one in a dialog, then
            "Create Load Slip" before the actual load page (Stage B below) ever mounts. Gated on
            isVehicleClaimed rather than slip.vehicleNumber: a Notion-synced order can already
            carry a vehicle number before anyone here has confirmed it (see the useEffect above
            that pre-fills vehicleSearch for exactly this case), and that still needs to go
            through this same confirm step, pre-filled with the Notion-suggested vehicle. */}
        {view === "create" && slip && !isVehicleClaimed && (
          <Dialog open onOpenChange={(open) => { if (!open) resetToSearch(); }}>
            <DialogContent className="max-w-lg">
              <DialogHeader>
                <DialogTitle className="text-[#001d6e]">#{slip.orderNumber}</DialogTitle>
                <DialogDescription>
                  {slip.partyName}{slip.plant ? ` · ${slip.plant}` : ""}
                  {/* Same local-midnight + explicit Asia/Kolkata pattern used everywhere else
                      this page renders orderDate — parsing the bare "YYYY-MM-DD" string directly
                      with new Date() treats it as UTC midnight, then formats in whatever the
                      browser's own default timezone happens to be instead of always IST. */}
                  {slip.orderDate ? ` · ${new Date(`${String(slip.orderDate).slice(0, 10)}T00:00:00`).toLocaleDateString("en-IN", { timeZone: "Asia/Kolkata", day: "2-digit", month: "2-digit", year: "numeric" })}` : ""}
                </DialogDescription>
              </DialogHeader>

              <div className="grid grid-cols-3 divide-x divide-gray-100 rounded-lg border border-gray-100 text-center">
                <div className="px-2 py-2.5">
                  <div className="text-base font-extrabold text-gray-900">{items.length}</div>
                  <div className="text-[10px] font-medium text-gray-500 mt-0.5">Items</div>
                </div>
                <div className="px-2 py-2.5">
                  <div className="text-base font-extrabold text-gray-900">{slip.totalQuantity ?? "-"}</div>
                  <div className="text-[10px] font-medium text-gray-500 mt-0.5">Total Qty</div>
                </div>
                <div className="px-2 py-2.5">
                  <div className="text-base font-extrabold text-gray-900">{slip.totalVolume ?? "-"}</div>
                  <div className="text-[10px] font-medium text-gray-500 mt-0.5">Volume</div>
                </div>
              </div>

              <div className="space-y-1.5">
                <Label className="flex items-center gap-1.5 text-xs font-semibold uppercase tracking-wide text-gray-500">
                  <Package className="h-3.5 w-3.5" /> Items on this order ({items.length})
                </Label>
                <div className="max-h-48 overflow-y-auto rounded-lg border border-gray-100">
                  <table className="w-full text-xs">
                    <thead className="sticky top-0 bg-gray-50">
                      <tr className="text-left text-[10px] font-semibold uppercase tracking-wide text-gray-500">
                        <th className="px-3 py-1.5">SKU</th>
                        <th className="px-3 py-1.5">Item Name</th>
                        <th className="px-3 py-1.5 text-right">Qty</th>
                      </tr>
                    </thead>
                    <tbody>
                      {items.map((it) => (
                        <tr key={it.id} className="border-t border-gray-100">
                          <td className="whitespace-nowrap px-3 py-1.5 text-gray-500">{it.sapCode ?? it.barcode ?? "—"}</td>
                          <td className="px-3 py-1.5 text-gray-800">{it.itemName ?? "—"}</td>
                          <td className="px-3 py-1.5 text-right font-medium tabular-nums text-gray-900">{it.expected}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </div>

              {canWrite ? (
                <div className="space-y-1.5">
                  <Label className="flex items-center gap-1.5 text-xs font-semibold uppercase tracking-wide text-gray-500">
                    <Truck className="h-3.5 w-3.5" /> Select a vehicle
                  </Label>
                  <div className="relative">
                    <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-gray-400" />
                    <Input
                      // Auto-focuses as soon as this dialog opens, ready for the gun to scan a
                      // vehicle barcode — same inputMode trick as the order-search input: stays
                      // focusable for the gun without popping the keyboard, and a real tap
                      // (onPointerDown, written straight to the DOM node so it lands before that
                      // tap's own focus event) opens it on demand instead.
                      inputMode="none"
                      onPointerDown={(e) => { (e.currentTarget as HTMLInputElement).inputMode = "text"; }}
                      value={vehicleSearch}
                      onChange={(e) => { setVehicleSearch(e.target.value); setSelectedVehicle(null); setVehicleSuggIdx(-1); }}
                      onFocus={() => setVehicleFocused(true)}
                      onBlur={(e) => { (e.currentTarget as HTMLInputElement).inputMode = "none"; setTimeout(() => setVehicleFocused(false), 150); }}
                      onKeyDown={(e) => {
                        if (vehicleFocused && vehicleSuggestions.length > 0) {
                          if (e.key === "ArrowDown") { e.preventDefault(); setVehicleSuggIdx((i) => Math.min(i + 1, vehicleSuggestions.length - 1)); return; }
                          if (e.key === "ArrowUp") { e.preventDefault(); setVehicleSuggIdx((i) => Math.max(i - 1, -1)); return; }
                          if (e.key === "Escape") { setVehicleFocused(false); return; }
                          if (e.key === "Enter" && vehicleSuggIdx >= 0) { e.preventDefault(); pickVehicle(vehicleSuggestions[vehicleSuggIdx]); return; }
                        }
                      }}
                      placeholder="Vehicle number, driver, company…"
                      className="h-10 pl-9 pr-9 text-sm"
                      autoFocus
                    />
                    {vehicleSearch && (
                      <button onClick={() => { setVehicleSearch(""); setSelectedVehicle(null); }} className="absolute right-3 top-1/2 -translate-y-1/2 text-gray-400 hover:text-gray-600">
                        <X className="h-4 w-4" />
                      </button>
                    )}
                    {vehicleFocused && !selectedVehicle && debouncedVehicleSearch.trim().length >= 1 && (
                      <div className="absolute z-20 mt-1 w-full rounded-lg border border-gray-200 bg-white shadow-lg overflow-hidden">
                        {vehicleSuggestionsQuery.isFetching ? (
                          <SectionSkeleton lines={2} />
                        ) : vehicleSuggestions.length === 0 ? (
                          <p className="px-4 py-3 text-xs text-gray-400">No matching vehicles.</p>
                        ) : (
                          vehicleSuggestions.map((v, i) => (
                            <button
                              key={v.id}
                              onMouseDown={(e) => e.preventDefault()}
                              onClick={() => pickVehicle(v)}
                              className={`flex w-full items-center justify-between gap-2 px-4 py-2.5 text-left border-b border-gray-100 last:border-0 ${i === vehicleSuggIdx ? "bg-[#001d6e]/10" : "hover:bg-[#001d6e]/5"}`}
                            >
                              <div className="min-w-0">
                                <div className="flex items-center gap-1.5">
                                  <div className="text-sm font-semibold text-[#001d6e] truncate">{v.vehicleNumber}</div>
                                  {v.fromNotion && (
                                    <span className="shrink-0 rounded-full bg-amber-100 px-1.5 py-0.5 text-[10px] font-semibold uppercase tracking-wide text-amber-700">
                                      From Notion
                                    </span>
                                  )}
                                </div>
                                <div className="text-xs text-gray-500 truncate">{[v.rtoNumber && `RTO ${v.rtoNumber}`, v.driver, v.company].filter(Boolean).join(" · ") || "—"}</div>
                              </div>
                              <ChevronRight className="h-4 w-4 shrink-0 text-gray-300" />
                            </button>
                          ))
                        )}
                      </div>
                    )}
                  </div>

                  {selectedVehicle && (
                    <div className="flex items-center justify-between gap-2 rounded-lg border border-[#001d6e]/20 bg-[#001d6e]/5 px-3 py-2.5">
                      <div className="min-w-0 text-sm">
                        <span className="font-semibold text-[#001d6e]">{selectedVehicle.vehicleNumber}</span>
                        <span className="text-gray-500"> — RTO {selectedVehicle.rtoNumber ?? "—"}{selectedVehicle.volume != null ? ` · Vol ${selectedVehicle.volume}` : ""}</span>
                      </div>
                    </div>
                  )}
                </div>
              ) : (
                <p className="text-sm text-gray-500">You have read-only access to Loading — a vehicle needs to be linked before a load slip can be created.</p>
              )}

              <DialogFooter className="gap-2">
                <Button variant="outline" onClick={resetToSearch} disabled={linkVehicleMutation.isPending}>
                  Cancel
                </Button>
                <Button
                  className="bg-[#001d6e] text-white hover:bg-[#001552]"
                  disabled={!canWrite || !selectedVehicle || linkVehicleMutation.isPending}
                  onClick={() => selectedVehicle && linkVehicleMutation.mutate(selectedVehicle)}
                >
                  {linkVehicleMutation.isPending ? <Loader2 className="mr-1.5 h-4 w-4 animate-spin" /> : <Link2 className="mr-1.5 h-4 w-4" />}
                  Create Load Slip
                </Button>
              </DialogFooter>
            </DialogContent>
          </Dialog>
        )}

        {/* ── Stage B: order found and vehicle set — responsive 2-column layout on wide screens.
            Only reached once a vehicle is linked (Stage B(pre) above handles getting one) — the
            "no vehicle yet" placeholder that used to sit here is gone; this page simply doesn't
            mount until then. ──────────────────────────────────────────────────────────────── */}
        {view === "create" && slip && isVehicleClaimed && (
          <div className={`flex h-full min-h-0 flex-col gap-3 ${kioskRotateClass} ${rotated ? "bg-[#f4f5f7] p-4" : ""}`}>
              {/* Kiosk rotate — same floating button Order Scan/Unloading use, for a screen
                  physically mounted at an angle next to the loading bay. Fixed positioning
                  inside the (transform:rotate) wrapper above keeps it pinned to a natural
                  on-screen corner from the viewer's rotated perspective. */}
              <PageScrollButtons />
              {/* No overflow-hidden here — the vehicle-search dropdown below is absolutely
                  positioned and needs to be able to render past this card's edge; clipping it
                  made the suggestions invisible even though the search itself worked fine.
                  rounded-t-xl on the header strip below keeps the top corners clean without it. */}
              {/* Sticky — stays pinned at the top of the scroll while the items table below it
                  scrolls underneath, instead of scrolling away with everything else. z-20 keeps
                  it above the items table's own sticky column header (itself sticky within the
                  table's own scroll box). */}
              <div className="sticky top-0 z-30 shrink-0 rounded-xl border border-gray-200 bg-white shadow-md">
                {/* xl (not sm) is deliberate here — this switches to a side-by-side row only once
                    there's real room for both the identity badges AND the action buttons.
                    min-w-0 below (on the identity block) plus shrink-0 (on the actions) means
                    ALL of any width shortfall gets absorbed by the identity side — at sm (640px)
                    that shortfall was severe on any "desktop-width" browser window with the
                    sidebar open (which eats ~256px), squeezing badges down to where "Ord 31 Aug
                    2026" wrapped onto four separate lines instead of just stacking the whole
                    identity block above the actions, which is what happens correctly below xl.
                    bigView (rotated kiosk or natural portrait) forces that same stacked layout
                    regardless of xl — xl: is a raw-window-width query, so a rotated kiosk on a
                    genuinely wide monitor would otherwise still pass it and get squeezed into
                    the side-by-side row despite its real (rotated) width being narrow. */}
                <div className={`flex flex-col gap-1 px-2.5 sm:px-3 py-1.5 border-b border-gray-100 bg-[#001d6e]/5 rounded-t-xl ${bigView ? "" : "xl:flex-row xl:items-center xl:justify-between"}`}>
                  {/* Slip identity — order#/party on one line, then plant (Plant Management's own
                      color, same PlantBadge every other page uses), date, volume and the linked
                      vehicle as a proper row of badges/text underneath, sized to actually be
                      readable at a glance instead of one tiny catch-all line. */}
                  <div className="min-w-0 space-y-1">
                    <div className="flex flex-wrap items-center gap-x-2 gap-y-0.5">
                      <span className="text-sm font-bold text-[#001d6e] truncate">#{slip.orderNumber}</span>
                      <span className="text-sm text-gray-600 truncate">{slip.partyName}</span>
                      {slip.plant && <PlantBadge plant={slip.plant} className="text-[10px]" />}
                      <span className="ml-auto flex shrink-0 flex-wrap items-center gap-x-2 text-[11px]">
                        {slip.orderDate && <span className="font-semibold text-gray-700">Order: {new Date(`${String(slip.orderDate).slice(0, 10)}T00:00:00`).toLocaleDateString("en-IN", { day: "2-digit", month: "short", year: "numeric" })}</span>}
                        {slip.loadDate && <span className="font-semibold text-gray-500">Load: {new Date(slip.loadDate).toLocaleDateString("en-IN", { day: "2-digit", month: "short", year: "numeric" })}</span>}
                      </span>
                    </div>
                    {/* text-xs (not text-sm) and a tighter gap here — this row can easily be
                        6-7 badges deep (plant, dates, item/qty counts, two volume pills, the
                        vehicle) and at text-sm each one claimed close to its own line on a phone,
                        which is most of what was pushing this card's height out. */}
                    <div className="flex flex-wrap items-center gap-1.5">
                      <div className="hidden">
                      {slip.orderDate && (
                        <span className="text-xs font-semibold text-gray-700" title="Order date — the proforma slip's own date">
                          Ord {new Date(`${String(slip.orderDate).slice(0, 10)}T00:00:00`).toLocaleDateString("en-IN", { day: "2-digit", month: "short", year: "numeric" })}
                        </span>
                      )}
                      {slip.loadDate && (
                        <span className="text-xs font-semibold text-gray-500" title="Load date — when this load operation was started">
                          Load {new Date(slip.loadDate).toLocaleDateString("en-IN", { day: "2-digit", month: "short", year: "numeric" })}
                        </span>
                      )}
                      </div>
                      <span className="text-xs text-gray-400">{items.length} item{items.length === 1 ? "" : "s"}</span>
                      <span className="text-xs text-gray-400">Qty {slip.totalQuantity ?? "—"}</span>
                      {/* Loaded volume vs. the order's own required volume — same figure the
                          removed Items/Total Qty/Volume stat card showed. Red once the order's
                          own volume would overflow the vehicle's capacity (isOverCapacity),
                          regardless of how much is loaded so far. */}
                      {slip.totalVolume && (
                        <span
                          className={`inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-xs font-bold ${
                            isOverCapacity ? "bg-red-100 text-red-700" : "bg-indigo-100 text-indigo-700"
                          }`}
                          title={`${loadedVolume} loaded of ${slip.totalVolume} required`}
                        >
                          {loadedVolume}<span className="opacity-50">/</span>{slip.totalVolume}
                        </span>
                      )}
                      {/* The vehicle's own capacity — a separate figure from the order's
                          required volume above, so the two are never read as one number. */}
                      {slip.vehicleVolume != null && (
                        <span
                          className={`inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-xs font-bold ${
                            isOverCapacity ? "bg-red-100 text-red-700" : "bg-sky-100 text-sky-700"
                          }`}
                          title="Vehicle capacity"
                        >
                          Vech vol: {slip.vehicleVolume}
                        </span>
                      )}
                      {slip.vehicleNumber && (
                        <span className="rounded-full bg-emerald-100 px-2 py-0.5 text-xs font-semibold text-emerald-700">
                          {slip.vehicleNumber}{slip.rtoNumber ? ` · ${slip.rtoNumber}` : ""}
                        </span>
                      )}
                      {/* Progress lives in THIS row (not its own line in the actions block below)
                          specifically so it shares a line with the vehicle badge instead of each
                          claiming a separate row — one of the biggest single wins for shrinking
                          this card's height. */}
                      <div
                        className={`flex items-center gap-1.5 rounded-full px-2 py-0.5 ${
                          itemPct >= 100 ? "bg-emerald-100" : "bg-gray-100"
                        }`}
                        title={`${itemTotals.loaded} of ${itemTotals.expected} loaded`}
                      >
                        <Progress
                          value={itemPct}
                          className={`w-16 h-1.5 ${itemPct >= 100 ? "bg-emerald-200" : "bg-gray-200"}`}
                          indicatorClassName={itemPct >= 100 ? "bg-emerald-600" : "bg-[#001d6e]"}
                        />
                        <span className={`text-xs font-bold whitespace-nowrap ${itemPct >= 100 ? "text-emerald-700" : "text-gray-700"}`}>
                          {itemTotals.loaded}/{itemTotals.expected} · {itemPct}%
                        </span>
                      </div>
                    </div>
                  </div>

                  {/* Actions — Back to List is the primary way out of this page, so it gets a
                      visibly bigger, outlined treatment rather than reading as just another
                      small pill alongside Change Vehicle/Complete. */}
                  <div className="flex flex-wrap items-center gap-1 shrink-0">
                    {/* STV is read-only here by design. It's picked once in the Create Operation
                        dialog and, after that, only an admin can change it — from the Proforma
                        Slips page, not from the scanning screen. */}
                    {lockedStv && (
                      <div className="flex items-center gap-1">
                        <span className="text-[10px] font-semibold uppercase tracking-wide text-gray-400">Dispatch Directory</span>
                        <span className="inline-flex h-6 items-center gap-1 rounded-full border border-[#001d6e] bg-[#001d6e]/5 px-3 text-xs font-semibold text-[#001d6e]">
                          <Lock className="h-3 w-3" />{lockedStv}
                        </span>
                        {/* Admin/Supervisor/current-owner — same rule the server enforces (see
                            requireLoadingWrite + the current-owner check in the PATCH /stv
                            route). Everyone else still only ever sees the read-only pill above. */}
                        {canWrite && !locked && (canBypassOwnership || isLoadOwner) && (
                          <button
                            type="button"
                            onClick={() => { setStvChangeValue(lockedStv); setStvChangeOpen(true); }}
                            title="Change this load's STV/platform"
                            className="ml-0.5 flex h-6 w-6 shrink-0 items-center justify-center rounded-full text-gray-400 hover:bg-[#001d6e]/10 hover:text-[#001d6e]"
                          >
                            <Pencil className="h-3 w-3" />
                          </button>
                        )}
                      </div>
                    )}
                    {canWrite && !locked && canEditVehicle && (
                      <Button
                        size="sm"
                        variant="outline"
                        className="h-6 rounded-full px-2 text-[11px]"
                        onClick={() => setVehiclePanelOpen((v) => !v)}
                      >
                        <Truck className="mr-1 h-3 w-3" /> Vehicle
                      </Button>
                    )}
                    {canComplete && !locked && (
                      <Button
                        size="sm"
                        className="h-7 rounded-full bg-emerald-600 px-3 text-xs text-white hover:bg-emerald-700"
                        disabled={completeMutation.isPending}
                        onClick={() => setConfirmCompleteOpen(true)}
                      >
                        {completeMutation.isPending && <Loader2 className="mr-1.5 h-3.5 w-3.5 animate-spin" />}
                        Complete
                      </Button>
                    )}
                    {/* Shift handoff — Pause (owner/admin only, while active) hands this load
                        off to whoever claims it next; Claim (anyone with write access, only
                        while paused) picks it up. Never both shown at once. */}
                    {canWrite && !locked && !isLoadPaused && (isLoadOwner || canBypassOwnership) && (
                      <Button
                        size="sm"
                        variant="outline"
                        className="h-7 rounded-full border-amber-300 px-3 text-xs text-amber-700 hover:bg-amber-50"
                        disabled={pauseLoadMutation.isPending}
                        title="Step away from this load — anyone with write access can then claim it"
                        onClick={() => pauseLoadMutation.mutate()}
                      >
                        {pauseLoadMutation.isPending && <Loader2 className="mr-1.5 h-3.5 w-3.5 animate-spin" />}
                        Pause
                      </Button>
                    )}
                    {canWrite && !locked && isLoadPaused && (
                      <Button
                        size="sm"
                        className="h-7 rounded-full bg-amber-500 px-3 text-xs text-white hover:bg-amber-600"
                        disabled={claimLoadMutation.isPending}
                        onClick={() => setClaimTarget(slip.orderNumber)}
                      >
                        {claimLoadMutation.isPending && <Loader2 className="mr-1.5 h-3.5 w-3.5 animate-spin" />}
                        Claim
                      </Button>
                    )}
                    <Button
                      size="sm"
                      variant="outline"
                      onClick={backToList}
                      className="h-8 px-3.5 text-xs font-semibold border-[#001d6e]/30 text-[#001d6e] hover:bg-[#001d6e]/5"
                    >
                      Back to List
                    </Button>
                  </div>
                </div>

                {locked && (
                  <div className="flex items-center gap-2 px-3 sm:px-4 py-1.5 bg-[#001d6e]/5 border-b border-gray-100">
                    <Lock className="h-3.5 w-3.5 shrink-0 text-[#001d6e]" />
                    <div className="text-xs text-[#001d6e]">
                      Load completed {slip.loadingCompletedAt ? new Date(slip.loadingCompletedAt).toLocaleString("en-IN", { timeZone: "Asia/Kolkata" }) : ""}
                    </div>
                  </div>
                )}

                {/* Shift handoff banners — paused (blocked for everyone until claimed) takes
                    priority over the plain "someone else owns this" read-only notice, since a
                    paused load is blocked for the owner too, not just other users. */}
                {!locked && isLoadPaused && (
                  <div className="flex flex-wrap items-center gap-2 px-3 sm:px-4 py-1.5 bg-amber-50 border-b border-amber-100">
                    <PackagePlus className="h-3.5 w-3.5 shrink-0 text-amber-700" />
                    <span className="text-xs text-amber-800">
                      Paused by {slip.loadingOwnerName ?? slip.loadingOwnerCode ?? "someone"} — claim it to keep scanning.
                    </span>
                  </div>
                )}
                {!locked && !isLoadPaused && !isLoadOwner && !canBypassOwnership && (
                  <div className="px-4 sm:px-5 py-1.5 border-b border-gray-100 text-xs text-gray-500">
                    Owned by {slip.loadingOwnerName ?? slip.loadingOwnerCode} — you can view this but can't scan until they pause it.
                  </div>
                )}

                {/* The vehicle itself is already shown up in the header's identity line (the
                    emerald "vehicle · RTO" badge) — this used to repeat it in its own banner.
                    Only the one piece that badge can't carry — read-only access — still needs a
                    line of its own. */}
                {slip.vehicleNumber && !canEditVehicle && (
                  <div className="px-4 sm:px-5 py-1.5 border-b border-gray-100 text-xs text-gray-500">
                    Assigned by another user — you can view this but can't change it.
                  </div>
                )}

                {/* Vehicle search/assign — collapsed behind the "Change Vehicle" button above
                    instead of always open; same search/suggestions/Link content as before. */}
                {canWrite && !locked && canEditVehicle && vehiclePanelOpen && (
                  <div className="px-3 sm:px-4 py-2 border-b border-gray-100">
                    <label className="mb-1.5 flex items-center gap-1.5 text-xs font-semibold uppercase tracking-wide text-gray-500">
                      <Truck className="h-3.5 w-3.5" /> Change vehicle
                    </label>
                    <div className="relative">
                      <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-gray-400" />
                      <Input
                        value={vehicleSearch}
                        onChange={(e) => { setVehicleSearch(e.target.value); setSelectedVehicle(null); setVehicleSuggIdx(-1); }}
                        onFocus={() => setVehicleFocused(true)}
                        onBlur={() => setTimeout(() => setVehicleFocused(false), 150)}
                        onKeyDown={(e) => {
                          if (vehicleFocused && vehicleSuggestions.length > 0) {
                            if (e.key === "ArrowDown") { e.preventDefault(); setVehicleSuggIdx((i) => Math.min(i + 1, vehicleSuggestions.length - 1)); return; }
                            if (e.key === "ArrowUp") { e.preventDefault(); setVehicleSuggIdx((i) => Math.max(i - 1, -1)); return; }
                            if (e.key === "Escape") { setVehicleFocused(false); return; }
                            if (e.key === "Enter" && vehicleSuggIdx >= 0) { e.preventDefault(); pickVehicle(vehicleSuggestions[vehicleSuggIdx]); return; }
                          }
                        }}
                        placeholder="Vehicle number, driver, company…"
                        className="h-10 pl-9 pr-9 text-sm"
                      />
                      {vehicleSearch && (
                        <button onClick={() => { setVehicleSearch(""); setSelectedVehicle(null); }} className="absolute right-3 top-1/2 -translate-y-1/2 text-gray-400 hover:text-gray-600">
                          <X className="h-4 w-4" />
                        </button>
                      )}
                      {vehicleFocused && !selectedVehicle && debouncedVehicleSearch.trim().length >= 1 && (
                        <div className="absolute z-20 mt-1 w-full rounded-lg border border-gray-200 bg-white shadow-lg overflow-hidden">
                          {vehicleSuggestionsQuery.isFetching ? (
                            <SectionSkeleton lines={2} />
                          ) : vehicleSuggestions.length === 0 ? (
                            <p className="px-4 py-3 text-xs text-gray-400">No matching vehicles.</p>
                          ) : (
                            vehicleSuggestions.map((v, i) => (
                              <button
                                key={v.id}
                                onMouseDown={(e) => e.preventDefault()}
                                onClick={() => pickVehicle(v)}
                                className={`flex w-full items-center justify-between gap-2 px-4 py-2.5 text-left border-b border-gray-100 last:border-0 ${i === vehicleSuggIdx ? "bg-[#001d6e]/10" : "hover:bg-[#001d6e]/5"}`}
                              >
                                <div className="min-w-0">
                                  <div className="flex items-center gap-1.5">
                                    <div className="text-sm font-semibold text-[#001d6e] truncate">{v.vehicleNumber}</div>
                                    {v.fromNotion && (
                                      <span className="shrink-0 rounded-full bg-amber-100 px-1.5 py-0.5 text-[10px] font-semibold uppercase tracking-wide text-amber-700">
                                        From Notion
                                      </span>
                                    )}
                                  </div>
                                  <div className="text-xs text-gray-500 truncate">{[v.rtoNumber && `RTO ${v.rtoNumber}`, v.driver, v.company].filter(Boolean).join(" · ") || "—"}</div>
                                </div>
                                <ChevronRight className="h-4 w-4 shrink-0 text-gray-300" />
                              </button>
                            ))
                          )}
                        </div>
                      )}
                    </div>

                    {selectedVehicle && (
                      <div className="mt-3 flex items-center justify-between gap-2 rounded-lg border border-[#001d6e]/20 bg-[#001d6e]/5 px-3 py-2.5">
                        <div className="min-w-0 text-sm">
                          <span className="font-semibold text-[#001d6e]">{selectedVehicle.vehicleNumber}</span>
                          <span className="text-gray-500"> — RTO {selectedVehicle.rtoNumber ?? "—"}{selectedVehicle.volume != null ? ` · Vol ${selectedVehicle.volume}` : ""}</span>
                        </div>
                        <Button size="sm" className="h-8 shrink-0 bg-[#001d6e] text-white hover:bg-[#001552]"
                          disabled={linkVehicleMutation.isPending}
                          onClick={() => linkVehicleMutation.mutate(selectedVehicle)}>
                          {linkVehicleMutation.isPending ? <Loader2 className="mr-1.5 h-3.5 w-3.5 animate-spin" /> : <Link2 className="mr-1.5 h-3.5 w-3.5" />}
                          Link
                        </Button>
                      </div>
                    )}
                  </div>
                )}

          {/* Total | Scanner | Owner History | Sort History — one merged row (used to be two
              separate ones, stacked), now also part of the SAME card as the vehicle/progress
              header above instead of a separate block underneath it — border-t marks where the
              header ends, same divider convention every other internal row of this card already
              uses. Total/Scanner is a tab switch instead of the two cards
              stacked, so glancing at totals doesn't push the barcode input off-screen; Scan Items
              stays mounted underneath while "Total" is active (hidden via class, not unmounted)
              so the barcode-gun listener's refocus-after-scan and the camera stream survive a tab
              switch. Owner/Sort History are independent toggles, not part of that same tab group
              — "Owner": every user who's ever held this load, oldest first, with how much each
              one loaded — display only, access control never reads this (see
              checkLoadOwnership/checkLoadViewAccess). "Sort": the Sort Slip side of this order,
              who picked it and how much while sorting rather than loading. Each group (Total/
              Scanner/Add Extra needs canScanThisLoad; Owner/Sort History need their own history
              to actually exist) only renders when it has something to show, and the whole row
              disappears if none of them do. */}
          <div className="space-y-2 border-t border-gray-100 px-3 sm:px-4 py-2">
            {(canScanThisLoad
              || (loadHandoffsQuery.data?.timeline?.length ?? 0) > 0
              || (sortLoaderHistoryQuery.data?.exists && (sortLoaderHistoryQuery.data.timeline?.length ?? 0) > 0)) && (
              <div className="flex flex-wrap items-center gap-2">
                {canScanThisLoad && (
                  <>
                    <button
                      type="button"
                      onClick={() => setActiveTab("total")}
                      className={workTabClass(activeTab === "total")}
                    >
                      Total
                    </button>
                    <button
                      type="button"
                      onClick={() => setActiveTab("scanner")}
                      className={workTabClass(activeTab === "scanner")}
                    >
                      Scanner
                    </button>
                  </>
                )}
                {(loadHandoffsQuery.data?.timeline?.length ?? 0) > 0 && (
                  <button
                    type="button"
                    onClick={() => setActiveTab((t) => (t === "owner" ? "scanner" : "owner"))}
                    className={workTabClass(activeTab === "owner")}
                  >
                    <UserCircle2 className="h-3.5 w-3.5" /> Owner History
                  </button>
                )}
                {sortLoaderHistoryQuery.data?.exists && (sortLoaderHistoryQuery.data.timeline?.length ?? 0) > 0 && (
                  <button
                    type="button"
                    onClick={() => setActiveTab((t) => (t === "sort" ? "scanner" : "sort"))}
                    className={workTabClass(activeTab === "sort")}
                  >
                    <ClipboardList className="h-3.5 w-3.5" /> Sort History
                    <span className={activeTab === "sort" ? "text-white/70" : "text-gray-400"}>
                      ({sortLoaderHistoryQuery.data.pickedQty ?? 0}/{sortLoaderHistoryQuery.data.totalQty ?? 0})
                    </span>
                  </button>
                )}
                <button
                  type="button"
                  onClick={() => setPanelsOpen((o) => !o)}
                  aria-expanded={panelsOpen}
                  title={panelsOpen ? "Hide this panel" : "Show this panel"}
                  className="ml-auto flex h-7 w-7 shrink-0 items-center justify-center rounded-full border border-gray-200 bg-white text-gray-500 hover:bg-gray-50"
                >
                  <ChevronDown className={`h-4 w-4 transition-transform ${panelsOpen ? "rotate-180" : ""}`} />
                </button>
              </div>
            )}

            {panelsOpen && activeTab === "owner" && (loadHandoffsQuery.data?.timeline?.length ?? 0) > 0 && (
              <div className="border rounded-md overflow-hidden bg-white">
                <OwnerTimelineSummary timeline={loadHandoffsQuery.data!.timeline} />
              </div>
            )}
            {panelsOpen && activeTab === "sort" && (
              <div className="border rounded-md overflow-hidden bg-white">
                <SortLoaderTimelineSummary timeline={sortLoaderHistoryQuery.data?.timeline ?? []} />
              </div>
            )}

            {/* Read-only viewers have no Total/Scanner buttons at all (canScanThisLoad is
                false), so Totals is their default view too — shown unless they've switched to
                Owner/Sort History, which they CAN still reach. */}
            <div className={
              panelsOpen && (activeTab === "total" || (!canScanThisLoad && activeTab !== "owner" && activeTab !== "sort"))
                ? "" : "hidden"
            }>
              <div className="flex min-w-0 flex-col gap-1 rounded-xl border bg-white p-1.5 shadow-sm">
                <div
                  role="button"
                  tabIndex={0}
                  aria-expanded={totalsOpen}
                  onClick={() => setTotalsOpen((o) => !o)}
                  onKeyDown={(e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); setTotalsOpen((o) => !o); } }}
                  className="flex cursor-pointer items-baseline justify-between gap-2 rounded-md px-1 hover:bg-gray-50"
                >
                  <p className="flex items-center gap-1 text-xs font-semibold uppercase tracking-wide text-gray-500">
                    Load Totals
                    <ChevronDown className={`h-3.5 w-3.5 text-gray-400 transition-transform ${totalsOpen ? "rotate-180" : ""}`} />
                  </p>
                  {itemTotals.expected <= 0 ? (
                    <p className="text-sm font-medium text-gray-400">—</p>
                  ) : itemPct >= 100 ? (
                    <p className="inline-flex items-center gap-1 text-sm font-semibold text-emerald-600">
                      <CheckCircle2 className="h-4 w-4" /> Complete
                    </p>
                  ) : (
                    <p className="text-sm font-medium text-gray-400">{itemPct}% complete</p>
                  )}
                </div>
                {/* Always 4 columns, even on the narrowest phone — was grid-cols-2 below sm
                    (wrapping to 2 rows); text/padding/gap now scale down with a sm: step
                    instead of the column count changing, so all four stay in one row. */}
                <div className={`grid grid-cols-4 gap-1 ${totalsOpen ? "" : "hidden"}`}>
                  {([
                    { key: "" as const, label: "Total", value: itemTotals.expected, plt: itemTotals.pltExpected, dot: "bg-gray-400", text: "text-gray-900" },
                    { key: "done" as const, label: "Loaded", value: itemTotals.loaded, plt: itemTotals.pltLoaded, dot: "bg-emerald-500", text: "text-emerald-600" },
                    { key: "remaining" as const, label: "Remaining", value: itemTotals.remaining, plt: itemTotals.pltRemaining, dot: "bg-red-500", text: "text-red-600" },
                    { key: "extra" as const, label: "Extra", value: itemTotals.extra, plt: itemTotals.pltExtra, dot: "bg-orange-500", text: itemTotals.extra > 0 ? "text-amber-600" : "text-gray-300" },
                  ]).map((s) => {
                    const isActive = itemStatusFilter === s.key;
                    return (
                      <button
                        key={s.label}
                        type="button"
                        onClick={() => setItemStatusFilter(isActive ? "" : s.key)}
                        aria-pressed={isActive}
                        title={s.key ? `Show only ${s.label.toLowerCase()} items` : "Show all items"}
                        className={`min-w-0 rounded-xl border px-1 py-0.5 text-center transition-colors sm:px-2 ${
                          isActive ? "border-[#001d6e] bg-[#001d6e]/[0.06] ring-1 ring-[#001d6e]/30" : "border-gray-100 bg-gray-50/70 hover:bg-gray-100"
                        }`}
                      >
                        <div className="flex items-center justify-center gap-1 sm:gap-1.5">
                          <span className={`h-1.5 w-1.5 shrink-0 rounded-full sm:h-2 sm:w-2 ${s.dot}`} />
                          <p className="truncate text-[9px] font-semibold uppercase tracking-wide text-gray-500 sm:text-xs">{s.label}</p>
                        </div>
                        <p className={`text-base font-bold leading-tight sm:text-xl ${s.text}`}>{s.value}</p>
                        <p className={`text-[11px] font-bold sm:text-sm ${s.text}`}>{s.plt.toFixed(2)} plt</p>
                      </button>
                    );
                  })}
                </div>
                <div className={`space-y-1 ${totalsOpen ? "" : "hidden"}`}>
                  <div className="h-1.5 w-full overflow-hidden rounded-full bg-gray-100">
                    <div className="h-full rounded-full bg-emerald-500 transition-[width] duration-300" style={{ width: `${itemPct}%` }} />
                  </div>
                  <div className="flex justify-between text-[10px] font-medium text-gray-400">
                    <span>{itemTotals.loaded} loaded</span>
                    <span>{itemTotals.remaining} remaining</span>
                  </div>
                </div>
              </div>
            </div>

            {/* Scan items — hidden once locked; a vehicle is guaranteed set by the time Stage B
                ever mounts (see Stage B(pre) above), so there's no "not linked yet" case to
                guard here anymore. Same Camera/Manual pattern as order search. */}
            {canScanThisLoad && (
              <div className={!panelsOpen || activeTab !== "scanner" ? "hidden" : ""}>
                <div className="rounded-xl border border-gray-200 bg-white shadow-sm overflow-hidden">
                  <button
                    type="button"
                    onClick={() => setScannerOpen((o) => !o)}
                    aria-expanded={scannerOpen}
                    className={`flex w-full items-center gap-2 px-4 sm:px-5 py-3.5 text-left transition-colors hover:bg-gray-50 ${scannerOpen ? "border-b border-gray-100" : ""}`}
                  >
                    <ScanLine className="h-4 w-4 text-[#001d6e]" />
                    <span className="text-sm font-semibold text-gray-900">Scan Items</span>
                    <ChevronDown className={`ml-auto h-4 w-4 text-gray-400 transition-transform ${scannerOpen ? "rotate-180" : ""}`} />
                  </button>
                  <div className={`px-4 sm:px-5 py-4 space-y-3 ${scannerOpen ? "" : "hidden"}`}>
                    <div className="flex overflow-hidden rounded-xl border border-gray-300 divide-x divide-gray-300 bg-white">
                      <button
                        onClick={() => setItemScanMode("camera")}
                        className={`flex-1 flex items-center justify-center gap-1.5 py-2 text-xs font-semibold transition-colors ${itemScanMode === "camera" ? "bg-[#001d6e] text-white" : "text-gray-500 hover:bg-gray-50"}`}
                      >
                        <Camera className="h-3.5 w-3.5" /> Camera
                      </button>
                      <button
                        onClick={() => { stopItemCamera(); setItemScanMode("manual"); }}
                        className={`flex-1 flex items-center justify-center gap-1.5 py-2 text-xs font-semibold transition-colors ${itemScanMode === "manual" ? "bg-[#001d6e] text-white" : "text-gray-500 hover:bg-gray-50"}`}
                      >
                        <Keyboard className="h-3.5 w-3.5" /> Manual
                      </button>
                    </div>

                    <div className="relative w-full bg-black rounded-2xl overflow-hidden" style={{ display: itemScanMode === "camera" ? "block" : "none", height: "clamp(190px, 40vw, 260px)" }}>
                      <video ref={itemVideoRef} autoPlay muted playsInline className="absolute inset-0 h-full w-full object-cover" />
                      <div className="pointer-events-none absolute inset-0" style={{ background: "radial-gradient(ellipse 70% 55% at 50% 50%, transparent 55%, rgba(0,0,0,0.55) 100%)" }} />
                      {itemScanMode === "camera" && !itemCameraReady && !itemCameraError && (
                        <div className="absolute inset-0 flex flex-col items-center justify-center gap-2 text-white z-10">
                          <Loader2 className="h-7 w-7 animate-spin opacity-90" />
                          <p className="text-xs font-medium opacity-80">Starting camera…</p>
                        </div>
                      )}
                      {itemScanMode === "camera" && itemCameraError && (
                        <div className="absolute bottom-0 left-0 right-0 flex items-center gap-2 bg-red-900/85 px-3 py-2 text-xs text-white z-10">
                          <AlertTriangle className="h-3.5 w-3.5 shrink-0" /> {itemCameraError}
                        </div>
                      )}
                    </div>

                    {itemScanMode === "manual" && (
                      <div className="relative">
                        <ScanLine className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-gray-400" />
                        <Input
                          ref={itemInputRef}
                          autoFocus
                          // Auto-focuses so the gun can scan items immediately — inputMode
                          // "none" keeps it focusable for the gun's keystrokes (onChange below
                          // still fires normally; only the on-screen keyboard is suppressed)
                          // without popping the keyboard on a tablet. A real tap opens it on
                          // demand, same trick as the order-search and vehicle-search inputs.
                          inputMode="none"
                          onPointerDown={(e) => { (e.currentTarget as HTMLInputElement).inputMode = "text"; }}
                          onBlur={(e) => { (e.currentTarget as HTMLInputElement).inputMode = "none"; }}
                          value={itemBarcode}
                          onChange={(e) => setItemBarcode(e.target.value)}
                          onKeyDown={(e) => { if (e.key === "Enter") handleItemBarcode(itemBarcode); }}
                          placeholder="Scan or type an item barcode…"
                          className="h-10 pl-9 text-sm"
                        />
                      </div>
                    )}

                  </div>
                </div>
              </div>
            )}
          </div>
          {/* Closes the header card opened above (vehicle/progress identity row) — now one
              continuous block through the Total/Scanner/Owner/Sort row, instead of ending right
              after the identity row and starting a new, separately-bordered block for the tabs.
              The items table below stays its own separate card. */}
          </div>

          {/* Items table with live load progress — full width below the totals/scanner row. */}
          <div className="flex min-h-0 flex-1 flex-col rounded-xl border border-gray-200 bg-white shadow-sm overflow-hidden">
              <div className="flex flex-wrap items-center gap-2 px-4 sm:px-5 py-3.5 border-b border-gray-100">
                <Package className="h-4 w-4 text-[#001d6e]" />
                <span className="text-sm font-semibold text-gray-900">Items on this order</span>
                <span className="text-xs text-gray-400">
                  {itemStatusFilter || itemSearchText ? `(${filteredItems.length} of ${items.length})` : `(${items.length})`}
                </span>
                {/* All/Pallet/Loose — three separate lists sharing one table. "All" shows every
                    item with both numbers merged; "Pallet" and "Loose" each narrow the rows
                    below to just that group (based on the Loaded column's own split), showing
                    only that one figure — never both lists visible at once, only one active. */}
                <div className="flex overflow-hidden rounded-full border border-gray-200">
                  <button
                    type="button"
                    onClick={() => setItemUnitTab("all")}
                    className={`px-3 py-1 text-xs font-semibold transition-colors ${itemUnitTab === "all" ? "bg-[#001d6e] text-white" : "text-gray-500 hover:bg-gray-50"}`}
                  >
                    All
                  </button>
                  <button
                    type="button"
                    onClick={() => setItemUnitTab("pallet")}
                    className={`px-3 py-1 text-xs font-semibold transition-colors ${itemUnitTab === "pallet" ? "bg-[#001d6e] text-white" : "text-gray-500 hover:bg-gray-50"}`}
                  >
                    Pallet
                  </button>
                  <button
                    type="button"
                    onClick={() => setItemUnitTab("loose")}
                    className={`px-3 py-1 text-xs font-semibold transition-colors ${itemUnitTab === "loose" ? "bg-[#001d6e] text-white" : "text-gray-500 hover:bg-gray-50"}`}
                  >
                    Loose
                  </button>
                </div>
                <div className="ml-auto flex items-center gap-2">
                  {allComplete && <span className="rounded-full bg-emerald-100 px-2 py-0.5 text-[10px] font-bold text-emerald-700">ALL LOADED</span>}
                  {canScanThisLoad && (
                    <button
                      type="button"
                      onClick={() => setExtraDialogOpen(true)}
                      title="Add an item not on this slip, or more than what's remaining"
                      className="inline-flex items-center gap-1.5 rounded-xl bg-amber-500 px-2.5 py-1.5 text-xs font-bold text-white shadow-sm transition-colors hover:bg-amber-600"
                    >
                      <PackagePlus className="h-3.5 w-3.5" /> Add Extra
                    </button>
                  )}
                  {items.length > 0 && (
                    <button
                      onClick={downloadLoadingItemsCsv}
                      className="inline-flex items-center gap-1.5 rounded-xl border border-gray-200 bg-white px-2.5 py-1.5 text-xs font-medium text-gray-700 shadow-sm hover:bg-gray-50"
                    >
                      <Download className="h-3.5 w-3.5" /> Export
                    </button>
                  )}
                  <CollapsibleSearch value={itemSearchText} onChange={setItemSearchText} placeholder="Search items…" />
                </div>
              </div>
              {/* Same wide table on every screen — mobile, tablet, and the rotated kiosk view
                  all get the exact 5-column ITEM NAME/EXPECTED/LOADED/REMAINING/STOCK layout,
                  not a separate cut-down design. showMobileSwipeHint surfaces DataTable's own
                  "swipe to see more" affordance on any screen too narrow for all 5 columns at
                  once, since its own overflow-x-auto keeps that contained to the table, never
                  the page. */}
              {/* Tablet widths only (sm up to, not including, xl): the item rows become cards, two
                  to a row, since the 5-column table leaves a tablet cramped. Phones keep the
                  table above, desktop keeps it too, and so does the rotated kiosk view. */}
              {!rotated && (
                <div className={`hidden min-h-0 overflow-y-auto p-3 ${itemCardsShow}`} style={scannerOpen ? { maxHeight: openSlipTableMaxHeight } : undefined}>
                  {filteredItems.length === 0 ? (
                    <p className="py-8 text-center text-sm text-gray-400">{itemStatusFilter || itemSearchText ? "No items match this filter." : "No items on this slip."}</p>
                  ) : (
                    <div className="space-y-2">
                      {filteredItems.map((row) => {
                        const extra = Math.max(0, row.loaded - row.expected);
                        const noStock = (row.stockAvailable ?? 0) <= 0;
                        const tone = row.isComplete
                          ? { bar: "bg-emerald-500", edge: "border-l-emerald-500", badge: "bg-emerald-50 text-emerald-700 ring-emerald-200", label: "Loaded" }
                          : row.loaded > 0
                            ? { bar: "bg-amber-500", edge: "border-l-amber-400", badge: "bg-amber-50 text-amber-700 ring-amber-200", label: "Partial" }
                            : { bar: "bg-gray-300", edge: "border-l-gray-300", badge: "bg-gray-50 text-gray-500 ring-gray-200", label: "Pending" };
                        const expanded = !!row.barcode && expandedItemBarcode === row.barcode;
                        return (
                          <div key={row.barcode ?? `row-${row.id}`} className={expanded ? "col-span-2" : undefined}>
                            <div
                              role={row.barcode ? "button" : undefined}
                              onClick={() => row.barcode && setExpandedItemBarcode((cur) => (cur === row.barcode ? null : row.barcode!))}
                              className={`flex items-center gap-2.5 rounded-lg border border-l-4 border-gray-200 bg-white px-2.5 py-2 text-left shadow-sm transition hover:shadow ${tone.edge}`}
                            >
                              {/* Tap the picture to enlarge it (zoomable); the row itself toggles the history. */}
                              <ItemRowThumb name={row.itemName} className="h-10 w-10 shrink-0" />
                              <div className="min-w-0 flex-1">
                                <p className="truncate text-sm font-semibold text-gray-900">{row.itemName ?? "—"}</p>
                                <p className="truncate font-mono text-[11px] text-gray-400">
                                  {row.barcode || "—"}{row.sapCode ? ` · SAP ${row.sapCode}` : ""}{(row.itemsPerPallet ?? 0) > 0 ? ` · ${row.itemsPerPallet}/plt` : ""}
                                </p>
                                <p className="mt-0.5 text-sm tabular-nums text-gray-600">
                                  Expected <span className="font-bold text-gray-900">{row.expected}</span>
                                  <span className="text-gray-300"> · </span>
                                  Loaded <span className="font-bold text-emerald-600">{row.loaded}</span>
                                  <span className="text-gray-300"> · </span>
                                  Remaining <span className="font-bold text-[#001d6e]">{row.remaining}</span>
                                  <span className="text-gray-300"> · </span>
                                  Stock <span className={`font-bold ${noStock ? "text-red-600" : "text-gray-700"}`}>{row.stockAvailable ?? 0}</span>
                                  {extra > 0 && <span className="ml-1.5 font-bold text-amber-600">+{extra} extra</span>}
                                  {noStock && <span className="ml-1.5 rounded-full bg-red-100 px-1.5 py-px text-[10px] font-bold text-red-700">NO STOCK</span>}
                                </p>
                              </div>
                              <span className={`shrink-0 rounded-full px-2 py-0.5 text-[10px] font-semibold ring-1 ring-inset ${tone.badge}`}>{tone.label}</span>

                              {canScanThisLoad && row.barcode && (
                                <div className="flex shrink-0 items-center gap-1">
                                  <Button size="sm" variant="ghost" disabled={row.loaded <= 0}
                                    className="h-7 w-7 rounded-full bg-red-100 p-0 text-sm font-bold text-red-700 hover:bg-red-200 hover:text-red-800 disabled:opacity-40"
                                    title="Remove from loaded quantity"
                                    onClick={(e) => { e.stopPropagation(); openAdjustDialog(row, "remove"); }}>−</Button>
                                  <span className="min-w-[2.25rem] text-center text-sm font-bold tabular-nums text-gray-900" title="Current loaded quantity">{row.loaded}</span>
                                  <Button size="sm" variant="ghost"
                                    className="h-7 w-7 rounded-full bg-emerald-100 p-0 text-sm font-bold text-emerald-700 hover:bg-emerald-200 hover:text-emerald-800"
                                    title="Add to loaded quantity"
                                    onClick={(e) => { e.stopPropagation(); openAdjustDialog(row, "add"); }}>+</Button>
                                </div>
                              )}
                            </div>
                            {expanded && <div className="mt-1 rounded-xl border border-gray-200 bg-white">{renderLoadingItemHistoryPanel(row)}</div>}
                          </div>
                        );
                      })}
                    </div>
                  )}
                </div>
              )}
              <DataTable<ProformaItem>
                className={`min-h-0 flex-1 ${rotated ? "" : itemTableHide}`}
                containerClassName="rounded-none border-0"
                headerClassName="bg-[#001d6e] text-white border-[#1a3a9c] hover:bg-[#0a2b7e] hover:text-white text-xs sm:text-xs"
                columns={loadingItemColumns}
                data={filteredItems}
                getRowId={(row) => row.barcode ?? `row-${row.id}`}
                enableZebraStripes
                rowClassName={(row) => (row.isComplete ? "bg-emerald-50/50" : undefined)}
                renderExpandedRow={renderLoadingItemHistoryPanel}
                isRowExpandable={(row) => !!row.barcode}
                expandedRowId={expandedItemBarcode}
                onRowClick={(row) => row.barcode && setExpandedItemBarcode((cur) => (cur === row.barcode ? null : row.barcode!))}
                emptyState="No items on this slip."
                noResultsState="No items match this filter."
                hasActiveFilters={!!itemStatusFilter || !!itemSearchText}
                sortMode="client"
                enableTotalsRow
                totalsLabelColumnId="item"
                enableColumnResizing
                isStickyHeader
                maxHeight={openSlipTableMaxHeight}
                showMobileSwipeHint
              />
            </div>
          </div>
        )}
      </div>

      {/* ── Auto Scan feedback popup — same popup Order Scan shows for 5s after an
          auto-confirmed (full-pallet) scan: product image + name/barcode/SAP + how much was
          scanned and what remains. Non-blocking (pointer-events-none) — operator keeps
          scanning; no confirm needed. Rapid scans replace it and reset the 5s timer. ── */}
      {autoFeedback && (
        <div className="fixed inset-x-0 top-16 z-[90] flex justify-center px-4 pointer-events-none" role="status">
          <div className="w-[calc(100%-2rem)] max-w-3xl sm:max-w-4xl min-h-[24rem] flex flex-col bg-white p-8 shadow-xl ring-1 ring-gray-200 animate-in fade-in slide-in-from-top-2">
            <div className={`flex items-center gap-2.5 ${autoFeedback.isExtra ? "text-amber-700" : "text-emerald-700"}`}>
              <Zap className="h-7 w-7 shrink-0" />
              <span className="text-2xl font-semibold">{autoFeedback.isExtra ? "Auto scanned (extra)" : "Auto scanned"}</span>
            </div>
            <div className="flex flex-1 gap-5 items-start pt-4">
              {/* Rendered conditionally on state (not left in the DOM with display:none via
                  onError) so the text column actually reflows to take the freed width when the
                  product has no cached image, instead of leaving a blank gap where it was. */}
              {!autoFeedbackImageFailed && (
                <ProductPhoto
                  productId={autoFeedback.productId}
                  name={autoFeedback.name}
                  className="h-64 w-64 shrink-0 object-contain bg-gray-50 border border-gray-100"
                  onLoadState={setAutoFeedbackImageFailed}
                />
              )}
              <div className="flex-1 min-w-0 text-lg">
                <p className="font-semibold text-gray-900 break-words text-2xl">{autoFeedback.name}</p>
                <p className="mt-2 font-mono text-lg text-gray-400 break-all">
                  {autoFeedback.barcode}{autoFeedback.sapCode && ` · SAP: ${autoFeedback.sapCode}`}
                </p>
                <p className="mt-5 text-3xl">
                  <span className={`font-bold ${autoFeedback.isExtra ? "text-amber-600" : "text-emerald-600"}`}>+{autoFeedback.scannedQty}</span>
                  <span className="text-gray-500"> scanned</span>
                  {autoFeedback.remaining > 0 && (
                    <span className="ml-2 font-semibold text-[#001d6e]">{autoFeedback.remaining} left</span>
                  )}
                </p>
              </div>
            </div>
          </div>
        </div>
      )}

      {/* "Create Load Operation from Proforma" — the same confirmation step Load Operations shows
          between finding a slip and starting work on it: full slip details, every item on it, and
          an explicit Create Operation before the scanning view opens. */}
      <Dialog open={!!pendingSlip} onOpenChange={(open) => { if (!open) { setPendingSlip(null); setPendingStv(""); setCapacityAck(false); } }}>
        <DialogContent className="sm:max-w-[700px] w-full overflow-y-auto max-h-[90vh]">
          <DialogHeader>
            <DialogTitle>Create Load Operation from Proforma</DialogTitle>
            <DialogDescription>
              Search for a proforma slip by order number to create a Load operation.
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-4 pt-2">
            <div className="space-y-6">
              <div className="border rounded-md p-4 bg-muted/30">
                <h3 className="text-lg font-semibold mb-2">Proforma Slip Details</h3>
                <div className="grid gap-2">
                  <div className="flex justify-between items-center">
                    <span className="text-muted-foreground">Order Number:</span>
                    <span className="font-medium">#{pendingSlip?.slip?.orderNumber || "N/A"}</span>
                  </div>
                  <div className="flex justify-between items-center">
                    <span className="text-muted-foreground">Order Date:</span>
                    <span className="font-medium">
                      {pendingSlip?.slip?.orderDate
                        ? new Date(`${String(pendingSlip.slip.orderDate).slice(0, 10)}T00:00:00`).toLocaleDateString("en-IN", { timeZone: "Asia/Kolkata", day: "2-digit", month: "2-digit", year: "numeric" })
                        : "N/A"}
                    </span>
                  </div>
                  <div className="flex justify-between items-center">
                    <span className="text-muted-foreground">Load Date:</span>
                    <span className="font-medium">
                      {pendingSlip?.slip?.loadDate
                        ? new Date(pendingSlip.slip.loadDate).toLocaleDateString("en-IN", { timeZone: "Asia/Kolkata", day: "2-digit", month: "2-digit", year: "numeric" })
                        : "Not started yet"}
                    </span>
                  </div>
                  <div className="flex justify-between items-center">
                    <span className="text-muted-foreground">Party Name:</span>
                    <span className="font-medium">{pendingSlip?.slip?.partyName || "N/A"}</span>
                  </div>
                  <div className="flex justify-between items-center">
                    <span className="text-muted-foreground">Plant:</span>
                    <span className="font-medium"><PlantBadge plant={pendingSlip?.slip?.plant || ""} /></span>
                  </div>
                  <div className="flex justify-between items-center">
                    <span className="text-muted-foreground">Vehicle Number:</span>
                    <span className="font-medium">
                      {pendingSlip?.slip?.vehicleNumber
                        ? `${pendingSlip.slip.vehicleNumber}${pendingSlip.slip.rtoNumber ? ` · ${pendingSlip.slip.rtoNumber}` : ""}`
                        : "Not assigned"}
                    </span>
                  </div>
                  <div className="flex justify-between items-center">
                    <span className="text-muted-foreground">Driver Name:</span>
                    <span className="font-medium">{pendingSlip?.slip?.driverName || "Not assigned"}</span>
                  </div>
                  <div className="flex justify-between items-center">
                    <span className="text-muted-foreground">Status:</span>
                    {/* The real status stored on the slip (notionStatus) — not a guess derived
                        from loadingCompletedAt/vehicleNumber, so an order already at some other
                        real-world stage (DISPATCHED, SHORTAGE, ...) shows that, not "PENDING". */}
                    <Badge
                      variant="secondary"
                      className={
                        pendingSlipAlreadyLoading
                          ? "bg-red-100 text-red-800 hover:bg-red-200"
                          : "bg-purple-100 text-purple-800 hover:bg-purple-200"
                      }
                    >
                      {pendingSlip?.slip?.notionStatus || "PENDING"}
                    </Badge>
                  </div>
                  <div className="flex justify-between items-center">
                    <span className="text-muted-foreground">Total Items:</span>
                    <span className="font-medium">{pendingSlip?.items?.length || 0}</span>
                  </div>
                  <div className="flex justify-between items-center">
                    <span className="text-muted-foreground">Order Volume:</span>
                    <span className="font-medium">
                      {Number.isFinite(pendingOrderVolume) ? `${pendingOrderVolume} cu ft` : "—"}
                    </span>
                  </div>
                  <div className="flex justify-between items-center">
                    <span className="text-muted-foreground">Vehicle Capacity:</span>
                    <span className={`font-medium ${pendingOverCapacity ? "text-red-600" : ""}`}>
                      {pendingVehicleVolume != null ? `${pendingVehicleVolume} cu ft` : "—"}
                    </span>
                  </div>
                </div>
                {pendingSlipAlreadyLoading && (
                  <div className="mt-3 rounded-md border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-700">
                    Status is already Loading — not able to load.
                  </div>
                )}
                {pendingMissingSortSlip && !pendingSlipAlreadyLoading && (
                  <div className="mt-3 rounded-md border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-700">
                    <span className="font-semibold">This plant requires a Sort Slip before Create Operation.</span>{" "}
                    Create one for order {pendingSlip?.slip?.orderNumber} on the Sort Slip page first.
                  </div>
                )}
                {pendingOverCapacity && !pendingSlipAlreadyLoading && (
                  <div className="mt-3 space-y-2 rounded-md border border-amber-300 bg-amber-50 px-3 py-2 text-sm text-amber-800">
                    <p>
                      <span className="font-semibold">This order does not fit on this vehicle.</span>{" "}
                      It needs <span className="font-semibold">{pendingOrderVolume} cu ft</span> but{" "}
                      {pendingSlip?.slip?.vehicleNumber ?? "the vehicle"} holds only{" "}
                      <span className="font-semibold">{pendingVehicleVolume} cu ft</span>
                      {" "}({(pendingOrderVolume - (pendingVehicleVolume ?? 0)).toFixed(2)} cu ft over).
                      Link a bigger vehicle, or carry on knowing part of the order will be left behind.
                    </p>
                    <label className="flex cursor-pointer items-center gap-2 font-medium">
                      <Checkbox checked={capacityAck} onCheckedChange={(v) => setCapacityAck(v === true)} />
                      Create it anyway
                    </label>
                  </div>
                )}
              </div>

              {/* STV (platform) — required, and the only place it can ever be set: once Create
                  Operation succeeds the server freezes it on the slip and records it, with the
                  creator's first name, into the slip's StoreKeeper Info. Hence the explicit
                  "cannot be changed later" warning rather than a silently-defaulted picker. */}
              {canWrite && (
                <div className="border rounded-md">
                  <h4 className="text-sm font-medium p-3 border-b bg-muted/30">
                    Dispatch Directory <span className="text-red-600">*</span>
                  </h4>
                  <div className="p-3 space-y-2">
                    {stvs.length > 0 ? (
                      <Select value={pendingStv || NO_STV} onValueChange={(v) => setPendingStv(v === NO_STV ? "" : v)}>
                        <SelectTrigger className={pendingStv ? "" : "border-amber-400 bg-amber-50"}>
                          <SelectValue placeholder="Select Dispatch Directory…" />
                        </SelectTrigger>
                        <SelectContent>
                          <SelectItem value={NO_STV}>— Select Dispatch Directory —</SelectItem>
                          {stvs.map((st) => (
                            <SelectItem key={st} value={st}>{st}</SelectItem>
                          ))}
                        </SelectContent>
                      </Select>
                    ) : !stvsQuery.isLoading && (
                      <div className="rounded-md border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-700">
                        No Dispatch Directory configured for {pendingSlip?.slip?.plant || "this plant"} — add one in Plant Settings before creating this operation.
                      </div>
                    )}
                    <p className="text-xs text-muted-foreground">
                      Recorded against this load and cannot be changed later.
                    </p>
                  </div>
                </div>
              )}

              {/* Link / change the vehicle without leaving the dialog — same Vehicle Master
                  search the scanning view uses, acting on this not-yet-started slip. */}
              {canWrite && (
                <div className="border rounded-md">
                  <h4 className="text-sm font-medium p-3 border-b bg-muted/30">
                    {pendingSlip?.slip?.vehicleAssignedByCode ? "Change vehicle" : "Link a vehicle"}
                  </h4>
                  <div className="p-3 space-y-3">
                    {/* The search box below is deliberately empty here (it's for picking a
                        DIFFERENT vehicle, not re-confirming this one) — without this, a slip
                        that already has one confirmed looked exactly like a slip with none at
                        all, since nothing else in this dialog shows what's actually assigned. */}
                    {pendingSlip?.slip?.vehicleAssignedByCode && pendingSlip.slip.vehicleNumber && (
                      <div className="flex items-center gap-1.5 rounded-md bg-emerald-50 px-3 py-2 text-sm text-emerald-800">
                        <Truck className="h-3.5 w-3.5 shrink-0" />
                        Currently assigned: <span className="font-semibold">{pendingSlip.slip.vehicleNumber}</span>
                        {pendingSlip.slip.rtoNumber && <span className="text-emerald-600">({pendingSlip.slip.rtoNumber})</span>}
                      </div>
                    )}
                    <div className="relative">
                      <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-gray-400" />
                      <Input
                        value={vehicleSearch}
                        onChange={(e) => { setVehicleSearch(e.target.value); setSelectedVehicle(null); setVehicleSuggIdx(-1); }}
                        onFocus={() => setVehicleFocused(true)}
                        onBlur={() => setTimeout(() => setVehicleFocused(false), 150)}
                        onKeyDown={(e) => {
                          if (vehicleFocused && vehicleSuggestions.length > 0) {
                            if (e.key === "ArrowDown") { e.preventDefault(); setVehicleSuggIdx((i) => Math.min(i + 1, vehicleSuggestions.length - 1)); return; }
                            if (e.key === "ArrowUp") { e.preventDefault(); setVehicleSuggIdx((i) => Math.max(i - 1, -1)); return; }
                            if (e.key === "Escape") { setVehicleFocused(false); return; }
                            if (e.key === "Enter" && vehicleSuggIdx >= 0) { e.preventDefault(); pickVehicle(vehicleSuggestions[vehicleSuggIdx]); return; }
                          }
                        }}
                        placeholder="Vehicle number, driver, company…"
                        className="h-10 pl-9 pr-9 text-sm"
                      />
                      {vehicleSearch && (
                        <button onClick={() => { setVehicleSearch(""); setSelectedVehicle(null); }} className="absolute right-3 top-1/2 -translate-y-1/2 text-gray-400 hover:text-gray-600">
                          <X className="h-4 w-4" />
                        </button>
                      )}
                      {vehicleFocused && !selectedVehicle && debouncedVehicleSearch.trim().length >= 1 && (
                        <div className="absolute z-20 mt-1 w-full rounded-lg border border-gray-200 bg-white shadow-lg overflow-hidden">
                          {vehicleSuggestionsQuery.isFetching ? (
                            <SectionSkeleton lines={2} />
                          ) : vehicleSuggestions.length === 0 ? (
                            <p className="px-4 py-3 text-xs text-gray-400">No matching vehicles.</p>
                          ) : (
                            vehicleSuggestions.map((v, i) => (
                              <button
                                key={v.id}
                                onMouseDown={(e) => e.preventDefault()}
                                onClick={() => pickVehicle(v)}
                                className={`flex w-full items-center justify-between gap-2 px-4 py-2.5 text-left border-b border-gray-100 last:border-0 ${i === vehicleSuggIdx ? "bg-[#001d6e]/10" : "hover:bg-[#001d6e]/5"}`}
                              >
                                <div className="min-w-0">
                                  <div className="flex items-center gap-1.5">
                                    <div className="text-sm font-semibold text-[#001d6e] truncate">{v.vehicleNumber}</div>
                                    {v.fromNotion && (
                                      <span className="shrink-0 rounded-full bg-amber-100 px-1.5 py-0.5 text-[10px] font-semibold uppercase tracking-wide text-amber-700">
                                        From Notion
                                      </span>
                                    )}
                                  </div>
                                  <div className="text-xs text-gray-500 truncate">{[v.rtoNumber && `RTO ${v.rtoNumber}`, v.driver, v.company].filter(Boolean).join(" · ") || "—"}</div>
                                </div>
                                <ChevronRight className="h-4 w-4 shrink-0 text-gray-300" />
                              </button>
                            ))
                          )}
                        </div>
                      )}
                    </div>

                    {selectedVehicle && (
                      <div className="flex items-center justify-between gap-2 rounded-lg border border-[#001d6e]/20 bg-[#001d6e]/5 px-3 py-2.5">
                        <div className="min-w-0 text-sm">
                          <span className="font-semibold text-[#001d6e]">{selectedVehicle.vehicleNumber}</span>
                          <span className="text-gray-500"> — RTO {selectedVehicle.rtoNumber ?? "—"}{selectedVehicle.volume != null ? ` · Vol ${selectedVehicle.volume}` : ""}</span>
                        </div>
                        <Button size="sm" className="h-8 shrink-0 bg-[#001d6e] text-white hover:bg-[#001552]"
                          disabled={linkVehicleMutation.isPending}
                          onClick={() => linkVehicleMutation.mutate(selectedVehicle)}>
                          {linkVehicleMutation.isPending ? <Loader2 className="mr-1.5 h-3.5 w-3.5 animate-spin" /> : <Link2 className="mr-1.5 h-3.5 w-3.5" />}
                          {pendingSlip?.slip?.vehicleAssignedByCode ? "Update" : "Link"}
                        </Button>
                      </div>
                    )}
                  </div>
                </div>
              )}

              <div className="border rounded-md">
                <h4 className="text-sm font-medium p-3 border-b bg-muted/30">Items in Slip</h4>
                <div className="max-h-60 overflow-y-auto">
                  <Table>
                    <TableHeader>
                      <TableRow>
                        <TableHead className="w-24">Sr. No.</TableHead>
                        <TableHead>Name</TableHead>
                        <TableHead className="w-20 text-right">Qty</TableHead>
                      </TableRow>
                    </TableHeader>
                    <TableBody>
                      {(pendingSlip?.items?.length ?? 0) > 0 ? (
                        pendingSlip!.items.map((item, idx) => (
                          <TableRow key={item.id}>
                            <TableCell>{item.srNo || idx + 1}</TableCell>
                            <TableCell className="max-w-[200px] break-words whitespace-normal">{item.itemName || "-"}</TableCell>
                            <TableCell className="text-right">{item.expected ?? item.quantity ?? 0}</TableCell>
                          </TableRow>
                        ))
                      ) : (
                        <TableRow>
                          <TableCell colSpan={3} className="text-center py-4">No items in this slip</TableCell>
                        </TableRow>
                      )}
                    </TableBody>
                  </Table>
                </div>
              </div>

              <div className="flex flex-col space-y-4 pt-2">
                <Button variant="outline" className="w-full" onClick={() => { setPendingSlip(null); setPendingStv(""); setOrderSearch(""); }}>
                  Cancel
                </Button>
                <Button
                  variant="default"
                  className="w-full bg-[#001d6e] hover:bg-[#001d6e]/90"
                  disabled={startLoadMutation.isPending || pendingSlipAlreadyLoading || pendingMissingSortSlip || !pendingStv || (pendingOverCapacity && !capacityAck)}
                  onClick={() => { if (pendingSlip && pendingStv) startLoadMutation.mutate({ orderNumber: pendingSlip.slip.orderNumber, stv: pendingStv }); }}
                >
                  {startLoadMutation.isPending ? (
                    <><Loader2 className="mr-2 h-4 w-4 animate-spin" />Creating...</>
                  ) : (
                    <>Create Operation</>
                  )}
                </Button>
                <Button type="button" variant="ghost" className="w-full" onClick={() => { setPendingSlip(null); setPendingStv(""); setOrderSearch(""); setTimeout(() => orderInputRef.current?.focus(), 50); }}>
                  <ChevronLeft className="h-4 w-4 mr-1" />
                  Back to Search
                </Button>
              </div>
            </div>
          </div>
        </DialogContent>
      </Dialog>

      {/* Confirm dialog — loose/partial regular scans. Extras never reach this — they go through
          their own dedicated Add Extra popup below. Same product-photo-on-the-left treatment
          Order Scan's own confirm dialog (and this page's own Add Extra dialog, just below) use
          — this one never had it, unlike every other scan-confirmation screen in the app. No id
          to look it up by here (ProformaItem carries no productId), so it goes by name, same as
          the box-image-by-name/image-by-name fallback ProductPhoto already supports. */}
      <Dialog open={!!pending} onOpenChange={(open) => { if (!open) setPending(null); }}>
        <DialogContent className="overflow-x-hidden overflow-y-auto p-0 sm:max-w-lg">
          <div className="flex flex-col sm:flex-row">
            <div className="flex shrink-0 items-center justify-center border-b border-gray-100 bg-gray-50 p-4 sm:w-48 sm:border-b-0 sm:border-r">
              <ProductPhoto
                name={pending?.item?.itemName ?? pending?.barcode}
                className="max-h-48 w-full object-contain"
                zoomable
              />
            </div>
            <div className="min-w-0 flex-1 p-6">
          <DialogHeader>
            <DialogTitle>{pending?.item?.itemName ?? pending?.barcode ?? "Confirm scan"}</DialogTitle>
            <DialogDescription>
              Expected {pending?.item?.expected} · Loaded {pending?.item?.loaded} · Remaining {pending?.item?.remaining}
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-3">
            {pending?.item && !((pending.item.realPackSize ?? 0) > 0) && (
              <p className="rounded-lg bg-amber-50 px-3 py-2 text-xs font-semibold text-amber-700">
                Pallet size is not set for this item in Product Master — enter the quantity you are loading.
              </p>
            )}
            {pending?.item && (pending.item.realPackSize ?? 0) > 0 && pending.item.itemsPerPallet > 0 ? (
              <div className="grid grid-cols-2 gap-3">
                <div>
                  <Label className="text-xs">Pallets</Label>
                  <Input
                    value={dialogPalletsInput}
                    onChange={(e) => {
                      setDialogPalletsInput(e.target.value);
                      const p = parseFloat(e.target.value);
                      if (Number.isFinite(p)) setDialogQty(Math.round(p * (pending.item!.itemsPerPallet)));
                    }}
                    type="number" step="0.01" min="0"
                  />
                </div>
                <div>
                  <Label className="text-xs">Qty</Label>
                  <Input
                    value={dialogQty === 0 ? "" : dialogQty}
                    onChange={(e) => {
                      const q = parseInt(e.target.value, 10) || 0;
                      setDialogQty(q);
                      setDialogPalletsInput((q / pending.item!.itemsPerPallet).toFixed(2));
                    }}
                    type="number" min="0"
                  />
                </div>
              </div>
            ) : (
              <div>
                <Label className="text-xs">Qty</Label>
                <Input value={dialogQty === 0 ? "" : dialogQty} onChange={(e) => setDialogQty(parseInt(e.target.value, 10) || 0)} type="number" min="1" autoFocus />
              </div>
            )}
            {pending && (pending.item?.stockAvailable ?? Infinity) < dialogQty && (
              <p className="text-xs text-red-600">Only {pending.item?.stockAvailable} in stock — reduce the quantity.</p>
            )}
            {/* Can never submit a qty beyond what's remaining — same rule the server enforces
                (EXTRA_NOT_ALLOWED in loading.ts's /scan); Cancel and use "Add Extra" for the
                amount beyond this. */}
            {pending && pending.item && dialogQty > pending.item.remaining && (
              <p className="text-xs text-amber-600">
                Only {pending.item.remaining} remaining — the rest would be extra. Cancel and use "Add Extra" instead.
              </p>
            )}
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setPending(null)}>Cancel</Button>
            <Button
              className="bg-[#001d6e] text-white hover:bg-[#001552]"
              disabled={
                dialogQty <= 0 || scanItemMutation.isPending
                || (pending?.item?.stockAvailable ?? Infinity) < dialogQty
                || (!!pending && !!pending.item && dialogQty > pending.item.remaining)
              }
              onClick={() => {
                if (!pending) return;
                scanItemMutation.mutate({ barcode: pending.barcode, qty: dialogQty }, {
                  onSuccess: () => setPending(null),
                });
              }}
            >
              {scanItemMutation.isPending ? <Loader2 className="mr-1.5 h-3.5 w-3.5 animate-spin" /> : null}
              Confirm
            </Button>
          </DialogFooter>
            </div>
          </div>
        </DialogContent>
      </Dialog>

      {/* Add Extra — the only way to log an item not on this slip, or more than what's
          remaining for one that is (a regular scan refuses both — see EXTRA_NOT_ALLOWED in
          loading.ts's /scan). Search the whole product catalog by name/barcode/SAP (same
          catalog + pattern ExchangeProductDialog uses), confirm by sight via the product's own
          image, then a qty/pallets pair defaulting to one full pallet. */}
      <Dialog open={extraDialogOpen} onOpenChange={(open) => { if (!open) resetExtraDialog(); }}>
        {/* Same two-column shell Order Scan's own scan-confirmation dialog uses — a real product
            image on the left (only once one's picked; the search step has nothing to show yet),
            everything else on the right — rather than a thumbnail strip above stacked fields. */}
        {/* overflow-x-hidden alongside overflow-y-auto is deliberate — leaving x unset while y
            is constrained computes x to auto per spec, which is exactly what put a horizontal
            scrollbar under the search view (same fix as the page-level scroll container's own
            comment about this elsewhere in this file). */}
        <DialogContent className={`overflow-x-hidden overflow-y-auto p-0 ${extraTarget ? "sm:max-w-3xl" : "max-w-xl"}`}>
          <div className={extraTarget ? "flex flex-col sm:flex-row" : ""}>
            {extraTarget && (
              <div className="flex shrink-0 items-center justify-center border-b border-gray-100 bg-gray-50 p-4 sm:w-56 sm:border-b-0 sm:border-r">
                <ProductPhoto
                  productId={extraTarget.id}
                  className="max-h-56 w-full object-contain sm:max-h-64"
                  name={extraTarget.name}
                  zoomable
                />
              </div>
            )}
            <div className="min-w-0 flex-1 p-6">
              <DialogHeader>
                <DialogTitle className="flex items-center gap-2 text-amber-700">
                  <PackagePlus className="h-4 w-4" /> Add Extra
                </DialogTitle>
                {!extraTarget && (
                  <DialogDescription>
                    Search for the item — this always logs as extra, whether or not it's on this order.
                  </DialogDescription>
                )}
              </DialogHeader>

              {extraTarget ? (() => {
                // gjPlt/mpPlt (the real per-state pallet size), not itemsPerPallet — that field
                // is "Packets" in the Product Master UI, a different concept.
                const extraIpp = extraProductPalletSize(extraTarget);
                return (
                <div className="space-y-4 pt-3">
                  <div className="flex items-start justify-between gap-2">
                    <p className="text-lg font-bold leading-snug text-gray-900">{extraTarget.name}</p>
                    <button
                      type="button"
                      onClick={() => setExtraTarget(null)}
                      className="shrink-0 text-xs font-medium text-gray-400 underline decoration-dotted hover:text-gray-600"
                    >
                      Change
                    </button>
                  </div>
                  <p className="font-mono text-sm text-gray-400">{extraTarget.barcode}</p>

                  {/* Same info-box treatment Order Scan's own confirm dialog uses for SAP/pallet
                      size, instead of small inline text. */}
                  {(extraTarget.sapCode || extraIpp > 0) && (
                    <div className="space-y-1 rounded-xl bg-gray-50 px-4 py-3 text-sm text-gray-600">
                      {extraTarget.sapCode && <p>SAP: <span className="font-mono font-bold text-gray-700">{extraTarget.sapCode}</span></p>}
                      {extraIpp > 0 && <p>Items per pallet: <strong>{extraIpp}</strong></p>}
                    </div>
                  )}

                  {/* Same −/+ stepper boxes Order Scan's own confirm dialog uses for Qty/Pallets,
                      instead of plain number inputs — easy to nudge by one box/pallet without
                      having to type. */}
                  <div className={`grid gap-3 ${extraIpp > 0 ? "sm:grid-cols-2" : "grid-cols-1"}`}>
                    <div className="space-y-1">
                      <Label className="text-sm">Qty (boxes)</Label>
                      <div className="flex items-stretch overflow-hidden rounded-xl border-2 border-gray-300 bg-white focus-within:border-amber-500">
                        <Button
                          type="button" variant="ghost"
                          className="h-12 w-11 shrink-0 rounded-none border-r border-gray-200 text-2xl font-bold text-gray-500 hover:bg-gray-100"
                          onClick={() => changeExtraQty(String(Math.max(1, extraQty - 1)))}
                          aria-label="Decrease quantity"
                        >
                          −
                        </Button>
                        <Input
                          type="number" min={1}
                          value={extraQty === 0 ? "" : extraQty}
                          onChange={(e) => changeExtraQty(e.target.value)}
                          className="h-12 min-w-0 flex-1 rounded-none border-0 px-1 text-center text-xl font-bold focus-visible:ring-0 focus-visible:ring-offset-0"
                        />
                        <Button
                          type="button" variant="ghost"
                          className="h-12 w-11 shrink-0 rounded-none border-l border-gray-200 text-2xl font-bold text-gray-500 hover:bg-gray-100"
                          onClick={() => changeExtraQty(String(extraQty + 1))}
                          aria-label="Increase quantity"
                        >
                          +
                        </Button>
                      </div>
                    </div>

                    {extraIpp > 0 && (
                      <div className="space-y-1">
                        <Label className="text-sm">Pallets <span className="font-normal text-gray-400">· {extraIpp}/pallet</span></Label>
                        <div className="flex items-stretch overflow-hidden rounded-xl border-2 border-amber-300 bg-white focus-within:border-amber-500">
                          <Button
                            type="button" variant="ghost"
                            className="h-12 w-11 shrink-0 rounded-none border-r border-amber-100 text-2xl font-bold text-amber-700 hover:bg-amber-50"
                            onClick={() => changeExtraPallets(String(Math.max(0, Math.round(((parseFloat(extraPalletsInput) || 0) - 1) * 100) / 100)))}
                            aria-label="Decrease pallets"
                          >
                            −
                          </Button>
                          <Input
                            type="number" min={0} step="0.01"
                            value={extraPalletsInput}
                            onChange={(e) => changeExtraPallets(e.target.value)}
                            className="h-12 min-w-0 flex-1 rounded-none border-0 px-1 text-center text-xl font-bold text-amber-700 focus-visible:ring-0 focus-visible:ring-offset-0"
                          />
                          <Button
                            type="button" variant="ghost"
                            className="h-12 w-11 shrink-0 rounded-none border-l border-amber-100 text-2xl font-bold text-amber-700 hover:bg-amber-50"
                            onClick={() => changeExtraPallets(String(Math.round(((parseFloat(extraPalletsInput) || 0) + 1) * 100) / 100))}
                            aria-label="Increase pallets"
                          >
                            +
                          </Button>
                        </div>
                      </div>
                    )}
                  </div>
                </div>
                );
              })() : (
                <div className="space-y-2 pt-1">
                  {/* Camera/Manual toggle — same mobile-scanner pattern as the regular item
                      scanner, so an operator can scan the extra straight in instead of typing. */}
                  <div className="flex overflow-hidden rounded-xl border border-gray-300 divide-x divide-gray-300 bg-white">
                    <button
                      type="button"
                      onClick={() => setExtraScanMode("camera")}
                      className={`flex-1 flex items-center justify-center gap-1.5 py-2 text-xs font-semibold transition-colors ${extraScanMode === "camera" ? "bg-[#001d6e] text-white" : "text-gray-500 hover:bg-gray-50"}`}
                    >
                      <Camera className="h-3.5 w-3.5" /> Camera
                    </button>
                    <button
                      type="button"
                      onClick={() => { stopExtraCamera(); setExtraScanMode("manual"); }}
                      className={`flex-1 flex items-center justify-center gap-1.5 py-2 text-xs font-semibold transition-colors ${extraScanMode === "manual" ? "bg-[#001d6e] text-white" : "text-gray-500 hover:bg-gray-50"}`}
                    >
                      <Keyboard className="h-3.5 w-3.5" /> Manual
                    </button>
                  </div>

                  <div className="relative w-full bg-black rounded-2xl overflow-hidden" style={{ display: extraScanMode === "camera" ? "block" : "none", height: "clamp(190px, 40vw, 260px)" }}>
                    <video ref={extraVideoRef} autoPlay muted playsInline className="absolute inset-0 h-full w-full object-cover" />
                    <div className="pointer-events-none absolute inset-0" style={{ background: "radial-gradient(ellipse 70% 55% at 50% 50%, transparent 55%, rgba(0,0,0,0.55) 100%)" }} />
                    {extraScanMode === "camera" && !extraCameraReady && !extraCameraError && (
                      <div className="absolute inset-0 flex flex-col items-center justify-center gap-2 text-white z-10">
                        <Loader2 className="h-7 w-7 animate-spin opacity-90" />
                        <p className="text-xs font-medium opacity-80">Starting camera…</p>
                      </div>
                    )}
                    {extraScanMode === "camera" && extraCameraError && (
                      <div className="absolute bottom-0 left-0 right-0 flex items-center gap-2 bg-red-900/85 px-3 py-2 text-xs text-white z-10">
                        <AlertTriangle className="h-3.5 w-3.5 shrink-0" /> {extraCameraError}
                      </div>
                    )}
                  </div>

                  {extraScanMode === "manual" && (
                  <div className="relative">
                    <Search className="absolute left-2.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-gray-400" />
                    <Input
                      className="h-9 pl-8 text-sm"
                      placeholder="Search item name, barcode or SAP code…"
                      value={extraSearch}
                      onChange={(e) => handleExtraSearchChange(e.target.value)}
                      autoFocus
                    />
                  </div>
                  )}
                  {allProductsQuery.isFetching && <p className="px-1 text-xs text-gray-400">Loading catalog…</p>}
                  {/* scrollbar-none: the OS's own scrollbar (wide, classic-styled, with arrow
                      buttons on this machine) was rendering past the rounded border no matter
                      how it was resized — inconsistently, depending on how many rows there were
                      to scroll. Hiding it outright is the only fix that holds regardless of
                      result count; the list still scrolls fine by wheel/touch/drag without it. */}
                  {extraSearch.trim() && !allProductsQuery.isFetching && (
                    <div className="overflow-hidden rounded-md border">
                      <div className="scrollbar-none max-h-56 divide-y overflow-y-auto">
                        {extraSearchResults.length === 0 ? (
                          <p className="px-3 py-3 text-xs text-gray-400">No matching item.</p>
                        ) : (
                          extraSearchResults.map((p) => (
                            <button
                              key={p.id}
                              type="button"
                              onClick={() => pickExtraTarget(p)}
                              className="flex w-full items-center gap-2.5 px-3 py-2 text-left hover:bg-gray-50"
                            >
                              <ProductPhoto
                                productId={p.id}
                                className="h-9 w-9 shrink-0 rounded border bg-white object-contain"
                              />
                              <div className="min-w-0 flex-1">
                                <p className="truncate text-sm font-medium text-gray-900">{p.name}</p>
                                <p className="truncate font-mono text-xs text-gray-400">{p.barcode}{p.sapCode && ` · SAP ${p.sapCode}`}</p>
                              </div>
                            </button>
                          ))
                        )}
                      </div>
                    </div>
                  )}
                </div>
              )}

              <DialogFooter className="mt-5">
                <Button variant="outline" onClick={resetExtraDialog} disabled={extraMutation.isPending}>Cancel</Button>
                <Button
                  className="bg-amber-600 text-white hover:bg-amber-700"
                  disabled={!extraTarget || extraQty <= 0 || extraMutation.isPending}
                  onClick={() => extraMutation.mutate()}
                >
                  {extraMutation.isPending ? <Loader2 className="mr-1.5 h-3.5 w-3.5 animate-spin" /> : <PackagePlus className="mr-1.5 h-3.5 w-3.5" />}
                  Add Extra
                </Button>
              </DialogFooter>
            </div>
          </div>
        </DialogContent>
      </Dialog>

      {/* Delete confirmation — reverses everything this slip's loading did: stock added back,
          scan history voided (kept for audit, same as individual Void), vehicle un-assigned,
          the row itself removed from this table. Cannot be undone from here. */}
      <Dialog open={!!resetTarget} onOpenChange={(o) => { if (!o) setResetTarget(null); }}>
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle className="text-red-600">Delete this loading slip?</DialogTitle>
            <DialogDescription>
              Order <span className="font-semibold text-gray-900">#{resetTarget?.orderNumber}</span>
              {resetTarget?.vehicleNumber ? <> on <span className="font-semibold text-gray-900">{resetTarget.vehicleNumber}</span></> : null}.
              Either way, all loaded stock is returned, the vehicle, owner and Dispatch Directory are cleared, the status goes back to what
              it was before loading started, and the proforma slip itself is not changed.
            </DialogDescription>
          </DialogHeader>

          {/* Two ways to delete — pick by what should be left behind. */}
          <div className="space-y-2">
            <button
              type="button"
              disabled={resetMutation.isPending}
              onClick={() => { if (resetTarget) resetMutation.mutate({ orderNumber: resetTarget.orderNumber, mode: "void" }); }}
              className="w-full rounded-lg border border-amber-300 bg-amber-50 px-3 py-2.5 text-left transition-colors hover:bg-amber-100 disabled:opacity-60"
            >
              <span className="flex items-center gap-1.5 text-sm font-semibold text-amber-800">
                {resetMutation.isPending && resetMutation.variables?.mode === "void" ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : null}
                Delete, keep history as Void
              </span>
              <span className="mt-0.5 block text-xs text-amber-700">
                Scan entries stay in Scan History marked Voided, so there is still a record of what was loaded.
              </span>
            </button>
            <button
              type="button"
              disabled={resetMutation.isPending}
              onClick={() => { if (resetTarget) resetMutation.mutate({ orderNumber: resetTarget.orderNumber, mode: "remove" }); }}
              className="w-full rounded-lg border border-red-300 bg-red-50 px-3 py-2.5 text-left transition-colors hover:bg-red-100 disabled:opacity-60"
            >
              <span className="flex items-center gap-1.5 text-sm font-semibold text-red-700">
                {resetMutation.isPending && resetMutation.variables?.mode === "remove" ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : null}
                Remove completely
              </span>
              <span className="mt-0.5 block text-xs text-red-600">
                All scan entries, handoff history and stock records for this load are permanently deleted from the database. This cannot be undone.
              </span>
            </button>
          </div>

          <DialogFooter>
            <Button variant="outline" onClick={() => setResetTarget(null)} disabled={resetMutation.isPending}>
              Cancel
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Reopen confirmation — admin-only action that undoes a completed, audited load. */}
      <Dialog open={!!reopenTarget} onOpenChange={(o) => { if (!o) setReopenTarget(null); }}>
        <DialogContent className="sm:max-w-sm">
          <DialogHeader>
            <DialogTitle className="text-amber-700">Reopen this load?</DialogTitle>
            <DialogDescription>
              Order <span className="font-semibold text-gray-900">#{reopenTarget}</span> is marked complete.
              Reopening puts it back to Loading so scanning can continue.
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button variant="outline" onClick={() => setReopenTarget(null)} disabled={reopenMutation.isPending}>
              Cancel
            </Button>
            <Button
              className="bg-amber-600 text-white hover:bg-amber-700"
              disabled={reopenMutation.isPending}
              onClick={() => {
                if (!reopenTarget) return;
                reopenMutation.mutate(reopenTarget);
                setReopenTarget(null);
              }}
            >
              {reopenMutation.isPending ? <Loader2 className="mr-1.5 h-3.5 w-3.5 animate-spin" /> : <RotateCcw className="mr-1.5 h-3.5 w-3.5" />}
              Reopen
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Claim confirmation — takes over ownership of a paused load from whoever had it. */}
      <Dialog open={!!claimTarget} onOpenChange={(o) => { if (!o) setClaimTarget(null); }}>
        <DialogContent className="sm:max-w-sm">
          <DialogHeader>
            <DialogTitle>Claim this load?</DialogTitle>
            <DialogDescription>
              Order <span className="font-semibold text-gray-900">#{claimTarget}</span> is currently paused.
              Claiming it makes you the owner — you will be the one allowed to scan it from here on.
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button variant="outline" onClick={() => setClaimTarget(null)} disabled={claimLoadMutation.isPending}>
              Cancel
            </Button>
            <Button
              className="bg-amber-500 text-white hover:bg-amber-600"
              disabled={claimLoadMutation.isPending}
              onClick={() => {
                if (!claimTarget) return;
                claimLoadMutation.mutate(claimTarget);
                setClaimTarget(null);
              }}
            >
              {claimLoadMutation.isPending && <Loader2 className="mr-1.5 h-3.5 w-3.5 animate-spin" />}
              Claim
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Void confirmation — a single scan event, same rule/effect as Scan History's own Void:
          stock reversed, kept in history marked Voided (never deleted). */}
      {/* Confirm before completing — the same "say what is still short, then let them decide"
          dialog Unloading uses, instead of completing straight from the button click. */}
      <Dialog open={stvChangeOpen} onOpenChange={(o) => { if (!o) setStvChangeOpen(false); }}>
        <DialogContent className="sm:max-w-sm">
          <DialogHeader>
            <DialogTitle>Change STV / Platform</DialogTitle>
            <DialogDescription>
              #{slip?.orderNumber} is currently on <span className="font-semibold text-[#001d6e]">{lockedStv}</span>.
              Every platform this load has ever used stays on record — picking a new one adds to
              that history, it doesn't erase {lockedStv}.
            </DialogDescription>
          </DialogHeader>
          <Select value={stvChangeValue} onValueChange={setStvChangeValue}>
            <SelectTrigger>
              <SelectValue placeholder="Select STV…" />
            </SelectTrigger>
            <SelectContent>
              {stvs.map((st) => (
                <SelectItem key={st} value={st}>{st}</SelectItem>
              ))}
            </SelectContent>
          </Select>
          <DialogFooter>
            <Button variant="outline" onClick={() => setStvChangeOpen(false)} disabled={changeStvMutation.isPending}>
              Cancel
            </Button>
            <Button
              className="bg-[#001d6e] text-white hover:bg-[#001552]"
              disabled={changeStvMutation.isPending || !stvChangeValue || stvChangeValue === lockedStv}
              onClick={() => changeStvMutation.mutate(stvChangeValue)}
            >
              {changeStvMutation.isPending && <Loader2 className="mr-1.5 h-3.5 w-3.5 animate-spin" />}
              Save
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <Dialog open={confirmCompleteOpen} onOpenChange={(o) => { if (!o) setConfirmCompleteOpen(false); }}>
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle>Mark this load complete?</DialogTitle>
            <DialogDescription>
              Once complete, scanning is locked for this order until it's reopened.
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-2 text-sm text-gray-600">
            <p>
              <span className="font-semibold text-gray-900">#{slip?.orderNumber}</span>
              {slip?.partyName ? ` — ${slip.partyName}` : ""}
              {slip?.vehicleNumber ? ` · ${slip.vehicleNumber}` : ""}
            </p>
            <p>
              <span className="font-bold tabular-nums text-gray-900">{completeTotals.loaded.toLocaleString()}</span>
              {" of "}
              <span className="font-bold tabular-nums text-gray-900">{completeTotals.expected.toLocaleString()}</span>
              {" loaded."}
            </p>
            {completeTotals.remaining > 0 && (
              <p className="rounded-md bg-amber-50 px-3 py-2 text-amber-800">
                <AlertTriangle className="mr-1.5 inline h-4 w-4" />
                {completeTotals.remaining.toLocaleString()} unit(s) are still not loaded. Completing now leaves them short.
              </p>
            )}
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setConfirmCompleteOpen(false)} disabled={completeMutation.isPending}>
              Cancel
            </Button>
            <Button
              className="bg-emerald-600 text-white hover:bg-emerald-700"
              disabled={completeMutation.isPending}
              onClick={() => completeMutation.mutate()}
            >
              {completeMutation.isPending && <Loader2 className="mr-1.5 h-3.5 w-3.5 animate-spin" />}
              Complete Load
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Shown once per order, whether the load finished by itself (last scan / +/-) or was
          completed by hand. */}
      <Dialog open={!!completedInfo} onOpenChange={(o) => { if (!o) setCompletedInfo(null); }}>
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2 text-emerald-700">
              <CheckCircle2 className="h-5 w-5" /> Load complete
            </DialogTitle>
            <DialogDescription>
              {completedInfo?.auto
                ? "Every item has been fully loaded — this order was marked complete automatically."
                : "This order has been marked complete."}
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-1 text-sm text-gray-600">
            <p>
              <span className="font-semibold text-gray-900">#{completedInfo?.orderNumber}</span>
              {completedInfo?.partyName ? ` — ${completedInfo.partyName}` : ""}
            </p>
            {completedInfo?.vehicleNumber && <p>Vehicle {completedInfo.vehicleNumber}</p>}
            <p>
              <span className="font-bold tabular-nums text-gray-900">{(completedInfo?.loadedQty ?? 0).toLocaleString()}</span>
              {" of "}
              <span className="font-bold tabular-nums text-gray-900">{(completedInfo?.expectedQty ?? 0).toLocaleString()}</span>
              {" units loaded."}
            </p>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setCompletedInfo(null)}>Stay on this order</Button>
            <Button className="bg-[#001d6e] text-white hover:bg-[#001d6e]/90" onClick={() => { setCompletedInfo(null); backToList(); }}>
              Back to list
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <Dialog open={!!voidTarget} onOpenChange={(o) => { if (!o) { setVoidTarget(null); setVoidReason(""); } }}>
        <DialogContent className={`max-w-sm`}>
          <DialogHeader>
            <DialogTitle>Void this scan?</DialogTitle>
          </DialogHeader>
          <p className="text-sm text-gray-600">
            <span className="font-semibold text-gray-900">{voidTarget?.itemName ?? voidTarget?.barcode}</span> — {voidTarget?.totalQty ?? 0} scanned by {voidTarget?.scannedByName ?? "—"}.
          </p>
          <p className="text-sm text-gray-500">
            This removes it from totals and stock, but the entry stays here marked "Voided" for the record — it is never deleted.
          </p>
          <div className="space-y-1.5">
            <Label className="text-sm">Reason (optional)</Label>
            <Input value={voidReason} onChange={(e) => setVoidReason(e.target.value)} placeholder="e.g. wrong barcode scanned by mistake" />
          </div>
          <DialogFooter className="gap-2">
            <Button variant="outline" onClick={() => { setVoidTarget(null); setVoidReason(""); }} disabled={voidMutation.isPending}>
              Cancel
            </Button>
            <Button
              className="bg-red-600 hover:bg-red-700 text-white"
              disabled={voidMutation.isPending}
              onClick={() => {
                if (!voidTarget) return;
                voidMutation.mutate({ id: voidTarget.id - LOADING_EVENT_ID_OFFSET, reason: voidReason });
              }}
            >
              {voidMutation.isPending ? <Loader2 className="mr-1.5 h-3.5 w-3.5 animate-spin" /> : null}
              Void Scan
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Items table's own +/- confirm — a manual correction to loaded qty, always confirmed
          first (never fires straight off the click) with an editable quantity, defaulting to 1. */}
      <Dialog open={!!adjustTarget} onOpenChange={(o) => { if (!o) setAdjustTarget(null); }}>
        <DialogContent className={`max-w-sm`}>
          <DialogHeader>
            <DialogTitle className={adjustTarget?.direction === "add" ? "text-emerald-700" : "text-red-700"}>
              {adjustTarget?.direction === "add" ? "Add to loaded quantity?" : "Remove from loaded quantity?"}
            </DialogTitle>
          </DialogHeader>
          <p className="text-sm text-gray-600">
            <span className="font-semibold text-gray-900">{adjustTarget?.item.itemName ?? adjustTarget?.item.barcode}</span>
            {" "}— currently <strong>{adjustTarget?.item.loaded ?? 0}</strong> loaded.
          </p>
          <p className="text-sm text-gray-500">
            {adjustTarget?.direction === "add"
              ? "Removes this quantity from available stock and logs it in scan history, same as a real scan."
              : "Adds this quantity back to available stock and logs the correction in scan history."}
          </p>
          <div className="space-y-1.5">
            <Label className="text-sm">Quantity</Label>
            <div className="flex items-stretch overflow-hidden rounded-xl border-2 border-gray-300 bg-white focus-within:border-[#001d6e]">
              <Button
                type="button" variant="ghost"
                className="h-11 w-10 shrink-0 rounded-none border-r border-gray-200 text-xl font-bold text-gray-500 hover:bg-gray-100"
                onClick={() => setAdjustQty((q) => Math.max(1, q - 1))}
                aria-label="Decrease"
              >
                −
              </Button>
              <Input
                type="number" min={1}
                value={adjustQty === 0 ? "" : adjustQty}
                onFocus={() => setAdjustQty(0)}
                onChange={(e) => setAdjustQty(Math.max(0, parseInt(e.target.value, 10) || 0))}
                onBlur={() => setAdjustQty((q) => Math.max(1, q))}
                className="h-11 min-w-0 flex-1 rounded-none border-0 px-1 text-center text-lg font-bold focus-visible:ring-0 focus-visible:ring-offset-0"
              />
              <Button
                type="button" variant="ghost"
                className="h-11 w-10 shrink-0 rounded-none border-l border-gray-200 text-xl font-bold text-gray-500 hover:bg-gray-100"
                onClick={() => setAdjustQty((q) => q + 1)}
                aria-label="Increase"
              >
                +
              </Button>
            </div>
          </div>
          <DialogFooter className="gap-2">
            <Button variant="outline" onClick={() => setAdjustTarget(null)} disabled={adjustLoadMutation.isPending}>
              Cancel
            </Button>
            <Button
              className={adjustTarget?.direction === "add" ? "bg-emerald-600 hover:bg-emerald-700 text-white" : "bg-red-600 hover:bg-red-700 text-white"}
              disabled={adjustLoadMutation.isPending || adjustQty <= 0}
              onClick={() => adjustLoadMutation.mutate()}
            >
              {adjustLoadMutation.isPending ? <Loader2 className="mr-1.5 h-3.5 w-3.5 animate-spin" /> : null}
              {adjustTarget?.direction === "add" ? `Add ${adjustQty}` : `Remove ${adjustQty}`}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <ProductMasterMissingDialog message={productMasterMissingMessage} onClose={() => setProductMasterMissingMessage(null)} />
      <ProductMasterMissingDialog message={barcodeNotInSystemMessage} onClose={() => setBarcodeNotInSystemMessage(null)} title="Barcode Not Found" />
      <ProductMasterMissingDialog message={extraNotAllowedMessage} onClose={() => setExtraNotAllowedMessage(null)} title="Extra Not Allowed" />
    </div>
  );
}
