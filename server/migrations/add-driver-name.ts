/**
 * Migration script to add driver_name column to load_operations table
 * for complete independence from proforma slips
 */

import { db } from "../db";
import { sql } from "drizzle-orm";

export async function addDriverNameColumn() {
  console.log('Starting migration: addDriverNameColumn - adding driver_name column to load_operations table');
  
  try {
    // Check if the column already exists
    const columnsResult = await db.execute(sql`
      SELECT column_name FROM information_schema.columns 
      WHERE table_name = 'load_operations' 
      AND column_name = 'driver_name'
    `);
    
    if (columnsResult.rows && columnsResult.rows.length > 0) {
      console.log('Column driver_name already exists, skipping creation');
      return { success: true };
    }
    
    // Add the driver_name column
    await db.execute(sql.raw(`ALTER TABLE load_operations ADD COLUMN driver_name TEXT`));
    console.log('Successfully added driver_name column to load_operations table');
    
    return { success: true };
  } catch (error) {
    console.error('Error during migration:', error);
    return { success: false, error };
  }
}

// For running directly with ES modules (using import.meta.url)
const isMainModule = import.meta.url.endsWith(process.argv[1].replace(/^file:\/\//, ''));
if (isMainModule) {
  addDriverNameColumn()
    .then((result) => {
      console.log('Migration completed:', result);
      process.exit(result.success ? 0 : 1);
    })
    .catch(error => {
      console.error('Migration failed:', error);
      process.exit(1);
    });
}