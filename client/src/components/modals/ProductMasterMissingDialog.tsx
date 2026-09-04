import { AlertTriangle } from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle,
} from "@/components/ui/dialog";

type ProductMasterMissingDialogProps = {
  message: string | null;
  onClose: () => void;
};

// The one shared popup for a scan blocked because its barcode is on the CSV/manifest/order but
// has no matching row in Product Master (see matchProductMasterMissingError in
// client/src/lib/apiError.ts) — used identically from Order Scan, Loading, and Unloading so this
// specific failure always looks the same regardless of which page hit it, distinct from the
// ordinary "scan failed" toast every other error still gets.
export default function ProductMasterMissingDialog({ message, onClose }: ProductMasterMissingDialogProps) {
  return (
    <Dialog open={!!message} onOpenChange={(open) => { if (!open) onClose(); }}>
      <DialogContent className="max-w-sm text-center sm:text-center">
        <DialogHeader className="items-center">
          <span className="flex h-12 w-12 items-center justify-center rounded-full bg-red-100">
            <AlertTriangle className="h-6 w-6 text-red-600" />
          </span>
          <DialogTitle className="text-red-700">Not in Product Master</DialogTitle>
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
