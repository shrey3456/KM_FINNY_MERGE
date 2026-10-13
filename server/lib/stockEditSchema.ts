import type { Pool } from 'pg';

// A manual Stock adjustment can be edited from Scan History (PUT /api/plant-stock/movements/:id in server/routes/plant-stock-admin.ts).
// These columns keep what the edit changed: the quantity it had before the first edit, who edited it last and when.
export async function ensureStockEditSchema(pool: Pool): Promise<void> {
  await pool.query(`ALTER TABLE stock_movements ADD COLUMN IF NOT EXISTS original_qty INTEGER`);
  await pool.query(`ALTER TABLE stock_movements ADD COLUMN IF NOT EXISTS edited_at TIMESTAMP`);
  await pool.query(`ALTER TABLE stock_movements ADD COLUMN IF NOT EXISTS edited_by_code TEXT`);
}
