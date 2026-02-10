import { Package, History, Upload, PieChart, ScanLine, FileText, MoreHorizontal, UsersRound, ShoppingCart, Receipt, IndianRupee, Activity, Factory, PrinterCheck, Truck } from 'lucide-react';
import useEmblaCarousel from 'embla-carousel-react';
import { useCallback, useEffect, useState } from 'react';
import { isAdminOrSuperAdmin, getCurrentUserPermissions } from '@/lib/permissions';

// Import the requested images
import ganpatiImg from '@assets/ganpati.png';
import awardImg from '@assets/IMG_20240117_171256.jpg';

const Home = () => {
  const [emblaRef, emblaApi] = useEmblaCarousel({ loop: true });
  const [scrollProgress, setScrollProgress] = useState(0);
  const [isAdmin, setIsAdmin] = useState(false);
  const [showSalesPage, setShowSalesPage] = useState(false);
  const [canAccessExpenseVoucher, setCanAccessExpenseVoucher] = useState(false);

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
        setCanAccessExpenseVoucher(userPermissions.canAccessExpenseVoucher);
      }
    } catch (error) {
      console.error('Error checking user permissions:', error);
    }
  }, []);

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
    <div className="flex-1 overflow-y-auto bg-white min-h-screen">
      <div className="p-4 lg:p-6 max-w-md mx-auto">
        
        {/* Image Slider - Only Ganpati and Award images as requested */}
        <div className="mb-4 overflow-hidden" ref={emblaRef}>
          <div className="flex">
            <div className="flex-shrink-0 min-w-full">
              <img 
                src={ganpatiImg} 
                alt="Ganpati" 
                className="w-full h-48 object-contain mx-auto" 
              />
            </div>
            <div className="flex-shrink-0 min-w-full">
              <img 
                src={awardImg} 
                alt="Award Ceremony" 
                className="w-full h-48 object-contain mx-auto" 
              />
            </div>
          </div>
        </div>
        
        {/* Dot indicators - Only 2 dots for 2 images */}
        <div className="flex justify-center space-x-2 mb-6">
          {[0, 1].map((index) => {
            // Calculate if this dot is the active one based on scroll progress
            // Each dot represents 1/2 of the total scroll
            const isActive = 
              (scrollProgress >= index/2) && 
              (scrollProgress < (index+1)/2);
            
            return (
              <div 
                key={index}
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
        
        {/* Main action buttons in a grid layout (4x2) */}
        <div className="grid grid-cols-4 gap-4">
          {/* Row 1 */}
          {/* Print Operations Button */}
          <div className="flex flex-col items-center">
            <a href="/print-operations" className="flex flex-col items-center">
              <div className="w-16 h-16 rounded-full bg-blue-50 flex items-center justify-center mb-2 shadow-sm">
                <PrinterCheck className="h-7 w-7 text-[#001d6e]" style={{fill: "#8766e3"}} />
              </div>
              <span className="text-gray-800 text-sm text-center">Print</span>
            </a>
          </div>
          
          {/* Load Button */}
          <div className="flex flex-col items-center">
            <a href="/load-operations" className="flex flex-col items-center">
              <div className="w-16 h-16 rounded-full bg-blue-50 flex items-center justify-center mb-2 shadow-sm">
                <Factory className="h-7 w-7 text-[#001d6e] fill-[#4d7eff]" />
              </div>
              <span className="text-gray-800 text-sm text-center">Load</span>
            </a>
          </div>
          
          {/* Dispatch Button */}
          <div className="flex flex-col items-center">
            <a href="/dispatch" className="flex flex-col items-center">
              <div className="w-16 h-16 rounded-full bg-blue-50 flex items-center justify-center mb-2 shadow-sm">
                <Truck className="h-7 w-7 text-[#001d6e]" style={{fill: "#eab308"}} />
              </div>
              <span className="text-gray-800 text-sm text-center">Dispatch</span>
            </a>
          </div>

          {/* Expense Voucher Button - Only show if user has access */}
          {canAccessExpenseVoucher && (
            <div className="flex flex-col items-center">
              <a href="/expense-voucher" className="flex flex-col items-center">
                <div className="w-16 h-16 rounded-full bg-blue-50 flex items-center justify-center mb-2 shadow-sm">
                  <Receipt className="h-7 w-7 text-[#001d6e]" style={{fill: "#ea580c"}} />
                </div>
                <span className="text-gray-800 text-sm text-center">Expense</span>
              </a>
            </div>
          )}
          
          {/* Row 2 */}
          {/* Scan Button */}
          <div className="flex flex-col items-center mt-4">
            <a href="/scan" className="flex flex-col items-center">
              <div className="w-16 h-16 rounded-full bg-blue-50 flex items-center justify-center mb-2 shadow-sm">
                <ScanLine className="h-7 w-7 text-[#001d6e]" />
              </div>
              <span className="text-gray-800 text-sm text-center">Scan</span>
            </a>
          </div>
          
          {/* History Button */}
          <div className="flex flex-col items-center mt-4">
            <a href="/scan-history" className="flex flex-col items-center">
              <div className="w-16 h-16 rounded-full bg-blue-50 flex items-center justify-center mb-2 shadow-sm">
                <History className="h-7 w-7 text-[#001d6e]" />
              </div>
              <span className="text-gray-800 text-sm text-center">History</span>
            </a>
          </div>
          
          {/* Proforma Slips Button */}
          <div className="flex flex-col items-center mt-4">
            <a href="/proforma-slips" className="flex flex-col items-center">
              <div className="w-16 h-16 rounded-full bg-blue-50 flex items-center justify-center mb-2 shadow-sm">
                <FileText className="h-7 w-7 text-[#001d6e]" />
              </div>
              <span className="text-gray-800 text-sm text-center">Proforma Slips</span>
            </a>
          </div>
          
          {/* Reports Button */}
          <div className="flex flex-col items-center mt-4">
            <a href="/reports" className="flex flex-col items-center">
              <div className="w-16 h-16 rounded-full bg-blue-50 flex items-center justify-center mb-2 shadow-sm">
                <PieChart className="h-7 w-7 text-[#001d6e]" />
              </div>
              <span className="text-gray-800 text-sm text-center">Reports</span>
            </a>
          </div>
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
