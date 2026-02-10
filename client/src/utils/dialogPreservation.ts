/**
 * Dialog Preservation Utility
 * 
 * This utility helps keep dialogs open when performing operations 
 * that would otherwise cause them to close unexpectedly.
 */

import { useState, useEffect, useRef, useCallback } from 'react';

// Store open dialog IDs globally to persist across re-renders
// Support both number and string IDs for flexibility
const openDialogIds = new Set<number | string>();

// Keep track of which dialogs should stay open until manually closed
const persistentDialogIds = new Set<number | string>();

/**
 * Enhanced hook to preserve dialog state during operations
 * @param initialOperationId - The initial operation ID
 * @returns Functions and state to manage dialog preservation
 */
export function useDialogPreservation(initialOperationId: number | string | null = null) {
  const [preservedOperationId, setPreservedOperationId] = useState<number | string | null>(initialOperationId);
  const timerRef = useRef<NodeJS.Timeout | null>(null);

  // On mount, check if we have a preserved operation ID to restore
  useEffect(() => {
    // If there's an initial operation ID, add it to the global set
    if (initialOperationId) {
      openDialogIds.add(initialOperationId);
      setPreservedOperationId(initialOperationId);
    }

    // On unmount, clear any timers and remove the operation ID from the global set
    return () => {
      if (timerRef.current) {
        clearTimeout(timerRef.current);
      }
      if (preservedOperationId) {
        openDialogIds.delete(preservedOperationId);
        persistentDialogIds.delete(preservedOperationId);
      }
    };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  /**
   * Keep a dialog open during an operation
   * @param operationId - The operation ID to preserve
   * @param durationMs - How long to maintain preservation (default: 2000ms)
   * @param persistent - If true, dialog stays open until manually closed
   */
  const preserveDialog = (operationId: number | string, durationMs: number = 2000, persistent: boolean = false) => {
    console.log(`[DialogPreservation] Preserving dialog for operation ${operationId}${persistent ? ' (persistent)' : ''}`);
    
    // Add to global set
    openDialogIds.add(operationId);
    setPreservedOperationId(operationId);
    
    // If dialog should be persistent, add to persistent set
    if (persistent) {
      persistentDialogIds.add(operationId);
    }
    
    // For non-persistent dialogs, use the timer
    if (!persistent) {
      // Clear any existing timer
      if (timerRef.current) {
        clearTimeout(timerRef.current);
      }
      
      // Set a timer to release the preservation after the duration
      timerRef.current = setTimeout(() => {
        console.log(`[DialogPreservation] Timer completed for operation ${operationId}`);
        // Don't actually remove from global set - only update local state
        // This allows other components to still check if the dialog should be open
        setPreservedOperationId(null);
      }, durationMs);
    }
  };

  /**
   * Check if a dialog should be kept open
   * @param operationId - The operation ID to check
   * @returns True if the dialog should be kept open
   */
  const shouldKeepDialogOpen = (operationId: number | string): boolean => {
    return openDialogIds.has(operationId) || persistentDialogIds.has(operationId);
  };

  /**
   * Release dialog preservation immediately
   * @param operationId - The operation ID to release
   */
  const releaseDialog = (operationId: number | string) => {
    console.log(`[DialogPreservation] Releasing dialog for operation ${operationId}`);
    openDialogIds.delete(operationId);
    persistentDialogIds.delete(operationId);
    setPreservedOperationId(null);
    
    if (timerRef.current) {
      clearTimeout(timerRef.current);
      timerRef.current = null;
    }
  };

  /**
   * Creates a callback that handles dialog open state
   * @param setOpen - State setter function for dialog open state
   * @param operationId - The operation ID
   * @returns A function to handle dialog open state changes
   */
  const createDialogOpenHandler = useCallback(
    (setOpen: (open: boolean) => void, operationId: number | string) => {
      return (open: boolean) => {
        if (!open) {
          // Only close if not in persistent mode
          if (!persistentDialogIds.has(operationId)) {
            setOpen(false);
            releaseDialog(operationId);
          }
        } else {
          setOpen(true);
          // When opening, add to the persistent list
          preserveDialog(operationId, 0, true);
        }
      };
    },
    [/* No dependencies needed */]
  );

  return {
    preservedOperationId,
    preserveDialog,
    shouldKeepDialogOpen,
    releaseDialog,
    createDialogOpenHandler
  };
}

/**
 * Restore a DOM element's visibility in the next tick
 * @param elementId - The ID of the element to restore
 */
export function restoreElementVisibility(elementId: string) {
  setTimeout(() => {
    const element = document.getElementById(elementId);
    if (element && element.classList.contains('hidden')) {
      console.log(`[DialogPreservation] Restoring visibility of element ${elementId}`);
      element.classList.remove('hidden');
    }
  }, 0);
}