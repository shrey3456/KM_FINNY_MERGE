import type { Pool } from 'pg';

// Stock (New) — the plant-wise stock lines and the day-by-day book behind the Stock (New) page. Entirely
// separate from product_plant_stock / stock_movements (the old Stock Overview keeps working off those);
// the operations write to both while the new one is being proven. See server/lib/stockV2.ts.
//
//   stock_v2_lines   one row = one item at one plant: name + barcode + SAP code (the state's) + the Product
//                    Master details copied when the line was created, and Stock = how much we have in total
//                    (all dates together). Loading will take from this number.
//   stock_v2_daily   one row per day + line: Purchase and Sale (extra INSIDE them) with the extra part kept
//                    in its own column for information, plus the transfer figures of a two-plant unloading.
//                    Opening and Closing are never stored — they are added up from the days.
//   stock_v2_ledger  the corrections (Adjust, Opening Stock, Clear Stock) and re-links, one row each.
//   stock_v2_links   a CSV / unloading batch / slip line pointing at its stock line, made when it is
//                    activated, so a scan never has to look the line up again.
export async function ensureStockV2Schema(pool: Pool): Promise<void> {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS stock_v2_lines (
      id              SERIAL PRIMARY KEY,
      plant           TEXT NOT NULL,
      state           TEXT,
      barcode         TEXT NOT NULL,
      item_name       TEXT NOT NULL,
      sap_code        TEXT,
      sap_is_fallback BOOLEAN NOT NULL DEFAULT false,
      sr_no           TEXT,
      brand           TEXT,
      category        TEXT,
      hsn_code        TEXT,
      pallet_size     INTEGER,
      product_id      INTEGER,
      stock_qty       INTEGER NOT NULL DEFAULT 0,
      created_at      TIMESTAMP NOT NULL DEFAULT now(),
      updated_at      TIMESTAMP NOT NULL DEFAULT now()
    )`);
  await pool.query(`
    CREATE UNIQUE INDEX IF NOT EXISTS stock_v2_lines_identity
      ON stock_v2_lines ((LOWER(plant)), (LOWER(barcode)), (LOWER(item_name)), (LOWER(COALESCE(sap_code, ''))))`);
  await pool.query(`CREATE INDEX IF NOT EXISTS stock_v2_lines_barcode ON stock_v2_lines ((LOWER(barcode)), (LOWER(plant)))`);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS stock_v2_daily (
      id                  SERIAL PRIMARY KEY,
      stock_date          DATE NOT NULL,
      line_id             INTEGER NOT NULL REFERENCES stock_v2_lines(id) ON DELETE CASCADE,
      purchase_qty        INTEGER NOT NULL DEFAULT 0,
      extra_purchase_qty  INTEGER NOT NULL DEFAULT 0,
      sale_qty            INTEGER NOT NULL DEFAULT 0,
      extra_sale_qty      INTEGER NOT NULL DEFAULT 0,
      transfer_in_qty     INTEGER NOT NULL DEFAULT 0,
      transfer_out_qty    INTEGER NOT NULL DEFAULT 0,
      UNIQUE (stock_date, line_id)
    )`);
  await pool.query(`CREATE INDEX IF NOT EXISTS stock_v2_daily_line ON stock_v2_daily (line_id, stock_date)`);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS stock_v2_ledger (
      id              SERIAL PRIMARY KEY,
      line_id         INTEGER NOT NULL REFERENCES stock_v2_lines(id) ON DELETE CASCADE,
      stock_date      DATE NOT NULL,
      kind            TEXT NOT NULL,
      qty             INTEGER NOT NULL,
      extra_qty       INTEGER NOT NULL DEFAULT 0,
      source          TEXT,
      source_ref      INTEGER,
      origin          TEXT,
      reason          TEXT,
      created_by_code TEXT,
      created_at      TIMESTAMP NOT NULL DEFAULT now()
    )`);
  await pool.query(`CREATE INDEX IF NOT EXISTS stock_v2_ledger_line ON stock_v2_ledger (line_id, stock_date)`);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS stock_v2_links (
      id               SERIAL PRIMARY KEY,
      kind             TEXT NOT NULL,
      ref_key          TEXT NOT NULL,
      line_id          INTEGER NOT NULL REFERENCES stock_v2_lines(id) ON DELETE CASCADE,
      purchase_line_id INTEGER REFERENCES stock_v2_lines(id) ON DELETE SET NULL,
      created_at       TIMESTAMP NOT NULL DEFAULT now(),
      UNIQUE (kind, ref_key)
    )`);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS stock_v2_config (
      id              INTEGER PRIMARY KEY DEFAULT 1,
      loading_uses_v2 BOOLEAN NOT NULL DEFAULT false,
      last_rebuild_at TIMESTAMP,
      last_rebuild_by TEXT
    )`);
  await pool.query(`ALTER TABLE stock_v2_config ADD COLUMN IF NOT EXISTS opening_open BOOLEAN NOT NULL DEFAULT false`);
  await pool.query(`ALTER TABLE stock_v2_config ADD COLUMN IF NOT EXISTS opening_date DATE`);
  await pool.query(`INSERT INTO stock_v2_config (id) VALUES (1) ON CONFLICT (id) DO NOTHING`);
}
