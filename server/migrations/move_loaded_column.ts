import { pool } from "../db";

/**
 * Migration to move the loaded column in the load_operations_items table
 * to be placed beside the loaded_quantity column.
 */
export async function moveLoadedColumn() {
  console.log('Starting migration: moveLoadedColumn');
  
  try {
    // Since we can't directly reorder columns in PostgreSQL, we need to:
    // 1. Create a new table with the desired column order
    // 2. Copy data from the old table
    // 3. Drop the old table
    // 4. Rename the new table to the original name
    
    const client = await pool.connect();
    
    try {
      // Start a transaction
      await client.query('BEGIN');
      
      console.log('Creating new table with desired column order...');
      
      // Create the new table with the desired column order
      await client.query(`
        CREATE TABLE load_operations_items_new (
          id SERIAL PRIMARY KEY,
          load_operations_id INTEGER REFERENCES load_operations(id),
          product_id INTEGER REFERENCES products(id),
          quantity INTEGER DEFAULT 0,
          original_quantity INTEGER,
          extra_quantity INTEGER DEFAULT 0,
          loaded_quantity INTEGER DEFAULT 0,
          created_at TIMESTAMP DEFAULT NOW(),
          loaded BOOLEAN DEFAULT false,
          sr_no TEXT,
          barcode TEXT,
          item_name TEXT,
          sr_no_display TEXT
        )
      `);
      
      console.log('Copying data from old table to new table...');
      
      // Copy data from old table to new table
      await client.query(`
        INSERT INTO load_operations_items_new (
          id, 
          load_operations_id, 
          product_id, 
          quantity, 
          original_quantity, 
          extra_quantity,
          loaded_quantity,
          created_at,
          loaded, 
          sr_no, 
          barcode, 
          item_name, 
          sr_no_display
        )
        SELECT 
          id, 
          load_operations_id, 
          product_id, 
          quantity, 
          original_quantity, 
          extra_quantity,
          loaded_quantity,
          created_at,
          loaded, 
          sr_no, 
          barcode, 
          item_name, 
          sr_no_display
        FROM load_operations_items
      `);
      
      console.log('Setting up sequence for new table...');
      
      // Get current sequence value and set it for the new table
      const seqResult = await client.query(`
        SELECT setval('load_operations_items_new_id_seq', 
          (SELECT COALESCE(MAX(id), 0) FROM load_operations_items_new), true)
      `);
      
      console.log('Dropping old table...');
      
      // Drop the old table
      await client.query('DROP TABLE load_operations_items');
      
      console.log('Renaming new table to original name...');
      
      // Rename the new table to the original name
      await client.query('ALTER TABLE load_operations_items_new RENAME TO load_operations_items');
      
      // Rename the sequence
      await client.query('ALTER SEQUENCE load_operations_items_new_id_seq RENAME TO load_operations_items_id_seq');
      
      // Commit the transaction
      await client.query('COMMIT');
      
      console.log('Migration completed successfully.');
      return { 
        success: true, 
        message: 'Successfully moved loaded column beside loaded_quantity column in load_operations_items table' 
      };
      
    } catch (error) {
      // Rollback the transaction in case of error
      await client.query('ROLLBACK');
      console.error('Error in migration:', error);
      throw error;
    } finally {
      // Release the client back to the pool
      client.release();
    }
    
  } catch (error) {
    console.error('Error in migration:', error);
    return { 
      success: false, 
      error: error instanceof Error ? error.message : String(error)
    };
  }
}

// For direct execution from command line
const isMainModule = import.meta.url === `file://${process.argv[1]}`;
if (isMainModule) {
  moveLoadedColumn()
    .then((result) => {
      console.log('Migration result:', result);
      process.exit(result.success ? 0 : 1);
    })
    .catch((error) => {
      console.error('Unhandled error during migration:', error);
      process.exit(1);
    });
}