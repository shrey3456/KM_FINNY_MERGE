/**
 * Utility to ensure extraQuantity is properly calculated, saved, and retrieved
 * This helps ensure extraQuantity consistently shows the correct value
 */

import { apiRequest } from "@/lib/queryClient";
import { toast } from "@/hooks/use-toast";

/**
 * Save the extraQuantity field directly to ensure it's persisted
 * @param itemId The ID of the item to update
 * @param newQuantity The new quantity value
 * @param originalQuantity The original quantity value
 * @param extraQuantity The extra quantity value (calculated if not provided)
 */
export async function saveExtraQuantity(
  itemId: number,
  newQuantity: number,
  originalQuantity: number | null | undefined,
  extraQuantity?: number,
  loadedStatus?: boolean,
  loadedQuantity?: number
): Promise<boolean> {
  try {
    // Use the provided extra quantity if available, otherwise calculate it
    const origQty = originalQuantity || 0;
    const extraQty = extraQuantity !== undefined ? 
      extraQuantity : 
      (newQuantity > origQty ? newQuantity - origQty : 0);
    
    // Get current item data to check loaded status if not provided
    let isItemLoaded = loadedStatus;
    let currentLoadedQty = loadedQuantity;
    
    if (isItemLoaded === undefined || currentLoadedQty === undefined) {
      try {
        // Attempt to fetch current item data if loaded status wasn't provided
        const response = await apiRequest("GET", `/api/loading-operation-items/${itemId}`);
        const currentItem = await response.json();
        
        // Use the current loaded status if not provided
        isItemLoaded = loadedStatus !== undefined ? loadedStatus : (currentItem.loaded || false);
        
        // Use the current loadedQuantity as a fallback
        currentLoadedQty = loadedQuantity !== undefined ? loadedQuantity : (currentItem.loadedQuantity || 0);
      } catch (fetchError) {
        console.warn(`Could not fetch current item data for ${itemId}, proceeding with available data`);
        // Default to false and 0 if we can't get current data
        isItemLoaded = loadedStatus || false;
        currentLoadedQty = loadedQuantity || 0;
      }
    }
    
    // If item is loaded, loadedQuantity should match newQuantity
    // If item is not loaded, PRESERVE current loadedQuantity value rather than setting to 0
    // This allows the loadedQuantity to be modified even when item is not yet marked as loaded
    const updatedLoadedQty = isItemLoaded ? newQuantity : currentLoadedQty;
    
    console.log(`Saving extraQuantity=${extraQty} for item ${itemId}: quantity=${newQuantity}, originalQuantity=${origQty}, loadedQuantity=${updatedLoadedQty}`);
    
    // Send a direct API request to update the item with the new quantity and extraQuantity
    // CRITICAL FIX: Always include all quantity fields to ensure consistency
    await apiRequest("PATCH", `/api/loading-operation-items/${itemId}`, {
      quantity: newQuantity,
      extraQuantity: extraQty,
      // Always include originalQuantity in updates
      originalQuantity: origQty,
      // Always include loadedQuantity based on loaded status
      loadedQuantity: updatedLoadedQty,
      // Only include loaded status if it's explicitly provided
      ...(loadedStatus !== undefined && { loaded: loadedStatus })
    });
    
    console.log(`Successfully saved extraQuantity and loadedQuantity to server for item ${itemId}`);
    return true;
  } catch (error) {
    console.error('Error saving extraQuantity to server:', error);
    // We don't show an error toast here to avoid being disruptive during quantity changes
    return false;
  }
}

/**
 * Update an item's loaded status while preserving its extraQuantity
 * @param itemId The ID of the item to update
 * @param isLoaded Whether the item should be marked as loaded
 * @param quantity The current quantity of the item
 * @param originalQuantity The original proforma quantity
 * @param extraQuantity The extra quantity beyond proforma
 */
export async function updateLoadedStatus(
  itemId: number,
  isLoaded: boolean,
  quantity: number,
  originalQuantity: number | null | undefined,
  extraQuantity: number | null | undefined
): Promise<boolean> {
  try {
    const origQty = originalQuantity || 0;
    // Ensure we preserve the extraQuantity when toggling loaded status
    // This prevents extraQuantity from being reset to zero
    const extraQty = extraQuantity !== undefined && extraQuantity !== null ? 
      extraQuantity : 
      (quantity > origQty ? quantity - origQty : 0);
    
    console.log(`Updating loaded status=${isLoaded} for item ${itemId}, preserving extraQuantity=${extraQty}`);
    
    // Get current loadedQuantity to preserve it
    let loadedQuantity = quantity;
    try {
      const response = await apiRequest("GET", `/api/loading-operation-items/${itemId}`);
      const currentItem = await response.json();
      // If toggling to loaded, use quantity; otherwise preserve the current loadedQuantity
      loadedQuantity = isLoaded ? quantity : (currentItem.loadedQuantity || quantity);
    } catch (error) {
      console.warn(`Could not fetch current loadedQuantity for item ${itemId}, using quantity value`);
    }

    // Send the update with explicit extraQuantity and loadedQuantity to ensure they're preserved
    // CRITICAL FIX: Always include all fields together to avoid inconsistencies
    await apiRequest("PATCH", `/api/loading-operation-items/${itemId}`, {
      loaded: isLoaded,
      quantity: quantity,
      extraQuantity: extraQty,
      originalQuantity: origQty,
      // If item is being marked as loaded, set loadedQuantity to quantity
      // If item is being marked as unloaded, preserve the current loadedQuantity value
      loadedQuantity: loadedQuantity
    });
    
    console.log(`Successfully updated loaded status for item ${itemId} while preserving extraQuantity=${extraQty}`);
    return true;
  } catch (error) {
    console.error('Error updating loaded status:', error);
    return false;
  }
}

/**
 * Update item in the mobile view, ensuring extraQuantity is saved properly
 * @param itemId The ID of the item to update
 * @param newQuantity The new quantity value
 * @param originalQuantity The original quantity value
 * @param isNewlyAddedItem Whether this is a newly added item
 */
export async function updateItemWithExtraQuantity(
  itemId: number,
  newQuantity: number,
  originalQuantity: number | null | undefined,
  isNewlyAddedItem: boolean = false
): Promise<void> {
  // For newly added items, originalQuantity should always be 0
  const origQty = isNewlyAddedItem ? 0 : (originalQuantity || 0);
  
  // For newly added items, extraQuantity equals the full quantity
  // For existing items, extraQuantity is the difference between new and original
  const extraQty = isNewlyAddedItem ? 
    newQuantity : 
    (newQuantity > origQty ? newQuantity - origQty : 0);
  
  try {
    // First get current item data to check loaded status
    let isItemLoaded = false;
    let currentLoadedQty = 0;
    
    try {
      // Attempt to fetch current item data
      const response = await apiRequest("GET", `/api/loading-operation-items/${itemId}`);
      const currentItem = await response.json();
      
      // Get current loaded status and loadedQuantity
      isItemLoaded = currentItem.loaded || false;
      currentLoadedQty = currentItem.loadedQuantity || 0;
      
      console.log(`Fetched current item ${itemId} status: loaded=${isItemLoaded}, loadedQuantity=${currentLoadedQty}`);
    } catch (fetchError) {
      console.warn(`Could not fetch current item data for ${itemId}, proceeding with defaults`);
    }
    
    // CRITICAL: For loaded items, ALWAYS sync loadedQuantity with quantity
    // If item is loaded, ALWAYS set loadedQuantity to equal the new quantity value
    // If item is not loaded, preserve the existing loadedQuantity
    const updatedLoadedQty = isItemLoaded ? newQuantity : currentLoadedQty;
    
    console.log(`Setting loadedQuantity for item ${itemId} to ${updatedLoadedQty} (isLoaded=${isItemLoaded})`);
    
    // First, directly update the server with the correct loadedQuantity for loaded items
    if (isItemLoaded) {
      try {
        // For loaded items, ensure loadedQuantity exactly matches quantity with a separate call
        // CRITICAL FIX: We need to explicitly sync both loadedQuantity and quantity
        await apiRequest("PATCH", `/api/loading-operation-items/${itemId}`, {
          loadedQuantity: newQuantity,
          quantity: newQuantity,
          extraQuantity: extraQty, // Also include extraQuantity in the first call
          originalQuantity: origQty // Also include originalQuantity in the first call
        });
        console.log(`Force-synchronized loadedQuantity with quantity (${newQuantity}) for loaded item ${itemId}`);
      } catch (syncError) {
        console.warn(`Failed to force-sync loadedQuantity for item ${itemId}:`, syncError);
      }
    }
    
    // Now proceed with the normal update including extraQuantity calculation
    await saveExtraQuantity(itemId, newQuantity, origQty, extraQty, isItemLoaded, updatedLoadedQty);
  } catch (error) {
    // If direct saving fails, we'll rely on the batch save
    console.error("Error directly updating extraQuantity:", error);
  }
}