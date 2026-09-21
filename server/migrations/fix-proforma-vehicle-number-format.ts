/**
 * One-time data fix: proforma_slips.vehicle_number was being stored in the raw
 * "<code> {<rtoNumber>}" format the Notion dispatch DB's "Vehi No:" rollup renders as (e.g.
 * "87 {GJ-15-AV-5725}") instead of the bare code ("87") vehicle_info.vehicle_number actually
 * uses — so it could never match a real Vehicle Master row via getVehicleInfoByVehicleNumber.
 * server/services/proformaNotionSync.ts now strips this at import time (extractVehicleCode);
 * this migration fixes rows already imported before that fix, so this data doesn't have to wait
 * for the next Notion sync to become usable.
 *
 * Only touches rows nobody has claimed via the Loading page yet (vehicle_assigned_by_code IS
 * NULL) — a real Loading link always writes a clean vehicle_info.vehicleNumber already, so it
 * would never match the messy pattern below anyway; the guard is just a safety net.
 */

import { db } from "../db";
import { sql } from "drizzle-orm";

export async function fixProformaVehicleNumberFormat() {
  console.log('Starting migration: fixProformaVehicleNumberFormat — stripping " {rtoNumber}" suffix from proforma_slips.vehicle_number');

  try {
    const result = await db.execute(sql`
      UPDATE proforma_slips
      SET vehicle_number = split_part(vehicle_number, ' {', 1)
      WHERE vehicle_number LIKE '% {%}%'
      AND vehicle_assigned_by_code IS NULL
    `);
    console.log(`Fixed ${result.rowCount ?? 0} proforma_slips row(s)`);
    return { success: true, updated: result.rowCount ?? 0 };
  } catch (error) {
    console.error('Error during migration:', error);
    return { success: false, error };
  }
}

const isMainModule = import.meta.url.endsWith(process.argv[1].replace(/^file:\/\//, ''));
if (isMainModule) {
  fixProformaVehicleNumberFormat()
    .then((result) => {
      console.log('Migration completed:', result);
      process.exit(result.success ? 0 : 1);
    })
    .catch(error => {
      console.error('Migration failed:', error);
      process.exit(1);
    });
}
