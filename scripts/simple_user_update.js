import pg from 'pg';
import dotenv from 'dotenv';

// Load environment variables
dotenv.config();

const { Client } = pg;

// A simple function to update a user's name, designation, department, access_type and role
async function updateUser(userId, updates) {
  const client = new Client({
    connectionString: process.env.DATABASE_URL,
  });
  
  try {
    // Connect to the database
    await client.connect();
    console.log('Connected to database');
    
    // Check if user exists
    const { rows: existingUser } = await client.query('SELECT * FROM users WHERE id = $1', [userId]);
    if (existingUser.length === 0) {
      throw new Error(`No user found with ID ${userId}`);
    }
    
    // Print current user data
    console.log('Current user data:');
    console.log(existingUser[0]);
    
    // Prepare column and value lists for the query
    const updateFields = [];
    const values = [userId]; // First parameter will be the user ID
    let paramIndex = 2; // Start with $2 since $1 is the ID
    
    // Add each field to be updated
    for (const [field, value] of Object.entries(updates)) {
      if (value !== undefined) {
        updateFields.push(`"${field}" = $${paramIndex}`);
        values.push(value);
        paramIndex++;
      }
    }
    
    if (updateFields.length === 0) {
      console.log('No fields to update');
      return;
    }
    
    // Create the UPDATE query
    const updateQuery = `
      UPDATE users
      SET ${updateFields.join(', ')}
      WHERE id = $1
      RETURNING *
    `;
    
    // Execute the query
    const { rows: updatedUser } = await client.query(updateQuery, values);
    
    console.log('User updated successfully:');
    console.log(updatedUser[0]);
    
  } catch (error) {
    console.error('Error updating user:', error.message);
  } finally {
    // Close database connection
    await client.end();
    console.log('Database connection closed');
  }
}

// Arguments handling from command line
const args = process.argv.slice(2);
if (args.length < 1) {
  console.error('Usage: node simple_user_update.js <user_id> [field=value ...]');
  console.error('Example: node simple_user_update.js 1 name="John Doe" role=admin');
  process.exit(1);
}

const userId = parseInt(args[0]);
if (isNaN(userId)) {
  console.error('Error: user_id must be a number');
  process.exit(1);
}

// Parse the field=value arguments
const updates = {};
for (let i = 1; i < args.length; i++) {
  const match = args[i].match(/^([^=]+)=(.*)$/);
  if (match) {
    const [, field, value] = match;
    updates[field] = value;
  }
}

// Run the user update
updateUser(userId, updates);