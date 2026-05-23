import { useState, useRef, useEffect } from 'react';
import { useToast } from '@/hooks/use-toast';
import { ScanLine, Zap, RotateCcw, CheckCircle, XCircle } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import BarcodeScanner from '@/lib/barcodeScanner';
import { Result } from '@zxing/library';
import NewManualEntryModal from './modals/NewManualEntryModal';
import BarcodeResultModal from './modals/BarcodeResultModal';
import CameraPermissionBanner from './CameraPermissionBanner';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { apiRequest } from '@/lib/queryClient';
import { Card, CardContent } from '@/components/ui/card';
import { ScanEntry } from '@shared/schema';

type ScanResult = {
  barcode: string;
  format: string;
  text: string;
  timestamp: Date;
  type?: 'order' | 'product';
};

type ScannerProps = {
  onScanComplete?: (result: any) => void;
  onOrderScanned?: (operation: any, items: any[]) => void;
};

// iOS home screen app detection interface
interface SafariIOSNavigator extends Navigator {
  standalone?: boolean;
}

const ScannerView = ({ onScanComplete, onOrderScanned }: ScannerProps) => {
  const videoRef = useRef<HTMLVideoElement>(null);
  const scannerRef = useRef<BarcodeScanner | null>(null);
  const { toast } = useToast();
  const queryClient = useQueryClient();

  const [isScanning, setIsScanning] = useState(false);
  const [flashActive, setFlashActive] = useState(false);
  const [scanResult, setScanResult] = useState<ScanResult | null>(null);
  const [showManualEntry, setShowManualEntry] = useState(false);
  const [showResultModal, setShowResultModal] = useState(false);
  const [productDetails, setProductDetails] = useState<any | null>(null);
  const [currentOrderNumber, setCurrentOrderNumber] = useState<string | null>(null);
  const [scannedItems, setScannedItems] = useState<any[]>([]);
  const [scannedProducts, setScannedProducts] = useState<{[key: string]: any}>({});

  // iOS detection states - define these first to avoid reference issues
  const [isIOS, setIsIOS] = useState<boolean>(
    typeof navigator !== 'undefined' && /iPad|iPhone|iPod/.test(navigator.userAgent)
  );

  const [isHomeScreenApp, setIsHomeScreenApp] = useState<boolean>(
    typeof navigator !== 'undefined' && 
    'standalone' in navigator && 
    (navigator as SafariIOSNavigator).standalone === true
  );

  // Get current user information from localStorage
  const [currentUser, setCurrentUser] = useState<{
    id?: number;
    name?: string;
    username?: string;
    department?: string;
    role?: string;
  } | null>(null);

  // Track the last scanned barcode and timestamp
  const [lastScanned, setLastScanned] = useState<{barcode: string, time: number}>({
    barcode: '',
    time: 0
  });

  const scanMutation = useMutation({
    mutationFn: async (data: ScanEntry) => {
      const response = await apiRequest('POST', '/api/scans', data);
      return response.json();
    },
    onSuccess: (data) => {
      setProductDetails(data.product);
      queryClient.invalidateQueries({ queryKey: ['/api/scans'] });
      queryClient.invalidateQueries({ queryKey: ['/api/products'] });
      if (onScanComplete) {
        onScanComplete(data);
      }
    },
    onError: (error) => {
      toast({
        title: "Scan failed",
        description: error.message || "Failed to process scan. Please try again.",
        variant: "destructive"
      });
    }
  });

  // Load current user from localStorage
  useEffect(() => {
    const userStr = localStorage.getItem('currentUser');
    if (userStr) {
      try {
        const userData = JSON.parse(userStr);
        setCurrentUser(userData);
      } catch (error) {
        console.error('Error parsing user data from localStorage:', error);
      }
    }
  }, []);

  // Set webkit-playsinline attribute directly on the video element
  useEffect(() => {
    if (videoRef.current) {
      // These attributes are critical for iOS video playback in PWA
      videoRef.current.setAttribute('webkit-playsinline', 'true');
      videoRef.current.setAttribute('playsinline', 'true');

      // iOS Safari specific attributes
      if (isIOS) {
        // This improves video rendering on iOS devices
        videoRef.current.setAttribute('x5-video-player-type', 'h5');

        // For iPad specifically 
        if (/iPad/.test(navigator.userAgent) || 
            (/Macintosh/.test(navigator.userAgent) && 'ontouchend' in document)) {
          console.log("Setting iPad-specific video attributes");
          // These styles help with iPad camera display in PWA mode
          videoRef.current.style.transform = isHomeScreenApp ? 'scaleX(-1)' : 'none'; 
        }
      }
    }
  }, [videoRef, isIOS, isHomeScreenApp]);

  useEffect(() => {
    // Check for iOS and standalone mode first
    const checkPlatform = () => {
      const isIOSDevice = /iPad|iPhone|iPod/.test(navigator.userAgent);
      const isHomeScreenAppMode = 'standalone' in window.navigator && 
        (window.navigator as SafariIOSNavigator).standalone === true;

      setIsIOS(isIOSDevice);
      setIsHomeScreenApp(isHomeScreenAppMode);

      if (isIOSDevice) {
        console.log("iOS device detected in scanner component");
        console.log("Home screen app:", isHomeScreenAppMode);
      }

      return { isIOSDevice, isHomeScreenAppMode };
    };

    const { isIOSDevice, isHomeScreenAppMode } = checkPlatform();

    // Configure constraints based on platform
    let videoConstraints = {
      video: {
        facingMode: "environment", // Default for all platforms
        width: { ideal: 1280 },
        height: { ideal: 720 }
      }
    };

    // Apply iOS-specific constraints
    if (isIOSDevice) {
      if (isHomeScreenAppMode) {
        // PWA mode on iOS needs specific constraints
        videoConstraints = {
          video: {
            facingMode: 'environment', // Force rear camera
            width: { ideal: 1280 },
            height: { ideal: 720 }
          }
        };
        console.log("Using PWA-specific iOS constraints:", videoConstraints);
      } else {
        // Browser mode on iOS
        videoConstraints = {
          video: {
            facingMode: 'environment',
            width: { ideal: 1280 },
            height: { ideal: 720 }
          }
        };
        console.log("Using iOS browser constraints:", videoConstraints);
      }
    }

    // Initialize scanner with platform-specific settings
    const scanner = new BarcodeScanner({
      onDetected: handleDetection,
      onError: handleError,
      constraints: videoConstraints
    });

    // Do not auto-initialize devices on mount; initialization (and any getUserMedia prompts)
    // must happen during a user gesture (Start Scanning). Just create the scanner and
    // assign it to the ref; startScanning will call start() which will initialize as needed.
    scannerRef.current = scanner;

    // Cleanup
    return () => {
      if (scannerRef.current) {
        try {
          scannerRef.current.stop();
        } catch (error) {
          console.error("Error stopping scanner:", error);
        }
      }
    };
  }, []);

  const handleDetection = async (result: Result) => {
    if (!result || !result.getText()) return;

    const barcode = result.getText();
    const currentTime = Date.now();

    // Prevent duplicate scans within 3 seconds
    if (barcode === lastScanned.barcode && currentTime - lastScanned.time < 3000) {
      return;
    }

    // Update last scanned info
    setLastScanned({
      barcode: barcode,
      time: currentTime
    });

    try {
      // First check if this is an order reference number (numbers only)
      if (/^\d+$/.test(barcode)) {
        const orderResponse = await fetch(`/api/loading-operations/reference/${barcode}`);
        if (orderResponse.ok) {
          const orderData = await orderResponse.json();

          if (orderData.exists) {
            // Get operation items to validate products against
            const itemsResponse = await fetch(`/api/loading-operations/${orderData.operation.id}/items`);
            const items = await itemsResponse.json();

            if (!items || items.length === 0) {
              toast({
                title: "No Items Found",
                description: `Order #${barcode} exists but has no items to match against`,
                variant: "destructive"
              });
              return;
            }

            setScanResult({
              barcode: barcode,
              format: result.getBarcodeFormat().toString(),
              text: `Order #${barcode}`,
              timestamp: new Date()
            });
            // Set the current order number for display
            setCurrentOrderNumber(barcode);
            
            setProductDetails({
              ...orderData,
              isOrder: true,
              name: `Order #${barcode}`,
              items: items // Store items for validation
            });
            toast({
              title: "Order Found",
              description: `Successfully found order #${barcode} with ${items.length} items. You can now scan products.`,
              variant: "default"
            });
            
            // Call onOrderScanned callback if provided
            if (onOrderScanned) {
              onOrderScanned(orderData.operation, items);
            }
            
            setShowResultModal(true);
            return;
          }
        }
        
        toast({
          title: "Invalid Order",
          description: `No matching order found for #${barcode}`,
          variant: "destructive"
        });
        return;
      }

      // If we have an active order, validate product against order items
      if (productDetails?.operation?.id) {
        // Get product details
        const productResponse = await fetch(`/api/products/barcode/${barcode}`);
        if (!productResponse.ok) {
          toast({
            title: "Product Not Found",
            description: "No product found with this barcode",
            variant: "destructive"
          });
          return;
        }

        const product = await productResponse.json();

        // Find matching item in order with logging
        console.log("Checking product match:", {
          scannedBarcode: barcode,
          product: product,
          orderItems: productDetails.items
        });
        
        const matchingItem = productDetails.items?.find((item: any) => {
          const matches = 
            item.productId === product.id || 
            item.barcode === product.barcode ||
            String(item.sapCode) === String(product.sapCode) ||
            String(item.srNo) === String(product.srNo);
            
          if (matches) {
            console.log("Found matching item:", item);
          }
          return matches;
        });

        if (matchingItem) {
          // Update scanned items list with this product
          const updatedScannedItems = [...scannedItems];
          // Check if this item was already scanned
          const existingItemIndex = updatedScannedItems.findIndex(
            (si: any) => si.productId === matchingItem.productId
          );
          
          if (existingItemIndex === -1) {
            // Add to scanned items if not already scanned
            updatedScannedItems.push({...matchingItem, scanned: true});
          }
          
          setScannedItems(updatedScannedItems);
          
          // Update scanned products map
          setScannedProducts({
            ...scannedProducts,
            [product.id]: {
              product,
              item: matchingItem,
              timestamp: new Date()
            }
          });
          
          setScanResult({
            barcode: barcode,
            format: result.getBarcodeFormat().toString(),
            text: product.name,
            timestamp: new Date(),
            type: 'product'
          });
          
          setProductDetails({
            ...productDetails,
            product: product,
            item: matchingItem
          });
          
          toast({
            title: "Product Found",
            description: `Successfully found ${product.name} in order #${currentOrderNumber}`,
            variant: "default"
          });
          
          setShowResultModal(true);
        } else {
          toast({
            title: "Invalid Product",
            description: `Product ${product.name} is not in this order`,
            variant: "destructive"
          });
        }
      } else {
        toast({
          title: "Scan Order First",
          description: "Please scan an order barcode before scanning products",
          variant: "destructive"
        });
      }
    } catch (error) {
      console.error('Error checking order or product:', error);
      toast({
        title: "Error",
        description: "Failed to process scan. Please try again.",
        variant: "destructive"
      });
    }
  };

  const handleError = (error: Error) => {
    console.error('Scanner error:', error);

    // Handle critical errors that require stopping the scanner
    if (error.message !== 'No MultiFormat Readers were able to detect the code.') {
      if (scannerRef.current) {
        scannerRef.current.stop();
        setIsScanning(false);
      }

      toast({
        title: "Scanner Error",
        description: "There was a problem with the scanner. Please try again.",
        variant: "destructive"
      });
    }
  };

  const processScan = (result: ScanResult) => {
    // Display the scan result immediately
    setScanResult(result);

    // Additional logic to fetch product details by barcode
    const fetchProductByBarcode = async () => {
      try {
        const response = await fetch(`/api/products/barcode/${result.barcode}`);

        if (response.ok) {
          const product = await response.json();
          setProductDetails(product);

          // Always show the result modal for confirmation
          setShowResultModal(true);
          // Pause scanning temporarily
          if (scannerRef.current) {
            scannerRef.current.stop();
          }
        } else if (response.status === 404) {
          // If no product found, still show the result modal
          setShowResultModal(true);
          // Pause scanning temporarily
          if (scannerRef.current) {
            scannerRef.current.stop();
          }
          setProductDetails(null);
        }
      } catch (error) {
        console.error("Error fetching product by barcode:", error);

        // Show error modal
        //setShowErrorModal(true); // Removed
        // Pause scanning temporarily
        if (scannerRef.current) {
          scannerRef.current.stop();
        }
      }
    };

    fetchProductByBarcode();
  };

  const startScanning = async () => {
    if (!scannerRef.current || !videoRef.current) return;

    try {
      setIsScanning(true);

      // Add special handling for iOS devices
      if (isIOS) {
        console.log("iOS device detected - starting scanner with special handling");
        console.log("- Running as home screen app:", isHomeScreenApp);

        // Ensure video element is properly set up for iOS
        if (videoRef.current) {
          // These attributes help with iOS camera permissions
          videoRef.current.setAttribute('autoplay', 'true');
          videoRef.current.setAttribute('muted', 'true');
          videoRef.current.setAttribute('playsinline', 'true');

          // Set explicit size - helps with iOS Safari
          videoRef.current.style.width = '100%';
          videoRef.current.style.height = '100%';

          // Explicitly set z-index to ensure camera is visible
          videoRef.current.style.zIndex = '1';

          // Force inline playback on iOS
          try {
            await videoRef.current.play();
          } catch (playError) {
            console.log("iOS video play attempt:", playError);
          }
        }

        // Show iOS-specific toast message
        if (isHomeScreenApp) {
          toast({
            title: "Home Screen App",
            description: "Using environment camera in home screen mode",
          });
        } else {
          toast({
            title: "iOS Camera",
            description: "If camera doesn't appear, ensure camera permissions are granted in Safari settings",
          });
        }
      }

      await scannerRef.current.start(videoRef.current);

      toast({
        title: "Scanner active",
        description: "Position a barcode within the frame to scan"
      });
    } catch (error) {
      console.error('Failed to start scanner:', error);

      // More detailed error handling based on iOS device type
      let errorMessage = "Failed to start the barcode scanner. Please check camera permissions.";

      if (isIOS) {
        if (isHomeScreenApp) {
          errorMessage = "Scanner failed to start in home screen mode. Please try these steps:\n" +
            "1. Ensure camera permissions are granted\n" +
            "2. Refresh the page\n" +
            "3. Try using the manual entry option if camera issues persist";
        } else {
          errorMessage = "Scanner failed to start on iOS. Please try these steps:\n" +
            "1. Ensure camera permissions are enabled in Settings > Safari > Camera\n" +
            "2. For better access, add this app to your home screen from the Safari share menu\n" +
            "3. Try switching to 'Request Desktop Site' in Safari settings";
        }
      }

      toast({
        title: "Scanner error",
        description: errorMessage,
        variant: "destructive"
      });

      setIsScanning(false);
    }
  };

  const stopScanning = () => {
    if (scannerRef.current) {
      scannerRef.current.stop();
      setIsScanning(false);
    }
  };
  
  // Reset the scanner and order details
  const resetScanner = () => {
    setCurrentOrderNumber(null);
    setProductDetails(null);
    setScanResult(null);
    setScannedItems([]);
    setScannedProducts({});
    if (scannerRef.current) {
      scannerRef.current.stop();
      setIsScanning(false);
    }
    
    toast({
      title: "Order Cleared",
      description: "You can now scan a different order",
      variant: "default"
    });
  };

  const toggleFlash = () => {
    // This is a placeholder - actual flash control depends on browser APIs
    setFlashActive(!flashActive);

    toast({
      title: flashActive ? "Flash disabled" : "Flash enabled",
      description: "Flash functionality depends on device capabilities"
    });
  };

  const switchCamera = async () => {
    if (scannerRef.current) {
      try {
        await scannerRef.current.switchCamera();

        toast({
          title: "Camera switched",
          description: "Now using different camera"
        });
      } catch (error) {
        console.error("Error switching camera:", error);

        toast({
          title: "Camera switch failed",
          description: "Unable to switch camera. You might have only one camera available.",
          variant: "destructive"
        });
      }
    }
  };

  const handleManualEntry = (data: ScanEntry) => {
    // Add user information to manual entry data
    const dataWithUser = {
      ...data,
      scannerName: currentUser?.name || "Unknown User",
      scannerDepartment: currentUser?.department || "N/A",
      scannedById: currentUser?.id // Include the actual user ID who performed the scan
    };

    scanMutation.mutate(dataWithUser);
    setShowManualEntry(false);
    setScanResult({
      barcode: data.barcode,
      format: "MANUAL",
      text: data.barcode,
      timestamp: new Date()
    });
  };

  const closeResultModal = () => {
    setShowResultModal(false);
    setScanResult(null);

    // Resume scanning automatically when closing the modal
    if (scannerRef.current && videoRef.current) {
      // If iOS, ensure video attributes are set again
      if (isIOS && videoRef.current) {
        videoRef.current.setAttribute('autoplay', 'true');
        videoRef.current.setAttribute('muted', 'true');
        videoRef.current.setAttribute('playsinline', 'true');

        // Optional: try to force playback
        videoRef.current.play().catch(err => console.log("iOS play on resume:", err));
      }

      scannerRef.current.start(videoRef.current);
    }
  };


  return (
    <>
      <div className="mx-auto">
        {/* Camera Permission Helper Banner */}
        <CameraPermissionBanner 
          onPermissionGranted={() => {
            toast({
              title: "Camera Permission Granted",
              description: "You can now start scanning. Click 'Start Scanning' to begin.",
              variant: "default"
            });
          }}
        />

        {/* Scanner Header */}
        <div className="mb-4 flex items-center">
          <ScanLine className="h-7 w-7 text-[#001d6e] mr-2" />
          <div>
            <h2 className="text-2xl font-bold text-[#001d6e]">Scan</h2>
            <p className="text-gray-600">Scan product barcodes to update inventory</p>
          </div>
        </div>
        
        {/* Current Order Display Banner */}
        {currentOrderNumber && (
          <div className="mb-4 p-3 bg-blue-100 border border-blue-300 rounded-lg shadow-sm">
            <div className="flex items-center justify-between">
              <div className="flex items-center">
                <div className="mr-2 bg-blue-600 text-white h-7 w-7 rounded-full flex items-center justify-center font-bold">
                  #
                </div>
                <div>
                  <h3 className="font-semibold text-blue-900">Order #{currentOrderNumber}</h3>
                  <p className="text-sm text-blue-700">
                    <span className="font-semibold">{scannedItems.length}</span> / {productDetails?.items?.length || 0} items scanned
                  </p>
                </div>
              </div>
              <Button 
                variant="ghost" 
                size="sm" 
                onClick={resetScanner}
                className="text-blue-700 hover:text-blue-900 hover:bg-blue-200"
              >
                <XCircle className="h-4 w-4 mr-1" />
                Clear Order
              </Button>
            </div>
          </div>
        )}

        {/* Scanner Interface - Full width for better scanning experience */}
        <Card className="mb-6 overflow-hidden">
          {/* Scanner Preview - Full height for better camera view */}
          <div className="bg-gray-900 relative overflow-hidden" style={{ height: isScanning ? 'calc(100vh - 250px)' : '50vh' }}>
            <video 
              ref={videoRef}
              className="absolute inset-0 h-full w-full object-cover"
              playsInline
              autoPlay
              muted
              controls={false}
              style={{
                width: '100%',
                height: '100%',
                objectFit: 'cover',
                objectPosition: 'center',
                zIndex: 1
              }}
            />

            {!isScanning && (
              <div className="absolute inset-0 bg-gradient-to-b from-transparent to-black/30 flex flex-col items-center justify-center">
                <p className="text-white font-medium">Camera feed will appear when scanning starts</p>

                {isIOS && (
                  <div className="mt-4 bg-blue-900/80 p-3 rounded-lg max-w-xs text-center">
                    <p className="text-white text-sm font-medium">
                      iOS Device {isHomeScreenApp ? "(Home Screen App)" : "(Browser)"}
                    </p>
                    <p className="text-white/80 text-xs mt-1">
                      {isHomeScreenApp 
                        ? "For best results, use the rear camera and ensure good lighting"
                        : "If camera doesn't appear, check Safari camera permissions and allow camera access when prompted"}
                    </p>
                    {!isHomeScreenApp && (
                      <p className="text-white/80 text-xs mt-1">
                        For better camera access, add this app to your home screen from the Safari share menu
                      </p>
                    )}
                  </div>
                )}
              </div>
            )}

            {/* Scanner Guide - Green border box in center */}
            {isScanning && (
              <div className="absolute top-1/2 left-1/2 transform -translate-x-1/2 -translate-y-1/2 w-4/5 h-[200px] border-2 border-green-500 rounded-lg">
                <div className="absolute top-0 left-0 w-[30px] h-[30px] border-t-[4px] border-l-[4px] border-green-500 -translate-x-[2px] -translate-y-[2px]"></div>
                <div className="absolute top-0 right-0 w-[30px] h-[30px] border-t-[4px] border-r-[4px] border-green-500 translate-x-[2px] -translate-y-[2px]"></div>
                <div className="absolute bottom-0 left-0 w-[30px] h-[30px] border-b-[4px] border-l-[4px] border-green-500 -translate-x-[2px] translate-y-[2px]"></div>
                <div className="absolute bottom-0 right-0 w-[30px] h-[30px] border-b-[4px] border-r-[4px] border-green-500 translate-x-[2px] translate-y-[2px]"></div>
              </div>
            )}

            {/* Barcode Display Overlay with light green background and dark blue text */}
            {isScanning && (
              <div className="absolute bottom-24 left-0 right-0 flex justify-center">
                <div className="bg-green-100 rounded-lg px-4 py-3 max-w-xs w-4/5 shadow-md">
                  <p className="text-[#001d6e] text-center font-medium truncate">
                    {scanResult ? scanResult.barcode : "Waiting for barcode..."}
                  </p>
                  {productDetails && (
                    <div className="mt-1 pt-1 border-t border-green-200">
                      <p className="text-[#001d6e] text-sm font-medium text-center">
                        {productDetails.name || 'Unknown product'}
                      </p>
                      <p className="text-xs text-[#001d6e]/80 mt-1 text-center">
                        SKU: {productDetails.sku || 'N/A'}
                      </p>
                    </div>
                  )}
                </div>
              </div>
            )}

            {/* Scanner Controls */}
            {isScanning && (
              <div className="absolute bottom-4 left-0 right-0 flex justify-center">
                <div className="bg-black/60 backdrop-blur-sm rounded-full p-1 flex space-x-2">
                  <Button 
                    variant="ghost" 
                    size="icon" 
                    className="p-2 text-white hover:bg-white/10 rounded-full"
                    onClick={toggleFlash}
                  >
                    <Zap className={`h-6 w-6 ${flashActive ? 'text-yellow-400' : 'text-white'}`} />
                    <span className="sr-only">Toggle flash</span>
                  </Button>

                  <Button 
                    variant="ghost" 
                    size="icon" 
                    className="p-2 text-white hover:bg-white/10 rounded-full"
                    onClick={switchCamera}
                  >
                    <RotateCcw className="h-6 w-6" />
                    <span className="sr-only">Switch camera</span>
                  </Button>
                </div>
              </div>
            )}
          </div>

          {/* Scanner Controls - Keeping the footer as requested */}
          <CardContent className="p-4 border-t border-gray-200">
            <div className="flex flex-col sm:flex-row sm:justify-between sm:items-center gap-4">
              <div>
                <div className="flex items-center space-x-3">
                  <Badge variant={isScanning ? "default" : "secondary"} className={`flex items-center space-x-1 ${isScanning ? 'bg-green-100 text-green-800 hover:bg-green-100' : ''}`}>
                    {isScanning ? (
                      <>
                        <ScanLine className="h-4 w-4 mr-1" />
                        <span>Scanning active</span>
                      </>
                    ) : (
                      <span>Ready to scan</span>
                    )}
                  </Badge>

                  {/* Confirmation mode indicator */}
                  <Badge variant="outline" className="flex items-center space-x-1 border-blue-200 bg-blue-50 text-blue-700">
                    <CheckCircle className="h-3.5 w-3.5 mr-1" />
                    <span>Confirmation mode</span>
                  </Badge>
                </div>
                <p className="text-sm text-gray-500 mt-1">
                  {isScanning 
                    ? "Position barcode within the frame (requires approval)"
                    : "Press Start Scanning to begin"}
                </p>
              </div>

              <div className="flex space-x-3">
                <Button 
                  variant="secondary" 
                  onClick={() => setShowManualEntry(true)}
                >
                  Manual Entry
                </Button>

                <Button 
                  onClick={isScanning ? stopScanning : startScanning}
                  variant={isScanning ? "destructive" : "default"}
                >
                  {isScanning ? "Stop Scanning" : "Start Scanning"}
                </Button>
              </div>
            </div>
          </CardContent>
        </Card>
      </div>

      {/* Modals */}
      <NewManualEntryModal 
        isOpen={showManualEntry} 
        onClose={() => setShowManualEntry(false)} 
        onSubmit={handleManualEntry} 
      />

      {/* Always show result modal for confirmation */}
      <BarcodeResultModal
        isOpen={showResultModal}
        onClose={() => {
          closeResultModal();
          // Resume scanning after closing the modal
          if (scannerRef.current && videoRef.current) {
            scannerRef.current.start(videoRef.current);
          }
        }}
        onConfirm={(quantity) => {
          // Create scan entry when confirmed in confirmation mode
          if (scanResult) {
            // Prepare scan data with or without order number
            const scanData: ScanEntry = {
              barcode: scanResult.barcode,
              action: "add",
              quantity: 1,
              scannerName: currentUser?.name || "Unknown User",
              scannerDepartment: currentUser?.department || "N/A",
              scannedById: currentUser?.id, // Include the actual user ID who performed the scan
            };
            
            // Add order number if present
            if (currentOrderNumber) {
              scanData.orderNumber = currentOrderNumber;
            }
            
            if (productDetails) {
              // Use the user-adjusted quantity from the modal, or default to itemsPerPallet
              const itemQuantity = quantity || productDetails.itemsPerPallet || 1;
              console.log("Using quantity:", itemQuantity);
              
              scanData.quantity = itemQuantity;
              scanData.productId = productDetails.id;
              scanData.name = productDetails.name;
              scanData.productSku = productDetails.barcode || scanResult.barcode;
            }
            
            // Submit the scan
            scanMutation.mutate(scanData);
            
            closeResultModal();
          }
        }}
        scanResult={scanResult}
        productDetails={productDetails}
        currentOrderNumber={currentOrderNumber}
      />
    </>
  );
};

export default ScannerView;