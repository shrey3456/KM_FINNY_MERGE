import { useEffect, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { hasPageWriteAccess } from "@/lib/permissions";
import { AlertCircle, Loader2, Plus, Save, Trash2 } from "lucide-react";
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
      <DialogContent className="max-w-4xl max-h-[85vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle className="text-[#001d6e]">
            {session ? `Edit — ${session.plant} · ${session.csvFileName}` : "Edit CSV"}
          </DialogTitle>
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
            {canWrite && (
              <div className="flex justify-end">
                <Button variant="outline" size="sm" onClick={addRow}>
                  <Plus className="h-4 w-4 mr-1" /> Add Row
                </Button>
              </div>
            )}
            <div className="overflow-x-auto rounded-md border">
              <table className="w-max min-w-full border-collapse text-xs">
                <thead>
                  <tr>
                    {["#", "Barcode", "Item Name", "SAP Code", "Qty", "Pallets", "Scanned", ""].map((h) => (
                      <th
                        key={h}
                        className="sticky top-0 whitespace-nowrap border-b border-r bg-slate-100 px-3 py-2 text-left font-semibold text-[#001d6e]"
                      >
                        {h}
                      </th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {rows.map((row, idx) => (
                    <tr key={row.key} className={`border-b ${idx % 2 === 1 ? "bg-gray-50" : "bg-white"}`}>
                      <td className="border-r px-3 py-1.5 text-gray-400">{idx + 1}</td>
                      <td className="border-r px-2 py-1">
                        <Input
                          className="h-7 text-xs"
                          value={row.barcode}
                          disabled={!canWrite}
                          onChange={(e) => updateRow(row.key, "barcode", e.target.value)}
                        />
                      </td>
                      <td className="border-r px-2 py-1">
                        <Input
                          className="h-7 text-xs min-w-[160px]"
                          value={row.itemName}
                          disabled={!canWrite}
                          onChange={(e) => updateRow(row.key, "itemName", e.target.value)}
                        />
                      </td>
                      <td className="border-r px-2 py-1">
                        <Input
                          className="h-7 text-xs"
                          value={row.sapCode}
                          disabled={!canWrite}
                          onChange={(e) => updateRow(row.key, "sapCode", e.target.value)}
                        />
                      </td>
                      <td className="border-r px-2 py-1">
                        <Input
                          className="h-7 text-xs w-20 text-right"
                          type="number"
                          value={row.quantity}
                          disabled={!canWrite}
                          onChange={(e) => updateRow(row.key, "quantity", e.target.value)}
                        />
                      </td>
                      <td className="border-r px-2 py-1">
                        <Input
                          className="h-7 text-xs w-20 text-right"
                          type="number"
                          value={row.expectedPallets}
                          disabled={!canWrite}
                          onChange={(e) => updateRow(row.key, "expectedPallets", e.target.value)}
                        />
                      </td>
                      <td className="border-r px-3 py-1.5 text-right">
                        {row.scannedQty > 0 ? (
                          <Badge variant="outline" className="text-emerald-700 border-emerald-200 bg-emerald-50">
                            {row.scannedQty} done
                          </Badge>
                        ) : (
                          <span className="text-gray-300">—</span>
                        )}
                      </td>
                      <td className="px-2 py-1 text-right">
                        {canWrite && (
                          <Button
                            variant="ghost"
                            size="sm"
                            className="h-7 w-7 p-0 text-red-500 hover:text-red-700"
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
                <Button variant="outline" onClick={onClose} disabled={saveMutation.isPending}>
                  Cancel
                </Button>
                <Button onClick={() => saveMutation.mutate()} disabled={saveMutation.isPending || rows.length === 0}>
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
    </Dialog>
  );
}
