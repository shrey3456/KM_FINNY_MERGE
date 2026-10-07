import { scanTypeLabel } from "@/pages/Scanning/ScanHistory";

// The Status cell of every per-item scan history table (Load Operations, Unload Operations, Scan
// Operations, Overall Scan Ops). It uses the exact words and badge colours of Scan History's Type
// column — "<where> <kind>": Scan / Load / Unload, then Regular / Extra / Adjust / Credit — and adds
// a red "Voided" when the entry was undone, so a scan reads the same on every page.
export function HistoryStatus({
  source, isExtra, isAdjust, isCredit, voided, voidReason,
}: {
  source: "scan" | "loading" | "unloading";
  isExtra?: boolean | null;
  isAdjust?: boolean | null;
  isCredit?: boolean | null;
  voided?: boolean | null;
  voidReason?: string | null;
}) {
  const t = scanTypeLabel({ isExtra: !!isExtra, isAdjust: !!isAdjust, sourceKind: source });
  // A credit-transfer row has no kind of its own in Scan History's labels — name it here.
  const label = isCredit && !isAdjust ? `${t.source} Credit` : t.label;
  return (
    <span className="inline-flex flex-wrap items-center gap-1.5">
      <span className={`inline-flex items-center whitespace-nowrap rounded-full px-2 py-0.5 text-[11px] font-medium ${t.className}`}>{label}</span>
      {voided && <span className="whitespace-nowrap text-[11px] font-semibold text-red-500" title={voidReason ?? undefined}>Voided</span>}
    </span>
  );
}
