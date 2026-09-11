import { AlertTriangle } from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle,
} from "@/components/ui/dialog";

type ProductMasterMissingDialogProps = {
  message: string | null;
  onClose: () => void;
  // Defaults to the original "Not in Product Master" case this was built for. Also reused as-is
  // (just a different title) for the sibling "barcode not on the manifest/order AT ALL, and not
  // in Product Master either" rejection — see matchBarcodeNotInSystemError in apiError.ts —
  // rather than duplicating this same centered-popup shell a second time.
  title?: string;
};

// The one shared popup for a scan blocked at a barcode-lookup step (see matchProductMasterMissingError
// / matchBarcodeNotInSystemError in client/src/lib/apiError.ts) — used identically from Order Scan,
// Loading, and Unloading so these failures always look the same regardless of which page hit them,
// distinct from the ordinary "scan failed" toast every other error still gets.
export default function ProductMasterMissingDialog({ message, onClose, title = "Not in Product Master" }: ProductMasterMissingDialogProps) {
  return (
    <Dialog open={!!message} onOpenChange={(open) => { if (!open) onClose(); }}>
      <DialogContent className="max-w-sm text-center sm:text-center">
        <DialogHeader className="items-center">
          <span className="flex h-12 w-12 items-center justify-center rounded-full bg-red-100">
            <AlertTriangle className="h-6 w-6 text-red-600" />
          </span>
          <DialogTitle className="text-red-700">{title}</DialogTitle>
          <DialogDescription className="text-sm text-gray-600">
            {message}
          </DialogDescription>
        </DialogHeader>
        <DialogFooter className="sm:justify-center">
          <Button className="bg-[#001d6e] text-white hover:bg-[#001552]" onClick={onClose}>
            OK
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
