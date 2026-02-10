import pg from 'pg';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import dotenv from 'dotenv';
import csvParser from 'csv-parser';
import { Readable } from 'stream';

// Load environment variables
dotenv.config();

const { Client, Pool } = pg;

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

// Function to drop constraints
async function dropConstraints(client, tableName) {
  try {
    // Drop all foreign key constraints for this table
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
    return true;
  } catch (err) {
    console.error('Error dropping constraints:', err.message);
    return false;
  }
}

// Function to perform a bulk insert using prepared query
async function bulkInsert(client, tableName, records, validColumns) {
  if (records.length === 0) return 0;
  
  try {
    // Prepare column list by examining the first record
    const sampleRecord = records[0];
    const columns = [];
    
    for (const col in sampleRecord) {
      // Skip columns not in valid schema
      if (!validColumns.includes(col)) continue;
      columns.push(`"${col}"`);
    }
    
    if (columns.length === 0) {
      console.log(`No valid columns found for ${tableName}`);
      return 0;
    }
    
    // Build value placeholders for all records
    let valuesSql = [];
    let valueParams = [];
    let paramIndex = 1;
    
    for (const record of records) {
      const rowPlaceholders = [];
      
      for (const col of columns.map(c => c.replace(/"/g, ''))) {
        if (record[col] !== undefined && record[col] !== null && record[col] !== '') {
          rowPlaceholders.push(`$${paramIndex}`);
          valueParams.push(record[col]);
          paramIndex++;
        } else {
          rowPlaceholders.push('NULL');
        }
      }
      
      valuesSql.push(`(${rowPlaceholders.join(', ')})`);
    }
    
    // Construct the final query
    const query = `
      INSERT INTO "${tableName}" (${columns.join(', ')})
      VALUES ${valuesSql.join(', ')}
      ON CONFLICT (id) DO NOTHING
    `;
    
    // Execute bulk insert
    const result = await client.query(query, valueParams);
    return result.rowCount;
  } catch (error) {
    console.error(`Error in bulk insert for ${tableName}:`, error.message);
    return 0;
  }
}

// Main function to import data with fast bulk inserts
async function fastImport(tableName, data, batchSize = 100) {
  // Create a connection pool for better performance
  const pool = new Pool({
    connectionString: process.env.DATABASE_URL,
    max: 10 // Maximum 10 connections
  });
  
  try {
    console.log(`Starting import for ${tableName} with ${data.length} records...`);
    
    // Get a client from the pool
    const client = await pool.connect();
    
    try {
      // Skip users table if there are existing users
      if (tableName === 'users') {
        const userCount = await client.query('SELECT COUNT(*) FROM users');
        if (parseInt(userCount.rows[0].count) > 0) {
          console.log('Skipping users table import as existing users were found');
          return 0;
        }
      }
      
      // Drop constraints first
      await dropConstraints(client, tableName);
      
      // Clear existing data (except for users table)
      if (tableName !== 'users') {
        await clearTable(client, tableName);
      }
      
      // Get valid columns for this table
      const validColumns = tableSchemas[tableName] || [];
      
      // Process in batches for better performance
      let importedCount = 0;
      for (let i = 0; i < data.length; i += batchSize) {
        const batch = data.slice(i, Math.min(i + batchSize, data.length));
        
        // Transform data to match schema
        const transformedBatch = batch.map(row => {
          const result = {};
          
          for (const col in row) {
            // Skip empty values
            if (row[col] === undefined || row[col] === null || row[col] === '') continue;
            
            // Map column name if needed
            const dbCol = specialColumnMappings[col] || col;
            
            // Skip columns not in schema
            if (!validColumns.includes(dbCol)) continue;
            
            // Add to result
            result[dbCol] = row[col];
          }
          
          return result;
        });
        
        // Insert batch
        const count = await bulkInsert(client, tableName, transformedBatch, validColumns);
        importedCount += count;
        
        console.log(`Imported ${importedCount}/${data.length} records for ${tableName}`);
      }
      
      console.log(`Successfully imported ${importedCount} records into ${tableName}`);
      return importedCount;
    } finally {
      // Release the client back to the pool
      client.release();
    }
  } catch (error) {
    console.error(`Error during import of ${tableName}:`, error);
    return 0;
  } finally {
    // Close the pool
    await pool.end();
  }
}

// Table configuration - order matters for dependencies
const tablesToImport = [
  { name: 'vehicle_info', file: 'vehicle_info.csv', batchSize: 100 },
  { name: 'products', file: 'products.csv', batchSize: 100 },
  { name: 'proforma_slips', file: 'proforma_slips.csv', batchSize: 100 },
  { name: 'proforma_slip_items', file: 'proforma_slip_items.csv', batchSize: 200 },
  { name: 'load_operations', file: 'load_operations.csv', batchSize: 100 },
  { name: 'load_operations_items', file: 'load_operations_items.csv', batchSize: 200 },
  { name: 'sales', file: 'sales.csv', batchSize: 100 },
  { name: 'sale_items', file: 'sale_items.csv', batchSize: 100 },
  { name: 'scan_history', file: 'scan_history.csv', batchSize: 100 },
  { name: 'activities', file: 'activities.csv', batchSize: 100 },
  { name: 'messages', file: 'messages.csv', batchSize: 100 },
  { name: 'backup_settings', file: 'backup_settings.csv', batchSize: 100 }
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
  
  try {
    // Parse CSV file
    const csvPath = path.join(assetsDir, csvFile);
    console.log(`Reading data from ${csvFile}...`);
    const data = await parseCSV(csvPath);
    console.log(`Found ${data.length} rows in ${csvFile} for table ${tableName}`);
    
    // Import data with fast bulk insert
    await fastImport(tableName, data, batchSize);
    
    console.log(`Import of ${tableName} completed.`);
  } catch (error) {
    console.error(`Error during import of ${tableName}:`, error);
  }
}

// Run the import function
importSingleTable();