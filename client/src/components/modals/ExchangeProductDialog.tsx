import { useEffect, useRef, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { ArrowLeftRight, Camera, Keyboard, Loader2, Search, X } from "lucide-react";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { useToast } from "@/hooks/use-toast";
import { apiRequest } from "@/lib/queryClient";
import BarcodeScanner from "@/lib/barcodeScanner";
import type { Product } from "@shared/schema";

export type ExchangeSourceRow = {
  barcode: string;
  itemName: string;
  plant: string;
  availableStock: number;
};

type ExchangeProductDialogProps = {
  source: ExchangeSourceRow | null;
  onClose: () => void;
};

// Manual stock swap between two products at one plant — "this physical stock was actually
// product B, not product A". Source is whichever Overall Stock row the Exchange button was
// clicked on (locked, read-only here); the target is picked either by camera scan or manual
// search, mirroring the Camera/Manual toggle already used on the Scan page. Posts to
// /reports/exchange-stock, which writes two rows into the existing stock_movements ledger
// (type='exchange') — no dedicated table, and existing scan history is never touched, only
// added to (see that endpoint's own comment for the full rationale).
export default function ExchangeProductDialog({ source, onClose }: ExchangeProductDialogProps) {
  const { toast } = useToast();
  const queryClient = useQueryClient();

  const [mode, setMode] = useState<"manual" | "camera">("manual");
  const [search, setSearch] = useState("");
  const [target, setTarget] = useState<Product | null>(null);
  const [removeQty, setRemoveQty] = useState("1");
  const [addQty, setAddQty] = useState("1");
  const [reason, setReason] = useState("");
  const [cameraError, setCameraError] = useState<string | null>(null);

  const videoRef = useRef<HTMLVideoElement | null>(null);

  // Reset local state every time a new source row is opened. Quantities default to the
  // source's full available stock (e.g. 20 in stock → defaults to 20, not 1) since exchanging
  // the whole quantity is the common case — edit the field if only part of it should move.
  useEffect(() => {
    if (!source) return;
    setMode("manual");
    setSearch("");
    setTarget(null);
    setRemoveQty(String(source.availableStock || 1));
    setAddQty(String(source.availableStock || 1));
    setReason("");
    setCameraError(null);
  }, [source]);

  const { data: allProducts = [] } = useQuery<Product[]>({
    queryKey: ["/api/products", "all"],
    queryFn: async () => await apiRequest("GET", "/api/products?all=true", undefined, false, true),
    enabled: !!source,
    staleTime: 60_000,
  });

  const searchResults = (() => {
    const q = search.trim().toLowerCase();
    if (!q || !source) return [];
    return allProducts
      .filter((p) => (p.barcode ?? "").toLowerCase() !== source.barcode.toLowerCase())
      .filter((p) =>
        (p.name ?? "").toLowerCase().includes(q) ||
        (p.barcode ?? "").toLowerCase().includes(q) ||
        (p.itemNo ?? "").toLowerCase().includes(q),
      )
      .slice(0, 20);
  })();

  // ── Camera scanning — same BarcodeScanner class the Scan page uses ─────────────────────────
  useEffect(() => {
    if (mode !== "camera" || !source || !videoRef.current) return;
    let cancelled = false;
    const scanner = new BarcodeScanner({
      onDetected: (result) => {
        if (cancelled) return;
        const code = result.getText();
        const match = allProducts.find((p) => (p.barcode ?? "").toLowerCase() === code.toLowerCase());
        if (!match) {
          setCameraError(`No product found for barcode "${code}"`);
          return;
        }
        if (match.barcode.toLowerCase() === source.barcode.toLowerCase()) {
          setCameraError("That's the same product you're exchanging from — scan a different one.");
          return;
        }
        setTarget(match);
        setCameraError(null);
        setMode("manual"); // stop the camera once a match is found
      },
      onError: (err) => { if (!cancelled) setCameraError(err.message); },
    });
    scanner.start(videoRef.current);
    return () => { cancelled = true; scanner.stop(); };
  }, [mode, source, allProducts]);

  const exchangeMutation = useMutation({
    mutationFn: async () => {
      if (!source || !target) throw new Error("Pick a target product first");
      const response = await apiRequest("POST", "/api/scan-sessions/reports/exchange-stock", {
        fromBarcode: source.barcode,
        toBarcode: target.barcode,
        plant: source.plant,
        removeQty: Number(removeQty),
        addQty: Number(addQty),
        reason: reason.trim() || undefined,
      });
      return response.json();
    },
    onSuccess: async (data) => {
      toast({
        title: "Exchange complete",
        description: `${data.from.removedQty} × ${data.from.name} exchanged for ${data.to.addedQty} × ${data.to.name}.`,
        className: "bg-emerald-50 border-emerald-200 text-emerald-900",
      });
      await queryClient.invalidateQueries({ queryKey: ["/api/scan-sessions/reports/plant-stock"] });
      await queryClient.invalidateQueries({ queryKey: ["/api/scan-sessions/reports/scan-history"] });
      onClose();
    },
    onError: (error: any) => {
      toast({ title: "Exchange failed", description: error.message, variant: "destructive" });
    },
  });

  const removeQtyNum = Number(removeQty) || 0;
  const addQtyNum = Number(addQty) || 0;
  const overStock = source != null && removeQtyNum > source.availableStock;
  const canSubmit = !!target && removeQtyNum > 0 && addQtyNum > 0 && !overStock;

  return (
    <Dialog open={!!source} onOpenChange={(open) => { if (!open) onClose(); }}>
      <DialogContent className="max-w-lg">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2 text-[#001d6e]">
            <ArrowLeftRight className="h-4 w-4" /> Exchange Product
          </DialogTitle>
          <DialogDescription>
            Move stock from one product to a different one, at the same plant.
          </DialogDescription>
        </DialogHeader>

        {source && (
          <div className="space-y-4">
            {/* Source — locked, read-only */}
            <div className="rounded-md border bg-gray-50 px-3 py-2">
              <p className="text-[11px] font-semibold uppercase tracking-wide text-gray-400">From</p>
              <p className="text-sm font-semibold text-gray-900">{source.itemName}</p>
              <p className="text-xs text-gray-500 font-mono">
                {source.barcode} · {source.plant} · {source.availableStock} in stock
              </p>
            </div>

            {/* Target — scan or search */}
            <div className="space-y-2">
              <div className="flex items-center justify-between">
                <Label className="text-xs font-semibold uppercase tracking-wide text-gray-500">To</Label>
                {!target && (
                  <div className="flex border border-gray-300 divide-x divide-gray-300">
                    <button type="button" onClick={() => setMode("manual")}
                      className={`flex items-center gap-1 px-2.5 py-1 text-xs font-medium ${mode === "manual" ? "bg-[#001d6e] text-white" : "text-gray-500 hover:bg-gray-50"}`}>
                      <Keyboard className="h-3 w-3" /> Manual
                    </button>
                    <button type="button" onClick={() => setMode("camera")}
                      className={`flex items-center gap-1 px-2.5 py-1 text-xs font-medium ${mode === "camera" ? "bg-[#001d6e] text-white" : "text-gray-500 hover:bg-gray-50"}`}>
                      <Camera className="h-3 w-3" /> Scan
                    </button>
                  </div>
                )}
              </div>

              {target ? (
                <div className="flex items-center justify-between rounded-md border border-[#001d6e]/30 bg-[#001d6e]/5 px-3 py-2">
                  <div className="min-w-0">
                    <p className="truncate text-sm font-semibold text-[#001d6e]">{target.name}</p>
                    <p className="text-xs text-gray-500 font-mono">{target.barcode}</p>
                  </div>
                  <Button size="sm" variant="ghost" className="h-7 w-7 p-0 shrink-0" onClick={() => setTarget(null)}>
                    <X className="h-3.5 w-3.5" />
                  </Button>
                </div>
              ) : mode === "manual" ? (
                <div className="space-y-1">
                  <div className="relative">
                    <Search className="absolute left-2.5 top-2.5 h-3.5 w-3.5 text-gray-400" />
                    <Input className="pl-8 h-9 text-sm" placeholder="Search by name or barcode…"
                      value={search} onChange={(e) => setSearch(e.target.value)} />
                  </div>
                  {searchResults.length > 0 && (
                    <div className="max-h-40 overflow-y-auto rounded-md border divide-y">
                      {searchResults.map((p) => (
                        <button key={p.id} type="button" onClick={() => { setTarget(p); setSearch(""); }}
                          className="w-full px-3 py-1.5 text-left text-xs hover:bg-gray-50">
                          <span className="font-medium text-gray-900">{p.name}</span>
                          <span className="ml-2 font-mono text-gray-400">{p.barcode}</span>
                        </button>
                      ))}
                    </div>
                  )}
                </div>
              ) : (
                <div className="space-y-1.5">
                  <div className="relative overflow-hidden rounded-md bg-black" style={{ height: "180px" }}>
                    <video ref={videoRef} className="h-full w-full object-cover" muted playsInline />
                  </div>
                  {cameraError && <p className="text-xs text-red-600">{cameraError}</p>}
                </div>
              )}
            </div>

            {/* Quantities — independent, don't have to match */}
            <div className="grid grid-cols-2 gap-3">
              <div className="space-y-1">
                <Label className="text-xs text-gray-500">Remove from source</Label>
                <Input type="number" min={1} value={removeQty} onChange={(e) => setRemoveQty(e.target.value)} />
                {overStock && (
                  <p className="text-[11px] text-red-600">Only {source.availableStock} available.</p>
                )}
              </div>
              <div className="space-y-1">
                <Label className="text-xs text-gray-500">Add to target</Label>
                <Input type="number" min={1} value={addQty} onChange={(e) => setAddQty(e.target.value)} />
              </div>
            </div>

            <div className="space-y-1">
              <Label className="text-xs text-gray-500">Reason (optional)</Label>
              <Input value={reason} onChange={(e) => setReason(e.target.value)} placeholder="e.g. wrong product received, customer swap" />
            </div>
          </div>
        )}

        <DialogFooter>
          <Button variant="outline" onClick={onClose} disabled={exchangeMutation.isPending}>Cancel</Button>
          <Button
            onClick={() => exchangeMutation.mutate()}
            disabled={!canSubmit || exchangeMutation.isPending}
            className="bg-[#001d6e] hover:bg-[#00154b] text-white"
          >
            {exchangeMutation.isPending ? <Loader2 className="h-4 w-4 mr-1.5 animate-spin" /> : <ArrowLeftRight className="h-4 w-4 mr-1.5" />}
            Exchange
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
