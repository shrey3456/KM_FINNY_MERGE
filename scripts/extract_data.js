import { spawn } from 'child_process';
import fs from 'fs';
import path from 'path';
import readline from 'readline';
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
const extractedDataPath = path.join(__dirname, 'extracted_data.sql');

if (!fs.existsSync(backupFilePath)) {
  console.error('Database backup file not found at:', backupFilePath);
  process.exit(1);
}

async function extractDataOnly() {
  console.log('Extracting data from backup file...');
  
  const fileStream = fs.createReadStream(backupFilePath);
  const rl = readline.createInterface({
    input: fileStream,
    crlfDelay: Infinity
  });

  // Open the output file for writing
  const outputStream = fs.createWriteStream(extractedDataPath);
  
  // Write a transaction start
  outputStream.write('BEGIN;\n\n');
  
  // Write truncate commands for all tables
  outputStream.write(`
-- First truncate all tables to remove existing data
TRUNCATE TABLE activities CASCADE;
TRUNCATE TABLE backup_settings CASCADE;
TRUNCATE TABLE load_operations CASCADE;
TRUNCATE TABLE load_operations_backup CASCADE;
TRUNCATE TABLE load_operations_items CASCADE;
TRUNCATE TABLE load_operations_items_backup CASCADE;
TRUNCATE TABLE messages CASCADE;
TRUNCATE TABLE products CASCADE;
TRUNCATE TABLE proforma_slip_items CASCADE;
TRUNCATE TABLE proforma_slip_items_backup CASCADE;
TRUNCATE TABLE proforma_slips CASCADE;
TRUNCATE TABLE proforma_slips_backup CASCADE;
TRUNCATE TABLE purchases CASCADE;
TRUNCATE TABLE sale_items CASCADE;
TRUNCATE TABLE sales CASCADE;
TRUNCATE TABLE sales_backup CASCADE;
TRUNCATE TABLE scan_history CASCADE;
TRUNCATE TABLE scan_history_backup CASCADE;
TRUNCATE TABLE users CASCADE;
TRUNCATE TABLE vehicle_info CASCADE;

-- Reset all sequences
ALTER SEQUENCE activities_id_seq RESTART WITH 1;
ALTER SEQUENCE backup_settings_id_seq RESTART WITH 1;
ALTER SEQUENCE loading_operations_id_seq RESTART WITH 1;
ALTER SEQUENCE loading_operations_backup_id_seq RESTART WITH 1;
ALTER SEQUENCE loading_op_items_id_seq RESTART WITH 1;
ALTER SEQUENCE loading_op_items_backup_id_seq RESTART WITH 1;
ALTER SEQUENCE messages_id_seq RESTART WITH 1;
ALTER SEQUENCE products_id_seq RESTART WITH 1;
ALTER SEQUENCE proforma_slip_items_id_seq RESTART WITH 1;
ALTER SEQUENCE proforma_slip_items_backup_id_seq RESTART WITH 1;
ALTER SEQUENCE proforma_slips_id_seq RESTART WITH 1;
ALTER SEQUENCE proforma_slips_backup_id_seq RESTART WITH 1;
ALTER SEQUENCE purchases_id_seq RESTART WITH 1;
ALTER SEQUENCE sale_items_id_seq RESTART WITH 1;
ALTER SEQUENCE sales_id_seq RESTART WITH 1;
ALTER SEQUENCE sales_backup_id_seq RESTART WITH 1;
ALTER SEQUENCE scan_history_id_seq RESTART WITH 1;
ALTER SEQUENCE scan_history_backup_id_seq RESTART WITH 1;
ALTER SEQUENCE users_id_seq RESTART WITH 1;
ALTER SEQUENCE vehicle_info_id_seq RESTART WITH 1;
\n\n`);

  let collectingData = false;
  let currentSection = '';
  
  for await (const line of rl) {
    // Look for COPY sections which contain the data
    if (line.startsWith('COPY public.')) {
      collectingData = true;
      currentSection = line;
      outputStream.write(line + '\n');
      console.log(`Found data section: ${line.substring(0, 50)}...`);
      continue;
    }
    
    // Check for end of COPY block
    if (collectingData && line === '\\.') {
      collectingData = false;
      outputStream.write(line + '\n\n');
      continue;
    }
    
    // If we're collecting data, write it to the output file
    if (collectingData) {
      outputStream.write(line + '\n');
    }
  }
  
  // Write transaction commit
  outputStream.write('\nCOMMIT;\n');
  outputStream.end();
  
  console.log(`Extracted data written to ${extractedDataPath}`);
  return extractedDataPath;
}

async function importData(dataFilePath) {
  console.log('Importing extracted data...');
  
  return new Promise((resolve, reject) => {
    const psql = spawn('psql', [databaseUrl, '-f', dataFilePath]);
    
    psql.stdout.on('data', (data) => {
      console.log(`psql stdout: ${data}`);
    });
    
    psql.stderr.on('data', (data) => {
      console.error(`psql stderr: ${data}`);
    });
    
    psql.on('close', (code) => {
      if (code === 0) {
        console.log('Data import completed successfully');
        resolve();
      } else {
        console.error(`Data import failed with code ${code}`);
        reject(new Error(`Import failed with code ${code}`));
      }
    });
    
    psql.on('error', (err) => {
      console.error('Error executing psql:', err);
      reject(err);
    });
  });
}

async function main() {
  try {
    const dataFilePath = await extractDataOnly();
    await importData(dataFilePath);
    console.log('Database restoration completed!');
  } catch (error) {
    console.error('Error during database restoration:', error);
    process.exit(1);
  }
}

main();