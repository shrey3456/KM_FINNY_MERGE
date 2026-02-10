/**
 * Migration script to remove columns from proforma_slip_items table
 * that are no longer needed since the data is now tracked in load_operations_items
 * 
 * This removes:
 * - originalQuantity
 * - extraQuantity
 * - loadedQuantity
 * - loaded
 */

import { db, pool } from "../db";
import { proformaSlipItems } from "@shared/schema";
import { eq } from "drizzle-orm";

export async function removeProformaColumns() {
  console.log('Starting migration: removeProformaColumns - removing unnecessary columns from proforma_slip_items');
  
  try {
    const client = await pool.connect();
    
    try {
      // Start a transaction
      await client.query('BEGIN');
      
      console.log('Checking if columns exist before dropping...');
      
      // Check if the columns exist first
      const columnsResult = await client.query(`
        SELECT column_name FROM information_schema.columns 
        WHERE table_name = 'proforma_slip_items' 
        AND column_name IN ('original_quantity', 'extra_quantity', 'loaded_quantity', 'loaded')
      `);
      
      const columnsToRemove = columnsResult.rows.map(row => row.column_name);
      
      if (columnsToRemove.length === 0) {
        console.log('No columns to remove. Migration already completed.');
        await client.query('COMMIT');
        return;
      }
      
      console.log(`Found ${columnsToRemove.length} columns to remove: ${columnsToRemove.join(', ')}`);
      
      // Drop each column one by one
      for (const column of columnsToRemove) {
        console.log(`Dropping column ${column}...`);
        await client.query(`ALTER TABLE proforma_slip_items DROP COLUMN IF EXISTS ${column}`);
      }
      
      // Commit the transaction
      await client.query('COMMIT');
      console.log('Migration completed successfully.');
    } catch (error) {
      // Rollback the transaction in case of error
      await client.query('ROLLBACK');
      console.error('Error during migration:', error);
      throw error;
    } finally {
      // Release the client back to the pool
      client.release();
    }
  } catch (error) {
    console.error('Failed to connect to database:', error);
    throw error;
  }
}

// For running directly with ES modules (using import.meta.url)
const isMainModule = import.meta.url.endsWith(process.argv[1].replace(/^file:\/\//, ''));
if (isMainModule) {
  removeProformaColumns()
    .then(() => {
      console.log('Migration completed.');
      process.exit(0);
    })
    .catch(error => {
      console.error('Migration failed:', error);
      process.exit(1);
    });
}