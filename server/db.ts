import dotenv from "dotenv";
dotenv.config();

import { Pool, types } from "pg";
import { drizzle } from "drizzle-orm/node-postgres";
import * as schema from "@shared/schema";

// Date-only columns (proforma_slips.order_date, purchase dates, ...) come back as the plain
// "YYYY-MM-DD" text stored in the database, never as a JS Date. node-postgres otherwise builds a
// Date at LOCAL midnight — on a server running India time that is 18:30 the previous day in UTC,
// so the JSON sent to the browser read "2026-08-31T18:30:00.000Z" for an order dated 1 Sep, and
// every screen that took its first 10 characters showed 31 Aug. Drizzle queries already return
// these as text; this makes raw pool.query() results match. Process-wide, set before any query.
types.setTypeParser(types.builtins.DATE, (value: string) => value);

const connectionString =
  process.env.DATABASE_URL ||
  "postgresql://kmuser:km_pass@localhost:5432/km_finny";

// Create pool with better configuration for handling concurrent operations
export const pool = new Pool({
  connectionString,
  max: 20, // Increase connection pool size for better concurrency
  idleTimeoutMillis: 30000, // How long a client is allowed to remain idle before being closed
  connectionTimeoutMillis: 5000, // How long to wait for a connection
});

// Monitor connection pool for issues
pool.on("error", (err) => {
  console.error("Database pool error:", err);
});

// Drizzle DB client (node-postgres adapter)
export const db = drizzle(pool, { schema });

/**
 * Safely converts any input value to a proper boolean for database storage
 * This is especially important for the 'loaded' field in loading operation items
 *
 * @param value Any value that should be converted to boolean
 * @returns A true JavaScript boolean value
 */
export function toBoolean(value: any): boolean {
  // Handle string 'true' which can come from form data
  if (typeof value === "string") {
    return value.toLowerCase() === "true";
  }
  // Normal boolean conversion for everything else
  return value === true;
}

/**
 * Reset a sequence to the maximum value of the ID column in the table
 * @param tableName The name of the table
 * @param sequenceName The name of the sequence to reset
 * @param safetyOffset Optional safety margin to add to the max ID
 * @returns The new sequence value
 */
export async function resetSequence(
  tableName: string,
  sequenceName: string,
  safetyOffset: number = 10
): Promise<number> {
  try {
    // First, get the current maximum ID from the table
    const res = await pool.query(`SELECT MAX(id) as max_id FROM ${tableName}`);
    const maxId = res.rows[0]?.max_id ? Number(res.rows[0].max_id) : 0;
    const newStartValue = maxId + safetyOffset;

    console.log(
      `Resetting sequence ${sequenceName} to start from ${newStartValue} (max ID = ${maxId})`
    );

    // Set the sequence to the new value
    await pool.query(`ALTER SEQUENCE ${sequenceName} RESTART WITH $1`, [
      newStartValue,
    ]);

    // Verify the change
    const verify = await pool.query(`SELECT last_value FROM ${sequenceName}`);
    const newValue = Number(verify.rows[0]?.last_value) || newStartValue;
    console.log(`Sequence ${sequenceName} reset to ${newValue}`);

    return newValue;
  } catch (error) {
    console.error(`Error resetting sequence ${sequenceName}:`, error);
    throw error;
  }
}
