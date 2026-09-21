import { pool } from './db';
import { storage } from './storage';

/**
 * One-time backfill: resolves every proforma_slips row that has a vehicleNumber but no
 * vehicleInfoId (i.e. it's only ever been matched by fragile text, never linked to a specific
 * Vehicle Master row by id) down to the exact Vehicle Master row it means, using the same
 * resolver writeOrderToDb (proformaNotionSync.ts) now applies going forward. Runs regardless of
 * whether the order's vehicle has already been confirmed (vehicleAssignedByCode set) — a
 * confirmed order missing its id link is just as fragile to a future Vehicle Master text edit as
 * an unconfirmed one, so it gets backfilled too. Also normalizes vehicleNumber to Vehicle
 * Master's own clean text when a match is found, since Notion's raw text can carry a
 * "<code> {<rto>}" suffix that was never stripped (see extractVehicleCode).
 */
async function linkVehicleInfoForExistingSlips() {
  console.log('Starting vehicleInfoId backfill for existing proforma slips...');

  const { rows } = await pool.query(
    `SELECT id, order_number AS "orderNumber", vehicle_number AS "vehicleNumber",
            vehicle_assigned_by_code AS "vehicleAssignedByCode"
     FROM proforma_slips
     WHERE vehicle_info_id IS NULL AND vehicle_number IS NOT NULL AND vehicle_number <> ''`,
  );
  console.log(`Found ${rows.length} slip(s) with a vehicleNumber but no vehicleInfoId.`);

  let linked = 0;
  let unmatched = 0;
  let errors = 0;

  for (const row of rows) {
    try {
      const vehicle = await storage.getVehicleInfoFromNotionText(row.vehicleNumber);
      if (!vehicle) {
        unmatched++;
        continue;
      }
      await pool.query(
        `UPDATE proforma_slips SET vehicle_info_id = $1, vehicle_number = $2 WHERE id = $3`,
        [vehicle.id, vehicle.vehicleNumber, row.id],
      );
      console.log(
        `Order ${row.orderNumber}: "${row.vehicleNumber}" -> vehicle #${vehicle.id} (${vehicle.vehicleNumber})`
        + (row.vehicleAssignedByCode ? ' [already confirmed]' : ' [not yet confirmed]'),
      );
      linked++;
    } catch (error) {
      console.error(`Error resolving order ${row.orderNumber} ("${row.vehicleNumber}"):`, error);
      errors++;
    }
  }

  console.log(`Backfill complete: ${linked} linked, ${unmatched} unmatched (no Vehicle Master row found), ${errors} error(s).`);
  return { linked, unmatched, errors };
}

// Run unconditionally — this file is meant to be executed directly (`tsx server/migration-
// vehicle-info-link.ts`), never imported elsewhere, so there's no need for the isMainModule
// guard other migration-*.ts scripts use (which doesn't reliably match on Windows anyway, where
// process.argv[1] uses backslashes and import.meta.url doesn't).
linkVehicleInfoForExistingSlips()
  .then((result) => {
    console.log('Vehicle info backfill result:', result);
    process.exit(0);
  })
  .catch((error) => {
    console.error('Unhandled error during vehicle info backfill:', error);
    process.exit(1);
  });
