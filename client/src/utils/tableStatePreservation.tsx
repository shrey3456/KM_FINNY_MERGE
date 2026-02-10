/**
 * Table state preservation utilities
 * These functions help keep the table state consistent during operations
 */

import { queryClient } from "@/lib/queryClient";

/**
 * Update a cached operation with new data
 * This ensures that vehicle number and driver name are preserved when items are updated
 * 
 * @param operation The updated operation data
 */
export function updateCachedOperation(operation: any) {
  if (!operation || !operation.id) {
    console.warn("Cannot update cached operation: invalid operation data");
    return;
  }

  console.log(`Updating cached operation #${operation.id} with data:`, operation);

  try {
    // Get current cached data for loading operations
    const cachedOperations = queryClient.getQueryData<any[]>(['/api/loading-operations']);
    
    if (cachedOperations && Array.isArray(cachedOperations)) {
      // Find and update the operation in the cache
      const updatedOperations = cachedOperations.map(op => 
        op.id === operation.id ? { ...op, ...operation } : op
      );
      
      // Update the cached data
      queryClient.setQueryData(['/api/loading-operations'], updatedOperations);
      console.log(`Updated operation #${operation.id} in cache`);
    }

    // Also update any direct operation queries
    queryClient.setQueryData([`/api/loading-operations/${operation.id}`], operation);
    
    // Log the vehicleNumber for debugging
    if (operation.vehicleNumber) {
      console.log(`Preserved vehicle number "${operation.vehicleNumber}" for operation #${operation.id}`);
    }
    
    if (operation.driverName) {
      console.log(`Preserved driver name "${operation.driverName}" for operation #${operation.id}`);
    }
  } catch (error) {
    console.error(`Error updating cached operation #${operation.id}:`, error);
  }
}