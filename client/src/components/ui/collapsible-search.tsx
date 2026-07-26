import { useEffect, useRef, useState } from "react";
import { Search, X } from "lucide-react";
import { cn } from "@/lib/utils";

// A search box that starts collapsed to just an icon button — click it to reveal the input.
// Collapses back on blur, but only if it's empty, so an active search stays visible.
export function CollapsibleSearch({
  value, onChange, placeholder = "Search…", className,
}: {
  value: string;
  onChange: (value: string) => void;
  placeholder?: string;
  className?: string;
}) {
  const [open, setOpen] = useState(!!value);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => { if (open) inputRef.current?.focus(); }, [open]);

  if (!open) {
    return (
      <button
        type="button"
        onClick={() => setOpen(true)}
        className={cn(
          "flex h-8 w-8 items-center justify-center rounded-md border border-gray-300 bg-white text-gray-400 hover:bg-gray-50 hover:text-gray-600",
          className,
        )}
        aria-label="Search"
      >
        <Search className="h-3.5 w-3.5" />
      </button>
    );
  }

  return (
    <div className={cn("relative", className)}>
      <Search className="pointer-events-none absolute left-2.5 top-2 h-3.5 w-3.5 text-gray-400" />
      <input
        ref={inputRef}
        value={value}
        onChange={(e) => onChange(e.target.value)}
        onBlur={() => { if (!value) setOpen(false); }}
        placeholder={placeholder}
        className="h-8 w-44 rounded-md border border-gray-300 bg-white pl-7 pr-6 text-xs text-gray-700 placeholder:text-gray-400 focus:outline-none focus:ring-1 focus:ring-[#001d6e]/30 sm:w-56"
      />
      {value && (
        <button
          type="button"
          onClick={() => onChange("")}
          className="absolute right-2 top-2 text-gray-400 hover:text-gray-600"
          aria-label="Clear search"
        >
          <X className="h-3.5 w-3.5" />
        </button>
      )}
    </div>
  );
}
