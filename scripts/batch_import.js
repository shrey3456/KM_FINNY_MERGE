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
  users: [
    'id', 'username', 'pin', 'first_name', 'last_name', 'name',
    'designation', 'department', 'access_type', 'role'
  ],
  
  products: [
    'id', 'sr_no', 'item_no', 'barcode', 'name', 'category',
    'volume_in_cu_ft', 'hsn_code', 'sap_code', 'purchased', 
    'sold', 'in_stock', 'items_per_pallet', 'pallets',
    'purchase_price', 'selling_price', 'last_updated',
    'description', 'status', 'created_by_id', 'created_at', 'updated_at'
  ],
  
  vehicle_info: [
    'id', 'sr_no', 'rto_number', 'vehicle_number',
    'last_edited_by_id', 'last_edited_at', 'created_by_id', 'created_at'
  ],
  
  proforma_slips: [
    'id', 'order_date', 'order_number', 'party_name', 'plant',
    'total_quantity', 'total_volume', 'vehicle_number', 'driver_name',
    'created_by_id', 'created_at', 'notes', 'is_backed_up'
  ],
  
  proforma_slip_items: [
    'id', 'proforma_slip_id', 'product_id', 'quantity', 'loaded',
    'created_at', 'original_quantity', 'loaded_quantity', 'sr_no', 
    'barcode', 'item_name'
  ],
  
  load_operations: [
    'id', 'status', 'reference_number', 'vehicle_number',
    'created_by_id', 'created_at', 'completed_at', 'notes',
    'is_backed_up', 'order_date'
  ],
  
  load_operations_items: [
    'id', 'load_operations_id', 'product_id', 'quantity', 'original_quantity',
    'loaded_quantity', 'loaded', 'created_at', 'sr_no', 'barcode',
    'item_name', 'sr_no_display'
  ],
  
  scan_history: [
    'id', 'barcode', 'product_id', 'scanned_by_id', 'scanned_at',
    'action', 'quantity', 'notes', 'product_sku', 'scanner_name',
    'scanner_department', 'product_name', 'is_backed_up', 'order_number'
  ],
  
  sales: [
    'id', 'order_number', 'date', 'dealer', 'plant', 'status',
    'quantity', 'amount', 'vehicle_number', 'created_by_id',
    'created_at', 'notes', 'is_backed_up'
  ],
  
  sale_items: [
    'id', 'sale_id', 'sku', 'barcode', 'name', 'quantity',
    'unit_price', 'total_price', 'category', 'hsn',
    'original_quantity', 'created_at', 'updated_at'
  ],
  
  activities: [
    'id', 'page_name', 'action', 'entity_type', 'entity_id',
    'details', 'user_id', 'user_name', 'created_at'
  ],
  
  messages: [
    'id', 'sender_id', 'recipient_id', 'content', 'is_read',
    'created_at', 'broadcast_to_all', 'broadcast_to_designation',
    'broadcast_to_department'
  ],
  
  backup_settings: [
    'id', 'last_backup_date', 'auto_backup_enabled',
    'backup_frequency_hours', 'created_at', 'updated_at'
  ]
};

// Special column mappings from CSV to database
const specialColumnMappings = {
  'gj_operations_id': 'load_operations_id',
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
  
  // Skip users table if there are existing users
  if (tableName === 'users') {
    const userCount = await client.query('SELECT COUNT(*) FROM users');
    if (parseInt(userCount.rows[0].count) > 0) {
      console.log('Skipping users table import as existing users were found');
      return 0;
    }
  }
  
  // Get valid columns for this table
  const validColumns = tableSchemas[tableName] || [];
  
  // Drop foreign key constraints for this table
  console.log(`Dropping foreign key constraints for ${tableName}...`);
  try {
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
  } catch (err) {
    console.error('Error dropping constraints:', err.message);
  }
  
  try {
    // Clear existing data (except for users table which we handle above)
    if (tableName !== 'users') {
      await clearTable(client, tableName);
    }
    
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
          continue; // Skip rows with no valid columns
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
          }
        }
      }
      
      // Commit the transaction for this batch
      await client.query('COMMIT');
      
      totalSuccessCount += batchSuccessCount;
      totalErrorCount += batchErrorCount;
      
      console.log(`Batch completed: imported ${batchSuccessCount}/${batch.length} rows with ${batchErrorCount} errors. Total: ${totalSuccessCount} rows imported.`);
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

// Table configuration - order matters for dependencies
const tablesToImport = [
  { name: 'vehicle_info', file: 'vehicle_info.csv', batchSize: 50 },
  { name: 'products', file: 'products.csv', batchSize: 50 },
  { name: 'proforma_slips', file: 'proforma_slips.csv', batchSize: 50 },
  { name: 'proforma_slip_items', file: 'proforma_slip_items.csv', batchSize: 100 },
  { name: 'load_operations', file: 'load_operations.csv', batchSize: 50 },
  { name: 'load_operations_items', file: 'load_operations_items.csv', batchSize: 100 },
  { name: 'sales', file: 'sales.csv', batchSize: 50 },
  { name: 'sale_items', file: 'sale_items.csv', batchSize: 50 },
  { name: 'scan_history', file: 'scan_history.csv', batchSize: 50 },
  { name: 'activities', file: 'activities.csv', batchSize: 50 },
  { name: 'messages', file: 'messages.csv', batchSize: 50 },
  { name: 'backup_settings', file: 'backup_settings.csv', batchSize: 50 }
];

// Main function to import a single table based on command line arg
async function importSingleTable() {
  // Get table index from command line (1-based for easier use)
  const tableIndex = parseInt(process.argv[2] || '1', 10);
  
  if (isNaN(tableIndex) || tableIndex < 1 || tableIndex > tablesToImport.length) {
    console.error(`Please provide a valid table index (1-${tablesToImport.length}).`);
    process.exit(1);
  }
  
  // Get table config (convert to 0-based index)
  const tableConfig = tablesToImport[tableIndex - 1];
  const { name: tableName, file: csvFile, batchSize } = tableConfig;
  
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
    
    // Import data with specified batch size
    const importCount = await importTable(client, tableName, data, batchSize);
    
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
importSingleTable();