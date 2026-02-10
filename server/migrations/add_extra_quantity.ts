import { eq } from 'drizzle-orm';
import { db } from '../db';
import { loadingOpItems } from '@shared/schema';
import { fileURLToPath } from 'url';

/**
 * Migration script to add the extraQuantity field to all existing load operation items
 * This will run through all items and calculate the extra quantity based on quantity and originalQuantity
 */
async function addExtraQuantityToItems() {
  console.log('Starting migration: Adding extraQuantity field to existing load operation items');
  
  try {
    // Get all load operation items
    const allItems = await db.select().from(loadingOpItems);
    console.log(`Found ${allItems.length} load operation items to update`);
    
    let updated = 0;
    let skipped = 0;
    let errors = 0;
    
    // Update each item with the calculated extraQuantity
    for (const item of allItems) {
      try {
        // Calculate extra quantity as the difference between quantity and originalQuantity
        // If quantity > originalQuantity, extra = quantity - originalQuantity
        // Otherwise, extra = 0
        const extraQty = (item.quantity !== null && item.originalQuantity !== null && 
                          item.quantity > item.originalQuantity) 
          ? item.quantity - item.originalQuantity 
          : 0;
        
        // Only update if we can calculate a valid extraQuantity
        if (item.quantity !== null && item.originalQuantity !== null) {
          await db.update(loadingOpItems)
            .set({ extraQuantity: extraQty })
            .where(eq(loadingOpItems.id, item.id));
          
          console.log(`Updated item ${item.id}: quantity=${item.quantity}, originalQuantity=${item.originalQuantity}, extraQuantity=${extraQty}`);
          updated++;
        } else {
          console.log(`Skipping item ${item.id}: Missing quantity or originalQuantity data`);
          skipped++;
        }
      } catch (itemError) {
        console.error(`Error updating item ${item.id}:`, itemError);
        errors++;
      }
    }
    
    console.log(`Migration completed: Updated ${updated} items, skipped ${skipped} items, encountered ${errors} errors`);
    return { updated, skipped, errors };
  } catch (error) {
    console.error('Migration failed:', error);
    throw error;
  }
}

// Execute the migration when the script is run directly
// Using ES modules pattern instead of CommonJS
const isMainModule = import.meta.url === `file://${process.argv[1]}`;
if (isMainModule) {
  addExtraQuantityToItems()
    .then((result) => {
      console.log('Migration completed successfully:', result);
      process.exit(0);
    })
    .catch((error) => {
      console.error('Migration failed:', error);
      process.exit(1);
    });
}

export { addExtraQuantityToItems };