import pg from 'pg';
import dotenv from 'dotenv';

// Load environment variables
dotenv.config();

const { Client } = pg;

// Function to change a user's ID with parameters
async function changeUserId(oldId, newId) {
  const client = new Client({
    connectionString: process.env.DATABASE_URL,
  });
  
  try {
    // Connect to the database
    await client.connect();
    console.log('Connected to database');
    
    // Start a transaction
    await client.query('BEGIN');
    
    // Check if the new ID is already in use
    const { rows: existingRows } = await client.query('SELECT id FROM users WHERE id = $1', [newId]);
    if (existingRows.length > 0) {
      throw new Error(`User with ID ${newId} already exists`);
    }
    
    // Get the current foreign key constraints
    const { rows: constraints } = await client.query(`
      SELECT 
        tc.constraint_name, 
        tc.table_name, 
        kcu.column_name, 
        ccu.table_name AS foreign_table_name, 
        ccu.column_name AS foreign_column_name
      FROM 
        information_schema.table_constraints AS tc 
        JOIN information_schema.key_column_usage AS kcu
          ON tc.constraint_name = kcu.constraint_name
          AND tc.table_schema = kcu.table_schema
        JOIN information_schema.constraint_column_usage AS ccu
          ON ccu.constraint_name = tc.constraint_name
          AND ccu.table_schema = tc.table_schema
      WHERE tc.constraint_type = 'FOREIGN KEY' 
        AND ccu.table_name = 'users'
        AND ccu.column_name = 'id';
    `);
    
    console.log('Foreign Key Constraints to update:');
    constraints.forEach(constraint => {
      console.log(`- Table: ${constraint.table_name}, Column: ${constraint.column_name}, Constraint: ${constraint.constraint_name}`);
    });
    
    // Temporarily disable all foreign key constraints
    await client.query('SET session_replication_role = replica');
    
    // Update the user's ID
    const { rowCount } = await client.query(
      'UPDATE users SET id = $1 WHERE id = $2',
      [newId, oldId]
    );
    
    if (rowCount === 0) {
      throw new Error(`No user found with ID ${oldId}`);
    }
    
    console.log(`Updated user ID from ${oldId} to ${newId}`);
    
    // Update references in all tables that have foreign keys to the users table
    for (const constraint of constraints) {
      console.log(`Updating references in ${constraint.table_name}.${constraint.column_name}`);
      
      const { rowCount } = await client.query(
        `UPDATE ${constraint.table_name} SET ${constraint.column_name} = $1 WHERE ${constraint.column_name} = $2`,
        [newId, oldId]
      );
      
      console.log(`- Updated ${rowCount} records`);
    }
    
    // Re-enable foreign key constraints
    await client.query('SET session_replication_role = DEFAULT');
    
    // Commit the transaction
    await client.query('COMMIT');
    
    console.log(`Successfully changed user ID from ${oldId} to ${newId}`);
    
    // Show updated user list
    const { rows: users } = await client.query(
      'SELECT id, username, name, role, department FROM users ORDER BY id'
    );
    
    console.log('\nUpdated Users:');
    console.log('ID | Username | Name | Role | Department');
    console.log('------------------------------------------');
    
    users.forEach(user => {
      console.log(`${user.id} | ${user.username} | ${user.name || 'N/A'} | ${user.role} | ${user.department || 'N/A'}`);
    });
    
  } catch (error) {
    // Rollback in case of error
    await client.query('ROLLBACK');
    console.error('Error changing user ID:', error.message);
  } finally {
    // Make sure constraints are re-enabled even if there's an error
    await client.query('SET session_replication_role = DEFAULT');
    
    // Close database connection
    await client.end();
    console.log('Database connection closed');
  }
}

// Arguments handling from command line
const args = process.argv.slice(2);
if (args.length !== 2) {
  console.error('Usage: node update_user_id.js <old_id> <new_id>');
  process.exit(1);
}

const oldId = parseInt(args[0]);
const newId = parseInt(args[1]);

if (isNaN(oldId) || isNaN(newId)) {
  console.error('Error: Both old_id and new_id must be numbers');
  process.exit(1);
}

// Run the ID change
changeUserId(oldId, newId);