import React from 'react';
import { LucideIcon } from 'lucide-react';

interface PageHeaderProps {
  icon: LucideIcon;
  title: string;
  description?: string;
  subtitle?: React.ReactNode;
  iconClassName?: string;
  children?: React.ReactNode;
}

const PageHeader: React.FC<PageHeaderProps> = ({ 
  icon: Icon, 
  title, 
  description, 
  subtitle,
  iconClassName,
  children 
}) => {
  return (
    <div className="w-full mb-4">
      <div className="flex items-center gap-3 mb-1">
        <Icon className={iconClassName || "w-7 h-7 text-[#001d6e]"} style={title === "Load Operations" ? {fill: "#4d7eff"} : title === "Stock Sheets" ? {fill: "#22c55e"} : undefined} />
        <h2 className="text-2xl font-bold text-[#001d6e]">{title}</h2>
        {children && <div className="inline-flex ml-2">{children}</div>}
      </div>
      {subtitle && <div className="ml-10">{subtitle}</div>}
      {description && <p className="text-gray-600 ml-10 mt-1">{description}</p>}
    </div>
  );
};

export default PageHeader;