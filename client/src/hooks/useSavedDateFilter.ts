import { useState, useEffect, useRef } from 'react';
import { DateRange } from 'react-day-picker';

// Base keys for storing date filter in localStorage
const BASE_DATE_FILTER_KEY = 'km-tribe-saved-date-filter';
const BASE_FILTER_LOCKED_KEY = 'km-tribe-date-filter-locked';

// Utility functions for direct localStorage access
const getStorageKeys = (pageId: string) => {
  return {
    dateFilterKey: `${BASE_DATE_FILTER_KEY}-${pageId}`,
    lockedKey: `${BASE_FILTER_LOCKED_KEY}-${pageId}`
  };
};

// Helper functions for storage - these can be called from anywhere
export const DateFilterStorage = {
  // Save a date range for a specific page
  saveDateFilter: (pageId: string, dateRange: DateRange | undefined) => {
    const { dateFilterKey } = getStorageKeys(pageId);
    
    if (dateRange?.from) {
      try {
        // Store with date objects converted to ISO strings for better serialization
        const fromDate = new Date(dateRange.from);
        const toDate = dateRange.to ? new Date(dateRange.to) : null;
        
        // Ensure we have valid dates by forcing midnight time
        if (fromDate) {
          fromDate.setHours(0, 0, 0, 0);
        }
        if (toDate) {
          toDate.setHours(23, 59, 59, 999); // End of day for "to" date
        }
        
        const saveData = {
          from: fromDate.toISOString(),
          to: toDate ? toDate.toISOString() : null
        };
        
        localStorage.setItem(dateFilterKey, JSON.stringify(saveData));
        console.log(`Date filter for ${pageId} saved:`, dateRange, "Storage data:", saveData);
        return true;
      } catch (error) {
        console.error(`Error saving date filter for ${pageId}:`, error);
        return false;
      }
    } else {
      // Only remove the date filter data, not the lock status
      localStorage.removeItem(dateFilterKey);
      console.log(`Date filter for ${pageId} cleared`);
      return false;
    }
  },
  
  // Get the saved date range for a page
  getSavedDateFilter: (pageId: string): DateRange | null => {
    const { dateFilterKey } = getStorageKeys(pageId);
    
    try {
      const savedFilterString = localStorage.getItem(dateFilterKey);
      console.log(`Getting saved date filter for ${pageId}:`, savedFilterString);
      
      if (savedFilterString) {
        const parsed = JSON.parse(savedFilterString);
        
        if (!parsed.from) {
          console.warn(`Invalid date filter data for ${pageId} - missing 'from' value`);
          return null;
        }
        
        // Convert string dates back to Date objects with clean date values
        const fromDate = new Date(parsed.from);
        const toDate = parsed.to ? new Date(parsed.to) : undefined;
        
        // Set time to midnight for from date to ensure consistent behavior
        fromDate.setHours(0, 0, 0, 0);
        
        // Set time to end of day for to date
        if (toDate) {
          toDate.setHours(23, 59, 59, 999);
        }
        
        const result = {
          from: fromDate,
          to: toDate
        };
        
        console.log(`Retrieved date filter for ${pageId}:`, result);
        return result;
      }
    } catch (error) {
      console.error(`Error getting saved date filter for ${pageId}:`, error);
      // Clear potentially corrupted data
      localStorage.removeItem(dateFilterKey);
    }
    
    return null;
  },
  
  // Clear the saved date filter for a page
  clearDateFilter: (pageId: string) => {
    const { dateFilterKey, lockedKey } = getStorageKeys(pageId);
    localStorage.removeItem(dateFilterKey);
    localStorage.removeItem(lockedKey);
    console.log(`Date filter for ${pageId} cleared and unlocked`);
  },
  
  // Check if the date filter is locked for a page
  isLocked: (pageId: string): boolean => {
    const { lockedKey } = getStorageKeys(pageId);
    return localStorage.getItem(lockedKey) === 'true';
  },
  
  // Set the locked state for a page
  setLocked: (pageId: string, locked: boolean) => {
    const { lockedKey } = getStorageKeys(pageId);
    localStorage.setItem(lockedKey, locked ? 'true' : 'false');
    console.log(`Date filter for ${pageId} ${locked ? 'locked' : 'unlocked'}`);
  }
};

/**
 * Custom hook to manage saved date filter persistence
 * @param pageId - Unique identifier for the page (e.g., 'load-operations', 'proforma', 'sales')
 * @param initialDateRange - Optional initial date range to use if no saved filter exists
 * @returns Functions and state for managing date filter persistence
 */
export function useSavedDateFilter(pageId: string = 'default', initialDateRange?: DateRange) {
  const [savedDateFilter, setSavedDateFilter] = useState<DateRange | null>(null);
  const [isInitialized, setIsInitialized] = useState(false);
  const [isLocked, setIsLocked] = useState(false);
  const isUnmounted = useRef(false);
  const pageIdRef = useRef(pageId);
  
  // Update pageIdRef when pageId changes
  useEffect(() => {
    pageIdRef.current = pageId;
  }, [pageId]);
  
  // Setup cleanup function to avoid memory leaks and state updates on unmounted components
  useEffect(() => {
    return () => {
      isUnmounted.current = true;
    };
  }, []);
  
  // Load saved date filter on initial mount or when pageId changes
  useEffect(() => {
    // First check if there's a saved filter in localStorage
    const storedLocked = DateFilterStorage.isLocked(pageId);
    setIsLocked(storedLocked);
    
    if (storedLocked) {
      // If filter is locked, we must use the saved value
      const loadedFilter = DateFilterStorage.getSavedDateFilter(pageId);
      if (loadedFilter) {
        console.log(`Using locked filter for ${pageId}:`, loadedFilter);
        setSavedDateFilter(loadedFilter);
      } else {
        // If there's no saved filter but it's locked, this is an inconsistent state
        // We'll unlock it
        console.warn(`Filter for ${pageId} was locked but no saved filter found. Unlocking.`);
        DateFilterStorage.setLocked(pageId, false);
        setIsLocked(false);
        // Use initial filter if provided
        if (initialDateRange?.from) {
          setSavedDateFilter(initialDateRange);
          DateFilterStorage.saveDateFilter(pageId, initialDateRange);
        }
      }
    } else {
      // If not locked, check if there's a saved filter
      const loadedFilter = DateFilterStorage.getSavedDateFilter(pageId);
      if (loadedFilter) {
        console.log(`Found saved filter for ${pageId}:`, loadedFilter);
        setSavedDateFilter(loadedFilter);
      } else if (initialDateRange?.from) {
        // Use initial filter if provided and no saved filter exists
        setSavedDateFilter(initialDateRange);
      }
    }
    
    setIsInitialized(true);
  }, [pageId, initialDateRange]);

  // Save the current date filter
  const saveDateFilter = (dateRange: DateRange | undefined) => {
    if (isUnmounted.current) return;
    
    console.log(`Attempting to save date filter for ${pageIdRef.current}:`, dateRange);
    const saved = DateFilterStorage.saveDateFilter(pageIdRef.current, dateRange);
    
    if (saved && dateRange && dateRange.from instanceof Date) {
      // Create a fresh copy of the date objects to ensure React state updates
      const freshRange: DateRange = {
        from: new Date(dateRange.from.getTime()),
        to: dateRange.to ? new Date(dateRange.to.getTime()) : undefined
      };
      console.log(`Successfully saved date filter for ${pageIdRef.current}:`, freshRange);
      setSavedDateFilter(freshRange);
    } else {
      console.log(`Cleared date filter for ${pageIdRef.current}`);
      setSavedDateFilter(null);
    }
    // Don't automatically lock when saving
  };

  // Clear the saved date filter
  const clearSavedDateFilter = () => {
    if (isUnmounted.current) return;
    
    DateFilterStorage.clearDateFilter(pageIdRef.current);
    setSavedDateFilter(null);
    setIsLocked(false);
  };

  // Set the locked state
  const setLocked = (locked: boolean) => {
    if (isUnmounted.current) return;
    
    // If locking the filter, make sure we have a filter to lock
    if (locked && savedDateFilter?.from) {
      // Save the current filter to ensure it's stored
      DateFilterStorage.saveDateFilter(pageIdRef.current, savedDateFilter);
      console.log(`Locking filter for ${pageIdRef.current} with values:`, savedDateFilter);
    } else if (locked) {
      console.warn(`Attempted to lock filter for ${pageIdRef.current} but no date range available`);
    }
    
    DateFilterStorage.setLocked(pageIdRef.current, locked);
    setIsLocked(locked);
  };

  return {
    savedDateFilter,
    saveDateFilter,
    clearSavedDateFilter,
    setLocked,
    isLocked,
    isInitialized
  };
}