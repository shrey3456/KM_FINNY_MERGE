import type { Pool } from 'pg';

// Indexes the Loading page (and Loading Overview / Scan History) lean on. Without them every row of /loading/records ran 3 separate
// full scans of loading_scan_events and proforma_slip_items (23k and 66k rows here): one page took ~6 s and the whole-list totals
// ~3.5 minutes; with them 50 ms and 150 ms. CREATE INDEX IF NOT EXISTS, so a plain server start is enough on any database
// (a few hundred milliseconds on this data).
export async function ensureLoadingIndexes(pool: Pool): Promise<void> {
  // the load quantity / volume per order — matches "WHERE order_number = ? AND voided IS NOT TRUE [GROUP BY barcode]"
  await pool.query(`CREATE INDEX IF NOT EXISTS idx_loading_scan_events_order_active ON loading_scan_events (order_number, barcode) WHERE voided IS NOT TRUE`);
  // a slip's items, and one item of a slip by barcode
  await pool.query(`CREATE INDEX IF NOT EXISTS idx_proforma_slip_items_slip_barcode ON proforma_slip_items (proforma_slip_id, barcode)`);
  // order number -> slip, and order number -> its load record
  await pool.query(`CREATE INDEX IF NOT EXISTS idx_proforma_slips_order_number ON proforma_slips (order_number)`);
  await pool.query(`CREATE INDEX IF NOT EXISTS idx_loading_records_order_number ON loading_records (order_number)`);
}
