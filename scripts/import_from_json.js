import pg from 'pg';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import dotenv from 'dotenv';

// Load environment variables
dotenv.config();

const { Client } = pg;

// Get the directory name
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Path to the extracted data directory
const dataDir = path.join(__dirname, '..', 'extracted_data');

// Tables to import in order (important for referential integrity)
const tablesToImport = [
  'products',
  'users',
  'vehicle_info',
  'proforma_slips',
  'proforma_slip_items',
  'load_operations',
  'load_operations_items',
  'scan_history',
  'messages',
  'activities',
  'sales',
  'sale_items'
];

async function importData() {
  // Create a PostgreSQL client
  const client = new Client({
    connectionString: process.env.DATABASE_URL,
  });

  try {
    // Connect to the database
    await client.connect();
    console.log('Connected to database');
    
    // Truncate existing tables where we want to import data
    console.log('Cleaning existing data...');
    await cleanTables(client);
    
    // Import each table
    for (const table of tablesToImport) {
      const filePath = path.join(dataDir, `${table}.json`);
      
      // Check if file exists
      if (!fs.existsSync(filePath)) {
        console.log(`No data file found for ${table}, skipping...`);
        continue;
      }
      
      // Read data from JSON file
      const data = JSON.parse(fs.readFileSync(filePath, 'utf8'));
      
      if (data.length === 0) {
        console.log(`No data to import for ${table}, skipping...`);
        continue;
      }
      
      // Skip importing users table to preserve existing user
      if (table === 'users') {
        console.log('Skipping users table to preserve existing admin user');
        continue;
      }
      
      console.log(`Importing ${data.length} rows into ${table}...`);
      await importTableData(client, table, data);
    }
    
    console.log('Data import completed successfully');
    
    // Recreate foreign key constraints
    console.log('Recreating foreign key constraints...');
    await recreateConstraints(client);
    
  } catch (err) {
    console.error('Error importing data:', err);
  } finally {
    await client.end();
  }
}

// Function to clean existing tables
async function cleanTables(client) {
  try {
    // Start a transaction
    await client.query('BEGIN');
    
    // Truncate each table (except users)
    for (const table of tablesToImport) {
      if (table !== 'users') {
        try {
          await client.query(`TRUNCATE TABLE "${table}" CASCADE`);
          console.log(`Truncated table ${table}`);
        } catch (err) {
          console.log(`Could not truncate table ${table}: ${err.message}`);
        }
      }
    }
    
    // Commit the transaction
    await client.query('COMMIT');
    console.log('Cleaned existing tables');
  } catch (err) {
    await client.query('ROLLBACK');
    console.error('Error cleaning tables:', err);
  }
}

// Function to import data into a table
async function importTableData(client, tableName, data) {
  if (data.length === 0) return;
  
  try {
    // Start a transaction
    await client.query('BEGIN');
    
    // Break data into manageable chunks (to avoid too many parameters in one query)
    const chunkSize = 100;
    for (let i = 0; i < data.length; i += chunkSize) {
      const chunk = data.slice(i, i + chunkSize);
      
      // Get column names from the first row
      const columns = Object.keys(chunk[0]);
      
      // For each row in the chunk
      for (const row of chunk) {
        // Build placeholders for values
        const placeholders = columns.map((_, i) => `$${i + 1}`).join(', ');
        const values = columns.map(col => row[col]);
        
        // Build the INSERT query with ON CONFLICT DO NOTHING
        const query = `
          INSERT INTO "${tableName}" (${columns.map(c => `"${c}"`).join(', ')})
          VALUES (${placeholders})
          ON CONFLICT DO NOTHING
        `;
        
        try {
          await client.query(query, values);
        } catch (err) {
          console.error(`Error inserting row into ${tableName}:`, err.message);
          // Continue with next row
        }
      }
      
      console.log(`Imported ${chunk.length} rows into ${tableName}`);
    }
    
    // Commit the transaction
    await client.query('COMMIT');
    console.log(`Completed importing data into ${tableName}`);
  } catch (err) {
    await client.query('ROLLBACK');
    console.error(`Error importing data to ${tableName}:`, err);
  }
}

// Function to recreate foreign key constraints
async function recreateConstraints(client) {
  // Store constraint info for recreation
  const constraintsInfo = [
    {
      table: 'load_operations_items',
      constraint: 'load_operations_items_load_operations_id_load_operations_id_fk',
      column: 'load_operations_id',
      foreignTable: 'load_operations',
      foreignColumn: 'id',
      onDelete: 'CASCADE'
    },
    {
      table: 'load_operations_items',
      constraint: 'load_operations_items_product_id_products_id_fk',
      column: 'product_id',
      foreignTable: 'products',
      foreignColumn: 'id',
      onDelete: 'SET NULL'
    },
    {
      table: 'load_operations',
      constraint: 'load_operations_created_by_id_users_id_fk',
      column: 'created_by_id',
      foreignTable: 'users',
      foreignColumn: 'id',
      onDelete: 'CASCADE'
    },
    {
      table: 'messages',
      constraint: 'messages_sender_id_users_id_fk',
      column: 'sender_id',
      foreignTable: 'users',
      foreignColumn: 'id',
      onDelete: 'CASCADE'
    },
    {
      table: 'messages',
      constraint: 'messages_recipient_id_users_id_fk',
      column: 'recipient_id',
      foreignTable: 'users',
      foreignColumn: 'id',
      onDelete: 'CASCADE'
    },
    {
      table: 'products',
      constraint: 'products_created_by_id_users_id_fk',
      column: 'created_by_id',
      foreignTable: 'users',
      foreignColumn: 'id',
      onDelete: 'SET NULL'
    },
    {
      table: 'proforma_slip_items',
      constraint: 'proforma_slip_items_proforma_slip_id_proforma_slips_id_fk',
      column: 'proforma_slip_id',
      foreignTable: 'proforma_slips',
      foreignColumn: 'id',
      onDelete: 'CASCADE'
    },
    {
      table: 'proforma_slip_items',
      constraint: 'proforma_slip_items_product_id_products_id_fk',
      column: 'product_id',
      foreignTable: 'products',
      foreignColumn: 'id',
      onDelete: 'SET NULL'
    },
    {
      table: 'proforma_slips',
      constraint: 'proforma_slips_created_by_id_users_id_fk',
      column: 'created_by_id',
      foreignTable: 'users',
      foreignColumn: 'id',
      onDelete: 'CASCADE'
    },
    {
      table: 'purchases',
      constraint: 'purchases_user_id_users_id_fk',
      column: 'user_id',
      foreignTable: 'users',
      foreignColumn: 'id',
      onDelete: 'CASCADE'
    },
    {
      table: 'sale_items',
      constraint: 'sale_items_sale_id_sales_id_fk',
      column: 'sale_id',
      foreignTable: 'sales',
      foreignColumn: 'id',
      onDelete: 'CASCADE'
    },
    {
      table: 'sales',
      constraint: 'sales_created_by_id_users_id_fk',
      column: 'created_by_id',
      foreignTable: 'users',
      foreignColumn: 'id',
      onDelete: 'CASCADE'
    },
    {
      table: 'scan_history',
      constraint: 'scan_history_product_id_products_id_fk',
      column: 'product_id',
      foreignTable: 'products',
      foreignColumn: 'id',
      onDelete: 'SET NULL'
    },
    {
      table: 'scan_history',
      constraint: 'scan_history_scanned_by_id_users_id_fk',
      column: 'scanned_by_id',
      foreignTable: 'users',
      foreignColumn: 'id',
      onDelete: 'CASCADE'
    },
    {
      table: 'vehicle_info',
      constraint: 'vehicle_info_last_edited_by_id_users_id_fk',
      column: 'last_edited_by_id',
      foreignTable: 'users',
      foreignColumn: 'id',
      onDelete: 'SET NULL'
    },
    {
      table: 'vehicle_info',
      constraint: 'vehicle_info_created_by_id_users_id_fk',
      column: 'created_by_id',
      foreignTable: 'users',
      foreignColumn: 'id',
      onDelete: 'SET NULL'
    }
  ];

  for (const constraint of constraintsInfo) {
    try {
      const query = `
        ALTER TABLE "${constraint.table}" 
        ADD CONSTRAINT "${constraint.constraint}" 
        FOREIGN KEY ("${constraint.column}") 
        REFERENCES "${constraint.foreignTable}" ("${constraint.foreignColumn}")
        ON DELETE ${constraint.onDelete};
      `;
      await client.query(query);
      console.log(`Recreated constraint ${constraint.constraint} on ${constraint.table}`);
    } catch (err) {
      console.error(`Error recreating constraint ${constraint.constraint}:`, err.message);
    }
  }
}

// Run the function
importData();