import { 
  Dialog, 
  DialogContent, 
  DialogTitle, 
  DialogDescription
} from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { AlertCircle } from 'lucide-react';

type ErrorModalProps = {
  isOpen: boolean;
  onClose: () => void;
  error: Error | null;
  onManualEntry: () => void;
  isIOS?: boolean;
  isHomeScreenApp?: boolean;
};

const ErrorModal = ({ isOpen, onClose, error, onManualEntry, isIOS = false, isHomeScreenApp = false }: ErrorModalProps) => {
  return (
    <Dialog open={isOpen} onOpenChange={onClose}>
      <DialogContent className="sm:max-w-md">
        <div className="flex items-center justify-center w-16 h-16 mx-auto rounded-full bg-blue-100">
          <AlertCircle className="w-8 h-8 text-[#001d6e]" />
        </div>
        
        <DialogTitle className="mt-4 text-xl font-medium text-center">Scanning Error</DialogTitle>
        <DialogDescription className="text-center">
          We couldn't read that barcode properly.
        </DialogDescription>
        
        <div className="mt-4 p-4 bg-gray-50 rounded-lg">
          <p className="text-sm text-gray-600">
            The barcode could not be scanned due to:
          </p>
          <ul className="mt-2 text-sm text-gray-600 list-disc pl-5 space-y-1">
            <li>Poor lighting conditions</li>
            <li>Barcode is damaged or blurry</li>
            <li>Unsupported barcode format</li>
            {error && error.message.includes('getImageData') && 
              <li>Camera error - try restarting the scan</li>
            }
            {error && !error.message.includes('getImageData') && 
              <li>{error.message}</li>
            }
          </ul>
          {isIOS && (
            <div className="mt-3">
              <p className="text-sm font-medium text-blue-700">iOS-Specific Tips:</p>
              <ul className="mt-1 text-sm text-gray-600 list-disc pl-5 space-y-1">
                {isHomeScreenApp ? (
                  <>
                    <li>Refresh the page and try again</li>
                    <li>Check camera permissions in Settings</li>
                    <li>Ensure good lighting conditions</li>
                  </>
                ) : (
                  <>
                    <li>Try using "Request Desktop Site" in Safari</li>
                    <li>Add this app to your home screen for better camera access</li>
                    <li>Check camera permissions in Safari settings</li>
                  </>
                )}
              </ul>
            </div>
          )}

          <p className="mt-3 text-sm text-gray-600">
            Try adjusting your position or using manual entry.
          </p>
        </div>
        
        <div className="mt-6 flex space-x-3">
          <Button variant="outline" className="flex-1" onClick={onClose}>
            Try Again
          </Button>
          <Button className="flex-1" onClick={onManualEntry}>
            Manual Entry
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  );
};

export default ErrorModal;
