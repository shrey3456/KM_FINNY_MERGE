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
        // Store with date objects converted to ISO strings for better serialization
        const newDate = new Date(date);
        
        // Ensure we have valid date by forcing midnight time
        newDate.setHours(0, 0, 0, 0);
        
        const saveData = newDate.toISOString();
        
        localStorage.setItem(dateFilterKey, saveData);
        console.log(`Date filter for ${pageId} saved:`, date, "Storage data:", saveData);
        return true;
      } catch (error) {
        console.error(`Error saving date filter for ${pageId}:`, error);
        return false;
      }
    } else {
      // Remove the date filter data
      localStorage.removeItem(dateFilterKey);
      console.log(`Date filter for ${pageId} cleared`);
      return false;
    }
  },
  
  // Get the saved date for a page
  getSavedDateFilter: (pageId: string): Date | null => {
    const { dateFilterKey } = getStorageKeys(pageId);
    
    try {
      const savedFilterString = localStorage.getItem(dateFilterKey);
      console.log(`Getting saved date filter for ${pageId}:`, savedFilterString);
      
      if (savedFilterString) {
        // Convert string date back to Date object with clean date value
        const date = new Date(savedFilterString);
        
        // Set time to midnight to ensure consistent behavior
        date.setHours(0, 0, 0, 0);
        
        console.log(`Retrieved date filter for ${pageId}:`, date);
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
    console.log(`Date filter for ${pageId} cleared`);
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
  
  // Load saved date filter on initial mount or when pageId changes
  useEffect(() => {
    // Check if there's a saved filter
    const loadedDate = SingleDateFilterStorage.getSavedDateFilter(pageId);
    if (loadedDate) {
      console.log(`Found saved filter for ${pageId}:`, loadedDate);
      setSavedDate(loadedDate);
    } else if (initialDate) {
      // Use initial date if provided and no saved filter exists
      setSavedDate(initialDate);
    }
    
    setIsInitialized(true);
  }, [pageId, initialDate]);

  // Save the current date filter
  const saveDateFilter = (date: Date | null) => {
    if (isUnmounted.current) return;
    
    console.log(`Attempting to save date filter for ${pageIdRef.current}:`, date);
    const saved = SingleDateFilterStorage.saveDateFilter(pageIdRef.current, date);
    
    if (saved && date) {
      // Create a fresh copy of the date object to ensure React state updates
      const freshDate = new Date(date.getTime());
      freshDate.setHours(0, 0, 0, 0);
      console.log(`Successfully saved date filter for ${pageIdRef.current}:`, freshDate);
      setSavedDate(freshDate);
    } else {
      console.log(`Cleared date filter for ${pageIdRef.current}`);
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