import { Router, Request, Response } from 'express';
import { storage } from '../storage';
import { pool } from '../db';
import { requirePageAccess, requirePageWrite, WRITE_ADMIN_ROLES } from '../lib/pageAccess';
import { getPlantStateCode, resolvePalletSizeOrQty, getPalletSize, getUserPlants } from './order-scan';
import { remapDeletedUnloadSessionEvents } from '../lib/unloadRemap';
import { reconcileUnloadCredits } from '../lib/unloadCredit';
import { computeUnloadGroupReport, computeUnloadPartReport, resolveUnloadGroupId } from '../lib/unloadGroupReport';
import { reconcileProductPlantStockBarcode } from '../lib/stockBarcodeReconcile';

// Unloading — vehicle-wise receiving. See unloadImportSessions' comment in shared/schema.ts:
// same "import a CSV, scan against it to receive stock" idea as Order Import/Scan Order, but
// grouped by (plant, vehicleNumber, orderDate) instead of just (plant, orderDate) — one CSV
// upload can span several vehicles, each becoming its own independently-scannable FIFO group.
// Deliberately simpler than Order Import/Scan Order (no delete/replace flow, no cross-part
// credit reconciliation, no Master View merge) — same lean two-table shape Loading uses for its
// own scan side (an "expected items" table + a "scan events" audit trail), progress computed
// live by summing events.
const router = Router();

function actor(req: Request): { userCode?: string; userName?: string } {
  const u = req.user as any;
  return { userCode: u?.userCode, userName: u?.name || u?.username || u?.userCode };
}

function isAdmin(req: Request): boolean {
  const role = ((req.user as any)?.role ?? '').toString().toLowerCase();
  return WRITE_ADMIN_ROLES.includes(role);
}

const normalize = (value?: string | number | null) => String(value ?? '').trim().toLowerCase();

function canAccessPlant(req: Request, plant: string): boolean {
  const userPlants = getUserPlants(req.user);
  if (userPlants === null) return true;
  return userPlants.includes(normalize(plant));
}

// Same "write access to both Unloading and Scan History" rule Loading's void/reset uses.
function hasWriteAccess(user: any, pageKey: string): boolean {
  const role = (user?.role ?? '').toString().toLowerCase();
  if (WRITE_ADMIN_ROLES.includes(role)) return true;
  let writable: string[] = [];
  try { writable = JSON.parse(user?.pageWriteAccess || '[]'); } catch { /* default [] */ }
  return writable.includes(pageKey);
}
function requireUnloadingVoidAccess(req: Request, res: Response, next: any) {
  if (!req.isAuthenticated || !req.isAuthenticated()) return res.status(401).json({ message: 'Not authenticated' });
  const user = req.user as any;
  if (isAdmin(req)) return next();
  // Deliberately unloading-only (not also requiring scan-history write, unlike the equivalent
  // Loading/Order Scan void gates) — a user with unloading write access should be able to
  // reopen/void within Unloading on its own.
  if (hasWriteAccess(user, 'unloading')) return next();
  return res.status(403).json({ message: 'Write access required' });
}
// Delete/delete-preview specifically (not reopen/void — those stay unloading-only above) also
// accept order-import write access: a CSV's delete action now lives on the Order Import page's
// own "Unloading" mode (client/src/pages/OrderImport.tsx) alongside its own delete, same as
// POST /unloading/import and GET /unloading/csv-history already do.
function requireUnloadingDeleteAccess(req: Request, res: Response, next: any) {
  if (!req.isAuthenticated || !req.isAuthenticated()) return res.status(401).json({ message: 'Not authenticated' });
  const user = req.user as any;
  if (isAdmin(req)) return next();
  if (hasWriteAccess(user, 'unloading') || hasWriteAccess(user, 'order-import')) return next();
  return res.status(403).json({ message: 'Write access required' });
}

// Attaches live progress to a session's expected items (expected/scanned/remaining/pallet size),
// the same shape both GET (open) and POST /scan responses return.
//
// Also returns offBatchExtraQty/offBatchExtraPallets: scans of products that are NOT on this batch's
// file at all (logged as Extra). They have no item row, but they are real boxes received on this
// vehicle — the landing list's "scannedQty" has always counted them, so the opened batch's
// Received/Extra totals add them too; otherwise the same batch showed one quantity in the list and
// a smaller one once opened.
async function withProgress(session: any) {
  const state = await getPlantStateCode(pool, session.plant ?? '');
  const { rows: items } = await pool.query(
    `SELECT id, barcode, item_name AS "itemName", sap_code AS "sapCode", quantity
     FROM unload_import_items WHERE session_id = $1 ORDER BY id ASC`,
    [session.id],
  );
  const { rows: scannedRows } = await pool.query(
    `SELECT barcode, COALESCE(SUM(total_qty), 0)::int AS "scannedQty"
     FROM unload_scan_events WHERE session_id = $1 AND voided IS NOT TRUE GROUP BY barcode`,
    [session.id],
  );
  // Summed, not set: two raw barcodes that differ only in case/spaces are the same product.
  const scannedByBarcode = new Map<string, number>();
  const rawBarcodeByKey = new Map<string, string>();
  for (const r of scannedRows as any[]) {
    const key = normalize(r.barcode);
    scannedByBarcode.set(key, (scannedByBarcode.get(key) ?? 0) + Number(r.scannedQty ?? 0));
    if (!rawBarcodeByKey.has(key)) rawBarcodeByKey.set(key, r.barcode);
  }

  // A barcode can be listed on more than one line of the same file. Its scans are shared out
  // across those lines in order (each line filled up to its own qty, the last line takes any
  // over-scan) instead of every line claiming the full scanned amount — which counted the same
  // boxes twice in the opened batch's totals.
  const lastLineByBarcode = new Map<string, number>();
  items.forEach((item: any, index: number) => lastLineByBarcode.set(normalize(item.barcode), index));
  const leftToShare = new Map(scannedByBarcode);
  const scannedPerLine = items.map((item: any, index: number) => {
    const key = normalize(item.barcode);
    const left = leftToShare.get(key) ?? 0;
    const share = index === lastLineByBarcode.get(key) ? left : Math.min(left, item.quantity ?? 0);
    leftToShare.set(key, left - share);
    return share;
  });

  const progressItems = await Promise.all(items.map(async (item: any, index: number) => {
    const product = item.barcode ? await storage.getProductByBarcode(item.barcode, session.plant) : undefined;
    const expected = item.quantity ?? 0;
    const scanned = scannedPerLine[index];
    const itemsPerPallet = resolvePalletSizeOrQty(product ?? null, state, expected);
    return {
      ...item, expected, scanned, remaining: Math.max(0, expected - scanned),
      itemsPerPallet,
      // Real Product Master pallet size (0 when GJ/MP PLT is blank) — itemsPerPallet falls back to
      // the line quantity, so this is what tells the page a size was never set.
      realPackSize: getPalletSize(product ?? null, state),
      isComplete: expected > 0 && scanned >= expected,
    };
  }));

  let offBatchExtraQty = 0;
  let offBatchExtraPallets = 0;
  for (const [key, qty] of Array.from(scannedByBarcode.entries())) {
    if (lastLineByBarcode.has(key) || qty <= 0) continue;
    const product = await storage.getProductByBarcode(rawBarcodeByKey.get(key) ?? key, session.plant);
    const itemsPerPallet = resolvePalletSizeOrQty(product ?? null, state, qty);
    offBatchExtraQty += qty;
    if (itemsPerPallet > 0) offBatchExtraPallets += qty / itemsPerPallet;
  }

  const allComplete = progressItems.length > 0 && progressItems.every((i) => i.isComplete);
  return {
    items: progressItems, allComplete,
    offBatchExtraQty, offBatchExtraPallets: Number(offBatchExtraPallets.toFixed(2)),
  };
}

// Per batch, how much of what its file lists has arrived — each barcode capped at its own listed
// qty, so over-scans and products not on the file don't count here. scannedQty (every box
// scanned) minus this is the batch's Extra, the same split the opened batch shows.
const RECEIVED_QTY_SQL = `COALESCE((
  SELECT SUM(LEAST(sc.qty, ex.qty))
  FROM (SELECT LOWER(TRIM(barcode)) AS bc, SUM(quantity) AS qty FROM unload_import_items WHERE session_id = s.id GROUP BY 1) ex
  JOIN (SELECT LOWER(TRIM(barcode)) AS bc, SUM(total_qty) AS qty FROM unload_scan_events WHERE session_id = s.id AND voided IS NOT TRUE GROUP BY 1) sc
    ON sc.bc = ex.bc
), 0)::int`;
const withExtraQty = (row: any) => ({ ...row, extraQty: Math.max(0, (row.scannedQty ?? 0) - (row.receivedQty ?? 0)) });

// A batch only becomes "active" when a user actually opens it to scan (POST .../activate below)
// — never automatically on import or when an earlier batch completes, mirroring Order Import's
// CSV lifecycle (available -> active -> completed, the "active" flip is its own explicit step).
// It's eligible to be clicked into, though, only once every earlier batch in the same FIFO group
// is completed — this is what keeps batches strictly sequential without a separate "is anything
// else active" lock: the earliest not-yet-completed, non-deleted batch in the group is always
// the only one eligible.
async function isEligibleToActivate(session: { id: number; groupId: number; partIndex: number }): Promise<boolean> {
  const { rows } = await pool.query(
    `SELECT id FROM unload_import_sessions
     WHERE group_id = $1 AND is_deleted = false AND scan_status <> 'completed'
     ORDER BY part_index ASC, id ASC LIMIT 1`,
    [session.groupId],
  );
  return rows[0]?.id === session.id;
}

// POST /api/unloading/import — body: { plant, orderDate, csvFileName, items }
// items: [{ vehicleNumber, barcode, itemName, sapCode, quantity }] — Vehicle Number is
// mandatory per row; rows are grouped by distinct vehicle number into separate FIFO groups.
// Also reachable with just order-import write access — the import UI for this now lives on the
// Order Import page's own "Unloading" mode (client/src/pages/OrderImport.tsx), not the Unloading
// page itself, so a user who can only reach that page still needs to be able to call this.
router.post('/unloading/import', requirePageWrite(['unloading', 'order-import']), async (req: Request, res: Response) => {
  try {
    const { plant, orderDate, csvFileName, items } = req.body as {
      plant: string; orderDate: string; csvFileName: string;
      items: Array<{ vehicleNumber?: string; barcode?: string; itemName?: string; sapCode?: string; quantity?: number }>;
    };

    if (!plant || !String(plant).trim()) return res.status(400).json({ message: 'Plant is required' });
    if (!orderDate || !String(orderDate).trim()) return res.status(400).json({ message: 'Order Date is required' });
    if (!csvFileName) return res.status(400).json({ message: 'csvFileName is required' });
    if (!Array.isArray(items) || items.length === 0) return res.status(400).json({ message: 'CSV has no rows' });
    if (!canAccessPlant(req, plant)) return res.status(403).json({ message: 'Access denied for this plant' });

    const normOrderDate = String(orderDate).trim();
    const missingVehicle = items.findIndex((it) => !it.vehicleNumber || !String(it.vehicleNumber).trim());
    if (missingVehicle !== -1) {
      return res.status(400).json({ message: `Row ${missingVehicle + 1} is missing a Vehicle Number — every row must have one.` });
    }
    const missingBarcode = items.findIndex((it) => !it.barcode || !String(it.barcode).trim());
    if (missingBarcode !== -1) {
      return res.status(400).json({ message: `Row ${missingBarcode + 1} is missing a barcode.` });
    }

    const { userCode, userName } = actor(req);
    const byVehicle = new Map<string, typeof items>();
    for (const item of items) {
      const key = String(item.vehicleNumber).trim();
      if (!byVehicle.has(key)) byVehicle.set(key, []);
      byVehicle.get(key)!.push(item);
    }

    const summary: Array<{
      vehicleNumber: string; sessionId: number; groupId: number; partIndex: number; rowCount: number;
      replacesSessionId: number | null; remapSummary: any;
    }> = [];

    for (const [vehicleNumber, vehicleItems] of byVehicle.entries()) {
      // ── Delete-with-rollback replacement: reclaim an unresolved "replace" delete's slot ────
      // Same idea as order-import.ts's own upload handler: a "replace" delete (see DELETE
      // /unloading/sessions/:id below) leaves remapped_to_session_id NULL so the next upload for
      // the exact same (plant, vehicleNumber, orderDate) is treated as its correction, carrying
      // the deleted session's scan history forward instead of starting over.
      const { rows: replacementRows } = await pool.query(
        `SELECT id, group_id AS "groupId", part_index AS "partIndex", csv_file_name AS "csvFileName"
         FROM unload_import_sessions
         WHERE LOWER(plant) = LOWER($1) AND LOWER(vehicle_number) = LOWER($2) AND order_date = $3
           AND is_deleted = true AND remapped_to_session_id IS NULL
         ORDER BY deleted_at ASC LIMIT 1`,
        [plant, vehicleNumber, normOrderDate],
      );
      const replacementFor = replacementRows[0] ?? null;

      let groupIdForInsert: number | null = null;
      let partIndex = 1;
      let joinedExistingGroup = false;
      if (replacementFor) {
        groupIdForInsert = replacementFor.groupId;
        partIndex = replacementFor.partIndex ?? 1;
        joinedExistingGroup = true;
      } else {
        // Every session that ever existed for this slot (deleted or not) — a discarded part's
        // slot number is retired, never reused, same reasoning as order-import.ts.
        const { rows: existingRows } = await pool.query(
          `SELECT id, group_id AS "groupId", part_index AS "partIndex" FROM unload_import_sessions
           WHERE LOWER(plant) = LOWER($1) AND LOWER(vehicle_number) = LOWER($2) AND order_date = $3
           ORDER BY part_index DESC LIMIT 1`,
          [plant, vehicleNumber, normOrderDate],
        );
        const existing = existingRows[0];
        if (existing) {
          groupIdForInsert = existing.groupId;
          partIndex = (existing.partIndex ?? 1) + 1;
          joinedExistingGroup = true;
        }
      }

      const { rows: sessionRows } = await pool.query(
        `INSERT INTO unload_import_sessions (plant, vehicle_number, order_date, csv_file_name, row_count, imported_by_code, group_id, part_index)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8) RETURNING id, group_id AS "groupId"`,
        [plant, vehicleNumber, normOrderDate, csvFileName, vehicleItems.length, userCode ?? null, groupIdForInsert, partIndex],
      );
      let session = sessionRows[0];
      let groupId = session.groupId as number | null;
      if (!groupId) {
        await pool.query(`UPDATE unload_import_sessions SET group_id = $1 WHERE id = $1`, [session.id]);
        groupId = session.id;
      }

      // Merge duplicate barcodes within this vehicle's rows (a manifest listing the same SKU
      // across multiple lines — different pallets/batches, or just a re-listed line — is common)
      // into ONE item with the summed quantity. Without this, each duplicate landed as its own
      // separate unload_import_items row, but /scan (below) matches a barcode to only the FIRST
      // such row via .find() and caps "regular vs extra" against THAT row's own quantity alone —
      // so scans past the first row's (partial) quantity were wrongly logged as Extra even though
      // the manifest's true combined total for that barcode hadn't been reached yet, and the item
      // table showed the SAME running scanned total against every duplicate row's own smaller
      // expected figure. One row per barcode with the true total sidesteps both problems.
      const mergedByBarcode = new Map<string, { barcode: string; itemName: string | null; sapCode: string | null; quantity: number }>();
      for (const item of vehicleItems) {
        const barcode = typeof item.barcode === 'string' ? item.barcode.trim() : String(item.barcode ?? '').trim();
        const key = barcode.toLowerCase();
        const existing = mergedByBarcode.get(key);
        if (existing) {
          existing.quantity += item.quantity ?? 0;
          if (!existing.itemName && item.itemName) existing.itemName = item.itemName;
          if (!existing.sapCode && item.sapCode) existing.sapCode = item.sapCode;
        } else {
          mergedByBarcode.set(key, { barcode, itemName: item.itemName || null, sapCode: item.sapCode || null, quantity: item.quantity ?? 0 });
        }
      }
      const rows = Array.from(mergedByBarcode.values()).map((item) => ({
        sessionId: session.id,
        plant, vehicleNumber,
        barcode: item.barcode,
        itemName: item.itemName,
        sapCode: item.sapCode,
        quantity: item.quantity,
      }));
      const values: any[] = [];
      const placeholders = rows.map((r, i) => {
        const base = i * 6;
        values.push(r.sessionId, r.plant, r.vehicleNumber, r.barcode, r.itemName, r.sapCode);
        return `($${base + 1},$${base + 2},$${base + 3},$${base + 4},$${base + 5},$${base + 6},${r.quantity ?? 0})`;
      });
      await pool.query(
        `INSERT INTO unload_import_items (session_id, plant, vehicle_number, barcode, item_name, sap_code, quantity)
         VALUES ${placeholders.join(',')}`,
        values,
      );

      // Carry the deleted session's scan history forward onto this replacement, before
      // auto-activate below so a fully-carried-forward part can immediately show as complete.
      let remapSummary: any = null;
      if (replacementFor) {
        const remapClient = await pool.connect();
        try {
          await remapClient.query('BEGIN');
          remapSummary = await remapDeletedUnloadSessionEvents(remapClient, replacementFor.id, session.id);
          await remapClient.query('COMMIT');
        } catch (err) {
          await remapClient.query('ROLLBACK');
          throw err;
        } finally {
          remapClient.release();
        }
        console.log(`[unloading] session ${session.id} (${csvFileName}) auto-linked as replacement for deleted session ${replacementFor.id} (${replacementFor.csvFileName}) — ${remapSummary?.qtyCarriedForward ?? 0} qty carried forward`);
      }

      // If this CSV joined an EXISTING group, any earlier part that already completed may have
      // leftover un-consumed extra scans that never got a chance to credit THIS part (it didn't
      // exist yet when that part completed — reconcileUnloadCredits only ever runs once, at
      // completion time). Re-run it now against every already-completed part in the group.
      if (joinedExistingGroup && groupId) {
        const { rows: completedParts } = await pool.query(
          `SELECT id FROM unload_import_sessions WHERE group_id = $1 AND is_deleted = false AND scan_status = 'completed'`,
          [groupId],
        );
        if (completedParts.length > 0) {
          const creditClient = await pool.connect();
          try {
            await creditClient.query('BEGIN');
            for (const p of completedParts) {
              await reconcileUnloadCredits(creditClient, p.id, groupId);
            }
            await creditClient.query('COMMIT');
          } catch (e) {
            await creditClient.query('ROLLBACK');
            console.error('[unloading] credit reconciliation against new part failed:', e);
          } finally {
            creditClient.release();
          }
        }
      }

      // Stays 'available' — a batch only becomes 'active' once a user opens it to scan (see
      // POST /unloading/sessions/:id/activate below), never automatically on import.
      summary.push({
        vehicleNumber, sessionId: session.id, groupId: groupId!, partIndex, rowCount: vehicleItems.length,
        replacesSessionId: replacementFor?.id ?? null, remapSummary,
      });
    }

    if (userCode) {
      await storage.logActivity({
        pageName: 'Unloading', action: 'create', entityType: 'unload_import', entityId: csvFileName,
        details: `Imported ${csvFileName} for ${plant} (${normOrderDate}) by ${userName ?? userCode} — ${summary.length} vehicle(s): `
          + summary.map((s) => `${s.vehicleNumber} (${s.rowCount})`).join(', '),
        userCode, userName,
      });
    }

    res.status(201).json({ success: true, vehicles: summary, totalRows: items.length });
  } catch (error) {
    console.error('Error importing unloading CSV:', error);
    res.status(500).json({ message: 'Failed to import CSV' });
  }
});

// GET /api/unloading/sessions — the landing table: one row per part, newest first. Non-admins
// are limited to their assigned plants (same rule every other page's plant scoping uses).
router.get('/unloading/sessions', requirePageAccess('unloading'), async (req: Request, res: Response) => {
  try {
    const limit = Math.max(1, Math.min(100, parseInt(String(req.query.limit ?? '20'), 10) || 20));
    const offset = Math.max(0, parseInt(String(req.query.offset ?? '0'), 10) || 0);
    const userPlants = getUserPlants(req.user);

    const conditions: string[] = ['s.is_deleted = false'];
    const params: any[] = [];
    if (userPlants !== null) {
      params.push(userPlants);
      conditions.push(`LOWER(s.plant) = ANY($${params.length})`);
    }
    if (typeof req.query.plant === 'string' && req.query.plant.trim()) {
      params.push(req.query.plant.trim());
      conditions.push(`LOWER(s.plant) = LOWER($${params.length})`);
    }
    if (typeof req.query.vehicleNumber === 'string' && req.query.vehicleNumber.trim()) {
      params.push(`%${req.query.vehicleNumber.trim()}%`);
      conditions.push(`s.vehicle_number ILIKE $${params.length}`);
    }
    if (typeof req.query.orderDate === 'string' && req.query.orderDate.trim()) {
      params.push(req.query.orderDate.trim());
      conditions.push(`s.order_date = $${params.length}`);
    }
    // Status tab — the client no longer has a separate "Active" tab (an in-progress batch just
    // shows green within Available, see statusBadge in Unloading.tsx), so 'available' here means
    // both 'available' AND 'active'. 'completed' still filters to exactly that (kept for any
    // other caller); 'history' (or omitted) shows every status, same as Order Management's own
    // History tab.
    const statusParam = typeof req.query.status === 'string' ? req.query.status.trim() : '';
    if (statusParam === 'available') {
      conditions.push(`s.scan_status IN ('available', 'active')`);
    } else if (['active', 'completed'].includes(statusParam)) {
      params.push(statusParam);
      conditions.push(`s.scan_status = $${params.length}`);
    }
    const where = `WHERE ${conditions.join(' AND ')}`;

    const [dataRes, countRes] = await Promise.all([
      pool.query(
        `SELECT s.id, s.plant, s.vehicle_number AS "vehicleNumber", s.order_date AS "orderDate",
                (SELECT vi.rto_number FROM vehicle_info vi
                  WHERE LOWER(TRIM(vi.vehicle_number)) = LOWER(TRIM(s.vehicle_number))
                  ORDER BY (LOWER(TRIM(COALESCE(vi.plant, ''))) = LOWER(TRIM(COALESCE(s.plant, '')))) DESC, vi.id DESC
                  LIMIT 1) AS "rtoNumber",
                s.csv_file_name AS "csvFileName", s.row_count AS "rowCount", s.group_id AS "groupId",
                s.part_index AS "partIndex", s.scan_status AS "scanStatus", s.created_at AS "createdAt",
                s.scan_activated_at AS "scanActivatedAt", s.scan_completed_at AS "scanCompletedAt",
                CASE WHEN s.scan_completed_by_code = 'system' THEN 'System' ELSE (SELECT u.name FROM users u WHERE u.user_code = s.scan_completed_by_code LIMIT 1) END AS "scanCompletedByName",
                (SELECT COUNT(*) FROM unload_import_sessions g WHERE g.group_id = s.group_id AND g.is_deleted = false) AS "partsCount",
                COALESCE((SELECT SUM(quantity) FROM unload_import_items WHERE session_id = s.id), 0)::int AS "expectedQty",
                COALESCE((SELECT SUM(total_qty) FROM unload_scan_events WHERE session_id = s.id AND voided IS NOT TRUE), 0)::int AS "scannedQty",
                ${RECEIVED_QTY_SQL} AS "receivedQty",
                ((SELECT g.id FROM unload_import_sessions g
                  WHERE g.group_id = s.group_id AND g.is_deleted = false AND g.scan_status <> 'completed'
                  ORDER BY g.part_index ASC, g.id ASC LIMIT 1) = s.id) AS "canActivate"
         FROM unload_import_sessions s
         ${where}
         ORDER BY s.created_at DESC
         LIMIT $${params.length + 1} OFFSET $${params.length + 2}`,
        [...params, limit, offset],
      ),
      pool.query(`SELECT COUNT(*) AS total FROM unload_import_sessions s ${where}`, params),
    ]);

    res.json({ sessions: dataRes.rows.map(withExtraQty), total: parseInt(countRes.rows[0]?.total ?? '0', 10), limit, offset });
  } catch (error) {
    console.error('Error listing unloading sessions:', error);
    res.status(500).json({ message: 'Failed to fetch unloading sessions' });
  }
});

// GET /api/unloading/sessions/status-counts — badge counts for the Available/Active/Completed/
// History tab strip (client/src/pages/Unloading/Unloading.tsx), same plant/vehicleNumber/
// orderDate scoping as the list endpoint above, so the badges reflect whatever's filtered.
router.get('/unloading/sessions/status-counts', requirePageAccess('unloading'), async (req: Request, res: Response) => {
  try {
    const userPlants = getUserPlants(req.user);
    const conditions: string[] = ['is_deleted = false'];
    const params: any[] = [];
    if (userPlants !== null) {
      params.push(userPlants);
      conditions.push(`LOWER(plant) = ANY($${params.length})`);
    }
    if (typeof req.query.plant === 'string' && req.query.plant.trim()) {
      params.push(req.query.plant.trim());
      conditions.push(`LOWER(plant) = LOWER($${params.length})`);
    }
    if (typeof req.query.vehicleNumber === 'string' && req.query.vehicleNumber.trim()) {
      params.push(`%${req.query.vehicleNumber.trim()}%`);
      conditions.push(`vehicle_number ILIKE $${params.length}`);
    }
    if (typeof req.query.orderDate === 'string' && req.query.orderDate.trim()) {
      params.push(req.query.orderDate.trim());
      conditions.push(`order_date = $${params.length}`);
    }
    const where = `WHERE ${conditions.join(' AND ')}`;

    const { rows } = await pool.query(
      `SELECT
         COUNT(*) FILTER (WHERE scan_status = 'available')::int AS available,
         COUNT(*) FILTER (WHERE scan_status = 'active')::int AS active,
         COUNT(*) FILTER (WHERE scan_status = 'completed')::int AS completed,
         COUNT(*)::int AS total
       FROM unload_import_sessions ${where}`,
      params,
    );
    res.json(rows[0] ?? { available: 0, active: 0, completed: 0, total: 0 });
  } catch (error) {
    console.error('Error fetching unloading status counts:', error);
    res.status(500).json({ message: 'Failed to fetch status counts' });
  }
});

// GET /api/unloading/csv-history — one row per uploaded CSV file, not per vehicle/batch like the
// list endpoint above. A single CSV upload lands as one unload_import_sessions row PER VEHICLE
// (one POST /unloading/import call, one plant/orderDate/csvFileName shared across all of them —
// see that handler), so "which CSV was this" isn't visible anywhere in the existing Available/
// History tabs. Grouped by (csv_file_name, plant, order_date, imported_by_code, and created_at
// truncated to the minute — the per-vehicle inserts in one upload all land within the same
// request, so same-minute is a safe, simple way to tell two uploads of an identically-named file
// apart without needing a dedicated "import batch id" column).
// Also reachable with just order-import view access — see POST /unloading/import's comment above.
router.get('/unloading/csv-history', requirePageAccess(['unloading', 'order-import']), async (req: Request, res: Response) => {
  try {
    const limit = Math.max(1, Math.min(100, parseInt(String(req.query.limit ?? '20'), 10) || 20));
    const offset = Math.max(0, parseInt(String(req.query.offset ?? '0'), 10) || 0);
    const userPlants = getUserPlants(req.user);

    const conditions: string[] = ['s.is_deleted = false'];
    const params: any[] = [];
    if (userPlants !== null) {
      params.push(userPlants);
      conditions.push(`LOWER(s.plant) = ANY($${params.length})`);
    }
    if (typeof req.query.plant === 'string' && req.query.plant.trim()) {
      params.push(req.query.plant.trim());
      conditions.push(`LOWER(s.plant) = LOWER($${params.length})`);
    }
    if (typeof req.query.orderDate === 'string' && req.query.orderDate.trim()) {
      params.push(req.query.orderDate.trim());
      conditions.push(`s.order_date = $${params.length}`);
    }
    if (typeof req.query.search === 'string' && req.query.search.trim()) {
      params.push(`%${req.query.search.trim()}%`);
      conditions.push(`s.csv_file_name ILIKE $${params.length}`);
    }
    const where = `WHERE ${conditions.join(' AND ')}`;

    const groupedFrom = `
      FROM unload_import_sessions s
      LEFT JOIN users u ON u.user_code = s.imported_by_code
      ${where}
      GROUP BY s.csv_file_name, s.plant, s.order_date, s.imported_by_code, date_trunc('minute', s.created_at)
    `;

    const [dataRes, countRes] = await Promise.all([
      pool.query(
        `SELECT
           s.csv_file_name AS "csvFileName",
           s.plant,
           s.order_date AS "orderDate",
           s.imported_by_code AS "importedByCode",
           MAX(u.name) AS "importedByName",
           MIN(s.created_at) AS "uploadedAt",
           COUNT(DISTINCT s.vehicle_number)::int AS "vehicleCount",
           SUM(s.row_count)::int AS "totalRows",
           array_agg(DISTINCT s.vehicle_number ORDER BY s.vehicle_number) AS "vehicleNumbers",
           array_agg(s.id ORDER BY s.id) AS "sessionIds",
           -- Paired vehicle->session mapping (each vehicle has exactly one session row per
           -- upload) — vehicleNumbers/sessionIds above are separately-ordered arrays that can't
           -- be zipped by index; this is what the CSV History UI's per-vehicle Edit action uses
           -- to resolve which session a clicked vehicle chip actually opens.
           json_agg(jsonb_build_object('vehicleNumber', s.vehicle_number, 'sessionId', s.id) ORDER BY s.vehicle_number) AS "vehicles"
         ${groupedFrom}
         ORDER BY MIN(s.created_at) DESC
         LIMIT $${params.length + 1} OFFSET $${params.length + 2}`,
        [...params, limit, offset],
      ),
      pool.query(
        `SELECT COUNT(*)::int AS total FROM (SELECT 1 ${groupedFrom}) grouped`,
        params,
      ),
    ]);

    res.json({ uploads: dataRes.rows, total: countRes.rows[0]?.total ?? 0, limit, offset });
  } catch (error) {
    console.error('Error fetching unloading CSV history:', error);
    res.status(500).json({ message: 'Failed to fetch CSV history' });
  }
});

// GET /api/unloading/sessions/recent-complete — one row per PLANT: whichever batch completed
// most recently there. Not the same as the History tab's "every completed batch" — this is
// deliberately narrowed to exactly the set of batches Reopen actually allows (the reopen rule is
// itself "only the most-recently-completed session per plant/group is eligible" — see POST
// .../reopen below), so every row this returns is guaranteed reopenable right now. Always shows
// every plant the user can see at once (ignores any plant filter) — the point of this tab is a
// one-glance "what just finished, what can I reopen" view across plants, not a filtered list.
router.get('/unloading/sessions/recent-complete', requirePageAccess('unloading'), async (req: Request, res: Response) => {
  try {
    const userPlants = getUserPlants(req.user);
    const conditions: string[] = ["s.is_deleted = false", "s.scan_status = 'completed'"];
    const params: any[] = [];
    if (userPlants !== null) {
      params.push(userPlants);
      conditions.push(`LOWER(s.plant) = ANY($${params.length})`);
    }
    const where = `WHERE ${conditions.join(' AND ')}`;

    const { rows } = await pool.query(
      `SELECT DISTINCT ON (s.plant)
         s.id, s.plant, s.vehicle_number AS "vehicleNumber", s.order_date AS "orderDate",
         (SELECT vi.rto_number FROM vehicle_info vi
                  WHERE LOWER(TRIM(vi.vehicle_number)) = LOWER(TRIM(s.vehicle_number))
                  ORDER BY (LOWER(TRIM(COALESCE(vi.plant, ''))) = LOWER(TRIM(COALESCE(s.plant, '')))) DESC, vi.id DESC
                  LIMIT 1) AS "rtoNumber",
         s.csv_file_name AS "csvFileName", s.group_id AS "groupId", s.part_index AS "partIndex",
         s.scan_status AS "scanStatus", s.scan_activated_at AS "scanActivatedAt",
         s.scan_completed_at AS "scanCompletedAt",
         CASE WHEN s.scan_completed_by_code = 'system' THEN 'System' ELSE (SELECT u.name FROM users u WHERE u.user_code = s.scan_completed_by_code LIMIT 1) END AS "scanCompletedByName",
         (SELECT COUNT(*) FROM unload_import_sessions g WHERE g.group_id = s.group_id AND g.is_deleted = false) AS "partsCount",
         COALESCE((SELECT SUM(quantity) FROM unload_import_items WHERE session_id = s.id), 0)::int AS "expectedQty",
         COALESCE((SELECT SUM(total_qty) FROM unload_scan_events WHERE session_id = s.id AND voided IS NOT TRUE), 0)::int AS "scannedQty",
         ${RECEIVED_QTY_SQL} AS "receivedQty"
       FROM unload_import_sessions s
       ${where}
       ORDER BY s.plant, s.scan_completed_at DESC`,
      params,
    );

    res.json({ sessions: rows.map(withExtraQty), total: rows.length });
  } catch (error) {
    console.error('Error fetching unloading recent-complete list:', error);
    res.status(500).json({ message: 'Failed to fetch recent-complete list' });
  }
});

// GET /api/unloading/sessions/:id/events — this part's scan history (audit trail + Void panel).
router.get('/unloading/sessions/:id/events', requirePageAccess('unloading'), async (req: Request, res: Response) => {
  try {
    const id = parseInt(req.params.id);
    if (isNaN(id)) return res.status(400).json({ message: 'Invalid session id' });
    const { rows: sessRows } = await pool.query(`SELECT plant FROM unload_import_sessions WHERE id = $1`, [id]);
    if (!sessRows[0]) return res.status(404).json({ message: 'Session not found' });
    if (!canAccessPlant(req, sessRows[0].plant)) return res.status(403).json({ message: 'Access denied for this plant' });

    const { rows } = await pool.query(
      `SELECT id, barcode, item_name AS "itemName", sap_code AS "sapCode", pallets, loose_qty AS "looseQty",
              total_qty AS "totalQty", is_extra AS "isExtra", stv, scanned_by_code AS "scannedByCode",
              scanned_by_name AS "scannedByName", scanned_at AS "scannedAt",
              voided, voided_by_code AS "voidedByCode", voided_at AS "voidedAt", void_reason AS "voidReason"
       FROM unload_scan_events WHERE session_id = $1 ORDER BY scanned_at DESC`,
      [id],
    );
    res.json({ events: rows });
  } catch (error) {
    console.error('Error fetching unloading scan history:', error);
    res.status(500).json({ message: 'Failed to fetch scan history' });
  }
});

// GET /api/unloading/sessions/:id/part-report — single-vehicle-part Summary report, with
// cross-part FIFO adjustments folded in when it's part of a multi-CSV group. Mirrors GET
// /api/order-import/sessions/:id/part-report (see server/lib/unloadGroupReport.ts).
router.get('/unloading/sessions/:id/part-report', requirePageAccess('unloading'), async (req: Request, res: Response) => {
  try {
    const id = parseInt(req.params.id);
    if (isNaN(id)) return res.status(400).json({ message: 'Invalid session id' });
    const { rows: sessRows } = await pool.query(`SELECT plant FROM unload_import_sessions WHERE id = $1`, [id]);
    if (!sessRows[0]) return res.status(404).json({ message: 'Session not found' });
    if (!canAccessPlant(req, sessRows[0].plant)) return res.status(403).json({ message: 'Access denied for this plant' });

    const report = await computeUnloadPartReport(id);
    if (!report) return res.status(404).json({ message: 'Session not found' });
    res.json(report);
  } catch (err) {
    res.status(500).json({ message: err instanceof Error ? err.message : 'Failed to build part report' });
  }
});

// GET /api/unloading/sessions/:id/group-report — whole vehicle+date FIFO group's consolidated
// report. :id can be any part in the group. Mirrors GET /api/order-import/sessions/:id/group-report.
router.get('/unloading/sessions/:id/group-report', requirePageAccess('unloading'), async (req: Request, res: Response) => {
  try {
    const id = parseInt(req.params.id);
    if (isNaN(id)) return res.status(400).json({ message: 'Invalid session id' });
    const { rows: sessRows } = await pool.query(`SELECT plant FROM unload_import_sessions WHERE id = $1`, [id]);
    if (!sessRows[0]) return res.status(404).json({ message: 'Session not found' });
    if (!canAccessPlant(req, sessRows[0].plant)) return res.status(403).json({ message: 'Access denied for this plant' });

    const groupId = await resolveUnloadGroupId(id);
    if (!groupId) return res.status(404).json({ message: 'Group not found' });
    const report = await computeUnloadGroupReport(groupId);
    if (!report) return res.status(404).json({ message: 'Group not found' });
    res.json(report);
  } catch (err) {
    res.status(500).json({ message: err instanceof Error ? err.message : 'Failed to build group report' });
  }
});

// GET /api/unloading/sessions/:id/scan-activity — every scan event for this part (?scope=group
// for the whole vehicle+date group, each tagged with its Part # + file). Mirrors GET
// /api/order-import/sessions/:id/scan-activity.
router.get('/unloading/sessions/:id/scan-activity', requirePageAccess('unloading'), async (req: Request, res: Response) => {
  try {
    const id = parseInt(req.params.id);
    if (isNaN(id)) return res.status(400).json({ message: 'Invalid session id' });
    const { rows: sessRows } = await pool.query(`SELECT plant FROM unload_import_sessions WHERE id = $1`, [id]);
    if (!sessRows[0]) return res.status(404).json({ message: 'Session not found' });
    if (!canAccessPlant(req, sessRows[0].plant)) return res.status(403).json({ message: 'Access denied for this plant' });

    const scope = String(req.query.scope ?? 'part');

    let sessionIds: number[] = [id];
    const labelBySession = new Map<number, { partIndex: number | null; csvFileName: string; scanActivatedAt: Date | null; scanCompletedAt: Date | null }>();

    if (scope === 'group') {
      const groupId = (await resolveUnloadGroupId(id)) ?? id;
      const { rows: partsRows } = await pool.query(
        `SELECT id, part_index AS "partIndex", csv_file_name AS "csvFileName",
                scan_activated_at AS "scanActivatedAt", scan_completed_at AS "scanCompletedAt"
         FROM unload_import_sessions
         WHERE group_id = $1 AND is_deleted = false
         ORDER BY part_index ASC, id ASC`,
        [groupId],
      );
      if (partsRows.length > 0) {
        sessionIds = partsRows.map((p: any) => p.id);
        partsRows.forEach((p: any) => labelBySession.set(p.id, {
          partIndex: p.partIndex, csvFileName: p.csvFileName, scanActivatedAt: p.scanActivatedAt, scanCompletedAt: p.scanCompletedAt,
        }));
      }
    }
    if (labelBySession.size === 0) {
      const { rows: selfRows } = await pool.query(
        `SELECT id, part_index AS "partIndex", csv_file_name AS "csvFileName",
                scan_activated_at AS "scanActivatedAt", scan_completed_at AS "scanCompletedAt"
         FROM unload_import_sessions WHERE id = $1`,
        [id],
      );
      const self = selfRows[0];
      if (self) { sessionIds = [self.id]; labelBySession.set(self.id, { partIndex: self.partIndex, csvFileName: self.csvFileName, scanActivatedAt: self.scanActivatedAt, scanCompletedAt: self.scanCompletedAt }); }
    }

    const { rows: events } = await pool.query(
      `SELECT session_id AS "sessionId", barcode, item_name AS "itemName", sap_code AS "sapCode",
              pallets, loose_qty AS "looseQty", total_qty AS "totalQty",
              is_extra AS "isExtra", stv, scanned_by_code AS "scannedByCode",
              scanned_by_name AS "scannedByName", scanned_at AS "scannedAt",
              voided, voided_at AS "voidedAt", void_reason AS "voidReason",
              is_credit AS "isCredit"
       FROM unload_scan_events
       WHERE session_id = ANY($1::int[])
       ORDER BY scanned_at ASC, id ASC`,
      [sessionIds],
    );

    const withLabels = events.map((e: any) => ({
      ...e,
      partIndex: labelBySession.get(e.sessionId)?.partIndex ?? null,
      csvFileName: labelBySession.get(e.sessionId)?.csvFileName ?? null,
    }));

    const sessions = Array.from(labelBySession.entries()).map(([sid, info]) => ({
      id: sid, partIndex: info.partIndex, csvFileName: info.csvFileName,
      scanActivatedAt: info.scanActivatedAt ? new Date(info.scanActivatedAt).toISOString() : null,
      scanCompletedAt: info.scanCompletedAt ? new Date(info.scanCompletedAt).toISOString() : null,
    }));

    res.json({ scope, totalEvents: withLabels.length, events: withLabels, sessions });
  } catch (err) {
    res.status(500).json({ message: err instanceof Error ? err.message : 'Failed to fetch scan activity' });
  }
});

// GET /api/unloading/sessions/:id — open a specific part for scanning.
router.get('/unloading/sessions/:id', requirePageAccess('unloading'), async (req: Request, res: Response) => {
  try {
    const id = parseInt(req.params.id);
    if (isNaN(id)) return res.status(400).json({ message: 'Invalid session id' });
    const { rows } = await pool.query(`SELECT * FROM unload_import_sessions WHERE id = $1`, [id]);
    const session = rows[0];
    if (!session || session.is_deleted) return res.status(404).json({ message: 'Unloading session not found' });
    if (!canAccessPlant(req, session.plant)) return res.status(403).json({ message: 'Access denied for this plant' });

    const { items, allComplete, offBatchExtraQty, offBatchExtraPallets } = await withProgress({ id: session.id, plant: session.plant });
    res.json({
      session: {
        id: session.id, plant: session.plant, vehicleNumber: session.vehicle_number, orderDate: session.order_date,
        csvFileName: session.csv_file_name, groupId: session.group_id, partIndex: session.part_index,
        scanStatus: session.scan_status, scanCompletedAt: session.scan_completed_at,
      },
      items, allComplete, offBatchExtraQty, offBatchExtraPallets,
    });
  } catch (error) {
    console.error('Error fetching unloading session:', error);
    res.status(500).json({ message: 'Failed to fetch unloading session' });
  }
});

// POST /api/unloading/sessions/:id/activate — the explicit available -> active step, fired when
// the user clicks "Scan" on a batch that hasn't been opened yet. Mirrors Order Import's CSV
// lifecycle: import lands as 'available' (nothing auto-activates), and a batch only becomes
// 'active' the moment someone actually starts working it. Only the earliest not-yet-completed
// batch in a vehicle+date's FIFO group is eligible — this is what keeps batches strictly
// sequential (see isEligibleToActivate above) without a separate "one active at a time" lock.
router.post('/unloading/sessions/:id/activate', requirePageWrite('unloading'), async (req: Request, res: Response) => {
  try {
    const id = parseInt(req.params.id);
    if (isNaN(id)) return res.status(400).json({ message: 'Invalid session id' });
    const { rows } = await pool.query(`SELECT * FROM unload_import_sessions WHERE id = $1`, [id]);
    const session = rows[0];
    if (!session || session.is_deleted) return res.status(404).json({ message: 'Unloading session not found' });
    if (!canAccessPlant(req, session.plant)) return res.status(403).json({ message: 'Access denied for this plant' });
    if (session.scan_status === 'completed') {
      return res.status(409).json({ message: 'This batch is already complete.' });
    }
    if (session.scan_status === 'active') {
      return res.json({ scanStatus: 'active' }); // already active — idempotent, e.g. resuming from a saved session id
    }

    const eligible = await isEligibleToActivate({ id: session.id, groupId: session.group_id, partIndex: session.part_index });
    if (!eligible) {
      const { rows: blockingRows } = await pool.query(
        `SELECT part_index AS "partIndex" FROM unload_import_sessions
         WHERE group_id = $1 AND is_deleted = false AND scan_status <> 'completed'
         ORDER BY part_index ASC, id ASC LIMIT 1`,
        [session.group_id],
      );
      const blockingPart = blockingRows[0]?.partIndex ?? null;
      return res.status(409).json({
        message: blockingPart ? `Complete Batch ${blockingPart} for this vehicle first.` : 'Another batch for this vehicle must complete first.',
      });
    }

    // Opening a batch no longer makes it active — its first real scan does (POST /scan below, under
    // the same lock and next-in-line check). This request is kept only for a device still running
    // the previously cached page, which calls it on open: it answers "ok, you may open it" without
    // changing anything, so a batch opened and closed without scanning stays available.
    res.json({ scanStatus: session.scan_status });
  } catch (error) {
    console.error('Error activating unloading session:', error);
    res.status(500).json({ message: 'Failed to activate' });
  }
});

// POST /api/unloading/sessions/:id/scan — body: { barcode, qty }. Adds stock (receiving).
router.post('/unloading/sessions/:id/scan', requirePageWrite('unloading'), async (req: Request, res: Response) => {
  const id = parseInt(req.params.id);
  if (isNaN(id)) return res.status(400).json({ message: 'Invalid session id' });
  const client = await pool.connect();
  try {
    const barcode = String(req.body?.barcode ?? '').trim();
    const qty = Math.round(Number(req.body?.qty));
    const stv = req.body?.stv ? String(req.body.stv).trim() : null;
    if (!barcode) return res.status(400).json({ message: 'barcode is required' });
    if (!Number.isFinite(qty) || qty <= 0) return res.status(400).json({ message: 'qty must be a positive number' });

    // Fast, UNLOCKED pre-checks — fail obviously-bad requests cheaply before opening a
    // transaction. NOT authoritative for scan_status/alreadyScanned: two concurrent scans of the
    // same barcode on this session could both read the same snapshot here. The real checks
    // (below, inside the transaction, against a FOR UPDATE-locked session row) are what actually
    // prevent two parallel scans from both computing the same stale "already scanned" and both
    // crediting themselves as regular when together they should split into regular + extra —
    // the same class of race fixed in Loading's own /scan handler (server/routes/loading.ts).
    const { rows: sessionRows } = await client.query(`SELECT * FROM unload_import_sessions WHERE id = $1`, [id]);
    const session = sessionRows[0];
    if (!session) return res.status(404).json({ message: 'Unloading session not found' });
    if (!canAccessPlant(req, session.plant)) return res.status(403).json({ message: 'Access denied for this plant' });
    if (session.scan_status === 'completed') {
      return res.status(409).json({ message: 'This part is already complete — reopen it before scanning more.' });
    }

    const { rows: itemRows } = await client.query(
      `SELECT * FROM unload_import_items WHERE session_id = $1`,
      [id],
    );
    const matchedItem = itemRows.find((i: any) => normalize(i.barcode) === normalize(barcode));
    const product = await storage.getProductByBarcode(barcode, session.plant);
    // Tagged the same way PRODUCT_MASTER_MISSING is below — see matchBarcodeNotInSystemError's
    // client-side handling (a distinct centered popup, not the ordinary error toast) in
    // Unloading.tsx.
    if (!matchedItem && !product) {
      return res.status(400).json({
        message: `BARCODE_NOT_IN_SYSTEM: "${barcode}" is not on this vehicle's manifest and not in Product Master. It cannot be scanned.`,
      });
    }
    // On the manifest, but nothing in Product Master to back it — item name/SAP code would
    // silently fall back to the manifest's own text and pallet size to a generic default
    // instead of the real GJ/MP-PLT value. Blocked rather than allowed through quietly, same as
    // the "matched nowhere at all" case above — see PRODUCT_MASTER_MISSING's client-side handling
    // (a distinct centered popup, not the ordinary error toast) in Unloading.tsx.
    if (matchedItem && !product) {
      return res.status(400).json({
        message: `PRODUCT_MASTER_MISSING: Barcode "${barcode}" is not in the system — it's on this vehicle's manifest but doesn't exactly match anything in Product Master (often a formatting difference, like a missing leading zero). Fix it by editing the CSV/manifest to use the correct barcode.`,
      });
    }

    const expected = matchedItem?.quantity ?? 0;
    const state = await getPlantStateCode(client, session.plant ?? '');
    const itemsPerPallet = resolvePalletSizeOrQty(product ?? null, state, expected);
    const { userCode, userName } = actor(req);
    // Assigned inside the locked section below, but needed afterward too (for the response).
    let regularQty = 0;
    let extraQty = 0;
    let remainingBefore = 0;

    await client.query('BEGIN');
    try {
      // Lock this session's row FIRST, before re-checking status or re-reading how much of
      // this barcode has already been scanned — this is what actually serializes concurrent
      // scans on the same session (any barcode) so a second request waits for the first to
      // commit, then sees real, post-commit numbers instead of racing a stale snapshot.
      const { rows: lockedSessionRows } = await client.query(
        `SELECT * FROM unload_import_sessions WHERE id = $1 FOR UPDATE`,
        [id],
      );
      const lockedSession = lockedSessionRows[0];
      if (!lockedSession || lockedSession.scan_status === 'completed') {
        throw Object.assign(new Error('This part is already complete — reopen it before scanning more.'), { status: 409 });
      }

      // Self-healing: normally the client already called POST .../activate when "Scan" was
      // clicked, but if a scan somehow lands here while still 'available' (e.g. an older
      // client), activate transparently rather than rejecting it outright — as long as it's
      // still eligible. Done under the lock so two concurrent first-scans can't both pass the
      // eligibility check and both try to activate.
      if (lockedSession.scan_status === 'available') {
        const eligible = await isEligibleToActivate({ id: lockedSession.id, groupId: lockedSession.group_id, partIndex: lockedSession.part_index });
        if (!eligible) {
          throw Object.assign(new Error('Another batch for this vehicle must complete first.'), { status: 409 });
        }
        const { userCode: activatorCode } = actor(req);
        await client.query(
          `UPDATE unload_import_sessions SET scan_status = 'active', scan_activated_by_code = $1, scan_activated_at = NOW() WHERE id = $2`,
          [activatorCode ?? null, id],
        );
        session.scan_status = 'active';
      }

      // Re-read fresh, now that the session row above is locked, so two concurrent scans of the
      // same barcode on this session can't both see the same stale "already scanned" and both
      // think they're entirely regular.
      const { rows: scannedRows } = await client.query(
        `SELECT COALESCE(SUM(total_qty), 0)::int AS "scanned" FROM unload_scan_events
         WHERE session_id = $1 AND barcode = $2 AND voided IS NOT TRUE`,
        [id, barcode],
      );
      const alreadyScanned = scannedRows[0]?.scanned ?? 0;
      remainingBefore = matchedItem ? Math.max(0, expected - alreadyScanned) : 0;
      regularQty = matchedItem ? Math.min(qty, remainingBefore) : 0;
      extraQty = qty - regularQty;

      const insertEvent = (totalQty: number, isExtra: boolean) => client.query(
        `INSERT INTO unload_scan_events
           (session_id, barcode, item_name, sap_code, pallets, loose_qty, total_qty, is_extra, stv, plant, vehicle_number, scanned_by_code, scanned_by_name)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)`,
        [
          id, barcode, matchedItem?.itemName ?? product?.name ?? null, matchedItem?.sapCode ?? product?.sapCode ?? null,
          itemsPerPallet > 0 ? Math.floor(totalQty / itemsPerPallet) : 0,
          itemsPerPallet > 0 ? totalQty % itemsPerPallet : totalQty,
          totalQty, isExtra, stv, session.plant, session.vehicle_number, userCode ?? null, userName ?? null,
        ],
      );
      if (regularQty > 0) await insertEvent(regularQty, false);
      if (extraQty > 0) await insertEvent(extraQty, true);

      // If this product's barcode changed since stock was last received under an old one, fold
      // it onto this barcode first — see stockBarcodeReconcile.ts.
      await reconcileProductPlantStockBarcode(client, product?.id, session.plant, barcode);
      await client.query(
        `INSERT INTO product_plant_stock (barcode, product_id, plant, in_stock, extra_qty)
         VALUES ($1,$2,$3,$4,0)
         ON CONFLICT (barcode, plant) DO UPDATE SET in_stock = product_plant_stock.in_stock + EXCLUDED.in_stock, updated_at = NOW()`,
        [barcode, product?.id ?? null, session.plant, qty],
      );
      await client.query(
        `INSERT INTO stock_movements (barcode, product_id, plant, qty, extra_qty, type, reason, session_id, created_by_code, source)
         VALUES ($1,$2,$3,$4,$5,'receive',$6,$7,$8,'unloading')`,
        [barcode, product?.id ?? null, session.plant, qty, extraQty, `Unloaded vehicle ${session.vehicle_number} (${session.order_date})`, id, userCode ?? null],
      );
      await client.query('COMMIT');
    } catch (err) {
      await client.query('ROLLBACK');
      throw err;
    }

    const { items: progressItems, allComplete, offBatchExtraQty, offBatchExtraPallets } = await withProgress({ id: session.id, plant: session.plant });

    let finalStatus = session.scan_status;
    if (allComplete && session.scan_status !== 'completed') {
      await pool.query(
        `UPDATE unload_import_sessions SET scan_status = 'completed', scan_completed_by_code = $1, scan_completed_at = NOW() WHERE id = $2`,
        [userCode ?? null, id],
      );
      finalStatus = 'completed';

      if (session.group_id) {
        const creditClient = await pool.connect();
        try {
          await creditClient.query('BEGIN');
          await reconcileUnloadCredits(creditClient, id, session.group_id);
          await creditClient.query('COMMIT');
        } catch (e) {
          await creditClient.query('ROLLBACK');
          console.error('[unloading] credit reconciliation failed:', e);
        } finally {
          creditClient.release();
        }
      }

      if (userCode) {
        await storage.logActivity({
          pageName: 'Unloading', action: 'update', entityType: 'unload_import_session', entityId: id,
          details: `Vehicle ${session.vehicle_number} (${session.order_date}) part ${session.part_index} completed by ${userName ?? userCode}`,
          userCode, userName,
        });
      }
    }

    res.json({
      session: {
        id: session.id, plant: session.plant, vehicleNumber: session.vehicle_number, orderDate: session.order_date,
        scanStatus: finalStatus, groupId: session.group_id, partIndex: session.part_index,
      },
      items: progressItems, allComplete, offBatchExtraQty, offBatchExtraPallets,
      event: {
        barcode, itemName: matchedItem?.itemName ?? product?.name ?? barcode,
        sapCode: matchedItem?.sapCode ?? product?.sapCode ?? null,
        totalQty: qty, isExtra: extraQty > 0, remaining: Math.max(0, remainingBefore - regularQty),
        productId: product?.id ?? null,
      },
    });
  } catch (error: any) {
    // A rejection raised from inside the locked transaction above (status/eligibility re-checked
    // against the FOR UPDATE-locked session row) carries its own intended status — an expected
    // business rejection, not a server error, so it shouldn't be logged as one or masked as 500.
    if (error?.status) {
      return res.status(error.status).json({ message: error.message });
    }
    console.error('Error scanning item for unloading:', error);
    res.status(500).json({ message: 'Failed to record scan' });
  } finally {
    client.release();
  }
});

// POST /api/unloading/sessions/:id/complete — manual override, same admin/designation rule
// Order Scan/Loading use for "force complete even if short".
router.post('/unloading/sessions/:id/complete', requirePageWrite('unloading'), async (req: Request, res: Response) => {
  try {
    const id = parseInt(req.params.id);
    if (isNaN(id)) return res.status(400).json({ message: 'Invalid session id' });
    const { rows } = await pool.query(`SELECT * FROM unload_import_sessions WHERE id = $1`, [id]);
    const session = rows[0];
    if (!session) return res.status(404).json({ message: 'Unloading session not found' });
    if (!canAccessPlant(req, session.plant)) return res.status(403).json({ message: 'Access denied for this plant' });

    const { userCode, userName } = actor(req);
    await pool.query(
      `UPDATE unload_import_sessions SET scan_status = 'completed', scan_completed_by_code = $1, scan_completed_at = NOW() WHERE id = $2`,
      [userCode ?? null, id],
    );
    if (session.group_id) {
      const creditClient = await pool.connect();
      try {
        await creditClient.query('BEGIN');
        await reconcileUnloadCredits(creditClient, id, session.group_id);
        await creditClient.query('COMMIT');
      } catch (e) {
        await creditClient.query('ROLLBACK');
        console.error('[unloading] credit reconciliation failed:', e);
      } finally {
        creditClient.release();
      }
    }

    if (userCode) {
      await storage.logActivity({
        pageName: 'Unloading', action: 'update', entityType: 'unload_import_session', entityId: id,
        details: `Vehicle ${session.vehicle_number} (${session.order_date}) part ${session.part_index} manually completed by ${userName ?? userCode}`,
        userCode, userName,
      });
    }

    const { items, allComplete, offBatchExtraQty, offBatchExtraPallets } = await withProgress({ id, plant: session.plant });
    res.json({ items, allComplete, offBatchExtraQty, offBatchExtraPallets });
  } catch (error) {
    console.error('Error completing unloading session:', error);
    res.status(500).json({ message: 'Failed to complete' });
  }
});

// POST /api/unloading/sessions/:id/reopen — undo complete (same void/write access rule).
router.post('/unloading/sessions/:id/reopen', requireUnloadingVoidAccess, async (req: Request, res: Response) => {
  try {
    const id = parseInt(req.params.id);
    if (isNaN(id)) return res.status(400).json({ message: 'Invalid session id' });
    const { rows } = await pool.query(`SELECT * FROM unload_import_sessions WHERE id = $1`, [id]);
    const session = rows[0];
    if (!session) return res.status(404).json({ message: 'Unloading session not found' });
    if (!canAccessPlant(req, session.plant)) return res.status(403).json({ message: 'Access denied for this plant' });

    const { userCode, userName } = actor(req);
    await pool.query(
      `UPDATE unload_import_sessions SET scan_status = 'active', scan_completed_by_code = NULL, scan_completed_at = NULL WHERE id = $1`,
      [id],
    );
    // If reopening pulled this part back into play while a later part in the same group had
    // already auto-activated, that later part steps back down to queued — only one active part
    // per group at a time.
    if (session.group_id) {
      await pool.query(
        `UPDATE unload_import_sessions SET scan_status = 'available', scan_activated_by_code = NULL, scan_activated_at = NULL
         WHERE group_id = $1 AND id <> $2 AND scan_status = 'active' AND is_deleted = false`,
        [session.group_id, id],
      );
    }

    if (userCode) {
      await storage.logActivity({
        pageName: 'Unloading', action: 'update', entityType: 'unload_import_session', entityId: id,
        details: `Vehicle ${session.vehicle_number} (${session.order_date}) part ${session.part_index} reopened by ${userName ?? userCode}`,
        userCode, userName,
      });
    }

    const { items, allComplete, offBatchExtraQty, offBatchExtraPallets } = await withProgress({ id, plant: session.plant });
    res.json({ items, allComplete, offBatchExtraQty, offBatchExtraPallets });
  } catch (error) {
    console.error('Error reopening unloading session:', error);
    res.status(500).json({ message: 'Failed to reopen' });
  }
});

// GET /api/unloading/sessions/:id/delete-preview — powers the delete confirmation dialog.
router.get('/unloading/sessions/:id/delete-preview', requireUnloadingDeleteAccess, async (req: Request, res: Response) => {
  try {
    const id = parseInt(req.params.id);
    if (isNaN(id)) return res.status(400).json({ message: 'Invalid session id' });
    const { rows: sessRows } = await pool.query(`SELECT id, plant FROM unload_import_sessions WHERE id = $1`, [id]);
    if (!sessRows[0]) return res.status(404).json({ message: 'Session not found' });
    if (!canAccessPlant(req, sessRows[0].plant)) return res.status(403).json({ message: 'Access denied for this plant' });

    const { rows: scanRows } = await pool.query(
      `SELECT COUNT(DISTINCT barcode)::int AS "scannedBarcodeCount", COALESCE(SUM(total_qty), 0)::int AS "scannedQtyTotal"
       FROM unload_scan_events WHERE session_id = $1 AND voided IS NOT TRUE AND total_qty > 0`,
      [id],
    );
    const { rows: extraRows } = await pool.query(
      `SELECT COALESCE(SUM(GREATEST(0, total_qty - COALESCE(credited_qty, 0))), 0)::int AS "extraQtyTotal"
       FROM unload_scan_events WHERE session_id = $1 AND is_extra = true AND voided IS NOT TRUE`,
      [id],
    );
    res.json({
      scannedBarcodeCount: scanRows[0]?.scannedBarcodeCount ?? 0,
      scannedQtyTotal: scanRows[0]?.scannedQtyTotal ?? 0,
      extraQtyTotal: extraRows[0]?.extraQtyTotal ?? 0,
      stockApplied: (scanRows[0]?.scannedQtyTotal ?? 0) > 0,
    });
  } catch (error) {
    console.error('Error computing unloading delete preview:', error);
    res.status(500).json({ message: 'Failed to compute delete preview' });
  }
});

// DELETE /api/unloading/sessions/:id?mode=replace|discard — same two-intent delete order-import
// uses (see the comment on its own DELETE handler):
//   mode=replace (default): soft-delete only. Scan events stay pointed at this (now-deleted)
//     session and stock is LEFT in place — the physical boxes are real and get carried forward
//     onto whichever corrected CSV is next uploaded for this exact vehicle+date (see
//     remapDeletedUnloadSessionEvents, invoked from POST /unloading/import).
//   mode=discard: the boxes were never real for this vehicle+date. Reverse the stock its scans
//     added, void its events, and self-resolve (remapped_to_session_id = own id) so the next
//     upload for this slot starts fresh instead of inheriting this deleted CSV's history.
router.delete('/unloading/sessions/:id', requireUnloadingDeleteAccess, async (req: Request, res: Response) => {
  const id = parseInt(req.params.id);
  if (isNaN(id)) return res.status(400).json({ message: 'Invalid session id' });
  const discard = String(req.query.mode ?? 'replace') === 'discard';
  const { userCode, userName } = actor(req);

  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const { rows: sessRows } = await client.query(`SELECT * FROM unload_import_sessions WHERE id = $1 FOR UPDATE`, [id]);
    const session = sessRows[0];
    if (!session) { await client.query('ROLLBACK'); return res.status(404).json({ message: 'Session not found' }); }
    if (!canAccessPlant(req, session.plant)) { await client.query('ROLLBACK'); return res.status(403).json({ message: 'Access denied for this plant' }); }

    const stockReversed: Array<{ barcode: string; qty: number }> = [];
    if (discard) {
      const { rows: received } = await client.query(
        `SELECT barcode, SUM(total_qty)::int AS qty
         FROM unload_scan_events WHERE session_id = $1 AND barcode IS NOT NULL AND voided IS NOT TRUE
         GROUP BY barcode HAVING SUM(total_qty) <> 0`,
        [id],
      );
      for (const r of received) {
        const { rows: plantRows } = await client.query(
          `SELECT in_stock, product_id FROM product_plant_stock WHERE barcode = $1 AND plant = $2 FOR UPDATE`,
          [r.barcode, session.plant],
        );
        const actualQty = Math.min(r.qty, Number(plantRows[0]?.in_stock ?? 0));
        if (actualQty <= 0) continue;
        const productId = plantRows[0]?.product_id ?? null;
        await client.query(
          `UPDATE product_plant_stock SET in_stock = in_stock - $1, updated_at = NOW() WHERE barcode = $2 AND plant = $3`,
          [actualQty, r.barcode, session.plant],
        );
        await client.query(
          `INSERT INTO stock_movements (barcode, product_id, plant, qty, extra_qty, type, reason, session_id, created_by_code, source)
           VALUES ($1,$2,$3,$4,0,'adjust',$5,$6,$7,'unloading')`,
          [r.barcode, productId, session.plant, -actualQty, 'Unloading CSV deleted — rollback', id, userCode ?? null],
        );
        stockReversed.push({ barcode: r.barcode, qty: actualQty });
      }
      await client.query(`UPDATE unload_scan_events SET voided = true WHERE session_id = $1 AND voided IS NOT TRUE`, [id]);
    }

    await client.query(
      `UPDATE unload_import_sessions
       SET is_deleted = true, deleted_at = NOW(), deleted_by_code = $1, scan_status = 'available',
           remapped_to_session_id = CASE WHEN $2 THEN id ELSE remapped_to_session_id END,
           remapped_at = CASE WHEN $2 THEN NOW() ELSE remapped_at END
       WHERE id = $3`,
      [userCode ?? null, discard, id],
    );
    await client.query('COMMIT');

    if (userCode) {
      await storage.logActivity({
        pageName: 'Unloading', action: discard ? 'delete-discard' : 'delete-for-replace',
        entityType: 'unload_import_session', entityId: id,
        details: `Vehicle ${session.vehicle_number} (${session.order_date}) part ${session.part_index} deleted (${discard ? 'discard' : 'replace'}) by ${userName ?? userCode}`
          + (stockReversed.length ? ` — stock reversed for ${stockReversed.length} barcode(s)` : ''),
        userCode, userName,
      });
    }

    res.json({ success: true, mode: discard ? 'discard' : 'replace', stockReversed });
  } catch (error) {
    await client.query('ROLLBACK');
    console.error('Error deleting unloading session:', error);
    res.status(500).json({ message: 'Failed to delete' });
  } finally {
    client.release();
  }
});

// POST /api/unloading/events/:id/void — reverses the stock this scan added and marks it voided.
router.post('/unloading/events/:id/void', requireUnloadingVoidAccess, async (req: Request, res: Response) => {
  const eventId = parseInt(req.params.id);
  if (isNaN(eventId)) return res.status(400).json({ message: 'Invalid event ID' });
  const reason = typeof req.body?.reason === 'string' ? req.body.reason.trim().slice(0, 500) : null;
  const { userCode } = actor(req);

  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const { rows: eventRows } = await client.query(`SELECT * FROM unload_scan_events WHERE id = $1 FOR UPDATE`, [eventId]);
    const event = eventRows[0];
    if (!event) { await client.query('ROLLBACK'); return res.status(404).json({ message: 'Scan event not found' }); }
    if (!canAccessPlant(req, event.plant)) { await client.query('ROLLBACK'); return res.status(403).json({ message: 'Access denied for this plant' }); }
    if (event.voided) { await client.query('ROLLBACK'); return res.status(400).json({ message: 'This scan is already voided' }); }

    const qty = Number(event.total_qty ?? 0);
    if (qty > 0 && event.plant && event.barcode) {
      const product = await storage.getProductByBarcode(event.barcode, event.plant);
      await reconcileProductPlantStockBarcode(client, product?.id, event.plant, event.barcode);
      await client.query(
        `UPDATE product_plant_stock SET in_stock = in_stock - $1, updated_at = NOW() WHERE barcode = $2 AND plant = $3`,
        [qty, event.barcode, event.plant],
      );
      await client.query(
        `INSERT INTO stock_movements (barcode, product_id, plant, qty, extra_qty, type, reason, session_id, created_by_code, source)
         VALUES ($1,$2,$3,$4,0,'adjust',$5,$6,$7,'unloading')`,
        [event.barcode, product?.id ?? null, event.plant, -qty, reason ?? 'Unloading scan voided', event.session_id, userCode ?? null],
      );
    }
    await client.query(
      `UPDATE unload_scan_events SET voided = true, voided_by_code = $1, voided_at = NOW(), void_reason = $2 WHERE id = $3`,
      [userCode ?? null, reason, eventId],
    );
    await client.query('COMMIT');
    res.json({ success: true });
  } catch (error) {
    await client.query('ROLLBACK');
    console.error('Error voiding unloading scan event:', error);
    res.status(500).json({ message: 'Failed to void scan' });
  } finally {
    client.release();
  }
});

// PUT /api/unloading/events/:id — body: { totalQty?, stv? }. Corrects a mistake in an already-
// recorded scan. STV-only: a plain field update. Qty change: void the old event (same stock-
// reversal branch the void handler above uses) then insert a fresh one for the corrected qty,
// same regular/extra split /scan itself computes — two audit rows instead of a silently-edited
// one. Refuses to touch an event that's part of the cross-part credit system (credited_qty > 0,
// or is_credit itself — see unloadCredit.ts) — same guard Order Scan's own qty-edit endpoint
// uses, since unload_scan_events carries the identical isCredit/creditedQty columns even though
// Unloading's void handler above doesn't itself reason about them.
router.put('/unloading/events/:id', requireUnloadingVoidAccess, async (req: Request, res: Response) => {
  const eventId = parseInt(req.params.id);
  if (isNaN(eventId)) return res.status(400).json({ message: 'Invalid event ID' });

  const hasQty = req.body?.totalQty !== undefined && req.body?.totalQty !== null;
  const newQty = hasQty ? Math.round(Number(req.body.totalQty)) : null;
  if (hasQty && (!Number.isFinite(newQty) || (newQty as number) <= 0)) {
    return res.status(400).json({ message: 'totalQty must be a positive number' });
  }
  const hasStv = req.body?.stv !== undefined;
  const newStv = hasStv ? (String(req.body.stv ?? '').trim() || null) : null;
  if (!hasQty && !hasStv) return res.status(400).json({ message: 'Nothing to update' });

  const { userCode, userName } = actor(req);
  const editorLabel = userName ?? userCode ?? 'unknown';

  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const { rows: eventRows } = await client.query(`SELECT * FROM unload_scan_events WHERE id = $1 FOR UPDATE`, [eventId]);
    const event = eventRows[0];
    if (!event) { await client.query('ROLLBACK'); return res.status(404).json({ message: 'Scan event not found' }); }
    if (!canAccessPlant(req, event.plant)) { await client.query('ROLLBACK'); return res.status(403).json({ message: 'Access denied for this plant' }); }
    if (event.voided) { await client.query('ROLLBACK'); return res.status(400).json({ message: 'This scan is voided — nothing to edit' }); }

    if (!hasQty || newQty === Number(event.total_qty)) {
      const { rows } = await client.query(
        `UPDATE unload_scan_events SET stv = $1 WHERE id = $2 RETURNING *`,
        [hasStv ? newStv : event.stv, eventId],
      );
      await client.query('COMMIT');
      return res.json({ event: rows[0] });
    }

    if (Number(event.credited_qty ?? 0) > 0) {
      await client.query('ROLLBACK');
      return res.status(400).json({ message: 'Part of this scan has already been credited to a later part — void it instead, then rescan the corrected quantity.' });
    }
    if (event.is_credit) {
      await client.query('ROLLBACK');
      return res.status(400).json({ message: 'This is a system-generated credit entry, not a direct scan — it has no quantity of its own to correct.' });
    }

    const oldQty = Number(event.total_qty ?? 0);
    const product = await storage.getProductByBarcode(event.barcode, event.plant);

    // Reverse the old qty's stock — same direction the void handler above uses.
    await reconcileProductPlantStockBarcode(client, product?.id, event.plant, event.barcode);
    await client.query(
      `UPDATE product_plant_stock SET in_stock = in_stock - $1, updated_at = NOW() WHERE barcode = $2 AND plant = $3`,
      [oldQty, event.barcode, event.plant],
    );
    await client.query(
      `INSERT INTO stock_movements (barcode, product_id, plant, qty, extra_qty, type, reason, session_id, created_by_code, source)
       VALUES ($1,$2,$3,$4,0,'adjust',$5,$6,$7,'unloading')`,
      [event.barcode, product?.id ?? null, event.plant, -oldQty, `Qty correction — old scan reversed (edited by ${editorLabel})`, event.session_id, userCode ?? null],
    );

    await client.query(
      `UPDATE unload_scan_events SET voided = true, voided_by_code = $1, voided_at = NOW(), void_reason = $2 WHERE id = $3`,
      [userCode ?? null, `Qty corrected: ${oldQty} -> ${newQty} (edited by ${editorLabel})`, eventId],
    );

    // Same regular/extra split /scan itself computes, against expected qty minus whatever's
    // still received for this barcode (now excluding the just-voided old event).
    const { rows: expectedRows } = await client.query(
      `SELECT COALESCE(SUM(quantity), 0)::int AS expected FROM unload_import_items WHERE session_id = $1 AND barcode = $2`,
      [event.session_id, event.barcode],
    );
    const expected = expectedRows[0]?.expected ?? 0;
    const { rows: scannedRows } = await client.query(
      `SELECT COALESCE(SUM(total_qty), 0)::int AS scanned FROM unload_scan_events WHERE session_id = $1 AND barcode = $2 AND voided IS NOT TRUE`,
      [event.session_id, event.barcode],
    );
    const alreadyScanned = scannedRows[0]?.scanned ?? 0;
    const remainingBefore = Math.max(0, expected - alreadyScanned);
    const regularQty = Math.min(newQty as number, remainingBefore);
    const extraQty = (newQty as number) - regularQty;

    const state = await getPlantStateCode(client, event.plant ?? '');
    const itemsPerPallet = resolvePalletSizeOrQty(product ?? null, state, expected);
    const insertEvent = (totalQty: number, isExtra: boolean) => client.query(
      // is_adjust: this is a qty correction, not a fresh scan — shown as "Unload Adjust".
      `INSERT INTO unload_scan_events
         (session_id, barcode, item_name, sap_code, pallets, loose_qty, total_qty, is_extra, is_adjust, stv, plant, vehicle_number, scanned_by_code, scanned_by_name)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,true,$9,$10,$11,$12,$13)`,
      [
        event.session_id, event.barcode, event.item_name, event.sap_code,
        itemsPerPallet > 0 ? Math.floor(totalQty / itemsPerPallet) : 0,
        itemsPerPallet > 0 ? totalQty % itemsPerPallet : totalQty,
        totalQty, isExtra, hasStv ? newStv : event.stv, event.plant, event.vehicle_number,
        event.scanned_by_code, event.scanned_by_name,
      ],
    );
    if (regularQty > 0) await insertEvent(regularQty, false);
    if (extraQty > 0) await insertEvent(extraQty, true);

    await reconcileProductPlantStockBarcode(client, product?.id, event.plant, event.barcode);
    await client.query(
      `INSERT INTO product_plant_stock (barcode, product_id, plant, in_stock, extra_qty, updated_at)
       VALUES ($1,$2,$3,$4,0,NOW())
       ON CONFLICT (barcode, plant) DO UPDATE SET in_stock = product_plant_stock.in_stock + EXCLUDED.in_stock, updated_at = NOW()`,
      [event.barcode, product?.id ?? null, event.plant, newQty],
    );
    await client.query(
      `INSERT INTO stock_movements (barcode, product_id, plant, qty, extra_qty, type, reason, session_id, created_by_code, source)
       VALUES ($1,$2,$3,$4,$5,'adjust',$6,$7,$8,'unloading')`,
      [event.barcode, product?.id ?? null, event.plant, newQty, extraQty, `Qty corrected (edited by ${editorLabel})`, event.session_id, userCode ?? null],
    );

    await client.query('COMMIT');
    res.json({ success: true, regularQty, extraQty });
  } catch (error) {
    await client.query('ROLLBACK');
    console.error('Error editing unloading scan event:', error);
    res.status(500).json({ message: 'Failed to edit scan' });
  } finally {
    client.release();
  }
});

export default router;
