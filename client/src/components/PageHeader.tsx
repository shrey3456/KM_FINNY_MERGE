import React from 'react';
import { LucideIcon } from 'lucide-react';

interface PageHeaderProps {
  icon: LucideIcon;
  title: string;
  description?: string;
  subtitle?: React.ReactNode;
  iconClassName?: string;
  children?: React.ReactNode;
  /** Pushed to the far right of the title row. Separate from `children` (which sits inline just
      after the title) so a page can put controls opposite the title without that ml-auto also
      shoving whatever `children` it already passes. */
  actions?: React.ReactNode;
}

const PageHeader: React.FC<PageHeaderProps> = ({ 
  icon: Icon, 
  title, 
  description, 
  subtitle,
  iconClassName,
  children,
  actions
}) => {
  return (
    <div className="w-full mb-4">
      {/* Wraps only when `actions` is in play — a title row with controls opposite it has enough
          in it to overflow a phone, while every existing caller (title + optional inline children)
          keeps the exact single-line behaviour it had. */}
      <div className={`flex items-center gap-3 mb-1 ${actions ? "flex-wrap" : ""}`}>
        <div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg bg-[#001d6e] text-white">
          <Icon className={iconClassName || "h-5 w-5"} />
        </div>
        <h2 className="text-2xl font-bold text-[#001d6e]">{title}</h2>
        {children && <div className="inline-flex ml-2">{children}</div>}
        {actions && <div className="ml-auto flex flex-wrap items-center justify-end gap-2">{actions}</div>}
      </div>
      {/* ml-12 keeps subtitle/description flush with the title: badge (w-9) + gap-3 */}
      {subtitle && <div className="ml-12">{subtitle}</div>}
      {description && <p className="text-gray-600 ml-12 mt-1">{description}</p>}
    </div>
  );
};

export default PageHeader;