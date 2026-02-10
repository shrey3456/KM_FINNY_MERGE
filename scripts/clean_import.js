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
    'original_quantity', 'loaded_quantity', 'sr_no', 'barcode',
    'item_name', 'created_at'
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

// Define the order of tables to import (considering dependencies)
const tablesToImport = [
  { name: 'users', file: 'users.csv', skipExisting: true },
  { name: 'vehicle_info', file: 'vehicle_info.csv' },
  { name: 'products', file: 'products.csv' },
  { name: 'proforma_slips', file: 'proforma_slips.csv' },
  { name: 'proforma_slip_items', file: 'proforma_slip_items.csv' },
  { name: 'load_operations', file: 'load_operations.csv' },
  { name: 'load_operations_items', file: 'load_operations_items.csv' },
  { name: 'scan_history', file: 'scan_history.csv' },
  { name: 'sales', file: 'sales.csv' },
  { name: 'sale_items', file: 'sale_items.csv' },
  { name: 'activities', file: 'activities.csv' },
  { name: 'messages', file: 'messages.csv' },
  { name: 'backup_settings', file: 'backup_settings.csv' }
];

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

// Function to import data for a table
async function importTable(client, tableName, data, skipExisting = false) {
  if (data.length === 0) {
    console.log(`No data to import for table ${tableName}`);
    return 0;
  }

  // Skip users table if skipExisting is true and we have users
  if (tableName === 'users' && skipExisting) {
    const userCount = await client.query('SELECT COUNT(*) FROM users');
    if (parseInt(userCount.rows[0].count) > 0) {
      console.log('Skipping users table import as existing users were found');
      return 0;
    }
  }
  
  let successCount = 0;
  let errorCount = 0;
  
  // Get valid columns for this table
  const validColumns = tableSchemas[tableName] || [];
  
  // Start a transaction
  await client.query('BEGIN');
  
  try {
    // Process each row
    for (const row of data) {
      // Map CSV columns to database columns
      const insertColumns = [];
      const insertValues = [];
      const placeholders = [];
      
      let i = 1;
      for (const csvCol in row) {
        // Skip empty values
        if (row[csvCol] === undefined || row[csvCol] === null || row[csvCol] === '') {
          continue;
        }
        
        // Map column name if needed
        let dbCol = specialColumnMappings[csvCol] || csvCol;
        
        // Check if this column exists in our database schema
        if (!validColumns.includes(dbCol)) {
          // Skip columns not in schema
          continue;
        }
        
        insertColumns.push(`"${dbCol}"`);
        
        // Special handling for certain columns/tables
        if (tableName === 'users' && csvCol === 'pin') {
          // For users, use pin directly (no hashing for initial import)
          insertValues.push(row[csvCol]);
        } else if (csvCol === 'details' && row[csvCol] && (row[csvCol].startsWith('{') || row[csvCol].startsWith('['))) {
          // Handle JSON data
          insertValues.push(row[csvCol]);
        } else {
          // Regular value
          insertValues.push(row[csvCol]);
        }
        
        placeholders.push(`$${i}`);
        i++;
      }

      if (insertColumns.length === 0) {
        console.log(`Skipping row with no valid columns for table ${tableName}`);
        continue;
      }
      
      // Create and execute insert query
      const insertQuery = createInsertQuery(tableName, insertColumns.join(', '), placeholders.join(', '));
      
      try {
        await client.query(insertQuery, insertValues);
        successCount++;
        
        // Log progress intermittently
        if (successCount % 100 === 0) {
          console.log(`Imported ${successCount} rows into ${tableName} so far...`);
        }
      } catch (error) {
        errorCount++;
        if (errorCount < 5) {
          console.error(`Error inserting row into ${tableName}:`, error.message);
          console.error('Row data:', Object.keys(row).filter(k => validColumns.includes(k))
            .reduce((obj, key) => ({ ...obj, [key]: row[key] }), {}));
        } else if (errorCount === 5) {
          console.error(`Suppressing further similar errors for ${tableName}...`);
        }
      }
    }
    
    // Commit the transaction
    await client.query('COMMIT');
    console.log(`Successfully imported ${successCount} rows into ${tableName} with ${errorCount} errors`);
    
    return successCount;
  } catch (error) {
    // Rollback on error
    await client.query('ROLLBACK');
    console.error(`Transaction failed for ${tableName}:`, error.message);
    return 0;
  }
}

// Main function to coordinate the import
async function importCSVData() {
  // Create PostgreSQL client
  const client = new Client({
    connectionString: process.env.DATABASE_URL,
  });

  try {
    // Connect to the database
    await client.connect();
    console.log('Connected to database');
    
    let totalImported = 0;
    
    // Drop foreign key constraints first to avoid import issues
    console.log('Dropping foreign key constraints...');
    const constraintsResult = await client.query(`
      SELECT tc.constraint_name, tc.table_name 
      FROM information_schema.table_constraints tc
      WHERE tc.constraint_type = 'FOREIGN KEY'
    `);
    
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
    
    // Import each table in the defined order
    for (const table of tablesToImport) {
      console.log(`Processing ${table.name}...`);
      
      // Clear existing data first (except for users)
      if (table.name !== 'users') {
        await clearTable(client, table.name);
      }
      
      // Parse CSV file
      const csvPath = path.join(assetsDir, table.file);
      const data = await parseCSV(csvPath);
      console.log(`Found ${data.length} rows in ${table.file}`);
      
      // Import data
      const importCount = await importTable(
        client, 
        table.name, 
        data,
        table.skipExisting
      );
      
      totalImported += importCount;
    }
    
    console.log(`Import completed. Total rows imported: ${totalImported}`);
    
    // Recreate foreign key constraints
    console.log('Recreating foreign key constraints...');
    
    const constraintDefinitions = [
      {
        table: 'load_operations_items',
        column: 'load_operations_id',
        referencedTable: 'load_operations',
        referencedColumn: 'id',
        onDelete: 'CASCADE'
      },
      {
        table: 'load_operations_items',
        column: 'product_id',
        referencedTable: 'products',
        referencedColumn: 'id',
        onDelete: 'SET NULL'
      },
      {
        table: 'proforma_slip_items',
        column: 'proforma_slip_id',
        referencedTable: 'proforma_slips',
        referencedColumn: 'id',
        onDelete: 'CASCADE'
      },
      {
        table: 'proforma_slip_items',
        column: 'product_id',
        referencedTable: 'products',
        referencedColumn: 'id',
        onDelete: 'SET NULL'
      },
      {
        table: 'sale_items',
        column: 'sale_id',
        referencedTable: 'sales',
        referencedColumn: 'id',
        onDelete: 'CASCADE'
      }
    ];
    
    for (const constraint of constraintDefinitions) {
      const constraintName = `${constraint.table}_${constraint.column}_fkey`;
      try {
        await client.query(`
          ALTER TABLE "${constraint.table}"
          ADD CONSTRAINT "${constraintName}"
          FOREIGN KEY ("${constraint.column}")
          REFERENCES "${constraint.referencedTable}" ("${constraint.referencedColumn}")
          ${constraint.onDelete ? `ON DELETE ${constraint.onDelete}` : ''}
        `);
        console.log(`Created constraint ${constraintName}`);
      } catch (error) {
        console.error(`Error creating constraint ${constraintName}:`, error.message);
      }
    }
    
  } catch (error) {
    console.error('Error during import:', error);
  } finally {
    // Close database connection
    await client.end();
    console.log('Database connection closed');
  }
}

// Run the import function
importCSVData();