import { Switch, Route, Redirect, useLocation } from "wouter";
import { queryClient, handleUnauthorized } from "./lib/queryClient";
import { QueryClientProvider } from "@tanstack/react-query";
import { Toaster } from "@/components/ui/toaster";
import NotFound from "./pages/not-found";
import Home from "@/pages/Dashboard";
import ScanOrder from "@/pages/Scanning/Scan";
import ScanViewer from "@/pages/ScanViewer";
import SortSlips from "@/pages/SortSlip/SortSlips";
import DailyReports from "@/pages/DailyReports";
import NotionInventory from "@/pages/NotionInventory";
import Reports from "@/pages/Scanning/Reports.tsx";
import Users from "@/pages/Users";
import Settings from "@/pages/Settings";
import Purchases from "@/pages/Purchases";
import PrintOperations from "./pages/PrintOperationsFinal12";
import Login from "./pages/Login";
import ProformaSlips from "./pages/ProformaSlips";
import Activities from "./pages/Activities";
import Dispatch from "./pages/Dispatch";
import ExpenseVoucher from "./pages/ExpenseVoucher";
import TollVoucher from "./pages/TollVoucher";
import StockSheets from "./pages/StockSheets";
import OrderManagement from "./pages/OrderManagement";
import OrderImport from "./pages/OrderImport";
import MessagesPage from "./pages/MessagesPage";
import CheckInOutPage from "./pages/CheckInOutPage";
import Profile from "./pages/Profile";
import { useState, useEffect, useCallback, Suspense, lazy } from "react";
import { PageSkeleton } from "@/components/ui/loading-skeletons";
import Layout from "@/components/Layout";
import { useToast } from "@/hooks/use-toast";
import ProtectedRoute from "@/components/ProtectedRoute";
import { initializeStatePreservation } from "./utils/statePreservationInit.tsx";
import { useAuth, AuthProvider } from "@/hooks/use-auth";
import PlantSettings from "./pages/PlantSettings";
import OverallStock from "./pages/OverallStock";
import VehicleMaster from "./pages/VehicleMaster";
import LoadOperation from "./pages/Loading/LoadOperation";
import Unloading from "./pages/Unloading/Unloading";

// Shown while a page's code is still loading — the same skeleton as every other page load,
// instead of a spinning ring.
const LoadingIndicator = () => <PageSkeleton />;

// Router component with improved PWA support
function Router() {
  const { user, logoutMutation } = useAuth();
  // We can derive isAuthenticated from user presence in useAuth context
  // But we'll keep local state for now to minimize disruption, syncing it with useAuth
  // Starts from the saved session, so a page refresh goes straight back to where you were. It used
  // to start false and wait for the check below, which flashed the login screen for a moment — the
  // 2.5-second splash screen that was shown on every load mainly existed to cover that flash.
  const [isAuthenticated, setIsAuthenticated] = useState(() => {
    try { return !!localStorage.getItem('currentUser'); } catch { return false; }
  });
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

    // The install offer is the BROWSER's own dialog now — nothing is drawn inside the app.
    // The browser fires this event when it decides the app is installable (on a fresh load, so
    // on a hard refresh and after logging in); taking it over with preventDefault() and calling
    // prompt() right away is what makes that native "Install KM Finny?" window appear by itself
    // instead of only a small icon in the address bar.
    //
    // Some browsers refuse prompt() unless the person has just interacted with the page. When
    // that happens the event is kept and fired on their very next click or key press, so the
    // dialog still comes up instead of being lost.
    let promptEvent: any = null;
    const openInstallDialog = async () => {
      if (!promptEvent) return;
      const e = promptEvent;
      promptEvent = null;
      try {
        await e.prompt();
        await e.userChoice;
        setDeferredPrompt(null);
      } catch {
        // Needs a gesture (or was already used) — retry on the next interaction.
        promptEvent = e;
        window.addEventListener('pointerdown', onFirstInteraction, { once: true });
        window.addEventListener('keydown', onFirstInteraction, { once: true });
      }
    };
    const onFirstInteraction = () => { void openInstallDialog(); };

    const handleBeforeInstallPrompt = (e: Event) => {
      e.preventDefault();          // we show it ourselves, immediately, via the browser's dialog
      promptEvent = e;
      setDeferredPrompt(e);        // kept so an in-app Install button could still trigger it
      void openInstallDialog();
    };

    window.addEventListener('beforeinstallprompt', handleBeforeInstallPrompt);

    return () => {
      window.removeEventListener('beforeinstallprompt', handleBeforeInstallPrompt);
      window.removeEventListener('pointerdown', onFirstInteraction);
      window.removeEventListener('keydown', onFirstInteraction);
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
        <ProtectedRoute path="/notion-inventory" component={NotionInventory} requiredPage="notion-inventory" />
        <ProtectedRoute path="/vehicle-master" component={VehicleMaster} requiredPage="vehicle-master" />
        <ProtectedRoute path="/purchases" component={Purchases} requireInventoryAccess={true} requiredPage="purchases" />
        <ProtectedRoute path="/print-operations" component={PrintOperations} requiredPage="print-operations" />
        <ProtectedRoute path="/proforma-slips" component={ProformaSlips} requiredPage="proforma" />
        <ProtectedRoute path="/dispatch" component={Dispatch} requiredPage="dispatch" />
        <ProtectedRoute path="/expense-voucher" component={ExpenseVoucher} requiredPage="expense-voucher" />
        <ProtectedRoute path="/toll-voucher" component={TollVoucher} requiredPage="toll-voucher" />
        <Route path="/stock-sheets" component={StockSheets} />
        <ProtectedRoute path="/scan-history" component={Reports} requiredPage="scan-history" />
        {/* /reports was the old path for this page — kept as a redirect so any existing
            bookmark/browser history still lands somewhere instead of 404ing. */}
        <Route path="/reports"><Redirect to="/scan-history" /></Route>
        <ProtectedRoute path="/overall-stock" component={OverallStock} requiredPage="overall-stock" />
        <ProtectedRoute path="/scan" component={ScanOrder} requiredPage="scan-order" />
        <ProtectedRoute path="/loading" component={LoadOperation} requiredPage="loading" />
        <ProtectedRoute path="/unloading" component={Unloading} requiredPage="unloading" />
        <ProtectedRoute path="/scan-viewer" component={ScanViewer} requiredPage="scan-viewer" />
        <ProtectedRoute path="/sort-slip" component={SortSlips} requiredPage="sort-slip" />
        <ProtectedRoute path="/daily-reports" component={DailyReports} requiredPage="daily-reports" />
        <ProtectedRoute path="/users" component={Users} requireAdmin={true} requiredPage="user-management" />
        <ProtectedRoute path="/activities" component={Activities} requireAdmin={true} requiredPage="activities" />
        <ProtectedRoute path="/settings" component={Settings} requiredPage="settings" />
        <ProtectedRoute path="/plant-settings" component={PlantSettings} requiredPage="plant-management" />
        <ProtectedRoute path="/order-management" component={OrderManagement} requiredPage="order-management" />
        <ProtectedRoute path="/order-import" component={OrderImport} requiredPage="order-import" />
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

function App() {
  // Track online status
  const [isOnline, setIsOnline] = useState(navigator.onLine);

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

  // Install is handled in one place only — Router's own beforeinstallprompt effect, which opens
  // the browser's native install dialog. A second listener here would have fought it for the
  // same one-shot event.
  useEffect(() => {
    initializeStatePreservation();
    console.log("State preservation utilities initialized");
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

  return (
    <QueryClientProvider client={queryClient}>
      <AuthProvider>
        <Suspense fallback={<LoadingIndicator />}>
          <Router />
          <Toaster />
          <OfflineBanner isOnline={isOnline} />
        </Suspense>
      </AuthProvider>
    </QueryClientProvider>
  );
}

export default App;
