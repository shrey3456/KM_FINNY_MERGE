import { Loader2 } from "lucide-react";
import { Dialog, DialogContent, DialogDescription, DialogTitle } from "@/components/ui/dialog";

// A popup that stays open for exactly as long as a sync runs. It has no close button and ignores
// clicks outside and Escape — dismissing it wouldn't stop the sync, and the page underneath
// shouldn't be touched halfway through one. Callers just pass `open` (true while it runs).
//
// `progress` is optional: syncs that report a phase and running count (Product Master, Vehicle
// Master) show "N of M done so far"; syncs that can't (Vehicle Planning, Proforma Slips) show only
// the title and a note, and the popup closes the moment `open` goes false.
export type SyncProgress = { phase: string; current: number; total: number | null };

export function SyncProgressDialog({
  open, title, progress, note,
}: {
  open: boolean;
  title: string;
  progress?: SyncProgress | null;
  note?: string;
}) {
  return (
    <Dialog open={open} onOpenChange={() => {}}>
      <DialogContent
        className="max-w-sm text-center"
        hideCloseButton
        onInteractOutside={(e) => e.preventDefault()}
        onEscapeKeyDown={(e) => e.preventDefault()}
      >
        <div className="flex flex-col items-center gap-3 py-4">
          <Loader2 className="h-8 w-8 animate-spin text-amber-500" />
          <DialogTitle className="text-base">{progress?.phase ?? title}</DialogTitle>
          <DialogDescription className="text-sm">
            {progress ? (
              <>
                {progress.current.toLocaleString()}
                {progress.total != null ? ` of ${progress.total.toLocaleString()}` : ""}
                {" "}done so far.{" "}
              </>
            ) : null}
            {note ?? "Please wait — this closes automatically once it's done."}
          </DialogDescription>
        </div>
      </DialogContent>
    </Dialog>
  );
}
