import { Fragment, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { format } from "date-fns";
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
  Scan,
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
import { PlantBadge } from "@/components/PlantBadge";
import { apiRequest } from "@/lib/queryClient";
import { useToast } from "@/hooks/use-toast";
import { useUser } from "@/hooks/use-user";
import { hasPageWriteAccess } from "@/lib/permissions";
import { useLocation } from "wouter";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Progress } from "@/components/ui/progress";
import { DataTable, DATA_TABLE_TOTALS_ROW, type DataTableColumn } from "@/components/ui/data-table";
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
  mpPlt?: number | null;   // Madhya Pradesh pallet qty (was indPlt)
  gjPlt?: number | null;   // Gujarat pallet qty (was valPlt)
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
  lastScannedAt?: string | null;
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
  // Server-side latest scan touch for this barcode — correct across reloads and other devices,
  // used as a fallback for osScanSeqRef (this client's own instant feedback) when sorting.
  _lastScannedAt?: string | null;
};
type ImpSession = {
  id: number; plant: string; csvFileName: string; rowCount: number;
  importedByName: string | null; createdAt: string | null; scanStatus: string;
  orderDate: string | null; totalQty: number; totalPallets: number;
};
type ImpItem = {
  id: number; barcode: string | null; itemName: string | null;
  sapCode: string | null; quantity: number | null; expectedPallets: number | null;
  scannedQty: number | null; scanStatus: string | null;
  extraQty: number | null; lastScannedAt: string | null;
};

// ─── Helpers ───────────────────────────────────────────────────────────────

function scanFmtIST(dt: string | null | undefined): string {
  if (!dt) return "—";
  const s = String(dt);
  const d = new Date(/Z$|[+-]\d{2}:\d{2}$/.test(s) ? s : s.replace(" ", "T") + "Z");
  if (isNaN(d.getTime())) return "—";
  return d.toLocaleString("en-IN", { timeZone: "UTC" });
}

// Order date — a bare "YYYY-MM-DD" (order_import_sessions.orderDate is a text column, not a
// timestamp), so parsed by hand from its Y/M/D parts rather than through `new Date(string)`,
// which is timezone-sensitive for date-only strings and would risk shifting it a day off.
function scanFmtOrderDate(d: string | null | undefined): string {
  if (!d) return "—";
  const s = String(d).slice(0, 10);
  const [y, m, day] = s.split("-").map(Number);
  if (!y || !m || !day) return s;
  const dt = new Date(y, m - 1, day);
  if (isNaN(dt.getTime())) return s;
  return dt.toLocaleDateString("en-IN", { day: "2-digit", month: "short", year: "numeric" });
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

const pltCell = (qty: number, ipp: number, className: string) =>
  qty > 0 && ipp > 0
    ? <span className={className}>{(qty / ipp).toFixed(2)}</span>
    : <span className="text-gray-300">0.00</span>;

/**
 * Column order for one table, remembered for the browser session — drag a column's header onto
 * another to move it. Session-scoped, like the filters: a rearranged table is working context for
 * this sitting, not a permanent preference. An empty array means "declared order".
 */
function useColumnOrder(storageKey: string) {
  const [order, setOrder] = useState<string[]>(() => {
    try {
      const parsed = JSON.parse(sessionStorage.getItem(storageKey) ?? "[]");
      return Array.isArray(parsed) ? parsed : [];
    } catch {
      return [];
    }
  });
  useEffect(() => {
    try { sessionStorage.setItem(storageKey, JSON.stringify(order)); } catch { /* storage unavailable */ }
  }, [storageKey, order]);
  return [order, setOrder] as const;
}

// Kiosk rotation steps — a full turn, so a screen mounted at any angle can be matched. The button
// walks these in order and wraps back to 0.
const ROTATIONS = [0, 90, 180, 270] as const;
type Rotation = (typeof ROTATIONS)[number];

// Radix renders dialogs/dropdowns into document.body, outside the rotated container, so each needs
// the matching turn applied by hand or it opens upright while everything behind it is rotated.
function portalRotateClass(rotation: Rotation): string {
  return rotation === 90 ? "rotate-90" : rotation === 180 ? "rotate-180" : rotation === 270 ? "-rotate-90" : "";
}

// Totals-row counterpart to pltCell: each row contributes qty ÷ ITS OWN pallet size, then those
// are added up — never one blended pallet size applied to a combined quantity, which would be
// wrong for any table mixing items with different pack sizes.
const pltTotal = <T,>(rows: T[], pick: (row: T) => { qty: number; ipp: number }) =>
  rows
    .reduce((sum, row) => {
      const { qty, ipp } = pick(row);
      return ipp > 0 ? sum + qty / ipp : sum;
    }, 0)
    .toFixed(2);

// The desktop tables get their totals row from the shared DataTable. The mobile card lists and
// the rotated-kiosk / portrait tables are hand-built, so they total up through here instead —
// same rule as pltTotal for the pallet figures, and always over the rows actually on screen so
// the line adds up to the column above it.
type KioskTotals = {
  exp: number; done: number; remain: number; extra: number;
  expPlt: number; donePlt: number; remainPlt: number; extraPlt: number;
};
const sumKioskTotals = <T,>(
  rows: T[],
  pick: (row: T) => { exp: number; done: number; remain: number; extra: number; ipp: number },
): KioskTotals =>
  rows.reduce<KioskTotals>(
    (acc, row) => {
      const { exp, done, remain, extra, ipp } = pick(row);
      acc.exp += exp;
      acc.done += done;
      acc.remain += remain;
      acc.extra += extra;
      if (ipp > 0) {
        acc.expPlt += exp / ipp;
        acc.donePlt += done / ipp;
        acc.remainPlt += remain / ipp;
        acc.extraPlt += extra / ipp;
      }
      return acc;
    },
    { exp: 0, done: 0, remain: 0, extra: 0, expPlt: 0, donePlt: 0, remainPlt: 0, extraPlt: 0 },
  );

// Hand-built totals lines borrow the DataTable's own totals styling rather than redefining it, so
// the rotated/mobile views and the desktop tables stay one design.
const KIOSK_TOTALS_ROW = DATA_TABLE_TOTALS_ROW;

// Pins the hand-built totals row to the bottom of its table's scroll box, the way the DataTable
// pins its own. The background has to live on the CELLS, not the <tr>: a row background paints at
// the row's natural position and does not travel with sticky cells, so a bare <tr> tint would be
// left behind and the rows would scroll through in the clear. The top rule is repeated as an inset
// shadow for the same reason the DataTable repeats it — a border-collapse table drops a sticky
// cell's own border while it is stuck.
const KIOSK_TOTALS_CELL_PINNED =
  "sticky bottom-0 z-[5] bg-[#f5f6f9] shadow-[inset_0_2px_0_0_rgba(0,29,110,0.2)]";

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
// Remembers which plant's active session the operator was last on, so returning to the Scan
// page (or reloading) defaults back to that plant instead of always the first active session.
const OS_LAST_PLANT_KEY = "km-finny.scan.lastPlant";
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

// Closes/collapses something (a search box, an expanded row) as soon as a press lands outside
// the returned ref's container — e.g. clicking anywhere else on the page hides an open search
// bar instead of requiring an explicit cancel. `active` gates the listener so it's only attached
// while there's actually something open to close. Uses `pointerdown` (fires before the target's
// own `onClick`, and — unlike `mousedown` — fires consistently for touch taps too, not just a
// mouse), so clicking/tapping the toggle button itself is seen as "inside" and only that
// button's own handler runs — no double-toggle. Desktop/mobile both render their own markup for
// the same tab (one hidden via CSS, not unmounted), so each needs its OWN ref/hook instance;
// `offsetParent === null` (a reliable display:none check) skips the click-outside check
// entirely for whichever instance's container isn't the one actually visible right now —
// otherwise the hidden instance would see every press as "outside" and fire spuriously.
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

// ─── Component ─────────────────────────────────────────────────────────────

export default function ScanOrderPage() {
  const { toast } = useToast();
  const { user: currentUser } = useUser();
  const [, navigate] = useLocation();
  // Anyone can complete a part EXCEPT designations "Loader"/"Helper"/"Driver"/"Scanner" (exact
  // match) — those are physical/operational roles who shouldn't be the ones deciding to close
  // an order out. Admin/super-admin always allowed regardless of designation.
  const userDesignation = String((currentUser as any)?.designation || "").toLowerCase().trim();
  const isAdminOrSuperUser = ["admin", "super-admin"].includes(((currentUser as any)?.role ?? "").toLowerCase());
  const canCompletePart = isAdminOrSuperUser || !["loader", "helper", "driver", "scanner"].includes(userDesignation);
  // The simplified Dispatch Dashboard replaces the normal scanning UI for designation
  // "Scanner" (exact match) only — no longer department-name-based ("Dispatch Valsad" etc.).
  // Admin/super-admin always get the full scanning interface regardless of designation.
  const isDispatchUser = !isAdminOrSuperUser && userDesignation === "scanner";
  // Write access for the actual scanning actions (barcode scan, Empty Box) — server already
  // enforces this (requirePageWrite('scan-order')); this just makes the buttons themselves
  // reflect it instead of showing fully-clickable controls that would 403 for a view-only user.
  const canScanWrite = isAdminOrSuperUser || hasPageWriteAccess("scan-order");
  const queryClient = useQueryClient();

  // ── Master View / Separate CSVs tab state ────────────────────────────────
  const [osTab, setOsTab] = useState<"scan" | "master-view" | "separate-csvs">("master-view");
  const [mvSearch,    setMvSearch]    = useState("");
  // Desktop Master View search — collapsed by default (just an icon button); clicking it
  // reveals the field inline in the plant-name row.
  const [mvSearchOpen, setMvSearchOpen] = useState(false);
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

  const [csvExpId,    setCsvExpId]    = useState<number | null>(null);
  const [csvSearch,   setCsvSearch]   = useState("");
  // Desktop Part Order search — collapsed by default (icon-only toggle), matching Scan/Master View.
  const [csvSearchOpen, setCsvSearchOpen] = useState(false);
  // Part Order's own date filter — "" means "follow the currently active order" (the old, only
  // behavior). Setting it lets the operator browse a different day's uploaded CSVs (still
  // scoped to the active order's plant) without leaving Scan Order or disturbing the active
  // scanning session.
  const [csvDate, setCsvDate] = useState("");
  const resetCsvBrowse = () => { setCsvDate(""); setCsvExpId(null); setCsvSearch(""); };

  const [showAllHistory, setShowAllHistory] = useState(false);
  const [historyPage, setHistoryPage] = useState(0);

  // ── Kiosk rotation — for a screen mounted at any angle, not just portrait. The button steps
  // 0° → 90° → 180° → 270° → 0°, a full turn, so a screen mounted upside-down or turned the other
  // way is reachable instead of only the one quarter turn the old on/off toggle offered.
  // Remembered across reloads (localStorage) since a mounted kiosk stays in the same physical
  // orientation indefinitely. See .kiosk-rotate-* in index.css for the actual rotate mechanics.
  const [osRotation, setOsRotation] = useState<Rotation>(() => {
    const saved = Number(localStorage.getItem("scanOrderRotation"));
    if ((ROTATIONS as readonly number[]).includes(saved)) return saved as Rotation;
    // Carry over the older true/false flag so an already-mounted kiosk keeps its orientation.
    return localStorage.getItem("scanOrderRotated") === "true" ? 90 : 0;
  });
  useEffect(() => {
    localStorage.setItem("scanOrderRotation", String(osRotation));
  }, [osRotation]);
  const osRotateNext = () =>
    setOsRotation((r) => ROTATIONS[(ROTATIONS.indexOf(r) + 1) % ROTATIONS.length]);
  const osRotated = osRotation !== 0;
  // A quarter turn swaps the screen's axes — what the CSS calls height then runs along the
  // viewport's width. Anything sized in vh/vw has to know which case it's in; a half turn leaves
  // the axes alone and only flips the content.
  const osQuarterTurn = osRotation === 90 || osRotation === 270;
  const kioskRotateClass = osRotated ? `kiosk-rotate-${osRotation}` : "";
  const osPortalRotate = portalRotateClass(osRotation);
  // Natural portrait orientation (window taller than wide) — a laptop/tablet held or resized to
  // portrait should get the same single-column, larger-text layout as the manual Rotate mode,
  // just WITHOUT the 90° kiosk rotation (the screen is already upright).
  const [isPortrait, setIsPortrait] = useState(
    () => typeof window !== "undefined" && window.matchMedia("(orientation: portrait)").matches,
  );
  useEffect(() => {
    const mq = window.matchMedia("(orientation: portrait)");
    const onChange = () => setIsPortrait(mq.matches);
    mq.addEventListener("change", onChange);
    return () => mq.removeEventListener("change", onChange);
  }, []);
  // Drives the compact single-column layout + larger sizing (manual rotate OR natural portrait).
  // The actual 90° CSS rotation stays tied to osRotated only.
  const bigView = osRotated || isPortrait;

  // Scroll frame for the hand-built kiosk/portrait tables. These used to just flow down the page,
  // leaving them with no scrollbar of their own and nothing for a totals row to pin against. In
  // bigView they now get a bounded, self-scrolling box — the same treatment the desktop DataTable
  // gives its tables — so the header holds at the top, the totals row holds at the bottom, and
  // there's a visible bar (kiosk-scroll) to drag.
  // The unit flips on a QUARTER turn: that turns the subtree 90°, so content-space height runs
  // along the viewport's WIDTH — vw there, vh when upright, half-turned, or naturally portrait.
  const kioskTableBoxClass = bigView
    ? `overflow-auto kiosk-scroll ${osQuarterTurn ? "max-h-[62vw]" : "max-h-[62vh]"}`
    : "hidden overflow-x-auto min-[480px]:block landscape:block";
  const RotateToggleButton = () => (
    <button
      onClick={() => osRotateNext()}
      className="fixed bottom-4 right-4 z-[60] flex items-center gap-2 rounded-full bg-[#001d6e] px-4 py-3 text-white shadow-lg transition-colors hover:bg-[#00154b]"
      title={`Rotate the screen (now ${osRotation}°) — steps a quarter turn each press, back to 0° after 270°`}
    >
      <RotateCw className="h-5 w-5" />
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
      if (osSelectedSessionId != null) {
        const picked = list.find((s) => s.id === osSelectedSessionId);
        if (picked) return picked;
      }
      // No explicit pick yet this load — default to whichever plant the operator was on last
      // (remembered across page visits/reloads via OS_LAST_PLANT_KEY), falling back to the
      // first active session if that plant isn't actively being scanned right now.
      let lastPlant: string | null = null;
      try { lastPlant = localStorage.getItem(OS_LAST_PLANT_KEY); } catch { /* private mode */ }
      const remembered = lastPlant
        ? list.find((s) => (s.plant ?? "").toUpperCase() === lastPlant!.toUpperCase())
        : null;
      return remembered ?? list[0];
    }
    // Fallback to the singular endpoint (covers the moment active-sessions hasn't
    // resolved yet on first load) so behavior is identical to before this existed.
    return orderScanNotif?.active ? orderScanNotif.session : null;
  })();

  // Shared by both the mobile and desktop plant-switch dropdowns — picks the session AND
  // remembers its plant so the next visit to this page defaults back to it.
  const selectPlantSession = (sessionId: number, plantName: string | null | undefined) => {
    setOsSelectedSessionId(sessionId);
    if (plantName) {
      try { localStorage.setItem(OS_LAST_PLANT_KEY, plantName); } catch { /* private mode */ }
    }
    setOsSearch("");
    setMvSearch("");
  };

  // Options for the plant-switch dropdown in the session header — always shown (not just
  // when 2+ plants are simultaneously active), so it falls back to a single-entry list built
  // from activeOrderScanSession itself when osActiveSessions hasn't resolved yet or only has
  // the one plant. Keeps the dropdown populated (and never empty) in every case.
  const osPlantSwitchOptions = (osActiveSessions && osActiveSessions.length > 0)
    ? osActiveSessions
    : (activeOrderScanSession ? [activeOrderScanSession] : []);

  // Plant config (colors + the scan behavior toggles like Auto Scan). Small, cacheable list;
  // we look up the active session's plant by name to read its per-plant flags. Auto Scan
  // being off (or the plant not found) falls through to the classic always-confirm flow.
  const { data: allPlants } = useQuery<any[]>({
    queryKey: ["/api/plants"],
    queryFn: () => apiRequest("GET", "/api/plants").then((r) => r.json()),
    staleTime: 60000,
  });
  // Plant Management's configured colors for a plant — same source/lookup PlantBadge itself
  // uses, so the plant-switch dropdown's trigger/options are colored consistently with every
  // other plant badge in the app instead of a flat, uncolored dropdown.
  const getPlantColorCfg = (plantName: string | null | undefined) => {
    const name = (plantName ?? "").trim().toUpperCase();
    if (!name || !allPlants) return null;
    return allPlants.find((p) => String(p.name ?? "").trim().toUpperCase() === name) ?? null;
  };
  // Pallet size is a per-STATE fact (see products.mpPlt/gjPlt), not per-plant — a plant just
  // knows which state it's in (plants.state, set on the Plant Management page). Replaces the
  // old plant-name string-guessing ("valsad"/"indore" substring checks).
  const getPlantState = (plantName: string): string | null => {
    const name = (plantName ?? "").trim().toLowerCase();
    if (!name || !allPlants) return null;
    const match = allPlants.find((p) => String(p.name ?? "").trim().toLowerCase() === name);
    const state = match?.state;
    return state ? String(state).trim().toUpperCase() : null;
  };
  // Only GJ PLT / MP PLT count as a "defined" pallet size — itemsPerPallet ("Packets" in the
  // Product Master UI) and the generic "pallets" column are a different concept and are no
  // longer treated as an equivalent fallback. Callers fall back to the item's own expected
  // quantity when this returns 0 (see _computePlantPalletSize and the Master View merge below).
  const getStatePalletSize = (product: Product | null, stateCode: string | null): number => {
    if (!product) return 0;
    if (stateCode === "GJ") return Number(product.gjPlt) || 0;
    if (stateCode === "MP") return Number(product.mpPlt) || 0;
    return 0;
  };
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

  // Part Order CAN browse a different day — csvDate (blank by default) falls back to the
  // active order's own date. Always scoped to the active order's plant.
  const csvEffDate  = csvDate || mvDate;
  const csvEffPlant = mvPlant;
  const csvBrowsingOtherDate = csvEffDate !== mvDate;

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
  // Tracks whether THIS scan's product image failed to load, so the image panel can hide via
  // React state instead of an onError handler reaching into the DOM directly. The dialog stays
  // mounted across back-to-back scans (its `open` prop never toggles false in between), so the
  // <img> node persists too — a prior imperative `parentElement.style.display = "none"` would
  // never get cleared and would wrongly keep hiding every later scan's image, even ones that
  // load fine. Resetting this on every new osPending fixes that.
  const [osImageFailed, setOsImageFailed] = useState(false);
  useEffect(() => { setOsImageFailed(false); }, [osPending]);
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
    if (prev !== null && id !== null && prev !== id) {
      setOsSelectedStv("");
      // A genuinely new active order loaded — snap Part Order's date browse back to following
      // it, so switching orders doesn't leave the operator stranded looking at whatever other
      // date they'd browsed to under the previous order.
      setCsvDate("");
      setCsvExpId(null);
    }
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
  // list has actually loaded, so a slow fetch never wipes a valid pick. Also defaults the
  // selection to the first STV in the list when nothing is picked yet (fresh session, or just
  // cleared by the check above) — scanning is blocked until an STV is chosen anyway (see
  // handleOsBarcode), so pre-selecting the first one saves that manual pick every time.
  useEffect(() => {
    const stvs = osStvsQuery.data;
    if (!stvs || stvs.length === 0) return;
    if (osSelectedStv && !stvs.includes(osSelectedStv)) { setOsSelectedStv(""); return; }
    if (!osSelectedStv) setOsSelectedStv(stvs[0]);
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
      // scan on a real CSV row, no status check: partial, completing, or an extra logged onto
      // an already-received row all float it to the top the same way. A "not in order" extra
      // has no matched row, so nothing to reorder.
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
    const state = getPlantState(activeOrderScanSession?.plant ?? "");
    // firstMatch.itemsPerPallet is a server-resolved snapshot (same GJ/MP-PLT-or-expectedQty
    // rule — see resolvePalletSizeOrQty in order-scan.ts); a fresh invProduct lookup here only
    // overrides it when GJ/MP PLT is genuinely defined, so a just-edited Product Master value
    // is reflected before the next server round-trip re-resolves and stores it.
    let size = firstMatch?.itemsPerPallet || firstMatch?.expectedQty || 1;
    if (invProduct) {
      const fromInv = getStatePalletSize(invProduct, state);
      if (fromInv > 0) size = fromInv;
    }
    return Math.max(1, size || 1);
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

  const handleOsBarcode = (rawBarcode: string) => {
    // Trimmed once, right at the funnel both the barcode gun and camera scanner feed into —
    // normalize() below already trims for internal matching, but the RAW value is what gets
    // held in state and eventually sent to the server, and a stray leading/trailing space
    // there becomes a permanently different barcode as far as product_plant_stock is concerned
    // (it's keyed on the literal string), silently splitting stock into an orphaned row.
    const barcode = rawBarcode.trim();
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

  // Shows a big, hard-to-miss "Part Complete" popup for 14s whenever a part finishes —
  // whether via this manual button, Auto Complete firing mid-scan, or the stale-part sweep
  // after a new CSV upload. Driven entirely by the WS 'part-completed' message (see the WS
  // effect below) so all three trigger paths are handled uniformly, without needing separate
  // client logic for "I just clicked Complete" vs "the server completed something on its own."
  // Also carries what CSV/part the plant switched TO (nextCsvFileName/nextPartIndex), so the
  // same popup answers "what just finished" AND "what am I scanning now" in one glance —
  // the two things that matter most the instant the active CSV changes underneath you.
  const [osPartCompleteBanner, setOsPartCompleteBanner] = useState<{
    kind: 'completed' | 'reopened';
    csvFileName: string; partIndex: number;
    nextCsvFileName: string | null; nextPartIndex: number | null;
  } | null>(null);
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
            setOsPartCompleteBanner({
              kind: 'completed',
              csvFileName: data.csvFileName, partIndex: data.partIndex,
              nextCsvFileName: data.nextCsvFileName ?? null, nextPartIndex: data.nextPartIndex ?? null,
            });
            osPartCompleteBannerTimerRef.current = setTimeout(() => setOsPartCompleteBanner(null), 14000);
            queryClient.invalidateQueries({ queryKey: ["/api/order-scan/active-sessions"] });
            queryClient.invalidateQueries({ queryKey: ["/api/order-import/master-view"] });
            return;
          }
          if (data.type === 'session-reopened') {
            // An admin undid an accidental Complete — the plant's active session just
            // changed back underneath whoever's looking at this page, same as a normal
            // CSV switch, so it deserves the same big, impossible-to-miss treatment.
            if (osPartCompleteBannerTimerRef.current) clearTimeout(osPartCompleteBannerTimerRef.current);
            setOsPartCompleteBanner({
              kind: 'reopened',
              csvFileName: data.csvFileName, partIndex: data.partIndex,
              nextCsvFileName: null, nextPartIndex: null,
            });
            osPartCompleteBannerTimerRef.current = setTimeout(() => setOsPartCompleteBanner(null), 14000);
            queryClient.invalidateQueries({ queryKey: ["/api/order-scan/active-sessions"] });
            queryClient.invalidateQueries({ queryKey: ["/api/order-scan/active"] });
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
    queryKey: ["/api/order-import/sessions", "scan-page", csvEffDate, csvEffPlant],
    queryFn: () => {
      const p = new URLSearchParams({ page: "1", pageSize: "100" });
      if (csvEffDate)  p.set("date",  csvEffDate);
      if (csvEffPlant) p.set("plant", csvEffPlant);
      return apiRequest("GET", `/api/order-import/sessions?${p}`).then((r) => r.json());
    },
    enabled: osTab === "separate-csvs" && !!csvEffDate,
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

  // Pallet-count cell: qty ÷ items-per-pallet, or a muted 0.00 when not applicable. Shared by
  // Part Order's CSV Items table. Looks up the item's own GJ/MP PLT in Product Master (NOT the
  // CSV's own Pallets/expectedPallets column, and not "Packets"/itemsPerPallet) — falling back
  // to treating the item as exactly one pallet sized to its own quantity when no PLT is defined.
  const impItemsPerPallet = (i: { barcode: string | null; quantity: number | null }): number => {
    const qty = i.quantity ?? 0;
    const invProduct = i.barcode ? productLookup.get(normalize(i.barcode)) ?? null : null;
    const defined = invProduct ? getStatePalletSize(invProduct, getPlantState(csvEffPlant)) : 0;
    return defined > 0 ? defined : Math.max(1, qty || 1);
  };

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

  // ── Master View item history drill-down (click a row → see every raw scan for it) ────────
  // Declared here — BEFORE the early loading-state return below — so these hooks always run on
  // every render regardless of orderScanNotifLoading (a hook after a conditional return only
  // fires on some renders, which is exactly what triggered the
  // "Rendered more hooks than during the previous render" crash).
  // Void rights mirror the server's own rule exactly (order-scan.ts's void route: requires
  // Write Access to BOTH "scan-order" and "scan-history", chained as two requirePageWrite
  // middlewares) — a user with only one of the two would otherwise see a clickable Void
  // button that 403s on click.
  const canVoidScan = isAdminOrSuperUser || (hasPageWriteAccess("scan-order") && hasPageWriteAccess("scan-history"));

  type MvHistoryEvent = {
    id: number; sessionId: number; barcode: string; itemName: string | null;
    pallets: number | null; totalQty: number; isExtra: boolean;
    scannedByName: string | null; scannedAt: string;
    voided: boolean | null; voidedAt: string | null; voidReason: string | null;
    orderName: string; partIndex: number | null;
  };
  // Item-history drill-down lives on the SCAN tab: click an item to expand its arrival history
  // below the row. (Was previously on Master View; moved here so Master View is view-only.)
  const [osHistoryItem, setOsHistoryItem] = useState<OsScanItem | null>(null);
  // Collapse any expanded item history when the operator leaves the Scan tab.
  useEffect(() => {
    if (osTab !== "scan") setOsHistoryItem(null);
  }, [osTab]);
  // Click anywhere outside the search box/expanded row and it closes on its own — no separate
  // cancel needed. Desktop and mobile each render their own markup for this tab (one hidden via
  // CSS, not unmounted), so each gets its own ref/hook instance — see useOutsideClick's comment.
  const closeMvSearch = useCallback(() => { setMvSearchOpen(false); setMvSearch(""); }, []);
  const closeOsHistory = useCallback(() => setOsHistoryItem(null), []);
  const mvSearchDesktopRef = useOutsideClick(mvSearchOpen, closeMvSearch);
  const mvSearchMobileRef = useOutsideClick(mvSearchOpen, closeMvSearch);
  const osExpandDesktopRef = useOutsideClick(osHistoryItem !== null, closeOsHistory);
  const osExpandMobileRef = useOutsideClick(osHistoryItem !== null, closeOsHistory);
  // Same click-outside-closes treatment for the Scan tab's own search toggle.
  const closeOsSearch = useCallback(() => { setOsSearchOpen(false); setOsSearch(""); }, []);
  const osSearchDesktopRef = useOutsideClick(osSearchOpen, closeOsSearch);
  const osSearchMobileRef = useOutsideClick(osSearchOpen, closeOsSearch);
  const [mvVoidTarget, setMvVoidTarget] = useState<MvHistoryEvent | null>(null);
  const [mvVoidReason, setMvVoidReason] = useState("");
  // Every session/part currently loaded into this Master View — the history drill-down spans
  // all of them (not just one file), matching what "history of this item in this order" means.
  const mvSessionIds = (mvQuery.data?.files ?? []).map((f) => f.sessionId);
  const mvHistoryQuery = useQuery<{ items: MvHistoryEvent[] }>({
    queryKey: ["/api/order-import/master-view/item-history", osHistoryItem?.barcode, osGroupSessionIds.join(",")],
    queryFn: () =>
      apiRequest(
        "GET",
        `/api/order-import/master-view/item-history?barcode=${encodeURIComponent(osHistoryItem!.barcode!)}&sessionIds=${osGroupSessionIds.join(",")}`,
      ).then((r) => r.json()),
    enabled: !!osHistoryItem?.barcode && osGroupSessionIds.length > 0,
  });
  const mvVoidMutation = useMutation({
    mutationFn: (payload: { id: number; reason: string }) =>
      apiRequest("POST", `/api/order-scan/events/${payload.id}/void`, { reason: payload.reason }).then((r) => r.json()),
    onSuccess: () => {
      // Same order_scan_events table Scan History reads from — voiding here is already visible
      // there with no extra sync step; invalidate every cache that could show this event so the
      // page reflects it live (no manual refresh). The "/api/order-scan/sessions" prefix covers
      // the Scan tab's items list, group credits, extras, etc. — refreshing the qty/status the
      // voided scan affected.
      queryClient.invalidateQueries({ queryKey: ["/api/order-scan/sessions"] });
      queryClient.invalidateQueries({ queryKey: ["/api/order-import/master-view/item-history"] });
      queryClient.invalidateQueries({ queryKey: ["/api/order-import/master-view"] });
      queryClient.invalidateQueries({ queryKey: ["/api/scan-sessions/reports/scan-history"] });
      queryClient.invalidateQueries({ queryKey: ["/api/scan-sessions/reports/plant-stock"] });
      setMvVoidTarget(null);
      setMvVoidReason("");
      toast({ title: "Scan voided", description: "Excluded from totals and stock; kept in history." });
    },
    onError: (err: any) => toast({ title: "Failed to void scan", description: err?.message, variant: "destructive" }),
  });

  // Stable per-row id for the item-history expansion — barcode is already the merge/dedup key
  // (see allMvItems above), so it's unique on its own; "empty-box" covers the one synthetic
  // row that has barcode: null.
  const mvRowKey = (item: MvMergedItem) => item.barcode ?? "empty-box";

  // Inline history panel — same content whether it renders as a DataTable expanded row
  // (desktop) or a plain <tr> below the clicked row (mobile custom table). Reads mvHistoryItem/
  // mvHistoryQuery, so it only has real content once an item's name has been clicked.
  const mvHistoryPanel = (
    // Sticky + width-capped so this stays fully visible without its own horizontal scroll —
    // it renders inside a <td colSpan> of a much wider table (which itself scrolls sideways),
    // so a plain 100%-width block here would inherit that full width. "sticky left:0" pins it
    // to the visible left edge of whatever ancestor is actually scrolled; capping the width
    // well under any realistic viewport keeps the whole thing on-screen at that position.
    <div className="sticky left-0 w-full max-w-2xl bg-gray-50 p-3">
      {mvHistoryQuery.isLoading ? (
        <div className="flex justify-center py-6">
          <Loader2 className="h-5 w-5 animate-spin text-[#001d6e]" />
        </div>
      ) : (mvHistoryQuery.data?.items?.length ?? 0) === 0 ? (
        <p className="py-4 text-center text-xs text-gray-400">No scans yet for this item in this order.</p>
      ) : (
        <div className="max-h-72 overflow-y-auto border border-gray-200">
          <table className="w-full table-fixed border-collapse text-xs">
            <thead>
              <tr className="border-b-2 border-gray-300 bg-gray-100 text-left text-gray-600 sticky top-0 z-10">
                <th className="font-semibold border-r border-gray-200 px-2 py-2 w-7">#</th>
                <th className="font-semibold border-r border-gray-200 px-2 py-2 w-[122px]">Date &amp; Time</th>
                <th className="font-semibold border-r border-gray-200 px-2 py-2">Scanned By</th>
                <th className="font-semibold border-r border-gray-200 px-2 py-2">Order / Part</th>
                <th className="font-semibold text-center border-r border-gray-200 px-2 py-2 w-14">Qty</th>
                <th className="font-semibold border-r border-gray-200 px-2 py-2 w-16">Status</th>
                {canVoidScan && <th className="font-semibold text-right px-2 py-2 w-14">Action</th>}
              </tr>
            </thead>
            <tbody>
              {mvHistoryQuery.data!.items.map((ev, idx) => {
                const isOdd = idx % 2 !== 0;
                return (
                  <tr
                    key={ev.id}
                    className={`border-b border-gray-100 transition-colors ${ev.voided ? "opacity-60" : "hover:bg-gray-50"} ${isOdd ? "bg-slate-50" : "bg-white"}`}
                  >
                    <td className="px-2 py-2 text-gray-400 font-mono border-r border-gray-100">{idx + 1}</td>
                    <td className="px-2 py-2 text-gray-800 truncate border-r border-gray-100">
                      {format(new Date(ev.scannedAt), "MMM d · h:mm a")}
                    </td>
                    <td className="px-2 py-2 text-gray-600 truncate border-r border-gray-100">{ev.scannedByName ?? "—"}</td>
                    <td className="px-2 py-2 text-gray-600 truncate border-r border-gray-100">
                      {stripCsvExt(ev.orderName)}{ev.partIndex ? ` · Part ${ev.partIndex}` : ""}
                    </td>
                    <td className="px-2 py-2 text-center border-r border-gray-100">
                      <span className={`inline-flex items-center justify-center rounded-full text-[11px] font-bold px-2 py-0.5 ${ev.isExtra ? "bg-amber-100 text-amber-700" : "bg-[#001d6e]/10 text-[#001d6e]"}`}>
                        {ev.isExtra ? "+" : ""}{ev.totalQty}
                      </span>
                    </td>
                    <td className="px-2 py-2 text-[11px] border-r border-gray-100 truncate">
                      {ev.voided ? (
                        <span className="font-medium text-red-500" title={ev.voidReason ?? undefined}>Voided</span>
                      ) : ev.isExtra ? (
                        <span className="font-semibold uppercase text-amber-700">Extra</span>
                      ) : (
                        <span className="text-gray-400">—</span>
                      )}
                    </td>
                    {canVoidScan && (
                      <td className="px-2 py-2 text-right">
                        {!ev.voided && (
                          <Button
                            size="sm" variant="ghost"
                            className="h-6 px-2 text-[11px] text-red-600 hover:bg-red-50 hover:text-red-700"
                            onClick={() => setMvVoidTarget(ev)}
                          >
                            Void
                          </Button>
                        )}
                      </td>
                    )}
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );

  // Mobile counterpart to mvHistoryPanel above — the dense 6/7-column table doesn't fit a
  // phone screen (even table-fixed squeezes every column illegibly), so this renders the same
  // mvHistoryQuery data as a stacked card per scan event instead.
  const mvHistoryPanelMobile = (
    <div className="w-full bg-gray-50 p-3">
      {mvHistoryQuery.isLoading ? (
        <div className="flex justify-center py-6">
          <Loader2 className="h-5 w-5 animate-spin text-[#001d6e]" />
        </div>
      ) : (mvHistoryQuery.data?.items?.length ?? 0) === 0 ? (
        <p className="py-4 text-center text-xs text-gray-400">No scans yet for this item in this order.</p>
      ) : (
        <div className="max-h-72 space-y-2 overflow-y-auto">
          {mvHistoryQuery.data!.items.map((ev) => (
            <div
              key={ev.id}
              className={`rounded-md border border-gray-200 bg-white p-2.5 ${ev.voided ? "opacity-60" : ""}`}
            >
              <div className="flex items-center justify-between gap-2">
                <span className="text-xs font-medium text-gray-800">
                  {format(new Date(ev.scannedAt), "MMM d · h:mm a")}
                </span>
                <span className={`inline-flex items-center justify-center rounded-full text-[11px] font-bold px-2 py-0.5 shrink-0 ${ev.isExtra ? "bg-amber-100 text-amber-700" : "bg-[#001d6e]/10 text-[#001d6e]"}`}>
                  {ev.isExtra ? "+" : ""}{ev.totalQty}
                </span>
              </div>
              <p className="mt-1 text-xs text-gray-600">{ev.scannedByName ?? "—"}</p>
              <p className="text-xs text-gray-400">
                {stripCsvExt(ev.orderName)}{ev.partIndex ? ` · Part ${ev.partIndex}` : ""}
              </p>
              {(ev.voided || ev.isExtra || canVoidScan) && (
                <div className="mt-1.5 flex items-center justify-between">
                  {ev.voided ? (
                    <span className="text-[11px] font-medium text-red-500" title={ev.voidReason ?? undefined}>Voided</span>
                  ) : ev.isExtra ? (
                    <span className="text-[11px] font-semibold uppercase text-amber-700">Extra</span>
                  ) : <span />}
                  {canVoidScan && !ev.voided && (
                    <Button
                      size="sm" variant="ghost"
                      className="h-6 px-2 text-[11px] text-red-600 hover:bg-red-50 hover:text-red-700"
                      onClick={() => setMvVoidTarget(ev)}
                    >
                      Void
                    </Button>
                  )}
                </div>
              )}
            </div>
          ))}
        </div>
      )}
    </div>
  );

  // ─── Views ────────────────────────────────────────────────────────────────

  // Don't show the plain dashboard for a split second before we actually know whether
  // an order-scan session is active — without this, a refresh always flashes the
  // dashboard first (since the notification query hasn't resolved yet) and then jumps
  // to the scan view once it loads a moment later.
  // Drag-to-reorder for each of this page's three tables, each remembering its own arrangement.
  // Declared ABOVE the early return below: every hook has to run on every render, and this
  // component bails out to a spinner while the notification query resolves.
  const [osColumnOrder, setOsColumnOrder] = useColumnOrder("scanOrder:osColumnOrder");
  const [mvColumnOrder, setMvColumnOrder] = useColumnOrder("scanOrder:mvColumnOrder");
  const [csvColumnOrder, setCsvColumnOrder] = useColumnOrder("scanOrder:csvColumnOrder");

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
          // Only the GJ/MP-PLT-defined size (0 if not defined) — the expected-qty fallback
          // needs this item's FINAL summed quantity across every contributing file, which
          // isn't known until the accumulation loop below finishes, so that fallback is
          // applied in one pass over `merged` further down instead of here.
          g = {
            barcode: item.barcode, itemName: item.itemName, sapCode: item.sapCode,
            quantity: 0, scannedQty: 0, extraQty: 0, expectedPallets: null,
            itemsPerPallet: invProduct ? getStatePalletSize(invProduct, getPlantState(mvPlant)) : 0,
            _files: [], _isExtra: true, _lastScannedAt: null,
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
        // Latest touch across every contributing part — server-side, so it's correct even
        // right after a reload or when the scan happened on a different device/kiosk.
        if (item.lastScannedAt && (!g._lastScannedAt || new Date(item.lastScannedAt) > new Date(g._lastScannedAt))) {
          g._lastScannedAt = item.lastScannedAt;
        }
      });
    });
    const merged = Array.from(groups.values());
    // No GJ/MP PLT was defined for these — now that every file's contribution has been
    // summed into g.quantity, treat each as exactly one pallet sized to its own total.
    merged.forEach((g) => { if (!(g.itemsPerPallet > 0)) g.itemsPerPallet = Math.max(1, g.quantity || 1); });
    // Append ONE distinct "Empty Box" entry summing every file's empty boxes for this view —
    // a separate labeled row, never mixed into order quantity/scanned/extra.
    const ebQty = mvData.files.reduce((s, f) => s + (f.emptyBoxTotalQty ?? 0), 0);
    const ebCount = mvData.files.reduce((s, f) => s + (f.emptyBoxCount ?? 0), 0);
    if (ebQty > 0) {
      merged.push({
        barcode: null, itemName: "Empty Box", sapCode: null,
        quantity: 0, scannedQty: 0, extraQty: 0, expectedPallets: null,
        itemsPerPallet: 0, _files: [], _isExtra: false,
        _isEmptyBox: true, _emptyBoxCount: ebCount, _emptyBoxQty: ebQty, _lastScannedAt: null,
      });
    }
    return merged;
  })();
  // Recently-scanned items float to the top — and crucially the SAME order is visible to every
  // user/device, not just this browser. Two tiers:
  //   1. Items I scanned this session sort first, newest local scan on top (instant feedback via
  //      the client seq map, before the server round-trip lands).
  //   2. Everything else falls back to the server's shared lastScannedAt — so a scan on ANY other
  //      device also floats that item up here once it refetches. Two server timestamps compare
  //      safely against each other (same IST-as-UTC convention); we never mix the optimistic
  //      client value in, because any item I scanned is already handled by tier 1.
  // Same rule + same barcode-keyed maps as the Scan tab, so both tables show the same order. A
  // stable sort (return 0 for untouched pairs) leaves never-scanned rows exactly where they were.
  const mvRecencySort = (a: MvMergedItem, b: MvMergedItem) => {
    const seq = osScanSeqRef.current.byBarcode;
    const aSeq = seq.get(normalize(a.barcode)) ?? 0;
    const bSeq = seq.get(normalize(b.barcode)) ?? 0;
    if (aSeq !== bSeq) return bSeq - aSeq;
    const aT = a._lastScannedAt ? new Date(a._lastScannedAt).getTime() : 0;
    const bT = b._lastScannedAt ? new Date(b._lastScannedAt).getTime() : 0;
    if (aT !== bT) return bT - aT;
    return 0;
  };
  const filtMvItems = mvSearch
    ? allMvItems
        .filter((i) =>
          [i.barcode, i.itemName, i.sapCode, ...i._files].some((v) => v?.toLowerCase().includes(mvSearch.toLowerCase()))
        )
        .slice()
        .sort(mvRecencySort)
    : allMvItems.slice().sort(mvRecencySort);

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
    // Done is the full physical count for this item — order-matched portion plus any extra —
    // not just the order-matched portion. E.g. expected 10, 10 scanned regular + 10 extra
    // shows Done: 20 (Extra Qty still separately shows 10 alongside it).
    const done = item.scannedQty ?? 0;
    const isExtraOnly = item._isExtra;
    const isDone = done >= exp && exp > 0;
    const isPartial = done > 0 && !isDone && !isExtraOnly;
    return {
      exp,
      done,
      extra,
      ipp: item.itemsPerPallet ?? 0,
      remain: Math.max(0, exp - done),
      isExtraOnly,
      isDone,
      isPartial,
      // Any nonzero scanned qty — used for the aggregate "how many received" counts/filters
      // below, which count a partially-scanned item as received even though its own badge
      // still reads "Partial" (that distinction stays visible per-row).
      isReceived: done > 0,
    };
  };
  // Aggregate "how many done" for the mobile blue header — mirrors osDoneCount's role for the
  // Scan tab, just computed from Master View's own per-row state instead. Counts fully-received
  // AND partially-received rows (any nonzero qty) plus extra-only rows — an item with SOME qty
  // in belongs in the "received" tally even while its own row still shows "Partial".
  const mvDoneCount = allMvItems.filter((i) => !i._isEmptyBox && (mvRowState(i).isReceived || mvRowState(i).isExtraOnly)).length;

  // Same totals-box filter the Scan tab uses, so clicking Done/Remaining/Extra narrows Master View
  // to those rows too. Declared after mvRowState because it calls it.
  const mvVisible = !osStatFilter
    ? filtMvItems
    : filtMvItems.filter((i) => {
        const { done, remain, extra } = mvRowState(i);
        // "Done" counts any item with SOME qty received — including a Partial row, whose own
        // badge still reads "Partial" but which still belongs in this tally. A partial item can
        // also still show up under "Remaining" at the same time, since it has qty left too.
        if (osStatFilter === "done") return done > 0;
        if (osStatFilter === "remaining") return remain > 0;
        return extra > 0;
      });

  // Totals for Master View's mobile card list and rotated/portrait table. Empty-box entries carry
  // no order quantity and render as a full-width note rather than a data row, so they contribute
  // nothing here.
  const mvKioskTotals = sumKioskTotals(mvVisible, (item) => {
    if (item._isEmptyBox) return { exp: 0, done: 0, remain: 0, extra: 0, ipp: 0 };
    const exp = item.quantity ?? 0;
    const done = item.scannedQty ?? 0;
    return {
      exp,
      done,
      remain: Math.max(0, exp - done),
      extra: item.extraQty ?? 0,
      ipp: item.itemsPerPallet ?? 0,
    };
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
      // Master View is view-only — no click-to-expand history here (moved to the Scan tab).
      render: (i) =>
        i._isEmptyBox ? (
          <span className="inline-flex items-center rounded-full bg-orange-100 px-2 py-0.5 text-[11px] font-semibold text-orange-800">
            Empty Box · {i._emptyBoxQty} box{i._emptyBoxQty === 1 ? "" : "es"}
            {i._emptyBoxCount ? ` (${i._emptyBoxCount})` : ""}
          </span>
        ) : (
          <span>{i.itemName ?? "—"}</span>
        ),
    },
    {
      id: "barcode",
      header: "Barcode / SAP",
      width: 140,
      sortable: true,
      accessor: (i) => i.barcode,
      // Barcodes are digits but they're identifiers, not quantities — never sum them into the
      // totals row.
      totalable: false,
      cellClassName: "font-mono text-gray-500",
      render: (i) => (
        <>
          <span className="block">{i.barcode ?? <span className="text-gray-300">—</span>}</span>
          {i.sapCode && <span className="block text-[10px] text-gray-400">SAP: {i.sapCode}</span>}
        </>
      ),
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
      header: "Received Qty",
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
      total: (rows) => pltTotal(rows, (i) => { const { exp, ipp } = mvRowState(i); return { qty: exp, ipp }; }),
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
      total: (rows) => pltTotal(rows, (i) => { const { remain, ipp } = mvRowState(i); return { qty: remain, ipp }; }),
      render: (i) => {
        const { remain, ipp } = mvRowState(i);
        return pltCell(remain, ipp, "text-purple-600");
      },
    },
    {
      id: "donePlt",
      header: "Received Plt",
      width: 90,
      align: "right",
      cellClassName: "tabular-nums font-semibold",
      total: (rows) => pltTotal(rows, (i) => { const { done, ipp } = mvRowState(i); return { qty: done, ipp }; }),
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
      total: (rows) => pltTotal(rows, (i) => { const { extra, ipp } = mvRowState(i); return { qty: extra, ipp }; }),
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
            {isExtraOnly ? "Extra" : isDone ? "Received" : isPartial ? "Partial" : "Pending"}
          </span>
        );
      },
    },
  ];
  const csvSessions = csvSessQuery.data?.sessions ?? [];
  const csvImpItems = csvItemsQuery2.data ?? [];
  // Whatever was scanned most recently floats to the top, regardless of complete/partial/
  // pending status — same behavior as the Scan tab's own item list. Part Order re-fetches
  // fresh on each expand rather than tracking a live client-side scan sequence, so recency
  // here comes from the server's lastScannedAt timestamp instead; items never scanned sort
  // last, in their original (CSV row) order.
  const csvItemsSorted = csvImpItems.slice().sort((a, b) => {
    const aT = a.lastScannedAt ? new Date(a.lastScannedAt).getTime() : 0;
    const bT = b.lastScannedAt ? new Date(b.lastScannedAt).getTime() : 0;
    if (aT !== bT) return bT - aT;
    return a.id - b.id;
  });
  const filtCsvItems = csvSearch
    ? csvItemsSorted.filter((i) =>
        [i.barcode, i.itemName, i.sapCode].some((v) => v?.toLowerCase().includes(csvSearch.toLowerCase()))
      )
    : csvItemsSorted;
  // Totals for Part Order's mobile card list and its rotated/portrait table. Taken over the rows
  // actually on screen (filtCsvItems, not every imported row) so a search narrows the total along
  // with the list — matching what the desktop table's own totals row does.
  const csvTotals = sumKioskTotals(filtCsvItems, (i) => {
    const exp = i.quantity ?? 0;
    return {
      exp,
      // Received = full physical count (order-matched + extra) — same convention as the
      // doneQty/donePlt columns above and the Scan tab's osRowState.doneQty.
      done: (i.scannedQty ?? 0) + (i.extraQty ?? 0),
      remain: Math.max(0, exp - (i.scannedQty ?? 0)),
      extra: i.extraQty ?? 0,
      ipp: impItemsPerPallet(i),
    };
  });

  // Part Order (Separate CSVs) columns — mirrors the Scan/Master View column layout
  // (Item, Barcode/SAP, Exp/Remain/Received Qty, Status) so all three tabs read as one system.
  const csvColumns: DataTableColumn<ImpItem>[] = [
    {
      id: "itemName",
      header: "Item Name",
      sortable: true,
      accessor: (i) => i.itemName,
      cellClassName: "font-medium text-gray-900 whitespace-normal break-words",
      render: (item) => item.itemName ?? "—",
    },
    {
      id: "barcode",
      header: "Barcode / SAP",
      width: 140,
      sortable: true,
      accessor: (i) => i.barcode,
      // Identifier, not a quantity — kept out of the totals row.
      totalable: false,
      cellClassName: "font-mono text-gray-500",
      render: (item) => (
        <>
          <span className="block">{item.barcode ?? <span className="text-gray-300">—</span>}</span>
          {item.sapCode && <span className="block text-[10px] text-gray-400">SAP: {item.sapCode}</span>}
        </>
      ),
    },
    {
      id: "expQty",
      header: "Exp Qty",
      width: 80,
      align: "right",
      sortable: true,
      accessor: (i) => i.quantity ?? 0,
      cellClassName: "text-gray-600 font-medium tabular-nums",
      render: (i) => i.quantity ?? "—",
    },
    {
      id: "remainQty",
      header: "Remain Qty",
      width: 100,
      align: "right",
      sortable: true,
      accessor: (i) => Math.max(0, (i.quantity ?? 0) - (i.scannedQty ?? 0)),
      cellClassName: "tabular-nums font-bold",
      render: (item) => {
        const rem = Math.max(0, (item.quantity ?? 0) - (item.scannedQty ?? 0));
        return rem > 0 ? <span className="text-[#001d6e]">{rem}</span> : <span className="text-gray-300">0</span>;
      },
    },
    {
      id: "doneQty",
      header: "Received Qty",
      width: 90,
      align: "right",
      sortable: true,
      // Received = the full physical count (order-matched scannedQty PLUS extra) — same
      // convention as the Scan tab's osRowState.doneQty and Master View's mvRowState.done.
      // Status/isDone below still gates on scannedQty alone (order fulfillment), unaffected.
      accessor: (i) => (i.scannedQty ?? 0) + (i.extraQty ?? 0),
      cellClassName: "tabular-nums font-bold",
      render: (item) => {
        const exp = item.quantity ?? 0;
        const scanned = item.scannedQty ?? 0;
        const done = scanned + (item.extraQty ?? 0);
        const isDone = scanned >= exp && exp > 0;
        const isPartial = scanned > 0 && !isDone;
        return <span className={isDone ? "text-emerald-700" : isPartial ? "text-amber-700" : "text-gray-400"}>{done}</span>;
      },
    },
    {
      id: "extraQty",
      header: "Extra Qty",
      width: 90,
      align: "right",
      sortable: true,
      accessor: (i) => i.extraQty ?? 0,
      cellClassName: "tabular-nums font-semibold",
      render: (item) => {
        const extra = item.extraQty ?? 0;
        return extra > 0 ? <span className="text-amber-600">+{extra}</span> : <span className="text-gray-300">0</span>;
      },
    },
    // Pallet columns, in the same Exp → Remain → Received → Extra order as the Qty block above —
    // matching the Scan and Master View tables, which read as one system with this one.
    {
      id: "expPlt",
      header: "Exp Plt",
      width: 80,
      align: "right",
      cellClassName: "tabular-nums text-gray-500",
      total: (rows) => pltTotal(rows, (i) => ({ qty: i.quantity ?? 0, ipp: impItemsPerPallet(i) })),
      render: (i) => pltCell(i.quantity ?? 0, impItemsPerPallet(i), "text-gray-500"),
    },
    {
      id: "remainPlt",
      header: "Remain Plt",
      width: 100,
      align: "right",
      cellClassName: "tabular-nums font-semibold",
      total: (rows) =>
        pltTotal(rows, (i) => ({
          qty: Math.max(0, (i.quantity ?? 0) - (i.scannedQty ?? 0)),
          ipp: impItemsPerPallet(i),
        })),
      render: (i) =>
        pltCell(Math.max(0, (i.quantity ?? 0) - (i.scannedQty ?? 0)), impItemsPerPallet(i), "text-purple-600"),
    },
    {
      id: "donePlt",
      header: "Received Plt",
      width: 90,
      align: "right",
      cellClassName: "tabular-nums font-semibold",
      total: (rows) => pltTotal(rows, (i) => ({ qty: (i.scannedQty ?? 0) + (i.extraQty ?? 0), ipp: impItemsPerPallet(i) })),
      render: (i) => pltCell((i.scannedQty ?? 0) + (i.extraQty ?? 0), impItemsPerPallet(i), "text-[#001d6e]"),
    },
    {
      id: "extraPlt",
      header: "Extra Plt",
      width: 90,
      align: "right",
      cellClassName: "tabular-nums font-semibold",
      total: (rows) => pltTotal(rows, (i) => ({ qty: i.extraQty ?? 0, ipp: impItemsPerPallet(i) })),
      render: (i) => pltCell(i.extraQty ?? 0, impItemsPerPallet(i), "text-amber-600"),
    },
    {
      id: "status",
      header: "Status",
      width: 90,
      align: "center",
      render: (item) => {
        const exp = item.quantity ?? 0;
        const done = item.scannedQty ?? 0;
        const isDone = done >= exp && exp > 0;
        const isPartial = done > 0 && !isDone;
        return (
          <span className={`inline-flex items-center rounded-full px-2 py-0.5 text-[10px] font-semibold ${
            isDone ? "bg-emerald-100 text-emerald-700" : isPartial ? "bg-amber-100 text-amber-700" : "bg-gray-100 text-gray-500"
          }`}>
            {isDone ? "Received" : isPartial ? "Partial" : "Pending"}
          </span>
        );
      },
    },
  ];

  function downloadMvCsv() {
    if (!mvData) return;
    const headers = ["#", "Item Name", "Barcode", "SAP Code", "Expected Qty", "Scanned Qty", "Remaining", "Pallets", "Status", "Source Files"];
    const rows = allMvItems.map((item, idx) => {
      const remain = Math.max(0, (item.quantity ?? 0) - (item.scannedQty ?? 0));
      const status = item._isExtra ? "Extra" : item.scannedQty >= item.quantity && item.quantity > 0 ? "Received" : item.scannedQty > 0 ? "Partial" : "Pending";
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
      // Same two-tier recency rule as Master View (see mvRecencySort), keyed by BARCODE so both
      // tables show the same order: (1) items I scanned this session float first (instant, via
      // the client seq map); (2) everything else falls back to the server's shared lastScannedAt
      // so a scan on ANY device also floats the item up for everyone. Two server timestamps
      // compare safely; my own scanned items never reach tier 2, so the optimistic client value
      // (different tz convention) is never mixed in. Stable for never-scanned rows (return 0).
      const seq = osScanSeqRef.current.byBarcode;
      const aSeq = seq.get(normalize(a.barcode ?? "")) ?? 0;
      const bSeq = seq.get(normalize(b.barcode ?? "")) ?? 0;
      if (aSeq !== bSeq) return bSeq - aSeq;
      const aT = a.lastScannedAt ? new Date(a.lastScannedAt).getTime() : 0;
      const bT = b.lastScannedAt ? new Date(b.lastScannedAt).getTime() : 0;
      if (aT !== bT) return bT - aT;
      return 0;
    });
    // Counts toward the "received" tally once scanned qty PLUS any cross-part credit is above
    // zero — a partially-scanned line (short of expected) still counts here even though its
    // own row badge shows "Partial", same as a line fully covered by a credit.
    const osIsItemDone = (i: OsScanItem) => {
      const creditQty = osCreditByBarcode.get(normalize(i.barcode))?.creditedQty ?? 0;
      return (i.totalScannedQty ?? 0) + creditQty > 0;
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
    // Credit from an earlier part's extra counts toward this part's Received and reduces
    // Remain. Extra reflects real over-scan on THIS part (extras are separate events, not
    // folded into totalScannedQty, which stays capped at expectedQty) — but IS folded into
    // Received/doneQty below so Received always reads as the full physical count, same as
    // Master View.
    const osRowState = (item: OsScanItem) => {
      const credit = osCreditByBarcode.get(normalize(item.barcode));
      const exp = item.expectedQty ?? 0;
      const effScanned = (item.totalScannedQty ?? 0) + (credit?.creditedQty ?? 0);
      const extra = extraByBarcode.get(normalize(item.barcode ?? "")) ?? 0;
      const done = exp > 0 && effScanned >= exp;
      return {
        credit,
        exp,
        // Received = the full physical count for this item — order-matched portion (capped at
        // expected, plus any cross-part credit) PLUS extra — same convention as Master View's
        // "done" (see mvRowState above). E.g. expected 100, 100 scanned regular + 10 extra
        // shows Received: 110 (Extra Qty still separately shows 10 alongside it).
        doneQty: effScanned + extra,
        rem: Math.max(0, exp - effScanned),
        extra,
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
          // "Done" now means "has any Received qty" — a partial item can also still show
          // under "Remaining" if it has qty left, same change as Master View's mvVisible.
          if (osStatFilter === "done") return doneQty > 0;
          if (osStatFilter === "remaining") return rem > 0;
          return extra > 0;
        });

    // Totals for the mobile card list and the rotated/portrait table below. Deliberately built
    // from the same expressions those rows print (cross-part credit folded into Received, extra
    // as real over-scan on this part) rather than from osRowState, so each column's figures and
    // its total are derived identically.
    const osKioskTotals = sumKioskTotals(osVisible, (item) => {
      const exp = item.expectedQty ?? 0;
      const effScanned = (item.totalScannedQty ?? 0) + (osCreditByBarcode.get(normalize(item.barcode))?.creditedQty ?? 0);
      const extra = extraByBarcode.get(normalize(item.barcode ?? "")) ?? 0;
      return {
        exp,
        done: effScanned + extra,
        remain: Math.max(0, exp - effScanned),
        extra,
        ipp: item.itemsPerPallet ?? 0,
      };
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
        // Clicking the item NAME toggles the inline arrival-history panel below this row — see
        // the DataTable's renderExpandedRow prop.
        render: (item) => {
          const { credit } = osRowState(item);
          const isOpen = !!osHistoryItem && osHistoryItem.id === item.id;
          return (
            <>
              <button
                type="button"
                disabled={!item.barcode}
                // Stop the trigger's pointerdown reaching the outside-click handler, which would
                // otherwise close-then-the-click-reopens (leaving it stuck open).
                onPointerDown={(e) => e.stopPropagation()}
                onClick={() => setOsHistoryItem((cur) => (cur && cur.id === item.id ? null : item))}
                className={`block text-left underline decoration-dotted underline-offset-2 hover:text-[#001d6e] hover:decoration-[#001d6e] disabled:no-underline disabled:hover:text-inherit ${isOpen ? "text-[#001d6e] decoration-[#001d6e]" : "decoration-gray-300"}`}
              >
                {item.itemName ?? "—"}
              </button>
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
        // Identifier, not a quantity — kept out of the totals row.
        totalable: false,
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
        header: "Received Qty",
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
        total: (rows) => pltTotal(rows, (i) => { const { exp, ipp } = osRowState(i); return { qty: exp, ipp }; }),
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
        total: (rows) => pltTotal(rows, (i) => { const { rem, ipp } = osRowState(i); return { qty: rem, ipp }; }),
        render: (i) => {
          const { rem, ipp } = osRowState(i);
          return pltCell(rem, ipp, "text-purple-600");
        },
      },
      {
        id: "donePlt",
        header: "Received Plt",
        width: 90,
        align: "right",
        cellClassName: "tabular-nums font-semibold",
        total: (rows) => pltTotal(rows, (i) => { const { doneQty, ipp } = osRowState(i); return { qty: doneQty, ipp }; }),
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
        total: (rows) => pltTotal(rows, (i) => { const { extra, ipp } = osRowState(i); return { qty: extra, ipp }; }),
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
              {done ? "Received" : partial ? "Partial" : "Pending"}
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
    // (quantity / itemsPerPallet — see the "Exp Plt"/"Received Plt"/etc. table cells and the
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
    // Use state-specific pallet size from inventory (gjPlt/mpPlt) as the multiplier
    const plt = osPending?.plantPalletSize ?? osPending?.matchedItem?.itemsPerPallet ?? 1;
    const NO_STV = "__none__";
    // True when the CSV item exists but is already fully scanned — extra boxes coming in
    const osItemIsComplete = osPending?.matchedItem
      ? (osPending.matchedItem.totalScannedQty ?? 0) >= (osPending.matchedItem.expectedQty ?? 1)
      : false;
    const osResolvedImageName = osPending?.matchedItem?.itemName ?? osPending?.inventoryProduct?.name;


    return (
      <div className={`flex-1 overflow-x-hidden bg-gray-50 sm:overflow-y-auto sm:px-4 sm:pb-4 sm:pt-2 lg:px-6 lg:pb-6 lg:pt-3 ${kioskRotateClass}`}>
        <RotateToggleButton />
        {osRotated && (
          <div className="fixed bottom-24 right-4 z-[60] rounded-3xl bg-[#001d6e] px-2.5 py-3 text-white shadow-xl ring-1 ring-white/10">
            <ScrollNudgeButtons targetRef={osTabBodyScrollRef} amount={360} large />
          </div>
        )}

        {/* ── Big "Part Complete" / "Reopened" popup — fires for every way a part can finish
            (manual Complete button, Auto Complete mid-scan, the stale-part sweep after a new
            upload) or get reopened (admin undoing an accidental Complete), driven by the WS
            'part-completed' / 'session-reopened' messages. Deliberately large and dimmed behind
            (not a slim corner toast) so a CSV switching underneath an operator is impossible to
            miss — click anywhere to dismiss early, otherwise auto-dismisses after 14s. When the
            active CSV also changed (nextCsvFileName), that's shown in the same popup so "what
            just finished" and "what am I scanning now" land in one glance. ── */}
        {osPartCompleteBanner && (
          <div
            className="fixed inset-0 z-[110] flex items-start justify-center bg-black/50 px-4 pt-10 sm:pt-16 animate-in fade-in cursor-pointer"
            role="status"
            onClick={() => setOsPartCompleteBanner(null)}
          >
            <div
              onClick={(e) => e.stopPropagation()}
              className={`w-full max-w-lg cursor-default overflow-hidden rounded-2xl shadow-2xl ring-1 ring-black/10 animate-in fade-in zoom-in-95 slide-in-from-top-4 ${
                osPartCompleteBanner.kind === "reopened" ? "bg-amber-600" : "bg-emerald-600"
              }`}
            >
              <div className="flex items-start gap-4 p-6 text-white">
                {osPartCompleteBanner.kind === "reopened" ? (
                  <Undo2 className="h-10 w-10 shrink-0" />
                ) : (
                  <CheckCircle2 className="h-10 w-10 shrink-0" />
                )}
                <div className="min-w-0 flex-1">
                  <p className="text-2xl font-bold leading-tight">
                    {osPartCompleteBanner.kind === "reopened"
                      ? `Part ${osPartCompleteBanner.partIndex} Reopened`
                      : `Part ${osPartCompleteBanner.partIndex} Complete`}
                  </p>
                  <p className="mt-1 break-words text-base font-medium opacity-90">
                    {stripCsvExt(osPartCompleteBanner.csvFileName)}
                  </p>
                </div>
                <button
                  type="button"
                  onClick={() => setOsPartCompleteBanner(null)}
                  className="shrink-0 rounded-full p-1 text-white/80 hover:bg-white/10 hover:text-white"
                  aria-label="Dismiss"
                >
                  <X className="h-5 w-5" />
                </button>
              </div>
              {osPartCompleteBanner.nextCsvFileName && (
                <div className="border-t border-white/20 bg-black/10 px-6 py-3 text-white">
                  <p className="text-xs font-semibold uppercase tracking-wide opacity-75">Now scanning</p>
                  <p className="mt-0.5 break-words text-lg font-bold">
                    Part {osPartCompleteBanner.nextPartIndex ?? "?"}
                    <span className="ml-1.5 font-normal opacity-90">— {stripCsvExt(osPartCompleteBanner.nextCsvFileName)}</span>
                  </p>
                </div>
              )}
            </div>
          </div>
        )}

        {/* ── Auto Scan feedback popup — shows for 5s after an auto-confirmed (full-pallet)
            scan: product image + name/barcode/SAP + how much was scanned and what remains.
            Non-blocking (pointer-events-none) — the operator keeps scanning; no confirm
            needed. Rapid scans replace it and reset the 5s timer (see showAutoScanFeedback). ── */}
        {osAutoScanFeedback && (
          <div className="fixed inset-x-0 top-16 z-[90] flex justify-center px-4 pointer-events-none" role="status">
            {/* Width matches the confirm dialog exactly (w-[calc(100%-2rem)] max-w-2xl
                sm:max-w-3xl). The dialog's height is content-driven (notices + button row), so
                min-h here approximates it — without it this card would sit noticeably shorter,
                since it has no footer buttons. */}
            <div className="w-[calc(100%-2rem)] max-w-2xl sm:max-w-3xl min-h-[20rem] flex flex-col bg-white p-8 shadow-xl ring-1 ring-gray-200 animate-in fade-in slide-in-from-top-2">
              <div className="flex items-center gap-2.5 text-emerald-700">
                <Zap className="h-7 w-7 shrink-0" />
                <span className="text-2xl font-semibold">Auto scanned</span>
              </div>
              <div className="flex flex-1 gap-5 items-start pt-4">
                <img
                  src={`/api/products/image-by-name?name=${encodeURIComponent(osAutoScanFeedback.name)}`}
                  alt=""
                  className="h-60 w-60 shrink-0 object-contain bg-gray-50 border border-gray-100"
                  onError={(e) => { (e.currentTarget as HTMLImageElement).style.display = 'none'; }}
                />
                <div className="flex-1 min-w-0 text-lg">
                  <p className="font-semibold text-gray-900 break-words text-xl">{osAutoScanFeedback.name}</p>
                  <p className="mt-1.5 font-mono text-base text-gray-400 break-all">
                    {osAutoScanFeedback.barcode}{osAutoScanFeedback.sapCode && ` · SAP: ${osAutoScanFeedback.sapCode}`}
                  </p>
                  <p className="mt-4 text-2xl">
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
<div className={`flex-col h-full overflow-y-auto ${bigView ? "flex" : "flex lg:hidden"}`}>
          {/* ── Sticky header + scanner ── */}
          <div className="sticky top-0 z-20 bg-white shadow-sm">

            {/* Session info row — bordered sections instead of a loose flex row, so title /
                complete action / progress read as distinct fields rather than floating text. */}
            <div className={`flex items-stretch divide-x divide-gray-200 border-b border-gray-300 ${bigView ? "text-sm" : ""}`}>
              <div className={`flex-1 min-w-0 ${bigView ? "px-4 py-3" : "px-3 py-2"}`}>
                <p
                  className={`font-bold text-gray-900 truncate leading-tight ${bigView ? "text-base" : "text-xs"}`}
                  title={stripCsvExt(activeOrderScanSession.csvFileName)}
                >
                  {scanFmtUploadDate(activeOrderScanSession.orderDate)}
                  {(osGroupCreditsQuery.data?.totalParts ?? 0) > 1 && (
                    <span className={`ml-1.5 inline-block bg-purple-100 font-semibold text-purple-700 ${bigView ? "px-2 py-0.5 text-xs" : "px-1.5 py-0.5 text-[10px]"}`}>
                      Part {osGroupCreditsQuery.data?.partIndex} of {osGroupCreditsQuery.data?.totalParts}
                    </span>
                  )}
                </p>
                <p className={`flex items-center gap-1.5 text-gray-500 truncate ${bigView ? "text-xs mt-0.5" : "text-[10px]"}`}>
                  {/* Plant-switch dropdown — always shown (replaces the old plant tab strip
                      above and the plain badge that used to sit here). Lists every plant
                      with an active scan session right now; picking one switches to it,
                      same as the old tabs did. Colored from Plant Management, same as
                      every other PlantBadge in the app. */}
                  <Select
                    value={String(activeOrderScanSession.id)}
                    onValueChange={(v) => {
                      const picked = osPlantSwitchOptions.find((s) => String(s.id) === v);
                      selectPlantSession(Number(v), picked?.plant);
                    }}
                  >
                    <SelectTrigger
                      className="h-5 w-auto gap-1 rounded-full border px-2 py-0 text-[10px] font-semibold shadow-none focus:ring-0 [&>svg]:h-3 [&>svg]:w-3"
                      style={(() => {
                        const cfg = getPlantColorCfg(activeOrderScanSession.plant);
                        return cfg ? { backgroundColor: cfg.bgColor, color: cfg.textColor, borderColor: cfg.borderColor } : undefined;
                      })()}
                    >
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      {osPlantSwitchOptions.map((s) => {
                        const cfg = getPlantColorCfg(s.plant);
                        return (
                          <SelectItem key={s.id} value={String(s.id)}>
                            <span className="flex items-center gap-1.5">
                              <span
                                className="h-2 w-2 shrink-0 rounded-full border"
                                style={cfg ? { backgroundColor: cfg.bgColor, borderColor: cfg.borderColor } : undefined}
                              />
                              {s.plant}
                            </span>
                          </SelectItem>
                        );
                      })}
                    </SelectContent>
                  </Select>
                  {activeOrderScanSession.importedByName && <span>· {activeOrderScanSession.importedByName}</span>}
                </p>
              </div>
              {canCompletePart && (
                <div className={`flex items-center justify-center shrink-0 ${bigView ? "px-4" : "px-2"}`}>
                  <Button size="sm" className={`bg-emerald-600 hover:bg-emerald-700 text-white shrink-0 ${bigView ? "h-9 px-4 text-sm" : "h-7 px-2.5 text-[11px]"}`} onClick={() => setShowForceComplete(true)}>
                    Complete
                  </Button>
                </div>
              )}
              <div className={`shrink-0 text-right flex flex-col justify-center ${bigView ? "px-4 py-3" : "px-3 py-2"}`}>
                <p className={`font-bold text-[#001d6e] ${bigView ? "text-base" : "text-xs"}`}>{osDoneCount}/{osTotalCount}</p>
                <p className={`text-gray-400 ${bigView ? "text-xs" : "text-[10px]"}`}>{osPct}%</p>
              </div>
            </div>

            {/* Full-width progress bar */}
            <Progress value={osPct} className={`rounded-xl ${bigView ? "h-2" : "h-1.5"}`} />

            {/* Scanner section — hidden on Separate CSVs (no scanning happens there) */}
            {osTab !== "separate-csvs" && (
            <div className="px-4 pt-3 pb-4 space-y-3 bg-gray-50 border-t border-gray-100">

              <p className="flex items-center gap-1.5 text-[11px] text-gray-400"><Plug className="h-3 w-3" />Barcode gun: plug in and scan</p>

              {/* Camera / Manual tabs */}
              <div className="flex overflow-hidden rounded-xl border border-gray-300 divide-x divide-gray-300 bg-white">
                <button
                  onClick={() => setOsScanMode("camera")}
                  className={`flex-1 flex items-center justify-center gap-1.5 font-semibold transition-colors ${bigView ? "py-3 text-sm" : "py-2 text-xs"} ${
                    osScanMode === "camera" ? "bg-[#001d6e] text-white" : "text-gray-500 hover:bg-gray-50"
                  }`}
                >
                  <Camera className={bigView ? "h-4 w-4" : "h-3.5 w-3.5"} /> Camera
                </button>
                <button
                  onClick={() => { stopOsCamera(); setOsScanMode("manual"); }}
                  className={`flex-1 flex items-center justify-center gap-1.5 font-semibold transition-colors ${bigView ? "py-3 text-sm" : "py-2 text-xs"} ${
                    osScanMode === "manual" ? "bg-[#001d6e] text-white" : "text-gray-500 hover:bg-gray-50"
                  }`}
                >
                  <Keyboard className={bigView ? "h-4 w-4" : "h-3.5 w-3.5"} /> Manual
                </button>
              </div>

              {/* Main STV selector — sets the default for the next scan confirmation too.
                  Bolder fill + explicit label so it reads as an active selector, not muted text. */}
              {stvs.length > 0 && (
                <div className="flex items-center gap-2">
                  <span className={`shrink-0 font-semibold uppercase tracking-wide text-gray-400 ${bigView ? "text-xs" : "text-[10px]"}`}>STV</span>
                  <Select
                    value={osSelectedStv || NO_STV}
                    onValueChange={(v) => {
                      const nextValue = v === NO_STV ? "" : v;
                      setOsSelectedStv(nextValue);
                    }}
                  >
                    <SelectTrigger className={`rounded-xl justify-center text-center font-semibold border-2 ${
                      osSelectedStv ? "border-[#001d6e] bg-[#001d6e]/5 text-[#001d6e]" : "border-gray-300 text-gray-500"
                    } ${bigView ? "h-11 w-56 text-base" : "h-8 w-44 text-sm"}`}>
                      <SelectValue placeholder="Select STV…" />
                    </SelectTrigger>
                    {/* Radix portals this dropdown to document.body, outside the .kiosk-rotate-90
                        subtree, so it doesn't inherit the page rotation on its own — it renders
                        upright while everything else is rotated. Radix positions it via an inline
                        transform:translate(...) on its OWN wrapper (a different element from this
                        one), so adding our rotation directly here composes cleanly with no
                        conflict. origin-top-left matches Radix's actual side="bottom" align="start"
                        anchor for this trigger, keeping the dropdown attached to the same corner. */}
                    <SelectContent className={osRotated ? `origin-top-left ${osPortalRotate}` : undefined}>
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
                  <span className="rounded-xl border border-dashed border-amber-300 bg-amber-50 px-2 py-1 text-[11px] text-amber-700">
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
                  overflow: "hidden",
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
                      className={`font-mono w-full rounded-xl border-gray-300 ${bigView ? "text-lg h-14" : "text-sm h-10"}`}
                      autoFocus
                    />
                    {osManualFocused && osSuggestions.length > 0 && (
                      <div className="absolute left-0 right-0 top-full z-50 mt-1 rounded-xl border border-gray-300 bg-white shadow-lg overflow-hidden">
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
                    className={`bg-[#001d6e] hover:bg-[#00154b] text-white shrink-0 p-0 rounded-xl ${bigView ? "h-14 w-14" : "h-10 w-10"}`}
                  >
                    <ScanLine className={bigView ? "h-6 w-6" : "h-4 w-4"} />
                  </Button>
                </div>
              )}

              {/* ── Empty Box — log a box with no item/barcode, alongside Gun Mode. Separate
                  from a product scan: no CSV lookup, doesn't count toward order qty. ── */}
              <div className="flex items-center gap-2 mt-2">
                <Button
                  variant="outline"
                  disabled={!activeOrderScanSession || activeOrderScanSession.scanStatus === "completed" || !!osPending || !canScanWrite}
                  onClick={() => { setEmptyBoxQty("1"); setEmptyBoxNote(""); setShowEmptyBox(true); }}
                  className="flex-1 h-9 rounded-full text-xs border-amber-300 text-amber-700 hover:bg-amber-50"
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

          {/* ── Scrollable content below sticky scanner ──
              When rotated, min-h-0 is load-bearing: a flex item defaults to min-height:auto, so
              this box grew to fit the whole item list rather than clipping it. Having no overflow
              of its own, it had nothing to scroll — which is why the ▲▼ nudge buttons (they call
              scrollBy on this element) did nothing and the rows below the fold were unreachable.
              Bounding it makes those buttons work, and overflow-y-auto + kiosk-scroll adds a wide,
              always-visible bar beside them.
              min-h-0 is applied ONLY when rotated: it is safe there because .kiosk-rotate-90 sets
              a definite height (100vw) for h-full to resolve against. On a naturally-portrait
              phone the ancestor height can be content-derived, where a 0 min-height would let this
              flex item collapse to nothing and swallow the list — so that case keeps the plain
              overflow-y-auto it uses at every other width. */}
          <div
            ref={osTabBodyScrollRef}
            className={`flex-1 px-4 py-3 space-y-3 ${osRotated ? "min-h-0 overflow-y-auto kiosk-scroll" : "overflow-y-auto"}`}
          >

            {/* ── Tab strip — one joined, bordered segmented control (business style) instead of
                separate floating rounded pills. Scanner above stays put across tabs. ── */}
            <div className="flex overflow-hidden rounded-xl border border-gray-300 divide-x divide-gray-300 bg-white">
              {(["master-view", "scan", "separate-csvs"] as const).map((t) => (
                <button
                  key={t}
                  onClick={() => setOsTab(t)}
                  className={`flex flex-1 items-center justify-center font-medium transition-colors ${
                    bigView ? "gap-2 px-4 py-3 text-base" : "gap-1.5 px-3 py-2 text-xs"
                  } ${
                    osTab === t
                      ? "bg-[#001d6e] text-white"
                      : "text-gray-600 hover:bg-gray-50"
                  }`}
                >
                  {t === "scan"
                    ? <ScanLine className={bigView ? "h-5 w-5" : "h-3.5 w-3.5"} />
                    : t === "master-view" ? <Layers className={bigView ? "h-5 w-5" : "h-3.5 w-3.5"} />
                    : <FileSpreadsheet className={bigView ? "h-5 w-5" : "h-3.5 w-3.5"} />}
                  {t === "scan" ? "Scan" : t === "master-view" ? "Master View" : "Part Order"}
                </button>
              ))}
            </div>

            {/* ── Order totals — persistent across Scan / Master View, hidden on Separate CSVs ──
                One unified bordered strip with internal dividers (business/report style),
                instead of four separate floating rounded+shadowed cards. */}
            {osTab !== "separate-csvs" && (
            <div className={`grid grid-cols-4 divide-x divide-gray-200 overflow-hidden rounded-xl border border-gray-300 bg-white ${bigView ? "text-base" : ""}`}>
              {([
                { key: "", label: "Total", value: displayTotals.expected, plt: displayTotals.palletsExpected, text: "text-gray-900" },
                { key: "done", label: "Received", value: displayTotals.done, plt: displayTotals.palletsDone, text: "text-emerald-600" },
                { key: "remaining", label: "Remaining", value: displayTotals.remaining, plt: displayTotals.palletsRemaining, text: "text-red-600" },
                { key: "extra", label: "Extra", value: displayTotals.extra, plt: displayTotals.palletsExtra, text: displayTotals.extra > 0 ? "text-amber-600" : "text-gray-300" },
              ] as const).map((s) => {
                const isActive = osStatFilter === s.key;
                return (
                  <button
                    key={s.label}
                    type="button"
                    onClick={() => setOsStatFilter(isActive ? "" : (s.key as typeof osStatFilter))}
                    aria-pressed={isActive}
                    title={s.key ? `Show only ${s.label.toLowerCase()} items` : "Show all items"}
                    className={`text-center transition-colors ${bigView ? "px-2 py-3" : "px-2 py-2"} ${
                      isActive ? "bg-[#001d6e]/[0.06] ring-1 ring-inset ring-[#001d6e]/30" : "hover:bg-gray-50"
                    }`}
                  >
                    <p className={`uppercase tracking-wide text-gray-400 ${bigView ? "text-[11px]" : "text-[10px]"}`}>{s.label}</p>
                    <p className={`font-bold ${s.text} ${bigView ? "text-xl" : "text-lg"}`}>{s.value}</p>
                    <p className={`font-bold ${s.text} ${bigView ? "text-lg" : "text-base"}`}>{s.plt.toFixed(2)} plt</p>
                  </button>
                );
              })}
            </div>
            )}

            {osTab === "scan" && (
              <>
            {/* Items list — matches Master View's mobile treatment: card list on a phone,
                the detailed table only for the rotated/kiosk view. */}
            <div className="bg-white border border-gray-300 overflow-hidden rounded-xl">
              {/* List header — navy bar, same treatment as Master View's mobile header. Search
                  replaces the row's content in place (rather than wrapping onto an extra line
                  below), and there's no explicit close button — click outside to hide it. */}
              <div ref={osSearchMobileRef} className="flex items-center gap-2 px-4 py-3 bg-[#001d6e]">
                {osSearchOpen ? (
                  <div className="relative w-full">
                    <Search className="pointer-events-none absolute left-3 top-2.5 h-3.5 w-3.5 text-gray-400" />
                    <Input
                      value={osSearch}
                      onChange={(e) => setOsSearch(e.target.value)}
                      placeholder="Search items…"
                      className="h-9 rounded-md border-gray-200 bg-gray-50 pl-8 text-sm focus-visible:ring-1 focus-visible:ring-[#001d6e]/30 focus-visible:ring-offset-0"
                      autoFocus
                    />
                    {osSearch && (
                      <button className="absolute right-2.5 top-2.5" onClick={() => setOsSearch("")}>
                        <X className="h-4 w-4 text-gray-400" />
                      </button>
                    )}
                  </div>
                ) : (
                  <>
                    <div className="text-white">
                      <p className="text-sm font-bold leading-tight">{osTotalCount} items</p>
                      <p className="text-xs text-blue-200">{osDoneCount} received</p>
                    </div>
                    <div className="ml-auto flex items-center gap-2">
                      <button
                        onClick={() => setOsSearchOpen(true)}
                        title="Search items"
                        className="inline-flex h-8 w-8 shrink-0 items-center justify-center rounded-md border border-white/25 bg-white/10 text-white hover:bg-white/20"
                      >
                        <Search className="h-3.5 w-3.5" />
                      </button>
                    </div>
                  </>
                )}
              </div>

              {/* Rows */}
              {osItemsQuery.isLoading ? (
                <div className="flex justify-center py-10">
                  <Loader2 className="h-6 w-6 animate-spin text-[#001d6e]" />
                </div>
              ) : (
                <>
                  {/* This is the narrow-screen fallback: fields stack as labeled lines instead
                      of table columns. It hides — i.e. the table below takes over — once EITHER
                      the viewport reaches 480px wide OR the device is physically turned to
                      landscape, whichever comes first. The landscape check matters on its own
                      because a phone rotated sideways should always get the table (same as the
                      rotated kiosk view), even if its landscape width happens to still be under
                      480px on a smaller device. Pure CSS (width + orientation media queries) —
                      no JS tracking needed. */}
                  {!osRotated && (
                    <div className="min-[480px]:hidden landscape:hidden">
                      {osVisible.length === 0 ? (
                        <p className="py-10 text-center text-sm text-gray-400">
                          {osItems.length === 0 ? "Loading items…" : "No items match."}
                        </p>
                      ) : osVisible.map((item) => {
                        const credit    = osCreditByBarcode.get(normalize(item.barcode));
                        const creditQty = credit?.creditedQty ?? 0;
                        const effScanned = (item.totalScannedQty ?? 0) + creditQty;
                        const exp        = item.expectedQty ?? 0;
                        const extra      = extraByBarcode.get(normalize(item.barcode ?? "")) ?? 0;
                        // Received = full physical count (order-matched + credit, plus extra) —
                        // matches Master View's convention. See osRowState's comment above.
                        const scanned    = effScanned + extra;
                        const remaining  = Math.max(0, exp - effScanned);
                        const ipp        = item.itemsPerPallet ?? 0;
                        const effStatus  = exp > 0 && effScanned >= exp ? "complete" : effScanned > 0 ? "partial" : "pending";
                        const expPlt     = ipp > 0 ? (exp / ipp).toFixed(2) : "0.00";
                        const remainPlt  = ipp > 0 ? (remaining / ipp).toFixed(2) : "0.00";
                        return (
                          <div key={item.id} className={`flex items-start gap-3 border-b border-gray-100 px-4 py-3 ${
                            effStatus === "complete" ? "bg-emerald-50/40" : effStatus === "partial" ? "bg-amber-50/30" : undefined
                          }`}>
                            <span className="mt-0.5 shrink-0">
                              {effStatus === "complete" ? (
                                <span className="flex h-7 w-7 items-center justify-center rounded-full bg-emerald-100">
                                  <CheckCircle2 className="h-4 w-4 text-emerald-600" />
                                </span>
                              ) : (
                                <span className={`flex h-7 w-7 items-center justify-center rounded-md border-2 border-dashed ${
                                  effStatus === "partial" ? "border-amber-400 text-amber-500" : "border-gray-300 text-gray-400"
                                }`}>
                                  <Scan className="h-3.5 w-3.5" />
                                </span>
                              )}
                            </span>
                            <div className="min-w-0 flex-1">
                              <p className="text-[15px] font-semibold leading-snug text-gray-900">{item.itemName ?? "—"}</p>
                              <p className="mt-0.5 font-mono text-xs text-gray-400">
                                {item.barcode ?? "—"}{item.sapCode && ` · SAP: ${item.sapCode}`}
                              </p>
                              {credit && (
                                <p className="mt-0.5 text-xs text-purple-600" title={credit.sources.map((s) => `${s.qty} from ${s.fromCsvFileName}`).join(", ")}>
                                  ✓ {credit.creditedQty} counted from an earlier part
                                </p>
                              )}
                              <p className="mt-1.5 text-sm leading-snug">
                                <span className="font-bold text-gray-900">{scanned}</span>
                                <span className="text-gray-400">/{exp}</span>{" "}
                                <span className="text-gray-400">({expPlt} plt)</span>
                                {remaining > 0 && (
                                  <>
                                    <span className="text-gray-300"> · </span>
                                    <span className="font-semibold text-[#001d6e]">{remaining} left</span>{" "}
                                    <span className="text-purple-500">(≈{remainPlt} plt)</span>
                                  </>
                                )}
                                {extra > 0 && (
                                  <>
                                    <span className="text-gray-300"> · </span>
                                    <span className="font-semibold text-amber-600">+{extra} extra</span>
                                  </>
                                )}
                              </p>
                            </div>
                            <span className="shrink-0">
                              <span className={`inline-block rounded-full px-2.5 py-1 text-xs font-semibold ${
                                effStatus === "complete" ? "bg-emerald-100 text-emerald-700" :
                                effStatus === "partial"  ? "bg-amber-100 text-amber-700" : "bg-gray-100 text-gray-500"
                              }`}>
                                {effStatus === "complete" ? "Received" : effStatus === "partial" ? "Partial" : "Pending"}
                              </span>
                            </span>
                          </div>
                        );
                      })}
                      {/* Card lists get the same closing totals as the tables — the numbers
                          shouldn't disappear just because the screen is narrow. */}
                      {osVisible.length > 0 && (
                        <div className={`flex items-center justify-between gap-3 px-4 py-3 text-sm ${KIOSK_TOTALS_ROW}`}>
                          <span>Total</span>
                          <span className="flex flex-wrap items-center justify-end gap-x-3 tabular-nums">
                            <span>{osKioskTotals.done}/{osKioskTotals.exp}</span>
                            <span className="text-gray-500">({osKioskTotals.expPlt.toFixed(2)} plt)</span>
                            {osKioskTotals.remain > 0 && <span>{osKioskTotals.remain} left</span>}
                            {osKioskTotals.extra > 0 && <span className="text-amber-600">+{osKioskTotals.extra} extra</span>}
                          </span>
                        </div>
                      )}
                    </div>
                  )}
                  {/* 480px and up, landscape orientation, and always when rotated: the table.
                      Matches Master View's table treatment exactly. In kiosk/portrait mode it
                      scrolls inside its own bounded frame (kioskTableBoxClass) so the header and
                      totals row stay put; at other widths it just flows in the page and the
                      page-level nudge/scroll handles it. */}
                  <div className={kioskTableBoxClass}>
                  <table className="min-w-[640px] w-full border-collapse text-base">
                    <thead>
                      <tr className="border-b-2 border-gray-300 bg-gray-100 text-left text-gray-600 sticky top-0">
                        <th className="font-semibold border-r border-gray-300 px-4 py-2.5">Item</th>
                        <th className="font-semibold text-right border-r border-gray-300 px-3 py-2.5">Exp</th>
                        <th className="font-semibold text-right border-r border-gray-300 px-3 py-2.5">Received</th>
                        <th className="font-semibold text-right border-r border-gray-300 px-3 py-2.5">Left</th>
                        <th className="font-semibold text-right border-r border-gray-300 px-3 py-2.5">Extra</th>
                        <th className="font-semibold text-center px-4 py-2.5">Status</th>
                      </tr>
                    </thead>
                    <tbody>
                      {osVisible.map((item) => {
                        const credit    = osCreditByBarcode.get(normalize(item.barcode));
                        const creditQty = credit?.creditedQty ?? 0;
                        // The credit from an earlier part's extra counts toward this part's
                        // progress: it adds to "done" and subtracts from "left". Real over-scan
                        // (extra) on THIS part is unaffected by the credit, but IS folded into
                        // Received below (full physical count) — same convention as Master View.
                        const effScanned = (item.totalScannedQty ?? 0) + creditQty;
                        const exp        = item.expectedQty ?? 0;
                        const extra      = extraByBarcode.get(normalize(item.barcode ?? "")) ?? 0;
                        const scanned    = effScanned + extra;
                        const remaining  = Math.max(0, exp - effScanned);
                        const effStatus  = exp > 0 && effScanned >= exp ? "complete" : effScanned > 0 ? "partial" : "pending";
                        const isOpen = !!osHistoryItem && osHistoryItem.id === item.id;
                        // Pallet figure under each qty (qty ÷ items-per-pallet), same as Master View.
                        const ipp = item.itemsPerPallet ?? 0;
                        const plt = (q: number) => (q > 0 && ipp > 0 ? (q / ipp).toFixed(2) : "0.00");
                        return (
                          <Fragment key={item.id}>
                          <tr className={`border-b border-gray-200 ${
                            effStatus === "complete" ? "bg-emerald-50/40" :
                            effStatus === "partial"  ? "bg-amber-50/30" : undefined
                          }`}>
                            <td className="border-r border-gray-200 min-w-[180px] max-w-[320px] px-4 py-2.5">
                              {/* Item name opens the arrival-history dropdown below the row. */}
                              <button
                                type="button"
                                disabled={!item.barcode}
                                onPointerDown={(e) => e.stopPropagation()}
                                onClick={() => setOsHistoryItem((cur) => (cur && cur.id === item.id ? null : item))}
                                className={`text-left font-medium text-gray-900 whitespace-normal break-words leading-snug underline decoration-dotted underline-offset-2 disabled:no-underline ${isOpen ? "text-[#001d6e] decoration-[#001d6e]" : "decoration-gray-300"}`}
                              >
                                {item.itemName ?? "—"}
                              </button>
                              <p className="text-gray-400 font-mono whitespace-normal break-words">
                                {item.barcode ?? "—"}{item.sapCode && ` · SAP ${item.sapCode}`}
                              </p>
                              {credit && (
                                <p className="text-purple-600 mt-0.5" title={credit.sources.map((s) => `${s.qty} from ${s.fromCsvFileName}`).join(", ")}>
                                  ✓ {credit.creditedQty} counted from an earlier part
                                </p>
                              )}
                            </td>
                            <td className="text-right tabular-nums text-gray-600 border-r border-gray-200 px-3 py-2.5">
                              <span className="block text-lg">{exp || "—"}</span>
                              <span className="block text-sm font-extrabold text-gray-500">{plt(exp)} plt</span>
                            </td>
                            <td className="text-right tabular-nums font-semibold text-gray-900 border-r border-gray-200 px-3 py-2.5">
                              <span className="block text-lg">{scanned}</span>
                              <span className="block text-sm font-extrabold text-gray-500">{plt(scanned)} plt</span>
                            </td>
                            <td className={`text-right tabular-nums font-semibold border-r border-gray-200 px-3 py-2.5 ${remaining > 0 ? "text-[#001d6e]" : "text-gray-300"}`}>
                              <span className="block text-lg">{remaining || "—"}</span>
                              <span className="block text-sm font-extrabold text-gray-500">{plt(remaining)} plt</span>
                            </td>
                            <td className={`text-right tabular-nums font-semibold border-r border-gray-200 px-3 py-2.5 ${extra > 0 ? "text-amber-600" : "text-gray-300"}`}>
                              <span className="block text-lg">{extra > 0 ? `+${extra}` : "—"}</span>
                              <span className="block text-sm font-extrabold text-gray-500">{plt(extra)} plt</span>
                            </td>
                            <td className="text-center px-4 py-2.5">
                              <span className={`inline-block font-semibold px-2.5 py-1 text-xs ${
                                effStatus === "complete" ? "bg-emerald-100 text-emerald-700" :
                                effStatus === "partial"  ? "bg-amber-100 text-amber-700" : "bg-gray-100 text-gray-500"
                              }`}>
                                {effStatus === "complete" ? "Received" : effStatus === "partial" ? "Partial" : "Pending"}
                              </span>
                            </td>
                          </tr>
                          {isOpen && (
                            <tr>
                              <td colSpan={6} className="p-0 border-b border-gray-200">
                                <div ref={osExpandMobileRef}>{mvHistoryPanelMobile}</div>
                              </td>
                            </tr>
                          )}
                          </Fragment>
                        );
                      })}
                      {osVisible.length === 0 && (
                        <tr><td colSpan={6} className="py-10 text-center text-gray-400">
                          {osItems.length === 0 ? "Loading items…" : "No items match."}
                        </td></tr>
                      )}
                      {/* Closing totals — the kiosk/portrait counterpart to the shared
                          DataTable's totals row, pinned to the bottom of the scroll frame the
                          same way (only in bigView, where that frame exists). */}
                      {osVisible.length > 0 && (
                        <tr className={KIOSK_TOTALS_ROW}>
                          <td className={`border-r border-gray-200 px-4 py-2.5 ${bigView ? KIOSK_TOTALS_CELL_PINNED : ""}`}>Total</td>
                          {([
                            ["exp", "expPlt"], ["done", "donePlt"], ["remain", "remainPlt"], ["extra", "extraPlt"],
                          ] as const).map(([qtyKey, pltKey]) => (
                            <td key={qtyKey} className={`text-right tabular-nums border-r border-gray-200 px-3 py-2.5 ${bigView ? KIOSK_TOTALS_CELL_PINNED : ""}`}>
                              <span className="block text-lg">{osKioskTotals[qtyKey].toLocaleString()}</span>
                              <span className="block text-sm font-extrabold text-gray-500">{osKioskTotals[pltKey].toFixed(2)} plt</span>
                            </td>
                          ))}
                          <td className={`px-4 py-2.5 ${bigView ? KIOSK_TOTALS_CELL_PINNED : ""}`} />
                        </tr>
                      )}
                    </tbody>
                  </table>
                  </div>
                </>
              )}
            </div>
              </>
            )}

            {/* ── Master View Tab (mobile) ── */}
            {osTab === "master-view" && (
              <div className="space-y-3">
                {mvQuery.isLoading && <p className="text-sm text-gray-400 animate-pulse py-4 text-center">Loading…</p>}
                {mvData && (
                  <div className="bg-white border border-gray-300 overflow-hidden rounded-xl">
                    {/* Navy header — same treatment as the Scan tab's mobile header. Search
                        replaces the row's content in place (rather than wrapping onto an extra
                        line below), and there's no explicit close button — click outside to
                        hide it (see mvSearchMobileRef/useOutsideClick). */}
                    <div ref={mvSearchMobileRef} className="flex items-center gap-2 px-4 py-3 bg-[#001d6e]">
                      {mvSearchOpen ? (
                        <div className="relative w-full">
                          <Search className="pointer-events-none absolute left-3 top-2.5 h-3.5 w-3.5 text-gray-400" />
                          <Input
                            value={mvSearch}
                            onChange={(e) => setMvSearch(e.target.value)}
                            placeholder="Search items…"
                            className="h-9 rounded-md border-gray-200 bg-gray-50 pl-8 text-sm focus-visible:ring-1 focus-visible:ring-[#001d6e]/30 focus-visible:ring-offset-0"
                            autoFocus
                          />
                          {mvSearch && (
                            <button className="absolute right-2.5 top-2.5" onClick={() => setMvSearch("")}>
                              <X className="h-4 w-4 text-gray-400" />
                            </button>
                          )}
                        </div>
                      ) : (
                        <>
                          <div className="text-white">
                            <p className="text-xl font-bold leading-tight">Items</p>
                            <p className="text-xs text-blue-200">{mvDoneCount} out of {allMvItems.length} received</p>
                          </div>
                          <div className="ml-auto flex items-center gap-2">
                            {allMvItems.length > 0 && (
                              <button
                                onClick={downloadMvCsv}
                                className="inline-flex items-center gap-1.5 rounded-md border border-white/25 bg-white/10 px-2.5 py-1.5 text-xs font-medium text-white hover:bg-white/20"
                              >
                                <Download className="h-3.5 w-3.5" /> Export
                              </button>
                            )}
                            <button
                              onClick={() => setMvSearchOpen(true)}
                              title="Search items"
                              className="inline-flex h-8 w-8 shrink-0 items-center justify-center rounded-md border border-white/25 bg-white/10 text-white hover:bg-white/20"
                            >
                              <Search className="h-3.5 w-3.5" />
                            </button>
                          </div>
                        </>
                      )}
                    </div>

                    {/* Below 480px, or when the device is physically turned to landscape,
                        stacked fields instead of table columns — same as the Scan tab's mobile
                        table above. Master View is view-only, so no click-to-expand history
                        here (that's Scan-tab-only). */}
                    {!osRotated && (
                      <div className="min-[480px]:hidden landscape:hidden">
                        {mvVisible.length === 0 ? (
                          <p className="py-10 text-center text-sm text-gray-400">No items found</p>
                        ) : mvVisible.map((item, idx) => {
                          if (item._isEmptyBox) {
                            return (
                              <div key={idx} className="flex items-center gap-3 border-b border-gray-100 px-4 py-3 bg-orange-50/60">
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
                          const done = item.scannedQty ?? 0;
                          const remain = Math.max(0, exp - done);
                          const extra = item.extraQty ?? 0;
                          const ipp = item.itemsPerPallet ?? 0;
                          const isExtraOnly = item._isExtra;
                          const isDone = done >= exp && exp > 0;
                          const isPartial = done > 0 && !isDone && !isExtraOnly;
                          const expPlt = ipp > 0 ? (exp / ipp).toFixed(2) : "0.00";
                          const remainPlt = ipp > 0 ? (remain / ipp).toFixed(2) : "0.00";
                          return (
                            <div key={idx} className={`flex items-start gap-3 border-b border-gray-100 px-4 py-3 ${
                              isExtraOnly ? "bg-orange-50/40" : isDone ? "bg-emerald-50/40" : isPartial ? "bg-amber-50/30" : undefined
                            }`}>
                              <span className="mt-0.5 shrink-0">
                                {isDone ? (
                                  <span className="flex h-7 w-7 items-center justify-center rounded-full bg-emerald-100">
                                    <CheckCircle2 className="h-4 w-4 text-emerald-600" />
                                  </span>
                                ) : (
                                  <span className={`flex h-7 w-7 items-center justify-center rounded-md border-2 border-dashed ${
                                    isExtraOnly ? "border-orange-300 text-orange-500" : isPartial ? "border-amber-400 text-amber-500" : "border-gray-300 text-gray-400"
                                  }`}>
                                    <Scan className="h-3.5 w-3.5" />
                                  </span>
                                )}
                              </span>
                              <div className="min-w-0 flex-1">
                                <p className="text-[15px] font-semibold leading-snug text-gray-900">{item.itemName ?? "—"}</p>
                                <p className="mt-0.5 font-mono text-xs text-gray-400">
                                  {item.barcode ?? "—"}{item.sapCode && ` · SAP: ${item.sapCode}`}
                                </p>
                                {mvShowFiles && item._files.length > 0 && (
                                  <p className="mt-0.5 text-[11px] text-gray-400" title={item._files.map(stripCsvExt).join(", ")}>
                                    {item._files.length > 1 ? `${item._files.length} files` : stripCsvExt(item._files[0] ?? "")}
                                  </p>
                                )}
                                <p className="mt-1.5 text-sm leading-snug">
                                  <span className="font-bold text-gray-900">{done}</span>
                                  <span className="text-gray-400">/{exp}</span>{" "}
                                  <span className="text-gray-400">({expPlt} plt)</span>
                                  {remain > 0 && (
                                    <>
                                      <span className="text-gray-300"> · </span>
                                      <span className="font-semibold text-[#001d6e]">{remain} left</span>{" "}
                                      <span className="text-purple-500">(≈{remainPlt} plt)</span>
                                    </>
                                  )}
                                  {extra > 0 && (
                                    <>
                                      <span className="text-gray-300"> · </span>
                                      <span className="font-semibold text-amber-600">+{extra} extra</span>
                                    </>
                                  )}
                                </p>
                              </div>
                              <span className="shrink-0">
                                <span className={`inline-block rounded-full px-2.5 py-1 text-xs font-semibold ${
                                  isExtraOnly ? "bg-orange-100 text-orange-700" :
                                  isDone       ? "bg-emerald-100 text-emerald-700" :
                                  isPartial    ? "bg-amber-100 text-amber-700" : "bg-gray-100 text-gray-500"
                                }`}>
                                  {isExtraOnly ? "Extra" : isDone ? "Received" : isPartial ? "Partial" : "Pending"}
                                </span>
                              </span>
                            </div>
                          );
                        })}
                        {mvVisible.length > 0 && (
                          <div className={`flex items-center justify-between gap-3 px-4 py-3 text-sm ${KIOSK_TOTALS_ROW}`}>
                            <span>Total</span>
                            <span className="flex flex-wrap items-center justify-end gap-x-3 tabular-nums">
                              <span>{mvKioskTotals.done}/{mvKioskTotals.exp}</span>
                              <span className="text-gray-500">({mvKioskTotals.expPlt.toFixed(2)} plt)</span>
                              {mvKioskTotals.remain > 0 && <span>{mvKioskTotals.remain} left</span>}
                              {mvKioskTotals.extra > 0 && <span className="text-amber-600">+{mvKioskTotals.extra} extra</span>}
                            </span>
                          </div>
                        )}
                      </div>
                    )}
                    <div className={kioskTableBoxClass}>
                      <table className="min-w-[640px] w-full border-collapse text-base">
                          <thead>
                            {/* sticky top-0 to match the Scan tab's table — it holds inside the
                                kiosk scroll frame the same way the totals row holds at the bottom. */}
                            <tr className="border-b-2 border-gray-300 bg-gray-100 text-left text-gray-600 sticky top-0">
                              <th className="font-semibold border-r border-gray-300 px-4 py-2.5">Item</th>
                              {mvShowFiles && <th className="font-semibold border-r border-gray-300 px-3 py-2.5">File</th>}
                              <th className="font-semibold text-right border-r border-gray-300 px-3 py-2.5">Exp</th>
                              <th className="font-semibold text-right border-r border-gray-300 px-3 py-2.5">Received</th>
                              <th className="font-semibold text-right border-r border-gray-300 px-3 py-2.5">Left</th>
                              <th className="font-semibold text-right border-r border-gray-300 px-3 py-2.5">Extra</th>
                              <th className="font-semibold text-center px-4 py-2.5">Status</th>
                            </tr>
                          </thead>
                          <tbody>
                            {mvVisible.length === 0 ? (
                              <tr><td colSpan={mvShowFiles ? 7 : 6} className="py-10 text-center text-gray-400">No items found</td></tr>
                            ) : mvVisible.map((item, idx) => {
                          if (item._isEmptyBox) {
                            return (
                              <tr key={idx} className="bg-orange-50/60">
                                <td colSpan={mvShowFiles ? 7 : 6} className="px-4 py-3">
                                  <div className="flex items-center gap-3">
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
                                </td>
                              </tr>
                            );
                          }
                              const exp = item.quantity ?? 0;
                              // Done is the full physical count (order + extra), matching mvRowState.
                              const done = item.scannedQty ?? 0;
                              const remain = Math.max(0, exp - done);
                              const extra = item.extraQty ?? 0;
                              const ipp = item.itemsPerPallet ?? 0;
                              // Pallet figure shown under each qty (qty ÷ items-per-pallet). A muted
                              // 0.00 when there's no qty or no configured pallet size.
                              const plt = (q: number) => (q > 0 && ipp > 0 ? (q / ipp).toFixed(2) : "0.00");
                              const isExtraOnly = item._isExtra;
                              const isDone = done >= exp && exp > 0;
                              const isPartial = done > 0 && !isDone && !isExtraOnly;
                              return (
                                <Fragment key={idx}>
                                <tr
                                  className={`border-b border-gray-200 ${
                                    isExtraOnly ? "bg-orange-50/40" : isDone ? "bg-emerald-50/40" : isPartial ? "bg-amber-50/30" : undefined
                                  }`}
                                >
                                  <td className="border-r border-gray-200 min-w-[180px] max-w-[320px] px-4 py-2.5">
                                    {/* Master View is view-only — no click-to-expand history. */}
                                    <p className="font-medium text-gray-900 whitespace-normal break-words leading-snug">
                                      {item.itemName ?? "—"}
                                    </p>
                                    <p className="text-gray-400 font-mono whitespace-normal break-words">
                                      {item.barcode ?? "—"}{item.sapCode && ` · SAP ${item.sapCode}`}
                                    </p>
                                  </td>
                                  {mvShowFiles && (
                                    <td className="text-gray-400 truncate max-w-[100px] border-r border-gray-200 px-3 py-2.5" title={item._files.map(stripCsvExt).join(", ")}>
                                      {item._files.length > 1 ? `${item._files.length} files` : stripCsvExt(item._files[0] ?? "")}
                                    </td>
                                  )}
                                  <td className="text-right tabular-nums text-gray-600 border-r border-gray-200 px-3 py-2.5">
                                    <span className="block text-lg">{exp || "—"}</span>
                                    <span className="block text-sm font-extrabold text-gray-500">{plt(exp)} plt</span>
                                  </td>
                                  <td className="text-right tabular-nums font-semibold text-gray-900 border-r border-gray-200 px-3 py-2.5">
                                    <span className="block text-lg">{done}</span>
                                    <span className="block text-sm font-extrabold text-gray-500">{plt(done)} plt</span>
                                  </td>
                                  <td className={`text-right tabular-nums font-semibold border-r border-gray-200 px-3 py-2.5 ${remain > 0 ? "text-[#001d6e]" : "text-gray-300"}`}>
                                    <span className="block text-lg">{remain || "—"}</span>
                                    <span className="block text-sm font-extrabold text-gray-500">{plt(remain)} plt</span>
                                  </td>
                                  <td className={`text-right tabular-nums font-semibold border-r border-gray-200 px-3 py-2.5 ${extra > 0 ? "text-amber-600" : "text-gray-300"}`}>
                                    <span className="block text-lg">{extra > 0 ? `+${extra}` : "—"}</span>
                                    <span className="block text-sm font-extrabold text-gray-500">{plt(extra)} plt</span>
                                  </td>
                                  <td className="text-center px-4 py-2.5">
                                    <span className={`inline-block font-semibold px-2.5 py-1 text-xs ${
                                      isExtraOnly ? "bg-orange-100 text-orange-700" :
                                      isDone       ? "bg-emerald-100 text-emerald-700" :
                                      isPartial    ? "bg-amber-100 text-amber-700" : "bg-gray-100 text-gray-500"
                                    }`}>
                                      {isExtraOnly ? "Extra" : isDone ? "Received" : isPartial ? "Partial" : "Pending"}
                                    </span>
                                  </td>
                                </tr>
                                </Fragment>
                              );
                            })}
                            {mvVisible.length > 0 && (
                              <tr className={KIOSK_TOTALS_ROW}>
                                <td className={`border-r border-gray-200 px-4 py-2.5 ${bigView ? KIOSK_TOTALS_CELL_PINNED : ""}`}>Total</td>
                                {mvShowFiles && <td className={`border-r border-gray-200 px-3 py-2.5 ${bigView ? KIOSK_TOTALS_CELL_PINNED : ""}`} />}
                                {([
                                  ["exp", "expPlt"], ["done", "donePlt"], ["remain", "remainPlt"], ["extra", "extraPlt"],
                                ] as const).map(([qtyKey, pltKey]) => (
                                  <td key={qtyKey} className={`text-right tabular-nums border-r border-gray-200 px-3 py-2.5 ${bigView ? KIOSK_TOTALS_CELL_PINNED : ""}`}>
                                    <span className="block text-lg">{mvKioskTotals[qtyKey].toLocaleString()}</span>
                                    <span className="block text-sm font-extrabold text-gray-500">{mvKioskTotals[pltKey].toFixed(2)} plt</span>
                                  </td>
                                ))}
                                <td className={`px-4 py-2.5 ${bigView ? KIOSK_TOTALS_CELL_PINNED : ""}`} />
                              </tr>
                            )}
                          </tbody>
                        </table>
                      </div>
                  </div>
                )}
                {!mvQuery.isLoading && !mvData && <p className="text-sm text-gray-400 py-4 text-center">No active session — load a CSV to see its Master View.</p>}
              </div>
            )}

            {/* ── Separate CSVs Tab (mobile) ── */}
            {osTab === "separate-csvs" && (
              <div className="space-y-3">
                <div className="flex flex-wrap items-center gap-2">
                  <Input
                    type="date"
                    value={csvEffDate}
                    onChange={(e) => { setCsvDate(e.target.value); setCsvExpId(null); setCsvSearch(""); }}
                    className="h-8 w-[136px] text-xs"
                  />
                  {!csvEffPlant && (
                    <span className="border border-gray-200 bg-white px-2.5 py-1.5 text-xs text-gray-600 shadow-sm">No active session</span>
                  )}
                  {csvBrowsingOtherDate && (
                    <Button size="sm" variant="ghost" className="h-8 px-2 text-xs text-[#001d6e]" onClick={resetCsvBrowse}>
                      Back to current order
                    </Button>
                  )}
                </div>
                {csvSessQuery.isFetching && <p className="text-sm text-gray-400 animate-pulse py-4 text-center">Loading files…</p>}
                {csvSessions.length === 0 && !csvSessQuery.isFetching && <p className="text-sm text-gray-400 py-4 text-center">No CSVs found for this date{csvEffPlant ? ` / ${csvEffPlant}` : ""}.</p>}
                <div className="space-y-2">
                  {csvSessions.map((sess) => (
                    <div key={sess.id} className="border bg-white shadow-sm overflow-hidden">
                      <button className="flex w-full items-start justify-between gap-2 px-3 py-2.5 hover:bg-gray-50 transition-colors"
                        onClick={() => { if (csvExpId === sess.id) { setCsvExpId(null); setCsvSearch(""); } else { setCsvExpId(sess.id); setCsvSearch(""); } }}>
                        <div className="flex items-start gap-2.5 min-w-0">
                          <Layers className="h-4 w-4 text-gray-400 shrink-0 mt-0.5" />
                          <div className="text-left min-w-0">
                            <div className="flex flex-wrap items-center gap-1.5">
                              <p className="text-sm font-semibold text-gray-900 truncate">{stripCsvExt(sess.csvFileName)}</p>
                              {sess.plant && <PlantBadge plant={sess.plant} />}
                            </div>
                            <div className="mt-1 flex flex-wrap items-center gap-x-2.5 gap-y-1 text-[11px] text-gray-400">
                              <span className="font-semibold text-gray-600">{sess.rowCount} rows</span>
                              <span className="font-semibold text-gray-600">{sess.totalQty} qty · {sess.totalPallets.toFixed(2)} plt</span>
                              <span>By {sess.importedByName ?? "Unknown"}</span>
                              <span>Order date: {scanFmtOrderDate(sess.orderDate)}</span>
                              <span>Uploaded: {scanFmtIST(sess.createdAt)}</span>
                            </div>
                          </div>
                        </div>
                        <ChevronDown className={`h-4 w-4 text-gray-400 shrink-0 mt-0.5 transition-transform ${csvExpId === sess.id ? "rotate-180" : ""}`} />
                      </button>
                      {csvExpId === sess.id && (
                        <div className="border-t">
                          <div className="px-3 py-2 bg-gray-50 border-b">
                            <div className="relative">
                              <Search className="absolute left-2.5 top-1/2 -translate-y-1/2 h-3.5 w-3.5 text-gray-400 pointer-events-none" />
                              <input value={csvSearch} onChange={(e) => setCsvSearch(e.target.value)} placeholder="Search…"
                                className="w-full border border-gray-200 bg-white pl-8 pr-3 py-1.5 text-xs focus:outline-none focus:ring-2 focus:ring-[#001d6e]" />
                              {csvSearch && <button onClick={() => setCsvSearch("")} className="absolute right-2 top-1/2 -translate-y-1/2"><X className="h-3 w-3 text-gray-400" /></button>}
                            </div>
                          </div>
                          {csvItemsQuery2.isFetching && <p className="px-3 py-4 text-sm text-gray-400 animate-pulse text-center">Loading items…</p>}
                          {/* Structured table (business style): square corners, grid borders, full
                              item names — matching the Scan/Master View tables, so all three tabs
                              read as one system. */}
                          {!csvItemsQuery2.isFetching && (
                            bigView ? (
                              <div className={kioskTableBoxClass}>
                                <table className="min-w-[640px] w-full border-collapse text-sm">
                                  <thead>
                                    <tr className="border-b-2 border-gray-300 bg-gray-100 text-left text-gray-600 sticky top-0">
                                      <th className="font-semibold border-r border-gray-300 px-4 py-2.5">Item</th>
                                      <th className="font-semibold text-right border-r border-gray-300 px-3 py-2.5">Exp</th>
                                      <th className="font-semibold text-right border-r border-gray-300 px-3 py-2.5">Received</th>
                                      <th className="font-semibold text-right border-r border-gray-300 px-3 py-2.5">Left</th>
                                      <th className="font-semibold text-right border-r border-gray-300 px-3 py-2.5">Extra</th>
                                      <th className="font-semibold text-center px-4 py-2.5">Status</th>
                                    </tr>
                                  </thead>
                                  <tbody>
                                    {filtCsvItems.length === 0 ? (
                                      <tr><td colSpan={6} className="py-10 text-center text-gray-400">No items</td></tr>
                                    ) : filtCsvItems.map((item) => {
                                      const exp = item.quantity ?? 0;
                                      const done = item.scannedQty ?? 0;
                                      const remain = Math.max(0, exp - done);
                                      const extra = item.extraQty ?? 0;
                                      const isDone = done >= exp && exp > 0;
                                      const isPartial = done > 0 && !isDone;
                                      // Pallet figure under each qty, same as the Scan and Master
                                      // View tables.
                                      const ipp = impItemsPerPallet(item);
                                      const plt = (q: number) => (q > 0 && ipp > 0 ? (q / ipp).toFixed(2) : "0.00");
                                      return (
                                        <tr key={item.id} className={`border-b border-gray-200 ${
                                          isDone ? "bg-emerald-50/40" : isPartial ? "bg-amber-50/30" : undefined
                                        }`}>
                                          <td className="border-r border-gray-200 min-w-[180px] max-w-[320px] px-4 py-2.5">
                                            <p className="font-medium text-gray-900 whitespace-normal break-words leading-snug">{item.itemName ?? "—"}</p>
                                            <p className="text-gray-400 font-mono whitespace-normal break-words">
                                              {item.barcode ?? "—"}{item.sapCode && ` · SAP ${item.sapCode}`}
                                            </p>
                                          </td>
                                          <td className="text-right tabular-nums text-gray-600 border-r border-gray-200 px-3 py-2.5">
                                            <span className="block">{exp || "—"}</span>
                                            <span className="block text-xs font-extrabold text-gray-500">{plt(exp)} plt</span>
                                          </td>
                                          <td className="text-right tabular-nums font-semibold text-gray-900 border-r border-gray-200 px-3 py-2.5">
                                            <span className="block">{done}</span>
                                            <span className="block text-xs font-extrabold text-gray-500">{plt(done)} plt</span>
                                          </td>
                                          <td className={`text-right tabular-nums font-semibold border-r border-gray-200 px-3 py-2.5 ${remain > 0 ? "text-[#001d6e]" : "text-gray-300"}`}>
                                            <span className="block">{remain || "—"}</span>
                                            <span className="block text-xs font-extrabold text-gray-500">{plt(remain)} plt</span>
                                          </td>
                                          <td className={`text-right tabular-nums font-semibold border-r border-gray-200 px-3 py-2.5 ${extra > 0 ? "text-amber-600" : "text-gray-300"}`}>
                                            <span className="block">{extra > 0 ? `+${extra}` : "—"}</span>
                                            <span className="block text-xs font-extrabold text-gray-500">{plt(extra)} plt</span>
                                          </td>
                                          <td className="text-center px-4 py-2.5">
                                            <span className={`inline-block font-semibold px-2.5 py-1 text-xs ${
                                              isDone ? "bg-emerald-100 text-emerald-700" : isPartial ? "bg-amber-100 text-amber-700" : "bg-gray-100 text-gray-500"
                                            }`}>
                                              {isDone ? "Received" : isPartial ? "Partial" : "Pending"}
                                            </span>
                                          </td>
                                        </tr>
                                      );
                                    })}
                                    {filtCsvItems.length > 0 && (
                                      <tr className={KIOSK_TOTALS_ROW}>
                                        <td className={`border-r border-gray-200 px-4 py-2.5 ${KIOSK_TOTALS_CELL_PINNED}`}>Total</td>
                                        {([
                                          ["exp", "expPlt"], ["done", "donePlt"], ["remain", "remainPlt"], ["extra", "extraPlt"],
                                        ] as const).map(([qtyKey, pltKey]) => (
                                          <td key={qtyKey} className={`text-right tabular-nums border-r border-gray-200 px-3 py-2.5 ${KIOSK_TOTALS_CELL_PINNED}`}>
                                            <span className="block">{csvTotals[qtyKey].toLocaleString()}</span>
                                            <span className="block text-xs font-extrabold text-gray-500">{csvTotals[pltKey].toFixed(2)} plt</span>
                                          </td>
                                        ))}
                                        <td className={`px-4 py-2.5 ${KIOSK_TOTALS_CELL_PINNED}`}></td>
                                      </tr>
                                    )}
                                  </tbody>
                                </table>
                              </div>
                            ) : (
                              /* Card list — matches the Scan/Master View mobile treatment. */
                              <div>
                                {filtCsvItems.length === 0 ? (
                                  <p className="py-10 text-center text-sm text-gray-400">No items</p>
                                ) : filtCsvItems.map((item) => {
                                  const exp = item.quantity ?? 0;
                                  const done = item.scannedQty ?? 0;
                                  const remain = Math.max(0, exp - done);
                                  const extra = item.extraQty ?? 0;
                                  const isDone = done >= exp && exp > 0;
                                  const isPartial = done > 0 && !isDone;
                                  const ipp = impItemsPerPallet(item);
                                  const expPlt = ipp > 0 ? (exp / ipp).toFixed(2) : "0.00";
                                  const remainPlt = ipp > 0 ? (remain / ipp).toFixed(2) : "0.00";
                                  return (
                                    <div key={item.id} className={`flex items-start gap-3 border-b border-gray-100 px-4 py-3 ${
                                      isDone ? "bg-emerald-50/40" : isPartial ? "bg-amber-50/30" : undefined
                                    }`}>
                                      <span className="mt-0.5 shrink-0">
                                        {isDone ? (
                                          <span className="flex h-7 w-7 items-center justify-center rounded-full bg-emerald-100">
                                            <CheckCircle2 className="h-4 w-4 text-emerald-600" />
                                          </span>
                                        ) : (
                                          <span className={`flex h-7 w-7 items-center justify-center rounded-md border-2 border-dashed ${
                                            isPartial ? "border-amber-400 text-amber-500" : "border-gray-300 text-gray-400"
                                          }`}>
                                            <Scan className="h-3.5 w-3.5" />
                                          </span>
                                        )}
                                      </span>
                                      <div className="min-w-0 flex-1">
                                        <p className="text-[15px] font-semibold leading-snug text-gray-900">{item.itemName ?? "—"}</p>
                                        <p className="mt-0.5 font-mono text-xs text-gray-400">
                                          {item.barcode ?? "—"}{item.sapCode && ` · SAP: ${item.sapCode}`}
                                        </p>
                                        <p className="mt-1.5 text-sm leading-snug">
                                          <span className="font-bold text-gray-900">{done}</span>
                                          <span className="text-gray-400">/{exp}</span>{" "}
                                          <span className="text-gray-400">({expPlt} plt)</span>
                                          {remain > 0 && (
                                            <>
                                              <span className="text-gray-300"> · </span>
                                              <span className="font-semibold text-[#001d6e]">{remain} left</span>{" "}
                                              <span className="text-purple-500">(≈{remainPlt} plt)</span>
                                            </>
                                          )}
                                          {extra > 0 && (
                                            <>
                                              <span className="text-gray-300"> · </span>
                                              <span className="font-semibold text-amber-600">+{extra} extra</span>
                                            </>
                                          )}
                                        </p>
                                      </div>
                                      <span className="shrink-0">
                                        <span className={`inline-block rounded-full px-2.5 py-1 text-xs font-semibold ${
                                          isDone ? "bg-emerald-100 text-emerald-700" : isPartial ? "bg-amber-100 text-amber-700" : "bg-gray-100 text-gray-500"
                                        }`}>
                                          {isDone ? "Received" : isPartial ? "Partial" : "Pending"}
                                        </span>
                                      </span>
                                    </div>
                                  );
                                })}
                                {filtCsvItems.length > 0 && (
                                  <div className={`flex items-center justify-between gap-3 px-4 py-3 text-sm ${KIOSK_TOTALS_ROW}`}>
                                    <span>Total</span>
                                    <span className="flex flex-wrap items-center justify-end gap-x-3 tabular-nums">
                                      <span>{csvTotals.done}/{csvTotals.exp}</span>
                                      <span className="text-gray-500">({csvTotals.expPlt.toFixed(2)} plt)</span>
                                      {csvTotals.remain > 0 && <span>{csvTotals.remain} left</span>}
                                      {csvTotals.extra > 0 && <span className="text-amber-600">+{csvTotals.extra} extra</span>}
                                    </span>
                                  </div>
                                )}
                              </div>
                            )
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

        {/* ══════════════════════════════════════════════════════════════════════════════════════════════════════ */}
      <div className={bigView ? "hidden" : "hidden lg:block"}>        
          <div className="mx-auto w-full max-w-[1800px] space-y-3">

            {/* Header row */}
            <div className="flex items-center justify-between gap-2 flex-wrap">
              <div className="flex items-center gap-3 min-w-0">
                <div className="flex h-9 w-9 shrink-0 items-center justify-center bg-amber-400">
                  <Scan className="h-4 w-4 text-white" />
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
                  <p className="mt-1.5 flex items-center gap-1.5 text-xs text-gray-500 truncate">
                    {/* Plant-switch dropdown — always shown (replaces the old plant tab strip
                        above and the plain badge that used to sit here). Lists every plant
                        with an active scan session right now; picking one switches to it,
                        same as the old tabs did. Colored from Plant Management, same as
                        every other PlantBadge in the app. */}
                    <Select
                      value={String(activeOrderScanSession.id)}
                      onValueChange={(v) => {
                        const picked = osPlantSwitchOptions.find((s) => String(s.id) === v);
                        selectPlantSession(Number(v), picked?.plant);
                      }}
                    >
                      <SelectTrigger
                        className="h-6 w-auto gap-1 rounded-full border px-2.5 py-0 text-xs font-semibold shadow-none focus:ring-0 [&>svg]:h-3.5 [&>svg]:w-3.5"
                        style={(() => {
                          const cfg = getPlantColorCfg(activeOrderScanSession.plant);
                          return cfg ? { backgroundColor: cfg.bgColor, color: cfg.textColor, borderColor: cfg.borderColor } : undefined;
                        })()}
                      >
                        <SelectValue />
                      </SelectTrigger>
                      <SelectContent>
                        {osPlantSwitchOptions.map((s) => {
                          const cfg = getPlantColorCfg(s.plant);
                          return (
                            <SelectItem key={s.id} value={String(s.id)}>
                              <span className="flex items-center gap-1.5">
                                <span
                                  className="h-2 w-2 shrink-0 rounded-full border"
                                  style={cfg ? { backgroundColor: cfg.bgColor, borderColor: cfg.borderColor } : undefined}
                                />
                                {s.plant}
                              </span>
                            </SelectItem>
                          );
                        })}
                      </SelectContent>
                    </Select>
                    {activeOrderScanSession.importedByName && <span>· loaded by {activeOrderScanSession.importedByName}</span>}
                  </p>
                </div>
              </div>
              <div className="flex items-center gap-2 shrink-0">
                <Progress value={osPct} className="w-28 h-2" />
                <span className="text-xs font-medium text-gray-600 whitespace-nowrap">{osDoneCount}/{osTotalCount} received</span>
                {canCompletePart && (
                  <Button size="sm" className="h-8 px-3 rounded-full text-xs bg-emerald-600 hover:bg-emerald-700 text-white" onClick={() => setShowForceComplete(true)}>
                    Complete
                  </Button>
                )}
              </div>
            </div>

            {/* ── Tab strip ── */}
            <div className="flex flex-wrap items-center justify-between gap-1.5">
              <div className="flex flex-wrap gap-1.5">
                {(["master-view", "scan", "separate-csvs"] as const).map((t) => (
                  <button
                    key={t}
                    onClick={() => setOsTab(t)}
                    className={`flex items-center gap-1.5 rounded-xl px-4 py-1.5 text-sm font-medium transition-colors ${
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
              {/* STV — sits on the right of the tab strip, so it's visible no matter which tab
                  (Master View / Scan / Part Order) is active, instead of only inside one tab. */}
              {stvs.length > 0 ? (
                <Select
                  value={osSelectedStv || NO_STV}
                  onValueChange={(v) => setOsSelectedStv(v === NO_STV ? "" : v)}
                >
                  <SelectTrigger
                    className={`h-7 w-full max-w-[9rem] justify-center rounded-full text-center text-xs font-semibold sm:w-36 ${
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
              ) : !osStvsQuery.isLoading && (
                <span className="border border-dashed border-amber-300 bg-amber-50 px-2 py-1 text-xs text-amber-700">
                  No STV — create one in Plant Settings
                </span>
              )}
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
                  <p className="text-sm font-semibold uppercase tracking-wide text-gray-500">Order Totals</p>
                  <p className="text-sm font-medium text-gray-400">
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
                    { key: "done", label: "Received", value: displayTotals.done, plt: displayTotals.palletsDone, dot: "bg-emerald-500", text: "text-emerald-600" },
                    { key: "remaining", label: "Remaining", value: displayTotals.remaining, plt: displayTotals.palletsRemaining, dot: "bg-red-500", text: "text-red-600" },
                    { key: "extra", label: "Extra", value: displayTotals.extra, plt: displayTotals.palletsExtra, dot: "bg-orange-500", text: displayTotals.extra > 0 ? "text-amber-600" : "text-gray-300" },
                  ] as const).map((s) => {
                    const isActive = osStatFilter === s.key;
                    return (
                      <button
                        key={s.label}
                        type="button"
                        onClick={() => setOsStatFilter(isActive ? "" : s.key)}
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
                  <div className="h-2 w-full overflow-hidden rounded-full bg-gray-100">
                    <div
                      className="h-full rounded-full bg-emerald-500 transition-[width] duration-300"
                      style={{ width: `${displayTotals.expected > 0 ? Math.min(100, (displayTotals.done / displayTotals.expected) * 100) : 0}%` }}
                    />
                  </div>
                  <div className="flex justify-between text-[10px] font-medium text-gray-400">
                    <span>{displayTotals.done} received</span>
                    <span>{displayTotals.remaining} remaining</span>
                  </div>
                </div>
              </div>
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

              {/* Scanner controls sit beside the totals: STV picker, then the mode buttons under it.
                  Padding/gaps match the Order Totals card (p-2.5/gap-1.5) so the two cards read as
                  the same height and the items table can start higher on screen. */}
              <div className="flex flex-col gap-1 rounded-xl border bg-white p-2 shadow-sm">
                {/* Equal-width halves via grid-cols-2; both share one height so they read as a pair. */}
                <div className="grid grid-cols-2 gap-2">
                  <Button
                    variant={osScanMode === "camera" ? "default" : "outline"}
                    title="Camera"
                    className={`h-7 w-full rounded-full text-xs font-semibold ${osScanMode === "camera" ? "bg-[#001d6e] hover:bg-[#00154b] text-white" : ""}`}
                    onClick={() => setOsScanMode("camera")}>
                    <Camera className="mr-1.5 h-4 w-4" /> Camera
                  </Button>
                  <Button
                    variant={osScanMode === "manual" ? "default" : "outline"}
                    title="Manual — or plug in a barcode gun and scan"
                    className={`h-7 w-full rounded-full text-xs font-semibold ${osScanMode === "manual" ? "bg-[#001d6e] hover:bg-[#00154b] text-white" : ""}`}
                    onClick={() => { stopOsCamera(); setOsScanMode("manual"); }}>
                    <Keyboard className="mr-1.5 h-4 w-4" /> Manual
                  </Button>
                </div>
                {/* Camera card — always in DOM so ref stays set; hidden via display:none when not in camera mode */}
                <Card className="rounded-xl shadow-sm" style={{ display: osScanMode === "camera" ? "block" : "none", overflow: "hidden", isolation: "isolate" }}>
                  <div className="relative bg-black" style={{ height: "150px" }}>
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
                        <div className="h-16 w-48 border-2 border-white/70" />
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
                    <CardContent className="p-2 space-y-1">
                      <Label className="text-[10px] font-semibold uppercase tracking-wide text-gray-500">Enter item name or barcode</Label>
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
                            className="font-mono text-xs h-7 w-full rounded-full"
                            autoFocus
                          />
                          {osManualFocused && osSuggestions.length > 0 && (
                            <div className="absolute left-0 right-0 top-full z-50 mt-1 rounded-xl border border-gray-200 bg-white shadow-lg overflow-hidden">
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
                          className="bg-[#001d6e] hover:bg-[#00154b] text-white shrink-0 h-7 w-7 p-0 rounded-full">
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
                    disabled={!activeOrderScanSession || activeOrderScanSession.scanStatus === "completed" || !!osPending || !canScanWrite}
                    onClick={() => { setEmptyBoxQty("1"); setEmptyBoxNote(""); setShowEmptyBox(true); }}
                    className="flex-1 h-7 rounded-full text-xs border-amber-300 text-amber-700 hover:bg-amber-50"
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
              {osTab === "scan" && (
                <div className="overflow-hidden rounded-xl border border-gray-200 bg-white shadow-sm">
                  {/* Headerless — the "Items" title is gone; the icon toggles a search bar inline. */}
                  <div ref={osSearchDesktopRef} className="flex flex-wrap items-center gap-2 border-b border-gray-200 px-4 py-2.5">
                    <span className="text-xs font-medium text-gray-500">{osDoneCount} / {osTotalCount} received</span>
                    {/* No explicit close — clicking outside (osSearchDesktopRef) hides it. */}
                    <button
                      onClick={() => setOsSearchOpen(true)}
                      title="Search items"
                      className={`ml-auto inline-flex h-8 w-8 shrink-0 items-center justify-center rounded-md border ${
                        osSearchOpen
                          ? "border-[#001d6e] bg-[#001d6e]/5 text-[#001d6e]"
                          : "border-gray-200 bg-white text-gray-500 hover:bg-gray-50"
                      }`}
                    >
                      <Search className="h-3.5 w-3.5" />
                    </button>
                    {osSearchOpen && (
                      <div className="relative w-full sm:w-64">
                        <Search className="pointer-events-none absolute left-2.5 top-2 h-3.5 w-3.5 text-gray-400" />
                        <input
                          value={osSearch}
                          onChange={(e) => setOsSearch(e.target.value)}
                          placeholder="Search by name or barcode…"
                          autoFocus
                          className="h-8 w-full rounded-md border border-gray-200 bg-gray-50 pl-7 pr-6 text-xs text-gray-700 placeholder:text-gray-400 focus:bg-white focus:outline-none focus:ring-1 focus:ring-[#001d6e]/30"
                        />
                        {osSearch && (
                          <button
                            type="button"
                            onClick={() => setOsSearch("")}
                            className="absolute right-2 top-2 text-gray-400 hover:text-gray-600"
                          >
                            <X className="h-3.5 w-3.5" />
                          </button>
                        )}
                      </div>
                    )}
                  </div>
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
                    renderExpandedRow={() => <div ref={osExpandDesktopRef}>{mvHistoryPanel}</div>}
                    isRowExpandable={(item) => !!item.barcode}
                    expandedRowId={osHistoryItem ? String(osHistoryItem.id) : null}
                    sortMode="client"
                    enableTotalsRow
                    totalsLabelColumnId="itemName"
                    columnOrder={osColumnOrder}
                    onColumnOrderChange={setOsColumnOrder}
                    enableColumnResizing
                    isStickyHeader
                    maxHeight="max(420px, calc(100vh - 340px))"
                    showMobileSwipeHint
                    headerClassName="bg-[#001d6e] text-white border-[#1a3a9c] hover:bg-[#0a2b7e] hover:text-white"
                  />
                </div>
              )}
              {osTab === "master-view" && (
                <div className="space-y-4">
                  {mvQuery.isLoading && <p className="text-sm text-gray-400 animate-pulse">Loading…</p>}
                  {mvData && (
                    <div>
                      {mvShowFiles && (
                      <div className="flex flex-wrap gap-2 mb-3">
                        {mvData.files.map((f) => (
                          <span key={f.sessionId} className="inline-flex items-center gap-1.5 rounded-full border border-gray-200 bg-white px-3 py-1 text-xs text-gray-600">
                            <Layers className="h-3 w-3 text-gray-400" />
                            {stripCsvExt(f.csvFileName)} <span className="text-gray-400">· {f.rowCount ?? f.items.length} rows</span>
                          </span>
                        ))}
                      </div>
                      )}
                      {/* Same card+header treatment as the Scan tab: an item-count on the left,
                          border-b separating the header from the table, instead of a floating
                          row above a separately-bordered card. */}
                      <div className="overflow-hidden rounded-xl border border-gray-200 bg-white shadow-sm">
                        <div ref={mvSearchDesktopRef} className="flex flex-wrap items-center gap-2 border-b border-gray-200 px-4 py-2.5">
                          <span className="text-xs font-medium text-gray-500">{mvVisible.length} of {allMvItems.length} items</span>
                          <div className="ml-auto flex items-center gap-2">
                            {allMvItems.length > 0 && (
                              <button
                                onClick={downloadMvCsv}
                                className="inline-flex items-center gap-1.5 rounded-xl border border-gray-200 bg-white px-2.5 py-1.5 text-xs font-medium text-gray-700 shadow-sm hover:bg-gray-50"
                              >
                                <Download className="h-3.5 w-3.5" /> Export
                              </button>
                            )}
                            {/* No explicit close — clicking outside (mvSearchDesktopRef) hides it. */}
                            <button
                              onClick={() => setMvSearchOpen(true)}
                              title="Search items"
                              className={`inline-flex h-8 w-8 shrink-0 items-center justify-center rounded-full border shadow-sm ${
                                mvSearchOpen ? "border-[#001d6e] bg-[#001d6e]/5 text-[#001d6e]" : "border-gray-200 bg-white text-gray-500 hover:bg-gray-50"
                              }`}
                            >
                              <Search className="h-3.5 w-3.5" />
                            </button>
                            {mvSearchOpen && (
                              <div className="relative w-full sm:w-64">
                                <Search className="pointer-events-none absolute left-2.5 top-2 h-3.5 w-3.5 text-gray-400" />
                                <input
                                  value={mvSearch}
                                  onChange={(e) => setMvSearch(e.target.value)}
                                  placeholder="Search items…"
                                  autoFocus
                                  className="h-8 w-full rounded-md border border-gray-200 bg-gray-50 pl-7 pr-6 text-xs text-gray-700 placeholder:text-gray-400 focus:bg-white focus:outline-none focus:ring-1 focus:ring-[#001d6e]/30"
                                />
                                {mvSearch && (
                                  <button
                                    type="button"
                                    onClick={() => setMvSearch("")}
                                    className="absolute right-2 top-2 text-gray-400 hover:text-gray-600"
                                  >
                                    <X className="h-3.5 w-3.5" />
                                  </button>
                                )}
                              </div>
                            )}
                          </div>
                        </div>
                        <DataTable<MvMergedItem>
                          className="space-y-0"
                          containerClassName="rounded-none border-0"
                          columns={mvColumns}
                          data={mvVisible}
                          getRowId={(item) => mvRowKey(item)}
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
                          enableTotalsRow
                          totalsLabelColumnId="itemName"
                          columnOrder={mvColumnOrder}
                          onColumnOrderChange={setMvColumnOrder}
                          enableColumnVisibility
                          columnVisibility={mvVisibleColumnIds}
                          enableColumnResizing
                          isStickyHeader
                          maxHeight="max(420px, calc(100vh - 340px))"
                          showMobileSwipeHint
                          headerClassName="bg-[#001d6e] text-white border-[#1a3a9c] hover:bg-[#0a2b7e] hover:text-white"
                        />
                      </div>
                    </div>
                  )}
                  {!mvQuery.isLoading && !mvData && <p className="text-sm text-gray-400">No active session — load a CSV to see its Master View.</p>}
                </div>
              )}
              </div>


            {/* ── Separate CSVs Tab (desktop) ── */}
            {osTab === "separate-csvs" && (
              <div className="space-y-4">
                <div className="flex flex-wrap items-center gap-3">
                  <Input
                    type="date"
                    value={csvEffDate}
                    onChange={(e) => { setCsvDate(e.target.value); setCsvExpId(null); setCsvSearch(""); }}
                    className="h-8 w-[140px] text-xs"
                  />
                  {!csvEffPlant && (
                    <span className="rounded-xl border border-gray-200 bg-white px-3 py-1.5 text-sm text-gray-600 shadow-sm">No active session</span>
                  )}
                  {csvBrowsingOtherDate && (
                    <Button size="sm" variant="ghost" className="h-8 px-2 text-xs text-[#001d6e]" onClick={resetCsvBrowse}>
                      Back to current order
                    </Button>
                  )}
                </div>
                {csvSessQuery.isFetching && <p className="text-sm text-gray-400 animate-pulse">Loading files…</p>}
                {csvSessions.length === 0 && !csvSessQuery.isFetching && <p className="text-sm text-gray-400">No CSVs found for this date{csvEffPlant ? ` / ${csvEffPlant}` : ""}.</p>}
                <div className="space-y-2">
                  {csvSessions.map((sess) => (
                    <div key={sess.id} className="border bg-white shadow-sm overflow-hidden">
                      <button className="flex w-full items-start justify-between gap-3 px-4 py-3 hover:bg-gray-50 transition-colors"
                        onClick={() => { if (csvExpId === sess.id) { setCsvExpId(null); setCsvSearch(""); } else { setCsvExpId(sess.id); setCsvSearch(""); } }}>
                        <div className="flex items-start gap-3 min-w-0">
                          <Layers className="h-4 w-4 text-gray-400 shrink-0 mt-0.5" />
                          <div className="text-left min-w-0">
                            <div className="flex flex-wrap items-center gap-2">
                              <p className="text-sm font-semibold text-gray-900 truncate">{stripCsvExt(sess.csvFileName)}</p>
                              {sess.plant && <PlantBadge plant={sess.plant} />}
                            </div>
                            <div className="mt-1 flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-gray-400">
                              <span className="font-semibold text-gray-600">{sess.rowCount} rows</span>
                              <span className="font-semibold text-gray-600">{sess.totalQty} qty · {sess.totalPallets.toFixed(2)} plt</span>
                              <span>By {sess.importedByName ?? "Unknown"}</span>
                              <span>Order date: {scanFmtOrderDate(sess.orderDate)}</span>
                              <span>Uploaded: {scanFmtIST(sess.createdAt)}</span>
                            </div>
                          </div>
                        </div>
                        <ChevronDown className={`h-4 w-4 text-gray-400 shrink-0 mt-0.5 transition-transform ${csvExpId === sess.id ? "rotate-180" : ""}`} />
                      </button>
                      {csvExpId === sess.id && (
                        <div className="border-t p-3">
                          <div className="overflow-hidden rounded-xl border border-gray-200 bg-white shadow-sm">
                            {/* Headerless — the "Items" title is gone; the icon toggles a search bar inline. */}
                            <div className="flex flex-wrap items-center gap-2 border-b border-gray-200 px-4 py-2.5">
                              <span className="text-xs font-medium text-gray-500">{filtCsvItems.length} of {csvImpItems.length} items</span>
                              <button
                                onClick={() => setCsvSearchOpen((v) => { if (v) setCsvSearch(""); return !v; })}
                                title={csvSearchOpen ? "Close search" : "Search items"}
                                className={`ml-auto inline-flex h-8 w-8 shrink-0 items-center justify-center rounded-md border ${
                                  csvSearchOpen
                                    ? "border-[#001d6e] bg-[#001d6e]/5 text-[#001d6e]"
                                    : "border-gray-200 bg-white text-gray-500 hover:bg-gray-50"
                                }`}
                              >
                                {csvSearchOpen ? <X className="h-3.5 w-3.5" /> : <Search className="h-3.5 w-3.5" />}
                              </button>
                              {csvSearchOpen && (
                                <div className="relative w-full sm:w-64">
                                  <Search className="pointer-events-none absolute left-2.5 top-2 h-3.5 w-3.5 text-gray-400" />
                                  <input
                                    value={csvSearch}
                                    onChange={(e) => setCsvSearch(e.target.value)}
                                    placeholder="Search items…"
                                    autoFocus
                                    className="h-8 w-full rounded-md border border-gray-200 bg-gray-50 pl-7 pr-6 text-xs text-gray-700 placeholder:text-gray-400 focus:bg-white focus:outline-none focus:ring-1 focus:ring-[#001d6e]/30"
                                  />
                                  {csvSearch && (
                                    <button
                                      type="button"
                                      onClick={() => setCsvSearch("")}
                                      className="absolute right-2 top-2 text-gray-400 hover:text-gray-600"
                                    >
                                      <X className="h-3.5 w-3.5" />
                                    </button>
                                  )}
                                </div>
                              )}
                            </div>
                            <DataTable<ImpItem>
                              className="space-y-0"
                              containerClassName="rounded-none border-0"
                              columns={csvColumns}
                              data={filtCsvItems}
                              getRowId={(item) => String(item.id)}
                              isLoading={csvItemsQuery2.isFetching}
                              loadingLabel="Loading items…"
                              emptyState="No items"
                              noResultsState="No items match your search."
                              hasActiveFilters={!!csvSearch}
                              enableZebraStripes
                              rowClassName={(item) => {
                                const exp = item.quantity ?? 0;
                                const done = item.scannedQty ?? 0;
                                const isDone = done >= exp && exp > 0;
                                const isPartial = done > 0 && !isDone;
                                return isDone ? "bg-emerald-50/40" : isPartial ? "bg-amber-50/30" : undefined;
                              }}
                              sortMode="client"
                              // Was a hand-written tfoot pinned to the bottom; now the shared
                              // totals row, so this table matches Scan/Master View/Reports/Overall
                              // Stock — pinned under the header AND repeated at the end.
                              enableTotalsRow
                              columnOrder={csvColumnOrder}
                              onColumnOrderChange={setCsvColumnOrder}
                              enableColumnResizing
                              isStickyHeader
                              maxHeight="max(420px, calc(100vh - 340px))"
                              showMobileSwipeHint
                              headerClassName="bg-[#001d6e] text-white border-[#1a3a9c] hover:bg-[#0a2b7e] hover:text-white"
                            />
                          </div>
                        </div>
                      )}
                    </div>
                  ))}
                </div>
              </div>
            )}

          </div>
        </div>

        {/* Empty Box dialog — manual entry (quantity + optional note), plus undo of prior entries.
            Radix portals this to document.body, outside the .kiosk-rotate-90 subtree (same as the
            STV SelectContent above), so it doesn't inherit the page rotation on its own — it opens
            upright and off-axis while everything else is rotated. It's centered (left/top 50% +
            translate -50%/-50%), not corner-anchored like the Select dropdown, so a plain rotate-90
            around its own (default, center) transform-origin lines it back up with the rotated
            page — no origin utility needed here. */}
        <Dialog open={showEmptyBox} onOpenChange={(o) => { if (!o) setShowEmptyBox(false); }}>
          <DialogContent className={`w-[calc(100%-2rem)] max-w-sm ${osPortalRotate}`}>
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
                      <div key={en.id} className="flex items-center gap-2 text-xs bg-amber-50/60 px-2 py-1.5">
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
                disabled={osEmptyBoxMutation.isPending || !(Number(emptyBoxQty) >= 1) || !canScanWrite}
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

        {/* Void confirmation — requires a reason, mirroring Scan History's own void dialog.
            (The history itself is no longer a Dialog — it's the inline expanded row shown
            directly below the clicked item via mvHistoryPanel/renderExpandedRow.) */}
        <Dialog open={!!mvVoidTarget} onOpenChange={(o) => { if (!o) { setMvVoidTarget(null); setMvVoidReason(""); } }}>
          <DialogContent className="w-[calc(100%-2rem)] max-w-sm">
            <DialogHeader>
              <DialogTitle className="text-red-600">Void this scan?</DialogTitle>
              <DialogDescription>
                This reverses its stock impact and excludes it from totals — the entry stays visible in history, marked as voided.
              </DialogDescription>
            </DialogHeader>
            <div className="space-y-1.5 py-1">
              <Label htmlFor="mv-void-reason" className="text-xs">Reason</Label>
              <Input
                id="mv-void-reason"
                value={mvVoidReason}
                onChange={(e) => setMvVoidReason(e.target.value)}
                placeholder="e.g. scanned wrong item, duplicate scan"
                autoFocus
              />
            </div>
            <DialogFooter>
              <Button variant="outline" onClick={() => { setMvVoidTarget(null); setMvVoidReason(""); }}>Cancel</Button>
              <Button
                className="bg-red-600 hover:bg-red-700 text-white"
                disabled={mvVoidMutation.isPending || !mvVoidReason.trim()}
                onClick={() => mvVoidTarget && mvVoidMutation.mutate({ id: mvVoidTarget.id, reason: mvVoidReason.trim() })}
              >
                {mvVoidMutation.isPending ? <Loader2 className="h-4 w-4 animate-spin" /> : "Void Scan"}
              </Button>
            </DialogFooter>
          </DialogContent>
        </Dialog>

        {/* Multi-match selection dialog — Radix portals this to document.body, outside the
            .kiosk-rotate-90 subtree, so (like the Empty Box dialog) it needs the rotate class
            applied manually or it opens upright while the rest of the kiosk screen is rotated. */}
        <Dialog open={!!osMultiMatch} onOpenChange={(o) => { if (!o) { setOsMultiMatch(null); resetOsConfirmation(); } }}>
          <DialogContent className={`w-[calc(100%-2rem)] max-w-sm ${osPortalRotate}`}>
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
                    className={`w-full border-2 px-4 py-3 text-left transition-colors hover:border-[#001d6e] hover:bg-[#001d6e]/5 ${
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

        {/* Scan confirmation dialog. Radix portals it to <body>, outside the .kiosk-rotate-*
            container, so on a rotated screen it would otherwise appear upright while everything
            else is turned. The rotate class composes with Radix's centering transform
            (translate(-50%,-50%)) to turn the whole dialog to match — so it reads correctly on the
            physical screen (and only looks turned in a normal landscape screenshot).
            Only a QUARTER turn swaps its on-screen width/height, so only then is it sized against
            the swapped viewport axes (w/max-w in vh, max-h in vw); a half turn keeps the normal
            sizing and just flips it. Either way it scrolls so it always fits. */}
        <Dialog open={!!osPending} onOpenChange={(o) => { if (!o) { setOsPending(null); osPendingRef.current = null; resetOsConfirmation(); } }}>
          <DialogContent
            className={`overflow-y-auto rounded-2xl p-0 ${osPortalRotate} ${
              osQuarterTurn
                ? "w-[92vh] max-w-[92vh] max-h-[92vw]"
                : "w-[calc(100%-2rem)] max-w-2xl sm:max-w-4xl max-h-[90vh]"}`}
          >
            {/* Two columns: full-height product image on the left, all controls on the right.
                Under rotate-90 (clockwise), CSS-left maps to physical-top — so image-left reads as
                image-on-top with the details below it on the physical portrait screen. */}
            <div className="flex flex-col sm:flex-row">
              {osResolvedImageName && !osImageFailed && (
                <div className="flex shrink-0 items-center justify-center border-b border-gray-100 bg-gray-50 p-4 sm:w-80 sm:border-b-0 sm:border-r">
                  <img
                    key={osResolvedImageName}
                    src={`/api/products/image-by-name?name=${encodeURIComponent(osResolvedImageName)}`}
                    alt=""
                    className="max-h-96 w-full object-contain sm:max-h-full"
                    onError={() => setOsImageFailed(true)}
                  />
                </div>
              )}
              <div className="min-w-0 flex-1 p-6">
            <DialogHeader>
              <DialogTitle className={`flex items-center gap-2.5 text-2xl ${
                !osPending?.matchedItem ? "text-red-700"
                : osItemIsComplete ? "text-amber-700"
                : "text-[#001d6e]"
              }`}>
                {!osPending?.matchedItem
                  ? <><AlertTriangle className="h-7 w-7" /> Not in order</>
                  : osItemIsComplete
                    ? <><AlertTriangle className="h-7 w-7" /> Extra item</>
                    : <><CheckCircle2 className="h-7 w-7" /> Match found</>}
              </DialogTitle>
              <DialogDescription className="text-left space-y-1.5 min-w-0 pt-3">
                <p className="font-bold text-gray-900 text-2xl leading-snug">{osPending?.matchedItem?.itemName ?? osPending?.inventoryProduct?.name ?? osPending?.barcode}</p>
                <p className="font-mono text-lg text-gray-400">{osPending?.barcode}</p>
                {!osPending?.matchedItem && (
                  <p className="text-lg text-red-600 mt-1">Not in the CSV — will be logged as extra.</p>
                )}
                {osItemIsComplete && (
                  <p className="text-lg text-amber-600 mt-1">Order already complete — these extra boxes will be logged separately.</p>
                )}
              </DialogDescription>
            </DialogHeader>

            <div className="space-y-4 py-1">
              {/* Inventory + CSV info */}
              {(osPending?.inventoryProduct || osPending?.matchedItem) && (
                <div className="rounded-xl bg-gray-50 px-4 py-3 text-base text-gray-600 space-y-1.5">
                  {osPending.inventoryProduct?.sapCode && (
                    <p>SAP: <span className="font-mono font-bold text-gray-700">{osPending.inventoryProduct.sapCode}</span></p>
                  )}
                  {osPending.matchedItem && (
                    <div className={`space-y-1 ${osPending.inventoryProduct ? "border-t border-gray-200 pt-1.5" : ""}`}>
                      <p>
                        Items per pallet:{" "}
                        <strong>{osPending.plantPalletSize || "—"}</strong>
                        {osPending.plantPalletSize !== (osPending.matchedItem.itemsPerPallet ?? 0) && osPending.matchedItem.itemsPerPallet ? (
                          <span className="text-blue-500 ml-1">
                            ({(() => {
                              const state = getPlantState(activeOrderScanSession?.plant ?? "");
                              if (state === "GJ") return "GJ PLT";
                              if (state === "MP") return "MP PLT";
                              return "inventory";
                            })()})
                          </span>
                        ) : null}
                      </p>
                      <p>Expected: <strong>{osPending.matchedItem.expectedQty}</strong> · Received Qty: <strong className="text-green-600">{osPending.matchedItem.totalScannedQty}</strong></p>
                      {(() => {
                        const remaining = Math.max(0, (osPending.matchedItem.expectedQty ?? 0) - (osPending.matchedItem.totalScannedQty ?? 0));
                        const remainingPallets = plt > 0 ? (remaining / plt).toFixed(2) : null;
                        return (
                          <p>
                            Remaining: <strong className="text-red-600">{remaining}</strong> boxes
                            {remainingPallets != null && <> · <strong className="text-base font-bold text-red-600">{remainingPallets}</strong> plt</>}
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
                    <SelectTrigger className={`w-full rounded-xl ${!osSelectedStv ? "border-dashed text-gray-400" : ""}`}>
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
              
              {/* Qty (boxes) and Pallets side by side — each with −/+ steppers. Editing either one
                  recalculates the other (2-way box↔pallet conversion). */}
              {/* Off-rotation: Qty + Pallets side by side (sm:grid-cols-2). Rotated: keep a single
                  CSS column — the rotate-90 turns that vertical stack into the side-by-side pair
                  the kiosk layout expects (a CSS two-column grid would rotate into a stacked pair). */}
              <div className={`grid gap-3 ${plt > 1 && !osQuarterTurn ? "sm:grid-cols-2" : "grid-cols-1"}`}>
                {/* Qty — −/+ step one box at a time. */}
                <div className="space-y-1">
                  <Label className="text-sm">Qty (boxes)</Label>
                  {/* One bordered box holding −, the number, and + together. */}
                  <div className="flex items-stretch overflow-hidden rounded-xl border-2 border-gray-300 bg-white focus-within:border-[#001d6e]">
                    <Button
                      type="button" variant="ghost"
                      className="h-14 w-14 shrink-0 rounded-none border-r border-gray-200 text-3xl font-bold text-gray-500 hover:bg-gray-100"
                      onClick={() => {
                        const q = Math.max(1, osQty - 1);
                        setOsQty(q);
                        setOsPalletsInput(plt > 0 ? (q / plt).toFixed(2) : "");
                      }}
                      aria-label="Decrease quantity"
                    >
                      −
                    </Button>
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
                      className="text-center text-3xl font-bold h-14 flex-1 rounded-none border-0 focus-visible:ring-0 focus-visible:ring-offset-0"
                      autoFocus
                    />
                    <Button
                      type="button" variant="ghost"
                      className="h-14 w-14 shrink-0 rounded-none border-l border-gray-200 text-3xl font-bold text-gray-500 hover:bg-gray-100"
                      onClick={() => {
                        const q = osQty + 1;
                        setOsQty(q);
                        setOsPalletsInput(plt > 0 ? (q / plt).toFixed(2) : "");
                      }}
                      aria-label="Increase quantity"
                    >
                      +
                    </Button>
                  </div>
                </div>

                {/* Pallets — −/+ step one full pallet; only shown when a pallet size is configured. */}
                {plt > 1 && (
                  <div className="space-y-1">
                    <Label className="text-sm">Pallets <span className="font-normal text-gray-400">· {plt}/pallet</span></Label>
                    {/* One bordered box holding −, the pallet count, and + together. */}
                    <div className="flex items-stretch overflow-hidden rounded-xl border-2 border-[#001d6e]/30 bg-white focus-within:border-[#001d6e]">
                      <Button
                        type="button" variant="ghost"
                        className="h-14 w-14 shrink-0 rounded-none border-r border-[#001d6e]/15 text-3xl font-bold text-[#001d6e] hover:bg-[#001d6e]/5"
                        onClick={() => {
                          const p = Math.max(0, Math.round(((parseFloat(osPalletsInput) || 0) - 1) * 100) / 100);
                          setOsPalletsInput(p.toFixed(2));
                          setOsQty(Math.max(1, Math.round(p * plt)));
                        }}
                        aria-label="Decrease pallets"
                      >
                        −
                      </Button>
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
                        className="text-center text-3xl font-bold text-[#001d6e] h-14 flex-1 rounded-none border-0 focus-visible:ring-0 focus-visible:ring-offset-0"
                      />
                      <Button
                        type="button" variant="ghost"
                        className="h-14 w-14 shrink-0 rounded-none border-l border-[#001d6e]/15 text-3xl font-bold text-[#001d6e] hover:bg-[#001d6e]/5"
                        onClick={() => {
                          const p = Math.round(((parseFloat(osPalletsInput) || 0) + 1) * 100) / 100;
                          setOsPalletsInput(p.toFixed(2));
                          setOsQty(Math.round(p * plt));
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
              <Button variant="outline" className="rounded-xl" onClick={() => { setOsPending(null); osPendingRef.current = null; resetOsConfirmation(); }}>
                Cancel
              </Button>
              <Button
                onClick={handleOsConfirmScan}
                disabled={osScanMutation.isPending || (stvs.length > 0 && !osSelectedStv) || !canScanWrite}
                className={`rounded-xl ${(!osPending?.matchedItem || osItemIsComplete)
                  ? "bg-amber-600 hover:bg-amber-700 text-white"
                  : "bg-[#001d6e] hover:bg-[#00154b] text-white"}`}
              >
                {osScanMutation.isPending && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
                {(!osPending?.matchedItem || osItemIsComplete) ? "Log as Extra" : "Confirm Scan"}
              </Button>
            </DialogFooter>
              </div>
            </div>
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
    );
  }

  return (
    <div className={`flex-1 overflow-y-auto bg-white p-4 lg:p-6 ${kioskRotateClass}`}>
      <RotateToggleButton />
      <div className="mx-auto w-full max-w-[1800px] space-y-4">
        <CameraPermissionBanner onPermissionGranted={() => toast({ title: "Camera Permission Granted", description: "You can now start scanning. Click 'New Scan Order' to begin." })} />

        {/* Greeting Header */}
        <div className="bg-gradient-to-r from-[#001d6e] to-[#1a3a9c] px-4 py-3 shadow-md">
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
            <div className="bg-white shadow-sm border border-gray-100 overflow-hidden">
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
            <div className="bg-white shadow-sm border border-gray-200 overflow-hidden">
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
                  <table className="w-full min-w-[720px] border-collapse text-xs">
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
          <div className="bg-white shadow-sm border border-gray-100 overflow-hidden py-20 text-center">
            <ScanLine className="h-10 w-10 text-gray-200 mx-auto mb-3" />
            <p className="text-gray-500 font-medium">No active scan session right now</p>
            <p className="text-sm text-gray-400 mt-1">An admin needs to activate a CSV for your plant before you can start scanning.</p>
          </div>
        )}
      </div>
    </div>
  );
}
