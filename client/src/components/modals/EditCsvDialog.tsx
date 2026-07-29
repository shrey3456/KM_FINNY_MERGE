import { useEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { hasPageWriteAccess } from "@/lib/permissions";
import { AlertCircle, Loader2, Pencil, Plus, Save, Trash2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
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
// itemName search/autocomplete on newly-added rows below.
type CatalogProduct = { id: number; name: string; barcode: string; sapCode?: string | null };

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

  // Full product catalog (synced from Notion) — searched by name/barcode/SAP as the operator
  // types an item name on a newly-added row, so barcode + SAP code auto-fill from a pick
  // instead of being typed by hand and risking a typo.
  const { data: productsRaw } = useQuery<any>({
    queryKey: ["/api/products", { all: "true" }],
  });
  const products: CatalogProduct[] = Array.isArray(productsRaw) ? productsRaw : (productsRaw?.results ?? []);

  // Which row's item-name dropdown is open — only ever a row without an id yet (a brand-new,
  // unsaved row). Existing rows keep their plain, freely-editable text inputs untouched.
  const [suggestKey, setSuggestKey] = useState<string | null>(null);
  const suggestRow = rows.find((r) => r.key === suggestKey);
  const productMatches = useMemo(() => {
    const q = suggestRow?.itemName.trim().toLowerCase();
    if (!q) return [];
    return products
      .filter((p) =>
        p.name?.toLowerCase().includes(q) ||
        p.barcode?.toLowerCase().includes(q) ||
        p.sapCode?.toLowerCase().includes(q)
      )
      .slice(0, 8);
  }, [products, suggestRow?.itemName]);

  // The dropdown is rendered fixed-position (see the bottom of this component), not nested
  // inside the table — the table's own overflow-x-auto wrapper forces its overflow-y to
  // "auto" too (a plain CSS rule: the two axes can't be independently visible/clipped), which
  // silently clipped an absolutely-positioned dropdown to nothing for a newly-added row (always
  // the last row, with zero room below it inside that wrapper). Measuring the input's on-screen
  // position and rendering fixed instead escapes that clipping ancestor entirely.
  const itemNameRefs = useRef<Record<string, HTMLInputElement | null>>({});
  const [suggestPos, setSuggestPos] = useState<{ top: number; left: number; width: number } | null>(null);

  // Tracked in a ref alongside the state so the blur handler's setTimeout (which closes over a
  // stale suggestKey from whatever render it was scheduled in) can read the CURRENT value
  // instead — otherwise a fast focus-to-another-row blur could close the wrong row's dropdown.
  const suggestKeyRef = useRef<string | null>(null);
  useEffect(() => { suggestKeyRef.current = suggestKey; }, [suggestKey]);

  function openSuggest(key: string) {
    setSuggestKey(key);
    const el = itemNameRefs.current[key];
    if (el) {
      const r = el.getBoundingClientRect();
      setSuggestPos({ top: r.bottom, left: r.left, width: r.width });
    }
  }
  function closeSuggest() {
    setSuggestKey(null);
    setSuggestPos(null);
  }
  // A stale-positioned dropdown left open through a scroll (dialog body or page) would drift
  // away from its input — simplest robust fix is to just close it, same as a blur would.
  useEffect(() => {
    if (!suggestKey) return;
    const onScroll = () => closeSuggest();
    window.addEventListener("scroll", onScroll, true);
    return () => window.removeEventListener("scroll", onScroll, true);
  }, [suggestKey]);

  function selectProduct(key: string, product: CatalogProduct) {
    setRows((prev) => prev.map((r) => (r.key === key
      ? { ...r, itemName: product.name, barcode: product.barcode, sapCode: product.sapCode ?? "" }
      : r)));
    closeSuggest();
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

  function addRow() {
    setRows((prev) => [
      ...prev,
      { key: newTempKey(), barcode: "", itemName: "", sapCode: "", quantity: "0", expectedPallets: "", scannedQty: 0 },
    ]);
  }

  const session = itemsQuery.data?.session;

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
              <Button variant="outline" size="sm" className="shrink-0 rounded-xl" onClick={addRow}>
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
                          ref={(el) => { itemNameRefs.current[row.key] = el; }}
                          className="h-7 w-full rounded-md text-xs"
                          value={row.itemName}
                          disabled={!canWrite}
                          placeholder={row.id == null ? "Search product name/barcode/SAP…" : undefined}
                          onChange={(e) => {
                            updateRow(row.key, "itemName", e.target.value);
                            if (row.id == null) openSuggest(row.key);
                          }}
                          onFocus={() => { if (row.id == null) openSuggest(row.key); }}
                          onBlur={() => setTimeout(() => { if (suggestKeyRef.current === row.key) closeSuggest(); }, 150)}
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

      {/* Portaled to document.body rather than rendered inline: DialogContent itself carries a
          CSS transform (translate-x/-y, for its open/close animation), and a transformed
          ancestor becomes the containing block for position:fixed descendants — so a fixed
          dropdown left inside it would be positioned relative to the dialog, not the viewport,
          silently landing in the wrong place. Portaling to body escapes that entirely. */}
      {suggestKey && suggestPos && createPortal(
        <div
          className="fixed z-[100] max-h-56 overflow-y-auto rounded-lg border border-gray-200 bg-white text-left text-xs shadow-lg"
          style={{ top: suggestPos.top + 4, left: suggestPos.left, width: suggestPos.width }}
        >
          {productMatches.length === 0 ? (
            <p className="px-2.5 py-2 text-gray-400">No matching product — type it manually.</p>
          ) : (
            productMatches.map((p) => (
              <button
                key={p.id}
                type="button"
                onMouseDown={(e) => { e.preventDefault(); selectProduct(suggestKey, p); }}
                className="flex w-full items-center gap-2 px-2.5 py-1.5 text-left hover:bg-gray-50"
              >
                <span className="min-w-0 flex-1 truncate font-medium text-gray-900">{p.name}</span>
                <span className="shrink-0 font-mono text-[10px] text-gray-400">{p.barcode}</span>
              </button>
            ))
          )}
        </div>,
        document.body,
      )}
    </Dialog>
  );
}
