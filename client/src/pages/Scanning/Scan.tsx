import { useEffect, useMemo, useRef, useState } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import {
  AlertTriangle,
  ArrowLeft,
  Camera,
  CheckCircle2,
  FileSpreadsheet,
  History,
  Keyboard,
  PackageCheck,
  Layers,
  Pencil,
  Play,
  Plus,
  RotateCcw,
  ScanLine,
  Square,
} from "lucide-react";
import { Result } from "@zxing/library";
import BarcodeScanner from "@/lib/barcodeScanner";
import CameraPermissionBanner from "@/components/CameraPermissionBanner";
import { apiRequest } from "@/lib/queryClient";
import { useToast } from "@/hooks/use-toast";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
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
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";

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

  // ── Queries ──────────────────────────────────────────────────────────────

  const { data: productsRaw = [] } = useQuery<any>({
    queryKey: ["/api/products", { all: "true" }],
  });
  const products: Product[] = Array.isArray(productsRaw) ? productsRaw : (productsRaw?.results ?? []);

  const { data: sessionsRaw = [], refetch: refetchSessions } = useQuery<SessionSummary[]>({
    queryKey: ["/api/scan-sessions"],
    queryFn: async () => {
      const r = await apiRequest("GET", "/api/scan-sessions", undefined, false, true);
      return Array.isArray(r) ? r : [];
    },
  });
  const sessions: SessionSummary[] = sessionsRaw;

  const importsQuery = useQuery<any>({
    queryKey: ["/api/orders/imports"],
    queryFn: async () => {
      const r = await apiRequest("GET", "/api/orders/imports", undefined, false, true);
      if (Array.isArray(r)) return r;
      if (r && Array.isArray(r.results)) return r.results;
      return [];
    },
    retry: false,
  });
  const { data: importSummariesRaw = [], error: importsError } = importsQuery as any;
  const importSummaries: { filename: string; orderCount: number; itemCount: number; lastImportedAt: string }[] =
    Array.isArray(importSummariesRaw) ? importSummariesRaw : [];

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
      setRecentItemIds([]);
      resetDraft();
      setView("scan");
    },
    onError: () => toast({ title: "Failed to create scan order", variant: "destructive" }),
  });

  const completeSessionMutation = useMutation({
    mutationFn: async (id: number) =>
      apiRequest("PATCH", `/api/scan-sessions/${id}`, { status: "completed" }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/scan-sessions"] });
      setActiveSession((s) => s ? { ...s, status: "completed" } : s);
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

  const loadImportItems = async () => {
    if (!selectedImport) return;
    const response = await apiRequest("GET", `/api/orders/imports/items?filename=${encodeURIComponent(selectedImport)}`, undefined, false, true) as ImportItemsResponse;
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
    setActiveSession({ ...data, items: data.items ?? [], extras: data.extras ?? [] });
    setScanActivities([]);
    setRecentItemIds([]);
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

  const handleScannedCode = async (rawCode: string) => {
    const code = rawCode.trim();
    if (!code || !activeSession || isPostingScan || pendingScan !== null) return;
    const now = Date.now();
    if (lastScanRef.current.code === code && now - lastScanRef.current.at < 1200) return;
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
      const defaultQty       = itemsPerPallet > 0 ? itemsPerPallet : 1;
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
    const userRaw = localStorage.getItem("currentUser");
    const user = userRaw ? JSON.parse(userRaw) : null;
    // Calculate and store the decimal pallet count: qty ÷ itemsPerPallet (e.g. 31/30 = 1.03)
    const numPallets = pendingScan.itemsPerPallet > 0
      ? parseFloat((qty / pendingScan.itemsPerPallet).toFixed(2))
      : null;
    setIsPostingScan(true);
    try {
      if (product) {
        await postStockScan(product, code, activeSession.orderName, qty);
        queryClient.invalidateQueries({ queryKey: ["/api/products"] });
        queryClient.invalidateQueries({ queryKey: ["/api/scans"] });
      }
      const scannedAt = new Date().toISOString();

      if (matchedItem) {
        // Float this item to the top of the CSV Order Items table on mobile
        setRecentItemIds((prev) => [matchedItem!.id, ...prev.filter((id) => id !== matchedItem!.id)]);

        // 1. Optimistic UI update immediately (functional form reads latest state, not stale closure)
        setActiveSession((s) => s ? {
          ...s,
          updatedAt: scannedAt,
          items: s.items.map((i) => i.id === matchedItem!.id ? { ...i, scannedQty: i.scannedQty + qty } : i),
        } : s);

        // 2. Persist scannedQty to DB with retry (up to 3 attempts)
        let saved = false;
        for (let attempt = 0; attempt < 3 && !saved; attempt++) {
          try {
            await apiRequest("PATCH", `/api/scan-sessions/${activeSession.id}/items/${matchedItem.id}`, { increment: qty, productId: product?.id ?? null }, false, true);
            saved = true;
          } catch {
            if (attempt < 2) await new Promise((r) => setTimeout(r, 400 * (attempt + 1)));
          }
        }
        if (!saved) {
          // Revert optimistic update and surface the error
          setActiveSession((s) => s ? {
            ...s,
            items: s.items.map((i) => i.id === matchedItem!.id ? { ...i, scannedQty: i.scannedQty - qty } : i),
          } : s);
          throw new Error("Failed to save scan after 3 attempts. Please try again.");
        }

        // 3. Pallet scan record — saved with retry (best-effort, won't revert scannedQty if it fails)
        postPalletScan(activeSession.id, {
          sessionItemId: matchedItem.id,
          barcode: product?.barcode || code,
          sku: product?.itemNo || product?.sapCode || product?.barcode || code,
          itemName: matchedItem.itemName,
          productId: product?.id,
          quantity: qty,
          numPallets,
          isExtra: false,
          scannedByCode: user?.userCode,
          scannedByName: user?.name || user?.username,
        });

        setScanActivities((prev) => [{ id: `act-${Date.now()}`, code, itemName: matchedItem.itemName, quantity: qty, scannedAt, type: "order" as const }, ...prev].slice(0, 50));
      } else {
        const extraName = product?.name ?? "Unknown product";

        // Persist extra scan with retry
        let saved = false;
        for (let attempt = 0; attempt < 3 && !saved; attempt++) {
          try {
            await apiRequest("POST", `/api/scan-sessions/${activeSession.id}/extras`, {
              code,
              itemName: extraName,
              sku: product?.itemNo || product?.sapCode || product?.barcode,
              productId: product?.id,
              quantity: qty,
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

        // Pallet scan record for extras — saved with retry (best-effort)
        postPalletScan(activeSession.id, {
          barcode: product?.barcode || code,
          sku: product?.itemNo || product?.sapCode || product?.barcode || code,
          itemName: extraName,
          productId: product?.id,
          quantity: qty,
          numPallets,
          isExtra: true,
          scannedByCode: user?.userCode,
          scannedByName: user?.name || user?.username,
        });

        // Update local extras
        const existing = (activeSession.extras ?? []).find((e) => e.code === code);
        setActiveSession((s) => {
          if (!s) return s;
          return {
            ...s,
            updatedAt: scannedAt,
            extras: existing
              ? s.extras.map((e) => e.code === code ? { ...e, quantity: e.quantity + qty, scannedAt } : e)
              : [{ id: Date.now(), code, itemName: extraName, sku: product?.itemNo || product?.sapCode || product?.barcode, quantity: qty, scannedAt, productId: product?.id, reason: product ? "not_in_order" as const : "unknown_product" as const }, ...s.extras],
          };
        });
        setScanActivities((prev) => [{ id: `act-${Date.now()}`, code, itemName: extraName, quantity: qty, scannedAt, type: "extra" as const }, ...prev].slice(0, 50));
      }

      queryClient.invalidateQueries({ queryKey: ["/api/scan-sessions"] });
      toast({
        title: matchedItem ? "Stock updated" : "Extra box recorded",
        description: product ? `${product.name} — ${qty} unit${qty !== 1 ? "s" : ""} added to stock.` : `${code} kept in the extra report (not in inventory).`,
        variant: matchedItem ? "default" : "destructive",
      });
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

  const submitManualCode = () => { handleScannedCode(manualCode); setManualCode(""); };

  // ─── Views ────────────────────────────────────────────────────────────────

  if (view === "map") {
    return (
      <div className="flex-1 overflow-y-auto bg-gray-50 p-4 lg:p-6">
        <div className="mx-auto max-w-7xl space-y-4">
          <div className="flex flex-wrap items-center justify-between gap-3">
            <div>
              <Button variant="ghost" className="mb-2 px-0" onClick={() => setView("dashboard")}>
                <ArrowLeft className="mr-2 h-4 w-4" />Back
              </Button>
              <h1 className="text-2xl font-semibold text-gray-950">Add New Scan Order</h1>
              <p className="text-sm text-gray-600">Upload yesterday's order CSV, review the rows, then start scanning boxes.</p>
            </div>
            <Button onClick={createOrder} disabled={!mappedItems.length || isCreatingOrder} className="bg-[#001d6e] hover:bg-[#00154b]">
              <ScanLine className="mr-2 h-4 w-4" />{isCreatingOrder ? "Creating…" : "Next"}
            </Button>
          </div>

          <div className="grid gap-4 lg:grid-cols-[360px_1fr]">
            <Card className="rounded-md">
              <CardHeader><CardTitle className="flex items-center text-lg"><FileSpreadsheet className="mr-2 h-5 w-5 text-[#001d6e]" />CSV Mapping</CardTitle></CardHeader>
              <CardContent className="space-y-5">
                <div className="space-y-2">
                  <Label>Arriving Order CSV (Uploaded)</Label>
                  <Select value={selectedImport} onValueChange={setSelectedImport}>
                    <SelectTrigger><SelectValue placeholder="Select uploaded CSV" /></SelectTrigger>
                    <SelectContent>
                      {importSummaries.length === 0 && <SelectItem value="no-imports" disabled>No uploaded CSVs found</SelectItem>}
                      {importSummaries.map((s) => <SelectItem key={s.filename} value={s.filename}>{s.filename}</SelectItem>)}
                    </SelectContent>
                  </Select>
                  <Button type="button" variant="outline" className="w-full" onClick={loadImportItems} disabled={!selectedImport}>
                    <PackageCheck className="mr-2 h-4 w-4" />Load Arriving Orders
                  </Button>
                  {selectedImport && <p className="text-xs text-gray-500">Using: {selectedImport}</p>}
                </div>

                {csvRows.length > 0 && csvMode === "pivot" && (
                  <div className="space-y-2">
                    <Label>Arriving Order / Dealer</Label>
                    <Select value={mappedColumn} onValueChange={setMappedColumn}>
                      <SelectTrigger><SelectValue placeholder="Select CSV order column" /></SelectTrigger>
                      <SelectContent>{pivotColumns.map((c) => <SelectItem key={c.label} value={c.label}>{c.label}</SelectItem>)}</SelectContent>
                    </Select>
                  </div>
                )}

                {csvRows.length > 0 && csvMode === "flat" && (
                  <div className="space-y-3">
                    <div className="space-y-2">
                      <Label>SKU / Barcode Column</Label>
                      <Select value={flatSkuColumn} onValueChange={setFlatSkuColumn}><SelectTrigger><SelectValue placeholder="Select SKU column" /></SelectTrigger><SelectContent>{flatHeaders.map((h) => <SelectItem key={h} value={h}>{h}</SelectItem>)}</SelectContent></Select>
                    </div>
                    <div className="space-y-2">
                      <Label>Item Name Column</Label>
                      <Select value={flatNameColumn} onValueChange={setFlatNameColumn}><SelectTrigger><SelectValue placeholder="Select name column" /></SelectTrigger><SelectContent>{flatHeaders.map((h) => <SelectItem key={h} value={h}>{h}</SelectItem>)}</SelectContent></Select>
                    </div>
                    <div className="space-y-2">
                      <Label>Quantity Column</Label>
                      <Select value={flatQtyColumn} onValueChange={setFlatQtyColumn}><SelectTrigger><SelectValue placeholder="Select quantity column" /></SelectTrigger><SelectContent>{flatHeaders.map((h) => <SelectItem key={h} value={h}>{h}</SelectItem>)}</SelectContent></Select>
                    </div>
                  </div>
                )}
              </CardContent>
            </Card>

            <Card className="rounded-md">
              <CardHeader><CardTitle className="text-lg">Loaded CSV Preview</CardTitle></CardHeader>
              <CardContent>
                <Table>
                  <TableHeader>
                    <TableRow>
                      <TableHead>Barcode / SKU</TableHead>
                      <TableHead>Item</TableHead>
                      <TableHead className="text-right">Order Qty</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {mappedItems.slice(0, 12).map((item, idx) => (
                      <TableRow key={idx}>
                        <TableCell className="font-mono text-xs">{bestCode(item)}</TableCell>
                        <TableCell className="max-w-[160px] truncate">{item.itemName}</TableCell>
                        <TableCell className="text-right font-medium">{item.expectedQty}</TableCell>
                      </TableRow>
                    ))}
                    {!mappedItems.length && <TableRow><TableCell colSpan={3} className="py-10 text-center text-gray-500">Upload a CSV and choose the correct order column.</TableCell></TableRow>}
                  </TableBody>
                </Table>
              </CardContent>
            </Card>
          </div>
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
            <div className="flex gap-2">
              <Button variant="outline" onClick={() => completeSessionMutation.mutate(activeSession.id)} disabled={activeSession.status === "completed"}>
                <CheckCircle2 className="mr-2 h-4 w-4" />Complete
              </Button>
              <Button variant="outline" onClick={stopScanner} disabled={!isScanning}>
                <Square className="mr-2 h-4 w-4" />Stop
              </Button>
            </div>
          </div>

          <div className="grid gap-4 lg:grid-cols-[1fr_420px]">
            <div className="space-y-4 order-last lg:order-first">
              <div className="grid gap-3 sm:grid-cols-4">
                <Card className="rounded-md"><CardContent className="p-4"><p className="text-xs text-gray-500">Order Items</p><p className="text-2xl font-semibold">{sessionItems.length}</p></CardContent></Card>
                <Card className="rounded-md"><CardContent className="p-4"><p className="text-xs text-gray-500">Expected</p><p className="text-2xl font-semibold">{totals.expected}</p></CardContent></Card>
                <Card className="rounded-md"><CardContent className="p-4"><p className="text-xs text-gray-500">Scanned</p><p className="text-2xl font-semibold text-emerald-700">{totals.scanned}</p></CardContent></Card>
                <Card className="rounded-md"><CardContent className="p-4"><p className="text-xs text-gray-500">Extras</p><p className="text-2xl font-semibold text-amber-700">{sessionExtras.reduce((s, e) => s + e.quantity, 0)}</p></CardContent></Card>
              </div>

              <Card className="rounded-md">
                <CardHeader><CardTitle className="text-lg">CSV Order Items</CardTitle></CardHeader>
                <CardContent>
                  <Table>
                    <TableHeader>
                      <TableRow>
                        <TableHead>Barcode / SKU</TableHead>
                        <TableHead>Item</TableHead>
                        <TableHead className="text-right">Inv. Stock</TableHead>
                        <TableHead className="text-right">Scanned / Order</TableHead>
                        <TableHead>Status</TableHead>
                      </TableRow>
                    </TableHeader>
                    <TableBody>
                      {sortedSessionItems.map((item) => {
                        const done = item.scannedQty >= item.expectedQty;
                        return (
                          <TableRow key={item.id}>
                            <TableCell className="font-mono text-xs">{bestCode(item)}</TableCell>
                            <TableCell className="max-w-[160px] truncate">{item.itemName}</TableCell>
                            <TableCell className="text-right">{item.inventoryQty != null ? <span className="font-semibold text-gray-700">{item.inventoryQty}</span> : <span className="text-gray-400 text-xs">—</span>}</TableCell>
                            <TableCell className="text-right font-medium">
                              <span className={item.scannedQty > 0 ? "text-emerald-700" : ""}>{item.scannedQty}</span>
                              <span className="text-gray-400">/{item.expectedQty}</span>
                            </TableCell>
                            <TableCell>
                              <Badge className={done ? "bg-emerald-100 text-emerald-800 hover:bg-emerald-100" : "bg-blue-100 text-blue-800 hover:bg-blue-100"}>
                                {done ? "Done" : "Pending"}
                              </Badge>
                            </TableCell>
                          </TableRow>
                        );
                      })}
                    </TableBody>
                  </Table>
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
      </div>
    );
  }

  // ── Dashboard ─────────────────────────────────────────────────────────────

  return (
    <div className="flex-1 overflow-y-auto bg-gray-50 p-4 lg:p-6">
      <div className="mx-auto max-w-7xl space-y-5">
        <CameraPermissionBanner onPermissionGranted={() => toast({ title: "Camera Permission Granted", description: "You can now start scanning. Click 'Add New Order' to begin." })} />

        <div className="flex flex-wrap items-center justify-between gap-3">
          <div>
            <h1 className="text-2xl font-semibold text-gray-950">Scan Order</h1>
            <p className="text-sm text-gray-600">Create an arrival order from CSV, scan box QR codes, and track stock arrivals.</p>
          </div>
          <Button onClick={() => { resetDraft(); setView("map"); }} className="bg-[#001d6e] hover:bg-[#00154b]">
            <Plus className="mr-2 h-4 w-4" />Add New Order
          </Button>
        </div>

        <div className="grid gap-4 sm:grid-cols-3">
          <Card className="rounded-md"><CardContent className="flex items-center gap-3 p-5"><PackageCheck className="h-9 w-9 text-emerald-600" /><div><p className="text-xs text-gray-500">Active Orders</p><p className="text-2xl font-semibold">{sessions.filter((s) => s.status === "scanning").length}</p></div></CardContent></Card>
          <Card className="rounded-md"><CardContent className="flex items-center gap-3 p-5"><ScanLine className="h-9 w-9 text-[#001d6e]" /><div><p className="text-xs text-gray-500">Boxes Scanned</p><p className="text-2xl font-semibold">{sessions.reduce((sum, s) => sum + (s.totalScanned ?? 0), 0)}</p></div></CardContent></Card>
          <Card className="rounded-md"><CardContent className="flex items-center gap-3 p-5"><AlertTriangle className="h-9 w-9 text-amber-600" /><div><p className="text-xs text-gray-500">Extra Boxes</p><p className="text-2xl font-semibold">{sessions.reduce((sum, s) => sum + (s.totalExtras ?? 0), 0)}</p></div></CardContent></Card>
        </div>

        <Card className="rounded-md">
          <CardHeader><CardTitle className="flex items-center text-lg"><History className="mr-2 h-5 w-5 text-[#001d6e]" />All Scan Orders</CardTitle></CardHeader>
          <CardContent>
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Order</TableHead>
                  <TableHead>CSV</TableHead>
                  <TableHead>Status</TableHead>
                  <TableHead className="text-right">Progress</TableHead>
                  <TableHead className="text-right">Extras</TableHead>
                  <TableHead>Updated</TableHead>
                  <TableHead className="text-right">Action</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {sessions.map((session) => (
                  <TableRow key={session.id}>
                    <TableCell className="font-medium">{session.orderName}</TableCell>
                    <TableCell className="text-gray-500 text-sm">{session.csvName}</TableCell>
                    <TableCell>
                      <Badge className={session.status === "completed" ? "bg-emerald-100 text-emerald-800 hover:bg-emerald-100" : "bg-blue-100 text-blue-800 hover:bg-blue-100"}>
                        {session.status === "completed" ? "Completed" : "Scanning"}
                      </Badge>
                    </TableCell>
                    <TableCell className="text-right font-medium">
                      <span className={(session.totalScanned ?? 0) > 0 ? "text-emerald-700" : ""}>{session.totalScanned ?? 0}</span>
                      <span className="text-gray-400">/{session.totalExpected ?? 0}</span>
                    </TableCell>
                    <TableCell className="text-right">
                      {(session.totalExtras ?? 0) > 0 ? <span className="text-amber-600 font-medium">{session.totalExtras}</span> : <span className="text-gray-400">—</span>}
                    </TableCell>
                    <TableCell className="text-sm text-gray-500">{new Date(session.updatedAt).toLocaleString()}</TableCell>
                    <TableCell className="text-right">
                      <Button size="sm" variant="outline" onClick={() => loadFullSession(session.id)}>
                        {session.status === "completed" ? "View" : "Resume"}
                      </Button>
                    </TableCell>
                  </TableRow>
                ))}
                {!sessions.length && (
                  <TableRow><TableCell colSpan={7} className="py-12 text-center text-gray-500">No scan orders yet. Add a new order to begin.</TableCell></TableRow>
                )}
              </TableBody>
            </Table>
          </CardContent>
        </Card>
      </div>
    </div>
  );
}
