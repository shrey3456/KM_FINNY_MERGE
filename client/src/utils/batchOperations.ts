/**
 * Optimized batch operations utility
 * Provides a generic and efficient way to update multiple operation items at once
 * Used by both GJ Operations and MP Operations pages
 */

import { toast } from "@/hooks/use-toast";
import { apiRequest } from "@/lib/queryClient";
import { QueryClient } from "@tanstack/react-query";

// Broadcast channel for synchronizing across tabs/windows
interface BroadcastData {
  type: string;
  operationId: number;
  data: any[];
}

// Track saved items to avoid redundant saves
const trackChangedItems = new Set<number>();

interface BatchUpdateOptions {
  operationId: number;
  operationType: 'gj' | 'mp';
  items: any[];
  referenceNumber: string;
  queryClient: QueryClient;
  onSuccess?: () => void;
  broadcastChannel?: BroadcastChannel | null;
}

/**
 * Optimized batch update function for both operation types
 * This combines the best optimizations from both operations pages
 */
export const batchUpdateItems = async ({
  operationId,
  operationType,
  items,
  referenceNumber,
  queryClient,
  onSuccess,
  broadcastChannel
}: BatchUpdateOptions) => {
  // Performance measurement
  const startTime = performance.now();
  console.log(`[BatchUpdate] Starting save operation for ${operationType} operation ID: ${operationId} at ${new Date().toISOString()}`);

  try {
    if (!items || items.length === 0) {
      console.warn(`[BatchUpdate] No items provided for ${operationType} operation ${operationId}`);
      toast({
        title: "Warning",
        description: "No items found to update for this operation",
      });
      return;
    }

    // Get newly added items from localStorage 
    const newItemsKey = `${operationType}-proforma-new-items-${referenceNumber.trim()}`;
    let newlyAddedItems: number[] = [];
    try {
      const storedNewItems = localStorage.getItem(newItemsKey);
      if (storedNewItems) {
        newlyAddedItems = JSON.parse(storedNewItems);
        console.log(`[BatchUpdate] Loaded newly added ${operationType} items: ${newlyAddedItems.length} items`);
      }
    } catch (err) {
      console.error(`[BatchUpdate] Error loading newly added ${operationType} items list:`, err);
    }

    // Track only items that have actually changed
    const changedItems = items.filter(item => {
      // Always update newly added items
      if (newlyAddedItems.includes(item.id)) {
        return true;
      }

      // Check if this item was previously tracked as changed
      if (trackChangedItems.has(item.id)) {
        return true;
      }

      // Otherwise, don't include this item in the batch update
      return false;
    });

    console.log(`[BatchUpdate] Filtered down to ${changedItems.length} changed items out of ${items.length} total items`);
    
    if (changedItems.length === 0) {
      console.log("[BatchUpdate] No changes detected, skipping save operation");
      toast({
        title: "Info",
        description: "No changes detected to save",
      });
      return;
    }

    // Build batch update payload
    const batchUpdates = changedItems.map((item) => {
      // Check if this is a newly added item
      const isNewlyAdded = newlyAddedItems.includes(item.id);
      
      if (isNewlyAdded) {
        // For newly added items, set originalQuantity to 0
        console.log(`[BatchUpdate] Setting originalQuantity to 0 for newly added ${operationType} item ${item.id}`);
        return {
          id: item.id,
          loaded: item.loaded || false,
          quantity: item.quantity || 0,
          loadedQuantity: item.loadedQuantity || 0,
          originalQuantity: 0
        };
      } else {
        // For regular items, don't update originalQuantity
        return {
          id: item.id,
          loaded: item.loaded || false,
          quantity: item.quantity || 0,
          loadedQuantity: item.loadedQuantity || 0
        };
      }
    });
    
    console.log(`[BatchUpdate] Sending ${batchUpdates.length} items for batch update`);

    // Use the appropriate API endpoint based on operation type
    const endpoint = operationType === 'gj' 
      ? '/api/proforma-slip-items/batch-update'
      : '/api/mp-operation-items/batch-update';
    
    // Make the batch update API call
    const response = await apiRequest('POST', endpoint, batchUpdates);
    
    if (!response.ok) {
      const errorText = await response.text();
      throw new Error(`Failed to update items: ${response.status} ${response.statusText} - ${errorText}`);
    }
    
    const result = await response.json();
    console.log(`[BatchUpdate] Successfully updated ${batchUpdates.length} items for ${operationType} operation #${referenceNumber}`);
    
    // Invalidate the relevant query cache to ensure all users/views get fresh data
    const operationsEndpoint = operationType === 'gj' ? '/api/proforma-slips' : '/api/mp-operations';
    const itemsEndpoint = operationType === 'gj'
      ? `/api/proforma-slips/${operationId}/items` 
      : `/api/mp-operations/${operationId}/items`;
    
    queryClient.invalidateQueries({ queryKey: [operationsEndpoint] });
    queryClient.invalidateQueries({ queryKey: [itemsEndpoint] });
    
    // Clear the changed items tracking for these items
    batchUpdates.forEach(item => {
      trackChangedItems.delete(item.id);
    });
    
    // Broadcast the updates to other tabs/devices via BroadcastChannel
    if (broadcastChannel && batchUpdates.length > 0) {
      broadcastChannel.postMessage({
        type: 'LOADED_STATUS_UPDATED',
        operationId: operationId,
        data: batchUpdates
      });
      console.log(`[BatchUpdate] Broadcasting ${batchUpdates.length} updates to other tabs/windows`);
    }
    
    const endTime = performance.now();
    const timeElapsed = (endTime - startTime).toFixed(2);
    
    toast({
      title: "Items Updated",
      description: `Successfully updated ${batchUpdates.length} items in ${timeElapsed}ms`,
    });
    
    // Call the success callback if provided
    if (onSuccess) {
      onSuccess();
    }
  } catch (error) {
    console.error(`[BatchUpdate] Error in ${operationType} batch update:`, error);
    toast({
      title: "Error",
      description: "Failed to update items. Please try again.",
      variant: "destructive",
    });
  }
};

/**
 * Mark an item as changed to be included in the next batch update
 */
export const markItemChanged = (itemId: number) => {
  trackChangedItems.add(itemId);
};

/**
 * Track changes to a specific field on an item
 */
export const trackItemFieldChange = (itemId: number, field: string, value: any) => {
  console.log(`[BatchUpdate] Tracking change to item ${itemId}, field: ${field}, value:`, value);
  markItemChanged(itemId);
};

/**
 * Create a broadcast channel for syncing changes across tabs
 */
export const createBroadcastChannel = (channelName: string): BroadcastChannel | null => {
  if (typeof BroadcastChannel === 'undefined') {
    console.warn('BroadcastChannel not supported in this browser');
    return null;
  }
  
  try {
    return new BroadcastChannel(channelName);
  } catch (error) {
    console.error('Error creating BroadcastChannel:', error);
    return null;
  }
};