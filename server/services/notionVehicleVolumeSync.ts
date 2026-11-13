import { Client } from '@notionhq/client';
import { pool } from '../db';

const VEHICLE_VOLUME_PROPERTY = 'Vol ';
const normalizeDate = (value: unknown): string => String(value ?? '').slice(0, 10);

/**
 * Writes the loaded volume for a dispatched slip to the linked vehicle's Notion page.
 * Slips on the same vehicle and order date accumulate; a new date starts a new value.
 * The local event table makes retries idempotent.
 */
export async function syncVehicleVolumeForDispatchedOrder(orderNumber: string): Promise<void> {
  const { rows } = await pool.query(
    `SELECT ps.order_number AS "orderNumber", ps.order_date AS "orderDate",
            v.id AS "vehicleId", v.notion_page_id AS "vehiclePageId",
            COALESCE((
              SELECT SUM(
                CASE WHEN i.volume_in_cu_ft ~ '^[0-9]+([.][0-9]+)?$'
                     THEN i.volume_in_cu_ft::numeric ELSE 0 END * ev.total_qty
              )
              FROM loading_scan_events ev
              LEFT JOIN proforma_slip_items i
                ON i.proforma_slip_id = ps.id AND i.barcode = ev.barcode
               AND (i.product_id IS NOT DISTINCT FROM ev.product_id)
              WHERE ev.order_number = ps.order_number AND ev.voided IS NOT TRUE
            ), 0)::float AS "loadedVolume"
       FROM proforma_slips ps
       LEFT JOIN vehicle_info v ON v.id = ps.vehicle_info_id
      WHERE ps.order_number = $1
      LIMIT 1`,
    [orderNumber],
  );
  const slip = rows[0];
  const loadedVolume = Number(slip?.loadedVolume);
  if (!slip || !slip.vehicleId || !slip.vehiclePageId || !Number.isFinite(loadedVolume) || loadedVolume <= 0) return;

  const slipDate = normalizeDate(slip.orderDate);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(slipDate)) {
    console.warn(`[Notion vehicle volume sync] Skipping ${orderNumber}: invalid order date`);
    return;
  }

  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query(`SELECT pg_advisory_xact_lock(hashtext($1))`, [`vehicle-volume:${slip.vehicleId}`]);

    const alreadyApplied = await client.query(
      `SELECT 1 FROM vehicle_volume_sync_events WHERE order_number = $1 LIMIT 1`,
      [orderNumber],
    );
    if (alreadyApplied.rowCount) {
      await client.query('COMMIT');
      return;
    }

    const stateResult = await client.query(
      `SELECT volume_date AS "volumeDate", volume
         FROM vehicle_volume_sync_state
        WHERE vehicle_id = $1
        FOR UPDATE`,
      [slip.vehicleId],
    );
    const state = stateResult.rows[0];
    const nextVolume = state && normalizeDate(state.volumeDate) === slipDate
      ? Number(state.volume) + loadedVolume
      : loadedVolume;
    const roundedVolume = Number(nextVolume.toFixed(2));

    const secret = (process.env.NOTION_INTEGRATION_SECRET ?? process.env.NOTION_API_KEY ?? '').trim();
    const databaseId = (process.env.NOTION_VEHICLE_DATABASE_ID ?? '').trim();
    if (!secret || !databaseId) throw new Error('Notion vehicle database is not configured');

    const notion = new Client({ auth: secret });
    const page: any = await notion.pages.retrieve({ page_id: slip.vehiclePageId });
    const current = page.properties?.[VEHICLE_VOLUME_PROPERTY];
    if (!current || current.type !== 'number') {
      throw new Error(`Vehicle page is missing numeric "${VEHICLE_VOLUME_PROPERTY}" property`);
    }
    await notion.pages.update({
      page_id: slip.vehiclePageId,
      properties: { [VEHICLE_VOLUME_PROPERTY]: { number: roundedVolume } },
    } as any);
    const after: any = await notion.pages.retrieve({ page_id: slip.vehiclePageId });
    const written = after.properties?.[VEHICLE_VOLUME_PROPERTY]?.number;
    if (Number(written) !== roundedVolume) throw new Error('Notion did not keep the vehicle volume change');

    await client.query(
      `INSERT INTO vehicle_volume_sync_state (vehicle_id, volume_date, volume, updated_at)
       VALUES ($1, $2, $3, NOW())
       ON CONFLICT (vehicle_id) DO UPDATE
       SET volume_date = EXCLUDED.volume_date, volume = EXCLUDED.volume, updated_at = NOW()`,
      [slip.vehicleId, slipDate, roundedVolume],
    );
    await client.query(
      `INSERT INTO vehicle_volume_sync_events (order_number, vehicle_id, volume_date, volume, applied_at)
       VALUES ($1, $2, $3, $4, NOW())`,
      [orderNumber, slip.vehicleId, slipDate, loadedVolume],
    );
    await client.query('COMMIT');
    console.log(`[Notion vehicle volume sync] ${orderNumber} -> vehicle ${slip.vehicleId}: ${roundedVolume}`);
  } catch (error) {
    await client.query('ROLLBACK').catch((rollbackError) => {
      console.error('[Notion vehicle volume sync] Rollback failed:', rollbackError);
    });
    console.error(`[Notion vehicle volume sync] Failed for ${orderNumber}:`, error instanceof Error ? error.message : error);
  } finally {
    client.release();
  }
}
