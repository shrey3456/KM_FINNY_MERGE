import { db } from './db';
import { loadingOpItems } from '@shared/schema';
import { eq, and, lt, gt, desc } from 'drizzle-orm';

/**
 * This script runs a targeted migration to calculate extra quantity values
 * for recently created load operation items only.
 */
async function updateRecentItems() {
  console.log('Starting targeted migration for recent load operation items...');
  
  try {
    // Get only the 100 most recent load operation items to update
    const recentItems = await db.select()
      .from(loadingOpItems)
      .orderBy(desc(loadingOpItems.id))
      .limit(100);
    
    console.log(`Found ${recentItems.length} recent load operation items to update`);
    
    let updated = 0;
    let errors = 0;
    
    // Update each item with the calculated extraQuantity
    for (const item of recentItems) {
      try {
        // Calculate extra quantity as the difference between quantity and originalQuantity
        // If quantity > originalQuantity, extra = quantity - originalQuantity
        // Otherwise, extra = 0
        const extraQty = (item.quantity !== null && item.originalQuantity !== null && 
                         item.quantity > item.originalQuantity) 
          ? item.quantity - item.originalQuantity 
          : 0;
        
        // Update the extraQuantity field in the database
        await db.update(loadingOpItems)
          .set({ extraQuantity: extraQty })
          .where(eq(loadingOpItems.id, item.id));
        
        console.log(`Updated item ${item.id}: quantity=${item.quantity}, originalQuantity=${item.originalQuantity}, extraQuantity=${extraQty}`);
        updated++;
      } catch (error) {
        console.error(`Error updating item ${item.id}:`, error);
        errors++;
      }
    }
    
    console.log(`Migration completed: Updated ${updated} items with ${errors} errors`);
    return { success: true, updated, errors };
  } catch (error) {
    console.error('Error during migration:', error);
    return { success: false, error };
  }
}

// Run the migration when this script is executed directly
const isMainModule = import.meta.url === `file://${process.argv[1]}`;
if (isMainModule) {
  updateRecentItems()
    .then((result) => {
      console.log('Migration result:', result);
      process.exit(0);
    })
    .catch((error) => {
      console.error('Unhandled error during migration:', error);
      process.exit(1);
    });
}

export { updateRecentItems };