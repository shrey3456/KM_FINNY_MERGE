/**
 * Script to run the migration to remove unnecessary columns from proforma_slip_items
 */

import { removeProformaColumns } from "./migrations/remove-proforma-columns";
import { db } from "./db";
import { sql } from "drizzle-orm";

// Define a function to run the migration to remove the columns
async function runMigration() {
  console.log('Starting proforma slip items column removal migration...');
  
  try {
    // Check if the columns exist before attempting to remove them
    const columnsResult = await db.execute(sql`
      SELECT column_name 
      FROM information_schema.columns 
      WHERE table_name = 'proforma_slip_items' 
      AND column_name IN ('original_quantity', 'extra_quantity', 'loaded_quantity', 'loaded')
    `);
    
    const columnsToRemove = columnsResult.rows.map((row: any) => row.column_name);
    
    if (columnsToRemove.length === 0) {
      console.log('No columns to remove. Migration already completed.');
      return { success: true };
    }
    
    console.log(`Found ${columnsToRemove.length} columns to remove: ${columnsToRemove.join(', ')}`);
    
    // Drop each column one by one
    for (const column of columnsToRemove) {
      console.log(`Dropping column ${column}...`);
      // We need to use raw SQL directly for a dynamic column name
      await db.execute(sql.raw(`ALTER TABLE proforma_slip_items DROP COLUMN IF EXISTS ${column}`));
    }
    
    console.log('All columns removed successfully.');
    return { success: true };
  } catch (error) {
    console.error('Error during migration:', error);
    return { success: false, error };
  }
}

// Run the migration
runMigration()
  .then((result) => {
    console.log('Migration result:', result);
    if (result.success) {
      console.log('Migration completed successfully.');
      process.exit(0);
    } else {
      console.error('Migration failed:', result.error);
      process.exit(1);
    }
  })
  .catch((error) => {
    console.error('Unexpected error during migration:', error);
    process.exit(1);
  });