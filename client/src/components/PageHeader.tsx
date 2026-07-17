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
        <div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg bg-[#001d6e] text-white">
          <Icon className={iconClassName || "h-5 w-5"} />
        </div>
        <h2 className="text-2xl font-bold text-[#001d6e]">{title}</h2>
        {children && <div className="inline-flex ml-2">{children}</div>}
      </div>
      {/* ml-12 keeps subtitle/description flush with the title: badge (w-9) + gap-3 */}
      {subtitle && <div className="ml-12">{subtitle}</div>}
      {description && <p className="text-gray-600 ml-12 mt-1">{description}</p>}
    </div>
  );
};

export default PageHeader;