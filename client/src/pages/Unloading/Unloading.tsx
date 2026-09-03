import { useEffect, useRef, useState } from "react";
import { useMutation, useQuery } from "@tanstack/react-query";
import type { Result } from "@zxing/library";
import BarcodeScanner from "@/lib/barcodeScanner";
import {
  AlertTriangle, Camera, CheckCircle2, ChevronLeft, ChevronRight, FileBarChart, Keyboard, Loader2, Package, PackageOpen, RotateCcw, RotateCw,
  ScanLine, Search, Trash2, Truck, X, Zap,
} from "lucide-react";
import PageHeader from "@/components/PageHeader";
import ReportsDialog, { type ReportsDialogSession } from "@/components/modals/ReportsDialog";
import { PlantBadge } from "@/components/PlantBadge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
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
import { hasPageWriteAccess } from "@/lib/permissions";

// ─── Types (mirror server/routes/unloading.ts responses) ─────────────────────
type SessionListItem = {
  id: number; plant: string; vehicleNumber: string; orderDate: string; csvFileName: string;
  rowCount: number; groupId: number; partIndex: number; scanStatus: "available" | "active" | "completed";
  createdAt: string; scanActivatedAt: string | null; scanCompletedAt: string | null;
  partsCount: number; expectedQty: number; scannedQty: number;
  // Only the earliest not-yet-completed batch in a vehicle+date's FIFO group is eligible to be
  // clicked into (see isEligibleToActivate in server/routes/unloading.ts) — an 'available' row
  // with canActivate=false is queued behind an earlier batch that must complete first.
  canActivate: boolean;
};
type SessionItem = {
  id: number; barcode: string | null; itemName: string | null; sapCode: string | null; quantity: number;
  expected: number; scanned: number; remaining: number; itemsPerPallet: number; isComplete: boolean;
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
// Mirrors getUserPlants in server/routes/order-scan.ts: null = admin, sees every plant;
// otherwise exactly the plants assigned on the Users page, lowercased. Used to filter the
// Import dialog's Plant picker down to what this user could actually import for — the server
// enforces the same restriction independently (canAccessPlant in server/routes/unloading.ts),
// this is just so a restricted user isn't shown plants that would 403 if picked.
function getUserPlantsClient(): string[] | null {
  const u = currentUser();
  const role = (u.role ?? "").toLowerCase().trim();
  if (role === "admin" || role === "super-admin") return null;
  try {
    const parsed = typeof u.plants === "string" ? JSON.parse(u.plants) : u.plants;
    if (Array.isArray(parsed)) return parsed.map((p: string) => String(p).toLowerCase().trim()).filter(Boolean);
  } catch { /* default [] */ }
  return [];
}

// Remembers which batch is currently open, per browser, so navigating away to another page and
// coming back to /unloading resumes exactly where you left off instead of dropping back to the
// list. Cleared once that batch is marked complete (or on an explicit "Back to list"), same
// pattern as LAST_ORDER_KEY in client/src/pages/Loading/LoadOperation.tsx.
const LAST_SESSION_KEY = "unloading_active_session_id";

// Remembers the Vehicle Details / Scan Items split width, per browser, so a dragged layout
// survives a refresh.
const LEFT_COL_WIDTH_KEY = "unloading_left_col_width";
const LEFT_COL_MIN = 260;
const LEFT_COL_MAX = 640;

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

// Radix renders dialogs into document.body, outside the rotated container, so each needs the
// matching turn applied by hand (same fix as portalRotateClass in Scan.tsx) or it opens upright
// while everything behind it is rotated — the opposite of what "rotated to match the physically
// turned screen" should look like.
function portalRotateClass(rotation: Rotation): string {
  return rotation === 90 ? "rotate-90" : rotation === 180 ? "rotate-180" : rotation === 270 ? "-rotate-90" : "";
}

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

  const [sessionPlantFilter, setSessionPlantFilter] = useState("");
  // Vehicle number search (debounced) and Order Date filter — same idea as Order Management's
  // History tab (date + Today/clear) and Loading's own debounced vehicle search. Both are
  // supported server-side already (vehicleNumber was, orderDate is new); this just exposes them.
  const [sessionVehicleFilter, setSessionVehicleFilter] = useState("");
  const debouncedVehicleFilter = useDebounced(sessionVehicleFilter, 300);
  const [sessionDateFilter, setSessionDateFilter] = useState("");
  // Three tabs — Available (which also holds in-progress "active" batches, marked green),
  // History (shows every status), and Recent Complete (one row per PLANT — whichever batch
  // finished there most recently; see /unloading/sessions/recent-complete's own comment for why
  // this is the "what can I reopen right now" view, not a duplicate of History). Importing a CSV
  // and browsing CSV upload history both moved to the Order Import page's own "Unloading" mode
  // (client/src/pages/OrderImport.tsx) — this page is scan-workflow only now. "active"/"completed"
  // stay valid values for the underlying query param but no longer have their own tab button.
  // "Time Taken" only ever shows a value on the History tab, matching Order Management's own
  // restriction.
  const [statusTab, setStatusTab] = useState<"available" | "active" | "completed" | "history" | "recent-complete">("available");
  const sessionFilterParams =
    (sessionPlantFilter ? `&plant=${encodeURIComponent(sessionPlantFilter)}` : "")
    + (debouncedVehicleFilter.trim() ? `&vehicleNumber=${encodeURIComponent(debouncedVehicleFilter.trim())}` : "")
    + (sessionDateFilter ? `&orderDate=${encodeURIComponent(sessionDateFilter)}` : "");
  const sessionsQuery = useQuery<{ sessions: SessionListItem[]; total: number }>({
    queryKey: ["/api/unloading/sessions", offset, limit, sessionPlantFilter, debouncedVehicleFilter, sessionDateFilter, statusTab],
    queryFn: () => apiRequest(
      "GET",
      `/api/unloading/sessions?limit=${limit}&offset=${offset}${sessionFilterParams}&status=${statusTab}`,
    ).then((r) => r.json()),
    enabled: statusTab !== "recent-complete",
  });
  const sessions = sessionsQuery.data?.sessions ?? [];
  const total = sessionsQuery.data?.total ?? 0;

  const statusCountsQuery = useQuery<{ available: number; active: number; completed: number; total: number }>({
    queryKey: ["/api/unloading/sessions/status-counts", sessionPlantFilter, debouncedVehicleFilter, sessionDateFilter],
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
    onError: (error: any) => toast({ title: "Failed to reopen", description: error?.message, variant: "destructive" }),
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
  // /api/plants itself returns every plant unfiltered — restrict what a non-admin is even
  // offered to import for, matching the server's own canAccessPlant check.
  const userPlants = getUserPlantsClient();
  const importablePlants = (allPlants ?? []).filter(
    (p: any) => userPlants === null || userPlants.includes(String(p.name ?? "").toLowerCase()),
  );

  // ─── Scan view ──────────────────────────────────────────────────────────────
  const [activeSessionId, setActiveSessionId] = useState<number | null>(() => {
    try {
      const saved = localStorage.getItem(LAST_SESSION_KEY);
      return saved ? parseInt(saved, 10) : null;
    } catch { return null; }
  });
  const barcodeRef = useRef<HTMLInputElement>(null);

  const activeSessionQuery = useQuery<{ session: SessionDetail; items: SessionItem[]; allComplete: boolean }>({
    queryKey: ["/api/unloading/sessions", activeSessionId],
    queryFn: () => apiRequest("GET", `/api/unloading/sessions/${activeSessionId}`).then((r) => r.json()),
    enabled: activeSessionId != null,
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

  // Draggable Vehicle Details / Scan Items split — desktop (lg) only; stacks to one column
  // below that, same breakpoint Tailwind's own lg: prefix uses elsewhere on this page.
  const [leftColWidth, setLeftColWidth] = useState<number>(() => {
    try {
      const saved = parseInt(localStorage.getItem(LEFT_COL_WIDTH_KEY) || "", 10);
      return Number.isFinite(saved) ? Math.min(LEFT_COL_MAX, Math.max(LEFT_COL_MIN, saved)) : 340;
    } catch { return 340; }
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
  const quarterTurn = rotation === 90 || rotation === 270;
  // Bounded, self-scrolling frame for tables in rotated mode — mirrors Order Scan's own
  // kioskTableBoxClass exactly (client/src/pages/Scanning/Scan.tsx). Without this, a table left
  // to flow naturally inside the rotated box has no cap of its own and no scrollbar to fall back
  // on, so it either overflows the rotated box's bounds or gets squeezed by the browser's table
  // layout algorithm into absurdly narrow columns with heavily-wrapped text — exactly the
  // "cramped, not responsive" look reported. The %-of-viewport cap flips units on a quarter turn:
  // that turns the subtree 90°, so content-space height runs along the viewport's WIDTH (vw)
  // instead of its height (vh).
  const kioskTableBoxClass = rotated
    ? `overflow-auto kiosk-scroll ${quarterTurn ? "max-h-[62vw]" : "max-h-[62vh]"}`
    : "";
  const portalRotate = rotated ? portalRotateClass(rotation) : "";
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

  const activateMutation = useMutation({
    mutationFn: (id: number) => apiRequest("POST", `/api/unloading/sessions/${id}/activate`, {}, false, true),
    onError: (error: any) => toast({ title: "Can't start yet", description: error?.message || "This batch can't be activated right now.", variant: "destructive" }),
  });

  function enterSession(id: number) {
    setActiveSessionId(id);
    setView("scan");
    setItemBarcode(""); setItemScanMode("manual"); setItemStatusFilter(""); setExpandedItemId(null);
    itemScanSeqRef.current = { seq: 0, byId: new Map() };
    try { localStorage.setItem(LAST_SESSION_KEY, String(id)); } catch { /* ignore */ }
  }

  // Clicking "Scan" on a not-yet-opened batch is the explicit available -> active step (mirrors
  // Order Import's CSV lifecycle) — activates it server-side first, then opens the scan view.
  // A batch queued behind an earlier incomplete one (canActivate=false) can't be opened at all.
  function openSession(s: SessionListItem) {
    if (s.scanStatus !== "available") { enterSession(s.id); return; }
    if (!s.canActivate) {
      toast({ title: "Locked", description: "Complete the earlier batch for this vehicle first.", variant: "destructive" });
      return;
    }
    activateMutation.mutate(s.id, {
      onSuccess: () => {
        queryClient.invalidateQueries({ queryKey: ["/api/unloading/sessions"] });
        enterSession(s.id);
      },
    });
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

  const scanMutation = useMutation({
    mutationFn: ({ barcode, qty, stv }: { barcode: string; qty: number; stv?: string | null }) =>
      apiRequest("POST", `/api/unloading/sessions/${activeSessionId}/scan`, { barcode, qty, stv: stv ?? null }, false, true),
    onMutate: () => {
      const item = scanItemRef.current;
      if (item) {
        const s = itemScanSeqRef.current;
        s.seq += 1;
        s.byId.set(item.id, s.seq);
      }
    },
    onSuccess: (data) => {
      queryClient.setQueryData(["/api/unloading/sessions", activeSessionId], { session: data.session, items: data.items, allComplete: data.allComplete });
      // setQueryData above only updates the item table's own progress numbers (an instant,
      // no-refetch cache write) — it does NOT touch the separate per-item history query
      // (["/api/unloading/sessions", activeSessionId, "events"], powering each item row's
      // expand panel), so without this, a just-recorded scan kept showing "No scan history for
      // this item yet." until something else (e.g. a void, which invalidates more broadly)
      // happened to refresh it.
      queryClient.invalidateQueries({ queryKey: ["/api/unloading/sessions", activeSessionId, "events"] });
      if (data.allComplete) toast({ title: "Batch complete", description: "Every item's expected quantity has been matched." });
    },
    onError: (error: any) => toast({ title: "Scan failed", description: error?.message || "Could not record scan", variant: "destructive" }),
    onSettled: () => { scanLockRef.current = false; },
  });

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

  const [pending, setPending] = useState<{ barcode: string; item: SessionItem | null } | null>(null);
  const [dialogQty, setDialogQty] = useState(1);
  const [dialogPalletsInput, setDialogPalletsInput] = useState("");
  const [dialogImageFailed, setDialogImageFailed] = useState(false);
  useEffect(() => { setDialogImageFailed(false); }, [pending]);
  const dialogPlt = pending?.item?.itemsPerPallet ?? 0;
  const dialogResolvedImageName = pending?.item?.itemName ?? pending?.barcode;

  const [autoFeedback, setAutoFeedback] = useState<
    { name: string; barcode: string; sapCode: string | null; scannedQty: number; remaining: number; isExtra: boolean } | null
  >(null);
  const autoFeedbackTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  function showAutoFeedback(name: string, barcode: string, sapCode: string | null, scannedQty: number, remaining: number, isExtra: boolean) {
    if (autoFeedbackTimerRef.current) clearTimeout(autoFeedbackTimerRef.current);
    setAutoFeedback({ name, barcode, sapCode, scannedQty, remaining, isExtra });
    autoFeedbackTimerRef.current = setTimeout(() => setAutoFeedback(null), 5000);
  }

  function stopItemCamera() {
    itemScannerRef.current?.stop();
    setItemCameraReady(false);
  }

  function defaultDialogQty(item: SessionItem | null): number {
    if (!item) return 1;
    const ipp = item.itemsPerPallet || 1;
    return item.remaining > 0 && item.remaining < ipp ? item.remaining : ipp;
  }
  function openConfirmDialog(barcode: string, item: SessionItem | null) {
    const qty = defaultDialogQty(item);
    setDialogQty(qty);
    setDialogPalletsInput(item && item.itemsPerPallet > 0 ? (qty / item.itemsPerPallet).toFixed(2) : "");
    setPending({ barcode, item });
  }

  function handleItemBarcode(rawBarcode: string) {
    const barcode = rawBarcode.trim();
    if (!barcode || !detail || locked || scanLockRef.current || pending) return;

    if (stvs.length > 0 && !selectedStv) {
      toast({ title: "Select an STV before scanning", description: "Pick one from the STV selector above, then continue scanning.", variant: "destructive" });
      return;
    }

    const nb = normalize(barcode);
    const last = lastScanRef.current;
    if (last && normalize(last.barcode) === nb && Date.now() - last.at < SAME_BARCODE_COOLDOWN_MS) return;
    lastScanRef.current = { barcode, at: Date.now() };

    const item = detail.items.find((i) => normalize(i.barcode) === nb) ?? null;
    scanLockRef.current = true;
    scanItemRef.current = item;

    const ipp = item?.itemsPerPallet ?? 0;
    const canAutoScan = autoScanEnabled && !!item && item.expected > 0 && ipp >= 1 && item.remaining >= ipp;
    if (canAutoScan) {
      scanMutation.mutate({ barcode, qty: ipp, stv: selectedStv || null }, {
        onSuccess: (data) => showAutoFeedback(data.event.itemName, data.event.barcode, data.event.sapCode, data.event.totalQty, data.event.remaining, data.event.isExtra),
      });
      setItemBarcode("");
      return;
    }

    scanLockRef.current = false;
    openConfirmDialog(barcode, item);
    setItemBarcode("");
  }

  useEffect(() => {
    if (view === "scan") setTimeout(() => barcodeRef.current?.focus(), 50);
  }, [view, activeSessionId]);

  // Camera scanner — active only while the Camera tab is selected.
  useEffect(() => {
    if (view !== "scan" || itemScanMode !== "camera" || !detail || locked) { stopItemCamera(); return; }
    let cancelled = false;
    const scanner = new BarcodeScanner({
      onDetected: (result: Result) => { const code = result.getText(); if (code && !cancelled) handleItemBarcode(code); },
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
  }, [view, itemScanMode, activeSessionId, locked]);

  // Barcode gun — a fast burst of keystrokes ending in a pause is treated as a scan, same
  // MAX_GAP_MS/BURST_END_MS heuristic as Order Scan/Loading.
  useEffect(() => {
    if (view !== "scan" || !detail || locked) return;
    const MAX_GAP_MS = 50;
    const BURST_END_MS = 80;
    let buffer = "";
    let lastAt = 0;
    let flushTimer: ReturnType<typeof setTimeout> | null = null;
    const handleKeyDown = (e: KeyboardEvent) => {
      const target = e.target as HTMLElement | null;
      if (target === barcodeRef.current) return;
      if (target && (target.tagName === "INPUT" || target.tagName === "TEXTAREA" || target.isContentEditable)) return;
      if (e.ctrlKey || e.metaKey || e.altKey || e.key.length !== 1) return;
      const now = Date.now();
      if (now - lastAt > MAX_GAP_MS) buffer = "";
      lastAt = now;
      buffer += e.key;
      if (flushTimer) clearTimeout(flushTimer);
      flushTimer = setTimeout(() => {
        if (buffer.length >= 3) { setItemScanMode("manual"); barcodeRef.current?.focus(); handleItemBarcode(buffer); }
        buffer = "";
      }, BURST_END_MS);
    };
    window.addEventListener("keydown", handleKeyDown, true);
    return () => { window.removeEventListener("keydown", handleKeyDown, true); if (flushTimer) clearTimeout(flushTimer); };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [view, activeSessionId, locked]);

  const voidMutation = useMutation({
    mutationFn: (eventId: number) => apiRequest("POST", `/api/unloading/events/${eventId}/void`, { reason: "Voided from Unloading" }),
    onSuccess: () => {
      toast({ title: "Voided" });
      if (activeSessionId != null) queryClient.invalidateQueries({ queryKey: ["/api/unloading/sessions", activeSessionId] });
      queryClient.invalidateQueries({ queryKey: ["/api/unloading/sessions"] });
    },
    onError: (error: any) => toast({ title: "Void failed", description: error?.message, variant: "destructive" }),
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
    onError: (error: any) => toast({ title: "Failed", description: error?.message, variant: "destructive" }),
  });
  const reopenMutation = useMutation({
    mutationFn: () => apiRequest("POST", `/api/unloading/sessions/${activeSessionId}/reopen`, {}),
    onSuccess: () => {
      toast({ title: "Reopened" });
      queryClient.invalidateQueries({ queryKey: ["/api/unloading/sessions", activeSessionId] });
      queryClient.invalidateQueries({ queryKey: ["/api/unloading/sessions"] });
    },
    onError: (error: any) => toast({ title: "Failed", description: error?.message, variant: "destructive" }),
  });

  // ─── Reports — same dialog Order Import uses (Summary/Activity/Hourly, per-part + whole-group),
  // pointed at Unloading's own report endpoints via basePath="unloading". ───────────────────────
  const [reportsSession, setReportsSession] = useState<ReportsDialogSession | null>(null);
  const openReports = (s: SessionListItem) => {
    setReportsSession({ id: s.id, csvFileName: s.csvFileName, plant: s.plant, receivingSessionId: s.groupId, partIndex: s.partIndex });
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
    onError: (error: any) => toast({ title: "Delete failed", description: error?.message, variant: "destructive" }),
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
  // viewport instead of scrolling sideways. Text sizes bumped a step up from the original 10-11px
  // micro-text in both views; the existing global .kiosk-rotate-* CSS (index.css) bumps these
  // again automatically while rotated, on top of this baseline increase.
  const itemColumns: DataTableColumn<SessionItem>[] = [
    {
      id: "item",
      header: "Item",
      accessor: (row) => row.itemName ?? row.barcode ?? "",
      width: 240,
      minWidth: 140,
      render: (row) => (
        <div>
          <p className="font-medium text-gray-900 whitespace-normal break-words leading-snug text-base">{row.itemName ?? "—"}</p>
          <p className="text-gray-400 font-mono whitespace-normal break-words text-sm">
            {row.barcode ?? "—"}{row.sapCode && ` · SAP ${row.sapCode}`}
          </p>
          {(row.itemsPerPallet ?? 0) > 0 && <p className="text-gray-500 font-semibold mt-0.5 text-sm">{row.itemsPerPallet} per pallet</p>}
        </div>
      ),
    },
    {
      id: "exp", header: "Exp", align: "right", width: 80, minWidth: 60, sortable: true,
      accessor: (row) => row.expected,
      render: (row) => (
        <>
          <span className="block text-lg font-semibold">{row.expected || "—"}</span>
          <span className="block text-sm font-semibold text-gray-400">{palletsOf(row.expected, row.itemsPerPallet)} plt</span>
        </>
      ),
    },
    {
      id: "received", header: "Received", align: "right", width: 90, minWidth: 60, sortable: true,
      accessor: (row) => row.scanned,
      cellClassName: "font-semibold text-gray-900",
      render: (row) => (
        <>
          <span className="block text-lg">{row.scanned}</span>
          <span className="block text-sm font-semibold text-gray-400">{palletsOf(row.scanned, row.itemsPerPallet)} plt</span>
        </>
      ),
    },
    {
      id: "left", header: "Remain", align: "right", width: 80, minWidth: 60, sortable: true,
      accessor: (row) => row.remaining,
      render: (row) => (
        <>
          <span className={`block text-lg font-semibold ${row.remaining > 0 ? "text-[#001d6e]" : "text-gray-300"}`}>{row.remaining || "—"}</span>
          <span className="block text-sm font-semibold text-gray-400">{palletsOf(row.remaining, row.itemsPerPallet)} plt</span>
        </>
      ),
    },
    {
      id: "extra", header: "Extra", align: "right", width: 80, minWidth: 60,
      accessor: (row) => Math.max(0, row.scanned - row.expected),
      render: (row) => {
        const extra = Math.max(0, row.scanned - row.expected);
        return (
          <>
            <span className={`block text-lg ${extra > 0 ? "text-amber-600 font-semibold" : "text-gray-300"}`}>{extra > 0 ? `+${extra}` : "—"}</span>
            <span className="block text-sm font-semibold text-gray-400">{palletsOf(extra, row.itemsPerPallet)} plt</span>
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
          <span className={`inline-block font-semibold px-2 py-1 text-sm rounded ${
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
          <div className="flex justify-center py-4"><Loader2 className="h-4 w-4 animate-spin text-[#001d6e]" /></div>
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

  return (
    <div className="flex-1 overflow-y-auto p-4 lg:p-6">
      <div className="mx-auto w-full max-w-[1800px] space-y-4">
        {/* The kiosk-rotate wrapper below is position:fixed over the whole viewport, so it visually
            covers this header once rotated — hide it then and fold the page's identity into the
            rotated box's own header (the "Unloading" eyebrow above "Vehicles") instead, so the
            title stays visible rather than sitting hidden behind the fixed overlay. */}
        {!rotated && (
          <PageHeader
            icon={PackageOpen}
            title="Unloading"
            description="Import a vehicle-wise CSV, then pick a vehicle + date to scan its items and receive stock."
          />
        )}

        {view === "list" && (
          <div className={`${kioskRotateClass} ${rotated ? "bg-[#f4f5f7] p-4" : ""}`}>
            <button
              onClick={rotateNext}
              className="fixed bottom-4 right-4 z-[60] flex items-center gap-2 rounded-full bg-[#001d6e] px-4 py-3 text-white shadow-lg transition-colors hover:bg-[#00154b]"
              title={`Rotate the screen (now ${rotation}°) — steps a quarter turn each press, back to 0° after 270°`}
            >
              <RotateCw className="h-5 w-5" />
            </button>
          <div className="rounded-xl border border-gray-200 bg-white shadow-sm overflow-hidden">
            <div className="flex items-center justify-between gap-2 px-4 sm:px-5 py-3.5 border-b border-gray-100">
              <div>
                {rotated && (
                  <div className="flex items-center gap-1.5 text-[#001d6e]">
                    <PackageOpen className="h-4 w-4" />
                    <span className="text-xs font-bold uppercase tracking-wide">Unloading</span>
                  </div>
                )}
                <div className="text-lg font-bold text-[#001d6e]">Vehicles</div>
                <div className="text-xs text-gray-400">{total} part(s){sessionPlantFilter ? ` · ${sessionPlantFilter}` : ""}</div>
              </div>
              <div className="flex items-center gap-2">
                {importablePlants.length > 1 && (
                  <Select value={sessionPlantFilter || "all"} onValueChange={(v) => { setSessionPlantFilter(v === "all" ? "" : v); setOffset(0); }}>
                    <SelectTrigger className="h-9 w-[160px]"><SelectValue placeholder="All Plants" /></SelectTrigger>
                    <SelectContent className={rotated ? `origin-top-left ${portalRotate}` : undefined}>
                      <SelectItem value="all">All Plants</SelectItem>
                      {importablePlants.map((p: any) => (
                        <SelectItem key={p.id ?? p.name} value={p.name}>{p.name}</SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                )}
              </div>
            </div>

            {/* Filters — vehicle number search (debounced) + Order Date, alongside the plant
                picker above. Both are supported server-side (see /unloading/sessions). */}
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
              <Input
                type="date"
                value={sessionDateFilter}
                onChange={(e) => { setSessionDateFilter(e.target.value); setOffset(0); }}
                className="h-9 w-auto text-sm"
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
                <div className="flex items-center justify-center py-16"><Loader2 className="h-6 w-6 animate-spin text-[#001d6e]" /></div>
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
                      <PlantBadge plant={s.plant} />
                      <span className="text-xs text-gray-500">{s.orderDate}</span>
                      {s.partsCount > 1 && (
                        <span className="rounded-full bg-indigo-50 px-1.5 py-0.5 text-[11px] font-semibold text-indigo-700">Batch {s.partIndex}/{s.partsCount}</span>
                      )}
                      <span className="text-xs text-gray-600"><span className="text-gray-400">Received </span><span className="font-bold tabular-nums">{s.scannedQty}/{s.expectedQty}</span></span>
                      {s.scanCompletedAt && (
                        <span className="text-xs text-gray-400">Completed {new Date(s.scanCompletedAt).toLocaleString()}</span>
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
              <div className="flex items-center justify-center py-16"><Loader2 className="h-6 w-6 animate-spin text-[#001d6e]" /></div>
            ) : sessions.length === 0 ? (
              <div className="flex flex-col items-center justify-center py-16 text-center">
                <div className="mb-3 flex h-14 w-14 items-center justify-center rounded-full bg-[#001d6e]/10">
                  <Truck className="h-7 w-7 text-[#001d6e]/40" />
                </div>
                <div className="mb-1 text-sm font-semibold text-[#001d6e]">
                  {statusTab === "history" ? "No vehicles imported yet" : `No ${statusTab} batches`}
                </div>
                <p className="mb-4 max-w-xs text-xs text-muted-foreground">
                  {statusTab !== "history" ? "Check the History tab to see everything." : canWrite ? "Import a CSV to get started." : "Nothing has been imported yet."}
                </p>
              </div>
            ) : (
              // Rotated/kiosk mode reuses this exact same table, just bounded + self-scrolling
              // inside kioskTableBoxClass (same treatment as the item table's own DataTable) —
              // rather than a different, cut-down card view, so what an operator sees rotated is
              // the same table as everywhere else in the app, only fitted to the rotated screen.
              <div className={rotated ? kioskTableBoxClass : "overflow-x-auto"}>
                <table className="w-full min-w-full caption-bottom border-collapse text-xs">
                  <thead className="sticky top-0 z-10">
                    <tr className="bg-[#001d6e]">
                      <th className="w-12 whitespace-nowrap border-r border-[#1a3a9c] px-3 py-2.5 text-left text-[11px] font-semibold tracking-wide uppercase text-white">Sr. No</th>
                      <th className="whitespace-nowrap border-r border-[#1a3a9c] px-3 py-2.5 text-left text-[11px] font-semibold tracking-wide uppercase text-white">Vehicle</th>
                      <th className="whitespace-nowrap border-r border-[#1a3a9c] px-3 py-2.5 text-left text-[11px] font-semibold tracking-wide uppercase text-white">Order Date</th>
                      <th className="whitespace-nowrap border-r border-[#1a3a9c] px-3 py-2.5 text-left text-[11px] font-semibold tracking-wide uppercase text-white">Plant</th>
                      <th className="whitespace-nowrap border-r border-[#1a3a9c] px-3 py-2.5 text-left text-[11px] font-semibold tracking-wide uppercase text-white">
                        <span title="When the same vehicle + date is uploaded more than once, each upload becomes a numbered batch — batches scan in order, one at a time.">
                          Batch
                        </span>
                      </th>
                      <th className="whitespace-nowrap border-r border-[#1a3a9c] px-3 py-2.5 text-left text-[11px] font-semibold tracking-wide uppercase text-white">Status</th>
                      <th className="whitespace-nowrap border-r border-[#1a3a9c] px-3 py-2.5 text-left text-[11px] font-semibold tracking-wide uppercase text-white">Progress</th>
                      <th className="whitespace-nowrap border-r border-[#1a3a9c] px-3 py-2.5 text-left text-[11px] font-semibold tracking-wide uppercase text-white" title="Time from when scanning started to when the batch was marked complete">Time Taken</th>
                      <th className="whitespace-nowrap px-3 py-2.5 text-right text-[11px] font-semibold tracking-wide uppercase text-white">Action</th>
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
                            <td className="border-r border-b border-gray-200 px-3 py-2 text-gray-400 tabular-nums">{offset + i + 1}</td>
                            <td className="border-r border-b border-gray-200 px-3 py-2 font-semibold text-[#001d6e]">{s.vehicleNumber}</td>
                            <td className="border-r border-b border-gray-200 px-3 py-2 text-gray-700">{s.orderDate}</td>
                            <td className="border-r border-b border-gray-200 px-3 py-2"><PlantBadge plant={s.plant} /></td>
                            <td className="border-r border-b border-gray-200 px-3 py-2">
                              {s.partsCount > 1 ? (
                                <span className="rounded-full bg-indigo-50 px-2 py-0.5 text-[11px] font-semibold text-indigo-700">Batch {s.partIndex} of {s.partsCount}</span>
                              ) : (
                                <span className="text-gray-400">—</span>
                              )}
                            </td>
                            <td className="border-r border-b border-gray-200 px-3 py-2">{statusBadge(s.scanStatus, s.canActivate)}</td>
                            <td className="border-r border-b border-gray-200 px-3 py-2 text-gray-700 tabular-nums">{s.scannedQty} / {s.expectedQty}</td>
                            <td className="border-r border-b border-gray-200 px-3 py-2 text-gray-700 tabular-nums">
                              {statusTab === "history" ? (formatDuration(s.scanActivatedAt, s.scanCompletedAt) ?? <span className="text-gray-300">—</span>) : <span className="text-gray-300">—</span>}
                            </td>
                            <td className="border-b border-gray-200 px-3 py-2 text-right">
                              <div className="flex items-center justify-end gap-1.5">
                                <Button
                                  size="sm" variant="outline" className="h-7 text-xs"
                                  disabled={s.scanStatus === "available" && !s.canActivate}
                                  onClick={(e) => { e.stopPropagation(); openSession(s); }}
                                >
                                  {s.scanStatus === "completed" ? "View" : s.scanStatus === "active" ? "Continue Scan" : s.canActivate ? "Start Scan" : "Locked"}
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
                    <select
                      className="h-7 rounded border bg-background px-1 text-xs"
                      value={limit}
                      onChange={(e) => { setLimit(Number(e.target.value)); setOffset(0); }}
                      aria-label="Rows per page"
                    >
                      {SESSIONS_PAGE_SIZE_OPTIONS.map((size) => (
                        <option key={size} value={size}>{size}</option>
                      ))}
                    </select>
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
            <div className="flex items-center justify-between flex-wrap gap-2">
              {canWrite ? (
                <Button variant="outline" size="sm" onClick={backToList}>&larr; Back to list</Button>
              ) : <span />}
              {detail?.session && (
                <div className="flex items-center gap-2 flex-wrap justify-end">
                  {statusBadge(detail.session.scanStatus)}
                  {itemTotals.expected > 0 && (
                    <div
                      className="flex items-center gap-1.5 rounded-full border border-gray-200 bg-gray-50 px-2.5 py-1"
                      title={`Batch progress: ${itemTotals.received.toLocaleString()} / ${itemTotals.expected.toLocaleString()} (${itemPct}%)`}
                    >
                      <div className="h-1.5 w-14 rounded-full bg-gray-200 overflow-hidden">
                        <div
                          className={`h-full rounded-full transition-all ${itemPct >= 100 ? "bg-emerald-500" : "bg-[#001d6e]"}`}
                          style={{ width: `${itemPct}%` }}
                        />
                      </div>
                      <span className="text-[11px] font-semibold text-gray-600 whitespace-nowrap">{itemPct}%</span>
                    </div>
                  )}
                  {canWrite && detail.session.scanStatus === "completed" && (
                    <Button size="sm" variant="outline" onClick={() => reopenMutation.mutate()} disabled={reopenMutation.isPending}>
                      <RotateCcw className="mr-1 h-3.5 w-3.5" /> Reopen
                    </Button>
                  )}
                  {canWrite && detail.session.scanStatus !== "completed" && (
                    <Button
                      size="sm"
                      className="h-8 rounded-full bg-emerald-600 px-3 text-xs text-white hover:bg-emerald-700"
                      onClick={() => setShowCompleteConfirm(true)}
                    >
                      Complete
                    </Button>
                  )}
                </div>
              )}
            </div>

            {activeSessionQuery.isLoading || !detail ? (
              <div className="flex items-center justify-center py-16"><Loader2 className="h-6 w-6 animate-spin text-[#001d6e]" /></div>
            ) : (
              <>
                <div
                  className="grid grid-cols-1 gap-4 items-start"
                  // Same row either way, but the split needs different math once rotated: the
                  // draggable leftColWidth is a fixed PIXEL the user set against a real desktop
                  // window, which can easily be wider than the rotated box's own available width
                  // (tied to the screen's HEIGHT, often much smaller on a laptop) — squeezing
                  // Scan Items down to nothing instead of just being proportioned wrong. Rotated
                  // mode uses a %-based split instead, so it always fits whatever width the
                  // rotated box actually has, on any screen.
                  style={
                    rotated
                      ? { gridTemplateColumns: "minmax(200px, 38%) 1fr" }
                      : isDesktop && canWrite && !locked
                      ? { gridTemplateColumns: `${leftColWidth}px 10px 1fr` }
                      : undefined
                  }
                >
                  <div className="rounded-xl border border-gray-200 bg-white shadow-sm overflow-hidden">
                    <div className="flex items-center gap-2 px-4 sm:px-5 py-3 border-b border-gray-100">
                      <Truck className="h-4 w-4 text-[#001d6e]" />
                      <span className="text-sm font-semibold text-gray-900">Vehicle Details</span>
                    </div>
                    <div className="grid grid-cols-2 gap-3 text-sm px-4 sm:px-5 py-4">
                      <div><div className="text-xs text-gray-400">Vehicle</div><div className="font-semibold text-[#001d6e]">{detail.session.vehicleNumber}</div></div>
                      <div><div className="text-xs text-gray-400">Order Date</div><div className="font-semibold">{detail.session.orderDate}</div></div>
                      <div><div className="text-xs text-gray-400">Plant</div><div className="font-semibold"><PlantBadge plant={detail.session.plant} /></div></div>
                      <div>
                        <div className="text-xs text-gray-400" title="When the same vehicle + date is uploaded more than once, each upload becomes a numbered batch — batches scan in order, one at a time.">Batch</div>
                        <div className="font-semibold">{detail.session.partIndex}</div>
                      </div>
                    </div>
                  </div>

                  {isDesktop && canWrite && !locked && !rotated && (
                    <div
                      onMouseDown={handleColumnResizeStart}
                      title="Drag to resize"
                      className="hidden lg:flex h-full items-stretch justify-center cursor-col-resize select-none group"
                    >
                      <div className="w-1 rounded-full bg-gray-200 group-hover:bg-[#001d6e]/50 group-active:bg-[#001d6e] transition-colors" />
                    </div>
                  )}

                  {canWrite && !locked && (
                    <div className="rounded-xl border border-gray-200 bg-white shadow-sm overflow-hidden">
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

                        {/* Main STV selector — same per-plant picker Order Scan has; sets the
                            default for the next scan confirmation too (see the dialog's own STV
                            select below). */}
                        {stvs.length > 0 && (
                          <div className="flex items-center gap-2">
                            <span className="shrink-0 text-[10px] font-semibold uppercase tracking-wide text-gray-400">STV</span>
                            <Select
                              value={selectedStv || NO_STV}
                              onValueChange={(v) => setSelectedStv(v === NO_STV ? "" : v)}
                            >
                              <SelectTrigger className={`h-8 w-44 justify-center rounded-xl border-2 text-center text-sm font-semibold ${
                                selectedStv ? "border-[#001d6e] bg-[#001d6e]/5 text-[#001d6e]" : "border-gray-300 text-gray-500"
                              }`}>
                                <SelectValue placeholder="Select STV…" />
                              </SelectTrigger>
                              <SelectContent className={rotated ? `origin-top-left ${portalRotate}` : undefined}>
                                <SelectItem value={NO_STV}>— Select STV —</SelectItem>
                                {stvs.map((s) => (
                                  <SelectItem key={s} value={s}>{s}</SelectItem>
                                ))}
                              </SelectContent>
                            </Select>
                          </div>
                        )}

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

                {/* ── Totals strip — same "4 clickable stat tiles with a pallet count under each
                    number" pattern as Order Scan's own item table (client/src/pages/Scanning/
                    Scan.tsx). Clicking a tile filters the table below to just that bucket. ── */}
                <div className="grid grid-cols-4 divide-x divide-gray-200 overflow-hidden rounded-xl border border-gray-300 bg-white">
                  {([
                    { key: "" as const, label: "Total", value: itemTotals.expected, plt: itemTotals.pltExpected, text: "text-gray-900" },
                    { key: "done" as const, label: "Received", value: itemTotals.received, plt: itemTotals.pltReceived, text: "text-emerald-600" },
                    { key: "remaining" as const, label: "Remaining", value: itemTotals.remaining, plt: itemTotals.pltRemaining, text: "text-red-600" },
                    { key: "extra" as const, label: "Extra", value: itemTotals.extra, plt: itemTotals.pltExtra, text: itemTotals.extra > 0 ? "text-amber-600" : "text-gray-300" },
                  ]).map((s) => {
                    const isActive = itemStatusFilter === s.key;
                    return (
                      <button
                        key={s.label}
                        type="button"
                        onClick={() => setItemStatusFilter(isActive ? "" : s.key)}
                        aria-pressed={isActive}
                        title={s.key ? `Show only ${s.label.toLowerCase()} items` : "Show all items"}
                        className={`text-center px-2 py-1.5 transition-colors ${isActive ? "bg-[#001d6e]/[0.06] ring-1 ring-inset ring-[#001d6e]/30" : "hover:bg-gray-50"}`}
                      >
                        <p className="uppercase tracking-wide text-gray-400 text-xs">{s.label}</p>
                        <p className={`font-bold text-2xl ${s.text}`}>{s.value}</p>
                        <p className={`font-bold text-sm ${s.text}`}>{s.plt.toFixed(2)} plt</p>
                      </button>
                    );
                  })}
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
                    isStickyHeader={rotated}
                    maxHeight={rotated ? (quarterTurn ? "62vw" : "62vh") : undefined}
                  />
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
                        <img
                          src={`/api/products/image-by-name?name=${encodeURIComponent(autoFeedback.name)}`}
                          alt=""
                          className="h-60 w-60 shrink-0 object-contain bg-gray-50 border border-gray-100"
                          onError={(e) => { (e.currentTarget as HTMLImageElement).style.display = "none"; }}
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

      {/* Confirm dialog — anything not a clean full-pallet auto-scan. Radix portals DialogContent
          to document.body, escaping the rotated wrapper no matter where this is declared in JSX,
          so it needs the compensating turn applied by hand via portalRotate (same fix as
          portalRotateClass in Scan.tsx) — otherwise it opens upright while the page behind it is
          rotated. */}
      <Dialog open={!!pending} onOpenChange={(open) => { if (!open) setPending(null); }}>
        <DialogContent
          className={`overflow-y-auto rounded-2xl p-0 ${portalRotate} ${
            quarterTurn
              ? "w-[92vh] max-w-[92vh] max-h-[92vw]"
              : "w-[calc(100%-2rem)] max-w-2xl sm:max-w-4xl max-h-[90vh]"}`}
        >
          {/* Two columns: full-height product image on the left, all controls on the right — same
              layout as Order Scan's own confirm dialog (client/src/pages/Scanning/Scan.tsx). Under
              rotate-90, CSS-left maps to physical-top, so image-left reads as image-on-top. */}
          <div className="flex flex-col sm:flex-row">
            {dialogResolvedImageName && !dialogImageFailed && (
              <div className="flex shrink-0 items-center justify-center border-b border-gray-100 bg-gray-50 p-4 sm:w-80 sm:border-b-0 sm:border-r">
                <img
                  key={dialogResolvedImageName}
                  src={`/api/products/image-by-name?name=${encodeURIComponent(dialogResolvedImageName)}`}
                  alt=""
                  className="max-h-96 w-full object-contain sm:max-h-full"
                  onError={() => setDialogImageFailed(true)}
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
                ? <><AlertTriangle className="h-7 w-7" /> Not on manifest</>
                : pending.item.isComplete
                  ? <><AlertTriangle className="h-7 w-7" /> Extra item</>
                  : <><CheckCircle2 className="h-7 w-7" /> Match found</>}
            </DialogTitle>
            <DialogDescription className="text-left space-y-1.5 min-w-0 pt-3">
              <p className="font-bold text-gray-900 text-2xl leading-snug">{pending?.item?.itemName ?? pending?.barcode}</p>
              <p className="font-mono text-lg text-gray-400">{pending?.barcode}</p>
              {!pending?.item && (
                <p className="text-lg text-red-600 mt-1">Not on this vehicle's manifest — will be logged as an extra.</p>
              )}
              {pending?.item?.isComplete && (
                <p className="text-lg text-amber-600 mt-1">Item already complete — these extra units will be logged separately.</p>
              )}
            </DialogDescription>
          </DialogHeader>

          <div className="space-y-4 py-1">
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
                <Label className="text-sm">STV <span className="text-red-500">*</span></Label>
                <Select value={selectedStv || NO_STV} onValueChange={(v) => setSelectedStv(v === NO_STV ? "" : v)}>
                  <SelectTrigger className={`w-full rounded-xl ${!selectedStv ? "border-dashed text-gray-400" : ""}`}>
                    <SelectValue placeholder="Select STV…" />
                  </SelectTrigger>
                  <SelectContent className={rotated ? `origin-top-left ${portalRotate}` : undefined}>
                    <SelectItem value={NO_STV}>— Select STV —</SelectItem>
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
            <div className={`grid gap-3 ${dialogPlt > 1 && !quarterTurn ? "sm:grid-cols-2" : "grid-cols-1"}`}>
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

              {dialogPlt > 1 && (
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
        <DialogContent className={`max-w-sm ${portalRotate}`}>
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

      {/* ── Delete confirmation — replace (soft, carries forward on re-upload) vs discard
          (reverses stock, voids history, self-resolves) ─────────────────────────────────── */}
      <Dialog open={!!deleteTarget} onOpenChange={(open) => { if (!open) setDeleteTarget(null); }}>
        <DialogContent className={`max-w-md ${portalRotate}`}>
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
