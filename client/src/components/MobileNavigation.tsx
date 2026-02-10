import React, { useState, useEffect } from 'react';
import { Link, useLocation } from 'wouter';
import { getCurrentUserPermissions } from '../lib/permissions';
import { 
  Home, 
  User
} from 'lucide-react';
import MessageIcon from '../assets/message-icon';
import { Avatar, AvatarFallback, AvatarImage } from '@/components/ui/avatar';

interface MobileNavigationProps {
  onLogout?: () => void;
}

interface CurrentUser {
  id: number;
  username: string;
  name?: string;
  role?: string;
  department?: string;
}

const MobileNavigation: React.FC<MobileNavigationProps> = ({ onLogout }) => {
  const [location] = useLocation();
  const [currentUser, setCurrentUser] = useState<CurrentUser | null>(null);
  const [profileImageUrl, setProfileImageUrl] = useState<string | null>(null);
  const [imageError, setImageError] = useState(false);

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
  }, []);

  useEffect(() => {
    // Load profile image
    const userCode = localStorage.getItem('userCode');
    if (userCode) {
      setProfileImageUrl(`/api/users/${userCode}/profile-image`);
    }
  }, []);
  
  const handleLogoutClick = (e: React.MouseEvent) => {
    if (onLogout) {
      e.preventDefault();
      onLogout();
    }
  };

  return (
    <nav className="lg:hidden bg-white border-t border-gray-100 fixed bottom-0 left-0 right-0 z-50">
      <div className="flex justify-around items-center px-4 py-2 max-w-md mx-auto">
        {/* Home */}
        <Link 
          href="/" 
          className={`flex flex-col items-center py-2 px-3 rounded-full transition-colors ${
            location === '/' ? 'text-primary' : 'text-gray-400'
          }`}
        >
          <div className={`w-10 h-10 rounded-full flex items-center justify-center ${
            location === '/' ? 'bg-primary/10' : ''
          }`}>
            <Home className="h-6 w-6" />
          </div>
          <span className="text-xs mt-1 font-medium">Home</span>
        </Link>
        
        {/* Messages */}
        <Link 
          href="/messages" 
          className={`flex flex-col items-center py-2 px-3 rounded-full transition-colors ${
            location === '/messages' ? 'text-primary' : 'text-gray-400'
          }`}
        >
          <div className={`w-10 h-10 rounded-full flex items-center justify-center ${
            location === '/messages' ? 'bg-primary/10' : ''
          }`}>
            <MessageIcon className="h-6 w-6" />
          </div>
          <span className="text-xs mt-1 font-medium">Messages</span>
        </Link>
        
        {/* Profile */}
        <Link 
          href="/profile" 
          className={`flex flex-col items-center py-2 px-3 rounded-full transition-colors ${
            location === '/profile' ? 'text-primary' : 'text-gray-400'
          }`}
        >
          <div className={`w-10 h-10 rounded-full flex items-center justify-center ${
            location === '/profile' ? 'bg-primary/10' : ''
          }`}>
            {profileImageUrl && !imageError ? (
              <img 
                src={profileImageUrl}
                alt="Profile"
                className="w-8 h-8 rounded-full object-cover"
                onError={() => setImageError(true)}
              />
            ) : (
              <div className="w-8 h-8 rounded-full bg-[#001d6e] flex items-center justify-center text-white text-xs font-semibold">
                {currentUser?.username ? 
                  currentUser.username.replace('@km-tribe', '').charAt(0).toUpperCase() : 
                  <User className="h-4 w-4" />}
              </div>
            )}
          </div>
          <span className="text-xs mt-1 font-medium">
            {!currentUser ? 'Login' : 'Profile'}
          </span>
        </Link>
        
      </div>
    </nav>
  );
};

export default MobileNavigation;
