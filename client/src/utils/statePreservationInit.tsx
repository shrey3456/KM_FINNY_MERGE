/**
 * State preservation initialization module
 * Initializes all state preservation utilities for the application
 */

import { initializeAddItemToSlip } from "./addItemUtils";
import { initializeMobileDialogFix } from "./mobileDialogFix";
import { cleanupTableCache } from "./tableStatePreservation";

/**
 * Initialize all state preservation utilities
 * Call this at the root of the application
 */
export function initializeStatePreservation() {
  // Initialize enhanced addItemToSlip
  initializeAddItemToSlip();
  
  // Initialize mobile dialog fix
  initializeMobileDialogFix();
  
  // Set up periodic cleanup for cached operations to prevent memory leaks
  setInterval(() => {
    cleanupTableCache();
  }, 60 * 60 * 1000); // Run once per hour
  
  console.log("[State Preservation] Initialized all state preservation utilities");
}

/**
 * Helper function to ensure dialog elements stay open
 * This can be used outside of the standard utilities when needed
 * @param selector CSS selector for the dialog element
 */
export function ensureElementVisible(selector: string) {
  const element = document.querySelector(selector);
  if (element && element.classList.contains('hidden')) {
    element.classList.remove('hidden');
  }
}

/**
 * Utility to keep modal dialogs open during any callback operations
 * @param callback The callback function to execute
 * @param dialogId The ID of the dialog element to keep open
 */
export async function keepDialogOpenDuring<T>(
  callback: () => Promise<T>,
  dialogId: string
): Promise<T> {
  try {
    // Ensure dialog is open before executing
    ensureElementVisible(`#${dialogId}`);
    
    // Execute the callback
    const result = await callback();
    
    // Ensure dialog is still open after executing
    ensureElementVisible(`#${dialogId}`);
    
    return result;
  } catch (error) {
    // Ensure dialog is still open even if there's an error
    ensureElementVisible(`#${dialogId}`);
    throw error;
  }
}