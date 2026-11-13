import React, { createContext, useContext, useEffect, useLayoutEffect, useMemo, useRef, useSyncExternalStore } from "react";
import { Router } from "wouter";
import { navigate as browserNavigate } from "wouter/use-browser-location";
import {
  Activity, ArrowLeftRight, CalendarClock, ClipboardList, Database, Eye, Factory, FileBarChart,
  FileText, FileUp, History, Home, LayoutList, MessageSquare, PackageCheck, PackageOpen,
  PrinterCheck, Receipt, ScanLine, Settings, Truck, UserRound, Users, type LucideIcon,
} from "lucide-react";

// Chrome-style tabs: every open tab keeps its page mounted (hidden when not active), so switching
// back to a tab finds it exactly as it was left — filters, scroll, half-typed search and all.
//
// Only the ACTIVE tab owns the browser URL. Each tab's page tree runs inside its own wouter
// <Router> whose location comes from that tab's own path (createTabLocation below), never from
// the browser directly — otherwise every hidden tab would follow the URL and turn into the
// active tab's page. Layout copies the browser URL into the active tab's path (sidebar clicks,
// back/forward) and pushes a tab's path to the URL when that tab is switched to.

export interface AppTab {
  id: string;
  /** pathname + search, e.g. "/toll-voucher" or "/loading?order=123" */
  path: string;
}

export const MAX_TABS = 10;
export const TABS_STORAGE_KEY = "team-finny.appTabs";

// Paths that must never be remembered as a tab — restoring "/logout" after the next login would
// log straight back out.
const UNSAVEABLE_PATHS = ["/logout"];
export const isTabbablePath = (path: string) => !UNSAVEABLE_PATHS.includes(path.split("?")[0]);

export const newTabId = () => Math.random().toString(36).slice(2, 10);

export function loadSavedTabs(currentPath: string): { tabs: AppTab[]; activeId: string } {
  const startPath = isTabbablePath(currentPath) ? currentPath : "/";
  try {
    const saved = JSON.parse(localStorage.getItem(TABS_STORAGE_KEY) || "null");
    if (saved && Array.isArray(saved.tabs) && saved.tabs.length > 0) {
      const tabs: AppTab[] = saved.tabs
        .filter((t: any) => t && typeof t.id === "string" && typeof t.path === "string")
        .slice(0, MAX_TABS);
      if (tabs.length > 0) {
        const activeId = tabs.some((t) => t.id === saved.activeId) ? saved.activeId : tabs[0].id;
        // The URL being opened always wins for the active tab (a refresh, or a pasted link).
        return { tabs: tabs.map((t) => (t.id === activeId ? { ...t, path: startPath } : t)), activeId };
      }
    }
  } catch { /* storage blocked or corrupt — start fresh */ }
  const id = newTabId();
  return { tabs: [{ id, path: startPath }], activeId: id };
}

export function saveTabs(tabs: AppTab[], activeId: string) {
  try { localStorage.setItem(TABS_STORAGE_KEY, JSON.stringify({ tabs, activeId })); } catch { /* storage blocked */ }
}

// Tab titles — same names the sidebar uses.
const TAB_TITLES: Record<string, string> = {
  "/": "Home",
  "/messages": "Messages",
  "/profile": "Profile",
  "/print-operations": "Print Operations",
  "/sort-slip": "Sort Slip",
  "/loading": "Load Operations",
  "/unloading": "Unload Operations",
  "/scan": "Scan Operations",
  "/scan-viewer": "Overall Scan Ops",
  "/scan-history": "Scan History",
  "/overall-stock": "Stock Overview",
  "/daily-reports": "Reports",
  "/dispatch": "Dispatch",
  "/proforma-slips": "Proforma Slips",
  "/load-csv-upload": "Load CSV Upload",
  "/load-master": "Load Master",
  "/loading-overview": "Load Master",
  "/adjust-exchange": "Adjust Exchange Extra",
  "/order-management": "Order Management",
  "/order-import": "Order Import",
  "/notion-inventory": "Product Master",
  "/plant-settings": "Plant Master",
  "/vehicle-master": "Vehicle Master",
  "/vehicle-planning": "Vehicle Planning",
  "/expense-voucher": "Expense Voucher",
  "/toll-voucher": "Toll Voucher",
  "/stock-sheets": "Stock Sheets",
  "/purchases": "Purchases",
  "/users": "User Management",
  "/activities": "Activities",
  "/settings": "Settings",
};

// Pane icons — the same icon each page has in the sidebar.
const TAB_ICONS: Record<string, LucideIcon> = {
  "/": Home,
  "/messages": MessageSquare,
  "/profile": UserRound,
  "/print-operations": PrinterCheck,
  "/sort-slip": ClipboardList,
  "/loading": Factory,
  "/unloading": PackageOpen,
  "/scan": ScanLine,
  "/scan-viewer": Eye,
  "/scan-history": History,
  "/overall-stock": LayoutList,
  "/daily-reports": FileBarChart,
  "/dispatch": Truck,
  "/proforma-slips": FileText,
  "/load-csv-upload": FileUp,
  "/load-master": PackageCheck,
  "/loading-overview": PackageCheck,
  "/adjust-exchange": ArrowLeftRight,
  "/order-management": ClipboardList,
  "/order-import": FileUp,
  "/notion-inventory": Database,
  "/plant-settings": Factory,
  "/vehicle-master": Truck,
  "/vehicle-planning": CalendarClock,
  "/expense-voucher": Receipt,
  "/toll-voucher": Receipt,
  "/users": Users,
  "/activities": Activity,
  "/settings": Settings,
};

// Colour fills some sidebar icons carry on top of the navy outline — keep in step with Sidebar.tsx.
const TAB_ICON_FILLS: Record<string, string> = {
  "/print-operations": "#8766e3",
  "/loading": "#4d7eff",
  "/dispatch": "#eab308",
  "/plant-settings": "#9ca3af",
  "/expense-voucher": "#ea580c",
  "/toll-voucher": "#16a34a",
};

export const tabIconFill = (path: string): string | undefined => TAB_ICON_FILLS[path.split("?")[0]];

export function tabIcon(path: string): LucideIcon {
  const pathname = path.split("?")[0];
  if (pathname.startsWith("/load-master/")) return PackageCheck;
  return TAB_ICONS[pathname] ?? FileText;
}

export function tabTitle(path: string): string {
  const pathname = path.split("?")[0];
  if (TAB_TITLES[pathname]) return TAB_TITLES[pathname];
  if (pathname.startsWith("/load-master/slip/")) return "Load Slip";
  const last = pathname.split("/").filter(Boolean).pop() || "Page";
  return last.replace(/-/g, " ").replace(/\b\w/g, (c) => c.toUpperCase());
}

// Whether the page reading it is in the tab currently on screen. Hidden tabs stay mounted, so a
// page with WINDOW-level listeners (the barcode-gun keydown capture on Scan / Loading /
// Unloading) must check this, or a hidden tab would swallow scans meant for the visible one.
const TabActiveContext = createContext(true);

export const useIsActiveTab = () => useContext(TabActiveContext);

/** Same as useIsActiveTab, as a ref — for event handlers registered once in an effect. */
export function useActiveTabRef() {
  const active = useIsActiveTab();
  const ref = useRef(active);
  ref.current = active;
  return ref;
}

// Lets a page show extra text on its own tab next to the page name — e.g. Load Operations shows
// the plant(s) it is filtered to. Cleared when the page unmounts (tab closed or moved on).
const TabSubtitleContext = createContext<(text: string) => void>(() => {});

export function useTabSubtitle(text: string) {
  const setSubtitle = useContext(TabSubtitleContext);
  useEffect(() => {
    setSubtitle(text);
  }, [setSubtitle, text]);
  useEffect(() => () => setSubtitle(""), [setSubtitle]);
}

// Short plant code for tab text: the first three letters ("INDORE" → "IND", "VALSAD" → "VAL"),
// except where that reads badly.
const PLANT_SHORT_CODES: Record<string, string> = { LUCKNOW: "LKW" };

export function plantShortCode(plant: string): string {
  const name = plant.trim().toUpperCase();
  return PLANT_SHORT_CODES[name] ?? name.slice(0, 3);
}

// A wouter location hook backed by one tab's own path. Created once per tab (it is a hook, so
// the same function must be used for the tab's whole life).
function createTabLocation(initialPath: string) {
  const store = {
    path: initialPath,
    listeners: new Set<() => void>(),
    navigate: (_to: string, _opts?: { replace?: boolean; state?: any }) => {},
  };
  const subscribe = (cb: () => void) => {
    store.listeners.add(cb);
    return () => { store.listeners.delete(cb); };
  };
  const getPathname = () => store.path.split("?")[0] || "/";
  const getSearch = () => {
    const i = store.path.indexOf("?");
    return i >= 0 ? store.path.slice(i + 1) : "";
  };
  const hook = () => [useSyncExternalStore(subscribe, getPathname), store.navigate] as [string, typeof store.navigate];
  const searchHook = () => useSyncExternalStore(subscribe, getSearch);
  const setPath = (path: string) => {
    if (path === store.path) return;
    store.path = path;
    store.listeners.forEach((l) => l());
  };
  return { store, hook, searchHook, setPath };
}

export function TabPane({
  tab,
  active,
  onInactiveNavigate,
  onSubtitle,
  children,
}: {
  tab: AppTab;
  active: boolean;
  /** A hidden tab navigated by itself (e.g. a <Redirect>) — it moves only that tab. */
  onInactiveNavigate: (tabId: string, path: string) => void;
  onSubtitle: (tabId: string, text: string) => void;
  children: React.ReactNode;
}) {
  const loc = useMemo(() => createTabLocation(tab.path), []); // eslint-disable-line react-hooks/exhaustive-deps
  const activeRef = useRef(active);
  activeRef.current = active;

  loc.store.navigate = (to, opts) => {
    if (activeRef.current) {
      // The active tab owns the URL; Layout copies the new URL back into this tab's path.
      loc.setPath(to);
      browserNavigate(to, opts);
    } else {
      onInactiveNavigate(tab.id, to);
    }
  };

  useLayoutEffect(() => {
    loc.setPath(tab.path);
  }, [loc, tab.path]);

  const setSubtitle = useMemo(() => (text: string) => onSubtitle(tab.id, text), [onSubtitle, tab.id]);

  return (
    <TabActiveContext.Provider value={active}>
      <TabSubtitleContext.Provider value={setSubtitle}>
        <Router hook={loc.hook as any} searchHook={loc.searchHook as any}>
          {children}
        </Router>
      </TabSubtitleContext.Provider>
    </TabActiveContext.Provider>
  );
}
