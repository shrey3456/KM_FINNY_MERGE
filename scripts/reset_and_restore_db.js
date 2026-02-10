import { spawn } from 'child_process';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Get database URL from environment
const databaseUrl = process.env.DATABASE_URL;

if (!databaseUrl) {
  console.error('DATABASE_URL environment variable not set');
  process.exit(1);
}

const backupFilePath = path.join(__dirname, '..', 'attached_assets', 'database_backup.sql');

if (!fs.existsSync(backupFilePath)) {
  console.error('Database backup file not found at:', backupFilePath);
  process.exit(1);
}

// First, create a script that drops all tables
const dropTablesSqlPath = path.join(__dirname, 'drop_tables.sql');
fs.writeFileSync(
  dropTablesSqlPath,
  `
DO $$ 
DECLARE
    r RECORD;
BEGIN
    -- Disable all triggers
    FOR r IN (SELECT tablename FROM pg_tables WHERE schemaname = 'public') LOOP
        EXECUTE 'ALTER TABLE public.' || quote_ident(r.tablename) || ' DISABLE TRIGGER ALL;';
    END LOOP;

    -- Drop all tables
    FOR r IN (SELECT tablename FROM pg_tables WHERE schemaname = 'public') LOOP
        EXECUTE 'DROP TABLE IF EXISTS public.' || quote_ident(r.tablename) || ' CASCADE;';
    END LOOP;
END $$;
`
);

console.log('Created SQL script to drop all tables');

// Function to execute a command and return a promise
async function executeCommand(command, args) {
  return new Promise((resolve, reject) => {
    console.log(`Executing command: ${command} ${args.join(' ')}`);
    const process = spawn(command, args);
    
    process.stdout.on('data', (data) => {
      console.log(`stdout: ${data}`);
    });
    
    process.stderr.on('data', (data) => {
      console.error(`stderr: ${data}`);
    });
    
    process.on('close', (code) => {
      if (code === 0) {
        console.log(`Command completed successfully`);
        resolve();
      } else {
        console.error(`Command failed with code ${code}`);
        reject(new Error(`Command failed with code ${code}`));
      }
    });
    
    process.on('error', (err) => {
      console.error(`Failed to execute command: ${err}`);
      reject(err);
    });
  });
}

// Main function to reset and restore database
async function resetAndRestoreDb() {
  try {
    // Step 1: Drop all tables
    console.log('Dropping all existing tables...');
    await executeCommand('psql', [databaseUrl, '-f', dropTablesSqlPath]);
    
    // Step 2: Restore the database from backup
    console.log('Restoring database from backup...');
    await executeCommand('psql', [databaseUrl, '-f', backupFilePath]);
    
    console.log('Database has been successfully reset and restored from backup!');
    
    // Clean up
    fs.unlinkSync(dropTablesSqlPath);
  } catch (error) {
    console.error('Error during database reset and restore:', error);
    process.exit(1);
  }
}

// Run the reset and restore process
resetAndRestoreDb();