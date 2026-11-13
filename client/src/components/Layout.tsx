import React, { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react';
import { useLocation, useSearch, Link } from 'wouter';
import Sidebar from './Sidebar';
import MobileNavigation from './MobileNavigation';
import TabStrip from './TabStrip';
import { Home, Menu, UserRound } from 'lucide-react';
import { SidebarContext } from '@/lib/sidebarContext';
import { PortalRotationProvider, type PortalRotation } from '@/lib/portalRotation';
import {
  type AppTab,
  MAX_TABS,
  TabPane,
  isTabbablePath,
  loadSavedTabs,
  newTabId,
  saveTabs,
  tabTitle,
} from '@/lib/appTabs';

interface LayoutProps {
  children: React.ReactNode;
  onLogout?: () => void;
}

// Tabs exist only where the desktop sidebar does (Tailwind's lg). Below that the app is a single
// page as before, and only the active tab is mounted so phones don't hold hidden pages in memory.
const DESKTOP_QUERY = '(min-width: 1024px)';
const subscribeDesktop = (cb: () => void) => {
  const mq = window.matchMedia(DESKTOP_QUERY);
  mq.addEventListener('change', cb);
  return () => mq.removeEventListener('change', cb);
};
const useIsDesktop = () => useSyncExternalStore(subscribeDesktop, () => window.matchMedia(DESKTOP_QUERY).matches);

type TabRotation = { cls: string; rot: PortalRotation };
const NO_ROTATION: TabRotation = { cls: '', rot: 0 };

// Each tab gets its own SidebarContext so a rotated Loading/Unloading/Scan page only rotates the
// sidebar and popups while ITS tab is the one on screen — not after you switch to another tab.
function TabSidebarContext({
  tabId,
  base,
  setTabRotation,
  children,
}: {
  tabId: string;
  base: { openMobileMenu: () => void; openSidebar: () => void; logout?: () => void };
  setTabRotation: (tabId: string, patch: Partial<TabRotation>) => void;
  children: React.ReactNode;
}) {
  const value = useMemo(
    () => ({
      ...base,
      setKioskRotateClass: (cls: string) => setTabRotation(tabId, { cls }),
      setPortalRotation: (rot: PortalRotation) => setTabRotation(tabId, { rot }),
    }),
    [tabId, base, setTabRotation],
  );
  return <SidebarContext.Provider value={value}>{children}</SidebarContext.Provider>;
}

const Layout: React.FC<LayoutProps> = ({ children, onLogout }) => {
  const [location, navigate] = useLocation();
  const search = useSearch();
  const fullPath = search ? `${location}?${search}` : location;
  const isDesktop = useIsDesktop();
  const [sidebarVisible, setSidebarVisible] = useState(true);
  const [mobileMenuOpen, setMobileMenuOpen] = useState(false);
  const [userName] = useState(() => {
    try { return JSON.parse(localStorage.getItem('currentUser') || '{}').username || ''; } catch { return ''; }
  });

  // ===== Tabs =====
  const [tabState, setTabState] = useState(() =>
    loadSavedTabs(window.location.pathname + window.location.search),
  );
  const { tabs, activeId } = tabState;
  const tabStateRef = useRef(tabState);
  tabStateRef.current = tabState;
  // Which tab the browser URL belongs to. Only changed by the handlers below (never on render), so
  // a URL change that lands in the same render as a tab switch is always copied into the right tab.
  const activeIdRef = useRef(activeId);

  useEffect(() => {
    saveTabs(tabs, activeId);
  }, [tabs, activeId]);

  // Sidebar clicks, back/forward and in-page navigation all move the browser URL — follow it in
  // the active tab, the way a browser tab does.
  useEffect(() => {
    if (!isTabbablePath(fullPath)) return;
    setTabState((s) => {
      const id = activeIdRef.current;
      const tab = s.tabs.find((t) => t.id === id);
      if (!tab || tab.path === fullPath) return s;
      return { ...s, tabs: s.tabs.map((t) => (t.id === id ? { ...t, path: fullPath } : t)) };
    });
  }, [fullPath]);

  const goTo = useCallback(
    (path: string, replace = false) => {
      const current = window.location.pathname + window.location.search;
      if (path !== current) navigate(path, { replace });
    },
    [navigate],
  );

  const activateTab = useCallback(
    (id: string) => {
      const tab = tabStateRef.current.tabs.find((t) => t.id === id);
      if (!tab || id === activeIdRef.current) return;
      activeIdRef.current = id;
      setTabState((s) => ({ ...s, activeId: id }));
      // Switching tabs isn't navigation — don't fill the browser's back button with it.
      goTo(tab.path, true);
    },
    [goTo],
  );

  const openTab = useCallback(
    (path = '/') => {
      if (tabStateRef.current.tabs.length >= MAX_TABS) return;
      const tab: AppTab = { id: newTabId(), path };
      activeIdRef.current = tab.id;
      setTabState((s) => ({ tabs: [...s.tabs, tab], activeId: tab.id }));
      goTo(path);
    },
    [goTo],
  );

  const closeTab = useCallback(
    (id: string) => {
      const { tabs: current } = tabStateRef.current;
      const index = current.findIndex((t) => t.id === id);
      if (index === -1) return;
      let remaining = current.filter((t) => t.id !== id);
      // Closing the last tab leaves a fresh Home tab, never an empty window.
      if (remaining.length === 0) remaining = [{ id: newTabId(), path: '/' }];
      if (id !== activeIdRef.current) {
        setTabState((s) => ({ ...s, tabs: remaining }));
        return;
      }
      const next = remaining[Math.min(index, remaining.length - 1)];
      activeIdRef.current = next.id;
      setTabState({ tabs: remaining, activeId: next.id });
      goTo(next.path, true);
    },
    [goTo],
  );

  // Extra text pages put on their own tab (useTabSubtitle), e.g. Load Operations' plant filter.
  const [subtitles, setSubtitles] = useState<Record<string, string>>({});
  const onSubtitle = useCallback((tabId: string, text: string) => {
    setSubtitles((s) => {
      if ((s[tabId] ?? '') === text) return s;
      const next = { ...s };
      if (text) next[tabId] = text;
      else delete next[tabId];
      return next;
    });
  }, []);

  // A hidden tab that navigates by itself (a <Redirect>, a timer) only moves its own tab.
  const onInactiveNavigate = useCallback((tabId: string, path: string) => {
    setTabState((s) => ({ ...s, tabs: s.tabs.map((t) => (t.id === tabId ? { ...t, path } : t)) }));
  }, []);

  // Ctrl/Cmd-click or middle-click a sidebar item opens it in a new tab, like a link in a browser.
  const openSidebarLinkInTab = (e: React.MouseEvent) => {
    const link = (e.target as HTMLElement).closest('a[href]');
    const href = link?.getAttribute('href');
    if (!href || !href.startsWith('/') || !isTabbablePath(href)) return;
    e.preventDefault();
    e.stopPropagation();
    openTab(href);
  };

  // ===== Kiosk rotation (per tab) =====
  // Pushed up by a rotated Loading/Unloading/Scan page through its tab's SidebarContext, so the
  // sidebar and portaled popups turn WITH the page — but only while that page's tab is showing.
  const [rotations, setRotations] = useState<Record<string, TabRotation>>({});
  const setTabRotation = useCallback((tabId: string, patch: Partial<TabRotation>) => {
    setRotations((r) => {
      const prev = r[tabId] ?? NO_ROTATION;
      const next = { ...prev, ...patch };
      if (next.cls === prev.cls && next.rot === prev.rot) return r;
      return { ...r, [tabId]: next };
    });
  }, []);
  // Forget rotations of closed tabs.
  useEffect(() => {
    setRotations((r) => {
      const ids = Object.keys(r).filter((id) => tabs.some((t) => t.id === id));
      return ids.length === Object.keys(r).length ? r : Object.fromEntries(ids.map((id) => [id, r[id]]));
    });
  }, [tabs]);
  const { cls: kioskRotateClass, rot: portalRotation } = rotations[activeId] ?? NO_ROTATION;
  // Popups attached to a trigger (dropdowns, popovers) are rotated by a body-level CSS rule rather
  // than per component — see the data-portal-rotation block in index.css for why.
  useEffect(() => {
    if (portalRotation === 0) {
      delete document.body.dataset.portalRotation;
      return;
    }
    document.body.dataset.portalRotation = String(portalRotation);
    return () => { delete document.body.dataset.portalRotation; };
  }, [portalRotation]);

  useEffect(() => {
    const sidebarVisibility = localStorage.getItem('sidebarVisible');
    if (sidebarVisibility !== null) {
      setSidebarVisible(sidebarVisibility === 'true');
    }
  }, []);

  // Toggle sidebar visibility and save to localStorage
  const toggleSidebar = () => {
    const newVisibility = !sidebarVisible;
    setSidebarVisible(newVisibility);
    localStorage.setItem('sidebarVisible', newVisibility.toString());
  };
  // Unconditionally shows the desktop sidebar (not a toggle) — what a kiosk-rotate page's
  // floating button needs: it should always mean "show me the sidebar", never accidentally
  // hide an already-visible one.
  const openSidebar = useCallback(() => {
    setSidebarVisible(true);
    localStorage.setItem('sidebarVisible', 'true');
  }, []);
  const openMobileMenu = useCallback(() => setMobileMenuOpen(true), []);

  const sidebarContextBase = useMemo(
    () => ({ openMobileMenu, openSidebar, logout: onLogout }),
    [openMobileMenu, openSidebar, onLogout],
  );

  const visibleTabs = isDesktop ? tabs : tabs.filter((t) => t.id === activeId);

  return (
    <SidebarContext.Provider
      value={{
        ...sidebarContextBase,
        setKioskRotateClass: (cls) => setTabRotation(activeId, { cls }),
        setPortalRotation: (rot) => setTabRotation(activeId, { rot }),
      }}
    >
    <div className="flex h-screen flex-col overflow-hidden bg-white">
      {/* Desktop: full-width Chrome-style tab bar with the logo on its left; the sidebar menu and
          the page sit below it. The Welcome header lives on the Home page itself. */}
      <div className="hidden lg:flex w-full shrink-0 items-end bg-gray-100 border-b border-gray-200">
        {/* Same width as the sidebar below (w-64 open, w-16 collapsed), so the tabs start where the
            page does and slide over with it when the menu opens or closes. */}
        <Link
          href="/"
          className={`flex h-11 shrink-0 items-center overflow-hidden self-stretch border-r border-gray-200 px-4 transition-[width] ${sidebarVisible ? 'w-64' : 'w-16'}`}
          aria-label="Home"
          title="Home"
        >
          <img src="/finny-logo.png" alt="" className="h-8 w-8 shrink-0 object-contain" />
          {/* No room for the name on the collapsed (w-16) rail. */}
          {sidebarVisible && (
            <span className="ml-2 truncate text-lg font-bold text-[#001d6e]">Team Finny</span>
          )}
        </Link>
        <TabStrip
          tabs={tabs}
          subtitles={subtitles}
          activeId={activeId}
          onActivate={activateTab}
          onClose={closeTab}
          onNew={() => openTab('/')}
        />
        {userName && (
          <Link
            href="/profile"
            title="Profile"
            className="mx-3 flex h-8 max-w-[14rem] shrink-0 items-center gap-2 self-center rounded-full px-3 text-sm font-medium text-[#001d6e] transition-colors hover:bg-[#001d6e]/10"
          >
            <UserRound className="h-4 w-4 shrink-0" />
            <span className="truncate">{userName}</span>
          </Link>
        )}
      </div>

    <div className="flex min-h-0 flex-1 overflow-hidden">
      {/* Desktop sidebar: when "closed" it collapses to an icon-only rail, never fully hidden.
          relative z-40 keeps it above Loading/Unloading/Scan's kiosk-rotate overlay (z-30), and
          kioskRotateClass turns it with that overlay — see index.css. */}
      <div
        className={`relative z-40 hidden lg:block ${kioskRotateClass}`}
        onClickCapture={(e) => { if (e.ctrlKey || e.metaKey) openSidebarLinkInTab(e); }}
        onAuxClick={(e) => { if (e.button === 1) openSidebarLinkInTab(e); }}
      >
        <Sidebar onLogout={onLogout} onCollapse={toggleSidebar} collapsed={!sidebarVisible} />
      </div>

      {/* Main content area — "sidebar-hidden" (see index.css) lets pages that center themselves
          with max-w-Nxl reclaim the width the sidebar used to take, instead of leaving it blank. */}
      <div className={`flex min-w-0 flex-col flex-1 overflow-hidden ${!sidebarVisible ? "sidebar-hidden" : ""}`}>
        {/* Mobile Sidebar Drawer */}
        {mobileMenuOpen && (
          // z-[60]: the bottom Home/Messages/Profile bar is z-50 and comes later in the page, so at
          // the same level it sat on top of the drawer and hid its last items and Log Out.
          <div className="lg:hidden fixed inset-0 z-[60] flex">
            <div
              className="fixed inset-0 bg-black bg-opacity-50"
              onClick={() => setMobileMenuOpen(false)}
            />
            <div className="relative z-10 flex flex-col h-full shadow-xl">
              <Sidebar
                onLogout={onLogout}
                onCollapse={() => setMobileMenuOpen(false)}
                isMobile
              />
            </div>
          </div>
        )}

        {/* Mobile/tablet bar: the hamburger (the only way to open the sidebar drawer below lg),
            the page name and a Home button. Hidden on Messages/Profile, which have the bottom bar. */}
        <div className={`lg:hidden flex items-center gap-3 bg-white border-b border-gray-200 w-full px-3 py-2 ${location === '/messages' || location === '/profile' ? 'hidden' : ''}`}>
          <button
            onClick={() => setMobileMenuOpen(true)}
            className="p-1.5 text-[#001d6e] hover:bg-gray-100 rounded-md transition-colors"
            aria-label="Open sidebar"
          >
            <Menu className="h-5 w-5" />
          </button>
          {location !== '/' && (
            <>
              <span className="flex-1 truncate font-semibold text-[#001d6e]">{tabTitle(location)}</span>
              <Link href="/" className="flex items-center justify-center w-9 h-9 text-[#001d6e] hover:opacity-70 transition-opacity" aria-label="Home">
                <Home className="h-5 w-5" />
              </Link>
            </>
          )}
        </div>

        {/* Page content — one pane per tab; only the active one is shown.
            overflow-x-hidden is deliberate: with only overflow-y set, the x axis computes to
            `auto` and the entire page pans sideways into empty space past the widest element.
            min-h-0: <main> is itself a flex item and must shrink to its share instead of growing
            to its content. */}
        <main className="flex-1 min-h-0 overflow-y-auto overflow-x-hidden bg-transparent">
          {visibleTabs.map((tab) => {
            const active = tab.id === activeId;
            return (
              // flex h-full flex-col + [&>*]:min-h-0: every page's root is `flex-1 overflow-y-auto`,
              // which is only a real, bounded scroll container (and lets `position: sticky` work)
              // when its parent is a sized flex column.
              <div key={tab.id} className={active ? 'flex h-full min-w-0 flex-col px-4 sm:px-6 [&>*]:min-h-0' : 'hidden'}>
                <TabSidebarContext tabId={tab.id} base={sidebarContextBase} setTabRotation={setTabRotation}>
                  <PortalRotationProvider rotation={(rotations[tab.id] ?? NO_ROTATION).rot}>
                    <TabPane tab={tab} active={active} onInactiveNavigate={onInactiveNavigate} onSubtitle={onSubtitle}>
                      {children}
                    </TabPane>
                  </PortalRotationProvider>
                </TabSidebarContext>
              </div>
            );
          })}
        </main>

        {/* Mobile Navigation - shown on home, messages, and profile pages */}
        {(location === '/' || location === '/messages' || location === '/profile') && <MobileNavigation onLogout={onLogout} />}
      </div>
    </div>
    </div>
    </SidebarContext.Provider>
  );
};

export default Layout;
