// scripts/db_inspect.ts
import { Pool } from "pg";
import { config } from "dotenv";
config();

if (!process.env.DATABASE_URL) {
  console.log("No DATABASE_URL found in env, trying to read from .env file directly...");
  // Read .env if dotenv didn't work (sometimes it's tricky in certain environments)
}

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
});

async function main() {
  const client = await pool.connect();
  try {
    console.log("Connected to database");
    
    // Get all tables
    const res = await client.query(`
      SELECT table_name 
      FROM information_schema.tables 
      WHERE table_schema = 'public'
    `);
    
    // For each table, get columns and constraints
    for (const row of res.rows) {
      const tableName = row.table_name;
      console.log(`\n--- Table: ${tableName} ---`);
      
      const columns = await client.query(`
        SELECT column_name, data_type, is_nullable
        FROM information_schema.columns 
        WHERE table_name = $1
      `, [tableName]);
      
      console.log("Columns:", columns.rows.map(c => `${c.column_name} (${c.data_type})`).join(", "));

      const constraints = await client.query(`
        SELECT kcu.column_name, tc.constraint_name, tc.constraint_type
        FROM information_schema.table_constraints tc
        JOIN information_schema.key_column_usage kcu 
          ON tc.constraint_name = kcu.constraint_name
          AND tc.table_schema = kcu.table_schema
        WHERE tc.table_name = $1 AND tc.constraint_type = 'PRIMARY KEY'
      `, [tableName]);
      
      console.log("Primary Key(s): " + constraints.rows.map(c => `${c.column_name} (${c.constraint_name})`).join(", "));
    }

  } catch (err) {
    console.error("Error inspecting DB:", err);
  } finally {
    client.release();
    await pool.end();
  }
}

main();
