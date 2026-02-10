import pg from 'pg';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import readline from 'readline';
import dotenv from 'dotenv';

// Load environment variables
dotenv.config();

const { Client } = pg;

// Get the directory name
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Path to the SQL dump file
const dumpFilePath = path.join(__dirname, '..', 'attached_assets', 'database_backup.sql');

// Path to store extracted data
const outputDir = path.join(__dirname, '..', 'extracted_data');

// Ensure output directory exists
if (!fs.existsSync(outputDir)) {
  fs.mkdirSync(outputDir, { recursive: true });
}

// Main function to extract data from SQL dump
async function extractData() {
  console.log('Starting data extraction from SQL dump...');
  
  try {
    // Create read stream for the SQL file
    const fileStream = fs.createReadStream(dumpFilePath);
    const rl = readline.createInterface({
      input: fileStream,
      crlfDelay: Infinity
    });

    let currentTable = '';
    let inCopySection = false;
    let copyData = [];
    let columnNames = [];

    // Process file line by line
    for await (const line of rl) {
      // Check for COPY statement (table data)
      if (line.startsWith('COPY public.')) {
        const match = line.match(/COPY public\.(\w+)/);
        if (match) {
          currentTable = match[1];
          inCopySection = true;
          copyData = [];
          
          // Extract column names from COPY statement
          const columnsMatch = line.match(/COPY public\.\w+ \(([^)]+)\)/);
          if (columnsMatch) {
            columnNames = columnsMatch[1].split(', ');
          }
          
          console.log(`Processing table: ${currentTable}`);
          continue;
        }
      }
      
      // End of COPY section
      if (line === '\\.' && inCopySection) {
        console.log(`Found ${copyData.length} rows for ${currentTable}`);
        
        // Save extracted data to JSON file
        const outputFile = path.join(outputDir, `${currentTable}.json`);
        const extractedData = convertToJsonFormat(columnNames, copyData);
        fs.writeFileSync(outputFile, JSON.stringify(extractedData, null, 2));
        
        console.log(`Saved data for ${currentTable} to ${outputFile}`);
        
        inCopySection = false;
        continue;
      }
      
      // Collect data rows
      if (inCopySection && line !== '\\.' && !line.startsWith('COPY')) {
        copyData.push(line);
      }
    }

    console.log('Data extraction completed successfully');
    await importExtractedData();
  } catch (error) {
    console.error('Error extracting data:', error);
  }
}

// Convert tab-separated values to JSON objects
function convertToJsonFormat(columns, rows) {
  return rows.map(row => {
    const values = row.split('\\t');
    const obj = {};
    
    for (let i = 0; i < columns.length; i++) {
      const columnName = columns[i];
      let value = values[i] || null;
      
      // Handle NULL values
      if (value === '\\N') {
        value = null;
      }
      
      obj[columnName] = value;
    }
    
    return obj;
  });
}

// Function to import the extracted data into the database
async function importExtractedData() {
  console.log('Starting to import extracted data into database...');
  
  const client = new Client({
    connectionString: process.env.DATABASE_URL,
  });
  
  try {
    await client.connect();
    console.log('Connected to database');
    
    // Get list of extracted data files
    const files = fs.readdirSync(outputDir);
    
    // Delete existing data from tables
    console.log('Clearing existing data...');
    await clearTables(client, files.map(file => file.replace('.json', '')));
    
    // Process each extracted file and import data
    for (const file of files) {
      if (file.endsWith('.json')) {
        const tableName = file.replace('.json', '');
        
        // Skip users table to preserve admin user
        if (tableName === 'users') {
          console.log('Skipping users table to preserve admin user');
          continue;
        }
        
        const data = JSON.parse(fs.readFileSync(path.join(outputDir, file), 'utf8'));
        
        if (data.length > 0) {
          console.log(`Importing ${data.length} rows into ${tableName}...`);
          await importTableData(client, tableName, data);
          console.log(`Imported data into ${tableName}`);
        } else {
          console.log(`No data to import for ${tableName}`);
        }
      }
    }
    
    console.log('Data import completed successfully');
  } catch (error) {
    console.error('Error importing data:', error);
  } finally {
    await client.end();
  }
}

// Function to clear existing data from tables
async function clearTables(client, tables) {
  try {
    // Start transaction
    await client.query('BEGIN');
    
    // Disable triggers temporarily
    try {
      await client.query('SET session_replication_role = replica;');
    } catch (e) {
      console.log('Could not disable triggers, continuing anyway:', e.message);
    }
    
    // Clear each table except users
    for (const table of tables) {
      if (table !== 'users') {
        try {
          await client.query(`TRUNCATE TABLE "${table}" CASCADE;`);
          console.log(`Cleared table: ${table}`);
        } catch (err) {
          console.log(`Could not clear table ${table}: ${err.message}`);
        }
      }
    }
    
    // Re-enable triggers
    try {
      await client.query('SET session_replication_role = DEFAULT;');
    } catch (e) {
      console.log('Could not re-enable triggers, continuing anyway:', e.message);
    }
    
    // Commit transaction
    await client.query('COMMIT');
  } catch (error) {
    await client.query('ROLLBACK');
    console.error('Error clearing tables:', error);
    throw error;
  }
}

// Function to import data for a specific table
async function importTableData(client, tableName, data) {
  if (data.length === 0) {
    return;
  }
  
  try {
    // Start transaction
    await client.query('BEGIN');
    
    // Get column names from first row
    const columnNames = Object.keys(data[0]);
    
    // Process in batches to avoid query size limits
    const batchSize = 100;
    for (let i = 0; i < data.length; i += batchSize) {
      const batch = data.slice(i, i + batchSize);
      
      // Generate placeholders for prepared statement
      const placeholders = batch.map((_, rowIndex) => {
        return `(${columnNames.map((_, colIndex) => 
          `$${rowIndex * columnNames.length + colIndex + 1}`).join(', ')})`;
      }).join(', ');
      
      // Create query with ON CONFLICT DO NOTHING to handle duplicates
      const query = `
        INSERT INTO "${tableName}" (${columnNames.map(c => `"${c}"`).join(', ')})
        VALUES ${placeholders}
        ON CONFLICT DO NOTHING
      `;
      
      // Flatten values for parameters
      const values = [];
      for (const row of batch) {
        for (const col of columnNames) {
          values.push(row[col]);
        }
      }
      
      // Execute query
      await client.query(query, values);
      console.log(`Imported batch of ${batch.length} rows to ${tableName}`);
    }
    
    // Commit transaction
    await client.query('COMMIT');
  } catch (error) {
    // Rollback on error
    await client.query('ROLLBACK');
    console.error(`Error importing data to ${tableName}:`, error);
    throw error;
  }
}

// Run the main function
extractData();