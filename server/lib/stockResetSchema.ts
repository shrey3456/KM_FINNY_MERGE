import type { Pool } from 'pg';
import { pool as defaultPool } from '../db';

// Two things for the "fresh start" work (Settings > Reset Stock to Count, and the Stock Overview date rules).
//
// 1) stock_movements.effective_date — the day a stock line counts on in Stock Overview when that is NOT the day it was
//    written. Only Unloading uses it: a void or a quantity correction counts on the day of the scan it cancels / replaces
//    (scanned on 2 Oct, voided on 3 Oct -> 2 Oct's purchase goes down, 3 Oct is untouched). Lines that leave it empty
//    count on the day they were written (an unloading scan counts on the day it was scanned).
// 2) stock_reset_batches / stock_reset_rows — one batch per "reset stock to count" run, with every item's stock before and
//    after, so the run can be undone and the old numbers are kept as a backup.
//
// Created with IF NOT EXISTS at server start, and re-checked before each use (cheap), so a restored or switched database
// never breaks the report or the tool.
export async function ensureStockResetSchema(pool: Pool): Promise<void> {
  await pool.query(`ALTER TABLE stock_movements ADD COLUMN IF NOT EXISTS effective_date DATE`);
  await pool.query(`
    CREATE TABLE IF NOT EXISTS stock_reset_batches (
      id SERIAL PRIMARY KEY,
      plant TEXT NOT NULL,
      as_of_date DATE NOT NULL,
      item_count INTEGER NOT NULL DEFAULT 0,
      count_total INTEGER NOT NULL DEFAULT 0,
      live_before_total INTEGER NOT NULL DEFAULT 0,
      live_after_total INTEGER NOT NULL DEFAULT 0,
      csv_file_name TEXT,
      prev_tracking_start DATE,
      set_tracking_start BOOLEAN NOT NULL DEFAULT false,
      status TEXT NOT NULL DEFAULT 'active',
      created_by_code TEXT,
      created_by_name TEXT,
      created_at TIMESTAMP NOT NULL DEFAULT now(),
      undone_at TIMESTAMP,
      undone_by_code TEXT
    )`);
  await pool.query(`
    CREATE TABLE IF NOT EXISTS stock_reset_rows (
      id SERIAL PRIMARY KEY,
      batch_id INTEGER NOT NULL REFERENCES stock_reset_batches(id) ON DELETE CASCADE,
      barcode TEXT NOT NULL,
      product_id INTEGER,
      plant TEXT NOT NULL,
      count_qty INTEGER NOT NULL DEFAULT 0,
      live_before INTEGER NOT NULL DEFAULT 0,
      extra_before INTEGER NOT NULL DEFAULT 0,
      live_after INTEGER NOT NULL DEFAULT 0,
      extra_after INTEGER NOT NULL DEFAULT 0
    )`);
  await pool.query(`CREATE INDEX IF NOT EXISTS stock_reset_rows_batch ON stock_reset_rows (batch_id)`);
  // ledger lines a reset "threw away" (only when it was run without keeping what was already done on/after the start day): their
  // day is moved to the day before the start so Stock Overview ignores them; this remembers the old day so an undo can put it back.
  await pool.query(`
    CREATE TABLE IF NOT EXISTS stock_reset_discards (
      id SERIAL PRIMARY KEY,
      batch_id INTEGER NOT NULL REFERENCES stock_reset_batches(id) ON DELETE CASCADE,
      movement_id INTEGER NOT NULL,
      prev_effective_date DATE
    )`);
  await pool.query(`CREATE INDEX IF NOT EXISTS stock_reset_discards_batch ON stock_reset_discards (batch_id)`);

  // Voids / corrections written before effective_date existed: find the scan each one cancelled (same batch + barcode, voided
  // at the very moment the ledger line was written) and take that scan's day. A no-op once every line has its day.
  await pool.query(`
    UPDATE stock_movements sm SET effective_date = x.d
      FROM (
        SELECT DISTINCT ON (sm2.id) sm2.id, e.scanned_at::date AS d
          FROM stock_movements sm2
          JOIN unload_scan_events e ON e.session_id = sm2.session_id AND LOWER(TRIM(e.barcode)) = LOWER(TRIM(sm2.barcode))
         WHERE sm2.source = 'unloading' AND sm2.effective_date IS NULL
           AND (sm2.origin = 'void' OR sm2.reason LIKE 'Qty correction — old scan reversed%' OR sm2.reason LIKE 'Qty corrected (edited by%')
           AND e.voided IS TRUE AND e.voided_at IS NOT NULL
           AND ABS(EXTRACT(EPOCH FROM (e.voided_at - sm2.created_at))) < 5
         ORDER BY sm2.id, ABS(EXTRACT(EPOCH FROM (e.voided_at - sm2.created_at)))
      ) x
     WHERE sm.id = x.id`);
}

export async function ensureStockResetTables(): Promise<void> {
  const { rows } = await defaultPool.query(
    `SELECT CASE WHEN to_regclass('public.stock_reset_rows') IS NOT NULL AND to_regclass('public.stock_reset_discards') IS NOT NULL
                  AND EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name = 'stock_movements' AND column_name = 'effective_date')
                 THEN 1 END AS ok`);
  if (rows[0]?.ok) return;
  if (!creating) creating = ensureStockResetSchema(defaultPool).finally(() => { creating = null; });
  await creating;
}
let creating: Promise<void> | null = null;
