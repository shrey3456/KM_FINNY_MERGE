import { useState, useEffect } from 'react';

// Storage key prefix - appended with page name for persistence
const STORAGE_KEY_PREFIX = 'kmtribe-date-filter-';

/**
 * Singleton utility class to save and retrieve date filters
 */
export class SingleDateFilterStorage {
  /**
   * Save date filter for a specific page
   */
  static saveDateFilter(pageKey: string, date: Date | null) {
    try {
      const key = `${STORAGE_KEY_PREFIX}${pageKey}`;
      if (date) {
        localStorage.setItem(key, date.toISOString());
      } else {
        localStorage.removeItem(key);
      }
    } catch (error) {
      console.error('Failed to save date filter:', error);
    }
  }

  /**
   * Get saved date filter for a specific page
   */
  static getSavedDateFilter(pageKey: string): Date | null {
    try {
      const key = `${STORAGE_KEY_PREFIX}${pageKey}`;
      const savedDate = localStorage.getItem(key);
      
      if (savedDate) {
        return new Date(savedDate);
      }
    } catch (error) {
      console.error('Failed to load date filter:', error);
    }
    
    return null;
  }

  /**
   * Clear saved date filter for a specific page
   */
  static clearDateFilter(pageKey: string) {
    try {
      const key = `${STORAGE_KEY_PREFIX}${pageKey}`;
      localStorage.removeItem(key);
    } catch (error) {
      console.error('Failed to clear date filter:', error);
    }
  }
}

/**
 * Hook to handle date filter state and persistence
 */
export function useSingleDateFilter(pageKey: string) {
  const [savedDate, setSavedDate] = useState<Date | null>(null);
  const [isInitialized, setIsInitialized] = useState(false);

  // Load saved date on mount
  useEffect(() => {
    const loadSavedDate = () => {
      try {
        const date = SingleDateFilterStorage.getSavedDateFilter(pageKey);
        setSavedDate(date);
      } catch (error) {
        console.error('Error loading saved date:', error);
      } finally {
        setIsInitialized(true);
      }
    };

    loadSavedDate();
  }, [pageKey]);

  // Save date filter
  const saveDateFilter = (date: Date | null) => {
    SingleDateFilterStorage.saveDateFilter(pageKey, date);
    setSavedDate(date);
  };

  // Clear saved date filter
  const clearSavedDateFilter = () => {
    SingleDateFilterStorage.clearDateFilter(pageKey);
    setSavedDate(null);
  };

  return { 
    savedDate, 
    isInitialized,
    saveDateFilter,
    clearSavedDateFilter
  };
}