import pg from 'pg';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import dotenv from 'dotenv';
import readline from 'readline';

// Load environment variables
dotenv.config();

const { Client } = pg;

// Get the directory name
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Connect to the database
const client = new Client({
  connectionString: process.env.DATABASE_URL,
});

// Path to the SQL dump file
const dumpFilePath = path.join(__dirname, '..', 'attached_assets', 'database_backup.sql');

async function executeSQL() {
  try {
    await client.connect();
    console.log('Connected to database');
    
    // First delete the existing data (except users)
    console.log('Cleaning existing data...');
    await cleanDatabase();

    // Process SQL file line by line
    console.log('Processing SQL dump file...');
    const fileStream = fs.createReadStream(dumpFilePath);
    const rl = readline.createInterface({
      input: fileStream,
      crlfDelay: Infinity
    });

    let currentCommand = '';
    let inCopy = false;
    let copyData = [];
    let tableName = '';
    let columnNames = [];

    for await (const line of rl) {
      // Skip comments and empty lines
      if (line.startsWith('--') || line.trim() === '') {
        continue;
      }

      // Handle COPY statements specially
      if (line.startsWith('COPY ')) {
        // Extract table name and column names from COPY statement
        const match = line.match(/COPY ([^ ]+) \(([^)]+)\)/);
        if (match) {
          tableName = match[1].replace('public.', '');
          columnNames = match[2].split(', ');
          inCopy = true;
          copyData = [];
          console.log(`Processing COPY data for table ${tableName}`);
          continue;
        }
      }

      // End of COPY data
      if (line === '\\.' && inCopy) {
        console.log(`Inserting ${copyData.length} rows into ${tableName}`);
        
        // Skip users table to preserve our admin user
        if (tableName !== 'users') {
          try {
            await processCopyData(tableName, columnNames, copyData);
          } catch (err) {
            console.error(`Error processing COPY data for ${tableName}:`, err.message);
          }
        } else {
          console.log('Skipping users table to preserve existing users');
        }
        
        inCopy = false;
        continue;
      }

      // Collect COPY data
      if (inCopy) {
        copyData.push(line);
        continue;
      }

      // Skip certain statements that might cause problems
      if (
        line.includes('DROP DATABASE') ||
        line.includes('CREATE DATABASE') ||
        line.includes('ALTER DATABASE') ||
        line.includes('COMMENT ON DATABASE') ||
        line.includes('connect ') ||
        line.includes('SET ')
      ) {
        continue;
      }

      // Collect standard SQL statements
      currentCommand += line + '\n';

      // Execute command on semicolon
      if (line.trim().endsWith(';') && currentCommand.trim() !== '') {
        try {
          // Skip commands that may cause issues
          if (
            currentCommand.includes('CREATE SCHEMA') ||
            currentCommand.includes('SET session_replication_role') ||
            // Skip table creation and constraint commands as we'll handle them differently
            currentCommand.includes('CREATE TABLE') ||
            currentCommand.includes('ALTER TABLE') && currentCommand.includes('ADD CONSTRAINT')
          ) {
            currentCommand = '';
            continue;
          }

          // Execute the SQL command
          await client.query(currentCommand);
          currentCommand = '';
        } catch (err) {
          console.error('Error executing SQL command:', err.message);
          console.error('Command was:', currentCommand);
          currentCommand = '';
        }
      }
    }

    console.log('SQL import completed successfully');
  } catch (err) {
    console.error('Error executing SQL:', err);
  } finally {
    await client.end();
  }
}

// Function to clean existing data from database
async function cleanDatabase() {
  const tables = [
    'activities',
    'backup_settings',
    'load_operations_items',
    'load_operations',
    'messages',
    'products_backup',
    'proforma_slip_items',
    'proforma_slips',
    'purchases',
    'sale_items',
    'sales',
    'scan_history',
    'vehicle_info',
    // Don't delete users to preserve admin account
    // 'users'
  ];

  // Disable foreign key checks temporarily
  try {
    await client.query('BEGIN');
    await client.query('SET CONSTRAINTS ALL DEFERRED');

    // Truncate all tables except users
    for (const table of tables) {
      try {
        await client.query(`TRUNCATE TABLE "${table}" CASCADE`);
        console.log(`Truncated table ${table}`);
      } catch (err) {
        console.log(`Table ${table} might not exist, skipping: ${err.message}`);
      }
    }

    // Commit the transaction
    await client.query('COMMIT');
    console.log('Database cleaned successfully');
  } catch (err) {
    await client.query('ROLLBACK');
    console.error('Error cleaning database:', err.message);
  }
}

// Function to process and insert COPY data
async function processCopyData(tableName, columnNames, copyData) {
  if (copyData.length === 0) return;

  try {
    // Begin a transaction for efficiency and atomicity
    await client.query('BEGIN');

    // We'll use batch inserts for efficiency
    const batchSize = 1000;
    for (let i = 0; i < copyData.length; i += batchSize) {
      const batch = copyData.slice(i, i + batchSize);
      
      // Prepare the insertion values
      const valueParams = [];
      const valueStrings = [];
      
      for (let rowIndex = 0; rowIndex < batch.length; rowIndex++) {
        const row = batch[rowIndex];
        const rowData = row.split('\\t');
        const rowValueIndexes = [];
        
        for (let colIndex = 0; colIndex < rowData.length; colIndex++) {
          const paramIndex = rowIndex * rowData.length + colIndex + 1;
          let value = rowData[colIndex];
          
          // Handle NULL values
          if (value === '\\N') {
            value = null;
          }
          
          valueParams.push(value);
          rowValueIndexes.push(`$${paramIndex}`);
        }
        
        valueStrings.push(`(${rowValueIndexes.join(', ')})`);
      }
      
      // Create the INSERT query
      const query = `
        INSERT INTO "${tableName}" (${columnNames.map(c => `"${c.trim()}"`).join(', ')})
        VALUES ${valueStrings.join(', ')}
        ON CONFLICT DO NOTHING
      `;
      
      await client.query(query, valueParams);
      console.log(`Inserted batch of ${batch.length} rows into ${tableName}`);
    }
    
    await client.query('COMMIT');
    console.log(`Successfully imported ${copyData.length} rows to ${tableName}`);
  } catch (err) {
    await client.query('ROLLBACK');
    console.error(`Error importing data to ${tableName}:`, err);
    throw err;
  }
}

// Run the function
executeSQL();