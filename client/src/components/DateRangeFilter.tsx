import { useState, useEffect } from "react";
import { DateRange } from "react-day-picker";
import { format } from "date-fns";
import { Button } from "@/components/ui/button";
import { Calendar } from "@/components/ui/calendar";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover";
import { CalendarIcon, XCircle, LockIcon, UnlockIcon } from "lucide-react";
import { cn } from "@/lib/utils";
import { useToast } from "@/hooks/use-toast";

// Constants for localStorage keys
const STORED_DATE_FROM_KEY = 'kmtribe-date-filter-from';
const STORED_DATE_TO_KEY = 'kmtribe-date-filter-to';
const STORED_DATE_LOCKED_KEY = 'kmtribe-date-filter-locked';

interface DateRangeFilterProps {
  onDateRangeChange?: (dateRange: DateRange | undefined) => void;
  startDate?: Date | null;
  endDate?: Date | null;
  onStartDateChange?: (date: Date | null) => void;
  onEndDateChange?: (date: Date | null) => void;
  className?: string;
  size?: "sm" | "md" | "lg";
  children?: React.ReactNode; // Added to allow additional components to be passed
  isLocked?: boolean; // Added to support page-specific lock state
  onLockChange?: (locked: boolean) => void; // Added to notify parent about lock state changes
  hideLockButton?: boolean; // Added to optionally hide the lock/unlock button
}

export function DateRangeFilter({ 
  onDateRangeChange, 
  startDate, 
  endDate, 
  onStartDateChange, 
  onEndDateChange, 
  className,
  size = "md",
  children,
  isLocked: externalIsLocked,
  onLockChange,
  hideLockButton = false
}: DateRangeFilterProps) {
  const { toast } = useToast();

  // Initialize state from props (if provided) or localStorage
  const initializeFromStorage = (): {
    initialDate: DateRange | undefined;
    initialLocked: boolean;
  } => {
    // If external lock state is provided, prioritize it
    if (typeof externalIsLocked !== 'undefined') {
      return {
        initialDate: (startDate && endDate) ? { from: startDate, to: endDate } : undefined,
        initialLocked: externalIsLocked
      };
    }
    
    try {
      // Check if we have stored date values
      const storedFromStr = localStorage.getItem(STORED_DATE_FROM_KEY);
      const storedToStr = localStorage.getItem(STORED_DATE_TO_KEY);
      const storedLocked = localStorage.getItem(STORED_DATE_LOCKED_KEY);
      
      if (storedFromStr) {
        const from = new Date(storedFromStr);
        const to = storedToStr ? new Date(storedToStr) : undefined;
        
        return {
          initialDate: { from, to },
          initialLocked: storedLocked === 'true'
        };
      }
    } catch (error) {
      console.error('Error reading date filter from localStorage:', error);
    }
    
    // Fall back to props if no stored values
    return {
      initialDate: (startDate && endDate) ? { from: startDate, to: endDate } : undefined,
      initialLocked: false
    };
  };
  
  const { initialDate, initialLocked } = initializeFromStorage();
  
  // State variables for the component
  const [date, setDate] = useState<DateRange | undefined>(initialDate);
  const [isOpen, setIsOpen] = useState(false);
  const [internalIsLocked, setInternalIsLocked] = useState(initialLocked);
  
  // Use the external isLocked prop if provided, otherwise use internal state
  const isLocked = typeof externalIsLocked !== 'undefined' ? externalIsLocked : internalIsLocked;

  // Effect to store date and locked state in localStorage when they change
  useEffect(() => {
    if (date?.from) {
      localStorage.setItem(STORED_DATE_FROM_KEY, date.from.toISOString());
      if (date.to) {
        localStorage.setItem(STORED_DATE_TO_KEY, date.to.toISOString());
      } else {
        localStorage.removeItem(STORED_DATE_TO_KEY);
      }
    } else {
      localStorage.removeItem(STORED_DATE_FROM_KEY);
      localStorage.removeItem(STORED_DATE_TO_KEY);
    }
    
    localStorage.setItem(STORED_DATE_LOCKED_KEY, isLocked.toString());
  }, [date, isLocked]);
  
  // Initialize the parent component with our persisted date on mount
  useEffect(() => {
    if (date?.from) {
      // Apply the stored filter to parent component
      if (onStartDateChange && onEndDateChange) {
        onStartDateChange(date.from);
        onEndDateChange(date.to || null);
      } else if (onDateRangeChange) {
        onDateRangeChange(date);
      }
    }
  }, []);
  
  // Keep the internal state in sync with external state when using direct date props
  useEffect(() => {
    // Only update if not locked and props have changed
    if (!isLocked && (startDate || endDate)) {
      setDate({
        from: startDate || undefined,
        to: endDate || undefined
      });
    }
  }, [startDate, endDate, isLocked]);

  const handleDateSelect = (selectedDate: DateRange | undefined) => {
    // Don't update if filter is locked
    if (isLocked) {
      toast({
        title: "Filter is locked",
        description: "Unlock the filter before changing dates",
        variant: "destructive",
      });
      setIsOpen(false);
      return;
    }
    
    setDate(selectedDate);
    
    if (selectedDate?.from && selectedDate?.to) {
      setIsOpen(false);
      
      // If using the new API with separate start/end date handlers
      if (onStartDateChange && onEndDateChange) {
        onStartDateChange(selectedDate.from);
        onEndDateChange(selectedDate.to);
      } 
      // If using the legacy API with combined date range handler
      else if (onDateRangeChange) {
        onDateRangeChange(selectedDate);
      }
    }
  };

  const clearFilter = () => {
    // Don't clear if locked
    if (isLocked) {
      toast({
        title: "Filter is locked",
        description: "Unlock the filter before clearing",
        variant: "destructive",
      });
      return;
    }
    
    setDate(undefined);
    
    // Clear from localStorage
    localStorage.removeItem(STORED_DATE_FROM_KEY);
    localStorage.removeItem(STORED_DATE_TO_KEY);
    
    // If using the new API with separate start/end date handlers
    if (onStartDateChange && onEndDateChange) {
      onStartDateChange(null);
      onEndDateChange(null);
    } 
    // If using the legacy API with combined date range handler
    else if (onDateRangeChange) {
      onDateRangeChange(undefined);
    }
    
    toast({
      title: "Filter cleared",
      description: "Date filter has been cleared.",
    });
  };
  
  const toggleFilterLock = () => {
    // Toggle lock state
    const newLockState = !isLocked;
    
    // Don't allow locking if no date is set
    if (newLockState && (!date?.from)) {
      toast({
        title: "Cannot lock empty filter",
        description: "Please select a date range before locking the filter.",
        variant: "destructive",
      });
      return;
    }
    
    // If we have an external lock callback, use it
    if (onLockChange) {
      console.log("DateRangeFilter: Calling external lock change handler with state:", newLockState);
      onLockChange(newLockState);
    } else {
      // Otherwise, use our internal state
      console.log("DateRangeFilter: Using internal lock state:", newLockState);
      setInternalIsLocked(newLockState);
    }
    
    // Save the lock state to local storage as well (redundancy)
    localStorage.setItem(STORED_DATE_LOCKED_KEY, newLockState.toString());
    
    toast({
      title: newLockState ? "Filter locked" : "Filter unlocked",
      description: newLockState 
        ? "The date filter is now locked. You cannot modify dates until unlocked." 
        : "The date filter is now unlocked. You can modify dates.",
    });
  };

  return (
    <div className={cn("flex items-center space-x-2", className)}>
      <Popover open={isOpen} onOpenChange={(open) => {
        // Don't allow opening if filter is locked
        if (isLocked && open) {
          toast({
            title: "Filter is locked",
            description: "Unlock the filter before changing dates",
            variant: "destructive",
          });
          return;
        }
        setIsOpen(open);
      }}>
        <PopoverTrigger asChild>
          <Button
            variant="outline"
            className={cn(
              "justify-start text-left font-normal",
              !date && "text-muted-foreground",
              isLocked && "bg-blue-50 border-[#001d6e] border-2"
            )}
          >
            <CalendarIcon className={cn("mr-2 h-4 w-4", isLocked && "text-[#001d6e]")} />
            {date?.from ? (
              date.to ? (
                <>
                  {format(date.from, "dd/MM/yyyy")} - {format(date.to, "dd/MM/yyyy")}
                </>
              ) : (
                format(date.from, "dd/MM/yyyy")
              )
            ) : (
              <span>Filter by date</span>
            )}
            {isLocked && <LockIcon className="ml-2 h-3 w-3 text-[#001d6e]" />}
          </Button>
        </PopoverTrigger>
        <PopoverContent className="w-auto p-0" align="start">
          <Calendar
            initialFocus
            mode="range"
            defaultMonth={date?.from}
            selected={date}
            onSelect={handleDateSelect}
            numberOfMonths={2}
          />
        </PopoverContent>
      </Popover>
      
      {/* Lock/Unlock toggle - only show if hideLockButton is false */}
      {!hideLockButton && (
        <Button 
          variant={isLocked ? "outline" : "ghost"} 
          size="sm" 
          onClick={toggleFilterLock}
          className={cn(
            "p-1 h-8 sm:p-2",
            isLocked && "border-[#001d6e]"
          )}
          title={isLocked ? "Unlock filter to allow changes" : "Lock filter to prevent changes"}
        >
          {isLocked ? (
            <>
              <UnlockIcon className="h-3.5 w-3.5 sm:h-4 sm:w-4 text-[#001d6e]" />
              <span className="hidden sm:inline ml-1 text-[#001d6e]">Unlock</span>
            </>
          ) : (
            <>
              <LockIcon className="h-3.5 w-3.5 sm:h-4 sm:w-4" />
              <span className="hidden sm:inline ml-1">Lock</span>
            </>
          )}
        </Button>
      )}
      
      {/* Clear button - always show when date is set and not locked */}
      {date && !isLocked && (
        <Button variant="ghost" size="sm" onClick={clearFilter} className="p-1 h-8 sm:p-2">
          <XCircle className="h-3.5 w-3.5 sm:hidden" />
          <span className="hidden sm:inline">Clear</span>
        </Button>
      )}
      
      {/* Render children (like PlantFilter) */}
      {children}
    </div>
  );
}