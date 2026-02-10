import pg from 'pg';
import dotenv from 'dotenv';

// Load environment variables
dotenv.config();

const { Client } = pg;

async function swapUserData() {
  const client = new Client({
    connectionString: process.env.DATABASE_URL,
  });
  
  try {
    // Connect to the database
    await client.connect();
    console.log('Connected to database');
    
    // Start a transaction
    await client.query('BEGIN');
    
    // 1. Get user data
    const { rows: users } = await client.query(
      'SELECT * FROM users WHERE id IN (3, 9)'
    );
    
    if (users.length !== 2) {
      throw new Error('Not all users found. Expected users with IDs 3 and 9.');
    }
    
    // Find Yash and Dharmesh in the result set
    const yash = users.find(u => u.id === 3);
    const dharmesh = users.find(u => u.id === 9);
    
    if (!yash || !dharmesh) {
      throw new Error('Failed to find user data for IDs 3 or 9');
    }
    
    console.log('Found users to swap:');
    console.log(`ID 3: ${yash.name} (${yash.username}) - ${yash.role}`);
    console.log(`ID 9: ${dharmesh.name} (${dharmesh.username}) - ${dharmesh.role}`);
    
    // 2. Temporarily change the usernames to avoid unique constraint violations
    console.log('Temporarily updating usernames...');
    
    await client.query(
      'UPDATE users SET username = $1 WHERE id = 3',
      [yash.username + '_temp']
    );
    
    await client.query(
      'UPDATE users SET username = $1 WHERE id = 9',
      [dharmesh.username + '_temp']
    );
    
    // 3. Swap the user data between the two IDs (except for ID field)
    console.log('Swapping user data...');
    
    // Update user ID 3 with Dharmesh's data
    await client.query(`
      UPDATE users
      SET username = $1,
          pin = $2,
          first_name = $3,
          last_name = $4,
          name = $5,
          designation = $6,
          department = $7,
          access_type = $8,
          role = $9
      WHERE id = 3
    `, [
      dharmesh.username,
      dharmesh.pin,
      dharmesh.first_name,
      dharmesh.last_name,
      dharmesh.name,
      dharmesh.designation,
      dharmesh.department,
      dharmesh.access_type,
      dharmesh.role
    ]);
    
    // Update user ID 9 (which will become Yash) with a temp username
    // (we'll fix username collisions in the next step)
    await client.query(`
      UPDATE users
      SET username = $1,
          pin = $2,
          first_name = $3,
          last_name = $4,
          name = $5,
          designation = $6,
          department = $7,
          access_type = $8,
          role = $9
      WHERE id = 9
    `, [
      '_temp_username_',  // Temporary username
      yash.pin,
      yash.first_name,
      yash.last_name,
      yash.name,
      yash.designation,
      yash.department,
      yash.access_type,
      yash.role
    ]);
    
    // 4. Create a new user with ID 8 for Yash
    console.log('Creating new user ID 8 for Yash...');
    
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
      yash.username,
      yash.pin,
      yash.first_name,
      yash.last_name,
      yash.name,
      yash.designation,
      yash.department,
      yash.access_type,
      yash.role
    ]);
    
    // 5. Delete user with ID 9 (Yash's temp data)
    console.log('Removing temporary user ID 9...');
    await client.query('DELETE FROM users WHERE id = 9');
    
    // 6. Update references for Yash from ID 3 to ID 8
    console.log('Updating foreign key references from ID 3 to ID 8...');
    
    await client.query('UPDATE scan_history SET scanned_by_id = 8 WHERE scanned_by_id = 3');
    await client.query('UPDATE sales SET created_by_id = 8 WHERE created_by_id = 3');
    await client.query('UPDATE proforma_slips SET created_by_id = 8 WHERE created_by_id = 3');
    await client.query('UPDATE load_operations SET created_by_id = 8 WHERE created_by_id = 3');
    await client.query('UPDATE activities SET user_id = 8 WHERE user_id = 3');
    
    // Commit transaction
    await client.query('COMMIT');
    
    // Verify the changes
    const { rows: updatedUsers } = await client.query(
      'SELECT id, username, name, role FROM users WHERE id IN (3, 8) ORDER BY id'
    );
    
    console.log('\nUser data swap completed successfully!');
    console.log('Updated users:');
    updatedUsers.forEach(user => {
      console.log(`ID ${user.id}: ${user.name} (${user.username}) - ${user.role}`);
    });
    
  } catch (error) {
    // Rollback in case of error
    await client.query('ROLLBACK');
    console.error('Error during user data swap:', error.message);
  } finally {
    // Close database connection
    await client.end();
    console.log('Database connection closed');
  }
}

// Run the swap function
swapUserData();