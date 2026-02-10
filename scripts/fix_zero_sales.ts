/**
 * This script updates specific sales entries with zero quantity and amount
 * that have associated sale items
 */

import { db } from '../server/db';
import { sales, saleItems } from '../shared/schema';
import { eq, inArray, sql } from 'drizzle-orm';

async function fixZeroSales() {
  console.log('Starting specific fix for sales with zero quantities but existing items...');
  
  try {
    // Find sales with zero quantity/amount but having items
    const results = await db.execute<{ id: number, order_number: string, quantity: number, amount: string, item_count: number }>(sql`
      SELECT s.id, s.order_number, s.quantity, s.amount, COUNT(si.id) as item_count 
      FROM sales s 
      LEFT JOIN sale_items si ON s.id = si.sale_id 
      WHERE s.status = 'READY≈DESP' AND (s.quantity = 0 OR s.amount = 0) 
      GROUP BY s.id, s.order_number, s.quantity, s.amount 
      HAVING COUNT(si.id) > 0
      ORDER BY s.id DESC
      LIMIT 100
    `);
    
    const recentZeroSales = results.rows;
    console.log(`Found ${recentZeroSales.length} sales with zero quantity/amount but having items`);
    
    let updatedCount = 0;
    let errorCount = 0;
    
    for (const sale of recentZeroSales) {
      try {
        // Get all items for this sale
        const items = await db.select()
          .from(saleItems)
          .where(eq(saleItems.saleId, sale.id));
        
        if (items.length > 0) {
          // Calculate total quantity and amount from items
          const totalQuantity = items.reduce((sum, item) => sum + (Number(item.quantity) || 0), 0);
          const totalAmount = items.reduce((sum, item) => {
            const unitPrice = (Number(item.mrp) || 750);
            return sum + (Number(item.quantity) || 0) * unitPrice;
          }, 0);
          
          const roundedAmount = Math.round(totalAmount);
          
          // Update the sale record
          await db.update(sales)
            .set({ 
              quantity: totalQuantity,
              amount: roundedAmount.toString()
            })
            .where(eq(sales.id, sale.id));
            
          console.log(`Updated sale #${sale.id} (Order #${sale.order_number}) with quantity=${totalQuantity}, amount=${roundedAmount}`);
          
          // Update activity record if it exists
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
        }
      } catch (error) {
        console.error(`Error updating sale #${sale.id}:`, error);
        errorCount++;
      }
    }
    
    console.log(`
=====================================
Sales Fix Completed
=====================================
Total sales checked: ${recentZeroSales.length}
Sales updated: ${updatedCount}
Errors encountered: ${errorCount}
    `);
    
  } catch (error) {
    console.error('Error fixing zero sales:', error);
  }
}

// Execute the function
fixZeroSales().catch(console.error);