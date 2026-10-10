import type { Pool } from 'pg';
import { pool as defaultPool } from '../db';

// Settings > Data Management > "Load from Sales Orders file" (server/routes/loading-sales-import.ts) keeps one batch per upload
// and the loading_scan_events rows it made, so the whole batch can be reversed. Created with CREATE ... IF NOT EXISTS, so a
// plain server start is enough on any database — no `npm run db:*` step. Also described in shared/schema.ts.
export async function ensureLoadingSalesSchema(pool: Pool): Promise<void> {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS loading_sales_batches (
      id SERIAL PRIMARY KEY,
      sale_date DATE,
      csv_file_name TEXT,
      order_count INTEGER NOT NULL DEFAULT 0,
      event_count INTEGER NOT NULL DEFAULT 0,
      total_qty INTEGER NOT NULL DEFAULT 0,
      note TEXT,
      status TEXT NOT NULL DEFAULT 'active',
      created_by_code TEXT,
      created_by_name TEXT,
      created_at TIMESTAMP NOT NULL DEFAULT now(),
      reversed_at TIMESTAMP,
      reversed_by_code TEXT
    )`);
  await pool.query(`
    CREATE TABLE IF NOT EXISTS loading_sales_batch_events (
      id SERIAL PRIMARY KEY,
      batch_id INTEGER NOT NULL REFERENCES loading_sales_batches(id) ON DELETE CASCADE,
      event_id INTEGER NOT NULL,
      order_number TEXT NOT NULL
    )`);
  // the Loading-page rows (loading_records) a batch had to create so its orders show in the Loading list — removed again on reverse
  await pool.query(`ALTER TABLE loading_sales_batches ADD COLUMN IF NOT EXISTS created_record_ids INTEGER[]`);
  await pool.query(`CREATE INDEX IF NOT EXISTS loading_sales_batch_events_batch ON loading_sales_batch_events (batch_id)`);
}

// Checked on every call (one cheap lookup), not remembered for the life of the process: if the database is restored, switched or
// cleaned while the server is running, the tables are created again instead of every report failing with "relation does not exist".
let creating: Promise<void> | null = null;
export async function ensureLoadingSalesTables(): Promise<void> {
  const { rows } = await defaultPool.query(`SELECT CASE WHEN to_regclass('public.loading_sales_batch_events') IS NOT NULL AND EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name = 'loading_sales_batches' AND column_name = 'created_record_ids') THEN 1 END AS t`);
  if (rows[0]?.t) return;
  if (!creating) creating = ensureLoadingSalesSchema(defaultPool).finally(() => { creating = null; });
  await creating;
}
