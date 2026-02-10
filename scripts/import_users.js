import csvParser from 'csv-parser';
import fs from 'fs';
import { createReadStream } from 'fs';
import pg from 'pg';
import dotenv from 'dotenv';
import { scrypt, randomBytes } from 'crypto';
import { promisify } from 'util';

// Load environment variables
dotenv.config();

const { Client } = pg;
const scryptAsync = promisify(scrypt);

// Function to hash a PIN
async function hashPin(pin) {
  const salt = randomBytes(16).toString('hex');
  const buf = (await scryptAsync(pin, salt, 64));
  return `${buf.toString('hex')}.${salt}`;
}

// Function to parse CSV
async function parseCSV(filePath) {
  return new Promise((resolve, reject) => {
    const results = [];
    createReadStream(filePath)
      .pipe(csvParser())
      .on('data', (data) => results.push(data))
      .on('end', () => resolve(results))
      .on('error', (error) => reject(error));
  });
}

// Main function to import users
async function importUsers() {
  // Create PostgreSQL client
  const client = new Client({
    connectionString: process.env.DATABASE_URL,
  });

  try {
    // Connect to the database
    await client.connect();
    console.log('Connected to database');
    
    // Parse users CSV
    const users = await parseCSV('./attached_assets/users.csv');
    console.log(`Found ${users.length} users in CSV file`);
    
    // Clear existing users except id 1 (admin)
    await client.query('DELETE FROM users WHERE id != 1');
    console.log('Cleared existing users (except admin user)');
    
    // Process each user
    for (const user of users) {
      try {
        // Hash the PIN for secure storage
        const hashedPin = await hashPin(user.pin);
        
        // Prepare column and value lists for the query
        const columns = [];
        const values = [];
        const placeholders = [];
        let counter = 1;
        
        // Manually map columns for the insert
        const columnMapping = {
          'id': 'id',
          'username': 'username',
          'pin': 'pin',
          'first_name': 'first_name', 
          'last_name': 'last_name',
          'name': 'name',
          'designation': 'designation',
          'department': 'department',
          'access_type': 'access_type',
          'role': 'role'
          // page_permissions is not in our database schema
        };
        
        // Add each field to the query
        for (const [csvColumn, dbColumn] of Object.entries(columnMapping)) {
          if (csvColumn in user) {
            columns.push(`"${dbColumn}"`);
            
            // Handle PIN specially to use the hashed value
            if (csvColumn === 'pin') {
              values.push(hashedPin);
            } else {
              values.push(user[csvColumn]);
            }
            
            placeholders.push(`$${counter++}`);
          }
        }
        
        // Create the INSERT query
        const insertQuery = `
          INSERT INTO users (${columns.join(', ')})
          VALUES (${placeholders.join(', ')})
          ON CONFLICT (id) DO UPDATE
          SET ${columns.map((col, i) => `${col} = $${i + 1}`).join(', ')}
        `;
        
        // Execute the query
        await client.query(insertQuery, values);
        console.log(`Imported user: ${user.name || user.username} (ID: ${user.id})`);
      } catch (error) {
        console.error(`Error importing user ${user.id} (${user.username}):`, error.message);
      }
    }
    
    console.log('User import completed successfully');
    
  } catch (error) {
    console.error('Error during user import:', error);
  } finally {
    // Close database connection
    await client.end();
    console.log('Database connection closed');
  }
}

// Run the import function
importUsers();