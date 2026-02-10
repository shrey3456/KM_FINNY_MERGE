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

// Define column mapping from CSV to database (for tables that need it)
const columnMappings = {
  'users': {
    'username': 'username',
    'pin': 'pin', // Match the actual column name in the schema
    'first_name': 'first_name',
    'last_name': 'last_name',
    'name': 'name',
    'designation': 'designation',
    'department': 'department',
    'access_type': 'access_type',
    'role': 'role',
    'page_permissions': 'page_permissions'
  },
  'products': {
    'id': 'id',
    'sr_no': 'sr_no',
    'item_no': 'item_no',
    'barcode': 'barcode', 
    'name': 'name',
    'category': 'category',
    'hsn_code': 'hsn_code',
    'sap_code': 'sap_code',
    'purchased': 'purchased',
    'sold': 'sold',
    'in_stock': 'in_stock',
    'items_per_pallet': 'items_per_pallet',
    'pallets': 'pallets',
    'purchase_price': 'purchase_price',
    'selling_price': 'selling_price',
    'last_updated': 'last_updated',
    'description': 'description',
    'status': 'status',
    'created_by_id': 'created_by_id',
    'created_at': 'created_at',
    'updated_at': 'updated_at',
    'volume_in_cu_ft': 'volume_in_cu_ft'
  },
  'vehicle_info': {
    'id': 'id',
    'sr_no': 'sr_no',
    'rto_number': 'rto_number',
    'vehicle_number': 'vehicle_number',
    'last_edited_by_id': 'last_edited_by_id',
    'last_edited_at': 'last_edited_at',
    'created_by_id': 'created_by_id',
    'created_at': 'created_at'
  },
  'proforma_slips': {
    'id': 'id',
    'order_date': 'order_date',
    'order_number': 'order_number',
    'party_name': 'party_name',
    'plant': 'plant',
    'total_quantity': 'total_quantity',
    'total_volume': 'total_volume',
    'vehicle_number': 'vehicle_number',
    'driver_name': 'driver_name',
    'created_by_id': 'created_by_id',
    'created_at': 'created_at',
    'notes': 'notes',
    'is_backed_up': 'is_backed_up'
  },
  'proforma_slip_items': {
    'id': 'id',
    'proforma_slip_id': 'proforma_slip_id',
    'product_id': 'product_id',
    'quantity': 'quantity',
    'loaded': 'loaded',
    'created_at': 'created_at',
    'original_quantity': 'original_quantity',
    'loaded_quantity': 'loaded_quantity',
    'sr_no': 'sr_no',
    'barcode': 'barcode',
    'item_name': 'item_name'
  },
  'load_operations': {
    'id': 'id',
    'status': 'status',
    'reference_number': 'reference_number',
    'vehicle_number': 'vehicle_number',
    'created_by_id': 'created_by_id',
    'created_at': 'created_at',
    'completed_at': 'completed_at',
    'notes': 'notes',
    'is_backed_up': 'is_backed_up',
    'order_date': 'order_date'
  },
  'load_operations_items': {
    'id': 'id',
    'gj_operations_id': 'load_operations_id',
    'product_id': 'product_id',
    'quantity': 'quantity',
    'original_quantity': 'original_quantity',
    'loaded_quantity': 'loaded_quantity',
    'loaded': 'loaded',
    'created_at': 'created_at',
    'sr_no': 'sr_no',
    'barcode': 'barcode',
    'item_name': 'item_name',
    'sr_no_display': 'sr_no_display'
  },
  'scan_history': {
    'id': 'id',
    'barcode': 'barcode',
    'product_id': 'product_id',
    'scanned_by_id': 'scanned_by_id',
    'scanned_at': 'scanned_at',
    'action': 'action',
    'quantity': 'quantity',
    'notes': 'notes',
    'product_sku': 'product_sku',
    'scanner_name': 'scanner_name',
    'scanner_department': 'scanner_department',
    'product_name': 'product_name',
    'is_backed_up': 'is_backed_up',
    'order_number': 'order_number'
  },
  'sales': {
    'id': 'id', 
    'order_number': 'order_number',
    'date': 'date',
    'dealer': 'dealer',
    'plant': 'plant',
    'status': 'status',
    'quantity': 'quantity',
    'amount': 'amount',
    'created_by_id': 'created_by_id',
    'created_at': 'created_at',
    'notes': 'notes',
    'is_backed_up': 'is_backed_up',
    'vehicle_number': 'vehicle_number'
  },
  'sale_items': {
    'id': 'id',
    'sale_id': 'sale_id',
    'sku': 'sku',
    'barcode': 'barcode',
    'name': 'name',
    'quantity': 'quantity',
    'unit_price': 'unit_price',
    'total_price': 'total_price',
    'category': 'category',
    'hsn': 'hsn',
    'original_quantity': 'original_quantity',
    'created_at': 'created_at',
    'updated_at': 'updated_at'
  },
  'activities': {
    'id': 'id',
    'page_name': 'page_name',
    'action': 'action',
    'entity_type': 'entity_type',
    'entity_id': 'entity_id',
    'details': 'details',
    'user_id': 'user_id',
    'user_name': 'user_name',
    'created_at': 'created_at'
  },
  'messages': {
    'id': 'id',
    'sender_id': 'sender_id',
    'recipient_id': 'recipient_id',
    'content': 'content',
    'is_read': 'is_read',
    'created_at': 'created_at',
    'broadcast_to_all': 'broadcast_to_all',
    'broadcast_to_designation': 'broadcast_to_designation',
    'broadcast_to_department': 'broadcast_to_department'
  },
  'backup_settings': {
    'id': 'id',
    'last_backup_date': 'last_backup_date',
    'auto_backup_enabled': 'auto_backup_enabled',
    'backup_frequency_hours': 'backup_frequency_hours',
    'created_at': 'created_at',
    'updated_at': 'updated_at'
  }
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
async function importTable(client, tableName, data, mapping, skipExisting = false) {
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
  
  // Start a transaction
  await client.query('BEGIN');
  
  try {
    for (const row of data) {
      // Map CSV columns to database columns
      const insertColumns = [];
      const insertValues = [];
      const placeholders = [];
      
      let i = 1;
      for (const csvCol in mapping) {
        const dbCol = mapping[csvCol];
        
        // Skip empty values
        if (row[csvCol] === undefined || row[csvCol] === null || row[csvCol] === '') {
          continue;
        }
        
        insertColumns.push(`"${dbCol}"`);
        
        // Special handling for certain columns/tables
        if (tableName === 'users' && csvCol === 'pin') {
          // For users, set password to pin directly (no hashing for initial import)
          insertValues.push(row[csvCol]);
        } else if (csvCol === 'page_permissions' && row[csvCol] && row[csvCol].startsWith('{')) {
          // Handle JSON data
          try {
            insertValues.push(row[csvCol]);
          } catch (e) {
            insertValues.push(null);
          }
        } else if (csvCol === 'details' && row[csvCol] && row[csvCol].startsWith('{')) {
          // Handle JSON details in activities
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
        columnMappings[table.name],
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
      // More constraints can be added as needed
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