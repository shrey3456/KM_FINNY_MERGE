import React from 'react';
import finnyLogo from '@assets/finny-logo.png';
import { Home } from 'lucide-react';
import { Link, useLocation } from 'wouter';
import { formatUsername } from '@/lib/format-username';

interface HeaderProps {
  userName?: string;
  userRole?: string;
}

const Header: React.FC<HeaderProps> = ({ 
  userName = '',
  userRole = ''
}) => {
  // Format username by removing @km-tribe suffix
  const displayUsername = formatUsername(userName);
  
  // Get current location to determine if we're on the home page
  const [location] = useLocation();
  const isHomePage = location === '/';
  
  return (
    <header className="bg-white border-b border-gray-200 py-4 px-4 flex items-center justify-between w-full">
      <div className="flex items-center space-x-4">
        <div className="w-10 h-10 sm:w-12 sm:h-12">
          <img 
            src={finnyLogo} 
            alt="KM Finny Logo" 
            className="w-full h-full object-contain" 
          />
        </div>
        <div>
          <h1 className="text-[#001d6e] font-bold text-xl sm:text-2xl">Welcome,</h1>
          <p className="text-gray-600 text-sm font-medium">{displayUsername}</p>
        </div>
      </div>
      
      {/* Home navigation button (only visible on non-home pages) */}
      {!isHomePage && (
        <Link href="/" className="flex items-center justify-center w-10 h-10 rounded-full bg-blue-50 text-[#001d6e] hover:bg-blue-100 transition-colors">
          <Home className="h-5 w-5" />
        </Link>
      )}
    </header>
  );
};

export default Header;