/**
 * This script identifies sales entries with zero quantity/amount and no related items
 * and marks them appropriately to avoid misleading zeros in reports
 */

import { db } from '../server/db';
import { sales, saleItems } from '../shared/schema';
import { eq, sql } from 'drizzle-orm';

async function fixNoItemsSales() {
  console.log('Starting fix for sales with zero quantities and no items...');
  
  try {
    // Find sales with zero quantity/amount and NO items
    const results = await db.execute<{ id: number, order_number: string, quantity: number, amount: string }>(sql`
      SELECT s.id, s.order_number, s.quantity, s.amount
      FROM sales s 
      LEFT JOIN sale_items si ON s.id = si.sale_id 
      WHERE s.status = 'READY≈DESP' AND (s.quantity = 0 OR s.amount = 0) 
      GROUP BY s.id, s.order_number, s.quantity, s.amount 
      HAVING COUNT(si.id) = 0
      ORDER BY s.id DESC
      LIMIT 100
    `);
    
    const salesWithNoItems = results.rows;
    console.log(`Found ${salesWithNoItems.length} sales with zero quantity/amount and no items`);
    
    let updatedCount = 0;
    let errorCount = 0;
    
    for (const sale of salesWithNoItems) {
      try {
        // Update the sale record with a note in the "comments" field 
        // indicating it's a placeholder with no actual items
        await db.update(sales)
          .set({ 
            comments: "No items found - placeholder entry"
          })
          .where(eq(sales.id, sale.id));
          
        console.log(`Updated sale #${sale.id} (Order #${sale.order_number}) with comment about missing items`);
        updatedCount++;
      } catch (error) {
        console.error(`Error updating sale #${sale.id}:`, error);
        errorCount++;
      }
    }
    
    console.log(`
=====================================
No-Items Sales Fix Completed
=====================================
Total sales checked: ${salesWithNoItems.length}
Sales updated: ${updatedCount}
Errors encountered: ${errorCount}
    `);
    
  } catch (error) {
    console.error('Error fixing no-items sales:', error);
  }
}

// Execute the function
fixNoItemsSales().catch(console.error);