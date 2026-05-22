import { useEffect, useMemo, useRef, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import {
  AlertTriangle,
  ArrowLeft,
  Camera,
  CheckCircle2,
  FileSpreadsheet,
  History,
  Keyboard,
  PackageCheck,
  Play,
  Plus,
  RotateCcw,
  ScanLine,
  Square,
  RefreshCw,
} from "lucide-react";
import { Result } from "@zxing/library";
import BarcodeScanner from "@/lib/barcodeScanner";
import { apiRequest } from "@/lib/queryClient";
import { useToast } from "@/hooks/use-toast";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
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

type Product = {
  id: number;
  name: string;
  barcode: string;
  itemNo?: string | null;
  sapCode?: string | null;
  srNo?: string | null;
  inStock?: number | null;
};

type OrderItem = {
  id: string;
  sku: string;
  itemName: string;
  expectedQty: number;
  scannedQty: number;
  productId?: number;
  barcode?: string;
  itemNo?: string | null;
  sapCode?: string | null;
};

type ExtraScan = {
  id: string;
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

type OrderSession = {
  id: string;
  orderName: string;
  csvName: string;
  mappedColumn: string;
  createdAt: string;
  updatedAt: string;
  status: "draft" | "scanning" | "completed";
  items: OrderItem[];
  extras: ExtraScan[];
  activities: ScanActivity[];
};

type ImportSummary = {
  filename: string;
  orderCount: number;
  itemCount: number;
  lastImportedAt: string;
};

type ImportItemsResponse = {
  filename: string;
  items: OrderItem[];
};

type CsvMode = "pivot" | "flat";

const STORAGE_KEY = "km_scan_order_sessions_v1";

const normalize = (value?: string | number | null) =>
  String(value ?? "").trim().toLowerCase();

const parseQuantity = (value?: string) => {
  const cleaned = String(value ?? "").replace(/,/g, "").trim();
  if (!cleaned) return 0;
  const parsed = Number(cleaned);
  return Number.isFinite(parsed) ? parsed : 0;
};

const splitSkuName = (value: string) => {
  const cleaned = value.trim();
  const match = cleaned.match(/^([^-\s]+)\s*-\s*(.+)$/);
  if (!match) return { sku: cleaned, itemName: cleaned };
  return { sku: match[1].trim(), itemName: match[2].trim() };
};

const parseCsv = (text: string) => {
  const rows: string[][] = [];
  let row: string[] = [];
  let cell = "";
  let inQuotes = false;

  for (let index = 0; index < text.length; index += 1) {
    const char = text[index];
    const next = text[index + 1];

    if (char === '"' && inQuotes && next === '"') {
      cell += '"';
      index += 1;
    } else if (char === '"') {
      inQuotes = !inQuotes;
    } else if (char === "," && !inQuotes) {
      row.push(cell.trim());
      cell = "";
    } else if ((char === "\n" || char === "\r") && !inQuotes) {
      if (char === "\r" && next === "\n") index += 1;
      row.push(cell.trim());
      if (row.some(Boolean)) rows.push(row);
      row = [];
      cell = "";
    } else {
      cell += char;
    }
  }

  row.push(cell.trim());
  if (row.some(Boolean)) rows.push(row);
  return rows;
};
const getSavedSessions = (): OrderSession[] => {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    return raw ? JSON.parse(raw) : [];
  } catch {
    return [];
  }
};

const saveSessions = (sessions: OrderSession[]) => {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(sessions.slice(0, 20)));
  } catch {
    // ignore
  }
};

const detectCsvMode = (rows: string[][]): CsvMode => {
  const firstCell = normalize(rows[0]?.[0]);
  const secondRowFirstCell = normalize(rows[1]?.[0]);
  if (firstCell.includes("customer") || secondRowFirstCell.includes("productcode")) {
    return "pivot";
  }
  return "flat";
};

export default function ScanOrderPage() {
  const { toast } = useToast();
  const queryClient = useQueryClient();
  const videoRef = useRef<HTMLVideoElement>(null);
  const scannerRef = useRef<BarcodeScanner | null>(null);
  const lastScanRef = useRef({ code: "", at: 0 });

  const [view, setView] = useState<"dashboard" | "map" | "scan">("dashboard");
  const [sessions, setSessions] = useState<OrderSession[]>([]);
  const [activeSessionId, setActiveSessionId] = useState<string | null>(null);
  const [csvRows, setCsvRows] = useState<string[][]>([]);
  const [csvName, setCsvName] = useState("");
  const [csvMode, setCsvMode] = useState<CsvMode>("pivot");
  const [mappedColumn, setMappedColumn] = useState("");
  const [selectedImport, setSelectedImport] = useState("");
  const [importItems, setImportItems] = useState<OrderItem[]>([]);
  const [flatSkuColumn, setFlatSkuColumn] = useState("");
  const [flatNameColumn, setFlatNameColumn] = useState("");
  const [flatQtyColumn, setFlatQtyColumn] = useState("");
  const [manualCode, setManualCode] = useState("");
  const [isScanning, setIsScanning] = useState(false);
  const [isPostingScan, setIsPostingScan] = useState(false);

  const { data: productsRaw = [] } = useQuery<any>({
    queryKey: ["/api/products", { all: "true" }],
  });
  const products: Product[] = Array.isArray(productsRaw) ? productsRaw : (productsRaw?.results ?? []);

  const importsQuery = useQuery<any>({
    queryKey: ["/api/orders/imports"],
    queryFn: async () => {
      const response = await apiRequest("GET", "/api/orders/imports", undefined, false, true);
      // Support both array and envelope { page, limit, results }
      if (Array.isArray(response)) return response;
      if (response && Array.isArray(response.results)) return response.results;
      return [];
    },
    retry: false,
  });

  const { data: importSummariesRaw = [], isLoading: importsLoading, refetch: refetchImports, error: importsError } = importsQuery as any;
  const importSummaries: ImportSummary[] = Array.isArray(importSummariesRaw) ? importSummariesRaw : [];

  useEffect(() => {
    if (importsError) {
      toast({ title: 'Failed to load uploaded CSVs', description: importsError.message, variant: 'destructive' });
    }
  }, [importsError, toast]);

  useEffect(() => {
    setSessions(getSavedSessions());
  }, []);

  const activeSession = useMemo(
    () => sessions.find((session) => session.id === activeSessionId) ?? null,
    [activeSessionId, sessions],
  );

  const productLookup = useMemo(() => {
    const map = new Map<string, Product>();
    products.forEach((product) => {
      [product.barcode, product.itemNo, product.sapCode, product.srNo, product.name].forEach((key) => {
        const normalized = normalize(key);
        if (normalized) map.set(normalized, product);
      });
    });
    return map;
  }, [products]);

  const pivotColumns = useMemo(() => {
    if (csvMode !== "pivot" || csvRows.length < 2) return [];
    return (csvRows[0] ?? [])
      .slice(1)
      .map((label, index) => ({ label, index: index + 1 }))
      .filter((column) => column.label && normalize(column.label) !== "total");
  }, [csvMode, csvRows]);

  const flatHeaders = useMemo(() => (csvMode === "flat" ? csvRows[0] ?? [] : []), [csvMode, csvRows]);

  const mappedItems = useMemo(() => {
    if (importItems.length) return importItems;
    if (!csvRows.length) return [];

    if (csvMode === "pivot") {
      const selected = pivotColumns.find((column) => column.label === mappedColumn);
      if (!selected) return [];

      return csvRows.slice(2).reduce<OrderItem[]>((items, row, index) => {
        const productCell = row[0] ?? "";
        const qty = parseQuantity(row[selected.index]);
        if (!productCell || qty <= 0) return items;

        const parsed = splitSkuName(productCell);
        const product =
          productLookup.get(normalize(parsed.sku)) ??
          products.find((item) => normalize(parsed.itemName).includes(normalize(item.name)));

        items.push({
          id: `${parsed.sku}-${index}`,
          sku: parsed.sku,
          itemName: product?.name ?? parsed.itemName,
          expectedQty: qty,
          scannedQty: 0,
          productId: product?.id,
          barcode: product?.barcode,
          itemNo: product?.itemNo,
          sapCode: product?.sapCode,
        });
        return items;
      }, []);
    }

    const skuIndex = flatHeaders.indexOf(flatSkuColumn);
    const nameIndex = flatHeaders.indexOf(flatNameColumn);
    const qtyIndex = flatHeaders.indexOf(flatQtyColumn);
    if (skuIndex < 0 || qtyIndex < 0) return [];

    return csvRows.slice(1).reduce<OrderItem[]>((items, row, index) => {
      const sku = row[skuIndex] ?? "";
      const qty = parseQuantity(row[qtyIndex]);
      if (!sku || qty <= 0) return items;
      const product = productLookup.get(normalize(sku));

      items.push({
        id: `${sku}-${index}`,
        sku,
        itemName: product?.name ?? row[nameIndex] ?? sku,
        expectedQty: qty,
        scannedQty: 0,
        productId: product?.id,
        barcode: product?.barcode,
        itemNo: product?.itemNo,
        sapCode: product?.sapCode,
      });
      return items;
    }, []);
  }, [csvMode, csvRows, flatHeaders, flatNameColumn, flatQtyColumn, flatSkuColumn, importItems, mappedColumn, pivotColumns, productLookup, products]);

  const totals = useMemo(() => {
    const items = activeSession?.items ?? [];
    const expected = items.reduce((sum, item) => sum + item.expectedQty, 0);
    const scanned = items.reduce((sum, item) => sum + item.scannedQty, 0);
    const completed = items.filter((item) => item.scannedQty >= item.expectedQty).length;
    return { expected, scanned, completed };
  }, [activeSession]);

  const updateSession = (updater: (session: OrderSession) => OrderSession) => {
    setSessions((current) => {
      const next = current.map((session) =>
        session.id === activeSessionId ? updater(session) : session,
      );
      saveSessions(next);
      return next;
    });
  };

  const resetDraft = () => {
    setCsvRows([]);
    setCsvName("");
    setMappedColumn("");
    setSelectedImport("");
    setImportItems([]);
    setFlatSkuColumn("");
    setFlatNameColumn("");
    setFlatQtyColumn("");
    setCsvMode("pivot");
  };

  const loadImportItems = async () => {
    if (!selectedImport) return;

    const response = await apiRequest(
      "GET",
      `/api/orders/imports/items?filename=${encodeURIComponent(selectedImport)}`,
      undefined,
      false,
      true,
    ) as ImportItemsResponse;

    if (!response?.items?.length) {
      toast({
        title: "No items found",
        description: "This CSV has no arriving items to scan.",
        variant: "destructive",
      });
      return;
    }

    setImportItems(response.items.map((item, index) => ({
      ...item,
      id: item.id || `import-${index}`,
      scannedQty: 0,
    })));
    setCsvName(response.filename);
    setMappedColumn("Arriving Orders Import");
    setCsvMode("pivot");
  };

  const loadCsvText = (text: string, name: string) => {
    const rows = parseCsv(text);
    if (rows.length < 2) {
      toast({
        title: "CSV not readable",
        description: "Please upload a CSV with product and quantity rows.",
        variant: "destructive",
      });
      return;
    }

    const mode = detectCsvMode(rows);
    setCsvRows(rows);
    setCsvName(name);
    setCsvMode(mode);
    setMappedColumn("");
  setSelectedImport("");
  setImportItems([]);

    if (mode === "flat") {
      const headers = rows[0] ?? [];
      setFlatSkuColumn(headers.find((header) => /sku|item|barcode|sap/i.test(header)) ?? "");
      setFlatNameColumn(headers.find((header) => /name|product/i.test(header)) ?? "");
      setFlatQtyColumn(headers.find((header) => /qty|quantity|box/i.test(header)) ?? "");
    }
  };

  const createOrder = () => {
    if (!mappedItems.length) {
      toast({
        title: "Map the order first",
        description: "Choose the CSV column that represents the arriving order.",
        variant: "destructive",
      });
      return;
    }

    const now = new Date().toISOString();
    const session: OrderSession = {
      id: `scan-${Date.now()}`,
      orderName: mappedColumn || csvName.replace(/\.csv$/i, "") || "Stock Arrival",
      csvName,
      mappedColumn: mappedColumn || "Mapped order",
      createdAt: now,
      updatedAt: now,
      status: "scanning",
      items: mappedItems,
      extras: [],
      activities: [],
    };

    const next = [session, ...sessions];
    setSessions(next);
    saveSessions(next);
    setActiveSessionId(session.id);
    resetDraft();
    setView("scan");
  };

  const findProductForCode = async (code: string): Promise<Product | null> => {
    const localProduct = productLookup.get(normalize(code));
    if (localProduct) return localProduct;

    try {
      return await apiRequest(
        "GET",
        `/api/products/barcode/${encodeURIComponent(code)}`,
        undefined,
        false,
        true,
      ) as Product;
    } catch {
      return null;
    }
  };

  const postStockScan = async (product: Product, code: string, orderNumber: string) => {
    const userRaw = localStorage.getItem("currentUser");
    const user = userRaw ? JSON.parse(userRaw) : null;

    const response = await apiRequest("POST", "/api/scans", {
      barcode: product.barcode || code,
      productId: product.id,
      action: "add",
      quantity: 1,
      productSku: product.itemNo || product.sapCode || product.barcode || code,
      productName: product.name,
      scannerName: user?.name || user?.username || "Unknown User",
      scannerDepartment: user?.department || "N/A",
      scannedByCode: user?.userCode,
      orderNumber,
      notes: `Stock arrival scan for ${orderNumber}`,
    });
    return response;
  };

  const handleScannedCode = async (rawCode: string) => {
    const code = rawCode.trim();
    if (!code || !activeSession || isPostingScan) return;

    const now = Date.now();
    if (lastScanRef.current.code === code && now - lastScanRef.current.at < 1200) return;
    lastScanRef.current = { code, at: now };
    setIsPostingScan(true);

    try {
      const product = await findProductForCode(code);
      const keys = new Set(
        [code, product?.barcode, product?.itemNo, product?.sapCode, product?.srNo].map(normalize).filter(Boolean),
      );

      let matchedItem: OrderItem | undefined;
      for (const item of activeSession.items) {
        const itemKeys = [item.sku, item.barcode, item.itemNo, item.sapCode].map(normalize);
        if (product?.id && item.productId === product.id) {
          matchedItem = item;
          break;
        }
        if (itemKeys.some((key) => keys.has(key))) {
          matchedItem = item;
          break;
        }
      }

      let scanResult: any = null;
      if (product) {
        scanResult = await postStockScan(product, code, activeSession.orderName);
        queryClient.invalidateQueries({ queryKey: ["/api/products"] });
        queryClient.invalidateQueries({ queryKey: ["/api/scans"] });
      }

      const scannedAt = new Date().toISOString();
      updateSession((session) => {
        if (matchedItem) {
          return {
            ...session,
            updatedAt: scannedAt,
            items: session.items.map((item) =>
              item.id === matchedItem.id
            ? { ...item, scannedQty: item.scannedQty + 1 }
                : item,
            ),
            activities: [
              {
                id: `act-${Date.now()}`,
                code,
                itemName: matchedItem.itemName,
                quantity: 1,
                scannedAt,
                type: "order" as const,
                details: scanResult ? `addedUnits=${scanResult.addedUnits}` : undefined,
              },
              ...session.activities,
            ].slice(0, 50),
          };
        }

        const existingExtra = session.extras.find((extra) => extra.code === code);
        const extraName = product?.name ?? "Unknown product";

        return {
          ...session,
          updatedAt: scannedAt,
          extras: existingExtra
            ? session.extras.map((extra) =>
                extra.code === code
                  ? { ...extra, quantity: extra.quantity + 1, scannedAt }
                  : extra,
              )
            : [
                {
                  id: `extra-${Date.now()}`,
                  code,
                  itemName: extraName,
                  sku: product?.itemNo || product?.sapCode || product?.barcode,
                  quantity: 1,
                  scannedAt,
                  productId: product?.id,
                  reason: product ? "not_in_order" as const : "unknown_product" as const,
                },
                ...session.extras,
              ],
          activities: [
            {
              id: `act-${Date.now()}`,
              code,
              itemName: extraName,
              quantity: 1,
              scannedAt,
              type: "extra" as const,
            },
            ...session.activities,
          ].slice(0, 50),
        };
      });

      toast({
        title: matchedItem ? "Box added to order stock" : "Extra box recorded",
        description: product
          ? `${product.name} stock increased by 1.`
          : `${code} was kept in the extra report because it was not found in inventory.`,
        variant: matchedItem ? "default" : "destructive",
      });
    } catch (error) {
      toast({
        title: "Scan failed",
        description: error instanceof Error ? error.message : "Could not process this box.",
        variant: "destructive",
      });
    } finally {
      setIsPostingScan(false);
    }
  };

  const startScanner = async () => {
    if (!videoRef.current) return;
    const scanner = new BarcodeScanner({
      onDetected: (result: Result) => handleScannedCode(result.getText()),
      onError: (error) => {
        if (!error.message.includes("No MultiFormat")) {
          toast({
            title: "Camera scanner issue",
            description: error.message,
            variant: "destructive",
          });
        }
      },
    });
    scannerRef.current = scanner;
    await scanner.initialize();
    await scanner.start(videoRef.current);
    setIsScanning(true);
  };

  const stopScanner = async () => {
    if (scannerRef.current) {
      await scannerRef.current.stop();
      scannerRef.current = null;
    }
    setIsScanning(false);
  };

  useEffect(() => {
    return () => {
      if (scannerRef.current) scannerRef.current.stop();
    };
  }, []);

  const submitManualCode = () => {
    handleScannedCode(manualCode);
    setManualCode("");
  };

  if (view === "map") {
    return (
      <div className="flex-1 overflow-y-auto bg-gray-50 p-4 lg:p-6">
        <div className="mx-auto max-w-7xl space-y-4">
          <div className="flex flex-wrap items-center justify-between gap-3">
            <div>
              <Button variant="ghost" className="mb-2 px-0" onClick={() => setView("dashboard")}>
                <ArrowLeft className="mr-2 h-4 w-4" />
                Back
              </Button>
              <h1 className="text-2xl font-semibold text-gray-950">Add New Scan Order</h1>
              <p className="text-sm text-gray-600">Upload yesterday's order CSV, map the arriving order, then start scanning boxes.</p>
            </div>
            <Button onClick={createOrder} disabled={!mappedItems.length} className="bg-[#001d6e] hover:bg-[#00154b]">
              <ScanLine className="mr-2 h-4 w-4" />
              Next
            </Button>
          </div>

          <div className="grid gap-4 lg:grid-cols-[360px_1fr]">
            <Card className="rounded-md">
              <CardHeader>
                <CardTitle className="flex items-center text-lg">
                  <FileSpreadsheet className="mr-2 h-5 w-5 text-[#001d6e]" />
                  CSV Mapping
                </CardTitle>
              </CardHeader>
              <CardContent className="space-y-5">
                <div className="space-y-2">
                  <Label>Arriving Order CSV (Uploaded)</Label>
                  <Select value={selectedImport} onValueChange={setSelectedImport}>
                    <SelectTrigger>
                      <SelectValue placeholder="Select uploaded CSV" />
                    </SelectTrigger>
                    <SelectContent>
                      {importSummaries.length === 0 && (
                        <SelectItem value="no-imports" disabled>
                          No uploaded CSVs found
                        </SelectItem>
                      )}
                      {importSummaries.map((summary) => (
                        <SelectItem key={summary.filename} value={summary.filename}>
                          {summary.filename}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                  <Button type="button" variant="outline" className="w-full" onClick={loadImportItems} disabled={!selectedImport}>
                    <PackageCheck className="mr-2 h-4 w-4" />
                    Load Arriving Orders
                  </Button>
                  {selectedImport && <p className="text-xs text-gray-500">Using: {selectedImport}</p>}
                </div>

                {csvRows.length > 0 && csvMode === "pivot" && (
                  <div className="space-y-2">
                    <Label>Arriving Order / Dealer</Label>
                    <Select value={mappedColumn} onValueChange={setMappedColumn}>
                      <SelectTrigger>
                        <SelectValue placeholder="Select CSV order column" />
                      </SelectTrigger>
                      <SelectContent>
                        {pivotColumns.map((column) => (
                          <SelectItem key={column.label} value={column.label}>
                            {column.label}
                          </SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                  </div>
                )}

                {csvRows.length > 0 && csvMode === "flat" && (
                  <div className="space-y-3">
                    <div className="space-y-2">
                      <Label>SKU / Barcode Column</Label>
                      <Select value={flatSkuColumn} onValueChange={setFlatSkuColumn}>
                        <SelectTrigger><SelectValue placeholder="Select SKU column" /></SelectTrigger>
                        <SelectContent>{flatHeaders.map((header) => <SelectItem key={header} value={header}>{header}</SelectItem>)}</SelectContent>
                      </Select>
                    </div>
                    <div className="space-y-2">
                      <Label>Item Name Column</Label>
                      <Select value={flatNameColumn} onValueChange={setFlatNameColumn}>
                        <SelectTrigger><SelectValue placeholder="Select name column" /></SelectTrigger>
                        <SelectContent>{flatHeaders.map((header) => <SelectItem key={header} value={header}>{header}</SelectItem>)}</SelectContent>
                      </Select>
                    </div>
                    <div className="space-y-2">
                      <Label>Quantity Column</Label>
                      <Select value={flatQtyColumn} onValueChange={setFlatQtyColumn}>
                        <SelectTrigger><SelectValue placeholder="Select quantity column" /></SelectTrigger>
                        <SelectContent>{flatHeaders.map((header) => <SelectItem key={header} value={header}>{header}</SelectItem>)}</SelectContent>
                      </Select>
                    </div>
                  </div>
                )}
              </CardContent>
            </Card>

            <Card className="rounded-md">
              <CardHeader>
                <CardTitle className="text-lg">Mapped Order Preview</CardTitle>
              </CardHeader>
              <CardContent>
                <Table>
                  <TableHeader>
                    <TableRow>
                      <TableHead>SKU</TableHead>
                      <TableHead>Item</TableHead>
                      <TableHead className="text-right">Boxes</TableHead>
                      <TableHead>Inventory Match</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {mappedItems.slice(0, 12).map((item) => (
                      <TableRow key={item.id}>
                        <TableCell className="font-mono">{item.sku}</TableCell>
                        <TableCell>{item.itemName}</TableCell>
                        <TableCell className="text-right font-medium">{item.expectedQty}</TableCell>
                        <TableCell>
                          {item.productId ? (
                            <Badge className="bg-emerald-100 text-emerald-800 hover:bg-emerald-100">Matched</Badge>
                          ) : (
                            <Badge variant="outline" className="border-amber-300 text-amber-700">Needs SKU match</Badge>
                          )}
                        </TableCell>
                      </TableRow>
                    ))}
                    {!mappedItems.length && (
                      <TableRow>
                        <TableCell colSpan={4} className="py-10 text-center text-gray-500">
                          Upload a CSV and choose the correct order column.
                        </TableCell>
                      </TableRow>
                    )}
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
    return (
      <div className="flex-1 overflow-y-auto bg-gray-50 p-4 lg:p-6">
        <div className="mx-auto max-w-7xl space-y-4">
          <div className="flex flex-wrap items-center justify-between gap-3">
            <div>
              <Button variant="ghost" className="mb-2 px-0" onClick={() => { stopScanner(); setView("dashboard"); }}>
                <ArrowLeft className="mr-2 h-4 w-4" />
                Dashboard
              </Button>
              <h1 className="text-2xl font-semibold text-gray-950">{activeSession.orderName}</h1>
              <p className="text-sm text-gray-600">{activeSession.csvName} - {totals.scanned} of {totals.expected} boxes scanned</p>
            </div>
            <div className="flex gap-2">
              <Button variant="outline" onClick={() => updateSession((session) => ({ ...session, status: "completed", updatedAt: new Date().toISOString() }))}>
                <CheckCircle2 className="mr-2 h-4 w-4" />
                Complete
              </Button>
              <Button variant="outline" onClick={stopScanner} disabled={!isScanning}>
                <Square className="mr-2 h-4 w-4" />
                Stop
              </Button>
            </div>
          </div>

          <div className="grid gap-4 lg:grid-cols-[1fr_420px]">
            <div className="space-y-4">
              <div className="grid gap-3 sm:grid-cols-4">
                <Card className="rounded-md"><CardContent className="p-4"><p className="text-xs text-gray-500">Order Items</p><p className="text-2xl font-semibold">{activeSession.items.length}</p></CardContent></Card>
                <Card className="rounded-md"><CardContent className="p-4"><p className="text-xs text-gray-500">Expected</p><p className="text-2xl font-semibold">{totals.expected}</p></CardContent></Card>
                <Card className="rounded-md"><CardContent className="p-4"><p className="text-xs text-gray-500">Scanned</p><p className="text-2xl font-semibold text-emerald-700">{totals.scanned}</p></CardContent></Card>
                <Card className="rounded-md"><CardContent className="p-4"><p className="text-xs text-gray-500">Extras</p><p className="text-2xl font-semibold text-amber-700">{activeSession.extras.reduce((sum, item) => sum + item.quantity, 0)}</p></CardContent></Card>
              </div>

              <Card className="rounded-md">
                <CardHeader><CardTitle className="text-lg">CSV Order Items</CardTitle></CardHeader>
                <CardContent>
                  <Table>
                    <TableHeader>
                      <TableRow>
                        <TableHead>SKU</TableHead>
                        <TableHead>Item</TableHead>
                        <TableHead className="text-right">Scanned</TableHead>
                        <TableHead>Status</TableHead>
                      </TableRow>
                    </TableHeader>
                    <TableBody>
                      {activeSession.items.map((item) => {
                        const done = item.scannedQty >= item.expectedQty;
                        return (
                          <TableRow key={item.id}>
                            <TableCell className="font-mono">{item.sku}</TableCell>
                            <TableCell>{item.itemName}</TableCell>
                            <TableCell className="text-right font-medium">{item.scannedQty}/{item.expectedQty}</TableCell>
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
                  <CardHeader><CardTitle className="text-lg">Scanned Bottom List</CardTitle></CardHeader>
                  <CardContent className="max-h-80 overflow-auto">
                    {activeSession.activities.length ? activeSession.activities.map((activity) => (
                      <div key={activity.id} className="flex items-center justify-between border-b py-3 last:border-0">
                        <div>
                          <p className="font-medium">{activity.itemName}</p>
                          <p className="text-xs text-gray-500">{activity.code} - {new Date(activity.scannedAt).toLocaleTimeString()}</p>
                        </div>
                        <Badge variant={activity.type === "order" ? "default" : "outline"}>{activity.type}</Badge>
                      </div>
                    )) : <p className="py-8 text-center text-sm text-gray-500">Scanned items will appear here.</p>}
                  </CardContent>
                </Card>

                <Card className="rounded-md">
                  <CardHeader><CardTitle className="flex items-center text-lg"><AlertTriangle className="mr-2 h-5 w-5 text-amber-600" />Extra Report</CardTitle></CardHeader>
                  <CardContent className="max-h-80 overflow-auto">
                    {activeSession.extras.length ? activeSession.extras.map((extra) => (
                      <div key={extra.id} className="flex items-center justify-between border-b py-3 last:border-0">
                        <div>
                          <p className="font-medium">{extra.itemName}</p>
                          <p className="text-xs text-gray-500">{extra.sku || extra.code} - {extra.reason === "not_in_order" ? "Not in CSV order" : "Not in inventory"}</p>
                        </div>
                        <Badge variant="outline">x{extra.quantity}</Badge>
                      </div>
                    )) : <p className="py-8 text-center text-sm text-gray-500">Extra scanned boxes will be listed separately.</p>}
                  </CardContent>
                </Card>
              </div>
            </div>

            <Card className="rounded-md">
              <CardHeader><CardTitle className="flex items-center text-lg"><Camera className="mr-2 h-5 w-5 text-[#001d6e]" />Scanner</CardTitle></CardHeader>
              <CardContent className="space-y-4">
                <div className="aspect-[4/3] overflow-hidden rounded-md bg-black">
                  <video ref={videoRef} className="h-full w-full object-cover" muted playsInline />
                </div>
                <div className="grid grid-cols-2 gap-2">
                  <Button onClick={startScanner} disabled={isScanning} className="bg-[#001d6e] hover:bg-[#00154b]">
                    <Play className="mr-2 h-4 w-4" />
                    Start
                  </Button>
                  <Button variant="outline" onClick={() => { stopScanner(); startScanner(); }}>
                    <RotateCcw className="mr-2 h-4 w-4" />
                    Restart
                  </Button>
                </div>
                <div className="space-y-2">
                  <Label htmlFor="manual-scan">Manual QR / SKU Entry</Label>
                  <div className="flex gap-2">
                    <Input id="manual-scan" value={manualCode} onChange={(event) => setManualCode(event.target.value)} onKeyDown={(event) => event.key === "Enter" && submitManualCode()} placeholder="Scan or type box code" />
                    <Button variant="outline" onClick={submitManualCode}>
                      <Keyboard className="h-4 w-4" />
                    </Button>
                  </div>
                </div>
                <p className="text-xs text-gray-500">
                  Every matched scan adds 1 box to inventory stock. Products not present in this CSV are kept in the extra report.
                </p>
              </CardContent>
            </Card>
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="flex-1 overflow-y-auto bg-gray-50 p-4 lg:p-6">
      <div className="mx-auto max-w-7xl space-y-5">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div>
            <h1 className="text-2xl font-semibold text-gray-950">Scan Order</h1>
            <p className="text-sm text-gray-600">Create an arrival order from CSV, scan box QR codes, and add stock by matching SKU from inventory.</p>
          </div>
          <Button onClick={() => { resetDraft(); setView("map"); }} className="bg-[#001d6e] hover:bg-[#00154b]">
            <Plus className="mr-2 h-4 w-4" />
            Add New Order
          </Button>
        </div>

        <div className="grid gap-4 sm:grid-cols-3">
          <Card className="rounded-md"><CardContent className="flex items-center gap-3 p-5"><PackageCheck className="h-9 w-9 text-emerald-600" /><div><p className="text-xs text-gray-500">Active Orders</p><p className="text-2xl font-semibold">{sessions.filter((session) => session.status === "scanning").length}</p></div></CardContent></Card>
          <Card className="rounded-md"><CardContent className="flex items-center gap-3 p-5"><ScanLine className="h-9 w-9 text-[#001d6e]" /><div><p className="text-xs text-gray-500">Boxes Scanned</p><p className="text-2xl font-semibold">{sessions.reduce((sum, session) => sum + session.items.reduce((itemSum, item) => itemSum + item.scannedQty, 0), 0)}</p></div></CardContent></Card>
          <Card className="rounded-md"><CardContent className="flex items-center gap-3 p-5"><AlertTriangle className="h-9 w-9 text-amber-600" /><div><p className="text-xs text-gray-500">Extra Boxes</p><p className="text-2xl font-semibold">{sessions.reduce((sum, session) => sum + session.extras.reduce((extraSum, extra) => extraSum + extra.quantity, 0), 0)}</p></div></CardContent></Card>
        </div>

        <Card className="rounded-md">
          <CardHeader><CardTitle className="flex items-center text-lg"><History className="mr-2 h-5 w-5 text-[#001d6e]" />Recent Activity</CardTitle></CardHeader>
          <CardContent>
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Order</TableHead>
                  <TableHead>CSV</TableHead>
                  <TableHead className="text-right">Progress</TableHead>
                  <TableHead>Updated</TableHead>
                  <TableHead className="text-right">Action</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {sessions.map((session) => {
                  const expected = session.items.reduce((sum, item) => sum + item.expectedQty, 0);
                  const scanned = session.items.reduce((sum, item) => sum + item.scannedQty, 0);
                  return (
                    <TableRow key={session.id}>
                      <TableCell className="font-medium">{session.orderName}</TableCell>
                      <TableCell>{session.csvName}</TableCell>
                      <TableCell className="text-right">{scanned}/{expected}</TableCell>
                      <TableCell>{new Date(session.updatedAt).toLocaleString()}</TableCell>
                      <TableCell className="text-right">
                        <Button size="sm" variant="outline" onClick={() => { setActiveSessionId(session.id); setView("scan"); }}>
                          Start Scanning
                        </Button>
                      </TableCell>
                    </TableRow>
                  );
                })}
                {!sessions.length && (
                  <TableRow>
                    <TableCell colSpan={5} className="py-12 text-center text-gray-500">
                      No scan orders yet. Add a new order to begin.
                    </TableCell>
                  </TableRow>
                )}
              </TableBody>
            </Table>
          </CardContent>
        </Card>
      </div>
    </div>
  );
}
