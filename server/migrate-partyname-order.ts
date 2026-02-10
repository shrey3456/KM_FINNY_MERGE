import { db } from './db';
import { sql } from 'drizzle-orm';

/**
 * This script alters the column positions in the load_operations table
 * to put party_name and plant columns after reference_number column.
 * 
 * Note: PostgreSQL doesn't have a direct way to reorder columns, so this is 
 * for display purposes in the schema definition only.
 * 
 * Column positions don't affect functionality, but they do affect how
 * columns are displayed in database tools and query results.
 */
async function checkColumnsOrder() {
  try {
    console.log('Checking column order in load_operations table...');
    
    // Check if the columns exist in the right order
    const columnOrderResult = await db.execute(sql`
      SELECT column_name, ordinal_position
      FROM information_schema.columns 
      WHERE table_name = 'load_operations'
      ORDER BY ordinal_position;
    `);
    
    if (columnOrderResult.rows) {
      console.log('Current column order:');
      columnOrderResult.rows.forEach((row: any) => {
        console.log(`${row.ordinal_position}: ${row.column_name}`);
      });
    }
    
    console.log('\nNote: PostgreSQL doesn\'t actually support changing column order.');
    console.log('Column order has been changed in the schema definition (schema.ts).');
    console.log('This will be reflected in new applications but not in the existing database.');
    console.log('This script is informational only.');
    
    // Check that party_name and plant columns exist
    const partyNameExists = await db.execute(sql`
      SELECT column_name 
      FROM information_schema.columns 
      WHERE table_name = 'load_operations' AND column_name = 'party_name';
    `);
    
    if (!partyNameExists.rows || partyNameExists.rows.length === 0) {
      console.log('WARNING: party_name column does not exist in the database!');
    } else {
      console.log('✓ party_name column exists');
    }
    
    const plantExists = await db.execute(sql`
      SELECT column_name 
      FROM information_schema.columns 
      WHERE table_name = 'load_operations' AND column_name = 'plant';
    `);
    
    if (!plantExists.rows || plantExists.rows.length === 0) {
      console.log('WARNING: plant column does not exist in the database!');
    } else {
      console.log('✓ plant column exists');
    }
    
    // Verify that columns are populated
    const dataPopulated = await db.execute(sql`
      SELECT 
        COUNT(*) as total,
        COUNT(party_name) as with_party_name,
        COUNT(plant) as with_plant
      FROM load_operations;
    `);
    
    if (dataPopulated.rows && dataPopulated.rows.length > 0) {
      const stats = dataPopulated.rows[0];
      console.log(`\nData population stats:`);
      console.log(`Total records: ${stats.total}`);
      console.log(`Records with party_name: ${stats.with_party_name} (${Math.round(stats.with_party_name/stats.total*100)}%)`);
      console.log(`Records with plant: ${stats.with_plant} (${Math.round(stats.with_plant/stats.total*100)}%)`);
    }
    
    console.log('\nColumn checking completed successfully!');
  } catch (error) {
    console.error('Error checking columns:', error);
    throw error;
  }
}

// Run the check immediately
checkColumnsOrder()
  .then(() => {
    console.log('Column check completed successfully!');
    process.exit(0);
  })
  .catch((error) => {
    console.error('Column check failed:', error);
    process.exit(1);
  });

export default checkColumnsOrder;