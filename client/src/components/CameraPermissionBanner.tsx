import { useState, useEffect } from 'react';
import { AlertCircle, CheckCircle, X } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';

type PermissionState = 'unknown' | 'prompt' | 'granted' | 'denied' | 'blocked';

type CameraPermissionBannerProps = {
  onPermissionGranted?: () => void;
  onDismiss?: () => void;
};

const CameraPermissionBanner = ({ onPermissionGranted, onDismiss }: CameraPermissionBannerProps) => {
  const [permissionState, setPermissionState] = useState<PermissionState>('unknown');
  const [isAttemptingPrompt, setIsAttemptingPrompt] = useState(false);
  const [dismissed, setDismissed] = useState(true); // Changed to true to hide banner by default

  useEffect(() => {
    // Banner is hidden by default - no need to check permission on load
    // checkCameraPermission();
  }, []);

  const checkCameraPermission = async () => {
    try {
      // Try to query permission state if browser supports it
      const permissions = (navigator as any).permissions;
      if (permissions && typeof permissions.query === 'function') {
        const status = await permissions.query({ name: 'camera' } as any);
        setPermissionState(status.state as PermissionState);
      } else {
        // Fallback: try to access camera to determine state
        setPermissionState('prompt');
      }
    } catch (error) {
      console.warn('Failed to check camera permission:', error);
      setPermissionState('unknown');
    }
  };

  const requestCameraPermission = async () => {
    setIsAttemptingPrompt(true);
    try {
      // Request camera access - this will prompt the user
      const stream = await navigator.mediaDevices.getUserMedia({ video: true });
      // If successful, stop the stream and update state
      stream.getTracks().forEach((track) => track.stop());
      setPermissionState('granted');
      if (onPermissionGranted) {
        onPermissionGranted();
      }
    } catch (error: any) {
      console.error('Camera permission error:', error);
      if (error.name === 'NotAllowedError') {
        setPermissionState('denied');
      } else if (error.name === 'NotFoundError' || error.name === 'OverconstrainedError') {
        setPermissionState('blocked');
      } else {
        setPermissionState('unknown');
      }
    } finally {
      setIsAttemptingPrompt(false);
    }
  };

  const handleDismiss = () => {
    setDismissed(true);
    if (onDismiss) {
      onDismiss();
    }
  };

  // Don't show banner if permission is granted or dismissed
  if (permissionState === 'granted' || dismissed) {
    return null;
  }

  // Don't show if unknown state
  if (permissionState === 'unknown' || permissionState === 'prompt') {
    return null;
  }

  // Show banner for denied or blocked states
  if (permissionState === 'denied' || permissionState === 'blocked') {
    return (
      <Card className="mb-4 border-red-200 bg-red-50">
        <div className="p-4">
          <div className="flex items-start gap-4">
            <div className="flex-shrink-0">
              <AlertCircle className="h-5 w-5 text-red-600 mt-0.5" />
            </div>
            <div className="flex-1">
              <h3 className="font-semibold text-red-900">Camera Access Required</h3>
              
              {permissionState === 'denied' ? (
                <div className="mt-2 text-sm text-red-800 space-y-2">
                  <p>Camera permission was denied. To use the scanner, you need to allow camera access:</p>
                  
                  <div className="bg-red-100 rounded p-3 space-y-2 text-xs">
                    <div>
                      <p className="font-semibold mb-1">For Chrome/Edge/Brave:</p>
                      <ol className="list-decimal list-inside space-y-1">
                        <li>Click the lock icon in the address bar</li>
                        <li>Find "Camera" and change from "Block" to "Allow"</li>
                        <li>Reload this page</li>
                      </ol>
                    </div>
                    
                    <div className="border-t border-red-200 pt-2">
                      <p className="font-semibold mb-1">For Firefox:</p>
                      <ol className="list-decimal list-inside space-y-1">
                        <li>Click the lock icon in the address bar</li>
                        <li>Scroll down and toggle Camera "Allow"</li>
                        <li>Reload this page</li>
                      </ol>
                    </div>
                    
                    <div className="border-t border-red-200 pt-2">
                      <p className="font-semibold mb-1">For Safari:</p>
                      <ol className="list-decimal list-inside space-y-1">
                        <li>Go to Safari → Settings for This Website</li>
                        <li>Set Camera to "Allow"</li>
                        <li>Reload this page</li>
                      </ol>
                    </div>
                  </div>
                  
                  <p className="font-semibold mt-3">After allowing permission:</p>
                  <Button 
                    onClick={requestCameraPermission}
                    disabled={isAttemptingPrompt}
                    size="sm"
                    className="bg-red-600 hover:bg-red-700"
                  >
                    {isAttemptingPrompt ? 'Requesting...' : 'Retry Camera Access'}
                  </Button>
                </div>
              ) : (
                <div className="mt-2 text-sm text-red-800 space-y-2">
                  <p>No camera device found on this system. Please check:</p>
                  <ul className="list-disc list-inside space-y-1">
                    <li>A camera is physically connected</li>
                    <li>Camera drivers are installed correctly</li>
                    <li>No other app is currently using the camera</li>
                  </ul>
                  <p className="font-semibold mt-3">Try refreshing the page or use Manual Entry instead:</p>
                  <Button 
                    onClick={requestCameraPermission}
                    disabled={isAttemptingPrompt}
                    size="sm"
                    className="bg-red-600 hover:bg-red-700"
                  >
                    {isAttemptingPrompt ? 'Checking...' : 'Check Camera Again'}
                  </Button>
                </div>
              )}
            </div>
            
            <button
              onClick={handleDismiss}
              className="flex-shrink-0 text-red-600 hover:text-red-900"
            >
              <X className="h-5 w-5" />
            </button>
          </div>
        </div>
      </Card>
    );
  }

  return null;
};

export default CameraPermissionBanner;
