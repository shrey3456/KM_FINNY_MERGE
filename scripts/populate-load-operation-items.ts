import { db } from '../server/db';
import { sql, or } from 'drizzle-orm';
import { loadingOperations, loadingOpItems, proformaSlipItems, proformaSlips } from '@shared/schema';
import { eq } from 'drizzle-orm';

/**
 * Script to populate the load_operations_items table for all load operations
 * This includes both "READY≈DESP" and "LOADING" status operations
 * This is useful for ensuring that all existing load operations have corresponding items
 */
async function populateLoadOperationItems() {
  console.log('Starting population of load operation items for ALL operations...');
  
  try {
    // 1. Get all load operations with both "READY≈DESP" and "LOADING" status
    const allOperations = await db.select()
      .from(loadingOperations)
      .where(or(
        eq(loadingOperations.status, 'READY≈DESP'),
        eq(loadingOperations.status, 'LOADING')
      ));
    
    const readyOperations = allOperations.filter(op => op.status === 'READY≈DESP');
    const loadingOperationsCount = allOperations.length - readyOperations.length;
    
    console.log(`Found ${allOperations.length} total load operations:`);
    console.log(`- ${readyOperations.length} with "READY≈DESP" status`);
    console.log(`- ${loadingOperationsCount} with "LOADING" status`);
    
    // 2. Process each operation
    let successCount = 0;
    let errorCount = 0;
    let skippedCount = 0;
    
    for (const operation of allOperations) {
      try {
        console.log(`Processing load operation ${operation.id} (${operation.status})...`);
        
        // Check if this operation already has items
        const existingItems = await db.select()
          .from(loadingOpItems)
          .where(eq(loadingOpItems.loadOperationsId, operation.id));
        
        if (existingItems.length > 0) {
          console.log(`Load operation ${operation.id} already has ${existingItems.length} items, skipping...`);
          skippedCount++;
          continue;
        }
        
        // First try to find the proforma slip by order number
        const referenceNumber = operation.referenceNumber;
        if (!referenceNumber) {
          console.warn(`Load operation ${operation.id} has no reference number, skipping...`);
          skippedCount++;
          continue;
        }
        
        // Get the proforma slip using order number (referenceNumber)
        const proformaSlipsResults = await db.select()
          .from(proformaSlips)
          .where(eq(proformaSlips.orderNumber, referenceNumber));
        
        if (proformaSlipsResults.length === 0) {
          console.warn(`No proforma slip found for reference number ${referenceNumber}, skipping load operation ${operation.id}...`);
          skippedCount++;
          continue;
        }
        
        const proformaSlip = proformaSlipsResults[0];
        const proformaSlipId = proformaSlip.id;
        
        // Get items from the proforma slip
        const items = await db.select()
          .from(proformaSlipItems)
          .where(eq(proformaSlipItems.proformaSlipId, proformaSlipId));
        
        if (items.length === 0) {
          console.warn(`No items found for proforma slip ${proformaSlipId}, skipping load operation ${operation.id}...`);
          skippedCount++;
          continue;
        }
        
        console.log(`Found ${items.length} items for proforma slip ${proformaSlipId} (order #${referenceNumber})`);
        
        // Create load operation items from proforma slip items
        const loadOpItemsToCreate = items.map(item => ({
          loadOperationsId: operation.id,
          productId: item.productId,
          quantity: item.quantity,
          originalQuantity: item.quantity,
          // For LOADING status, default to not loaded
          // For READY≈DESP status, default to loaded
          loadedQuantity: operation.status === 'READY≈DESP' ? item.quantity : 0,
          loaded: operation.status === 'READY≈DESP', // Default based on status
          srNo: item.srNo || '',
          barcode: item.barcode || '',
          itemName: item.itemName || '',
          srNoDisplay: item.srNo || ''
        }));
        
        // Insert the items
        if (loadOpItemsToCreate.length > 0) {
          const insertedItems = await db.insert(loadingOpItems)
            .values(loadOpItemsToCreate)
            .returning();
          
          console.log(`Successfully created ${insertedItems.length} items for load operation ${operation.id} (${operation.status})`);
          successCount++;
        }
      } catch (error) {
        console.error(`Error processing load operation ${operation.id}:`, error);
        errorCount++;
      }
    }
    
    console.log(`
Population complete:
- Processed ${allOperations.length} load operations
- Successfully populated ${successCount} operations
- Skipped ${skippedCount} operations (already had items or no proforma items)
- Encountered errors with ${errorCount} operations
    `);
    
  } catch (error) {
    console.error('Error populating load operation items:', error);
  }
}

// Run the function
populateLoadOperationItems().then(() => {
  console.log('Script execution completed');
  process.exit(0);
}).catch(error => {
  console.error('Script execution failed:', error);
  process.exit(1);
});