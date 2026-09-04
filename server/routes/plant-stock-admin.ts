import { Router, Request, Response } from 'express';
import { storage } from '../storage';
import { pool } from '../db';
import { requireAdminRole } from '../lib/pageAccess';

// Overall Stock > per-row Edit/Delete — admin-only actions scoped to ONE (barcode, plant), the
// surgical counterpart to Settings > Clear Stock (which acts on a whole plant at once). Two
// actions:
//   - POST /plant-stock/adjust — sets this item's stock to an admin-typed total. Logs exactly
//     one stock_movements 'adjust' row for the delta (positive if raised, negative if lowered),
//     same ledger entry type Opening Stock/Clear Stock's own zero-out already use, so it shows up
//     as "Adjusted" in Overall Stock's existing arrival-history drill-down with no new UI needed.
//   - DELETE /plant-stock — permanently removes this barcode+plant's stock AND every trace of it
//     from receiving (Order Import/Scan Order), Loading dispatch, and Unloading scan history —
//     mirrors Clear Stock's 'remove' mode, just filtered down to one barcode instead of every
//     barcode in the plant. An Order Import/Unloading session that had ONLY this barcode on its
//     CSV is deleted outright (nothing left to keep); a session with other items on it just loses
//     this barcode's rows and stays. stock_movements is wiped unconditionally (every type,
//     including 'exchange' and past 'adjust' rows) — same reasoning as Clear Stock's fix: it's
//     the ledger Overall Stock's own drill-down reads from, so a partial wipe would leave stale
//     history visible for an item that was just deleted.
const router = Router();

function actor(req: Request): { userCode?: string; userName?: string } {
  const u = req.user as any;
  return { userCode: u?.userCode, userName: u?.name || u?.username || u?.userCode };
}

// GET /api/plant-stock/delete-preview?barcode=&plant= — impact counts shown before the
// type-to-confirm delete dialog.
router.get('/plant-stock/delete-preview', requireAdminRole, async (req: Request, res: Response) => {
  try {
    const barcode = typeof req.query.barcode === 'string' ? req.query.barcode.trim() : '';
    const plant = typeof req.query.plant === 'string' ? req.query.plant.trim() : '';
    if (!barcode || !plant) return res.status(400).json({ message: 'barcode and plant are required' });

    const [stockRes, receivingRes, loadingRes, unloadRes, movementsRes, orderSessionsRes, unloadSessionsRes] = await Promise.all([
      pool.query(`SELECT in_stock, extra_qty FROM product_plant_stock WHERE LOWER(barcode) = LOWER($1) AND LOWER(plant) = LOWER($2)`, [barcode, plant]),
      pool.query(
        `SELECT COUNT(*)::int AS n FROM order_scan_events e JOIN order_import_sessions s ON s.id = e.session_id
         WHERE LOWER(e.barcode) = LOWER($1) AND LOWER(s.plant) = LOWER($2)`,
        [barcode, plant],
      ),
      pool.query(`SELECT COUNT(*)::int AS n FROM loading_scan_events WHERE LOWER(barcode) = LOWER($1) AND LOWER(plant) = LOWER($2)`, [barcode, plant]),
      pool.query(`SELECT COUNT(*)::int AS n FROM unload_scan_events WHERE LOWER(barcode) = LOWER($1) AND LOWER(plant) = LOWER($2)`, [barcode, plant]),
      pool.query(`SELECT COUNT(*)::int AS n FROM stock_movements WHERE LOWER(barcode) = LOWER($1) AND LOWER(plant) = LOWER($2)`, [barcode, plant]),
      pool.query(
        `SELECT COUNT(DISTINCT session_id)::int AS n FROM order_import_items WHERE LOWER(barcode) = LOWER($1) AND LOWER(plant) = LOWER($2)`,
        [barcode, plant],
      ),
      pool.query(
        `SELECT COUNT(DISTINCT session_id)::int AS n FROM unload_import_items WHERE LOWER(barcode) = LOWER($1) AND LOWER(plant) = LOWER($2)`,
        [barcode, plant],
      ),
    ]);

    const stockRow = stockRes.rows[0];
    res.json({
      currentStock: stockRow ? Number(stockRow.in_stock ?? 0) + Number(stockRow.extra_qty ?? 0) : 0,
      receivingScanEvents: receivingRes.rows[0]?.n ?? 0,
      loadingScanEvents: loadingRes.rows[0]?.n ?? 0,
      unloadingScanEvents: unloadRes.rows[0]?.n ?? 0,
      stockMovements: movementsRes.rows[0]?.n ?? 0,
      orderImportSessionsTouched: orderSessionsRes.rows[0]?.n ?? 0,
      unloadingSessionsTouched: unloadSessionsRes.rows[0]?.n ?? 0,
    });
  } catch (error) {
    console.error('Error building plant-stock delete preview:', error);
    res.status(500).json({ message: 'Failed to load impact preview' });
  }
});

// POST /api/plant-stock/adjust — body: { barcode, plant, newQty, reason? }
router.post('/plant-stock/adjust', requireAdminRole, async (req: Request, res: Response) => {
  const barcode = typeof req.body?.barcode === 'string' ? req.body.barcode.trim() : '';
  const plant = typeof req.body?.plant === 'string' ? req.body.plant.trim() : '';
  const newQty = Math.round(Number(req.body?.newQty));
  const reason = (typeof req.body?.reason === 'string' ? req.body.reason.trim() : '') || 'Manual adjustment (Overall Stock)';
  if (!barcode || !plant) return res.status(400).json({ message: 'barcode and plant are required' });
  if (!Number.isFinite(newQty) || newQty < 0) return res.status(400).json({ message: 'newQty must be a non-negative number' });
  const { userCode, userName } = actor(req);

  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const { rows } = await client.query(
      `SELECT id, product_id, in_stock, extra_qty FROM product_plant_stock WHERE LOWER(barcode) = LOWER($1) AND LOWER(plant) = LOWER($2) FOR UPDATE`,
      [barcode, plant],
    );
    const existing = rows[0];
    const currentTotal = existing ? Number(existing.in_stock ?? 0) + Number(existing.extra_qty ?? 0) : 0;
    const delta = newQty - currentTotal;

    if (delta !== 0) {
      const product = await storage.getProductByBarcode(barcode);
      const productId = existing?.product_id ?? product?.id ?? null;
      if (existing) {
        await client.query(
          `UPDATE product_plant_stock SET in_stock = in_stock + $1, updated_at = NOW() WHERE id = $2`,
          [delta, existing.id],
        );
      } else {
        await client.query(
          `INSERT INTO product_plant_stock (barcode, product_id, plant, in_stock, extra_qty) VALUES ($1,$2,$3,$4,0)`,
          [barcode, productId, plant, newQty],
        );
      }
      await client.query(
        `INSERT INTO stock_movements (barcode, product_id, plant, qty, extra_qty, type, reason, created_by_code)
         VALUES ($1,$2,$3,$4,0,'adjust',$5,$6)`,
        [barcode, productId, plant, delta, reason, userCode ?? null],
      );
      // Recompute the legacy cross-plant mirror from the live per-plant table.
      await client.query(
        `UPDATE products p
         SET in_stock = COALESCE((SELECT SUM(pps.in_stock) FROM product_plant_stock pps WHERE LOWER(pps.barcode) = LOWER(p.barcode)), 0)
         WHERE LOWER(p.barcode) = LOWER($1)`,
        [barcode],
      );
    }
    await client.query('COMMIT');

    if (userCode && delta !== 0) {
      await storage.logActivity({
        pageName: 'Overall Stock',
        action: 'update',
        entityType: 'plant_stock_item',
        entityId: `${barcode}@${plant}`,
        details: `Adjusted ${barcode} at ${plant} by ${userName ?? userCode}: ${currentTotal} -> ${newQty} (${delta >= 0 ? '+' : ''}${delta}). Reason: ${reason}`,
        userCode,
        userName,
      });
    }

    res.json({ success: true, previousQty: currentTotal, newQty, delta });
  } catch (error) {
    await client.query('ROLLBACK');
    console.error('Error adjusting plant stock:', error);
    res.status(500).json({ message: 'Failed to adjust stock' });
  } finally {
    client.release();
  }
});

// DELETE /api/plant-stock — body: { barcode, plant }
router.delete('/plant-stock', requireAdminRole, async (req: Request, res: Response) => {
  const barcode = typeof req.body?.barcode === 'string' ? req.body.barcode.trim() : '';
  const plant = typeof req.body?.plant === 'string' ? req.body.plant.trim() : '';
  if (!barcode || !plant) return res.status(400).json({ message: 'barcode and plant are required' });
  const { userCode, userName } = actor(req);

  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    // --- Order Import / Scan Order: strip this barcode out of every session at this plant,
    // then delete any session that's now left with zero items (this barcode was its only one). ---
    const { rows: orderSessionRows } = await client.query(
      `SELECT DISTINCT session_id FROM order_import_items WHERE LOWER(barcode) = LOWER($1) AND LOWER(plant) = LOWER($2)`,
      [barcode, plant],
    );
    const orderSessionIds: number[] = orderSessionRows.map((r) => r.session_id);
    let receivingEventsAffected = 0;
    let orderSessionsRemoved = 0;
    if (orderSessionIds.length > 0) {
      const evRes = await client.query(
        `DELETE FROM order_scan_events WHERE LOWER(barcode) = LOWER($1) AND session_id = ANY($2::int[]) RETURNING id`,
        [barcode, orderSessionIds],
      );
      receivingEventsAffected = evRes.rowCount ?? 0;
      await client.query(
        `DELETE FROM order_scan_items WHERE LOWER(barcode) = LOWER($1) AND session_id = ANY($2::int[])`,
        [barcode, orderSessionIds],
      );
      await client.query(
        `DELETE FROM order_import_items WHERE LOWER(barcode) = LOWER($1) AND session_id = ANY($2::int[])`,
        [barcode, orderSessionIds],
      );
      const { rows: emptied } = await client.query(
        `SELECT s.id FROM order_import_sessions s
         WHERE s.id = ANY($1::int[]) AND NOT EXISTS (SELECT 1 FROM order_import_items oi WHERE oi.session_id = s.id)`,
        [orderSessionIds],
      );
      if (emptied.length > 0) {
        await client.query(`DELETE FROM order_import_sessions WHERE id = ANY($1::int[])`, [emptied.map((r) => r.id)]);
        orderSessionsRemoved = emptied.length;
      }
    }

    // --- Loading dispatch events at this plant (no session grouping — a plain leaf table). ---
    const loadingRes = await client.query(
      `DELETE FROM loading_scan_events WHERE LOWER(barcode) = LOWER($1) AND LOWER(plant) = LOWER($2) RETURNING id`,
      [barcode, plant],
    );

    // --- Unloading: same strip-then-remove-if-empty pattern as Order Import above. ---
    const { rows: unloadSessionRows } = await client.query(
      `SELECT DISTINCT session_id FROM unload_import_items WHERE LOWER(barcode) = LOWER($1) AND LOWER(plant) = LOWER($2)`,
      [barcode, plant],
    );
    const unloadSessionIds: number[] = unloadSessionRows.map((r) => r.session_id);
    let unloadingEventsAffected = 0;
    let unloadSessionsRemoved = 0;
    if (unloadSessionIds.length > 0) {
      const uevRes = await client.query(
        `DELETE FROM unload_scan_events WHERE LOWER(barcode) = LOWER($1) AND session_id = ANY($2::int[]) RETURNING id`,
        [barcode, unloadSessionIds],
      );
      unloadingEventsAffected = uevRes.rowCount ?? 0;
      await client.query(
        `DELETE FROM unload_import_items WHERE LOWER(barcode) = LOWER($1) AND session_id = ANY($2::int[])`,
        [barcode, unloadSessionIds],
      );
      const { rows: emptied } = await client.query(
        `SELECT s.id FROM unload_import_sessions s
         WHERE s.id = ANY($1::int[]) AND NOT EXISTS (SELECT 1 FROM unload_import_items ui WHERE ui.session_id = s.id)`,
        [unloadSessionIds],
      );
      if (emptied.length > 0) {
        await client.query(`DELETE FROM unload_import_sessions WHERE id = ANY($1::int[])`, [emptied.map((r) => r.id)]);
        unloadSessionsRemoved = emptied.length;
      }
    }

    // --- stock_movements: every row for this barcode+plant, any type — see file header comment. ---
    const movementsRes = await client.query(
      `DELETE FROM stock_movements WHERE LOWER(barcode) = LOWER($1) AND LOWER(plant) = LOWER($2) RETURNING id`,
      [barcode, plant],
    );

    // --- The plant-stock row itself. ---
    await client.query(
      `DELETE FROM product_plant_stock WHERE LOWER(barcode) = LOWER($1) AND LOWER(plant) = LOWER($2)`,
      [barcode, plant],
    );

    // Recompute the legacy cross-plant mirror — deleting one plant's stock must never erase
    // this product's stock that still legitimately exists elsewhere.
    await client.query(
      `UPDATE products p
       SET in_stock = COALESCE((SELECT SUM(pps.in_stock) FROM product_plant_stock pps WHERE LOWER(pps.barcode) = LOWER(p.barcode)), 0)
       WHERE LOWER(p.barcode) = LOWER($1)`,
      [barcode],
    );

    await client.query('COMMIT');

    if (userCode) {
      await storage.logActivity({
        pageName: 'Overall Stock',
        action: 'delete',
        entityType: 'plant_stock_item',
        entityId: `${barcode}@${plant}`,
        details: `Deleted ${barcode} at ${plant} by ${userName ?? userCode} — ${receivingEventsAffected} receiving scan event(s), `
          + `${loadingRes.rowCount ?? 0} loading scan event(s), ${unloadingEventsAffected} unloading scan event(s), `
          + `${movementsRes.rowCount ?? 0} stock movement(s) deleted; ${orderSessionsRemoved} order import session(s) and `
          + `${unloadSessionsRemoved} unloading session(s) fully removed (this was their only item).`,
        userCode,
        userName,
      });
    }

    res.json({
      success: true,
      receivingEventsAffected,
      loadingEventsAffected: loadingRes.rowCount ?? 0,
      unloadingEventsAffected,
      stockMovementsAffected: movementsRes.rowCount ?? 0,
      orderSessionsRemoved,
      unloadSessionsRemoved,
    });
  } catch (error) {
    await client.query('ROLLBACK');
    console.error('Error deleting plant stock item:', error);
    res.status(500).json({ message: 'Failed to delete this item' });
  } finally {
    client.release();
  }
});

export default router;
