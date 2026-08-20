import { Fragment, useEffect, useMemo, useRef, useState } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { format } from "date-fns";
import { CheckCircle2, ChevronDown, ChevronLeft, ChevronUp, Eye, Layers, ListFilter, Loader2, Pencil, Plus, RotateCw, ScanLine, X } from "lucide-react";
import { useAuth } from "@/hooks/use-auth";
import { useToast } from "@/hooks/use-toast";
import { hasPageWriteAccess } from "@/lib/permissions";
import { apiRequest } from "@/lib/queryClient";
import { PlantBadge } from "@/components/PlantBadge";
import { TableCard } from "@/components/ui/table-card";
import { CollapsibleSearch } from "@/components/ui/collapsible-search";
import { DataTable, type DataTableColumn } from "@/components/ui/data-table";
import { ColumnHeaderFilterButton, ColumnFilterPopoverContent } from "@/components/filters/ColumnFilterChip";
import { type FilterableColumn, type FilterCondition, conditionSummary, matchAllConditions } from "@/lib/columnFilters";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Select, SelectContent, SelectItem, SelectTrigger, SelectValue,
} from "@/components/ui/select";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import {
  Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription, DialogFooter,
} from "@/components/ui/dialog";

// ── Types ──────────────────────────────────────────────────────────────────

type Plant = { id: number; name: string; bgColor?: string | null; textColor?: string | null; borderColor?: string | null };

// Matches GET /api/order-import/sessions' row shape (only the fields this page needs).
type SessionOption = {
  id: number;
  plant: string;
  csvFileName: string;
  orderDate: string | null;
  scanStatus: string | null;
  partIndex: number | null;
  importedByName?: string | null;
  scanActivatedAt?: string | null;
  scanCompletedAt?: string | null;
};

// Matches GET /api/order-scan/sessions/:id/items.
type OsScanItem = {
  id: number; sessionId: number;
  barcode: string | null; itemName: string | null; sapCode: string | null;
  expectedQty: number; itemsPerPallet: number;
  // The item's real, defined GJ/MP PLT pack size (0 when not configured) — informational only,
  // distinct from itemsPerPallet above which can be a per-scan fallback. See its comment in
  // server/routes/order-scan.ts's /items endpoint.
  realPackSize?: number;
  scannedPallets: number; scannedLooseQty: number; totalScannedQty: number;
  status: string; lastScannedAt: string | null;
};

// Matches GET /api/order-scan/sessions/:id/extras (grouped, un-voided only).
type ExtraRow = { barcode: string; itemName: string | null; totalQty: number; partIndexes: number[] };

// One raw item row from GET /api/order-import/master-view's files[].items — a single CSV
// part's line for one barcode, before merging across parts (see MvMergedItem below).
type MvRawItem = {
  id: number; barcode: string | null; itemName: string | null; sapCode: string | null;
  quantity: number | null; scannedQty: number | null; isExtra: boolean; lastScannedAt: string | null;
  // The item's real GJ/MP PLT pack size (0/absent when not configured) — same informational
  // field as realPackSize elsewhere on this page, resolved server-side.
  itemsPerPallet?: number;
};
type MvFile = { sessionId: number; csvFileName: string; plant: string; items: MvRawItem[] };
type MvResponse = { date: string; totalFiles: number; totalRows: number; files: MvFile[] };

// Master View = one consolidated row per item across EVERY CSV part of this plant+date order,
// mirroring the Scan Order page's own Master View tab (allMvItems in Scan.tsx) — same merge
// rule: same barcode (falling back to item name) across every file sums into one row, and an
// item that was scanned but never appeared on ANY of the order's CSVs shows up here too (the
// server already includes those as isExtra rows — see order-import.ts's "Fold in extra scans"
// comment), permanently, regardless of how long ago it was scanned.
type MvMergedItem = {
  barcode: string | null; itemName: string | null; sapCode: string | null;
  quantity: number; scannedQty: number; extraQty: number; itemsPerPallet: number;
  isExtraOnly: boolean; lastScannedAt: string | null;
};

// Matches GET /api/order-import/master-view/item-history.
type HistoryEvent = {
  id: number; sessionId: number; barcode: string; itemName: string | null;
  pallets: number | null; totalQty: number; isExtra: boolean; stv: string | null;
  scannedByName: string | null; scannedAt: string;
  voided: boolean | null; voidedAt: string | null; voidReason: string | null;
  orderName: string; partIndex: number | null;
};

const normalize = (v?: string | null) => String(v ?? "").trim().toLowerCase();

/** "2026-08-03" → "03 Aug 2026" — how the Scan Order header renders an order date. */
function fmtOrderDate(value: string | null): string {
  if (!value) return "—";
  const d = new Date(value);
  return isNaN(d.getTime()) ? value : format(d, "dd MMM yyyy");
}

// Kiosk rotation steps — a full turn, so a screen mounted at any angle can be matched. Mirrors the
// Scan Order page's own control (see .kiosk-rotate-* in index.css for the mechanics).
const ROTATIONS = [0, 90, 180, 270] as const;
type Rotation = (typeof ROTATIONS)[number];

// Pins the kiosk table's totals row to the bottom of its scroll frame. The background has to live
// on the CELLS: a <tr> background paints at the row's natural position and does not travel with
// sticky cells, so a bare row tint would be left behind and rows would scroll through in the clear.
const KIOSK_TOTALS_CELL = "sticky bottom-0 z-[5] bg-[#f5f6f9] shadow-[inset_0_2px_0_0_rgba(0,29,110,0.2)]";

// Filters survive leaving the page and coming back — they live in component state, so navigating
// away used to drop whatever the table had been narrowed to. sessionStorage rather than
// localStorage: a filter is working context for the current sitting, not a preference that should
// still be applied when the app is opened fresh tomorrow.
const VIEWER_FILTERS_KEY = "scanViewer:filters";

type SavedViewerFilters = {
  search?: string;
  conditions?: Record<string, FilterCondition>;
};

function readSavedViewerFilters(): SavedViewerFilters {
  try {
    return JSON.parse(sessionStorage.getItem(VIEWER_FILTERS_KEY) ?? "{}") as SavedViewerFilters;
  } catch {
    // Corrupt or unreadable (private-mode storage throws) — start clean rather than break the page.
    return {};
  }
}

function getLocalISODate(date = new Date()): string {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

// A read-only replica of the Scan tab's CSV Items table (same Item/Exp/Received/Left/Extra/
// Status columns), except instead of always following whichever session happens to be
// "active" for your plant, you pick a plant + order date first and it shows that order's
// data instead — including already-completed ones. Deliberately filters-first: nothing is
// fetched until both are chosen, and every filter change re-queries the server rather than
// filtering an already-loaded set client-side.
// Void is included (click a row to see its scan history, void a mistaken entry from there)
// but gated by its own "scan-viewer" Write Access — independent of Scan Order/Scan History's
// write access, so someone can be trusted to look things up and correct a mistake without
// being able to do anything else on the real Scan Order page. See requireVoidAccess in
// server/routes/order-scan.ts for the matching server-side rule.
export default function ScanViewer() {
  const { user } = useAuth();
  const { toast } = useToast();
  const qc = useQueryClient();

  const isAdminOrSuper = ["admin", "super-admin"].includes(((user as any)?.role ?? "").toLowerCase());
  const canVoidScan = isAdminOrSuper || hasPageWriteAccess("scan-viewer");

  // Same plant scoping as the Scan page's own "Active:" switcher — admin/super-admin see
  // every plant, everyone else only the plant(s) actually assigned to them (users.plants).
  const myPlantNames: string[] = (() => {
    try {
      const parsed = JSON.parse((user as any)?.plants ?? "[]");
      return Array.isArray(parsed) ? parsed.map((p: any) => String(p)) : [];
    } catch { return []; }
  })();

  const [plant, setPlant] = useState("");
  // Defaults to today — "the live order date" — rather than blank, so the page shows
  // something immediately instead of starting on an empty screen. Still fully backend-driven:
  // this is just the initial value handed to the same filter, not a client-side default view.
  const [date, setDate] = useState(() => getLocalISODate());
  const [sessionId, setSessionId] = useState<number | null>(null);
  // Seeded from whatever was left applied last time — see VIEWER_FILTERS_KEY.
  const [search, setSearch] = useState(() => readSavedViewerFilters().search ?? "");

  // ── Kiosk rotation — the same control the Scan Order page has, for a screen mounted at an
  // angle. Its own storage key, so the two pages can sit on differently-mounted screens.
  // Its own storage key, so this page and Scan Order can sit on differently-mounted screens.
  const [rotation, setRotation] = useState<Rotation>(() => {
    const saved = Number(localStorage.getItem("scanViewerRotation"));
    return (ROTATIONS as readonly number[]).includes(saved) ? (saved as Rotation) : 0;
  });
  useEffect(() => { localStorage.setItem("scanViewerRotation", String(rotation)); }, [rotation]);
  const rotateNext = () => setRotation((r) => ROTATIONS[(ROTATIONS.indexOf(r) + 1) % ROTATIONS.length]);
  const isRotated = rotation !== 0;
  const isQuarterTurn = rotation === 90 || rotation === 270;
  // Natural portrait (window taller than wide) gets the same big, single-column treatment as the
  // manual Rotate mode, just without the 90° turn — the screen is already upright. Mirrors the
  // Scan Order page's own isPortrait/bigView split.
  const [isPortrait, setIsPortrait] = useState(
    () => typeof window !== "undefined" && window.matchMedia("(orientation: portrait)").matches,
  );
  useEffect(() => {
    const mq = window.matchMedia("(orientation: portrait)");
    const onChange = () => setIsPortrait(mq.matches);
    mq.addEventListener("change", onChange);
    return () => mq.removeEventListener("change", onChange);
  }, []);
  const bigView = isRotated || isPortrait;
  const rotateClass = isRotated ? `kiosk-rotate-${rotation}` : "";
  // Radix portals dialogs to <body>, outside the rotated container, so they need the matching turn
  // applied by hand or they open upright while everything behind them is rotated.
  const portalRotate = rotation === 90 ? "rotate-90" : rotation === 180 ? "rotate-180" : rotation === 270 ? "-rotate-90" : "";
  // Rotated, the page's own scroll moves content sideways on the physical screen, so it gets the
  // same Up/Down nudge buttons the Scan Order page uses rather than relying on wheel/swipe.
  const pageScrollRef = useRef<HTMLDivElement>(null);
  // A quarter turn swaps the axes: the table's height then runs along the viewport's WIDTH, so it
  // has to be capped in vw there or the box is sized against the wrong dimension entirely.
  const tableMaxHeight = isQuarterTurn
    ? "max(420px, calc(100vw - 340px))"
    : "max(420px, calc(100vh - 340px))";
  // Bounded scroll frame for the kiosk table below, so its header holds at the top and its totals
  // row at the bottom. Same unit flip as above: a quarter turn puts content-space height along the
  // viewport's WIDTH, so it caps in vw there and vh when upright or naturally portrait.
  const kioskTableBoxClass = `overflow-auto kiosk-scroll ${isQuarterTurn ? "max-h-[62vw]" : "max-h-[62vh]"}`;
  // Rotated, the page's own scroll moves content sideways on the physical screen (a rigid turn
  // swaps which axis is "vertical"), so it gets discrete Up/Down buttons rather than relying on a
  // wheel/swipe whose direction no longer matches what the viewer sees. scrollBy drives the same
  // container either way. Same treatment as the Scan Order page.
  const ScrollNudgeButtons = ({ targetRef, amount = 360 }: {
    targetRef: React.RefObject<HTMLElement>; amount?: number;
  }) => {
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
  };

  const RotateButton = () => (
    <button
      type="button"
      onClick={rotateNext}
      className="fixed bottom-4 right-4 z-[60] flex items-center gap-2 rounded-full bg-[#001d6e] px-4 py-3 text-white shadow-lg transition-colors hover:bg-[#00154b]"
      title={`Rotate the screen (now ${rotation}°) — steps a quarter turn each press, back to 0° after 270°`}
    >
      <RotateCw className="h-5 w-5" />
    </button>
  );

  const filtersReady = !!plant && !!date;

  // Same two-tab split the Scan Order page has: Master View (everything in this order merged
  // into one row per item, across every CSV part) vs Part View (this page's original behavior —
  // pick one specific CSV/part and see just its items). Defaults to Master View since that's
  // the "whole picture" view most lookups want first.
  // Part Order was removed as a separate tab — switching which CSV/part you're looking at now
  // happens via the "Select part…" picker in the tab row (always visible, next to the date
  // picker), which drives this same "scan" tab directly instead of needing its own tab.
  const [viewerTab, setViewerTab] = useState<"master-view" | "scan">("master-view");

  const { data: allPlants } = useQuery<Plant[]>({
    queryKey: ["/api/plants"],
    queryFn: () => apiRequest("GET", "/api/plants").then((r) => r.json()),
    staleTime: 60000,
  });

  // Plant pills to show — this user's own assigned plants, or every plant for admins.
  const plantOptions = isAdminOrSuper
    ? (allPlants ?? []).map((p) => p.name)
    : myPlantNames.map((p) => p.toUpperCase());

  // Plant Management's configured colors for a plant — same source/lookup the Scan Order
  // page's own plant switcher uses (getPlantColorCfg there), so this page's plant switcher is
  // colored consistently with every other PlantBadge in the app instead of a flat, uncolored
  // dropdown that doesn't match what's actually saved in Plant Management.
  const getPlantColorCfg = (plantName: string | null | undefined) => {
    const name = (plantName ?? "").trim().toUpperCase();
    if (!name || !allPlants) return null;
    return allPlants.find((p) => String(p.name ?? "").trim().toUpperCase() === name) ?? null;
  };

  // Same source the Scan page's own switcher uses — already scoped server-side to this
  // user's plants. Used here to resolve each plant's currently-active order date, so picking
  // a plant snaps the date to what's actually live for it instead of leaving whatever date a
  // previously-selected plant happened to be on.
  const activeSessionsQuery = useQuery<{ plant: string; orderDate: string | null }[]>({
    queryKey: ["/api/order-scan/active-sessions", "scan-viewer"],
    queryFn: () => apiRequest("GET", "/api/order-scan/active-sessions").then((r) => r.json()),
    staleTime: 30000,
  });
  const activeDateByPlant = new Map(
    (activeSessionsQuery.data ?? [])
      .filter((s) => !!s.orderDate)
      .map((s) => [normalize(s.plant), s.orderDate as string]),
  );

  // Picking a plant (including the initial default below) also sets the date to that
  // plant's live active order date, if it has one right now — falling back to today when it
  // doesn't, rather than carrying over whatever date a different plant happened to be on.
  const selectPlant = (p: string) => {
    setPlant(p);
    setSessionId(null);
    setDate(activeDateByPlant.get(normalize(p)) ?? getLocalISODate());
  };

  // Default to the first plant available once the list is known, same as the Scan page
  // defaulting to whichever plant it resolves for you rather than leaving it unset. Waits for
  // active-sessions to have loaded (or failed) too, so this default also gets the right date
  // in one step instead of picking a plant now and correcting the date a moment later.
  useEffect(() => {
    if (!plant && plantOptions.length > 0 && !activeSessionsQuery.isLoading) {
      selectPlant(plantOptions[0]);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [plantOptions.join(","), activeSessionsQuery.isLoading]);

  // Nothing is fetched until both filters are picked — this query is disabled otherwise, and
  // every value it depends on is in the queryKey, so changing plant/date always re-queries the
  // server instead of re-filtering whatever was loaded before.
  const sessionsQuery = useQuery<{ sessions: SessionOption[]; total: number }>({
    queryKey: ["/api/order-import/sessions", "scan-viewer", plant, date],
    queryFn: () =>
      apiRequest("GET", `/api/order-import/sessions?plant=${encodeURIComponent(plant)}&date=${encodeURIComponent(date)}&pageSize=50`)
        .then((r) => r.json()),
    enabled: filtersReady,
  });
  const sessionOptions = (sessionsQuery.data?.sessions ?? [])
    .slice()
    .sort((a, b) => (a.partIndex ?? 0) - (b.partIndex ?? 0));

  // Default to the first (lowest part number) session once the list for this plant/date
  // loads, or clear the selection if the filters changed and it no longer applies.
  useEffect(() => {
    if (sessionOptions.length === 0) { setSessionId(null); return; }
    if (!sessionOptions.some((s) => s.id === sessionId)) {
      setSessionId(sessionOptions[0].id);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sessionOptions.map((s) => s.id).join(",")]);

  // Master View data — same endpoint the Scan Order page's own Master View tab reads, scoped to
  // this page's plant/date pickers instead of "whichever session is currently active."
  const mvQuery = useQuery<MvResponse>({
    queryKey: ["/api/order-import/master-view", "scan-viewer", plant, date],
    queryFn: () =>
      apiRequest("GET", `/api/order-import/master-view?date=${encodeURIComponent(date)}&plant=${encodeURIComponent(plant)}`)
        .then((r) => r.json()),
    enabled: filtersReady && viewerTab === "master-view",
  });

  // Merges every file's items by barcode (falling back to item name for a barcode-less row) —
  // same rule as allMvItems in Scan.tsx. An item that's isExtra on every contributing row (i.e.
  // never appeared on ANY of the order's CSVs) stays flagged isExtraOnly; one that's extra on
  // some rows and a real CSV line on others is folded into the normal quantity instead, same as
  // the Scan Order page's own Master View.
  const allMvItems: MvMergedItem[] = useMemo(() => {
    if (!mvQuery.data) return [];
    const groups = new Map<string, MvMergedItem>();
    mvQuery.data.files.forEach((f) => {
      f.items.forEach((item) => {
        const key = item.barcode?.trim().toLowerCase()
          || (item.itemName ? `name::${item.itemName.trim().toLowerCase()}` : `id::${item.id}`);
        let g = groups.get(key);
        if (!g) {
          g = {
            barcode: item.barcode, itemName: item.itemName, sapCode: item.sapCode,
            quantity: 0, scannedQty: 0, extraQty: 0, itemsPerPallet: 0,
            isExtraOnly: true, lastScannedAt: null,
          };
          groups.set(key, g);
        }
        g.quantity += item.quantity ?? 0;
        g.scannedQty += item.scannedQty ?? 0;
        if (item.isExtra) g.extraQty += item.scannedQty ?? 0;
        if (!item.isExtra) g.isExtraOnly = false;
        if (!g.itemName && item.itemName) g.itemName = item.itemName;
        if (!g.sapCode && item.sapCode) g.sapCode = item.sapCode;
        if (!g.itemsPerPallet && item.itemsPerPallet) g.itemsPerPallet = item.itemsPerPallet;
        if (item.lastScannedAt && (!g.lastScannedAt || new Date(item.lastScannedAt) > new Date(g.lastScannedAt))) {
          g.lastScannedAt = item.lastScannedAt;
        }
      });
    });
    return Array.from(groups.values());
  }, [mvQuery.data]);

  const itemsQuery = useQuery<OsScanItem[]>({
    queryKey: ["/api/order-scan/sessions", sessionId, "items", "scan-viewer"],
    queryFn: () => apiRequest("GET", `/api/order-scan/sessions/${sessionId}/items`).then((r) => r.json()),
    enabled: sessionId != null,
  });
  const extrasQuery = useQuery<ExtraRow[]>({
    queryKey: ["/api/order-scan/sessions", sessionId, "extras", "scan-viewer"],
    queryFn: () => apiRequest("GET", `/api/order-scan/sessions/${sessionId}/extras`).then((r) => r.json()),
    enabled: sessionId != null,
  });
  const extraByBarcode = new Map((extrasQuery.data ?? []).map((e) => [normalize(e.barcode), e.totalQty ?? 0]));
  // Which part(s) each barcode's extra actually happened on (the endpoint now spans the whole
  // order group, not just this one part) — used to label an extra "from Part X" when it isn't
  // this part's own, same as the Scan tab.
  const extraPartIndexesByBarcode = new Map((extrasQuery.data ?? []).map((e) => [normalize(e.barcode), e.partIndexes ?? []]));
  const currentPartIndex = sessionOptions.find((s) => s.id === sessionId)?.partIndex ?? null;

  // Every part sharing this plant + order date — history spans the whole order, not just the
  // one part currently selected above, same as the Scan tab's own drill-down.
  const groupSessionIds = sessionOptions.map((s) => s.id);

  // ── Master View derived data ──────────────────────────────────────────────
  // Local copy of the same qty÷ipp rule used everywhere on this page (see pltQty further down)
  // — defined here too since this block runs before that declaration in source order.
  const mvPltQty = (qty: number, ipp: number) => (qty > 0 && ipp > 0 ? qty / ipp : 0);
  const mvRowState = (i: MvMergedItem) => ({
    exp: i.quantity,
    received: i.scannedQty,
    left: Math.max(0, i.quantity - i.scannedQty),
    extra: i.extraQty,
  });
  const mvSearched = useMemo(() => {
    const q = search.trim().toLowerCase();
    if (!q) return allMvItems;
    return allMvItems.filter((i) => [i.itemName, i.barcode, i.sapCode].some((v) => v?.toLowerCase().includes(q)));
  }, [allMvItems, search]);
  const [mvStatFilter, setMvStatFilter] = useState<"" | "done" | "remaining" | "extra">("");
  const mvFiltered = !mvStatFilter
    ? mvSearched
    : mvSearched.filter((i) => {
        const { received, left, extra } = mvRowState(i);
        if (mvStatFilter === "done") return received > 0;
        if (mvStatFilter === "remaining") return left > 0;
        return extra > 0;
      });
  const mvTotals = allMvItems.reduce((acc, i) => {
    const { exp, received, left, extra } = mvRowState(i);
    const ipp = i.itemsPerPallet ?? 0;
    acc.expected += exp;
    acc.done += Math.min(received, exp);
    acc.remaining += left;
    acc.extra += extra;
    if (ipp > 0) {
      acc.palletsExpected += exp / ipp;
      acc.palletsDone += Math.min(received, exp) / ipp;
      acc.palletsRemaining += left / ipp;
      acc.palletsExtra += extra / ipp;
    }
    return acc;
  }, { expected: 0, done: 0, remaining: 0, extra: 0, palletsExpected: 0, palletsDone: 0, palletsRemaining: 0, palletsExtra: 0 });
  // Totals for the Master View kiosk table / card list closing row — over whatever's on screen
  // (search + stat filter), same rule the Part View table's own totals row follows.
  const mvCardTotals = mvFiltered.reduce((acc, i) => {
    const { exp, received, left, extra } = mvRowState(i);
    const ipp = i.itemsPerPallet ?? 0;
    acc.exp += exp; acc.received += received; acc.left += left; acc.extra += extra;
    acc.expPlt += mvPltQty(exp, ipp); acc.receivedPlt += mvPltQty(received, ipp);
    acc.leftPlt += mvPltQty(left, ipp); acc.extraPlt += mvPltQty(extra, ipp);
    return acc;
  }, { exp: 0, received: 0, left: 0, extra: 0, expPlt: 0, receivedPlt: 0, leftPlt: 0, extraPlt: 0 });

  // ── STV filter (page level) ──────────────────────────────────────────────
  // Every other filter on this page reads a field that's already on the loaded item rows. STV
  // isn't one — it's recorded per scan EVENT — so it comes from the existing per-session events
  // endpoint (one call per part of the order), and the item↔STV mapping is derived here on the
  // client, same as the other filters' option lists are.
  const eventsQuery = useQuery<{ barcode: string | null; stv: string | null; voided: boolean | null }[]>({
    queryKey: ["/api/order-scan/sessions", "events", "scan-viewer", groupSessionIds.join(",")],
    queryFn: async () => {
      const pages = await Promise.all(
        groupSessionIds.map((id) =>
          apiRequest("GET", `/api/order-scan/sessions/${id}/events?limit=5000`).then((r) => r.json()),
        ),
      );
      return pages.flat();
    },
    enabled: groupSessionIds.length > 0,
  });

  // barcode → every STV that barcode was scanned under. One item can go out on more than one
  // truck, which is why the column's accessor hands the filter engine an array rather than a
  // single value. Voided scans are skipped: a cancelled entry shouldn't make an item show up
  // under an STV it was never actually loaded onto.
  const stvsByBarcode = useMemo(() => {
    const map = new Map<string, Set<string>>();
    for (const ev of eventsQuery.data ?? []) {
      if (!ev.stv || ev.voided) continue;
      const key = normalize(ev.barcode);
      const set = map.get(key);
      if (set) set.add(ev.stv);
      else map.set(key, new Set([ev.stv]));
    }
    return new Map(Array.from(map, ([k, v]) => [k, Array.from(v)]));
  }, [eventsQuery.data]);

  const stvOptions = useMemo(
    () => Array.from(new Set(Array.from(stvsByBarcode.values()).flat())).sort((a, b) => a.localeCompare(b)),
    [stvsByBarcode],
  );

  const [historyItem, setHistoryItem] = useState<OsScanItem | null>(null);
  const historyQuery = useQuery<{ items: HistoryEvent[] }>({
    queryKey: ["/api/order-import/master-view/item-history", "scan-viewer", historyItem?.barcode, groupSessionIds.join(",")],
    queryFn: () =>
      apiRequest(
        "GET",
        `/api/order-import/master-view/item-history?barcode=${encodeURIComponent(historyItem!.barcode!)}&sessionIds=${groupSessionIds.join(",")}`,
      ).then((r) => r.json()),
    enabled: !!historyItem?.barcode && groupSessionIds.length > 0,
  });

  // STV filter for the history drill-down — an item can have been scanned across more than
  // one truck/STV, so this narrows the list to just one. Resets whenever a different item's
  // history is opened. (historyStvOptions/historyEvents are computed further down, once the
  // main table's own STV column filter — columnConditions below — is in scope, since that
  // filter is applied as a floor on top of this one.)
  const [historyStvFilter, setHistoryStvFilter] = useState("");
  useEffect(() => { setHistoryStvFilter(""); }, [historyItem?.id]);

  const [voidTarget, setVoidTarget] = useState<HistoryEvent | null>(null);
  const [voidReason, setVoidReason] = useState("");
  const voidMutation = useMutation({
    mutationFn: (payload: { id: number; reason: string }) =>
      apiRequest("POST", `/api/order-scan/events/${payload.id}/void`, { reason: payload.reason }).then((r) => r.json()),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["/api/order-scan/sessions"] });
      qc.invalidateQueries({ queryKey: ["/api/order-import/master-view/item-history"] });
      qc.invalidateQueries({ queryKey: ["/api/order-import/master-view"] });
      qc.invalidateQueries({ queryKey: ["/api/scan-sessions/reports/scan-history"] });
      qc.invalidateQueries({ queryKey: ["/api/scan-sessions/reports/plant-stock"] });
      setVoidTarget(null);
      setVoidReason("");
      toast({ title: "Scan voided", description: "Excluded from totals and stock; kept in history." });
    },
    onError: (err: any) => toast({ title: "Failed to void scan", description: err?.message, variant: "destructive" }),
  });

  // Extras that don't match ANY CSV item — not on this part's CSV, and not on any other part's
  // either — have no existing row to attach their "+N" to, so without this they stayed
  // invisible here even after /extras started returning them (Master View doesn't have this
  // problem — it never relied on a matching CSV row). One synthetic row per such barcode,
  // Exp/Received left at 0 since there's no CSV line backing them; rowState's own `received`
  // (scanned + extra) still correctly shows the physical qty via the Extra column.
  const realItems = itemsQuery.data ?? [];
  const matchedBarcodes = new Set(realItems.map((i) => normalize(i.barcode ?? "")));
  const extraOnlyItems: OsScanItem[] = (extrasQuery.data ?? [])
    .filter((e) => e.barcode && !matchedBarcodes.has(normalize(e.barcode)))
    .map((e, idx) => ({
      id: -1000 - idx,
      sessionId: sessionId ?? 0,
      barcode: e.barcode,
      itemName: e.itemName,
      sapCode: null,
      expectedQty: 0,
      itemsPerPallet: 0,
      scannedPallets: 0,
      scannedLooseQty: 0,
      totalScannedQty: 0,
      status: 'extra',
      lastScannedAt: null,
    }));
  const items = [...realItems, ...extraOnlyItems];

  const rowState = (item: OsScanItem) => {
    const exp = item.expectedQty ?? 0;
    const scanned = item.totalScannedQty ?? 0;
    const extra = extraByBarcode.get(normalize(item.barcode ?? "")) ?? 0;
    const extraFromOtherParts = (extraPartIndexesByBarcode.get(normalize(item.barcode ?? "")) ?? [])
      .filter((p) => p !== currentPartIndex);
    // Synthetic extra-only rows (barcodes scanned as Extra that aren't on any CSV — see
    // extraOnlyItems above) have expectedQty 0, so a status badge that only checks
    // exp>=received/received>0 falls through to "Pending" even though the item has real Extra
    // quantity. Flag that case so the badge can show "Extra" instead.
    const isExtraOnly = exp <= 0 && extra > 0;
    return {
      exp,
      // Received = the full physical count (order-matched scanned qty PLUS extra) — same
      // convention as the Scan Order page's osRowState.doneQty and both Master Views.
      received: scanned + extra,
      left: Math.max(0, exp - scanned),
      extra,
      extraFromOtherParts,
      isExtraOnly,
    };
  };
  // qty ÷ its own items-per-pallet — never one blended pallet size for every item, same rule
  // used everywhere else in this app (osTotals in Scan.tsx, Overall Stock's Pallets column).
  const pltQty = (qty: number, ipp: number) => (qty > 0 && ipp > 0 ? qty / ipp : 0);

  // Same 4-tile Total/Received/Remaining/Extra strip as the Scan tab, including the pallet
  // figure under each count — computed the same way (osTotals in Scan.tsx): each item's own
  // qty ÷ its own itemsPerPallet, summed, never one blended pallet size for everything.
  const [statFilter, setStatFilter] = useState<"" | "done" | "remaining" | "extra">("");
  const totals = items.reduce((acc, i) => {
    const exp = i.expectedQty ?? 0;
    const received = i.totalScannedQty ?? 0;
    const ipp = i.itemsPerPallet ?? 0;
    const done = Math.min(received, exp);
    const remaining = Math.max(0, exp - received);
    acc.expected += exp;
    acc.done += done;
    acc.remaining += remaining;
    if (ipp > 0) {
      acc.palletsExpected += exp / ipp;
      acc.palletsDone += done / ipp;
      acc.palletsRemaining += remaining / ipp;
    }
    return acc;
  }, { expected: 0, done: 0, remaining: 0, extra: 0, palletsExpected: 0, palletsDone: 0, palletsRemaining: 0, palletsExtra: 0 });
  (extrasQuery.data ?? []).forEach((e) => {
    const qty = e.totalQty ?? 0;
    totals.extra += qty;
    const match = items.find((i) => normalize(i.barcode ?? "") === normalize(e.barcode));
    const ipp = match?.itemsPerPallet ?? 0;
    if (ipp > 0) totals.palletsExtra += qty / ipp;
  });

  // Excel-style per-column filters for the items table (Item, Exp, Received, Left, Extra,
  // Status) — matched client-side since this order's item list is already fully loaded (not
  // paginated the way Scan History is), same approach as Overall Stock.
  const [columnConditions, setColumnConditions] = useState<Record<string, FilterCondition>>(
    () => readSavedViewerFilters().conditions ?? {},
  );

  // Drag a column's header onto another to move it. Session-scoped, like the filters — a
  // rearranged table is working context for this sitting, not a permanent preference.
  const [columnOrder, setColumnOrder] = useState<string[]>(() => {
    try {
      const parsed = JSON.parse(sessionStorage.getItem("scanViewer:columnOrder") ?? "[]");
      return Array.isArray(parsed) ? parsed : [];
    } catch {
      return [];
    }
  });
  useEffect(() => {
    try { sessionStorage.setItem("scanViewer:columnOrder", JSON.stringify(columnOrder)); } catch { /* storage unavailable */ }
  }, [columnOrder]);
  const setColumnCondition = (columnId: string, condition: FilterCondition) =>
    setColumnConditions((prev) => ({ ...prev, [columnId]: condition }));
  const clearColumnCondition = (columnId: string) =>
    setColumnConditions((prev) => {
      const next = { ...prev };
      delete next[columnId];
      return next;
    });
  const filterableColumns: FilterableColumn<OsScanItem>[] = useMemo(() => {
    const textOptions = (pick: (i: OsScanItem) => string | null) =>
      Array.from(new Set(items.map(pick).filter((v): v is string => !!v)))
        .sort((a, b) => a.localeCompare(b))
        .map((v) => ({ value: v, label: v }));
    const numberOptions = (pick: (i: OsScanItem) => number) =>
      Array.from(new Set(items.map(pick)))
        .sort((a, b) => a - b)
        .map((v) => ({ value: String(v), label: v.toLocaleString() }));
    const palletOptions = (pick: (i: OsScanItem) => number) =>
      Array.from(new Set(items.map(pick)))
        .sort((a, b) => a - b)
        .map((v) => ({ value: String(v), label: v.toFixed(2) }));
    const dateOptions = (pick: (i: OsScanItem) => string | null) => {
      const days = new Set<string>();
      items.forEach((i) => { const raw = pick(i); if (raw) days.add(format(new Date(raw), "yyyy-MM-dd")); });
      return Array.from(days).sort().reverse().map((d) => ({ value: d, label: format(new Date(d), "MMM d, yyyy") }));
    };
    return [
      { id: "item", label: "Item", filterType: "text", options: textOptions((i) => i.itemName), accessor: (i) => i.itemName },
      { id: "barcode", label: "Barcode / SAP", filterType: "text", options: textOptions((i) => i.barcode), accessor: (i) => i.barcode },
      // STV isn't a field on an item — it's recorded per scan event, and one item can go out on
      // more than one truck. The accessor therefore returns ALL the STVs that item was scanned
      // under and the filter engine matches if any of them qualifies (see matchValue's array
      // branch in lib/columnFilters.ts). Options come from the whole order, so the checklist
      // still offers every STV even after other filters have narrowed the visible rows.
      {
        id: "stv", label: "STV", filterType: "enum",
        options: stvOptions.map((s) => ({ value: s, label: s })),
        // Checklist only — an STV is a label you either pick or don't, so contains/equals
        // operators would just be a slower way to do the same thing.
        disableConditions: true,
        accessor: (i) => stvsByBarcode.get(normalize(i.barcode ?? "")) ?? [],
      },
      // Labels and order deliberately mirror the Scan Order page's own items table (osColumns in
      // Scan.tsx): all Qty columns first as Exp → Remain → Received → Extra, then the matching Plt
      // columns in the same order, so the two pages read as one system.
      { id: "exp", label: "Exp Qty", filterType: "number", options: numberOptions((i) => i.expectedQty ?? 0), accessor: (i) => i.expectedQty ?? 0 },
      { id: "left", label: "Remain Qty", filterType: "number", options: numberOptions((i) => rowState(i).left), accessor: (i) => rowState(i).left },
      { id: "received", label: "Received Qty", filterType: "number", options: numberOptions((i) => rowState(i).received), accessor: (i) => rowState(i).received },
      { id: "extra", label: "Extra Qty", filterType: "number", options: numberOptions((i) => rowState(i).extra), accessor: (i) => rowState(i).extra },
      { id: "expPlt", label: "Exp Plt", filterType: "number", options: palletOptions((i) => pltQty(rowState(i).exp, i.itemsPerPallet ?? 0)), accessor: (i) => pltQty(rowState(i).exp, i.itemsPerPallet ?? 0) },
      { id: "leftPlt", label: "Remain Plt", filterType: "number", options: palletOptions((i) => pltQty(rowState(i).left, i.itemsPerPallet ?? 0)), accessor: (i) => pltQty(rowState(i).left, i.itemsPerPallet ?? 0) },
      { id: "receivedPlt", label: "Received Plt", filterType: "number", options: palletOptions((i) => pltQty(rowState(i).received, i.itemsPerPallet ?? 0)), accessor: (i) => pltQty(rowState(i).received, i.itemsPerPallet ?? 0) },
      { id: "extraPlt", label: "Extra Plt", filterType: "number", options: palletOptions((i) => pltQty(rowState(i).extra, i.itemsPerPallet ?? 0)), accessor: (i) => pltQty(rowState(i).extra, i.itemsPerPallet ?? 0) },
      {
        id: "status", label: "Status", filterType: "enum",
        options: [
          { value: "complete", label: "Received" },
          { value: "partial", label: "Partial" },
          { value: "pending", label: "Pending" },
        ],
        accessor: (i) => i.status ?? "pending",
      },
      { id: "lastScanned", label: "Last Scanned", filterType: "date", options: dateOptions((i) => i.lastScannedAt), accessor: (i) => i.lastScannedAt },
    ];
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [items, extrasQuery.data, stvOptions, stvsByBarcode]);
  const columnConditionList = useMemo(() => Object.values(columnConditions), [columnConditions]);

  // Keep the saved copy in step with what's applied, so coming back to this page restores it.
  // Plant/date aren't saved: they choose WHICH order you're looking at rather than filtering it,
  // and the page deliberately opens on the live order for your plant.
  useEffect(() => {
    try {
      sessionStorage.setItem(
        VIEWER_FILTERS_KEY,
        JSON.stringify({ search, conditions: columnConditions } satisfies SavedViewerFilters),
      );
    } catch {
      // Storage unavailable (private mode / quota) — filters just won't outlive the page.
    }
  }, [search, columnConditions]);

  // The single "+ Filter" entry point — every generic column in one searchable list, same
  // pattern as Overall Stock/Scan History (no special-cased dims here: Plant/Order Date are
  // already their own controls above, scoping which order this table even shows).
  const [filterPickerOpen, setFilterPickerOpen] = useState(false);
  const [filterPickerKey, setFilterPickerKey] = useState("");
  const [filterPickerSearch, setFilterPickerSearch] = useState("");
  const filterPickerOptions = useMemo(() => {
    // Already-filtered columns are left OUT of this list: "+ Filter" adds a new one, while
    // changing or removing an existing filter happens in the "Filters (N)" dropdown, which lists
    // them all and opens each one's builder pre-filled.
    const q = filterPickerSearch.trim().toLowerCase();
    return filterableColumns
      .filter((c) => !columnConditions[c.id])
      .filter((c) => !q || c.label.toLowerCase().includes(q))
      .map((c) => ({ key: c.id, label: c.label }));
  }, [filterableColumns, columnConditions, filterPickerSearch]);
  const pickedFilterColumn = filterableColumns.find((c) => c.id === filterPickerKey) ?? null;

  // The "Filters (N)" popover doubles as the editor: it lists everything applied, and drilling
  // into one swaps the list for that filter's own builder (editFilterKey), with a Back link — a
  // drill-down inside the same popover rather than a popover within a popover.
  const [editFilterOpen, setEditFilterOpen] = useState(false);
  const [editFilterKey, setEditFilterKey] = useState("");
  const editFilterColumn = filterableColumns.find((c) => c.id === editFilterKey) ?? null;

  // Wraps a plain header label with the Excel-style filter icon — same columnHeader() pattern
  // as Overall Stock/Scan History.
  const columnHeader = (id: string, label: string) => {
    const col = filterableColumns.find((c) => c.id === id);
    if (!col) return label;
    return (
      <span className="inline-flex items-center gap-1">
        {label}
        <ColumnHeaderFilterButton
          column={col}
          condition={columnConditions[id]}
          onChange={(c) => setColumnCondition(id, c)}
          onRemove={() => clearColumnCondition(id)}
        />
      </span>
    );
  };

  const columnFiltered = useMemo(
    () => items.filter((i) => matchAllConditions(i, columnConditionList, filterableColumns)),
    [items, columnConditionList, filterableColumns],
  );
  // Free-text search from the card header's collapsible button. Applied here rather than by the
  // table, so the ONE search box drives every layout — the desktop table, the kiosk table and the
  // mobile cards all read from `filtered`. Matches the same three fields the Item column shows.
  const searched = useMemo(() => {
    const q = search.trim().toLowerCase();
    if (!q) return columnFiltered;
    return columnFiltered.filter((i) =>
      [i.itemName, i.barcode, i.sapCode].some((v) => v?.toLowerCase().includes(q)),
    );
  }, [columnFiltered, search]);

  const filtered = !statFilter
    ? searched
    : searched.filter((i) => {
        const { received, left, extra } = rowState(i);
        if (statFilter === "done") return received > 0;
        if (statFilter === "remaining") return left > 0;
        return extra > 0;
      });

  // Totals for the kiosk table's closing row and the card list's closing line. Over the rows
  // actually on screen, so a search or filter narrows the total along with the list — the same
  // rule the desktop table's own totals row follows. Pallets sum each row at ITS OWN pack size.
  const cardTotals = filtered.reduce(
    (acc, i) => {
      const { exp, received, left, extra } = rowState(i);
      const ipp = i.itemsPerPallet ?? 0;
      acc.exp += exp;
      acc.received += received;
      acc.left += left;
      acc.extra += extra;
      acc.expPlt += pltQty(exp, ipp);
      acc.receivedPlt += pltQty(received, ipp);
      acc.leftPlt += pltQty(left, ipp);
      acc.extraPlt += pltQty(extra, ipp);
      return acc;
    },
    { exp: 0, received: 0, left: 0, extra: 0, expPlt: 0, receivedPlt: 0, leftPlt: 0, extraPlt: 0 },
  );

  const selectedSession = sessionOptions.find((s) => s.id === sessionId) ?? null;

  // The STV(s) currently selected in the main table's own STV column filter, if any (a
  // checklist — "in" — so possibly more than one). Reused as a floor on the history drill-down
  // below: if you've filtered the items table down to one STV, opening any of those items'
  // history should only ever show that STV's scans, not every truck that item ever went out on.
  const activeStvFilterValues: string[] = useMemo(() => {
    const cond = columnConditions["stv"];
    if (!cond || cond.operator !== "in") return [];
    return (cond.value as string[]) ?? [];
  }, [columnConditions]);

  // Same STV floor applied first, then the in-panel dropdown (below) narrows further within
  // whatever that leaves — so with a single STV filtered on the main table, history for any
  // item under it is already scoped correctly with no extra step needed.
  const historyEventsInStvScope = activeStvFilterValues.length > 0
    ? (historyQuery.data?.items ?? []).filter((ev) => !!ev.stv && activeStvFilterValues.includes(ev.stv))
    : (historyQuery.data?.items ?? []);
  const historyStvOptions = Array.from(
    new Set(historyEventsInStvScope.map((ev) => ev.stv).filter((s): s is string => !!s)),
  );
  const historyEvents = historyStvFilter
    ? historyEventsInStvScope.filter((ev) => ev.stv === historyStvFilter)
    : historyEventsInStvScope;

  // The item-history drill-down panel — same content for whichever row is currently expanded
  // (driven by historyItem, set from the Item column's click handler below).
  const historyPanel = (
    // Sticky + width-capped, matching the Scan Order page's panel: this renders inside a
    // <td colSpan> of a much wider table that scrolls sideways, so a plain 100%-width block
    // inherits that full width. sticky left-0 pins it to the visible left edge instead.
    <div className="sticky left-0 w-full max-w-2xl bg-gray-50 p-3">
      {historyQuery.isLoading ? (
        <div className="flex justify-center py-6"><Loader2 className="h-5 w-5 animate-spin text-[#001d6e]" /></div>
      ) : historyEventsInStvScope.length === 0 ? (
        <p className="py-4 text-center text-xs text-gray-400">
          {activeStvFilterValues.length > 0
            ? `No scans for this item under ${activeStvFilterValues.length > 1 ? "the selected STVs" : `STV ${activeStvFilterValues[0]}`}.`
            : "No scans yet for this item in this order."}
        </p>
      ) : (
        <>
        {historyStvOptions.length > 1 && (
          <div className="mb-2 flex items-center gap-2">
            <Label className="text-xs text-gray-500">STV</Label>
            <Select value={historyStvFilter || "__all__"} onValueChange={(v) => setHistoryStvFilter(v === "__all__" ? "" : v)}>
              <SelectTrigger className="h-7 w-40 text-xs"><SelectValue /></SelectTrigger>
              <SelectContent>
                <SelectItem value="__all__">All STVs</SelectItem>
                {historyStvOptions.map((s) => (
                  <SelectItem key={s} value={s}>{s}</SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
        )}
        <div className="max-h-72 overflow-y-auto border border-gray-200">
          <table className="w-full table-fixed border-collapse text-xs">
            <thead>
              <tr className="sticky top-0 z-10 border-b-2 border-gray-300 bg-gray-100 text-left text-gray-600">
                <th className="w-7 border-r border-gray-200 px-2 py-2 font-semibold">#</th>
                <th className="w-[122px] border-r border-gray-200 px-2 py-2 font-semibold">Date &amp; Time</th>
                <th className="border-r border-gray-200 px-2 py-2 font-semibold">Scanned By</th>
                <th className="border-r border-gray-200 px-2 py-2 font-semibold">Order / Part</th>
                <th className="w-14 border-r border-gray-200 px-2 py-2 text-center font-semibold">Qty</th>
                <th className="w-16 border-r border-gray-200 px-2 py-2 font-semibold">Status</th>
                {canVoidScan && <th className="w-14 px-2 py-2 text-right font-semibold">Action</th>}
              </tr>
            </thead>
            <tbody>
              {historyEvents.map((ev, idx) => (
                <tr key={ev.id} className={`border-b border-gray-100 ${ev.voided ? "opacity-60" : "hover:bg-gray-50"} ${idx % 2 !== 0 ? "bg-slate-50" : "bg-white"}`}>
                  <td className="border-r border-gray-100 px-2 py-2 font-mono text-gray-400">{idx + 1}</td>
                  <td className="truncate border-r border-gray-100 px-2 py-2 text-gray-800">{format(new Date(ev.scannedAt), "MMM d · h:mm a")}</td>
                  <td className="truncate border-r border-gray-100 px-2 py-2 text-gray-600">{ev.scannedByName ?? "—"}</td>
                  <td className="truncate border-r border-gray-100 px-2 py-2 text-gray-600">
                    {ev.orderName?.replace(/\.csv$/i, "")}{ev.partIndex ? ` · Part ${ev.partIndex}` : ""}
                  </td>
                  <td className="border-r border-gray-100 px-2 py-2 text-center">
                    <span className={`inline-flex items-center justify-center rounded-full px-2 py-0.5 text-[11px] font-bold ${ev.isExtra ? "bg-amber-100 text-amber-700" : "bg-[#001d6e]/10 text-[#001d6e]"}`}>
                      {ev.isExtra ? "+" : ""}{ev.totalQty}
                    </span>
                  </td>
                  <td className="truncate border-r border-gray-100 px-2 py-2 text-[11px]">
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
                          onClick={() => setVoidTarget(ev)}
                        >
                          Void
                        </Button>
                      )}
                    </td>
                  )}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        </>
      )}
    </div>
  );

  const headerBorder = "border-r border-white/10";
  const cellBorder = "border-r border-gray-200";

  const itemColumns: DataTableColumn<OsScanItem>[] = [
    {
      id: "item",
      header: columnHeader("item", "Item"),
      hideable: false,
      width: 260,
      sortable: true,
      accessor: (row) => `${row.itemName ?? ""} ${row.barcode ?? ""} ${row.sapCode ?? ""}`,
      totalable: false,
      headerClassName: headerBorder,
      cellClassName: `min-w-[180px] max-w-[320px] whitespace-normal break-words ${cellBorder}`,
      render: (row) => {
        const isOpen = historyItem?.id === row.id;
        return (
          <>
            <button
              type="button"
              disabled={!row.barcode}
              onClick={() => setHistoryItem((cur) => (cur?.id === row.id ? null : row))}
              className={`whitespace-normal break-words text-left font-medium leading-snug text-gray-900 underline decoration-dotted underline-offset-2 disabled:no-underline ${isOpen ? "text-[#001d6e] decoration-[#001d6e]" : "decoration-gray-300"}`}
            >
              {row.itemName ?? "—"}
            </button>
            <p className="whitespace-normal break-words font-mono text-xs text-gray-400">
              {row.barcode ?? "—"}{row.sapCode && ` · SAP ${row.sapCode}`}
            </p>
            {/* Informational only — the item's real GJ/MP PLT pack size, never used in any
                qty/plt calculation on this page. */}
            {!!row.realPackSize && row.realPackSize > 0 && (
              <p className="text-sm font-semibold text-gray-600">{row.realPackSize} per pallet</p>
            )}
          </>
        );
      },
    },
    // Qty block, in the Scan Order page's order: Exp → Remain → Received → Extra.
    {
      id: "exp",
      header: columnHeader("exp", "Exp Qty"),
      width: 80,
      align: "right",
      sortable: true,
      accessor: (row) => row.expectedQty ?? 0,
      headerClassName: headerBorder,
      cellClassName: `tabular-nums text-gray-600 ${cellBorder}`,
      render: (row) => rowState(row).exp || "—",
    },
    {
      id: "left",
      header: columnHeader("left", "Remain Qty"),
      width: 90,
      align: "right",
      sortable: true,
      accessor: (row) => rowState(row).left,
      headerClassName: headerBorder,
      cellClassName: cellBorder,
      render: (row) => {
        const { left } = rowState(row);
        return <span className={`tabular-nums font-semibold ${left > 0 ? "text-[#001d6e]" : "text-gray-300"}`}>{left || "—"}</span>;
      },
    },
    {
      id: "received",
      header: columnHeader("received", "Received Qty"),
      width: 90,
      align: "right",
      sortable: true,
      accessor: (row) => rowState(row).received,
      headerClassName: headerBorder,
      cellClassName: `tabular-nums font-semibold text-gray-900 ${cellBorder}`,
      render: (row) => rowState(row).received,
    },
    {
      id: "extra",
      header: columnHeader("extra", "Extra Qty"),
      width: 80,
      align: "right",
      sortable: true,
      accessor: (row) => rowState(row).extra,
      headerClassName: headerBorder,
      cellClassName: cellBorder,
      render: (row) => {
        const { extra, extraFromOtherParts } = rowState(row);
        if (extra <= 0) return <span className="tabular-nums font-semibold text-gray-300">—</span>;
        return (
          <span className="tabular-nums font-semibold text-amber-600">
            +{extra}
            {extraFromOtherParts.length > 0 && (
              <span className="block text-[10px] font-normal text-gray-400">from Part {extraFromOtherParts.join(", ")}</span>
            )}
          </span>
        );
      },
    },
    // Pallet columns, their own columns rather than a subline under each qty cell — same
    // Exp → Remain → Received → Extra order as the qty block above, matching the Scan Order
    // page's own Exp/Remain/Received/Extra Plt columns in Scan.tsx.
    {
      id: "expPlt",
      header: columnHeader("expPlt", "Exp Plt"),
      width: 80,
      align: "right",
      sortable: true,
      accessor: (row) => pltQty(rowState(row).exp, row.itemsPerPallet ?? 0),
      // Each row contributes qty ÷ ITS OWN pallet size — never one blended size — then those are
      // added and shown to 2dp, same rule as pltTotal in Scan.tsx. Without an explicit total the
      // auto-sum would print the raw float's full precision.
      total: (rows) => rows.reduce((s, r) => s + pltQty(rowState(r).exp, r.itemsPerPallet ?? 0), 0).toFixed(2),
      headerClassName: headerBorder,
      cellClassName: `tabular-nums text-gray-500 ${cellBorder}`,
      render: (row) => pltQty(rowState(row).exp, row.itemsPerPallet ?? 0).toFixed(2),
    },
    {
      id: "leftPlt",
      header: columnHeader("leftPlt", "Remain Plt"),
      width: 90,
      align: "right",
      sortable: true,
      accessor: (row) => pltQty(rowState(row).left, row.itemsPerPallet ?? 0),
      total: (rows) => rows.reduce((s, r) => s + pltQty(rowState(r).left, r.itemsPerPallet ?? 0), 0).toFixed(2),
      headerClassName: headerBorder,
      cellClassName: `tabular-nums font-semibold text-purple-600 ${cellBorder}`,
      render: (row) => pltQty(rowState(row).left, row.itemsPerPallet ?? 0).toFixed(2),
    },
    {
      id: "receivedPlt",
      header: columnHeader("receivedPlt", "Received Plt"),
      width: 90,
      align: "right",
      sortable: true,
      accessor: (row) => pltQty(rowState(row).received, row.itemsPerPallet ?? 0),
      total: (rows) => rows.reduce((s, r) => s + pltQty(rowState(r).received, r.itemsPerPallet ?? 0), 0).toFixed(2),
      headerClassName: headerBorder,
      cellClassName: `tabular-nums font-semibold text-[#001d6e] ${cellBorder}`,
      render: (row) => pltQty(rowState(row).received, row.itemsPerPallet ?? 0).toFixed(2),
    },
    {
      id: "extraPlt",
      header: columnHeader("extraPlt", "Extra Plt"),
      width: 80,
      align: "right",
      sortable: true,
      accessor: (row) => pltQty(rowState(row).extra, row.itemsPerPallet ?? 0),
      total: (rows) => rows.reduce((s, r) => s + pltQty(rowState(r).extra, r.itemsPerPallet ?? 0), 0).toFixed(2),
      headerClassName: headerBorder,
      cellClassName: `tabular-nums font-semibold text-amber-600 ${cellBorder}`,
      render: (row) => pltQty(rowState(row).extra, row.itemsPerPallet ?? 0).toFixed(2),
    },
    {
      id: "status",
      header: columnHeader("status", "Status"),
      width: 100,
      align: "center",
      sortable: true,
      accessor: (row) => row.status ?? "pending",
      totalable: false,
      render: (row) => {
        const status = row.status ?? "pending";
        return (
          <span className={`inline-block px-2.5 py-1 text-xs font-semibold ${
            status === "extra"    ? "bg-orange-100 text-orange-700" :
            status === "complete" ? "bg-emerald-100 text-emerald-700" :
            status === "partial"  ? "bg-amber-100 text-amber-700" : "bg-gray-100 text-gray-500"
          }`}>
            {status === "extra" ? "Extra" : status === "complete" ? "Received" : status === "partial" ? "Partial" : "Pending"}
          </span>
        );
      },
    },
    {
      id: "lastScanned",
      header: columnHeader("lastScanned", "Last Scanned"),
      width: 130,
      sortable: true,
      accessor: (row) => row.lastScannedAt,
      totalable: false,
      cellClassName: "text-gray-500 whitespace-nowrap",
      render: (row) => (row.lastScannedAt ? format(new Date(row.lastScannedAt), "MMM d, yyyy · h:mm a") : <span className="text-gray-300">—</span>),
    },
  ];

  // Master View's own columns — same layout/order as Part View's itemColumns above (Item, Exp,
  // Remain, Received, Extra, then the matching Plt columns, then Status), just backed by
  // MvMergedItem's merged-across-every-part shape instead of one session's OsScanItem rows.
  const mvColumns: DataTableColumn<MvMergedItem>[] = [
    {
      id: "item",
      header: "Item",
      hideable: false,
      width: 260,
      sortable: true,
      accessor: (row) => `${row.itemName ?? ""} ${row.barcode ?? ""} ${row.sapCode ?? ""}`,
      totalable: false,
      cellClassName: `min-w-[180px] max-w-[320px] whitespace-normal break-words ${cellBorder}`,
      render: (row) => {
        return (
          <>
            {/* Plain text, not a button: Master View is view-only, matching the Scan Order page.
                Its rows are merged across every part, while the scan history panel is per-part —
                so the drill-down lives on the Scan tab, where a row IS one part's line. */}
            <p className="whitespace-normal break-words text-left font-medium leading-snug text-gray-900">
              {row.itemName ?? "—"}
            </p>
            <p className="whitespace-normal break-words font-mono text-xs text-gray-400">
              {row.barcode ?? "—"}{row.sapCode && ` · SAP ${row.sapCode}`}
            </p>
            {row.itemsPerPallet > 0 && (
              <p className="text-sm font-semibold text-gray-600">{row.itemsPerPallet} per pallet</p>
            )}
            {row.isExtraOnly && (
              <p className="text-[11px] font-semibold uppercase text-amber-700">Extra — not on any CSV</p>
            )}
          </>
        );
      },
    },
    {
      id: "exp", header: "Exp Qty", width: 80, align: "right", sortable: true,
      accessor: (row) => mvRowState(row).exp,
      cellClassName: `tabular-nums text-gray-600 ${cellBorder}`,
      render: (row) => mvRowState(row).exp || "—",
    },
    {
      id: "left", header: "Remain Qty", width: 90, align: "right", sortable: true,
      accessor: (row) => mvRowState(row).left,
      cellClassName: cellBorder,
      render: (row) => {
        const { left } = mvRowState(row);
        return <span className={`tabular-nums font-semibold ${left > 0 ? "text-[#001d6e]" : "text-gray-300"}`}>{left || "—"}</span>;
      },
    },
    {
      id: "received", header: "Received Qty", width: 90, align: "right", sortable: true,
      accessor: (row) => mvRowState(row).received,
      cellClassName: `tabular-nums font-semibold text-gray-900 ${cellBorder}`,
      render: (row) => mvRowState(row).received,
    },
    {
      id: "extra", header: "Extra Qty", width: 80, align: "right", sortable: true,
      accessor: (row) => mvRowState(row).extra,
      cellClassName: cellBorder,
      render: (row) => {
        const { extra } = mvRowState(row);
        return <span className={`tabular-nums font-semibold ${extra > 0 ? "text-amber-600" : "text-gray-300"}`}>{extra > 0 ? `+${extra}` : "—"}</span>;
      },
    },
    {
      id: "expPlt", header: "Exp Plt", width: 80, align: "right", sortable: true,
      accessor: (row) => mvPltQty(mvRowState(row).exp, row.itemsPerPallet),
      total: (rows) => rows.reduce((s, r) => s + mvPltQty(mvRowState(r).exp, r.itemsPerPallet), 0).toFixed(2),
      cellClassName: `tabular-nums text-gray-500 ${cellBorder}`,
      render: (row) => mvPltQty(mvRowState(row).exp, row.itemsPerPallet).toFixed(2),
    },
    {
      id: "leftPlt", header: "Remain Plt", width: 90, align: "right", sortable: true,
      accessor: (row) => mvPltQty(mvRowState(row).left, row.itemsPerPallet),
      total: (rows) => rows.reduce((s, r) => s + mvPltQty(mvRowState(r).left, r.itemsPerPallet), 0).toFixed(2),
      cellClassName: `tabular-nums font-semibold text-purple-600 ${cellBorder}`,
      render: (row) => mvPltQty(mvRowState(row).left, row.itemsPerPallet).toFixed(2),
    },
    {
      id: "receivedPlt", header: "Received Plt", width: 90, align: "right", sortable: true,
      accessor: (row) => mvPltQty(mvRowState(row).received, row.itemsPerPallet),
      total: (rows) => rows.reduce((s, r) => s + mvPltQty(mvRowState(r).received, r.itemsPerPallet), 0).toFixed(2),
      cellClassName: `tabular-nums font-semibold text-[#001d6e] ${cellBorder}`,
      render: (row) => mvPltQty(mvRowState(row).received, row.itemsPerPallet).toFixed(2),
    },
    {
      id: "extraPlt", header: "Extra Plt", width: 80, align: "right", sortable: true,
      accessor: (row) => mvPltQty(mvRowState(row).extra, row.itemsPerPallet),
      total: (rows) => rows.reduce((s, r) => s + mvPltQty(mvRowState(r).extra, r.itemsPerPallet), 0).toFixed(2),
      cellClassName: `tabular-nums font-semibold text-amber-600 ${cellBorder}`,
      render: (row) => mvPltQty(mvRowState(row).extra, row.itemsPerPallet).toFixed(2),
    },
    {
      id: "status", header: "Status", width: 100, align: "center", sortable: true,
      totalable: false,
      accessor: (row) => (row.isExtraOnly ? "extra" : mvRowState(row).received >= mvRowState(row).exp && mvRowState(row).exp > 0 ? "complete" : mvRowState(row).received > 0 ? "partial" : "pending"),
      render: (row) => {
        const { received, exp } = mvRowState(row);
        const status = row.isExtraOnly ? "extra" : received >= exp && exp > 0 ? "complete" : received > 0 ? "partial" : "pending";
        return (
          <span className={`inline-block px-2.5 py-1 text-xs font-semibold ${
            status === "extra" ? "bg-orange-100 text-orange-700"
            : status === "complete" ? "bg-emerald-100 text-emerald-700"
            : status === "partial"  ? "bg-amber-100 text-amber-700" : "bg-gray-100 text-gray-500"
          }`}>
            {status === "extra" ? "Extra" : status === "complete" ? "Received" : status === "partial" ? "Partial" : "Pending"}
          </span>
        );
      },
    },
    {
      id: "lastScanned", header: "Last Scanned", width: 130, sortable: true,
      accessor: (row) => row.lastScannedAt,
      totalable: false,
      cellClassName: "text-gray-500 whitespace-nowrap",
      render: (row) => (row.lastScannedAt ? format(new Date(row.lastScannedAt), "MMM d, yyyy · h:mm a") : <span className="text-gray-300">—</span>),
    },
  ];

  return (
    <div ref={pageScrollRef} className={`flex-1 overflow-y-auto bg-gray-50 p-4 lg:p-6 ${rotateClass}`}>
      <RotateButton />
      {isRotated && (
        <div className="fixed bottom-24 right-4 z-[60] rounded-3xl bg-[#001d6e] px-2.5 py-3 text-white shadow-xl ring-1 ring-white/10">
          <ScrollNudgeButtons targetRef={pageScrollRef} />
        </div>
      )}
      <div className="mx-auto w-full max-w-[1800px] space-y-4">

        {/* Plant switcher — unboxed, same exact markup/style as the Scan page's own "Active:"
            switcher (no bordered card wrapper) — scoped to this user's own assigned plants (all
            plants for admins), not a generic dropdown of every plant in the system. Order
            Date/Part sit inline right after it, same unboxed treatment. */}
        {/* Session header — the same band the Scan Order page carries above its tabs: which
            order this is, which plant, who loaded it, and how far along it is. No Complete
            button: that writes (it closes the order), and this page is a read-only viewer whose
            only write is voiding a single mistaken scan. */}
        {filtersReady && selectedSession && (
          <div className="flex flex-wrap items-center gap-3">
            <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg bg-amber-400/90">
              <ScanLine className="h-5 w-5 text-white" />
            </span>
            <div className="min-w-0">
              <p
                className="truncate text-sm font-bold leading-tight text-gray-900"
                title={selectedSession.csvFileName}
              >
                {fmtOrderDate(selectedSession.orderDate ?? date)}
                {sessionOptions.length > 1 && (
                  <span className="ml-1.5 rounded-full bg-purple-100 px-1.5 py-0.5 text-[10px] font-semibold text-purple-700">
                    Part {selectedSession.partIndex ?? "?"} of {sessionOptions.length}
                  </span>
                )}
              </p>
              <p className="mt-1.5 flex items-center gap-1.5 truncate text-xs text-gray-500">
                {/* Plant is now switched from the always-visible control in the tab row above
                    (see its comment) — this is just a label here, not its own control, so it
                    doesn't disappear along with the rest of this header when there's no data. */}
                <span
                  className="inline-block rounded-full border px-2.5 py-0.5 text-[11px] font-semibold"
                  style={(() => {
                    const cfg = getPlantColorCfg(plant);
                    return cfg
                      ? { backgroundColor: cfg.bgColor ?? undefined, color: cfg.textColor ?? undefined, borderColor: cfg.borderColor ?? undefined }
                      : undefined;
                  })()}
                >
                  {plant}
                </span>
                {selectedSession.importedByName && <span>· loaded by {selectedSession.importedByName}</span>}
                {/* Scan start/end — set once each, when the part is activated and when it's
                    marked complete (order_import_sessions.scanActivatedAt/scanCompletedAt).
                    Completed only shows once it's actually set; a still-in-progress part just
                    shows Started. */}
                {selectedSession.scanActivatedAt && (
                  <span>· started {format(new Date(selectedSession.scanActivatedAt), "MMM d, h:mm a")}</span>
                )}
                {selectedSession.scanCompletedAt && (
                  <span>· completed {format(new Date(selectedSession.scanCompletedAt), "MMM d, h:mm a")}</span>
                )}
                {selectedSession.scanActivatedAt && selectedSession.scanCompletedAt && (() => {
                  const totalMinutes = Math.round(
                    (new Date(selectedSession.scanCompletedAt).getTime() - new Date(selectedSession.scanActivatedAt).getTime()) / 60000,
                  );
                  if (isNaN(totalMinutes) || totalMinutes < 0) return null;
                  const hours = Math.floor(totalMinutes / 60);
                  const minutes = totalMinutes % 60;
                  return <span className="font-semibold text-emerald-600">· active for {hours > 0 ? `${hours}h ${minutes}m` : `${minutes}m`}</span>;
                })()}
              </p>
            </div>
            {/* Received progress, right-aligned — same readout as Scan Order's. 100% only once
                EVERY real CSV item has reached its own expected quantity, not just "has any
                qty at all" — a part with several genuinely short items could otherwise show
                100% the moment every line had SOME quantity in, however small. Synthetic
                extra-only rows (expectedQty 0 — items scanned as Extra that aren't on this
                CSV) are excluded from both the numerator and denominator, since they were
                never part of the order and can never be "complete". */}
            {(() => {
              const realItems = items.filter((i) => (i.expectedQty ?? 0) > 0);
              const fullyDone = realItems.filter((i) => (i.totalScannedQty ?? 0) >= (i.expectedQty ?? 0)).length;
              const total = realItems.length;
              const pct = total > 0 ? Math.round((fullyDone / total) * 100) : 0;
              return (
                <div className="ml-auto flex shrink-0 items-center gap-2">
                  <div className="h-2 w-28 overflow-hidden rounded-full bg-gray-100">
                    <div
                      className={`h-full rounded-full transition-[width] duration-300 ${pct >= 100 && total > 0 ? "bg-emerald-500" : "bg-[#001d6e]"}`}
                      style={{ width: `${pct}%` }}
                    />
                  </div>
                  <span className="whitespace-nowrap text-xs font-medium">
                    {pct >= 100 && total > 0 ? (
                      <span className="inline-flex items-center gap-1 font-semibold text-emerald-600">
                        <CheckCircle2 className="h-3.5 w-3.5" /> Complete
                      </span>
                    ) : (
                      <span className="text-gray-600">{fullyDone}/{total} received ({pct}%)</span>
                    )}
                  </span>
                </div>
              );
            })()}
          </div>
        )}


        {/* Plant switcher, order date (and the part picker when an order has several) — their
            own row, ABOVE the Master View/Scan tabs rather than sharing a row with them. This
            page has to choose WHICH order to show, which the Scan Order page never does: it
            follows the live session. Kept OUTSIDE the selectedSession-gated header below so
            it's still there to change even when the chosen plant/date has no order at all —
            previously the only plant control lived inside that header, so hitting a date with
            no data made it disappear along with everything else, leaving no way to switch
            plants without editing the URL. */}
        <div className="flex flex-wrap items-center gap-1.5">
          <Select value={plant} onValueChange={selectPlant}>
            <SelectTrigger
              className="h-9 w-auto gap-1 rounded-xl text-xs"
              style={(() => {
                const cfg = getPlantColorCfg(plant);
                return cfg ? { backgroundColor: cfg.bgColor ?? undefined, color: cfg.textColor ?? undefined, borderColor: cfg.borderColor ?? undefined } : undefined;
              })()}
            >
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {plantOptions.map((p) => {
                const cfg = getPlantColorCfg(p);
                return (
                  <SelectItem key={p} value={p}>
                    <span className="flex items-center gap-1.5">
                      <span
                        className="h-2 w-2 shrink-0 rounded-full border"
                        style={cfg ? { backgroundColor: cfg.bgColor ?? undefined, borderColor: cfg.borderColor ?? undefined } : undefined}
                      />
                      {p}
                    </span>
                  </SelectItem>
                );
              })}
            </SelectContent>
          </Select>
          <Input
            type="date"
            className="h-9 w-auto rounded-xl text-xs"
            value={date}
            onChange={(e) => { setDate(e.target.value); setSessionId(null); }}
          />
          {sessionOptions.length > 1 && (
            <Select value={sessionId ? String(sessionId) : ""} onValueChange={(v) => setSessionId(Number(v))}>
              <SelectTrigger className="h-9 w-36 rounded-xl text-xs"><SelectValue placeholder="Select part…" /></SelectTrigger>
              <SelectContent>
                {sessionOptions.map((so) => (
                  <SelectItem key={so.id} value={String(so.id)}>
                    Part {so.partIndex ?? "—"} · {so.scanStatus ?? "—"}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          )}
        </div>

        {/* Master View / Part View tabs — same split the Scan Order page has: Master View
            merges every CSV part of this order into one row per item; Part View is this page's
            original behavior, one specific CSV/part at a time. */}
        {/* Same tab treatment as Scan Order: an icon beside each label, the active one filled
            navy. "Scan" is deliberately absent — that tab exists there to scan into, and this
            page never writes scans. */}
        <div className="flex flex-wrap items-center gap-2">
          {([
            { key: "master-view", label: "Master View", icon: Layers },
            { key: "scan", label: "Scan", icon: ScanLine },
          ] as const).map((t) => {
            const Icon = t.icon;
            return (
              <button
                key={t.key}
                type="button"
                onClick={() => setViewerTab(t.key)}
                className={`inline-flex items-center gap-2 rounded-xl px-4 py-2.5 text-sm font-semibold transition-colors ${
                  viewerTab === t.key
                    ? "bg-[#001d6e] text-white shadow-sm"
                    : "border border-gray-200 bg-white text-gray-600 hover:bg-gray-50"
                }`}
              >
                <Icon className="h-4 w-4" />
                {t.label}
              </button>
            );
          })}
        </div>

        {!filtersReady ? (
          <div className="rounded-xl border border-dashed border-gray-300 bg-white py-16 text-center text-sm text-gray-400">
            Pick a plant and an order date to view its scan progress.
          </div>
        ) : sessionsQuery.isLoading ? (
          <div className="flex justify-center py-16"><Loader2 className="h-6 w-6 animate-spin text-[#001d6e]" /></div>
        ) : sessionOptions.length === 0 ? (
          <div className="rounded-xl border border-dashed border-gray-300 bg-white py-16 text-center text-sm text-gray-400">
            No order found for {plant} on {date}.
          </div>
        ) : viewerTab === "scan" ? (
          <>
          {/* Order Totals — same card as the Scan Order page's: heading with a % complete
              readout, four click-to-filter tiles carrying a count and a pallet figure, and a
              progress bar underneath. Totals live in one card rather than four free-floating
              boxes so the block reads as a single unit. */}
          <div className="flex flex-col gap-1.5 rounded-xl border bg-white p-2.5 shadow-sm">
            <div className="flex items-baseline justify-between">
              <p className="text-sm font-semibold uppercase tracking-wide text-gray-500">Order Totals</p>
              <p className="text-sm font-medium text-gray-400">
                {totals.expected > 0
                  ? `${Math.round((totals.done / totals.expected) * 100)}% complete`
                  : "—"}
              </p>
            </div>

            {/* Each box filters the items table to its own rows; clicking the active one clears
                the filter. Total is the "show everything" box, so it doubles as Clear. */}
            <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
              {([
                { key: "", label: "Total", value: totals.expected, plt: totals.palletsExpected, dot: "bg-gray-400", text: "text-gray-900" },
                { key: "done", label: "Received", value: totals.done, plt: totals.palletsDone, dot: "bg-emerald-500", text: "text-emerald-600" },
                { key: "remaining", label: "Remaining", value: totals.remaining, plt: totals.palletsRemaining, dot: "bg-red-500", text: "text-red-600" },
                { key: "extra", label: "Extra", value: totals.extra, plt: totals.palletsExtra, dot: "bg-orange-500", text: totals.extra > 0 ? "text-amber-600" : "text-gray-300" },
              ] as const).map((s) => {
                const isActive = statFilter === s.key;
                return (
                  <button
                    key={s.label}
                    type="button"
                    onClick={() => setStatFilter(isActive ? "" : (s.key as typeof statFilter))}
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
                  style={{ width: `${totals.expected > 0 ? Math.min(100, (totals.done / totals.expected) * 100) : 0}%` }}
                />
              </div>
              <div className="flex justify-between text-[10px] font-medium text-gray-400">
                <span>{totals.done} received</span>
                <span>{totals.remaining} remaining</span>
              </div>
            </div>
          </div>

          {/* Same TableCard + DataTable used by Overall Stock/Reports — navy header, built-in
              search, zebra stripes — plus the same Excel-style filtering: a filter icon on each
              column header, a unified "+ Filter" picker, and a "Filters (N)" summary. */}
          <TableCard
            icon={Eye}
            // Headerless, like the Scan Order page's items card: it leads with the row count
            // rather than a title, since the order is already identified by the header band above.
            compactHeader
            title={`${filtered.length} of ${items.length} items`}
            className="rounded-xl shadow-sm border-gray-200"
            headerActions={
              <>
                {/* One unified "+ Filter" — every generic column (Item, Barcode/SAP, Exp,
                    Received, Left, Extra, Status, pallet columns, Last Scanned) in one
                    searchable list. */}
                <Popover
                  open={filterPickerOpen}
                  onOpenChange={(open) => {
                    setFilterPickerOpen(open);
                    if (!open) { setFilterPickerKey(""); setFilterPickerSearch(""); }
                  }}
                >
                  <PopoverTrigger asChild>
                    <Button
                      size="sm"
                      variant="outline"
                      className="h-8 gap-1 rounded-md border-dashed border-[#001d6e]/40 bg-white text-xs font-medium text-[#001d6e] hover:bg-[#001d6e]/5 hover:text-[#001d6e]"
                    >
                      <Plus className="h-3.5 w-3.5" /> Filter

                    </Button>
                  </PopoverTrigger>
                  <PopoverContent align="start" className="w-64">
                    {filterPickerKey === "" ? (
                      <div className="space-y-1.5">
                        <Input
                          className="h-8 text-xs"
                          placeholder="Find a filter…"
                          value={filterPickerSearch}
                          onChange={(e) => setFilterPickerSearch(e.target.value)}
                          autoFocus
                        />
                        <div className="max-h-56 overflow-y-auto">
                          {filterPickerOptions.length === 0 ? (
                            <div className="px-2 py-1.5 text-xs text-gray-400">
                              {filterPickerSearch ? "No matches" : "All filters added"}
                            </div>
                          ) : (
                            filterPickerOptions.map((d) => (
                              <button
                                key={d.key}
                                type="button"
                                onClick={() => setFilterPickerKey(d.key)}
                                className="block w-full rounded px-2 py-1.5 text-left text-xs text-gray-700 hover:bg-[#001d6e]/5 hover:text-[#001d6e]"
                              >
                                {d.label}
                              </button>
                            ))
                          )}
                        </div>
                      </div>
                    ) : pickedFilterColumn ? (
                      <div className="space-y-2">
                        <button
                          type="button"
                          onClick={() => setFilterPickerKey("")}
                          className="flex items-center gap-1 text-[11px] text-gray-400 hover:text-gray-600"
                        >
                          <ChevronLeft className="h-3 w-3" /> Back
                        </button>
                        <ColumnFilterPopoverContent
                          column={pickedFilterColumn}
                          onApply={(c) => {
                            setColumnCondition(pickedFilterColumn.id, c);
                            setFilterPickerOpen(false);
                            setFilterPickerKey("");
                          }}
                          onCancel={() => setFilterPickerKey("")}
                        />
                      </div>
                    ) : null}
                  </PopoverContent>
                </Popover>

                {Object.keys(columnConditions).length > 0 && (
                  <Button size="sm" variant="ghost" className="h-8 px-2 text-xs text-gray-500 hover:text-gray-900" onClick={() => setColumnConditions({})}>
                    Clear all
                  </Button>
                )}

                {/* Every active column filter in one list, with its own remove button. */}
                {Object.keys(columnConditions).length > 0 && (
                  <Popover open={editFilterOpen} onOpenChange={(o) => { setEditFilterOpen(o); if (!o) setEditFilterKey(""); }}>
                    <PopoverTrigger asChild>
                      <Button size="sm" variant="outline" className="h-8 rounded-full border-0 bg-[#001d6e] text-xs text-white hover:bg-[#001552] hover:text-white">
                        <ListFilter className="h-3.5 w-3.5 mr-1" />
                        Filters ({Object.keys(columnConditions).length})
                      </Button>
                    </PopoverTrigger>
                    {/* One place to see AND change every applied filter. */}
                    <PopoverContent align="end" className="w-72">
                      {editFilterColumn ? (
                        <div className="space-y-2">
                          <button
                            type="button"
                            onClick={() => setEditFilterKey("")}
                            className="flex items-center gap-1 text-[11px] text-gray-400 hover:text-gray-600"
                          >
                            <ChevronLeft className="h-3 w-3" /> Back to filters
                          </button>
                          <ColumnFilterPopoverContent
                            column={editFilterColumn}
                            initial={columnConditions[editFilterColumn.id]}
                            onApply={(c) => { setColumnCondition(editFilterColumn.id, c); setEditFilterKey(""); }}
                            onClear={() => { clearColumnCondition(editFilterColumn.id); setEditFilterKey(""); }}
                            onCancel={() => setEditFilterKey("")}
                          />
                        </div>
                      ) : (
                        <div className="space-y-0.5">
                          <p className="mb-1 text-[11px] font-semibold uppercase tracking-wide text-gray-500">Active filters</p>
                          {Object.entries(columnConditions).map(([columnId, condition]) => (
                            <div key={columnId} className="flex items-center justify-between gap-2 rounded text-xs hover:bg-gray-50">
                              {/* The summary itself is the edit control — clicking it opens this filter's
                                  builder pre-filled, so it can be changed without removing it first. */}
                              <button
                                type="button"
                                onClick={() => setEditFilterKey(columnId)}
                                className="flex min-w-0 flex-1 items-center gap-1.5 px-1.5 py-1 text-left text-gray-700 hover:text-[#001d6e]"
                                title="Edit this filter"
                              >
                                <Pencil className="h-3 w-3 shrink-0 opacity-40" />
                                <span className="truncate">{conditionSummary(condition, filterableColumns)}</span>
                              </button>
                              <button type="button" onClick={() => clearColumnCondition(columnId)} className="mr-1.5 shrink-0 text-gray-400 hover:text-red-500" aria-label="Remove filter">
                                <X className="h-3.5 w-3.5" />
                              </button>
                            </div>
                          ))}
                        </div>
                      )}
                    </PopoverContent>
                  </Popover>
                )}
                {/* Search as a button that expands, matching the Scan Order page — rather than a
                    permanently-open input taking up header width. Shown in every layout, since it
                    lives in the card header the desktop, kiosk and mobile views all share. */}
                <CollapsibleSearch
                  value={search}
                  onChange={setSearch}
                  placeholder="Search by name or barcode…"
                />
              </>
            }
          >
            <DataTable<OsScanItem>
              containerClassName="rounded-none border-0"
              headerClassName="bg-[#001d6e] text-white border-[#1a3a9c] hover:bg-[#0a2b7e] hover:text-white"
              columns={itemColumns}
              data={filtered}
              getRowId={(row) => String(row.id)}
              isLoading={itemsQuery.isLoading}
              // No enableSearch here: the card header already carries a collapsible search
              // button, and having the table render its own always-open bar underneath meant two
              // search boxes driving the same value. The header button is the one that stays; its
              // text is applied in `searched` below, which is what feeds this table.
              enableZebraStripes
              rowClassName={(row) => {
                const status = row.status ?? "pending";
                return status === "extra" ? "bg-orange-50/40" : status === "complete" ? "bg-emerald-50/40" : status === "partial" ? "bg-amber-50/30" : undefined;
              }}
              renderExpandedRow={() => historyPanel}
              isRowExpandable={(row) => !!row.barcode}
              expandedRowId={historyItem ? String(historyItem.id) : null}
              emptyState={items.length === 0 ? "No items in this order." : "No items match your filters."}
              // Same treatment as the Scan Order page's own items table: a totals row closing the
              // table, and a bounded scroll box so the header stays put while the rows move.
              enableTotalsRow
              totalsLabelColumnId="item"
              columnOrder={columnOrder}
              onColumnOrderChange={setColumnOrder}
              enableColumnResizing
              isStickyHeader
              maxHeight={tableMaxHeight}
              showMobileSwipeHint
              // Three layouts for three shapes of screen, the same split the Scan Order page uses:
              // this table on a normal screen, the kiosk table below when rotated (bigger type,
              // pallets stacked under each qty, read from a distance), and the card list on a
              // narrow phone. Landscape keeps a real table either way.
              className={`space-y-0 ${bigView ? "hidden" : "hidden min-[480px]:block landscape:block"}`}
            />

            {/* Kiosk table — the rotated / portrait layout, matching the Scan Order page's own:
                bigger type and the pallet figure stacked UNDER each quantity rather than in its
                own column, so a whole row reads at a glance from across the floor. Its header
                holds at the top of the frame and its totals row at the bottom. */}
            {bigView && (
              // Still hidden under 480px in portrait: the card list takes that case, since a
              // 640px-min table on a phone would mean scrolling sideways to read a row.
              <div className={`${kioskTableBoxClass} hidden min-[480px]:block landscape:block`}>
                <table className="min-w-[640px] w-full border-collapse text-base">
                  <thead>
                    <tr className="sticky top-0 z-10 border-b-2 border-gray-300 bg-gray-100 text-left text-gray-600">
                      <th className="border-r border-gray-300 px-4 py-2.5 font-semibold">Item</th>
                      {["Exp", "Received", "Left", "Extra"].map((h) => (
                        <th key={h} className="border-r border-gray-300 px-3 py-2.5 text-right font-semibold">{h}</th>
                      ))}
                      <th className="px-4 py-2.5 text-center font-semibold">Status</th>
                    </tr>
                  </thead>
                  <tbody>
                    {filtered.length === 0 ? (
                      <tr>
                        <td colSpan={6} className="py-10 text-center text-gray-400">
                          {items.length === 0 ? "No items in this order." : "No items match your filters."}
                        </td>
                      </tr>
                    ) : filtered.map((item) => {
                      const { exp, received, left, extra, extraFromOtherParts } = rowState(item);
                      const ipp = item.itemsPerPallet ?? 0;
                      const status = item.status ?? "pending";
                      const plt = (q: number) => pltQty(q, ipp).toFixed(2);
                      const isOpen = historyItem?.id === item.id;
                      return (
                        <Fragment key={item.id}>
                          <tr className={`border-b border-gray-200 ${
                            status === "extra" ? "bg-orange-50/40" : status === "complete" ? "bg-emerald-50/40" : status === "partial" ? "bg-amber-50/30" : ""
                          }`}>
                            <td className="min-w-[180px] max-w-[320px] border-r border-gray-200 px-4 py-2.5">
                              {/* Same click-to-open scan history as the desktop table's Item cell. */}
                              <button
                                type="button"
                                disabled={!item.barcode}
                                onClick={() => setHistoryItem((cur) => (cur?.id === item.id ? null : item))}
                                className={`whitespace-normal break-words text-left font-medium leading-snug text-gray-900 underline decoration-dotted underline-offset-2 disabled:no-underline ${isOpen ? "text-[#001d6e] decoration-[#001d6e]" : "decoration-gray-300"}`}
                              >
                                {item.itemName ?? "—"}
                              </button>
                              <p className="whitespace-normal break-words font-mono text-gray-400">
                                {item.barcode ?? "—"}{item.sapCode && ` · SAP ${item.sapCode}`}
                              </p>
                              {!!item.realPackSize && item.realPackSize > 0 && (
                                <p className="text-sm font-semibold text-gray-600">{item.realPackSize} per pallet</p>
                              )}
                            </td>
                            <td className="border-r border-gray-200 px-3 py-2.5 text-right tabular-nums text-gray-600">
                              <span className="block text-lg">{exp || "—"}</span>
                              <span className="block text-sm font-extrabold text-gray-500">{plt(exp)} plt</span>
                            </td>
                            <td className="border-r border-gray-200 px-3 py-2.5 text-right tabular-nums font-semibold text-gray-900">
                              <span className="block text-lg">{received}</span>
                              <span className="block text-sm font-extrabold text-gray-500">{plt(received)} plt</span>
                            </td>
                            <td className={`border-r border-gray-200 px-3 py-2.5 text-right tabular-nums font-semibold ${left > 0 ? "text-[#001d6e]" : "text-gray-300"}`}>
                              <span className="block text-lg">{left || "—"}</span>
                              <span className="block text-sm font-extrabold text-gray-500">{plt(left)} plt</span>
                            </td>
                            <td className={`border-r border-gray-200 px-3 py-2.5 text-right tabular-nums font-semibold ${extra > 0 ? "text-amber-600" : "text-gray-300"}`}>
                              <span className="block text-lg">{extra > 0 ? `+${extra}` : "—"}</span>
                              {extra > 0 && extraFromOtherParts.length > 0 && (
                                <span className="block text-[10px] font-normal text-gray-400">from Part {extraFromOtherParts.join(", ")}</span>
                              )}
                              <span className="block text-sm font-extrabold text-gray-500">{plt(extra)} plt</span>
                            </td>
                            <td className="px-4 py-2.5 text-center">
                              <span className={`inline-block px-2.5 py-1 text-xs font-semibold ${
                                status === "extra" ? "bg-orange-100 text-orange-700"
                                : status === "complete" ? "bg-emerald-100 text-emerald-700"
                                : status === "partial" ? "bg-amber-100 text-amber-700"
                                : "bg-gray-100 text-gray-500"}`}>
                                {status === "extra" ? "Extra" : status === "complete" ? "Received" : status === "partial" ? "Partial" : "Pending"}
                              </span>
                            </td>
                          </tr>
                          {isOpen && (
                            <tr>
                              <td colSpan={6} className="border-b border-gray-200 p-0">{historyPanel}</td>
                            </tr>
                          )}
                        </Fragment>
                      );
                    })}
                    {/* Totals close the table, pinned to the bottom of the frame. The background
                        lives on the CELLS, not the row — a row background paints at its natural
                        position and doesn't travel with sticky cells. */}
                    {filtered.length > 0 && (
                      <tr className="border-t-2 border-[#001d6e]/20 bg-[#f5f6f9] font-bold text-gray-900">
                        <td className={`border-r border-gray-200 px-4 py-2.5 ${KIOSK_TOTALS_CELL}`}>Total</td>
                        {([
                          ["exp", "expPlt"], ["received", "receivedPlt"], ["left", "leftPlt"], ["extra", "extraPlt"],
                        ] as const).map(([qtyKey, pltKey]) => (
                          <td key={qtyKey} className={`border-r border-gray-200 px-3 py-2.5 text-right tabular-nums ${KIOSK_TOTALS_CELL}`}>
                            <span className="block text-lg">{cardTotals[qtyKey].toLocaleString()}</span>
                            <span className="block text-sm font-extrabold text-gray-500">{cardTotals[pltKey].toFixed(2)} plt</span>
                          </td>
                        ))}
                        <td className={`px-4 py-2.5 ${KIOSK_TOTALS_CELL}`} />
                      </tr>
                    )}
                  </tbody>
                </table>
              </div>
            )}

            {/* Mobile card list — the narrow-screen counterpart to the table above, matching the
                Scan Order page's own treatment: fields stack as labelled lines instead of columns,
                so nothing depends on sideways scrolling. Hidden once the screen is wide enough or
                turned to landscape, and never used in the rotated kiosk view (which is always
                wide enough for the real table). */}
            {!isRotated && (
              <div className="min-[480px]:hidden landscape:hidden">
                {filtered.length === 0 ? (
                  <p className="py-10 text-center text-sm text-gray-400">
                    {items.length === 0 ? "No items in this order." : "No items match your filters."}
                  </p>
                ) : (
                  filtered.map((item) => {
                    const { exp, received, left, extra, extraFromOtherParts } = rowState(item);
                    const ipp = item.itemsPerPallet ?? 0;
                    const status = item.status ?? "pending";
                    const expPlt = pltQty(exp, ipp).toFixed(2);
                    const leftPlt = pltQty(left, ipp).toFixed(2);
                    return (
                      <div
                        key={item.id}
                        className={`flex items-start gap-3 border-b border-gray-100 px-4 py-3 ${
                          status === "extra" ? "bg-orange-50/40" : status === "complete" ? "bg-emerald-50/40" : status === "partial" ? "bg-amber-50/30" : ""
                        }`}
                      >
                        <span className="mt-0.5 shrink-0">
                          {status === "complete" ? (
                            <span className="flex h-7 w-7 items-center justify-center rounded-full bg-emerald-100">
                              <CheckCircle2 className="h-4 w-4 text-emerald-600" />
                            </span>
                          ) : (
                            <span className={`flex h-7 w-7 items-center justify-center rounded-md border-2 border-dashed ${
                              status === "extra" ? "border-orange-300 text-orange-500" : status === "partial" ? "border-amber-400 text-amber-500" : "border-gray-300 text-gray-400"
                            }`}>
                              <ScanLine className="h-3.5 w-3.5" />
                            </span>
                          )}
                        </span>
                        <div className="min-w-0 flex-1">
                          {/* Tapping the name opens the same scan-history drill-down the table
                              row does, so voiding a mistake is reachable on a phone too. */}
                          <button
                            type="button"
                            disabled={!item.barcode}
                            onClick={() => setHistoryItem((cur) => (cur?.id === item.id ? null : item))}
                            className="text-left text-[15px] font-semibold leading-snug text-gray-900 underline decoration-dotted underline-offset-2 decoration-gray-300 disabled:no-underline"
                          >
                            {item.itemName ?? "—"}
                          </button>
                          <p className="mt-0.5 font-mono text-xs text-gray-400">
                            {item.barcode ?? "—"}{item.sapCode && ` · SAP: ${item.sapCode}`}
                          </p>
                          {!!item.realPackSize && item.realPackSize > 0 && (
                            <p className="mt-0.5 text-sm font-semibold text-gray-600">{item.realPackSize} per pallet</p>
                          )}
                          <p className="mt-1.5 text-sm leading-snug">
                            <span className="font-bold text-gray-900">{received}</span>
                            <span className="text-gray-400">/{exp}</span>{" "}
                            <span className="text-gray-400">({expPlt} plt)</span>
                            {left > 0 && (
                              <>
                                <span className="text-gray-300"> · </span>
                                <span className="font-semibold text-[#001d6e]">{left} left</span>{" "}
                                <span className="text-purple-500">(≈{leftPlt} plt)</span>
                              </>
                            )}
                            {extra > 0 && (
                              <>
                                <span className="text-gray-300"> · </span>
                                <span className="font-semibold text-amber-600">+{extra} extra</span>
                                {extraFromOtherParts.length > 0 && (
                                  <span className="text-[11px] font-normal text-gray-400"> (Part {extraFromOtherParts.join(", ")})</span>
                                )}
                              </>
                            )}
                          </p>
                          {historyItem?.id === item.id && <div className="mt-2">{historyPanel}</div>}
                        </div>
                        <span className="shrink-0">
                          <span className={`inline-block rounded-full px-2.5 py-1 text-xs font-semibold ${
                            status === "extra" ? "bg-orange-100 text-orange-700"
                            : status === "complete" ? "bg-emerald-100 text-emerald-700"
                            : status === "partial" ? "bg-amber-100 text-amber-700"
                            : "bg-gray-100 text-gray-500"}`}>
                            {status === "extra" ? "Extra" : status === "complete" ? "Received" : status === "partial" ? "Partial" : "Pending"}
                          </span>
                        </span>
                      </div>
                    );
                  })
                )}
                {/* The card list gets the same closing totals as the table — the numbers
                    shouldn't disappear just because the screen is narrow. */}
                {filtered.length > 0 && (
                  <div className="flex items-center justify-between gap-3 border-t-2 border-[#001d6e]/20 bg-[#f5f6f9] px-4 py-3 text-sm font-bold text-gray-900">
                    <span>Total</span>
                    <span className="flex flex-wrap items-center justify-end gap-x-3 tabular-nums">
                      <span>{cardTotals.received}/{cardTotals.exp}</span>
                      <span className="text-gray-500">({cardTotals.expPlt.toFixed(2)} plt)</span>
                      {cardTotals.left > 0 && <span className="text-[#001d6e]">{cardTotals.left} left</span>}
                      {cardTotals.extra > 0 && <span className="text-amber-600">+{cardTotals.extra} extra</span>}
                    </span>
                  </div>
                )}
              </div>
            )}
          </TableCard>
          </>
        ) : (
          <>
          {/* Master View — same Order Totals card as Part View, computed over every item merged
              across all of this order's CSV parts (mvTotals) instead of one session's items. */}
          <div className="flex flex-col gap-1.5 rounded-xl border bg-white p-2.5 shadow-sm">
            <div className="flex items-baseline justify-between">
              <p className="text-sm font-semibold uppercase tracking-wide text-gray-500">Order Totals</p>
              <p className="text-sm font-medium text-gray-400">
                {mvTotals.expected > 0 ? `${Math.round((mvTotals.done / mvTotals.expected) * 100)}% complete` : "—"}
              </p>
            </div>
            <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
              {([
                { key: "", label: "Total", value: mvTotals.expected, plt: mvTotals.palletsExpected, dot: "bg-gray-400", text: "text-gray-900" },
                { key: "done", label: "Received", value: mvTotals.done, plt: mvTotals.palletsDone, dot: "bg-emerald-500", text: "text-emerald-600" },
                { key: "remaining", label: "Remaining", value: mvTotals.remaining, plt: mvTotals.palletsRemaining, dot: "bg-red-500", text: "text-red-600" },
                { key: "extra", label: "Extra", value: mvTotals.extra, plt: mvTotals.palletsExtra, dot: "bg-orange-500", text: mvTotals.extra > 0 ? "text-amber-600" : "text-gray-300" },
              ] as const).map((s) => {
                const isActive = mvStatFilter === s.key;
                return (
                  <button
                    key={s.label}
                    type="button"
                    onClick={() => setMvStatFilter(isActive ? "" : (s.key as typeof mvStatFilter))}
                    aria-pressed={isActive}
                    title={s.key ? `Show only ${s.label.toLowerCase()} items` : "Show all items"}
                    className={`rounded-xl border px-2.5 py-1 text-center transition-colors ${
                      isActive ? "border-[#001d6e] bg-[#001d6e]/[0.06] ring-1 ring-[#001d6e]/30" : "border-gray-100 bg-gray-50/70 hover:bg-gray-100"
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
                  style={{ width: `${mvTotals.expected > 0 ? Math.min(100, (mvTotals.done / mvTotals.expected) * 100) : 0}%` }}
                />
              </div>
              <div className="flex justify-between text-[10px] font-medium text-gray-400">
                <span>{mvTotals.done} received</span>
                <span>{mvTotals.remaining} remaining</span>
              </div>
            </div>
          </div>

          <TableCard
            icon={Eye}
            compactHeader
            title={`${mvFiltered.length} of ${allMvItems.length} items`}
            className="rounded-xl shadow-sm border-gray-200"
            headerActions={
              <CollapsibleSearch value={search} onChange={setSearch} placeholder="Search by name or barcode…" />
            }
          >
            {mvQuery.isLoading ? (
              <div className="flex justify-center py-16"><Loader2 className="h-6 w-6 animate-spin text-[#001d6e]" /></div>
            ) : (
              <>
              <DataTable<MvMergedItem>
                containerClassName="rounded-none border-0"
                headerClassName="bg-[#001d6e] text-white border-[#1a3a9c] hover:bg-[#0a2b7e] hover:text-white"
                columns={mvColumns}
                data={mvFiltered}
                getRowId={(row) => row.barcode ?? row.itemName ?? String(Math.random())}
                enableZebraStripes
                rowClassName={(row) => (row.isExtraOnly ? "bg-orange-50/40" : undefined)}
                emptyState={allMvItems.length === 0 ? "No items in this order." : "No items match your filters."}
                enableTotalsRow
                totalsLabelColumnId="item"
                isStickyHeader
                maxHeight={tableMaxHeight}
                showMobileSwipeHint
                className={`space-y-0 ${bigView ? "hidden" : "hidden min-[480px]:block landscape:block"}`}
              />

              {/* Kiosk table — same rotated/portrait treatment as Part View's own. */}
              {bigView && (
                <div className={`${kioskTableBoxClass} hidden min-[480px]:block landscape:block`}>
                  <table className="min-w-[640px] w-full border-collapse text-base">
                    <thead>
                      <tr className="sticky top-0 z-10 border-b-2 border-gray-300 bg-gray-100 text-left text-gray-600">
                        <th className="border-r border-gray-300 px-4 py-2.5 font-semibold">Item</th>
                        {["Exp", "Received", "Left", "Extra"].map((h) => (
                          <th key={h} className="border-r border-gray-300 px-3 py-2.5 text-right font-semibold">{h}</th>
                        ))}
                        <th className="px-4 py-2.5 text-center font-semibold">Status</th>
                      </tr>
                    </thead>
                    <tbody>
                      {mvFiltered.length === 0 ? (
                        <tr><td colSpan={6} className="py-10 text-center text-gray-400">{allMvItems.length === 0 ? "No items in this order." : "No items match your filters."}</td></tr>
                      ) : mvFiltered.map((item) => {
                        const { exp, received, left, extra } = mvRowState(item);
                        const ipp = item.itemsPerPallet;
                        const status = item.isExtraOnly ? "extra" : received >= exp && exp > 0 ? "complete" : received > 0 ? "partial" : "pending";
                        const plt = (q: number) => mvPltQty(q, ipp).toFixed(2);
                        const isOpen = historyItem?.barcode === item.barcode;
                        return (
                          <Fragment key={item.barcode ?? item.itemName}>
                            <tr className={`border-b border-gray-200 ${
                              status === "extra" ? "bg-orange-50/40" : status === "complete" ? "bg-emerald-50/40" : status === "partial" ? "bg-amber-50/30" : ""
                            }`}>
                              <td className="min-w-[180px] max-w-[320px] border-r border-gray-200 px-4 py-2.5">
                                <p className="whitespace-normal break-words text-left font-medium leading-snug text-gray-900">
                                  {item.itemName ?? "—"}
                                </p>
                                <p className="whitespace-normal break-words font-mono text-gray-400">
                                  {item.barcode ?? "—"}{item.sapCode && ` · SAP ${item.sapCode}`}
                                </p>
                                {ipp > 0 && <p className="text-sm font-semibold text-gray-600">{ipp} per pallet</p>}
                                {item.isExtraOnly && <p className="text-[11px] font-semibold uppercase text-amber-700">Extra — not on any CSV</p>}
                              </td>
                              <td className="border-r border-gray-200 px-3 py-2.5 text-right tabular-nums text-gray-600">
                                <span className="block text-lg">{exp || "—"}</span>
                                <span className="block text-sm font-extrabold text-gray-500">{plt(exp)} plt</span>
                              </td>
                              <td className="border-r border-gray-200 px-3 py-2.5 text-right tabular-nums font-semibold text-gray-900">
                                <span className="block text-lg">{received}</span>
                                <span className="block text-sm font-extrabold text-gray-500">{plt(received)} plt</span>
                              </td>
                              <td className={`border-r border-gray-200 px-3 py-2.5 text-right tabular-nums font-semibold ${left > 0 ? "text-[#001d6e]" : "text-gray-300"}`}>
                                <span className="block text-lg">{left || "—"}</span>
                                <span className="block text-sm font-extrabold text-gray-500">{plt(left)} plt</span>
                              </td>
                              <td className={`border-r border-gray-200 px-3 py-2.5 text-right tabular-nums font-semibold ${extra > 0 ? "text-amber-600" : "text-gray-300"}`}>
                                <span className="block text-lg">{extra > 0 ? `+${extra}` : "—"}</span>
                                <span className="block text-sm font-extrabold text-gray-500">{plt(extra)} plt</span>
                              </td>
                              <td className="px-4 py-2.5 text-center">
                                <span className={`inline-block px-2.5 py-1 text-xs font-semibold ${
                                  status === "extra" ? "bg-orange-100 text-orange-700"
                                  : status === "complete" ? "bg-emerald-100 text-emerald-700"
                                  : status === "partial" ? "bg-amber-100 text-amber-700" : "bg-gray-100 text-gray-500"}`}>
                                  {status === "extra" ? "Extra" : status === "complete" ? "Received" : status === "partial" ? "Partial" : "Pending"}
                                </span>
                              </td>
                            </tr>
                            {isOpen && (
                              <tr><td colSpan={6} className="border-b border-gray-200 p-0">{historyPanel}</td></tr>
                            )}
                          </Fragment>
                        );
                      })}
                      {mvFiltered.length > 0 && (
                        <tr className="border-t-2 border-[#001d6e]/20 bg-[#f5f6f9] font-bold text-gray-900">
                          <td className={`border-r border-gray-200 px-4 py-2.5 ${KIOSK_TOTALS_CELL}`}>Total</td>
                          {([
                            ["exp", "expPlt"], ["received", "receivedPlt"], ["left", "leftPlt"], ["extra", "extraPlt"],
                          ] as const).map(([qtyKey, pltKey]) => (
                            <td key={qtyKey} className={`border-r border-gray-200 px-3 py-2.5 text-right tabular-nums ${KIOSK_TOTALS_CELL}`}>
                              <span className="block text-lg">{mvCardTotals[qtyKey].toLocaleString()}</span>
                              <span className="block text-sm font-extrabold text-gray-500">{mvCardTotals[pltKey].toFixed(2)} plt</span>
                            </td>
                          ))}
                          <td className={`px-4 py-2.5 ${KIOSK_TOTALS_CELL}`} />
                        </tr>
                      )}
                    </tbody>
                  </table>
                </div>
              )}

              {/* Mobile card list — same treatment as Part View's own. */}
              {!isRotated && (
                <div className="min-[480px]:hidden landscape:hidden">
                  {mvFiltered.length === 0 ? (
                    <p className="py-10 text-center text-sm text-gray-400">
                      {allMvItems.length === 0 ? "No items in this order." : "No items match your filters."}
                    </p>
                  ) : (
                    mvFiltered.map((item) => {
                      const { exp, received, left, extra } = mvRowState(item);
                      const ipp = item.itemsPerPallet;
                      const status = item.isExtraOnly ? "extra" : received >= exp && exp > 0 ? "complete" : received > 0 ? "partial" : "pending";
                      const expPlt = mvPltQty(exp, ipp).toFixed(2);
                      const leftPlt = mvPltQty(left, ipp).toFixed(2);
                      return (
                        <div
                          key={item.barcode ?? item.itemName}
                          className={`flex items-start gap-3 border-b border-gray-100 px-4 py-3 ${
                            status === "extra" ? "bg-orange-50/40" : status === "complete" ? "bg-emerald-50/40" : status === "partial" ? "bg-amber-50/30" : ""
                          }`}
                        >
                          <span className="mt-0.5 shrink-0">
                            {status === "complete" ? (
                              <span className="flex h-7 w-7 items-center justify-center rounded-full bg-emerald-100">
                                <CheckCircle2 className="h-4 w-4 text-emerald-600" />
                              </span>
                            ) : (
                              <span className={`flex h-7 w-7 items-center justify-center rounded-md border-2 border-dashed ${
                                status === "extra" ? "border-orange-300 text-orange-500" : status === "partial" ? "border-amber-400 text-amber-500" : "border-gray-300 text-gray-400"
                              }`}>
                                <ScanLine className="h-3.5 w-3.5" />
                              </span>
                            )}
                          </span>
                          <div className="min-w-0 flex-1">
                            {/* View-only, like the Master View table above. */}
                            <p className="text-left text-[15px] font-semibold leading-snug text-gray-900">
                              {item.itemName ?? "—"}
                            </p>
                            <p className="mt-0.5 font-mono text-xs text-gray-400">
                              {item.barcode ?? "—"}{item.sapCode && ` · SAP: ${item.sapCode}`}
                            </p>
                            {ipp > 0 && <p className="mt-0.5 text-sm font-semibold text-gray-600">{ipp} per pallet</p>}
                            {item.isExtraOnly && <p className="mt-0.5 text-[11px] font-semibold uppercase text-amber-700">Extra — not on any CSV</p>}
                            <p className="mt-1.5 text-sm leading-snug">
                              <span className="font-bold text-gray-900">{received}</span>
                              <span className="text-gray-400">/{exp}</span>{" "}
                              <span className="text-gray-400">({expPlt} plt)</span>
                              {left > 0 && (
                                <>
                                  <span className="text-gray-300"> · </span>
                                  <span className="font-semibold text-[#001d6e]">{left} left</span>{" "}
                                  <span className="text-purple-500">(≈{leftPlt} plt)</span>
                                </>
                              )}
                              {extra > 0 && (
                                <>
                                  <span className="text-gray-300"> · </span>
                                  <span className="font-semibold text-amber-600">+{extra} extra</span>
                                </>
                              )}
                            </p>
                            {historyItem?.barcode === item.barcode && <div className="mt-2">{historyPanel}</div>}
                          </div>
                          <span className="shrink-0">
                            <span className={`inline-block rounded-full px-2.5 py-1 text-xs font-semibold ${
                              status === "extra" ? "bg-orange-100 text-orange-700"
                              : status === "complete" ? "bg-emerald-100 text-emerald-700"
                              : status === "partial" ? "bg-amber-100 text-amber-700" : "bg-gray-100 text-gray-500"}`}>
                              {status === "extra" ? "Extra" : status === "complete" ? "Received" : status === "partial" ? "Partial" : "Pending"}
                            </span>
                          </span>
                        </div>
                      );
                    })
                  )}
                  {mvFiltered.length > 0 && (
                    <div className="flex items-center justify-between gap-3 border-t-2 border-[#001d6e]/20 bg-[#f5f6f9] px-4 py-3 text-sm font-bold text-gray-900">
                      <span>Total</span>
                      <span className="flex flex-wrap items-center justify-end gap-x-3 tabular-nums">
                        <span>{mvCardTotals.received}/{mvCardTotals.exp}</span>
                        <span className="text-gray-500">({mvCardTotals.expPlt.toFixed(2)} plt)</span>
                        {mvCardTotals.left > 0 && <span className="text-[#001d6e]">{mvCardTotals.left} left</span>}
                        {mvCardTotals.extra > 0 && <span className="text-amber-600">+{mvCardTotals.extra} extra</span>}
                      </span>
                    </div>
                  )}
                </div>
              )}
              </>
            )}
          </TableCard>
          </>
        )}
      </div>

      {/* Void confirmation — same rule as Scan/Scan History's own void dialog. */}
      <Dialog open={!!voidTarget} onOpenChange={(o) => { if (!o) { setVoidTarget(null); setVoidReason(""); } }}>
        {/* Radix portals this to <body>, outside the rotated container, so on a turned screen it
            would otherwise open upright while everything behind it is rotated. */}
        <DialogContent className={`w-[calc(100%-2rem)] max-w-sm ${portalRotate}`}>
          <DialogHeader>
            <DialogTitle className="text-red-600">Void this scan?</DialogTitle>
            <DialogDescription>
              This reverses its stock impact and excludes it from totals — the entry stays visible in history, marked as voided.
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-1.5 py-1">
            <Label htmlFor="scan-viewer-void-reason" className="text-xs">Reason</Label>
            <Input
              id="scan-viewer-void-reason"
              value={voidReason}
              onChange={(e) => setVoidReason(e.target.value)}
              placeholder="e.g. scanned wrong item, duplicate scan"
              autoFocus
            />
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => { setVoidTarget(null); setVoidReason(""); }}>Cancel</Button>
            <Button
              className="bg-red-600 text-white hover:bg-red-700"
              disabled={voidMutation.isPending || !voidReason.trim()}
              onClick={() => voidTarget && voidMutation.mutate({ id: voidTarget.id, reason: voidReason.trim() })}
            >
              {voidMutation.isPending ? <Loader2 className="h-4 w-4 animate-spin" /> : "Void Scan"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
