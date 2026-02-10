/**
 * This script deletes all existing sales entries and regenerates them
 * based on loading operations with READY≈DESP status.
 */

import nodePersist from 'node-persist';
import { db } from '../server/db';
import { sql, eq, like } from 'drizzle-orm';
import { sales, saleItems, loadingOperations, loadingOpItems } from '../shared/schema';

async function main() {
  console.log('Starting sales regeneration script...');
  
  try {
    // Step 1: Count existing sales and sale items for reporting
    const existingSalesCount = await db.select({ count: sql`count(*)` }).from(sales);
    const existingSaleItemsCount = await db.select({ count: sql`count(*)` }).from(saleItems);
    
    console.log(`Found ${existingSalesCount[0].count} existing sales with ${existingSaleItemsCount[0].count} items`);
    
    // Step 2: Delete all sale items first (due to foreign key constraints)
    console.log('Deleting all sale items...');
    await db.delete(saleItems);
    
    // Step 3: Delete all sales
    console.log('Deleting all sales...');
    await db.delete(sales);
    
    // Step 4: Get all loading operations with READY≈DESP status
    // Note: We check both "READY≈DESP" and "READY DESP" and "PENDING DESP" for compatibility
    console.log('Finding loading operations with READY≈DESP status...');
    const readyOps = await db.select()
      .from(loadingOperations)
      .where(
        sql`(${loadingOperations.status} LIKE ${'%READY%DESP%'} OR ${loadingOperations.status} = ${'PENDING DESP'})`
      );
    
    console.log(`Found ${readyOps.length} loading operations with READY≈DESP status`);
    
    // Step 5: Create sales entries for each ready loading operation
    console.log('Creating new sales entries...');
    
    let createdSalesCount = 0;
    let createdItemsCount = 0;
    let errorCount = 0;
    
    for (const op of readyOps) {
      try {
        // Get the operation items to calculate total quantity
        const opItems = await db.select()
          .from(loadingOpItems)
          .where(eq(loadingOpItems.loadingOperationId, op.id));
        
        // Calculate total quantity
        const totalQuantity = opItems.reduce((sum, item) => sum + (item.loadedQuantity || 0), 0);
        
        // Prepare the dealer/party name
        // Use the party_name field if available, otherwise use the notes field
        const dealerName = op.partyName || extractDealerFromNotes(op.notes) || 'Unknown';
        
        // Prepare the date (use createdAt if available, otherwise use current date)
        const dateStr = op.createdAt 
          ? formatDate(op.createdAt) 
          : formatDate(new Date());
        
        // Create the sale entry
        const newSale = {
          orderNumber: op.referenceNumber,
          date: dateStr,
          status: 'READY≈DESP',
          createdById: 1, // Admin user ID
          quantity: totalQuantity,
          notes: op.notes || '',
          dealer: dealerName,
          vehicleNumber: op.vehicleNumber || '',
          plant: op.plant || null,
          amount: calculateTotalAmount(opItems)
        };
        
        // Insert the sale record
        const [createdSale] = await db.insert(sales).values(newSale).returning();
        createdSalesCount++;
        
        console.log(`Created sale #${createdSale.id} for order ${op.referenceNumber} with ${opItems.length} items`);
        
        // Now create sale items for each loading operation item
        if (opItems.length > 0) {
          // For each item in the load operation, create a corresponding sale item
          const saleItemsToInsert = opItems.map(item => ({
            saleId: createdSale.id,
            sku: item.srNo || null,
            barcode: item.barcode || null,
            name: item.itemName || 'Unknown Item',
            quantity: item.loadedQuantity || 0,
            unitPrice: calculateUnitPrice(item).toString(),
            totalPrice: (calculateUnitPrice(item) * (item.loadedQuantity || 0)).toString(),
            category: null, // We don't have this info in the loading op items
            hsn: null, // We don't have this info in the loading op items
            originalQuantity: item.originalQuantity || item.loadedQuantity || 0
          }));
          
          // Insert items in batches of 50
          const BATCH_SIZE = 50;
          for (let i = 0; i < saleItemsToInsert.length; i += BATCH_SIZE) {
            const batch = saleItemsToInsert.slice(i, i + BATCH_SIZE);
            await db.insert(saleItems).values(batch);
            createdItemsCount += batch.length;
          }
          
          console.log(`Created ${saleItemsToInsert.length} items for sale #${createdSale.id}`);
        } else {
          console.log(`Warning: No items found for operation ${op.id}, sale created with 0 items`);
        }
      } catch (error) {
        console.error(`Error processing operation ${op.id}:`, error);
        errorCount++;
      }
    }
    
    // Final report
    console.log(`
    Sales regeneration completed:
    - Created ${createdSalesCount} new sales (from ${readyOps.length} operations)
    - Created ${createdItemsCount} new sale items
    - Encountered errors with ${errorCount} operations
    `);
    
  } catch (error) {
    console.error('Fatal error during sales regeneration:', error);
  }
}

// Helper function to extract dealer name from notes field
function extractDealerFromNotes(notes: string | null): string | null {
  if (!notes) return null;
  
  // Common pattern in notes: "Party: NAME" or "Dealer: NAME"
  const partyMatch = notes.match(/Party:\s*([^,\n]+)/i);
  if (partyMatch && partyMatch[1]) return partyMatch[1].trim();
  
  const dealerMatch = notes.match(/Dealer:\s*([^,\n]+)/i);
  if (dealerMatch && dealerMatch[1]) return dealerMatch[1].trim();
  
  return null;
}

// Helper function to calculate unit price (this is approximate since we don't have actual price data)
function calculateUnitPrice(item: any): number {
  // If we have a price directly, use it
  if (item.price && !isNaN(parseFloat(item.price))) {
    return parseFloat(item.price);
  }
  
  // Default prices based on common product types
  return 750; // Default price if we don't have pricing data
}

// Helper function to calculate total amount
function calculateTotalAmount(items: any[]): string {
  const total = items.reduce((sum, item) => {
    const unitPrice = calculateUnitPrice(item);
    const quantity = item.loadedQuantity || 0;
    return sum + (unitPrice * quantity);
  }, 0);
  
  return total.toString();
}

// Helper function to format dates
function formatDate(date: Date | string): string {
  const d = date instanceof Date ? date : new Date(date);
  const day = d.getDate().toString().padStart(2, '0');
  const month = (d.getMonth() + 1).toString().padStart(2, '0');
  const year = d.getFullYear();
  return `${day}-${month}-${year}`;
}

// Run the script
main()
  .then(() => process.exit(0))
  .catch(error => {
    console.error('Script failed:', error);
    process.exit(1);
  });