import React, { useEffect, useState } from 'react';
import { useLocation, Link } from 'wouter';
import Header from './Header';
import Sidebar from './Sidebar';
import MobileNavigation from './MobileNavigation';
import finnyLogo from '@assets/finny-logo.png';
import { Home, Menu, ChevronUp, ChevronDown } from 'lucide-react';
import { formatUsername } from '@/lib/format-username';
import { SidebarContext } from '@/lib/sidebarContext';
import { PortalRotationProvider, type PortalRotation } from '@/lib/portalRotation';

interface LayoutProps {
  children: React.ReactNode;
  onLogout?: () => void;
}

interface CurrentUser {
  id: number;
  username: string;
  name?: string;
  role?: string;
  department?: string;
}

// Pages that scan at a fixed station, where the header is worth trading away for table height.
const HEADER_HIDEABLE_PATHS = ['/scan', '/unloading', '/loading'];
// Vehicle Planning trades the header away too, but starts HIDDEN by default (the opposite of the
// scan stations above) — it's a planning board, not a station someone sits at all day, so there's
// no ongoing value in the "Welcome, <name>" greeting eating into its vertical space every time it
// opens. Its own localStorage key, since the two groups of pages want different defaults.
const HEADER_HIDDEN_BY_DEFAULT_PATHS = ['/vehicle-planning'];

const Layout: React.FC<LayoutProps> = ({ children, onLogout }) => {
  const [location] = useLocation();
  const [currentUser, setCurrentUser] = useState<CurrentUser | null>(null);
  const [sidebarVisible, setSidebarVisible] = useState(true);
  const [mobileMenuOpen, setMobileMenuOpen] = useState(false);
  // Pushed up by whichever page is active (Loading/Unloading/Scan) via
  // useSidebarContext().setKioskRotateClass, so the sidebar rotates WITH the page's own
  // rotated content instead of popping up unrotated on top of it. Empty when not rotated.
  const [kioskRotateClass, setKioskRotateClass] = useState("");
  // Also pushed up by the active rotated page — provided to the page tree so its portaled popups
  // turn with it (lib/portalRotation). 0 when not rotated.
  const [portalRotation, setPortalRotation] = useState<PortalRotation>(0);
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
  // Scanning pages: let the operator collapse the "Welcome" header to reclaim vertical space for
  // the items table. Remembered across reloads since a scanning station keeps the same preference
  // — one shared key rather than one per page, because it's the same physical station either way.
  const isScanPage = HEADER_HIDEABLE_PATHS.includes(location);
  const [scanHeaderHidden, setScanHeaderHidden] = useState(
    () => localStorage.getItem('scanHeaderHidden') === 'true',
  );
  useEffect(() => {
    localStorage.setItem('scanHeaderHidden', String(scanHeaderHidden));
  }, [scanHeaderHidden]);

  const isHiddenByDefaultPage = HEADER_HIDDEN_BY_DEFAULT_PATHS.includes(location);
  const [defaultHiddenHeaderHidden, setDefaultHiddenHeaderHidden] = useState(
    () => localStorage.getItem('headerHiddenByDefaultPages') !== 'false',
  );
  useEffect(() => {
    localStorage.setItem('headerHiddenByDefaultPages', String(defaultHiddenHeaderHidden));
  }, [defaultHiddenHeaderHidden]);

  // Whichever group this page belongs to drives the toggle — a page is never in both lists.
  const canToggleHeader = isScanPage || isHiddenByDefaultPage;
  const headerHidden = isScanPage ? scanHeaderHidden : defaultHiddenHeaderHidden;
  const setHeaderHidden = isScanPage ? setScanHeaderHidden : setDefaultHiddenHeaderHidden;
  const hideHeader = canToggleHeader && headerHidden;

  // Pages (Loading, Unloading) can ask for the header to be hidden from their own toolbar, so the
  // button is reachable at every screen size, not just in the desktop bar.
  useEffect(() => {
    const onHide = () => setHeaderHidden(true);
    window.addEventListener('app:hide-header', onHide);
    return () => window.removeEventListener('app:hide-header', onHide);
  }, [setHeaderHidden]);

  useEffect(() => {
    // Get user information from localStorage
    const userStr = localStorage.getItem('currentUser');
    if (userStr) {
      try {
        const userData = JSON.parse(userStr);
        setCurrentUser(userData);
      } catch (error) {
        console.error('Error parsing user data from localStorage:', error);
      }
    }
    
    // Get sidebar visibility from localStorage
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
  const openSidebar = () => {
    setSidebarVisible(true);
    localStorage.setItem('sidebarVisible', 'true');
  };

  return (
    <SidebarContext.Provider value={{ openMobileMenu: () => setMobileMenuOpen(true), openSidebar, setKioskRotateClass, setPortalRotation }}>
    <div className="flex h-screen overflow-hidden bg-white">
      {/* Sidebar for desktop - conditionally shown based on sidebarVisible state.
          relative z-40: Loading/Unloading/Scan's kiosk-rotate wrapper (index.css) is a fixed,
          full-viewport overlay at z-index 30 — without a higher z-index here, opening the
          sidebar via a rotated page's floating menu button correctly flipped sidebarVisible to
          true, but the sidebar itself stayed invisible, painted UNDER that overlay. Safe here
          (unlike raising the thin header bar, which left a stray border sliver at the seam
          where its elevated strip met the un-elevated main content below it) because this is a
          solid, full-height panel with no such boundary to leak through.
          kioskRotateClass (pushed up by the active page) turns the sidebar to match — it's the
          exact same fixed/rotated box the page's own content uses, so the sidebar's normal
          top-left-anchored column just keeps its usual position inside that rotated box, the
          same way any other rotated content does. */}
      {sidebarVisible && (
        <div className={`relative z-40 hidden lg:block ${kioskRotateClass}`}>
          <Sidebar onLogout={onLogout} onCollapse={toggleSidebar} />
        </div>
      )}
      
      {/* Main content area — "sidebar-hidden" (see index.css) lets pages that center themselves
          with max-w-Nxl reclaim the width the sidebar used to take, instead of leaving it blank. */}
      <div className={`flex min-w-0 flex-col flex-1 overflow-hidden ${!sidebarVisible ? "sidebar-hidden" : ""}`}>
        {/* Header for desktop with hamburger menu — collapsible on the scan page. The hamburger
            is the ONLY way to bring the sidebar back once toggleSidebar has hidden it, so it
            must stay outside the hideHeader gate below — it used to be nested inside the same
            `{!hideHeader && (...)}` block as the rest of this bar, so hiding the header on
            Loading/Unloading/Scan also hid the one button that could un-hide the sidebar,
            stranding anyone who did both with no way back short of clearing localStorage.
            It's still only rendered when the sidebar is ACTUALLY hidden (!sidebarVisible) —
            when it's open, Sidebar's own "«" collapse arrow is right there to close it, so
            showing this button too would just be a redundant second control.
            Rotated kiosk mode (Loading/Unloading) covers this bar with its own fixed,
            full-viewport overlay — that's handled by a floating button INSIDE the rotated
            container itself (via SidebarContext.openMobileMenu, same trick the rotate button
            uses), not by raising this bar's z-index above the overlay, which left a stray
            sliver of the sidebar's border visible at the seam instead of actually fixing
            reachability. */}
        <div className="hidden lg:flex items-center w-full bg-white border-b border-gray-200">
          {!sidebarVisible && (
            <button
              onClick={toggleSidebar}
              className="p-3 text-[#001d6e] hover:bg-gray-100 transition-colors rounded-md mx-2"
              aria-label="Show sidebar"
            >
              <Menu className="h-6 w-6" />
            </button>
          )}
          {!hideHeader && (
            <>
              <Header
                userName={currentUser?.username || ''}
                userRole={currentUser?.role || ''}
                onLogout={onLogout}
              />
              {canToggleHeader && (
                <button
                  onClick={() => setHeaderHidden(true)}
                  className="mr-3 ml-auto flex shrink-0 items-center gap-1.5 rounded-lg border border-gray-200 px-3 py-1.5 text-xs font-medium text-gray-500 transition-colors hover:bg-gray-50 hover:text-[#001d6e]"
                  title="Hide header for more space"
                >
                  <ChevronUp className="h-4 w-4" /> Hide header
                </button>
              )}
            </>
          )}
        </div>
        
        {/* Mobile Header with tribe logo, welcome text and (on non-home pages) a home icon - Hidden on messages and profile */}
        {/* Mobile Sidebar Drawer */}
        {mobileMenuOpen && (
          <div className="lg:hidden fixed inset-0 z-50 flex">
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

        {/* Same fix as the desktop bar above: the hamburger (the only way to open the mobile
            sidebar drawer) must never be inside the hideHeader-hidden branch — it used to be,
            so hiding the header on Loading/Unloading/Scan also removed the only way to reach
            the sidebar on mobile. hideHeader now only trims the logo/welcome/home/logout content
            and shrinks the padding, never the whole bar. (Rotated kiosk mode reaches the sidebar
            through its own in-rotation floating button instead — see the comment on the desktop
            bar above.) */}
        <div className={`lg:hidden bg-white border-b border-gray-200 w-full ${hideHeader ? 'p-2' : 'p-4'} ${location === '/messages' || location === '/profile' ? 'hidden' : ''}`}>
          <div className="flex items-center justify-between">
            <div className="flex items-center space-x-4">
              <button
                onClick={() => setMobileMenuOpen(true)}
                className="p-1.5 text-[#001d6e] hover:bg-gray-100 rounded-md transition-colors"
                aria-label="Open sidebar"
              >
                <Menu className="h-5 w-5" />
              </button>
              {!hideHeader && (
                <>
                  <div className="w-10 h-10 sm:w-12 sm:h-12">
                    <img
                      src={finnyLogo}
                      alt="Finny Logo"
                      className="w-full h-full object-contain"
                    />
                  </div>
                  <div>
                    <h1 className="text-[#001d6e] font-bold text-xl sm:text-2xl">Welcome,</h1>
                    <p className="text-gray-600 text-sm font-medium">
                      {formatUsername(currentUser?.username)}
                    </p>
                  </div>
                </>
              )}
            </div>

            {!hideHeader && (
              <div className="flex items-center space-x-2">
                {canToggleHeader && (
                  <button
                    onClick={() => setHeaderHidden(true)}
                    className="flex shrink-0 items-center gap-1 rounded-lg border border-gray-200 px-2 py-1.5 text-xs font-medium text-gray-500 transition-colors hover:bg-gray-50 hover:text-[#001d6e]"
                    title="Hide header for more space"
                  >
                    <ChevronUp className="h-4 w-4" /> Hide header
                  </button>
                )}
                {/* Home navigation button (only visible on non-home pages) */}
                {location !== '/' && (
                  <Link href="/" className="flex items-center justify-center w-10 h-10 rounded-full bg-blue-50 text-[#001d6e] hover:bg-blue-100 transition-colors">
                    <Home className="h-5 w-5" />
                  </Link>
                )}

                {/* Logout button in top right */}
                <a
                  href="/logout"
                  onClick={(e) => {
                    if (onLogout) {
                      e.preventDefault();
                      onLogout();
                    }
                  }}
                  className="flex items-center justify-center w-10 h-10 rounded-full bg-[#001d6e] text-white hover:bg-blue-900 transition-colors"
                >
                  <svg xmlns="http://www.w3.org/2000/svg" width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                    <path d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4"></path>
                    <polyline points="16 17 21 12 16 7"></polyline>
                    <line x1="21" y1="12" x2="9" y2="12"></line>
                  </svg>
                </a>
              </div>
            )}
          </div>
        </div>
        
        {/* When the header is collapsed, a small floating pill brings it back. */}
        {hideHeader && (
          <button
            onClick={() => setHeaderHidden(false)}
            className="fixed left-1/2 top-2 z-40 flex -translate-x-1/2 items-center gap-1.5 rounded-full bg-[#001d6e] px-4 py-1.5 text-xs font-semibold text-white shadow-lg transition-colors hover:bg-[#00154b]"
            title="Show header"
          >
            <ChevronDown className="h-4 w-4" /> Show header
          </button>
        )}

        {/* Page content */}
        {/* overflow-x-hidden is deliberate: with only overflow-y set, the x axis computes to
            `auto` and the entire page pans sideways into empty space past the widest element.
            Tables scroll horizontally inside their own containers, so nothing is lost here. */}
        {/* min-h-0: <main> is ITSELF a flex item (flex-1, of the flex-col at line 136) and had
            the exact same min-height:auto problem one level up — without overriding it here too,
            <main> still computed its own height from its (now properly int-clipped, but still
            reported) content rather than shrinking to its allotted share, leaving a sliver of
            the previous scroll position visible above a page's sticky header. */}
        <main className="flex-1 min-h-0 overflow-y-auto overflow-x-hidden bg-white">
          {/* flex h-full flex-col: every page's own root is `flex-1 overflow-y-auto ...` (dozens
              of pages share that exact pattern), which only works as a real, bounded scroll
              container when ITS parent is a sized flex column. Without this, that div had no
              definite height, so its own overflow-y-auto was inert and <main> above did the
              actual scrolling instead — which silently broke `position: sticky` for any header a
              page tried to pin while its own table scrolled, since sticky only latches onto the
              nearest ancestor that's genuinely a scroll container, not a grandparent's. With this,
              each page scrolls within itself as its className already implied, and <main>'s own
              overflow-y-auto simply never needs to engage (its child now exactly fills it).
              [&>*]:min-h-0 — flex items default to min-height:auto, which means "never shrink
              below your content's natural height" even with flex-1 set. Without overriding that
              to 0 on the page's own root div, h-full above alone wasn't enough: the page's root
              still grew to its full (long) content height instead of clipping to this box and
              scrolling internally, which pushed <main> itself past its bounds and made IT start
              scrolling too — two scroll contexts moving at once, which is what let page content
              visibly bleed past/above a page's own sticky header while scrolling. */}
          <div className="flex h-full min-w-0 flex-col px-4 sm:px-6 [&>*]:min-h-0">
            <PortalRotationProvider rotation={portalRotation}>{children}</PortalRotationProvider>
          </div>
        </main>
        
        {/* Mobile Navigation - shown on home, messages, and profile pages */}
        {(location === '/' || location === '/messages' || location === '/profile') && <MobileNavigation onLogout={onLogout} />}
      </div>
    </div>
    </SidebarContext.Provider>
  );
};

export default Layout;