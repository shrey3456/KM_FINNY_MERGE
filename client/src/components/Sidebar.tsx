import React, { useEffect, useState } from "react";
import { Link, useLocation } from "wouter";
import { useQuery } from "@tanstack/react-query";
import { getCurrentUserPermissions } from "../lib/permissions";
import { useAuth } from "../hooks/use-auth";
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
  PieChart,
  UserRound,
  Activity,
  Receipt,
  IndianRupee,
  Factory,
  ClipboardList,
  Printer,
  PrinterCheck,
  FileBarChart,
  Clock,
  Database,
  ScanLine,
  FileUp,
  PackageCheck,
  ChevronsLeft,
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
          //disabled: !userPermissions.canManageUsers
        },
        {
          label: "Stock Sheets",
          icon: (
            <FileBarChart
              className="h-5 w-5 mr-3 text-[#001d6e]"
              style={{ fill: "#22c55e" }}
            />
          ),
          path: "/stock-sheets",
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
        },
        {
          label: "Proforma Slips",
          icon: <FileText className="h-5 w-5 mr-3 text-[#001d6e]" />,
          path: "/proforma-slips",
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
        },
        {
          label: "Scan Order",
          icon: <ScanLine className="h-5 w-5 mr-3 text-[#001d6e]" />,
          path: "/scan",
        },
        {
          label: "Order Scan",
          icon: <PackageCheck className="h-5 w-5 mr-3 text-[#001d6e]" />,
          path: "/order-scan",
        },
        {
          label: "Pallet Stock Report",
          icon: <FileBarChart className="h-5 w-5 mr-3 text-[#001d6e]" style={{ fill: "#a78bfa" }} />,
          path: "/scan-stock-report",
        },
        {
          label: "Reports",
          icon: <PieChart className="h-5 w-5 mr-3 text-[#001d6e]" />,
          path: "/reports",
        },
      ],
    },
    {
      title: "INVENTORY",
      items: [
        {
          label: "Inventory",
          icon: <Package className="h-5 w-5 mr-3 text-[#001d6e]" />,
          path: "/inventory",
        },
        {
          label: "Purchases",
          icon: <ShoppingCart className="h-5 w-5 mr-3 text-[#001d6e]" />,
          path: "/purchases",
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
        },
        {
          label: "Notion Inventory",
          icon: <Database className="h-5 w-5 mr-3 text-[#001d6e]" />,
          path: "/notion-inventory",
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
        },
        {
          label: "Order Management",
          icon: <ClipboardList className="h-5 w-5 mr-3 text-[#001d6e]" />,
          path: "/order-management",
        },
        {
          label: "Order Import",
          icon: <FileUp className="h-5 w-5 mr-3 text-[#001d6e]" />,
          path: "/order-import",
        },
        {
          label: "Activities",
          icon: <Activity className="h-5 w-5 mr-3 text-[#001d6e]" />,
          path: "/activities",
        },
        {
          label: "Settings",
          icon: <Settings className="h-5 w-5 mr-3 text-[#001d6e]" />,
          path: "/settings",
        },
      ],
    },
  ];

  // Get user permissions for conditional rendering
  // const userPermissions = getCurrentUserPermissions();

  // Filter categories based on user permissions
  const filteredCategories = menuCategories.filter((category) => {
    // Hide ADMIN category for non-admin users
    if (category.title === "ADMIN" && !userPermissions.canManageUsers) {
      return false;
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
                  // Check if item requires permission
                  if (item.permission) {
                    // @ts-ignore - We know the permission exists
                    return userPermissions[item.permission] === true;
                  }
                  return true; // Show items with no permission requirement
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
                        {item.label}
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
