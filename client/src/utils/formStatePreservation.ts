/**
 * Utility to preserve form state when performing operations
 * like adding items, saving changes, or after notifications
 */

// Store the currently selected operation by page
const selectedOperations: Record<string, any> = {
  'indore': null,
  'valsad': null,
  'main': null
};

// Store the currently open dialog content
const viewDetailsContent: Record<string, any> = {
  'indore': null,
  'valsad': null, 
  'main': null
};

/**
 * Save the current operation and view state for a page
 * to prevent form closing during operations
 * 
 * @param page The page identifier ('indore', 'valsad', or 'main')
 * @param operation The selected operation
 * @param viewDetails The view details content
 */
export function saveFormState(page: string, operation: any, viewDetails: any) {
  if (!page || !operation) return;
  
  selectedOperations[page] = operation;
  if (viewDetails) {
    viewDetailsContent[page] = viewDetails;
  }
}

/**
 * Get the saved operation for a page
 * 
 * @param page The page identifier
 * @returns The saved operation or null
 */
export function getSavedOperation(page: string) {
  return selectedOperations[page] || null;
}

/**
 * Get the saved view details for a page
 * 
 * @param page The page identifier
 * @returns The saved view details or null
 */
export function getSavedViewDetails(page: string) {
  return viewDetailsContent[page] || null;
}

/**
 * Clear the saved form state for a page
 * 
 * @param page The page identifier
 */
export function clearSavedFormState(page: string) {
  selectedOperations[page] = null;
  viewDetailsContent[page] = null;
}

/**
 * Check if there is a saved form state for a page
 * 
 * @param page The page identifier
 * @returns True if there is a saved form state
 */
export function hasSavedFormState(page: string): boolean {
  return !!selectedOperations[page];
}

/**
 * Ensure dialog stays open when it's supposed to
 * 
 * @param operationId The operation ID
 */
export function ensureDialogOpen(operationId: number) {
  if (!operationId) return;
  
  // Make sure the view dialog remains open
  const viewDialogEl = document.getElementById(`view-dialog-${operationId}`);
  if (viewDialogEl && viewDialogEl.classList.contains('hidden')) {
    viewDialogEl.classList.remove('hidden');
  }
  
  // Make sure the search results stay visible if they were shown
  const searchResultsEl = document.getElementById(`search-results-${operationId}`);
  if (searchResultsEl && searchResultsEl.classList.contains('hidden')) {
    searchResultsEl.classList.remove('hidden');
  }
}