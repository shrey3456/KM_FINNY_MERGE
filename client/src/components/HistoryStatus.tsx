import { scanTypeLabel } from "@/pages/Scanning/ScanHistory";

// The Status cell of every per-item scan history table (Load Operations, Unload Operations, Scan
// Operations, Overall Scan Ops). It uses the exact words and badge colours of Scan History's Type
// column — "<where> <kind>": Scan / Load / Unload, then Regular / Extra / Adjust / Credit — and adds
// a red "Voided" when the entry was undone, so a scan reads the same on every page.
export function HistoryStatus({
  source, isExtra, isAdjust, isCredit, voided, voidReason, creditedQty, creditedTo, creditedFrom,
}: {
  source: "scan" | "loading" | "unloading";
  isExtra?: boolean | null;
  isAdjust?: boolean | null;
  isCredit?: boolean | null;
  voided?: boolean | null;
  voidReason?: string | null;
  // An Extra that was given to an EARLIER shortfall: how much, and which CSV(s) it closed. A credit row: the Extra it came from.
  creditedQty?: number | null;
  creditedTo?: Array<{ csv: string; orderDate: string | null; qty: number }> | null;
  creditedFrom?: { csv: string; orderDate: string | null } | null;
}) {
  const t = scanTypeLabel({ isExtra: !!isExtra, isAdjust: !!isAdjust, sourceKind: source });
  // A credit-transfer row has no kind of its own in Scan History's labels — name it here.
  const label = isCredit && !isAdjust ? `${t.source} Credit` : t.label;
  return (
    <span className="inline-flex flex-wrap items-center gap-1.5">
      <span className={`inline-flex items-center whitespace-nowrap rounded-full px-2 py-0.5 text-[11px] font-medium ${t.className}`}>{label}</span>
      {voided && <span className="whitespace-nowrap text-[11px] font-semibold text-red-500" title={voidReason ?? undefined}>Voided</span>}
      {!voided && creditedTo && creditedTo.length > 0 && (
        <span className="text-[11px] font-medium text-amber-700">
          {creditedQty ?? creditedTo.reduce((s, c) => s + c.qty, 0)} closed an earlier shortfall → {creditedTo.map((c) => `${c.csv}${c.orderDate ? ` (${c.orderDate})` : ""}${creditedTo.length > 1 ? ` ${c.qty}` : ""}`).join(", ")}
        </span>
      )}
      {!voided && creditedFrom && (
        <span className="text-[11px] font-medium text-amber-700">from an Extra on {creditedFrom.csv}{creditedFrom.orderDate ? ` (${creditedFrom.orderDate})` : ""}</span>
      )}
    </span>
  );
}
