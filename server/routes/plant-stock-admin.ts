import { Router, Request, Response } from 'express';
import { storage } from '../storage';
import { pool } from '../db';
import { requireAdminRole } from '../lib/pageAccess';

// Overall Stock > per-row Edit/Delete — admin-only actions scoped to ONE (barcode, plant), the
// surgical counterpart to Settings > Clear Stock (which acts on a whole plant at once). Two
// actions:
//   - GET /plant-stock/current + POST /plant-stock/adjust — the Adjust dialog. The admin picks a
//     plant, sees that plant's LIVE stock, and adds / removes / sets it. Logs one stock_movements
//     'adjust' row tagged source = 'manual', which shows as "Adjusted" in Overall Stock's
//     arrival-history drill-down and as an "Adjust" entry in Scan History.
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
      // in_stock is the physical total — extras are already counted inside it.
      currentStock: stockRow ? Number(stockRow.in_stock ?? 0) : 0,
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

// GET /api/plant-stock/current?barcode=&plant= — this item's LIVE stock at one plant, straight from
// product_plant_stock. The Adjust dialog previews against this rather than the Overall Stock row it
// was opened from: with a date filter on, that row's numbers mean "received in the window", not what
// is on hand, and on the All/State tabs a row is several plants summed together — previewing
// against either is what made an intended "+" land as a "−".
router.get('/plant-stock/current', requireAdminRole, async (req: Request, res: Response) => {
  const barcode = typeof req.query.barcode === 'string' ? req.query.barcode.trim() : '';
  const plant = typeof req.query.plant === 'string' ? req.query.plant.trim() : '';
  if (!barcode || !plant) return res.status(400).json({ message: 'barcode and plant are required' });
  try {
    const { rows } = await pool.query(
      `SELECT in_stock, extra_qty FROM product_plant_stock WHERE LOWER(barcode) = LOWER($1) AND LOWER(plant) = LOWER($2)`,
      [barcode, plant],
    );
    const inStock = Number(rows[0]?.in_stock ?? 0);
    const extraQty = Number(rows[0]?.extra_qty ?? 0);
    // in_stock IS the physical total; extra_qty only says how many of those boxes were extra.
    res.json({ inStock, extraQty, total: inStock });
  } catch (error) {
    console.error('Error fetching current plant stock:', error);
    res.status(500).json({ message: 'Failed to fetch current stock' });
  }
});

// POST /api/plant-stock/adjust — body: { barcode, plant, mode: 'add' | 'remove' | 'set', qty,
// expectedCurrentQty?, reason? }
//   - add / remove: qty is a positive amount to add or take away; set: qty is the new total.
//   - expectedCurrentQty is the live total the dialog showed. If stock moved since (someone scanned
//     meanwhile), the request is refused with 409 instead of silently applying a different change
//     than the one previewed.
//   - The on-hand total is in_stock ALONE — extras are already counted inside it, and extra_qty
//     only says how many of those boxes were extra (see applyLiveScanStock in
//     server/lib/orderGroupReport.ts). Adding the two together overstated the stock of any item with
//     extras, which is what turned an intended "+" into a "−".
router.post('/plant-stock/adjust', requireAdminRole, async (req: Request, res: Response) => {
  const barcode = typeof req.body?.barcode === 'string' ? req.body.barcode.trim() : '';
  const requestedPlant = typeof req.body?.plant === 'string' ? req.body.plant.trim() : '';
  const mode: 'add' | 'remove' | 'set' = req.body?.mode === 'add' || req.body?.mode === 'remove' ? req.body.mode : 'set';
  const qty = Math.round(Number(req.body?.qty));
  const rawExpected = req.body?.expectedCurrentQty;
  const expectedCurrentQty = rawExpected === undefined || rawExpected === null || rawExpected === '' ? null : Math.round(Number(rawExpected));
  const reason = (typeof req.body?.reason === 'string' ? req.body.reason.trim() : '') || 'Manual adjustment (Overall Stock)';
  if (!barcode || !requestedPlant) return res.status(400).json({ message: 'barcode and plant are required' });
  if (!Number.isFinite(qty) || qty < 0) return res.status(400).json({ message: 'Quantity must be a non-negative number' });
  if (mode !== 'set' && qty === 0) return res.status(400).json({ message: 'Enter a quantity greater than 0' });
  const { userCode, userName } = actor(req);

  const { rows: plantRows } = await pool.query(`SELECT name FROM plants WHERE LOWER(name) = LOWER($1) LIMIT 1`, [requestedPlant]);
  if (!plantRows[0]) return res.status(400).json({ message: `Unknown plant "${requestedPlant}"` });

  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const { rows } = await client.query(
      `SELECT id, product_id, plant, in_stock, extra_qty FROM product_plant_stock WHERE LOWER(barcode) = LOWER($1) AND LOWER(plant) = LOWER($2) FOR UPDATE`,
      [barcode, requestedPlant],
    );
    const existing = rows[0];
    // Reuse the stock row's own plant spelling when one exists, so a new ledger row can never
    // split one plant into two differently-cased keys.
    const plant: string = existing?.plant ?? plantRows[0].name;
    const inStock = Number(existing?.in_stock ?? 0);
    const extraQty = Number(existing?.extra_qty ?? 0);
    const currentTotal = inStock;

    if (expectedCurrentQty !== null && Number.isFinite(expectedCurrentQty) && expectedCurrentQty !== currentTotal) {
      await client.query('ROLLBACK');
      return res.status(409).json({
        message: `Stock for this item at ${plant} is now ${currentTotal} (it was ${expectedCurrentQty} when you opened this). Check the new number and try again.`,
        currentTotal,
      });
    }

    const newTotal = mode === 'add' ? currentTotal + qty : mode === 'remove' ? currentTotal - qty : qty;
    if (newTotal < 0) {
      await client.query('ROLLBACK');
      return res.status(400).json({ message: `Can't remove ${qty} — only ${currentTotal} in stock at ${plant}.` });
    }
    const delta = newTotal - currentTotal;

    // The whole change lands on in_stock. extra_qty is only trimmed when fewer boxes remain than
    // were marked extra — the extra portion can never be larger than the total.
    const inStockDelta = delta;
    const extraDelta = Math.min(0, newTotal - extraQty);

    if (delta !== 0) {
      const product = await storage.getProductByBarcode(barcode, plant);
      const productId = existing?.product_id ?? product?.id ?? null;
      if (existing) {
        await client.query(
          `UPDATE product_plant_stock SET in_stock = in_stock + $1, extra_qty = extra_qty + $2, updated_at = NOW() WHERE id = $3`,
          [inStockDelta, extraDelta, existing.id],
        );
      } else {
        // No row yet means currentTotal is 0, so only an increase can reach here.
        await client.query(
          `INSERT INTO product_plant_stock (barcode, product_id, plant, in_stock, extra_qty) VALUES ($1,$2,$3,$4,0)`,
          [barcode, productId, plant, inStockDelta],
        );
      }
      await client.query(
        // origin 'page': a person adjusted this one item from Stock Overview. Kept apart from a
        // Settings-wide clear so the Adjust column only ever shows corrections like this one.
        `INSERT INTO stock_movements (barcode, product_id, plant, qty, extra_qty, type, reason, created_by_code, source, origin)
         VALUES ($1,$2,$3,$4,$5,'adjust',$6,$7,'manual','page')`,
        [barcode, productId, plant, inStockDelta, extraDelta, reason, userCode ?? null],
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
        details: `Adjusted ${barcode} at ${plant} by ${userName ?? userCode} (${mode}): ${currentTotal} -> ${newTotal} (${delta >= 0 ? '+' : ''}${delta}). Reason: ${reason}`,
        userCode,
        userName,
      });
    }

    res.json({ success: true, previousQty: currentTotal, newQty: newTotal, delta, plant });
  } catch (error) {
    await client.query('ROLLBACK').catch(() => {});
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

// DELETE /api/plant-stock/movements/:id — removes ONE stock_movements row from the ledger (the
// Adjustments history dialog's own delete button). Scoped to type='adjust' only — a 'receive'/
// 'dispatch' row is tied to a real scan event elsewhere (Order Scan/Unloading/Loading) with its
// own void flow, and deleting it here would desync the two. This is a ledger/reporting
// correction only: it does NOT touch product_plant_stock.in_stock. A stray or duplicate entry
// (e.g. a stale "Opening stock import" row left over from testing, or any other Clear Stock/
// manual adjust already superseded by later real activity) only ever distorts the Opening/
// Adjust/Total Stock figures Overall Stock computes FROM the ledger — it was never the live
// stock number itself, which has already moved on independently since.
router.delete('/plant-stock/movements/:id', requireAdminRole, async (req: Request, res: Response) => {
  const id = Number(req.params.id);
  if (!Number.isFinite(id)) return res.status(400).json({ message: 'Invalid movement id' });
  const { userCode, userName } = actor(req);

  try {
    const { rows } = await pool.query(
      `DELETE FROM stock_movements WHERE id = $1 AND type = 'adjust' RETURNING barcode, plant, qty, reason, origin`,
      [id],
    );
    const deleted = rows[0];
    if (!deleted) return res.status(404).json({ message: 'Adjustment not found (or not deletable — only manual/opening/settings corrections can be removed here)' });

    if (userCode) {
      await storage.logActivity({
        pageName: 'Overall Stock',
        action: 'delete',
        entityType: 'stock_movement',
        entityId: String(id),
        details: `Deleted an Adjust ledger entry for ${deleted.barcode} at ${deleted.plant} by ${userName ?? userCode}: `
          + `${deleted.qty >= 0 ? '+' : ''}${deleted.qty} (${deleted.reason ?? 'no reason recorded'}). Live stock was not changed.`,
        userCode,
        userName,
      });
    }

    res.json({ success: true });
  } catch (error) {
    console.error('Error deleting a stock movement:', error);
    res.status(500).json({ message: 'Failed to delete this entry' });
  }
});

export default router;
