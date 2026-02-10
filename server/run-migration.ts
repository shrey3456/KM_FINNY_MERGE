import { addExtraQuantityToItems } from './migrations/add_extra_quantity';
import { reorderExtraQuantityColumn } from './migrations/reorder_extra_quantity';
import { run as addExtraQuantityProforma } from './migrations/add_extra_quantity_proforma';
import { updateRecentProformaItems } from './migration-recent-proforma';

/**
 * Script to run database migrations
 * This is useful for applying schema changes to the database in production
 */
async function runMigrations() {
  console.log('Starting database migrations...');
  
  try {
    // Run the migration to add extraQuantity field to load operation items
    console.log('Running migration: addExtraQuantityToItems');
    const extraQuantityResult = await addExtraQuantityToItems();
    console.log('Migration completed successfully:', extraQuantityResult);
    
    // Run the migration to reorder the extraQuantity column
    console.log('Running migration: reorderExtraQuantityColumn');
    const reorderResult = await reorderExtraQuantityColumn();
    console.log('Migration completed successfully:', reorderResult);
    
    // Run the migration to add extraQuantity field to proforma slip items
    console.log('Running migration: addExtraQuantityProforma');
    const proformaExtraQuantityResult = await addExtraQuantityProforma();
    console.log('Migration completed successfully:', proformaExtraQuantityResult);
    
    // Run the migration to populate extraQuantity values in proforma slip items
    console.log('Running migration: updateRecentProformaItems');
    const proformaUpdateResult = await updateRecentProformaItems();
    console.log('Migration completed successfully:', proformaUpdateResult);
    
    // Add other migrations here as needed
    
    console.log('All migrations completed successfully');
    return { success: true };
  } catch (error) {
    console.error('Error running migrations:', error);
    return { success: false, error };
  }
}

// Run the migrations when this script is executed directly
// Using ES modules pattern instead of CommonJS
const isMainModule = import.meta.url === `file://${process.argv[1]}`;
if (isMainModule) {
  runMigrations()
    .then((result) => {
      console.log('Migration process completed with result:', result);
      if (result.success) {
        process.exit(0);
      } else {
        process.exit(1);
      }
    })
    .catch((error) => {
      console.error('Unhandled error during migration process:', error);
      process.exit(1);
    });
}

export { runMigrations };