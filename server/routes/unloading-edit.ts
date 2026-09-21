import { Router, Request, Response } from 'express';
import { pool } from '../db';
import { storage } from '../storage';
import { requirePageAccess, requirePageWrite } from '../lib/pageAccess';
import { getUserPlants, getPlantStateCode, resolvePalletSizeOrQty } from './order-scan';
import { resplitUnloadEventsExtraFlag } from '../lib/unloadRemap';

// ============================================================================
// UNLOADING EDIT — fixes a mistake in an already-uploaded, not-yet-completed unload CSV (one
// vehicle's item list) without deleting and re-uploading. Opened from a vehicle chip in the
// expanded CSV History row on the Order Import page's own "Unloading" mode
// (client/src/pages/OrderImport.tsx). Deliberately answers to the SAME permission Order Import's
// own edit feature does — Order Management (page grant to open, write access to save) — rather
// than a separate one: whoever can already edit an Order Import CSV from that page can edit an
// Unloading one there too.
//
// Mirrors server/routes/order-import-edit.ts's two real correctness fixes, adapted to Unloading's
// simpler (no cached order_scan_items-style progress table — expected/remaining/isComplete are
// always computed LIVE, see withProgress in unloading.ts) data model:
//   - Barcode changed on an item with existing scan history: unload_scan_events still carries its
//     own literal barcode text, so it must be relinked to the new one, and the stock already
//     credited under the old barcode must be reversed and reapplied under the new one — otherwise
//     that scan history and stock silently orphan.
//   - Quantity changed on an item with existing scan history: each unload_scan_events row's
//     is_extra flag is decided once, permanently, at scan time — it does NOT recompute just
//     because expected quantity changed. Re-split it against the new quantity (reusing
//     resplitUnloadEventsExtraFlag, already shared with the "replace" delete-and-carry-forward
//     flow) and correct product_plant_stock.extra_qty by the delta.
// ============================================================================

const router = Router();

router.use('/unloading-edit', (_req: Request, res: Response, next) => {
  res.set('Cache-Control', 'no-store, no-cache, must-revalidate');
  res.set('Pragma', 'no-cache');
  next();
});

// GET /api/unloading-edit/sessions/:id/items
router.get('/unloading-edit/sessions/:id/items', requirePageAccess('order-import'), async (req: Request, res: Response) => {
  try {
    const id = parseInt(req.params.id);
    if (isNaN(id)) return res.status(400).json({ message: 'Invalid session ID' });

    const { rows: sessRows } = await pool.query(
      `SELECT id, plant, vehicle_number AS "vehicleNumber", order_date AS "orderDate",
              csv_file_name AS "csvFileName", scan_status AS "scanStatus"
       FROM unload_import_sessions WHERE id = $1 AND is_deleted = false`,
      [id],
    );
    if (!sessRows[0]) return res.status(404).json({ message: 'Session not found' });

    const allowedPlants = getUserPlants(req.user);
    if (allowedPlants !== null && !allowedPlants.includes(String(sessRows[0].plant).toLowerCase())) {
      return res.status(403).json({ message: 'Access required for this plant' });
    }

    const { rows: items } = await pool.query(
      `SELECT
         ii.id, ii.session_id AS "sessionId", ii.barcode, ii.item_name AS "itemName", ii.sap_code AS "sapCode",
         ii.quantity,
         COALESCE((
           SELECT SUM(total_qty) FROM unload_scan_events
           WHERE session_id = ii.session_id AND barcode = ii.barcode AND voided IS NOT TRUE
         ), 0)::int AS "scannedQty"
       FROM unload_import_items ii
       WHERE ii.session_id = $1
       ORDER BY ii.id`,
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
};

// PUT /api/unloading-edit/sessions/:id
router.put('/unloading-edit/sessions/:id', requirePageWrite('order-import'), async (req: Request, res: Response) => {
  const id = parseInt(req.params.id);
  if (isNaN(id)) return res.status(400).json({ message: 'Invalid session ID' });

  const { items } = req.body as { items: EditItemInput[] };
  if (!Array.isArray(items) || items.length === 0)
    return res.status(400).json({ message: 'items are required' });

  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    const sessResult = await client.query(
      `SELECT * FROM unload_import_sessions WHERE id = $1 AND is_deleted = false FOR UPDATE`,
      [id],
    );
    const session = sessResult.rows[0];
    if (!session) {
      await client.query('ROLLBACK');
      return res.status(404).json({ message: 'Session not found' });
    }
    if (session.scan_status === 'completed') {
      await client.query('ROLLBACK');
      return res.status(400).json({ message: 'This vehicle is already completed and can no longer be edited.' });
    }

    const allowedPlants = getUserPlants(req.user);
    if (allowedPlants !== null && !allowedPlants.includes(String(session.plant).toLowerCase())) {
      await client.query('ROLLBACK');
      return res.status(403).json({ message: 'Access required for this plant' });
    }

    const { rows: existingRows } = await client.query(
      `SELECT ii.id, ii.barcode, ii.quantity,
         COALESCE((
           SELECT SUM(total_qty) FROM unload_scan_events
           WHERE session_id = ii.session_id AND barcode = ii.barcode AND voided IS NOT TRUE
         ), 0)::int AS "scannedQty"
       FROM unload_import_items ii WHERE ii.session_id = $1`,
      [id],
    );
    const existingById = new Map<number, { barcode: string | null; quantity: number; scannedQty: number }>(
      existingRows.map((r: any) => [r.id, { barcode: r.barcode, quantity: Number(r.quantity ?? 0), scannedQty: r.scannedQty }]),
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
      await client.query(`DELETE FROM unload_import_items WHERE id = ANY($1::int[])`, [removedIds]);
    }

    const state = await getPlantStateCode(client, session.plant ?? '');

    for (const item of items) {
      const barcode = (item.barcode ?? '').trim() || null;
      const itemName = (item.itemName ?? '').trim() || null;
      const sapCode = (item.sapCode ?? '').trim() || null;
      const quantity = item.quantity ?? 0;

      if (item.id != null) {
        const existing = existingById.get(item.id);
        if (!existing) {
          await client.query('ROLLBACK');
          return res.status(400).json({ message: `Item #${item.id} not found in this session` });
        }

        await client.query(
          `UPDATE unload_import_items SET barcode = $1, item_name = $2, sap_code = $3, quantity = $4
           WHERE id = $5 AND session_id = $6`,
          [barcode, itemName, sapCode, quantity, item.id, id],
        );

        const oldBarcode = existing.barcode;
        const barcodeChanged = (oldBarcode ?? '').toLowerCase() !== (barcode ?? '').toLowerCase();

        // unload_scan_events stores its own copy of the barcode, seeded the moment each scan is
        // logged — independent of unload_import_items. Must relink on every barcode change, not
        // just ones with existing scanned quantity: an item edited BEFORE its first scan still
        // needs its later scans to land against the corrected barcode, not the CSV's original one.
        if (barcodeChanged && oldBarcode && barcode) {
          const { rows: scannedRows } = await client.query(
            `SELECT
               COALESCE(SUM(total_qty) FILTER (WHERE NOT is_extra), 0)::int AS "orderQty",
               COALESCE(SUM(total_qty) FILTER (WHERE is_extra), 0)::int AS "extraQty"
             FROM unload_scan_events
             WHERE session_id = $1 AND barcode = $2 AND voided IS NOT TRUE`,
            [id, oldBarcode],
          );
          const orderQty = scannedRows[0]?.orderQty ?? 0;
          const extraQty = scannedRows[0]?.extraQty ?? 0;
          const totalQty = orderQty + extraQty;

          if (totalQty > 0) {
            const reason = `Barcode correction (unloading edit): ${oldBarcode} -> ${barcode}`;

            // Reverse stock credited to the old barcode.
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
              `INSERT INTO stock_movements (barcode, plant, qty, extra_qty, type, reason, session_id, created_at, source)
               VALUES ($1, $2, $3, $4, 'adjust', $5, $6, NOW(),'unloading')`,
              [oldBarcode, session.plant, -totalQty, -extraQty, reason, id],
            );

            // Apply the same quantity to the corrected barcode. RETURNING id so the corrected
            // barcode's own product row links up correctly rather than inheriting the old one's.
            const { rows: newProductRows } = await client.query(
              `UPDATE products SET in_stock = COALESCE(in_stock, 0) + $1 WHERE LOWER(barcode) = LOWER($2) RETURNING id`,
              [totalQty, barcode],
            );
            const newProductId = newProductRows[0]?.id ?? null;
            await client.query(
              `INSERT INTO product_plant_stock (barcode, product_id, plant, in_stock, extra_qty, updated_at)
               VALUES ($1, $2, $3, $4, $5, NOW())
               ON CONFLICT (barcode, plant) DO UPDATE
                 SET in_stock  = product_plant_stock.in_stock  + EXCLUDED.in_stock,
                     extra_qty = product_plant_stock.extra_qty + EXCLUDED.extra_qty,
                     product_id = COALESCE(product_plant_stock.product_id, EXCLUDED.product_id),
                     updated_at = NOW()`,
              [barcode, newProductId, session.plant, totalQty, extraQty],
            );
            await client.query(
              `INSERT INTO stock_movements (barcode, product_id, plant, qty, extra_qty, type, reason, session_id, created_at, source)
               VALUES ($1, $2, $3, $4, $5, 'adjust', $6, $7, NOW(),'unloading')`,
              [barcode, newProductId, session.plant, totalQty, extraQty, reason, id],
            );
          }

          // Relink the scan rows so scan history/status follow the corrected barcode.
          await client.query(
            `UPDATE unload_scan_events SET barcode = $1 WHERE session_id = $2 AND barcode = $3`,
            [barcode, id, oldBarcode],
          );
        }

        // Quantity edits: unload_scan_events' is_extra flag is fixed at scan time and never
        // auto-follows a later CSV edit — re-split it against the new quantity the same way the
        // "replace" delete-and-carry-forward flow already does (remapDeletedUnloadSessionEvents),
        // via the same shared resplitUnloadEventsExtraFlag.
        const quantityChanged = Number(existing.quantity) !== Number(quantity);
        if (quantityChanged && barcode) {
          const { rows: eventRows } = await client.query(
            `SELECT id, total_qty, is_extra FROM unload_scan_events
             WHERE session_id = $1 AND barcode = $2 AND voided IS NOT TRUE ORDER BY id ASC`,
            [id, barcode],
          );
          const physicalQty = eventRows.reduce((s: number, e: any) => s + Number(e.total_qty ?? 0), 0);
          if (physicalQty > 0) {
            const oldExtraQty = eventRows.reduce((s: number, e: any) => s + (e.is_extra ? Number(e.total_qty ?? 0) : 0), 0);
            const newOrderQty = Math.min(physicalQty, quantity);
            const newExtraQty = physicalQty - newOrderQty;

            const product = await storage.getProductByBarcode(barcode, session.plant);
            const itemsPerPallet = resolvePalletSizeOrQty(product ?? null, state, quantity);

            await resplitUnloadEventsExtraFlag(client, eventRows, newOrderQty, itemsPerPallet);

            // in_stock already counts every physical box regardless of order/extra split — only
            // extra_qty, the "how much of it was over-order" subset, needs correcting here.
            const extraDelta = newExtraQty - oldExtraQty;
            if (extraDelta !== 0) {
              await client.query(
                `UPDATE product_plant_stock SET extra_qty = GREATEST(0, extra_qty + $1), updated_at = NOW()
                 WHERE LOWER(barcode) = LOWER($2) AND LOWER(plant) = LOWER($3)`,
                [extraDelta, barcode, session.plant],
              );
              await client.query(
                `INSERT INTO stock_movements (barcode, plant, qty, extra_qty, type, reason, session_id, created_at, source)
                 VALUES ($1, $2, 0, $3, 'adjust', $4, $5, NOW(),'unloading')`,
                [barcode, session.plant, extraDelta, `Quantity correction (unloading edit): ${existing.quantity} -> ${quantity}`, id],
              );
            }
          }
        }
      } else {
        await client.query(
          `INSERT INTO unload_import_items (session_id, plant, vehicle_number, barcode, item_name, sap_code, quantity)
           VALUES ($1, $2, $3, $4, $5, $6, $7)`,
          [id, session.plant, session.vehicle_number, barcode, itemName, sapCode, quantity],
        );
      }
    }

    const { rows: countRows } = await client.query(
      `SELECT COUNT(*)::int AS "rowCount" FROM unload_import_items WHERE session_id = $1`,
      [id],
    );
    const { rows: updatedRows } = await client.query(
      `UPDATE unload_import_sessions SET row_count = $1 WHERE id = $2 RETURNING *`,
      [countRows[0]?.rowCount ?? items.length, id],
    );

    await client.query('COMMIT');
    res.json({ success: true, session: updatedRows[0], rowCount: countRows[0]?.rowCount ?? items.length });
  } catch (err) {
    await client.query('ROLLBACK');
    res.status(500).json({ message: err instanceof Error ? err.message : 'Update failed' });
  } finally {
    client.release();
  }
});

export default router;
