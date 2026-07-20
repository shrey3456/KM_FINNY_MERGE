import { Switch, Route, useLocation } from "wouter";
import { queryClient, handleUnauthorized } from "./lib/queryClient";
import { QueryClientProvider } from "@tanstack/react-query";
import { Toaster } from "@/components/ui/toaster";
import NotFound from "./pages/not-found";
import Home from "@/pages/Dashboard";
import ScanOrder from "@/pages/Scanning/Scan";
import Inventory from "@/pages/Inventory";
import NotionInventory from "@/pages/NotionInventory";
import Reports from "@/pages/Scanning/Reports.tsx";
import Users from "@/pages/Users";
import Settings from "@/pages/Settings";
import Purchases from "@/pages/Purchases";
import LoadOperations from "./pages/LoadOperations"; // Renamed component
import PrintOperations from "./pages/PrintOperationsFinal12";
import Login from "./pages/Login";
import SplashScreen from "./pages/SplashScreen";
import ProformaSlips from "./pages/ProformaSlips";
import Activities from "./pages/Activities";
import Dispatch from "./pages/Dispatch";
import ExpenseVoucher from "./pages/ExpenseVoucher";
import TollVoucher from "./pages/TollVoucher";
import StockSheets from "./pages/StockSheets";
import OrderManagement from "./pages/OrderManagement";
import OrderImport from "./pages/OrderImport";
import OrderReports from "./pages/OrderReports";
import MessagesPage from "./pages/MessagesPage";
import CheckInOutPage from "./pages/CheckInOutPage";
import Profile from "./pages/Profile";
import { useState, useEffect, useCallback, Suspense, lazy } from "react";
import Layout from "@/components/Layout";
import { useToast } from "@/hooks/use-toast";
import ProtectedRoute from "@/components/ProtectedRoute";
import { initializeStatePreservation } from "./utils/statePreservationInit.tsx";
import { useAuth, AuthProvider } from "@/hooks/use-auth";
import PlantSettings from "./pages/PlantSettings";
import OverallStock from "./pages/OverallStock";

// Loading indicator component for Suspense fallback
const LoadingIndicator = () => (
  <div className="flex h-screen w-full items-center justify-center">
    <div className="h-16 w-16 animate-spin rounded-full border-b-2 border-t-2 border-primary"></div>
  </div>
);

// Router component with improved PWA support
function Router() {
  const { user, logoutMutation } = useAuth();
  // We can derive isAuthenticated from user presence in useAuth context
  // But we'll keep local state for now to minimize disruption, syncing it with useAuth
  const [isAuthenticated, setIsAuthenticated] = useState(false);
  const [showSplash, setShowSplash] = useState(true);
  const [isOnline, setIsOnline] = useState(navigator.onLine);
  const [deferredPrompt, setDeferredPrompt] = useState<any>(null);
  const [isStandalone, setIsStandalone] = useState(false);
  const [, navigate] = useLocation();
  const { toast } = useToast();

  // Sync authentication state with useAuth
  useEffect(() => {
    if (user) {
      setIsAuthenticated(true);
    } else {
      // Check localStorage as backup for initial load before query resolves
      const userStr = localStorage.getItem('currentUser');
      if (userStr) {
        setIsAuthenticated(true);
      } else {
        setIsAuthenticated(false);
      }
    }
  }, [user]);

  // Check for existing user on mount and PWA status
  useEffect(() => {
    // Check if already installed
    const isInStandaloneMode = () => 
      (window.matchMedia('(display-mode: standalone)').matches) || 
      (window.navigator as any).standalone || 
      document.referrer.includes('android-app://');

    setIsStandalone(isInStandaloneMode());

    // Listen for beforeinstallprompt event
    const handleBeforeInstallPrompt = (e: Event) => {
      // Prevent Chrome 76+ from automatically showing the prompt
      e.preventDefault();
      // Stash the event so it can be triggered later
      setDeferredPrompt(e);
    };

    window.addEventListener('beforeinstallprompt', handleBeforeInstallPrompt);

    return () => {
      window.removeEventListener('beforeinstallprompt', handleBeforeInstallPrompt);
    };
  }, []);

  // Online/offline detection
  useEffect(() => {
    const handleOnlineStatus = () => {
      const isCurrentlyOnline = navigator.onLine;
      setIsOnline(isCurrentlyOnline);

      if (!isCurrentlyOnline) {
        toast({
          title: "You're offline",
          description: "The app will continue to work with limited functionality",
          variant: "destructive",
        });
      } else {
        toast({
          title: "You're back online",
          description: "Full functionality has been restored",
          variant: "default",
        });
      }
    };

    window.addEventListener('online', handleOnlineStatus);
    window.addEventListener('offline', handleOnlineStatus);

    return () => {
      window.removeEventListener('online', handleOnlineStatus);
      window.removeEventListener('offline', handleOnlineStatus);
    };
  }, [toast]);

  // Show splash screen for 2.5 seconds
  useEffect(() => {
    const timer = setTimeout(() => {
      setShowSplash(false);
    }, 2500);
    return () => clearTimeout(timer);
  }, []);

  // Handle Login
  const handleLogin = () => {
    setIsAuthenticated(true);
    // Force a reload of user data
    queryClient.invalidateQueries({ queryKey: ["/api/user"] });
  };

  // Handle Logout
  const handleLogout = useCallback(() => {
    // Call the API logout
    logoutMutation.mutate();
    
    // Also perform local cleanup immediately for better UX
    localStorage.removeItem('currentUser');
    localStorage.removeItem('km-user');
    localStorage.removeItem('userCode');
    localStorage.removeItem('userId');
    
    setIsAuthenticated(false);
    // Toast is handled in use-auth onSuccess
  }, [logoutMutation]);

  // Logout route handler
  useEffect(() => {
    const checkLogoutRoute = (location: string) => {
      if (location === '/logout') {
        handleLogout();
      }
    };

    // Initial check
    checkLogoutRoute(window.location.pathname);

    // Set up listener for route changes
    const handleRouteChange = () => {
      checkLogoutRoute(window.location.pathname);
    };

    window.addEventListener('popstate', handleRouteChange);

    return () => {
      window.removeEventListener('popstate', handleRouteChange);
    };
  }, [handleLogout]);

  useEffect(() => {
    if (typeof window === "undefined") {
      return;
    }

    const handleUnauthorizedEvent = () => {
      setIsAuthenticated(false);
      toast({
        title: "Session expired",
        description: "Please enter your PIN to continue.",
        variant: "destructive",
      });
      navigate("/");
    };

    window.addEventListener("auth:unauthorized", handleUnauthorizedEvent);

    return () => {
      window.removeEventListener("auth:unauthorized", handleUnauthorizedEvent);
    };
  }, [navigate, toast]);

  // Show splash screen
  if (showSplash) {
    return <SplashScreen />;
  }

  // Show login if not authenticated
  if (!isAuthenticated) {
    return <Login onLogin={handleLogin} />;
  }

  // Install PWA prompt
  const handleInstallClick = async () => {
    if (!deferredPrompt) {
      return;
    }

    // Show the installation prompt
    deferredPrompt.prompt();

    // Wait for the user to respond to the prompt
    const choiceResult = await deferredPrompt.userChoice;

    if (choiceResult.outcome === 'accepted') {
      toast({
        title: "Installation started",
        description: "KM Finny is being installed on your device",
      });
    }

    // Clear the saved prompt as it can't be used again
    setDeferredPrompt(null);
  };

  return (
    <Layout onLogout={handleLogout}>
      <Switch>
        <Route path="/" component={Home} />
        <ProtectedRoute path="/inventory" component={Inventory} requireInventoryAccess={true} requiredPage="inventory" />
        <ProtectedRoute path="/notion-inventory" component={NotionInventory} requireAdmin={true} requiredPage="notion-inventory" />
        <ProtectedRoute path="/purchases" component={Purchases} requireInventoryAccess={true} requiredPage="purchases" />
        <ProtectedRoute path="/load-operations" component={LoadOperations} requiredPage="load-operations" />
        <ProtectedRoute path="/print-operations" component={PrintOperations} requiredPage="print-operations" />
        <ProtectedRoute path="/proforma-slips" component={ProformaSlips} requiredPage="proforma" />
        <ProtectedRoute path="/dispatch" component={Dispatch} requiredPage="dispatch" />
        <ProtectedRoute path="/expense-voucher" component={ExpenseVoucher} requiredPage="expense-voucher" />
        <ProtectedRoute path="/toll-voucher" component={TollVoucher} requiredPage="toll-voucher" />
        <Route path="/stock-sheets" component={StockSheets} />
        <ProtectedRoute path="/reports" component={Reports} requiredPage="scan-history" />
        <ProtectedRoute path="/overall-stock" component={OverallStock} requiredPage="overall-stock" />
        <ProtectedRoute path="/scan" component={ScanOrder} requiredPage="scan-order" />
        <ProtectedRoute path="/users" component={Users} requireAdmin={true} requiredPage="user-management" />
        <ProtectedRoute path="/activities" component={Activities} requireAdmin={true} requiredPage="activities" />
        <ProtectedRoute path="/settings" component={Settings} requiredPage="settings" />
        <ProtectedRoute path="/plant-settings" component={PlantSettings} requiredPage="plant-management" />
        <ProtectedRoute path="/order-management" component={OrderManagement} requiredPage="order-management" />
        <ProtectedRoute path="/order-import" component={OrderImport} requireOrderManagement={true} requiredPage="order-import" />
        <ProtectedRoute path="/order-reports" component={OrderReports} requiredPage="order-import" />
        <Route path="/messages" component={MessagesPage} />
        <Route path="/inout" component={CheckInOutPage} />
        <ProtectedRoute path="/checkinout-admin" component={CheckInOutPage} requireAdmin={true} />
        <Route path="/profile" component={Profile} />
        <Route path="/logout">
          {() => {
            handleLogout();
            return null;
          }}
        </Route>
        {/* Fallback to 404 */}
        <Route component={NotFound} />
      </Switch>
    </Layout>
  );
}

// Offline banner component to indicate when the app is offline
const OfflineBanner = ({ isOnline }: { isOnline: boolean }) => {
  if (isOnline) return null;

  return (
    <div className="fixed bottom-0 left-0 right-0 z-50 bg-yellow-500 p-2 text-center text-sm font-semibold text-black">
      You're offline. Some features may be limited.
    </div>
  );
};

// Install PWA prompt banner
const InstallPromptBanner = ({ 
  deferredPrompt, 
  isStandalone, 
  onInstallClick,
  onDismiss
}: { 
  deferredPrompt: any;
  isStandalone: boolean;
  onInstallClick: () => void;
  onDismiss: () => void;
}) => {
  if (isStandalone || !deferredPrompt) return null;

  return (
    <div className="fixed bottom-0 left-0 right-0 z-50 bg-primary p-2 text-white">
       <div className="flex items-center justify-between">
        <span>Install KM Finny for offline use</span>
        <div className="flex items-center gap-2">
          <button 
            onClick={onInstallClick}
            className="rounded bg-white px-2 py-1 text-sm font-medium text-primary"
          >
            Install
          </button>
          <button 
            onClick={onDismiss}
            className="ml-2 rounded p-1 hover:bg-white/20"
            aria-label="Dismiss"
          >
            <svg xmlns="http://www.w3.org/2000/svg" width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><line x1="18" y1="6" x2="6" y2="18"></line><line x1="6" y1="6" x2="18" y2="18"></line></svg>
          </button>
        </div>
      </div> 
    </div>
  );
};
function App() {
  // Track online status
  const [isOnline, setIsOnline] = useState(navigator.onLine);
  const [deferredPrompt, setDeferredPrompt] = useState<any>(null);
  const [isStandalone, setIsStandalone] = useState(false);
  // State to track dismissal for the current session only.
  // This resets to false on every page reload, ensuring the option is given every time the user visits.
  const [isInstallBannerDismissed, setIsInstallBannerDismissed] = useState(false);

  // Handle online/offline status
  useEffect(() => {
    const handleOnlineStatus = () => setIsOnline(navigator.onLine);

    window.addEventListener('online', handleOnlineStatus);
    window.addEventListener('offline', handleOnlineStatus);

    return () => {
      window.removeEventListener('online', handleOnlineStatus);
      window.removeEventListener('offline', handleOnlineStatus);
    };
  }, []);

  // Handle PWA installation and initialize state preservation
  useEffect(() => {
    // Initialize state preservation utilities
    initializeStatePreservation();
    console.log("State preservation utilities initialized");
    
    // Check if already installed
    const isInStandaloneMode = () => 
      (window.matchMedia('(display-mode: standalone)').matches) || 
      (window.navigator as any).standalone || 
      document.referrer.includes('android-app://');

    setIsStandalone(isInStandaloneMode());

    // Listen for beforeinstallprompt event
    const handleBeforeInstallPrompt = (e: Event) => {
      e.preventDefault();
      setDeferredPrompt(e);
    };

    window.addEventListener('beforeinstallprompt', handleBeforeInstallPrompt);

    return () => {
      window.removeEventListener('beforeinstallprompt', handleBeforeInstallPrompt);
    };
  }, []);

  useEffect(() => {
    if (typeof window === "undefined") {
      return;
    }

    const originalFetch = window.fetch;

    window.fetch = async (...args) => {
      const response = await originalFetch(...args);
      if (response.status === 401) {
        handleUnauthorized();
      }
      return response;
    };

    return () => {
      window.fetch = originalFetch;
    };
  }, []);

  const handleInstallClick = async () => {
    if (!deferredPrompt) return;

    deferredPrompt.prompt();
    const { outcome } = await deferredPrompt.userChoice;

    if (outcome === 'accepted') {
      setIsStandalone(true);
    }

    setDeferredPrompt(null);
  };

  return (
    <QueryClientProvider client={queryClient}>
      <AuthProvider>
        <Suspense fallback={<LoadingIndicator />}>
          <Router />
          <Toaster />
          <OfflineBanner isOnline={isOnline} />
          {!isInstallBannerDismissed && (
            <InstallPromptBanner 
              deferredPrompt={deferredPrompt}
              isStandalone={isStandalone}
              onInstallClick={handleInstallClick}
              onDismiss={() => setIsInstallBannerDismissed(true)}
            />
          )}
        </Suspense>
      </AuthProvider>
    </QueryClientProvider>
  );
}

export default App;
