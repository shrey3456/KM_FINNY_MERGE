import type { Pool } from 'pg';
import { pool as defaultPool } from '../db';

// Manual Sales tables (Settings > Data Management > Manual Sales; server/routes/manual-sales.ts). Created with
// CREATE ... IF NOT EXISTS, so a plain server start is enough on any database — no `npm run db:*` needed.
// Also described in shared/schema.ts, for anyone who prefers generate + migrate; the two are the same shape.
export async function ensureManualSalesSchema(pool: Pool): Promise<void> {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS manual_sale_batches (
      id SERIAL PRIMARY KEY,
      sale_date DATE NOT NULL,
      plant TEXT NOT NULL,
      csv_file_name TEXT,
      row_count INTEGER NOT NULL DEFAULT 0,
      total_qty INTEGER NOT NULL DEFAULT 0,
      status TEXT NOT NULL DEFAULT 'active',
      created_by_code TEXT,
      created_by_name TEXT,
      created_at TIMESTAMP NOT NULL DEFAULT now(),
      reversed_at TIMESTAMP,
      reversed_by_code TEXT
    )`);
  await pool.query(`
    CREATE TABLE IF NOT EXISTS manual_sale_rows (
      id SERIAL PRIMARY KEY,
      batch_id INTEGER NOT NULL REFERENCES manual_sale_batches(id) ON DELETE CASCADE,
      barcode TEXT NOT NULL,
      item_name TEXT,
      product_id INTEGER,
      qty INTEGER NOT NULL,
      name_differs BOOLEAN NOT NULL DEFAULT false,
      csv_barcode TEXT,
      csv_name TEXT,
      requested_qty INTEGER
    )`);
  // what the CSV said, when the person chose a different product than its barcode (older tables get the columns here)
  await pool.query(`ALTER TABLE manual_sale_rows ADD COLUMN IF NOT EXISTS csv_barcode TEXT`);
  await pool.query(`ALTER TABLE manual_sale_rows ADD COLUMN IF NOT EXISTS csv_name TEXT`);
  // what the CSV asked for, when the stock only covered part of it (qty is what was actually sold)
  await pool.query(`ALTER TABLE manual_sale_rows ADD COLUMN IF NOT EXISTS requested_qty INTEGER`);
  await pool.query(`
    CREATE TABLE IF NOT EXISTS manual_sale_pulls (
      id SERIAL PRIMARY KEY,
      row_id INTEGER NOT NULL REFERENCES manual_sale_rows(id) ON DELETE CASCADE,
      source_plant TEXT NOT NULL,
      qty INTEGER NOT NULL
    )`);
  await pool.query(`CREATE INDEX IF NOT EXISTS manual_sale_rows_batch ON manual_sale_rows (batch_id)`);
  await pool.query(`CREATE INDEX IF NOT EXISTS manual_sale_pulls_row ON manual_sale_pulls (row_id)`);
}

// Stock Overview's Sale query reads these tables, so a report must never run before they exist — whatever
// happened to the long start-up migration chain.
// Checked on every call (one cheap lookup), not remembered for the life of the process: if the database is restored, switched or
// cleaned while the server is running, the tables are created again instead of every report failing with "relation does not exist".
let creating: Promise<void> | null = null;
export async function ensureManualSalesTables(): Promise<void> {
  const { rows } = await defaultPool.query(`SELECT to_regclass('public.manual_sale_pulls') AS t`);
  if (rows[0]?.t) return;
  if (!creating) creating = ensureManualSalesSchema(defaultPool).finally(() => { creating = null; });
  await creating;
}
