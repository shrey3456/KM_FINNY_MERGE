import React, { useState } from 'react';
import { Sheet, SheetContent, SheetTrigger } from '@/components/ui/sheet';
import { Button } from '@/components/ui/button';
import { Link } from 'wouter';
import { 
  BarChart4,
  Home,
  Settings,
  Users,
  ScanLine,
  Menu,
  FileText,
  ClipboardList
} from 'lucide-react';

interface MobileMenuProps {
  currentPath: string;
}

const MobileMenu: React.FC<MobileMenuProps> = ({ currentPath }) => {
  const [open, setOpen] = useState(false);

  const menuItems = [
    { label: 'Dashboard', icon: <Home className="h-5 w-5 mr-3 text-[#4e2e1a]" />, path: '/' },
    { label: 'Proforma Slips', icon: <FileText className="h-5 w-5 mr-3" />, path: '/proforma-slips' },
    { label: 'Scan Order', icon: <ScanLine className="h-5 w-5 mr-3" />, path: '/scan' },
    { label: 'Order Management', icon: <ClipboardList className="h-5 w-5 mr-3" />, path: '/order-management' },
    { label: 'Reports', icon: <BarChart4 className="h-5 w-5 mr-3" />, path: '/scan-history' },
    { label: 'Users', icon: <Users className="h-5 w-5 mr-3" />, path: '/users' },
    { label: 'Settings', icon: <Settings className="h-5 w-5 mr-3" />, path: '/settings' },
  ];

  return (
    <Sheet open={open} onOpenChange={setOpen}>
      <SheetTrigger asChild>
        <Button variant="ghost" size="icon" className="lg:hidden">
          <Menu />
          <span className="sr-only">Toggle menu</span>
        </Button>
      </SheetTrigger>
      <SheetContent side="left" className="w-[280px] p-0">
        <div className="p-4 border-b border-gray-200">
          <div className="flex items-center space-x-3">
            <div className="w-10 h-10 rounded-lg bg-primary flex items-center justify-center text-white font-bold">
              KM
            </div>
            <h1 className="text-xl font-bold">KM-Tribe</h1>
          </div>
        </div>
        
        <nav className="flex-1 py-4 overflow-y-auto">
          <ul className="space-y-1 px-3">
            {menuItems.map((item) => (
              <li key={item.path}>
                <Link href={item.path}>
                  <a 
                    className={`flex items-center px-3 py-2 rounded-lg ${
                      currentPath === item.path
                        ? 'bg-primary/10 text-primary font-medium'
                        : 'text-gray-700 hover:bg-gray-100'
                    }`}
                    onClick={() => setOpen(false)}
                  >
                    {item.icon}
                    {item.label}
                  </a>
                </Link>
              </li>
            ))}
          </ul>
        </nav>
        
        <div className="p-4 border-t border-gray-200">
          <div className="flex items-center">
            <div className="w-8 h-8 rounded-full bg-gray-200 mr-3 flex items-center justify-center text-gray-500">
              <Users size={16} />
            </div>
            <div>
              <p className="text-sm font-medium">Admin User</p>
              <p className="text-xs text-gray-500">Administrator</p>
            </div>
          </div>
        </div>
      </SheetContent>
    </Sheet>
  );
};

export default MobileMenu;
