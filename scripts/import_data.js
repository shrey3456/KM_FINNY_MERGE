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

if (!fs.existsSync(backupFilePath)) {
  console.error('Database backup file not found at:', backupFilePath);
  process.exit(1);
}

console.log('Extracting and importing data...');

// Extract specific table data - only the INSERT commands
async function extractAndExecute() {
  // Read the file line by line
  const fileStream = fs.createReadStream(backupFilePath);
  const rl = readline.createInterface({
    input: fileStream,
    crlfDelay: Infinity
  });

  let currentTable = '';
  let collectingInserts = false;
  let insertBuffer = [];
  const tablesImported = new Set();
  
  for await (const line of rl) {
    // Detect table being copied
    if (line.startsWith('COPY public.')) {
      const match = line.match(/COPY public\.([a-z_]+)/);
      if (match) {
        currentTable = match[1];
        collectingInserts = true;
        console.log(`Found data for table: ${currentTable}`);
        
        // Skip if we've already processed this table
        if (tablesImported.has(currentTable)) {
          console.log(`Skipping table ${currentTable} - already imported`);
          collectingInserts = false;
          continue;
        }
        
        insertBuffer = [line];
      }
    }
    
    // Add data lines while collecting
    else if (collectingInserts) {
      insertBuffer.push(line);
      
      // If we see the end of COPY data
      if (line === '\\.') {
        collectingInserts = false;
        
        // Write insert statements to a temp file
        const tempFilePath = path.join(__dirname, `temp_${currentTable}.sql`);
        fs.writeFileSync(tempFilePath, insertBuffer.join('\n'));
        console.log(`Importing data for table: ${currentTable}`);
        
        // Execute the SQL to import just this table's data
        try {
          const psql = spawn('psql', [databaseUrl, '-f', tempFilePath]);
          
          // Process stdout and stderr
          psql.stdout.on('data', (data) => {
            console.log(`${currentTable} stdout: ${data}`);
          });
          
          psql.stderr.on('data', (data) => {
            console.error(`${currentTable} stderr: ${data}`);
          });
          
          // Wait for process to complete
          await new Promise((resolve, reject) => {
            psql.on('close', (code) => {
              if (code === 0) {
                console.log(`Successfully imported data for table: ${currentTable}`);
                tablesImported.add(currentTable);
                // Delete the temp file
                fs.unlinkSync(tempFilePath);
                resolve();
              } else {
                console.error(`Failed to import data for table ${currentTable} with code ${code}`);
                reject(new Error(`Import failed with code ${code}`));
              }
            });
            
            psql.on('error', (err) => {
              console.error(`Error executing psql for ${currentTable}:`, err);
              reject(err);
            });
          });
        } catch (err) {
          console.error(`Error importing ${currentTable}:`, err);
        }
        
        insertBuffer = [];
      }
    }
  }
  
  console.log('Data import completed');
}

// Run the extraction and execution
extractAndExecute().catch(err => {
  console.error('Error during import process:', err);
});