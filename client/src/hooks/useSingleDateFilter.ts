import { useState, useEffect, useRef } from 'react';

// Completely independent keys for each page's date filter storage
// This ensures no cross-page synchronization happens
const getStorageKeys = (pageId: string) => {
  return {
    dateFilterKey: `date-filter-${pageId}` // No shared base prefix to avoid any accidental sharing
  };
};

// Helper functions for storage - these can be called from anywhere
export const SingleDateFilterStorage = {
  // Save a date for a specific page
  saveDateFilter: (pageId: string, date: Date | null) => {
    const { dateFilterKey } = getStorageKeys(pageId);
    
    if (date) {
      try {
        // Stored as a plain "YYYY-MM-DD" day, not an ISO timestamp: an ISO string is a moment
        // in UTC, so the saved day shifted by one whenever it was read back in another timezone
        // (or after a DST change) — the filter then quietly pointed at the wrong day.
        const y = date.getFullYear();
        const m = String(date.getMonth() + 1).padStart(2, '0');
        const d = String(date.getDate()).padStart(2, '0');
        localStorage.setItem(dateFilterKey, `${y}-${m}-${d}`);
        return true;
      } catch (error) {
        console.error(`Error saving date filter for ${pageId}:`, error);
        return false;
      }
    } else {
      // Remove the date filter data
      localStorage.removeItem(dateFilterKey);
      return false;
    }
  },
  
  // Get the saved date for a page
  getSavedDateFilter: (pageId: string): Date | null => {
    const { dateFilterKey } = getStorageKeys(pageId);
    
    try {
      const savedFilterString = localStorage.getItem(dateFilterKey);

      if (savedFilterString) {
        // "YYYY-MM-DD" (current format) is built as a LOCAL date — `new Date("2026-09-15")` parses
        // as UTC midnight and comes back as the 14th in any timezone behind UTC. Older entries are
        // full ISO timestamps, which Date handles correctly on its own.
        const parts = /^(\d{4})-(\d{2})-(\d{2})$/.exec(savedFilterString);
        const date = parts
          ? new Date(Number(parts[1]), Number(parts[2]) - 1, Number(parts[3]))
          : new Date(savedFilterString);
        if (isNaN(date.getTime())) {
          localStorage.removeItem(dateFilterKey);
          return null;
        }
        date.setHours(0, 0, 0, 0);
        return date;
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
    const { dateFilterKey } = getStorageKeys(pageId);
    localStorage.removeItem(dateFilterKey);
  }
};

/**
 * Custom hook to manage saved single date filter persistence
 * @param pageId - Unique identifier for the page (e.g., 'load-operations', 'proforma', 'sales')
 * @param initialDate - Optional initial date to use if no saved filter exists
 * @returns Functions and state for managing date filter persistence
 */
export function useSingleDateFilter(pageId: string = 'default', initialDate?: Date) {
  const [savedDate, setSavedDate] = useState<Date | null>(null);
  const [isInitialized, setIsInitialized] = useState(false);
  // Keeping isLocked for backward compatibility, but it will always be false
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
  
  // initialDate is only a starting value, so it is read through a ref: a caller that builds it
  // inline (`new Date()`) hands over a different object on every render, and depending on it made
  // this effect re-run and reset the date the user had just picked.
  const initialDateRef = useRef(initialDate);
  initialDateRef.current = initialDate;

  // Load saved date filter on initial mount or when pageId changes
  useEffect(() => {
    const loadedDate = SingleDateFilterStorage.getSavedDateFilter(pageId);
    if (loadedDate) {
      setSavedDate(loadedDate);
    } else if (initialDateRef.current) {
      setSavedDate(initialDateRef.current);
    }

    setIsInitialized(true);
  }, [pageId]);

  // Save the current date filter
  const saveDateFilter = (date: Date | null) => {
    if (isUnmounted.current) return;
    
    const saved = SingleDateFilterStorage.saveDateFilter(pageIdRef.current, date);

    if (saved && date) {
      // A fresh object so React always sees a state change, pinned to local midnight.
      const freshDate = new Date(date.getFullYear(), date.getMonth(), date.getDate());
      setSavedDate(freshDate);
    } else {
      setSavedDate(null);
    }
  };

  // Clear the saved date filter
  const clearSavedDateFilter = () => {
    if (isUnmounted.current) return;
    
    SingleDateFilterStorage.clearDateFilter(pageIdRef.current);
    setSavedDate(null);
  };

  // Dummy function that does nothing, kept for backward compatibility
  const setLockedState = (_locked: boolean) => {
    // No-op function
    return;
  };

  return {
    savedDate,
    saveDateFilter,
    clearSavedDateFilter,
    setLocked: setLockedState,
    isLocked, // Always false
    isInitialized
  };
}