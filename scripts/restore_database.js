import pg from 'pg';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { spawn } from 'child_process';
import dotenv from 'dotenv';

// Load environment variables
dotenv.config();

const { Client } = pg;

// Get the directory name
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Path to the SQL dump file
const dumpFilePath = path.join(__dirname, '..', 'attached_assets', 'database_backup.sql');

async function restoreDatabase() {
  // Create a PostgreSQL client
  const client = new Client({
    connectionString: process.env.DATABASE_URL,
  });

  try {
    // Connect to the database
    await client.connect();
    console.log('Connected to database');

    // Drop all constraints first to avoid issues during data loading
    console.log('Dropping foreign key constraints...');
    await dropConstraints(client);

    // Disable triggers
    console.log('Disabling triggers (if possible)...');
    try {
      await client.query('SET session_replication_role = replica;');
      console.log('Triggers disabled');
    } catch (e) {
      console.log('Could not disable triggers, continuing anyway:', e.message);
    }

    // Use the pg_restore command directly for better compatibility
    await runPsqlCommand();

    // Re-enable triggers
    console.log('Re-enabling triggers...');
    try {
      await client.query('SET session_replication_role = DEFAULT;');
      console.log('Triggers re-enabled');
    } catch (e) {
      console.log('Could not re-enable triggers, continuing anyway:', e.message);
    }

    // Add constraints back
    console.log('Recreating foreign key constraints...');
    await recreateConstraints(client);

    console.log('Database restoration completed successfully');
  } catch (error) {
    console.error('Error restoring database:', error);
  } finally {
    await client.end();
  }
}

// Function to run psql command to restore database
function runPsqlCommand() {
  return new Promise((resolve, reject) => {
    // Parse DATABASE_URL to extract components
    const url = new URL(process.env.DATABASE_URL);
    const host = url.hostname;
    const port = url.port;
    const database = url.pathname.substring(1); // Remove leading /
    const username = url.username;
    const password = url.password;

    // Set environment variables for psql
    const env = {
      ...process.env,
      PGPASSWORD: password
    };

    // Use psql to restore the database
    const psql = spawn('psql', [
      `-h${host}`,
      `-p${port}`,
      `-U${username}`,
      `-d${database}`,
      '-f', dumpFilePath
    ], { env });

    psql.stdout.on('data', (data) => {
      console.log(`psql output: ${data}`);
    });

    psql.stderr.on('data', (data) => {
      console.error(`psql error: ${data}`);
    });

    psql.on('close', (code) => {
      if (code === 0) {
        console.log('Database restored successfully using psql');
        resolve();
      } else {
        console.error(`psql process exited with code ${code}`);
        reject(new Error(`psql process exited with code ${code}`));
      }
    });
  });
}

// Function to drop all foreign key constraints
async function dropConstraints(client) {
  const constraintsQuery = `
    SELECT 
      tc.constraint_name, 
      tc.table_name, 
      kcu.column_name, 
      ccu.table_name AS foreign_table_name,
      ccu.column_name AS foreign_column_name 
    FROM 
      information_schema.table_constraints AS tc 
      JOIN information_schema.key_column_usage AS kcu
        ON tc.constraint_name = kcu.constraint_name
      JOIN information_schema.constraint_column_usage AS ccu 
        ON ccu.constraint_name = tc.constraint_name 
    WHERE tc.constraint_type = 'FOREIGN KEY';
  `;

  try {
    const result = await client.query(constraintsQuery);
    console.log(`Found ${result.rows.length} foreign key constraints to drop`);
    
    for (const constraint of result.rows) {
      try {
        const dropQuery = `ALTER TABLE "${constraint.table_name}" DROP CONSTRAINT "${constraint.constraint_name}";`;
        await client.query(dropQuery);
        console.log(`Dropped constraint ${constraint.constraint_name} from ${constraint.table_name}`);
      } catch (e) {
        console.error(`Error dropping constraint ${constraint.constraint_name}:`, e.message);
      }
    }
  } catch (e) {
    console.error('Error getting constraints:', e.message);
  }
}

// Function to recreate all foreign key constraints
async function recreateConstraints(client) {
  // Store constraint info for recreation
  const constraintsInfo = [
    {
      table: 'activities',
      constraint: 'activities_entity_id_fkey',
      column: 'entity_id',
      foreignTable: 'users',
      foreignColumn: 'id',
      onDelete: 'CASCADE'
    },
    {
      table: 'load_operations',
      constraint: 'load_operations_created_by_id_fkey',
      column: 'created_by_id',
      foreignTable: 'users',
      foreignColumn: 'id',
      onDelete: 'CASCADE'
    },
    {
      table: 'load_operations_items',
      constraint: 'load_operations_items_load_operations_id_fkey',
      column: 'load_operations_id',
      foreignTable: 'load_operations',
      foreignColumn: 'id',
      onDelete: 'CASCADE'
    },
    {
      table: 'load_operations_items',
      constraint: 'load_operations_items_product_id_fkey',
      column: 'product_id',
      foreignTable: 'products',
      foreignColumn: 'id',
      onDelete: 'SET NULL'
    },
    {
      table: 'messages',
      constraint: 'messages_from_user_id_fkey',
      column: 'from_user_id',
      foreignTable: 'users',
      foreignColumn: 'id',
      onDelete: 'CASCADE'
    },
    {
      table: 'messages',
      constraint: 'messages_to_user_id_fkey',
      column: 'to_user_id',
      foreignTable: 'users',
      foreignColumn: 'id',
      onDelete: 'CASCADE'
    },
    {
      table: 'proforma_slip_items',
      constraint: 'proforma_slip_items_product_id_fkey',
      column: 'product_id',
      foreignTable: 'products',
      foreignColumn: 'id',
      onDelete: 'SET NULL'
    },
    {
      table: 'proforma_slip_items',
      constraint: 'proforma_slip_items_proforma_slip_id_fkey',
      column: 'proforma_slip_id',
      foreignTable: 'proforma_slips',
      foreignColumn: 'id',
      onDelete: 'CASCADE'
    },
    {
      table: 'proforma_slips',
      constraint: 'proforma_slips_created_by_id_fkey',
      column: 'created_by_id',
      foreignTable: 'users',
      foreignColumn: 'id',
      onDelete: 'CASCADE'
    },
    {
      table: 'scan_history',
      constraint: 'scan_history_product_id_fkey',
      column: 'product_id',
      foreignTable: 'products',
      foreignColumn: 'id',
      onDelete: 'SET NULL'
    },
    {
      table: 'scan_history',
      constraint: 'scan_history_user_id_fkey',
      column: 'user_id',
      foreignTable: 'users',
      foreignColumn: 'id',
      onDelete: 'CASCADE'
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
    } catch (e) {
      console.error(`Error recreating constraint ${constraint.constraint}:`, e.message);
    }
  }
}

// Run the function
restoreDatabase();