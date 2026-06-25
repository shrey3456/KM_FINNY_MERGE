import { BrowserMultiFormatReader, DecodeHintType, BarcodeFormat, Result } from '@zxing/library';

export type ScannerOptions = {
  onDetected: (result: Result) => void;
  onError: (error: Error) => void;
  formats?: BarcodeFormat[];
};

export class BarcodeScanner {
  private reader: BrowserMultiFormatReader;
  private videoElement: HTMLVideoElement | null = null;
  private activeStream: MediaStream | null = null;
  private isRunning = false;
  private onDetected: (result: Result) => void;
  private onError: (error: Error) => void;

  // Confirmation: same barcode must be read twice within 1.5 s to fire
  private lastCode: string | null = null;
  private lastCodeCount = 0;
  private lastCodeAt = 0;
  private readonly CONFIRM_COUNT = 2;
  private readonly CONFIRM_WINDOW_MS = 1500;

  constructor(options: ScannerOptions) {
    const hints = new Map();
    const formats = options.formats ?? [
      BarcodeFormat.CODE_128,
      BarcodeFormat.CODE_39,
      BarcodeFormat.CODE_93,
      BarcodeFormat.EAN_13,
      BarcodeFormat.EAN_8,
      BarcodeFormat.UPC_A,
      BarcodeFormat.UPC_E,
      BarcodeFormat.ITF,
      BarcodeFormat.CODABAR,
    ];
    hints.set(DecodeHintType.POSSIBLE_FORMATS, formats);
    // TRY_HARDER intentionally disabled — causes false positives on faces/backgrounds
    this.reader = new BrowserMultiFormatReader(hints, 150);
    this.onDetected = options.onDetected;
    this.onError = options.onError;
  }

  /**
   * Initialize — requests camera permission and returns available devices.
   * Call this before start() to prompt the user if needed.
   */
  async initialize(): Promise<MediaDeviceInfo[]> {
    try {
      // Prompt for permission by opening a temp stream, then close it
      const tmp = await navigator.mediaDevices.getUserMedia({ video: true, audio: false });
      tmp.getTracks().forEach((t) => t.stop());
      const devices = await navigator.mediaDevices.enumerateDevices();
      return devices.filter((d) => d.kind === 'videoinput');
    } catch (err: any) {
      if (err?.name === 'NotAllowedError') {
        this.onError(new Error('Camera permission denied. Please allow camera access in your browser settings.'));
      } else if (err?.name === 'NotFoundError') {
        this.onError(new Error('No camera found on this device.'));
      } else {
        this.onError(new Error('Camera access failed: ' + (err?.message ?? String(err))));
      }
      return [];
    }
  }

  /**
   * Start the barcode scanner on the given video element.
   * Uses getUserMedia directly with facingMode:environment to reliably get the
   * rear camera — avoids the black screen that ZXing's device-ID path causes
   * when constraints are not forwarded to getUserMedia.
   */
  async start(videoElement: HTMLVideoElement): Promise<void> {
    if (this.isRunning) await this.stop();

    this.videoElement = videoElement;

    // Ensure video element has the right attributes before stream is attached
    videoElement.setAttribute('autoplay', '');
    videoElement.setAttribute('muted', '');
    videoElement.setAttribute('playsinline', '');
    videoElement.setAttribute('webkit-playsinline', '');
    videoElement.muted = true;
    videoElement.style.width = '100%';
    videoElement.style.height = '100%';
    videoElement.style.objectFit = 'cover';

    try {
      // Get the rear camera stream directly — most reliable on Android & iOS
      let stream: MediaStream;
      try {
        stream = await navigator.mediaDevices.getUserMedia({
          video: { facingMode: { ideal: 'environment' }, width: { ideal: 1280 }, height: { ideal: 720 } },
          audio: false,
        });
      } catch {
        // Fallback: no facing mode constraint (e.g. desktop without rear camera)
        stream = await navigator.mediaDevices.getUserMedia({ video: true, audio: false });
      }

      this.activeStream = stream;

      // Build the detection callback
      const callback = (result: Result | null, error: any) => {
        if (result) {
          const code = result.getText();
          if (!code || code.trim().length < 3 || !/[a-zA-Z0-9]/.test(code)) return;
          const now = Date.now();
          if (code === this.lastCode && now - this.lastCodeAt < this.CONFIRM_WINDOW_MS) {
            this.lastCodeCount++;
            this.lastCodeAt = now;
            if (this.lastCodeCount >= this.CONFIRM_COUNT) {
              this.lastCode = null;
              this.lastCodeCount = 0;
              this.onDetected(result);
            }
          } else {
            this.lastCode = code;
            this.lastCodeCount = 1;
            this.lastCodeAt = now;
          }
        }
        if (error && !(error instanceof TypeError)) {
          if (!error.message?.includes('No MultiFormat Readers were able to detect the code')) {
            console.warn('[BarcodeScanner] decode error (non-critical):', error.message);
          }
        }
      };

      // decodeFromStream: ZXing attaches the stream to the video, calls play(), and runs the scan loop
      await this.reader.decodeFromStream(stream, videoElement, callback);

      // Explicit play() fallback: on some Android browsers ZXing's internal canplay listener
      // fires but play() is rejected silently, leaving the video paused (black screen).
      if (videoElement.paused) {
        await videoElement.play().catch((e) =>
          console.warn('[BarcodeScanner] play() retry failed:', e)
        );
      }

      this.isRunning = true;
      console.log('[BarcodeScanner] Started successfully');
    } catch (err: any) {
      this.isRunning = false;
      this._releaseStream();
      if (err?.name === 'NotAllowedError') {
        this.onError(new Error('Camera permission denied.'));
      } else if (err?.name === 'NotFoundError' || err?.name === 'OverconstrainedError') {
        this.onError(new Error('No camera available.'));
      } else {
        this.onError(err instanceof Error ? err : new Error('Failed to start camera: ' + String(err)));
      }
    }
  }

  /** Switch to the next available camera (cycles through devices). */
  async switchCamera(): Promise<void> {
    if (!this.videoElement || !this.isRunning) return;
    try {
      const devices = (await navigator.mediaDevices.enumerateDevices()).filter(
        (d) => d.kind === 'videoinput',
      );
      if (devices.length <= 1) return;

      // Find current track's deviceId to know which one to switch away from
      const currentId = this.activeStream?.getVideoTracks()[0]?.getSettings().deviceId ?? '';
      const currentIdx = devices.findIndex((d) => d.deviceId === currentId);
      const next = devices[(currentIdx + 1) % devices.length];

      await this.stop();

      // Restart with the specific next device
      const stream = await navigator.mediaDevices.getUserMedia({
        video: { deviceId: { exact: next.deviceId } },
        audio: false,
      });
      this.activeStream = stream;

      const callback = (result: Result | null, error: any) => {
        if (result) {
          const code = result.getText();
          if (!code || code.trim().length < 3 || !/[a-zA-Z0-9]/.test(code)) return;
          const now = Date.now();
          if (code === this.lastCode && now - this.lastCodeAt < this.CONFIRM_WINDOW_MS) {
            this.lastCodeCount++;
            this.lastCodeAt = now;
            if (this.lastCodeCount >= this.CONFIRM_COUNT) {
              this.lastCode = null;
              this.lastCodeCount = 0;
              this.onDetected(result);
            }
          } else {
            this.lastCode = code;
            this.lastCodeCount = 1;
            this.lastCodeAt = now;
          }
        }
        if (error && !(error instanceof TypeError)) {
          if (!error.message?.includes('No MultiFormat Readers were able to detect the code')) {
            console.warn('[BarcodeScanner] decode error:', error.message);
          }
        }
      };

      await this.reader.decodeFromStream(stream, this.videoElement, callback);
      this.isRunning = true;
      console.log('[BarcodeScanner] Switched to camera:', next.label || next.deviceId);
    } catch (err) {
      console.warn('[BarcodeScanner] switchCamera failed:', err);
    }
  }

  /** @deprecated Use start() — hasCameraAccess always returns true now */
  hasCameraAccess(): boolean { return true; }

  /** Stop scanning and release the camera. */
  async stop(): Promise<void> {
    this.reader.reset();
    this._releaseStream();
    this.isRunning = false;
  }

  /** Reset the confirmation counter after a scan is confirmed/dismissed. */
  resetConfirmation(): void {
    this.lastCode = null;
    this.lastCodeCount = 0;
    this.lastCodeAt = 0;
  }

  isActive(): boolean { return this.isRunning; }

  private _releaseStream(): void {
    if (this.activeStream) {
      this.activeStream.getTracks().forEach((t) => t.stop());
      this.activeStream = null;
    }
    if (this.videoElement) {
      this.videoElement.srcObject = null;
    }
  }
}

export default BarcodeScanner;
