import pg from 'pg';
import dotenv from 'dotenv';

// Load environment variables
dotenv.config();

const { Client } = pg;

async function swapUserIds() {
  const client = new Client({
    connectionString: process.env.DATABASE_URL,
  });
  
  try {
    // Connect to the database
    await client.connect();
    console.log('Connected to database');
    
    // Start a transaction
    await client.query('BEGIN');
    
    // 1. Check if users exist
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
      throw new Error('User with ID 8 already exists. Cannot proceed with ID swap.');
    }
    
    // Store original data
    const yashData = users.find(u => u.id === 3);
    const dharmeshData = users.find(u => u.id === 9);
    
    if (!yashData || !dharmeshData) {
      throw new Error('Unable to find user data for Yash (ID 3) or Dharmesh (ID 9)');
    }
    
    // 3. First change the usernames to avoid unique constraint issues
    console.log('Temporarily changing usernames to avoid conflicts...');
    
    await client.query(
      'UPDATE users SET username = $1 WHERE id = 3',
      [yashData.username + '_temp']
    );
    
    await client.query(
      'UPDATE users SET username = $1 WHERE id = 9',
      [dharmeshData.username + '_temp']
    );
    
    // 4. Get full user data for both users
    const { rows: fullYashData } = await client.query('SELECT * FROM users WHERE id = 3');
    const { rows: fullDharmeshData } = await client.query('SELECT * FROM users WHERE id = 9');
    
    if (fullYashData.length === 0 || fullDharmeshData.length === 0) {
      throw new Error('Failed to get complete user data');
    }
    
    // 5. Update references for both users (changing all foreign keys)
    console.log('Updating foreign key references...');
    
    // Update all foreign keys referring to Yash (ID 3) to a temporary high ID (999)
    await client.query('UPDATE scan_history SET scanned_by_id = 999 WHERE scanned_by_id = 3');
    await client.query('UPDATE sales SET created_by_id = 999 WHERE created_by_id = 3');
    await client.query('UPDATE proforma_slips SET created_by_id = 999 WHERE created_by_id = 3');
    await client.query('UPDATE load_operations SET created_by_id = 999 WHERE created_by_id = 3');
    await client.query('UPDATE activities SET user_id = 999 WHERE user_id = 3');
    
    // 6. Now move Dharmesh to ID 3 (after references are updated)
    console.log('Moving Dharmesh from ID 9 to ID 3...');
    
    // Delete Yash's record
    await client.query('DELETE FROM users WHERE id = 3');
    
    // Insert Dharmesh with ID 3 but temporary username
    const dharmeshFields = Object.keys(fullDharmeshData[0]).filter(k => k !== 'id').map(k => `"${k}"`).join(', ');
    const dharmeshPlaceholders = Object.keys(fullDharmeshData[0]).filter(k => k !== 'id').map((_, i) => `$${i + 1}`).join(', ');
    const dharmeshValues = Object.entries(fullDharmeshData[0]).filter(([k]) => k !== 'id').map(([_, v]) => v);
    
    await client.query(
      `INSERT INTO users (id, ${dharmeshFields}) VALUES (3, ${dharmeshPlaceholders})`,
      dharmeshValues
    );
    
    // 7. Create Yash with ID 8
    console.log('Moving Yash from ID 3 to ID 8...');
    
    // Insert Yash with ID 8 but temporary username
    const yashFields = Object.keys(fullYashData[0]).filter(k => k !== 'id').map(k => `"${k}"`).join(', ');
    const yashPlaceholders = Object.keys(fullYashData[0]).filter(k => k !== 'id').map((_, i) => `$${i + 1}`).join(', ');
    const yashValues = Object.entries(fullYashData[0]).filter(([k]) => k !== 'id').map(([_, v]) => v);
    
    await client.query(
      `INSERT INTO users (id, ${yashFields}) VALUES (8, ${yashPlaceholders})`,
      yashValues
    );
    
    // 8. Now delete Dharmesh's old record
    await client.query('DELETE FROM users WHERE id = 9');
    
    // 9. Update all references back
    console.log('Updating foreign key references to point to new IDs...');
    
    // Update references for Dharmesh from ID 9 to ID 3
    await client.query('UPDATE scan_history SET scanned_by_id = 3 WHERE scanned_by_id = 9');
    await client.query('UPDATE sales SET created_by_id = 3 WHERE created_by_id = 9');
    await client.query('UPDATE proforma_slips SET created_by_id = 3 WHERE created_by_id = 9');
    await client.query('UPDATE load_operations SET created_by_id = 3 WHERE created_by_id = 9');
    await client.query('UPDATE activities SET user_id = 3 WHERE user_id = 9');
    
    // Update references for Yash from temporary ID 999 to ID 8
    await client.query('UPDATE scan_history SET scanned_by_id = 8 WHERE scanned_by_id = 999');
    await client.query('UPDATE sales SET created_by_id = 8 WHERE created_by_id = 999');
    await client.query('UPDATE proforma_slips SET created_by_id = 8 WHERE created_by_id = 999');
    await client.query('UPDATE load_operations SET created_by_id = 8 WHERE created_by_id = 999');
    await client.query('UPDATE activities SET user_id = 8 WHERE user_id = 999');
    
    // 10. Now restore the original usernames
    console.log('Restoring original usernames...');
    
    await client.query(
      'UPDATE users SET username = $1 WHERE id = 3',
      [dharmeshData.username]
    );
    
    await client.query(
      'UPDATE users SET username = $1 WHERE id = 8',
      [yashData.username]
    );
    
    // Commit transaction
    await client.query('COMMIT');
    
    // 11. Verify the changes
    const { rows: updatedUsers } = await client.query(
      'SELECT id, username, name, role FROM users WHERE id IN (3, 8) ORDER BY id'
    );
    
    console.log('\nUser ID swap completed successfully!');
    console.log('Updated users:');
    updatedUsers.forEach(user => {
      console.log(`ID ${user.id}: ${user.name} (${user.username}) - ${user.role}`);
    });
    
  } catch (error) {
    // Rollback in case of error
    await client.query('ROLLBACK');
    console.error('Error during user ID swap:', error.message);
  } finally {
    // Close database connection
    await client.end();
    console.log('Database connection closed');
  }
}

// Run the swap function
swapUserIds();