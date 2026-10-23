import { Switch, Route, Redirect, useLocation } from "wouter";
import { queryClient, handleUnauthorized } from "./lib/queryClient";
import { flushQueue, onQueueChange, getQueueState, type QueueState } from "./lib/offlineQueue";
import { Loader2 as Loader2Icon, CloudOff as CloudOffIcon, Cloud as CloudIcon } from "lucide-react";
import { QueryClientProvider } from "@tanstack/react-query";
import { Toaster } from "@/components/ui/toaster";
import NotFound from "./pages/not-found";
import Home from "@/pages/Dashboard";
import ScanOrder from "@/pages/Scanning/Scan";
import ScanViewer from "@/pages/ScanViewer";
import SortSlips from "@/pages/SortSlip/SortSlips";
import DailyReports from "@/pages/DailyReports";
import AdjustExchange from "@/pages/AdjustExchange";
import LoadingOverview from "@/pages/LoadingOverview";
import LoadMasterSlip from "@/pages/LoadMasterSlip";
import NotionInventory from "@/pages/NotionInventory";
import ScanHistory from "@/pages/Scanning/ScanHistory.tsx";
import Users from "@/pages/Users";
import Settings from "@/pages/Settings";
import Purchases from "@/pages/Purchases";
import PrintOperations from "./pages/PrintOperationsFinal12";
import Login from "./pages/Login";
import ProformaSlips from "./pages/ProformaSlips";
import LoadCsvUpload from "./pages/LoadCsvUpload";
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
import StockOverview from "./pages/StockOverview";
import VehicleMaster from "./pages/VehicleMaster";
import VehiclePlanning from "./pages/VehiclePlanning";
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
  // "Not now" is remembered for 7 days, so people are not asked at every login.
  const INSTALL_SNOOZE_KEY = 'installPromptDismissedAt';
  const [installSnoozed, setInstallSnoozed] = useState(() => {
    try { const at = Number(localStorage.getItem(INSTALL_SNOOZE_KEY) ?? 0); return !!at && Date.now() - at < 7 * 24 * 3600 * 1000; } catch { return false; }
  });
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

    // The install offer is the bar at the bottom of the app (InstallPromptBanner below), not an automatic dialog: the browser tells us when the app can be
    // installed, we keep that event, and the browser's own "Install" box opens only when the person presses Install on the bar.
    const handleBeforeInstallPrompt = (e: Event) => {
      e.preventDefault();          // no automatic mini-bar / dialog; the bar below is the offer
      setDeferredPrompt(e);
    };
    const handleInstalled = () => { setDeferredPrompt(null); setIsStandalone(true); };

    window.addEventListener('beforeinstallprompt', handleBeforeInstallPrompt);
    window.addEventListener('appinstalled', handleInstalled);

    return () => {
      window.removeEventListener('beforeinstallprompt', handleBeforeInstallPrompt);
      window.removeEventListener('appinstalled', handleInstalled);
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
        // Send whatever scans piled up in the offline queue while the connection was down —
        // see client/src/lib/offlineQueue.ts. Fire-and-forget: OfflineQueueBadge (rendered
        // globally) shows progress/results, this effect doesn't need to await it.
        void flushQueue();
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

  const dismissInstall = () => {
    try { localStorage.setItem(INSTALL_SNOOZE_KEY, String(Date.now())); } catch { /* storage unavailable */ }
    setInstallSnoozed(true);
  };

  return (
    <Layout
      onLogout={handleLogout}
      bottomBar={
        <InstallPromptBanner
          deferredPrompt={installSnoozed ? null : deferredPrompt}
          isStandalone={isStandalone}
          onInstallClick={handleInstallClick}
          onDismiss={dismissInstall}
        />
      }
    >
      <Switch>
        <Route path="/" component={Home} />
        <ProtectedRoute path="/notion-inventory" component={NotionInventory} requiredPage="notion-inventory" />
        <ProtectedRoute path="/vehicle-master" component={VehicleMaster} requiredPage="vehicle-master" />
        <ProtectedRoute path="/vehicle-planning" component={VehiclePlanning} requiredPage="vehicle-planning" />
        <ProtectedRoute path="/purchases" component={Purchases} requireInventoryAccess={true} requiredPage="purchases" />
        <ProtectedRoute path="/print-operations" component={PrintOperations} requiredPage="print-operations" />
        <ProtectedRoute path="/proforma-slips" component={ProformaSlips} requiredPage="proforma" />
        <ProtectedRoute path="/load-csv-upload" component={LoadCsvUpload} requiredPage="proforma" />
        <ProtectedRoute path="/dispatch" component={Dispatch} requiredPage="dispatch" />
        <ProtectedRoute path="/expense-voucher" component={ExpenseVoucher} requiredPage="expense-voucher" />
        <ProtectedRoute path="/toll-voucher" component={TollVoucher} requiredPage="toll-voucher" />
        <Route path="/stock-sheets" component={StockSheets} />
        <ProtectedRoute path="/scan-history" component={ScanHistory} requiredPage="scan-history" />
        <ProtectedRoute path="/adjust-exchange" component={AdjustExchange} requiredPage="adjust-exchange" />
        <ProtectedRoute path="/load-master/slip/:orderNumber" component={LoadMasterSlip} requiredPage="loading-overview" />
        <ProtectedRoute path="/load-master" component={LoadingOverview} requiredPage="loading-overview" />
        <ProtectedRoute path="/loading-overview" component={LoadingOverview} requiredPage="loading-overview" />
        {/* /reports was the old path for this page — kept as a redirect so any existing
            bookmark/browser history still lands somewhere instead of 404ing. */}
        <Route path="/reports"><Redirect to="/scan-history" /></Route>
        <ProtectedRoute path="/overall-stock" component={StockOverview} requiredPage="overall-stock" />
        <Route path="/stock-v2"><Redirect to="/overall-stock" /></Route>
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

// Install bar at the bottom of the app (a small rounded box, only as wide as its content): shown only when the browser says the app can be installed and it is not installed yet. Install opens the browser's own
// confirmation box; the X hides the bar for 7 days.
const InstallPromptBanner = ({
  deferredPrompt, isStandalone, onInstallClick, onDismiss,
}: {
  deferredPrompt: any; isStandalone: boolean; onInstallClick: () => void; onDismiss: () => void;
}) => {
  if (isStandalone || !deferredPrompt) return null;
  return (
    <div className="flex shrink-0 justify-center px-3 pb-3 pt-1">
      <div className="flex w-fit max-w-full items-center gap-3 rounded-xl bg-[#001d6e] px-3 py-2 text-white shadow-lg">
        <img src="/icons/icon-192-v2.png" alt="" className="h-9 w-9 shrink-0 rounded-lg bg-white p-0.5" />
        <div className="min-w-0">
          <p className="text-sm font-semibold leading-tight">Install KM Finny</p>
          <p className="truncate text-xs text-white/75">Add it to your device for quick access</p>
        </div>
        <button type="button" onClick={onInstallClick} className="shrink-0 rounded-md bg-white px-3 py-1.5 text-sm font-semibold text-[#001d6e] hover:bg-gray-100">Install</button>
        <button type="button" onClick={onDismiss} aria-label="Not now" title="Not now" className="shrink-0 rounded p-1 text-white/70 hover:bg-white/10 hover:text-white">
          <span aria-hidden className="block px-1 text-lg leading-none">×</span>
        </button>
      </div>
    </div>
  );
};

// Offline banner component to indicate when the app is offline
const OfflineBanner = ({ isOnline }: { isOnline: boolean }) => {
  if (isOnline) return null;

  return (
    <div className="fixed bottom-0 left-0 right-0 z-50 bg-yellow-500 p-2 text-center text-sm font-semibold text-black">
      You're offline. Some features may be limited.
    </div>
  );
};

// The only visible sign the offline queue (client/src/lib/offlineQueue.ts) exists at all — a
// small "N pending" pill with a manual Sync button, replacing what used to be total silence:
// a scan made offline just failed and vanished with nothing to show for it either way. Rendered
// globally (not per-page) since a scan queued on one page should stay visible while navigating
// elsewhere, right up until it actually sends.
function OfflineQueueBadge() {
  const [state, setState] = useState<QueueState>({ pending: 0, flushing: false, lastMessage: null, offline: false, slow: false });

  useEffect(() => {
    getQueueState().then(setState);
    return onQueueChange(setState);
  }, []);

  // Also shown with nothing waiting when the connection is down or poor, so the operator knows why a
  // scan may take long or be held back — not only once something is already queued.
  if (state.pending === 0 && !state.flushing && !state.lastMessage && !state.offline && !state.slow) return null;

  // Lifted above the bottom Home / Messages / Profile bar on small screens, where it used to sit
  // underneath it.
  return (
    <div className="fixed bottom-20 right-3 z-[70] flex max-w-[calc(100vw-1.5rem)] flex-wrap items-center gap-2 rounded-2xl border border-gray-200 bg-white px-3 py-2 text-xs font-medium text-gray-700 shadow-lg lg:bottom-3">
      {state.offline ? (
        <CloudOffIcon className="h-4 w-4 shrink-0 text-red-600" />
      ) : state.flushing ? (
        <Loader2Icon className="h-4 w-4 shrink-0 animate-spin text-[#001d6e]" />
      ) : state.pending > 0 || state.slow ? (
        <CloudOffIcon className="h-4 w-4 shrink-0 text-amber-600" />
      ) : (
        <CloudIcon className="h-4 w-4 shrink-0 text-emerald-600" />
      )}
      {state.offline && <span className="rounded-full bg-red-100 px-2 py-0.5 font-bold text-red-700">Offline</span>}
      {!state.offline && state.slow && <span className="rounded-full bg-amber-100 px-2 py-0.5 font-bold text-amber-800">Slow network</span>}
      <span>
        {state.flushing
          ? `Syncing… (${state.pending} left)`
          : state.pending > 0
            ? `${state.pending} scan${state.pending === 1 ? "" : "s"} waiting to sync`
            : state.offline
              ? "Scans are saved on this device and sent when you are back online."
              : state.slow
                ? "Scans may take longer — they are kept if the connection drops."
                : (state.lastMessage ?? "Synced")}
      </span>
      {state.pending > 0 && !state.flushing && (
        <button
          type="button"
          onClick={() => void flushQueue()}
          className="rounded-full bg-[#001d6e] px-2.5 py-1 text-[11px] font-semibold text-white hover:bg-[#00154b]"
        >
          Sync now
        </button>
      )}
    </div>
  );
}
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
          <OfflineQueueBadge />
        </Suspense>
      </AuthProvider>
    </QueryClientProvider>
  );
}

export default App;
