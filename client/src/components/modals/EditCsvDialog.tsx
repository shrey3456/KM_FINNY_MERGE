import { useEffect, useMemo, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { hasPageWriteAccess } from "@/lib/permissions";
import { AlertCircle, Loader2, Pencil, Plus, Save, Search, Trash2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Badge } from "@/components/ui/badge";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { useToast } from "@/hooks/use-toast";
import { apiRequest } from "@/lib/queryClient";

interface EditableItem {
  key: string;
  id?: number;
  barcode: string;
  itemName: string;
  sapCode: string;
  quantity: string;
  expectedPallets: string;
  scannedQty: number;
}

// Just enough of the Notion-synced product catalog to search by and auto-fill from — see the
// itemName search/autocomplete on newly-added rows below. itemsPerPallet/pallets/gjPlt/mpPlt
// drive the Quantity <-> Pallets auto-calc in the Add Item dialog.
type CatalogProduct = {
  id: number; name: string; barcode: string; sapCode?: string | null;
  itemsPerPallet?: number | null; pallets?: number | null;
  gjPlt?: number | null; mpPlt?: number | null;
};

// Same fallback chain used across the app (see Scan.tsx's getStatePalletSize): state-specific
// pallet size first (resolved via which state the given plant is in, plants.state — not a
// plant-name guess), then the generic itemsPerPallet/pallets fields, then a "*NNN" hint in the
// product name itself. Returns 0 (not 1) when nothing is configured, so callers can tell
// "no pallet data" apart from "genuinely 1 per pallet".
function resolvePalletSize(product: CatalogProduct | null, plant: string | undefined, allPlants: any[] | undefined): number {
  if (!product) return 0;
  const plantName = (plant ?? "").trim().toLowerCase();
  const match = allPlants?.find((p) => String(p.name ?? "").trim().toLowerCase() === plantName);
  const state = match?.state ? String(match.state).trim().toUpperCase() : null;
  let size = 0;
  if (state === "GJ") {
    size = Number(product.gjPlt) || Number(product.itemsPerPallet) || Number(product.pallets) || 0;
  } else if (state === "MP") {
    size = Number(product.mpPlt) || Number(product.itemsPerPallet) || Number(product.pallets) || 0;
  } else {
    size = Number(product.itemsPerPallet) || Number(product.pallets) || 0;
  }
  if (size === 0 && product.name) {
    const m = product.name.match(/\*(\d{1,5})/);
    if (m) { const n = parseInt(m[1], 10); if (Number.isFinite(n) && n > 1) size = n; }
  }
  return size;
}

let tempKeyCounter = 0;
function newTempKey() {
  tempKeyCounter += 1;
  return `new-${tempKeyCounter}`;
}

type EditCsvDialogProps = {
  sessionId: number | null;
  onClose: () => void;
};

// Fixes a mistake in an already-uploaded, not-yet-completed CSV (e.g. one wrong barcode)
// without deleting and re-uploading the whole file — opened from a row's Edit button in
// OrderImport.tsx's Available/Active tabs. Gated by its own "order-import-edit" page key
// (allowedPages = read-only view, pageWriteAccess = can save), independent of the caller's
// own Order Import access, plus the same plant scoping enforced server-side.
export default function EditCsvDialog({ sessionId, onClose }: EditCsvDialogProps) {
  const { toast } = useToast();
  const qc = useQueryClient();
  const canWrite = hasPageWriteAccess("order-import-edit");

  const [rows, setRows] = useState<EditableItem[]>([]);

  // Full product catalog (synced from Notion) — searched by name/barcode/SAP in the "Add Item"
  // dialog below, so a picked product's barcode + SAP code auto-fill instead of being typed
  // by hand and risking a typo.
  const { data: productsRaw } = useQuery<any>({
    queryKey: ["/api/products", { all: "true" }],
  });
  const products: CatalogProduct[] = Array.isArray(productsRaw) ? productsRaw : (productsRaw?.results ?? []);

  // Plant → state lookup for resolvePalletSize (state-specific pallet size, not plant-name
  // guessing — see that function's own comment).
  const { data: allPlants } = useQuery<any[]>({
    queryKey: ["/api/plants"],
    queryFn: () => apiRequest("GET", "/api/plants").then((r) => r.json()),
    staleTime: 60000,
  });

  // "Add Item" dialog — a separate small dialog (rather than an inline empty row growing at
  // the bottom of the big table) so the product search has a normal, uncluttered place to
  // live: no clipping-ancestor tricks needed, and picking a result can't be confused with
  // editing an existing row's own item name.
  const [addItemOpen, setAddItemOpen] = useState(false);
  const [addSearch, setAddSearch] = useState("");
  const [addPicked, setAddPicked] = useState<CatalogProduct | null>(null);
  const [addQty, setAddQty] = useState("0");
  const [addPallets, setAddPallets] = useState("");

  // Barcodes already present as a row in this CSV — excluded from suggestions below so you
  // don't accidentally add a duplicate row for an item that's already there (if it needs a
  // qty change, that's an edit to its existing row, not a second row for the same barcode).
  const existingBarcodes = useMemo(
    () => new Set(rows.map((r) => r.barcode.trim().toLowerCase()).filter(Boolean)),
    [rows],
  );

  // Computed separately from the exclusion filter below so the empty-results message can tell
  // apart "nothing matches this search at all" from "it matches, but every match is already a
  // row in this CSV" — the two need different messages, not just a blank list either way.
  const addTextMatches = useMemo(() => {
    const q = addSearch.trim().toLowerCase();
    if (!q) return [];
    return products.filter((p) =>
      p.name?.toLowerCase().includes(q) ||
      p.barcode?.toLowerCase().includes(q) ||
      p.sapCode?.toLowerCase().includes(q)
    );
  }, [products, addSearch]);
  const addMatches = useMemo(
    () => addTextMatches.filter((p) => !existingBarcodes.has((p.barcode ?? "").trim().toLowerCase())).slice(0, 8),
    [addTextMatches, existingBarcodes],
  );
  // True when the search matched something, but every match got filtered out for already being
  // a row in this CSV — as opposed to genuinely matching nothing at all.
  const addAllMatchesAlreadyInCsv = addTextMatches.length > 0 && addMatches.length === 0;

  function resetAddDialog() {
    setAddItemOpen(false);
    setAddSearch("");
    setAddPicked(null);
    setAddQty("0");
    setAddPallets("");
  }

  function confirmAddItem() {
    if (!addPicked) return;
    setRows((prev) => [
      ...prev,
      {
        key: newTempKey(),
        barcode: addPicked.barcode,
        itemName: addPicked.name,
        sapCode: addPicked.sapCode ?? "",
        quantity: addQty || "0",
        expectedPallets: addPallets,
        scannedQty: 0,
      },
    ]);
    resetAddDialog();
  }

  const itemsQuery = useQuery({
    queryKey: ["/api/order-import-edit/sessions", sessionId, "items"],
    queryFn: async (): Promise<{ session: any; items: any[] }> =>
      (await apiRequest("GET", `/api/order-import-edit/sessions/${sessionId}/items`)).json(),
    enabled: sessionId != null,
  });

  useEffect(() => {
    if (!itemsQuery.data) return;
    setRows(
      itemsQuery.data.items.map((it: any) => ({
        key: `existing-${it.id}`,
        id: it.id,
        barcode: it.barcode ?? "",
        itemName: it.itemName ?? "",
        sapCode: it.sapCode ?? "",
        quantity: String(it.quantity ?? 0),
        expectedPallets: it.expectedPallets != null ? String(it.expectedPallets) : "",
        scannedQty: it.scannedQty ?? 0,
      })),
    );
  }, [itemsQuery.data]);

  const saveMutation = useMutation({
    mutationFn: async () => {
      const payload = {
        items: rows.map((r) => ({
          id: r.id,
          barcode: r.barcode,
          itemName: r.itemName,
          sapCode: r.sapCode,
          quantity: Number(r.quantity) || 0,
          expectedPallets: r.expectedPallets === "" ? null : Number(r.expectedPallets),
        })),
      };
      return (await apiRequest("PUT", `/api/order-import-edit/sessions/${sessionId}`, payload)).json();
    },
    onSuccess: async () => {
      toast({
        title: "Saved",
        description: "The CSV's items have been updated.",
        className: "bg-emerald-50 border-emerald-200 text-emerald-900",
      });
      await qc.invalidateQueries({ queryKey: ["/api/order-import-edit/sessions", sessionId, "items"] });
      await qc.invalidateQueries({ queryKey: ["/api/order-import/sessions"] });
      onClose();
    },
    onError: (error: any) => {
      toast({ title: "Could not save", description: error.message, variant: "destructive" });
    },
  });

  function updateRow(key: string, field: keyof EditableItem, value: string) {
    setRows((prev) => prev.map((r) => (r.key === key ? { ...r, [field]: value } : r)));
  }

  function removeRow(row: EditableItem) {
    if (row.scannedQty > 0) {
      toast({
        title: "Can't remove this item",
        description: `${row.barcode || row.itemName || "This item"} already has ${row.scannedQty} scanned — void the scan first, then remove it.`,
        variant: "destructive",
      });
      return;
    }
    setRows((prev) => prev.filter((r) => r.key !== row.key));
  }

  const session = itemsQuery.data?.session;

  // Quantity <-> Pallets auto-calc in the Add Item dialog, once a product (and therefore a
  // pallet size for this session's plant) is picked. Each field only recomputes the OTHER one
  // on its own change — never both from a shared effect — so rounding on one side can't fight
  // the other field while the operator is still typing it.
  const addPalletSize = resolvePalletSize(addPicked, session?.plant, allPlants);
  function handleAddQtyChange(value: string) {
    setAddQty(value);
    const n = Number(value);
    if (addPalletSize > 0 && Number.isFinite(n)) setAddPallets((n / addPalletSize).toFixed(2));
  }
  function handleAddPalletsChange(value: string) {
    setAddPallets(value);
    const n = Number(value);
    if (addPalletSize > 0 && Number.isFinite(n)) setAddQty(String(Math.round(n * addPalletSize)));
  }

  return (
    <Dialog open={sessionId != null} onOpenChange={(open) => { if (!open) onClose(); }}>
      <DialogContent className="max-w-5xl max-h-[88vh] overflow-y-auto rounded-2xl">
        <DialogHeader>
          <div className="flex items-center justify-between gap-3 pr-10">
            <DialogTitle className="flex items-center gap-2 text-xl text-[#001d6e]">
              <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-full bg-[#001d6e] text-white">
                <Pencil className="h-4 w-4" />
              </span>
              <span className="min-w-0">
                <span className="block text-base font-bold leading-tight">Edit CSV</span>
                {session && (
                  <span className="block truncate text-xs font-normal text-gray-500">
                    {session.plant} · {session.csvFileName}
                  </span>
                )}
              </span>
            </DialogTitle>
            {/* Add Row lives up here next to the close button, so it doesn't take its own row. */}
            {canWrite && !itemsQuery.isLoading && (
              <Button variant="outline" size="sm" className="shrink-0 rounded-xl" onClick={() => setAddItemOpen(true)}>
                <Plus className="h-4 w-4 mr-1" /> Add Row
              </Button>
            )}
          </div>
        </DialogHeader>

        {!canWrite && (
          <Alert className="bg-amber-50 border-amber-200">
            <AlertCircle className="h-4 w-4 text-amber-600" />
            <AlertDescription className="text-amber-800">
              You have read-only access — you can view items but can't edit or save changes.
            </AlertDescription>
          </Alert>
        )}

        {itemsQuery.isLoading ? (
          <div className="flex justify-center py-10">
            <Loader2 className="h-6 w-6 animate-spin text-[#001d6e]" />
          </div>
        ) : (
          <>
            <div className="overflow-x-auto rounded-xl border border-gray-200 shadow-sm">
              {/* Fixed column widths: barcode/SAP/qty/pallets stay compact so Item Name gets the
                  remaining space and is never truncated. table-fixed makes the widths authoritative. */}
              <table className="w-full min-w-[720px] table-fixed border-collapse text-xs">
                <colgroup>
                  <col className="w-10" />
                  <col className="w-36" />{/* Barcode — enough for a 13-digit code, no more */}
                  <col />{/* Item Name — takes all remaining width */}
                  <col className="w-24" />{/* SAP */}
                  <col className="w-16" />{/* Qty */}
                  <col className="w-16" />{/* Pallets */}
                  <col className="w-20" />{/* Scanned */}
                  <col className="w-12" />{/* remove */}
                </colgroup>
                <thead>
                  <tr className="bg-[#001d6e]">
                    {["#", "Barcode", "Item Name", "SAP", "Qty", "Plt", "Scanned", ""].map((h, i) => (
                      <th
                        key={h || i}
                        className={`sticky top-0 z-10 whitespace-nowrap border-r border-[#1a3a9c] bg-[#001d6e] px-2.5 py-2 font-semibold uppercase tracking-wide text-white ${
                          i >= 4 && i <= 6 ? "text-right" : "text-left"
                        }`}
                      >
                        {h}
                      </th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {rows.map((row, idx) => (
                    <tr key={row.key} className={`border-b border-gray-100 transition-colors hover:bg-[#001d6e]/[0.03] ${idx % 2 === 1 ? "bg-slate-50/60" : "bg-white"}`}>
                      <td className="border-r border-gray-100 px-2.5 py-1.5 text-center text-gray-400 tabular-nums">{idx + 1}</td>
                      <td className="border-r border-gray-100 px-1.5 py-1">
                        <Input
                          className="h-7 rounded-md font-mono text-xs"
                          value={row.barcode}
                          disabled={!canWrite}
                          onChange={(e) => updateRow(row.key, "barcode", e.target.value)}
                        />
                      </td>
                      <td className="border-r border-gray-100 px-1.5 py-1">
                        <Input
                          className="h-7 w-full rounded-md text-xs"
                          value={row.itemName}
                          disabled={!canWrite}
                          onChange={(e) => updateRow(row.key, "itemName", e.target.value)}
                        />
                      </td>
                      <td className="border-r border-gray-100 px-1.5 py-1">
                        <Input
                          className="h-7 rounded-md font-mono text-xs"
                          value={row.sapCode}
                          disabled={!canWrite}
                          onChange={(e) => updateRow(row.key, "sapCode", e.target.value)}
                        />
                      </td>
                      <td className="border-r border-gray-100 px-1.5 py-1">
                        <Input
                          className="h-7 rounded-md text-right text-xs tabular-nums"
                          type="number"
                          value={row.quantity}
                          disabled={!canWrite}
                          onChange={(e) => updateRow(row.key, "quantity", e.target.value)}
                        />
                      </td>
                      <td className="border-r border-gray-100 px-1.5 py-1">
                        <Input
                          className="h-7 rounded-md text-right text-xs tabular-nums"
                          type="number"
                          value={row.expectedPallets}
                          disabled={!canWrite}
                          onChange={(e) => updateRow(row.key, "expectedPallets", e.target.value)}
                        />
                      </td>
                      <td className="border-r border-gray-100 px-2 py-1.5 text-right">
                        {row.scannedQty > 0 ? (
                          <Badge variant="outline" className="text-emerald-700 border-emerald-200 bg-emerald-50">
                            {row.scannedQty}
                          </Badge>
                        ) : (
                          <span className="text-gray-300">—</span>
                        )}
                      </td>
                      <td className="px-1 py-1 text-center">
                        {canWrite && (
                          <Button
                            variant="ghost"
                            size="sm"
                            className="h-7 w-7 rounded-md p-0 text-red-500 hover:bg-red-50 hover:text-red-700"
                            onClick={() => removeRow(row)}
                            title={row.scannedQty > 0 ? "Already scanned — void the scan before removing" : "Remove"}
                          >
                            <Trash2 className="h-4 w-4" />
                          </Button>
                        )}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>

            {canWrite && (
              <div className="flex justify-end gap-2 pt-1">
                <Button variant="outline" className="rounded-xl" onClick={onClose} disabled={saveMutation.isPending}>
                  Cancel
                </Button>
                <Button className="rounded-xl bg-[#001d6e] hover:bg-[#00154b] text-white" onClick={() => saveMutation.mutate()} disabled={saveMutation.isPending || rows.length === 0}>
                  {saveMutation.isPending ? (
                    <Loader2 className="h-4 w-4 mr-1 animate-spin" />
                  ) : (
                    <Save className="h-4 w-4 mr-1" />
                  )}
                  Save
                </Button>
              </div>
            )}
          </>
        )}
      </DialogContent>

      {/* Nested dialog, opened on top of the main Edit CSV dialog by the "Add Row" button.
          Search first, pick a product (fills barcode/SAP from the catalog), then set qty/pallets. */}
      <Dialog open={addItemOpen} onOpenChange={(open) => { if (!open) resetAddDialog(); }}>
        <DialogContent className="max-w-md rounded-2xl">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2 text-lg text-[#001d6e]">
              <Plus className="h-4 w-4" /> Add Item
            </DialogTitle>
          </DialogHeader>

          {!addPicked ? (
            // min-w-0: DialogContent is display:grid, and a grid item's default min-width is
            // "auto" — the intrinsic minimum size of its content, which for a long, unbroken
            // font-mono barcode string can force this whole row wider than the rest of the
            // dialog (max-w-md), even though the text itself has `truncate` on it further down.
            // min-w-0 here (and on the results list + each row below) removes that floor so
            // truncation actually gets a chance to apply instead of being overridden by it.
            <div className="min-w-0">
              <div className="relative">
                <Search className="pointer-events-none absolute left-2.5 top-2.5 h-4 w-4 text-gray-400" />
                <Input
                  autoFocus
                  className="pl-8"
                  placeholder="Search product name, barcode, or SAP code…"
                  value={addSearch}
                  onChange={(e) => setAddSearch(e.target.value)}
                />
              </div>
              {addSearch.trim() && (
                <div className="mt-2 max-h-64 min-w-0 overflow-y-auto overflow-x-hidden rounded-lg border border-gray-200">
                  {addMatches.length === 0 ? (
                    <p className="px-2.5 py-3 text-center text-xs text-gray-400">
                      {addAllMatchesAlreadyInCsv
                        ? "Already in this CSV — edit its quantity from the row in the table, not a new one."
                        : "No matching product found."}
                    </p>
                  ) : (
                    addMatches.map((p) => (
                      <button
                        key={p.id}
                        type="button"
                        onClick={() => setAddPicked(p)}
                        className="flex w-full min-w-0 items-center gap-2 border-b border-gray-100 px-2.5 py-2 text-left text-sm last:border-0 hover:bg-gray-50"
                      >
                        <span className="min-w-0 flex-1 truncate font-medium text-gray-900">{p.name}</span>
                        <span className="shrink-0 font-mono text-[11px] text-gray-400">{p.barcode}</span>
                      </button>
                    ))
                  )}
                </div>
              )}
            </div>
          ) : (
            <div className="min-w-0 space-y-3">
              <div className="flex items-start justify-between gap-2 rounded-lg border border-gray-200 bg-gray-50 p-2.5">
                <div className="min-w-0">
                  <p className="truncate text-sm font-semibold text-gray-900">{addPicked.name}</p>
                  <p className="font-mono text-xs text-gray-500">
                    {addPicked.barcode}{addPicked.sapCode ? ` · SAP ${addPicked.sapCode}` : ""}
                  </p>
                </div>
                <Button variant="ghost" size="sm" className="h-7 shrink-0 text-xs" onClick={() => setAddPicked(null)}>
                  Change
                </Button>
              </div>
              <div className="grid grid-cols-2 gap-3">
                <div className="space-y-1">
                  <label className="text-xs font-medium text-gray-500">Quantity</label>
                  <Input type="number" value={addQty} onChange={(e) => handleAddQtyChange(e.target.value)} />
                </div>
                <div className="space-y-1">
                  <label className="text-xs font-medium text-gray-500">Expected Pallets</label>
                  <Input type="number" value={addPallets} onChange={(e) => handleAddPalletsChange(e.target.value)} />
                </div>
              </div>
              {addPalletSize > 0 && (
                <p className="text-[11px] text-gray-400">{addPalletSize} per pallet for this plant</p>
              )}
            </div>
          )}

          <DialogFooter>
            <Button variant="outline" className="rounded-xl" onClick={resetAddDialog}>
              Cancel
            </Button>
            <Button
              className="rounded-xl bg-[#001d6e] hover:bg-[#00154b] text-white"
              disabled={!addPicked}
              onClick={confirmAddItem}
            >
              <Plus className="h-4 w-4 mr-1" /> Add
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </Dialog>
  );
}
