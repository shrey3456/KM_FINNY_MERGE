import pg from 'pg';
import dotenv from 'dotenv';
import readline from 'readline';

// Load environment variables
dotenv.config();

const { Client } = pg;

// Create a readline interface for user interaction
const rl = readline.createInterface({
  input: process.stdin,
  output: process.stdout
});

// Function to list all users
async function listUsers(client) {
  try {
    const { rows } = await client.query('SELECT id, username, name, designation, department, role FROM users ORDER BY id');
    
    console.log('\nCurrent Users:');
    console.log('ID | Username | Name | Role | Department');
    console.log('------------------------------------------');
    
    rows.forEach(user => {
      console.log(`${user.id} | ${user.username} | ${user.name || 'N/A'} | ${user.role} | ${user.department || 'N/A'}`);
    });
    
    return rows;
  } catch (error) {
    console.error('Error listing users:', error.message);
    return [];
  }
}

// Function to check for foreign key constraints
async function checkForeignKeyConstraints(client) {
  try {
    const { rows } = await client.query(`
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
    
    if (rows.length > 0) {
      console.log('\nForeign Key Constraints to consider:');
      rows.forEach(constraint => {
        console.log(`- Table: ${constraint.table_name}, Column: ${constraint.column_name}, Constraint: ${constraint.constraint_name}`);
      });
    }
    
    return rows;
  } catch (error) {
    console.error('Error checking foreign key constraints:', error.message);
    return [];
  }
}

// Function to change a user's ID
async function changeUserId(client, oldId, newId) {
  // Start a transaction
  await client.query('BEGIN');
  
  try {
    // Check if the new ID is already in use
    const { rows: existingRows } = await client.query('SELECT id FROM users WHERE id = $1', [newId]);
    if (existingRows.length > 0) {
      throw new Error(`User with ID ${newId} already exists`);
    }
    
    // Get the current foreign key constraints
    const constraints = await checkForeignKeyConstraints(client);
    
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
    
    // Update references in all tables that have foreign keys to the users table
    for (const constraint of constraints) {
      console.log(`Updating references in ${constraint.table_name}.${constraint.column_name}`);
      
      await client.query(
        `UPDATE ${constraint.table_name} SET ${constraint.column_name} = $1 WHERE ${constraint.column_name} = $2`,
        [newId, oldId]
      );
    }
    
    // Re-enable foreign key constraints
    await client.query('SET session_replication_role = DEFAULT');
    
    // Commit the transaction
    await client.query('COMMIT');
    
    console.log(`Successfully changed user ID from ${oldId} to ${newId}`);
    return true;
  } catch (error) {
    // Rollback in case of error
    await client.query('ROLLBACK');
    console.error('Error changing user ID:', error.message);
    return false;
  } finally {
    // Make sure constraints are re-enabled even if there's an error
    await client.query('SET session_replication_role = DEFAULT');
  }
}

// Function to prompt for input
function prompt(question) {
  return new Promise((resolve) => {
    rl.question(question, (answer) => {
      resolve(answer);
    });
  });
}

// Main function
async function main() {
  const client = new Client({
    connectionString: process.env.DATABASE_URL,
  });
  
  try {
    // Connect to the database
    await client.connect();
    console.log('Connected to database');
    
    // List all users
    const users = await listUsers(client);
    
    // Check for foreign key constraints
    await checkForeignKeyConstraints(client);
    
    // Prompt user for old ID
    const oldId = await prompt('\nEnter the current ID of the user you want to change: ');
    
    // Validate old ID
    const oldIdNum = parseInt(oldId);
    if (isNaN(oldIdNum)) {
      console.error('Error: ID must be a number');
      await cleanup(client);
      return;
    }
    
    // Check if user exists
    const userExists = users.some(user => user.id === oldIdNum);
    if (!userExists) {
      console.error(`Error: No user found with ID ${oldIdNum}`);
      await cleanup(client);
      return;
    }
    
    // Prompt for new ID
    const newId = await prompt('Enter the new ID for this user: ');
    
    // Validate new ID
    const newIdNum = parseInt(newId);
    if (isNaN(newIdNum)) {
      console.error('Error: ID must be a number');
      await cleanup(client);
      return;
    }
    
    // Confirm the change
    const answer = await prompt(`Are you sure you want to change user ID from ${oldIdNum} to ${newIdNum}? (y/n): `);
    
    if (answer.toLowerCase() === 'y') {
      // Change the user ID
      const success = await changeUserId(client, oldIdNum, newIdNum);
      
      if (success) {
        // List updated users
        await listUsers(client);
      }
    } else {
      console.log('Operation cancelled');
    }
    
    await cleanup(client);
  } catch (error) {
    console.error('Error:', error);
    await cleanup(client);
  }
}

// Cleanup function
async function cleanup(client) {
  try {
    await client.end();
    console.log('Database connection closed');
    rl.close();
  } catch (error) {
    console.error('Error during cleanup:', error);
  }
}

// Run the main function
main();