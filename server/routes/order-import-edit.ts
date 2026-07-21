import { Router, Request, Response } from 'express';
import { pool } from '../db';
import { requirePageAccess, requirePageWrite } from '../lib/pageAccess';
import { broadcastOrderImportUpdate } from '../lib/importEvents';
import { getUserPlants } from './order-scan';

// ============================================================================
// ORDER IMPORT EDIT — a focused, non-admin-gated page for fixing mistakes in a
// CSV after it's been uploaded (e.g. one wrong barcode), without deleting and
// re-uploading the whole file. Gated purely by the "order-import-edit" page
// key (allowedPages = read-only view, pageWriteAccess = can actually save),
// independent of the existing Order Import page's own admin/plant-scoped
// access rules in order-import.ts.
//
// Only sessions that are NOT yet completed are ever listed here — a finished,
// reconciled CSV can't be rewritten from this page.
//
// Plant scoping mirrors Overall Stock / Scan History (getUserPlants, from the Users
// page's users.plants): admin/super-admin/billing see every plant, everyone else only
// the plant(s) assigned to them — a non-admin with none assigned sees nothing.
//
// Editing an item is normally a simple field update (item stays linked to its
// own scan history because its row ID never changes). Changing an item's
// BARCODE is the one special case: order_scan_items/order_scan_events store
// their own copy of the barcode text, and stock (products.in_stock +
// product_plant_stock) was already credited to the OLD barcode the moment it
// was scanned (live-scan model). So whenever a barcode changes on an item
// that already has scanned quantity, the transaction below also relinks the
// scan rows and MOVES the stock from the old barcode to the new one, instead
// of leaving it orphaned.
// ============================================================================

const router = Router();

router.use('/order-import-edit', (_req: Request, res: Response, next) => {
  res.set('Cache-Control', 'no-store, no-cache, must-revalidate');
  res.set('Pragma', 'no-cache');
  next();
});

// GET /api/order-import-edit/sessions?date=YYYY-MM-DD
router.get('/order-import-edit/sessions', requirePageAccess('order-import-edit'), async (req: Request, res: Response) => {
  try {
    const date = String(req.query.date ?? '');
    if (!date) return res.status(400).json({ message: 'date is required' });
    const plantParam = typeof req.query.plant === 'string' && req.query.plant.trim() ? req.query.plant.trim() : null;

    const allowedPlants = getUserPlants(req.user); // null = admin (all plants)
    if (allowedPlants !== null && allowedPlants.length === 0) {
      return res.json({ sessions: [], plants: [] });
    }

    const conditions = [
      `ois.is_deleted = false`,
      `ois.order_date = $1`,
      `ois.scan_status IS DISTINCT FROM 'completed'`,
    ];
    const params: (string | string[])[] = [date];

    if (allowedPlants !== null) {
      params.push(allowedPlants);
      conditions.push(`LOWER(ois.plant) = ANY($${params.length}::text[])`);
    }
    if (plantParam) {
      params.push(plantParam.toLowerCase());
      conditions.push(`LOWER(ois.plant) = $${params.length}`);
    }

    const { rows } = await pool.query(
      `SELECT
         ois.id,
         ois.plant,
         ois.csv_file_name    AS "csvFileName",
         ois.order_date       AS "orderDate",
         ois.scan_status      AS "scanStatus",
         ois.row_count        AS "rowCount",
         ois.receiving_session_id AS "receivingSessionId",
         ois.part_index       AS "partIndex"
       FROM order_import_sessions ois
       WHERE ${conditions.join(' AND ')}
       ORDER BY ois.plant, ois.part_index NULLS FIRST, ois.created_at`,
      params,
    );
    res.json({ sessions: rows, plants: allowedPlants });
  } catch (err) {
    res.status(500).json({ message: err instanceof Error ? err.message : 'Failed to fetch sessions' });
  }
});

// GET /api/order-import-edit/sessions/:id/items
router.get('/order-import-edit/sessions/:id/items', requirePageAccess('order-import-edit'), async (req: Request, res: Response) => {
  try {
    const id = parseInt(req.params.id);
    if (isNaN(id)) return res.status(400).json({ message: 'Invalid session ID' });

    const { rows: sessRows } = await pool.query(
      `SELECT id, plant, csv_file_name AS "csvFileName", scan_status AS "scanStatus"
       FROM order_import_sessions WHERE id = $1 AND is_deleted = false`,
      [id],
    );
    if (!sessRows[0]) return res.status(404).json({ message: 'Session not found' });

    const allowedPlants = getUserPlants(req.user);
    if (allowedPlants !== null && !allowedPlants.includes(String(sessRows[0].plant).toLowerCase())) {
      return res.status(403).json({ message: 'Access required for this plant' });
    }

    const { rows: items } = await pool.query(
      `SELECT
         oi.id,
         oi.session_id   AS "sessionId",
         oi.barcode,
         oi.item_name    AS "itemName",
         oi.sap_code     AS "sapCode",
         oi.quantity,
         oi.expected_pallets AS "expectedPallets",
         COALESCE((
           SELECT SUM(osi.total_scanned_qty) FROM order_scan_items osi
           WHERE osi.order_import_item_id = oi.id
              OR (osi.order_import_item_id IS NULL
                  AND osi.session_id = oi.session_id
                  AND osi.barcode IS NOT DISTINCT FROM oi.barcode)
         ), 0)::int AS "scannedQty"
       FROM order_import_items oi
       WHERE oi.session_id = $1
       ORDER BY oi.id`,
      [id],
    );
    res.json({ session: sessRows[0], items });
  } catch (err) {
    res.status(500).json({ message: err instanceof Error ? err.message : 'Failed to fetch items' });
  }
});

type EditItemInput = {
  id?: number;
  barcode?: string | null;
  itemName?: string | null;
  sapCode?: string | null;
  quantity?: number | null;
  expectedPallets?: number | null;
};

// PUT /api/order-import-edit/sessions/:id
router.put('/order-import-edit/sessions/:id', requirePageWrite('order-import-edit'), async (req: Request, res: Response) => {
  const id = parseInt(req.params.id);
  if (isNaN(id)) return res.status(400).json({ message: 'Invalid session ID' });

  const { csvFileName, items } = req.body as { csvFileName?: string; items: EditItemInput[] };
  if (!Array.isArray(items) || items.length === 0)
    return res.status(400).json({ message: 'items are required' });

  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    const sessResult = await client.query(
      `SELECT * FROM order_import_sessions WHERE id = $1 AND is_deleted = false FOR UPDATE`,
      [id],
    );
    const session = sessResult.rows[0];
    if (!session) {
      await client.query('ROLLBACK');
      return res.status(404).json({ message: 'Session not found' });
    }
    if (session.scan_status === 'completed') {
      await client.query('ROLLBACK');
      return res.status(400).json({ message: 'This CSV is already completed and can no longer be edited.' });
    }

    const allowedPlants = getUserPlants(req.user);
    if (allowedPlants !== null && !allowedPlants.includes(String(session.plant).toLowerCase())) {
      await client.query('ROLLBACK');
      return res.status(403).json({ message: 'Access required for this plant' });
    }

    const { rows: existingRows } = await client.query(
      `SELECT oi.id, oi.barcode,
         COALESCE((
           SELECT SUM(osi.total_scanned_qty) FROM order_scan_items osi
           WHERE osi.order_import_item_id = oi.id
              OR (osi.order_import_item_id IS NULL
                  AND osi.session_id = oi.session_id
                  AND osi.barcode IS NOT DISTINCT FROM oi.barcode)
         ), 0)::int AS "scannedQty"
       FROM order_import_items oi WHERE oi.session_id = $1`,
      [id],
    );
    const existingById = new Map<number, { barcode: string | null; scannedQty: number }>(
      existingRows.map((r: any) => [r.id, { barcode: r.barcode, scannedQty: r.scannedQty }]),
    );

    const submittedIds = new Set(items.filter((i) => i.id != null).map((i) => i.id as number));
    const removedIds = Array.from(existingById.keys()).filter((existingId) => !submittedIds.has(existingId));

    const blockedRemovals = removedIds.filter((rid) => (existingById.get(rid)?.scannedQty ?? 0) > 0);
    if (blockedRemovals.length > 0) {
      await client.query('ROLLBACK');
      const barcodes = blockedRemovals.map((rid) => existingById.get(rid)?.barcode || `#${rid}`).join(', ');
      return res.status(400).json({
        message: `Can't remove ${barcodes} — it already has scanned quantity. Void the scan first, then remove it.`,
      });
    }

    if (removedIds.length > 0) {
      await client.query(`DELETE FROM order_import_items WHERE id = ANY($1::int[])`, [removedIds]);
    }

    for (const item of items) {
      const barcode = (item.barcode ?? '').trim() || null;
      const itemName = (item.itemName ?? '').trim() || null;
      const sapCode = (item.sapCode ?? '').trim() || null;
      const quantity = item.quantity ?? 0;
      const expectedPallets = item.expectedPallets ?? null;

      if (item.id != null) {
        const existing = existingById.get(item.id);
        if (!existing) {
          await client.query('ROLLBACK');
          return res.status(400).json({ message: `Item #${item.id} not found in this session` });
        }

        await client.query(
          `UPDATE order_import_items
           SET barcode = $1, item_name = $2, sap_code = $3, quantity = $4, expected_pallets = $5
           WHERE id = $6 AND session_id = $7`,
          [barcode, itemName, sapCode, quantity, expectedPallets, item.id, id],
        );

        const oldBarcode = existing.barcode;
        const barcodeChanged = (oldBarcode ?? '').toLowerCase() !== (barcode ?? '').toLowerCase();

        if (barcodeChanged && existing.scannedQty > 0 && oldBarcode && barcode) {
          const { rows: scannedRows } = await client.query(
            `SELECT
               COALESCE(SUM(total_qty) FILTER (WHERE NOT is_extra), 0)::int AS "orderQty",
               COALESCE(SUM(total_qty) FILTER (WHERE is_extra), 0)::int AS "extraQty"
             FROM order_scan_events
             WHERE session_id = $1 AND barcode IS NOT NULL AND LOWER(barcode) = LOWER($2) AND voided IS NOT TRUE`,
            [id, oldBarcode],
          );
          const orderQty = scannedRows[0]?.orderQty ?? 0;
          const extraQty = scannedRows[0]?.extraQty ?? 0;
          const totalQty = orderQty + extraQty;

          if (totalQty > 0) {
            const reason = `Barcode correction (order-import edit): ${oldBarcode} -> ${barcode}`;

            // Reverse stock credited to the old barcode
            await client.query(
              `UPDATE products SET in_stock = GREATEST(0, COALESCE(in_stock, 0) - $1) WHERE LOWER(barcode) = LOWER($2)`,
              [totalQty, oldBarcode],
            );
            await client.query(
              `UPDATE product_plant_stock
               SET in_stock = GREATEST(0, in_stock - $1), extra_qty = GREATEST(0, extra_qty - $2), updated_at = NOW()
               WHERE LOWER(barcode) = LOWER($3) AND LOWER(plant) = LOWER($4)`,
              [totalQty, extraQty, oldBarcode, session.plant],
            );
            await client.query(
              `INSERT INTO stock_movements (barcode, plant, qty, extra_qty, type, reason, session_id, created_at)
               VALUES ($1, $2, $3, $4, 'adjust', $5, $6, NOW())`,
              [oldBarcode, session.plant, -totalQty, -extraQty, reason, id],
            );

            // Apply the same quantity to the corrected barcode
            await client.query(
              `UPDATE products SET in_stock = COALESCE(in_stock, 0) + $1 WHERE LOWER(barcode) = LOWER($2)`,
              [totalQty, barcode],
            );
            await client.query(
              `INSERT INTO product_plant_stock (barcode, plant, in_stock, extra_qty, updated_at)
               VALUES ($1, $2, $3, $4, NOW())
               ON CONFLICT (barcode, plant) DO UPDATE
                 SET in_stock  = product_plant_stock.in_stock  + EXCLUDED.in_stock,
                     extra_qty = product_plant_stock.extra_qty + EXCLUDED.extra_qty,
                     updated_at = NOW()`,
              [barcode, session.plant, totalQty, extraQty],
            );
            await client.query(
              `INSERT INTO stock_movements (barcode, plant, qty, extra_qty, type, reason, session_id, created_at)
               VALUES ($1, $2, $3, $4, 'adjust', $5, $6, NOW())`,
              [barcode, session.plant, totalQty, extraQty, reason, id],
            );
          }

          // Relink the scan rows so scan history/status follow the corrected barcode.
          await client.query(
            `UPDATE order_scan_items SET barcode = $1
             WHERE order_import_item_id = $2
                OR (order_import_item_id IS NULL AND session_id = $3 AND LOWER(barcode) = LOWER($4))`,
            [barcode, item.id, id, oldBarcode],
          );
          await client.query(
            `UPDATE order_scan_events SET barcode = $1 WHERE session_id = $2 AND LOWER(barcode) = LOWER($3)`,
            [barcode, id, oldBarcode],
          );
        }
      } else {
        await client.query(
          `INSERT INTO order_import_items (session_id, plant, barcode, item_name, sap_code, quantity, expected_pallets)
           VALUES ($1, $2, $3, $4, $5, $6, $7)`,
          [id, session.plant, barcode, itemName, sapCode, quantity, expectedPallets],
        );
      }
    }

    const { rows: countRows } = await client.query(
      `SELECT COUNT(*)::int AS "rowCount" FROM order_import_items WHERE session_id = $1`,
      [id],
    );

    const { rows: updatedRows } = await client.query(
      `UPDATE order_import_sessions SET csv_file_name = COALESCE($1, csv_file_name), row_count = $2
       WHERE id = $3 RETURNING *`,
      [csvFileName || null, countRows[0]?.rowCount ?? items.length, id],
    );

    await client.query('COMMIT');

    res.json({ success: true, session: updatedRows[0], rowCount: countRows[0]?.rowCount ?? items.length });

    broadcastOrderImportUpdate();
  } catch (err) {
    await client.query('ROLLBACK');
    res.status(500).json({ message: err instanceof Error ? err.message : 'Update failed' });
  } finally {
    client.release();
  }
});

export default router;
