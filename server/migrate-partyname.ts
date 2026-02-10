import { db } from './db';
import { sql } from 'drizzle-orm';

/**
 * This script adds the party_name column to the load_operations table and 
 * populates it with party names from corresponding proforma slips.
 */
async function addPartyNameColumn() {
  console.log('Starting party_name column migration for load_operations...');

  try {
    // Check if party_name column already exists to avoid errors
    const columns = await db.execute(sql`
      SELECT column_name 
      FROM information_schema.columns 
      WHERE table_name = 'load_operations' AND column_name = 'party_name'
    `);
    
    if (columns.rows && columns.rows.length > 0) {
      console.log('Column party_name already exists in load_operations table, skipping creation');
    } else {
      // Add the party_name column if it doesn't exist
      await db.execute(sql`
        ALTER TABLE load_operations 
        ADD COLUMN party_name TEXT
      `);
      console.log('Successfully added party_name column to load_operations table');
      
      // Count operations with null party_name
      const countResult = await db.execute(sql`
        SELECT COUNT(*) FROM load_operations WHERE party_name IS NULL
      `);
      console.log(`Found ${countResult.rows[0].count} load operations with null party_name`);
      
      // Update party_name from corresponding proforma slips
      console.log('Updating party_name values from proforma slips...');
      const updateResult = await db.execute(sql`
        UPDATE load_operations lo
        SET party_name = ps.party_name
        FROM proforma_slips ps
        WHERE lo.reference_number = ps.order_number
        AND lo.party_name IS NULL
      `);
      console.log('Party name update completed');
      
      // Count remaining operations with null party_name
      const remainingNullCount = await db.execute(sql`
        SELECT COUNT(*) FROM load_operations WHERE party_name IS NULL
      `);
      console.log(`Remaining load operations with null party_name: ${remainingNullCount.rows[0].count}`);
      
      // Set default value for any remaining null party_name fields
      await db.execute(sql`
        UPDATE load_operations
        SET party_name = 'Unknown'
        WHERE party_name IS NULL
      `);
      console.log('Set "Unknown" for any remaining null party name values');
    }

    console.log('Party name migration completed successfully');
  } catch (error) {
    console.error('Error during party_name migration:', error);
  }
}

// Run the migration
addPartyNameColumn()
  .then(() => {
    console.log('Migration finished');
    process.exit(0);
  })
  .catch(error => {
    console.error('Migration failed:', error);
    process.exit(1);
  });