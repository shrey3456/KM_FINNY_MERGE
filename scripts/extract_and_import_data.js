import fs from 'fs';
import path from 'path';
import pg from 'pg';
const { Client } = pg;
import { Transform } from 'stream';
import readline from 'readline';
import { fileURLToPath } from 'url';
import dotenv from 'dotenv';

// Load environment variables
dotenv.config();

// Get the directory name
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Connect to the database
const client = new Client({
  connectionString: process.env.DATABASE_URL,
});

// Function to extract data from the SQL dump
async function extractAndImportData() {
  try {
    await client.connect();
    console.log('Connected to database');

    // Clear all tables first
    await clearAllTables();
    
    // Reset sequences
    await resetSequences();

    // Path to the SQL dump file
    const dumpFilePath = path.join(__dirname, '..', 'attached_assets', 'database_backup.sql');
    
    // Create a read stream for the SQL file
    const fileStream = fs.createReadStream(dumpFilePath);
    const rl = readline.createInterface({
      input: fileStream,
      crlfDelay: Infinity
    });

    let currentTable = '';
    let copySection = false;
    let copyData = [];
    let columnNames = [];
    
    // Process the file line by line
    for await (const line of rl) {
      // Check if it's the start of a COPY statement
      if (line.startsWith('COPY public.')) {
        const match = line.match(/COPY public\.(\w+)/);
        if (match) {
          currentTable = match[1];
          copySection = true;
          copyData = [];
          
          // Extract column names
          const columnsMatch = line.match(/COPY public\.\w+ \(([^)]+)\)/);
          if (columnsMatch) {
            columnNames = columnsMatch[1].split(', ');
          }
          
          console.log(`Processing table: ${currentTable}`);
          continue;
        }
      }
      
      // Check if it's the end of a COPY section
      if (line === '\\.' && copySection) {
        console.log(`Importing data for ${currentTable}...`);
        await importTableData(currentTable, columnNames, copyData);
        copySection = false;
        continue;
      }
      
      // Collect data lines within a COPY section
      if (copySection && line !== '\\.' && !line.startsWith('COPY')) {
        copyData.push(line);
      }
    }

    console.log('Data extraction and import completed');
  } catch (err) {
    console.error('Error:', err);
  } finally {
    await client.end();
  }
}

// Function to clear all tables
async function clearAllTables() {
  try {
    // Get all tables in the public schema
    const tablesResult = await client.query(`
      SELECT tablename FROM pg_tables 
      WHERE schemaname = 'public' AND 
      tablename != 'users'`); // Skip users table to keep admin user
    
    const tables = tablesResult.rows.map(row => row.tablename);
    
    if (tables.length > 0) {
      // Skip the replication role settings due to permissions
      
      // Clear tables 
      console.log('Clearing all tables...');
      for (const table of tables) {
        try {
          await client.query(`DELETE FROM "${table}";`);
          console.log(`Cleared table: ${table}`);
        } catch (tableErr) {
          console.log(`Warning: Could not clear table ${table}, skipping: ${tableErr.message}`);
          // Continue with other tables
        }
      }
    }
  } catch (err) {
    console.error('Error clearing tables:', err);
    console.log('Will continue with import anyway...');
    // Don't throw - continue with import
  }
}

// Function to reset all sequences to 1
async function resetSequences() {
  try {
    // Get all sequences in the public schema
    const sequencesResult = await client.query(`
      SELECT c.relname as sequence_name
      FROM pg_class c
      JOIN pg_namespace n ON n.oid = c.relnamespace
      WHERE c.relkind = 'S' AND n.nspname = 'public';
    `);
    
    const sequences = sequencesResult.rows.map(row => row.sequence_name);
    
    if (sequences.length > 0) {
      console.log('Resetting sequences...');
      for (const sequence of sequences) {
        try {
          await client.query(`ALTER SEQUENCE "${sequence}" RESTART WITH 1;`);
          console.log(`Reset sequence: ${sequence}`);
        } catch (seqErr) {
          console.log(`Warning: Could not reset sequence ${sequence}, skipping: ${seqErr.message}`);
          // Continue with other sequences
        }
      }
    }
  } catch (err) {
    console.error('Error resetting sequences:', err);
    console.log('Will continue with import anyway...');
    // Don't throw - continue with import
  }
}

// Function to import data for a specific table
async function importTableData(tableName, columnNames, data) {
  if (data.length === 0) {
    console.log(`No data to import for ${tableName}`);
    return;
  }

  // Skip users table to preserve our admin user
  if (tableName === 'users') {
    console.log('Skipping users table import to preserve admin user');
    return;
  }
  
  try {
    // Start a transaction
    await client.query('BEGIN');
    
    // Create values placeholders for INSERT
    const placeholders = data.map((_, rowIndex) => {
      const rowPlaceholders = columnNames.map((_, colIndex) => 
        `$${rowIndex * columnNames.length + colIndex + 1}`).join(', ');
      return `(${rowPlaceholders})`;
    }).join(', ');
    
    // Create the INSERT query
    const query = `
      INSERT INTO "${tableName}" (${columnNames.map(c => `"${c}"`).join(', ')})
      VALUES ${placeholders}
    `;
    
    // Parse the data rows
    const values = [];
    for (const row of data) {
      const rowValues = row.split('\t');
      for (let i = 0; i < rowValues.length; i++) {
        let value = rowValues[i];
        // Handle NULL values
        if (value === '\\N') {
          value = null;
        }
        values.push(value);
      }
    }
    
    // Execute the INSERT
    await client.query(query, values);
    
    // Commit the transaction
    await client.query('COMMIT');
    
    console.log(`Imported ${data.length} rows into ${tableName}`);
  } catch (err) {
    // Rollback the transaction on error
    await client.query('ROLLBACK');
    console.error(`Error importing data into ${tableName}:`, err);
  }
}

// Run the script
extractAndImportData();