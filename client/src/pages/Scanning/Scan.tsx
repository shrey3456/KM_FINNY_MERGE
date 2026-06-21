import { useEffect, useMemo, useRef, useState } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import {
  AlertTriangle,
  ArrowLeft,
  Camera,
  CheckCircle2,
  ChevronLeft,
  ChevronRight,
  FileSpreadsheet,
  History,
  Keyboard,
  Loader2,
  PackageCheck,
  Layers,
  Pencil,
  Play,
  Plus,
  RotateCcw,
  ScanLine,
  Search,
  Square,
  User,
  X,  
  Zap,
} from "lucide-react";
import { Result } from "@zxing/library";
import BarcodeScanner from "@/lib/barcodeScanner";
import CameraPermissionBanner from "@/components/CameraPermissionBanner";
import { apiRequest } from "@/lib/queryClient";
import { useToast } from "@/hooks/use-toast";
import { useUser } from "@/hooks/use-user";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Progress } from "@/components/ui/progress";
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
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";

// ─── Types ─────────────────────────────────────────────────────────────────

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

type OrderItem = {
  id: number;          // DB id from scan_session_items
  sku: string;
  itemName: string;
  expectedQty: number;
  scannedQty: number;
  productId?: number;
  barcode?: string;
  itemNo?: string | null;
  sapCode?: string | null;
  inventoryQty?: number | null;
};

type ExtraScan = {
  id: number;
  code: string;
  itemName: string;
  sku?: string;
  quantity: number;
  scannedAt: string;
  productId?: number;
  reason: "not_in_order" | "unknown_product";
};

type ScanActivity = {
  id: string;
  code: string;
  itemName: string;
  quantity: number;
  scannedAt: string;
  type: "order" | "extra";
};

type OfflineScanOp = {
  queueId: string;
  sessionId: number;
  itemId?: number;
  code: string;
  qty: number;
  productId?: number;
  productName?: string;
  productBarcode?: string;
  productSku?: string;
  itemName: string;
  isExtra: boolean;
  scannedAt: string;
  numPallets?: number | null;
  userCode?: string;
  userName?: string;
};

// Full session (used while actively scanning)
type OrderSession = {
  id: number;
  orderName: string;
  csvName: string;
  mappedColumn: string;
  createdAt: string;
  updatedAt: string;
  status: "scanning" | "completed";
  items: OrderItem[];
  extras: ExtraScan[];
};

// Lightweight summary used in the dashboard list
type SessionSummary = {
  id: number;
  orderName: string;
  csvName: string;
  status: "scanning" | "completed";
  totalExpected: number;
  totalScanned: number;
  totalExtras: number;
  itemCount: number;
  createdAt: string;
  updatedAt: string;
  createdByName?: string | null;
  createdByCode?: string | null;
};



type OsScanItem = {
  id: number; sessionId: number;
  barcode: string | null; itemName: string | null; sapCode: string | null;
  expectedQty: number; itemsPerPallet: number;
  scannedPallets: number; scannedLooseQty: number; totalScannedQty: number;
  status: string; lastScannedAt: string | null;
};

type ImportItemsResponse = {
  filename: string;
  items: Array<Omit<OrderItem, "id"> & { id?: number }>;
};

type CsvMode = "pivot" | "flat";

// ─── Helpers ───────────────────────────────────────────────────────────────

const normalize = (value?: string | number | null) =>
  String(value ?? "").trim().toLowerCase();

// Returns the most barcode-like display value: prefers values without spaces over product names
const bestCode = (item: { barcode?: string | null; sku: string; itemNo?: string | null }): string => {
  const candidates = [item.barcode, item.sku, item.itemNo].filter(Boolean) as string[];
  return candidates.find((c) => !c.includes(" ")) ?? candidates[0] ?? "";
};

const parseQuantity = (value?: string) => {
  const cleaned = String(value ?? "").replace(/,/g, "").trim();
  if (!cleaned) return 0;
  const parsed = Number(cleaned);
  return Number.isFinite(parsed) ? parsed : 0;
};

const parseCsv = (text: string) => {
  const rows: string[][] = [];
  let row: string[] = [];
  let cell = "";
  let inQuotes = false;

  for (let index = 0; index < text.length; index += 1) {
    const char = text[index];
    const next = text[index + 1];
    if (char === '"' && inQuotes && next === '"') { cell += '"'; index += 1; }
    else if (char === '"') { inQuotes = !inQuotes; }
    else if (char === "," && !inQuotes) { row.push(cell.trim()); cell = ""; }
    else if ((char === "\n" || char === "\r") && !inQuotes) {
      if (char === "\r" && next === "\n") index += 1;
      row.push(cell.trim());
      if (row.some(Boolean)) rows.push(row);
      row = []; cell = "";
    } else { cell += char; }
  }
  row.push(cell.trim());
  if (row.some(Boolean)) rows.push(row);
  return rows;
};

const detectCsvMode = (rows: string[][]): CsvMode => {
  const headers = rows[0] ?? [];
  const normalized = headers.map((h) => normalize(h));
  if (normalized.includes("productbarcode") || normalized.includes("quantity")) return "flat";
  const firstCell = normalize(rows[0]?.[0]);
  const secondFirst = normalize(rows[1]?.[0]);
  if (firstCell.includes("customer") || secondFirst.includes("productcode")) return "pivot";
  return "flat";
};

const extractPalletSize = (product: { itemsPerPallet?: number | null; name?: string | null }): number => {
  if (product.itemsPerPallet != null && product.itemsPerPallet > 0) return product.itemsPerPallet;
  const nameStr = String(product.name ?? "");
  const starMatch = nameStr.match(/\*(\d{1,5})/);
  if (starMatch) { const n = parseInt(starMatch[1], 10); if (Number.isFinite(n) && n > 1) return n; }
  const standalone = nameStr.match(/\b(\d{1,4})\b/);
  if (standalone) { const n = parseInt(standalone[1], 10); if (Number.isFinite(n) && n > 1) return n; }
  return 0;
};

// ─── Component ─────────────────────────────────────────────────────────────

export default function ScanOrderPage() {
  const { toast } = useToast();
  const { user: currentUser } = useUser();
  const queryClient = useQueryClient();
  const videoRef = useRef<HTMLVideoElement>(null);
  const scannerRef = useRef<BarcodeScanner | null>(null);
  const lastScanRef = useRef({ code: "", at: 0 });

  const [view, setView] = useState<"dashboard" | "map" | "scan">("dashboard");
  const [activeSession, setActiveSession] = useState<OrderSession | null>(null);
  const [scanActivities, setScanActivities] = useState<ScanActivity[]>([]);
  // Tracks item IDs in the order they were last scanned (newest first).
  // Used to float recently-scanned rows to the top of the CSV Order Items table.
  const [recentItemIds, setRecentItemIds] = useState<number[]>([]);

  const [csvPage, setCsvPage] = useState(1);
  const CSV_PAGE_SIZE = 8;
  const [scanItemPage, setScanItemPage] = useState(1);
  const SCAN_PAGE_SIZE = 10;

  const [csvRows, setCsvRows] = useState<string[][]>([]);
  const [csvName, setCsvName] = useState("");
  const [csvMode, setCsvMode] = useState<CsvMode>("pivot");
  const [mappedColumn, setMappedColumn] = useState("");
  const [selectedImport, setSelectedImport] = useState("");
  const [importItems, setImportItems] = useState<Array<Omit<OrderItem, "id">>>([]);
  const [flatSkuColumn, setFlatSkuColumn] = useState("");
  const [flatNameColumn, setFlatNameColumn] = useState("");
  const [flatQtyColumn, setFlatQtyColumn] = useState("");
  const [manualCode, setManualCode] = useState("");
  const [isScanning, setIsScanning] = useState(false);
  const [isPostingScan, setIsPostingScan] = useState(false);
  const [isCreatingOrder, setIsCreatingOrder] = useState(false);

  type PendingScan = {
    code: string;
    product: Product | null;
    matchedItem: OrderItem | undefined;
    palletSize: number;
    itemsPerPallet: number; // fixed units-per-pallet from inventory (divisor for pallet calculation)
  };
  const [pendingScan, setPendingScan] = useState<PendingScan | null>(null);
  const [pendingQty, setPendingQty] = useState<string>("1");
  const [showCompleteConfirm, setShowCompleteConfirm] = useState(false);

  // Online / offline state + queued scans
  const [isOnline, setIsOnline] = useState(() => typeof navigator !== "undefined" ? navigator.onLine : true);
  const [offlineQueue, setOfflineQueue] = useState<OfflineScanOp[]>(() => {
    try { return JSON.parse(localStorage.getItem("km_offline_scan_queue") || "[]"); } catch { return []; }
  });
  const [isSyncing, setIsSyncing] = useState(false);
  const offlineQueueRef = useRef<OfflineScanOp[]>(offlineQueue);
  const isSyncingRef = useRef(false);

  // ── Queries ──────────────────────────────────────────────────────────────

  const { data: productsRaw = [] } = useQuery<any>({
    queryKey: ["/api/products", { all: "true" }],
  });
  const products: Product[] = Array.isArray(productsRaw) ? productsRaw : (productsRaw?.results ?? []);

  const { data: sessionsRaw = [], refetch: refetchSessions } = useQuery<SessionSummary[]>({
    queryKey: ["/api/scan-sessions", currentUser?.userCode],
    queryFn: async () => {
      const params = currentUser?.userCode ? `?userCode=${encodeURIComponent(currentUser.userCode)}` : "";
      const r = await apiRequest("GET", `/api/scan-sessions${params}`, undefined, false, true);
      return Array.isArray(r) ? r : [];
    },
  });
  const sessions: SessionSummary[] = sessionsRaw;

  // Poll for admin-loaded order-import session (from /order-scan flow)
  const { data: orderScanNotif } = useQuery<{ active: boolean; session: any }>({
    queryKey: ["/api/order-scan/notification"],
    queryFn: () => apiRequest("GET", "/api/order-scan/notification").then((r) => r.json()),
    refetchInterval: 20000,
  });
  const activeOrderScanSession = orderScanNotif?.active ? orderScanNotif.session : null;

  // ── Embedded order-scan state (admin-loaded CSV) ───────────────────────────
  const osVideoRef = useRef<HTMLVideoElement>(null);
  const osScannerRef = useRef<BarcodeScanner | null>(null);
  const [osScanMode, setOsScanMode] = useState<"camera" | "manual">("manual");
  const [osCameraReady, setOsCameraReady] = useState(false);
  const [osCameraError, setOsCameraError] = useState<string | null>(null);
  const [osPending, setOsPending] = useState<{ barcode: string; matchedItem: OsScanItem | null; inventoryProduct: Product | null; plantPalletSize: number } | null>(null);
  const osPendingRef = useRef<{ barcode: string; matchedItem: OsScanItem | null; inventoryProduct: Product | null; plantPalletSize: number } | null>(null);
  const [osMultiMatch, setOsMultiMatch] = useState<{ barcode: string; matches: OsScanItem[]; inventoryProduct: Product | null; plantPalletSize: number } | null>(null);
  const osMultiMatchRef = useRef<{ barcode: string; matches: OsScanItem[]; inventoryProduct: Product | null; plantPalletSize: number } | null>(null);
  const [osPallets, setOsPallets] = useState(1);
  const [osLooseQty, setOsLooseQty] = useState(0);
  const [osQty, setOsQty] = useState(1); // total boxes — user-editable; pallets auto-calculated
  const [osSelectedStv, setOsSelectedStv] = useState("");
  const lastSelectedStvRef = useRef("");
  const [osSearch, setOsSearch] = useState("");
  const [osManualCode, setOsManualCode] = useState("");
  const [osRecentScans, setOsRecentScans] = useState<{ barcode: string; name: string; total: number; isExtra: boolean }[]>([]);
  // Barcodes we already added optimistically; WS handler skips the echo for these
  const osRecentScanSentRef = useRef<Set<string>>(new Set());
  const [wsConnected, setWsConnected] = useState(false);
  useEffect(() => { osPendingRef.current = osPending; }, [osPending]);
  useEffect(() => { osMultiMatchRef.current = osMultiMatch; }, [osMultiMatch]);
  useEffect(() => {
    lastSelectedStvRef.current = "";
    setOsSelectedStv("");
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

  const osStvsQuery = useQuery<string[]>({
    queryKey: ["/api/order-scan/stvs", activeOrderScanSession?.plant],
    queryFn: () =>
      apiRequest("GET", `/api/order-scan/stvs?plant=${encodeURIComponent(activeOrderScanSession!.plant)}`).then((r) => r.json()),
    enabled: !!activeOrderScanSession?.plant,
  });

  const osItemsKey = ["/api/order-scan/sessions", activeOrderScanSession?.id, "items"] as const;

  const osScanMutation = useMutation({
    mutationFn: (payload: { barcode: string; pallets: number; looseQty: number; isExtra: boolean; stv: string | null }) =>
      apiRequest("POST", `/api/order-scan/sessions/${activeOrderScanSession!.id}/scan`, payload).then((r) => r.json()),

    onMutate: async (payload) => {
      // Cancel any in-flight refetch so it doesn't overwrite our optimistic update
      await queryClient.cancelQueries({ queryKey: osItemsKey });
      const previousItems = queryClient.getQueryData<OsScanItem[]>(osItemsKey);
      const previousPending = osPendingRef.current; // save before clearing

      // Only optimistically update if the barcode matched a CSV item (not an extra)
      const matched = previousPending?.matchedItem;
      if (matched && !payload.isExtra) {
        const itemsPerPallet = previousPending?.plantPalletSize ?? matched.itemsPerPallet ?? 1;
        const addedQty = Math.round(payload.pallets * Math.max(1, itemsPerPallet)) + payload.looseQty;

        queryClient.setQueryData<OsScanItem[]>(osItemsKey, (old = []) =>
          old.map((item) => {
            if (item.id !== matched.id) return item;
            const newTotal = (item.totalScannedQty ?? 0) + addedQty;
            return {
              ...item,
              totalScannedQty: newTotal,
              scannedPallets: (item.scannedPallets ?? 0) + payload.pallets,
              scannedLooseQty: (item.scannedLooseQty ?? 0) + payload.looseQty,
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
          { barcode: payload.barcode, name: extraName, total: payload.pallets, isExtra: true },
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
      // SSE handles recent-scans feed and other devices — no invalidateQueries needed
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

  const handleOsBarcode = (barcode: string) => {
    if (osPendingRef.current || osMultiMatchRef.current) return;
    const normBarcode = normalize(barcode);
    const matches = osItemsRef.current.filter((i) => normalize(i.barcode ?? "") === normBarcode);
    const invProduct = productLookup.get(normalize(barcode)) ?? null;
    const plantPalletSize = _computePlantPalletSize(matches[0] ?? null, invProduct);

    if (matches.length > 1) {
      setOsMultiMatch({ barcode, matches, inventoryProduct: invProduct, plantPalletSize });
      return;
    }

    const match = matches[0] ?? null;
    const defaultQty = _defaultScanQty(match, plantPalletSize);
    setOsQty(defaultQty);
    setOsPallets(1);
    setOsLooseQty(0);
    setOsSelectedStv(lastSelectedStvRef.current);
    setOsPending({ barcode, matchedItem: match, inventoryProduct: invProduct, plantPalletSize });
  };

  const handleOsMultiMatchSelect = (item: OsScanItem) => {
    if (!osMultiMatch) return;
    const barcode = osMultiMatch.barcode;
    const invProduct = osMultiMatch.inventoryProduct;
    const plantPalletSize = _computePlantPalletSize(item, invProduct);
    const defaultQty = _defaultScanQty(item, plantPalletSize);
    setOsMultiMatch(null);
    setOsQty(defaultQty);
    setOsPallets(1);
    setOsLooseQty(0);
    setOsSelectedStv(lastSelectedStvRef.current);
    setOsPending({ barcode, matchedItem: item, inventoryProduct: invProduct, plantPalletSize });
  };

  const handleOsConfirmScan = () => {
    if (!osPending) return;
    const stvs = osStvsQuery.data ?? [];
    if (stvs.length > 0 && !osSelectedStv) {
      toast({ title: "Select an STV first", variant: "destructive" });
      return;
    }
    const plt = osPending.plantPalletSize ?? osPending.matchedItem?.itemsPerPallet ?? 1;
    const qty = Math.max(1, osQty);
    const pallets = plt > 1 ? Math.floor(qty / plt) : qty;
    const looseQty = plt > 1 ? qty % plt : 0;
    const itemAlreadyComplete = osPending.matchedItem
      ? (osPending.matchedItem.totalScannedQty ?? 0) >= (osPending.matchedItem.expectedQty ?? 1)
      : false;
    osScanMutation.mutate({
      barcode: osPending.barcode,
      pallets,
      looseQty,
      isExtra: !osPending.matchedItem || itemAlreadyComplete,
      stv: osSelectedStv || null,
    });
  };

  useEffect(() => {
    if (!activeOrderScanSession || osScanMode !== "camera") return;
    let cancelled = false;
    (async () => {
      if (!osVideoRef.current || cancelled) return;
      setOsCameraError(null);
      setOsCameraReady(false);
      const scanner = new BarcodeScanner({
        onDetected: (result: Result) => {
          const code = result.getText();
          if (code && !osPendingRef.current && !osMultiMatchRef.current) handleOsBarcode(code);
        },
        onError: (err: Error) => {
          if (!cancelled) { setOsCameraError(err.message); setOsScanMode("manual"); }
        },
      });
      osScannerRef.current = scanner;
      try {
        await scanner.initialize();
        if (!cancelled) await scanner.start(osVideoRef.current!);
        if (!cancelled) setOsCameraReady(true);
      } catch (err: any) {
        if (!cancelled) { setOsCameraError(err?.message ?? "Camera failed"); setOsScanMode("manual"); }
      }
    })();
    return () => { cancelled = true; stopOsCamera(); };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeOrderScanSession?.id, osScanMode]);

  // Order completion dialog state
  const [showOsComplete, setShowOsComplete] = useState(false);
  const osCompletionPromptedRef = useRef(false);

  // Reset prompt flag when session changes so a new session can trigger it again
  useEffect(() => {
    osCompletionPromptedRef.current = false;
    setShowOsComplete(false);
  }, [activeOrderScanSession?.id]);

  // Auto-show completion dialog once all CSV items are fully scanned
  useEffect(() => {
    if (!activeOrderScanSession || osCompletionPromptedRef.current) return;
    const items = osItemsQuery.data ?? [];
    if (items.length === 0) return;
    if (items.every((i) => i.status === "complete")) {
      osCompletionPromptedRef.current = true;
      setShowOsComplete(true);
    }
  }, [osItemsQuery.data, activeOrderScanSession]);

  const osCompleteMutation = useMutation({
    mutationFn: () =>
      apiRequest("POST", `/api/order-scan/sessions/${activeOrderScanSession!.id}/complete`).then((r) => r.json()),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/order-scan/notification"] });
      setShowOsComplete(false);
      toast({ title: "Order completed!", description: "Session closed. Great work!" });
    },
    onError: (err: any) => toast({ title: "Failed to complete order", description: err?.message, variant: "destructive" }),
  });

  // WebSocket subscription — receives push updates from every scan on this session
  useEffect(() => {
    if (!activeOrderScanSession) return;
    const sessionId = activeOrderScanSession.id;

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
        ws!.send(JSON.stringify({ type: 'join', sessionId }));
        startDeadTimer();
      };

      ws.onmessage = (e) => {
        lastMsgAt = Date.now(); // reset dead-connection timer on any message
        try {
          const data = JSON.parse(e.data);

          if (data.type === 'joined' || data.type === 'ping') return;
          if (data.type !== 'scan') return;

          // Patch cache directly — no HTTP refetch needed.
          // The WS message already carries the committed DB values for this item.
          if (data.item) {
            queryClient.setQueryData<OsScanItem[]>(
              ["/api/order-scan/sessions", sessionId, "items"],
              (old = []) => old.map((i) => i.id === data.item.id ? { ...i, ...data.item } : i),
            );
          }

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
  }, [activeOrderScanSession?.id]);

  const importsQuery = useQuery<any>({
    queryKey: ["/api/orders/imports", csvPage, CSV_PAGE_SIZE],
    queryFn: async () => {
      const r = await apiRequest("GET", `/api/orders/imports?page=${csvPage}&limit=${CSV_PAGE_SIZE}`, undefined, false, true);
      return r ?? {};
    },
    retry: false,
    staleTime: 0,
  });
  const { data: importsData = {}, error: importsError } = importsQuery as any;
  const importSummaries: { filename: string; noteKey: string; orderCount: number; itemCount: number; lastImportedAt: string }[] =
    Array.isArray(importsData.results) ? importsData.results : (Array.isArray(importsData) ? importsData : []);
  const importsTotalPages: number = importsData.totalPages ?? 1;
  const importsTotal: number = importsData.total ?? importSummaries.length;

  useEffect(() => {
    if (importsError) toast({ title: "Failed to load uploaded CSVs", description: (importsError as any).message, variant: "destructive" });
  }, [importsError, toast]);

  // ── Mutations ────────────────────────────────────────────────────────────

  const createSessionMutation = useMutation({
    mutationFn: async (payload: { session: any; items: any[] }) =>
      apiRequest("POST", "/api/scan-sessions", payload, false, true) as Promise<OrderSession>,
    onSuccess: (data) => {
      queryClient.invalidateQueries({ queryKey: ["/api/scan-sessions"] });
      setActiveSession({ ...data, items: data.items ?? [], extras: data.extras ?? [] });
      setScanActivities([]);
      localStorage.removeItem(`km_scan_activities_${data.id}`);
      setRecentItemIds([]);
      resetDraft();
      setView("scan");
    },
    onError: () => toast({ title: "Failed to create scan order", variant: "destructive" }),
  });

  const completeSessionMutation = useMutation({
    mutationFn: async (id: number) =>
      apiRequest("PATCH", `/api/scan-sessions/${id}`, { status: "completed" }),
    onSuccess: (_, id) => {
      queryClient.invalidateQueries({ queryKey: ["/api/scan-sessions"] });
      setActiveSession((s) => s ? { ...s, status: "completed" } : s);
      localStorage.removeItem("km_scan_restore_id");
      localStorage.removeItem(`km_scan_activities_${id}`);
    },
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

  // ── CSV helpers ───────────────────────────────────────────────────────────

  const pivotColumns = useMemo(() => {
    if (csvMode !== "pivot" || csvRows.length < 2) return [];
    return (csvRows[0] ?? []).slice(1)
      .map((label, index) => ({ label, index: index + 1 }))
      .filter((c) => c.label && normalize(c.label) !== "total");
  }, [csvMode, csvRows]);

  const flatHeaders = useMemo(() => (csvMode === "flat" ? csvRows[0] ?? [] : []), [csvMode, csvRows]);

  const mappedItems = useMemo(() => {
    if (importItems.length) return importItems;
    if (!csvRows.length) return [];

    if (csvMode === "pivot") {
      const selected = pivotColumns.find((c) => c.label === mappedColumn);
      if (!selected) return [];
      return csvRows.slice(2).reduce<Array<Omit<OrderItem, "id">>>((acc, row) => {
        const barcode = row[11] ?? "";
        const internalCode = row[10] ?? "";
        const productDescription = row[12] ?? "";
        const qty = parseQuantity(row[selected.index]);
        if (!barcode || qty <= 0) return acc;
        // Load directly from CSV — no inventory lookup at this stage
        acc.push({ sku: barcode, itemName: productDescription || barcode, expectedQty: qty, scannedQty: 0, productId: undefined, barcode, itemNo: internalCode || undefined, sapCode: undefined, inventoryQty: null });
        return acc;
      }, []);
    }

    const skuIndex = flatHeaders.indexOf(flatSkuColumn);
    const nameIndex = flatHeaders.indexOf(flatNameColumn);
    const qtyIndex = flatHeaders.indexOf(flatQtyColumn);
    if (skuIndex < 0 || qtyIndex < 0) return [];
    return csvRows.slice(1).reduce<Array<Omit<OrderItem, "id">>>((acc, row) => {
      const sku = row[skuIndex] ?? "";
      const qty = parseQuantity(row[qtyIndex]);
      if (!sku || qty <= 0) return acc;
      // Load directly from CSV — no inventory lookup at this stage
      acc.push({ sku, itemName: row[nameIndex] ?? sku, expectedQty: qty, scannedQty: 0, productId: undefined, barcode: sku, itemNo: undefined, sapCode: undefined, inventoryQty: null });
      return acc;
    }, []);
  }, [csvMode, csvRows, flatHeaders, flatNameColumn, flatQtyColumn, flatSkuColumn, importItems, mappedColumn, pivotColumns]);

  const totals = useMemo(() => {
    const items = activeSession?.items ?? [];
    return {
      expected: items.reduce((s, i) => s + i.expectedQty, 0),
      scanned: items.reduce((s, i) => s + i.scannedQty, 0),
      completed: items.filter((i) => i.scannedQty >= i.expectedQty).length,
    };
  }, [activeSession]);

  // ── Actions ───────────────────────────────────────────────────────────────

  const resetDraft = () => {
    setCsvRows([]); setCsvName(""); setMappedColumn(""); setSelectedImport([].toString());
    setImportItems([]); setFlatSkuColumn(""); setFlatNameColumn(""); setFlatQtyColumn(""); setCsvMode("pivot");
  };

  const loadImportItems = async (filename?: string) => {
    const target = filename ?? selectedImport;
    if (!target) return;
    const response = await apiRequest("GET", `/api/orders/imports/items?filename=${encodeURIComponent(target)}`, undefined, false, true) as ImportItemsResponse;
    if (!response?.items?.length) { toast({ title: "No items found", description: "This CSV has no arriving items to scan.", variant: "destructive" }); return; }
    // Load CSV data as-is — no inventory matching at import time
    setImportItems(response.items.map((item) => ({
      ...item,
      scannedQty: 0,
      productId: undefined,
      sapCode: undefined,
      inventoryQty: null,
    })));
    setCsvName(response.filename);
    setMappedColumn("Arriving Orders Import");
    setCsvMode("pivot");
  };

  const loadCsvText = (text: string, name: string) => {
    const rows = parseCsv(text);
    if (rows.length < 2) { toast({ title: "CSV not readable", description: "Please upload a CSV with product and quantity rows.", variant: "destructive" }); return; }
    const mode = detectCsvMode(rows);
    setCsvRows(rows); setCsvName(name); setCsvMode(mode); setMappedColumn(""); setSelectedImport(""); setImportItems([]);
    if (mode === "flat") {
      const headers = rows[0] ?? [];
      const find = (patterns: RegExp[]) => headers.find((h) => patterns.some((p) => p.test(h))) ?? "";
      setFlatSkuColumn(find([/^productbarcode$/i, /^barcode$/i, /^sku$/i, /barcode/i, /sku/i, /sap/i]));
      setFlatNameColumn(find([/^productname$/i, /^name$/i, /product/i]));
      setFlatQtyColumn(find([/^quantity$/i, /^qty$/i, /quantity/i]));
    }
  };

  const createOrder = async () => {
    if (!mappedItems.length) { toast({ title: "Map the order first", description: "Choose the CSV column that represents the arriving order.", variant: "destructive" }); return; }
    setIsCreatingOrder(true);
    const userRaw = localStorage.getItem("currentUser");
    const user = userRaw ? JSON.parse(userRaw) : null;
    try {
      await createSessionMutation.mutateAsync({
        session: {
          orderName: mappedColumn || csvName.replace(/\.csv$/i, "") || "Stock Arrival",
          csvName,
          mappedColumn: mappedColumn || "Mapped order",
          status: "scanning",
          createdByName: user?.name || user?.username,
        },
        items: mappedItems.map((item) => ({
          sku: item.sku,
          itemName: item.itemName,
          barcode: item.barcode,
          itemNo: item.itemNo,
          sapCode: item.sapCode,
          productId: item.productId,
          expectedQty: item.expectedQty,
          scannedQty: 0,
        })),
      });
    } finally {
      setIsCreatingOrder(false);
    }
  };

  const loadFullSession = async (id: number) => {
    const data = await apiRequest("GET", `/api/scan-sessions/${id}`, undefined, false, true) as OrderSession;
    const items = data.items ?? [];
    setActiveSession({ ...data, items, extras: data.extras ?? [] });
    try {
      const saved = localStorage.getItem(`km_scan_activities_${id}`);
      setScanActivities(saved ? JSON.parse(saved) : []);
    } catch {
      setScanActivities([]);
    }
    setRecentItemIds(items.filter((i) => i.scannedQty > 0).map((i) => i.id));
    setView("scan");
  };

  const findProductForCode = async (code: string): Promise<Product | null> => {
    const local = productLookup.get(normalize(code));
    if (local) return local;
    try {
      const api = await apiRequest("GET", `/api/products/barcode/${encodeURIComponent(code)}`, undefined, false, true) as Product;
      if (api?.id) return api;
    } catch { /* not found */ }
    const n = normalize(code);
    return products.find((p) => [p.barcode, p.itemNo, p.sapCode, p.srNo].some((f) => normalize(f) === n)) ?? null;
  };

  // Saves a pallet scan row with up to 3 retries and exponential backoff.
  // Fails silently — scannedQty is already committed, so this is best-effort.
  const postPalletScan = async (sessionId: number, payload: object) => {
    for (let attempt = 0; attempt < 3; attempt++) {
      try {
        await apiRequest("POST", `/api/scan-sessions/${sessionId}/pallet-scans`, payload, false, true);
        return; // success
      } catch {
        if (attempt < 2) await new Promise((r) => setTimeout(r, 400 * (attempt + 1)));
      }
    }
  };

  const postStockScan = async (product: Product, code: string, orderNumber: string, quantity: number) => {
    const userRaw = localStorage.getItem("currentUser");
    const user = userRaw ? JSON.parse(userRaw) : null;
    return apiRequest("POST", "/api/scans", {
      barcode: product.barcode || code,
      productId: product.id,
      action: "add",
      quantity,
      productSku: product.itemNo || product.sapCode || product.barcode || code,
      productName: product.name,
      scannerName: user?.name || user?.username || "Unknown User",
      scannerDepartment: user?.department || "N/A",
      scannedByCode: user?.userCode,
      orderNumber,
      notes: `Stock arrival scan for ${orderNumber} (qty: ${quantity})`,
    });
  };

  // Flush the offline queue to the server. Called automatically when the browser
  // regains connectivity. Processes ops in order; stops on first failure and keeps
  // remaining ops in the queue for the next attempt.
  const syncOfflineQueue = async (queue: OfflineScanOp[]) => {
    if (!queue.length || isSyncingRef.current) return;
    isSyncingRef.current = true;
    setIsSyncing(true);
    let processed = 0;
    let remaining: OfflineScanOp[] = [];
    for (let i = 0; i < queue.length; i++) {
      const op = queue[i];
      try {
        if (!op.isExtra && op.itemId != null) {
          await apiRequest("PATCH", `/api/scan-sessions/${op.sessionId}/items/${op.itemId}`,
            { increment: op.qty, productId: op.productId ?? null }, false, true);
          postPalletScan(op.sessionId, { sessionItemId: op.itemId, barcode: op.productBarcode || op.code, sku: op.productSku || op.code, itemName: op.itemName, productId: op.productId, quantity: op.qty, numPallets: op.numPallets ?? null, isExtra: false, scannedByCode: op.userCode, scannedByName: op.userName });
        } else if (op.isExtra) {
          await apiRequest("POST", `/api/scan-sessions/${op.sessionId}/extras`,
            { code: op.code, itemName: op.itemName, sku: op.productSku || op.code, productId: op.productId, quantity: op.qty, reason: op.productId ? "not_in_order" : "unknown_product", scannedByCode: op.userCode, scannedByName: op.userName }, false, true);
          postPalletScan(op.sessionId, { barcode: op.productBarcode || op.code, sku: op.productSku || op.code, itemName: op.itemName, productId: op.productId, quantity: op.qty, numPallets: op.numPallets ?? null, isExtra: true, scannedByCode: op.userCode, scannedByName: op.userName });
        }
        processed++;
      } catch {
        remaining = queue.slice(i); // keep this op and everything after it
        break;
      }
    }
    setOfflineQueue(remaining);
    offlineQueueRef.current = remaining;
    isSyncingRef.current = false;
    setIsSyncing(false);
    if (processed > 0) {
      toast({
        title: remaining.length === 0 ? "Offline scans synced" : `${processed} scan${processed !== 1 ? "s" : ""} synced`,
        description: remaining.length > 0 ? `${remaining.length} still pending — will retry on next connection.` : undefined,
      });
    }
  };

  const handleScannedCode = async (rawCode: string) => {
    const code = rawCode.trim();
    if (!code || !activeSession || isPostingScan || pendingScan !== null) return;
    const now = Date.now();
    if (lastScanRef.current.code === code && now - lastScanRef.current.at < 600) return;
    lastScanRef.current = { code, at: now };
    setIsPostingScan(true);
    try {
      let product = await findProductForCode(code);
      if (product?.id && (!product.itemsPerPallet || product.itemsPerPallet === 0)) {
        try {
          const fresh = await apiRequest("GET", `/api/products/${product.id}`, undefined, false, true) as Product;
          if (fresh?.id) product = fresh;
        } catch { /* keep original */ }
      }
      const keys = new Set([code, product?.barcode, product?.itemNo, product?.sapCode, product?.srNo].map(normalize).filter(Boolean));
      let matchedItem: OrderItem | undefined;
      for (const item of (activeSession.items ?? [])) {
        const itemKeys = [item.sku, item.barcode, item.itemNo, item.sapCode].map(normalize);
        if (product?.id && item.productId === product.id) { matchedItem = item; break; }
        if (itemKeys.some((k) => keys.has(k))) { matchedItem = item; break; }
      }
      // product.pallets = the size of one pallet (items per pallet) as defined in inventory.
      // extractPalletSize parses the number from the product name (e.g. *192) only as a fallback.
      const inventoryPallets = product?.pallets ?? 0;
      const namePalletSize   = product ? extractPalletSize(product) : 0;
      // itemsPerPallet = pallet size (the divisor for the pallet count calculation)
      const itemsPerPallet   = inventoryPallets > 0 ? inventoryPallets : namePalletSize;
      // remaining = how many boxes are still needed to fill the order (0 if fully/over scanned)
      const remaining        = matchedItem ? Math.max(0, matchedItem.expectedQty - matchedItem.scannedQty) : 0;
      const hasRemaining     = remaining > 0;
      // If there's still room in the order and it's less than one pallet, default to the gap.
      // Otherwise (fully scanned or extra) default to a full pallet — the scan will go to extras.
      const defaultQty       = itemsPerPallet > 0
        ? (hasRemaining && remaining < itemsPerPallet ? remaining : itemsPerPallet)
        : (hasRemaining ? remaining : 1);
      setPendingScan({ code, product, matchedItem, palletSize: itemsPerPallet, itemsPerPallet });
      setPendingQty(String(defaultQty));
    } catch (error) {
      toast({ title: "Scan failed", description: error instanceof Error ? error.message : "Could not look up this barcode.", variant: "destructive" });
    } finally {
      setIsPostingScan(false);
    }
  };

  const confirmPendingScan = async () => {
    if (!pendingScan || !activeSession) return;
    const { code, product, matchedItem } = pendingScan;
    const qty = Math.max(1, parseInt(pendingQty, 10) || 1);

    // ── Offline path: apply optimistic UI updates and queue for later sync ──
    if (!isOnline) {
      const scannedAt = new Date().toISOString();
      const userRaw = localStorage.getItem("currentUser");
      const user = userRaw ? JSON.parse(userRaw) : null;
      const ipp = pendingScan.itemsPerPallet;

      const remaining = matchedItem ? Math.max(0, matchedItem.expectedQty - matchedItem.scannedQty) : 0;
      const orderQty = matchedItem ? Math.min(qty, remaining) : 0;
      const extraQty = matchedItem ? qty - orderQty : qty;

      if (matchedItem && orderQty > 0) {
        setActiveSession((s) => s ? { ...s, updatedAt: scannedAt, items: s.items.map((i) => i.id === matchedItem!.id ? { ...i, scannedQty: i.scannedQty + orderQty } : i) } : s);
        setRecentItemIds((prev) => [matchedItem!.id, ...prev.filter((id) => id !== matchedItem!.id)]);
        setScanItemPage(1);
        setOfflineQueue((q) => [...q, { queueId: `q-${Date.now()}`, sessionId: activeSession.id, itemId: matchedItem.id, code, qty: orderQty, productId: product?.id, productName: product?.name, productBarcode: product?.barcode, productSku: product?.itemNo || product?.sapCode || product?.barcode, itemName: matchedItem.itemName, isExtra: false, scannedAt, numPallets: ipp > 0 ? parseFloat((orderQty / ipp).toFixed(2)) : null, userCode: user?.userCode, userName: user?.name || user?.username }]);
        setScanActivities((prev) => [{ id: `act-${Date.now()}`, code, itemName: matchedItem.itemName, quantity: orderQty, scannedAt, type: "order" as const }, ...prev].slice(0, 50));
      }

      const extraTarget = matchedItem ? extraQty : qty;
      if (extraTarget > 0) {
        const extraName = matchedItem ? matchedItem.itemName : (product?.name ?? "Unknown product");
        const existing = (activeSession.extras ?? []).find((e) => e.code === code);
        setActiveSession((s) => !s ? s : { ...s, updatedAt: scannedAt, extras: existing ? s.extras.map((e) => e.code === code ? { ...e, quantity: e.quantity + extraTarget, scannedAt } : e) : [{ id: Date.now(), code, itemName: extraName, sku: product?.itemNo || product?.sapCode || product?.barcode, quantity: extraTarget, scannedAt, productId: product?.id, reason: product ? "not_in_order" as const : "unknown_product" as const }, ...s.extras] });
        setOfflineQueue((q) => [...q, { queueId: `q-${Date.now()}-x`, sessionId: activeSession.id, code, qty: extraTarget, productId: product?.id, productName: product?.name, productBarcode: product?.barcode, productSku: product?.itemNo || product?.sapCode || product?.barcode, itemName: extraName, isExtra: true, scannedAt, numPallets: ipp > 0 ? parseFloat((extraTarget / ipp).toFixed(2)) : null, userCode: user?.userCode, userName: user?.name || user?.username }]);
        setScanActivities((prev) => [{ id: `act-${Date.now()}-x`, code, itemName: extraName, quantity: extraTarget, scannedAt, type: "extra" as const }, ...prev].slice(0, 50));
      }

      toast({ title: "Saved offline", description: "Will sync automatically when you reconnect." });
      setIsPostingScan(false);
      setPendingScan(null);
      setPendingQty("1");
      lastScanRef.current = { code: "", at: 0 };
      return;
    }
    // ── End offline path ────────────────────────────────────────────────────
    const userRaw = localStorage.getItem("currentUser");
    const user = userRaw ? JSON.parse(userRaw) : null;
    setIsPostingScan(true);
    try {
      if (product) {
        await postStockScan(product, code, activeSession.orderName, qty);
        queryClient.invalidateQueries({ queryKey: ["/api/products"] });
        queryClient.invalidateQueries({ queryKey: ["/api/scans"] });
      }
      const scannedAt = new Date().toISOString();

      const saveExtra = async (extraQty: number, extraName: string) => {
        let saved = false;
        for (let attempt = 0; attempt < 3 && !saved; attempt++) {
          try {
            await apiRequest("POST", `/api/scan-sessions/${activeSession.id}/extras`, {
              code,
              itemName: extraName,
              sku: product?.itemNo || product?.sapCode || product?.barcode,
              productId: product?.id,
              quantity: extraQty,
              reason: product ? "not_in_order" : "unknown_product",
              scannedByCode: user?.userCode,
              scannedByName: user?.name || user?.username,
            }, false, true);
            saved = true;
          } catch {
            if (attempt < 2) await new Promise((r) => setTimeout(r, 400 * (attempt + 1)));
          }
        }
        if (!saved) throw new Error("Failed to save extra scan after 3 attempts. Please try again.");

        const extraNumPallets = pendingScan.itemsPerPallet > 0
          ? parseFloat((extraQty / pendingScan.itemsPerPallet).toFixed(2))
          : null;
        postPalletScan(activeSession.id, {
          barcode: product?.barcode || code,
          sku: product?.itemNo || product?.sapCode || product?.barcode || code,
          itemName: extraName,
          productId: product?.id,
          quantity: extraQty,
          numPallets: extraNumPallets,
          isExtra: true,
          scannedByCode: user?.userCode,
          scannedByName: user?.name || user?.username,
        });

        const existing = (activeSession.extras ?? []).find((e) => e.code === code);
        setActiveSession((s) => {
          if (!s) return s;
          return {
            ...s,
            updatedAt: scannedAt,
            extras: existing
              ? s.extras.map((e) => e.code === code ? { ...e, quantity: e.quantity + extraQty, scannedAt } : e)
              : [{ id: Date.now(), code, itemName: extraName, sku: product?.itemNo || product?.sapCode || product?.barcode, quantity: extraQty, scannedAt, productId: product?.id, reason: product ? "not_in_order" as const : "unknown_product" as const }, ...s.extras],
          };
        });
        setScanActivities((prev) => [{ id: `act-${Date.now()}-x`, code, itemName: extraName, quantity: extraQty, scannedAt, type: "extra" as const }, ...prev].slice(0, 50));
      };

      if (matchedItem) {
        // Split: qty that fills the remaining expected goes to order; overflow goes to extras
        const remaining = Math.max(0, matchedItem.expectedQty - matchedItem.scannedQty);
        const orderQty = Math.min(qty, remaining);
        const extraQty = qty - orderQty;

        setRecentItemIds((prev) => [matchedItem!.id, ...prev.filter((id) => id !== matchedItem!.id)]);
        setScanItemPage(1);

        if (orderQty > 0) {
          const orderNumPallets = pendingScan.itemsPerPallet > 0
            ? parseFloat((orderQty / pendingScan.itemsPerPallet).toFixed(2))
            : null;

          // Optimistic UI update
          setActiveSession((s) => s ? {
            ...s,
            updatedAt: scannedAt,
            items: s.items.map((i) => i.id === matchedItem!.id ? { ...i, scannedQty: i.scannedQty + orderQty } : i),
          } : s);

          // Persist to DB with retry
          let saved = false;
          for (let attempt = 0; attempt < 3 && !saved; attempt++) {
            try {
              await apiRequest("PATCH", `/api/scan-sessions/${activeSession.id}/items/${matchedItem.id}`, { increment: orderQty, productId: product?.id ?? null }, false, true);
              saved = true;
            } catch {
              if (attempt < 2) await new Promise((r) => setTimeout(r, 400 * (attempt + 1)));
            }
          }
          if (!saved) {
            setActiveSession((s) => s ? {
              ...s,
              items: s.items.map((i) => i.id === matchedItem!.id ? { ...i, scannedQty: i.scannedQty - orderQty } : i),
            } : s);
            throw new Error("Failed to save scan after 3 attempts. Please try again.");
          }

          postPalletScan(activeSession.id, {
            sessionItemId: matchedItem.id,
            barcode: product?.barcode || code,
            sku: product?.itemNo || product?.sapCode || product?.barcode || code,
            itemName: matchedItem.itemName,
            productId: product?.id,
            quantity: orderQty,
            numPallets: orderNumPallets,
            isExtra: false,
            scannedByCode: user?.userCode,
            scannedByName: user?.name || user?.username,
          });

          setScanActivities((prev) => [{ id: `act-${Date.now()}`, code, itemName: matchedItem.itemName, quantity: orderQty, scannedAt, type: "order" as const }, ...prev].slice(0, 50));
        }

        // Any overflow beyond expected goes straight to extras
        if (extraQty > 0) {
          await saveExtra(extraQty, matchedItem.itemName);
        }

        toast({
          title: orderQty > 0 ? "Stock updated" : "Extra box recorded",
          description: extraQty > 0
            ? `${matchedItem.itemName} — ${orderQty} to order, ${extraQty} extra (over expected).`
            : `${matchedItem.itemName} — ${orderQty} unit${orderQty !== 1 ? "s" : ""} added.`,
        });
      } else {
        const extraName = product?.name ?? "Unknown product";
        await saveExtra(qty, extraName);
        toast({
          title: "Extra box recorded",
          description: product ? `${product.name} — ${qty} unit${qty !== 1 ? "s" : ""} not in order.` : `${code} kept in the extra report (not in inventory).`,
          variant: "destructive",
        });
      }

      queryClient.invalidateQueries({ queryKey: ["/api/scan-sessions"] });
    } catch (error) {
      toast({ title: "Scan failed", description: error instanceof Error ? error.message : "Could not process this scan.", variant: "destructive" });
    } finally {
      setIsPostingScan(false);
      setPendingScan(null);
      setPendingQty("1");
      lastScanRef.current = { code: "", at: 0 }; // reset debounce so same item can be scanned again immediately
    }
  };

  const startScanner = async () => {
    if (!videoRef.current) return;
    const scanner = new BarcodeScanner({
      onDetected: (result: Result) => handleScannedCode(result.getText()),
      onError: (error) => {
        if (!error.message.includes("No MultiFormat")) toast({ title: "Camera scanner issue", description: error.message, variant: "destructive" });
      },
    });
    scannerRef.current = scanner;
    await scanner.initialize();
    await scanner.start(videoRef.current);
    setIsScanning(true);
  };

  const stopScanner = async () => {
    if (scannerRef.current) { await scannerRef.current.stop(); scannerRef.current = null; }
    setIsScanning(false);
  };

  // Bulk-sync all item scannedQty values to DB so navigating away never loses data
  const syncSession = async (session: OrderSession) => {
    const items = session.items.filter((i) => i.scannedQty > 0);
    if (!items.length) return;
    try {
      await apiRequest(
        "PUT",
        `/api/scan-sessions/${session.id}/sync-items`,
        { items: items.map((i) => ({ id: i.id, scannedQty: i.scannedQty })) },
        false,
        true,
      );
    } catch {
      // Best-effort — individual PATCHes already ran; this is a safety net
    }
  };

  // Keep a ref so the beforeunload handler can read the latest session without stale closure
  const activeSessionRef = useRef<OrderSession | null>(null);
  useEffect(() => { activeSessionRef.current = activeSession; }, [activeSession]);

  useEffect(() => {
    const handleUnload = () => {
      const s = activeSessionRef.current;
      if (!s) return;
      const items = s.items.filter((i) => i.scannedQty > 0);
      if (!items.length) return;
      // sendBeacon survives page close / hard refresh
      navigator.sendBeacon(
        `/api/scan-sessions/${s.id}/sync-items`,
        new Blob(
          [JSON.stringify({ items: items.map((i) => ({ id: i.id, scannedQty: i.scannedQty })) })],
          { type: "application/json" },
        ),
      );
    };
    window.addEventListener("beforeunload", handleUnload);
    return () => {
      window.removeEventListener("beforeunload", handleUnload);
      // Component unmount = SPA navigation away (sidebar link etc.)
      // Fire sync as a plain fetch so it completes even after unmount
      const s = activeSessionRef.current;
      if (s) syncSession(s);
      if (scannerRef.current) scannerRef.current.stop();
    };
  }, []);

  // Keep offlineQueueRef in sync so event callbacks see the latest queue
  useEffect(() => { offlineQueueRef.current = offlineQueue; }, [offlineQueue]);

  // Persist offline queue to localStorage across page refreshes
  useEffect(() => {
    localStorage.setItem("km_offline_scan_queue", JSON.stringify(offlineQueue));
  }, [offlineQueue]);

  // Persist scan activities per session so history survives dashboard navigation
  useEffect(() => {
    if (activeSession?.id && scanActivities.length > 0) {
      localStorage.setItem(`km_scan_activities_${activeSession.id}`, JSON.stringify(scanActivities));
    }
  }, [scanActivities, activeSession?.id]);

  // Save the active session ID when scanning so we can auto-restore after a refresh
  useEffect(() => {
    if (activeSession && view === "scan") {
      localStorage.setItem("km_scan_restore_id", String(activeSession.id));
    }
  }, [activeSession?.id, view]);

  // On mount: if the user refreshed while scanning, jump straight back into the session
  useEffect(() => {
    const savedId = localStorage.getItem("km_scan_restore_id");
    if (!savedId) return;
    const id = parseInt(savedId, 10);
    if (isNaN(id)) return;
    loadFullSession(id).catch(() => localStorage.removeItem("km_scan_restore_id"));
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Online / offline listeners — auto-sync the queue when connectivity is restored
  useEffect(() => {
    const handleOnline = () => {
      setIsOnline(true);
      if (offlineQueueRef.current.length > 0) syncOfflineQueue(offlineQueueRef.current);
    };
    const handleOffline = () => setIsOnline(false);
    window.addEventListener("online", handleOnline);
    window.addEventListener("offline", handleOffline);
    return () => {
      window.removeEventListener("online", handleOnline);
      window.removeEventListener("offline", handleOffline);
    };
  // syncOfflineQueue is stable within this render — queue is read via ref
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const submitManualCode = () => { handleScannedCode(manualCode); setManualCode(""); };

  // ─── Views ────────────────────────────────────────────────────────────────

  if (view === "map") {
    return (
      <div className="flex-1 overflow-y-auto bg-gray-50 p-4 lg:p-6">
        <div className="mx-auto max-w-lg space-y-4">
          <div>
            <Button variant="ghost" className="mb-2 px-0" onClick={() => setView("dashboard")}>
              <ArrowLeft className="mr-2 h-4 w-4" />Back
            </Button>
            <h1 className="text-2xl font-semibold text-gray-950">New Scan Order</h1>
            <p className="text-sm text-gray-600">Select an order CSV to begin scanning.</p>
          </div>

          <div className="space-y-2">
            {importSummaries.length === 0 ? (
              <Card className="rounded-md">
                <CardContent className="py-12 text-center">
                  <FileSpreadsheet className="h-8 w-8 text-gray-200 mx-auto mb-3" />
                  <p className="text-gray-500 font-medium">No CSVs uploaded yet</p>
                  <p className="text-sm text-gray-400 mt-1">Upload an order CSV from the Orders page first.</p>
                </CardContent>
              </Card>
            ) : (
              <>
                {importSummaries.map((s) => {
                  const isSelected = selectedImport === s.noteKey;
                  return (
                    <button
                      key={s.noteKey}
                      type="button"
                      onClick={() => { setSelectedImport(s.noteKey); loadImportItems(s.noteKey); }}
                      className={`w-full text-left rounded-md border px-4 py-3 transition-all ${
                        isSelected
                          ? "border-[#001d6e] bg-blue-50 ring-1 ring-[#001d6e]"
                          : "border-gray-200 bg-white hover:border-gray-300 hover:bg-gray-50"
                      }`}
                    >
                      <div className="flex items-center gap-3">
                        <FileSpreadsheet className={`h-5 w-5 shrink-0 ${isSelected ? "text-[#001d6e]" : "text-gray-400"}`} />
                        <div className="min-w-0 flex-1">
                          <p className={`font-medium truncate ${isSelected ? "text-[#001d6e]" : "text-gray-800"}`}>{s.filename}</p>
                          <p className="text-xs text-gray-400 mt-0.5">
                            {s.orderCount} orders · {new Date(s.lastImportedAt).toLocaleDateString()}
                          </p>
                        </div>
                        {isSelected && <CheckCircle2 className="h-4 w-4 text-[#001d6e] shrink-0" />}
                      </div>
                    </button>
                  );
                })}

                {importsTotalPages > 1 && (
                  <div className="flex items-center justify-between pt-1">
                    <span className="text-xs text-gray-400">
                      Page {csvPage} of {importsTotalPages} · {importsTotal} CSV{importsTotal !== 1 ? "s" : ""}
                    </span>
                    <div className="flex gap-1">
                      <Button
                        variant="outline"
                        size="sm"
                        className="h-7 w-7 p-0"
                        disabled={csvPage <= 1}
                        onClick={() => setCsvPage((p) => Math.max(1, p - 1))}
                      >
                        <ChevronLeft className="h-3.5 w-3.5" />
                      </Button>
                      <Button
                        variant="outline"
                        size="sm"
                        className="h-7 w-7 p-0"
                        disabled={csvPage >= importsTotalPages}
                        onClick={() => setCsvPage((p) => Math.min(importsTotalPages, p + 1))}
                      >
                        <ChevronRight className="h-3.5 w-3.5" />
                      </Button>
                    </div>
                  </div>
                )}
              </>
            )}
          </div>

          {mappedItems.length > 0 && (
            <div className="rounded-md bg-emerald-50 border border-emerald-200 px-4 py-3 text-sm text-emerald-800">
              <span className="font-semibold">{mappedItems.length}</span> items loaded from <span className="font-medium">{csvName}</span>
            </div>
          )}

          <Button onClick={createOrder} disabled={!mappedItems.length || isCreatingOrder} className="w-full bg-[#001d6e] hover:bg-[#00154b]">
            <ScanLine className="mr-2 h-4 w-4" />{isCreatingOrder ? "Creating…" : "Start Scanning"}
          </Button>
        </div>
      </div>
    );
  }

  if (view === "scan" && activeSession) {
    const sessionItems = activeSession.items ?? [];
    const sessionExtras = activeSession.extras ?? [];

    // Sort so the most recently scanned item is always at the top.
    // Items never scanned stay below in their original CSV order.
    const sortedSessionItems = recentItemIds.length
      ? [...sessionItems].sort((a, b) => {
          const ai = recentItemIds.indexOf(a.id);
          const bi = recentItemIds.indexOf(b.id);
          if (ai !== -1 && bi !== -1) return ai - bi; // both scanned: keep relative scan order
          if (ai !== -1) return -1;                    // a scanned, b not → a goes up
          if (bi !== -1) return 1;                     // b scanned, a not → b goes up
          return 0;                                    // neither scanned: keep original order
        })
      : sessionItems;
    return (
      <div className="flex-1 overflow-y-auto bg-gray-50 p-4 lg:p-6">
        <div className="mx-auto max-w-7xl space-y-4">
          <div className="flex flex-wrap items-center justify-between gap-3">
            <div>
              <Button variant="ghost" className="mb-2 px-0" onClick={async () => {
                await stopScanner();
                await syncSession(activeSession);
                refetchSessions();
                setView("dashboard");
              }}>
                <ArrowLeft className="mr-2 h-4 w-4" />Dashboard
              </Button>
              <h1 className="text-2xl font-semibold text-gray-950">{activeSession.orderName}</h1>
              <p className="text-sm text-gray-600">{activeSession.csvName} — {totals.scanned} of {totals.expected} boxes scanned</p>
            </div>
            <div className="flex flex-wrap items-center gap-2">
              {isSyncing && (
                <span className="inline-flex items-center gap-1.5 rounded-full bg-blue-50 px-3 py-1 text-xs font-medium text-blue-700 border border-blue-200">
                  <RotateCcw className="h-3 w-3 animate-spin" />Syncing…
                </span>
              )}
              {!isOnline && (
                <span className="inline-flex items-center gap-1.5 rounded-full bg-amber-50 px-3 py-1 text-xs font-medium text-amber-700 border border-amber-200">
                  <AlertTriangle className="h-3 w-3" />Offline{offlineQueue.length > 0 ? ` · ${offlineQueue.length} queued` : ""}
                </span>
              )}
              <Button variant="outline" onClick={() => setShowCompleteConfirm(true)} disabled={activeSession.status === "completed"}>
                <CheckCircle2 className="mr-2 h-4 w-4" />Complete
              </Button>
              <Button variant="outline" onClick={stopScanner} disabled={!isScanning}>
                <Square className="mr-2 h-4 w-4" />Stop
              </Button>
            </div>
          </div>

          <div className="grid gap-4 lg:grid-cols-[1fr_420px]">
            <div className="space-y-4 order-last lg:order-first">
              <div className="grid gap-3 sm:grid-cols-3">
                <Card className="rounded-md"><CardContent className="p-4"><p className="text-xs text-gray-500">Expected</p><p className="text-2xl font-semibold">{totals.expected}</p></CardContent></Card>
                <Card className="rounded-md"><CardContent className="p-4"><p className="text-xs text-gray-500">Scanned</p><p className="text-2xl font-semibold text-emerald-700">{totals.scanned}</p></CardContent></Card>
                <Card className="rounded-md"><CardContent className="p-4"><p className="text-xs text-gray-500">Extras</p><p className="text-2xl font-semibold text-amber-700">{sessionExtras.reduce((s, e) => s + e.quantity, 0)}</p></CardContent></Card>
              </div>

              <Card className="rounded-md">
                <CardHeader>
                  <div className="flex items-center justify-between">
                    <CardTitle className="text-lg">CSV Order Items</CardTitle>
                    <span className="text-xs text-gray-400">{sortedSessionItems.length} items</span>
                  </div>
                </CardHeader>
                <CardContent>
                  <div className="overflow-x-auto overflow-y-auto max-h-[520px] border rounded-md">
                  <table className="w-full text-sm border-collapse">
                    <thead className="sticky top-0 z-10 bg-white">
                      <tr className="border-b border-gray-200">
                        <th className="px-3 py-2.5 text-left text-[11px] font-semibold uppercase tracking-wide text-gray-500 border-r border-gray-100 w-[45%] min-w-[220px]">Item</th>
                        <th className="px-3 py-2.5 text-right text-[11px] font-semibold uppercase tracking-wide text-gray-500 border-r border-gray-100 w-[18%]">Scanned / Exp.</th>
                        <th className="px-3 py-2.5 text-right text-[11px] font-semibold uppercase tracking-wide text-gray-500 border-r border-gray-100 w-[14%]">Pallets</th>
                        <th className="px-3 py-2.5 text-left text-[11px] font-semibold uppercase tracking-wide text-gray-500 w-[14%]">Status</th>
                      </tr>
                    </thead>
                    <tbody className="divide-y divide-gray-100">
                      {sortedSessionItems.slice((scanItemPage - 1) * SCAN_PAGE_SIZE, scanItemPage * SCAN_PAGE_SIZE).map((item, idx) => {
                        const done = item.scannedQty >= item.expectedQty;
                        const over = item.scannedQty > item.expectedQty;
                        const product = item.productId
                          ? products.find((p) => p.id === item.productId)
                          : productLookup.get(normalize(item.barcode || item.sku));
                        const ipp = product ? (product.pallets || extractPalletSize(product)) : 0;
                        const palletsScanned = ipp > 0 && item.scannedQty > 0
                          ? parseFloat((item.scannedQty / ipp).toFixed(2))
                          : null;
                        const code = bestCode(item);
                        return (
                          <tr key={item.id} className={idx % 2 === 1 ? "bg-gray-50/60" : "bg-white"}>
                            <td className="px-3 py-2.5 border-r border-gray-100">
                              <p className="font-medium text-gray-900 leading-snug">{item.itemName}</p>
                              {code && <p className="font-mono text-[11px] text-gray-400 mt-0.5">{code}</p>}
                            </td>
                            <td className="px-3 py-2.5 text-right tabular-nums border-r border-gray-100">
                              <span className={over ? "text-red-600 font-semibold" : done ? "text-gray-900 font-semibold" : "text-gray-700"}>
                                {item.scannedQty}
                              </span>
                              <span className="text-gray-400 font-normal">/{item.expectedQty}</span>
                            </td>
                            <td className="px-3 py-2.5 text-right tabular-nums text-gray-700 border-r border-gray-100">
                              {palletsScanned !== null ? palletsScanned : <span className="text-gray-300">—</span>}
                            </td>
                            <td className="px-3 py-2.5">
                              <span className={`inline-flex items-center gap-1 text-[11px] font-medium ${
                                done ? "text-gray-500" : over ? "text-red-600" : "text-gray-400"
                              }`}>
                                <span className={`h-1.5 w-1.5 rounded-full ${
                                  done ? "bg-gray-400" : over ? "bg-red-500" : "bg-gray-300"
                                }`} />
                                {done ? "Done" : over ? "Over" : "Pending"}
                              </span>
                            </td>
                          </tr>
                        );
                      })}
                    </tbody>
                  </table>
                  </div>

                  {sortedSessionItems.length > SCAN_PAGE_SIZE && (
                    <div className="flex items-center justify-between mt-4 pt-3 border-t">
                      <span className="text-xs text-gray-500">
                        Page {scanItemPage} of {Math.ceil(sortedSessionItems.length / SCAN_PAGE_SIZE)} · {sortedSessionItems.length} items
                      </span>
                      <div className="flex gap-1">
                        <Button
                          variant="outline"
                          size="sm"
                          className="h-7 w-7 p-0"
                          disabled={scanItemPage <= 1}
                          onClick={() => setScanItemPage((p) => Math.max(1, p - 1))}
                        >
                          <ChevronLeft className="h-3.5 w-3.5" />
                        </Button>
                        <Button
                          variant="outline"
                          size="sm"
                          className="h-7 w-7 p-0"
                          disabled={scanItemPage >= Math.ceil(sortedSessionItems.length / SCAN_PAGE_SIZE)}
                          onClick={() => setScanItemPage((p) => Math.min(Math.ceil(sortedSessionItems.length / SCAN_PAGE_SIZE), p + 1))}
                        >
                          <ChevronRight className="h-3.5 w-3.5" />
                        </Button>
                      </div>
                    </div>
                  )}
                </CardContent>
              </Card>

              <div className="grid gap-4 lg:grid-cols-2">
                <Card className="rounded-md">
                  <CardHeader><CardTitle className="text-lg">Scanned Activity</CardTitle></CardHeader>
                  <CardContent className="max-h-80 overflow-auto">
                    {scanActivities.length ? scanActivities.map((a) => (
                      <div key={a.id} className="flex items-center justify-between border-b py-3 last:border-0">
                        <div>
                          <p className="font-medium">{a.itemName}</p>
                          <p className="text-xs text-gray-500">{a.code} — {new Date(a.scannedAt).toLocaleTimeString()}</p>
                        </div>
                        <Badge variant={a.type === "order" ? "default" : "outline"}>{a.type}</Badge>
                      </div>
                    )) : <p className="py-8 text-center text-sm text-gray-500">Scanned items will appear here.</p>}
                  </CardContent>
                </Card>

                <Card className="rounded-md">
                  <CardHeader><CardTitle className="flex items-center text-lg"><AlertTriangle className="mr-2 h-5 w-5 text-amber-600" />Extra Report</CardTitle></CardHeader>
                  <CardContent className="max-h-80 overflow-auto">
                    {sessionExtras.length ? sessionExtras.map((extra) => (
                      <div key={extra.id} className="flex items-center justify-between border-b py-3 last:border-0">
                        <div>
                          <p className="font-medium">{extra.itemName}</p>
                          <p className="text-xs text-gray-500">{extra.sku || extra.code} — {extra.reason === "not_in_order" ? "Not in CSV order" : "Not in inventory"}</p>
                        </div>
                        <Badge variant="outline">x{extra.quantity}</Badge>
                      </div>
                    )) : <p className="py-8 text-center text-sm text-gray-500">Extra scanned boxes will be listed separately.</p>}
                  </CardContent>
                </Card>
              </div>
            </div>

            <Card className="rounded-md order-first lg:order-last">
              <CardHeader><CardTitle className="flex items-center text-lg"><Camera className="mr-2 h-5 w-5 text-[#001d6e]" />Scanner</CardTitle></CardHeader>
              <CardContent className="space-y-4">
                <div className="aspect-[4/3] overflow-hidden rounded-md bg-black">
                  <video ref={videoRef} className="h-full w-full object-cover" muted playsInline />
                </div>
                <div className="grid grid-cols-2 gap-2">
                  <Button onClick={startScanner} disabled={isScanning} className="bg-[#001d6e] hover:bg-[#00154b]">
                    <Play className="mr-2 h-4 w-4" />Start
                  </Button>
                  <Button variant="outline" onClick={() => { stopScanner(); startScanner(); }}>
                    <RotateCcw className="mr-2 h-4 w-4" />Restart
                  </Button>
                </div>
                <div className="space-y-2">
                  <Label htmlFor="manual-scan">Manual QR / SKU Entry</Label>
                  <div className="flex gap-2">
                    <Input id="manual-scan" value={manualCode} onChange={(e) => setManualCode(e.target.value)} onKeyDown={(e) => e.key === "Enter" && submitManualCode()} placeholder="Scan or type box code" />
                    <Button variant="outline" onClick={submitManualCode}><Keyboard className="h-4 w-4" /></Button>
                  </div>
                </div>
                <p className="text-xs text-gray-500">Every matched scan is recorded against the loaded CSV order. Boxes not in this CSV are kept in the extra report.</p>
              </CardContent>
            </Card>
          </div>
        </div>

        {/* Scan Confirmation Dialog */}
        <Dialog open={pendingScan !== null} onOpenChange={(open) => { if (!open) { setPendingScan(null); setPendingQty("1"); lastScanRef.current = { code: "", at: 0 }; } }}>
          <DialogContent className="sm:max-w-md">
            <DialogHeader>
              <DialogTitle className="flex items-center gap-2"><ScanLine className="h-5 w-5 text-[#001d6e]" />Confirm Scan</DialogTitle>
              <DialogDescription>Review the product details fetched from inventory and adjust quantity if needed.</DialogDescription>
            </DialogHeader>

            {pendingScan && (
              <div className="space-y-4 py-2">
                <div className="rounded-lg border bg-gray-50 p-4 space-y-2">
                  <p className="font-semibold text-gray-900 text-base leading-tight">{pendingScan.product?.name ?? "Unknown Product"}</p>
                  <div className="flex flex-wrap gap-x-6 gap-y-1 text-sm text-gray-600">
                    <span><span className="font-medium text-gray-700">Barcode:</span> <span className="font-mono">{pendingScan.code}</span></span>
                    {pendingScan.product?.itemNo && <span><span className="font-medium text-gray-700">SKU:</span> {pendingScan.product.itemNo}</span>}
                    {pendingScan.product?.sapCode && <span><span className="font-medium text-gray-700">SAP:</span> {pendingScan.product.sapCode}</span>}
                  </div>

                  {(() => {
                    const qty = Math.max(1, parseInt(pendingQty) || 1);
                    const ipp = pendingScan.itemsPerPallet;
                    // Show exact decimal: 31/30 = 1.03 (not rounded up)
                    const calculatedPallets = ipp > 0 ? (qty / ipp) : null;
                    const palletDisplay = calculatedPallets !== null
                      ? parseFloat(calculatedPallets.toFixed(2))
                      : null;

                    return (
                      <div className="mt-3 flex gap-3">
                        <div className="flex-1 rounded-md bg-white border px-3 py-2 text-center">
                          <p className="text-xs text-gray-500 mb-0.5">Current Stock</p>
                          <p className="text-xl font-bold text-gray-800">{pendingScan.product?.inStock ?? <span className="text-gray-400">—</span>}</p>
                        </div>
                        <div className="flex-1 rounded-md bg-white border px-3 py-2 text-center">
                          <p className="text-xs text-gray-500 mb-0.5 flex items-center justify-center gap-1"><Layers className="h-3 w-3" />Pallets</p>
                          {palletDisplay !== null
                            ? <p className="text-xl font-bold text-[#001d6e]">{palletDisplay}</p>
                            : <p className="text-sm text-gray-400 mt-1">Not set</p>}
                          {palletDisplay !== null && ipp > 0 && (
                            <p className="text-xs text-gray-400 mt-0.5">{qty}/{ipp}</p>
                          )}
                        </div>
                        <div className="flex-1 rounded-md bg-white border px-3 py-2 text-center">
                          <p className="text-xs text-gray-500 mb-0.5">Order Match</p>
                          {pendingScan.matchedItem ? <Badge className="mt-0.5 bg-emerald-100 text-emerald-800 hover:bg-emerald-100">✓ In Order</Badge> : <Badge variant="outline" className="mt-0.5 border-amber-400 text-amber-700">Extra</Badge>}
                        </div>
                      </div>
                    );
                  })()}
                </div>

                <div className="space-y-2">
                  <Label htmlFor="confirm-qty" className="flex items-center gap-1.5">
                    <Pencil className="h-3.5 w-3.5" />Quantity to Add
                  </Label>
                  <div className="flex gap-2 items-center">
                    <Input id="confirm-qty" type="number" min={1} value={pendingQty} onChange={(e) => setPendingQty(e.target.value)} onKeyDown={(e) => e.key === "Enter" && confirmPendingScan()} className="text-lg font-semibold h-11" autoFocus />
                    {pendingScan.itemsPerPallet > 0 && (
                      <Button type="button" variant="outline" size="sm" className="shrink-0 text-xs" onClick={() => setPendingQty(String(pendingScan.itemsPerPallet))}>
                        1 Pallet ({pendingScan.itemsPerPallet})
                      </Button>
                    )}
                  </div>
                  {pendingScan.itemsPerPallet > 0 && (
                    <p className="text-xs text-gray-500">
                      {pendingScan.itemsPerPallet} items/pallet — enter total boxes and pallets are calculated automatically.
                    </p>
                  )}
                </div>
              </div>
            )}

            <DialogFooter className="gap-2 sm:gap-0">
              <Button variant="outline" onClick={() => { setPendingScan(null); setPendingQty("1"); lastScanRef.current = { code: "", at: 0 }; }} disabled={isPostingScan}>Cancel</Button>
              <Button onClick={confirmPendingScan} disabled={isPostingScan || !pendingQty || parseInt(pendingQty) < 1} className="bg-[#001d6e] hover:bg-[#00154b]">
                {isPostingScan ? "Saving…" : `Confirm — Add ${pendingQty || 0} unit${parseInt(pendingQty || "0") !== 1 ? "s" : ""}`}
              </Button>
            </DialogFooter>
          </DialogContent>
        </Dialog>

        {/* Complete order confirmation */}
        <Dialog open={showCompleteConfirm} onOpenChange={setShowCompleteConfirm}>
          <DialogContent>
            <DialogHeader>
              <DialogTitle>Complete Scan Order?</DialogTitle>
              <DialogDescription>
                <span className="font-medium text-gray-800">{activeSession.orderName}</span>
                <span className="text-gray-500"> — {totals.scanned} of {totals.expected} boxes scanned.</span>
                {totals.scanned < totals.expected && (
                  <p className="mt-2 text-amber-600 text-sm">
                    Warning: {totals.expected - totals.scanned} boxes are still pending. Marking as complete cannot be undone.
                  </p>
                )}
              </DialogDescription>
            </DialogHeader>
            <DialogFooter className="gap-2 sm:gap-0">
              <Button variant="outline" onClick={() => setShowCompleteConfirm(false)}>
                Cancel
              </Button>
              <Button
                className="bg-[#001d6e] hover:bg-[#00154b]"
                disabled={completeSessionMutation.isPending}
                onClick={() => {
                  completeSessionMutation.mutate(activeSession.id);
                  setShowCompleteConfirm(false);
                }}
              >
                <CheckCircle2 className="mr-2 h-4 w-4" />
                {completeSessionMutation.isPending ? "Completing…" : "Yes, Complete"}
              </Button>
            </DialogFooter>
          </DialogContent>
        </Dialog>
      </div>
    );
  }

  // ── Dashboard ─────────────────────────────────────────────────────────────

  const activeSessions = sessions.filter((s) => s.status === "scanning");
  const completedSessions = sessions.filter((s) => s.status === "completed");
  const totalScanned = sessions.reduce((sum, s) => sum + (s.totalScanned ?? 0), 0);
  const totalExtras = sessions.reduce((sum, s) => sum + (s.totalExtras ?? 0), 0);

  // ── Embedded order-scan view (replaces dashboard when admin CSV is active) ─
  if (activeOrderScanSession) {
    const osItems = osItemsQuery.data ?? [];
    const osFiltered = osSearch
      ? osItems.filter((i) =>
          [i.barcode, i.itemName, i.sapCode].some((v) => v?.toLowerCase().includes(osSearch.toLowerCase()))
        )
      : osItems;
    const osDoneCount = osItems.filter((i) => i.status === "complete").length;
    const osTotalCount = osItems.length;
    const osPct = osTotalCount ? Math.round((osDoneCount / osTotalCount) * 100) : 0;
    const stvs = osStvsQuery.data ?? [];
    // Use plant-specific pallet size from inventory (valPlt/indPlt) as the multiplier
    const plt = osPending?.plantPalletSize ?? osPending?.matchedItem?.itemsPerPallet ?? 1;
    const NO_STV = "__none__";
    // True when the CSV item exists but is already fully scanned — extra boxes coming in
    const osItemIsComplete = osPending?.matchedItem
      ? (osPending.matchedItem.totalScannedQty ?? 0) >= (osPending.matchedItem.expectedQty ?? 1)
      : false;

    return (
      <div className="flex-1 overflow-y-auto bg-gray-50 p-4 lg:p-6">
        <div className="mx-auto max-w-7xl space-y-4">

          {/* Header row */}
          <div className="flex items-center justify-between gap-3 flex-wrap">
            <div className="flex items-center gap-3 min-w-0">
              <div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg bg-amber-400">
                <Zap className="h-4 w-4 text-white" />
              </div>
              <div className="min-w-0">
                <p className="text-sm font-bold text-gray-900 leading-tight truncate max-w-xs sm:max-w-sm">{activeOrderScanSession.csvFileName}</p>
                <p className="text-xs text-gray-500 truncate">
                  {activeOrderScanSession.plant}
                  {activeOrderScanSession.importedByName && ` · loaded by ${activeOrderScanSession.importedByName}`}
                </p>
              </div>
            </div>
            <div className="flex items-center gap-3 shrink-0">
              <div className="hidden sm:flex items-center gap-2">
                <Progress value={osPct} className="w-28 h-2" />
                <span className="text-xs font-medium text-gray-600 whitespace-nowrap">{osDoneCount}/{osTotalCount} done</span>
              </div>
            </div>
          </div>

          {/* Mobile progress */}
          <div className="sm:hidden flex items-center gap-2">
            <Progress value={osPct} className="flex-1 h-1.5" />
            <span className="text-xs text-gray-500 shrink-0">{osPct}% · {osDoneCount}/{osTotalCount}</span>
          </div>

          {/* Two-column layout */}
          <div className="grid gap-4 lg:grid-cols-[1fr_300px]">

            {/* Items table */}
            <div className="order-2 lg:order-1">
              <Card className="rounded-xl shadow-sm">
                <CardHeader className="pb-2 pt-4 px-4">
                  <div className="flex items-center justify-between mb-2">
                    <CardTitle className="text-base">CSV Items</CardTitle>
                    <span className="text-xs text-gray-400">{osDoneCount} / {osTotalCount} done</span>
                  </div>
                  <div className="relative">
                    <Search className="absolute left-3 top-2.5 h-3.5 w-3.5 text-gray-400" />
                    <Input
                      value={osSearch}
                      onChange={(e) => setOsSearch(e.target.value)}
                      placeholder="Search by name or barcode…"
                      className="pl-8 h-8 text-sm"
                    />
                    {osSearch && (
                      <button className="absolute right-2 top-2" onClick={() => setOsSearch("")}>
                        <X className="h-4 w-4 text-gray-400" />
                      </button>
                    )}
                  </div>
                </CardHeader>
                <CardContent className="p-0">
                  {osItemsQuery.isLoading ? (
                    <div className="flex justify-center py-10">
                      <Loader2 className="h-6 w-6 animate-spin text-[#001d6e]" />
                    </div>
                  ) : (
                    <div className="overflow-x-auto overflow-y-auto max-h-[560px]">
                      <table className="w-full text-sm">
                        <thead className="sticky top-0 z-10">
                          <tr className="border-b bg-slate-50">
                            <th className="w-8 px-3 py-2 bg-slate-50" />
                            <th className="px-3 py-2 text-left text-xs font-semibold text-gray-600 bg-slate-50">Item</th>
                            <th className="px-3 py-2 text-left text-xs font-semibold text-gray-600 bg-slate-50">Barcode</th>
                            <th className="px-3 py-2 text-right text-xs font-semibold text-gray-600 bg-slate-50">Exp</th>
                            <th className="px-3 py-2 text-right text-xs font-semibold text-gray-600 bg-slate-50">Done</th>
                            <th className="px-3 py-2 text-right text-xs font-semibold text-purple-700 bg-slate-50">Pallets</th>
                            <th className="px-3 py-2 text-right text-xs font-semibold text-[#001d6e] bg-slate-50">Remain</th>
                            <th className="px-3 py-2 text-right text-xs font-semibold text-amber-600 bg-slate-50">Extra</th>
                            <th className="px-3 py-2 text-left text-xs font-semibold text-gray-600 bg-slate-50">Status</th>
                          </tr>
                        </thead>
                        <tbody>
                          {osFiltered.map((item) => (
                            <tr
                              key={item.id}
                              className={`border-b transition-colors ${
                                item.status === "complete" ? "bg-green-50/40" :
                                item.status === "partial" ? "bg-amber-50/30" : ""
                              }`}
                            >
                              <td className="px-3 py-2.5">
                                {item.status === "complete"
                                  ? <CheckCircle2 className="h-4 w-4 text-green-500" />
                                  : item.status === "partial"
                                  ? <ScanLine className="h-4 w-4 text-amber-500" />
                                  : <span className="inline-block h-4 w-4 rounded-full border-2 border-gray-300" />}
                              </td>
                              <td className="max-w-[200px] truncate px-3 py-2.5 text-xs font-medium">{item.itemName ?? "—"}</td>
                              <td className="px-3 py-2.5 font-mono text-xs text-gray-400">{item.barcode ?? "—"}</td>
                              <td className="px-3 py-2.5 text-xs text-right">{item.expectedQty}</td>
                              <td className="px-3 py-2.5 text-xs text-right font-semibold">
                                {Math.min(item.totalScannedQty ?? 0, item.expectedQty ?? 0)}
                              </td>
                              <td className="px-3 py-2.5 text-xs text-right font-semibold">
                                {(item.scannedPallets ?? 0) > 0
                                  ? <span className="text-purple-700">{item.scannedPallets}</span>
                                  : <span className="text-gray-300">—</span>}
                              </td>
                              <td className="px-3 py-2.5 text-xs text-right font-semibold">
                                {(() => {
                                  const rem = Math.max(0, (item.expectedQty ?? 0) - (item.totalScannedQty ?? 0));
                                  return rem > 0
                                    ? <span className="text-[#001d6e]">{rem}</span>
                                    : <span className="text-gray-300">—</span>;
                                })()}
                              </td>
                              <td className="px-3 py-2.5 text-xs text-right font-semibold">
                                {(item.totalScannedQty ?? 0) > (item.expectedQty ?? 0)
                                  ? <span className="text-amber-600">+{(item.totalScannedQty ?? 0) - (item.expectedQty ?? 0)}</span>
                                  : <span className="text-gray-300">—</span>}
                              </td>
                              <td className="px-3 py-2.5">
                                {item.status === "complete"
                                  ? <Badge className="bg-green-100 text-green-800 text-[11px] border-0 px-1.5 hover:bg-green-100">Done</Badge>
                                  : item.status === "partial"
                                  ? <Badge className="bg-amber-100 text-amber-800 text-[11px] border-0 px-1.5 hover:bg-amber-100">Partial</Badge>
                                  : <Badge variant="outline" className="text-gray-400 text-[11px] px-1.5">Pending</Badge>}
                              </td>
                            </tr>
                          ))}
                        </tbody>
                      </table>
                      {osFiltered.length === 0 && !osItemsQuery.isLoading && (
                        <p className="py-10 text-center text-sm text-gray-400">
                          {osItems.length === 0 ? "Loading items…" : "No items match the search."}
                        </p>
                      )}
                    </div>
                  )}
                </CardContent>
              </Card>
            </div>

            {/* Scanner panel */}
            <div className="order-1 lg:order-2 space-y-3">
              {/* Mode toggle */}
              <div className="flex gap-2">
                <Button
                  size="sm"
                  variant={osScanMode === "camera" ? "default" : "outline"}
                  className={`flex-1 ${osScanMode === "camera" ? "bg-[#001d6e] hover:bg-[#00154b] text-white" : ""}`}
                  onClick={() => setOsScanMode("camera")}
                >
                  <Camera className="mr-2 h-4 w-4" /> Camera
                </Button>
                <Button
                  size="sm"
                  variant={osScanMode === "manual" ? "default" : "outline"}
                  className={`flex-1 ${osScanMode === "manual" ? "bg-[#001d6e] hover:bg-[#00154b] text-white" : ""}`}
                  onClick={() => { stopOsCamera(); setOsScanMode("manual"); }}
                >
                  <Keyboard className="mr-2 h-4 w-4" /> Manual
                </Button>
              </div>

              {/* Camera feed */}
              {osScanMode === "camera" && (
                <Card className="rounded-xl overflow-hidden shadow-sm">
                  <div className="relative bg-black aspect-video">
                    <video ref={osVideoRef} className="h-full w-full object-cover" autoPlay muted playsInline />
                    {!osCameraReady && !osCameraError && (
                      <div className="absolute inset-0 flex flex-col items-center justify-center text-white gap-2">
                        <Loader2 className="h-8 w-8 animate-spin" />
                        <p className="text-sm">Starting camera…</p>
                      </div>
                    )}
                    {osCameraReady && (
                      <div className="pointer-events-none absolute inset-0 flex items-center justify-center">
                        <div className="h-16 w-48 rounded border-2 border-white/70" />
                      </div>
                    )}
                  </div>
                  {osCameraError && (
                    <div className="flex items-center gap-2 bg-red-50 p-3 text-xs text-red-700">
                      <AlertTriangle className="h-3.5 w-3.5 shrink-0" />
                      {osCameraError}
                    </div>
                  )}
                </Card>
              )}

              {/* Manual input */}
              {osScanMode === "manual" && (
                <Card className="rounded-xl shadow-sm">
                  <CardContent className="p-4 space-y-2">
                    <Label className="text-sm font-medium">Enter barcode</Label>
                    <div className="flex gap-2">
                      <Input
                        value={osManualCode}
                        onChange={(e) => setOsManualCode(e.target.value)}
                        onKeyDown={(e) => {
                          if (e.key === "Enter" && osManualCode.trim()) {
                            handleOsBarcode(osManualCode.trim());
                            setOsManualCode("");
                          }
                        }}
                        placeholder="Scan or type barcode…"
                        disabled={!!osPending}
                        className="font-mono text-sm"
                        autoFocus
                      />
                      <Button
                        size="sm"
                        disabled={!osManualCode.trim() || !!osPending}
                        onClick={() => {
                          if (osManualCode.trim()) {
                            handleOsBarcode(osManualCode.trim());
                            setOsManualCode("");
                          }
                        }}
                        className="bg-[#001d6e] hover:bg-[#00154b] text-white shrink-0"
                      >
                        <ScanLine className="h-4 w-4" />
                      </Button>
                    </div>
                  </CardContent>
                </Card>
              )}

              {/* Recent scans */}
              {osRecentScans.length > 0 && (
                <Card className="rounded-xl shadow-sm">
                  <CardHeader className="pb-2 pt-3 px-4">
                    <CardTitle className="text-xs font-semibold uppercase tracking-wide text-gray-500">Recent Scans</CardTitle>
                  </CardHeader>
                  <CardContent className="px-4 pb-3 space-y-1.5">
                    {osRecentScans.map((s, i) => (
                      <div key={i} className={`flex items-center justify-between rounded px-2 py-1.5 text-xs ${s.isExtra ? "bg-orange-50" : "bg-green-50"}`}>
                        <p className="truncate font-medium max-w-[170px]">{s.name}</p>
                        <span className={`font-mono shrink-0 ml-2 ${s.isExtra ? "text-orange-700" : "text-green-700"}`}>
                          {s.isExtra ? "EXTRA" : `qty: ${s.total}`}
                        </span>
                      </div>
                    ))}
                  </CardContent>
                </Card>
              )}
            </div>
          </div>
        </div>

        {/* Multi-match selection dialog */}
        <Dialog open={!!osMultiMatch} onOpenChange={(o) => { if (!o) setOsMultiMatch(null); }}>
          <DialogContent className="max-w-sm">
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
              <Button variant="outline" onClick={() => setOsMultiMatch(null)}>Cancel</Button>
            </DialogFooter>
          </DialogContent>
        </Dialog>

        {/* Scan confirmation dialog */}
        <Dialog open={!!osPending} onOpenChange={(o) => { if (!o) { setOsPending(null); osPendingRef.current = null; setOsSelectedStv(""); } }}>
          <DialogContent className="max-w-sm">
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
              <DialogDescription className="text-left pt-1 space-y-0.5">
                <p className="font-semibold text-gray-900 text-sm">{osPending?.matchedItem?.itemName ?? "Unknown item"}</p>
                <p className="font-mono text-xs text-gray-400">{osPending?.barcode}</p>
                {!osPending?.matchedItem && (
                  <p className="text-xs text-red-600 mt-1">Not in the CSV — will be logged as extra.</p>
                )}
                {osItemIsComplete && (
                  <p className="text-xs text-amber-600 mt-1">Order already complete — these extra boxes will be logged separately.</p>
                )}
              </DialogDescription>
            </DialogHeader>

            <div className="space-y-4 py-1">
              {/* Inventory + CSV info */}
              {(osPending?.inventoryProduct || osPending?.matchedItem) && (
                <div className="rounded-md bg-gray-50 px-3 py-2 text-xs text-gray-600 space-y-1">
                  {osPending.inventoryProduct && (
                    <>
                      <p className="font-semibold text-gray-800 truncate">{osPending.inventoryProduct.name}</p>
                      {osPending.inventoryProduct.sapCode && (
                        <p>SAP: <span className="font-mono font-bold text-gray-700">{osPending.inventoryProduct.sapCode}</span></p>
                      )}
                    </>
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
                      lastSelectedStvRef.current = nextValue;
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
              
              {/* Qty input — user edits boxes; pallets auto-calculated */}
              <div className="space-y-1">
                <Label className="text-sm">Qty (boxes)</Label>
                <Input
                  type="number" min={0}
                  value={osQty === 0 ? "" : osQty}
                  onChange={(e) => setOsQty(parseInt(e.target.value) || 0)}
                  onBlur={(e) => { if (!e.target.value || parseInt(e.target.value) < 1) setOsQty(1); }}
                  className="text-center text-3xl font-bold h-14"
                  autoFocus
                />
              </div>

              {/* Auto-calculated pallets (read-only) */}
              {plt > 1 && (
                <div className="rounded-md bg-[#001d6e]/5 border border-[#001d6e]/20 px-4 py-3 flex items-center justify-between">
                  <div>
                    <p className="text-xs text-gray-500">Pallets</p>
                    <p className="text-2xl font-bold text-[#001d6e]">
                      {osQty > 0 ? (osQty / plt).toFixed(2) : "—"}
                    </p>
                  </div>
                  <div className="text-right">
                    <p className="text-xs text-gray-500">Pallet size</p>
                    <p className="text-lg font-semibold text-gray-700">{plt} <span className="text-xs font-normal text-gray-400">boxes</span></p>
                  </div>
                </div>
              )}
            </div>

            <DialogFooter className="gap-2">
              <Button variant="outline" onClick={() => { setOsPending(null); osPendingRef.current = null; }}>
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

        {/* Order completion dialog — auto-shown when all CSV items reach "complete" */}
        <Dialog open={showOsComplete} onOpenChange={(o) => { if (!o) setShowOsComplete(false); }}>
          <DialogContent className="max-w-sm text-center">
            <DialogHeader>
              <div className="flex justify-center mb-2">
                <div className="flex h-16 w-16 items-center justify-center rounded-full bg-green-100">
                  <CheckCircle2 className="h-9 w-9 text-green-600" />
                </div>
              </div>
              <DialogTitle className="text-xl text-green-700 text-center">All Items Scanned!</DialogTitle>
              <DialogDescription className="text-center space-y-1 pt-1">
                <p className="text-sm text-gray-600">
                  Every item in <span className="font-semibold text-gray-900">{activeOrderScanSession?.csvFileName}</span> has been fully scanned.
                </p>
                <p className="text-xs text-gray-400">{activeOrderScanSession?.plant}</p>
              </DialogDescription>
            </DialogHeader>

            <div className="grid grid-cols-2 gap-3 py-2">
              <div className="rounded-lg bg-green-50 px-3 py-3 text-center">
                <p className="text-2xl font-bold text-green-700">{osItemsQuery.data?.length ?? 0}</p>
                <p className="text-xs text-green-600 mt-0.5">Items done</p>
              </div>
              <div className="rounded-lg bg-blue-50 px-3 py-3 text-center">
                <p className="text-2xl font-bold text-[#001d6e]">
                  {osItemsQuery.data?.reduce((s, i) => s + i.totalScannedQty, 0) ?? 0}
                </p>
                <p className="text-xs text-blue-600 mt-0.5">Total boxes</p>
              </div>
            </div>

            <DialogFooter className="flex-col gap-2 sm:flex-col">
              <Button
                onClick={() => osCompleteMutation.mutate()}
                disabled={osCompleteMutation.isPending}
                className="w-full bg-green-600 hover:bg-green-700 text-white"
              >
                {osCompleteMutation.isPending && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
                Complete Order
              </Button>
              <Button
                variant="outline"
                className="w-full"
                onClick={() => setShowOsComplete(false)}
                disabled={osCompleteMutation.isPending}
              >
                Keep Scanning (add extras)
              </Button>
            </DialogFooter>
          </DialogContent>
        </Dialog>
      </div>
    );
  }

  return (
    <div className="flex-1 overflow-y-auto bg-gray-50 p-4 lg:p-6">
      <div className="mx-auto max-w-5xl space-y-5">
        <CameraPermissionBanner onPermissionGranted={() => toast({ title: "Camera Permission Granted", description: "You can now start scanning. Click 'New Scan Order' to begin." })} />

        {/* Header */}
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div>
            <div className="flex items-center gap-2 mb-0.5">
              <User className="h-4 w-4 text-gray-400" />
              <span className="text-sm text-gray-500">{currentUser?.name || currentUser?.username || "Your"}'s orders</span>
            </div>
            <h1 className="text-2xl font-semibold text-gray-950">Scan Order Dashboard</h1>
            <p className="text-sm text-gray-500 mt-0.5">Your stock arrival scan orders and history.</p>
          </div>
          <Button onClick={() => { resetDraft(); importsQuery.refetch(); setView("map"); }} className="bg-[#001d6e] hover:bg-[#00154b] h-11 px-6 text-base">
            <Plus className="mr-2 h-5 w-5" />New Scan Order
          </Button>
        </div>

        {/* Stats */}
        <div className="grid gap-3 sm:grid-cols-4">
          <Card className="rounded-xl border-0 shadow-sm">
            <CardContent className="p-4">
              <div className="flex items-center justify-between mb-2">
                <p className="text-xs font-medium text-gray-500 uppercase tracking-wide">Active</p>
                <div className="h-7 w-7 rounded-full bg-blue-50 flex items-center justify-center">
                  <ScanLine className="h-3.5 w-3.5 text-[#001d6e]" />
                </div>
              </div>
              <p className="text-3xl font-bold text-gray-900">{activeSessions.length}</p>
              <p className="text-xs text-gray-400 mt-0.5">in progress</p>
            </CardContent>
          </Card>
          <Card className="rounded-xl border-0 shadow-sm">
            <CardContent className="p-4">
              <div className="flex items-center justify-between mb-2">
                <p className="text-xs font-medium text-gray-500 uppercase tracking-wide">Completed</p>
                <div className="h-7 w-7 rounded-full bg-emerald-50 flex items-center justify-center">
                  <CheckCircle2 className="h-3.5 w-3.5 text-emerald-600" />
                </div>
              </div>
              <p className="text-3xl font-bold text-gray-900">{completedSessions.length}</p>
              <p className="text-xs text-gray-400 mt-0.5">orders done</p>
            </CardContent>
          </Card>
          <Card className="rounded-xl border-0 shadow-sm">
            <CardContent className="p-4">
              <div className="flex items-center justify-between mb-2">
                <p className="text-xs font-medium text-gray-500 uppercase tracking-wide">Boxes Scanned</p>
                <div className="h-7 w-7 rounded-full bg-indigo-50 flex items-center justify-center">
                  <PackageCheck className="h-3.5 w-3.5 text-indigo-600" />
                </div>
              </div>
              <p className="text-3xl font-bold text-gray-900">{totalScanned}</p>
              <p className="text-xs text-gray-400 mt-0.5">total units</p>
            </CardContent>
          </Card>
          <Card className="rounded-xl border-0 shadow-sm">
            <CardContent className="p-4">
              <div className="flex items-center justify-between mb-2">
                <p className="text-xs font-medium text-gray-500 uppercase tracking-wide">Extras</p>
                <div className="h-7 w-7 rounded-full bg-amber-50 flex items-center justify-center">
                  <AlertTriangle className="h-3.5 w-3.5 text-amber-600" />
                </div>
              </div>
              <p className="text-3xl font-bold text-gray-900">{totalExtras}</p>
              <p className="text-xs text-gray-400 mt-0.5">not in orders</p>
            </CardContent>
          </Card>
        </div>

        {/* Active orders */}
        {activeSessions.length > 0 && (
          <div className="space-y-2">
            <h2 className="text-sm font-semibold text-gray-700 uppercase tracking-wide flex items-center gap-2">
              <span className="h-2 w-2 rounded-full bg-blue-500 inline-block" />
              In Progress
            </h2>
            <div className="space-y-3">
              {activeSessions.map((session) => {
                const pct = session.totalExpected > 0 ? Math.round((session.totalScanned / session.totalExpected) * 100) : 0;
                return (
                  <Card key={session.id} className="rounded-xl border-0 shadow-sm hover:shadow-md transition-shadow cursor-pointer" onClick={() => loadFullSession(session.id)}>
                    <CardContent className="p-4">
                      <div className="flex items-start justify-between gap-3">
                        <div className="min-w-0 flex-1">
                          <div className="flex items-center gap-2 mb-0.5">
                            <Badge className="bg-blue-100 text-blue-800 hover:bg-blue-100 text-xs px-2 py-0">Scanning</Badge>
                            {(session.totalExtras ?? 0) > 0 && (
                              <Badge variant="outline" className="border-amber-300 text-amber-700 text-xs px-2 py-0">{session.totalExtras} extra</Badge>
                            )}
                          </div>
                          <p className="font-semibold text-gray-900 truncate">{session.orderName}</p>
                          <p className="text-xs text-gray-400 truncate">{session.csvName}</p>
                        </div>
                        <Button size="sm" className="bg-[#001d6e] hover:bg-[#00154b] shrink-0" onClick={(e) => { e.stopPropagation(); loadFullSession(session.id); }}>
                          Resume
                        </Button>
                      </div>
                      <div className="mt-3 space-y-1">
                        <div className="flex justify-between text-xs text-gray-500">
                          <span>{session.totalScanned ?? 0} scanned</span>
                          <span>{pct}% of {session.totalExpected ?? 0}</span>
                        </div>
                        <Progress value={pct} className="h-1.5" />
                      </div>
                      <p className="text-xs text-gray-400 mt-2">Updated {new Date(session.updatedAt).toLocaleString()}</p>
                    </CardContent>
                  </Card>
                );
              })}
            </div>
          </div>
        )}

        {/* Completed orders */}
        <div className="space-y-2">
          <h2 className="text-sm font-semibold text-gray-700 uppercase tracking-wide flex items-center gap-2">
            <History className="h-3.5 w-3.5 text-gray-400" />
            History
          </h2>
          {completedSessions.length === 0 && activeSessions.length === 0 ? (
            <Card className="rounded-xl border-0 shadow-sm">
              <CardContent className="py-16 text-center">
                <ScanLine className="h-10 w-10 text-gray-200 mx-auto mb-3" />
                <p className="text-gray-500 font-medium">No scan orders yet</p>
                <p className="text-sm text-gray-400 mt-1">Click "New Scan Order" to get started.</p>
              </CardContent>
            </Card>
          ) : completedSessions.length === 0 ? (
            <Card className="rounded-xl border-0 shadow-sm">
              <CardContent className="py-10 text-center">
                <p className="text-sm text-gray-400">Completed orders will appear here.</p>
              </CardContent>
            </Card>
          ) : (
            <div className="space-y-2">
              {completedSessions.map((session) => {
                const pct = session.totalExpected > 0 ? Math.round((session.totalScanned / session.totalExpected) * 100) : 100;
                return (
                  <Card key={session.id} className="rounded-xl border-0 shadow-sm hover:shadow-md transition-shadow cursor-pointer" onClick={() => loadFullSession(session.id)}>
                    <CardContent className="p-4">
                      <div className="flex items-center justify-between gap-3">
                        <div className="min-w-0 flex-1">
                          <div className="flex items-center gap-2 mb-0.5">
                            <Badge className="bg-emerald-100 text-emerald-800 hover:bg-emerald-100 text-xs px-2 py-0">Completed</Badge>
                            {(session.totalExtras ?? 0) > 0 && (
                              <Badge variant="outline" className="border-amber-300 text-amber-700 text-xs px-2 py-0">{session.totalExtras} extra</Badge>
                            )}
                          </div>
                          <p className="font-medium text-gray-800 truncate">{session.orderName}</p>
                          <p className="text-xs text-gray-400 truncate">{session.csvName}</p>
                        </div>
                        <div className="text-right shrink-0">
                          <p className="text-sm font-semibold text-emerald-700">{session.totalScanned ?? 0}<span className="text-gray-400 font-normal">/{session.totalExpected ?? 0}</span></p>
                          <p className="text-xs text-gray-400">{new Date(session.updatedAt).toLocaleDateString()}</p>
                        </div>
                      </div>
                      <Progress value={pct} className="h-1 mt-3" />
                    </CardContent>
                  </Card>
                );
              })}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
