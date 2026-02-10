import pg from 'pg';
import dotenv from 'dotenv';

// Load environment variables
dotenv.config();

const { Client } = pg;

async function dropConstraints() {
  // Create a PostgreSQL client
  const client = new Client({
    connectionString: process.env.DATABASE_URL,
  });

  try {
    // Connect to the database
    await client.connect();
    console.log('Connected to database');
    
    // Start a transaction
    await client.query('BEGIN');
    
    // Drop all foreign key constraints
    console.log('Dropping all foreign key constraints...');
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
    
    // Commit the transaction
    await client.query('COMMIT');
    console.log('All constraints dropped successfully');
  } catch (err) {
    await client.query('ROLLBACK');
    console.error('Error dropping constraints:', err);
  } finally {
    await client.end();
  }
}

dropConstraints();