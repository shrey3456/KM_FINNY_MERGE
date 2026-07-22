import { useEffect, useMemo, useRef, useState } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import {
  AlertTriangle,
  ArrowLeft,
  Camera,
  CheckCircle2,
  ChevronDown,
  ChevronLeft,
  ChevronRight,
  Download,
  History,
  Keyboard,
  Loader2,
  PackageCheck,
  Package,
  FileSpreadsheet,
  Layers,
  Plug,
  ScanLine,
  Search,
  Trash2,
  Undo2,
  X,
  Zap,
  Eye,
  EyeOff,
  RotateCw,
  ChevronUp,
} from "lucide-react";
import { Result } from "@zxing/library";
import BarcodeScanner from "@/lib/barcodeScanner";
import CameraPermissionBanner from "@/components/CameraPermissionBanner";
import { apiRequest } from "@/lib/queryClient";
import { useToast } from "@/hooks/use-toast";
import { useUser } from "@/hooks/use-user";
import { useLocation } from "wouter";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Progress } from "@/components/ui/progress";
import { DataTable, type DataTableColumn } from "@/components/ui/data-table";
import { TableCard } from "@/components/ui/table-card";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";


type Product = {
  id: number;
  name: string;
  barcode: string;
  itemNo?: string | null;
  sapCode?: string | null;
  srNo?: string | null;
  inStock?: number | null;
  itemsPerPallet?: number | null;
  pallets?: number | null;
  indPlt?: number | null;   // Indore plant pallet qty
  valPlt?: number | null;   // Valsad plant pallet qty
};

type OsScanItem = {
  id: number; sessionId: number;
  barcode: string | null; itemName: string | null; sapCode: string | null;
  expectedQty: number; itemsPerPallet: number;
  scannedPallets: number; scannedLooseQty: number; totalScannedQty: number;
  status: string; lastScannedAt: string | null;
};

type MvItem = {
  id: number; barcode: string | null; itemName: string | null;
  sapCode: string | null; quantity: number | null; expectedPallets: number | null;
  scannedQty: number | null; scanStatus: string | null; isExtra?: boolean;
};
type MvFile = {
  sessionId: number; csvFileName: string; rowCount: number | null;
  uploadedAt: string | null; uploadedBy: string; plant: string;
  scanStatus: string | null; items: MvItem[];
  emptyBoxCount?: number; emptyBoxTotalQty?: number;
};
type MvResponse = { date: string; totalFiles: number; totalRows: number; files: MvFile[] };
type MvMergedItem = {
  barcode: string | null; itemName: string | null; sapCode: string | null;
  quantity: number; scannedQty: number; extraQty: number; expectedPallets: number | null;
  itemsPerPallet: number;
  _files: string[]; _isExtra: boolean;
  // Distinct synthetic "Empty Box" entry — not a product, never counted toward order qty.
  _isEmptyBox?: boolean; _emptyBoxCount?: number; _emptyBoxQty?: number;
};
type ImpSession = {
  id: number; plant: string; csvFileName: string; rowCount: number;
  importedByName: string | null; createdAt: string | null; scanStatus: string;
};
type ImpItem = {
  id: number; barcode: string | null; itemName: string | null;
  sapCode: string | null; quantity: number | null; expectedPallets: number | null;
  scannedQty: number | null; scanStatus: string | null;
};

// ─── Helpers ───────────────────────────────────────────────────────────────

function scanFmtIST(dt: string | null | undefined): string {
  if (!dt) return "—";
  const s = String(dt);
  const d = new Date(/Z$|[+-]\d{2}:\d{2}$/.test(s) ? s : s.replace(" ", "T") + "Z");
  if (isNaN(d.getTime())) return "—";
  return d.toLocaleString("en-IN", { timeZone: "UTC" });
}

// Upload date for the session header — date only, no clock, since it identifies which day's
// upload this is. Parses the same bare-timestamp shape scanFmtIST handles.
function scanFmtUploadDate(dt: string | null | undefined): string {
  if (!dt) return "—";
  const s = String(dt);
  const d = new Date(/Z$|[+-]\d{2}:\d{2}$/.test(s) ? s : s.replace(" ", "T") + "Z");
  if (isNaN(d.getTime())) return "—";
  return d.toLocaleDateString("en-IN", {
    timeZone: "UTC",
    day: "2-digit",
    month: "short",
    year: "numeric",
  });
}

const normalize = (value?: string | number | null) =>
  String(value ?? "").trim().toLowerCase();

// Display-only: strips a trailing ".csv" from a file name so it reads cleanly in the UI.
const stripCsvExt = (name?: string | null) => (name ?? "").replace(/\.csv$/i, "");

// Pallet-count cell: qty ÷ items-per-pallet, or a muted 0.00 when not applicable. Shared by the
// Scan tab's CSV Items table and Master View so both render pallet figures identically.
const pltCell = (qty: number, ipp: number, className: string) =>
  qty > 0 && ipp > 0
    ? <span className={className}>{(qty / ipp).toFixed(2)}</span>
    : <span className="text-gray-300">0.00</span>;

// Sound played on every barcode detection. Drop an mp3/wav at client/public/sounds/scan-beep.mp3
// to use a custom sound — it's tried first and used automatically. If that file is missing (or
// playback fails), falls back to a short tone generated via the Web Audio API, so no audio asset
// is required at all. One AudioContext is reused across calls (re-creating one per scan is wasteful
// and browsers cap how many can be created).
const CUSTOM_SCAN_SOUND_URL = "/sounds/scan-beep.mp3";

// Remembers the operator's STV pick across page navigations (the Scan page unmounts when you
// leave it, which would otherwise clear the selection and re-trigger "Select an STV").
const OS_STV_STORAGE_KEY = "km-finny.scan.selectedStv";
// Width split (percent) between the totals card and the scanner column — operator-draggable.
const OS_TOTALS_PCT_KEY = "km-finny.scan.totalsWidthPct";
const OS_TOTALS_PCT_MIN = 30;
const OS_TOTALS_PCT_MAX = 80;
let customScanSoundBroken = false; // set once the custom file is confirmed missing/unplayable
let scanBeepCtx: AudioContext | null = null;

function playGeneratedBeep() {
  try {
    const Ctx = window.AudioContext || (window as any).webkitAudioContext;
    if (!Ctx) return;
    if (!scanBeepCtx) scanBeepCtx = new Ctx();
    const ctx = scanBeepCtx;
    if (ctx.state === "suspended") ctx.resume();
    const osc = ctx.createOscillator();
    const gain = ctx.createGain();
    osc.type = "sine";
    osc.frequency.value = 880;
    gain.gain.setValueAtTime(0.15, ctx.currentTime);
    gain.gain.exponentialRampToValueAtTime(0.0001, ctx.currentTime + 0.12);
    osc.connect(gain);
    gain.connect(ctx.destination);
    osc.start();
    osc.stop(ctx.currentTime + 0.12);
  } catch {
    // Audio unavailable (e.g. autoplay restrictions) — scanning still works without sound.
  }
}

function playScanBeep() {
  if (customScanSoundBroken) { playGeneratedBeep(); return; }
  try {
    const audio = new Audio(CUSTOM_SCAN_SOUND_URL);
    audio.play().catch(() => { customScanSoundBroken = true; playGeneratedBeep(); });
  } catch {
    customScanSoundBroken = true;
    playGeneratedBeep();
  }
}

// ─── Component ─────────────────────────────────────────────────────────────

export default function ScanOrderPage() {
  const { toast } = useToast();
  const { user: currentUser } = useUser();
  const [, navigate] = useLocation();
  const isDispatchUser = (currentUser?.department ?? '').toLowerCase().includes('dispatch');
  // Force-completing a part (even with items still short) is admin-only by default — the
  // shortage can be picked up by a later part and reconciled via the combined-report
  // FIFO adjustment logic, so dispatch scanners shouldn't be the ones deciding to close it.
  // Also allowed for: a user who BOTH has "scan-order" granted via Allowed Pages AND has
  // the Supervisor designation — either alone is not enough.
  const userDesignation = String((currentUser as any)?.designation || "").toLowerCase().trim();
  let osAllowedPagesList: string[] = [];
  try { osAllowedPagesList = JSON.parse((currentUser as any)?.allowedPages || "[]"); } catch { osAllowedPagesList = []; }
  const canCompletePart = ["admin", "super-admin"].includes(((currentUser as any)?.role ?? "").toLowerCase())
    || (osAllowedPagesList.includes("scan-order") && userDesignation === "supervisor");
  const queryClient = useQueryClient();

  // ── Master View / Separate CSVs tab state ────────────────────────────────
  const [osTab, setOsTab] = useState<"scan" | "master-view" | "separate-csvs">("master-view");
  const [mvSearch,    setMvSearch]    = useState("");
  const [mvShowFiles, setMvShowFiles] = useState(false); // toggle: show/hide source-file names in Master View
  // Clicking a totals box narrows the items table to just those rows. "" = show everything;
  // clicking the active box again clears it.
  const [osStatFilter, setOsStatFilter] = useState<"" | "done" | "remaining" | "extra">("");
  // Draggable split between the totals card and the scanner column. Stored as a percent of the
  // row's width so it survives a reload and adapts to any window size.
  const totalsRowRef = useRef<HTMLDivElement | null>(null);
  const [totalsPct, setTotalsPct] = useState<number>(() => {
    try {
      const saved = Number(localStorage.getItem(OS_TOTALS_PCT_KEY));
      return Number.isFinite(saved) && saved >= OS_TOTALS_PCT_MIN && saved <= OS_TOTALS_PCT_MAX ? saved : 60;
    } catch { return 60; }
  });
  useEffect(() => {
    try { localStorage.setItem(OS_TOTALS_PCT_KEY, String(Math.round(totalsPct))); } catch { /* private mode */ }
  }, [totalsPct]);

  // Pointer events (not mouse) so a stylus/touch drag works too. Listeners go on window so the
  // drag keeps tracking even when the cursor leaves the thin handle.
  const startTotalsResize = (e: React.PointerEvent<HTMLDivElement>) => {
    e.preventDefault();
    const row = totalsRowRef.current;
    if (!row) return;
    const onMove = (ev: PointerEvent) => {
      const rect = row.getBoundingClientRect();
      if (!rect.width) return;
      const pct = ((ev.clientX - rect.left) / rect.width) * 100;
      setTotalsPct(Math.min(OS_TOTALS_PCT_MAX, Math.max(OS_TOTALS_PCT_MIN, pct)));
    };
    const onUp = () => {
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", onUp);
      document.body.style.userSelect = "";
      document.body.style.cursor = "";
    };
    document.body.style.userSelect = "none";
    document.body.style.cursor = "col-resize";
    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup", onUp);
  };

  // No csvDate/csvPlant here: the Separate CSVs tab filters by mvDate/mvPlant, which are derived
  // from the active scan session further down.
  const [csvExpId,    setCsvExpId]    = useState<number | null>(null);
  const [csvSearch,   setCsvSearch]   = useState("");

  const [showAllHistory, setShowAllHistory] = useState(false);
  const [historyPage, setHistoryPage] = useState(0);

  // ── Kiosk rotation — for a screen mounted in portrait. Remembered across reloads
  // (localStorage) since a mounted kiosk screen stays in the same physical orientation
  // indefinitely. See .kiosk-rotate-90 in index.css for the actual rotate mechanics.
  const [osRotated, setOsRotated] = useState(() => localStorage.getItem("scanOrderRotated") === "true");
  useEffect(() => {
    localStorage.setItem("scanOrderRotated", String(osRotated));
  }, [osRotated]);
  const RotateToggleButton = () => (
    <button
      onClick={() => setOsRotated((r) => !r)}
      className="fixed bottom-4 right-4 z-[60] flex items-center gap-2 rounded-full bg-[#001d6e] px-4 py-3 text-white shadow-lg transition-colors hover:bg-[#00154b]"
      title={osRotated ? "Rotate back to normal" : "Rotate for a portrait-mounted screen"}
    >
      <RotateCw className="h-5 w-5" />
      <span className="hidden text-xs font-semibold sm:inline">{osRotated ? "Un-rotate" : "Rotate"}</span>
    </button>
  );

  // ── Rotated-view scroll fix ──────────────────────────────────────────────
  // A 90°-rotated container's native scroll (mouse wheel, trackpad, touch swipe) moves content
  // SIDEWAYS on screen, not up/down — a rigid rotation swaps which axis is "vertical", but this
  // page's lists are still laid out as normal top-to-bottom content, so the only real scrollable
  // axis maps to sideways motion once rotated (confirmed via direct on-screen measurement).
  // Rather than rebuild these lists to scroll on the other axis (invasive — most rows are
  // variable-height, incompatible with the fixed-width-per-item layout that would need), we
  // disable native scroll on these containers when rotated and replace it with discrete Up/Down
  // buttons — a button press doesn't carry the same "gesture went one way, screen went another"
  // mismatch that makes continuous swipe/wheel scrolling feel disorienting.
  const osTabBodyScrollRef = useRef<HTMLDivElement>(null);
  const osCsvListScrollRef = useRef<HTMLDivElement>(null);
  const osManageExtraScrollRef = useRef<HTMLDivElement>(null);

  function ScrollNudgeButtons({ targetRef, amount = 240, className = "", large = false }: {
    targetRef: React.RefObject<HTMLElement>; amount?: number; className?: string; large?: boolean;
  }) {
    const nudge = (dir: 1 | -1) => targetRef.current?.scrollBy({ top: dir * amount, behavior: "smooth" });
    const btn = large
      ? "rounded-2xl bg-black/10 p-3.5 text-current hover:bg-black/20 active:scale-95 transition"
      : "rounded-full bg-black/10 p-1.5 text-current hover:bg-black/20";
    const icon = large ? "h-7 w-7" : "h-4 w-4";
    return (
      <div className={`flex items-center ${large ? "flex-col gap-2" : "gap-1"} ${className}`}>
        <button type="button" onClick={() => nudge(-1)} aria-label="Scroll up" title="Scroll up" className={btn}>
          <ChevronUp className={icon} />
        </button>
        <button type="button" onClick={() => nudge(1)} aria-label="Scroll down" title="Scroll down" className={btn}>
          <ChevronDown className={icon} />
        </button>
      </div>
    );
  }

  // ── Queries ──────────────────────────────────────────────────────────────

  const { data: productsRaw = [] } = useQuery<any>({
    queryKey: ["/api/products", { all: "true" }],
  });
  const products: Product[] = Array.isArray(productsRaw) ? productsRaw : (productsRaw?.results ?? []);

  // Dispatch dashboard: all order-scan sessions for the user's plant (active + completed)
  const { data: osAllSessions = [] } = useQuery<any[]>({
    queryKey: ["/api/order-scan/sessions", "dispatch-dashboard"],
    queryFn: () => apiRequest("GET", "/api/order-scan/sessions").then((r) => r.json()),
    enabled: isDispatchUser,
    staleTime: 0,
    refetchInterval: 30000,
  });

  // Dispatch dashboard: scan history by current user (last 10 or paginated)
  const dispatchHistoryKey = ["/api/scan-sessions/reports/scan-history", "dispatch", currentUser?.name, showAllHistory, historyPage];
  const { data: dispatchHistory, isFetching: dispatchHistoryFetching } = useQuery<{
    items: any[]; total: number; totalBoxes: number; totalPallets: number; limit: number; offset: number;
  }>({
    queryKey: dispatchHistoryKey,
    queryFn: () => {
      const scanner = encodeURIComponent(currentUser?.name || currentUser?.username || '');
      const offset = showAllHistory ? historyPage * 10 : 0;
      return apiRequest("GET", `/api/scan-sessions/reports/scan-history?scanner=${scanner}&limit=10&offset=${offset}`).then((r) => r.json());
    },
    enabled: isDispatchUser && !!(currentUser?.name || currentUser?.username),
    staleTime: 0,
    refetchInterval: 30000,
  });

  // Poll for admin-loaded order-import session (from /order-scan flow).
  // 5s interval + refetchOnMount:'always' so changes made on the Import page
  // are visible here within 5 seconds without a manual page refresh.
  const { data: orderScanNotif, isLoading: orderScanNotifLoading } = useQuery<{ active: boolean; session: any }>({
    queryKey: ["/api/order-scan/notification"],
    queryFn: () => apiRequest("GET", "/api/order-scan/notification").then((r) => r.json()),
    staleTime: 0,
    refetchInterval: 5000,
    refetchOnMount: "always",
  });

  // Plural counterpart — lets an admin see/switch between MULTIPLE simultaneously-active
  // sessions across different plants (e.g. Valsad + Indore both scanning at once), instead
  // of only ever seeing whichever one /notification picks as "the" active session. For
  // dispatch/non-admin users this returns the same 0-or-1 sessions as /notification, so
  // nothing changes for them — the switcher UI below only renders when there's a real choice.
  const { data: osActiveSessions } = useQuery<any[]>({
    queryKey: ["/api/order-scan/active-sessions"],
    queryFn: () => apiRequest("GET", "/api/order-scan/active-sessions").then((r) => r.json()),
    staleTime: 0,
    refetchInterval: 5000,
    refetchOnMount: "always",
  });
  const [osSelectedSessionId, setOsSelectedSessionId] = useState<number | null>(null);
  const activeOrderScanSession = (() => {
    const list = osActiveSessions ?? [];
    if (list.length > 0) {
      return list.find((s) => s.id === osSelectedSessionId) ?? list[0];
    }
    // Fallback to the singular endpoint (covers the moment active-sessions hasn't
    // resolved yet on first load) so behavior is identical to before this existed.
    return orderScanNotif?.active ? orderScanNotif.session : null;
  })();

  // Plant config (colors + the scan behavior toggles like Auto Scan). Small, cacheable list;
  // we look up the active session's plant by name to read its per-plant flags. Auto Scan
  // being off (or the plant not found) falls through to the classic always-confirm flow.
  const { data: allPlants } = useQuery<any[]>({
    queryKey: ["/api/plants"],
    queryFn: () => apiRequest("GET", "/api/plants").then((r) => r.json()),
    staleTime: 60000,
  });
  const autoScanEnabled = (() => {
    const plantName = (activeOrderScanSession?.plant ?? "").toLowerCase();
    if (!plantName) return false;
    const p = (allPlants ?? []).find((pl: any) => String(pl.name ?? "").toLowerCase() === plantName);
    return p?.isAutoScanEnabled === true;
  })();

  // Master View has no manual plant/date pickers — it always follows the currently active
  // session. Scoped by that session's ORDER DATE (the value chosen at upload, which is also
  // what FIFO grouping keys on) so every part of the order shows together no matter which day
  // each CSV was actually uploaded. Previously this used scanActivatedAt (≈ the upload/scan
  // day), which split a group whenever its parts arrived on different days.
  const mvPlant = activeOrderScanSession?.plant ?? "";
  const mvDate = activeOrderScanSession?.orderDate
    ? String(activeOrderScanSession.orderDate).slice(0, 10)
    : "";

  // ── Embedded order-scan state (admin-loaded CSV) ───────────────────────────
  // Two video elements exist (mobile sm:hidden block + desktop hidden sm:block block).
  // They MUST have separate refs — a shared ref would attach to the last-rendered
  // (desktop) element, so on a phone the camera stream would go to the hidden desktop
  // video and the visible mobile video would stay black. getActiveVideo() picks whichever
  // is actually on screen (offsetParent is null for display:none elements).
  const osVideoMobileRef = useRef<HTMLVideoElement>(null);
  const osVideoDesktopRef = useRef<HTMLVideoElement>(null);
  const getActiveVideo = (): HTMLVideoElement | null => {
    const m = osVideoMobileRef.current;
    const d = osVideoDesktopRef.current;
    if (m && m.offsetParent !== null) return m;
    if (d && d.offsetParent !== null) return d;
    return m ?? d ?? null;
  };
  const osScannerRef = useRef<BarcodeScanner | null>(null);
  const [osScanMode, setOsScanMode] = useState<"camera" | "manual">("manual");
  const [osCameraReady, setOsCameraReady] = useState(false);
  const [osCameraError, setOsCameraError] = useState<string | null>(null);
  const [osPending, setOsPending] = useState<{ barcode: string; matchedItem: OsScanItem | null; inventoryProduct: Product | null; plantPalletSize: number } | null>(null);
  const osPendingRef = useRef<{ barcode: string; matchedItem: OsScanItem | null; inventoryProduct: Product | null; plantPalletSize: number } | null>(null);
  // Synchronous reentrancy lock for the auto-confirm path. osPendingRef/osMultiMatchRef only
  // guard re-entry while a DIALOG is open — but an auto-confirmed scan never opens one, so
  // without this a second gun trigger-pull (or an auto-repeating manual-entry Enter) landing
  // before the first scan's optimistic totalScannedQty update reaches osItemsRef.current would
  // read the same stale qty, independently decide "still under capacity", and double-log one
  // physical scan while skipping the breach dialog it should have hit on the second qty.
  const osScanLockRef = useRef(false);
  // The matched CSV item + pallet size for the scan currently being submitted. Set by BOTH
  // the auto-confirm path (_resolveOsScan) and the dialog-confirm path (handleOsConfirmScan)
  // just before osScanMutation.mutate, so onMutate can apply its optimistic totalScannedQty/
  // lastScannedAt bump uniformly. Previously onMutate read this only from osPendingRef, which
  // is null for auto-confirmed (under-capacity) scans — so those scans skipped the optimistic
  // reorder-to-top and only moved after the slower server round-trip, while full/breach scans
  // (which open the dialog) reordered instantly. This ref closes that asymmetry.
  const osScanCtxRef = useRef<{ matchedItem: OsScanItem | null; plantPalletSize: number } | null>(null);
  // 5s non-blocking feedback shown after an Auto Scan auto-confirm — image + product details
  // so the operator sees what was scanned without needing to confirm/close anything.
  const [osAutoScanFeedback, setOsAutoScanFeedback] = useState<
    { name: string; barcode: string; sapCode: string | null; scannedQty: number; remaining: number } | null
  >(null);
  const osAutoScanFeedbackTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => () => { if (osAutoScanFeedbackTimerRef.current) clearTimeout(osAutoScanFeedbackTimerRef.current); }, []);
  const [osMultiMatch, setOsMultiMatch] = useState<{ barcode: string; matches: OsScanItem[]; inventoryProduct: Product | null; plantPalletSize: number } | null>(null);
  const osMultiMatchRef = useRef<{ barcode: string; matches: OsScanItem[]; inventoryProduct: Product | null; plantPalletSize: number } | null>(null);
  const [osPallets, setOsPallets] = useState(1);
  const [osLooseQty, setOsLooseQty] = useState(0);
  const [osQty, setOsQty] = useState(1); // total boxes — canonical value sent to the server
  const [osPalletsInput, setOsPalletsInput] = useState(""); // pallets field's own text — kept in sync with osQty in both directions
  // Persists across scans by design — never cleared except when the active session changes
  // (new CSV = probably a new vehicle/delivery). Previously this was cleared after every
  // scan and manually re-applied from a ref at each barcode-scan entry point; any entry
  // point that forgot the re-apply step (or the Escape/backdrop-close path, which cleared
  // it directly) silently broke the "remember my last STV" behavior. Not clearing it at all
  // removes that whole class of bug — the field just keeps showing what you last picked.
  // Seeded from (and mirrored to) localStorage: this is component state, so navigating away
  // from Scan and back unmounts it and would otherwise reset the pick to empty — the operator
  // then hits "Select an STV before scanning" again despite having chosen one earlier.
  // Validated against the plant's real STV list once that loads (see the effect below), so a
  // remembered value from a different plant can't linger.
  const [osSelectedStv, setOsSelectedStv] = useState(() => {
    try { return localStorage.getItem(OS_STV_STORAGE_KEY) ?? ""; } catch { return ""; }
  });
  useEffect(() => {
    try {
      if (osSelectedStv) localStorage.setItem(OS_STV_STORAGE_KEY, osSelectedStv);
      else localStorage.removeItem(OS_STV_STORAGE_KEY);
    } catch { /* storage unavailable (private mode) — in-memory state still works */ }
  }, [osSelectedStv]);
  const [osSearch, setOsSearch] = useState("");
  // Mobile CSV Items search — collapsed by default (just a button); tapping it reveals the field.
  const [osSearchOpen, setOsSearchOpen] = useState(false);
  const [osManualCode, setOsManualCode] = useState("");
  const [osManualFocused, setOsManualFocused] = useState(false);
  const [osSuggIdx, setOsSuggIdx] = useState(-1);
  // Empty Box manual entry (a box with no item/barcode to scan) — dialog state.
  const [showEmptyBox, setShowEmptyBox] = useState(false);
  const [emptyBoxQty, setEmptyBoxQty] = useState("1");
  const [emptyBoxNote, setEmptyBoxNote] = useState("");
  const [osRecentScans, setOsRecentScans] = useState<{ barcode: string; name: string; total: number; isExtra: boolean }[]>([]);
  // Barcodes we already added optimistically; WS handler skips the echo for these
  const osRecentScanSentRef = useRef<Set<string>>(new Set());
  const [wsConnected, setWsConnected] = useState(false);
  // Brief full-screen tint on a silently auto-confirmed scan (no dialog shown) — the only
  // feedback signal besides the beep for the fast/normal-case path. Cleared via setTimeout.
  const [osFlash, setOsFlash] = useState<"success" | null>(null);
  // Client-side "most recently scanned floats to top" ordering. A monotonic counter bumped on
  // every scan (in onMutate), mapping item id → its scan sequence number. Used as the PRIMARY
  // sort key for the CSV Items list instead of lastScannedAt, because lastScannedAt can't be
  // compared reliably across items: a just-scanned item still carries its optimistic real-UTC
  // toISOString() value, while items whose scan already round-tripped carry the server's
  // IST-wall-clock-as-UTC convention (~5.5h ahead) — so the freshly-scanned item looks OLDER
  // and wrongly sorts below an already-completed one. A pure client counter sidesteps all of
  // that. Reset on session change. Held in a ref (not state) because every scan already
  // triggers a re-render via the optimistic setQueryData/setOsRecentScans, so the sort re-runs
  // and reads the fresh ref without needing its own state update.
  // byId keys the Scan tab (rows are CSV items with a real id); byBarcode keys Master View,
  // whose rows are merged across files and so have no id of their own.
  const osScanSeqRef = useRef<{ seq: number; byId: Map<number, number>; byBarcode: Map<string, number> }>(
    { seq: 0, byId: new Map(), byBarcode: new Map() },
  );
  useEffect(() => { osPendingRef.current = osPending; }, [osPending]);
  useEffect(() => { osMultiMatchRef.current = osMultiMatch; }, [osMultiMatch]);
  // Clearing the STV is meant for "the active session actually switched" (new CSV = probably
  // a new vehicle/delivery). It must NOT fire on the initial resolve (undefined → id), which
  // happens on every page load/remount — that would wipe the STV restored from localStorage
  // before the operator ever saw it, so returning to Scan would always demand a re-pick.
  const osPrevSessionIdRef = useRef<number | null>(null);
  useEffect(() => {
    const id = activeOrderScanSession?.id ?? null;
    const prev = osPrevSessionIdRef.current;
    osPrevSessionIdRef.current = id;
    if (prev !== null && id !== null && prev !== id) setOsSelectedStv("");
    osScanSeqRef.current = { seq: 0, byId: new Map(), byBarcode: new Map() };
  }, [activeOrderScanSession?.id]);

  const osItemsQuery = useQuery<OsScanItem[]>({
    queryKey: ["/api/order-scan/sessions", activeOrderScanSession?.id, "items"],
    queryFn: () =>
      apiRequest("GET", `/api/order-scan/sessions/${activeOrderScanSession!.id}/items`).then((r) => r.json()),
    enabled: !!activeOrderScanSession,
    // When WS is live it pushes every update — poll every 30s as a safety net only.
    // When WS is disconnected (proxy drop, production firewall) poll every 8s so
    // other devices don't fall behind waiting for the reconnect.
    refetchInterval: wsConnected ? 30000 : 8000,
    refetchIntervalInBackground: false,
  });
  const osItemsRef = useRef<OsScanItem[]>([]);
  useEffect(() => { osItemsRef.current = osItemsQuery.data ?? []; }, [osItemsQuery.data]);

  // FIFO batch credits: how much of THIS part's expected qty is already covered by an
  // earlier part's over-scan (e.g. a box arrived early and got scanned against Part 1
  // even though Part 1 didn't need it — that extra offsets Part 2's shortfall here).
  // Empty/no-op for a session that isn't part of a FIFO batch upload.
  const osGroupCreditsQuery = useQuery<{ credits: { barcode: string | null; itemName: string | null; creditedQty: number; sources: { fromCsvFileName: string; qty: number }[] }[]; partIndex: number | null; totalParts: number }>({
    queryKey: ["/api/order-scan/sessions", activeOrderScanSession?.id, "group-credits"],
    queryFn: () =>
      apiRequest("GET", `/api/order-scan/sessions/${activeOrderScanSession!.id}/group-credits`).then((r) => r.json()),
    enabled: !!activeOrderScanSession,
    refetchInterval: wsConnected ? 30000 : 8000,
    refetchIntervalInBackground: false,
  });
  const osCreditByBarcode = new Map(
    (osGroupCreditsQuery.data?.credits ?? []).map((c) => [normalize(c.barcode), c]),
  );

  // Every part of the current FIFO group is scannable at once now (sequential cross-part
  // search — see the server's /scan handler), so a physical scan can land on a sibling part
  // instead of the one shown as "front" here. The WS effect below joins every id in this
  // list so live updates from any part reach this device, not just the front one.
  const osGroupSessionIdsQuery = useQuery<{ sessionIds: number[] }>({
    queryKey: ["/api/order-scan/sessions", activeOrderScanSession?.id, "group-session-ids"],
    queryFn: () =>
      apiRequest("GET", `/api/order-scan/sessions/${activeOrderScanSession!.id}/group-session-ids`).then((r) => r.json()),
    enabled: !!activeOrderScanSession,
    staleTime: 30000,
  });
  const osGroupSessionIds = osGroupSessionIdsQuery.data?.sessionIds ?? (activeOrderScanSession ? [activeOrderScanSession.id] : []);

  type OsExtraRow = { barcode: string; itemName: string | null; totalQty: number; scanCount: number; lastScannedAt: string | null; scannedByName: string | null };
  const osExtrasQuery = useQuery<OsExtraRow[]>({
    queryKey: ["/api/order-scan/sessions", activeOrderScanSession?.id, "extras"],
    queryFn: () =>
      apiRequest("GET", `/api/order-scan/sessions/${activeOrderScanSession!.id}/extras`).then((r) => r.json()),
    enabled: !!activeOrderScanSession,
    refetchInterval: wsConnected ? 30000 : 8000,
    refetchIntervalInBackground: false,
  });

  // ── Empty Box: running count/list + log + undo ───────────────────────────────
  const osEmptyBoxesQuery = useQuery<{ count: number; totalQty: number; entries: any[] }>({
    queryKey: ["/api/order-scan/sessions", activeOrderScanSession?.id, "empty-boxes"],
    queryFn: () =>
      apiRequest("GET", `/api/order-scan/sessions/${activeOrderScanSession!.id}/empty-boxes`).then((r) => r.json()),
    enabled: !!activeOrderScanSession,
  });
  const emptyBoxKey = ["/api/order-scan/sessions", activeOrderScanSession?.id, "empty-boxes"] as const;

  const osEmptyBoxMutation = useMutation({
    mutationFn: (payload: { quantity: number; note: string | null }) =>
      apiRequest("POST", `/api/order-scan/sessions/${activeOrderScanSession!.id}/empty-box`, payload).then((r) => r.json()),
    onSuccess: (data) => {
      queryClient.invalidateQueries({ queryKey: emptyBoxKey });
      queryClient.invalidateQueries({ queryKey: ["/api/order-import/master-view"] });
      setShowEmptyBox(false);
      setEmptyBoxQty("1");
      setEmptyBoxNote("");
      toast({ title: "Empty box logged", description: `${data?.totalQty ?? 0} empty box(es) recorded for this order.` });
    },
    onError: (err: any) => toast({ title: "Failed to log empty box", description: err?.message, variant: "destructive" }),
  });

  const osEmptyBoxUndoMutation = useMutation({
    mutationFn: (entryId: number) =>
      apiRequest("POST", `/api/order-scan/empty-box/${entryId}/undo`).then((r) => r.json()),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: emptyBoxKey });
      queryClient.invalidateQueries({ queryKey: ["/api/order-import/master-view"] });
      toast({ title: "Empty box removed" });
    },
    onError: (err: any) => toast({ title: "Failed to remove empty box", description: err?.message, variant: "destructive" }),
  });

  const osSuggestions = useMemo(() => {
    const q = osManualCode.trim().toLowerCase();
    if (!q) return [];
    return (osItemsQuery.data ?? [])
      .filter((item) =>
        item.itemName?.toLowerCase().includes(q) ||
        item.barcode?.toLowerCase().includes(q) ||
        item.sapCode?.toLowerCase().includes(q)
      )
      .slice(0, 8);
  }, [osManualCode, osItemsQuery.data]);

  const osStvsQuery = useQuery<string[]>({
    queryKey: ["/api/order-scan/stvs", activeOrderScanSession?.plant],
    queryFn: () =>
      apiRequest("GET", `/api/order-scan/stvs?plant=${encodeURIComponent(activeOrderScanSession!.plant)}`).then((r) => r.json()),
    enabled: !!activeOrderScanSession?.plant,
  });

  // Drop a remembered STV that doesn't belong to this plant's list (e.g. it was picked while
  // scanning a different plant, then restored from localStorage here). Only runs once the
  // list has actually loaded, so a slow fetch never wipes a valid pick.
  useEffect(() => {
    const stvs = osStvsQuery.data;
    if (!stvs || stvs.length === 0) return;
    if (osSelectedStv && !stvs.includes(osSelectedStv)) setOsSelectedStv("");
  }, [osStvsQuery.data, osSelectedStv]);

  const osItemsKey = ["/api/order-scan/sessions", activeOrderScanSession?.id, "items"] as const;

  const osScanMutation = useMutation({
    mutationFn: (payload: { barcode: string; qty: number; isExtra: boolean; stv: string | null }) =>
      apiRequest("POST", `/api/order-scan/sessions/${activeOrderScanSession!.id}/scan`, payload).then((r) => r.json()),

    onMutate: async (payload) => {
      // Cancel any in-flight refetch so it doesn't overwrite our optimistic update
      await queryClient.cancelQueries({ queryKey: osItemsKey });
      const previousItems = queryClient.getQueryData<OsScanItem[]>(osItemsKey);
      const previousPending = osPendingRef.current; // save before clearing
      const scanCtx = osScanCtxRef.current; // set by both auto-confirm and dialog-confirm paths

      // Only optimistically update if the barcode matched a CSV item (not an extra).
      // Prefer scanCtx (populated for BOTH scan paths) over previousPending (dialog only) so
      // auto-confirmed under-capacity scans also get the instant totalScannedQty/lastScannedAt
      // bump — otherwise they wouldn't reorder-to-top until the server round-trip landed.
      const matched = scanCtx?.matchedItem ?? previousPending?.matchedItem;
      // Stamp this scan's sequence so the item floats to the very top of the list — for ANY
      // scan on a real CSV row (partial, completing, or an extra logged onto an already-full
      // row), not just completing ones. A "not in order" extra has no matched row, so nothing
      // to reorder.
      if (matched) {
        const s = osScanSeqRef.current;
        s.seq += 1;
        s.byId.set(matched.id, s.seq);
        if (matched.barcode) s.byBarcode.set(normalize(matched.barcode), s.seq);
      }
      if (matched && !payload.isExtra) {
        // payload.qty is the authoritative box count — pallets/looseQty here are only a
        // display estimate using this client's best-known plant pallet size; the server
        // reconciles with the live-resolved value via onSuccess below.
        const itemsPerPallet = scanCtx?.plantPalletSize ?? previousPending?.plantPalletSize ?? matched.itemsPerPallet ?? 1;
        const addedQty = payload.qty;
        const addedPallets = itemsPerPallet > 0 ? Math.floor(addedQty / itemsPerPallet) : addedQty;
        const addedLoose = itemsPerPallet > 0 ? addedQty % itemsPerPallet : 0;

        queryClient.setQueryData<OsScanItem[]>(osItemsKey, (old = []) =>
          old.map((item) => {
            if (item.id !== matched.id) return item;
            const newTotal = (item.totalScannedQty ?? 0) + addedQty;
            return {
              ...item,
              totalScannedQty: newTotal,
              scannedPallets: (item.scannedPallets ?? 0) + addedPallets,
              scannedLooseQty: (item.scannedLooseQty ?? 0) + addedLoose,
              status: newTotal >= item.expectedQty ? "complete" : newTotal > 0 ? "partial" : "pending",
              lastScannedAt: new Date().toISOString(),
            };
          })
        );

        // Update recent scans feed immediately — don't wait for WS round-trip
        osRecentScanSentRef.current.add(payload.barcode);
        setOsRecentScans((prev) => [
          {
            barcode: payload.barcode,
            name: matched.itemName ?? payload.barcode,
            total: addedQty,
            isExtra: false,
          },
          ...prev.slice(0, 4),
        ]);
      } else if (payload.isExtra) {
        // Extra item — prefer inventory/CSV name over raw barcode
        const extraName =
          previousPending?.matchedItem?.itemName ??
          previousPending?.inventoryProduct?.name ??
          payload.barcode;
        osRecentScanSentRef.current.add(payload.barcode);
        setOsRecentScans((prev) => [
          { barcode: payload.barcode, name: extraName, total: payload.qty, isExtra: true },
          ...prev.slice(0, 4),
        ]);
      }

      // Close dialog immediately — user sees instant response
      setOsPending(null);
      osPendingRef.current = null;
      setOsQty(1);
      setOsManualCode("");

      return { previousItems, previousPending };
    },

    onSuccess: (data: any) => {
      // Reconcile with exact server values (handles rounding, status edge cases)
      if (data?.updatedItem) {
        const u = data.updatedItem;
        queryClient.setQueryData<OsScanItem[]>(osItemsKey, (old = []) =>
          old.map((item) =>
            item.id === u.id
              ? {
                  ...item,
                  totalScannedQty: u.total_scanned_qty,
                  scannedPallets:  u.scanned_pallets,
                  scannedLooseQty: u.scanned_loose_qty,
                  status:          u.status,
                  lastScannedAt:   u.last_scanned_at,
                }
              : item
          )
        );
      }
      // Always refresh extras list — server determines isExtra; HTTP response uses snake_case is_extra
      queryClient.invalidateQueries({ queryKey: ["/api/order-scan/sessions", activeOrderScanSession?.id, "extras"] });
      // Keep Master View / Separate CSVs live for the scanning device too (the WS
      // echo also does this; React Query dedupes the overlapping refetch).
      queryClient.invalidateQueries({ queryKey: ["/api/order-import/master-view"] });
      queryClient.invalidateQueries({ queryKey: ["/api/order-import/sessions", "scan-page"] });
      queryClient.invalidateQueries({ queryKey: ["/api/order-import/items"] });
    },

    onError: (err: any, _payload, context: any) => {
      // Roll back the optimistic update
      if (context?.previousItems) {
        queryClient.setQueryData(osItemsKey, context.previousItems);
      }
      // Re-open dialog so user can retry with the saved pending state
      if (context?.previousPending) {
        setOsPending(context.previousPending);
        osPendingRef.current = context.previousPending;
      }
      toast({ title: "Scan failed", description: err?.message ?? "Unknown error", variant: "destructive" });
    },
  });

  const stopOsCamera = () => {
    if (osScannerRef.current) { osScannerRef.current.stop(); osScannerRef.current = null; }
    setOsCameraReady(false);
  };

  const resetOsConfirmation = () => {
    osScannerRef.current?.resetConfirmation();
  };

  // Client-side preview only — the server independently re-resolves this live from the
  // products table (with the same fallback chain) and is what actually gets stored, so a
  // mismatch here only affects what's shown before confirming, never the recorded data.
  const _computePlantPalletSize = (firstMatch: OsScanItem | null, invProduct: Product | null): number => {
    const plantLower = (activeOrderScanSession?.plant ?? "").toLowerCase();
    let size = firstMatch?.itemsPerPallet ?? 1;
    if (invProduct) {
      let fromInv = 0;
      if (plantLower.includes("valsad") || plantLower.includes("val")) {
        fromInv = Number(invProduct.valPlt) || Number(invProduct.itemsPerPallet) || Number(invProduct.pallets) || 0;
      } else if (plantLower.includes("indore") || plantLower.includes("ind")) {
        fromInv = Number(invProduct.indPlt) || Number(invProduct.itemsPerPallet) || Number(invProduct.pallets) || 0;
      } else {
        fromInv = Number(invProduct.itemsPerPallet) || Number(invProduct.pallets) || 0;
      }
      // Last resort: parse *NNN from the product name (e.g. "16GM*192 ..." → 192), same
      // fallback the old classic-scan flow used, for products with no pallet columns set.
      if (fromInv === 0 && invProduct.name) {
        const m = String(invProduct.name).match(/\*(\d{1,5})/);
        if (m) { const n = parseInt(m[1], 10); if (Number.isFinite(n) && n > 1) fromInv = n; }
      }
      if (fromInv > 0) size = fromInv;
    }
    return Math.max(1, size || 1);
  };

  // Same fallback chain as _computePlantPalletSize, but for Master View items (which have
  // no OsScanItem/session-scoped itemsPerPallet snapshot to fall back on) — and returns 0
  // rather than clamping to 1 when nothing is configured, so the UI can tell "no pallet
  // data" apart from "genuinely 1 per pallet" (matching how OsScanItem.itemsPerPallet==0
  // is already treated elsewhere in this file).
  const _resolveMvPalletSize = (invProduct: Product | null, plant: string): number => {
    if (!invProduct) return 0;
    const plantLower = (plant ?? "").toLowerCase();
    let fromInv = 0;
    if (plantLower.includes("valsad") || plantLower.includes("val")) {
      fromInv = Number(invProduct.valPlt) || Number(invProduct.itemsPerPallet) || Number(invProduct.pallets) || 0;
    } else if (plantLower.includes("indore") || plantLower.includes("ind")) {
      fromInv = Number(invProduct.indPlt) || Number(invProduct.itemsPerPallet) || Number(invProduct.pallets) || 0;
    } else {
      fromInv = Number(invProduct.itemsPerPallet) || Number(invProduct.pallets) || 0;
    }
    if (fromInv === 0 && invProduct.name) {
      const m = String(invProduct.name).match(/\*(\d{1,5})/);
      if (m) { const n = parseInt(m[1], 10); if (Number.isFinite(n) && n > 1) fromInv = n; }
    }
    return fromInv;
  };

  const _defaultScanQty = (match: OsScanItem | null, plantPalletSize: number): number => {
    if (!match) return plantPalletSize;
    const remaining = Math.max(0, (match.expectedQty ?? 0) - (match.totalScannedQty ?? 0));
    // Pre-fill with remaining when it's less than a full pallet (covers both "CSV qty < pallet size"
    // and "last partial pallet" cases). Fall back to full pallet if item is already complete.
    return remaining > 0 && remaining < plantPalletSize ? remaining : plantPalletSize;
  };

  // Shows the 5s Auto Scan feedback popup (image + details) and (re)starts its dismiss timer.
  // Rapid consecutive auto-scans just replace the content and reset the 5s window.
  const showAutoScanFeedback = (
    match: OsScanItem,
    invProduct: Product | null,
    scannedQty: number,
    remaining: number,
  ) => {
    if (osAutoScanFeedbackTimerRef.current) clearTimeout(osAutoScanFeedbackTimerRef.current);
    setOsAutoScanFeedback({
      name: match.itemName ?? invProduct?.name ?? match.barcode ?? "—",
      barcode: match.barcode ?? "",
      sapCode: match.sapCode ?? null,
      scannedQty,
      remaining,
    });
    osAutoScanFeedbackTimerRef.current = setTimeout(() => setOsAutoScanFeedback(null), 5000);
  };

  // Decides whether a resolved single-item match auto-confirms silently or opens the confirm
  // dialog, gated by the plant's Auto Scan setting:
  //   • Auto Scan OFF (default) → EVERY scan opens the confirm dialog (fully manual).
  //   • Auto Scan ON → a matched CSV item with a FULL pallet or more still remaining is
  //     confirmed automatically (exactly ONE pallet per scan) with a 5s image feedback popup
  //     and no dialog. A leftover "loose" amount (less than a full pallet), an extra, an
  //     already-complete item, or an unmatched-but-in-inventory barcode all still open the
  //     dialog — the dialog's own match/extra/already-complete branching stays unchanged.
  const _resolveOsScan = (
    barcode: string,
    match: OsScanItem | null,
    invProduct: Product | null,
    plantPalletSize: number,
  ) => {
    const remaining = match ? Math.max(0, (match.expectedQty ?? 0) - (match.totalScannedQty ?? 0)) : 0;
    // One full pallet (or more) of order qty still remaining → auto-scan exactly one pallet.
    // Never overshoots: remaining >= plantPalletSize means scanned + one pallet <= expected.
    const canAutoScan =
      autoScanEnabled &&
      !!match &&
      (match.expectedQty ?? 0) > 0 &&
      plantPalletSize >= 1 &&
      remaining >= plantPalletSize;

    if (canAutoScan) {
      const qty = plantPalletSize; // exactly one full pallet per scan
      setOsFlash("success");
      setTimeout(() => setOsFlash(null), 350);
      // 5s non-blocking feedback popup (image + details) so the operator can see what was
      // auto-scanned without having to confirm anything.
      showAutoScanFeedback(match!, invProduct, qty, Math.max(0, remaining - qty));
      // Give onMutate the matched item so it can optimistically bump qty + lastScannedAt (and
      // thus reorder this item to the top) instantly, without waiting for the server.
      osScanCtxRef.current = { matchedItem: match, plantPalletSize };
      // Lock stays held (set by the caller before this ran) until the mutation settles — this
      // is the only path that never opens a dialog, so it needs its own release point.
      osScanMutation.mutate(
        { barcode, qty, isExtra: false, stv: osSelectedStv || null },
        { onSettled: () => { osScanLockRef.current = false; } },
      );
      return;
    }

    // Opening the dialog now — osPendingRef takes over as the reentrancy guard from here.
    const defaultQty = _defaultScanQty(match, plantPalletSize);
    osScanLockRef.current = false;
    setOsQty(defaultQty);
    setOsPalletsInput(plantPalletSize > 0 ? (defaultQty / plantPalletSize).toFixed(2) : "");
    setOsPallets(1);
    setOsLooseQty(0);
    setOsPending({ barcode, matchedItem: match, inventoryProduct: invProduct, plantPalletSize });
  };

  const handleOsBarcode = (barcode: string) => {
    if (osPendingRef.current || osMultiMatchRef.current || osScanLockRef.current) return;
    // STV (when the plant has any configured) is picked once up front via the persistent
    // selector above the scanner, not per scan — see osSelectedStv's own comment. Scanning
    // is a no-op until it's chosen, so every auto-confirmed AND dialog-confirmed scan always
    // has one, and the dialog no longer needs its own STV picker/validation.
    const stvs = osStvsQuery.data ?? [];
    if (stvs.length > 0 && !osSelectedStv) {
      toast({ title: "Select an STV before scanning", description: "Pick one from the STV selector above, then continue scanning.", variant: "destructive" });
      return;
    }
    // Held synchronously from here until either a dialog opens (osPendingRef/osMultiMatchRef
    // take over) or an early return below — closes the gap where a second rapid scan (gun
    // double-trigger, auto-repeating manual Enter) could read the same not-yet-updated
    // osItemsRef snapshot as this one and double-process the same physical scan.
    osScanLockRef.current = true;
    playScanBeep();
    const normBarcode = normalize(barcode);
    const matches = osItemsRef.current.filter((i) => normalize(i.barcode ?? "") === normBarcode);
    const invProduct = productLookup.get(normalize(barcode)) ?? null;

    // Not on this part's CSV AND not a known product in Inventory at all — this isn't a
    // legitimate "extra" (early arrival of a real item), it's a barcode the system has no
    // record of. Block it outright instead of letting it get logged as an extra.
    if (matches.length === 0 && !invProduct) {
      osScanLockRef.current = false;
      toast({ title: "Barcode not in system", description: "This barcode isn't in the order or in Inventory — scanning it is not allowed.", variant: "destructive" });
      return;
    }

    const plantPalletSize = _computePlantPalletSize(matches[0] ?? null, invProduct);

    if (matches.length > 1) {
      // osMultiMatchRef takes over as the reentrancy guard once the picker is open.
      osScanLockRef.current = false;
      setOsMultiMatch({ barcode, matches, inventoryProduct: invProduct, plantPalletSize });
      return;
    }

    const match = matches[0] ?? null;
    // Auto Scan ON → full-pallet matches auto-confirm (with the 5s image popup); loose/extra
    // amounts open the dialog. Auto Scan OFF → always opens the dialog. All handled inside
    // _resolveOsScan, which also manages the osScanLockRef release for each path.
    _resolveOsScan(barcode, match, invProduct, plantPalletSize);
  };

  // The camera-scanner and barcode-gun listeners below are bound inside effects keyed on the
  // active session, so the handleOsBarcode closure they capture freezes whatever state existed
  // when that effect last ran. React Query's structural sharing keeps activeOrderScanSession's
  // identity stable, so those effects can go a long time without re-running — leaving the
  // captured closure reading an empty osSelectedStv forever and reporting "Select an STV" on
  // every scan even after one was picked (same staleness would hit the Auto Scan flag and the
  // product lookup). Routing those two call sites through this ref always runs the CURRENT
  // handler with current state, without re-binding the listeners on every render.
  const handleOsBarcodeRef = useRef(handleOsBarcode);
  useEffect(() => { handleOsBarcodeRef.current = handleOsBarcode; });

  const handleOsMultiMatchSelect = (item: OsScanItem) => {
    if (!osMultiMatch) return;
    const barcode = osMultiMatch.barcode;
    const invProduct = osMultiMatch.inventoryProduct;
    const plantPalletSize = _computePlantPalletSize(item, invProduct);
    const defaultQty = _defaultScanQty(item, plantPalletSize);
    setOsMultiMatch(null);
    setOsQty(defaultQty);
    setOsPalletsInput(plantPalletSize > 0 ? (defaultQty / plantPalletSize).toFixed(2) : "");
    setOsPallets(1);
    setOsLooseQty(0);
    setOsPending({ barcode, matchedItem: item, inventoryProduct: invProduct, plantPalletSize });
  };

  const handleOsConfirmScan = () => {
    if (!osPending) return;
    // Defense-in-depth: handleOsBarcode already blocks a scan from ever reaching this dialog
    // without an STV selected (when the plant requires one), but osSelectedStv resets on a
    // session change (see its own comment) — if that happens to fire while this dialog is
    // still open, re-check here rather than silently submitting with stv: null.
    const stvs = osStvsQuery.data ?? [];
    if (stvs.length > 0 && !osSelectedStv) {
      toast({ title: "Select an STV before scanning", description: "Pick one from the STV selector above, then continue scanning.", variant: "destructive" });
      setOsPending(null);
      osPendingRef.current = null;
      resetOsConfirmation();
      return;
    }
    const qty = Math.max(1, osQty);
    const itemAlreadyComplete = osPending.matchedItem
      ? (osPending.matchedItem.totalScannedQty ?? 0) >= (osPending.matchedItem.expectedQty ?? 1)
      : false;
    // Mirror the auto-confirm path so onMutate has a uniform source for its optimistic bump.
    osScanCtxRef.current = { matchedItem: osPending.matchedItem, plantPalletSize: osPending.plantPalletSize };
    osScanMutation.mutate({
      barcode: osPending.barcode,
      qty,
      isExtra: !osPending.matchedItem || itemAlreadyComplete,
      stv: osSelectedStv || null,
    });
  };

  useEffect(() => {
    if (!activeOrderScanSession || osScanMode !== "camera") return;
    let cancelled = false;
    let rafId: number;
    // Wait one animation frame so the video element is fully painted and visible
    rafId = requestAnimationFrame(async () => {
      const videoEl = getActiveVideo();
      if (!videoEl || cancelled) return;
      setOsCameraError(null);
      setOsCameraReady(false);
      const scanner = new BarcodeScanner({
        onDetected: (result: Result) => {
          const code = result.getText();
          if (code && !osPendingRef.current && !osMultiMatchRef.current) handleOsBarcodeRef.current(code);
        },
        onError: (err: Error) => {
          if (!cancelled) { setOsCameraError(err.message); setOsScanMode("manual"); }
        },
      });
      osScannerRef.current = scanner;
      try {
        await scanner.initialize();
        if (!cancelled) await scanner.start(videoEl);
        // Belt-and-suspenders: mobile browsers sometimes need an explicit play() after
        // the stream is attached, especially when the video was inside display:none.
        if (!cancelled && videoEl.paused) {
          await videoEl.play().catch(() => {});
        }
        if (!cancelled) setOsCameraReady(true);
      } catch (err: any) {
        if (!cancelled) { setOsCameraError(err?.message ?? "Camera failed"); setOsScanMode("manual"); }
      }
    });
    return () => { cancelled = true; cancelAnimationFrame(rafId); stopOsCamera(); };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeOrderScanSession?.id, osScanMode]);

  // Admin-triggered "complete this part now". A part can also complete on its own when
  // Auto Complete is enabled for the plant — see the WS 'part-completed' handling below,
  // which covers both this manual path and the automatic one with the same banner.
  const [showForceComplete, setShowForceComplete] = useState(false);

  // Shows a prominent "Part Complete" banner for 10s whenever a part finishes — whether via
  // this manual button, Auto Complete firing mid-scan, or the stale-part sweep after a new
  // CSV upload. Driven entirely by the WS 'part-completed' message (see the WS effect below)
  // so all three trigger paths are handled uniformly, without needing separate client logic
  // for "I just clicked Complete" vs "the server completed something on its own."
  const [osPartCompleteBanner, setOsPartCompleteBanner] = useState<{ csvFileName: string; partIndex: number } | null>(null);
  const osPartCompleteBannerTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const osCompleteMutation = useMutation({
    mutationFn: () =>
      apiRequest("POST", `/api/order-scan/sessions/${activeOrderScanSession!.id}/complete`).then((r) => r.json()),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/order-scan/notification"] });
      setShowForceComplete(false);
      toast({ title: "Order completed!", description: "Session closed. Great work!" });
    },
    onError: (err: any) => toast({ title: "Failed to complete order", description: err?.message, variant: "destructive" }),
  });

  // WebSocket subscription — receives push updates from every scan across the current
  // FIFO group, not just the "front" part shown here. A scan can land on a sibling part
  // (see the sequential cross-part search + dual-logging in the server's /scan handler),
  // so this device needs to hear about all of them to stay live.
  const osGroupSessionIdsKey = osGroupSessionIds.join(',');
  useEffect(() => {
    if (!activeOrderScanSession) return;
    const sessionId = activeOrderScanSession.id;
    const groupSessionIds = osGroupSessionIdsKey ? osGroupSessionIdsKey.split(',').map(Number) : [sessionId];

    let ws: WebSocket | null = null;
    let reconnectTimer: ReturnType<typeof setTimeout> | null = null;
    let closed = false;
    // Detect silently-dropped connections: IIS ARR can close the TCP socket
    // without sending a WS CLOSE frame, leaving the client thinking it's connected.
    // The server pings every 20s; if we get no message for 55s the connection is dead.
    let lastMsgAt = Date.now();
    let deadTimer: ReturnType<typeof setInterval> | null = null;

    function startDeadTimer() {
      if (deadTimer) clearInterval(deadTimer);
      deadTimer = setInterval(() => {
        if (ws && Date.now() - lastMsgAt > 55_000) {
          // No server ping received in 55s — connection is silently dead
          ws.close();
        }
      }, 10_000);
    }

    function stopDeadTimer() {
      if (deadTimer) { clearInterval(deadTimer); deadTimer = null; }
    }

    function connect() {
      if (closed) return;
      const proto = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
      ws = new WebSocket(`${proto}//${window.location.host}/ws/order-scan`);

      ws.onopen = () => {
        lastMsgAt = Date.now();
        setWsConnected(true);
        for (const sid of groupSessionIds) ws!.send(JSON.stringify({ type: 'join', sessionId: sid }));
        startDeadTimer();
      };

      ws.onmessage = (e) => {
        lastMsgAt = Date.now(); // reset dead-connection timer on any message
        try {
          const data = JSON.parse(e.data);

          if (data.type === 'joined' || data.type === 'ping') return;

          if (data.type === 'part-completed') {
            if (osPartCompleteBannerTimerRef.current) clearTimeout(osPartCompleteBannerTimerRef.current);
            setOsPartCompleteBanner({ csvFileName: data.csvFileName, partIndex: data.partIndex });
            osPartCompleteBannerTimerRef.current = setTimeout(() => setOsPartCompleteBanner(null), 10000);
            queryClient.invalidateQueries({ queryKey: ["/api/order-scan/active-sessions"] });
            queryClient.invalidateQueries({ queryKey: ["/api/order-import/master-view"] });
            return;
          }
          if (data.type === 'empty-box') {
            // Another device logged/undid an empty box against this session — refresh the
            // running count + list and Master View's reconciliation figure.
            queryClient.invalidateQueries({ queryKey: ["/api/order-scan/sessions", data.sessionId, "empty-boxes"] });
            queryClient.invalidateQueries({ queryKey: ["/api/order-import/master-view"] });
            return;
          }
          if (data.type === 'session-deleted') {
            // Admin deleted the CSV we're actively scanning against (delete-with-rollback).
            // Nothing else auto-activates until a corrected CSV is uploaded for this plant/
            // date, at which point the active-session polls below will pick it up on their
            // own — no explicit navigation needed, this component already renders a "no
            // active session" fallback whenever activeOrderScanSession is null.
            toast({
              title: "Session removed",
              description: "This CSV was deleted by an admin. If a corrected CSV is uploaded for the same plant/date, it will appear here automatically.",
              variant: "destructive",
            });
            setOsSelectedSessionId(null);
            queryClient.invalidateQueries({ queryKey: ["/api/order-scan/notification"] });
            queryClient.invalidateQueries({ queryKey: ["/api/order-scan/active-sessions"] });
            queryClient.invalidateQueries({ queryKey: ["/api/order-import/master-view"] });
            return;
          }
          if (data.type !== 'scan') return;

          // The event's own sessionId (stamped server-side) tells us which part it actually
          // belongs to — it may not be the "front" part this device has open, since a scan
          // can land on a sibling part (dual-logging rule in the server's /scan handler).
          const eventSessionId: number = data.sessionId ?? sessionId;

          // Patch cache directly — no HTTP refetch needed.
          // The WS message already carries the committed DB values for this item.
          if (data.item) {
            queryClient.setQueryData<OsScanItem[]>(
              ["/api/order-scan/sessions", eventSessionId, "items"],
              (old = []) => old.map((i) => i.id === data.item.id ? { ...i, ...data.item } : i),
            );
          }

          // Master View / Separate CSVs read scan progress keyed by order_import_item_id,
          // which the WS payload doesn't carry (and barcodes repeat across CSVs, so we
          // can't patch by barcode). Invalidate so whichever of those tabs is open
          // refetches live. Disabled (closed-tab) queries are only marked stale — no
          // network call — so this is cheap when the user is on the Scan tab.
          queryClient.invalidateQueries({ queryKey: ["/api/order-import/master-view"] });
          queryClient.invalidateQueries({ queryKey: ["/api/order-import/sessions", "scan-page"] });
          queryClient.invalidateQueries({ queryKey: ["/api/order-import/items"] });

          // Append to recent scans list — skip if we already added it optimistically
          if (data.event) {
            const wasOptimistic = osRecentScanSentRef.current.delete(data.event.barcode);
            if (!wasOptimistic) {
              setOsRecentScans((prev) => [
                {
                  barcode: data.event.barcode,
                  name:    data.event.itemName ?? data.event.barcode,
                  total:   data.event.totalQty,
                  isExtra: data.event.isExtra,
                },
                ...prev.slice(0, 4),
              ]);
            }
            // Refresh extras for scans from other devices (this device refreshes via onSuccess)
            if (data.event.isExtra && !wasOptimistic) {
              queryClient.invalidateQueries({ queryKey: ["/api/order-scan/sessions", eventSessionId, "extras"] });
            }
          }
        } catch { /* ignore malformed frames */ }
      };

      ws.onerror = () => { /* onclose fires next — handled there */ };

      ws.onclose = () => {
        stopDeadTimer();
        ws = null;
        setWsConnected(false);
        if (!closed) reconnectTimer = setTimeout(connect, 3000);
      };
    }

    connect();

    return () => {
      closed = true;
      stopDeadTimer();
      setWsConnected(false);
      if (reconnectTimer) clearTimeout(reconnectTimer);
      ws?.close();
    };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeOrderScanSession?.id, osGroupSessionIdsKey]);

  // ── Master View / Separate CSVs queries ─────────────────────────────────

  const mvQuery = useQuery<MvResponse>({
    queryKey: ["/api/order-import/master-view", mvDate, mvPlant],
    queryFn: () => {
      const p = new URLSearchParams({ date: mvDate });
      if (mvPlant) p.set("plant", mvPlant);
      return apiRequest("GET", `/api/order-import/master-view?${p}`).then((r) => r.json());
    },
    enabled: osTab === "master-view" && !!mvDate,
    staleTime: 0,
    refetchOnMount: true,
    // WS scan events invalidate this query for live updates. Poll as a safety net:
    // 30s when WS is healthy, 8s when it's down so the open tab still keeps pace.
    refetchInterval: wsConnected ? 30000 : 8000,
    refetchIntervalInBackground: false,
  });

  const csvSessQuery = useQuery<{ sessions: ImpSession[]; total: number }>({
    queryKey: ["/api/order-import/sessions", "scan-page", mvDate, mvPlant],
    queryFn: () => {
      const p = new URLSearchParams({ page: "1", pageSize: "100" });
      if (mvDate)  p.set("date",  mvDate);
      if (mvPlant) p.set("plant", mvPlant);
      return apiRequest("GET", `/api/order-import/sessions?${p}`).then((r) => r.json());
    },
    enabled: osTab === "separate-csvs" && !!mvDate,
    staleTime: 0,
    refetchOnMount: true,
    refetchInterval: wsConnected ? 30000 : 8000,
    refetchIntervalInBackground: false,
  });

  // Separate allocation query — always uses mvDate/mvPlant so it matches the sessions list
const csvItemsQuery2 = useQuery<ImpItem[]>({
    queryKey: ["/api/order-import/items", csvExpId, "scan-page"],
    queryFn: () => apiRequest("GET", `/api/order-import/sessions/${csvExpId}/items`).then((r) => r.json()),
    enabled: csvExpId !== null && osTab === "separate-csvs",
    staleTime: 0,
    refetchInterval: wsConnected ? 30000 : 8000,
    refetchIntervalInBackground: false,
  });

  // ── Product lookup ────────────────────────────────────────────────────────

  const productLookup = useMemo(() => {
    const map = new Map<string, Product>();
    products.forEach((p) => {
      [p.barcode, p.itemNo, p.sapCode, p.srNo, p.name].forEach((key) => {
        const n = normalize(key);
        if (n) map.set(n, p);
      });
    });
    return map;
  }, [products]);

  // ── Barcode gun (HID keyboard-wedge) support ─────────────────────────────
  useEffect(() => {
    if (!activeOrderScanSession) return;

    const MAX_KEY_INTERVAL = 50;  // ms between chars -- faster than any human types
    const MIN_BARCODE_LENGTH = 3;
    const BURST_END_DELAY = 80;   // ms of silence = end of scan, for guns with no suffix key

    let buffer = "";
    let lastKeyAt = 0;
    let flushTimer: ReturnType<typeof setTimeout> | null = null;
    let qtySnapshot: string | null = null; // qty field's value right before a suspected burst
    let qtyKind: "os" | null = null;

    const clearFlush = () => { if (flushTimer) { clearTimeout(flushTimer); flushTimer = null; } };
    const resetQtyTracking = () => { qtySnapshot = null; qtyKind = null; };

    const revertQtyField = () => {
      if (qtySnapshot === null) return;
      if (qtyKind === "os") {
        const q = parseInt(qtySnapshot, 10) || 0;
        const plt = osPendingRef.current?.plantPalletSize ?? osPendingRef.current?.matchedItem?.itemsPerPallet ?? 1;
        setOsQty(q);
        setOsPalletsInput(plt > 0 ? (q / plt).toFixed(2) : "");
      }
    };

    const process = (code: string) => {
      if (code.length < MIN_BARCODE_LENGTH) return;
      if (activeOrderScanSession) handleOsBarcodeRef.current(code);
    };

    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.ctrlKey || e.metaKey || e.altKey) return;
      const target = e.target as HTMLInputElement | null;
      const gunQtyKind = target?.dataset?.gunQty as "os" | undefined;
      const isQtyField = gunQtyKind === "os";
      const isTypingTarget = !!target && (target.tagName === "INPUT" || target.tagName === "TEXTAREA" || target.isContentEditable);
      if (isTypingTarget && !isQtyField) return; // manual code inputs already handle their own Enter

      const now = Date.now();
      const delta = now - lastKeyAt;
      lastKeyAt = now;

      if (e.key === "Enter" || e.key === "Tab") {
        clearFlush();
        const code = buffer;
        buffer = "";
        if (code.length >= MIN_BARCODE_LENGTH) {
          e.preventDefault();
          if (isQtyField) {
            e.stopPropagation();
            revertQtyField();
            resetQtyTracking();
            toast({ title: "Scan blocked", description: "Finish or cancel the current item before scanning the next one.", variant: "destructive" });
          } else {
            process(code);
          }
        } else if (isQtyField) {
          resetQtyTracking();
        }
        return;
      }

      if (e.key.length !== 1) return; // ignore Shift/Escape/ArrowUp/etc.

      if (isQtyField) {
        if (delta > MAX_KEY_INTERVAL || buffer.length === 0) {
          // First character of a fresh burst -- or just an isolated human keystroke.
          // Remember the pre-keystroke value so we can undo it if the next char proves
          // this is a gun burst rather than manual typing.
          buffer = "";
          qtySnapshot = target!.value;
          qtyKind = gunQtyKind!;
        } else {
          // A second fast character confirms this is a gun scan, not manual typing --
          // undo the character that already leaked into the field and block the rest.
          e.preventDefault();
          e.stopPropagation();
          revertQtyField();
        }
        buffer += e.key;
        clearFlush();
        flushTimer = setTimeout(() => {
          if (buffer.length >= MIN_BARCODE_LENGTH) {
            revertQtyField();
            toast({ title: "Scan blocked", description: "Finish or cancel the current item before scanning the next one.", variant: "destructive" });
          }
          resetQtyTracking();
          buffer = "";
        }, BURST_END_DELAY);
        return;
      }

      if (delta > MAX_KEY_INTERVAL) buffer = ""; // gap too long -- not a scanner burst
      buffer += e.key;

      clearFlush();
      flushTimer = setTimeout(() => { process(buffer); buffer = ""; }, BURST_END_DELAY);
    };

    window.addEventListener("keydown", handleKeyDown, true);
    return () => { window.removeEventListener("keydown", handleKeyDown, true); clearFlush(); };
  }, [activeOrderScanSession]);

  // ─── Views ────────────────────────────────────────────────────────────────

  // Don't show the plain dashboard for a split second before we actually know whether
  // an order-scan session is active — without this, a refresh always flashes the
  // dashboard first (since the notification query hasn't resolved yet) and then jumps
  // to the scan view once it loads a moment later.
  if (orderScanNotifLoading) {
    return (
      <div className="flex-1 flex items-center justify-center bg-gray-50">
        <Loader2 className="h-6 w-6 animate-spin text-[#001d6e]" />
      </div>
    );
  }

  // ── Master View derived data ─────────────────────────────────────────────

  const mvData      = mvQuery.data;
  // Master View = one consolidated row per item across every file for the date/plant.
  // Same item (matched by barcode, falling back to item name) has its expected qty and
  // scanned qty summed across all contributing CSVs — this is what makes it a "master"
  // view rather than just the flattened per-file list (that's what Separate CSVs is for).
  const allMvItems: MvMergedItem[] = (() => {
    if (!mvData) return [];
    const groups = new Map<string, MvMergedItem>();
    mvData.files.forEach((f) => {
      f.items.forEach((item) => {
        const key = item.barcode?.trim().toLowerCase()
          || (item.itemName ? `name::${item.itemName.trim().toLowerCase()}` : `id::${item.id}`);
        let g = groups.get(key);
        if (!g) {
          const invProduct = productLookup.get(normalize(item.barcode ?? item.itemName ?? "")) ?? null;
          g = {
            barcode: item.barcode, itemName: item.itemName, sapCode: item.sapCode,
            quantity: 0, scannedQty: 0, extraQty: 0, expectedPallets: null,
            itemsPerPallet: _resolveMvPalletSize(invProduct, mvPlant),
            _files: [], _isExtra: true,
          };
          groups.set(key, g);
        }
        g.quantity += item.quantity ?? 0;
        g.scannedQty += item.scannedQty ?? 0;
        // Extra scans come through as their own rows (quantity: 0, isExtra: true) — tracked
        // separately from the regular scannedQty sum so Done/Extra can be shown as distinct
        // columns instead of one blended total.
        if (item.isExtra) g.extraQty += item.scannedQty ?? 0;
        if (item.expectedPallets != null) g.expectedPallets = (g.expectedPallets ?? 0) + item.expectedPallets;
        if (!g.itemName && item.itemName) g.itemName = item.itemName;
        if (!g.sapCode && item.sapCode) g.sapCode = item.sapCode;
        if (!g._files.includes(f.csvFileName)) g._files.push(f.csvFileName);
        // A barcode scanned as "extra" during one session but genuinely expected via
        // another file's CSV that same day is not really extra once merged — only
        // flag it Extra if every contributing row was an extra (no real CSV row anywhere).
        if (!item.isExtra) g._isExtra = false;
      });
    });
    const merged = Array.from(groups.values());
    // Append ONE distinct "Empty Box" entry summing every file's empty boxes for this view —
    // a separate labeled row, never mixed into order quantity/scanned/extra.
    const ebQty = mvData.files.reduce((s, f) => s + (f.emptyBoxTotalQty ?? 0), 0);
    const ebCount = mvData.files.reduce((s, f) => s + (f.emptyBoxCount ?? 0), 0);
    if (ebQty > 0) {
      merged.push({
        barcode: null, itemName: "Empty Box", sapCode: null,
        quantity: 0, scannedQty: 0, extraQty: 0, expectedPallets: null,
        itemsPerPallet: 0, _files: [], _isExtra: false,
        _isEmptyBox: true, _emptyBoxCount: ebCount, _emptyBoxQty: ebQty,
      });
    }
    return merged;
  })();
  const filtMvItems = mvSearch
    ? allMvItems.filter((i) =>
        [i.barcode, i.itemName, i.sapCode, ...i._files].some((v) => v?.toLowerCase().includes(mvSearch.toLowerCase()))
      )
    : allMvItems.slice().sort((a, b) => {
        // Whatever was scanned most recently THIS page-load floats to the very top, mirroring the
        // Scan tab's behavior so the operator can see what they just scanned without hunting for
        // it. Everything not scanned this session has seq 0 and keeps its original merge order
        // (Array.prototype.sort is stable, so equal keys don't get shuffled).
        const seq = osScanSeqRef.current.byBarcode;
        const aSeq = seq.get(normalize(a.barcode)) ?? 0;
        const bSeq = seq.get(normalize(b.barcode)) ?? 0;
        return bSeq - aSeq;
      });

  // The existing Eye toggle drives the Files column's visibility.
  const mvVisibleColumnIds = new Set(
    [
      "state", "itemName", "barcode",
      "expQty", "remainQty", "doneQty", "extraQty",
      "expPlt", "remainPlt", "donePlt", "extraPlt",
      "status",
      ...(mvShowFiles ? ["files"] : []),
    ],
  );

  // Master View row state — drives both the status column and the row tint.
  const mvRowState = (item: MvMergedItem) => {
    const exp = item.quantity ?? 0;
    const extra = item.extraQty ?? 0;
    // scannedQty includes over-scans, so subtract them to get real progress against the CSV —
    // otherwise a row's Done would double-count what the Extra column already reports.
    const done = Math.max(0, (item.scannedQty ?? 0) - extra);
    const isExtraOnly = item._isExtra;
    const isDone = done >= exp && exp > 0;
    return {
      exp,
      done,
      extra,
      ipp: item.itemsPerPallet ?? 0,
      remain: Math.max(0, exp - done),
      isExtraOnly,
      isDone,
      isPartial: done > 0 && !isDone && !isExtraOnly,
    };
  };

  // Same totals-box filter the Scan tab uses, so clicking Done/Remaining/Extra narrows Master View
  // to those rows too. Declared after mvRowState because it calls it.
  const mvVisible = !osStatFilter
    ? filtMvItems
    : filtMvItems.filter((i) => {
        const { done, remain, extra } = mvRowState(i);
        if (osStatFilter === "done") return done > 0 && remain === 0;
        if (osStatFilter === "remaining") return remain > 0;
        return extra > 0;
      });

  const mvColumns: DataTableColumn<MvMergedItem>[] = [
    {
      id: "state",
      header: "",
      width: 40,
      align: "center",
      hideable: false,
      render: (item) => {
        if (item._isEmptyBox) return <Package className="mx-auto h-4 w-4 text-orange-500" />;
        const { isExtraOnly, isDone, isPartial } = mvRowState(item);
        return isExtraOnly ? <AlertTriangle className="mx-auto h-4 w-4 text-orange-500" />
          : isDone ? <CheckCircle2 className="mx-auto h-4 w-4 text-emerald-500" />
          : isPartial ? <ScanLine className="mx-auto h-4 w-4 text-amber-500" />
          : <span className="inline-block h-4 w-4 rounded-full border-2 border-gray-300" />;
      },
    },
    {
      id: "itemName",
      header: "Item Name",
      width: 220,
      sortable: true,
      accessor: (i) => i.itemName,
      cellClassName: "font-medium text-gray-900 whitespace-normal break-words",
      render: (i) =>
        i._isEmptyBox ? (
          <span className="inline-flex items-center rounded-full bg-orange-100 px-2 py-0.5 text-[11px] font-semibold text-orange-800">
            Empty Box · {i._emptyBoxQty} box{i._emptyBoxQty === 1 ? "" : "es"}
            {i._emptyBoxCount ? ` (${i._emptyBoxCount})` : ""}
          </span>
        ) : (
          i.itemName ?? "—"
        ),
    },
    {
      id: "barcode",
      header: "Barcode",
      width: 130,
      sortable: true,
      accessor: (i) => i.barcode,
      cellClassName: "font-mono text-gray-500",
      render: (i) => i.barcode ?? "—",
    },
    {
      id: "files",
      header: "Files",
      width: 130,
      isHiddenByDefault: true,
      cellClassName: "text-gray-400 truncate",
      render: (i) => (
        <span title={i._files.map(stripCsvExt).join(", ")}>
          {i._files.length > 1 ? `${i._files.length} files` : stripCsvExt(i._files[0])}
        </span>
      ),
    },
    // Mirrors the Scan tab's CSV Items table: all Qty columns (Exp → Remain → Done → Extra),
    // then the matching Plt columns in the same order.
    {
      id: "expQty",
      header: "Exp Qty",
      width: 80,
      align: "right",
      sortable: true,
      accessor: (i) => i.quantity ?? 0,
      cellClassName: "text-gray-600 font-medium tabular-nums",
      render: (i) => mvRowState(i).exp || "—",
    },
    {
      id: "remainQty",
      header: "Remain Qty",
      width: 100,
      align: "right",
      sortable: true,
      accessor: (i) => mvRowState(i).remain,
      cellClassName: "tabular-nums font-bold",
      render: (i) => {
        const { remain } = mvRowState(i);
        return remain > 0 ? <span className="text-[#001d6e]">{remain}</span> : <span className="text-gray-300">0</span>;
      },
    },
    {
      id: "doneQty",
      header: "Done Qty",
      width: 90,
      align: "right",
      sortable: true,
      accessor: (i) => mvRowState(i).done,
      cellClassName: "tabular-nums font-bold",
      render: (i) => {
        const { done, isExtraOnly, isDone, isPartial } = mvRowState(i);
        return (
          <span className={isExtraOnly ? "text-orange-700" : isDone ? "text-emerald-700" : isPartial ? "text-amber-700" : "text-gray-400"}>
            {done}
          </span>
        );
      },
    },
    {
      id: "extraQty",
      header: "Extra Qty",
      width: 90,
      align: "right",
      sortable: true,
      accessor: (i) => mvRowState(i).extra,
      cellClassName: "tabular-nums font-semibold",
      render: (i) => {
        const { extra } = mvRowState(i);
        return extra > 0 ? <span className="text-amber-600">+{extra}</span> : <span className="text-gray-300">0</span>;
      },
    },
    {
      id: "expPlt",
      header: "Exp Plt",
      width: 80,
      align: "right",
      cellClassName: "tabular-nums text-gray-500",
      render: (i) => {
        const { exp, ipp } = mvRowState(i);
        return pltCell(exp, ipp, "text-gray-500");
      },
    },
    {
      id: "remainPlt",
      header: "Remain Plt",
      width: 100,
      align: "right",
      cellClassName: "tabular-nums font-semibold",
      render: (i) => {
        const { remain, ipp } = mvRowState(i);
        return pltCell(remain, ipp, "text-purple-600");
      },
    },
    {
      id: "donePlt",
      header: "Done Plt",
      width: 90,
      align: "right",
      cellClassName: "tabular-nums font-semibold",
      render: (i) => {
        const { done, ipp } = mvRowState(i);
        return pltCell(done, ipp, "text-[#001d6e]");
      },
    },
    {
      id: "extraPlt",
      header: "Extra Plt",
      width: 90,
      align: "right",
      cellClassName: "tabular-nums font-semibold",
      render: (i) => {
        const { extra, ipp } = mvRowState(i);
        return pltCell(extra, ipp, "text-amber-600");
      },
    },
    {
      id: "status",
      header: "Status",
      width: 100,
      align: "center",
      render: (i) => {
        const { isExtraOnly, isDone, isPartial } = mvRowState(i);
        return (
          <span className={`inline-flex rounded-full px-2 py-0.5 text-[11px] font-semibold ${
            isExtraOnly ? "bg-orange-100 text-orange-700"
            : isDone ? "bg-emerald-100 text-emerald-700"
            : isPartial ? "bg-amber-100 text-amber-700"
            : "bg-gray-100 text-gray-500"}`}>
            {isExtraOnly ? "Extra" : isDone ? "Done" : isPartial ? "Partial" : "Pending"}
          </span>
        );
      },
    },
  ];
  const csvSessions = csvSessQuery.data?.sessions ?? [];
  const csvImpItems = csvItemsQuery2.data ?? [];
  const filtCsvItems = csvSearch
    ? csvImpItems.filter((i) =>
        [i.barcode, i.itemName, i.sapCode].some((v) => v?.toLowerCase().includes(csvSearch.toLowerCase()))
      )
    : csvImpItems;

  function downloadMvCsv() {
    if (!mvData) return;
    const headers = ["#", "Item Name", "Barcode", "SAP Code", "Expected Qty", "Scanned Qty", "Remaining", "Pallets", "Status", "Source Files"];
    const rows = allMvItems.map((item, idx) => {
      const remain = Math.max(0, (item.quantity ?? 0) - (item.scannedQty ?? 0));
      const status = item._isExtra ? "Extra" : item.scannedQty >= item.quantity && item.quantity > 0 ? "Done" : item.scannedQty > 0 ? "Partial" : "Pending";
      return [
        idx + 1, item.itemName ?? "", item.barcode ?? "", item.sapCode ?? "",
        item.quantity ?? 0, item.scannedQty ?? 0, remain, item.expectedPallets ?? "", status, item._files.join(" | "),
      ];
    });
    const csv = [headers, ...rows].map((r) => r.map((v) => `"${String(v).replace(/"/g, '""')}"`).join(",")).join("\n");
    const a = document.createElement("a");
    a.href = URL.createObjectURL(new Blob([csv], { type: "text/csv;charset=utf-8;" }));
    a.download = `master-view-${mvData.date}.csv`;
    a.click();
    URL.revokeObjectURL(a.href);
  }


  // ── Dashboard ─────────────────────────────────────────────────────────────

  // ── Embedded order-scan view (replaces dashboard when admin CSV is active) ─
  if (activeOrderScanSession) {
    const osItems = osItemsQuery.data ?? [];
    const osFiltered = (osSearch
      ? osItems.filter((i) =>
          [i.barcode, i.itemName, i.sapCode].some((v) => v?.toLowerCase().includes(osSearch.toLowerCase()))
        )
      : osItems
    ).slice().sort((a, b) => {
      // PRIMARY: whatever was scanned most recently THIS session floats to the very top —
      // every scan bumps osScanSeqRef in onMutate, so the item just scanned always wins
      // position 1 (a monotonic client counter, immune to the optimistic-vs-server timestamp
      // skew that a lastScannedAt comparison suffers from). Items not scanned this session have
      // seq 0 and fall through to the ordering below.
      const seq = osScanSeqRef.current.byId;
      const aSeq = seq.get(a.id) ?? 0;
      const bSeq = seq.get(b.id) ?? 0;
      if (aSeq !== bSeq) return bSeq - aSeq;
      // SECONDARY: for items only scanned in a PRIOR page-load (all carry the server's own
      // timestamp convention, so they're mutually consistent), most-recent first. Guard against
      // an unparseable value (NaN) so it cleanly falls through to the status/id tiebreakers.
      const parseAt = (v: string | null) => { const t = v ? new Date(v).getTime() : 0; return Number.isNaN(t) ? 0 : t; };
      const aScannedAt = parseAt(a.lastScannedAt);
      const bScannedAt = parseAt(b.lastScannedAt);
      if (aScannedAt !== bScannedAt) return bScannedAt - aScannedAt;
      const rank = (s: string) => s === "complete" ? 0 : s === "partial" ? 1 : 2;
      const diff = rank(a.status) - rank(b.status);
      if (diff !== 0) return diff;
      // Within same status group keep original order (by id)
      return a.id - b.id;
    });
    // An item counts as done when its scanned qty PLUS any cross-part credit reaches
    // expected — so a line fully covered by an earlier part's extra shows as done here too.
    const osIsItemDone = (i: OsScanItem) => {
      const creditQty = osCreditByBarcode.get(normalize(i.barcode))?.creditedQty ?? 0;
      const exp = i.expectedQty ?? 0;
      return exp > 0 && (i.totalScannedQty ?? 0) + creditQty >= exp;
    };
    const osDoneCount = osItems.filter(osIsItemDone).length;
    const osTotalCount = osItems.length;
    const osPct = osTotalCount ? Math.round((osDoneCount / osTotalCount) * 100) : 0;
    // Map of barcode → total extra qty for this session — used both for the per-row Extra
    // column in the CSV Items table and the Extra-pallets total below.
    const extraByBarcode = new Map(
      (osExtrasQuery.data ?? []).map((e) => [normalize(e.barcode), e.totalQty ?? 0]),
    );

    // Per-row derived values shared by the CSV Items columns and the row tint.
    // Credit from an earlier part's extra counts toward this part's Done and reduces
    // Remain; Extra reflects real over-scan on THIS part (extras are separate events,
    // not folded into totalScannedQty, which is capped at expectedQty).
    const osRowState = (item: OsScanItem) => {
      const credit = osCreditByBarcode.get(normalize(item.barcode));
      const exp = item.expectedQty ?? 0;
      const effScanned = (item.totalScannedQty ?? 0) + (credit?.creditedQty ?? 0);
      const done = exp > 0 && effScanned >= exp;
      return {
        credit,
        exp,
        doneQty: Math.min(effScanned, exp),
        rem: Math.max(0, exp - effScanned),
        extra: extraByBarcode.get(normalize(item.barcode ?? "")) ?? 0,
        ipp: item.itemsPerPallet ?? 0,
        done,
        partial: !done && effScanned > 0,
      };
    };

    // Totals-box filter, applied after osRowState exists: Done = fully scanned, Remaining = still
    // owed, Extra = over-scanned. Runs last so it narrows the already-searched, already-sorted list.
    const osVisible = !osStatFilter
      ? osFiltered
      : osFiltered.filter((i) => {
          const { doneQty, rem, extra } = osRowState(i);
          if (osStatFilter === "done") return doneQty > 0 && rem === 0;
          if (osStatFilter === "remaining") return rem > 0;
          return extra > 0;
        });

    const osColumns: DataTableColumn<OsScanItem>[] = [
      {
        id: "state",
        header: "",
        width: 40,
        align: "center",
        hideable: false,
        render: (item) => {
          const { done, partial } = osRowState(item);
          return done ? <CheckCircle2 className="mx-auto h-4 w-4 text-emerald-500" />
            : partial ? <ScanLine className="mx-auto h-4 w-4 text-amber-500" />
            : <span className="inline-block h-4 w-4 rounded-full border-2 border-gray-300" />;
        },
      },
      {
        id: "itemName",
        header: "Item",
        width: 240,
        sortable: true,
        accessor: (i) => i.itemName,
        cellClassName: "font-medium text-gray-900 whitespace-normal break-words",
        render: (item) => {
          const { credit } = osRowState(item);
          return (
            <>
              <span className="block">{item.itemName ?? "—"}</span>
              {credit && (
                <span
                  className="block truncate text-[10px] font-normal text-purple-600"
                  title={credit.sources.map((s) => `${s.qty} from ${s.fromCsvFileName}`).join(", ")}
                >
                  ✓ {credit.creditedQty} counted from earlier part
                </span>
              )}
            </>
          );
        },
      },
      {
        id: "barcode",
        header: "Barcode / SAP",
        width: 140,
        sortable: true,
        accessor: (i) => i.barcode,
        cellClassName: "font-mono text-gray-500",
        render: (item) => (
          <>
            <span className="block">{item.barcode ?? <span className="text-gray-300">—</span>}</span>
            {item.sapCode && <span className="block text-[10px] text-gray-400">SAP: {item.sapCode}</span>}
          </>
        ),
      },
      // All Qty columns first (Exp → Remain → Done → Extra), then the matching Plt columns
      // in the same order, so the two unit groups read as separate blocks.
      {
        id: "expQty",
        header: "Exp Qty",
        width: 80,
        align: "right",
        sortable: true,
        accessor: (i) => i.expectedQty ?? 0,
        cellClassName: "text-gray-600 font-medium tabular-nums",
        render: (i) => i.expectedQty,
      },
      {
        id: "remainQty",
        header: "Remain Qty",
        width: 100,
        align: "right",
        sortable: true,
        accessor: (i) => osRowState(i).rem,
        cellClassName: "tabular-nums font-bold",
        render: (i) => {
          const { rem } = osRowState(i);
          return rem > 0 ? <span className="text-[#001d6e]">{rem}</span> : <span className="text-gray-300">0</span>;
        },
      },
      {
        id: "doneQty",
        header: "Done Qty",
        width: 90,
        align: "right",
        sortable: true,
        accessor: (i) => osRowState(i).doneQty,
        cellClassName: "tabular-nums font-bold",
        render: (item) => {
          const { doneQty, done, partial } = osRowState(item);
          return (
            <span
              className={done ? "text-emerald-700" : partial ? "text-amber-700" : "text-gray-400"}
              title={`${item.scannedPallets ?? 0} plt + ${item.scannedLooseQty ?? 0} loose`}
            >
              {doneQty}
            </span>
          );
        },
      },
      {
        id: "extraQty",
        header: "Extra Qty",
        width: 90,
        align: "right",
        sortable: true,
        accessor: (i) => osRowState(i).extra,
        cellClassName: "tabular-nums font-semibold",
        render: (i) => {
          const { extra } = osRowState(i);
          return extra > 0 ? <span className="text-amber-600">+{extra}</span> : <span className="text-gray-300">0</span>;
        },
      },
      {
        id: "expPlt",
        header: "Exp Plt",
        width: 80,
        align: "right",
        cellClassName: "tabular-nums text-gray-500",
        render: (i) => {
          const { exp, ipp } = osRowState(i);
          return pltCell(exp, ipp, "text-gray-500");
        },
      },
      {
        id: "remainPlt",
        header: "Remain Plt",
        width: 100,
        align: "right",
        cellClassName: "tabular-nums font-semibold",
        render: (i) => {
          const { rem, ipp } = osRowState(i);
          return pltCell(rem, ipp, "text-purple-600");
        },
      },
      {
        id: "donePlt",
        header: "Done Plt",
        width: 90,
        align: "right",
        cellClassName: "tabular-nums font-semibold",
        render: (i) => {
          const { doneQty, ipp } = osRowState(i);
          return pltCell(doneQty, ipp, "text-[#001d6e]");
        },
      },
      {
        id: "extraPlt",
        header: "Extra Plt",
        width: 90,
        align: "right",
        cellClassName: "tabular-nums font-semibold",
        render: (i) => {
          const { extra, ipp } = osRowState(i);
          return pltCell(extra, ipp, "text-amber-600");
        },
      },
      {
        id: "status",
        header: "Status",
        width: 90,
        align: "center",
        render: (i) => {
          const { done, partial } = osRowState(i);
          return (
            <span className={`inline-flex items-center rounded-full px-2 py-0.5 text-[10px] font-semibold ${
              done ? "bg-emerald-100 text-emerald-700"
              : partial ? "bg-amber-100 text-amber-700"
              : "bg-gray-100 text-gray-500"}`}>
              {done ? "Done" : partial ? "Partial" : "Pending"}
            </span>
          );
        },
      },
    ];
    // Resolves items-per-pallet for ANY barcode — first from this session's own CSV items
    // (already live-resolved server-side, see the /items endpoint), falling back to a live
    // inventory lookup for barcodes that aren't on the CSV at all (genuine "not in order" extras).
    const ippForBarcode = (barcode: string): number => {
      const match = osItems.find((i) => normalize(i.barcode ?? "") === normalize(barcode));
      if (match?.itemsPerPallet) return match.itemsPerPallet;
      const invProduct = productLookup.get(normalize(barcode)) ?? null;
      return _computePlantPalletSize(null, invProduct);
    };

    // Quantity totals (not item counts) — shown in a summary card that stays visible across
    // Scan / Master View / Separate CSVs. Part-wise (this part's own numbers only, no
    // cross-part credit blending) everywhere except Master View, which shows the merged
    // totals across every part/file in the group — matching what each tab is already showing.
    // Pallet totals are summed per item using THAT item's own pallet size (never one blended
    // pallet size for everything), then added up — mirroring the Exp/Done/Remain Plt columns
    // already shown per row in the CSV Items table.
    const osTotals = osItems.reduce((acc, i) => {
      const exp = i.expectedQty ?? 0;
      const scanned = i.totalScannedQty ?? 0;
      const ipp = i.itemsPerPallet ?? 0;
      const done = Math.min(scanned, exp);
      const remaining = Math.max(0, exp - scanned);
      acc.expected  += exp;
      acc.done      += done;
      acc.remaining += remaining;
      acc.extra     += Math.max(0, scanned - exp);
      if (ipp > 0) {
        acc.palletsExpected  += exp / ipp;
        acc.palletsDone      += done / ipp;
        acc.palletsRemaining += remaining / ipp;
      }
      return acc;
    }, { expected: 0, done: 0, remaining: 0, extra: 0, palletsExpected: 0, palletsDone: 0, palletsRemaining: 0, palletsExtra: 0 });
    // Unmatched barcodes (not in this part's CSV at all) are tracked separately from osItems.
    (osExtrasQuery.data ?? []).forEach((e) => {
      const qty = e.totalQty ?? 0;
      osTotals.extra += qty;
      const ipp = ippForBarcode(e.barcode);
      if (ipp > 0) osTotals.palletsExtra += qty / ipp;
    });

    // Computed the same way every Master View row already displays its own pallet figures
    // (quantity / itemsPerPallet — see the "Exp Plt"/"Done Plt"/etc. table cells and the
    // mobile list below) rather than the CSV's raw "Expected Pallets" column, which has no
    // guaranteed relationship to itemsPerPallet and previously made this total disagree
    // with what every row underneath it actually shows.
    const mvTotals = allMvItems.reduce((acc, item) => {
      const exp = item.quantity ?? 0;
      const done = item.scannedQty ?? 0;
      const ipp = item.itemsPerPallet ?? 0;
      if (item._isExtra) {
        acc.extra += done;
        if (ipp > 0) acc.palletsExtra += done / ipp;
      } else {
        const doneCapped = Math.min(done, exp);
        const remaining = Math.max(0, exp - done);
        const overage = Math.max(0, done - exp);
        acc.expected  += exp;
        acc.done      += doneCapped;
        acc.remaining += remaining;
        acc.extra     += overage;
        if (ipp > 0) {
          acc.palletsExpected  += exp / ipp;
          acc.palletsDone      += doneCapped / ipp;
          acc.palletsRemaining += remaining / ipp;
          if (overage > 0) acc.palletsExtra += overage / ipp;
        }
      }
      return acc;
    }, { expected: 0, done: 0, remaining: 0, extra: 0, palletsExpected: 0, palletsDone: 0, palletsRemaining: 0, palletsExtra: 0 });

    const displayTotals = osTab === "master-view" ? mvTotals : osTotals;
    const stvs = osStvsQuery.data ?? [];
    // Use plant-specific pallet size from inventory (valPlt/indPlt) as the multiplier
    const plt = osPending?.plantPalletSize ?? osPending?.matchedItem?.itemsPerPallet ?? 1;
    const NO_STV = "__none__";
    // True when the CSV item exists but is already fully scanned — extra boxes coming in
    const osItemIsComplete = osPending?.matchedItem
      ? (osPending.matchedItem.totalScannedQty ?? 0) >= (osPending.matchedItem.expectedQty ?? 1)
      : false;
    const osResolvedImageName = osPending?.matchedItem?.itemName ?? osPending?.inventoryProduct?.name;

    // Extra Items panel — reused as-is in both the mobile and desktop layouts below. Manage
    // Scans (void) used to live here too; it's been moved to the Scan History page instead,
    // so this is just the Extra list now.
    const sideInfoPanel = (
      <div className="bg-white rounded-xl border shadow-sm overflow-hidden">
        <div className="flex items-center justify-between border-b bg-gray-50 px-4 py-2">
          <p className="text-xs font-semibold text-gray-600">Extra{(osExtrasQuery.data ?? []).length > 0 ? ` (${(osExtrasQuery.data ?? []).length})` : ""}</p>
          {osRotated && <ScrollNudgeButtons targetRef={osManageExtraScrollRef} className="text-gray-500" />}
        </div>
        <div ref={osManageExtraScrollRef} className={`max-h-[420px] divide-y divide-gray-100 ${osRotated ? "overflow-hidden" : "overflow-y-auto"}`}>
          {(osExtrasQuery.data ?? []).length > 0 ? (osExtrasQuery.data ?? []).map((e, i) => {
            const eIpp = ippForBarcode(e.barcode);
            return (
              <div key={i} className={`flex items-center gap-3 px-4 py-2.5 text-xs ${i % 2 === 0 ? "bg-white" : "bg-slate-50"}`}>
                <AlertTriangle className="h-4 w-4 text-amber-500 shrink-0" />
                <div className="min-w-0 flex-1">
                  <p className="font-medium text-gray-900 truncate">{e.itemName ?? e.barcode}</p>
                  <p className="text-[11px] text-gray-400 font-mono">{e.barcode}</p>
                </div>
                <div className="text-right shrink-0">
                  <p className="font-bold text-amber-600">{e.totalQty} units</p>
                  {eIpp > 0 && <p className="text-[11px] text-purple-500">{(e.totalQty / eIpp).toFixed(2)} plt</p>}
                </div>
              </div>
            );
          }) : <p className="py-8 text-center text-xs text-gray-400">No extra scans.</p>}
        </div>
      </div>
    );

    return (
      <div className={`flex-1 overflow-x-hidden bg-gray-50 sm:overflow-y-auto sm:p-4 lg:p-6 ${osRotated ? "kiosk-rotate-90" : ""}`}>
        <RotateToggleButton />
        {osRotated && (
          <div className="fixed bottom-24 right-4 z-[60] rounded-3xl bg-[#001d6e] px-2.5 py-3 text-white shadow-xl ring-1 ring-white/10">
            <ScrollNudgeButtons targetRef={osTabBodyScrollRef} amount={360} large />
          </div>
        )}

        {/* ── "Part Complete" banner — fires for every way a part can finish (manual Complete
            button, Auto Complete mid-scan, or the stale-part sweep after a new upload), driven
            by the WS 'part-completed' message. Fixed/centered so it's visible regardless of
            which tab or viewport is showing; auto-dismisses after 10s, or on click. ── */}
        {osPartCompleteBanner && (
          <div
            className="fixed inset-x-0 top-3 z-[100] flex justify-center px-3 pointer-events-none"
            role="status"
          >
            <button
              type="button"
              onClick={() => setOsPartCompleteBanner(null)}
              className="pointer-events-auto flex items-center gap-2.5 rounded-full bg-emerald-600 pl-3 pr-4 py-2.5 text-white shadow-lg ring-1 ring-emerald-700/30 animate-in fade-in slide-in-from-top-2"
            >
              <CheckCircle2 className="h-5 w-5 shrink-0" />
              <span className="text-sm font-semibold">
                Part {osPartCompleteBanner.partIndex} Complete
                <span className="ml-1.5 font-normal opacity-90">— {stripCsvExt(osPartCompleteBanner.csvFileName)}</span>
              </span>
            </button>
          </div>
        )}

        {/* ── Auto Scan feedback popup — shows for 5s after an auto-confirmed (full-pallet)
            scan: product image + name/barcode/SAP + how much was scanned and what remains.
            Non-blocking (pointer-events-none) — the operator keeps scanning; no confirm
            needed. Rapid scans replace it and reset the 5s timer (see showAutoScanFeedback). ── */}
        {osAutoScanFeedback && (
          <div className="fixed inset-x-0 top-16 z-[90] flex justify-center px-4 pointer-events-none" role="status">
            {/* Width matches the confirm dialog exactly (w-[calc(100%-2rem)] max-w-md
                sm:max-w-xl). The dialog's height is content-driven (notices + button row), so
                min-h here approximates it — without it this card would sit noticeably shorter,
                since it has no footer buttons. */}
            <div className="w-[calc(100%-2rem)] max-w-md sm:max-w-xl min-h-[15rem] flex flex-col rounded-lg bg-white p-6 shadow-xl ring-1 ring-gray-200 animate-in fade-in slide-in-from-top-2">
              <div className="flex items-center gap-2 text-emerald-700">
                <Zap className="h-5 w-5 shrink-0" />
                <span className="text-lg font-semibold">Auto scanned</span>
              </div>
              <div className="flex flex-1 gap-3 items-start pt-2">
                <img
                  src={`/api/products/image-by-name?name=${encodeURIComponent(osAutoScanFeedback.name)}`}
                  alt=""
                  className="h-40 w-40 shrink-0 object-contain rounded-md bg-gray-50 border border-gray-100"
                  onError={(e) => { (e.currentTarget as HTMLImageElement).style.display = 'none'; }}
                />
                <div className="flex-1 min-w-0 text-sm">
                  <p className="font-semibold text-gray-900 break-words">{osAutoScanFeedback.name}</p>
                  <p className="mt-0.5 font-mono text-xs text-gray-400 break-all">
                    {osAutoScanFeedback.barcode}{osAutoScanFeedback.sapCode && ` · SAP: ${osAutoScanFeedback.sapCode}`}
                  </p>
                  <p className="mt-2 text-base">
                    <span className="font-bold text-emerald-600">+{osAutoScanFeedback.scannedQty}</span>
                    <span className="text-gray-500"> scanned</span>
                    {osAutoScanFeedback.remaining > 0 && (
                      <span className="ml-2 font-semibold text-[#001d6e]">{osAutoScanFeedback.remaining} left</span>
                    )}
                  </p>
                </div>
              </div>
            </div>
          </div>
        )}

        {/* ── Plant switcher — only appears when 2+ plants have a simultaneously active
            session (e.g. Valsad + Indore both scanning at once). New/additive: for a
            single active session, or non-admin users, this renders nothing and the page
            behaves exactly as before. ── */}
        {(osActiveSessions?.length ?? 0) > 1 && (
          <div className="flex flex-wrap items-center gap-1.5 bg-white sm:bg-transparent px-3 py-2 sm:px-0 sm:py-0 sm:mb-3 border-b sm:border-0 border-gray-100">
            <span className="text-[10px] sm:text-xs font-semibold uppercase tracking-wide text-gray-400 mr-1">Active:</span>
            {(osActiveSessions ?? []).map((s) => (
              <button
                key={s.id}
                onClick={() => {
                  setOsSelectedSessionId(s.id);
                  setOsSearch("");
                  setMvSearch("");
                }}
                className={`rounded-full px-3 py-1 text-xs font-semibold transition-colors ${
                  activeOrderScanSession?.id === s.id
                    ? "bg-[#001d6e] text-white"
                    : "border border-gray-200 bg-white text-gray-600 hover:bg-gray-50"
                }`}
              >
                {s.plant}
              </button>
            ))}
          </div>
        )}

        {/* ══════════════════════════════════════════════════
            MOBILE LAYOUT  (hidden on sm+, or forced on when rotated)
            - Sticky header strip with session info + progress
            - Sticky scanner (Camera toggle + feed / manual)
            - Natural-scroll items list below
            When rotated for a portrait-mounted screen, the DESKTOP layout's multi-column
            grid ignores our CSS rotate trick (Tailwind's sm:/lg: prefixes key off the
            actual (unrotated) window width, not the rotated container's effective size),
            so it kept rendering cramped. Forcing this single-column mobile layout on
            whenever osRotated is true — regardless of real viewport width — is what
            actually makes the rotated view usable.
        ════════════════════════════════════════════════════ */}
        <div className={`flex-col h-full overflow-y-auto ${osRotated ? "flex" : "flex sm:hidden"}`}>

          {/* ── Sticky header + scanner ── */}
          <div className="sticky top-0 z-20 bg-white shadow-sm">

            {/* Session info row — bordered sections instead of a loose flex row, so title /
                complete action / progress read as distinct fields rather than floating text. */}
            <div className={`flex items-stretch divide-x divide-gray-200 border-b border-gray-300 ${osRotated ? "text-sm" : ""}`}>
              <div className={`flex-1 min-w-0 ${osRotated ? "px-4 py-3" : "px-3 py-2"}`}>
                <p
                  className={`font-bold text-gray-900 truncate leading-tight ${osRotated ? "text-base" : "text-xs"}`}
                  title={stripCsvExt(activeOrderScanSession.csvFileName)}
                >
                  {scanFmtUploadDate(activeOrderScanSession.orderDate)}
                  {(osGroupCreditsQuery.data?.totalParts ?? 0) > 1 && (
                    <span className={`ml-1.5 inline-block bg-purple-100 font-semibold text-purple-700 ${osRotated ? "px-2 py-0.5 text-xs" : "px-1.5 py-0.5 text-[10px]"}`}>
                      Part {osGroupCreditsQuery.data?.partIndex} of {osGroupCreditsQuery.data?.totalParts}
                    </span>
                  )}
                </p>
                <p className={`text-gray-500 truncate ${osRotated ? "text-xs mt-0.5" : "text-[10px]"}`}>
                  {activeOrderScanSession.plant}
                  {activeOrderScanSession.importedByName && ` · ${activeOrderScanSession.importedByName}`}
                </p>
              </div>
              {canCompletePart && (
                <div className={`flex items-center justify-center shrink-0 ${osRotated ? "px-4" : "px-2"}`}>
                  <Button size="sm" className={`bg-emerald-600 hover:bg-emerald-700 text-white shrink-0 ${osRotated ? "h-9 px-4 text-sm" : "h-7 px-2.5 text-[11px]"}`} onClick={() => setShowForceComplete(true)}>
                    Complete
                  </Button>
                </div>
              )}
              <div className={`shrink-0 text-right flex flex-col justify-center ${osRotated ? "px-4 py-3" : "px-3 py-2"}`}>
                <p className={`font-bold text-[#001d6e] ${osRotated ? "text-base" : "text-xs"}`}>{osDoneCount}/{osTotalCount}</p>
                <p className={`text-gray-400 ${osRotated ? "text-xs" : "text-[10px]"}`}>{osPct}%</p>
              </div>
            </div>

            {/* Full-width progress bar */}
            <Progress value={osPct} className={`rounded-none ${osRotated ? "h-2" : "h-1.5"}`} />

            {/* Scanner section — hidden on Separate CSVs (no scanning happens there) */}
            {osTab !== "separate-csvs" && (
            <div className="px-4 pt-3 pb-4 space-y-3 bg-gray-50 border-t border-gray-100">

              <p className="flex items-center gap-1.5 text-[11px] text-gray-400"><Plug className="h-3 w-3" />Barcode gun: plug in and scan</p>

              {/* Camera / Manual tabs */}
              <div className="flex border border-gray-300 divide-x divide-gray-300 bg-white">
                <button
                  onClick={() => setOsScanMode("camera")}
                  className={`flex-1 flex items-center justify-center gap-1.5 font-semibold transition-colors ${osRotated ? "py-3 text-sm" : "py-2 text-xs"} ${
                    osScanMode === "camera" ? "bg-[#001d6e] text-white" : "text-gray-500 hover:bg-gray-50"
                  }`}
                >
                  <Camera className={osRotated ? "h-4 w-4" : "h-3.5 w-3.5"} /> Camera
                </button>
                <button
                  onClick={() => { stopOsCamera(); setOsScanMode("manual"); }}
                  className={`flex-1 flex items-center justify-center gap-1.5 font-semibold transition-colors ${osRotated ? "py-3 text-sm" : "py-2 text-xs"} ${
                    osScanMode === "manual" ? "bg-[#001d6e] text-white" : "text-gray-500 hover:bg-gray-50"
                  }`}
                >
                  <Keyboard className={osRotated ? "h-4 w-4" : "h-3.5 w-3.5"} /> Manual
                </button>
              </div>

              {/* Main STV selector — sets the default for the next scan confirmation too.
                  Bolder fill + explicit label so it reads as an active selector, not muted text. */}
              {stvs.length > 0 && (
                <div className="flex items-center gap-2">
                  <span className={`shrink-0 font-semibold uppercase tracking-wide text-gray-400 ${osRotated ? "text-xs" : "text-[10px]"}`}>STV</span>
                  <Select
                    value={osSelectedStv || NO_STV}
                    onValueChange={(v) => {
                      const nextValue = v === NO_STV ? "" : v;
                      setOsSelectedStv(nextValue);
                    }}
                  >
                    <SelectTrigger className={`rounded-none justify-center text-center font-semibold border-2 ${
                      osSelectedStv ? "border-[#001d6e] bg-[#001d6e]/5 text-[#001d6e]" : "border-gray-300 text-gray-500"
                    } ${osRotated ? "h-11 w-56 text-base" : "h-8 w-44 text-sm"}`}>
                      <SelectValue placeholder="Select STV…" />
                    </SelectTrigger>
                    {/* Radix portals this dropdown to document.body, outside the .kiosk-rotate-90
                        subtree, so it doesn't inherit the page rotation on its own — it renders
                        upright while everything else is rotated. Radix positions it via an inline
                        transform:translate(...) on its OWN wrapper (a different element from this
                        one), so adding our rotation directly here composes cleanly with no
                        conflict. origin-top-left matches Radix's actual side="bottom" align="start"
                        anchor for this trigger, keeping the dropdown attached to the same corner. */}
                    <SelectContent className={osRotated ? "origin-top-left rotate-90" : undefined}>
                      <SelectItem value={NO_STV}>— Select STV —</SelectItem>
                      {stvs.map((s) => (
                        <SelectItem key={s} value={s}>{s}</SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </div>
              )}
              {/* No STVs configured for this plant — say so instead of rendering nothing, which
                  looked like a missing/broken control (notably on production, where the plant's
                  STV list hadn't been set up). */}
              {!osStvsQuery.isLoading && stvs.length === 0 && (
                <div className="flex items-center">
                  <span className="rounded border border-dashed border-amber-300 bg-amber-50 px-2 py-1 text-[11px] text-amber-700">
                    No STV — create one in Plant Settings
                  </span>
                </div>
              )}

              {/* Camera feed — always in DOM so ref is set before scanner starts */}
              <div
                className="bg-black relative w-full"
                style={{
                  display: osScanMode === "camera" ? "block" : "none",
                  /* Responsive height: 50% of viewport width, clamped 190–250px */
                  height: "clamp(190px, 50vw, 250px)",
                  borderRadius: "16px",
                }}
              >
                <video
                  ref={osVideoMobileRef}
                  autoPlay
                  muted
                  playsInline
                  // @ts-ignore - webkit attribute for iOS Safari
                  webkit-playsinline="true"
                  style={{
                    position: "absolute",
                    inset: 0,
                    width: "100%",
                    height: "100%",
                    objectFit: "cover",
                    display: "block",
                    /* border-radius ON the video forces Android Chrome to composite it
                       as a texture instead of a hole-punched SurfaceView. This is what
                       fixes the "black camera on mobile" bug — do NOT add transform/
                       translateZ here, which pushes it back onto the broken surface path. */
                    borderRadius: "16px",
                  }}
                />

                {/* Dark vignette edges to draw focus to the scan zone */}
                <div
                  className="pointer-events-none absolute inset-0"
                  style={{
                    background:
                      "radial-gradient(ellipse 70% 55% at 50% 50%, transparent 55%, rgba(0,0,0,0.55) 100%)",
                  }}
                />

                {/* Loading spinner */}
                {osScanMode === "camera" && !osCameraReady && !osCameraError && (
                  <div className="absolute inset-0 flex flex-col items-center justify-center text-white gap-2 z-10">
                    <Loader2 className="h-9 w-9 animate-spin opacity-90" />
                    <p className="text-sm font-medium opacity-80">Starting camera…</p>
                  </div>
                )}

                {/* Corner-bracket scan guide */}
                {osScanMode === "camera" && osCameraReady && (
                  <div className="pointer-events-none absolute inset-0 flex items-center justify-center z-10">
                    {/* scan line pulse */}
                    <div className="absolute w-48 overflow-hidden" style={{ height: "72px" }}>
                      <div
                        className="absolute left-0 right-0 h-0.5 bg-[#3b82f6]/70"
                        style={{
                          animation: "scanLine 1.8s ease-in-out infinite",
                          top: 0,
                        }}
                      />
                    </div>
                    {/* corner brackets */}
                    {(["tl","tr","bl","br"] as const).map((pos) => (
                      <div
                        key={pos}
                        className="absolute"
                        style={{
                          top:    pos.startsWith("t") ? "calc(50% - 36px)" : undefined,
                          bottom: pos.startsWith("b") ? "calc(50% - 36px)" : undefined,
                          left:   pos.endsWith("l")   ? "calc(50% - 96px)" : undefined,
                          right:  pos.endsWith("r")   ? "calc(50% - 96px)" : undefined,
                          width: 20, height: 20,
                          borderColor: "white",
                          borderStyle: "solid",
                          borderTopWidth:    pos.startsWith("t") ? 3 : 0,
                          borderBottomWidth: pos.startsWith("b") ? 3 : 0,
                          borderLeftWidth:   pos.endsWith("l")   ? 3 : 0,
                          borderRightWidth:  pos.endsWith("r")   ? 3 : 0,
                          borderRadius:
                            pos === "tl" ? "4px 0 0 0" :
                            pos === "tr" ? "0 4px 0 0" :
                            pos === "bl" ? "0 0 0 4px" : "0 0 4px 0",
                        }}
                      />
                    ))}
                  </div>
                )}

                {/* Error banner */}
                {osScanMode === "camera" && osCameraError && (
                  <div className="absolute bottom-0 left-0 right-0 flex items-center gap-2 bg-red-900/85 px-3 py-2.5 text-xs text-white z-10">
                    <AlertTriangle className="h-3.5 w-3.5 shrink-0" />
                    {osCameraError}
                  </div>
                )}
              </div>

              {/* Scan line keyframe injected once */}
              <style>{`@keyframes scanLine { 0%,100%{top:0} 50%{top:calc(72px - 2px)} }`}</style>

              {/* Manual barcode input */}
              {osScanMode === "manual" && (
                <div className="relative flex gap-2">
                  <div className="relative flex-1 min-w-0">
                    <Input
                      value={osManualCode}
                      onChange={(e) => { setOsManualCode(e.target.value); setOsSuggIdx(-1); }}
                      onFocus={() => setOsManualFocused(true)}
                      onBlur={() => setTimeout(() => setOsManualFocused(false), 150)}
                      onKeyDown={(e) => {
                        if (osManualFocused && osSuggestions.length > 0) {
                          if (e.key === "ArrowDown") { e.preventDefault(); setOsSuggIdx((i) => Math.min(i + 1, osSuggestions.length - 1)); return; }
                          if (e.key === "ArrowUp") { e.preventDefault(); setOsSuggIdx((i) => Math.max(i - 1, -1)); return; }
                          if (e.key === "Escape") { setOsManualFocused(false); return; }
                          if (e.key === "Enter" && osSuggIdx >= 0) {
                            e.preventDefault();
                            const item = osSuggestions[osSuggIdx];
                            if (item.barcode) { handleOsBarcode(item.barcode); setOsManualCode(""); setOsSuggIdx(-1); }
                            return;
                          }
                        }
                        if (e.key === "Enter" && osManualCode.trim() && osSuggIdx < 0) {
                          handleOsBarcode(osManualCode.trim());
                          setOsManualCode("");
                        }
                      }}
                      placeholder="Type item name or barcode…"
                      disabled={!!osPending}
                      className={`font-mono w-full rounded-none border-gray-300 ${osRotated ? "text-lg h-14" : "text-sm h-10"}`}
                      autoFocus
                    />
                    {osManualFocused && osSuggestions.length > 0 && (
                      <div className="absolute left-0 right-0 top-full z-50 mt-1 rounded-none border border-gray-300 bg-white shadow-lg overflow-hidden">
                        {osSuggestions.map((item, idx) => (
                          <button
                            key={item.id}
                            type="button"
                            onMouseDown={(e) => { e.preventDefault(); if (item.barcode) { handleOsBarcode(item.barcode); setOsManualCode(""); setOsSuggIdx(-1); } }}
                            className={`w-full text-left px-3 py-2.5 flex items-center gap-2 text-sm border-b last:border-0 ${idx === osSuggIdx ? "bg-[#001d6e] text-white" : "hover:bg-gray-50"}`}
                          >
                            <ScanLine className={`h-3.5 w-3.5 shrink-0 mt-0.5 ${idx === osSuggIdx ? "text-white/70" : "text-gray-400"}`} />
                            <div className="flex-1 min-w-0">
                              <p className="font-medium leading-snug">{item.itemName || item.barcode}</p>
                              {item.barcode && item.itemName && (
                                <p className={`font-mono text-xs mt-0.5 ${idx === osSuggIdx ? "text-white/60" : "text-gray-400"}`}>{item.barcode}</p>
                              )}
                            </div>
                          </button>
                        ))}
                      </div>
                    )}
                  </div>
                  <Button
                    disabled={!osManualCode.trim() || !!osPending}
                    onClick={() => {
                      if (osSuggIdx >= 0 && osSuggestions[osSuggIdx]?.barcode) {
                        handleOsBarcode(osSuggestions[osSuggIdx].barcode!);
                      } else if (osManualCode.trim()) {
                        handleOsBarcode(osManualCode.trim());
                      }
                      setOsManualCode(""); setOsSuggIdx(-1);
                    }}
                    className={`bg-[#001d6e] hover:bg-[#00154b] text-white shrink-0 p-0 rounded-none ${osRotated ? "h-14 w-14" : "h-10 w-10"}`}
                  >
                    <ScanLine className={osRotated ? "h-6 w-6" : "h-4 w-4"} />
                  </Button>
                </div>
              )}

              {/* ── Empty Box — log a box with no item/barcode, alongside Gun Mode. Separate
                  from a product scan: no CSV lookup, doesn't count toward order qty. ── */}
              <div className="flex items-center gap-2 mt-2">
                <Button
                  variant="outline"
                  disabled={!activeOrderScanSession || activeOrderScanSession.scanStatus === "completed" || !!osPending}
                  onClick={() => { setEmptyBoxQty("1"); setEmptyBoxNote(""); setShowEmptyBox(true); }}
                  className="flex-1 h-9 text-xs border-amber-300 text-amber-700 hover:bg-amber-50"
                >
                  <Package className="h-4 w-4 mr-1.5" /> Empty Box
                </Button>
                {(osEmptyBoxesQuery.data?.totalQty ?? 0) > 0 && (
                  <span className="text-[11px] font-medium text-amber-700 bg-amber-50 border border-amber-200 rounded-full px-2.5 py-1 shrink-0">
                    {osEmptyBoxesQuery.data!.totalQty} empty
                  </span>
                )}
              </div>
            </div>
            )}
          </div>

          {/* ── Scrollable content below sticky scanner ── */}
          <div ref={osTabBodyScrollRef} className={`flex-1 px-4 py-3 space-y-3 ${osRotated ? "overflow-hidden" : "overflow-y-auto"}`}>

            {/* ── Tab strip — one joined, bordered segmented control (business style) instead of
                separate floating rounded pills. Scanner above stays put across tabs. ── */}
            <div className="flex border border-gray-300 divide-x divide-gray-300 bg-white">
              {(["master-view", "scan", "separate-csvs"] as const).map((t) => (
                <button
                  key={t}
                  onClick={() => setOsTab(t)}
                  className={`flex flex-1 items-center justify-center font-medium transition-colors ${
                    osRotated ? "gap-2 px-4 py-3 text-base" : "gap-1.5 px-3 py-2 text-xs"
                  } ${
                    osTab === t
                      ? "bg-[#001d6e] text-white"
                      : "text-gray-600 hover:bg-gray-50"
                  }`}
                >
                  {t === "scan"
                    ? <ScanLine className={osRotated ? "h-5 w-5" : "h-3.5 w-3.5"} />
                    : t === "master-view" ? <Layers className={osRotated ? "h-5 w-5" : "h-3.5 w-3.5"} />
                    : <FileSpreadsheet className={osRotated ? "h-5 w-5" : "h-3.5 w-3.5"} />}
                  {t === "scan" ? "Scan" : t === "master-view" ? "Master View" : "Part Order"}
                </button>
              ))}
            </div>

            {/* ── Order totals — persistent across Scan / Master View, hidden on Separate CSVs ──
                One unified bordered strip with internal dividers (business/report style),
                instead of four separate floating rounded+shadowed cards. */}
            {osTab !== "separate-csvs" && (
            <div className={`grid grid-cols-4 divide-x divide-gray-200 border border-gray-300 bg-white ${osRotated ? "text-base" : ""}`}>
              <div className={`text-center ${osRotated ? "px-2 py-3" : "px-2 py-2"}`}>
                <p className={`uppercase tracking-wide text-gray-400 ${osRotated ? "text-[11px]" : "text-[10px]"}`}>Total</p>
                <p className={`font-bold text-gray-900 ${osRotated ? "text-xl" : "text-lg"}`}>{displayTotals.expected}</p>
                <p className={`font-medium text-gray-500 ${osRotated ? "text-sm" : "text-xs"}`}>{displayTotals.palletsExpected.toFixed(2)} plt</p>
              </div>
              <div className={`text-center ${osRotated ? "px-2 py-3" : "px-2 py-2"}`}>
                <p className={`uppercase tracking-wide text-gray-400 ${osRotated ? "text-[11px]" : "text-[10px]"}`}>Done</p>
                <p className={`font-bold text-emerald-600 ${osRotated ? "text-xl" : "text-lg"}`}>{displayTotals.done}</p>
                <p className={`font-medium text-gray-500 ${osRotated ? "text-sm" : "text-xs"}`}>{displayTotals.palletsDone.toFixed(2)} plt</p>
              </div>
              <div className={`text-center ${osRotated ? "px-2 py-3" : "px-2 py-2"}`}>
                <p className={`uppercase tracking-wide text-gray-400 ${osRotated ? "text-[11px]" : "text-[10px]"}`}>Remaining</p>
                <p className={`font-bold text-[#001d6e] ${osRotated ? "text-xl" : "text-lg"}`}>{displayTotals.remaining}</p>
                <p className={`font-medium text-gray-500 ${osRotated ? "text-sm" : "text-xs"}`}>{displayTotals.palletsRemaining.toFixed(2)} plt</p>
              </div>
              <div className={`text-center ${osRotated ? "px-2 py-3" : "px-2 py-2"}`}>
                <p className={`uppercase tracking-wide text-gray-400 ${osRotated ? "text-[11px]" : "text-[10px]"}`}>Extra</p>
                <p className={`font-bold ${displayTotals.extra > 0 ? "text-amber-600" : "text-gray-300"} ${osRotated ? "text-xl" : "text-lg"}`}>{displayTotals.extra}</p>
                <p className={`font-medium text-gray-500 ${osRotated ? "text-sm" : "text-xs"}`}>{displayTotals.palletsExtra.toFixed(2)} plt</p>
              </div>
            </div>
            )}

            {osTab === "scan" && (
              <>
            {/* Items list — structured table (business style): square corners, grid borders,
                full item names (no truncation), matching Master View's table. */}
            <div className="bg-white border border-gray-300 overflow-hidden">
              {/* List header */}
              <div className="flex items-center justify-between px-4 py-2.5 border-b border-gray-300 bg-[#001d6e]">
                <p className="text-xs font-semibold text-white">Items</p>
                <div className="flex items-center gap-3">
                  <span className="text-xs text-blue-200">{osDoneCount}/{osTotalCount} done</span>
                  {osRotated && <ScrollNudgeButtons targetRef={osCsvListScrollRef} className="text-white" />}
                  <button
                    onClick={() => setOsSearchOpen((v) => !v)}
                    className="text-white/80 hover:text-white"
                  >
                    {osSearchOpen ? <X className="h-4 w-4" /> : <Search className="h-4 w-4" />}
                  </button>
                </div>
              </div>

              {/* Search — collapsed until the search button above is tapped */}
              {osSearchOpen && (
                <div className="px-3 py-2.5 border-b border-gray-300">
                  <div className="relative">
                    <Search className="absolute left-3 top-2.5 h-3.5 w-3.5 text-gray-400" />
                    <Input
                      value={osSearch}
                      onChange={(e) => setOsSearch(e.target.value)}
                      placeholder="Search items…"
                      className="pl-8 h-9 text-sm rounded-none border-gray-300"
                      autoFocus
                    />
                    {osSearch && (
                      <button className="absolute right-2.5 top-2.5" onClick={() => setOsSearch("")}>
                        <X className="h-4 w-4 text-gray-400" />
                      </button>
                    )}
                  </div>
                </div>
              )}

              {/* Rows */}
              {osItemsQuery.isLoading ? (
                <div className="flex justify-center py-10">
                  <Loader2 className="h-6 w-6 animate-spin text-[#001d6e]" />
                </div>
              ) : (
                <div ref={osCsvListScrollRef} className={`max-h-[420px] overflow-x-auto ${osRotated ? "overflow-y-hidden" : "overflow-y-auto"}`}>
                  <table className={`w-full border-collapse ${osRotated ? "text-sm" : "text-xs"}`}>
                    <thead>
                      <tr className="border-b-2 border-gray-300 bg-gray-100 text-left text-gray-600 sticky top-0">
                        <th className={`font-semibold border-r border-gray-300 ${osRotated ? "px-4 py-2.5" : "px-3 py-2"}`}>Item</th>
                        <th className={`font-semibold text-right border-r border-gray-300 ${osRotated ? "px-3 py-2.5" : "px-2 py-2"}`}>Exp</th>
                        <th className={`font-semibold text-right border-r border-gray-300 ${osRotated ? "px-3 py-2.5" : "px-2 py-2"}`}>Done</th>
                        <th className={`font-semibold text-right border-r border-gray-300 ${osRotated ? "px-3 py-2.5" : "px-2 py-2"}`}>Left</th>
                        <th className={`font-semibold text-right border-r border-gray-300 ${osRotated ? "px-3 py-2.5" : "px-2 py-2"}`}>Extra</th>
                        <th className={`font-semibold text-center ${osRotated ? "px-4 py-2.5" : "px-3 py-2"}`}>Status</th>
                      </tr>
                    </thead>
                    <tbody>
                      {osFiltered.map((item) => {
                        const credit    = osCreditByBarcode.get(normalize(item.barcode));
                        const creditQty = credit?.creditedQty ?? 0;
                        // The credit from an earlier part's extra counts toward this part's
                        // progress: it adds to "done" and subtracts from "left". Real over-scan
                        // (extra) on THIS part is unaffected by the credit.
                        const effScanned = (item.totalScannedQty ?? 0) + creditQty;
                        const exp        = item.expectedQty ?? 0;
                        const scanned    = Math.min(effScanned, exp);
                        const remaining  = Math.max(0, exp - effScanned);
                        const extra      = Math.max(0, (item.totalScannedQty ?? 0) - exp);
                        const effStatus  = exp > 0 && effScanned >= exp ? "complete" : effScanned > 0 ? "partial" : "pending";
                        return (
                          <tr key={item.id} className={`border-b border-gray-200 ${
                            effStatus === "complete" ? "bg-emerald-50/40" :
                            effStatus === "partial"  ? "bg-amber-50/30" : undefined
                          }`}>
                            <td className={`border-r border-gray-200 min-w-[180px] max-w-[320px] ${osRotated ? "px-4 py-2.5" : "px-3 py-2"}`}>
                              <p className="font-medium text-gray-900 whitespace-normal break-words leading-snug">{item.itemName ?? "—"}</p>
                              <p className="text-gray-400 font-mono whitespace-normal break-words">
                                {item.barcode ?? "—"}{item.sapCode && ` · SAP ${item.sapCode}`}
                              </p>
                              {credit && (
                                <p className="text-purple-600 mt-0.5" title={credit.sources.map((s) => `${s.qty} from ${s.fromCsvFileName}`).join(", ")}>
                                  ✓ {credit.creditedQty} counted from an earlier part
                                </p>
                              )}
                            </td>
                            <td className={`text-right tabular-nums text-gray-600 border-r border-gray-200 ${osRotated ? "px-3 py-2.5" : "px-2 py-2"}`}>{exp || "—"}</td>
                            <td className={`text-right tabular-nums font-semibold text-gray-900 border-r border-gray-200 ${osRotated ? "px-3 py-2.5" : "px-2 py-2"}`}>{scanned}</td>
                            <td className={`text-right tabular-nums font-semibold border-r border-gray-200 ${remaining > 0 ? "text-[#001d6e]" : "text-gray-300"} ${osRotated ? "px-3 py-2.5" : "px-2 py-2"}`}>{remaining || "—"}</td>
                            <td className={`text-right tabular-nums font-semibold border-r border-gray-200 ${extra > 0 ? "text-amber-600" : "text-gray-300"} ${osRotated ? "px-3 py-2.5" : "px-2 py-2"}`}>{extra > 0 ? `+${extra}` : "—"}</td>
                            <td className={`text-center ${osRotated ? "px-4 py-2.5" : "px-3 py-2"}`}>
                              <span className={`inline-block font-semibold ${osRotated ? "px-2.5 py-1 text-xs" : "px-2 py-0.5 text-[11px]"} ${
                                effStatus === "complete" ? "bg-emerald-100 text-emerald-700" :
                                effStatus === "partial"  ? "bg-amber-100 text-amber-700" : "bg-gray-100 text-gray-500"
                              }`}>
                                {effStatus === "complete" ? "Done" : effStatus === "partial" ? "Partial" : "Pending"}
                              </span>
                            </td>
                          </tr>
                        );
                      })}
                      {osFiltered.length === 0 && (
                        <tr><td colSpan={6} className="py-10 text-center text-gray-400">
                          {osItems.length === 0 ? "Loading items…" : "No items match."}
                        </td></tr>
                      )}
                    </tbody>
                  </table>
                </div>
              )}
            </div>

            {/* Manage / Extra — pinned to the bottom, below the CSV Items list */}
            {sideInfoPanel}

              </>
            )}

            {/* ── Master View Tab (mobile) ── */}
            {osTab === "master-view" && (
              <div className="space-y-3">
                <div className="flex flex-wrap items-center gap-2">
                  <span className="rounded-md border border-gray-200 bg-white px-2.5 py-1.5 text-xs text-gray-600 shadow-sm">
                    {mvPlant ? <><span className="font-semibold text-[#001d6e]">{mvPlant}</span> · {mvDate}</> : "No active session"}
                  </span>
                  <button
                    onClick={() => setMvShowFiles((v) => !v)}
                    title={mvShowFiles ? "Hide file names" : "Show file names"}
                    className="inline-flex h-8 w-8 shrink-0 items-center justify-center rounded-md border border-gray-200 bg-white text-gray-500 shadow-sm hover:bg-gray-50"
                  >
                    {mvShowFiles ? <Eye className="h-3.5 w-3.5" /> : <EyeOff className="h-3.5 w-3.5" />}
                  </button>
                  {allMvItems.length > 0 && (
                    <button onClick={downloadMvCsv} className="inline-flex items-center gap-1.5 rounded-md border border-gray-200 bg-white px-2.5 py-1.5 text-xs font-medium text-gray-700 hover:bg-gray-50 shadow-sm">
                      <Download className="h-3.5 w-3.5" /> Export
                    </button>
                  )}
                </div>
                <div className="relative">
                  <Search className="absolute left-3 top-2.5 h-3.5 w-3.5 text-gray-400" />
                  <Input
                    value={mvSearch}
                    onChange={(e) => setMvSearch(e.target.value)}
                    placeholder="Search items…"
                    className="pl-8 h-9 text-sm bg-white"
                  />
                  {mvSearch && (
                    <button className="absolute right-2.5 top-2.5" onClick={() => setMvSearch("")}>
                      <X className="h-4 w-4 text-gray-400" />
                    </button>
                  )}
                </div>
                {mvQuery.isLoading && <p className="text-sm text-gray-400 animate-pulse py-4 text-center">Loading…</p>}
                {mvData && (
                  <div className="bg-white border border-gray-300 overflow-hidden">
                    <div className="flex items-center justify-between px-4 py-2.5 border-b border-gray-300 bg-[#001d6e]">
                      <p className="text-xs font-semibold text-white">Items</p>
                      <span className="text-xs text-blue-200">{filtMvItems.length} of {allMvItems.length}</span>
                    </div>
                    <div className="overflow-x-auto">
                      <table className={`w-full border-collapse ${osRotated ? "text-sm" : "text-xs"}`}>
                        <thead>
                          <tr className="border-b-2 border-gray-300 bg-gray-100 text-left text-gray-600">
                            <th className={`font-semibold border-r border-gray-300 ${osRotated ? "px-4 py-2.5" : "px-3 py-2"}`}>Item</th>
                            {mvShowFiles && <th className={`font-semibold border-r border-gray-300 ${osRotated ? "px-3 py-2.5" : "px-2 py-2"}`}>File</th>}
                            <th className={`font-semibold text-right border-r border-gray-300 ${osRotated ? "px-3 py-2.5" : "px-2 py-2"}`}>Exp</th>
                            <th className={`font-semibold text-right border-r border-gray-300 ${osRotated ? "px-3 py-2.5" : "px-2 py-2"}`}>Done</th>
                            <th className={`font-semibold text-right border-r border-gray-300 ${osRotated ? "px-3 py-2.5" : "px-2 py-2"}`}>Left</th>
                            <th className={`font-semibold text-right border-r border-gray-300 ${osRotated ? "px-3 py-2.5" : "px-2 py-2"}`}>Extra</th>
                            <th className={`font-semibold text-center ${osRotated ? "px-4 py-2.5" : "px-3 py-2"}`}>Status</th>
                          </tr>
                        </thead>
                        <tbody>
                          {filtMvItems.length === 0 ? (
                            <tr><td colSpan={mvShowFiles ? 7 : 6} className="py-10 text-center text-gray-400">No items found</td></tr>
                          ) : filtMvItems.map((item, idx) => {
                        if (item._isEmptyBox) {
                          return (
                            <div key={idx} className="flex items-center gap-3 px-4 py-3 bg-orange-50/60">
                              <span className="shrink-0"><Package className="h-5 w-5 text-orange-500" /></span>
                              <div className="flex-1 min-w-0">
                                <p className="text-sm font-medium text-orange-900 leading-snug">Empty Box</p>
                                <p className="text-[11px] text-orange-600/80">
                                  {item._emptyBoxQty} box{item._emptyBoxQty === 1 ? "" : "es"} logged
                                  {item._emptyBoxCount ? ` · ${item._emptyBoxCount} entr${item._emptyBoxCount === 1 ? "y" : "ies"}` : ""} · not counted as stock
                                </p>
                              </div>
                              <span className="shrink-0">
                                <span className="rounded-full bg-orange-100 px-2 py-0.5 text-[11px] font-semibold text-orange-700">Empty Box</span>
                              </span>
                            </div>
                          );
                        }
                            const exp = item.quantity ?? 0;
                            const done = Math.max(0, (item.scannedQty ?? 0) - (item.extraQty ?? 0));
                            const remain = Math.max(0, exp - done);
                            const extra = item.extraQty ?? 0;
                            const isExtraOnly = item._isExtra;
                            const isDone = done >= exp && exp > 0;
                            const isPartial = done > 0 && !isDone && !isExtraOnly;
                            return (
                              <tr key={idx} className={`border-b border-gray-200 ${
                                isExtraOnly ? "bg-orange-50/40" : isDone ? "bg-emerald-50/40" : isPartial ? "bg-amber-50/30" : undefined
                              }`}>
                                <td className={`border-r border-gray-200 min-w-[180px] max-w-[320px] ${osRotated ? "px-4 py-2.5" : "px-3 py-2"}`}>
                                  <p className="font-medium text-gray-900 whitespace-normal break-words leading-snug">{item.itemName ?? "—"}</p>
                                  <p className="text-gray-400 font-mono whitespace-normal break-words">
                                    {item.barcode ?? "—"}{item.sapCode && ` · SAP ${item.sapCode}`}
                                  </p>
                                </td>
                                {mvShowFiles && (
                                  <td className={`text-gray-400 truncate max-w-[100px] border-r border-gray-200 ${osRotated ? "px-3 py-2.5" : "px-2 py-2"}`} title={item._files.map(stripCsvExt).join(", ")}>
                                    {item._files.length > 1 ? `${item._files.length} files` : stripCsvExt(item._files[0] ?? "")}
                                  </td>
                                )}
                                <td className={`text-right tabular-nums text-gray-600 border-r border-gray-200 ${osRotated ? "px-3 py-2.5" : "px-2 py-2"}`}>{exp || "—"}</td>
                                <td className={`text-right tabular-nums font-semibold text-gray-900 border-r border-gray-200 ${osRotated ? "px-3 py-2.5" : "px-2 py-2"}`}>{done}</td>
                                <td className={`text-right tabular-nums font-semibold border-r border-gray-200 ${remain > 0 ? "text-[#001d6e]" : "text-gray-300"} ${osRotated ? "px-3 py-2.5" : "px-2 py-2"}`}>{remain || "—"}</td>
                                <td className={`text-right tabular-nums font-semibold border-r border-gray-200 ${extra > 0 ? "text-amber-600" : "text-gray-300"} ${osRotated ? "px-3 py-2.5" : "px-2 py-2"}`}>{extra > 0 ? `+${extra}` : "—"}</td>
                                <td className={`text-center ${osRotated ? "px-4 py-2.5" : "px-3 py-2"}`}>
                                  <span className={`inline-block font-semibold ${osRotated ? "px-2.5 py-1 text-xs" : "px-2 py-0.5 text-[11px]"} ${
                                    isExtraOnly ? "bg-orange-100 text-orange-700" :
                                    isDone       ? "bg-emerald-100 text-emerald-700" :
                                    isPartial    ? "bg-amber-100 text-amber-700" : "bg-gray-100 text-gray-500"
                                  }`}>
                                    {isExtraOnly ? "Extra" : isDone ? "Done" : isPartial ? "Partial" : "Pending"}
                                  </span>
                                </td>
                              </tr>
                            );
                          })}
                        </tbody>
                      </table>
                    </div>
                  </div>
                )}
                {!mvQuery.isLoading && !mvData && <p className="text-sm text-gray-400 py-4 text-center">No active session — load a CSV to see its Master View.</p>}
                {sideInfoPanel}
              </div>
            )}

            {/* ── Separate CSVs Tab (mobile) ── */}
            {osTab === "separate-csvs" && (
              <div className="space-y-3">
                <div className="flex flex-wrap items-center gap-2">
                  <span className="rounded-md border border-gray-200 bg-white px-2.5 py-1.5 text-xs text-gray-600 shadow-sm">
                    {mvPlant ? <><span className="font-semibold text-[#001d6e]">{mvPlant}</span> · {mvDate}</> : "No active session"}
                  </span>
                </div>
                {csvSessQuery.isFetching && <p className="text-sm text-gray-400 animate-pulse py-4 text-center">Loading files…</p>}
                {csvSessions.length === 0 && !csvSessQuery.isFetching && <p className="text-sm text-gray-400 py-4 text-center">No uploaded files for this order.</p>}
                <div className="space-y-2">
                  {csvSessions.map((sess) => (
                    <div key={sess.id} className="rounded-xl border bg-white shadow-sm overflow-hidden">
                      <button className="flex w-full items-center justify-between px-3 py-2.5 hover:bg-gray-50 transition-colors"
                        onClick={() => { if (csvExpId === sess.id) { setCsvExpId(null); setCsvSearch(""); } else { setCsvExpId(sess.id); setCsvSearch(""); } }}>
                        <div className="flex items-center gap-2.5 min-w-0">
                          <Layers className="h-4 w-4 text-gray-400 shrink-0" />
                          <div className="text-left min-w-0">
                            <p className="text-sm font-medium text-gray-900 truncate">{stripCsvExt(sess.csvFileName)}</p>
                            <p className="text-[11px] text-gray-400">
                              {sess.plant && <span className="mr-1.5">Plant: {sess.plant}</span>}
                              {sess.rowCount} rows · {scanFmtIST(sess.createdAt)}
                            </p>
                          </div>
                        </div>
                        <ChevronDown className={`h-4 w-4 text-gray-400 shrink-0 transition-transform ${csvExpId === sess.id ? "rotate-180" : ""}`} />
                      </button>
                      {csvExpId === sess.id && (
                        <div className="border-t">
                          <div className="px-3 py-2 bg-gray-50 border-b">
                            <div className="relative">
                              <Search className="absolute left-2.5 top-1/2 -translate-y-1/2 h-3.5 w-3.5 text-gray-400 pointer-events-none" />
                              <input value={csvSearch} onChange={(e) => setCsvSearch(e.target.value)} placeholder="Search…"
                                className="w-full rounded-md border border-gray-200 bg-white pl-8 pr-3 py-1.5 text-xs focus:outline-none focus:ring-2 focus:ring-[#001d6e]" />
                              {csvSearch && <button onClick={() => setCsvSearch("")} className="absolute right-2 top-1/2 -translate-y-1/2"><X className="h-3 w-3 text-gray-400" /></button>}
                            </div>
                          </div>
                          {csvItemsQuery2.isFetching && <p className="px-3 py-4 text-sm text-gray-400 animate-pulse text-center">Loading items…</p>}
                          {!csvItemsQuery2.isFetching && (
                            <div className="divide-y">
                              {filtCsvItems.length === 0 ? (
                                <p className="py-8 text-center text-sm text-gray-400">No items</p>
                              ) : filtCsvItems.map((item) => {
                                const exp = item.quantity ?? 0;
                                const done = item.scannedQty ?? 0;
                                const remain = Math.max(0, exp - done);
                                const isDone = done >= exp && exp > 0;
                                const isPartial = done > 0 && !isDone;
                                return (
                                  <div key={item.id} className={`flex items-center gap-3 px-3 py-2.5 ${
                                    isDone ? "bg-green-50/60" : isPartial ? "bg-amber-50/50" : ""
                                  }`}>
                                    <span className="shrink-0">
                                      {isDone
                                        ? <CheckCircle2 className="h-4 w-4 text-green-500" />
                                        : isPartial
                                        ? <ScanLine className="h-4 w-4 text-amber-500" />
                                        : <span className="inline-block h-4 w-4 rounded-full border-2 border-gray-300" />}
                                    </span>
                                    <div className="flex-1 min-w-0">
                                      <p className="text-xs font-medium text-gray-900 truncate">{item.itemName ?? "—"}</p>
                                      <p className="text-[11px] text-gray-400 font-mono truncate">{item.barcode ?? "—"}</p>
                                    </div>
                                    <div className="text-right shrink-0 text-xs">
                                      <p className="font-bold text-gray-800">{done}/{exp || "—"}</p>
                                      {remain > 0 && <p className="text-[#001d6e] font-semibold">{remain} left</p>}
                                    </div>
                                  </div>
                                );
                              })}
                            </div>
                          )}
                        </div>
                      )}
                    </div>
                  ))}
                </div>
              </div>
            )}
          </div>
        </div>

        {/* ══════════════════════════════════════════════════
            DESKTOP LAYOUT  (hidden on mobile, or when rotated — see MOBILE LAYOUT note above)
        ════════════════════════════════════════════════════ */}
        <div className={osRotated ? "hidden" : "hidden sm:block"}>
          <div className="mx-auto max-w-7xl space-y-4">

            {/* Header row */}
            <div className="flex items-center justify-between gap-3 flex-wrap">
              <div className="flex items-center gap-3 min-w-0">
                <div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg bg-amber-400">
                  <Zap className="h-4 w-4 text-white" />
                </div>
                <div className="min-w-0">
                  {/* Order Date (what the CSV was uploaded FOR) rather than the CSV file name —
                      operators identify a session by the order it belongs to, not the raw upload
                      timestamp. The file name is still available as the tooltip. */}
                  <p
                    className="text-sm font-bold text-gray-900 leading-tight truncate max-w-xs lg:max-w-sm"
                    title={stripCsvExt(activeOrderScanSession.csvFileName)}
                  >
                    {scanFmtUploadDate(activeOrderScanSession.orderDate)}
                    {(osGroupCreditsQuery.data?.totalParts ?? 0) > 1 && (
                      <span className="ml-1.5 rounded-full bg-purple-100 px-1.5 py-0.5 text-[10px] font-semibold text-purple-700">
                        Part {osGroupCreditsQuery.data?.partIndex} of {osGroupCreditsQuery.data?.totalParts}
                      </span>
                    )}
                  </p>
                  <p className="text-xs text-gray-500 truncate">
                    {activeOrderScanSession.plant}
                    {activeOrderScanSession.importedByName && ` · loaded by ${activeOrderScanSession.importedByName}`}
                  </p>
                </div>
              </div>
              <div className="flex flex-col items-stretch gap-1.5 shrink-0 sm:items-end">
                <div className="flex items-center gap-2">
                  <Progress value={osPct} className="w-28 h-2" />
                  <span className="text-xs font-medium text-gray-600 whitespace-nowrap">{osDoneCount}/{osTotalCount} done</span>
                  {canCompletePart && (
                    <Button size="sm" className="h-8 px-3 text-xs bg-emerald-600 hover:bg-emerald-700 text-white" onClick={() => setShowForceComplete(true)}>
                      Complete
                    </Button>
                  )}
                </div>
                {/* STV selector — sits under Complete as part of the order header. Highlighted so
                    the operator notices it's unset before scanning. */}
                {stvs.length > 0 && (
                  <Select
                    value={osSelectedStv || NO_STV}
                    onValueChange={(v) => setOsSelectedStv(v === NO_STV ? "" : v)}
                  >
                    <SelectTrigger
                      className={`h-9 w-full text-xs font-semibold sm:w-52 ${
                        osSelectedStv
                          ? "border-[#001d6e] bg-[#001d6e]/5 text-[#001d6e] ring-1 ring-[#001d6e]/20"
                          : "border-amber-400 bg-amber-50 text-amber-800 ring-1 ring-amber-300"
                      }`}
                    >
                      <SelectValue placeholder="Select STV…" />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value={NO_STV}>— Select STV —</SelectItem>
                      {stvs.map((s) => (
                        <SelectItem key={s} value={s}>{s}</SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                )}
                {/* No STVs configured for this plant — say so instead of rendering nothing,
                    which looked like a missing/broken control (notably on production, where
                    the plant's STV list hadn't been set up). */}
                {!osStvsQuery.isLoading && stvs.length === 0 && (
                  <span className="w-full rounded border border-dashed border-amber-300 bg-amber-50 px-2 py-1 text-center text-[11px] text-amber-700 sm:w-52">
                    No STV — create one in Plant Settings
                  </span>
                )}
              </div>
            </div>

            {/* ── Tab strip ── */}
            <div className="flex flex-wrap gap-1.5">
              {(["master-view", "scan", "separate-csvs"] as const).map((t) => (
                <button
                  key={t}
                  onClick={() => setOsTab(t)}
                  className={`flex items-center gap-1.5 rounded-full px-4 py-1.5 text-sm font-medium transition-colors ${
                    osTab === t
                      ? "bg-[#001d6e] text-white"
                      : "border border-gray-200 bg-white text-gray-600 hover:bg-gray-50"
                  }`}
                >
                  {t === "scan" ? <ScanLine className="h-4 w-4" /> : t === "master-view" ? <Layers className="h-4 w-4" /> : <FileSpreadsheet className="h-4 w-4" />}
                  {t === "scan" ? "Scan" : t === "master-view" ? "Master View" : "Part Order"}
                </button>
              ))}
            </div>

            {/* ── Order totals — persistent across Scan / Master View, hidden on Separate CSVs ──
                Two resizable columns on lg+: the --totals-col variable drives the split so the
                drag handle can change it without Tailwind needing a static class. Below lg the
                columns stack and the handle is hidden. */}
            {osTab !== "separate-csvs" && (
            <div
              ref={totalsRowRef}
              style={{ "--totals-col": `${totalsPct}%` } as React.CSSProperties}
              className="grid items-start gap-3 lg:grid-cols-[var(--totals-col)_0.75rem_minmax(0,1fr)] lg:gap-0"
            >
              {/* Totals live in one card rather than four free-floating boxes, so the block reads as
                  a single unit. items-start on the row keeps this card at its natural height rather
                  than stretching to match the taller scanner column. */}
              <div className="flex min-w-0 flex-col gap-3">
              <div className="flex flex-col gap-1.5 rounded-xl border bg-white p-2.5 shadow-sm">
                <div className="flex items-baseline justify-between">
                  <p className="text-[11px] font-semibold uppercase tracking-wide text-gray-500">Order Totals</p>
                  <p className="text-[11px] font-medium text-gray-400">
                    {displayTotals.expected > 0
                      ? `${Math.round((displayTotals.done / displayTotals.expected) * 100)}% complete`
                      : "—"}
                  </p>
                </div>

                {/* All four totals on one line; they stack 2×2 only on narrow screens. */}
                {/* Each box filters the items table to its own rows; clicking the active one clears
                    the filter. Total is the "show everything" box, so it doubles as Clear. */}
                <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
                  {([
                    { key: "", label: "Total", value: displayTotals.expected, plt: displayTotals.palletsExpected, dot: "bg-gray-400", text: "text-gray-900" },
                    { key: "done", label: "Done", value: displayTotals.done, plt: displayTotals.palletsDone, dot: "bg-emerald-500", text: "text-emerald-600" },
                    { key: "remaining", label: "Remaining", value: displayTotals.remaining, plt: displayTotals.palletsRemaining, dot: "bg-[#001d6e]", text: "text-[#001d6e]" },
                    { key: "extra", label: "Extra", value: displayTotals.extra, plt: displayTotals.palletsExtra, dot: "bg-amber-500", text: displayTotals.extra > 0 ? "text-amber-600" : "text-gray-300" },
                  ] as const).map((s) => {
                    const isActive = osStatFilter === s.key;
                    return (
                      <button
                        key={s.label}
                        type="button"
                        onClick={() => setOsStatFilter(isActive ? "" : s.key)}
                        aria-pressed={isActive}
                        title={s.key ? `Show only ${s.label.toLowerCase()} items` : "Show all items"}
                        className={`rounded-lg border px-2.5 py-1 text-left transition-colors ${
                          isActive
                            ? "border-[#001d6e] bg-[#001d6e]/[0.06] ring-1 ring-[#001d6e]/30"
                            : "border-gray-100 bg-gray-50/70 hover:bg-gray-100"
                        }`}
                      >
                        <div className="flex items-center gap-1.5">
                          <span className={`h-1.5 w-1.5 shrink-0 rounded-full ${s.dot}`} />
                          <p className="text-[10px] font-semibold uppercase tracking-wide text-gray-500">{s.label}</p>
                        </div>
                        <p className={`text-lg font-bold leading-tight ${s.text}`}>{s.value}</p>
                        <p className="text-xs font-medium text-gray-500">{s.plt.toFixed(2)} plt</p>
                      </button>
                    );
                  })}
                </div>

                <div className="space-y-1">
                  <div className="h-2 w-full overflow-hidden rounded-full bg-gray-100">
                    <div
                      className="h-full rounded-full bg-emerald-500 transition-[width] duration-300"
                      style={{ width: `${displayTotals.expected > 0 ? Math.min(100, (displayTotals.done / displayTotals.expected) * 100) : 0}%` }}
                    />
                  </div>
                  <div className="flex justify-between text-[10px] font-medium text-gray-400">
                    <span>{displayTotals.done} done</span>
                    <span>{displayTotals.remaining} remaining</span>
                  </div>
                </div>
              </div>
              {osTab === "master-view" && (
                      <div className="flex flex-wrap items-center gap-3">
                        <span className="rounded-md border border-gray-200 bg-white px-3 py-1.5 text-sm text-gray-600 shadow-sm">
                          {mvPlant ? <><span className="font-semibold text-[#001d6e]">{mvPlant}</span> · {mvDate}</> : "No active session"}
                        </span>
                        {allMvItems.length > 0 && (
                          <button onClick={downloadMvCsv} className="inline-flex items-center gap-1.5 rounded-md border border-gray-200 bg-white px-3 py-1.5 text-sm font-medium text-gray-700 hover:bg-gray-50 shadow-sm">
                            <Download className="h-3.5 w-3.5" /> Export CSV
                          </button>
                        )}
                      </div>
              )}
              </div>

              {/* Drag handle — sits in the 0.75rem gutter column and trades width between the two
                  cards. Keyboard-accessible via arrow keys since a pointer drag isn't reachable
                  without a mouse. */}
              <div
                role="separator"
                aria-orientation="vertical"
                aria-label="Resize totals and scanner columns"
                aria-valuenow={Math.round(totalsPct)}
                aria-valuemin={OS_TOTALS_PCT_MIN}
                aria-valuemax={OS_TOTALS_PCT_MAX}
                tabIndex={0}
                onPointerDown={startTotalsResize}
                onDoubleClick={() => setTotalsPct(60)}
                onKeyDown={(e) => {
                  if (e.key === "ArrowLeft") { e.preventDefault(); setTotalsPct((p) => Math.max(OS_TOTALS_PCT_MIN, p - 2)); }
                  if (e.key === "ArrowRight") { e.preventDefault(); setTotalsPct((p) => Math.min(OS_TOTALS_PCT_MAX, p + 2)); }
                }}
                title="Drag to resize · double-click to reset"
                className="group hidden cursor-col-resize touch-none select-none items-center justify-center rounded focus:outline-none focus:ring-2 focus:ring-[#001d6e]/40 lg:flex"
              >
                <span className="h-10 w-[3px] rounded-full bg-gray-200 transition-colors group-hover:bg-[#001d6e]" />
              </div>

              {/* Scanner controls sit beside the totals: STV picker, then the mode buttons under it. */}
              <div className="flex flex-col gap-2 rounded-xl border bg-white p-3 shadow-sm">
                {/* Equal-width halves via grid-cols-2; both share one height so they read as a pair. */}
                <div className="grid grid-cols-2 gap-2">
                  <Button
                    variant={osScanMode === "camera" ? "default" : "outline"}
                    className={`h-9 w-full text-xs font-semibold ${osScanMode === "camera" ? "bg-[#001d6e] hover:bg-[#00154b] text-white" : ""}`}
                    onClick={() => setOsScanMode("camera")}>
                    <Camera className="mr-1.5 h-4 w-4" /> Camera
                  </Button>
                  <Button
                    variant={osScanMode === "manual" ? "default" : "outline"}
                    className={`h-9 w-full text-xs font-semibold ${osScanMode === "manual" ? "bg-[#001d6e] hover:bg-[#00154b] text-white" : ""}`}
                    onClick={() => { stopOsCamera(); setOsScanMode("manual"); }}>
                    <Keyboard className="mr-1.5 h-4 w-4" /> Manual
                  </Button>
                </div>
                <p className="flex items-center gap-1.5 text-[11px] text-gray-400">
                  <Plug className="h-3 w-3 shrink-0" />
                  Barcode gun: plug in and scan
                </p>
                {/* Camera card — always in DOM so ref stays set; hidden via display:none when not in camera mode */}
                <Card className="rounded-xl shadow-sm" style={{ display: osScanMode === "camera" ? "block" : "none", overflow: "hidden", isolation: "isolate" }}>
                  <div className="relative bg-black" style={{ height: "230px" }}>
                    <video
                      ref={osVideoDesktopRef}
                      autoPlay
                      muted
                      playsInline
                      style={{
                        width: "100%",
                        height: "100%",
                        objectFit: "cover",
                        transform: "translateZ(0)",
                        WebkitTransform: "translateZ(0)",
                        display: "block",
                      }}
                    />
                    {osScanMode === "camera" && !osCameraReady && !osCameraError && (
                      <div className="absolute inset-0 flex flex-col items-center justify-center text-white gap-2">
                        <Loader2 className="h-8 w-8 animate-spin" />
                        <p className="text-sm">Starting camera…</p>
                      </div>
                    )}
                    {osScanMode === "camera" && osCameraReady && (
                      <div className="pointer-events-none absolute inset-0 flex items-center justify-center">
                        <div className="h-16 w-48 rounded border-2 border-white/70" />
                      </div>
                    )}
                  </div>
                  {osScanMode === "camera" && osCameraError && (
                    <div className="flex items-center gap-2 bg-red-50 p-3 text-xs text-red-700">
                      <AlertTriangle className="h-3.5 w-3.5 shrink-0" />
                      {osCameraError}
                    </div>
                  )}
                </Card>

                {osScanMode === "manual" && (
                  <Card className="rounded-xl shadow-sm">
                    <CardContent className="p-4 space-y-2">
                      <Label className="text-sm font-medium">Enter item name or barcode</Label>
                      <div className="relative flex gap-2">
                        <div className="relative flex-1 min-w-0">
                          <Input
                            value={osManualCode}
                            onChange={(e) => { setOsManualCode(e.target.value); setOsSuggIdx(-1); }}
                            onFocus={() => setOsManualFocused(true)}
                            onBlur={() => setTimeout(() => setOsManualFocused(false), 150)}
                            onKeyDown={(e) => {
                              if (osManualFocused && osSuggestions.length > 0) {
                                if (e.key === "ArrowDown") { e.preventDefault(); setOsSuggIdx((i) => Math.min(i + 1, osSuggestions.length - 1)); return; }
                                if (e.key === "ArrowUp") { e.preventDefault(); setOsSuggIdx((i) => Math.max(i - 1, -1)); return; }
                                if (e.key === "Escape") { setOsManualFocused(false); return; }
                                if (e.key === "Enter" && osSuggIdx >= 0) {
                                  e.preventDefault();
                                  const item = osSuggestions[osSuggIdx];
                                  if (item.barcode) { handleOsBarcode(item.barcode); setOsManualCode(""); setOsSuggIdx(-1); }
                                  return;
                                }
                              }
                              if (e.key === "Enter" && osManualCode.trim() && osSuggIdx < 0) {
                                handleOsBarcode(osManualCode.trim());
                                setOsManualCode("");
                              }
                            }}
                            placeholder="Type item name or barcode…"
                            disabled={!!osPending}
                            className="font-mono text-xs h-8 w-full"
                            autoFocus
                          />
                          {osManualFocused && osSuggestions.length > 0 && (
                            <div className="absolute left-0 right-0 top-full z-50 mt-1 rounded-lg border border-gray-200 bg-white shadow-lg overflow-hidden">
                              {osSuggestions.map((item, idx) => (
                                <button
                                  key={item.id}
                                  type="button"
                                  onMouseDown={(e) => { e.preventDefault(); if (item.barcode) { handleOsBarcode(item.barcode); setOsManualCode(""); setOsSuggIdx(-1); } }}
                                  className={`w-full text-left px-3 py-2 flex items-center gap-2 text-sm border-b last:border-0 ${idx === osSuggIdx ? "bg-[#001d6e] text-white" : "hover:bg-gray-50"}`}
                                >
                                  <ScanLine className={`h-3.5 w-3.5 shrink-0 ${idx === osSuggIdx ? "text-white/70" : "text-gray-400"}`} />
                                  <span className="flex-1 min-w-0 truncate font-medium">{item.itemName || item.barcode}</span>
                                  {item.barcode && <span className={`font-mono text-xs shrink-0 ${idx === osSuggIdx ? "text-white/60" : "text-gray-400"}`}>{item.barcode}</span>}
                                </button>
                              ))}
                            </div>
                          )}
                        </div>
                        <Button size="sm"
                          disabled={!osManualCode.trim() || !!osPending}
                          onClick={() => {
                            if (osSuggIdx >= 0 && osSuggestions[osSuggIdx]?.barcode) {
                              handleOsBarcode(osSuggestions[osSuggIdx].barcode!);
                            } else if (osManualCode.trim()) {
                              handleOsBarcode(osManualCode.trim());
                            }
                            setOsManualCode(""); setOsSuggIdx(-1);
                          }}
                          className="bg-[#001d6e] hover:bg-[#00154b] text-white shrink-0 h-8 w-8 p-0">
                          <ScanLine className="h-3.5 w-3.5" />
                        </Button>
                      </div>
                    </CardContent>
                  </Card>
                )}

                {/* ── Empty Box — log a box with no item/barcode, alongside Gun Mode. Separate
                    from a product scan: no CSV lookup, doesn't count toward order qty. ── */}
                <div className="flex items-center gap-2">
                  <Button
                    variant="outline"
                    disabled={!activeOrderScanSession || activeOrderScanSession.scanStatus === "completed" || !!osPending}
                    onClick={() => { setEmptyBoxQty("1"); setEmptyBoxNote(""); setShowEmptyBox(true); }}
                    className="flex-1 h-9 text-xs border-amber-300 text-amber-700 hover:bg-amber-50"
                  >
                    <Package className="h-4 w-4 mr-1.5" /> Empty Box
                  </Button>
                  {(osEmptyBoxesQuery.data?.totalQty ?? 0) > 0 && (
                    <span className="text-[11px] font-medium text-amber-700 bg-amber-50 border border-amber-200 rounded-full px-2.5 py-1 shrink-0">
                      {osEmptyBoxesQuery.data!.totalQty} empty
                    </span>
                  )}
                </div>
              </div>
            </div>
            )}

            <div className="space-y-4">
            <div className="flex flex-col gap-4">

              {/* Single full-width column: the scanner collapsible sits above the table (order-1)
                  and the table spans the whole width below it (order-2). The scanner panel is
                  shared/persistent across both tabs so the camera never remounts (and drops its
                  stream) when switching between them. */}
              <div className="order-2 space-y-4 min-w-0">
              {osTab === "scan" && (
                <TableCard
                  icon={ScanLine}
                  title="Items"
                  subtitle={`${osDoneCount} / ${osTotalCount} done`}
                  searchValue={osSearch}
                  onSearchChange={setOsSearch}
                  searchPlaceholder="Search by name or barcode…"
                >
                  <DataTable<OsScanItem>
                    className="space-y-0"
                    containerClassName="rounded-none border-0"
                    columns={osColumns}
                    data={osVisible}
                    getRowId={(item) => String(item.id)}
                    isLoading={osItemsQuery.isLoading}
                    loadingLabel="Loading items…"
                    emptyState="Loading items…"
                    noResultsState="No items match the search."
                    hasActiveFilters={!!osSearch}
                    enableZebraStripes
                    rowClassName={(item) => {
                      const { done, partial } = osRowState(item);
                      return done ? "bg-emerald-50/40" : partial ? "bg-amber-50/30" : undefined;
                    }}
                    sortMode="client"
                    paginationMode="client"
                    defaultPageSize={10}
                    pageSizeOptions={[10, 25, 50, 100]}
                    enableColumnResizing
                    isStickyHeader
                    maxHeight="560px"
                    showMobileSwipeHint
                    headerClassName="bg-[#001d6e] text-white border-[#1a3a9c] hover:bg-[#0a2b7e] hover:text-white"
                  />
                </TableCard>
              )}
              {osTab === "master-view" && (
                <div className="space-y-4">
                  <div className="flex flex-wrap items-center gap-3">
                    <span className="rounded-md border border-gray-200 bg-white px-3 py-1.5 text-sm text-gray-600 shadow-sm">
                      {mvPlant ? <><span className="font-semibold text-[#001d6e]">{mvPlant}</span> · {mvDate}</> : "No active session"}
                    </span>
                    <button
                      onClick={() => setMvShowFiles((v) => !v)}
                      title={mvShowFiles ? "Hide file names" : "Show file names"}
                      className="inline-flex h-8 w-8 shrink-0 items-center justify-center rounded-md border border-gray-200 bg-white text-gray-500 shadow-sm hover:bg-gray-50"
                    >
                      {mvShowFiles ? <Eye className="h-3.5 w-3.5" /> : <EyeOff className="h-3.5 w-3.5" />}
                    </button>
                    {allMvItems.length > 0 && (
                      <button onClick={downloadMvCsv} className="inline-flex items-center gap-1.5 rounded-md border border-gray-200 bg-white px-3 py-1.5 text-sm font-medium text-gray-700 hover:bg-gray-50 shadow-sm">
                        <Download className="h-3.5 w-3.5" /> Export CSV
                      </button>
                    )}
                  </div>
                  {mvQuery.isLoading && <p className="text-sm text-gray-400 animate-pulse">Loading…</p>}
                  {mvData && (
                    <>
                      {mvShowFiles && (
                      <div className="flex flex-wrap gap-2">
                        {mvData.files.map((f) => (
                          <span key={f.sessionId} className="inline-flex items-center gap-1.5 rounded-full border border-gray-200 bg-white px-3 py-1 text-xs text-gray-600">
                            <Layers className="h-3 w-3 text-gray-400" />
                            {stripCsvExt(f.csvFileName)} <span className="text-gray-400">· {f.rowCount ?? f.items.length} rows</span>
                          </span>
                        ))}
                      </div>
                      )}
                      <TableCard
                        icon={Layers}
                        title="Items"
                        subtitle={`${mvVisible.length} of ${allMvItems.length}`}
                        searchValue={mvSearch}
                        onSearchChange={setMvSearch}
                        searchPlaceholder="Search items…"
                      >
                        <DataTable<MvMergedItem>
                          className="space-y-0"
                          containerClassName="rounded-none border-0"
                          columns={mvColumns}
                          data={mvVisible}
                          getRowId={(item, i) => `${item.barcode ?? "na"}-${i}`}
                          emptyState="No items found"
                          noResultsState="No items match your search."
                          hasActiveFilters={!!mvSearch}
                          enableZebraStripes
                          rowClassName={(item) => {
                            if (item._isEmptyBox) return "bg-orange-50/60";
                            const { isExtraOnly, isDone, isPartial } = mvRowState(item);
                            return isExtraOnly ? "bg-orange-50/40"
                              : isDone ? "bg-emerald-50/40"
                              : isPartial ? "bg-amber-50/30"
                              : undefined;
                          }}
                          sortMode="client"
                          paginationMode="client"
                          defaultPageSize={10}
                          pageSizeOptions={[10, 25, 50, 100]}
                          enableColumnVisibility
                          columnVisibility={mvVisibleColumnIds}
                          enableColumnResizing
                          showMobileSwipeHint
                          headerClassName="bg-[#001d6e] text-white border-[#1a3a9c] hover:bg-[#0a2b7e] hover:text-white"
                        />
                      </TableCard>
                    </>
                  )}
                  {!mvQuery.isLoading && !mvData && <p className="text-sm text-gray-400">No active session — load a CSV to see its Master View.</p>}
                </div>
              )}
              {(osTab === "scan" || osTab === "master-view") && sideInfoPanel}
              </div>


            {/* ── Separate CSVs Tab (desktop) ── */}
            {osTab === "separate-csvs" && (
              <div className="space-y-4">
                <div className="flex flex-wrap items-center gap-3">
                  <span className="rounded-md border border-gray-200 bg-white px-3 py-1.5 text-sm text-gray-600 shadow-sm">
                    {mvPlant ? <><span className="font-semibold text-[#001d6e]">{mvPlant}</span> · {mvDate}</> : "No active session"}
                  </span>
                </div>
                {csvSessQuery.isFetching && <p className="text-sm text-gray-400 animate-pulse">Loading files…</p>}
                {csvSessions.length === 0 && !csvSessQuery.isFetching && <p className="text-sm text-gray-400">No uploaded files for this order.</p>}
                <div className="space-y-2">
                  {csvSessions.map((sess) => (
                    <div key={sess.id} className="rounded-xl border bg-white shadow-sm overflow-hidden">
                      <button className="flex w-full items-center justify-between px-4 py-3 hover:bg-gray-50 transition-colors"
                        onClick={() => { if (csvExpId === sess.id) { setCsvExpId(null); setCsvSearch(""); } else { setCsvExpId(sess.id); setCsvSearch(""); } }}>
                        <div className="flex items-center gap-3 min-w-0">
                          <Layers className="h-4 w-4 text-gray-400 shrink-0" />
                          <div className="text-left min-w-0">
                            <p className="text-sm font-medium text-gray-900 truncate">{stripCsvExt(sess.csvFileName)}</p>
                            <p className="text-xs text-gray-400">
                              {sess.plant && <span className="mr-2">Plant: {sess.plant}</span>}
                              {sess.rowCount} rows · {sess.importedByName ?? "Unknown"} · {scanFmtIST(sess.createdAt)}
                            </p>
                          </div>
                        </div>
                        <ChevronDown className={`h-4 w-4 text-gray-400 shrink-0 transition-transform ${csvExpId === sess.id ? "rotate-180" : ""}`} />
                      </button>
                      {csvExpId === sess.id && (
                        <div className="border-t">
                          <div className="flex items-center gap-2 px-4 py-2 bg-gray-50 border-b">
                            <div className="relative flex-1 max-w-xs">
                              <Search className="absolute left-2.5 top-1/2 -translate-y-1/2 h-3.5 w-3.5 text-gray-400 pointer-events-none" />
                              <input value={csvSearch} onChange={(e) => setCsvSearch(e.target.value)} placeholder="Search…"
                                className="w-full rounded-md border border-gray-200 bg-white pl-8 pr-3 py-1.5 text-xs focus:outline-none focus:ring-2 focus:ring-[#001d6e]" />
                              {csvSearch && <button onClick={() => setCsvSearch("")} className="absolute right-2 top-1/2 -translate-y-1/2"><X className="h-3 w-3 text-gray-400" /></button>}
                            </div>
                            {csvImpItems.length > 0 && <span className="text-xs text-gray-400">{filtCsvItems.length} of {csvImpItems.length} items</span>}
                          </div>
                          {csvItemsQuery2.isFetching && <p className="px-4 py-4 text-sm text-gray-400 animate-pulse">Loading items…</p>}
                          {!csvItemsQuery2.isFetching && (
                            <div className="overflow-x-auto">
                              <table className="w-full text-xs sm:text-sm">
                                <thead>
                                  <tr className="bg-[#001d6e]">
                                    <th className="px-3 py-2 w-8" />
                                    <th className="px-3 py-2 text-left font-semibold text-white text-[11px] uppercase tracking-wide">Item Name</th>
                                    <th className="px-3 py-2 text-left font-semibold text-white text-[11px] uppercase tracking-wide">Barcode</th>
                                    <th className="px-3 py-2 text-right font-semibold text-white text-[11px] uppercase tracking-wide">Exp</th>
                                    <th className="px-3 py-2 text-right font-semibold text-white text-[11px] uppercase tracking-wide">Done</th>
                                    <th className="px-3 py-2 text-right font-semibold text-white text-[11px] uppercase tracking-wide">Remain</th>
                                    <th className="px-3 py-2 text-center font-semibold text-white text-[11px] uppercase tracking-wide">Status</th>
                                  </tr>
                                </thead>
                                <tbody>
                                  {filtCsvItems.length === 0 ? (
                                    <tr><td colSpan={7} className="px-3 py-6 text-center text-gray-400">No items</td></tr>
                                  ) : filtCsvItems.map((item, idx) => {
                                    const exp  = item.quantity ?? 0;
                                    const done = item.scannedQty ?? 0;
                                    const remain = Math.max(0, exp - done);
                                    const isDone = done >= exp && exp > 0;
                                    const isPartial = done > 0 && !isDone;
                                    const rowBg = isDone ? "bg-emerald-50/40" : isPartial ? "bg-amber-50/30" : idx % 2 === 0 ? "bg-white" : "bg-slate-50";
                                    return (
                                      <tr key={item.id} className={`${rowBg} border-b border-gray-100 hover:bg-slate-100/60`}>
                                        <td className="px-3 py-2 text-center">
                                          {isDone ? <CheckCircle2 className="h-4 w-4 text-emerald-500 mx-auto" />
                                            : isPartial ? <ScanLine className="h-4 w-4 text-amber-500 mx-auto" />
                                            : <span className="inline-block h-4 w-4 rounded-full border-2 border-gray-300" />}
                                        </td>
                                        <td className="px-3 py-2 font-medium text-gray-900 max-w-[200px]"><span className="block truncate">{item.itemName ?? "—"}</span></td>
                                        <td className="px-3 py-2 font-mono text-gray-500">{item.barcode ?? "—"}</td>
                                        <td className="px-3 py-2 text-right text-gray-600 tabular-nums">{exp || "—"}</td>
                                        <td className="px-3 py-2 text-right tabular-nums font-bold">
                                          <span className={isDone ? "text-emerald-700" : isPartial ? "text-amber-700" : "text-gray-400"}>{done}</span>
                                        </td>
                                        <td className="px-3 py-2 text-right tabular-nums font-bold">
                                          <span className={remain > 0 ? "text-red-600" : "text-gray-400"}>{remain}</span>
                                        </td>
                                        <td className="px-3 py-2 text-center">
                                          <span className={`inline-flex rounded-full px-2 py-0.5 text-[11px] font-semibold ${isDone ? "bg-emerald-100 text-emerald-700" : isPartial ? "bg-amber-100 text-amber-700" : "bg-gray-100 text-gray-500"}`}>
                                            {isDone ? "Done" : isPartial ? "Partial" : "Pending"}
                                          </span>
                                        </td>
                                      </tr>
                                    );
                                  })}
                                </tbody>
                              </table>
                            </div>
                          )}
                        </div>
                      )}
                    </div>
                  ))}
                </div>
              </div>
            )}

          </div>
        </div>

        {/* Empty Box dialog — manual entry (quantity + optional note), plus undo of prior entries */}
        <Dialog open={showEmptyBox} onOpenChange={(o) => { if (!o) setShowEmptyBox(false); }}>
          <DialogContent className="w-[calc(100%-2rem)] max-w-sm">
            <DialogHeader>
              <DialogTitle className="flex items-center gap-2 text-amber-700">
                <Package className="h-5 w-5" /> Log Empty Box
              </DialogTitle>
              <DialogDescription className="text-left pt-1">
                Record a box with no item/barcode to scan. It's logged separately — it doesn't
                count toward the order quantity and won't affect completion.
              </DialogDescription>
            </DialogHeader>

            <div className="space-y-3 py-1">
              <div className="space-y-1.5">
                <Label htmlFor="emptyBoxQty" className="text-xs">Quantity</Label>
                <Input
                  id="emptyBoxQty"
                  type="number"
                  min={1}
                  value={emptyBoxQty}
                  onChange={(e) => setEmptyBoxQty(e.target.value)}
                  className="h-10"
                />
              </div>
              <div className="space-y-1.5">
                <Label htmlFor="emptyBoxNote" className="text-xs">Note (optional)</Label>
                <Input
                  id="emptyBoxNote"
                  value={emptyBoxNote}
                  onChange={(e) => setEmptyBoxNote(e.target.value)}
                  placeholder="e.g. damaged, missing item"
                  className="h-10"
                />
              </div>

              {(osEmptyBoxesQuery.data?.entries?.length ?? 0) > 0 && (
                <div className="border-t pt-2">
                  <p className="text-[11px] font-medium text-gray-500 mb-1.5">
                    Logged this order — {osEmptyBoxesQuery.data!.totalQty} box(es)
                  </p>
                  <div className="max-h-40 overflow-y-auto space-y-1">
                    {osEmptyBoxesQuery.data!.entries.map((en: any) => (
                      <div key={en.id} className="flex items-center gap-2 text-xs bg-amber-50/60 rounded px-2 py-1.5">
                        <span className="font-medium text-amber-800 shrink-0">×{en.quantity}</span>
                        <span className="flex-1 min-w-0 truncate text-gray-600">
                          {en.note || "No note"}{en.scannedByName ? ` · ${en.scannedByName}` : ""}
                        </span>
                        <Button
                          size="sm" variant="ghost"
                          className="h-6 px-1.5 text-gray-400 hover:text-red-600 shrink-0"
                          disabled={osEmptyBoxUndoMutation.isPending}
                          onClick={() => osEmptyBoxUndoMutation.mutate(en.id)}
                          title="Undo this empty box"
                        >
                          <Undo2 className="h-3.5 w-3.5" />
                        </Button>
                      </div>
                    ))}
                  </div>
                </div>
              )}
            </div>

            <DialogFooter>
              <Button variant="outline" onClick={() => setShowEmptyBox(false)}>Cancel</Button>
              <Button
                className="bg-amber-600 hover:bg-amber-700 text-white"
                disabled={osEmptyBoxMutation.isPending || !(Number(emptyBoxQty) >= 1)}
                onClick={() => osEmptyBoxMutation.mutate({
                  quantity: Math.max(1, Math.floor(Number(emptyBoxQty) || 1)),
                  note: emptyBoxNote.trim() || null,
                })}
              >
                {osEmptyBoxMutation.isPending ? <Loader2 className="h-4 w-4 animate-spin" /> : "Log Empty Box"}
              </Button>
            </DialogFooter>
          </DialogContent>
        </Dialog>

        {/* Multi-match selection dialog */}
        <Dialog open={!!osMultiMatch} onOpenChange={(o) => { if (!o) { setOsMultiMatch(null); resetOsConfirmation(); } }}>
          <DialogContent className="w-[calc(100%-2rem)] max-w-sm">
            <DialogHeader>
              <DialogTitle className="flex items-center gap-2 text-[#001d6e]">
                <AlertTriangle className="h-5 w-5 text-amber-500" />
                Multiple Items Found
              </DialogTitle>
              <DialogDescription className="text-left pt-1">
                Barcode{" "}
                <span className="font-mono font-semibold text-gray-700">{osMultiMatch?.barcode}</span>{" "}
                matches {osMultiMatch?.matches.length} items. Tap the item you are scanning.
              </DialogDescription>
            </DialogHeader>
            <div className="space-y-2 py-1 max-h-72 overflow-y-auto pr-1">
              {osMultiMatch?.matches.map((item) => {
                const isComplete = (item.totalScannedQty ?? 0) >= (item.expectedQty ?? 1);
                return (
                  <button
                    key={item.id}
                    onClick={() => handleOsMultiMatchSelect(item)}
                    className={`w-full rounded-lg border-2 px-4 py-3 text-left transition-colors hover:border-[#001d6e] hover:bg-[#001d6e]/5 ${
                      isComplete ? "border-amber-300 bg-amber-50" : "border-gray-200 bg-white"
                    }`}
                  >
                    <p className="font-semibold text-gray-900 text-sm leading-tight">
                      {item.itemName ?? <span className="italic text-gray-400">Unknown</span>}
                    </p>
                    <div className="flex flex-wrap items-center gap-x-3 gap-y-0.5 mt-1">
                      <span className="text-[11px] text-gray-400">
                        Expected: <span className="font-medium text-gray-600">{item.expectedQty}</span>
                      </span>
                      <span className="text-[11px] text-gray-400">
                        Scanned:{" "}
                        <span className={`font-medium ${isComplete ? "text-amber-600" : "text-emerald-600"}`}>
                          {item.totalScannedQty}
                        </span>
                      </span>
                      {isComplete && (
                        <span className="text-[11px] font-semibold text-amber-600">Complete</span>
                      )}
                    </div>
                  </button>
                );
              })}
            </div>
            <DialogFooter>
              <Button variant="outline" onClick={() => { setOsMultiMatch(null); resetOsConfirmation(); }}>Cancel</Button>
            </DialogFooter>
          </DialogContent>
        </Dialog>

        {/* Auto-confirm flash — the only visual feedback for a silently-logged scan (paired
            with playScanBeep) since there's no dialog to look at for that case. */}
        {/* z-40, below Dialog's z-50 (client/src/components/ui/dialog.tsx) — a scan right after
            this one can open the confirmation dialog while the flash is still fading, and the
            dialog must render on top, not be washed out underneath it. */}
        {osFlash === "success" && (
          <div className="fixed inset-0 z-40 pointer-events-none bg-green-400/25" />
        )}

        {/* Scan confirmation dialog */}
        <Dialog open={!!osPending} onOpenChange={(o) => { if (!o) { setOsPending(null); osPendingRef.current = null; resetOsConfirmation(); } }}>
          <DialogContent className="w-[calc(100%-2rem)] max-w-md sm:max-w-xl">
            <DialogHeader>
              <DialogTitle className={`flex items-center gap-2 ${
                !osPending?.matchedItem ? "text-red-700"
                : osItemIsComplete ? "text-amber-700"
                : "text-[#001d6e]"
              }`}>
                {!osPending?.matchedItem
                  ? <><AlertTriangle className="h-5 w-5" /> Not in order</>
                  : osItemIsComplete
                    ? <><AlertTriangle className="h-5 w-5" /> Extra item</>
                    : <><CheckCircle2 className="h-5 w-5" /> Match found</>}
              </DialogTitle>
              <div className="flex gap-3 items-start pt-1">
                {osResolvedImageName && (
                  <img
                    src={`/api/products/image-by-name?name=${encodeURIComponent(osResolvedImageName)}`}
                    alt=""
                    className="h-24 w-24 shrink-0 object-contain rounded-md bg-gray-50 border border-gray-100"
                    onError={(e) => { (e.currentTarget as HTMLImageElement).style.display = "none"; }}
                  />
                )}
                <DialogDescription className="text-left space-y-0.5 flex-1 min-w-0">
                  <p className="font-semibold text-gray-900 text-sm">{osPending?.matchedItem?.itemName ?? osPending?.inventoryProduct?.name ?? osPending?.barcode}</p>
                  <p className="font-mono text-xs text-gray-400">{osPending?.barcode}</p>
                  {!osPending?.matchedItem && (
                    <p className="text-xs text-red-600 mt-1">Not in the CSV — will be logged as extra.</p>
                  )}
                  {osItemIsComplete && (
                    <p className="text-xs text-amber-600 mt-1">Order already complete — these extra boxes will be logged separately.</p>
                  )}
                </DialogDescription>
              </div>
            </DialogHeader>

            <div className="space-y-4 py-1">
              {/* Inventory + CSV info */}
              {(osPending?.inventoryProduct || osPending?.matchedItem) && (
                <div className="rounded-md bg-gray-50 px-3 py-2 text-xs text-gray-600 space-y-1">
                  {osPending.inventoryProduct?.sapCode && (
                    <p>SAP: <span className="font-mono font-bold text-gray-700">{osPending.inventoryProduct.sapCode}</span></p>
                  )}
                  {osPending.matchedItem && (
                    <div className={`space-y-0.5 ${osPending.inventoryProduct ? "border-t border-gray-200 pt-1" : ""}`}>
                      <p>
                        Items per pallet:{" "}
                        <strong>{osPending.plantPalletSize || "—"}</strong>
                        {osPending.plantPalletSize !== (osPending.matchedItem.itemsPerPallet ?? 0) && osPending.matchedItem.itemsPerPallet ? (
                          <span className="text-blue-500 ml-1">
                            ({(() => {
                              const p = (activeOrderScanSession?.plant ?? "").toLowerCase();
                              if (p.includes("valsad") || p.includes("val")) return "VAL PLT";
                              if (p.includes("indore") || p.includes("ind")) return "IND PLT";
                              return "inventory";
                            })()})
                          </span>
                        ) : null}
                      </p>
                      <p>Expected: <strong>{osPending.matchedItem.expectedQty}</strong> · Already scanned: <strong>{osPending.matchedItem.totalScannedQty}</strong></p>
                      {(() => {
                        const remaining = Math.max(0, (osPending.matchedItem.expectedQty ?? 0) - (osPending.matchedItem.totalScannedQty ?? 0));
                        const remainingPallets = plt > 0 ? (remaining / plt).toFixed(2) : null;
                        return (
                          <p>
                            Remaining: <strong>{remaining}</strong> boxes
                            {remainingPallets != null && <> · <strong>{remainingPallets}</strong> plt</>}
                          </p>
                        );
                      })()}
                    </div>
                  )}
                </div>
              )}
               {stvs.length > 0 && (
                <div className="space-y-1">
                  <Label className="text-sm">STV <span className="text-red-500">*</span></Label>
                  <Select
                    value={osSelectedStv || NO_STV}
                    onValueChange={(v) => {
                      const nextValue = v === NO_STV ? "" : v;
                      setOsSelectedStv(nextValue);
                    }}
                  >
                    <SelectTrigger className={`w-full ${!osSelectedStv ? "border-dashed text-gray-400" : ""}`}>
                      <SelectValue placeholder="Select STV…" />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value={NO_STV}>— Select STV —</SelectItem>
                      {stvs.map((s) => (
                        <SelectItem key={s} value={s}>{s}</SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </div>
              )}
              
              {/* Qty input — editing boxes recalculates pallets */}
              <div className="space-y-1">
                <Label className="text-sm">Qty (boxes)</Label>
                <Input
                  data-gun-qty="os"
                  type="number" min={0}
                  value={osQty === 0 ? "" : osQty}
                  onChange={(e) => {
                    const q = parseInt(e.target.value) || 0;
                    setOsQty(q);
                    setOsPalletsInput(plt > 0 ? (q / plt).toFixed(2) : "");
                  }}
                  onBlur={(e) => {
                    if (!e.target.value || parseInt(e.target.value) < 1) {
                      setOsQty(1);
                      setOsPalletsInput(plt > 0 ? (1 / plt).toFixed(2) : "");
                    }
                  }}
                  onKeyDown={(e) => {
                    if (e.key === "Enter") {
                      e.preventDefault();
                      handleOsConfirmScan();
                    }
                  }}
                  className="text-center text-3xl font-bold h-14"
                  autoFocus
                />
              </div>

              {/* Pallets input — editing pallets recalculates boxes (2-way conversion) */}
              {plt > 1 && (
                <div className="rounded-md bg-[#001d6e]/5 border border-[#001d6e]/20 px-4 py-3 flex items-center justify-between gap-3">
                  <div className="flex-1">
                    <Label className="text-xs text-gray-500">Pallets</Label>
                    <Input
                      type="number" min={0} step="0.01"
                      value={osPalletsInput}
                      onChange={(e) => {
                        const raw = e.target.value;
                        setOsPalletsInput(raw);
                        const p = parseFloat(raw);
                        if (!isNaN(p) && p >= 0) setOsQty(Math.round(p * plt));
                      }}
                      onBlur={() => {
                        if (osPalletsInput === "" || isNaN(parseFloat(osPalletsInput))) {
                          setOsPalletsInput((osQty / plt).toFixed(2));
                        }
                      }}
                      onKeyDown={(e) => {
                        if (e.key === "Enter") {
                          e.preventDefault();
                          handleOsConfirmScan();
                        }
                      }}
                      className="text-2xl font-bold text-[#001d6e] h-11 bg-white"
                    />
                  </div>
                  <div className="text-right shrink-0">
                    <p className="text-xs text-gray-500">Pallet size</p>
                    <p className="text-lg font-semibold text-gray-700">{plt} <span className="text-xs font-normal text-gray-400">boxes</span></p>
                  </div>
                </div>
              )}
            </div>

            <DialogFooter className="gap-2">
              <Button variant="outline" onClick={() => { setOsPending(null); osPendingRef.current = null; resetOsConfirmation(); }}>
                Cancel
              </Button>
              <Button
                onClick={handleOsConfirmScan}
                disabled={osScanMutation.isPending || (stvs.length > 0 && !osSelectedStv)}
                className={(!osPending?.matchedItem || osItemIsComplete)
                  ? "bg-amber-600 hover:bg-amber-700 text-white"
                  : "bg-[#001d6e] hover:bg-[#00154b] text-white"}
              >
                {osScanMutation.isPending && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
                {(!osPending?.matchedItem || osItemIsComplete) ? "Log as Extra" : "Confirm Scan"}
              </Button>
            </DialogFooter>
          </DialogContent>
        </Dialog>

        {/* Admin manual "Complete Part" — works regardless of scan % (shortfall can be
            reconciled against a later part via the combined-report FIFO adjustment) */}
        <Dialog open={showForceComplete} onOpenChange={(o) => { if (!o) setShowForceComplete(false); }}>
          <DialogContent className="max-w-sm">
            <DialogHeader>
              <DialogTitle>Complete this part?</DialogTitle>
              <DialogDescription className="space-y-1 pt-1">
                <p>
                  <span className="font-semibold text-gray-900">{stripCsvExt(activeOrderScanSession?.csvFileName)}</span> — {osDoneCount} of {osTotalCount} items fully scanned.
                </p>
                {osDoneCount < osTotalCount && (
                  <p className="text-amber-600 text-sm">
                    {osTotalCount - osDoneCount} item(s) are still short. Completing now is fine if the remainder is expected in a later part — it'll be reconciled in the Combined Report.
                  </p>
                )}
              </DialogDescription>
            </DialogHeader>
            <DialogFooter className="gap-2">
              <Button variant="outline" onClick={() => setShowForceComplete(false)} disabled={osCompleteMutation.isPending}>
                Cancel
              </Button>
              <Button
                onClick={() => osCompleteMutation.mutate()}
                disabled={osCompleteMutation.isPending}
                className="bg-emerald-600 hover:bg-emerald-700 text-white"
              >
                {osCompleteMutation.isPending && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
                Complete Part
              </Button>
            </DialogFooter>
          </DialogContent>
        </Dialog>

      </div>
          </div>
        </div>
    );
  }

  return (
    <div className={`flex-1 overflow-y-auto bg-white p-4 lg:p-6 ${osRotated ? "kiosk-rotate-90" : ""}`}>
      <RotateToggleButton />
      <div className="mx-auto max-w-7xl space-y-4">
        <CameraPermissionBanner onPermissionGranted={() => toast({ title: "Camera Permission Granted", description: "You can now start scanning. Click 'New Scan Order' to begin." })} />

        {/* Greeting Header */}
        <div className="rounded-xl bg-gradient-to-r from-[#001d6e] to-[#1a3a9c] px-4 py-3 shadow-md">
          <div className="flex flex-wrap items-center justify-between gap-3">
            <div className="flex items-center gap-3">
              <div className="h-10 w-10 rounded-full bg-white/20 border-2 border-white/40 flex items-center justify-center text-white font-bold text-base shrink-0 select-none">
                {(currentUser?.name || currentUser?.username || "U").split(" ").map((w: string) => w[0] ?? "").join("").slice(0, 2).toUpperCase()}
              </div>
              <div>
                <p className="text-blue-200 text-xs font-medium">
                  {(() => { const h = new Date().getHours(); return h >= 5 && h < 12 ? "Good Morning" : h >= 12 && h < 17 ? "Good Afternoon" : h >= 17 && h < 21 ? "Good Evening" : "Welcome Back"; })()}!
                </p>
                <h1 className="text-lg font-bold text-white leading-tight">
                  {currentUser?.name || currentUser?.username || "User"}
                </h1>
                <p className="text-blue-300 text-[11px]">
                  {new Date().toLocaleDateString(undefined, { weekday: "long", year: "numeric", month: "long", day: "numeric" })}
                </p>
              </div>
            </div>
            <div className="flex items-center gap-2">
              <Button variant="outline" onClick={() => navigate("/")} className="h-8 px-3 text-xs border-white/40 bg-white/10 text-white hover:bg-white/20 hover:text-white">
                <ArrowLeft className="mr-1.5 h-3.5 w-3.5" />Home
              </Button>
            </div>
          </div>
        </div>

        {/* ── DISPATCH USER DASHBOARD ─────────────────────────────── */}
        {isDispatchUser ? (
          <div className="space-y-4">

            {/* Stats row — horizontal inline cells like reference */}
            <div className="bg-white rounded-xl shadow-sm border border-gray-100 overflow-hidden">
              <div className="grid grid-cols-3 divide-x divide-gray-100">
                <div className="flex items-center gap-3 p-5">
                  <div className="h-11 w-11 rounded-full bg-blue-50 flex items-center justify-center shrink-0">
                    <ScanLine className="h-5 w-5 text-[#001d6e]" />
                  </div>
                  <div>
                    <p className="text-sm font-semibold text-gray-500 uppercase tracking-wide">Active Orders</p>
                    <p className="text-4xl font-bold text-gray-900 leading-tight">
                      {osAllSessions.filter((s: any) => s.scanStatus === "active").length}
                    </p>
                    <p className="text-sm text-gray-400">in progress</p>
                  </div>
                </div>
                <div className="flex items-center gap-3 p-5">
                  <div className="h-11 w-11 rounded-full bg-emerald-50 flex items-center justify-center shrink-0">
                    <CheckCircle2 className="h-5 w-5 text-emerald-600" />
                  </div>
                  <div>
                    <p className="text-sm font-semibold text-gray-500 uppercase tracking-wide">Completed</p>
                    <p className="text-4xl font-bold text-gray-900 leading-tight">
                      {osAllSessions.filter((s: any) => s.scanStatus === "completed").length}
                    </p>
                    <p className="text-sm text-gray-400">orders done</p>
                  </div>
                </div>
                <div className="flex items-center gap-3 p-5">
                  <div className="h-11 w-11 rounded-full bg-indigo-50 flex items-center justify-center shrink-0">
                    <PackageCheck className="h-5 w-5 text-indigo-600" />
                  </div>
                  <div>
                    <p className="text-sm font-semibold text-gray-500 uppercase tracking-wide">Boxes Scanned</p>
                    <p className="text-4xl font-bold text-gray-900 leading-tight">{dispatchHistory?.totalBoxes ?? 0}</p>
                    <p className="text-sm text-gray-400">scanned by you</p>
                  </div>
                </div>
              </div>
            </div>

            {/* Scan History Table */}
            <div className="bg-white rounded-xl shadow-sm border border-gray-200 overflow-hidden">
              {/* Navy header bar — title only */}
              <div className="flex items-center gap-2.5 px-4 sm:px-5 py-3 bg-[#ffff]">
                <History className="h-4 w-4 text-[#001d6e] shrink-0" />
                <div className="flex-1 min-w-0">
                  <p className="text-xl font-bold text-[#001d6e] leading-tight  tracking-wide">
                    {showAllHistory ? "All My Scans" : "Recent Scans"}
                  </p>
                  <p className="text-[10px] text-[#001d6e]/70 leading-none mt-0.5">
                    {!showAllHistory ? "Last 10 entries" : `${dispatchHistory?.total ?? 0} total`}
                  </p>
                </div>
                {dispatchHistoryFetching && <Loader2 className="h-3.5 w-3.5 animate-spin text-blue-300 shrink-0" />}
              </div>

              {/* Empty state */}
              {!dispatchHistoryFetching && (!dispatchHistory?.items?.length) && (
                <div className="py-14 text-center">
                  <History className="h-8 w-8 text-gray-200 mx-auto mb-2" />
                  <p className="text-sm text-gray-400">No scan history found.</p>
                </div>
              )}

              {/* Table */}
              {(dispatchHistory?.items?.length ?? 0) > 0 && (
                <div className="overflow-x-auto" style={{ WebkitOverflowScrolling: "touch" }}>
                  <table className="w-full border-collapse text-xs">
                    <thead>
                      <tr className="bg-[#001d6e]">
                        <th className="sticky top-0 bg-[#001d6e] px-3 py-2.5 text-left text-[11px] font-semibold uppercase tracking-wide text-white border-r border-[#1a3a9c] w-8">#</th>
                        <th className="sticky top-0 bg-[#001d6e] px-3 py-2.5 text-left text-[11px] font-semibold uppercase tracking-wide text-white border-r border-[#1a3a9c] min-w-[220px]">Item Name</th>
                        <th className="sticky top-0 bg-[#001d6e] px-3 py-2.5 text-left text-[11px] font-semibold uppercase tracking-wide text-white border-r border-[#1a3a9c]">Barcode</th>
                        <th className="sticky top-0 bg-[#001d6e] px-3 py-2.5 text-center text-[11px] font-semibold uppercase tracking-wide text-white border-r border-[#1a3a9c]">Qty</th>
                        <th className="sticky top-0 bg-[#001d6e] px-3 py-2.5 text-left text-[11px] font-semibold uppercase tracking-wide text-white border-r border-[#1a3a9c]">Order</th>
                        <th className="sticky top-0 bg-[#001d6e] px-3 py-2.5 text-left text-[11px] font-semibold uppercase tracking-wide text-white">Scanned At</th>
                      </tr>
                    </thead>
                    <tbody>
                      {dispatchHistory!.items.map((ev: any, idx: number) => {
                        const isOdd = idx % 2 !== 0;
                        return (
                          <tr key={ev.id ?? idx} className={`border-b border-gray-100 hover:bg-[#001d6e]/[0.03] transition-colors ${isOdd ? "bg-slate-50" : "bg-white"}`}>
                            <td className="px-3 py-2 text-xs text-gray-400 font-mono border-r border-gray-100">
                              {(showAllHistory ? historyPage * 10 : 0) + idx + 1}
                            </td>
                            <td className="px-3 py-2 border-r border-gray-100">
                              <p className="text-gray-800 font-medium min-w-[220px] max-w-[320px] whitespace-normal break-words text-xs">{ev.itemName ?? "—"}</p>
                            </td>
                            <td className="px-3 py-2 font-mono text-xs text-gray-500 border-r border-gray-100">{ev.barcode ?? "—"}</td>
                            <td className="px-3 py-2 text-center border-r border-gray-100">
                              <span className="inline-flex items-center justify-center rounded-full bg-[#001d6e]/10 text-[#001d6e] text-[11px] font-bold px-2 py-0.5">
                                {ev.totalQty ?? ev.quantity ?? 0}
                              </span>
                            </td>
                            <td className="px-3 py-2 text-xs text-gray-500 max-w-[130px] truncate border-r border-gray-100">{ev.orderName ?? "—"}</td>
                            <td className="px-3 py-2 text-xs text-gray-400 whitespace-nowrap">
                              {ev.scannedAt ? new Date(ev.scannedAt).toLocaleString(undefined, { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" }) : "—"}
                            </td>
                          </tr>
                        );
                      })}
                    </tbody>
                  </table>
                </div>
              )}

              {/* Footer — pagination + View All / Recent Only toggle */}
              <div className="flex items-center justify-between border-t border-gray-100 px-4 sm:px-5 py-2.5 bg-gray-50">
                {showAllHistory && (dispatchHistory?.total ?? 0) > 0 ? (
                  <>
                    <span className="text-xs text-gray-500">
                      {historyPage * 10 + 1}–{Math.min((historyPage + 1) * 10, dispatchHistory?.total ?? 0)} of {dispatchHistory?.total}
                    </span>
                    <div className="flex items-center gap-2">
                      <div className="flex gap-1">
                        <Button size="sm" variant="outline" className="h-7 w-7 p-0 border-gray-200" disabled={historyPage === 0} onClick={() => setHistoryPage((p) => p - 1)}>
                          <ChevronLeft className="h-3.5 w-3.5" />
                        </Button>
                        <span className="flex items-center px-2 text-xs text-gray-600 font-medium">
                          {historyPage + 1}/{Math.ceil((dispatchHistory?.total ?? 0) / 10)}
                        </span>
                        <Button size="sm" variant="outline" className="h-7 w-7 p-0 border-gray-200" disabled={(historyPage + 1) * 10 >= (dispatchHistory?.total ?? 0)} onClick={() => setHistoryPage((p) => p + 1)}>
                          <ChevronRight className="h-3.5 w-3.5" />
                        </Button>
                      </div>
                      <Button variant="outline" size="sm" className="h-7 px-2.5 text-xs border-gray-200 text-gray-600" onClick={() => { setShowAllHistory(false); setHistoryPage(0); }}>
                        <ChevronLeft className="h-3 w-3 mr-1" />Recent Only
                      </Button>
                    </div>
                  </>
                ) : (
                  <>
                    <span className="text-xs text-gray-400">{(dispatchHistory?.items?.length ?? 0)} entries shown</span>
                    <Button size="sm" className="h-7 px-3 text-xs bg-[#001d6e] hover:bg-[#001552] text-white font-semibold" onClick={() => { setShowAllHistory(true); setHistoryPage(0); }}>
                      View All
                    </Button>
                  </>
                )}
              </div>
            </div>
          </div>

        ) : (
          /* ── REGULAR USER: no active order-scan session for their plant right now ── */
          <div className="bg-white rounded-xl shadow-sm border border-gray-100 overflow-hidden py-20 text-center">
            <ScanLine className="h-10 w-10 text-gray-200 mx-auto mb-3" />
            <p className="text-gray-500 font-medium">No active scan session right now</p>
            <p className="text-sm text-gray-400 mt-1">An admin needs to activate a CSV for your plant before you can start scanning.</p>
          </div>
        )}
      </div>
    </div>
  );
}
