import { BrowserMultiFormatReader, DecodeHintType, BarcodeFormat, Result } from '@zxing/library';

export type ScannerOptions = {
  onDetected: (result: Result) => void;
  onError: (error: Error) => void;
  formats?: BarcodeFormat[];
  interval?: number;
  constraints?: MediaStreamConstraints;
};

export class BarcodeScanner {
  private reader: BrowserMultiFormatReader;
  private videoElement: HTMLVideoElement | null = null;
  private selectedDeviceId: string | null = null;
  private scanInterval: number | null = null;
  private isRunning = false;
  private hasCamera = true;
  private onDetected: (result: Result) => void;
  private onError: (error: Error) => void;
  private constraints: MediaStreamConstraints | undefined;

  constructor(options: ScannerOptions) {
    const hints = new Map();
    const formats = options.formats || [
      BarcodeFormat.CODE_128,  // most common warehouse/product barcode
      BarcodeFormat.CODE_39,
      BarcodeFormat.CODE_93,
      BarcodeFormat.EAN_13,
      BarcodeFormat.EAN_8,
      BarcodeFormat.UPC_A,
      BarcodeFormat.UPC_E,
      BarcodeFormat.ITF,       // interleaved 2-of-5, common in logistics
      BarcodeFormat.CODABAR,
    ];
    hints.set(DecodeHintType.POSSIBLE_FORMATS, formats);
    hints.set(DecodeHintType.TRY_HARDER, true);
    this.reader = new BrowserMultiFormatReader(hints, 150);
    this.onDetected = options.onDetected;
    this.onError = options.onError;
    this.constraints = options.constraints;
    
    // Default to environment-facing camera (rear) if no constraints provided
    if (!this.constraints) {
      this.constraints = {
        video: {
          facingMode: "environment" // Force environment (rear) camera by default
        }
      };
    }
  }

  /**
   * Initialize the scanner and enumerate devices
   * @returns Promise with available video devices
   */
  async initialize(): Promise<MediaDeviceInfo[]> {
    try {
      // Try to detect explicit permission state when available
      let permState: PermissionState | null = null;
      try {
        // Some browsers support querying the camera permission directly
        const permissions = (navigator as any).permissions;
        if (permissions && typeof permissions.query === 'function') {
          const status = await permissions.query({ name: 'camera' } as any);
          permState = status.state as PermissionState;
        }
      } catch (permErr) {
        // Ignore permission query errors - not all browsers support it
      }

      // List devices first; if none found and permission isn't explicitly denied,
      // try to prompt the user by calling getUserMedia once and re-enumerate.
      // Try to list devices, but some browsers/environments don't support enumeration
      // (e.g., older Safari versions, cross-origin frames, or restricted contexts).
      let devices: MediaDeviceInfo[] = [];
      try {
        devices = await this.reader.listVideoInputDevices();
        this.hasCamera = devices.length > 0;
      } catch (listErr: any) {
        console.warn('Device enumeration not supported or failed:', listErr?.message || listErr);
        // We'll try to prompt for camera access directly as a fallback below.
        this.hasCamera = false;
      }

      if (!this.hasCamera && permState !== 'denied' && navigator.mediaDevices && typeof navigator.mediaDevices.getUserMedia === 'function') {
        try {
          // Trigger a permission prompt (if the browser allows) so devices become available
          const tempStream = await navigator.mediaDevices.getUserMedia({ video: true });
          // Immediately stop tracks - we only wanted to prompt
          tempStream.getTracks().forEach(t => t.stop());
          // Re-list devices after prompting
          try {
            devices = await this.reader.listVideoInputDevices();
            this.hasCamera = devices.length > 0;
          } catch (relistErr: any) {
            // enumerate still not available but getUserMedia succeeded -> treat as available
            console.warn('Re-enumeration failed after prompt:', relistErr?.message || relistErr);
            this.hasCamera = true;
            // leave devices as empty array; start() will fall back to browser default
          }
        } catch (mediaErr: any) {
          // If user denied permission or no devices exist, record that state
          if (mediaErr && mediaErr.name === 'NotAllowedError') {
            this.hasCamera = false;
            this.onError(new Error('Camera permission denied. Please enable camera access for this site in your browser settings.'));
            return [];
          }
          if (mediaErr && (mediaErr.name === 'NotFoundError' || mediaErr.name === 'OverconstrainedError')) {
            this.hasCamera = false;
            this.onError(new Error('No camera devices found on this system.'));
            return [];
          }
          // Non-fatal: continue and return whatever devices we have (likely none)
        }
      }

  if (this.hasCamera && !this.selectedDeviceId) {
        console.log("Available cameras:", devices.map(d => `${d.label} (${d.deviceId})`));
        
        // Define keywords that might indicate a rear camera
        const rearKeywords = ['back', 'rear', 'environment', 'main', 'primary'];
        
        // Look for a camera with rear indicators in the label
        const rearCamera = devices.find(device => {
          const label = device.label.toLowerCase();
          return rearKeywords.some(keyword => label.includes(keyword));
        });
        
        // Try to infer rear camera from device ordering on mobile (typically rear camera is first)
        // Some mobile browsers don't provide descriptive labels
        const inferredRearCamera = devices.length >= 2 ? devices[0] : null;
        
        if (rearCamera) {
          // Use the identified rear camera by label
          console.log("Found rear camera by label:", rearCamera.label);
          this.selectedDeviceId = rearCamera.deviceId;
        } else if (inferredRearCamera) {
          // If we have multiple cameras but couldn't identify rear by label,
          // infer that the first device is likely the rear camera
          console.log("Inferring rear camera from device order:", inferredRearCamera.label);
          this.selectedDeviceId = inferredRearCamera.deviceId;
        } else {
          // Default to first device
          console.log("No specific rear camera identified, using first available camera");
          this.selectedDeviceId = devices[0].deviceId;
        }
      }
      
      return devices;
    } catch (error) {
      console.error('Failed to initialize scanner:', error);
      this.hasCamera = false;
      // Provide a clearer error depending on the error type
      const e: any = error;
      if (e && e.name === 'NotAllowedError') {
        this.onError(new Error('Camera permission denied. Please enable camera access for this site in your browser settings.'));
      } else if (e && (e.name === 'NotFoundError' || e.name === 'OverconstrainedError')) {
        this.onError(new Error('No camera devices found on this system.'));
      } else {
        this.onError(new Error('Camera access denied or not available'));
      }
      return [];
    }
  }

  /**
   * Start the scanner
   * @param videoElement The video element to use for scanning
   * @param deviceId Optional device ID to use
   */
  async start(videoElement: HTMLVideoElement, deviceId?: string): Promise<void> {
    if (!this.hasCamera) {
      this.onError(new Error('No camera available'));
      return;
    }

    if (this.isRunning) {
      await this.stop();
    }

    this.videoElement = videoElement;
    this.selectedDeviceId = deviceId || this.selectedDeviceId;

    try {
      if (!this.selectedDeviceId) {
        const devices = await this.initialize();
        // initialize() sets this.hasCamera based on enumeration or successful getUserMedia prompt.
        if (!this.hasCamera) {
          throw new Error('No camera available');
        }
        // If enumeration is unsupported, devices may be empty but hasCamera===true; we allow start and
        // rely on decodeFromVideoDevice(null, ...) to pick browser default device.
      }

      // Create a callback function for barcode detection
      const callback = (result: Result | null, error: any) => {
        if (result) {
          this.onDetected(result);
        }
        if (error && !(error instanceof TypeError)) {
          // TypeError is thrown when there's no barcode in view, we can ignore this
          console.warn('Scanner error (non-critical):', error);
          // Don't call onError for common non-critical errors to avoid interrupting the scanning
          if (!error.message?.includes('No MultiFormat Readers were able to detect the code')) {
            this.onError(error instanceof Error ? error : new Error(String(error)));
          }
        }
      };

      console.log(`Starting scanner with deviceId: ${this.selectedDeviceId || 'default'}`);
      
      // Setup special handling for iOS devices
      const isIOS = /iPad|iPhone|iPod/.test(navigator.userAgent);
      if (isIOS) {
        console.log("iOS device detected, applying special settings");
        
        // Detect if we're running as a home screen app (Safari iOS specific)
        // Define a type for iOS Safari navigator with standalone property
        interface SafariIOSNavigator extends Navigator {
          standalone?: boolean;
        }
        
        const isStandalone = 'standalone' in window.navigator && 
          (window.navigator as SafariIOSNavigator).standalone === true;
        console.log("Running in standalone/home screen mode:", isStandalone);
        
        // Different constraints for standalone (PWA) vs browser
        if (isStandalone) {
          // For PWA mode, we need to be more specific with constraints
          console.log("Using PWA-specific camera constraints for iOS");
          this.constraints = {
            video: {
              facingMode: { exact: 'environment' }, // Force environment camera only
              width: { min: 640, ideal: 1280, max: 1920 },
              height: { min: 480, ideal: 720, max: 1080 }
            },
            audio: false
          };
        } else {
          // For browser mode
          this.constraints = {
            video: {
              facingMode: 'environment', // Prefer environment camera
              width: { ideal: 1280 },
              height: { ideal: 720 }
            },
            audio: false
          };
        }
        
        // Ensure proper video element setup for iOS
        if (this.videoElement) {
          console.log("Setting up video element for iOS");
          
          // These attributes are required for iOS video
          this.videoElement.setAttribute('autoplay', 'true');
          this.videoElement.setAttribute('muted', 'true');
          this.videoElement.setAttribute('playsinline', 'true');
          
          // Add critical iOS PWA attributes
          this.videoElement.setAttribute('controls', 'false');
          this.videoElement.setAttribute('webkit-playsinline', 'true');
          
          // Force video dimensions - helps with iOS
          this.videoElement.style.width = '100%';
          this.videoElement.style.height = '100%';
          this.videoElement.style.objectFit = 'cover';
          
          // Special handling for iPad
          const isIPad = /iPad/.test(navigator.userAgent) || 
            (/Macintosh/.test(navigator.userAgent) && 'ontouchend' in document);
          
          if (isIPad) {
            console.log("iPad detected, applying iPad-specific settings");
            // iPad needs these additional settings
            this.videoElement.style.transform = 'scaleX(-1)'; // Fix mirroring issues
            this.videoElement.style.position = 'absolute';
            
            // Using getUserMedia directly for iPad in PWA mode
            if (isStandalone) {
              console.log("Using direct getUserMedia for iOS PWA mode");
              
              try {
                // Try a modified approach first for iOS standalone mode
                const stream = await navigator.mediaDevices.getUserMedia({
                  video: { 
                    facingMode: 'environment',
                    width: { ideal: 1280 },
                    height: { ideal: 720 }
                  },
                  audio: false
                });
                
                console.log("Successfully obtained camera stream directly for iOS PWA");
                
                // Assign stream to video element
                if (this.videoElement) {
                  this.videoElement.srcObject = stream;
                  
                  // Force playback
                  try {
                    await this.videoElement.play();
                    console.log("Video playback started successfully");
                    
                    // Set flag to indicate we have a manual stream
                    this.isRunning = true;
                  } catch (playError) {
                    console.error("Video playback failed:", playError);
                    // Continue with regular approach if direct play fails
                  }
                }
              } catch (mediaError) {
                console.warn("Manual getUserMedia failed, falling back to regular approach:", mediaError);
                // We'll continue with the regular approach
              }
            }
          }
        }
      }
      
      try {
        if (this.selectedDeviceId) {
          // Use device ID as string when we have it
          await this.reader.decodeFromVideoDevice(
            this.selectedDeviceId,
            this.videoElement,
            callback
          );
        } else {
          // Fall back to null (let browser pick camera) if no device ID selected
          // In combination with our constraints, this should favor the rear camera
          await this.reader.decodeFromVideoDevice(
            null, 
            this.videoElement,
            callback
          );
        }
        
        this.isRunning = true;
        console.log("Scanner started successfully");
      } catch (startError) {
        console.error('Failed to start with selected device, trying alternative approach:', startError);
        
        // If the selected device failed, try with null (browser default)
        try {
          await this.reader.decodeFromVideoDevice(
            null, 
            this.videoElement,
            callback
          );
          
          this.isRunning = true;
          console.log("Scanner started with browser default device");
        } catch (fallbackError: any) {
          throw new Error(`Failed to start scanner with any device: ${fallbackError?.message || 'Unknown error'}`);
        }
      }
    } catch (error) {
      console.error('Failed to start scanner:', error);
      this.isRunning = false;
      this.onError(error instanceof Error ? error : new Error('Failed to start scanner'));
    }
  }

  /**
   * Stop the scanner
   */
  async stop(): Promise<void> {
    if (this.scanInterval) {
      clearInterval(this.scanInterval);
      this.scanInterval = null;
    }
    
    this.reader.reset();
    this.isRunning = false;
  }

  /**
   * Start the scanner with a specific device ID
   * @param deviceId The device ID to use
   */
  async startWithDeviceId(deviceId: string): Promise<void> {
    if (!this.videoElement) {
      console.error('Video element not set');
      return;
    }
    
    this.selectedDeviceId = deviceId;
    await this.stop();
    await this.start(this.videoElement, deviceId);
  }

  /**
   * Switch camera device
   */
  async switchCamera(): Promise<void> {
    if (!this.hasCamera || !this.videoElement) {
      return;
    }
    try {
      const devices = await this.reader.listVideoInputDevices();
      if (devices.length <= 1) {
        return; // No other cameras to switch to
      }

      // Find the index of the current device
      const currentIndex = devices.findIndex(device => device.deviceId === this.selectedDeviceId);
      // Select the next device in the list, or the first if we're at the end
      const nextIndex = (currentIndex + 1) % devices.length;
      this.selectedDeviceId = devices[nextIndex].deviceId;

      // Restart with the new device
      await this.stop();
      await this.start(this.videoElement, this.selectedDeviceId);
    } catch (err) {
      console.warn('Unable to enumerate devices to switch camera:', err);
      // If enumeration isn't supported, there's nothing to switch — silently ignore.
    }
  }

  /**
   * Check if the scanner is currently running
   */
  isActive(): boolean {
    return this.isRunning;
  }

  /**
   * Check if a camera is available
   */
  hasCameraAccess(): boolean {
    return this.hasCamera;
  }
}

export default BarcodeScanner;
