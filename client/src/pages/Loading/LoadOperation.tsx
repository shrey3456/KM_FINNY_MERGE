import { useEffect, useRef, useState } from "react";
import { useMutation, useQuery } from "@tanstack/react-query";
import {
  AlertTriangle, Camera, CheckCircle2, ChevronDown, ChevronRight, Keyboard, Link2, Loader2,
  Lock, Package, Plus, RotateCcw, ScanLine, Search, Trash2, Truck, X,
} from "lucide-react";
import type { Result } from "@zxing/library";
import BarcodeScanner from "@/lib/barcodeScanner";
import PageHeader from "@/components/PageHeader";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle,
} from "@/components/ui/dialog";
import { useToast } from "@/hooks/use-toast";
import { apiRequest, queryClient } from "@/lib/queryClient";
import { hasPageWriteAccess } from "@/lib/permissions";

// ─── Types (mirror server/routes/loading.ts responses) ───────────────────────
type ProformaSuggestion = {
  id: number; orderNumber: string; partyName: string; plant: string | null;
  orderDate: string | null; vehicleNumber: string | null;
};
type ProformaItem = {
  id: number; barcode: string | null; itemName: string | null; sapCode: string | null;
  quantity: number | null;
  // Progress fields, added by withProgress() server-side
  expected: number; loaded: number; remaining: number; itemsPerPallet: number;
  isComplete: boolean; stockAvailable: number | null;
};
type ProformaSlip = {
  id: number; orderNumber: string; partyName: string; plant: string | null;
  orderDate: string | null; totalQuantity: number | null; totalVolume: string | null;
  vehicleNumber: string | null; driverName: string | null; rtoNumber: string | null;
  loadingCompletedAt: string | null; loadingCompletedByCode: string | null;
  vehicleAssignedByCode: string | null;
};
type VehicleSuggestion = {
  id: number; vehicleNumber: string; rtoNumber: string | null; driver: string | null;
  company: string | null; manufacturer: string | null; volume: number | null;
};
type LoadingRecord = {
  id: number; orderNumber: string; partyName: string | null; plant: string | null;
  vehicleNumber: string; rtoNumber: string | null; volume: string | null;
  createdByCode: string | null; createdByName: string | null; createdAt: string;
  loadingCompletedAt: string | null;
};
type ScanResponse = { slip: ProformaSlip; items: ProformaItem[]; allComplete: boolean; event: { barcode: string; itemName: string; totalQty: number; isExtra: boolean; remaining: number } };
// One row of that order's own load-event history (the landing table's expand panel) — fetched
// from the same Scan History endpoint the Reports page's Load Event tab uses, scoped to this
// order (GET /api/scan-sessions/reports/scan-history?source=dispatch&order=X).
type LoadHistoryEvent = {
  id: number; barcode: string | null; itemName: string | null; totalQty: number;
  isExtra: boolean; voided: boolean | null; scannedByName: string | null; scannedAt: string;
};

function currentUser(): any {
  try { return JSON.parse(localStorage.getItem("currentUser") || "{}"); } catch { return {}; }
}
function isAdminOrSuper(): boolean {
  const u = currentUser();
  return u.role === "admin" || u.role === "super-admin";
}
// Mirrors the server's canCompleteLoad (server/routes/loading.ts) exactly, for a clean hide
// instead of a click-then-403 — real enforcement still happens server-side either way.
function canCompleteLoadClient(): boolean {
  const u = currentUser();
  const role = (u.role ?? "").toLowerCase().trim();
  if (["admin", "super-admin"].includes(role)) return true;
  const designation = (u.designation ?? "").toLowerCase().trim();
  return !["loader", "helper", "driver", "scanner"].includes(designation);
}

const normalize = (v?: string | number | null) => String(v ?? "").trim().toLowerCase();

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

// A LoadHistoryEvent's id is the combined-table offset id (3000000000 + loading_scan_events.id —
// see SCAN_HISTORY_COMBINED_SOURCE, server/routes/scan-sessions.ts). The void endpoint takes the
// real underlying id, same offset Scan History's own Load Event void uses.
const LOADING_EVENT_ID_OFFSET = 3000000000;

export default function LoadOperation() {
  const { toast } = useToast();
  const canWrite = hasPageWriteAccess("loading");
  const admin = isAdminOrSuper();
  const canComplete = canCompleteLoadClient();
  // Mirrors the server's requireLoadingVoidAccess (server/routes/loading.ts): admin, or write
  // access to BOTH "loading" and "scan-history" — same rule individual Void uses, since Delete
  // is exactly that applied to every event on the order at once.
  const canResetLoad = admin || (hasPageWriteAccess("loading") && hasPageWriteAccess("scan-history"));

  // Landing view is the records table; a persisted mid-flow order (see LAST_ORDER_KEY) resumes
  // straight into the create flow instead, per "remember where we were" — except for admin, who
  // always lands on the list first regardless of any remembered order (admin's job here is
  // mainly to review everyone's slips, not to be dropped back into whatever one they had open).
  const [view, setView] = useState<"list" | "create">(() => (!admin && localStorage.getItem(LAST_ORDER_KEY) ? "create" : "list"));

  // Server-paginated (20/page, matching Scan History) rather than fetching every slip anyone's
  // ever loaded in one request.
  const RECORDS_PAGE_SIZE = 20;
  const [recordsPage, setRecordsPage] = useState(1);
  const recordsOffset = (recordsPage - 1) * RECORDS_PAGE_SIZE;
  const recordsQuery = useQuery<{ records: LoadingRecord[]; total: number }>({
    queryKey: ["/api/loading/records", recordsPage],
    queryFn: async () => (await apiRequest("GET", `/api/loading/records?limit=${RECORDS_PAGE_SIZE}&offset=${recordsOffset}`)).json(),
    enabled: view === "list",
  });
  const recordsTotal = recordsQuery.data?.total ?? 0;
  const recordsItems = recordsQuery.data?.records ?? [];
  const recordsHasMore = recordsOffset + recordsItems.length < recordsTotal;

  // Whichever row's history panel is currently open — click-to-expand, same idea as the Scan
  // History page's own drill-down (only one open at a time).
  const [expandedRecordOrder, setExpandedRecordOrder] = useState<string | null>(null);
  const recordHistoryQuery = useQuery<{ items: LoadHistoryEvent[] }>({
    queryKey: ["/api/scan-sessions/reports/scan-history", "loading-panel", expandedRecordOrder],
    queryFn: async () =>
      (await apiRequest(
        "GET",
        `/api/scan-sessions/reports/scan-history?source=dispatch&order=${encodeURIComponent(expandedRecordOrder ?? "")}&limit=100`,
      )).json(),
    enabled: !!expandedRecordOrder,
  });

  // Reopen (undo Complete) and Reset (the "Delete" action — undoes everything the order's
  // loading did: reverses stock, voids the scan history, un-assigns the vehicle, removes the
  // landing-table row). Both act on whichever order the confirm dialog is currently targeting.
  const reopenMutation = useMutation({
    mutationFn: async (orderNumber: string) => {
      const res = await apiRequest("POST", `/api/loading/proforma/${encodeURIComponent(orderNumber)}/reopen`, {});
      if (!res.ok) throw new Error((await res.json().catch(() => ({})))?.message || "Reopen failed");
      return res.json();
    },
    onSuccess: () => { toast({ title: "Load reopened" }); recordsQuery.refetch(); },
    onError: (err: any) => toast({ title: "Reopen failed", description: err?.message, variant: "destructive" }),
  });

  const [resetTarget, setResetTarget] = useState<LoadingRecord | null>(null);
  const resetMutation = useMutation({
    mutationFn: async (orderNumber: string) => {
      const res = await apiRequest("POST", `/api/loading/proforma/${encodeURIComponent(orderNumber)}/reset`, {});
      if (!res.ok) throw new Error((await res.json().catch(() => ({})))?.message || "Delete failed");
      return res.json();
    },
    onSuccess: (data: any) => {
      toast({ title: "Loading slip deleted", description: `${data?.reversedEvents ?? 0} scan(s) undone and stock reversed.` });
      setResetTarget(null);
      setExpandedRecordOrder(null);
      recordsQuery.refetch();
    },
    onError: (err: any) => toast({ title: "Delete failed", description: err?.message, variant: "destructive" }),
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
      setVoidTarget(null);
      setVoidReason("");
      // Both history panels (landing table + this order's items table) read the same combined
      // endpoint under the same key prefix — one invalidation refreshes whichever is open.
      queryClient.invalidateQueries({ queryKey: ["/api/scan-sessions/reports/scan-history"] });
      // Voiding changes "loaded"/"remaining" — refresh the open order's own progress too.
      if (slip) openOrder(slip.orderNumber, { silent: true });
    },
    onError: (err: any) => toast({ title: "Void failed", description: err?.message, variant: "destructive" }),
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

  // "Items on this order" table — click a row to expand it and see that item's own scan history.
  // Fetched once for the whole order (same endpoint the Loading landing table's own expand panel
  // and Scan History's Load Event tab use) and filtered client-side per barcode when a row opens,
  // rather than one request per item.
  const [expandedItemBarcode, setExpandedItemBarcode] = useState<string | null>(null);
  const orderLoadHistoryQuery = useQuery<{ items: LoadHistoryEvent[] }>({
    queryKey: ["/api/scan-sessions/reports/scan-history", "item-panel", slip?.orderNumber],
    queryFn: async () =>
      (await apiRequest(
        "GET",
        `/api/scan-sessions/reports/scan-history?source=dispatch&order=${encodeURIComponent(slip?.orderNumber ?? "")}&limit=200`,
      )).json(),
    enabled: !!slip,
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

  const fetchSlipMutation = useMutation({
    mutationFn: async (orderNumber: string) => {
      const res = await apiRequest("GET", `/api/loading/proforma/${encodeURIComponent(orderNumber)}`);
      return res.json() as Promise<{ slip: ProformaSlip; items: ProformaItem[]; allComplete: boolean }>;
    },
    onSuccess: (data) => {
      setSlip(data.slip);
      setItems(data.items);
      setAllComplete(data.allComplete);
      setOrderFocused(false);
      localStorage.setItem(LAST_ORDER_KEY, data.slip.orderNumber);
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
      toast({ title: "Order not found", description: err?.message, variant: "destructive" });
    },
  });

  function openOrder(orderNumber: string, opts?: { silent?: boolean }) {
    if (!orderNumber.trim()) return;
    silentLookupRef.current = !!opts?.silent;
    fetchSlipMutation.mutate(orderNumber.trim());
  }

  useEffect(() => {
    if (admin) return; // admin always starts on the list — see the view initializer above
    const saved = localStorage.getItem(LAST_ORDER_KEY);
    if (saved) openOrder(saved, { silent: true });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  function resetToSearch() {
    setSlip(null);
    setItems([]);
    setAllComplete(false);
    setOrderSearch("");
    setVehicleSearch("");
    setSelectedVehicle(null);
    setExpandedItemBarcode(null);
    localStorage.removeItem(LAST_ORDER_KEY);
    setTimeout(() => orderInputRef.current?.focus(), 50);
  }

  function backToList() {
    resetToSearch();
    setView("list");
    recordsQuery.refetch();
  }

  function startNewLoad() {
    resetToSearch();
    setView("create");
  }

  function openOrderFromList(orderNumber: string) {
    setView("create");
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

  useEffect(() => {
    if (view !== "create" || scanMode !== "camera" || slip) { stopCamera(); return; }
    let cancelled = false;
    const scanner = new BarcodeScanner({
      onDetected: (result: Result) => {
        const code = result.getText();
        if (code && !cancelled) { setOrderSearch(code); openOrder(code); }
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
  }, [view, scanMode, slip]);

  useEffect(() => {
    if (view !== "create" || slip) return;
    const MAX_GAP_MS = 50;
    const BURST_END_MS = 80;
    let buffer = "";
    let lastAt = 0;
    let flushTimer: ReturnType<typeof setTimeout> | null = null;
    const handleKeyDown = (e: KeyboardEvent) => {
      const target = e.target as HTMLElement | null;
      if (target === orderInputRef.current) return;
      if (target && (target.tagName === "INPUT" || target.tagName === "TEXTAREA" || target.isContentEditable)) return;
      if (e.ctrlKey || e.metaKey || e.altKey || e.key.length !== 1) return;
      const now = Date.now();
      if (now - lastAt > MAX_GAP_MS) buffer = "";
      lastAt = now;
      buffer += e.key;
      if (flushTimer) clearTimeout(flushTimer);
      flushTimer = setTimeout(() => {
        if (buffer.length >= 3) { setScanMode("manual"); orderInputRef.current?.focus(); setOrderSearch(buffer); openOrder(buffer); }
        buffer = "";
      }, BURST_END_MS);
    };
    window.addEventListener("keydown", handleKeyDown, true);
    return () => { window.removeEventListener("keydown", handleKeyDown, true); if (flushTimer) clearTimeout(flushTimer); };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [view, slip]);

  useEffect(() => { if (view === "create" && !slip && scanMode === "manual") orderInputRef.current?.focus(); }, [view, slip, scanMode]);

  // ─── Vehicle search + link ────────────────────────────────────────────────
  const [vehicleSearch, setVehicleSearch] = useState("");
  const debouncedVehicleSearch = useDebounced(vehicleSearch, 250);
  const [vehicleFocused, setVehicleFocused] = useState(false);
  const [vehicleSuggIdx, setVehicleSuggIdx] = useState(-1);
  const [selectedVehicle, setSelectedVehicle] = useState<VehicleSuggestion | null>(null);

  const vehicleSuggestionsQuery = useQuery<{ results: VehicleSuggestion[] }>({
    queryKey: ["/api/loading/vehicles/search", debouncedVehicleSearch],
    queryFn: async () => (await apiRequest("GET", `/api/loading/vehicles/search?q=${encodeURIComponent(debouncedVehicleSearch)}`)).json(),
    enabled: !!slip && debouncedVehicleSearch.trim().length >= 1,
  });
  const vehicleSuggestions = vehicleSuggestionsQuery.data?.results ?? [];

  const linkVehicleMutation = useMutation({
    mutationFn: async (vehicleNumber: string) => {
      const res = await apiRequest("POST", `/api/loading/proforma/${encodeURIComponent(slip!.orderNumber)}/link-vehicle`, { vehicleNumber });
      return res.json() as Promise<{ slip: ProformaSlip; vehicle: VehicleSuggestion }>;
    },
    onSuccess: (data) => {
      setSlip(data.slip);
      setSelectedVehicle(null);
      setVehicleSearch("");
      toast({ title: "Vehicle linked", description: `${data.vehicle.vehicleNumber} — RTO ${data.vehicle.rtoNumber ?? "—"}` });
      queryClient.invalidateQueries({ queryKey: ["/api/loading/records"] });
    },
    onError: (err: any) => toast({ title: "Link failed", description: err?.message, variant: "destructive" }),
  });

  function pickVehicle(v: VehicleSuggestion) {
    setSelectedVehicle(v);
    setVehicleSearch(v.vehicleNumber);
    setVehicleFocused(false);
    setVehicleSuggIdx(-1);
  }

  // ─── Item scanning — same barcode-matching / pallet-loose / auto-scan rules as Order Scan ──
  const [itemScanMode, setItemScanMode] = useState<"camera" | "manual">("manual");
  const [itemBarcode, setItemBarcode] = useState("");
  const itemInputRef = useRef<HTMLInputElement>(null);
  const [itemCameraReady, setItemCameraReady] = useState(false);
  const [itemCameraError, setItemCameraError] = useState<string | null>(null);
  const itemVideoRef = useRef<HTMLVideoElement>(null);
  const itemScannerRef = useRef<BarcodeScanner | null>(null);
  const itemsRef = useRef<ProformaItem[]>(items);
  itemsRef.current = items;
  const scanLockRef = useRef(false);

  const locked = !!slip?.loadingCompletedAt;

  function stopItemCamera() {
    itemScannerRef.current?.stop();
    setItemCameraReady(false);
  }

  // Pending confirm dialog (opens for anything that isn't a clean full-pallet auto-scan).
  const [pending, setPending] = useState<{ barcode: string; item: ProformaItem | null } | null>(null);
  const [dialogQty, setDialogQty] = useState(1);
  const [dialogPalletsInput, setDialogPalletsInput] = useState("");

  // 5s non-blocking feedback after an auto-confirmed full-pallet scan — same idea as Order
  // Scan's Auto Scan popup, minus the plant-level toggle (Loading always auto-scans full
  // pallets; anything less than a full pallet still opens the confirm dialog below).
  const [autoFeedback, setAutoFeedback] = useState<{ itemName: string; qty: number; remaining: number; isExtra: boolean } | null>(null);
  const autoFeedbackTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  function showAutoFeedback(itemName: string, qty: number, remaining: number, isExtra: boolean) {
    if (autoFeedbackTimerRef.current) clearTimeout(autoFeedbackTimerRef.current);
    setAutoFeedback({ itemName, qty, remaining, isExtra });
    autoFeedbackTimerRef.current = setTimeout(() => setAutoFeedback(null), 5000);
  }

  const scanItemMutation = useMutation({
    mutationFn: async ({ barcode, qty }: { barcode: string; qty: number }) => {
      const res = await apiRequest("POST", `/api/loading/proforma/${encodeURIComponent(slip!.orderNumber)}/scan`, { barcode, qty });
      if (!res.ok) throw new Error((await res.json().catch(() => ({})))?.message || "Scan failed");
      return res.json() as Promise<ScanResponse>;
    },
    onSuccess: (data) => {
      setSlip(data.slip);
      setItems(data.items);
      setAllComplete(data.allComplete);
      if (data.allComplete && !slip?.loadingCompletedAt) {
        toast({ title: "Load complete", description: "Every item has been fully loaded — marked complete automatically." });
      }
      queryClient.invalidateQueries({ queryKey: ["/api/scan-sessions/reports/scan-history", "item-panel", data.slip.orderNumber] });
    },
    onError: (err: any) => toast({ title: "Scan failed", description: err?.message, variant: "destructive" }),
    onSettled: () => { scanLockRef.current = false; },
  });

  const completeMutation = useMutation({
    mutationFn: async () => {
      const res = await apiRequest("POST", `/api/loading/proforma/${encodeURIComponent(slip!.orderNumber)}/complete`, {});
      if (!res.ok) throw new Error((await res.json().catch(() => ({})))?.message || "Complete failed");
      return res.json() as Promise<{ slip: ProformaSlip; items: ProformaItem[]; allComplete: boolean }>;
    },
    onSuccess: (data) => {
      setSlip(data.slip);
      setItems(data.items);
      setAllComplete(data.allComplete);
      toast({ title: "Load marked complete" });
    },
    onError: (err: any) => toast({ title: "Complete failed", description: err?.message, variant: "destructive" }),
  });

  function defaultDialogQty(item: ProformaItem | null): number {
    if (!item) return 1;
    const ipp = item.itemsPerPallet || 1;
    return item.remaining > 0 && item.remaining < ipp ? item.remaining : ipp;
  }

  function openConfirmDialog(barcode: string, item: ProformaItem | null) {
    const qty = defaultDialogQty(item);
    setDialogQty(qty);
    setDialogPalletsInput(item && item.itemsPerPallet > 0 ? (qty / item.itemsPerPallet).toFixed(2) : "");
    setPending({ barcode, item });
  }

  function handleItemBarcode(rawBarcode: string) {
    const barcode = rawBarcode.trim();
    if (!barcode || !slip || locked || scanLockRef.current || pending) return;
    const item = itemsRef.current.find((i) => normalize(i.barcode) === normalize(barcode)) ?? null;

    // Not on this slip at all is still allowed through to the server (it may be a real product,
    // logged as an Extra) — but a stock-zero item on THIS slip is stopped right here, before
    // even opening the dialog, since there's nothing to load.
    if (item && (item.stockAvailable ?? 0) <= 0) {
      toast({ title: "No stock to load", description: `${item.itemName ?? barcode} has 0 stock at ${slip.plant} — cannot load it.`, variant: "destructive" });
      return;
    }

    scanLockRef.current = true;

    // Full pallet (or more) still remaining → auto-scan exactly one pallet, no dialog, 5s
    // feedback popup — same shape as Order Scan's Auto Scan path.
    const ipp = item?.itemsPerPallet ?? 0;
    const canAutoScan = !!item && item.expected > 0 && ipp >= 1 && item.remaining >= ipp && (item.stockAvailable ?? 0) >= ipp;
    if (canAutoScan) {
      const qty = ipp;
      scanItemMutation.mutate({ barcode, qty }, {
        onSuccess: (data) => showAutoFeedback(data.event.itemName, data.event.totalQty, data.event.remaining, data.event.isExtra),
      });
      setItemBarcode("");
      return;
    }

    scanLockRef.current = false;
    openConfirmDialog(barcode, item);
    setItemBarcode("");
  }

  useEffect(() => {
    if (view !== "create" || itemScanMode !== "camera" || !slip || locked) { stopItemCamera(); return; }
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
  }, [view, itemScanMode, slip, locked]);

  // Barcode gun for items — active once a slip is open and not yet complete.
  useEffect(() => {
    if (view !== "create" || !slip || locked) return;
    const MAX_GAP_MS = 50;
    const BURST_END_MS = 80;
    let buffer = "";
    let lastAt = 0;
    let flushTimer: ReturnType<typeof setTimeout> | null = null;
    const handleKeyDown = (e: KeyboardEvent) => {
      const target = e.target as HTMLElement | null;
      if (target === itemInputRef.current) return;
      if (target && (target.tagName === "INPUT" || target.tagName === "TEXTAREA" || target.isContentEditable)) return;
      if (e.ctrlKey || e.metaKey || e.altKey || e.key.length !== 1) return;
      const now = Date.now();
      if (now - lastAt > MAX_GAP_MS) buffer = "";
      lastAt = now;
      buffer += e.key;
      if (flushTimer) clearTimeout(flushTimer);
      flushTimer = setTimeout(() => {
        if (buffer.length >= 3) { setItemScanMode("manual"); itemInputRef.current?.focus(); handleItemBarcode(buffer); }
        buffer = "";
      }, BURST_END_MS);
    };
    window.addEventListener("keydown", handleKeyDown, true);
    return () => { window.removeEventListener("keydown", handleKeyDown, true); if (flushTimer) clearTimeout(flushTimer); };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [view, slip, locked]);

  // Once a vehicle is assigned, only whoever assigned it (or admin) can change it — everyone
  // else with write access to Loading still sees it, just without the edit controls. The
  // FIRST assignment (no vehicle yet) stays open to anyone with write access. Server-enforced
  // too (see /link-vehicle in server/routes/loading.ts) — this is just the matching UI gate.
  const canEditVehicle = !slip?.vehicleNumber || admin || (!!slip?.vehicleAssignedByCode && slip.vehicleAssignedByCode === currentUser()?.userCode);

  return (
    <div className="flex-1 overflow-y-auto p-4 lg:p-6">
      <div className="mx-auto w-full max-w-[1800px] space-y-4">
        <PageHeader
          icon={Package}
          title="Loading"
          description="Scan or search a proforma slip, then link a vehicle and scan its items onto it."
        />

        {/* ── Landing view: this user's (or, for admin, everyone's) loading history ────── */}
        {view === "list" && (
          <div className="rounded-xl border border-gray-200 bg-white shadow-sm overflow-hidden">
            <div className="flex items-center justify-between gap-2 px-4 sm:px-5 py-3.5 border-b border-gray-100">
              <div>
                <div className="text-lg font-bold text-[#001d6e]">{admin ? "All Loading Slips" : "Your Loading Slips"}</div>
                <div className="text-xs text-gray-400">{recordsTotal} slip(s){admin ? " · every user" : ""}</div>
              </div>
              {canWrite && (
                <Button className="h-9 bg-[#001d6e] text-white hover:bg-[#001552]" onClick={startNewLoad}>
                  <Plus className="mr-1.5 h-4 w-4" /> Load New Slip
                </Button>
              )}
            </div>

            {recordsQuery.isLoading ? (
              <div className="flex items-center justify-center py-16"><Loader2 className="h-6 w-6 animate-spin text-[#001d6e]" /></div>
            ) : recordsItems.length === 0 ? (
              <div className="flex flex-col items-center justify-center py-16 text-center">
                <div className="mb-3 flex h-14 w-14 items-center justify-center rounded-full bg-[#001d6e]/10">
                  <Truck className="h-7 w-7 text-[#001d6e]/40" />
                </div>
                <div className="mb-1 text-sm font-semibold text-[#001d6e]">No loading slips yet</div>
                <p className="mb-4 max-w-xs text-xs text-muted-foreground">{canWrite ? "Start a new load to scan a proforma slip and link it to a vehicle." : "Nothing has been loaded yet."}</p>
              </div>
            ) : (
              <div className="overflow-x-auto">
                <table className="w-full min-w-full caption-bottom border-collapse text-xs">
                  <thead>
                    <tr className="bg-[#001d6e]">
                      <th className="w-8 border-r border-[#1a3a9c] px-2 py-2.5"></th>
                      <th className="w-12 whitespace-nowrap border-r border-[#1a3a9c] px-3 py-2.5 text-left text-[11px] font-semibold tracking-wide uppercase text-white">Sr. No</th>
                      <th className="whitespace-nowrap border-r border-[#1a3a9c] px-3 py-2.5 text-left text-[11px] font-semibold tracking-wide uppercase text-white">Order No.</th>
                      <th className="whitespace-nowrap border-r border-[#1a3a9c] px-3 py-2.5 text-left text-[11px] font-semibold tracking-wide uppercase text-white">Party</th>
                      <th className="whitespace-nowrap border-r border-[#1a3a9c] px-3 py-2.5 text-left text-[11px] font-semibold tracking-wide uppercase text-white">Plant</th>
                      <th className="whitespace-nowrap border-r border-[#1a3a9c] px-3 py-2.5 text-left text-[11px] font-semibold tracking-wide uppercase text-white">Vehicle</th>
                      <th className="whitespace-nowrap border-r border-[#1a3a9c] px-3 py-2.5 text-left text-[11px] font-semibold tracking-wide uppercase text-white">RTO No.</th>
                      <th className="whitespace-nowrap border-r border-[#1a3a9c] px-3 py-2.5 text-left text-[11px] font-semibold tracking-wide uppercase text-white">Status</th>
                      {admin && <th className="whitespace-nowrap border-r border-[#1a3a9c] px-3 py-2.5 text-left text-[11px] font-semibold tracking-wide uppercase text-white">Created By</th>}
                      <th className="whitespace-nowrap border-r border-[#1a3a9c] px-3 py-2.5 text-left text-[11px] font-semibold tracking-wide uppercase text-white">Created At</th>
                      <th className="whitespace-nowrap px-3 py-2.5 text-right text-[11px] font-semibold tracking-wide uppercase text-white">Actions</th>
                    </tr>
                  </thead>
                  <tbody>
                    {recordsItems.map((r, i) => {
                      const isExpanded = expandedRecordOrder === r.orderNumber;
                      const colCount = admin ? 11 : 10;
                      return (
                        <>
                          <tr
                            key={r.id}
                            onClick={() => openOrderFromList(r.orderNumber)}
                            className={`cursor-pointer transition-colors hover:bg-[#001d6e]/[0.06] ${isExpanded ? "bg-[#001d6e]/[0.04]" : i % 2 !== 0 ? "bg-slate-50" : "bg-white"}`}
                          >
                            <td className="border-r border-b border-gray-200 px-2 py-2 text-center">
                              <button
                                type="button"
                                onClick={(e) => { e.stopPropagation(); setExpandedRecordOrder((cur) => (cur === r.orderNumber ? null : r.orderNumber)); }}
                                className="rounded p-0.5 text-gray-400 hover:bg-gray-100 hover:text-[#001d6e]"
                                title="View scan history"
                              >
                                <ChevronDown className={`h-3.5 w-3.5 transition-transform ${isExpanded ? "rotate-180 text-[#001d6e]" : ""}`} />
                              </button>
                            </td>
                            <td className="border-r border-b border-gray-200 px-3 py-2 text-gray-400 tabular-nums">{recordsOffset + i + 1}</td>
                            <td className="border-r border-b border-gray-200 px-3 py-2 font-semibold text-[#001d6e]">#{r.orderNumber}</td>
                            <td className="border-r border-b border-gray-200 px-3 py-2 text-gray-700">{r.partyName ?? "—"}</td>
                            <td className="border-r border-b border-gray-200 px-3 py-2 text-gray-700">{r.plant ?? "—"}</td>
                            <td className="border-r border-b border-gray-200 px-3 py-2 text-gray-700">{r.vehicleNumber}</td>
                            <td className="border-r border-b border-gray-200 px-3 py-2 text-gray-700">{r.rtoNumber ?? "—"}</td>
                            <td className="border-r border-b border-gray-200 px-3 py-2">
                              {r.loadingCompletedAt ? (
                                <span className="rounded-full bg-emerald-100 px-2 py-0.5 text-[10px] font-bold text-emerald-700">Complete</span>
                              ) : (
                                <span className="rounded-full bg-blue-100 px-2 py-0.5 text-[10px] font-bold text-blue-700">In Progress</span>
                              )}
                            </td>
                            {admin && <td className="border-r border-b border-gray-200 px-3 py-2 text-gray-700">{r.createdByName ?? r.createdByCode ?? "—"}</td>}
                            <td className="border-r border-b border-gray-200 px-3 py-2 text-gray-500 whitespace-nowrap">{new Date(r.createdAt).toLocaleString("en-IN", { timeZone: "Asia/Kolkata" })}</td>
                            <td className="border-b border-gray-200 px-3 py-2 text-right" onClick={(e) => e.stopPropagation()}>
                              <div className="flex items-center justify-end gap-1">
                                {r.loadingCompletedAt && canComplete && canWrite && (
                                  <Button
                                    size="sm" variant="ghost"
                                    className="h-7 px-2 text-[11px] text-amber-600 hover:bg-amber-50 hover:text-amber-700"
                                    disabled={reopenMutation.isPending}
                                    onClick={() => reopenMutation.mutate(r.orderNumber)}
                                    title="Reopen this load"
                                  >
                                    <RotateCcw className="mr-1 h-3 w-3" /> Reopen
                                  </Button>
                                )}
                                {canResetLoad && (
                                  <Button
                                    size="sm" variant="ghost"
                                    className="h-7 w-7 p-0 text-gray-400 hover:bg-red-50 hover:text-red-600"
                                    onClick={() => setResetTarget(r)}
                                    title="Delete this loading slip"
                                  >
                                    <Trash2 className="h-3.5 w-3.5" />
                                  </Button>
                                )}
                              </div>
                            </td>
                          </tr>
                          {isExpanded && (
                            <tr key={`${r.id}-history`}>
                              <td colSpan={colCount} className="border-b border-gray-200 bg-gray-50 p-3">
                                {recordHistoryQuery.isLoading ? (
                                  <div className="flex justify-center py-6"><Loader2 className="h-5 w-5 animate-spin text-[#001d6e]" /></div>
                                ) : (recordHistoryQuery.data?.items.length ?? 0) === 0 ? (
                                  <p className="py-4 text-center text-xs text-gray-400">No scan history for this order yet.</p>
                                ) : (
                                  <div className="max-h-72 overflow-y-auto overflow-x-auto border border-gray-200 bg-white">
                                    <table className="w-full min-w-[640px] table-fixed border-collapse text-xs">
                                      <thead>
                                        <tr className="sticky top-0 z-10 border-b-2 border-gray-300 bg-gray-100 text-left text-gray-600">
                                          <th className="w-32 border-r border-gray-200 px-2 py-2 font-semibold">SKU</th>
                                          <th className="border-r border-gray-200 px-2 py-2 font-semibold">Item</th>
                                          <th className="w-[168px] border-r border-gray-200 px-2 py-2 font-semibold">Date &amp; Time</th>
                                          <th className="w-28 border-r border-gray-200 px-2 py-2 font-semibold">Scanned By</th>
                                          <th className="w-16 border-r border-gray-200 px-2 py-2 text-right font-semibold">Qty</th>
                                          <th className="w-20 border-r border-gray-200 px-2 py-2 font-semibold">Status</th>
                                          {canResetLoad && <th className="w-14 px-2 py-2 text-right font-semibold">Void</th>}
                                        </tr>
                                      </thead>
                                      <tbody>
                                        {recordHistoryQuery.data!.items.map((ev, idx) => (
                                          <tr key={ev.id} className={`border-b border-gray-100 ${ev.voided ? "opacity-60" : "hover:bg-gray-50"} ${idx % 2 !== 0 ? "bg-slate-50" : "bg-white"}`}>
                                            <td className="truncate border-r border-gray-100 px-2 py-2 font-mono text-gray-500">{ev.barcode ?? "—"}</td>
                                            <td className="truncate border-r border-gray-100 px-2 py-2 text-gray-800">{ev.itemName ?? "—"}</td>
                                            <td className="whitespace-nowrap border-r border-gray-100 px-2 py-2 text-gray-600">{new Date(ev.scannedAt).toLocaleString("en-IN", { timeZone: "Asia/Kolkata" })}</td>
                                            <td className="truncate border-r border-gray-100 px-2 py-2 text-gray-600">{ev.scannedByName ?? "—"}</td>
                                            <td className="border-r border-gray-100 px-2 py-2 text-right">
                                              <span className={`inline-flex items-center justify-center rounded-full px-2 py-0.5 text-[11px] font-bold ${ev.isExtra ? "bg-amber-100 text-amber-700" : "bg-[#001d6e]/10 text-[#001d6e]"}`}>
                                                {ev.isExtra ? "+" : ""}{ev.totalQty}
                                              </span>
                                            </td>
                                            <td className="truncate border-r border-gray-100 px-2 py-2 text-[11px]">
                                              {ev.voided ? (
                                                <span className="font-medium text-red-500">Voided</span>
                                              ) : ev.isExtra ? (
                                                <span className="font-semibold uppercase text-amber-700">Extra</span>
                                              ) : (
                                                <span className="text-gray-400">—</span>
                                              )}
                                            </td>
                                            {canResetLoad && (
                                              <td className="px-2 py-2 text-right">
                                                {!ev.voided && (
                                                  <Button size="sm" variant="ghost" className="h-6 w-6 p-0 text-gray-400 hover:bg-red-50 hover:text-red-600"
                                                    onClick={() => setVoidTarget(ev)} title="Void this scan">
                                                    <Trash2 className="h-3.5 w-3.5" />
                                                  </Button>
                                                )}
                                              </td>
                                            )}
                                          </tr>
                                        ))}
                                      </tbody>
                                    </table>
                                  </div>
                                )}
                              </td>
                            </tr>
                          )}
                        </>
                      );
                    })}
                  </tbody>
                </table>
              </div>
            )}

            {!recordsQuery.isLoading && recordsItems.length > 0 && (
              <div className="flex items-center justify-between border-t border-gray-100 px-4 sm:px-5 py-3 text-xs text-gray-500">
                <span>
                  {recordsTotal > 0
                    ? `Showing ${recordsOffset + 1}–${Math.min(recordsOffset + recordsItems.length, recordsTotal)} of ${recordsTotal.toLocaleString()} slips`
                    : "No slips"}
                </span>
                <div className="flex gap-2">
                  <Button variant="outline" size="sm" className="rounded-xl" disabled={recordsPage <= 1}
                    onClick={() => setRecordsPage((p) => Math.max(1, p - 1))}>Prev</Button>
                  <Button variant="outline" size="sm" className="rounded-xl" disabled={!recordsHasMore}
                    onClick={() => setRecordsPage((p) => p + 1)}>Next</Button>
                </div>
              </div>
            )}
          </div>
        )}

        {/* ── Stage A: find the order ─────────────────────────────────────── */}
        {view === "create" && !slip && (
          // No overflow-hidden — same reason as the vehicle-search card below (Stage B): the
          // order-search suggestions dropdown is absolutely positioned and needs to render past
          // this card's bottom edge, not get clipped by it. Safe here with no rounding
          // compensation needed — everything inside is already inset by padding, nothing
          // touches the card's own edge directly.
          <div className="mx-auto max-w-xl rounded-xl border border-gray-200 bg-white shadow-sm">
            <div className="px-4 sm:px-5 py-4 sm:py-5 space-y-3">
              <div className="flex items-center justify-between">
                <span className="text-sm font-semibold text-gray-500">New Load</span>
                <Button size="sm" variant="ghost" onClick={backToList} className="h-7 text-gray-500 hover:text-gray-700">
                  <X className="mr-1 h-3.5 w-3.5" /> Cancel
                </Button>
              </div>
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
                    autoFocus
                    value={orderSearch}
                    onChange={(e) => { setOrderSearch(e.target.value); setOrderSuggIdx(-1); }}
                    onFocus={() => setOrderFocused(true)}
                    onBlur={() => setTimeout(() => setOrderFocused(false), 150)}
                    onKeyDown={(e) => {
                      if (orderFocused && orderSuggestions.length > 0) {
                        if (e.key === "ArrowDown") { e.preventDefault(); setOrderSuggIdx((i) => Math.min(i + 1, orderSuggestions.length - 1)); return; }
                        if (e.key === "ArrowUp") { e.preventDefault(); setOrderSuggIdx((i) => Math.max(i - 1, -1)); return; }
                        if (e.key === "Escape") { setOrderFocused(false); return; }
                        if (e.key === "Enter" && orderSuggIdx >= 0) { e.preventDefault(); openOrder(orderSuggestions[orderSuggIdx].orderNumber); return; }
                      }
                      if (e.key === "Enter") openOrder(orderSearch);
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
                        <div className="flex items-center justify-center py-4"><Loader2 className="h-4 w-4 animate-spin text-[#001d6e]" /></div>
                      ) : orderSuggestions.length === 0 ? (
                        <p className="px-4 py-3 text-xs text-gray-400">No matching orders.</p>
                      ) : (
                        orderSuggestions.map((s, i) => (
                          <button
                            key={s.id}
                            onMouseDown={(e) => e.preventDefault()}
                            onClick={() => openOrder(s.orderNumber)}
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
                onClick={() => openOrder(orderSearch)}>
                {fetchSlipMutation.isPending ? <Loader2 className="mr-1.5 h-4 w-4 animate-spin" /> : null}
                Find Order
              </Button>
            </div>
          </div>
        )}

        {/* ── Stage B: order found — responsive 2-column layout on wide screens ──── */}
        {view === "create" && slip && (
          <div className="grid grid-cols-1 lg:grid-cols-[380px_1fr] gap-4 items-start">
            {/* Left: slip summary + vehicle link */}
            <div className="space-y-4">
              {/* No overflow-hidden here — the vehicle-search dropdown below is absolutely
                  positioned and needs to be able to render past this card's edge; clipping it
                  made the suggestions invisible even though the search itself worked fine.
                  rounded-t-xl on the header strip below keeps the top corners clean without it. */}
              <div className="rounded-xl border border-gray-200 bg-white shadow-sm">
                <div className="flex items-center justify-between gap-2 px-4 sm:px-5 py-3.5 border-b border-gray-100 bg-[#001d6e]/5 rounded-t-xl">
                  <div className="min-w-0">
                    <div className="text-lg font-bold text-[#001d6e] truncate">#{slip.orderNumber}</div>
                    <div className="text-xs text-gray-500 truncate">
                      {slip.partyName}{slip.plant ? ` · ${slip.plant}` : ""}
                      {slip.orderDate ? ` · ${new Date(slip.orderDate).toLocaleDateString("en-IN")}` : ""}
                    </div>
                  </div>
                  <div className="flex shrink-0 items-center gap-1">
                    <Button size="sm" variant="ghost" onClick={resetToSearch} className="text-gray-500 hover:text-gray-700">
                      <RotateCcw className="mr-1.5 h-3.5 w-3.5" /> New
                    </Button>
                    <Button size="sm" variant="ghost" onClick={backToList} className="text-gray-500 hover:text-gray-700">
                      Back to List
                    </Button>
                  </div>
                </div>

                {locked && (
                  <div className="flex items-center gap-2.5 px-4 sm:px-5 py-3 bg-[#001d6e]/5 border-b border-gray-100">
                    <Lock className="h-4 w-4 shrink-0 text-[#001d6e]" />
                    <div className="text-sm text-[#001d6e]">
                      Load completed {slip.loadingCompletedAt ? new Date(slip.loadingCompletedAt).toLocaleString("en-IN", { timeZone: "Asia/Kolkata" }) : ""}
                    </div>
                  </div>
                )}

                <div className="grid grid-cols-3 divide-x divide-gray-100 border-b border-gray-100 text-center">
                  <div className="px-2 py-3">
                    <div className="text-lg font-extrabold text-gray-900">{items.length}</div>
                    <div className="text-[10px] font-medium text-gray-500 mt-0.5">Items</div>
                  </div>
                  <div className="px-2 py-3">
                    <div className="text-lg font-extrabold text-gray-900">{slip.totalQuantity ?? "-"}</div>
                    <div className="text-[10px] font-medium text-gray-500 mt-0.5">Total Qty</div>
                  </div>
                  <div className="px-2 py-3">
                    <div className="text-lg font-extrabold text-gray-900">{slip.totalVolume ?? "-"}</div>
                    <div className="text-[10px] font-medium text-gray-500 mt-0.5">Volume</div>
                  </div>
                </div>

                {slip.vehicleNumber && (
                  <div className="flex items-center gap-2.5 px-4 sm:px-5 py-3 bg-emerald-50 border-b border-emerald-100">
                    <CheckCircle2 className="h-4 w-4 shrink-0 text-emerald-600" />
                    <div className="text-sm text-emerald-800">
                      <span className="font-semibold">{slip.vehicleNumber}</span> linked
                      {slip.rtoNumber ? <> — RTO <span className="font-semibold">{slip.rtoNumber}</span></> : null}
                      {!canEditVehicle && (
                        <div className="mt-0.5 text-xs text-emerald-700/70">Assigned by another user — you can view this but can't change it.</div>
                      )}
                    </div>
                  </div>
                )}

                {canWrite && !locked && canEditVehicle && (
                  <div className="px-4 sm:px-5 py-4">
                    <label className="mb-1.5 flex items-center gap-1.5 text-xs font-semibold uppercase tracking-wide text-gray-500">
                      <Truck className="h-3.5 w-3.5" /> {slip.vehicleNumber ? "Change vehicle" : "Link a vehicle"}
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
                            <div className="flex items-center justify-center py-4"><Loader2 className="h-4 w-4 animate-spin text-[#001d6e]" /></div>
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
                                  <div className="text-sm font-semibold text-[#001d6e] truncate">{v.vehicleNumber}</div>
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
                          onClick={() => linkVehicleMutation.mutate(selectedVehicle.vehicleNumber)}>
                          {linkVehicleMutation.isPending ? <Loader2 className="mr-1.5 h-3.5 w-3.5 animate-spin" /> : <Link2 className="mr-1.5 h-3.5 w-3.5" />}
                          Link
                        </Button>
                      </div>
                    )}
                  </div>
                )}
              </div>

              {/* Scan items — hidden once locked; same Camera/Manual pattern as order search */}
              {canWrite && !locked && (
                <div className="rounded-xl border border-gray-200 bg-white shadow-sm overflow-hidden">
                  <div className="flex items-center gap-2 px-4 sm:px-5 py-3.5 border-b border-gray-100">
                    <ScanLine className="h-4 w-4 text-[#001d6e]" />
                    <span className="text-sm font-semibold text-gray-900">Scan Items</span>
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
                          ref={itemInputRef}
                          autoFocus
                          value={itemBarcode}
                          onChange={(e) => setItemBarcode(e.target.value)}
                          onKeyDown={(e) => { if (e.key === "Enter") handleItemBarcode(itemBarcode); }}
                          placeholder="Scan or type an item barcode…"
                          className="h-10 pl-9 text-sm"
                        />
                      </div>
                    )}

                    {/* 5s auto-scan feedback — non-blocking, replaced by the next auto-scan */}
                    {autoFeedback && (
                      <div className={`flex items-center gap-2 rounded-lg px-3 py-2 text-xs ${autoFeedback.isExtra ? "bg-amber-50 text-amber-800" : "bg-emerald-50 text-emerald-800"}`}>
                        <CheckCircle2 className="h-4 w-4 shrink-0" />
                        <div>
                          <span className="font-semibold">{autoFeedback.itemName}</span> +{autoFeedback.qty}{autoFeedback.isExtra ? " (extra)" : ""} · {autoFeedback.remaining} remaining
                        </div>
                      </div>
                    )}
                  </div>
                </div>
              )}

              {canComplete && !locked && (
                <Button
                  className="w-full h-10 bg-emerald-600 text-white hover:bg-emerald-700"
                  disabled={completeMutation.isPending}
                  onClick={() => completeMutation.mutate()}
                >
                  {completeMutation.isPending ? <Loader2 className="mr-1.5 h-4 w-4 animate-spin" /> : <CheckCircle2 className="mr-1.5 h-4 w-4" />}
                  {allComplete ? "Complete Load" : "Complete Load (items still short)"}
                </Button>
              )}
            </div>

            {/* Right: items table with live load progress */}
            <div className="rounded-xl border border-gray-200 bg-white shadow-sm overflow-hidden">
              <div className="flex items-center gap-2 px-4 sm:px-5 py-3.5 border-b border-gray-100">
                <Package className="h-4 w-4 text-[#001d6e]" />
                <span className="text-sm font-semibold text-gray-900">Items on this order</span>
                <span className="text-xs text-gray-400">({items.length})</span>
                {allComplete && <span className="ml-auto rounded-full bg-emerald-100 px-2 py-0.5 text-[10px] font-bold text-emerald-700">ALL LOADED</span>}
              </div>
              <div className="overflow-x-auto overflow-y-auto max-h-[65vh]">
                <table className="w-full min-w-full caption-bottom border-collapse text-xs">
                  <thead>
                    <tr className="bg-[#001d6e]">
                      <th className="sticky top-0 z-10 w-8 bg-[#001d6e] border-r border-[#1a3a9c] px-2 py-2.5"></th>
                      <th className="sticky top-0 z-10 bg-[#001d6e] whitespace-nowrap border-r border-[#1a3a9c] px-3 py-2.5 text-left text-[11px] font-semibold tracking-wide uppercase text-white">SKU</th>
                      <th className="sticky top-0 z-10 bg-[#001d6e] whitespace-nowrap border-r border-[#1a3a9c] px-3 py-2.5 text-left text-[11px] font-semibold tracking-wide uppercase text-white">Item Name</th>
                      <th className="sticky top-0 z-10 bg-[#001d6e] whitespace-nowrap border-r border-[#1a3a9c] px-3 py-2.5 text-right text-[11px] font-semibold tracking-wide uppercase text-white">Expected</th>
                      <th className="sticky top-0 z-10 bg-[#001d6e] whitespace-nowrap border-r border-[#1a3a9c] px-3 py-2.5 text-right text-[11px] font-semibold tracking-wide uppercase text-white">Loaded</th>
                      <th className="sticky top-0 z-10 bg-[#001d6e] whitespace-nowrap border-r border-[#1a3a9c] px-3 py-2.5 text-right text-[11px] font-semibold tracking-wide uppercase text-white">Remaining</th>
                      <th className="sticky top-0 z-10 bg-[#001d6e] whitespace-nowrap px-3 py-2.5 text-right text-[11px] font-semibold tracking-wide uppercase text-white">Stock</th>
                    </tr>
                  </thead>
                  <tbody>
                    {items.length === 0 ? (
                      <tr><td colSpan={7} className="h-24 text-center text-sm text-muted-foreground">No items on this slip.</td></tr>
                    ) : (
                      items.map((it, i) => {
                        const outOfStock = (it.stockAvailable ?? 0) <= 0;
                        const isExpanded = !!it.barcode && expandedItemBarcode === it.barcode;
                        const itemEvents = (orderLoadHistoryQuery.data?.items ?? []).filter((ev) => normalize(ev.barcode) === normalize(it.barcode));
                        return (
                          <>
                            <tr
                              key={it.id}
                              onClick={() => it.barcode && setExpandedItemBarcode((cur) => (cur === it.barcode ? null : it.barcode))}
                              className={`transition-colors ${it.barcode ? "cursor-pointer hover:bg-[#001d6e]/[0.04]" : ""} ${isExpanded ? "bg-[#001d6e]/[0.04]" : it.isComplete ? "bg-emerald-50/50" : i % 2 !== 0 ? "bg-slate-50" : "bg-white"}`}
                            >
                              <td className="border-r border-b border-gray-200 px-2 py-2 text-center">
                                {it.barcode && (
                                  <ChevronDown className={`mx-auto h-3.5 w-3.5 text-gray-400 transition-transform ${isExpanded ? "rotate-180 text-[#001d6e]" : ""}`} />
                                )}
                              </td>
                              <td className="border-r border-b border-gray-200 px-3 py-2 text-gray-500">{it.barcode || "—"}</td>
                              <td className="border-r border-b border-gray-200 px-3 py-2 text-gray-700">
                                {it.itemName ?? "—"}
                                {outOfStock && <span className="ml-1.5 rounded-full bg-red-100 px-1.5 py-0.5 text-[9px] font-bold text-red-700">NO STOCK</span>}
                                {it.isComplete && <CheckCircle2 className="ml-1.5 inline h-3.5 w-3.5 text-emerald-600" />}
                              </td>
                              <td className="border-r border-b border-gray-200 px-3 py-2 text-right text-gray-700">{it.expected}</td>
                              <td className="border-r border-b border-gray-200 px-3 py-2 text-right font-medium text-gray-900">{it.loaded}</td>
                              <td className="border-r border-b border-gray-200 px-3 py-2 text-right text-gray-700">{it.remaining}</td>
                              <td className={`border-b border-gray-200 px-3 py-2 text-right ${outOfStock ? "font-semibold text-red-600" : "text-gray-500"}`}>{it.stockAvailable ?? "—"}</td>
                            </tr>
                            {isExpanded && (
                              <tr key={`${it.id}-history`}>
                                <td colSpan={7} className="border-b border-gray-200 bg-gray-50 p-3">
                                  {orderLoadHistoryQuery.isLoading ? (
                                    <div className="flex justify-center py-6"><Loader2 className="h-5 w-5 animate-spin text-[#001d6e]" /></div>
                                  ) : itemEvents.length === 0 ? (
                                    <p className="py-4 text-center text-xs text-gray-400">No scan history for this item yet.</p>
                                  ) : (
                                    <div className="max-h-60 overflow-y-auto overflow-x-auto border border-gray-200 bg-white">
                                      <table className="w-full min-w-[520px] table-fixed border-collapse text-xs">
                                        <thead>
                                          <tr className="sticky top-0 z-10 border-b-2 border-gray-300 bg-gray-100 text-left text-gray-600">
                                            <th className="w-[170px] border-r border-gray-200 px-2 py-2 font-semibold">Date &amp; Time</th>
                                            <th className="border-r border-gray-200 px-2 py-2 font-semibold">Scanned By</th>
                                            <th className="w-16 border-r border-gray-200 px-2 py-2 text-right font-semibold">Qty</th>
                                            <th className="w-20 border-r border-gray-200 px-2 py-2 font-semibold">Status</th>
                                            {canResetLoad && <th className="w-14 px-2 py-2 text-right font-semibold">Void</th>}
                                          </tr>
                                        </thead>
                                        <tbody>
                                          {itemEvents.map((ev, idx) => (
                                            <tr key={ev.id} className={`border-b border-gray-100 ${ev.voided ? "opacity-60" : "hover:bg-gray-50"} ${idx % 2 !== 0 ? "bg-slate-50" : "bg-white"}`}>
                                              <td className="whitespace-nowrap border-r border-gray-100 px-2 py-2 text-gray-600">{new Date(ev.scannedAt).toLocaleString("en-IN", { timeZone: "Asia/Kolkata" })}</td>
                                              <td className="truncate border-r border-gray-100 px-2 py-2 text-gray-600">{ev.scannedByName ?? "—"}</td>
                                              <td className="border-r border-gray-100 px-2 py-2 text-right">
                                                <span className={`inline-flex items-center justify-center rounded-full px-2 py-0.5 text-[11px] font-bold ${ev.isExtra ? "bg-amber-100 text-amber-700" : "bg-[#001d6e]/10 text-[#001d6e]"}`}>
                                                  {ev.isExtra ? "+" : ""}{ev.totalQty}
                                                </span>
                                              </td>
                                              <td className="truncate border-r border-gray-100 px-2 py-2 text-[11px]">
                                                {ev.voided ? (
                                                  <span className="font-medium text-red-500">Voided</span>
                                                ) : ev.isExtra ? (
                                                  <span className="font-semibold uppercase text-amber-700">Extra</span>
                                                ) : (
                                                  <span className="text-gray-400">—</span>
                                                )}
                                              </td>
                                              {canResetLoad && (
                                                <td className="px-2 py-2 text-right">
                                                  {!ev.voided && (
                                                    <Button size="sm" variant="ghost" className="h-6 w-6 p-0 text-gray-400 hover:bg-red-50 hover:text-red-600"
                                                      onClick={() => setVoidTarget(ev)} title="Void this scan">
                                                      <Trash2 className="h-3.5 w-3.5" />
                                                    </Button>
                                                  )}
                                                </td>
                                              )}
                                            </tr>
                                          ))}
                                        </tbody>
                                      </table>
                                    </div>
                                  )}
                                </td>
                              </tr>
                            )}
                          </>
                        );
                      })
                    )}
                  </tbody>
                </table>
              </div>
            </div>
          </div>
        )}
      </div>

      {/* Confirm dialog — loose/partial/extra scans, and anything not on this slip at all */}
      <Dialog open={!!pending} onOpenChange={(open) => { if (!open) setPending(null); }}>
        <DialogContent className="max-w-sm">
          <DialogHeader>
            <DialogTitle>{pending?.item?.itemName ?? pending?.barcode ?? "Confirm scan"}</DialogTitle>
            <DialogDescription>
              {pending?.item
                ? `Expected ${pending.item.expected} · Loaded ${pending.item.loaded} · Remaining ${pending.item.remaining}`
                : "Not on this order — will be logged as an extra."}
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
            {pending && (pending.item?.stockAvailable ?? Infinity) < dialogQty && (
              <p className="text-xs text-red-600">Only {pending.item?.stockAvailable} in stock — reduce the quantity.</p>
            )}
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setPending(null)}>Cancel</Button>
            <Button
              className="bg-[#001d6e] text-white hover:bg-[#001552]"
              disabled={dialogQty <= 0 || scanItemMutation.isPending || (pending?.item?.stockAvailable ?? Infinity) < dialogQty}
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
        </DialogContent>
      </Dialog>

      {/* Delete confirmation — reverses everything this slip's loading did: stock added back,
          scan history voided (kept for audit, same as individual Void), vehicle un-assigned,
          the row itself removed from this table. Cannot be undone from here. */}
      <Dialog open={!!resetTarget} onOpenChange={(o) => { if (!o) setResetTarget(null); }}>
        <DialogContent className="max-w-sm">
          <DialogHeader>
            <DialogTitle className="text-red-600">Delete this loading slip?</DialogTitle>
            <DialogDescription>
              Order <span className="font-semibold text-gray-900">#{resetTarget?.orderNumber}</span> — this reverses every item scanned onto{" "}
              <span className="font-semibold text-gray-900">{resetTarget?.vehicleNumber}</span> (stock is added back), un-assigns the vehicle, and
              clears the completed status. The scan history stays visible in Scan History marked Voided, but this row disappears from this table.
              This cannot be undone from here.
            </DialogDescription>
          </DialogHeader>
          <DialogFooter className="gap-2">
            <Button variant="outline" onClick={() => setResetTarget(null)} disabled={resetMutation.isPending}>
              Cancel
            </Button>
            <Button
              className="bg-red-600 text-white hover:bg-red-700"
              disabled={resetMutation.isPending}
              onClick={() => { if (resetTarget) resetMutation.mutate(resetTarget.orderNumber); }}
            >
              {resetMutation.isPending ? <Loader2 className="mr-1.5 h-3.5 w-3.5 animate-spin" /> : null}
              Delete Slip
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Void confirmation — a single scan event, same rule/effect as Scan History's own Void:
          stock reversed, kept in history marked Voided (never deleted). */}
      <Dialog open={!!voidTarget} onOpenChange={(o) => { if (!o) { setVoidTarget(null); setVoidReason(""); } }}>
        <DialogContent className="max-w-sm">
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
    </div>
  );
}
