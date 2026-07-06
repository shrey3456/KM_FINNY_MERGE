import React, { useEffect, useState } from "react";
import { Link, useLocation } from "wouter";
import { useQuery } from "@tanstack/react-query";
import { getCurrentUserPermissions } from "../lib/permissions";
import { useAuth } from "../hooks/use-auth";
import { apiRequest } from "../lib/queryClient";
import { formatUsername } from "@/lib/format-username";
import {
  Home,
  Settings,
  Users,
  ShoppingCart,
  Truck,
  LogOut,
  FileText,
  Clipboard,
  Package,
  History as HistoryIcon,
  UserRound,
  Activity,
  Receipt,
  IndianRupee,
  Factory,
  Printer,
  PrinterCheck,
  FileBarChart,
  Clock,
  Database,
  ScanLine,
  FileUp,
  PackageCheck,
  ChevronsLeft,
  LayoutList,
} from "lucide-react";
import MessageIcon from "../assets/message-icon";
import QuicklineIcon from "../assets/quickline-icon";

interface SidebarProps {
  onLogout?: () => void;
  onCollapse?: () => void;
  isMobile?: boolean;
}

const Sidebar: React.FC<SidebarProps> = ({ onLogout, onCollapse, isMobile }) => {
  const [location] = useLocation();
  const { user: authUser } = useAuth();
  const [fallbackUser, setFallbackUser] = useState(null);

  // Use authUser if available, otherwise fallback to localStorage
  const currentUser = authUser || fallbackUser;

  // Fallback to localStorage if AuthContext fails
  useEffect(() => {
    if (!authUser) {
      const userStr = localStorage.getItem("currentUser");
      if (userStr) {
        try {
          const userData = JSON.parse(userStr);
          setFallbackUser(userData);
        } catch (error) {
          console.error("Error parsing user data from localStorage:", error);
        }
      }
    }
  }, [authUser]);

  const [profileImageUrl, setProfileImageUrl] = useState<string | null>(null);
  const [imageError, setImageError] = useState(false);

  useEffect(() => {
    // Handle profile image - check if user has profileImage data or load from API
    if (currentUser?.userCode) {
      // If user has Base64 profile image data, use it directly
      if (currentUser.profileImage) {
        setProfileImageUrl(
          `data:image/jpeg;base64,${currentUser.profileImage}`,
        );
        setImageError(false);
      } else {
        // Otherwise, try to load from API endpoint
        setProfileImageUrl(`/api/users/${currentUser.userCode}/profile-image`);
        setImageError(false);
      }
    } else {
      setProfileImageUrl(null);
    }
  }, [currentUser?.userCode, currentUser?.profileImage]);

  // Handle logout click
  const handleLogoutClick = (e: React.MouseEvent) => {
    if (onLogout) {
      e.preventDefault();
      onLogout();
    }
  };
  const userPermissions = getCurrentUserPermissions();
  // Notification badge: poll for active scan session for non-admin users
  const ADMIN_ROLES = ['admin', 'super-admin'];
  const userRole = ((currentUser as any)?.role ?? '').toLowerCase().trim();
  const userDepartment = ((currentUser as any)?.department ?? '').toLowerCase().trim();
  const isSuperAdmin = ['admin', 'super-admin'].includes(userRole);
  const isAdminRole = ADMIN_ROLES.includes(userRole);
  const { data: scanNotif } = useQuery<{ active: boolean; session: any }>({
    queryKey: ['/api/order-scan/notification'],
    queryFn: () => apiRequest('GET', '/api/order-scan/notification').then((r) => r.json()),
    enabled: !!currentUser && !isAdminRole,
    refetchInterval: 30000,
  });
  const hasScanBadge = !isAdminRole && scanNotif?.active === true;

  // Parse allowed pages from user object
  const allowedPages: string[] = (() => {
    try { return JSON.parse((currentUser as any)?.allowedPages || "[]"); } catch { return []; }
  })();

  // Group menu items by categories as shown in the image
  const menuCategories = [
    {
      title: "MAIN",
      items: [
        {
          label: "Home",
          icon: <Home className="h-5 w-5 mr-3 text-[#001d6e]" />,
          path: "/",
        },
        {
          label: "Messages",
          icon: <MessageIcon className="h-5 w-5 mr-3 text-[#001d6e]" />,
          path: "/messages",
        },
        {
          label: "Check In/Out",
          icon: <Clock className="h-5 w-5 mr-3 text-[#001d6e]" />,
          path: "/inout",
        },
        {
          label: "Profile",
          icon: <UserRound className="h-5 w-5 mr-3 text-[#001d6e]" />,
          path: "/profile",
        },
      ],
    },
    {
      title: "OPERATIONS",
      items: [
        {
          label: "Load Operations",
          icon: (
            <Factory
              className="h-5 w-5 mr-3 text-[#001d6e]"
              style={{ fill: "#4d7eff" }}
            />
          ),
          path: "/load-operations",
          pageKey: "load-operations",
        },
        {
          label: "Print Operations",
          icon: (
            <PrinterCheck
              className="h-5 w-5 mr-3 text-[#001d6e]"
              style={{ fill: "#8766e3" }}
            />
          ),
          path: "/print-operations",
          pageKey: "print-operations",
        },
        {
          label: "Proforma Slips",
          icon: <FileText className="h-5 w-5 mr-3 text-[#001d6e]" />,
          path: "/proforma-slips",
          pageKey: "proforma",
        },
        {
          label: "Dispatch",
          icon: (
            <Truck
              className="h-5 w-5 mr-3 text-[#001d6e]"
              style={{ fill: "#eab308" }}
            />
          ),
          path: "/dispatch",
          pageKey: "dispatch",
        },
        {
          label: "Expense Voucher",
          icon: (
            <Receipt
              className="h-5 w-5 mr-3 text-[#001d6e]"
              style={{ fill: "#ea580c" }}
            />
          ),
          path: "/expense-voucher",
          permission: "canAccessExpenseVoucher",
          pageKey: "expense-voucher",
        },
        {
          label: "Toll Voucher",
          icon: (
            <Receipt
              className="h-5 w-5 mr-3 text-[#001d6e]"
              style={{ fill: "#16a34a" }}
            />
          ),
          path: "/toll-voucher",
          permission: "canAccessExpenseVoucher",
          pageKey: "toll-voucher",
        },
        {
          label: "Scan Order",
          icon: <ScanLine className="h-5 w-5 mr-3 text-[#001d6e]" />,
          path: "/scan",
          badge: hasScanBadge ? 1 : 0,
          pageKey: "scan-order",
        },
        {
          label: "Overall Stock",
          icon: <LayoutList className="h-5 w-5 mr-3 text-[#001d6e]" />,
          path: "/overall-stock",
          permission: "canAccessOverallStockReport",
          pageKey: "overall-stock",
        },
        {
          label: "Scan History",
          icon: <HistoryIcon className="h-5 w-5 mr-3 text-[#001d6e]" />,
          path: "/reports",
          pageKey: "scan-history",
        },
        {

          label: "Order Management",
          icon: <FileUp className="h-5 w-5 mr-3 text-[#001d6e]" />,
          path: "/order-import",
          permission: "canAccessOrderManagement",
          departments: ['billing'],
          pageKey: "order-import",
        },
        {
          label: "Order Reports",
          icon: <FileText className="h-5 w-5 mr-3 text-[#001d6e]" style={{ fill: "#c4b5fd" }} />,
          path: "/order-reports",
          permission: "canAccessOrderManagement",
          departments: ['billing'],
          pageKey: "order-import",
        },
      ],
    },
    {
      title: "INVENTORY",
      items: [
         {
          label: "Inventory",
          icon: <Database className="h-5 w-5 mr-3 text-[#001d6e]" />,
          path: "/notion-inventory",
          pageKey: "notion-inventory",
        },
        {
          label: "Purchases",
          icon: <ShoppingCart className="h-5 w-5 mr-3 text-[#001d6e]" />,
          path: "/purchases",
          pageKey: "purchases",
        },
      ],
    },
    {
      title: "ADMIN",
      items: [
        {
          label: "User Management",
          icon: <Users className="h-5 w-5 mr-3 text-[#001d6e]" />,
          path: "/users",
          pageKey: "user-management",
        },
        {
          label: "Plant Management",
          icon: (
            <Factory
              className="h-5 w-5 mr-3 text-[#001d6e]"
              style={{ fill: "#4d7eff" }}
            />
          ),
          path: "/plant-settings",
          pageKey: "plant-management",
        },
        {
          label: "Activities",
          icon: <Activity className="h-5 w-5 mr-3 text-[#001d6e]" />,
          path: "/activities",
          pageKey: "activities",
        },
        {
          label: "Settings",
          icon: <Settings className="h-5 w-5 mr-3 text-[#001d6e]" />,
          path: "/settings",
          pageKey: "settings",
        },
      ],
    },
  ];

  // Get user permissions for conditional rendering
  // const userPermissions = getCurrentUserPermissions();

  // Filter categories based on user permissions
  const filteredCategories = menuCategories.filter((category) => {
    if (category.title === "ADMIN") {
      // Show ADMIN category if user has canManageUsers OR has role-based access to any item
      const hasRoleBasedItem = category.items.some(
        (item) => (item as any).roles?.includes(userRole)
      );
      return userPermissions.canManageUsers || hasRoleBasedItem;
    }
    // Hide INVENTORY category for users without inventory access
    if (category.title === "INVENTORY" && !userPermissions.canAccessInventory) {
      return false;
    }
    return true;
  });

  return (
    <aside className={isMobile ? "flex flex-col w-64 bg-white h-full" : "hidden lg:flex lg:flex-col lg:w-64 bg-white border-r border-gray-200 h-screen"}>
      {/* Collapse button */}
      <div className="flex justify-end px-3 pt-3 pb-1">
        <button
          onClick={onCollapse}
          className="p-1.5 text-[#001d6e] hover:bg-gray-100 rounded-md transition-colors"
          aria-label="Collapse sidebar"
        >
          <ChevronsLeft className="h-5 w-5" />
        </button>
      </div>

      {/* Sidebar content */}
      <div className="flex-1 py-2 overflow-y-auto">
        {filteredCategories.map((category, index) => (
          <div key={index} className="mb-6 px-4">
            <h3 className="text-xs font-medium text-gray-700 mb-2">
              {category.title}
            </h3>
            <ul className="space-y-1">
              {category.items
                .filter((item) => {
                  const it = item as any;
                  if (it.adminOnly && !isSuperAdmin) return false;
                  // Role-based access: only show to listed roles
                  if (it.roles) return it.roles.includes(userRole);
                  // Permission-based access (with optional department override)
                  if (it.permission) {
                    return userPermissions[it.permission as keyof typeof userPermissions] === true
                      || it.departments?.includes(userDepartment) === true;
                  }
                  // Page-based access control for non-admin users
                  if (it.pageKey && !isAdminRole) {
                    return allowedPages.includes(it.pageKey);
                  }
                  return true;
                })
                .map((item) => {
                  // @ts-ignore
                  if (item.disabled) {
                    return (
                      <li key={item.path}>
                        <div className="flex items-center py-2 text-sm text-gray-400 cursor-not-allowed pl-4 grayscale opacity-60">
                          {item.icon}
                          {item.label}
                        </div>
                      </li>
                    );
                  }

                  return (
                    <li key={item.path}>
                      <Link
                        href={item.path}
                        className={`flex items-center py-2 text-sm hover:bg-gray-50 ${
                          location === item.path
                            ? "text-black font-medium border-l-4 border-[#001d6e] pl-3"
                            : "text-black font-medium pl-4"
                        }`}
                      >
                        {item.icon}
                        <span className="flex-1">{item.label}</span>
                        {/* @ts-ignore */}
                        {item.badge > 0 && location !== item.path && (
                          <span className="mr-2 h-5 w-5 rounded-full bg-red-500 text-white text-[10px] font-bold flex items-center justify-center animate-pulse">
                            1
                          </span>
                        )}
                      </Link>
                    </li>
                  );
                })}
            </ul>
          </div>
        ))}
      </div>

      {/* Logout at bottom */}
      <div className="mt-auto px-4 py-4">
        <Link
          href="/logout"
          onClick={handleLogoutClick}
          className="flex items-center text-sm text-black py-2 pl-4 hover:bg-gray-50"
        >
          <LogOut className="h-5 w-5 mr-3 text-[#001d6e]" />
          Log Out
        </Link>
      </div>
    </aside>
  );
};

export default Sidebar;
