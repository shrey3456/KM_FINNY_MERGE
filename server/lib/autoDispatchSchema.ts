import type { Pool } from 'pg';

// Columns Auto Dispatch relies on (see server/services/autoDispatch.ts). Created at server start with IF NOT EXISTS, so a plain
// start is enough on any database. auto_dispatch defaults to false: every slip that exists when this first runs stays "previous"
// and is never dispatched by itself; only a load created afterwards (Create Operation) is marked true.
export async function ensureAutoDispatchSchema(pool: Pool): Promise<void> {
  await pool.query(`ALTER TABLE proforma_slips ADD COLUMN IF NOT EXISTS auto_dispatch BOOLEAN NOT NULL DEFAULT false`);
  await pool.query(`ALTER TABLE proforma_slips ADD COLUMN IF NOT EXISTS dispatched_at TIMESTAMP`);
  // The job looks only at completed loads that are flagged — a tiny partial index keeps the 5-minute check instant.
  await pool.query(
    `CREATE INDEX IF NOT EXISTS idx_proforma_slips_auto_dispatch_due ON proforma_slips (loading_completed_at) WHERE auto_dispatch = true AND dispatched_at IS NULL`,
  );
}
