/**
 * This script updates existing sale activity records with correct quantity and amount values.
 * It finds activity records with 0 quantity/amount and updates them with values from the sales table.
 */

import { db } from '../server/db';
import { sales, activities } from '../shared/schema';
import { sql, eq } from 'drizzle-orm';

async function updateSalesActivities() {
  console.log('Starting to update activity records for sales with zero quantities and amounts...');
  
  try {
    // Find all sale activities with zero quantity or amount in their details
    const activitiesQuery = await db.select()
      .from(activities)
      .where(sql`entity_type = 'sale' AND details LIKE '%"quantity":0,%' AND details LIKE '%"amount":0,%'`);
      
    console.log(`Found ${activitiesQuery.length} sale activities with zero quantity and amount to update.`);
    
    let updatedCount = 0;
    let errorCount = 0;
    
    for (const activity of activitiesQuery) {
      try {
        // Parse the entity_id to get the sale ID
        const saleId = parseInt(activity.entityId);
        if (isNaN(saleId)) {
          console.error(`Invalid sale ID in activity #${activity.id}: ${activity.entityId}`);
          errorCount++;
          continue;
        }
        
        // Get the corresponding sale record
        const saleQuery = await db.select()
          .from(sales)
          .where(eq(sales.id, saleId))
          .limit(1);
          
        if (saleQuery.length === 0) {
          console.error(`Activity #${activity.id} refers to non-existent sale ID: ${saleId}`);
          errorCount++;
          continue;
        }
        
        const sale = saleQuery[0];
        
        // Parse the activity details
        let details;
        try {
          details = JSON.parse(activity.details);
        } catch (jsonError) {
          console.error(`Failed to parse JSON details for activity #${activity.id}:`, jsonError);
          errorCount++;
          continue;
        }
        
        // Check if we need to update the details
        if (details.quantity === 0 && details.amount === 0 && 
            (sale.quantity > 0 || sale.amount > 0)) {
          // Update with correct values from the sales table
          details.quantity = sale.quantity;
          details.amount = sale.amount;
          
          // Update the activity record
          await db.update(activities)
            .set({ details: JSON.stringify(details) })
            .where(eq(activities.id, activity.id));
            
          console.log(`Updated activity #${activity.id} for sale #${saleId} with quantity=${sale.quantity}, amount=${sale.amount}`);
          updatedCount++;
        } else {
          console.log(`Activity #${activity.id} for sale #${saleId} already has correct values or both sale and activity have zeros.`);
        }
      } catch (activityError) {
        console.error(`Error processing activity #${activity.id}:`, activityError);
        errorCount++;
      }
    }
    
    console.log(`
=====================================
Sale Activity Records Update Completed
=====================================
Total records checked: ${activitiesQuery.length}
Records updated: ${updatedCount}
Errors encountered: ${errorCount}
    `);
    
  } catch (error) {
    console.error('Error updating activity records for sales:', error);
  }
}

// Execute the function
updateSalesActivities().catch(console.error);