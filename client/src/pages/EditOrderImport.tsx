import { useEffect, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { hasPageWriteAccess } from "../lib/permissions";
import { AlertCircle, FileEdit, Loader2, Plus, Save, Trash2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Badge } from "@/components/ui/badge";
import { Alert, AlertDescription } from "@/components/ui/alert";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { useToast } from "@/hooks/use-toast";
import { apiRequest } from "@/lib/queryClient";

function getLocalISODate(date = new Date()): string {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

interface SessionOption {
  id: number;
  plant: string;
  csvFileName: string;
  orderDate: string;
  scanStatus: string;
  rowCount: number;
  partIndex: number | null;
}

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

export default function EditOrderImport() {
  const { toast } = useToast();
  const qc = useQueryClient();
  const canWrite = hasPageWriteAccess("order-import-edit");

  const [date, setDate] = useState(getLocalISODate());
  const [plantFilter, setPlantFilter] = useState(""); // "" = all plants the user may see
  const [selectedSessionId, setSelectedSessionId] = useState<number | null>(null);
  const [rows, setRows] = useState<EditableItem[]>([]);
  const [removedIds, setRemovedIds] = useState<number[]>([]);

  // All configured plants — used to populate the plant switcher for admins only.
  const { data: allPlants = [] } = useQuery<{ id: number; name: string }[]>({
    queryKey: ["/api/plants"],
    queryFn: () => apiRequest("GET", "/api/plants", undefined, false, true),
  });

  const sessionsQuery = useQuery({
    queryKey: ["/api/order-import-edit/sessions", date, plantFilter],
    queryFn: async (): Promise<{ sessions: SessionOption[]; plants: string[] | null }> =>
      (
        await apiRequest(
          "GET",
          `/api/order-import-edit/sessions?date=${date}${plantFilter ? `&plant=${encodeURIComponent(plantFilter)}` : ""}`,
        )
      ).json(),
    enabled: !!date,
  });

  const sessions = sessionsQuery.data?.sessions ?? [];
  const allowedPlants = sessionsQuery.data?.plants ?? null; // null = admin (all plants)
  const isAdmin = allowedPlants === null;
  const plantOptions = isAdmin
    ? allPlants.map((p) => p.name)
    : (allowedPlants ?? []).map((p) => p.toUpperCase());

  useEffect(() => {
    setSelectedSessionId(null);
    setRows([]);
    setRemovedIds([]);
  }, [date, plantFilter]);

  const itemsQuery = useQuery({
    queryKey: ["/api/order-import-edit/sessions", selectedSessionId, "items"],
    queryFn: async (): Promise<{ session: any; items: any[] }> =>
      (await apiRequest("GET", `/api/order-import-edit/sessions/${selectedSessionId}/items`)).json(),
    enabled: selectedSessionId != null,
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
    setRemovedIds([]);
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
      return (await apiRequest("PUT", `/api/order-import-edit/sessions/${selectedSessionId}`, payload)).json();
    },
    onSuccess: async () => {
      toast({
        title: "Saved",
        description: "The CSV's items have been updated.",
        className: "bg-emerald-50 border-emerald-200 text-emerald-900",
      });
      await qc.invalidateQueries({ queryKey: ["/api/order-import-edit/sessions", selectedSessionId, "items"] });
      await qc.invalidateQueries({ queryKey: ["/api/order-import-edit/sessions", date] });
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

  const selectedSession = sessions.find((s) => s.id === selectedSessionId);

  return (
    <div className="p-4 md:p-6 space-y-4">
      <div className="flex items-center gap-2">
        <FileEdit className="h-6 w-6 text-[#001d6e]" />
        <h1 className="text-xl font-semibold text-[#001d6e]">Edit Order Import CSV</h1>
      </div>

      {!canWrite && (
        <Alert className="bg-amber-50 border-amber-200">
          <AlertCircle className="h-4 w-4 text-amber-600" />
          <AlertDescription className="text-amber-800">
            You have read-only access to this page. You can view items but can't edit or save changes.
          </AlertDescription>
        </Alert>
      )}

      <Card>
        <CardHeader>
          <CardTitle className="text-base text-[#001d6e]">Select a CSV</CardTitle>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="grid grid-cols-1 md:grid-cols-3 gap-4 max-w-3xl">
            <div>
              <Label>Order Date</Label>
              <Input type="date" value={date} onChange={(e) => setDate(e.target.value)} />
            </div>
            <div>
              <Label>Plant</Label>
              <Select value={plantFilter || "_all_"} onValueChange={(v) => setPlantFilter(v === "_all_" ? "" : v)}>
                <SelectTrigger>
                  <SelectValue placeholder="All plants" />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="_all_">{isAdmin ? "All plants" : "All my plants"}</SelectItem>
                  {plantOptions.map((p) => (
                    <SelectItem key={p} value={p}>
                      {p}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <div>
              <Label>CSV File</Label>
              <Select
                value={selectedSessionId != null ? String(selectedSessionId) : ""}
                onValueChange={(v) => setSelectedSessionId(Number(v))}
              >
                <SelectTrigger>
                  <SelectValue placeholder={sessionsQuery.isLoading ? "Loading…" : "Select a CSV"} />
                </SelectTrigger>
                <SelectContent>
                  {sessions.length === 0 && !sessionsQuery.isLoading && (
                    <div className="px-3 py-2 text-sm text-gray-400">No pending CSVs for this date</div>
                  )}
                  {sessions.map((s) => (
                    <SelectItem key={s.id} value={String(s.id)}>
                      {s.plant} — {s.csvFileName}
                      {s.partIndex ? ` (Part ${s.partIndex})` : ""}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
          </div>
          <p className="text-xs text-gray-400">
            Only CSVs that aren't completed yet are shown here — a finished CSV can no longer be edited.
          </p>
        </CardContent>
      </Card>

      {selectedSessionId != null && (
        <Card>
          <CardHeader className="flex flex-row items-center justify-between">
            <CardTitle className="text-base text-[#001d6e]">
              {selectedSession ? `${selectedSession.plant} — ${selectedSession.csvFileName}` : "Items"}
            </CardTitle>
            {canWrite && (
              <div className="flex gap-2">
                <Button variant="outline" size="sm" onClick={addRow}>
                  <Plus className="h-4 w-4 mr-1" /> Add Row
                </Button>
                <Button
                  size="sm"
                  onClick={() => saveMutation.mutate()}
                  disabled={saveMutation.isPending || rows.length === 0}
                >
                  {saveMutation.isPending ? (
                    <Loader2 className="h-4 w-4 mr-1 animate-spin" />
                  ) : (
                    <Save className="h-4 w-4 mr-1" />
                  )}
                  Save
                </Button>
              </div>
            )}
          </CardHeader>
          <CardContent>
            {itemsQuery.isLoading ? (
              <div className="flex justify-center py-6">
                <Loader2 className="h-5 w-5 animate-spin text-[#001d6e]" />
              </div>
            ) : (
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
            )}
          </CardContent>
        </Card>
      )}
    </div>
  );
}
