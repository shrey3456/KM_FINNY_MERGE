import { useState, useEffect, useRef } from "react";
import { format, addDays, subDays, parse } from "date-fns";
import { Button } from "@/components/ui/button";
import { Calendar } from "@/components/ui/calendar";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover";
import { CalendarIcon, XCircle } from "lucide-react";
import { cn } from "@/lib/utils";
import { useToast } from "@/hooks/use-toast";
import { useSingleDateFilter } from "@/hooks/useSingleDateFilter";
import { 
  DropdownMenu, 
  DropdownMenuContent, 
  DropdownMenuGroup, 
  DropdownMenuItem, 
  DropdownMenuTrigger 
} from "@/components/ui/dropdown-menu";

// Constants for localStorage keys
const STORED_DATE_KEY = 'kmtribe-single-date-filter';

// Define date formats
const DISPLAY_DATE_FORMAT = 'dd/MM/yyyy'; // Format for display to users
const API_DATE_FORMAT = 'yyyy-MM-dd';     // Format for API calls

interface SingleDateFilterProps {
  pageKey: string;
  onDateChange?: (date: Date | null) => void;
  selectedDate?: Date | null;
  className?: string;
  /** Extra classes merged onto the "Filter by date" / "Calendar" trigger buttons. */
  buttonClassName?: string;
  size?: "sm" | "md" | "lg";
  children?: React.ReactNode;
  isLocked?: boolean; // Kept for backward compatibility but not used
  onLockChange?: (locked: boolean) => void; // Kept for backward compatibility but not used
}

export function SingleDateFilter({
  pageKey,
  onDateChange,
  selectedDate,
  className,
  buttonClassName,
  size = "md",
  children,
  isLocked: externalIsLocked, // Kept but ignored
  onLockChange // Kept but ignored
}: SingleDateFilterProps) {
  const { toast } = useToast();
  const { savedDate: date, saveDateFilter: setDate, clearSavedDateFilter: clearFilter } = useSingleDateFilter(pageKey);
  const [isOpen, setIsOpen] = useState(false);
  const pushedSavedDateRef = useRef(false);
  
  // Same calendar day? Dates are compared by day, never by object identity or timestamp — two
  // Date objects for the same day are different objects, and one of them may carry a time.
  const sameDay = (a: Date | null | undefined, b: Date | null | undefined) => {
    if (!a || !b) return !a && !b;
    return a.getFullYear() === b.getFullYear() && a.getMonth() === b.getMonth() && a.getDate() === b.getDate();
  };

  // Hand the restored date to the page once it has actually been read from storage. This used to
  // run only on mount, where `date` was still null (storage is read in an effect of its own, one
  // render later) — so the button showed the saved date while the page's list was never filtered
  // by it, which is what "the date filter doesn't stick" looked like.
  useEffect(() => {
    if (pushedSavedDateRef.current || !date) return;
    pushedSavedDateRef.current = true;
    if (!sameDay(date, selectedDate)) onDateChange?.(date);
  }, [date]);

  // Keep the internal state in sync when the page drives the date itself. Guarded by day, so a
  // page that rebuilds its Date object on every render doesn't rewrite storage every render.
  useEffect(() => {
    if (selectedDate && !sameDay(selectedDate, date)) setDate(selectedDate);
  }, [selectedDate]);

  const handleDateSelect = (picked: Date | undefined) => {
    // react-day-picker reports undefined when the already-selected day is clicked again. Treat
    // that as "keep it" — clearing is the Clear button — instead of silently dropping the filter,
    // which made picking a date look like it hadn't worked at all.
    if (!picked) {
      setIsOpen(false);
      return;
    }
    const newDate = new Date(picked.getFullYear(), picked.getMonth(), picked.getDate());
    setDate(newDate);
    setIsOpen(false);
    onDateChange?.(newDate);
  };

  const setToday = () => {
    // Create today date at midnight to ensure proper date comparison
    const today = new Date();
    today.setHours(0, 0, 0, 0);
    
    console.log(`Setting today filter: ${today.toISOString()}`);
    setDate(today);
    
    if (onDateChange) {
      // Create a fresh copy to ensure React state updates
      const todayCopy = new Date(today.getTime());
      onDateChange(todayCopy);
    }
    
    setIsOpen(false);
  };

  const setYesterday = () => {
    // Create yesterday date at midnight to ensure proper date comparison
    const today = new Date();
    const yesterday = subDays(today, 1);
    yesterday.setHours(0, 0, 0, 0);
    
    console.log(`Setting yesterday filter: ${yesterday.toISOString()}`);
    setDate(yesterday);
    
    if (onDateChange) {
      // Create a fresh copy to ensure React state updates
      const yesterdayCopy = new Date(yesterday.getTime());
      onDateChange(yesterdayCopy);
    }
    
    setIsOpen(false);
  };

  const setTomorrow = () => {
    // Create tomorrow date at midnight to ensure proper date comparison
    const today = new Date();
    const tomorrow = addDays(today, 1);
    tomorrow.setHours(0, 0, 0, 0);
    
    console.log(`Setting tomorrow filter: ${tomorrow.toISOString()}`);
    setDate(tomorrow);
    
    if (onDateChange) {
      // Create a fresh copy to ensure React state updates
      const tomorrowCopy = new Date(tomorrow.getTime());
      onDateChange(tomorrowCopy);
    }
    
    setIsOpen(false);
  };

  const handleClearFilter = () => {
    clearFilter();
    pushedSavedDateRef.current = true;
    
    if (onDateChange) {
      onDateChange(null);
    }
    
    toast({
      title: "Filter cleared",
      description: "Date filter has been cleared.",
    });
  };

  return (
    <div className={cn("flex items-center space-x-2", className)}>
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <Button
            variant="outline"
            className={cn(
              "justify-start text-left font-normal",
              !date && "text-muted-foreground",
              buttonClassName,
            )}
          >
            <CalendarIcon className="mr-2 h-4 w-4" />
            {date ? (
              <>
                {format(date, DISPLAY_DATE_FORMAT)}
              </>
            ) : (
              <span>Filter by date</span>
            )}
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent className="w-56">
          <DropdownMenuGroup>
            <DropdownMenuItem onClick={setToday}>
              Today
            </DropdownMenuItem>
            <DropdownMenuItem onClick={setTomorrow}>
              Tomorrow
            </DropdownMenuItem>
            <DropdownMenuItem onClick={setYesterday}>
              Yesterday
            </DropdownMenuItem>
          </DropdownMenuGroup>
        </DropdownMenuContent>
      </DropdownMenu>
      
      <Popover open={isOpen} onOpenChange={setIsOpen}>
        <PopoverTrigger asChild>
          <Button
            variant="outline"
            className={cn(
              "justify-start text-left font-normal",
              !date && "text-muted-foreground",
              buttonClassName,
            )}
          >
            <span>Calendar</span>
          </Button>
        </PopoverTrigger>
        <PopoverContent className="w-auto p-0" align="start">
          <Calendar
            initialFocus
            mode="single"
            defaultMonth={date || undefined}
            selected={date || undefined}
            onSelect={handleDateSelect}
          />
        </PopoverContent>
      </Popover>
      
      <div className="flex items-center space-x-1">
        {/* Clear button - always show when date is set */}
        {date && (
          <Button variant="ghost" size="sm" onClick={handleClearFilter} className="p-1 h-8 sm:p-2">
            <XCircle className="h-3.5 w-3.5 sm:hidden" />
            <span className="hidden sm:inline">Clear</span>
          </Button>
        )}
        
        {/* Render children (like additional filters) directly next to the clear button */}
        {children}
      </div>
    </div>
  );
}