import { useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Pencil, Loader2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { useToast } from "@/hooks/use-toast";
import { apiRequest } from "@/lib/queryClient";

// Settings > Data Management > Edit Opening Stock. Lists what the Opening Stock imports (and earlier edits) left on the
// ledger — one line per item + plant + "as of" date — and lets an admin change a quantity, add an item that was left
// out, or set one to 0. Each save writes a correcting ledger row and moves the live stock by the same difference (never
// below zero), so Stock Overview's Opening follows at once. Server: server/routes/opening-stock.ts.

type Entry = { plant: string; barcode: string; itemName: string | null; ledgerDate: string; asOfDate: string; qty: number; entries: number; liveStock: number };
type EntriesResponse = { items: Entry[]; total: number; dates: string[]; plants: string[]; sumQty: number };

const keyOf = (e: { plant: string; barcode: string; asOfDate: string }) => `${e.plant}|${e.barcode}|${e.asOfDate}`;
const todayLocal = () => {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
};

export default function OpeningStockEditorCard({ isAdmin }: { isAdmin: boolean }) {
  const { toast } = useToast();
  const queryClient = useQueryClient();
  const [open, setOpen] = useState(false);
  const [plant, setPlant] = useState("");
  const [asOf, setAsOf] = useState("");
  const [search, setSearch] = useState("");
  const [edits, setEdits] = useState<Record<string, string>>({});
  const [savingKey, setSavingKey] = useState<string | null>(null);
  const [adding, setAdding] = useState({ plant: "", barcode: "", quantity: "", asOfDate: "" });
  const [addBusy, setAddBusy] = useState(false);

  const url = `/api/opening-stock/entries?plant=${encodeURIComponent(plant)}&asOf=${encodeURIComponent(asOf)}&search=${encodeURIComponent(search)}`;
  const query = useQuery<EntriesResponse>({
    queryKey: ["/api/opening-stock/entries", plant, asOf, search],
    queryFn: () => apiRequest("GET", url, undefined, false, true),
    enabled: open && isAdmin,
  });
  const plantsQuery = useQuery<{ name: string }[]>({
    queryKey: ["/api/plants"],
    queryFn: () => apiRequest("GET", "/api/plants").then((r: any) => r.json()),
    enabled: open && isAdmin,
  });

  const refresh = () => {
    queryClient.invalidateQueries({ queryKey: ["/api/opening-stock/entries"] });
    queryClient.invalidateQueries({ queryKey: ["/api/scan-sessions/reports/plant-stock"] });
    queryClient.invalidateQueries({ queryKey: ["/api/products"] });
  };

  async function save(e: Entry) {
    const k = keyOf(e);
    const raw = edits[k];
    const quantity = Math.round(Number(raw));
    if (raw === undefined || raw === "" || !Number.isFinite(quantity) || quantity < 0) {
      toast({ title: "Enter a quantity of 0 or more", variant: "destructive" });
      return;
    }
    setSavingKey(k);
    try {
      const r = await apiRequest("POST", "/api/opening-stock/entry", { plant: e.plant, barcode: e.barcode, asOfDate: e.asOfDate, quantity }, false, true);
      toast({ title: r.delta === 0 ? "No change" : "Opening stock updated", description: r.delta === 0 ? undefined : `${e.barcode} at ${e.plant}: ${r.previous.toLocaleString()} → ${quantity.toLocaleString()}.` });
      setEdits((cur) => { const n = { ...cur }; delete n[k]; return n; });
      refresh();
    } catch (err: any) {
      toast({ title: "Could not change it", description: err?.message, variant: "destructive" });
    } finally { setSavingKey(null); }
  }

  async function addItem() {
    const quantity = Math.round(Number(adding.quantity));
    const date = adding.asOfDate || query.data?.dates?.[0] || todayLocal();
    if (!adding.plant || !adding.barcode.trim() || !Number.isFinite(quantity) || quantity < 0) {
      toast({ title: "Pick a plant, enter a barcode and a quantity", variant: "destructive" });
      return;
    }
    setAddBusy(true);
    try {
      const r = await apiRequest("POST", "/api/opening-stock/entry", { plant: adding.plant, barcode: adding.barcode.trim(), asOfDate: date, quantity }, false, true);
      toast({ title: "Opening stock saved", description: `${adding.barcode.trim()} at ${adding.plant}: ${r.previous.toLocaleString()} → ${quantity.toLocaleString()} (as of ${date}).` });
      setAdding((a) => ({ ...a, barcode: "", quantity: "" }));
      refresh();
    } catch (err: any) {
      toast({ title: "Could not add it", description: err?.message, variant: "destructive" });
    } finally { setAddBusy(false); }
  }

  const data = query.data;
  return (
    <div className="p-4 border rounded-lg bg-gray-50">
      <h4 className="font-medium flex items-center"><Pencil className="h-4 w-4 mr-2" /> Edit Opening Stock</h4>
      <p className="text-sm text-gray-600 mt-1 mb-3">
        See the opening stock that was imported from a CSV, change a quantity, add an item that was missed, or set one to 0. Stock Overview and the live stock follow the change. Admin only.
      </p>
      <Button variant="outline" size="sm" onClick={() => setOpen(true)} disabled={!isAdmin} title={!isAdmin ? "Admin access required" : undefined}>
        Edit Opening Stock
      </Button>

      <Dialog open={open} onOpenChange={(o) => { if (!o && !savingKey && !addBusy) setOpen(false); }}>
        <DialogContent className="max-w-5xl max-h-[90vh] flex flex-col rounded-xl">
          <DialogHeader>
            <DialogTitle>Edit Opening Stock</DialogTitle>
            <DialogDescription>
              Each line is one item at one plant for one "as of" date. Change the Opening quantity and press Save. The live stock moves by the same difference and never goes below zero.
            </DialogDescription>
          </DialogHeader>

          <div className="flex flex-wrap items-end gap-3">
            <div className="space-y-1">
              <Label className="text-xs">Plant</Label>
              <Select value={plant || "__all__"} onValueChange={(v) => setPlant(v === "__all__" ? "" : v)}>
                <SelectTrigger className="h-9 w-40"><SelectValue /></SelectTrigger>
                <SelectContent>
                  <SelectItem value="__all__">All plants</SelectItem>
                  {(data?.plants ?? []).map((p) => <SelectItem key={p} value={p}>{p}</SelectItem>)}
                </SelectContent>
              </Select>
            </div>
            <div className="space-y-1">
              <Label className="text-xs">As of</Label>
              <Select value={asOf || "__all__"} onValueChange={(v) => setAsOf(v === "__all__" ? "" : v)}>
                <SelectTrigger className="h-9 w-44"><SelectValue /></SelectTrigger>
                <SelectContent>
                  <SelectItem value="__all__">All dates</SelectItem>
                  {(data?.dates ?? []).map((d) => <SelectItem key={d} value={d}>{d}</SelectItem>)}
                </SelectContent>
              </Select>
            </div>
            <div className="space-y-1 flex-1 min-w-[180px]">
              <Label className="text-xs">Search item or barcode</Label>
              <Input className="h-9" value={search} onChange={(e) => setSearch(e.target.value)} placeholder="Type to search…" />
            </div>
            {data && <div className="pb-2 text-xs text-gray-500">{data.total.toLocaleString()} line(s) · {data.sumQty.toLocaleString()} boxes{data.total > data.items.length ? ` · showing the first ${data.items.length}` : ""}</div>}
          </div>

          <div className="min-h-0 flex-1 overflow-auto border">
            <table className="w-full text-xs">
              <thead className="sticky top-0 bg-gray-100">
                <tr className="text-left text-gray-500">
                  <th className="px-2 py-1.5">As of</th><th>Plant</th><th>Item</th>
                  <th className="text-right">Live stock</th><th className="w-32 text-right">Opening</th><th className="w-20 pr-2"></th>
                </tr>
              </thead>
              <tbody>
                {query.isLoading && <tr><td colSpan={6} className="py-6 text-center"><Loader2 className="mx-auto h-5 w-5 animate-spin" /></td></tr>}
                {(data?.items ?? []).map((e) => {
                  const k = keyOf(e);
                  const val = edits[k] ?? String(e.qty);
                  const changed = edits[k] !== undefined && Number(edits[k]) !== e.qty;
                  return (
                    <tr key={k} className={`border-b ${changed ? "bg-amber-50" : ""}`}>
                      <td className="px-2 py-1.5 tabular-nums">{e.asOfDate}</td>
                      <td>{e.plant}</td>
                      <td className="max-w-[360px]">
                        <div className="truncate font-medium" title={e.itemName ?? ""}>{e.itemName ?? "(not in Product Master)"}</div>
                        <div className="font-mono text-[11px] text-gray-500">{e.barcode}{e.entries > 1 ? ` · ${e.entries} entries` : ""}</div>
                      </td>
                      <td className="text-right tabular-nums text-gray-600">{e.liveStock.toLocaleString()}</td>
                      <td className="text-right">
                        <Input type="number" min={0} className="ml-auto h-8 w-28 text-right tabular-nums" value={val}
                          onChange={(ev) => setEdits((cur) => ({ ...cur, [k]: ev.target.value }))}
                          onKeyDown={(ev) => { if (ev.key === "Enter" && changed) save(e); }} />
                      </td>
                      <td className="pr-2 text-right">
                        <Button size="sm" className="h-7 px-3 text-xs" disabled={!changed || savingKey === k} onClick={() => save(e)}>
                          {savingKey === k ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : "Save"}
                        </Button>
                      </td>
                    </tr>
                  );
                })}
                {!query.isLoading && (data?.items.length ?? 0) === 0 && <tr><td colSpan={6} className="py-6 text-center text-gray-400">No opening stock found for this filter.</td></tr>}
              </tbody>
            </table>
          </div>

          <div className="rounded-lg border bg-gray-50 p-3">
            <p className="mb-2 text-xs font-semibold uppercase tracking-wide text-gray-500">Add an item that was left out</p>
            <div className="flex flex-wrap items-end gap-2">
              <div className="space-y-1">
                <Label className="text-xs">Plant</Label>
                <Select value={adding.plant} onValueChange={(v) => setAdding((a) => ({ ...a, plant: v }))}>
                  <SelectTrigger className="h-9 w-36"><SelectValue placeholder="Plant" /></SelectTrigger>
                  <SelectContent>{(plantsQuery.data ?? []).map((p) => <SelectItem key={p.name} value={p.name}>{p.name}</SelectItem>)}</SelectContent>
                </Select>
              </div>
              <div className="space-y-1">
                <Label className="text-xs">Barcode</Label>
                <Input className="h-9 w-44 font-mono" value={adding.barcode} onChange={(e) => setAdding((a) => ({ ...a, barcode: e.target.value }))} />
              </div>
              <div className="space-y-1">
                <Label className="text-xs">Opening quantity</Label>
                <Input type="number" min={0} className="h-9 w-32" value={adding.quantity} onChange={(e) => setAdding((a) => ({ ...a, quantity: e.target.value }))} />
              </div>
              <div className="space-y-1">
                <Label className="text-xs">As of</Label>
                <Input type="date" className="h-9 w-40" value={adding.asOfDate || data?.dates?.[0] || ""} onChange={(e) => setAdding((a) => ({ ...a, asOfDate: e.target.value }))} />
              </div>
              <Button size="sm" className="h-9" disabled={addBusy} onClick={addItem}>{addBusy ? <Loader2 className="h-4 w-4 animate-spin" /> : "Save item"}</Button>
            </div>
          </div>
        </DialogContent>
      </Dialog>
    </div>
  );
}
