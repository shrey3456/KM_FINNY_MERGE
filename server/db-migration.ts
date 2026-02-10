import { db } from './db';
import { sql } from 'drizzle-orm';
import { removeProformaColumns } from './migrations/remove-proforma-columns';

/**
 * This script runs the necessary database migrations:
 * 1. Add the extraQuantity column to the load_operations_items table
 * 2. Remove unnecessary columns from proforma_slip_items table
 */
async function runDbMigration() {
  console.log('Starting database schema migration...');

  try {
    // Step 1: Add extra_quantity column to load_operations_items if it doesn't exist
    console.log('Step 1: Checking for extra_quantity column...');
    const columns = await db.execute(sql`
      SELECT column_name 
      FROM information_schema.columns 
      WHERE table_name = 'load_operations_items' AND column_name = 'extra_quantity'
    `);
    
    if (columns.rows && columns.rows.length > 0) {
      console.log('Column extra_quantity already exists, skipping creation');
    } else {
      // Add the extra_quantity column if it doesn't exist
      await db.execute(sql`
        ALTER TABLE load_operations_items 
        ADD COLUMN extra_quantity INTEGER DEFAULT 0
      `);
      console.log('Successfully added extra_quantity column to load_operations_items table');
    }

    // Step 2: Remove unnecessary columns from proforma_slip_items
    console.log('Step 2: Removing unnecessary columns from proforma_slip_items...');
    await removeProformaColumns();

    console.log('Database schema migration completed successfully');
    return { success: true };
  } catch (error) {
    console.error('Error during database schema migration:', error);
    return { success: false, error };
  }
}

// Run the migration when this script is executed directly
const isMainModule = import.meta.url === `file://${process.argv[1]}`;
if (isMainModule) {
  runDbMigration()
    .then((result) => {
      console.log('Database migration result:', result);
      if (result.success) {
        process.exit(0);
      } else {
        process.exit(1);
      }
    })
    .catch((error) => {
      console.error('Unhandled error during database migration:', error);
      process.exit(1);
    });
}

export { runDbMigration };