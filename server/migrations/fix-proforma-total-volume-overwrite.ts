/**
 * One-time data fix: POST /loading/proforma/:orderNumber/link-vehicle used to overwrite
 * proforma_slips.total_volume with the LINKED VEHICLE's capacity (vehicle_info.volume) instead
 * of leaving it as the order's own required cargo volume (Product Master's per-item
 * volumeInCuFt, summed). server/routes/loading.ts no longer does this; this migration repairs
 * the rows it already corrupted — every slip that was actually linked via Loading
 * (vehicle_assigned_by_code IS NOT NULL) — by recomputing total_volume from
 * proforma_slip_items, the same math server/services/proformaNotionSync.ts uses at import time.
 */

import { db } from "../db";
import { sql } from "drizzle-orm";

export async function fixProformaTotalVolumeOverwrite() {
  console.log('Starting migration: fixProformaTotalVolumeOverwrite — recomputing total_volume for slips linked via Loading');

  try {
    const { rows: affected } = await db.execute(sql`
      SELECT id, order_number FROM proforma_slips WHERE vehicle_assigned_by_code IS NOT NULL
    `) as unknown as { rows: { id: number; order_number: string }[] };

    let updated = 0;
    for (const slip of affected) {
      const { rows: items } = await db.execute(sql`
        SELECT quantity, volume_in_cu_ft FROM proforma_slip_items WHERE proforma_slip_id = ${slip.id}
      `) as unknown as { rows: { quantity: number | null; volume_in_cu_ft: string | null }[] };

      let total = 0;
      for (const item of items) {
        const perUnit = parseFloat(item.volume_in_cu_ft ?? '0');
        if (Number.isFinite(perUnit)) total += perUnit * (item.quantity ?? 0);
      }

      await db.execute(sql`
        UPDATE proforma_slips SET total_volume = ${total.toFixed(2)} WHERE id = ${slip.id}
      `);
      console.log(`  order ${slip.order_number}: total_volume -> ${total.toFixed(2)}`);
      updated++;
    }

    console.log(`Fixed ${updated} proforma_slips row(s)`);
    return { success: true, updated };
  } catch (error) {
    console.error('Error during migration:', error);
    return { success: false, error };
  }
}

const isMainModule = import.meta.url.endsWith(process.argv[1].replace(/^file:\/\//, ''));
if (isMainModule) {
  fixProformaTotalVolumeOverwrite()
    .then((result) => {
      console.log('Migration completed:', result);
      process.exit(result.success ? 0 : 1);
    })
    .catch(error => {
      console.error('Migration failed:', error);
      process.exit(1);
    });
}
