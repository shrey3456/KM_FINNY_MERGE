import React, { useEffect, useState } from 'react';
import { useLocation, Link } from 'wouter';
import Header from './Header';
import Sidebar from './Sidebar';
import MobileNavigation from './MobileNavigation';
import InstallPrompt from './InstallPrompt';
import finnyLogo from '@assets/finny-logo.png';
import { Home, Menu } from 'lucide-react';
import { formatUsername } from '@/lib/format-username';

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

const Layout: React.FC<LayoutProps> = ({ children, onLogout }) => {
  const [location] = useLocation();
  const [currentUser, setCurrentUser] = useState<CurrentUser | null>(null);
  const [sidebarVisible, setSidebarVisible] = useState(true);
  
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

  return (
    <div className="flex h-screen overflow-hidden bg-white">
      {/* Sidebar for desktop - conditionally shown based on sidebarVisible state */}
      {sidebarVisible && (
        <div className="hidden lg:block">
          <Sidebar onLogout={onLogout} />
        </div>
      )}
      
      {/* Main content area */}
      <div className="flex flex-col flex-1 overflow-hidden">
        {/* Header for desktop with hamburger menu */}
        <div className="hidden lg:flex items-center w-full bg-white border-b border-gray-200">
          <button 
            onClick={toggleSidebar}
            className="p-3 text-[#001d6e] hover:bg-gray-100 transition-colors rounded-md mx-2"
            aria-label={sidebarVisible ? "Hide sidebar" : "Show sidebar"}
          >
            <Menu className="h-6 w-6" />
          </button>
          <Header 
            userName={currentUser?.username || ''} 
            userRole={currentUser?.role || ''}
          />
        </div>
        
        {/* Mobile Header with tribe logo, welcome text and (on non-home pages) a home icon - Hidden on messages and profile */}
        <div className={`lg:hidden bg-white border-b border-gray-200 p-4 w-full ${location === '/messages' || location === '/profile' ? 'hidden' : ''}`}>
          <div className="flex items-center justify-between">
            <div className="flex items-center space-x-4">
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
            </div>
            
            <div className="flex items-center space-x-2">
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
          </div>
        </div>
        
        {/* Page content */}
        <main className="flex-1 overflow-y-auto bg-white">
          <div className="px-4 sm:px-6">
            {children}
          </div>
        </main>
        
        {/* Mobile Navigation - shown on home, messages, and profile pages */}
        {(location === '/' || location === '/messages' || location === '/profile') && <MobileNavigation onLogout={onLogout} />}
      </div>
      
      {/* Install prompt for "Add to Home Screen" functionality */}
      <InstallPrompt />
    </div>
  );
};

export default Layout;