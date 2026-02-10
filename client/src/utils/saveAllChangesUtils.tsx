/**
 * Enhanced saveAllChanges utility function for warehouse pages
 * This function preserves form state and prevents tables from going blank
 * 
 * Usage: Import this into each warehouse component and use it as the saveAllChanges function
 */

import { toast } from "@/hooks/use-toast";
import { apiRequest } from "@/lib/queryClient";
import { ensureDialogOpen } from "./formStatePreservation";
import { updateCachedOperation } from "./tableStatePreservation";

/**
 * Save all changes for a loading operation
 * This function will:
 * 1. Preserve form state and keep dialogs open
 * 2. Update the table state to prevent blank tables
 * 3. Save changes to the backend in a batch
 * 4. Preserve vehicle number and driver name in all operations
 * 
 * @param operationId The operation ID
 * @param items Items to update
 * @param onSuccess Optional callback on success
 * @param onError Optional callback on error
 * @param vehicleNumber Optional vehicle number to preserve
 * @param driverName Optional driver name to preserve
 */
export async function saveAllChanges(
  operationId: number, 
  items: any[], 
  onSuccess?: () => void,
  onError?: (error: any) => void,
  vehicleNumber?: string,
  driverName?: string
) {
  console.log("[SaveChanges] Starting save operation...");
  const startTime = performance.now();

  if (!operationId || !items || !items.length) {
    console.log("No operation ID or items to save");
    return;
  }

  try {
    // First, ensure the dialog stays open during the operation
    ensureDialogOpen(operationId);
    
    // If vehicle number or driver name was provided, update them first
    if (vehicleNumber !== undefined || driverName !== undefined) {
      console.log(`Preserving vehicle number "${vehicleNumber}" and driver name "${driverName}" for operation #${operationId}`);
      
      try {
        // Get current values to supplement any missing parameters
        const currentOperation = await apiRequest(
          `/api/loading-operations/${operationId}`,
          { method: "GET" }
        );
        
        // Update operation with vehicle and driver info
        await apiRequest(
          `/api/loading-operations/${operationId}`,
          { 
            method: "PUT", 
            data: {
              vehicleNumber: vehicleNumber !== undefined ? vehicleNumber : currentOperation?.vehicleNumber || "",
              driverName: driverName !== undefined ? driverName : currentOperation?.driverName || ""
            }
          }
        );
        
        console.log(`Successfully updated operation #${operationId} with vehicle/driver info`);
      } catch (error) {
        console.error(`Error updating vehicle/driver info for operation #${operationId}:`, error);
        // Continue with item updates even if this fails
      }
    }
    
    // Create an array to track all update promises
    const updatePromises = [];

    // Process items in parallel with a limit of 10 concurrent requests
    const batchSize = 10;
    
    for (let i = 0; i < items.length; i += batchSize) {
      const batch = items.slice(i, i + batchSize);
      
      const batchPromises = batch.map(async (item) => {
        try {
          // Always convert loaded status to true boolean and calculate loadedQuantity accordingly
          const loadedStatus = item.loaded === true || item.loaded === 'true';
          const loadedQuantity = loadedStatus ? (item.quantity || 0) : 0;
          
          console.log(`Saving item ${item.id}: loaded=${loadedStatus}, quantity=${item.quantity}, originalQuantity=${item.originalQuantity || 'not set'}, extraQuantity=${item.extraQuantity !== undefined ? item.extraQuantity : 'calculated'}, loadedQuantity=${loadedQuantity}`);
          
          // Build request data with explicit type handling
          const requestData = { 
            items: [{ 
              id: item.id,
              quantity: typeof item.quantity === 'number' ? item.quantity : parseInt(item.quantity || '0'),
              loaded: loadedStatus, // Convert to boolean explicitly
              originalQuantity: item.originalQuantity,
              // Calculate extra quantity as the difference between quantity and originalQuantity
              extraQuantity: item.extraQuantity !== undefined ? 
                item.extraQuantity : 
                Math.max(0, (item.quantity || 0) - (item.originalQuantity || 0)),
              // ALWAYS set loadedQuantity based on loaded status - critical for database update
              loadedQuantity: loadedStatus ? 
                (typeof item.quantity === 'number' ? item.quantity : parseInt(item.quantity || '0')) : 
                0
            }],
            // Include operation ID for context
            loadOperationId: operationId
          };
          
          // Debug: Log what we're sending to the server
          console.log(`Saving item ${item.id} for product ${item.productId}: loaded=${loadedStatus}, loadedQuantity=${loadedStatus ? item.quantity : 0}`);
          
          console.log("Making batch request to update items with data:", JSON.stringify(requestData));
          
          try {
            const result = await apiRequest(
              `/api/loading-operation-items/batch-update`,
              {
                method: "POST",
                data: requestData
              }
            );
            
            // Log the response to help with debugging
            console.log(`Response for item ${item.id}:`, JSON.stringify(result));
            
            return result;
          } catch (error) {
            console.error(`Error in request for item ${item.id}:`, error);
            throw error;
          }
        } catch (error) {
          console.error(`Error updating item ${item.id}:`, error);
          throw error;
        }
      });
      
      // Wait for the current batch to complete before processing the next batch
      const batchResults = await Promise.all(batchPromises);
      updatePromises.push(...batchResults);
    }

    // All updates completed
    console.log("Updated proforma details after save:", updatePromises);
    
    // Update the cached operation to reflect the changes
    const operation = await apiRequest(
      `/api/loading-operations/${operationId}`,
      { method: "GET" }
    );
    
    if (operation) {
      updateCachedOperation(operation);
    }
    
    const endTime = performance.now();
    console.log(`[SaveChanges] Save operation completed in ${(endTime - startTime).toFixed(2)}ms`);

    // Show success toast
    toast({
      title: "Changes saved",
      description: "All changes have been saved successfully.",
    });

    // Call the onSuccess callback if provided
    if (onSuccess) {
      onSuccess();
    }

    // Ensure the dialog stays open after the operation
    ensureDialogOpen(operationId);
    
  } catch (error) {
    console.error("Error updating items:", error);
    
    // Show error toast
    toast({
      variant: "destructive",
      title: "Error saving changes",
      description: "An error occurred while saving changes. Please try again.",
    });

    // Call the onError callback if provided
    if (onError) {
      onError(error);
    }

    // Even on error, ensure the dialog stays open
    ensureDialogOpen(operationId);
  }
}