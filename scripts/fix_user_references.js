import pg from 'pg';
import dotenv from 'dotenv';

// Load environment variables
dotenv.config();

const { Client } = pg;

// Main function to fix user references
async function fixUserReferences() {
  // Create PostgreSQL client
  const client = new Client({
    connectionString: process.env.DATABASE_URL,
  });

  try {
    // Connect to the database
    await client.connect();
    console.log('Connected to database');
    
    // Check if admin user (id=1) exists
    const checkAdminResult = await client.query('SELECT * FROM users WHERE id = 1');
    if (checkAdminResult.rowCount === 0) {
      console.error('Admin user (ID 1) not found. Cannot proceed with reference fix.');
      return;
    }
    
    console.log('Found admin user:', checkAdminResult.rows[0]);
    
    // Update all references to user ID 2 to point to user ID 1 instead
    // This includes:
    // 1. scan_history.scanned_by_id
    // 2. sales.created_by_id
    // 3. proforma_slips.created_by_id
    // 4. load_operations.created_by_id
    // 5. activities.user_id
    
    // Update scan_history
    const scanHistoryResult = await client.query(
      'UPDATE scan_history SET scanned_by_id = 1 WHERE scanned_by_id = 2'
    );
    console.log(`Updated ${scanHistoryResult.rowCount} records in scan_history`);
    
    // Update sales
    const salesResult = await client.query(
      'UPDATE sales SET created_by_id = 1 WHERE created_by_id = 2'
    );
    console.log(`Updated ${salesResult.rowCount} records in sales`);
    
    // Update proforma_slips
    const proformaResult = await client.query(
      'UPDATE proforma_slips SET created_by_id = 1 WHERE created_by_id = 2'
    );
    console.log(`Updated ${proformaResult.rowCount} records in proforma_slips`);
    
    // Update load_operations
    const loadOpsResult = await client.query(
      'UPDATE load_operations SET created_by_id = 1 WHERE created_by_id = 2'
    );
    console.log(`Updated ${loadOpsResult.rowCount} records in load_operations`);
    
    // Update activities
    const activitiesResult = await client.query(
      'UPDATE activities SET user_id = 1 WHERE user_id = 2'
    );
    console.log(`Updated ${activitiesResult.rowCount} records in activities`);
    
    console.log('All references to user ID 2 have been updated to point to user ID 1');
    
  } catch (error) {
    console.error('Error fixing user references:', error);
  } finally {
    // Close database connection
    await client.end();
    console.log('Database connection closed');
  }
}

// Run the fix function
fixUserReferences();