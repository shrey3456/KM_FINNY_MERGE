import { useEffect, useRef, useState } from "react";
import { useMutation, useQuery } from "@tanstack/react-query";
import type { Result } from "@zxing/library";
import type { Product } from "@shared/schema";
import BarcodeScanner from "@/lib/barcodeScanner";
import {
  AlertTriangle, Camera, CheckCircle2, ChevronDown, ChevronLeft, ChevronRight, ChevronUp, FileBarChart, Keyboard, Loader2, Package, PackageOpen, RotateCcw, RotateCw,
  ScanLine, Search, Trash2, Truck, X, Zap,
} from "lucide-react";
import { useSidebarContext } from "@/lib/sidebarContext";
import { usePersistentFilter } from "@/hooks/usePersistentFilter";
import { AddColumnFilterButton, ColumnFilterChipView, ColumnHeaderFilterButton } from "@/components/filters/ColumnFilterChip";
import { type FilterableColumn, type FilterCondition, type FilterOption, isConditionEmpty } from "@/lib/columnFilters";
import { format as formatDay } from "date-fns";
import PageHeader from "@/components/PageHeader";
import ReportsDialog, { type ReportsDialogSession } from "@/components/modals/ReportsDialog";
import ProductMasterMissingDialog from "@/components/modals/ProductMasterMissingDialog";
import { matchProductMasterMissingError, matchBarcodeNotInSystemError, parseApiErrorMessage } from "@/lib/apiError";
import { PlantBadge } from "@/components/PlantBadge";
import { ProductPhoto } from "@/components/ProductPhoto";
import { CircularProgress } from "@/components/ui/circular-progress";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { DateInput } from "@/components/ui/date-input";
import { Label } from "@/components/ui/label";
import {
  Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle,
} from "@/components/ui/dialog";
import {
  Select, SelectContent, SelectItem, SelectTrigger, SelectValue,
} from "@/components/ui/select";
import { RadioGroup, RadioGroupItem } from "@/components/ui/radio-group";
import { DataTable, buildPageList, type DataTableColumn } from "@/components/ui/data-table";
import { useToast } from "@/hooks/use-toast";
import { apiRequest, queryClient } from "@/lib/queryClient";
import { scanOrQueue } from "@/lib/offlineQueue";
import { hasPageWriteAccess } from "@/lib/permissions";
import { SectionSkeleton } from "@/components/ui/loading-skeletons";

// ─── Types (mirror server/routes/unloading.ts responses) ─────────────────────
type SessionListItem = {
  id: number; plant: string; vehicleNumber: string; orderDate: string; csvFileName: string;
  rowCount: number; groupId: number; partIndex: number; scanStatus: "available" | "active" | "completed";
  createdAt: string; scanActivatedAt: string | null; scanCompletedAt: string | null;
  // Who completed the batch — a name, "System", or null (see server/routes/unloading.ts).
  scanCompletedByName?: string | null;
  // The vehicle's RTO registration from Vehicle Master, matched on its number — null if not found.
  rtoNumber?: string | null;
  // scannedQty = every box scanned on this batch; receivedQty = the part of it that fills what the
  // file lists (each barcode capped at its own qty); extraQty = the rest (over-scans + products
  // not on the file). The opened batch's Received/Extra tiles use this same split.
  partsCount: number; expectedQty: number; scannedQty: number; receivedQty: number; extraQty: number;
  // Only the earliest not-yet-completed batch in a vehicle+date's FIFO group is eligible to be
  // clicked into (see isEligibleToActivate in server/routes/unloading.ts) — an 'available' row
  // with canActivate=false is queued behind an earlier batch that must complete first.
  canActivate: boolean;
};
type SessionItem = {
  id: number; barcode: string | null; itemName: string | null; sapCode: string | null; quantity: number;
  expected: number; scanned: number; remaining: number; itemsPerPallet: number; isComplete: boolean;
  // The pallet size actually set in Product Master for this plant's state (GJ PLT / MP PLT),
  // 0 when nobody set one. itemsPerPallet falls back to the line quantity, so only this field
  // can answer "is a real pallet size set?".
  realPackSize?: number;
};
type SessionDetail = {
  id: number; plant: string; vehicleNumber: string; orderDate: string; csvFileName: string;
  groupId: number; partIndex: number; scanStatus: "available" | "active" | "completed"; scanCompletedAt: string | null;
};
type ScanEventRow = {
  id: number; barcode: string | null; itemName: string | null; sapCode: string | null;
  pallets: number; looseQty: number; totalQty: number; isExtra: boolean; isCredit?: boolean; stv: string | null;
  scannedByCode: string | null; scannedByName: string | null; scannedAt: string;
  voided: boolean | null; voidedByCode: string | null; voidedAt: string | null; voidReason: string | null;
};
type DeletePreview = { scannedBarcodeCount: number; scannedQtyTotal: number; extraQtyTotal: number; stockApplied: boolean };

const normalize = (v?: string | number | null) => String(v ?? "").trim().toLowerCase();
const palletsOf = (qty: number, itemsPerPallet: number | null | undefined) =>
  (qty > 0 && (itemsPerPallet ?? 0) > 0 ? (qty / (itemsPerPallet as number)).toFixed(2) : "0.00");

// Totals-row counterpart to palletsOf, for columns that stack qty over its pallets in one cell:
// the column's qty summed, with the pallet figure underneath — each row's qty ÷ ITS OWN pallet
// size, added up unrounded, never one blended pallet size applied to the combined quantity.
function qtyPalletTotal<T extends { itemsPerPallet?: number | null }>(rows: T[], pick: (row: T) => number, signed = false) {
  const qty = rows.reduce((sum, row) => sum + pick(row), 0);
  const plt = rows.reduce((sum, row) => {
    const q = pick(row);
    const ipp = row.itemsPerPallet ?? 0;
    return q > 0 && ipp > 0 ? sum + q / ipp : sum;
  }, 0);
  return (
    <>
      <span className="block">{signed && qty > 0 ? `+${qty}` : qty}</span>
      <span className="block text-xs font-semibold text-gray-500">{plt.toFixed(2)} plt</span>
    </>
  );
}

// "Time taken" — wall-clock time from when a batch was first opened for scanning (activated) to
// when it was marked complete. Same measure used on Order Management and Loading's own landing
// tables, so all three read the same way.
function formatDuration(startIso: string | null, endIso: string | null): string | null {
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

function currentUser(): any {
  try { return JSON.parse(localStorage.getItem("currentUser") || "{}"); } catch { return {}; }
}
function isAdminOrSuper(): boolean {
  const role = (currentUser().role ?? "").toLowerCase().trim();
  return role === "admin" || role === "super-admin";
}
// Remembers which batch is currently open, per browser, so navigating away to another page and
// coming back to /unloading resumes exactly where you left off instead of dropping back to the
// list. Cleared once that batch is marked complete (or on an explicit "Back to list"), same
// pattern as LAST_ORDER_KEY in client/src/pages/Loading/LoadOperation.tsx.
const LAST_SESSION_KEY = "unloading_active_session_id";

// Remembers the totals / Scan Items split width, per browser, so a dragged layout survives a
// refresh.
const LEFT_COL_WIDTH_KEY = "unloading_left_col_width";
const LEFT_COL_MIN = 320;
const LEFT_COL_MAX = 760;
// Below this the four totals tiles stop fitting on one row and fold to 2x2 — a 4-digit box
// count at text-2xl plus its "1136.79 plt" line needs ~115px of tile to itself.
const TOTALS_ONE_ROW_MIN = 460;

// Remembers the operator's STV pick across page navigations — same reasoning and key pattern as
// Order Scan's OS_STV_STORAGE_KEY (client/src/pages/Scanning/Scan.tsx): this page unmounts on
// navigation, which would otherwise clear the selection and re-trigger "Select an STV".
const UNLOADING_STV_STORAGE_KEY = "km-finny.unloading.selectedStv";
const NO_STV = "__none__";

// Kiosk rotation — same idea and CSS mechanics as Order Scan's own rotate view
// (client/src/pages/Scanning/Scan.tsx, .kiosk-rotate-* in index.css): for a screen physically
// mounted at an angle (or upside-down) next to the unloading bay. Steps 0° → 90° → 180° → 270°
// → 0°, remembered per browser since a mounted screen stays in the same orientation.
const ROTATIONS = [0, 90, 180, 270] as const;
type Rotation = (typeof ROTATIONS)[number];
const SESSIONS_PAGE_SIZE_OPTIONS = [10, 20, 50, 100];
const ROTATION_STORAGE_KEY = "unloadingRotation";

function getLocalISODate(date = new Date()): string {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

// Same pattern as Scan.tsx's useOutsideClick — the ref must wrap both the search header AND the
// table below it, or clicking any row is misread as "outside" and silently clears the search.
function useOutsideClick(active: boolean, onOutside: () => void) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!active) return;
    const handler = (e: PointerEvent) => {
      const el = ref.current;
      if (!el || el.offsetParent === null) return;
      if (!el.contains(e.target as Node)) onOutside();
    };
    document.addEventListener("pointerdown", handler);
    return () => document.removeEventListener("pointerdown", handler);
  }, [active, onOutside]);
  return ref;
}

// Same pattern as Loading's own vehicle/order search (client/src/pages/Loading/LoadOperation.tsx)
// — waits for typing to pause before firing the filtered query, instead of refetching on every
// keystroke.
function useDebounced<T>(value: T, delayMs: number): T {
  const [debounced, setDebounced] = useState(value);
  useEffect(() => {
    const t = setTimeout(() => setDebounced(value), delayMs);
    return () => clearTimeout(t);
  }, [value, delayMs]);
  return debounced;
}

export default function Unloading() {
  const { toast } = useToast();
  // hasPageWriteAccess already bypasses for admin/super-admin internally — also matches the
  // server's requireUnloadingVoidAccess rule for POST /unloading/sessions/:id/reopen and
  // /unloading/events/:id/void, which is deliberately unloading-write-only (no scan-history
  // write also required, unlike the equivalent Loading/Order Scan void gates).
  const canWrite = hasPageWriteAccess("unloading");

  const [view, setView] = useState<"list" | "scan">(() => {
    try { return localStorage.getItem(LAST_SESSION_KEY) ? "scan" : "list"; } catch { return "list"; }
  });
  const [offset, setOffset] = useState(0);
  const [limit, setLimit] = useState(20);

  // Persisted (sessionStorage) — narrowing the batch list by date/vehicle is working context for
  // the current sitting. Plant has no dedicated picker here any more; it's filtered through the
  // Plant column filter instead (sessionFilterColumns below).
  // Vehicle number search (debounced) and Order Date filter — same idea as Order Management's
  // History tab (date + Today/clear) and Loading's own debounced vehicle search. Both are
  // supported server-side already (vehicleNumber was, orderDate is new); this just exposes them.
  const [sessionVehicleFilter, setSessionVehicleFilter] = usePersistentFilter("unloading:vehicleFilter", "");
  const debouncedVehicleFilter = useDebounced(sessionVehicleFilter, 300);
  const [sessionDateFilter, setSessionDateFilter] = usePersistentFilter("unloading:dateFilter", "");
  // Excel-style column filters for the landing list (see sessionFilterColumns below).
  const [sessionColumnConditions, setSessionColumnConditions] = usePersistentFilter<Record<string, FilterCondition>>("unloading:columnFilters", {});
  // Three tabs — Available (which also holds in-progress "active" batches, marked green),
  // History (shows every status), and Recent Complete (one row per PLANT — whichever batch
  // finished there most recently; see /unloading/sessions/recent-complete's own comment for why
  // this is the "what can I reopen right now" view, not a duplicate of History). Importing a CSV
  // and browsing CSV upload history both moved to the Order Import page's own "Unloading" mode
  // (client/src/pages/OrderImport.tsx) — this page is scan-workflow only now. "active"/"completed"
  // stay valid values for the underlying query param but no longer have their own tab button.
  // "Time Taken" only ever shows a value on the History tab, matching Order Management's own
  // restriction.
  const [statusTab, setStatusTab] = usePersistentFilter<"available" | "active" | "completed" | "history" | "recent-complete">("unloading:statusTab", "available");
  const sessionFilterParams =
    (debouncedVehicleFilter.trim() ? `&vehicleNumber=${encodeURIComponent(debouncedVehicleFilter.trim())}` : "")
    + (sessionDateFilter ? `&orderDate=${encodeURIComponent(sessionDateFilter)}` : "");
  // The column filters go to the SERVER now, alongside vehicle/date/status, so every one of them
  // narrows the whole list and they all apply together. Matching them in the browser only ever
  // filtered the rows already fetched, leaving the pages behind them unfiltered.
  const sessionFiltersJson = (() => {
    const list = Object.values(sessionColumnConditions).filter((c) => c && !isConditionEmpty(c));
    return list.length ? JSON.stringify(list) : "";
  })();
  const sessionsQuery = useQuery<{ sessions: SessionListItem[]; total: number }>({
    queryKey: ["/api/unloading/sessions", offset, limit, debouncedVehicleFilter, sessionDateFilter, statusTab, sessionFiltersJson],
    queryFn: () => apiRequest(
      "GET",
      `/api/unloading/sessions?limit=${limit}&offset=${offset}${sessionFilterParams}&status=${statusTab}`
      + `${sessionFiltersJson ? `&filters=${encodeURIComponent(sessionFiltersJson)}` : ""}`,
    ).then((r) => r.json()),
    enabled: statusTab !== "recent-complete",
  });
  const allSessions = sessionsQuery.data?.sessions ?? [];
  const total = sessionsQuery.data?.total ?? 0;

  // Same filter engine and UI as Overall Stock / Scan History / Scan Viewer: a "+ Filter" button,
  // a filter icon on each column header, and removable chips. Applied client-side over the page
  // already fetched — plant/vehicle/date/status tab still go to the server as before.
  // "Ready" vs "Locked (queued)" splits available batches the same way the row's own button does:
  // Locked ones sit behind an earlier batch in their vehicle + date group.
  const sessionStatusLabel = (s: SessionListItem) =>
    s.scanStatus === "completed" ? "Completed" : s.scanStatus === "active" ? "Active" : s.canActivate ? "Ready" : "Locked (queued)";
  const sessionProgressLabel = (s: SessionListItem) =>
    s.scannedQty <= 0 ? "Not started" : s.receivedQty >= s.expectedQty ? "Complete" : "Partial";
  const sessionBatchLabel = (s: SessionListItem) => (s.partsCount > 1 ? `Batch ${s.partIndex} of ${s.partsCount}` : "Single");
  const distinctOptions = (values: (string | null | undefined)[]): FilterOption[] =>
    Array.from(new Set(values.map((v) => (v ?? "").trim()).filter(Boolean))).sort().map((v) => ({ value: v, label: v }));
  const sessionFilterColumns: FilterableColumn<SessionListItem>[] = [
    { id: "vehicle", label: "Vehicle", filterType: "text", options: distinctOptions(allSessions.map((s) => s.vehicleNumber)), accessor: (s) => s.vehicleNumber },
    // Options bucketed to a day exactly as the matcher buckets the cell (lib/columnFilters dayBucket).
    { id: "orderDate", label: "Order Date", filterType: "date", options: distinctOptions(allSessions.map((s) => (s.orderDate ? formatDay(new Date(s.orderDate), "yyyy-MM-dd") : null))), accessor: (s) => s.orderDate },
    { id: "plant", label: "Plant", filterType: "text", disableConditions: true, options: distinctOptions(allSessions.map((s) => s.plant)), accessor: (s) => s.plant },
    { id: "batch", label: "Batch", filterType: "text", disableConditions: true, options: distinctOptions(allSessions.map(sessionBatchLabel)), accessor: sessionBatchLabel },
    { id: "status", label: "Status", filterType: "text", disableConditions: true, options: distinctOptions(allSessions.map(sessionStatusLabel)), accessor: sessionStatusLabel },
    { id: "progress", label: "Progress", filterType: "text", disableConditions: true, options: distinctOptions(allSessions.map(sessionProgressLabel)), accessor: sessionProgressLabel },
    { id: "csvFile", label: "CSV File", filterType: "text", options: distinctOptions(allSessions.map((s) => s.csvFileName)), accessor: (s) => s.csvFileName },
    { id: "expectedQty", label: "Expected Qty", filterType: "number", disableValues: true, options: [], accessor: (s) => s.expectedQty },
    { id: "completedBy", label: "Completed By", filterType: "text", options: distinctOptions(allSessions.map((s) => (s.scanCompletedAt ? s.scanCompletedByName : null))), accessor: (s) => (s.scanCompletedAt ? s.scanCompletedByName ?? "" : "") },
    { id: "scannedQty", label: "Received Qty", filterType: "number", disableValues: true, options: [], accessor: (s) => s.scannedQty },
    { id: "extraQty", label: "Extra Qty", filterType: "number", disableValues: true, options: [], accessor: (s) => s.extraQty },
  ];
  // The server already applied these (see sessionFiltersJson) — the rows that arrive are the
  // filtered ones, and re-filtering here would only risk the two disagreeing.
  const sessions = allSessions;
  const setSessionCondition = (id: string, condition: FilterCondition) =>
    setSessionColumnConditions((prev) => ({ ...prev, [id]: condition }));
  const clearSessionCondition = (id: string) =>
    setSessionColumnConditions((prev) => { const next = { ...prev }; delete next[id]; return next; });
  const sessionColumnHeader = (id: string, label: string) => {
    const column = sessionFilterColumns.find((c) => c.id === id);
    if (!column) return label;
    return (
      <span className="inline-flex items-center gap-1">
        {label}
        <ColumnHeaderFilterButton
          column={column}
          condition={sessionColumnConditions[id]}
          onChange={(c) => setSessionCondition(id, c)}
          onRemove={() => clearSessionCondition(id)}
        />
      </span>
    );
  };

  const statusCountsQuery = useQuery<{ available: number; active: number; completed: number; total: number }>({
    queryKey: ["/api/unloading/sessions/status-counts", debouncedVehicleFilter, sessionDateFilter],
    queryFn: () => apiRequest(
      "GET",
      `/api/unloading/sessions/status-counts${sessionFilterParams ? `?${sessionFilterParams.slice(1)}` : ""}`,
    ).then((r) => r.json()),
  });
  const statusCounts = statusCountsQuery.data ?? { available: 0, active: 0, completed: 0, total: 0 };

  // Recent Complete — one row per plant, ignores the plant filter/pagination on purpose (see the
  // tab's own comment in the JSX below and the endpoint's comment in server/routes/unloading.ts).
  const recentCompleteQuery = useQuery<{ sessions: SessionListItem[]; total: number }>({
    queryKey: ["/api/unloading/sessions/recent-complete"],
    queryFn: () => apiRequest("GET", "/api/unloading/sessions/recent-complete").then((r) => r.json()),
    enabled: statusTab === "recent-complete",
  });
  const recentCompleteSessions = recentCompleteQuery.data?.sessions ?? [];
  // Separate from reopenMutation above — that one always reopens activeSessionId (the batch
  // currently open in the scan view). This tab lets you reopen straight from the list without
  // opening the batch first, so it needs to take the id explicitly instead.
  const recentCompleteReopenMutation = useMutation({
    mutationFn: (id: number) => apiRequest("POST", `/api/unloading/sessions/${id}/reopen`, {}),
    onSuccess: () => {
      toast({ title: "Reopened" });
      queryClient.invalidateQueries({ queryKey: ["/api/unloading/sessions/recent-complete"] });
      queryClient.invalidateQueries({ queryKey: ["/api/unloading/sessions"] });
    },
    onError: (error: any) => toast({ title: "Failed to reopen", description: parseApiErrorMessage(error), variant: "destructive" }),
  });

  function selectStatusTab(key: "available" | "active" | "completed" | "history" | "recent-complete") {
    setStatusTab(key);
    setOffset(0);
  }

  const { data: allPlants } = useQuery<any[]>({
    queryKey: ["/api/plants"],
    queryFn: () => apiRequest("GET", "/api/plants").then((r) => r.json()),
    staleTime: 60000,
  });

  // ─── Scan view ──────────────────────────────────────────────────────────────
  const [activeSessionId, setActiveSessionId] = useState<number | null>(() => {
    try {
      const saved = localStorage.getItem(LAST_SESSION_KEY);
      return saved ? parseInt(saved, 10) : null;
    } catch { return null; }
  });
  const barcodeRef = useRef<HTMLInputElement>(null);

  const activeSessionQuery = useQuery<{ session: SessionDetail; items: SessionItem[]; allComplete: boolean; offBatchExtraQty?: number; offBatchExtraPallets?: number }>({
    queryKey: ["/api/unloading/sessions", activeSessionId],
    queryFn: () => apiRequest("GET", `/api/unloading/sessions/${activeSessionId}`).then((r) => r.json()),
    enabled: activeSessionId != null,
    // Live refresh — while this batch is open, another session (a second scanner on the same
    // vehicle, an admin edit, a void) can change its progress at any moment. Without this, the
    // operator only sees fresh numbers after their OWN next scan happens to refetch it — same
    // fix as Loading's own live slip/items poll (LoadOperation.tsx) and the Scan Viewer's.
    refetchInterval: 15000,
  });
  const detail = activeSessionQuery.data;
  const locked = detail?.session?.scanStatus === "completed";

  // Per-item scan history — powers each item row's expand panel in the table below.
  const itemHistoryQuery = useQuery<{ events: ScanEventRow[] }>({
    queryKey: ["/api/unloading/sessions", activeSessionId, "events"],
    queryFn: () => apiRequest("GET", `/api/unloading/sessions/${activeSessionId}/events`).then((r) => r.json()),
    enabled: activeSessionId != null && view === "scan",
  });
  const [expandedItemId, setExpandedItemId] = useState<number | null>(null);

  // Draggable totals / Scan Items split — desktop (lg) only; stacks to one column below that,
  // same breakpoint Tailwind's own lg: prefix uses elsewhere on this page.
  const [leftColWidth, setLeftColWidth] = useState<number>(() => {
    try {
      const saved = parseInt(localStorage.getItem(LEFT_COL_WIDTH_KEY) || "", 10);
      return Number.isFinite(saved) ? Math.min(LEFT_COL_MAX, Math.max(LEFT_COL_MIN, saved)) : 520;
    } catch { return 520; }
  });
  const [isDesktop, setIsDesktop] = useState(false);
  useEffect(() => {
    const mq = window.matchMedia("(min-width: 1024px)");
    const update = () => setIsDesktop(mq.matches);
    update();
    mq.addEventListener("change", update);
    return () => mq.removeEventListener("change", update);
  }, []);

  const [rotation, setRotation] = useState<Rotation>(() => {
    const saved = Number(localStorage.getItem(ROTATION_STORAGE_KEY));
    return (ROTATIONS as readonly number[]).includes(saved) ? (saved as Rotation) : 0;
  });
  useEffect(() => { localStorage.setItem(ROTATION_STORAGE_KEY, String(rotation)); }, [rotation]);
  const rotateNext = () => setRotation((r) => ROTATIONS[(ROTATIONS.indexOf(r) + 1) % ROTATIONS.length]);
  const rotated = rotation !== 0;
  const kioskRotateClass = rotated ? `kiosk-rotate-${rotation}` : "";
  // Rotated kiosk mode is a fixed, full-viewport overlay, so it sits on top of Layout's own
  // sidebar toggle — this floating button (same trick as the rotate button itself: fixed inside
  // the rotated container, so it turns with the content) reopens a path back to real navigation.
  const { setKioskRotateClass: setSidebarKioskRotateClass, setPortalRotation } = useSidebarContext();
  // Keeps Layout's sidebar turning in sync with this page's own rotation, so opening it while
  // rotated doesn't pop it up unrotated on top of everything else. Cleared on unmount — leaving
  // a stale rotation class behind would wrongly rotate the sidebar on whatever page loads next.
  useEffect(() => {
    setSidebarKioskRotateClass(kioskRotateClass);
    return () => setSidebarKioskRotateClass("");
  }, [kioskRotateClass, setSidebarKioskRotateClass]);
  const quarterTurn = rotation === 90 || rotation === 270;
  // Natural portrait (window taller than wide) — a tablet or laptop turned upright should get the
  // same single-column layout as manual Rotate, just without the 90° CSS turn, since the screen is
  // already the right way up. Same pair Order Scan uses (isPortrait/bigView in Scan.tsx).
  const [isPortrait, setIsPortrait] = useState(
    () => typeof window !== "undefined" && window.matchMedia("(orientation: portrait)").matches,
  );
  useEffect(() => {
    const mq = window.matchMedia("(orientation: portrait)");
    const onChange = () => setIsPortrait(mq.matches);
    mq.addEventListener("change", onChange);
    return () => mq.removeEventListener("change", onChange);
  }, []);
  // Drives the single-column layout; the actual 90° rotation stays tied to `rotated` alone. The
  // two-column split can't just be left to Tailwind's lg: prefix here — those breakpoints key off
  // the REAL (unrotated) window width, not the rotated container's effective width, so a rotated
  // kiosk kept getting the desktop grid crammed into a narrow band. Same reason Order Scan forces
  // its own single-column layout on for bigView instead of relying on breakpoints.
  // The vehicle list's compact mode (short action labels) also has to kick in on a plain narrow
  // window, which is neither rotated nor portrait — breakpoint classes can't be used for this
  // because a rotated kiosk's REAL window is wide even though its content area is narrow.
  const [isNarrowViewport, setIsNarrowViewport] = useState(
    () => typeof window !== "undefined" && window.matchMedia("(max-width: 1023px)").matches,
  );
  useEffect(() => {
    const mq = window.matchMedia("(max-width: 1023px)");
    const onChange = () => setIsNarrowViewport(mq.matches);
    mq.addEventListener("change", onChange);
    return () => mq.removeEventListener("change", onChange);
  }, []);
  // A narrow viewport must use the same stacked scan layout as rotated/portrait mode; otherwise
  // the totals card and scanner can remain in a desktop split and squeeze the scanner into a
  // thin column on smaller screens.
  const bigView = rotated || isPortrait || isNarrowViewport;
  const compactVehicleTable = bigView || isNarrowViewport;
  // Bounded, self-scrolling frame for tables in rotated mode — mirrors Order Scan's own
  // kioskTableBoxClass exactly (client/src/pages/Scanning/Scan.tsx). Without this, a table left
  // to flow naturally inside the rotated box has no cap of its own and no scrollbar to fall back
  // on, so it either overflows the rotated box's bounds or gets squeezed by the browser's table
  // layout algorithm into absurdly narrow columns with heavily-wrapped text — exactly the
  // "cramped, not responsive" look reported. The %-of-viewport cap flips units on a quarter turn:
  // that turns the subtree 90°, so content-space height runs along the viewport's WIDTH (vw)
  // instead of its height (vh).
  const kioskTableBoxClass = bigView
    ? `overflow-y-auto overflow-x-hidden kiosk-scroll ${quarterTurn ? "max-h-[62vw]" : "max-h-[62vh]"}`
    : "";
  // ── Rotated-view scroll fix — same as Order Scan's own (client/src/pages/Scanning/Scan.tsx):
  // a 90°-rotated container's native scroll moves content sideways on screen, not up/down, so a
  // discrete Up/Down button pair replaces continuous wheel/swipe scrolling for the vehicles table
  // in rotated mode.
  const vehiclesTableScrollRef = useRef<HTMLDivElement>(null);

  function ScrollNudgeButtons({ targetRef, amount = 240 }: { targetRef: React.RefObject<HTMLElement>; amount?: number }) {
    const nudge = (dir: 1 | -1) => targetRef.current?.scrollBy({ top: dir * amount, behavior: "smooth" });
    const btn = "rounded-2xl bg-black/10 p-3.5 text-current hover:bg-black/20 active:scale-95 transition";
    return (
      <div className="flex flex-col items-center gap-2">
        <button type="button" onClick={() => nudge(-1)} aria-label="Scroll up" title="Scroll up" className={btn}>
          <ChevronUp className="h-7 w-7" />
        </button>
        <button type="button" onClick={() => nudge(1)} aria-label="Scroll down" title="Scroll down" className={btn}>
          <ChevronDown className="h-7 w-7" />
        </button>
      </div>
    );
  }
  function handleColumnResizeStart(e: React.MouseEvent) {
    e.preventDefault();
    const startX = e.clientX;
    const startWidth = leftColWidth;
    let currentWidth = startWidth;
    const handleMove = (ev: MouseEvent) => {
      currentWidth = Math.min(LEFT_COL_MAX, Math.max(LEFT_COL_MIN, startWidth + (ev.clientX - startX)));
      setLeftColWidth(currentWidth);
    };
    const handleUp = () => {
      window.removeEventListener("mousemove", handleMove);
      window.removeEventListener("mouseup", handleUp);
      try { localStorage.setItem(LEFT_COL_WIDTH_KEY, String(currentWidth)); } catch { /* ignore */ }
    };
    window.addEventListener("mousemove", handleMove);
    window.addEventListener("mouseup", handleUp);
  }

  // Session totals for the 4-tile stat strip, and the click-to-filter state driving both the
  // tiles and the item table below — same "Total/Received/Remaining/Extra" pattern Order Scan
  // uses (osStatFilter in client/src/pages/Scanning/Scan.tsx).
  const [itemStatusFilter, setItemStatusFilter] = useState<"" | "done" | "remaining" | "extra">("");
  const itemTotals = (() => {
    const items = detail?.items ?? [];
    const acc = { expected: 0, received: 0, remaining: 0, extra: 0, pltExpected: 0, pltReceived: 0, pltRemaining: 0, pltExtra: 0 };
    for (const item of items) {
      const extra = Math.max(0, item.scanned - item.expected);
      const ipp = item.itemsPerPallet ?? 0;
      acc.expected += item.expected;
      acc.received += item.scanned;
      acc.remaining += item.remaining;
      acc.extra += extra;
      if (ipp > 0) {
        acc.pltExpected += item.expected / ipp;
        acc.pltReceived += item.scanned / ipp;
        acc.pltRemaining += item.remaining / ipp;
        acc.pltExtra += extra / ipp;
      }
    }
    // Products scanned on this vehicle that aren't on the batch file have no item row, but they
    // are boxes received — counted in Received and Extra, so these totals equal the list's
    // "Received" figure for the same batch.
    const offBatchQty = detail?.offBatchExtraQty ?? 0;
    const offBatchPlt = detail?.offBatchExtraPallets ?? 0;
    acc.received += offBatchQty;
    acc.extra += offBatchQty;
    acc.pltReceived += offBatchPlt;
    acc.pltExtra += offBatchPlt;
    return acc;
  })();
  const itemPct = itemTotals.expected > 0 ? Math.min(100, Math.round((itemTotals.received / itemTotals.expected) * 100)) : 0;

  // Collapsible item-table search — same pattern as Order Scan's osSearchOpen/osSearch: an icon
  // toggles an inline input, and the array is pre-filtered here rather than via DataTable's own
  // (always-open, non-collapsible) enableSearch prop.
  const [itemSearchOpen, setItemSearchOpen] = useState(false);
  const [itemSearchText, setItemSearchText] = useState("");
  const itemSearchRef = useOutsideClick(itemSearchOpen, () => setItemSearchOpen(false));

  // Client-side "most recently scanned floats to top" ordering for the item table — same idea as
  // Order Scan's osScanSeqRef (client/src/pages/Scanning/Scan.tsx). A monotonic counter bumped in
  // scanMutation's onMutate (i.e. only once a scan is actually submitted, not merely dialog-opened),
  // keyed by item id since server items here carry no lastScannedAt to fall back on. scanItemRef
  // carries the matched item from wherever the scan was triggered (auto-scan or dialog confirm)
  // through to onMutate. Reset whenever a different batch is opened. Declared here (ahead of
  // filteredItems below, which reads it synchronously inside .sort()) rather than nearer
  // scanMutation/pending further down — filteredItems' sort runs during render, not inside a
  // later callback, so the ref must already be initialized by this point or it's a TDZ error.
  const itemScanSeqRef = useRef<{ seq: number; byId: Map<number, number> }>({ seq: 0, byId: new Map() });
  const scanItemRef = useRef<SessionItem | null>(null);

  const filteredItems = (detail?.items ?? [])
    .filter((item) => {
      if (itemStatusFilter) {
        const extra = Math.max(0, item.scanned - item.expected);
        if (itemStatusFilter === "done" && !(item.scanned > 0)) return false;
        if (itemStatusFilter === "remaining" && !(item.remaining > 0)) return false;
        if (itemStatusFilter === "extra" && !(extra > 0)) return false;
      }
      if (itemSearchText.trim()) {
        const q = itemSearchText.trim().toLowerCase();
        const hay = `${item.itemName ?? ""} ${item.barcode ?? ""} ${item.sapCode ?? ""}`.toLowerCase();
        if (!hay.includes(q)) return false;
      }
      return true;
    })
    // Whatever was scanned most recently floats to the top — same behavior as Order Scan's item
    // list (see itemScanSeqRef above). Never-scanned rows are left in their original order (stable).
    .sort((a, b) => {
      const seq = itemScanSeqRef.current.byId;
      const aSeq = seq.get(a.id) ?? 0;
      const bSeq = seq.get(b.id) ?? 0;
      return bSeq - aSeq;
    });


  function enterSession(id: number) {
    setActiveSessionId(id);
    setView("scan");
    setItemBarcode(""); setItemScanMode("manual"); setItemStatusFilter(""); setExpandedItemId(null);
    itemScanSeqRef.current = { seq: 0, byId: new Map() };
    try { localStorage.setItem(LAST_SESSION_KEY, String(id)); } catch { /* ignore */ }
  }

  // Clicking "Scan" on a not-yet-opened batch is the explicit available -> active step (mirrors
  // Order Import's CSV lifecycle) — now only opens the scan view; the first scan activates it.
  // A batch queued behind an earlier incomplete one (canActivate=false) can't be opened at all.
  // Opening a batch only opens it — it stays "available" until its first product is actually
  // scanned, and that scan is what makes it "active" (POST /scan activates an available batch
  // itself, under the same lock and next-in-line check the separate activate call used). So a batch
  // someone merely looked at, then left, no longer shows as Active on the list, and its start time
  // is when unloading really began rather than when the screen was opened.
  function openSession(s: SessionListItem) {
    if (s.scanStatus === "available" && !s.canActivate) {
      toast({ title: "Locked", description: "Complete the earlier batch for this vehicle first.", variant: "destructive" });
      return;
    }
    enterSession(s.id);
  }
  function backToList() {
    stopItemCamera();
    setView("list"); setActiveSessionId(null);
    try { localStorage.removeItem(LAST_SESSION_KEY); } catch { /* ignore */ }
    queryClient.invalidateQueries({ queryKey: ["/api/unloading/sessions"] });
  }

  // A restored session id (from a previous visit) may no longer exist or be reachable (deleted,
  // plant access changed) — fall back to the list instead of getting stuck on a dead scan view.
  useEffect(() => {
    if (activeSessionQuery.isError) backToList();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeSessionQuery.isError]);

  // Once a batch is marked complete, stop resuming straight into it on the next visit — a fresh
  // visit to /unloading should land on the list again, even though the user can still keep
  // reviewing this same completed batch right now without being kicked out. Reopening it (status
  // goes back to active) makes it resumable again.
  useEffect(() => {
    if (!detail?.session || activeSessionId == null) return;
    try {
      if (detail.session.scanStatus === "completed") localStorage.removeItem(LAST_SESSION_KEY);
      else localStorage.setItem(LAST_SESSION_KEY, String(activeSessionId));
    } catch { /* ignore */ }
  }, [detail?.session?.scanStatus, activeSessionId]);

  const autoScanEnabled = (() => {
    const plantName = (detail?.session?.plant ?? "").toLowerCase();
    if (!plantName) return false;
    const p = (allPlants ?? []).find((pl: any) => String(pl.name ?? "").toLowerCase() === plantName);
    return p?.isAutoScanEnabled === true;
  })();

  // Pallet size is a per-STATE fact (products.gjPlt/mpPlt), not per-plant — a plant just knows
  // which state it's in (plants.state). Same pair Order Scan uses (getPlantState/
  // getStatePalletSize in Scan.tsx) — itemsPerPallet ("Packets" in the Product Master UI) is a
  // different concept and is NOT an equivalent fallback for the actual pallet size.
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
  // For an item not in this vehicle's batch: no server-resolved snapshot to start from (unlike
  // a matched SessionItem), so this is just the GJ/MP-PLT override, or 1 when the product has
  // none defined for this plant's state.
  const extraProductPalletSize = (product: Product | null): number => {
    const state = getPlantState(detail?.session?.plant ?? "");
    return Math.max(1, getStatePalletSize(product, state) || 1);
  };

  const scanMutation = useMutation({
    mutationFn: async ({ barcode, qty, stv }: { barcode: string; qty: number; stv?: string | null }) => {
      // Tries live first; falls back to the offline queue only on a genuine network failure —
      // see client/src/lib/offlineQueue.ts. A queued scan has no server response yet (the
      // regular/extra split is decided server-side, under a lock, so it can't be guessed
      // client-side) — but the optimistic bump in onMutate below still moves "scanned/remaining"
      // locally using the server's own math (expected/scanned, regardless of regular vs extra),
      // so the operator sees this scan land immediately. The 15s live poll on this query (see
      // activeSessionQuery's refetchInterval above) corrects it once the real data is back.
      const result = await scanOrQueue(
        `/api/unloading/sessions/${activeSessionId}/scan`,
        { barcode, qty, stv: stv ?? null },
        `${barcode} × ${qty} — Unloading session #${activeSessionId}`,
      );
      if (result.queued) return { queued: true as const };
      const res = result.response;
      if (!res.ok) throw new Error((await res.json().catch(() => ({})))?.message || "Scan failed");
      return { queued: false as const, data: await res.json() };
    },
    onMutate: ({ barcode, qty }) => {
      const item = scanItemRef.current;
      if (item) {
        const s = itemScanSeqRef.current;
        s.seq += 1;
        s.byId.set(item.id, s.seq);
      }
      const key = ["/api/unloading/sessions", activeSessionId] as const;
      const prevData = queryClient.getQueryData<{ session: SessionDetail; items: SessionItem[]; allComplete: boolean; offBatchExtraQty?: number; offBatchExtraPallets?: number }>(key);
      const idx = prevData?.items.findIndex((i) => normalize(i.barcode) === normalize(barcode)) ?? -1;
      if (!prevData || idx === -1) return { prevData };
      const target = prevData.items[idx];
      const scanned = target.scanned + qty;
      const nextItems = prevData.items.slice();
      nextItems[idx] = {
        ...target,
        scanned,
        remaining: Math.max(0, target.expected - scanned),
        isComplete: target.expected > 0 && scanned >= target.expected,
      };
      queryClient.setQueryData(key, { ...prevData, items: nextItems });
      return { prevData };
    },
    onSuccess: (result, vars) => {
      if (result.queued) {
        // Text must differ scan-to-scan — TOAST_LIMIT is 1 (use-toast.ts), so a second queued
        // scan replaces the first toast in the very same tick. Identical text on both meant a
        // second scan of a different item looked exactly like nothing had happened at all.
        // The dialog's per-call onSuccess is not a reliable place to release the UI when the
        // request is queued (the queue has no server response yet). Clear it here as well, so
        // an offline scan does not leave `pending` blocking the next different barcode.
        scanLockRef.current = false;
        setPending((current) => current && normalize(current.barcode) === normalize(vars.barcode) ? null : current);
        toast({
          title: "Scan saved offline",
          description: `${vars.barcode} × ${vars.qty} — will sync once you're back online.`,
        });
        return;
      }
      const data = result.data;
      // This scan was the batch's first — it just became active, so the landing list and tab
      // counts (still showing it as available) need a refresh.
      const becameActive = detail?.session?.scanStatus === "available" && data.session?.scanStatus === "active";
      queryClient.setQueryData(["/api/unloading/sessions", activeSessionId], {
        session: data.session, items: data.items, allComplete: data.allComplete,
        offBatchExtraQty: data.offBatchExtraQty, offBatchExtraPallets: data.offBatchExtraPallets,
      });
      // setQueryData above only updates the item table's own progress numbers (an instant,
      // no-refetch cache write) — it does NOT touch the separate per-item history query
      // (["/api/unloading/sessions", activeSessionId, "events"], powering each item row's
      // expand panel), so without this, a just-recorded scan kept showing "No scan history for
      // this item yet." until something else (e.g. a void, which invalidates more broadly)
      // happened to refresh it.
      queryClient.invalidateQueries({ queryKey: ["/api/unloading/sessions", activeSessionId, "events"] });
      if (becameActive) {
        queryClient.invalidateQueries({ queryKey: ["/api/unloading/sessions"], exact: false, predicate: (q) => q.queryKey[1] !== activeSessionId });
      }
      if (data.allComplete) toast({ title: "Batch complete", description: "Every item's expected quantity has been matched." });
    },
    onError: (error: any, _vars, context) => {
      // A genuine rejection (not a queue) — the optimistic bump never happened for real, so undo it.
      if (context?.prevData) queryClient.setQueryData(["/api/unloading/sessions", activeSessionId], context.prevData);
      const productMasterMissing = matchProductMasterMissingError(error);
      if (productMasterMissing) { setProductMasterMissingMessage(productMasterMissing); return; }
      const barcodeNotInSystem = matchBarcodeNotInSystemError(error);
      if (barcodeNotInSystem) { setBarcodeNotInSystemMessage(barcodeNotInSystem); return; }
      toast({ title: "Scan failed", description: parseApiErrorMessage(error) || "Could not record scan", variant: "destructive" });
    },
    onSettled: () => { scanLockRef.current = false; },
  });
  const [productMasterMissingMessage, setProductMasterMissingMessage] = useState<string | null>(null);
  const [barcodeNotInSystemMessage, setBarcodeNotInSystemMessage] = useState<string | null>(null);

  // ─── Manual/Camera barcode input, same-barcode cooldown, auto-scan popup — mirrors
  // client/src/pages/Loading/LoadOperation.tsx's item-scanning UX exactly. ─────────────────────
  const [itemScanMode, setItemScanMode] = useState<"camera" | "manual">("manual");
  const [itemBarcode, setItemBarcode] = useState("");

  // ─── STV (sub-transfer voucher) — same per-plant picker Order Scan has, reusing its existing
  // GET /api/order-scan/stvs endpoint (a generic plant-scoped lookup, not Order-Scan-specific).
  // Picked once for the vehicle, stored on every scan event (see scanMutation below).
  const [selectedStv, setSelectedStv] = useState(() => {
    try { return localStorage.getItem(UNLOADING_STV_STORAGE_KEY) ?? ""; } catch { return ""; }
  });
  useEffect(() => {
    try {
      if (selectedStv) localStorage.setItem(UNLOADING_STV_STORAGE_KEY, selectedStv);
      else localStorage.removeItem(UNLOADING_STV_STORAGE_KEY);
    } catch { /* storage unavailable (private mode) — in-memory state still works */ }
  }, [selectedStv]);
  const stvsQuery = useQuery<string[]>({
    queryKey: ["/api/order-scan/stvs", detail?.session?.plant],
    queryFn: () => apiRequest("GET", `/api/order-scan/stvs?plant=${encodeURIComponent(detail!.session.plant)}`).then((r) => r.json()),
    enabled: !!detail?.session?.plant,
  });
  const stvs = stvsQuery.data ?? [];
  // Drop a remembered STV that doesn't belong to this plant's list, and default to the first STV
  // once the list loads and nothing is picked yet — same reasoning as Order Scan's own effect.
  useEffect(() => {
    if (stvs.length === 0) return;
    if (selectedStv && !stvs.includes(selectedStv)) { setSelectedStv(""); return; }
    if (!selectedStv) setSelectedStv(stvs[0]);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [stvsQuery.data, selectedStv]);
  const [itemCameraReady, setItemCameraReady] = useState(false);
  const [itemCameraError, setItemCameraError] = useState<string | null>(null);
  const itemVideoRef = useRef<HTMLVideoElement>(null);
  const itemScannerRef = useRef<BarcodeScanner | null>(null);
  const scanLockRef = useRef(false);
  const lastScanRef = useRef<{ barcode: string; at: number } | null>(null);
  const SAME_BARCODE_COOLDOWN_MS = 5000;

  // product: the resolved Product Master row when the barcode isn't on this vehicle's batch at
  // all (pending.item null) — carries name/SAP/itemsPerPallet so the dialog can still show a
  // real identity and default the qty to a full pallet, same as Order Scan's own
  // inventoryProduct for an unmatched scan, instead of a bare barcode defaulting to 1.
  const [pending, setPending] = useState<{ barcode: string; item: SessionItem | null; product: Product | null } | null>(null);
  const [dialogQty, setDialogQty] = useState(1);
  const [dialogPalletsInput, setDialogPalletsInput] = useState("");
  // Tracks WHICH resolved name last failed to load, not a plain boolean — a boolean reset by a
  // useEffect on [pending] left a one-render gap where a new dialog's very first paint still
  // read the PREVIOUS item's "failed" flag (effects run after render, not before it), hiding an
  // image that would have loaded fine. Comparing against the current name is race-free: a new
  // name is never treated as failed until it specifically fails.
  const [dialogImageFailed, setDialogImageFailed] = useState<string | null>(null);
  const dialogPlt = pending?.item?.itemsPerPallet ?? (pending?.product ? extraProductPalletSize(pending.product) : 0);
  // Batch item whose GJ PLT / MP PLT is blank in Product Master — dialogPlt is then only the
  // line's own quantity standing in for a pallet, so the dialog asks for the amount instead.
  const dialogPackSizeMissing = !!pending?.item && !((pending.item.realPackSize ?? 0) > 0);
  const dialogResolvedImageName = pending?.item?.itemName ?? pending?.product?.name ?? pending?.barcode;

  const [autoFeedback, setAutoFeedback] = useState<
    { name: string; barcode: string; sapCode: string | null; scannedQty: number; remaining: number; isExtra: boolean; productId: number | null } | null
  >(null);
  const autoFeedbackTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  function showAutoFeedback(name: string, barcode: string, sapCode: string | null, scannedQty: number, remaining: number, isExtra: boolean, productId: number | null) {
    if (autoFeedbackTimerRef.current) clearTimeout(autoFeedbackTimerRef.current);
    setAutoFeedback({ name, barcode, sapCode, scannedQty, remaining, isExtra, productId });
    autoFeedbackTimerRef.current = setTimeout(() => setAutoFeedback(null), 5000);
  }

  function stopItemCamera() {
    itemScannerRef.current?.stop();
    setItemCameraReady(false);
  }

  // ipp: item's own server-resolved snapshot when matched to this batch, else the GJ/MP-PLT
  // override for the resolved Product Master row (NOT its plain itemsPerPallet — that field is
  // "Packets" in the Product Master UI, a different concept from the actual pallet size) — same
  // "full pallet, unless a partial amount is genuinely all that's left" rule either way.
  function defaultDialogQty(item: SessionItem | null, product: Product | null): number {
    const ipp = item?.itemsPerPallet || (product ? extraProductPalletSize(product) : 1);
    if (!item) return ipp;
    // No real GJ/MP PLT set → nothing honest to pre-fill: leave it empty (Confirm stays off)
    // so the operator types what they are actually unloading.
    if (!((item.realPackSize ?? 0) > 0)) return 0;
    return item.remaining > 0 && item.remaining < ipp ? item.remaining : ipp;
  }
  function openConfirmDialog(barcode: string, item: SessionItem | null, product: Product | null) {
    const qty = defaultDialogQty(item, product);
    const ipp = item?.itemsPerPallet || (product ? extraProductPalletSize(product) : 0);
    const packSizeMissing = !!item && !((item.realPackSize ?? 0) > 0);
    setDialogQty(qty);
    setDialogPalletsInput(ipp > 0 && !packSizeMissing ? (qty / ipp).toFixed(2) : "");
    setPending({ barcode, item, product });
  }

  // A 404 here means this barcode genuinely isn't a real product at all — anything else
  // (network hiccup, 500) shouldn't block a legitimate scan on our own connectivity/lookup
  // failure, so those are treated as "assume known" rather than risk a false block (product
  // comes back null in that case too — there's nothing to show, but the scan isn't refused).
  // Any failure here — a clean 404, or anything else (a timeout, a gateway error under
  // production load, an odd/garbage barcode string) — means "not known": there's nothing
  // legitimate to log either way, and letting an ambiguous error through as "assume it's a real
  // product, log it as an extra" was actually the worse failure mode (silently opening a qty
  // dialog for garbage input instead of a clear rejection the operator can just retry).
  async function resolveProduct(barcode: string): Promise<{ known: boolean; product: Product | null }> {
    try {
      const plant = detail?.session?.plant ? `?plant=${encodeURIComponent(detail.session.plant)}` : "";
      const res = await apiRequest("GET", `/api/products/barcode/${encodeURIComponent(barcode)}${plant}`);
      return { known: true, product: await res.json() };
    } catch {
      return { known: false, product: null };
    }
  }

  async function handleItemBarcode(rawBarcode: string) {
    const barcode = rawBarcode.trim();
    if (!barcode || !detail || locked || scanLockRef.current || pending) return;

    if (stvs.length > 0 && !selectedStv) {
      toast({ title: "Select a Dispatch Directory before scanning", description: "Pick one from the Dispatch Directory selector above, then continue scanning.", variant: "destructive" });
      return;
    }

    const nb = normalize(barcode);
    const last = lastScanRef.current;
    if (last && normalize(last.barcode) === nb && Date.now() - last.at < SAME_BARCODE_COOLDOWN_MS) return;
    lastScanRef.current = { barcode, at: Date.now() };

    const item = detail.items.find((i) => normalize(i.barcode) === nb) ?? null;
    scanLockRef.current = true;
    scanItemRef.current = item;

    // Not in this vehicle's batch — before walking the user through picking an STV/qty to
    // "log as Extra", resolve whether it's even a real product at all, and if so pull its own
    // Product Master details (name/SAP/itemsPerPallet) so the dialog can still show a real
    // identity and default the qty to a full pallet — same as Order Scan's own inventoryProduct
    // fallback for an unmatched scan — instead of a bare barcode defaulting to 1.
    let resolvedProduct: Product | null = null;
    if (!item) {
      // If this lookup throws (a network blip), the lock set above must still be released —
      // otherwise every later scan is silently ignored until the page is reloaded.
      let resolved: Awaited<ReturnType<typeof resolveProduct>>;
      try {
        resolved = await resolveProduct(barcode);
      } catch {
        scanLockRef.current = false;
        lastScanRef.current = null;
        toast({ title: "Scan failed", description: "Couldn't look up that barcode — please scan it again.", variant: "destructive" });
        return;
      }
      const { known, product } = resolved;
      if (!known) {
        scanLockRef.current = false;
        setItemBarcode("");
        setBarcodeNotInSystemMessage(`"${barcode}" is not in this vehicle's batch and not in Product Master. It cannot be scanned.`);
        return;
      }
      resolvedProduct = product;
    }

    const ipp = item?.itemsPerPallet ?? 0;
    // A pallet size that was never set in Product Master is never auto-scanned — ipp would be a
    // guess (the line's own quantity), so the dialog always opens and asks for the amount.
    const canAutoScan = autoScanEnabled && !!item && (item.realPackSize ?? 0) > 0
      && item.expected > 0 && ipp >= 1 && item.remaining >= ipp;
    if (canAutoScan) {
      scanMutation.mutate({ barcode, qty: ipp, stv: selectedStv || null }, {
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
    openConfirmDialog(barcode, item, resolvedProduct);
    setItemBarcode("");
  }

  // The gun and camera listeners are long-lived, so they call the scan handler through this ref —
  // always the latest one. Calling handleItemBarcode directly froze it at the render the listener
  // was attached in: the batch's items still loading, an STV picked afterwards, updated remaining
  // quantities — none of it was ever seen, which is how scanning could "stop" until the page was
  // reopened. Same pattern as Scan Order's handleOsBarcodeRef.
  const handleItemBarcodeRef = useRef(handleItemBarcode);
  useEffect(() => { handleItemBarcodeRef.current = handleItemBarcode; });
  const detailReady = !!detail;

  // Also re-run when the confirm pop-up closes (pending -> null): the pop-up takes focus while open,
  // and without this the next gun scan had no focused box to land in.
  useEffect(() => {
    if (view === "scan" && !pending) setTimeout(() => barcodeRef.current?.focus(), 50);
  }, [view, activeSessionId, pending]);

  // Camera scanner — active only while the Camera tab is selected.
  useEffect(() => {
    if (view !== "scan" || itemScanMode !== "camera" || !detailReady || locked) { stopItemCamera(); return; }
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
  }, [view, itemScanMode, activeSessionId, locked, detailReady]);

  // Barcode gun — a fast burst of keystrokes ending in a pause is treated as a scan, same
  // MAX_GAP_MS/BURST_END_MS heuristic as Order Scan/Loading. Attached for the whole time the scan
  // screen is open: it used to attach only if the batch had already loaded at that moment, and
  // never re-attached once it had, so a freshly opened batch could miss the gun entirely whenever
  // focus wasn't on the barcode box. Whether a scan can go through right now (batch loaded, not
  // locked, no pop-up open) is checked by the handler itself, with current values.
  useEffect(() => {
    if (view !== "scan") return;
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
      if (buffer.length >= 3) { setItemScanMode("manual"); barcodeRef.current?.focus(); handleItemBarcodeRef.current(buffer); }
      buffer = "";
    };
    const handleKeyDown = (e: KeyboardEvent) => {
      const target = e.target as HTMLElement | null;
      if (target === barcodeRef.current) return;
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
  }, [view]);

  const voidMutation = useMutation({
    mutationFn: (eventId: number) => apiRequest("POST", `/api/unloading/events/${eventId}/void`, { reason: "Voided from Unloading" }),
    onSuccess: () => {
      toast({ title: "Voided" });
      if (activeSessionId != null) queryClient.invalidateQueries({ queryKey: ["/api/unloading/sessions", activeSessionId] });
      queryClient.invalidateQueries({ queryKey: ["/api/unloading/sessions"] });
    },
    onError: (error: any) => toast({ title: "Void failed", description: parseApiErrorMessage(error), variant: "destructive" }),
  });

  // Confirmation dialog before completing — same "Complete this part?" pattern as Order Scan's
  // showForceComplete/osCompleteMutation (client/src/pages/Scanning/Scan.tsx).
  const [showCompleteConfirm, setShowCompleteConfirm] = useState(false);
  const completeMutation = useMutation({
    mutationFn: () => apiRequest("POST", `/api/unloading/sessions/${activeSessionId}/complete`, {}),
    onSuccess: () => {
      setShowCompleteConfirm(false);
      toast({ title: "Marked complete" });
      queryClient.invalidateQueries({ queryKey: ["/api/unloading/sessions", activeSessionId] });
      queryClient.invalidateQueries({ queryKey: ["/api/unloading/sessions"] });
    },
    onError: (error: any) => toast({ title: "Failed", description: parseApiErrorMessage(error), variant: "destructive" }),
  });
  const reopenMutation = useMutation({
    mutationFn: () => apiRequest("POST", `/api/unloading/sessions/${activeSessionId}/reopen`, {}),
    onSuccess: () => {
      toast({ title: "Reopened" });
      queryClient.invalidateQueries({ queryKey: ["/api/unloading/sessions", activeSessionId] });
      queryClient.invalidateQueries({ queryKey: ["/api/unloading/sessions"] });
    },
    onError: (error: any) => toast({ title: "Failed", description: parseApiErrorMessage(error), variant: "destructive" }),
  });

  // ─── Reports — same dialog Order Import uses (Summary/Activity/Hourly, per-part + whole-group),
  // pointed at Unloading's own report endpoints via basePath="unloading". ───────────────────────
  const [reportsSession, setReportsSession] = useState<ReportsDialogSession | null>(null);
  const openReports = (s: SessionListItem) => {
    setReportsSession({ id: s.id, csvFileName: s.csvFileName, plant: s.plant, receivingSessionId: s.groupId, partIndex: s.partIndex, orderDate: s.orderDate });
  };

  // ─── Delete (replace vs discard) ──────────────────────────────────────────────────────────
  const [deleteTarget, setDeleteTarget] = useState<{ id: number; vehicleNumber: string; orderDate: string } | null>(null);
  const [deleteMode, setDeleteMode] = useState<"replace" | "discard">("replace");
  const deletePreviewQuery = useQuery<DeletePreview>({
    queryKey: ["/api/unloading/sessions", deleteTarget?.id, "delete-preview"],
    queryFn: () => apiRequest("GET", `/api/unloading/sessions/${deleteTarget!.id}/delete-preview`).then((r) => r.json()),
    enabled: deleteTarget != null,
  });
  const deleteMutation = useMutation({
    mutationFn: () => apiRequest("DELETE", `/api/unloading/sessions/${deleteTarget!.id}?mode=${deleteMode}`, undefined, false, true),
    onSuccess: () => {
      toast({ title: "Deleted", description: deleteMode === "discard" ? "Stock reversed and scan history voided." : "Stock and history kept — a corrected re-upload for this vehicle+date will carry it forward." });
      setDeleteTarget(null);
      if (view === "scan") backToList(); else queryClient.invalidateQueries({ queryKey: ["/api/unloading/sessions"] });
    },
    onError: (error: any) => toast({ title: "Delete failed", description: parseApiErrorMessage(error), variant: "destructive" }),
  });

  // canActivate only matters for 'available' rows — an available batch that's next in line
  // (canActivate) reads "Available"; one still queued behind an earlier incomplete batch reads
  // "Locked" instead, since clicking it does nothing until that earlier batch completes.
  const statusBadge = (status: string, canActivate = true) => {
    if (status === "completed") return <span className="rounded-full bg-green-100 px-2 py-0.5 text-[11px] font-semibold text-green-700">Completed</span>;
    // In-progress batches live in the Available tab (no separate Active tab) — a distinct green
    // dot + label is what makes them stand out from the plain amber "Available" ones in that list.
    if (status === "active") return (
      <span className="inline-flex items-center gap-1 rounded-full bg-emerald-100 px-2 py-0.5 text-[11px] font-semibold text-emerald-700">
        <span className="h-1.5 w-1.5 rounded-full bg-emerald-500" /> Active
      </span>
    );
    if (!canActivate) return <span className="rounded-full bg-gray-100 px-2 py-0.5 text-[11px] font-semibold text-gray-500">Locked</span>;
    return <span className="rounded-full bg-amber-100 px-2 py-0.5 text-[11px] font-semibold text-amber-700">Available</span>;
  };

  // Item table columns — DataTable gives column resizing, its own search box, and expandable
  // rows for free (client/src/components/ui/data-table), same component Order Scan/Overall Stock
  // use for their own item tables.
  // Widths kept compact (total ~660px, close to Order Scan's own kiosk table's 640px) so the
  // rotated/kiosk view never needs horizontal scrolling — DataTable floors the table at the sum
  // of every column's width, so a narrower baseline here is what keeps it fitting in a rotated
  // viewport instead of scrolling sideways. Text sizes dropped one Tailwind step back down from
  // an earlier bump (text-base/text-lg felt oversized outside the kiosk/rotated view) — the
  // existing global .kiosk-rotate-* CSS (index.css) still bumps these up automatically while
  // rotated, independent of this baseline.
  // Same ring pattern as Scan Order/Master View's and Loading's own items tables: one aggregate
  // "% received" ring in the header (built from every item on this batch, not just whatever's
  // currently filtered/searched, so the aggregate never shifts just because of a search), each
  // row gets its own ring showing that item's own % received. Capped at 100/at each item's own
  // expected qty so an over-received (Extra) item can't push either number past 100.
  const unloadPctItems = detail?.items ?? [];
  const unloadQtyExpected = unloadPctItems.reduce((sum, i) => sum + (i.expected ?? 0), 0);
  const unloadQtyReceived = unloadPctItems.reduce((sum, i) => sum + Math.min(i.scanned ?? 0, i.expected ?? 0), 0);
  const unloadPct = unloadQtyExpected ? Math.min(100, Math.round((unloadQtyReceived / unloadQtyExpected) * 100)) : 0;

  const itemColumns: DataTableColumn<SessionItem>[] = [
    {
      id: "pct",
      header: <CircularProgress percent={unloadPct} size={20} strokeWidth={2} color="#38bdf8" textColor="#ffffff" />,
      // align-top: the Item column next to this one stacks 2-3 lines, which sets this row's
      // height — align-middle's default then centered the ring in all that leftover space,
      // reading as too much empty space around a tiny ring. Top-aligning it (matching where the
      // Item column's own text starts) puts the slack below the ring instead of around it.
      // px-0.5 on both header and cell: the ring is only 20px wide, so DataTable's default
      // horizontal cell padding was costing more width than the ring itself.
      width: 24, minWidth: 24, align: "center",
      headerClassName: "px-0.5", cellClassName: "align-top px-0.5", sortable: false, totalable: false,
      render: (row) => {
        const pct = row.expected > 0 ? Math.min(100, Math.round((row.scanned / row.expected) * 100)) : (row.scanned > 0 ? 100 : 0);
        return <CircularProgress percent={pct} size={20} strokeWidth={2} />;
      },
    },
    {
      id: "item",
      header: "Item",
      accessor: (row) => row.itemName ?? row.barcode ?? "",
      width: 240,
      minWidth: 140,
      render: (row) => (
        <div>
          <p className="font-medium text-gray-900 whitespace-normal break-words leading-tight text-xs">{row.itemName ?? "—"}</p>
          <p className="text-gray-400 font-mono whitespace-normal break-words leading-tight text-[10px]">
            {row.barcode ?? "—"}{row.sapCode && ` · SAP ${row.sapCode}`}
          </p>
          {(row.itemsPerPallet ?? 0) > 0 && <p className="text-gray-500 font-semibold leading-tight text-[10px]">{row.itemsPerPallet} per pallet</p>}
        </div>
      ),
    },
    {
      id: "exp", header: "Exp", align: "right", width: 80, minWidth: 60, sortable: true,
      accessor: (row) => row.expected,
      total: (rows) => qtyPalletTotal(rows, (r) => r.expected),
      render: (row) => (
        <>
          <span className="block text-base font-semibold">{row.expected || "—"}</span>
          <span className="block text-xs font-semibold text-gray-400">{palletsOf(row.expected, row.itemsPerPallet)} plt</span>
        </>
      ),
    },
    {
      id: "received", header: "Received", align: "right", width: 90, minWidth: 60, sortable: true,
      accessor: (row) => row.scanned,
      total: (rows) => qtyPalletTotal(rows, (r) => r.scanned),
      cellClassName: "font-semibold text-gray-900",
      render: (row) => (
        <>
          <span className="block text-base">{row.scanned}</span>
          <span className="block text-xs font-semibold text-gray-400">{palletsOf(row.scanned, row.itemsPerPallet)} plt</span>
        </>
      ),
    },
    {
      id: "left", header: "Remain", align: "right", width: 80, minWidth: 60, sortable: true,
      accessor: (row) => row.remaining,
      total: (rows) => qtyPalletTotal(rows, (r) => r.remaining),
      render: (row) => (
        <>
          <span className={`block text-base font-semibold ${row.remaining > 0 ? "text-[#001d6e]" : "text-gray-300"}`}>{row.remaining || "—"}</span>
          <span className="block text-xs font-semibold text-gray-400">{palletsOf(row.remaining, row.itemsPerPallet)} plt</span>
        </>
      ),
    },
    {
      id: "extra", header: "Extra", align: "right", width: 80, minWidth: 60,
      accessor: (row) => Math.max(0, row.scanned - row.expected),
      total: (rows) => qtyPalletTotal(rows, (r) => Math.max(0, r.scanned - r.expected), true),
      render: (row) => {
        const extra = Math.max(0, row.scanned - row.expected);
        return (
          <>
            <span className={`block text-base ${extra > 0 ? "text-amber-600 font-semibold" : "text-gray-300"}`}>{extra > 0 ? `+${extra}` : "—"}</span>
            <span className="block text-xs font-semibold text-gray-400">{palletsOf(extra, row.itemsPerPallet)} plt</span>
          </>
        );
      },
    },
    {
      id: "status", header: "Status", align: "center", width: 90, minWidth: 70, hideable: false, totalable: false,
      accessor: (row) => (row.isComplete ? "Received" : row.scanned > 0 ? "Partial" : "Pending"),
      render: (row) => {
        const status = row.isComplete ? "complete" : row.scanned > 0 ? "partial" : "pending";
        return (
          <span className={`inline-block font-semibold px-2 py-1 text-xs rounded ${
            status === "complete" ? "bg-emerald-100 text-emerald-700" :
            status === "partial" ? "bg-amber-100 text-amber-700" : "bg-gray-100 text-gray-500"
          }`}>
            {status === "complete" ? "Received" : status === "partial" ? "Partial" : "Pending"}
          </span>
        );
      },
    },
  ];

  const itemRowClassName = (row: SessionItem) => {
    const extra = Math.max(0, row.scanned - row.expected);
    if (extra > 0) return "bg-orange-50/40";
    if (row.isComplete) return "bg-emerald-50/40";
    if (row.scanned > 0) return "bg-amber-50/30";
    return undefined;
  };

  function renderItemHistoryPanel(row: SessionItem) {
    const rowEvents = (itemHistoryQuery.data?.events ?? []).filter((ev) => normalize(ev.barcode) === normalize(row.barcode));
    return (
      <div className="bg-gray-50 px-4 py-3">
        {itemHistoryQuery.isLoading ? (
          <SectionSkeleton lines={2} />
        ) : rowEvents.length === 0 ? (
          <div className="py-2 text-xs text-gray-400">No scan history for this item yet.</div>
        ) : (
          <table className="w-full text-[11px]">
            <thead>
              <tr className="text-left text-gray-500">
                <th className="py-1 pr-3">Qty</th>
                <th className="py-1 pr-3">By</th>
                <th className="py-1 pr-3">At</th>
                <th className="py-1 pr-3">Status</th>
                {canWrite && <th className="py-1 pr-3"></th>}
              </tr>
            </thead>
            <tbody>
              {rowEvents.map((ev) => (
                <tr key={ev.id} className={ev.voided ? "opacity-50" : ""}>
                  <td className="py-1 pr-3 tabular-nums">
                    {ev.totalQty}{ev.isExtra ? " (extra)" : ""}{ev.isCredit ? " (credit)" : ""}
                    {ev.stv && <span className="ml-1 text-gray-400">· {ev.stv}</span>}
                  </td>
                  <td className="py-1 pr-3">{ev.scannedByName ?? ev.scannedByCode ?? "—"}</td>
                  <td className="py-1 pr-3">{new Date(ev.scannedAt).toLocaleString()}</td>
                  <td className="py-1 pr-3">{ev.voided ? <span className="text-red-500">Voided</span> : <span className="text-green-600">OK</span>}</td>
                  {canWrite && (
                    <td className="py-1 pr-3">
                      {!ev.voided && (
                        <button className="text-red-500 hover:underline" onClick={() => voidMutation.mutate(ev.id)} disabled={voidMutation.isPending}>
                          Void
                        </button>
                      )}
                    </td>
                  )}
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>
    );
  }

  // ─── Scan-view header pieces ─────────────────────────────────────────────────────────
  // Shared because they render in two different places. Normally they hang off the page's own
  // PageHeader: Back above the title, the vehicle beside it, status + Complete opposite
  // it. But PageHeader is hidden in rotated kiosk mode (the fixed rotate overlay covers it), so
  // the rotated layout folds these same three pieces into its own batch bar instead.
  const scanSession = detail?.session;

  // Navigation only, never a write action — a read-only user needs this exactly as much as
  // anyone else to get off the scan view.
  const scanBackButton = (
    <Button variant="outline" size="sm" onClick={backToList}>&larr; Back</Button>
  );

  // While a vehicle is on the bay it IS the page — so the truck and its number take the title
  // slot where "Unloading" sits on the list, and this carries the rest of the identity beside it.
  const scanVehicleTitle = scanSession ? (
    <div className="flex shrink-0 items-center gap-1.5 text-[#001d6e]">
      {/* Same icon as "Unload Operations" in the sidebar, in the navy badge every page uses. */}
      <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg bg-[#001d6e]">
        <PackageOpen className="h-5 w-5 text-white" />
      </span>
      <span className="text-2xl font-bold">{scanSession.vehicleNumber}</span>
    </div>
  ) : null;

  // Replaces the old Vehicle Details card, whose column the totals tiles now occupy. The vehicle
  // number moved up into the title above, so this is just what's left: when, and which plant.
  const scanVehicleSummary = scanSession ? (
    <div className="flex min-w-0 flex-wrap items-center gap-1.5 text-xs">
      <span className="font-medium text-gray-600">{scanSession.orderDate}</span>
      <span className="text-gray-300">&middot;</span>
      <PlantBadge plant={scanSession.plant} className="px-2 py-0 text-[11px]" />
    </div>
  ) : null;

  // STV picker. Rides in the title row's action group next to Complete rather than on a line of
  // its own: it's a batch-level control like Complete is, and parked below the description on its
  // own it just read as one stray dropdown floating in whitespace.
  const scanStvControl = canWrite && !locked ? (
    <div className="flex items-center gap-2">
      <span className="text-[10px] font-semibold uppercase tracking-wide text-gray-400">Dispatch Directory</span>
      {stvs.length > 0 ? (
          // Same dropdown rotated or not. It used to swap to a native <select> when rotated, because
          // rotating the popup in place mis-positioned it — but a native select's list is drawn by
          // the browser and can't be rotated at all, so it opened upright. Rotated popups are now
          // centred and turned by the data-portal-rotation rule in index.css instead.
          <Select value={selectedStv || NO_STV} onValueChange={(v) => setSelectedStv(v === NO_STV ? "" : v)}>
            {/* Amber when nothing is picked — scanning is blocked until it is (see
                handleItemBarcode's "Select an STV before scanning" toast), so the control has to
                read as needing attention, not as an idle dropdown. */}
            <SelectTrigger className={`h-7 w-36 justify-center rounded-full text-center text-xs font-semibold ${
              selectedStv
                ? "border-[#001d6e] bg-[#001d6e]/5 text-[#001d6e] ring-1 ring-[#001d6e]/20"
                : "border-amber-400 bg-amber-50 text-amber-800 ring-1 ring-amber-300"
            }`}>
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
        <span className="rounded-full border border-dashed border-amber-300 bg-amber-50 px-2 py-1 text-xs text-amber-700">
          No Dispatch Directory — create one in Plant Settings
        </span>
      )}
    </div>
  // Read-only (or locked) — no picker, but the platform this vehicle is already on should still
  // be visible, not just hidden, to anyone who can only view this scan.
  ) : selectedStv ? (
    <div className="flex items-center gap-2">
      <span className="text-[10px] font-semibold uppercase tracking-wide text-gray-400">STV</span>
      <span className="rounded-full border border-[#001d6e]/20 bg-[#001d6e]/5 px-2 py-1 text-xs font-semibold text-[#001d6e]">
        {selectedStv}
      </span>
    </div>
  ) : null;

  const scanStatusActions = scanSession ? (
    <>
      {statusBadge(scanSession.scanStatus)}
      {scanStvControl}
      {canWrite && scanSession.scanStatus === "completed" && (
        <Button size="sm" variant="outline" onClick={() => reopenMutation.mutate()} disabled={reopenMutation.isPending}>
          <RotateCcw className="mr-1 h-3.5 w-3.5" /> Reopen
        </Button>
      )}
      {canWrite && scanSession.scanStatus !== "completed" && (
        <Button
          size="sm"
          className="h-8 rounded-full bg-emerald-600 px-3 text-xs text-white hover:bg-emerald-700"
          onClick={() => setShowCompleteConfirm(true)}
        >
          Complete
        </Button>
      )}
    </>
  ) : null;

  return (
    <div className="min-w-0 flex-1 overflow-x-hidden overflow-y-auto p-4 lg:p-6">
      <div className="mx-auto w-full max-w-[1800px] space-y-4">
        {/* The kiosk-rotate wrapper below is position:fixed over the whole viewport, so it visually
            covers this header once rotated — hidden then, and the rotated box renders the same
            PageHeader itself, above (outside) the Vehicles card. */}
        {!rotated && view === "list" && (
          <PageHeader
            icon={PackageOpen}
            title="Unload Operations"
            description="Import a vehicle-wise CSV, then pick a vehicle + date to scan its items and receive stock."
          />
        )}

        {/* Scan view: Back, the vehicle, and when/where all on one identity line —
            same compact single-row header the Loading page's own scan view uses — instead of
            a navigation action sitting alone on a line above it. */}
        {!rotated && view === "scan" && scanSession && (
          <div className="mb-4 flex flex-wrap items-center gap-3 rounded-xl border border-gray-200 bg-white px-4 py-3 shadow-sm">
            {scanBackButton}
            {scanVehicleTitle}
            {scanVehicleSummary}
            <div className="ml-auto flex flex-wrap items-center justify-end gap-2">{scanStatusActions}</div>
          </div>
        )}

        {view === "list" && (
          <div className={`${kioskRotateClass} ${rotated ? "bg-[#f4f5f7] p-4" : ""}`}>
            {rotated && (
              <div className="fixed bottom-24 right-4 z-[60] rounded-3xl bg-[#001d6e] px-2.5 py-3 text-white shadow-xl ring-1 ring-white/10">
                <ScrollNudgeButtons targetRef={vehiclesTableScrollRef} amount={360} />
              </div>
            )}
            <button
              onClick={rotateNext}
              className="fixed bottom-4 right-4 z-[60] flex items-center gap-2 rounded-full bg-[#001d6e] px-4 py-3 text-white shadow-lg transition-colors hover:bg-[#00154b]"
              title={`Rotate the screen (now ${rotation}°) — steps a quarter turn each press, back to 0° after 270°`}
            >
              <RotateCw className="h-5 w-5" />
            </button>
            {rotated && (
              <div className="mb-3">
                <PageHeader
                  icon={PackageOpen}
                  title="Unload Operations"
                  description="Import a vehicle-wise CSV, then pick a vehicle + date to scan its items and receive stock."
                />
              </div>
            )}
          <div className="rounded-xl border border-gray-200 bg-white shadow-sm overflow-hidden">
            <div className="flex items-center justify-between gap-2 px-4 sm:px-5 py-3.5 border-b border-gray-100">
              {/* Header only ABOVE this card (rotated included) — a second copy inside it pushed
                  the table down and read as a duplicate. Plant is a column filter now, so the
                  old All Plants dropdown that used to sit here is gone. */}
              <div>
                <div className="text-lg font-bold text-[#001d6e]">Vehicles</div>
                <div className="text-xs text-gray-400">{total} part(s)</div>
              </div>
            </div>

            {/* Filters — vehicle number search (debounced) + Order Date, both supported
                server-side (see /unloading/sessions), plus the shared column filters. */}
            <div className="flex flex-wrap items-center gap-2 px-4 sm:px-5 py-3 border-b border-gray-100">
              <div className="relative w-full sm:w-56">
                <Search className="pointer-events-none absolute left-2.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-gray-400" />
                <Input
                  value={sessionVehicleFilter}
                  onChange={(e) => { setSessionVehicleFilter(e.target.value); setOffset(0); }}
                  placeholder="Search vehicle number…"
                  className="h-9 pl-8 pr-7 text-sm"
                />
                {sessionVehicleFilter && (
                  <button
                    type="button"
                    onClick={() => { setSessionVehicleFilter(""); setOffset(0); }}
                    className="absolute right-2 top-1/2 -translate-y-1/2 text-gray-400 hover:text-gray-600"
                  >
                    <X className="h-3.5 w-3.5" />
                  </button>
                )}
              </div>
              <DateInput
                value={sessionDateFilter}
                onChange={(v) => { setSessionDateFilter(v); setOffset(0); }}
                clearable={false}
                className="h-9 text-sm"
              />
              {sessionDateFilter !== getLocalISODate() && (
                <Button
                  size="sm" variant="ghost" className="h-9 px-2 text-xs text-gray-500 hover:text-[#001d6e]"
                  onClick={() => { setSessionDateFilter(getLocalISODate()); setOffset(0); }}
                >
                  Today
                </Button>
              )}
              {sessionDateFilter && (
                <Button
                  size="sm" variant="ghost" className="h-9 w-9 p-0 text-gray-400 hover:text-red-500"
                  onClick={() => { setSessionDateFilter(""); setOffset(0); }}
                >
                  <X className="h-3.5 w-3.5" />
                </Button>
              )}

              <AddColumnFilterButton
                columns={sessionFilterColumns}
                conditions={sessionColumnConditions}
                onApply={setSessionCondition}
                onClear={clearSessionCondition}
                className="h-9 gap-1 rounded-md border-dashed border-[#001d6e]/40 bg-white text-xs font-medium text-[#001d6e] hover:bg-[#001d6e]/5 hover:text-[#001d6e]"
              />
              {Object.entries(sessionColumnConditions).map(([id, condition]) => (
                <ColumnFilterChipView
                  key={id}
                  columnId={id}
                  condition={condition}
                  columns={sessionFilterColumns}
                  onEdit={(c) => setSessionCondition(id, c)}
                  onRemove={() => clearSessionCondition(id)}
                />
              ))}
              {Object.keys(sessionColumnConditions).length > 1 && (
                <Button
                  size="sm" variant="ghost" className="h-9 px-2 text-xs text-gray-500 hover:text-[#001d6e]"
                  onClick={() => setSessionColumnConditions({})}
                >
                  Clear all
                </Button>
              )}
            </div>

            {/* Status tab strip — Available/History (no separate Active or Completed tab: an
                in-progress batch stays in Available, just marked green in the Status column
                so it's easy to spot — see statusBadge's "active" case below — and History
                already includes every completed batch, same reasoning Order Management's own
                Completed tab didn't need duplicating there either). */}
            <div className="px-4 sm:px-5 py-3 border-b border-gray-100">
              <div className="flex gap-1 flex-wrap">
                {(
                  [
                    { key: "available", label: "Available", count: statusCounts.available + statusCounts.active },
                    { key: "history", label: "History", count: statusCounts.total },
                    { key: "recent-complete", label: "Recent Complete", count: 0 },
                  ] as { key: "available" | "active" | "completed" | "history" | "recent-complete"; label: string; count: number }[]
                ).map((tab) => (
                  <button
                    key={tab.key}
                    onClick={() => selectStatusTab(tab.key)}
                    className={
                      statusTab === tab.key
                        ? "rounded-full bg-[#001d6e] text-white px-4 py-1.5 text-sm font-medium"
                        : "rounded-full bg-white border border-gray-200 text-gray-600 px-4 py-1.5 text-sm font-medium hover:bg-gray-50"
                    }
                  >
                    {tab.label}
                    {tab.count > 0 && (
                      <span className={`ml-1.5 inline-flex h-5 min-w-[20px] items-center justify-center rounded-full px-1 text-xs font-semibold ${
                        statusTab === tab.key ? "bg-white/20 text-white" : "bg-gray-100 text-gray-600"
                      }`}>
                        {tab.count}
                      </span>
                    )}
                  </button>
                ))}
              </div>
            </div>

            {statusTab === "recent-complete" ? (
              // One small, self-contained list — no pagination (there's at most one row per
              // plant), no rotated-vs-desktop split (it's never wide enough to need one). See
              // this tab's own comment above and /unloading/sessions/recent-complete's comment
              // in server/routes/unloading.ts for why this is a distinct list from History.
              recentCompleteQuery.isLoading ? (
                <SectionSkeleton lines={6} />
              ) : recentCompleteSessions.length === 0 ? (
                <div className="flex flex-col items-center justify-center py-16 text-center">
                  <div className="mb-3 flex h-14 w-14 items-center justify-center rounded-full bg-[#001d6e]/10">
                    <RotateCcw className="h-7 w-7 text-[#001d6e]/40" />
                  </div>
                  <div className="mb-1 text-sm font-semibold text-[#001d6e]">Nothing completed yet</div>
                  <p className="mb-4 max-w-xs text-xs text-muted-foreground">Once a batch finishes for a plant, it'll show up here.</p>
                </div>
              ) : (
                <div className="divide-y divide-gray-100">
                  {recentCompleteSessions.map((s, i) => (
                    <div
                      key={s.id}
                      className={`flex flex-wrap items-center gap-x-3 gap-y-1 px-4 py-2.5 ${i % 2 !== 0 ? "bg-slate-50" : "bg-white"}`}
                    >
                      <span className="text-sm font-bold text-[#001d6e]">{s.vehicleNumber}</span>
                      {s.rtoNumber && <span className="text-xs text-gray-500">RTO: {s.rtoNumber}</span>}
                      <PlantBadge plant={s.plant} />
                      <span className="text-xs text-gray-500">{s.orderDate}</span>
                      {s.partsCount > 1 && (
                        <span className="rounded-full bg-indigo-50 px-1.5 py-0.5 text-[11px] font-semibold text-indigo-700">Batch {s.partIndex}/{s.partsCount}</span>
                      )}
                      <span className="text-xs text-gray-600"><span className="text-gray-400">Received </span><span className="font-bold tabular-nums">{s.scannedQty}/{s.expectedQty}</span>{s.extraQty > 0 && <span className="text-amber-600"> (incl. {s.extraQty} extra)</span>}</span>
                      {s.scanCompletedAt && (
                        <span className="text-xs text-gray-400">
                          Completed {new Date(s.scanCompletedAt).toLocaleString()}
                          {s.scanCompletedByName ? <> by <span className="font-medium text-gray-600">{s.scanCompletedByName}</span></> : null}
                        </span>
                      )}
                      <div className="ml-auto flex items-center gap-1.5">
                        <Button size="sm" variant="outline" className="h-7 text-xs" onClick={() => openSession(s)}>
                          View
                        </Button>
                        <button
                          className="rounded p-1 text-gray-400 hover:bg-[#001d6e]/10 hover:text-[#001d6e]"
                          title="Reports"
                          onClick={() => openReports(s)}
                        >
                          <FileBarChart className="h-3.5 w-3.5" />
                        </button>
                        {canWrite && (
                          <Button
                            size="sm" variant="outline" className="h-7 text-xs"
                            disabled={recentCompleteReopenMutation.isPending}
                            onClick={() => recentCompleteReopenMutation.mutate(s.id)}
                          >
                            <RotateCcw className="mr-1 h-3.5 w-3.5" /> Reopen
                          </Button>
                        )}
                      </div>
                    </div>
                  ))}
                </div>
              )
            ) : sessionsQuery.isLoading ? (
              <SectionSkeleton lines={6} />
            ) : sessions.length === 0 ? (
              <div className="flex flex-col items-center justify-center py-16 text-center">
                <div className="mb-3 flex h-14 w-14 items-center justify-center rounded-full bg-[#001d6e]/10">
                  <Truck className="h-7 w-7 text-[#001d6e]/40" />
                </div>
                <div className="mb-1 text-sm font-semibold text-[#001d6e]">
                  {allSessions.length > 0 ? "No batches match these filters" : statusTab === "history" ? "No vehicles imported yet" : `No ${statusTab} batches`}
                </div>
                <p className="mb-4 max-w-xs text-xs text-muted-foreground">
                  {statusTab !== "history" ? "Check the History tab to see everything." : canWrite ? "Import a CSV to get started." : "Nothing has been imported yet."}
                </p>
              </div>
            ) : (
              <>
              <div className="space-y-3 p-3 xl:hidden">
                {sessions.map((s) => {
                  const isLockedSession = s.scanStatus === "available" && !s.canActivate;
                  const openLabel = s.scanStatus === "completed"
                    ? "View"
                    : s.scanStatus === "active"
                      ? "Continue"
                      : s.canActivate ? "Start" : "Locked";
                  return (
                    <article
                      key={s.id}
                      role="button"
                      tabIndex={0}
                      aria-label={`${openLabel} unload operation for ${s.vehicleNumber}`}
                      aria-disabled={isLockedSession}
                      onClick={() => { if (!isLockedSession) openSession(s); }}
                      onKeyDown={(e) => {
                        if (e.key === "Enter" || e.key === " ") {
                          e.preventDefault();
                          if (!isLockedSession) openSession(s);
                        }
                      }}
                      className={`rounded-lg border px-3 py-3.5 shadow-sm transition-colors ${
                        isLockedSession
                          ? "cursor-not-allowed border-gray-200 bg-gray-50 opacity-65"
                          : s.scanStatus === "active"
                            ? "cursor-pointer border-emerald-200 bg-emerald-50/40 hover:border-emerald-300"
                            : "cursor-pointer border-gray-200 bg-white hover:border-[#001d6e]/30 hover:bg-[#001d6e]/[0.02]"
                      }`}
                    >
                      <div className="flex items-start justify-between gap-3">
                        <div className="min-w-0">
                          <div className="flex flex-wrap items-center gap-2">
                            <span className="text-lg font-bold leading-none text-gray-900">#{s.id}</span>
                            <PlantBadge plant={s.plant} />
                            {s.partsCount > 1 && (
                              <span className="rounded-full bg-indigo-50 px-1.5 py-0.5 text-[11px] font-semibold text-indigo-700">
                                Batch {s.partIndex}/{s.partsCount}
                              </span>
                            )}
                          </div>
                          <p className="mt-2 truncate text-base font-medium text-gray-600">{s.vehicleNumber}</p>
                          {s.rtoNumber && <p className="mt-0.5 truncate text-xs text-gray-400">RTO: {s.rtoNumber}</p>}
                        </div>
                        <div className="shrink-0">{statusBadge(s.scanStatus, s.canActivate)}</div>
                      </div>

                      <div className="mt-4 flex items-center gap-2">
                        <span
                          title="Received quantity"
                          className="inline-flex h-11 min-w-11 items-center justify-center rounded-full bg-amber-50 px-2 text-sm font-semibold tabular-nums text-amber-700"
                        >
                          {String(s.scannedQty).padStart(2, "0")}
                        </span>
                        <button
                          type="button"
                          className="inline-flex h-11 w-11 items-center justify-center rounded-full bg-blue-50 text-[#001d6e] hover:bg-blue-100"
                          title="Reports"
                          aria-label={`View reports for ${s.vehicleNumber}`}
                          onClick={(e) => { e.stopPropagation(); openReports(s); }}
                        >
                          <FileBarChart className="h-5 w-5" />
                        </button>
                        {canWrite && (
                          <button
                            type="button"
                            className="inline-flex h-11 w-11 items-center justify-center rounded-full bg-red-50 text-red-500 hover:bg-red-100"
                            title="Delete"
                            aria-label={`Delete unload operation for ${s.vehicleNumber}`}
                            onClick={(e) => {
                              e.stopPropagation();
                              setDeleteTarget({ id: s.id, vehicleNumber: s.vehicleNumber, orderDate: s.orderDate });
                              setDeleteMode("replace");
                            }}
                          >
                            <Trash2 className="h-5 w-5" />
                          </button>
                        )}
                        <button
                          type="button"
                          className="ml-auto inline-flex h-11 w-11 items-center justify-center rounded-full bg-[#001d6e] text-white hover:bg-[#00154b] disabled:cursor-not-allowed disabled:bg-gray-300"
                          title={openLabel}
                          aria-label={`${openLabel} unload operation for ${s.vehicleNumber}`}
                          disabled={isLockedSession}
                          onClick={(e) => { e.stopPropagation(); openSession(s); }}
                        >
                          <ChevronRight className="h-5 w-5" />
                        </button>
                      </div>

                      <div className="mt-3 flex flex-wrap items-center gap-x-2 gap-y-1 border-t border-gray-100 pt-2 text-xs text-gray-500">
                        <span>Order <span className="font-semibold text-gray-700">{s.orderDate}</span></span>
                        <span className="text-gray-300">|</span>
                        <span>Expected <span className="font-semibold tabular-nums text-gray-700">{s.expectedQty}</span></span>
                        {s.extraQty > 0 && (
                          <>
                            <span className="text-gray-300">|</span>
                            <span className="font-medium text-amber-600">{s.extraQty} extra</span>
                          </>
                        )}
                        {statusTab === "history" && formatDuration(s.scanActivatedAt, s.scanCompletedAt) && (
                          <>
                            <span className="text-gray-300">|</span>
                            <span>{formatDuration(s.scanActivatedAt, s.scanCompletedAt)}</span>
                          </>
                        )}
                      </div>
                    </article>
                  );
                })}
              </div>

              {/* Desktop and kiosk mode retain the full table, bounded and self-scrolling when
                  rotated. The card list above is reserved for tablet and mobile widths. */}
              <div ref={vehiclesTableScrollRef} className={`hidden xl:block ${bigView ? kioskTableBoxClass : "overflow-x-auto"}`}>
                {/* The kiosk version intentionally shows only the operational essentials. Its
                    width is the physical screen's short edge after a quarter turn, so hiding
                    desktop-only History details prevents every cell from collapsing and wrapping. */}
                <table className="w-full min-w-full table-fixed caption-bottom border-collapse text-xs">
                  <thead className="sticky top-0 z-10">
                    <tr className="bg-[#001d6e]">
                      <th className={`${compactVehicleTable ? "w-[6%]" : "w-[5%]"} border-r border-[#1a3a9c] px-1.5 py-2 leading-tight break-words text-left text-[11px] font-semibold tracking-wide uppercase text-white`}>Sr. No</th>
                      <th className={`${compactVehicleTable ? "w-[20%]" : "w-[15%]"} border-r border-[#1a3a9c] px-1.5 py-2 leading-tight break-words text-left text-[11px] font-semibold tracking-wide uppercase text-white`}>{sessionColumnHeader("vehicle", "Vehicle")}</th>
                      <th className={`${compactVehicleTable ? "w-[14%]" : "w-[11%]"} border-r border-[#1a3a9c] px-1.5 py-2 leading-tight break-words text-left text-[11px] font-semibold tracking-wide uppercase text-white`}>{sessionColumnHeader("orderDate", "Order Date")}</th>
                      <th className={`${compactVehicleTable ? "w-[13%]" : "w-[10%]"} border-r border-[#1a3a9c] px-1.5 py-2 leading-tight break-words text-left text-[11px] font-semibold tracking-wide uppercase text-white`}>{sessionColumnHeader("plant", "Plant")}</th>
                      <th className={`${compactVehicleTable ? "w-[14%]" : "w-[12%]"} border-r border-[#1a3a9c] px-1.5 py-2 leading-tight break-words text-left text-[11px] font-semibold tracking-wide uppercase text-white`}>{sessionColumnHeader("status", "Status")}</th>
                      <th className={`${compactVehicleTable ? "w-[15%]" : "w-[10%]"} border-r border-[#1a3a9c] px-1.5 py-2 leading-tight break-words text-left text-[11px] font-semibold tracking-wide uppercase text-white`}>{sessionColumnHeader("progress", "Progress")}</th>
                      {!compactVehicleTable && <th className="w-[10%] border-r border-[#1a3a9c] px-1.5 py-2 leading-tight break-words text-left text-[11px] font-semibold tracking-wide uppercase text-white" title="Time from when scanning started to when the batch was marked complete">Time Taken</th>}
                      {!compactVehicleTable && <th className="w-[10%] border-r border-[#1a3a9c] px-1.5 py-2 leading-tight break-words text-left text-[11px] font-semibold tracking-wide uppercase text-white" title="Who marked this batch complete — the Complete button, or the scan that finished it">{sessionColumnHeader("completedBy", "Completed By")}</th>}
                      <th className={`${compactVehicleTable ? "w-[18%]" : "w-[17%]"} px-1.5 py-2 leading-tight break-words text-right text-[11px] font-semibold tracking-wide uppercase text-white`}>Action</th>
                    </tr>
                  </thead>
                  <tbody>
                    {sessions.map((s, i) => {
                      return (
                          <tr
                            key={s.id}
                            onClick={() => openSession(s)}
                            className={`transition-colors hover:bg-[#001d6e]/[0.06] ${s.scanStatus === "available" && !s.canActivate ? "cursor-not-allowed opacity-60" : "cursor-pointer"} ${s.scanStatus === "active" ? "bg-emerald-50/60" : i % 2 !== 0 ? "bg-slate-50" : "bg-white"}`}
                          >
                            <td className="border-r border-b border-gray-200 px-1.5 py-2 break-words text-gray-400 tabular-nums">{offset + i + 1}</td>
                            <td className="border-r border-b border-gray-200 px-1.5 py-2 break-words font-semibold text-[#001d6e]">
                              {s.vehicleNumber}
                              {s.rtoNumber && <span className="block text-[11px] font-normal text-gray-500">RTO: {s.rtoNumber}</span>}
                            </td>
                            <td className="border-r border-b border-gray-200 px-1.5 py-2 break-words text-gray-700">{s.orderDate}</td>
                            <td className="border-r border-b border-gray-200 px-1.5 py-2 break-words"><PlantBadge plant={s.plant} /></td>
                            <td className="border-r border-b border-gray-200 px-1.5 py-2 break-words">{statusBadge(s.scanStatus, s.canActivate)}</td>
                            <td className="border-r border-b border-gray-200 px-1.5 py-2 break-words text-gray-700 tabular-nums">
                              {s.scannedQty} / {s.expectedQty}
                              {s.extraQty > 0 && <span className="block text-[11px] text-amber-600">incl. {s.extraQty} extra</span>}
                            </td>
                            {!compactVehicleTable && <td className="border-r border-b border-gray-200 px-1.5 py-2 break-words text-gray-700 tabular-nums">
                              {statusTab === "history" ? (formatDuration(s.scanActivatedAt, s.scanCompletedAt) ?? <span className="text-gray-300">—</span>) : <span className="text-gray-300">—</span>}
                            </td>}
                            {!compactVehicleTable && <td className="border-r border-b border-gray-200 px-1.5 py-2 break-words text-gray-700">
                              {s.scanCompletedAt ? (s.scanCompletedByName ?? <span className="text-gray-300">—</span>) : <span className="text-gray-300">—</span>}
                            </td>}
                            <td className="border-b border-gray-200 px-1.5 py-2 break-words text-right">
                              <div className="flex flex-wrap items-center justify-end gap-1">
                                <Button
                                  size="sm" variant="outline" className="h-7 px-2 text-xs"
                                  disabled={s.scanStatus === "available" && !s.canActivate}
                                  title={s.scanStatus === "completed" ? "View" : s.scanStatus === "active" ? "Continue Scan" : s.canActivate ? "Start Scan" : "Locked"}
                                  onClick={(e) => { e.stopPropagation(); openSession(s); }}
                                >
                                  {s.scanStatus === "completed"
                                    ? "View"
                                    : s.scanStatus === "active"
                                      ? (compactVehicleTable ? "Continue" : "Continue Scan")
                                      : s.canActivate
                                        ? (compactVehicleTable ? "Start" : "Start Scan")
                                        : "Locked"}
                                </Button>
                                <button
                                  className="rounded p-1 text-gray-400 hover:bg-[#001d6e]/10 hover:text-[#001d6e]"
                                  title="Reports"
                                  onClick={(e) => { e.stopPropagation(); openReports(s); }}
                                >
                                  <FileBarChart className="h-3.5 w-3.5" />
                                </button>
                                {canWrite && (
                                  <button
                                    className="rounded p-1 text-gray-400 hover:bg-red-50 hover:text-red-600"
                                    title="Delete"
                                    onClick={(e) => { e.stopPropagation(); setDeleteTarget({ id: s.id, vehicleNumber: s.vehicleNumber, orderDate: s.orderDate }); setDeleteMode("replace"); }}
                                  >
                                    <Trash2 className="h-3.5 w-3.5" />
                                  </button>
                                )}
                              </div>
                            </td>
                          </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
              </>
            )}

            {statusTab !== "recent-complete" && total > 0 && (() => {
              const effectiveTotal = total;
              const pageIndex = Math.floor(offset / limit);
              const pageCount = Math.max(1, Math.ceil(effectiveTotal / limit));
              return (
                <div className="flex flex-wrap items-center justify-between gap-2 border-t border-gray-100 px-4 py-3">
                  <span className="text-xs text-muted-foreground">
                    Showing {offset + 1} to {Math.min(offset + limit, effectiveTotal)} of {effectiveTotal} entries
                  </span>
                  <nav className="flex flex-wrap items-center justify-center gap-1" aria-label="Pagination">
                    <Button
                      variant="outline" size="sm" className="h-8 w-8 p-0"
                      onClick={() => setOffset(Math.max(0, offset - limit))}
                      disabled={pageIndex === 0}
                      aria-label="Previous page"
                    >
                      <ChevronLeft className="h-4 w-4" />
                    </Button>
                    {buildPageList(pageIndex, pageCount).map((pg, i) =>
                      pg === "gap" ? (
                        <span key={`gap-${i}`} aria-hidden className="select-none px-1 text-sm text-gray-400">…</span>
                      ) : (
                        <Button
                          key={pg}
                          variant={pg === pageIndex ? "default" : "outline"}
                          size="sm"
                          className={`h-8 min-w-8 px-2 tabular-nums ${pg === pageIndex ? "bg-[#001d6e] text-white hover:bg-[#00154b]" : ""}`}
                          onClick={() => setOffset(pg * limit)}
                          aria-label={`Page ${pg + 1}`}
                          aria-current={pg === pageIndex ? "page" : undefined}
                        >
                          {pg + 1}
                        </Button>
                      ),
                    )}
                    <Button
                      variant="outline" size="sm" className="h-8 w-8 p-0"
                      onClick={() => setOffset(Math.min((pageCount - 1) * limit, offset + limit))}
                      disabled={pageIndex >= pageCount - 1}
                      aria-label="Next page"
                    >
                      <ChevronRight className="h-4 w-4" />
                    </Button>
                  </nav>

                  <div className="flex items-center gap-1">
                    <span className="text-xs whitespace-nowrap text-muted-foreground">Show:</span>
                    {/* The shared Select, not a native <select>: a native list is drawn by the
                        browser and stays upright on a rotated kiosk screen. */}
                    <Select value={String(limit)} onValueChange={(v) => { setLimit(Number(v)); setOffset(0); }}>
                      <SelectTrigger className="h-7 w-[64px] px-2 text-xs" aria-label="Rows per page"><SelectValue /></SelectTrigger>
                      <SelectContent>
                        {SESSIONS_PAGE_SIZE_OPTIONS.map((size) => (
                          <SelectItem key={size} value={String(size)}>{size}</SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                  </div>
                </div>
              );
            })()}
          </div>
          </div>
        )}

        {view === "scan" && (
          <div className={`space-y-4 ${kioskRotateClass} ${rotated ? "bg-[#f4f5f7] p-4" : ""}`}>
            <button
              onClick={rotateNext}
              className="fixed bottom-4 right-4 z-[60] flex items-center gap-2 rounded-full bg-[#001d6e] px-4 py-3 text-white shadow-lg transition-colors hover:bg-[#00154b]"
              title={`Rotate the screen (now ${rotation}°) — steps a quarter turn each press, back to 0° after 270°`}
            >
              <RotateCw className="h-5 w-5" />
            </button>
            {/* ── Rotated kiosk mode only. Unrotated, this whole header lives on the page's own
                compact scan-header row above; rotated, the fixed rotate overlay covers that, so
                the same pieces fold into a card here instead — same single merged row, so the
                two orientations read the same. ── */}
            {rotated && (
              <div className="flex flex-wrap items-center gap-3 rounded-xl border border-gray-200 bg-white px-3 py-2 shadow-sm">
                {scanBackButton}
                {scanVehicleTitle}
                {scanVehicleSummary}
                <div className="ml-auto flex flex-wrap items-center justify-end gap-2">{scanStatusActions}</div>
              </div>
            )}

            {activeSessionQuery.isLoading || !detail ? (
              <SectionSkeleton lines={6} />
            ) : (
              <>
                <div
                  className="grid grid-cols-1 gap-4 items-start"
                  // Two columns only on a real landscape desktop. bigView (rotated kiosk, or a
                  // naturally portrait screen) stacks instead: the draggable leftColWidth is a
                  // fixed PIXEL the operator set against a real desktop window, and it's easily
                  // wider than the room a rotated box actually has — that width is tied to the
                  // screen's SHORT side — so holding a split there squeezed Scan Items down to
                  // nothing. Full-width stacked cards give both the room they need.
                  style={
                    !bigView && isDesktop && canWrite && !locked
                      ? { gridTemplateColumns: `${leftColWidth}px 10px 1fr` }
                      : undefined
                  }
                >
                  {/* ── Batch totals — the left column of the split (where Vehicle Details used to
                      be, now summarised up in the header). Same card Order Scan builds for its
                      own Order Totals (client/src/pages/Scanning/Scan.tsx): a percent on the
                      right, four dotted stat boxes on one row, and a progress bar with
                      received/remaining under it. Each box filters the item table below to
                      its own rows; Total is the "show everything" box, so it doubles as Clear. ── */}
                  <div className={`flex min-w-0 flex-col gap-1.5 rounded-xl border bg-white p-2.5 shadow-sm ${bigView ? "order-2" : ""}`}>
                    {/* No title — the four labelled tiles under it already say what this is. */}
                    <div className="flex items-baseline justify-end gap-2">
                      {itemTotals.expected <= 0 ? (
                        <p className="text-sm font-medium text-gray-400">&mdash;</p>
                      ) : itemPct >= 100 ? (
                        <p className="inline-flex items-center gap-1 text-sm font-semibold text-emerald-600">
                          <CheckCircle2 className="h-4 w-4" /> Complete
                        </p>
                      ) : (
                        <p className="text-sm font-medium text-gray-400">{itemPct}% complete</p>
                      )}
                    </div>

                    {/* In the desktop split this column is a dragged PIXEL width, not a viewport
                        one, so the fold to 2×2 keys off that width rather than a sm: breakpoint —
                        which would keep four across in a 320px column and overflow every tile.
                        Stacked (bigView, mobile, or no Scan Items card) the card spans the full
                        width, so the ordinary viewport breakpoint is the right call again. */}
                    <div
                      className={`grid gap-2 ${
                        !bigView && isDesktop && canWrite && !locked
                          ? leftColWidth >= TOTALS_ONE_ROW_MIN ? "grid-cols-4" : "grid-cols-2"
                          : "grid-cols-2 sm:grid-cols-4"
                      }`}
                    >
                      {([
                        { key: "" as const, label: "Total", value: itemTotals.expected, plt: itemTotals.pltExpected, dot: "bg-gray-400", text: "text-gray-900" },
                        { key: "done" as const, label: "Received", value: itemTotals.received, plt: itemTotals.pltReceived, dot: "bg-emerald-500", text: "text-emerald-600" },
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
                            className={`rounded-xl border px-2.5 py-1 text-center transition-colors ${
                              isActive
                                ? "border-[#001d6e] bg-[#001d6e]/[0.06] ring-1 ring-[#001d6e]/30"
                                : "border-gray-100 bg-gray-50/70 hover:bg-gray-100"
                            }`}
                          >
                            <div className="flex items-center justify-center gap-1.5">
                              <span className={`h-2 w-2 shrink-0 rounded-full ${s.dot}`} />
                              <p className="text-xs font-semibold uppercase tracking-wide text-gray-500">{s.label}</p>
                            </div>
                            <p className={`text-2xl font-bold leading-tight ${s.text}`}>{s.value}</p>
                            <p className={`text-lg font-bold ${s.text}`}>{s.plt.toFixed(2)} plt</p>
                          </button>
                        );
                      })}
                    </div>

                    <div className="space-y-1">
                      {/* itemPct, not received/expected raw: received here includes extras (over-scans
                          and products not on the file), so an over-received batch would otherwise
                          push the bar past its own track. */}
                      <div className="h-2 w-full overflow-hidden rounded-full bg-gray-100">
                        <div
                          className="h-full rounded-full bg-emerald-500 transition-[width] duration-300"
                          style={{ width: `${itemPct}%` }}
                        />
                      </div>
                      <div className="flex justify-between text-[10px] font-medium text-gray-400">
                        <span>{itemTotals.received} received</span>
                        <span>{itemTotals.remaining} remaining</span>
                      </div>
                    </div>
                  </div>

                  {isDesktop && canWrite && !locked && !bigView && (
                    <div
                      onMouseDown={handleColumnResizeStart}
                      title="Drag to resize"
                      className="hidden lg:flex h-full items-stretch justify-center cursor-col-resize select-none group"
                    >
                      <div className="w-1 rounded-full bg-gray-200 group-hover:bg-[#001d6e]/50 group-active:bg-[#001d6e] transition-colors" />
                    </div>
                  )}

                  {canWrite && !locked && (
                    // order-1 stacked: the barcode box is what the operator reaches for first, so
                    // it leads and the totals read as the result underneath. Side by side the
                    // source order already puts totals on the left, so no ordering is needed.
                    <div className={`rounded-xl border border-gray-200 bg-white shadow-sm overflow-hidden ${bigView ? "order-1" : ""}`}>
                      <div className="flex items-center gap-2 px-4 sm:px-5 py-3.5 border-b border-gray-100">
                        <ScanLine className="h-4 w-4 text-[#001d6e]" />
                        <span className="text-sm font-semibold text-gray-900">Scan Items</span>
                        {autoScanEnabled && <span className="ml-auto rounded-full bg-amber-100 px-2 py-0.5 text-[10px] font-bold text-amber-700">AUTO SCAN ON</span>}
                      </div>
                      <div className="px-4 sm:px-5 py-4 space-y-3">
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
                              ref={barcodeRef}
                              autoFocus
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
                  )}
                </div>

                <div ref={itemSearchRef} className="rounded-xl border border-gray-200 bg-white shadow-sm overflow-hidden">
                  {/* Headerless — the icon toggles a search bar inline, same collapsible pattern
                      as Order Scan (osSearchOpen in Scan.tsx). ref wraps this header AND the
                      DataTable below it, not just the header, so clicking a row isn't misread as
                      "outside" and doesn't clear the search (same bug class fixed before). */}
                  <div className="flex flex-wrap items-center gap-2 border-b border-gray-200 px-4 py-2.5 bg-white">
                    <span className="text-xs font-medium text-gray-500">{filteredItems.length} item{filteredItems.length === 1 ? "" : "s"}</span>
                    <button
                      onClick={() => setItemSearchOpen(true)}
                      title="Search items"
                      className={`ml-auto inline-flex h-8 w-8 shrink-0 items-center justify-center rounded-md border ${
                        itemSearchOpen
                          ? "border-[#001d6e] bg-[#001d6e]/5 text-[#001d6e]"
                          : "border-gray-200 bg-white text-gray-500 hover:bg-gray-50"
                      }`}
                    >
                      <Search className="h-3.5 w-3.5" />
                    </button>
                    {itemSearchOpen && (
                      <div className="relative w-full sm:w-64">
                        <Search className="pointer-events-none absolute left-2.5 top-2 h-3.5 w-3.5 text-gray-400" />
                        <input
                          value={itemSearchText}
                          onChange={(e) => setItemSearchText(e.target.value)}
                          placeholder="Search items…"
                          autoFocus
                          className="h-8 w-full rounded-md border border-gray-200 bg-gray-50 pl-7 pr-6 text-xs text-gray-700 placeholder:text-gray-400 focus:bg-white focus:outline-none focus:ring-1 focus:ring-[#001d6e]/30"
                        />
                        {itemSearchText && (
                          <button
                            type="button"
                            onClick={() => setItemSearchText("")}
                            className="absolute right-2 top-2 text-gray-400 hover:text-gray-600"
                          >
                            <X className="h-3.5 w-3.5" />
                          </button>
                        )}
                      </div>
                    )}
                  </div>
                  <div className={bigView ? "hidden" : "hidden xl:block"}>
                  <DataTable<SessionItem>
                    containerClassName="rounded-none border-0"
                    headerClassName="bg-[#001d6e] text-white border-[#1a3a9c] hover:bg-[#0a2b7e] hover:text-white text-xs sm:text-sm"
                    columns={itemColumns}
                    data={filteredItems}
                    getRowId={(row) => String(row.id)}
                    rowClassName={itemRowClassName}
                    renderExpandedRow={renderItemHistoryPanel}
                    isRowExpandable={(row) => !!row.barcode}
                    expandedRowId={expandedItemId != null ? String(expandedItemId) : null}
                    onRowClick={(row) => setExpandedItemId((cur) => (cur === row.id ? null : row.id))}
                    enableColumnResizing
                    enableTotalsRow
                    emptyState="No items on this batch."
                    noResultsState="No items match your search."
                    hasActiveFilters={!!itemStatusFilter || !!itemSearchText}
                    isStickyHeader={bigView}
                    maxHeight={bigView ? (quarterTurn ? "62vw" : "62vh") : undefined}
                  />
                  </div>
                  <div className={bigView ? "space-y-2 p-3" : "space-y-2 p-3 xl:hidden"}>
                    {filteredItems.length === 0 ? (
                      <p className="py-8 text-center text-sm text-gray-400">{itemSearchText || itemStatusFilter ? "No items match your filters." : "No items on this batch."}</p>
                    ) : filteredItems.map((item) => {
                      const extra = Math.max(0, item.scanned - item.expected);
                      return (
                        <button
                          key={item.id}
                          type="button"
                          onClick={() => setExpandedItemId((cur) => (cur === item.id ? null : item.id))}
                          className="block w-full rounded-lg border border-gray-200 bg-white p-3 text-left shadow-sm"
                        >
                          <div className="flex min-w-0 items-start justify-between gap-3">
                            <div className="min-w-0">
                              <p className="break-words text-sm font-semibold text-gray-900">{item.itemName ?? "—"}</p>
                              <p className="mt-1 break-all font-mono text-[11px] text-gray-400">{item.barcode ?? "—"}{item.sapCode ? ` · SAP ${item.sapCode}` : ""}</p>
                            </div>
                            <span className={`shrink-0 rounded px-2 py-1 text-[11px] font-semibold ${item.isComplete ? "bg-emerald-100 text-emerald-700" : item.scanned > 0 ? "bg-amber-100 text-amber-700" : "bg-gray-100 text-gray-500"}`}>
                              {item.isComplete ? "Received" : item.scanned > 0 ? "Partial" : "Pending"}
                            </span>
                          </div>
                          <div className="mt-3 grid grid-cols-2 gap-2 text-xs text-gray-600">
                            <span>Expected <strong className="text-gray-900">{item.expected}</strong></span>
                            <span>Received <strong className="text-emerald-600">{item.scanned}</strong></span>
                            <span>Remaining <strong className="text-[#001d6e]">{item.remaining}</strong></span>
                            <span>Extra <strong className="text-amber-600">{extra}</strong></span>
                          </div>
                          {(item.itemsPerPallet ?? 0) > 0 && <p className="mt-2 text-[11px] font-semibold text-gray-500">{item.itemsPerPallet} per pallet</p>}
                        </button>
                      );
                    })}
                  </div>
                </div>

                {/* ── Auto Scan feedback popup — same popup Order Scan/Loading show for 5s after
                    an auto-confirmed (full-pallet) scan. Non-blocking; rapid scans reset the 5s
                    timer. Deliberately kept INSIDE the rotated wrapper (not a sibling further
                    down the page) so it picks up the same transform as everything else — a plain
                    fixed div only rotates along with an ancestor that's actually transformed. ── */}
                {autoFeedback && (
                  <div className="fixed inset-x-0 top-16 z-[90] flex justify-center px-4 pointer-events-none" role="status">
                    <div className="w-[calc(100%-2rem)] max-w-2xl sm:max-w-3xl min-h-[20rem] flex flex-col bg-white p-8 shadow-xl ring-1 ring-gray-200 animate-in fade-in slide-in-from-top-2">
                      <div className={`flex items-center gap-2.5 ${autoFeedback.isExtra ? "text-amber-700" : "text-emerald-700"}`}>
                        <Zap className="h-7 w-7 shrink-0" />
                        <span className="text-2xl font-semibold">{autoFeedback.isExtra ? "Auto scanned (extra)" : "Auto scanned"}</span>
                      </div>
                      <div className="flex flex-1 gap-5 items-start pt-4">
                        <ProductPhoto
                          productId={autoFeedback.productId}
                          name={autoFeedback.name}
                          className="h-60 w-60 shrink-0 object-contain bg-gray-50 border border-gray-100"
                        />
                        <div className="flex-1 min-w-0 text-lg">
                          <p className="font-semibold text-gray-900 break-words text-xl">{autoFeedback.name}</p>
                          <p className="mt-1.5 font-mono text-base text-gray-400 break-all">
                            {autoFeedback.barcode}{autoFeedback.sapCode && ` · SAP: ${autoFeedback.sapCode}`}
                          </p>
                          <p className="mt-4 text-2xl">
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
              </>
            )}
          </div>
        )}
      </div>

      {/* Confirm dialog — anything not a clean full-pallet auto-scan. */}
      <Dialog open={!!pending} onOpenChange={(open) => { if (!open) setPending(null); }}>
        <DialogContent
          className={`overflow-y-auto rounded-2xl p-0 ${
            quarterTurn
              ? "w-[92vh] max-w-[92vh] max-h-[92vw]"
              : "w-[calc(100%-2rem)] max-w-2xl sm:max-w-4xl max-h-[90vh]"}`}
        >
          {/* Two columns: full-height product image on the left, all controls on the right — same
              layout as Order Scan's own confirm dialog (client/src/pages/Scanning/Scan.tsx). Under
              rotate-90, CSS-left maps to physical-top, so image-left reads as image-on-top. */}
          <div className="flex flex-col sm:flex-row">
            {dialogResolvedImageName && dialogImageFailed !== dialogResolvedImageName && (
              <div className="flex shrink-0 items-center justify-center border-b border-gray-100 bg-gray-50 p-4 sm:w-80 sm:border-b-0 sm:border-r">
                <ProductPhoto
                  // pending.product's own id is stable across a rename — prefer it whenever
                  // it's resolved (always true for "not in this batch"; a matched item has no
                  // product id of its own yet, so it still falls back to the name lookup).
                  productId={pending?.product?.id ?? null}
                  name={dialogResolvedImageName}
                  className="max-h-96 w-full object-contain sm:max-h-full"
                  onLoadState={(failed) => setDialogImageFailed(failed ? dialogResolvedImageName : null)}
                />
              </div>
            )}
            <div className="min-w-0 flex-1 p-6">
          <DialogHeader>
            <DialogTitle className={`flex items-center gap-2.5 text-2xl ${
              !pending?.item ? "text-red-700"
              : pending.item.isComplete ? "text-amber-700"
              : "text-[#001d6e]"
            }`}>
              {!pending?.item
                ? <><AlertTriangle className="h-7 w-7" /> Not in this batch</>
                : pending.item.isComplete
                  ? <><AlertTriangle className="h-7 w-7" /> Extra item</>
                  : <><CheckCircle2 className="h-7 w-7" /> Match found</>}
            </DialogTitle>
            <DialogDescription className="text-left space-y-1.5 min-w-0 pt-3">
              <p className="font-bold text-gray-900 text-2xl leading-snug">{pending?.item?.itemName ?? pending?.product?.name ?? pending?.barcode}</p>
              <p className="font-mono text-lg text-gray-400">{pending?.barcode}</p>
              {!pending?.item && (
                <p className="text-lg text-red-600 mt-1">Not in this vehicle's batch — will be logged as an extra.</p>
              )}
              {pending?.item?.isComplete && (
                <p className="text-lg text-amber-600 mt-1">Item already complete — these extra units will be logged separately.</p>
              )}
              {dialogPackSizeMissing && (
                <p className="mt-1 rounded-lg bg-amber-50 px-3 py-2 text-base font-semibold text-amber-700">
                  Pallet size is not set for this item in Product Master — enter the quantity you are scanning.
                </p>
              )}
            </DialogDescription>
          </DialogHeader>

          <div className="space-y-4 py-1">
            {/* Not in this batch, but a real Product Master row — same info box shape as a
                matched item, just SAP + pallet size (there's no Expected/Received/Remaining to
                show without a batch row backing it). */}
            {!pending?.item && pending?.product && (
              <div className="rounded-xl bg-gray-50 px-4 py-3 text-base text-gray-600 space-y-1.5">
                {pending.product.sapCode && (
                  <p>SAP: <span className="font-mono font-bold text-gray-700">{pending.product.sapCode}</span></p>
                )}
                {extraProductPalletSize(pending.product) > 0 && (
                  <p>Items per pallet: <strong>{extraProductPalletSize(pending.product)}</strong></p>
                )}
              </div>
            )}
            {pending?.item && (
              <div className="rounded-xl bg-gray-50 px-4 py-3 text-base text-gray-600 space-y-1.5">
                {pending.item.sapCode && (
                  <p>SAP: <span className="font-mono font-bold text-gray-700">{pending.item.sapCode}</span></p>
                )}
                <div className="space-y-1">
                  <p>Items per pallet: <strong>{pending.item.itemsPerPallet || "—"}</strong></p>
                  <p>Expected: <strong>{pending.item.expected}</strong> · Received: <strong className="text-green-600">{pending.item.scanned}</strong></p>
                  <p>
                    Remaining: <strong className="text-red-600">{pending.item.remaining}</strong> boxes
                    {pending.item.itemsPerPallet > 0 && (
                      <> · <strong className="text-base font-bold text-red-600">{(pending.item.remaining / pending.item.itemsPerPallet).toFixed(2)}</strong> plt</>
                    )}
                  </p>
                </div>
              </div>
            )}

            {stvs.length > 0 && (
              <div className="space-y-1">
                <Label className="text-sm">Dispatch Directory <span className="text-red-500">*</span></Label>
                <Select value={selectedStv || NO_STV} onValueChange={(v) => setSelectedStv(v === NO_STV ? "" : v)}>
                  <SelectTrigger className={`w-full rounded-xl ${!selectedStv ? "border-dashed text-gray-400" : ""}`}>
                    <SelectValue placeholder="Select Dispatch Directory…" />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value={NO_STV}>— Select Dispatch Directory —</SelectItem>
                    {stvs.map((s) => (
                      <SelectItem key={s} value={s}>{s}</SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
            )}

            {/* Qty (boxes) and Pallets side by side — each with −/+ steppers. Off-rotation: side by
                side (sm:grid-cols-2). Rotated: single CSS column, since the rotate-90 turns that
                vertical stack into the side-by-side pair the kiosk layout expects. */}
            <div className={`grid gap-3 ${dialogPlt > 1 && !dialogPackSizeMissing && !quarterTurn ? "sm:grid-cols-2" : "grid-cols-1"}`}>
              <div className="space-y-1">
                <Label className="text-sm">Qty (boxes)</Label>
                <div className="flex items-stretch overflow-hidden rounded-xl border-2 border-gray-300 bg-white focus-within:border-[#001d6e]">
                  <Button
                    type="button" variant="ghost"
                    className="h-14 w-14 shrink-0 rounded-none border-r border-gray-200 text-3xl font-bold text-gray-500 hover:bg-gray-100"
                    onClick={() => {
                      const q = Math.max(1, dialogQty - 1);
                      setDialogQty(q);
                      if (dialogPlt > 0) setDialogPalletsInput((q / dialogPlt).toFixed(2));
                    }}
                    aria-label="Decrease quantity"
                  >
                    −
                  </Button>
                  <Input
                    type="number" min={0}
                    value={dialogQty === 0 ? "" : dialogQty}
                    onChange={(e) => {
                      const q = parseInt(e.target.value) || 0;
                      setDialogQty(q);
                      if (dialogPlt > 0) setDialogPalletsInput((q / dialogPlt).toFixed(2));
                    }}
                    onBlur={(e) => {
                      // With no pallet size set the box stays empty until a number is typed —
                      // snapping it to 1 here would hand the operator a guess again.
                      if (dialogPackSizeMissing) return;
                      if (!e.target.value || parseInt(e.target.value) < 1) {
                        setDialogQty(1);
                        if (dialogPlt > 0) setDialogPalletsInput((1 / dialogPlt).toFixed(2));
                      }
                    }}
                    onKeyDown={(e) => {
                      if (e.key === "Enter") {
                        e.preventDefault();
                        if (pending && dialogQty > 0 && !scanMutation.isPending) {
                          scanMutation.mutate({ barcode: pending.barcode, qty: dialogQty, stv: selectedStv || null }, { onSuccess: () => setPending(null) });
                        }
                      }
                    }}
                    className="text-center text-3xl font-bold h-14 flex-1 rounded-none border-0 focus-visible:ring-0 focus-visible:ring-offset-0"
                    autoFocus
                  />
                  <Button
                    type="button" variant="ghost"
                    className="h-14 w-14 shrink-0 rounded-none border-l border-gray-200 text-3xl font-bold text-gray-500 hover:bg-gray-100"
                    onClick={() => {
                      const q = dialogQty + 1;
                      setDialogQty(q);
                      if (dialogPlt > 0) setDialogPalletsInput((q / dialogPlt).toFixed(2));
                    }}
                    aria-label="Increase quantity"
                  >
                    +
                  </Button>
                </div>
              </div>

              {dialogPlt > 1 && !dialogPackSizeMissing && (
                <div className="space-y-1">
                  <Label className="text-sm">Pallets <span className="font-normal text-gray-400">· {dialogPlt}/pallet</span></Label>
                  <div className="flex items-stretch overflow-hidden rounded-xl border-2 border-[#001d6e]/30 bg-white focus-within:border-[#001d6e]">
                    <Button
                      type="button" variant="ghost"
                      className="h-14 w-14 shrink-0 rounded-none border-r border-[#001d6e]/15 text-3xl font-bold text-[#001d6e] hover:bg-[#001d6e]/5"
                      onClick={() => {
                        const p = Math.max(0, Math.round(((parseFloat(dialogPalletsInput) || 0) - 1) * 100) / 100);
                        setDialogPalletsInput(p.toFixed(2));
                        setDialogQty(Math.max(1, Math.round(p * dialogPlt)));
                      }}
                      aria-label="Decrease pallets"
                    >
                      −
                    </Button>
                    <Input
                      type="number" min={0} step="0.01"
                      value={dialogPalletsInput}
                      onChange={(e) => {
                        const raw = e.target.value;
                        setDialogPalletsInput(raw);
                        const p = parseFloat(raw);
                        if (!isNaN(p) && p >= 0) setDialogQty(Math.round(p * dialogPlt));
                      }}
                      onBlur={() => {
                        if (dialogPalletsInput === "" || isNaN(parseFloat(dialogPalletsInput))) {
                          setDialogPalletsInput((dialogQty / dialogPlt).toFixed(2));
                        }
                      }}
                      onKeyDown={(e) => {
                        if (e.key === "Enter") {
                          e.preventDefault();
                          if (pending && dialogQty > 0 && !scanMutation.isPending) {
                            scanMutation.mutate({ barcode: pending.barcode, qty: dialogQty, stv: selectedStv || null }, { onSuccess: () => setPending(null) });
                          }
                        }
                      }}
                      className="text-center text-3xl font-bold text-[#001d6e] h-14 flex-1 rounded-none border-0 focus-visible:ring-0 focus-visible:ring-offset-0"
                    />
                    <Button
                      type="button" variant="ghost"
                      className="h-14 w-14 shrink-0 rounded-none border-l border-[#001d6e]/15 text-3xl font-bold text-[#001d6e] hover:bg-[#001d6e]/5"
                      onClick={() => {
                        const p = Math.round(((parseFloat(dialogPalletsInput) || 0) + 1) * 100) / 100;
                        setDialogPalletsInput(p.toFixed(2));
                        setDialogQty(Math.round(p * dialogPlt));
                      }}
                      aria-label="Increase pallets"
                    >
                      +
                    </Button>
                  </div>
                </div>
              )}
            </div>
          </div>

          <DialogFooter className="gap-2">
            <Button variant="outline" className="rounded-xl" onClick={() => setPending(null)}>Cancel</Button>
            <Button
              className={`rounded-xl ${(!pending?.item || pending.item.isComplete)
                ? "bg-amber-600 hover:bg-amber-700 text-white"
                : "bg-[#001d6e] hover:bg-[#001552] text-white"}`}
              disabled={dialogQty <= 0 || scanMutation.isPending}
              onClick={() => {
                if (!pending) return;
                scanMutation.mutate({ barcode: pending.barcode, qty: dialogQty, stv: selectedStv || null }, { onSuccess: () => setPending(null) });
              }}
            >
              {scanMutation.isPending ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : null}
              {(!pending?.item || pending.item.isComplete) ? "Log as Extra" : "Confirm Scan"}
            </Button>
          </DialogFooter>
            </div>
          </div>
        </DialogContent>
      </Dialog>

      {/* Manual "Complete" confirm — works regardless of scan % (a shortfall can be reconciled
          against a later part via reconcileUnloadCredits), same "Complete this part?" pattern and
          copy as Order Scan's own showForceComplete dialog. */}
      <Dialog open={showCompleteConfirm} onOpenChange={(open) => { if (!open) setShowCompleteConfirm(false); }}>
        <DialogContent className={`max-w-sm`}>
          <DialogHeader>
            <DialogTitle>Complete this batch?</DialogTitle>
            <DialogDescription className="space-y-1 pt-1">
              <p>
                <span className="font-semibold text-gray-900">{detail?.session?.vehicleNumber}</span> — {itemTotals.received.toLocaleString()} of {itemTotals.expected.toLocaleString()} received.
              </p>
              {itemTotals.remaining > 0 && (
                <p className="text-amber-600 text-sm">
                  {itemTotals.remaining.toLocaleString()} unit(s) are still short. Completing now is fine if the remainder is expected in a later batch — it'll be reconciled automatically.
                </p>
              )}
            </DialogDescription>
          </DialogHeader>
          <DialogFooter className="gap-2">
            <Button variant="outline" onClick={() => setShowCompleteConfirm(false)} disabled={completeMutation.isPending}>
              Cancel
            </Button>
            <Button
              onClick={() => completeMutation.mutate()}
              disabled={completeMutation.isPending}
              className="bg-emerald-600 hover:bg-emerald-700 text-white"
            >
              {completeMutation.isPending && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
              Complete
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Import CSV moved to the Order Import page's own "Unloading" mode
          (client/src/pages/OrderImport.tsx) — see that page's plan comment for why. */}

      <ReportsDialog session={reportsSession} onClose={() => setReportsSession(null)} basePath="unloading" />
      <ProductMasterMissingDialog message={productMasterMissingMessage} onClose={() => setProductMasterMissingMessage(null)} />
      <ProductMasterMissingDialog message={barcodeNotInSystemMessage} onClose={() => setBarcodeNotInSystemMessage(null)} title="Barcode Not Found" />

      {/* ── Delete confirmation — replace (soft, carries forward on re-upload) vs discard
          (reverses stock, voids history, self-resolves) ─────────────────────────────────── */}
      <Dialog open={!!deleteTarget} onOpenChange={(open) => { if (!open) setDeleteTarget(null); }}>
        <DialogContent className={`max-w-md`}>
          <DialogHeader>
            <DialogTitle>Delete {deleteTarget?.vehicleNumber} ({deleteTarget?.orderDate})?</DialogTitle>
            <DialogDescription>
              {deletePreviewQuery.isLoading ? "Loading impact…" : deletePreviewQuery.data ? (
                <>
                  {deletePreviewQuery.data.scannedBarcodeCount} barcode(s) scanned ({deletePreviewQuery.data.scannedQtyTotal} total qty
                  {deletePreviewQuery.data.extraQtyTotal > 0 ? `, ${deletePreviewQuery.data.extraQtyTotal} extra` : ""}) against this batch.
                </>
              ) : null}
            </DialogDescription>
          </DialogHeader>

          <RadioGroup value={deleteMode} onValueChange={(v) => setDeleteMode(v as "replace" | "discard")}>
            <label className="flex items-start gap-2 text-sm p-2 rounded border cursor-pointer">
              <RadioGroupItem value="replace" id="delModeReplace" className="mt-0.5" />
              <span>
                <span className="font-medium">Replace (recommended)</span> — stock and scan history stay in place; a corrected
                re-upload for this exact vehicle + date will carry the scan history forward automatically.
              </span>
            </label>
            <label className="flex items-start gap-2 text-sm p-2 rounded border border-red-200 bg-red-50 cursor-pointer">
              <RadioGroupItem value="discard" id="delModeDiscard" className="mt-0.5" />
              <span>
                <span className="font-medium text-red-700">Discard</span> — the boxes were never real for this vehicle. Stock this
                part added is reversed and its scan history is voided. Cannot be undone.
              </span>
            </label>
          </RadioGroup>

          <DialogFooter className="gap-2">
            <Button variant="outline" onClick={() => setDeleteTarget(null)} disabled={deleteMutation.isPending}>Cancel</Button>
            <Button
              className="bg-red-600 text-white hover:bg-red-700"
              disabled={deleteMutation.isPending}
              onClick={() => deleteMutation.mutate()}
            >
              {deleteMutation.isPending ? <Loader2 className="mr-1.5 h-3.5 w-3.5 animate-spin" /> : null}
              Delete
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
