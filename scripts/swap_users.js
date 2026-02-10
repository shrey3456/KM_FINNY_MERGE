import pg from 'pg';
import dotenv from 'dotenv';

// Load environment variables
dotenv.config();

const { Client } = pg;

async function swapUsers() {
  const client = new Client({
    connectionString: process.env.DATABASE_URL,
  });
  
  try {
    // Connect to the database
    await client.connect();
    console.log('Connected to database');
    
    // Start a transaction
    await client.query('BEGIN');
    
    // 1. First, check if all users exist
    const { rows: users } = await client.query(
      'SELECT id, username, name, role FROM users WHERE id IN (3, 9) ORDER BY id'
    );
    
    if (users.length !== 2) {
      throw new Error('Not all users found. Expected users with IDs 3 and 9.');
    }
    
    console.log('Found users:');
    users.forEach(user => {
      console.log(`ID ${user.id}: ${user.name} (${user.username}) - ${user.role}`);
    });
    
    // 2. Check if ID 8 is available
    const { rows: existingId8 } = await client.query('SELECT id FROM users WHERE id = 8');
    if (existingId8.length > 0) {
      throw new Error('User with ID 8 already exists. Cannot proceed with ID switch.');
    }
    
    // 3. Create a temporary user (ID 100) to avoid unique constraint on username
    console.log('Creating temporary user record for swapping...');
    
    // Get yash's data for the temporary record
    const { rows: yashData } = await client.query('SELECT * FROM users WHERE id = 3');
    if (yashData.length === 0) {
      throw new Error('Failed to get Yash\'s data');
    }
    
    // Create a temporary record with a modified username
    await client.query(`
      INSERT INTO users (
        id, username, pin, first_name, last_name, name, 
        designation, department, access_type, role
      )
      VALUES (
        100, $1, $2, $3, $4, $5, 
        $6, $7, $8, $9
      )
    `, [
      yashData[0].username + '_temp',
      yashData[0].pin,
      yashData[0].first_name,
      yashData[0].last_name,
      yashData[0].name,
      yashData[0].designation,
      yashData[0].department,
      yashData[0].access_type,
      yashData[0].role
    ]);
    
    // 4. Update foreign keys from ID 3 to temporary ID 100
    console.log('Updating foreign key references for Yash (3 -> 100)...');
    
    // Update references in all tables with foreign keys
    await client.query('UPDATE scan_history SET scanned_by_id = 100 WHERE scanned_by_id = 3');
    await client.query('UPDATE sales SET created_by_id = 100 WHERE created_by_id = 3');
    await client.query('UPDATE proforma_slips SET created_by_id = 100 WHERE created_by_id = 3');
    await client.query('UPDATE load_operations SET created_by_id = 100 WHERE created_by_id = 3');
    await client.query('UPDATE activities SET user_id = 100 WHERE user_id = 3');
    
    // 5. Move Dharmesh from ID 9 to ID 3
    console.log('Moving Dharmesh from ID 9 to ID 3...');
    
    // Get Dharmesh's data
    const { rows: dharmeshData } = await client.query('SELECT * FROM users WHERE id = 9');
    if (dharmeshData.length === 0) {
      throw new Error('Failed to get Dharmesh\'s data');
    }
    
    // Delete original Yash record
    await client.query('DELETE FROM users WHERE id = 3');
    
    // Create Dharmesh at ID 3
    await client.query(`
      INSERT INTO users (
        id, username, pin, first_name, last_name, name, 
        designation, department, access_type, role
      )
      VALUES (
        3, $1, $2, $3, $4, $5, 
        $6, $7, $8, $9
      )
    `, [
      dharmeshData[0].username,
      dharmeshData[0].pin,
      dharmeshData[0].first_name,
      dharmeshData[0].last_name,
      dharmeshData[0].name,
      dharmeshData[0].designation,
      dharmeshData[0].department,
      dharmeshData[0].access_type,
      dharmeshData[0].role
    ]);
    
    // 6. Update foreign keys from ID 9 to ID 3
    console.log('Updating foreign key references for Dharmesh (9 -> 3)...');
    
    await client.query('UPDATE scan_history SET scanned_by_id = 3 WHERE scanned_by_id = 9');
    await client.query('UPDATE sales SET created_by_id = 3 WHERE created_by_id = 9');
    await client.query('UPDATE proforma_slips SET created_by_id = 3 WHERE created_by_id = 9');
    await client.query('UPDATE load_operations SET created_by_id = 3 WHERE created_by_id = 9');
    await client.query('UPDATE activities SET user_id = 3 WHERE user_id = 9');
    
    // 7. Move Yash from temporary ID to ID 8
    console.log('Moving Yash from temporary ID 100 to ID 8...');
    
    // Delete Dharmesh's original record
    await client.query('DELETE FROM users WHERE id = 9');
    
    // Create Yash at ID 8
    await client.query(`
      INSERT INTO users (
        id, username, pin, first_name, last_name, name, 
        designation, department, access_type, role
      )
      VALUES (
        8, $1, $2, $3, $4, $5, 
        $6, $7, $8, $9
      )
    `, [
      yashData[0].username,
      yashData[0].pin,
      yashData[0].first_name,
      yashData[0].last_name,
      yashData[0].name,
      yashData[0].designation,
      yashData[0].department,
      yashData[0].access_type,
      yashData[0].role
    ]);
    
    // 8. Update foreign keys from temporary ID 100 to ID 8
    console.log('Updating foreign key references for Yash (100 -> 8)...');
    
    await client.query('UPDATE scan_history SET scanned_by_id = 8 WHERE scanned_by_id = 100');
    await client.query('UPDATE sales SET created_by_id = 8 WHERE created_by_id = 100');
    await client.query('UPDATE proforma_slips SET created_by_id = 8 WHERE created_by_id = 100');
    await client.query('UPDATE load_operations SET created_by_id = 8 WHERE created_by_id = 100');
    await client.query('UPDATE activities SET user_id = 8 WHERE user_id = 100');
    
    // 9. Delete temporary record
    console.log('Cleaning up temporary user record...');
    await client.query('DELETE FROM users WHERE id = 100');
    
    // Commit transaction
    await client.query('COMMIT');
    
    // Verify the changes
    const { rows: updatedUsers } = await client.query(
      'SELECT id, username, name, role FROM users WHERE id IN (3, 8) ORDER BY id'
    );
    
    console.log('\nUser swap completed successfully!');
    console.log('Updated users:');
    updatedUsers.forEach(user => {
      console.log(`ID ${user.id}: ${user.name} (${user.username}) - ${user.role}`);
    });
    
  } catch (error) {
    // Rollback in case of error
    await client.query('ROLLBACK');
    console.error('Error during user swap:', error.message);
  } finally {
    // Close database connection
    await client.end();
    console.log('Database connection closed');
  }
}

// Run the swap function
swapUsers();