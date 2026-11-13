import { Package, Upload, FileUp, ScanLine, FileText, MoreHorizontal, UsersRound, ShoppingCart, IndianRupee, Activity, Factory, PrinterCheck, Truck, ClipboardList, PackageCheck } from 'lucide-react';
import useEmblaCarousel from 'embla-carousel-react';
import { useCallback, useEffect, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { Link } from 'wouter';
import { apiRequest } from '@/lib/queryClient';
import { isAdminOrSuperAdmin, getCurrentUserPermissions, hasPageViewAccess } from '@/lib/permissions';
import Header from '@/components/Header';
import { useSidebarContext } from '@/lib/sidebarContext';


const Home = () => {
  const [emblaRef, emblaApi] = useEmblaCarousel({ loop: true });
  const [scrollProgress, setScrollProgress] = useState(0);
  const [isAdmin, setIsAdmin] = useState(false);
  const [showSalesPage, setShowSalesPage] = useState(false);
  const [isScanUser, setIsScanUser] = useState(false);
  // The Welcome header (logo, name, logout) is shown on Home only — other pages get the full height.
  const { logout } = useSidebarContext();
  const [userName] = useState(() => {
    try { return JSON.parse(localStorage.getItem('currentUser') || '{}').username || ''; } catch { return ''; }
  });

  // Check user permissions
  useEffect(() => {
    try {
      const currentUserStr = localStorage.getItem('currentUser');
      if (currentUserStr) {
        const currentUser = JSON.parse(currentUserStr);
        setIsAdmin(isAdminOrSuperAdmin(currentUser.role));

        // Check if user should see Sales page instead of Reports
        const userPermissions = getCurrentUserPermissions();
        setShowSalesPage(userPermissions.canAccessSalesPage);

        // Non-admin/billing users are scanning dept users
        const role = (currentUser.role ?? '').toLowerCase().trim();
        setIsScanUser(!['admin', 'super-admin', 'billing'].includes(role));
      }
    } catch (error) {
      console.error('Error checking user permissions:', error);
    }
  }, []);

  // Poll for active scan session (scanning dept users only)
  const { data: scanNotif } = useQuery<{ active: boolean; session: any }>({
    queryKey: ['/api/order-scan/notification'],
    queryFn: () => apiRequest('GET', '/api/order-scan/notification').then((r) => r.json()),
    enabled: isScanUser,
    refetchInterval: 30000,
  });

  // Slider pictures are the "Product Ad" rows of the Notion attachment database (server/services/homeSlidesSync)
  const { data: homeSlides } = useQuery<{ welcome: string | null; ads: { title: string; url: string }[] }>({
    queryKey: ['/api/home-slides'],
    queryFn: () => fetch('/api/home-slides').then((r) => r.json()),
    staleTime: 5 * 60 * 1000,
  });
  const slides = homeSlides?.ads ?? [];

  // Automatically scroll every 5 seconds
  useEffect(() => {
    if (!emblaApi) return;
    
    const interval = setInterval(() => {
      emblaApi.scrollNext();
    }, 5000);
    
    return () => clearInterval(interval);
  }, [emblaApi]);

  // Update scroll progress
  const onScroll = useCallback(() => {
    if (!emblaApi) return;
    const progress = Math.max(0, Math.min(1, emblaApi.scrollProgress()));
    setScrollProgress(progress);
  }, [emblaApi]);

  useEffect(() => {
    if (!emblaApi) return;
    emblaApi.on('scroll', onScroll);
    onScroll();
    return () => {
      emblaApi.off('scroll', onScroll);
    };
  }, [emblaApi, onScroll]);

  return (
    <div className="flex-1 overflow-y-auto bg-transparent min-h-screen">
      <Header userName={userName} onLogout={logout} />
      <div className="p-4 lg:p-6 max-w-md mx-auto">
        
        {/* Image Slider - Product Ad slides from Notion */}
        <div className="mb-4 overflow-hidden" ref={emblaRef}>
          <div className="flex">
            {slides.map((slide) => (
              <div key={slide.url} className="flex-shrink-0 min-w-full flex justify-center">
                {/* Sized to the image's own aspect (not a fixed box) so the rounded corners sit on
                    the picture itself instead of on letterbox space around it */}
                <img
                  src={slide.url}
                  alt={slide.title}
                  className="max-w-full max-h-48 w-auto h-auto rounded-3xl shadow-md"
                />
              </div>
            ))}
          </div>
        </div>

        {/* Dot indicators - one per slide */}
        <div className="flex justify-center space-x-2 mb-6">
          {slides.map((slide, index) => {
            // Each dot represents 1/n of the total scroll
            const isActive =
              (scrollProgress >= index / slides.length) &&
              (scrollProgress < (index + 1) / slides.length);

            return (
              <div
                key={slide.url}
                className={`h-2 w-2 rounded-full transition-all duration-200 ${
                  isActive ? 'bg-[#001d6e]' : 'bg-gray-300'
                }`}
              ></div>
            );
          })}
        </div>
        
        {/* Loading animation for proper styling */}
        <div className="loading-indicator mb-6" style={{ display: "none" }}>
          <div className="loading-dots">
            <div className="loading-dots--dot"></div>
            <div className="loading-dots--dot"></div>
            <div className="loading-dots--dot"></div>
          </div>
        </div>
        
        {/* Active scan banner — scanning dept users only */}
        {isScanUser && scanNotif?.active && scanNotif.session && (
          <div className="mb-5 flex items-center gap-3 rounded-xl border-2 border-amber-400 bg-amber-50 px-4 py-3 shadow-sm">
            <span className="h-3 w-3 shrink-0 rounded-full bg-amber-400 animate-pulse" />
            <div className="flex-1 min-w-0">
              <p className="text-sm font-bold text-amber-900">Scan Available!</p>
              <p className="text-xs text-amber-700 truncate">{scanNotif.session.csvFileName}</p>
              <p className="text-[11px] text-amber-600">{scanNotif.session.plant} · {scanNotif.session.rowCount} rows</p>
            </div>
            <Link
              href="/scan"
              className="shrink-0 rounded-lg bg-[#001d6e] px-3 py-2 text-xs font-semibold text-white shadow hover:bg-[#00154b] transition-colors"
            >
              Scan Now
            </Link>
          </div>
        )}

        {/* Main action buttons in a grid layout (4x2) */}
        <div className="grid grid-cols-4 gap-4">
          {/* Row 1 */}
          {/* Print Operations Button */}
          {hasPageViewAccess("print-operations") && (
            <div className="flex flex-col items-center">
              <Link href="/print-operations" className="flex flex-col items-center">
                <div className="w-16 h-16 rounded-full glass flex items-center justify-center mb-2">
                  <PrinterCheck className="h-7 w-7 text-[#001d6e]" style={{fill: "#8766e3"}} />
                </div>
                <span className="text-gray-800 text-sm text-center">Print</span>
              </Link>
            </div>
          )}

          {/* Load Button — the current Load Operations page (/loading). It used to point at the
              retired /load-operations page and was gated by that page's own grant, so it opened
              the old screen for whoever still had that grant and was hidden from everyone else. */}
          {hasPageViewAccess("loading") && (
            <div className="flex flex-col items-center">
              <Link href="/loading" className="flex flex-col items-center">
                <div className="w-16 h-16 rounded-full glass flex items-center justify-center mb-2">
                  <Factory className="h-7 w-7 text-[#001d6e] fill-[#4d7eff]" />
                </div>
                <span className="text-gray-800 text-sm text-center">Load</span>
              </Link>
            </div>
          )}
          {/* Sort Slip Button */}
          {hasPageViewAccess("sort-slip") && (
            <div className="flex flex-col items-center">
              <Link href="/sort-slip" className="flex flex-col items-center">
                <div className="w-16 h-16 rounded-full glass flex items-center justify-center mb-2">
                  <ClipboardList className="h-7 w-7 text-[#001d6e]" />
                </div>
                <span className="text-gray-800 text-sm text-center">Sort Slip</span>
              </Link>
            </div>
          )}

          {/* Loading Overview Button */}
          {hasPageViewAccess("loading-overview") && (
            <div className="flex flex-col items-center">
              <Link href="/loading-overview" className="flex flex-col items-center">
                <div className="w-16 h-16 rounded-full glass flex items-center justify-center mb-2">
                  <PackageCheck className="h-7 w-7 text-[#001d6e]" />
                </div>
                <span className="text-gray-800 text-sm text-center">Loading Overview</span>
              </Link>
            </div>
          )}

          {/* Dispatch Button */}
          {hasPageViewAccess("dispatch") && (
            <div className="flex flex-col items-center">
              <Link href="/dispatch" className="flex flex-col items-center">
                <div className="w-16 h-16 rounded-full glass flex items-center justify-center mb-2">
                  <Truck className="h-7 w-7 text-[#001d6e]" style={{fill: "#eab308"}} />
                </div>
                <span className="text-gray-800 text-sm text-center">Dispatch</span>
              </Link>
            </div>
          )}

          {/* Row 2 */}
          {/* Scan Button */}
          {hasPageViewAccess("scan-order") && (
            <div className="flex flex-col items-center">
              <Link href="/scan" className="flex flex-col items-center">
                <div className="w-16 h-16 rounded-full glass flex items-center justify-center mb-2">
                  <ScanLine className="h-7 w-7 text-[#001d6e]" />
                </div>
                <span className="text-gray-800 text-sm text-center">Scan</span>
              </Link>
            </div>
          )}

          {/* Proforma Slips Button */}
          {hasPageViewAccess("proforma") && (
            <div className="flex flex-col items-center">
              <Link href="/proforma-slips" className="flex flex-col items-center">
                <div className="w-16 h-16 rounded-full glass flex items-center justify-center mb-2">
                  <FileText className="h-7 w-7 text-[#001d6e]" />
                </div>
                <span className="text-gray-800 text-sm text-center">Proforma Slips</span>
              </Link>
            </div>
          )}

          {/* Reports Button — order reports live inside Order Management now (per-row
              Reports dialog), not a separate page, so this points there. */}
          {hasPageViewAccess("order-import") && (
            <div className="flex flex-col items-center">
              <Link href="/order-import" className="flex flex-col items-center">
                <div className="w-16 h-16 rounded-full glass flex items-center justify-center mb-2">
                  <FileUp className="h-7 w-7 text-[#001d6e]" />
                </div>
                <span className="text-gray-800 text-sm text-center">Order Management</span>
              </Link>
            </div>
          )}
        </div>
        
        {/* KRUPA MARKETING Credit */}
        <div className="mt-8 text-center">
          <hr className="w-24 mx-auto border-blue-100 border-2 mb-3" />
          <p className="text-[#001d6e] text-sm font-bold">KRUPA MARKETING</p>
          <p className="text-[#001d6e] text-xs">since 2004</p>
        </div>
      </div>
    </div>
  );
};

export default Home;