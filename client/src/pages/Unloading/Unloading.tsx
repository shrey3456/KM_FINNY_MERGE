import { useEffect, useRef, useState } from "react";
import { useMutation, useQuery } from "@tanstack/react-query";
import Papa from "papaparse";
import type { Result } from "@zxing/library";
import BarcodeScanner from "@/lib/barcodeScanner";
import {
  AlertTriangle, Camera, ChevronLeft, ChevronRight, Keyboard, Loader2, Package, PackageOpen, RotateCcw, RotateCw,
  ScanLine, Search, Trash2, Truck, Upload, X, Zap,
} from "lucide-react";
import PageHeader from "@/components/PageHeader";
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
  pallets: number; looseQty: number; totalQty: number; isExtra: boolean; isCredit?: boolean;
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

// ─── CSV column mapping (mirrors client/src/pages/OrderImport.tsx's mapping dialog, plus a
// mandatory Vehicle Number field) — parses the raw CSV client-side, auto-matches columns by
// common header names, then lets the user review/override the mapping before importing. ──────
const TARGET_FIELDS = [
  { key: "vehicleNumber", label: "Vehicle Number" },
  { key: "barcode", label: "Barcode / SKU" },
  { key: "itemName", label: "Item Name" },
  { key: "sapCode", label: "SAP Code" },
  { key: "quantity", label: "Quantity" },
] as const;
type TargetKey = (typeof TARGET_FIELDS)[number]["key"];
type Mapping = Record<TargetKey, string>;
const SKIP = "__skip__";

function cleanHeader(h: string): string {
  return h.replace(/^﻿/, "").replace(/[^\x20-\x7E]/g, "").trim();
}

// Reads a CSV quantity cell as a number, decimal-safely. The old approach stripped every
// non-digit character (including the decimal point itself) before parsing — so a cell written
// as "200.00" (a very common Excel export format for a whole-number column) became "20000" once
// the "." was stripped, silently importing a quantity 100x too large. parseFloat (which
// understands the decimal point) then a round is the correct way to read it; commas are still
// stripped first since those are a thousands separator, not part of the number.
function parseQtyCell(raw: string): number {
  const n = parseFloat(raw.replace(/,/g, "").trim());
  return Number.isFinite(n) ? Math.round(n) : 0;
}

function autoMatch(headers: string[]): Mapping {
  const norm = headers.map((h) => h.toLowerCase().replace(/[\s_\-+*]/g, ""));
  const best = (...kws: string[]) => {
    for (const kw of kws) {
      const k = kw.toLowerCase().replace(/[\s_\-+*]/g, "");
      const i = norm.findIndex((h) => h === k);
      if (i !== -1) return headers[i];
    }
    for (const kw of kws) {
      const k = kw.toLowerCase().replace(/[\s_\-+*]/g, "");
      const i = norm.findIndex((h) => h.startsWith(k));
      if (i !== -1) return headers[i];
    }
    for (const kw of kws) {
      const k = kw.toLowerCase().replace(/[\s_\-+*]/g, "");
      const i = norm.findIndex((h) => h.includes(k));
      if (i !== -1) return headers[i];
    }
    return SKIP;
  };
  // Exact-header-only match, no startsWith/includes fuzziness — for keywords too generic to
  // safely substring-match (see quantity's "total"/"grand total" fallback below).
  const bestExact = (...kws: string[]) => {
    for (const kw of kws) {
      const k = kw.toLowerCase().replace(/[\s_\-+*]/g, "");
      const i = norm.findIndex((h) => h === k);
      if (i !== -1) return headers[i];
    }
    return SKIP;
  };
  // "total"/"grand total" alone are too generic to substring-match safely — a CSV can easily
  // have an unrelated "Total Amount"/"Total Value"/"Total Weight" column alongside the real
  // quantity one, and best()'s startsWith/includes tiers would grab whichever "Total ..." column
  // happens to come first, silently importing the wrong numbers as quantity. So they're only
  // tried as an exact-header last resort, after every quantity-specific keyword (checked via the
  // normal fuzzy best()) has already come up empty.
  const quantityMatch = best("total qty", "total quantity", "quantity", "qty", "boxes", "nos", "pcs", "count", "units");
  return {
    vehicleNumber: best("vehicle no", "vehicle number", "vehicleno", "vehicle", "truck no", "truckno", "vehicle reg", "vehicle regno"),
    barcode: best("barcode", "bar code", "bar_code", "sku", "product code", "productcode", "item code", "itemcode", "code"),
    itemName: best("product name", "productname", "item name", "itemname", "description", "name", "item", "product", "material"),
    sapCode: best("sap code", "sapcode", "sap_code", "sap", "material code", "materialcode"),
    quantity: quantityMatch !== SKIP ? quantityMatch : bestExact("total", "grand total"),
  };
}

function getLocalISODate(date = new Date()): string {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

function parseCsvRaw(file: File, toast: (opts: any) => void): Promise<{ name: string; headers: string[]; rows: Record<string, string>[] } | null> {
  return new Promise((resolve) => {
    Papa.parse<string[]>(file, {
      header: false, skipEmptyLines: true, delimiter: "", encoding: "UTF-8",
      complete: (result) => {
        const rawRows = result.data as string[][];
        if (rawRows.length === 0) {
          toast({ title: "Empty file", description: `"${file.name}" has no rows.`, variant: "destructive" });
          resolve(null);
          return;
        }
        let headerRowIdx = 0;
        let maxCols = 0;
        for (let i = 0; i < Math.min(rawRows.length, 15); i++) {
          const nonEmpty = rawRows[i].filter((c) => c.trim() !== "").length;
          if (nonEmpty > maxCols) { maxCols = nonEmpty; headerRowIdx = i; }
        }
        const headers = rawRows[headerRowIdx].map((h) => cleanHeader(h)).filter((h) => h !== "");
        if (headers.length === 0) {
          toast({ title: "No columns found", description: `Could not detect column headers in "${file.name}".`, variant: "destructive" });
          resolve(null);
          return;
        }
        const rows = rawRows.slice(headerRowIdx + 1).map((row) => {
          const obj: Record<string, string> = {};
          headers.forEach((h, i) => { obj[h] = row[i] ?? ""; });
          return obj;
        });
        resolve({ name: file.name, headers, rows });
      },
      error: (err) => {
        toast({ title: "Could not parse CSV", description: `"${file.name}": ${err.message}`, variant: "destructive" });
        resolve(null);
      },
    });
  });
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
  // Two tabs — Available (which also holds in-progress "active" batches, marked green) and
  // History (shows every status). "active"/"completed" stay valid values for the underlying
  // query param but no longer have their own tab button. "Time Taken" only ever shows a value
  // on the History tab, matching Order Management's own restriction.
  const [statusTab, setStatusTab] = useState<"available" | "active" | "completed" | "history">("available");
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

  function selectStatusTab(key: "available" | "active" | "completed" | "history") {
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

  // ─── Import: plant/date/file picker, then a column-mapping dialog ───────────────────────────
  const [showImport, setShowImport] = useState(false);
  const [importPlant, setImportPlant] = useState("");
  const [importDate, setImportDate] = useState("");
  const [importFile, setImportFile] = useState<File | null>(null);
  const [isImporting, setIsImporting] = useState(false);
  const fileRef = useRef<HTMLInputElement>(null);

  const [csvData, setCsvData] = useState<{ name: string; headers: string[]; rows: Record<string, string>[] } | null>(null);
  const [mapping, setMapping] = useState<Mapping>({ vehicleNumber: SKIP, barcode: SKIP, itemName: SKIP, sapCode: SKIP, quantity: SKIP });
  const [showMappingDialog, setShowMappingDialog] = useState(false);

  function resetImportDialog() {
    setImportPlant(""); setImportDate(""); setImportFile(null);
    if (fileRef.current) fileRef.current.value = "";
  }

  async function handleFileChosen(file: File) {
    const parsed = await parseCsvRaw(file, toast);
    if (!parsed) return;
    setCsvData(parsed);
    setMapping(autoMatch(parsed.headers));
    setShowImport(false);
    setShowMappingDialog(true);
  }

  function handleImportNext() {
    if (!importPlant.trim()) { toast({ title: "Select a plant first", variant: "destructive" }); return; }
    if (!importDate.trim()) { toast({ title: "Select an Order Date first", variant: "destructive" }); return; }
    if (!importFile) { toast({ title: "Select a CSV file first", variant: "destructive" }); return; }
    handleFileChosen(importFile);
  }

  async function handleConfirmImport() {
    if (!csvData) return;
    const get = (row: Record<string, string>, key: TargetKey) => {
      const col = mapping[key];
      return col && col !== SKIP ? (row[col] ?? "") : "";
    };
    if (mapping.vehicleNumber === SKIP) { toast({ title: "Map the Vehicle Number column", variant: "destructive" }); return; }
    if (mapping.barcode === SKIP) { toast({ title: "Map the Barcode column", variant: "destructive" }); return; }
    if (mapping.quantity === SKIP) { toast({ title: "Map the Quantity column", variant: "destructive" }); return; }

    const items = csvData.rows.map((row) => ({
      vehicleNumber: get(row, "vehicleNumber").trim(),
      barcode: get(row, "barcode").trim(),
      itemName: get(row, "itemName").trim() || null,
      sapCode: get(row, "sapCode").trim() || null,
      quantity: parseQtyCell(get(row, "quantity")),
    })).filter((it) => it.vehicleNumber || it.barcode);

    setIsImporting(true);
    try {
      const data = await apiRequest("POST", "/api/unloading/import", {
        plant: importPlant, orderDate: importDate, csvFileName: csvData.name, items,
      }, false, true);

      toast({
        title: "Imported",
        description: `${csvData.name} — ${data.vehicles.length} vehicle(s): ${data.vehicles.map((v: any) => `${v.vehicleNumber} (${v.rowCount})${v.replacesSessionId ? " · replaced" : ""}`).join(", ")}`,
      });
      queryClient.invalidateQueries({ queryKey: ["/api/unloading/sessions"] });
      setShowMappingDialog(false);
      setCsvData(null);
      resetImportDialog();
    } catch (error: any) {
      console.error("Unloading import failed:", error);
      toast({ title: "Import failed", description: error?.message || "Could not import CSV", variant: "destructive" });
    } finally {
      setIsImporting(false);
    }
  }

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

  const filteredItems = (detail?.items ?? []).filter((item) => {
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
  });

  const activateMutation = useMutation({
    mutationFn: (id: number) => apiRequest("POST", `/api/unloading/sessions/${id}/activate`, {}, false, true),
    onError: (error: any) => toast({ title: "Can't start yet", description: error?.message || "This batch can't be activated right now.", variant: "destructive" }),
  });

  function enterSession(id: number) {
    setActiveSessionId(id);
    setView("scan");
    setItemBarcode(""); setItemScanMode("manual"); setItemStatusFilter(""); setExpandedItemId(null);
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
    mutationFn: ({ barcode, qty }: { barcode: string; qty: number }) =>
      apiRequest("POST", `/api/unloading/sessions/${activeSessionId}/scan`, { barcode, qty }, false, true),
    onSuccess: (data) => {
      queryClient.setQueryData(["/api/unloading/sessions", activeSessionId], { session: data.session, items: data.items, allComplete: data.allComplete });
      if (data.allComplete) toast({ title: "Batch complete", description: "Every item's expected quantity has been matched." });
    },
    onError: (error: any) => toast({ title: "Scan failed", description: error?.message || "Could not record scan", variant: "destructive" }),
    onSettled: () => { scanLockRef.current = false; },
  });

  // ─── Manual/Camera barcode input, same-barcode cooldown, auto-scan popup — mirrors
  // client/src/pages/Loading/LoadOperation.tsx's item-scanning UX exactly. ─────────────────────
  const [itemScanMode, setItemScanMode] = useState<"camera" | "manual">("manual");
  const [itemBarcode, setItemBarcode] = useState("");
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

    const nb = normalize(barcode);
    const last = lastScanRef.current;
    if (last && normalize(last.barcode) === nb && Date.now() - last.at < SAME_BARCODE_COOLDOWN_MS) return;
    lastScanRef.current = { barcode, at: Date.now() };

    const item = detail.items.find((i) => normalize(i.barcode) === nb) ?? null;
    scanLockRef.current = true;

    const ipp = item?.itemsPerPallet ?? 0;
    const canAutoScan = autoScanEnabled && !!item && item.expected > 0 && ipp >= 1 && item.remaining >= ipp;
    if (canAutoScan) {
      scanMutation.mutate({ barcode, qty: ipp }, {
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
                  <td className="py-1 pr-3 tabular-nums">{ev.totalQty}{ev.isExtra ? " (extra)" : ""}{ev.isCredit ? " (credit)" : ""}</td>
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
        <PageHeader
          icon={PackageOpen}
          title="Unloading"
          description="Import a vehicle-wise CSV, then pick a vehicle + date to scan its items and receive stock."
        />

        {view === "list" && (
          <div className="rounded-xl border border-gray-200 bg-white shadow-sm overflow-hidden">
            <div className="flex items-center justify-between gap-2 px-4 sm:px-5 py-3.5 border-b border-gray-100">
              <div>
                <div className="text-lg font-bold text-[#001d6e]">Vehicles</div>
                <div className="text-xs text-gray-400">{total} part(s){sessionPlantFilter ? ` · ${sessionPlantFilter}` : ""}</div>
              </div>
              <div className="flex items-center gap-2">
                {importablePlants.length > 1 && (
                  <Select value={sessionPlantFilter || "all"} onValueChange={(v) => { setSessionPlantFilter(v === "all" ? "" : v); setOffset(0); }}>
                    <SelectTrigger className="h-9 w-[160px]"><SelectValue placeholder="All Plants" /></SelectTrigger>
                    <SelectContent>
                      <SelectItem value="all">All Plants</SelectItem>
                      {importablePlants.map((p: any) => (
                        <SelectItem key={p.id ?? p.name} value={p.name}>{p.name}</SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                )}
                {canWrite && (
                  <Button className="h-9 bg-[#001d6e] text-white hover:bg-[#001552]" onClick={() => setShowImport(true)}>
                    <Upload className="mr-1.5 h-4 w-4" /> Import CSV
                  </Button>
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
                  ] as { key: "available" | "active" | "completed" | "history"; label: string; count: number }[]
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

            {sessionsQuery.isLoading ? (
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
              <div className="overflow-x-auto">
                <table className="w-full min-w-full caption-bottom border-collapse text-xs">
                  <thead>
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

            {total > 0 && (() => {
              const pageIndex = Math.floor(offset / limit);
              const pageCount = Math.max(1, Math.ceil(total / limit));
              return (
                <div className="flex flex-wrap items-center justify-between gap-2 border-t border-gray-100 px-4 py-3">
                  <span className="text-xs text-muted-foreground">
                    Showing {offset + 1} to {Math.min(offset + limit, total)} of {total} entries
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
                  style={isDesktop && canWrite && !locked ? { gridTemplateColumns: `${leftColWidth}px 10px 1fr` } : undefined}
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

                  {isDesktop && canWrite && !locked && (
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
        <DialogContent className={`max-w-sm ${portalRotate}`}>
          <DialogHeader>
            <DialogTitle>{pending?.item?.itemName ?? pending?.barcode ?? "Confirm scan"}</DialogTitle>
            <DialogDescription>
              {pending?.item
                ? `Expected ${pending.item.expected} · Scanned ${pending.item.scanned} · Remaining ${pending.item.remaining}`
                : "Not on this vehicle's manifest — will be logged as an extra."}
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-3">
            {pending?.item && pending.item.itemsPerPallet > 0 ? (
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
                    value={dialogQty}
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
                <Input value={dialogQty} onChange={(e) => setDialogQty(parseInt(e.target.value, 10) || 0)} type="number" min="1" />
              </div>
            )}
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setPending(null)}>Cancel</Button>
            <Button
              className="bg-[#001d6e] text-white hover:bg-[#001552]"
              disabled={dialogQty <= 0 || scanMutation.isPending}
              onClick={() => {
                if (!pending) return;
                scanMutation.mutate({ barcode: pending.barcode, qty: dialogQty }, { onSuccess: () => setPending(null) });
              }}
            >
              {scanMutation.isPending ? <Loader2 className="mr-1.5 h-3.5 w-3.5 animate-spin" /> : null}
              Confirm
            </Button>
          </DialogFooter>
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

      {/* ── Import: step 1 — plant/date/file picker ─────────────────────────────── */}
      <Dialog open={showImport} onOpenChange={(open) => { setShowImport(open); if (!open) resetImportDialog(); }}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Import Unloading CSV</DialogTitle>
            <DialogDescription>
              One CSV can contain multiple vehicles — every row must have a Vehicle Number column.
            </DialogDescription>
          </DialogHeader>

          <div className="space-y-3">
            <div className="space-y-1.5">
              <Label htmlFor="importPlant">Plant</Label>
              <Select value={importPlant} onValueChange={setImportPlant}>
                <SelectTrigger id="importPlant"><SelectValue placeholder="Select a plant" /></SelectTrigger>
                <SelectContent>
                  {importablePlants.map((p: any) => (
                    <SelectItem key={p.id ?? p.name} value={p.name}>{p.name}</SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="importDate">Order Date</Label>
              <Input id="importDate" type="date" value={importDate} onChange={(e) => setImportDate(e.target.value)} />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="importFile">CSV File</Label>
              <Input
                id="importFile" ref={fileRef} type="file" accept=".csv"
                onChange={(e) => setImportFile(e.target.files?.[0] ?? null)}
              />
              {importFile && <div className="text-xs text-gray-500">{importFile.name}</div>}
            </div>
          </div>

          <DialogFooter>
            <Button variant="outline" onClick={() => setShowImport(false)}>Cancel</Button>
            <Button className="bg-[#001d6e] text-white hover:bg-[#001552]" onClick={handleImportNext}>
              Next: Map Columns
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* ── Import: step 2 — column mapping dialog (mirrors OrderImport.tsx) ────── */}
      <Dialog open={showMappingDialog} onOpenChange={(open) => { if (!open) { setShowMappingDialog(false); setCsvData(null); } }}>
        <DialogContent className="max-w-2xl max-h-[90vh] flex flex-col rounded-xl">
          <DialogHeader>
            <DialogTitle>Map CSV Columns</DialogTitle>
            <DialogDescription>
              {csvData ? `"${csvData.name}" — ${csvData.rows.length} rows detected. Match each target field to a CSV column.` : "Map columns."}
            </DialogDescription>
          </DialogHeader>

          {csvData && (
            <div className="flex flex-col gap-4 overflow-y-auto flex-1 min-h-0 pr-1">
              <div className="border border-blue-100 bg-blue-50 px-4 py-3">
                <p className="mb-2 text-xs font-semibold text-blue-700">{csvData.headers.length} columns detected in "{csvData.name}"</p>
                <div className="flex flex-wrap gap-1.5">
                  {csvData.headers.map((h) => (
                    <span key={h} className="border border-blue-200 bg-white px-2 py-0.5 text-xs text-blue-800 font-mono">{h}</span>
                  ))}
                </div>
              </div>
              <div className="border bg-gray-50 p-4">
                <p className="mb-3 text-xs font-semibold uppercase tracking-wide text-gray-500">Map each target field → CSV column</p>
                <div className="grid grid-cols-1 gap-3">
                  {TARGET_FIELDS.map((field) => {
                    const matched = mapping[field.key] !== SKIP && mapping[field.key] !== "";
                    return (
                      <div key={field.key} className="flex flex-col gap-1.5 sm:flex-row sm:items-center sm:gap-3">
                        <div className="flex w-full items-center gap-1.5 sm:w-[160px] sm:shrink-0">
                          <span className={`h-2 w-2 rounded-full ${matched ? "bg-green-500" : "bg-gray-300"}`} />
                          <Label className="text-sm">{field.label}</Label>
                        </div>
                        <Select value={mapping[field.key] || SKIP} onValueChange={(v) => setMapping((m) => ({ ...m, [field.key]: v }))}>
                          <SelectTrigger className={`sm:flex-1 h-9 text-sm rounded-full ${!matched ? "border-dashed text-gray-400" : ""}`}>
                            <SelectValue placeholder="— skip this field —" />
                          </SelectTrigger>
                          <SelectContent>
                            <SelectItem value={SKIP}>— skip this field —</SelectItem>
                            {csvData.headers.map((h) => (<SelectItem key={h} value={h}>{h}</SelectItem>))}
                          </SelectContent>
                        </Select>
                      </div>
                    );
                  })}
                </div>
              </div>
              <div>
                <p className="mb-2 text-xs font-semibold uppercase tracking-wide text-gray-500">
                  Preview — first {Math.min(5, csvData.rows.length)} of {csvData.rows.length} rows
                </p>
                <div className="overflow-x-auto border">
                  <table className="w-max min-w-full border-collapse text-xs">
                    <thead>
                      <tr>
                        {TARGET_FIELDS.map((f) => {
                          const col = mapping[f.key];
                          const matched = col && col !== SKIP;
                          return (
                            <th key={f.key} className={`sticky top-0 whitespace-nowrap border-b border-r px-3 py-2 text-left font-semibold ${matched ? "bg-green-50 text-green-800" : "bg-gray-100 text-gray-400"}`}>
                              {f.label}
                              {matched && <div className="font-normal text-green-600 text-xs mt-0.5">← {col}</div>}
                            </th>
                          );
                        })}
                      </tr>
                    </thead>
                    <tbody>
                      {csvData.rows.slice(0, 5).map((row, i) => (
                        <tr key={i} className="border-b hover:bg-gray-50">
                          {TARGET_FIELDS.map((f) => {
                            const col = mapping[f.key];
                            const val = col && col !== SKIP ? (row[col] ?? "") : "";
                            return (
                              <td key={f.key} className={`max-w-[180px] truncate whitespace-nowrap border-r px-3 py-2 ${val ? "" : "text-gray-300"}`} title={val}>{val || "—"}</td>
                            );
                          })}
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </div>
            </div>
          )}

          <DialogFooter className="mt-2 gap-2">
            <Button variant="outline" className="rounded-xl" onClick={() => { setShowMappingDialog(false); setCsvData(null); setShowImport(true); }} disabled={isImporting}>
              Back
            </Button>
            <Button onClick={handleConfirmImport} disabled={isImporting || !csvData} className="bg-[#001d6e] hover:bg-[#00154b] text-white rounded-xl">
              {isImporting ? (<><Loader2 className="mr-1.5 h-4 w-4 animate-spin" />Importing…</>) : (<><Upload className="mr-1.5 h-4 w-4" />Import {csvData?.rows.length ?? 0} rows</>)}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* ── Delete confirmation — replace (soft, carries forward on re-upload) vs discard
          (reverses stock, voids history, self-resolves) ─────────────────────────────────── */}
      <Dialog open={!!deleteTarget} onOpenChange={(open) => { if (!open) setDeleteTarget(null); }}>
        <DialogContent className="max-w-md">
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
