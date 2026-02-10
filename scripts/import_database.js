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

console.log('Importing database from backup file...');

// Use the psql command to restore the database
const psql = spawn('psql', [databaseUrl], { stdio: ['pipe', 'inherit', 'inherit'] });

// Create a read stream for the backup file
const fileStream = fs.createReadStream(backupFilePath);

// Create a readline interface to read line by line
const rl = readline.createInterface({
  input: fileStream,
  crlfDelay: Infinity
});

let lineCount = 0;
const totalLines = 54674; // Total lines in the file from the information provided

// Pipe the content to psql
rl.on('line', (line) => {
  lineCount++;
  if (lineCount % 5000 === 0) {
    console.log(`Processed ${lineCount} lines (${(lineCount / totalLines * 100).toFixed(2)}%)`);
  }
  psql.stdin.write(line + '\n');
});

rl.on('close', () => {
  console.log('Finished reading backup file.');
  psql.stdin.end();
});

psql.on('close', (code) => {
  if (code === 0) {
    console.log('Database import completed successfully!');
  } else {
    console.error(`Database import failed with code ${code}`);
  }
});

psql.on('error', (err) => {
  console.error('Error executing psql command:', err);
});