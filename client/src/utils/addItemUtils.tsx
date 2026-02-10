/**
 * Enhanced addItemToSlip utility to prevent forms from closing
 * when adding new items to proforma slips
 */

import { ensureDialogOpen } from "./formStatePreservation";
import { apiRequest, queryClient } from "@/lib/queryClient";
import { toast } from "@/hooks/use-toast";
import { keepDialogOpen, releaseDialog } from "./mobileDialogFix";

/**
 * Store of newly added items by operation ID
 * Used to track newly added items and preserve their quantities
 */
const newlyAddedItems: Record<string, number[]> = {};

/**
 * Store of original quantities by proforma slip
 * Used to preserve quantities of existing items
 */
const originalQuantitiesMap: Record<string, Record<number, number>> = {};

/**
 * Initialize the enhanced addItemToSlip function
 * This will replace the global window.addItemToSlip function
 */
export function initializeAddItemToSlip() {
  // Add the global function to the window object
  window.addItemToSlip = async (
    operationId: number, 
    productId: number, 
    referenceNumber: string, 
    productName: string,
    sku: string,
    defaultQuantity: number = 0
  ) => {
    console.log(`Adding item ${productName} to slip with default quantity from itemsPerPallet: ${defaultQuantity}`);

    // Ensure we're working with valid data
    if (!operationId || !productId || !referenceNumber) {
      toast({
        variant: "destructive",
        title: "Error adding item",
        description: "Missing required information. Please try again.",
      });
      return;
    }

    try {
      // First, ensure the dialog stays open during the operation
      ensureDialogOpen(operationId);
      // Also use the mobile-specific dialog fix
      keepDialogOpen(operationId);

      // After operation is created, we don't need the proforma slip details anymore
      // We work directly with the loading operation

      // Create a new load operation item instead of a proforma slip item
      const newItem = await apiRequest("POST", `/api/loading-operations/${operationId}/items`, {
        loadOperationsId: operationId,
        productId: productId,
        quantity: defaultQuantity || 0,
        originalQuantity: 0, // New items have 0 original quantity (all is extra)
        extraQuantity: defaultQuantity || 0, // All quantity is extra for new items
        loaded: false,
        loadedQuantity: 0
      });

      if (!newItem || !newItem.id) {
        toast({
          variant: "destructive",
          title: "Error adding item",
          description: "Failed to add the item. Please try again.",
        });
        return;
      }

      // Track this item as newly added for this operation
      if (!newlyAddedItems[referenceNumber]) {
        newlyAddedItems[referenceNumber] = [];
      }
      newlyAddedItems[referenceNumber].push(newItem.id);
      console.log(`Added item ${newItem.id} to newly added items list for ${referenceNumber}:`, newlyAddedItems[referenceNumber]);

      // Update the original quantity for the new item
      if (!originalQuantitiesMap[referenceNumber]) {
        originalQuantitiesMap[referenceNumber] = {};
      }
      originalQuantitiesMap[referenceNumber][newItem.id] = defaultQuantity || 0;
      console.log(`Updated original quantities for new item ${newItem.id} with quantity ${defaultQuantity || 0}`);

      // Invalidate queries to reflect the new item - ONLY loading operations, NOT proforma
      queryClient.invalidateQueries({ queryKey: [`/api/loading-operations/${operationId}/items`] });
      queryClient.invalidateQueries({ queryKey: [`/api/loading-operations/${operationId}`] });
      
      // Broadcast the addition for reactive UI updates
      console.log(`Broadcasting new item addition: id=${newItem.id}, qty=${defaultQuantity || 0}, to operation ${operationId}`);
      
      // Get updated details to ensure everything is in sync
      await apiRequest("GET", `/api/loading-operations/${operationId}/items`);

      // Show success toast
      toast({
        title: "Item added",
        description: `${productName} has been added to the operation.`,
      });

      // Keep the dialog open after adding the item
      ensureDialogOpen(operationId);
      // Double ensure with mobile fix
      keepDialogOpen(operationId);
      
    } catch (error) {
      console.error("Error adding item:", error);
      
      toast({
        variant: "destructive",
        title: "Error adding item",
        description: "An error occurred while adding the item. Please try again.",
      });
      
      // Even on error, ensure the dialog stays open
      ensureDialogOpen(operationId);
      keepDialogOpen(operationId);
    }
  };
}

/**
 * Get all newly added items for a reference number
 * @param referenceNumber The reference number
 * @returns Array of item IDs that were newly added
 */
export function getNewlyAddedItems(referenceNumber: string): number[] {
  return newlyAddedItems[referenceNumber] || [];
}

/**
 * Get original quantities map for a reference number
 * @param referenceNumber The reference number
 * @returns Map of item ID to original quantity
 */
export function getOriginalQuantities(referenceNumber: string): Record<number, number> {
  return originalQuantitiesMap[referenceNumber] || {};
}

/**
 * Store original quantities for a reference number
 * @param referenceNumber The reference number
 * @param quantities Map of item ID to original quantity
 */
export function storeOriginalQuantities(referenceNumber: string, quantities: Record<number, number>) {
  originalQuantitiesMap[referenceNumber] = { ...quantities };
  console.log(`Loaded stored original quantities for ${referenceNumber}:`, originalQuantitiesMap[referenceNumber]);
}