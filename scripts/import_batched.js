import pg from 'pg';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import dotenv from 'dotenv';
import csvParser from 'csv-parser';
import { Readable } from 'stream';

// Load environment variables
dotenv.config();

const { Client } = pg;

// Get the directory name
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Path to the attached_assets directory
const assetsDir = path.join(__dirname, '..', 'attached_assets');

// Define the database schema with valid columns for each table
const tableSchemas = {
  products: [
    'id', 'sr_no', 'item_no', 'barcode', 'name', 'category',
    'volume_in_cu_ft', 'hsn_code', 'sap_code', 'purchased', 
    'sold', 'in_stock', 'items_per_pallet', 'pallets',
    'purchase_price', 'selling_price', 'last_updated',
    'description', 'status', 'created_by_id', 'created_at', 'updated_at'
  ],
};

// Special column mappings from CSV to database
const specialColumnMappings = {
  'gj_operations_id': 'load_operations_id',
  'proforma_slip_id': 'proforma_slip_id'
};

// Function to parse CSV data into array of objects
async function parseCSV(filePath) {
  return new Promise((resolve, reject) => {
    const results = [];
    
    if (!fs.existsSync(filePath)) {
      console.log(`File not found: ${filePath}`);
      resolve([]);
      return;
    }
    
    const csvData = fs.readFileSync(filePath, 'utf8');
    const stream = Readable.from([csvData]);
    
    stream
      .pipe(csvParser())
      .on('data', (data) => results.push(data))
      .on('end', () => resolve(results))
      .on('error', (error) => reject(error));
  });
}

// Function to clean a table
async function clearTable(client, tableName) {
  try {
    await client.query(`TRUNCATE TABLE "${tableName}" CASCADE`);
    console.log(`Cleared data from ${tableName}`);
  } catch (error) {
    console.error(`Error clearing table ${tableName}:`, error.message);
  }
}

// Function to create insert query
function createInsertQuery(tableName, columns, placeholders) {
  return `
    INSERT INTO "${tableName}" (${columns})
    VALUES (${placeholders})
    ON CONFLICT (id) DO NOTHING
  `;
}

// Function to import data for a table in batches
async function importTable(client, tableName, data, batchSize = 50) {
  if (data.length === 0) {
    console.log(`No data to import for table ${tableName}`);
    return 0;
  }
  
  // Get valid columns for this table
  const validColumns = tableSchemas[tableName] || [];
  const skipColumns = ['volume', 'series', 'manufacturer'];
  
  // Drop foreign key constraints for this table
  console.log(`Dropping foreign key constraints for ${tableName}...`);
  const constraintsResult = await client.query(`
    SELECT tc.constraint_name, tc.table_name 
    FROM information_schema.table_constraints tc
    WHERE tc.constraint_type = 'FOREIGN KEY' AND tc.table_name = $1
  `, [tableName]);
  
  for (const row of constraintsResult.rows) {
    try {
      await client.query(`
        ALTER TABLE "${row.table_name}" DROP CONSTRAINT IF EXISTS "${row.constraint_name}"
      `);
      console.log(`Dropped constraint ${row.constraint_name} from ${row.table_name}`);
    } catch (err) {
      console.error(`Error dropping constraint ${row.constraint_name}:`, err.message);
    }
  }
  
  try {
    // Clear existing data
    await clearTable(client, tableName);
    
    // Process data in batches
    let totalSuccessCount = 0;
    let totalErrorCount = 0;
    
    for (let i = 0; i < data.length; i += batchSize) {
      // Start a transaction for this batch
      await client.query('BEGIN');
      
      const batch = data.slice(i, i + batchSize);
      let batchSuccessCount = 0;
      let batchErrorCount = 0;
      
      for (const row of batch) {
        // Map CSV columns to database columns
        const insertColumns = [];
        const insertValues = [];
        const placeholders = [];
        
        let paramIndex = 1;
        for (const csvCol in row) {
          // Skip empty values
          if (row[csvCol] === undefined || row[csvCol] === null || row[csvCol] === '') {
            continue;
          }
          
          // Skip columns we want to exclude
          if (skipColumns.includes(csvCol)) {
            continue;
          }
          
          // Map column name if needed
          let dbCol = specialColumnMappings[csvCol] || csvCol;
          
          // Check if this column exists in our database schema
          if (validColumns.length > 0 && !validColumns.includes(dbCol)) {
            // Skip columns not in schema
            continue;
          }
          
          insertColumns.push(`"${dbCol}"`);
          insertValues.push(row[csvCol]);
          placeholders.push(`$${paramIndex}`);
          paramIndex++;
        }

        if (insertColumns.length === 0) {
          console.log(`Skipping row with no valid columns for table ${tableName}`);
          continue;
        }
        
        // Create and execute insert query
        const insertQuery = createInsertQuery(tableName, insertColumns.join(', '), placeholders.join(', '));
        
        try {
          await client.query(insertQuery, insertValues);
          batchSuccessCount++;
        } catch (error) {
          batchErrorCount++;
          if (batchErrorCount <= 3) {
            console.error(`Error inserting row into ${tableName}:`, error.message);
            console.error('Row data:', Object.keys(row).reduce((obj, key) => {
              if (!skipColumns.includes(key)) obj[key] = row[key];
              return obj;
            }, {}));
          }
        }
      }
      
      // Commit the transaction for this batch
      await client.query('COMMIT');
      
      totalSuccessCount += batchSuccessCount;
      totalErrorCount += batchErrorCount;
      
      console.log(`Batch completed: imported ${batchSuccessCount} rows with ${batchErrorCount} errors. Total: ${totalSuccessCount} rows imported.`);
    }
    
    console.log(`Successfully imported ${totalSuccessCount} rows into ${tableName} with ${totalErrorCount} errors`);
    return totalSuccessCount;
  } catch (error) {
    // Rollback on error (though individual batches should have already committed)
    try {
      await client.query('ROLLBACK');
    } catch (rollbackErr) {
      console.error('Error during rollback:', rollbackErr.message);
    }
    
    console.error(`Transaction failed for ${tableName}:`, error.message);
    return 0;
  }
}

// Main function to import a single table
async function importProductsTable() {
  const tableName = 'products';
  const csvFile = 'products.csv';
  
  // Create PostgreSQL client
  const client = new Client({
    connectionString: process.env.DATABASE_URL,
  });

  try {
    // Connect to the database
    await client.connect();
    console.log(`Connected to database to import ${tableName}`);
    
    // Parse CSV file
    const csvPath = path.join(assetsDir, csvFile);
    const data = await parseCSV(csvPath);
    console.log(`Found ${data.length} rows in ${csvFile} for table ${tableName}`);
    
    // Import data in batches of 50
    const importCount = await importTable(client, tableName, data, 50);
    
    console.log(`Import of ${tableName} completed. Imported ${importCount} rows.`);
    
  } catch (error) {
    console.error(`Error during import of ${tableName}:`, error);
  } finally {
    // Close database connection
    await client.end();
    console.log('Database connection closed');
  }
}

// Run the import function
importProductsTable();