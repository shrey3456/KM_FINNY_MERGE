import type { LucideIcon } from "lucide-react";
import type { ReactNode } from "react";
import { Search, X } from "lucide-react";
import { cn } from "@/lib/utils";

interface TableCardProps {
  icon: LucideIcon;
  title: string;
  /** Small caption under the title — typically a row count. */
  subtitle?: ReactNode;

  /** Omit both to hide the search box. */
  searchValue?: string;
  onSearchChange?: (value: string) => void;
  searchPlaceholder?: string;

  /** Filter controls rendered on their own row beneath the title/search. */
  filters?: ReactNode;

  /** The table itself. Pass a DataTable with className="space-y-0" and
   *  containerClassName="rounded-none border-0" so it sits flush. */
  children: ReactNode;

  className?: string;
}

/**
 * The Notion Inventory "Product Master" card: a bordered card whose header holds a
 * navy icon badge, title + count, a right-aligned search box, and an optional filter
 * row — with the table rendered flush beneath.
 */
export function TableCard({
  icon: Icon,
  title,
  subtitle,
  searchValue,
  onSearchChange,
  searchPlaceholder = "Search…",
  filters,
  children,
  className,
}: TableCardProps) {
  const showSearch = onSearchChange !== undefined;

  return (
    <div className={cn("rounded-xl border border-gray-200 bg-white shadow-sm overflow-hidden", className)}>
      <div className="border-b border-gray-200 bg-white px-3 py-3 sm:px-5 sm:py-3.5">
        <div className="flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
          <div className="flex items-center gap-3">
            <div className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg bg-[#001d6e] text-white sm:h-9 sm:w-9">
              <Icon className="h-4 w-4 sm:h-5 sm:w-5" />
            </div>
            <div className="min-w-0">
              <div className="text-lg font-bold tracking-tight text-gray-900 sm:text-xl">{title}</div>
              {subtitle && (
                <div className="mt-0.5 text-xs leading-none text-gray-400">{subtitle}</div>
              )}
            </div>
          </div>

          {showSearch && (
            <div className="relative w-full sm:w-auto sm:shrink-0">
              <Search className="pointer-events-none absolute left-2.5 top-1.5 h-3.5 w-3.5 text-gray-400" />
              <input
                value={searchValue ?? ""}
                onChange={(e) => onSearchChange?.(e.target.value)}
                placeholder={searchPlaceholder}
                className="h-7 w-full rounded-md border border-gray-200 bg-gray-50 pl-7 pr-6 text-xs text-gray-700 placeholder:text-gray-400 focus:bg-white focus:outline-none focus:ring-1 focus:ring-[#001d6e]/30 sm:w-64"
              />
              {searchValue && (
                <button
                  type="button"
                  onClick={() => onSearchChange?.("")}
                  className="absolute right-2 top-1.5 text-gray-400 hover:text-gray-600"
                >
                  <X className="h-3.5 w-3.5" />
                </button>
              )}
            </div>
          )}
        </div>

        {filters && <div className="mt-3 flex flex-wrap items-center gap-2">{filters}</div>}
      </div>

      {children}
    </div>
  );
}
