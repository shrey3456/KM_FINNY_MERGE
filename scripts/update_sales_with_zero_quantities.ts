/**
 * This script updates sales entries with zero quantity and amount
 * by recalculating them from their related items
 * 
 * Processes sales in batches to avoid timeouts
 */

import { db } from '../server/db';
import { sales, saleItems } from '../shared/schema';
import { eq, sql, inArray } from 'drizzle-orm';

async function updateSalesWithZeroQuantities() {
  console.log('Starting update of sales with zero quantities and amounts...');
  
  const BATCH_SIZE = 50; // Process 50 sales at a time
  let currentOffset = 0;
  let totalChecked = 0;
  let updatedCount = 0;
  let errorCount = 0;
  let noItemsCount = 0;
  let hasMoreSales = true;
  
  try {
    while (hasMoreSales) {
      // Find batch of sales with zero quantity or zero amount
      const salesToUpdate = await db.select()
        .from(sales)
        .where(sql`(quantity = 0 OR amount = 0) AND status = 'READY≈DESP'`)
        .limit(BATCH_SIZE)
        .offset(currentOffset);
      
      if (salesToUpdate.length === 0) {
        hasMoreSales = false;
        break;
      }
      
      console.log(`Processing batch of ${salesToUpdate.length} sales (offset: ${currentOffset})`);
      
      // Extract all sale IDs for this batch
      const saleIds = salesToUpdate.map(sale => sale.id);
      
      // Get all items for all sales in this batch in a single query
      const allItems = await db.select()
        .from(saleItems)
        .where(inArray(saleItems.saleId, saleIds));
      
      // Group items by saleId
      const itemsBySaleId = allItems.reduce((acc, item) => {
        if (!acc[item.saleId]) {
          acc[item.saleId] = [];
        }
        acc[item.saleId].push(item);
        return acc;
      }, {} as Record<number, typeof allItems>);
      
      // Process each sale in the batch
      for (const sale of salesToUpdate) {
        try {
          const items = itemsBySaleId[sale.id] || [];
          
          if (items.length === 0) {
            console.log(`Sale #${sale.id} (Order #${sale.orderNumber}) has no items. Skipping.`);
            noItemsCount++;
            continue;
          }
          
          // Calculate total quantity
          const totalQuantity = items.reduce((sum, item) => sum + (item.quantity || 0), 0);
          
          // Calculate total amount - convert each totalPrice from string to number
          const totalAmount = items.reduce((sum, item) => {
            const itemTotal = item.totalPrice ? parseFloat(item.totalPrice) : 0;
            return sum + itemTotal;
          }, 0);
          
          // Only update if the calculated values are non-zero
          if (totalQuantity > 0 || totalAmount > 0) {
            // Round the amount to the nearest integer as per DB schema
            const roundedAmount = Math.round(totalAmount);
            
            // Update the sale record
            await db.update(sales)
              .set({ 
                quantity: totalQuantity,
                amount: roundedAmount
              })
              .where(eq(sales.id, sale.id));
              
            console.log(`Updated sale #${sale.id} (Order #${sale.orderNumber}) with quantity=${totalQuantity}, amount=${roundedAmount}`);
            
            // Also update the corresponding activity record
            await db.execute(sql`
              UPDATE activities
              SET details = jsonb_set(
                jsonb_set(details::jsonb, '{quantity}', ${totalQuantity}::text::jsonb),
                '{amount}', ${roundedAmount}::text::jsonb
              )
              WHERE entity_type = 'sale' 
              AND entity_id = ${String(sale.id)}
              AND details::jsonb->>'quantity' = '0'
            `);
            
            console.log(`Updated activity record for sale #${sale.id}`);
            updatedCount++;
          } else {
            console.log(`Sale #${sale.id} (Order #${sale.orderNumber}) has no quantity or amount from items. Skipping.`);
          }
        } catch (error) {
          console.error(`Error updating sale #${sale.id}:`, error);
          errorCount++;
        }
      }
      
      totalChecked += salesToUpdate.length;
      currentOffset += BATCH_SIZE;
      
      // Print progress after each batch
      console.log(`
      Progress Update:
      ----------------
      Sales checked so far: ${totalChecked}
      Sales updated so far: ${updatedCount}
      Sales with no items so far: ${noItemsCount}
      Errors encountered so far: ${errorCount}
      `);
    }
    
    console.log(`
=====================================
Sales Update Completed
=====================================
Total sales checked: ${totalChecked}
Sales updated: ${updatedCount}
Sales with no items: ${noItemsCount}
Errors encountered: ${errorCount}
    `);
    
  } catch (error) {
    console.error('Error updating sales with zero quantities:', error);
  }
}

// Execute the function
updateSalesWithZeroQuantities().catch(console.error);