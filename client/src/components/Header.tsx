import React from 'react';
const finnyLogo = '/finny-logo.png'; // served from client/public
import { Home } from 'lucide-react';
import { Link, useLocation } from 'wouter';

interface HeaderProps {
  userName?: string;
  userRole?: string;
  /** Same handler Sidebar's own logout uses — plumbed through from Layout so the desktop
   *  header can offer it too, matching the mobile header bar (which already has both a Home
   *  and a Logout button; this one previously had only Home). */
  onLogout?: () => void;
}

const Header: React.FC<HeaderProps> = ({
  userName = '',
  userRole = '',
  onLogout,
}) => {
  
  // Get current location to determine if we're on the home page
  const [location] = useLocation();
  const isHomePage = location === '/';
  
  return (
    <header className="bg-transparent py-4 px-4 flex items-center justify-between w-full">
      <div className="flex items-center space-x-4">
        <div className="w-10 h-10 sm:w-12 sm:h-12">
          <img 
            src={finnyLogo} 
            alt="Team Finny Logo" 
            className="w-full h-full object-contain" 
          />
        </div>
        <div>
          <h1 className="text-[#001d6e] font-bold text-xl sm:text-2xl">Welcome,</h1>
          <p className="text-gray-600 text-sm font-medium">{userName}</p>
        </div>
      </div>
      
      <div className="flex items-center space-x-2">
        {/* Home navigation button (only visible on non-home pages) */}
        {!isHomePage && (
          <Link href="/" className="flex items-center justify-center w-10 h-10 text-[#001d6e] hover:opacity-70 transition-opacity">
            <Home className="h-5 w-5" />
          </Link>
        )}

        {/* Logout — same button/icon as the mobile header bar (Layout.tsx), just missing from
            here until now. Plain <a href="/logout"> so it still works even if onLogout isn't
            passed in; onLogout (when given) takes over instead of a real navigation. */}
        <a
          href="/logout"
          onClick={(e) => {
            if (onLogout) {
              e.preventDefault();
              onLogout();
            }
          }}
          className="flex lg:hidden items-center justify-center w-10 h-10 text-red-600 hover:opacity-70 transition-opacity"
          aria-label="Log out"
          title="Log out"
        >
          <svg xmlns="http://www.w3.org/2000/svg" width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <path d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4"></path>
            <polyline points="16 17 21 12 16 7"></polyline>
            <line x1="21" y1="12" x2="9" y2="12"></line>
          </svg>
        </a>
      </div>
    </header>
  );
};

export default Header;