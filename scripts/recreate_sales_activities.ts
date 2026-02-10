/**
 * This script recreates activity records for sales that don't have them.
 * It directly uses Drizzle ORM to query the database.
 */

import { db } from '../server/db';
import { sales, activities, users } from '../shared/schema';
import { sql, eq } from 'drizzle-orm';

async function recreateSalesActivities() {
  console.log('Starting activity records recreation for sales...');
  
  try {
    // Get all sales
    const allSales = await db.select().from(sales);
    console.log(`Found ${allSales.length} sales entries to check for activities.`);
    
    let recreatedCount = 0;
    let errorCount = 0;
    let skippedCount = 0;
    
    for (const sale of allSales) {
      try {
        // Check if this sale already has an activity record
        const existingActivities = await db.select()
          .from(activities)
          .where(sql`${activities.entityType} = 'sale' AND ${activities.entityId} = ${String(sale.id)}`)
          .limit(1);
        
        if (existingActivities.length === 0) {
          console.log(`Sale #${sale.id} (Order #${sale.orderNumber}) has no activity record. Creating one...`);
          
          // Find the user who created the sale
          let userName = "System";
          if (sale.createdById) {
            try {
              const userResults = await db.select()
                .from(users)
                .where(eq(users.id, sale.createdById))
                .limit(1);
              
              if (userResults.length > 0) {
                userName = userResults[0].name || userResults[0].username || "Unknown User";
              }
            } catch (userError) {
              console.error(`Error fetching user info for sale #${sale.id}:`, userError);
            }
          }
          
          // Create activity details
          const activityDetails = JSON.stringify({
            orderNumber: sale.orderNumber,
            dealer: sale.dealer,
            quantity: sale.quantity,
            amount: sale.amount,
            status: sale.status
          });
          
          // Create activity record
          await db.insert(activities).values({
            pageName: "Sales",
            action: "create",
            entityType: "sale",
            entityId: String(sale.id),
            details: activityDetails,
            userId: sale.createdById || null,
            userName,
            createdAt: new Date() // Use current timestamp
          });
          
          console.log(`Created activity record for sale #${sale.id}`);
          recreatedCount++;
        } else {
          console.log(`Sale #${sale.id} already has activity records. Skipping.`);
          skippedCount++;
        }
      } catch (saleError) {
        console.error(`Error processing sale #${sale.id}:`, saleError);
        errorCount++;
      }
    }
    
    console.log(`
=====================================
Activity Records Recreation Completed
=====================================
Total sales checked: ${allSales.length}
Records created: ${recreatedCount}
Records skipped: ${skippedCount}
Errors encountered: ${errorCount}
    `);
    
  } catch (error) {
    console.error('Error recreating activity records for sales:', error);
  }
}

// Execute the function
recreateSalesActivities().catch(console.error);