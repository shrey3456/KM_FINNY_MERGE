import { Router, Request, Response, NextFunction } from 'express';
import { db, pool } from '../db';
import {
  orderImportSessions, orderImportItems, orderScanItems, orderScanEvents,
  products, users, plants, plantStvs,
} from '../../shared/schema';
import { eq, and, ne, desc, asc, gte, sql } from 'drizzle-orm';
import { alias } from 'drizzle-orm/pg-core';

// Case-insensitive plant match: LOWER(plant) = LOWER(filter)
function plantEq(filter: string) {
  return sql`LOWER(${orderImportSessions.plant}) = LOWER(${filter})`;
}

const router = Router();

// ── SSE registry ──────────────────────────────────────────────────────────────
// Keeps one Set of active SSE Response objects per session ID.
// Written to by broadcastScanEvent() after every successful scan.
const sseClients = new Map<number, Set<Response>>();

function broadcastScanEvent(sessionId: number, payload: object) {
  const clients = sseClients.get(sessionId);
  if (!clients || clients.size === 0) return;
  const frame = `data: ${JSON.stringify(payload)}\n\n`;
  clients.forEach((res) => {
    try { res.write(frame); } catch { /* client already disconnected */ }
  });
}

// ── Auth helpers ──────────────────────────────────────────────────────────────

function requireScanRole(req: Request, res: Response, next: NextFunction) {
  if (!req.isAuthenticated()) return res.status(401).json({ message: 'Not authenticated' });
  next(); // any logged-in user may access scan routes; plant filtering handles the rest
}

function requireImportRole(req: Request, res: Response, next: NextFunction) {
  if (!req.isAuthenticated()) return res.status(401).json({ message: 'Not authenticated' });
  const role = ((req.user as any)?.role ?? '').toLowerCase();
  if (!['admin', 'super-admin', 'billing'].includes(role))
    return res.status(403).json({ message: 'Only admin/billing can manage sessions' });
  next();
}

// Extract plant filter for dispatch users (fully case-insensitive).
// All inputs are lowercased; DB comparisons use LOWER() via plantEq().
//   role="Dispatch Valsad"              → "valsad"
//   role="dispatch", dept="Valsad"      → "valsad"
//   role="dispatch", dept="Dispatch Valsad" → "valsad"
//   role="user",     dept="DISPATCH VALSAD" → "valsad"
//   role="Admin"/"Billing"/"Super-Admin" → null (see all plants)
// Strip "dispatch" prefix and bracket wrappers: "DISPATCH {VALSAD}" → "valsad"
function extractPlant(s: string): string {
  return s.toLowerCase().replace(/^dispatch[\s_-]*/i, '').replace(/[{}\[\]()]/g, '').trim();
}

const ADMIN_ROLES = ['admin', 'super-admin', 'billing'];
const NON_PLANT_WORDS = new Set(['admin', 'super-admin', 'billing', 'user', 'dispatch', 'read', 'write', 'it', 'management', '']);

function getPlantFilter(user: any): string | null {
  const role = (user?.role ?? '').toLowerCase().trim();
  const dept = (user?.department ?? '').toLowerCase().trim();

  // Admin roles see all plants — no filter
  if (ADMIN_ROLES.includes(role)) return null;

  // Any user: try to extract plant from department first, fall back to role
  const fromDept = extractPlant(dept);
  if (fromDept && !NON_PLANT_WORDS.has(fromDept)) return fromDept;

  const fromRole = extractPlant(role);
  if (fromRole && !NON_PLANT_WORDS.has(fromRole)) return fromRole;

  return null;
}

// Pick correct pallet size based on plant
function getPalletSize(product: any, plant: string): number {
  const p = (plant ?? '').toUpperCase();
  if (p.includes('VAL')) return Number(product.valPlt) || Number(product.itemsPerPallet) || 0;
  if (p.includes('IND')) return Number(product.indPlt) || Number(product.itemsPerPallet) || 0;
  return Number(product.itemsPerPallet) || 0;
}

router.use('/order-scan', requireScanRole);

// ── GET /api/order-scan/notification ─────────────────────────────────────────
// Returns whether there is an active scan session for the user's plant.
// Used by the sidebar badge and dashboard banner.
// Admin/billing: sees all plants (returns active count).
// Scanner users: returns their plant's active session only.
router.get('/order-scan/notification', async (req: Request, res: Response) => {
  try {
    const plantFilter = getPlantFilter(req.user);
    const importedBy  = alias(users, 'imported_by');

    const conditions: any[] = [eq(orderImportSessions.scanStatus, 'active')];
    if (plantFilter) conditions.push(plantEq(plantFilter));

    const [session] = await db
      .select({
        id:          orderImportSessions.id,
        plant:       orderImportSessions.plant,
        csvFileName: orderImportSessions.csvFileName,
        rowCount:    orderImportSessions.rowCount,
        importedByName: importedBy.name,
        scanActivatedAt: orderImportSessions.scanActivatedAt,
      })
      .from(orderImportSessions)
      .leftJoin(importedBy, eq(orderImportSessions.importedByCode, importedBy.userCode))
      .where(and(...conditions))
      .orderBy(desc(orderImportSessions.scanActivatedAt))
      .limit(1);

    res.json({ active: !!session, session: session ?? null });
  } catch (err) {
    res.status(500).json({ message: err instanceof Error ? err.message : 'Failed' });
  }
});

// ── GET /api/order-scan/whoami — returns what plant the server sees for this user ──
router.get('/order-scan/whoami', (req: Request, res: Response) => {
  const plant = getPlantFilter(req.user);
  res.json({ role: (req.user as any)?.role, department: (req.user as any)?.department, plantFilter: plant });
});

// ── GET /api/order-scan/active ───────────────────────────────────────────────
// Returns the currently active session for the user's plant (or null).
router.get('/order-scan/active', async (req: Request, res: Response) => {
  try {
    const plantFilter = getPlantFilter(req.user);
    const importedBy  = alias(users, 'imported_by');
    const activatedBy = alias(users, 'activated_by');

    const conditions: any[] = [eq(orderImportSessions.scanStatus, 'active')];
    if (plantFilter) conditions.push(plantEq(plantFilter));

    const [session] = await db
      .select({
        id:                  orderImportSessions.id,
        plant:               orderImportSessions.plant,
        csvFileName:         orderImportSessions.csvFileName,
        rowCount:            orderImportSessions.rowCount,
        importedByCode:      orderImportSessions.importedByCode,
        importedByName:      importedBy.name,
        createdAt:           orderImportSessions.createdAt,
        scanStatus:          orderImportSessions.scanStatus,
        scanActivatedByCode: orderImportSessions.scanActivatedByCode,
        scanActivatedByName: activatedBy.name,
        scanActivatedAt:     orderImportSessions.scanActivatedAt,
        scanCompletedAt:     orderImportSessions.scanCompletedAt,
      })
      .from(orderImportSessions)
      .leftJoin(importedBy,  eq(orderImportSessions.importedByCode,      importedBy.userCode))
      .leftJoin(activatedBy, eq(orderImportSessions.scanActivatedByCode, activatedBy.userCode))
      .where(and(...conditions))
      .orderBy(desc(orderImportSessions.scanActivatedAt))
      .limit(1);

    res.json(session ?? null);
  } catch (err) {
    res.status(500).json({ message: err instanceof Error ? err.message : 'Failed to fetch active session' });
  }
});

// ── GET /api/order-scan/stvs?plant=VALSAD ───────────────────────────────────
// Returns the list of STV codes configured for a given plant.
router.get('/order-scan/stvs', async (req: Request, res: Response) => {
  try {
    const plantName = String(req.query.plant ?? '').trim();
    if (!plantName) return res.json([]);

    const [plant] = await db.select().from(plants)
      .where(sql`LOWER(${plants.name}) = LOWER(${plantName})`);
    if (!plant) return res.json([]);

    const stvRows = await db.select({ stv: plantStvs.stv })
      .from(plantStvs)
      .where(eq(plantStvs.plantId, plant.id));

    res.json(stvRows.map((r) => r.stv));
  } catch (err) {
    res.status(500).json({ message: err instanceof Error ? err.message : 'Failed to fetch STVs' });
  }
});

// ── GET /api/order-scan/sessions ─────────────────────────────────────────────
// Returns recent import sessions (last 48 h) with scan status + names.
// Using a 48-hour window avoids midnight-boundary timezone issues where
// sessions imported late at night would disappear from "today" the next morning.
// Dispatch users see only their plant.
router.get('/order-scan/sessions', async (req: Request, res: Response) => {
  try {
    const plantFilter = getPlantFilter(req.user);
    const cutoff = new Date(Date.now() - 48 * 60 * 60 * 1000);

    const importedBy  = alias(users, 'imported_by');
    const activatedBy = alias(users, 'activated_by');

    let q = db
      .select({
        id:                   orderImportSessions.id,
        plant:                orderImportSessions.plant,
        csvFileName:          orderImportSessions.csvFileName,
        rowCount:             orderImportSessions.rowCount,
        importedByCode:       orderImportSessions.importedByCode,
        importedByName:       importedBy.name,
        createdAt:            orderImportSessions.createdAt,
        scanStatus:           orderImportSessions.scanStatus,
        scanActivatedByCode:  orderImportSessions.scanActivatedByCode,
        scanActivatedByName:  activatedBy.name,
        scanActivatedAt:      orderImportSessions.scanActivatedAt,
        scanCompletedAt:      orderImportSessions.scanCompletedAt,
      })
      .from(orderImportSessions)
      .leftJoin(importedBy,  eq(orderImportSessions.importedByCode,      importedBy.userCode))
      .leftJoin(activatedBy, eq(orderImportSessions.scanActivatedByCode, activatedBy.userCode))
      .where(
        and(
          eq(orderImportSessions.isDeleted, false),
          gte(orderImportSessions.createdAt, cutoff),
          ...(plantFilter
            ? [plantEq(plantFilter)]
            : []),
        ),
      )
      .orderBy(desc(orderImportSessions.createdAt));

    const sessions = await q;
    res.json(sessions);
  } catch (err) {
    res.status(500).json({ message: err instanceof Error ? err.message : 'Failed to fetch sessions' });
  }
});

// ── POST /api/order-scan/sessions/:id/activate ───────────────────────────────
// Activates a session for scanning. Pre-populates orderScanItems from import items.
// Only one active session per plant at a time.
router.post('/order-scan/sessions/:id/activate', async (req: Request, res: Response) => {
  const id = parseInt(req.params.id);
  if (isNaN(id)) return res.status(400).json({ message: 'Invalid session ID' });

  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    // Lock the session row — prevents two simultaneous activations of the same
    // session from both passing the status/conflict checks.
    const sessResult = await client.query(
      'SELECT * FROM order_import_sessions WHERE id = $1 FOR UPDATE',
      [id],
    );
    const session = sessResult.rows[0];
    if (!session) {
      await client.query('ROLLBACK');
      return res.status(404).json({ message: 'Session not found' });
    }
    if (session.scan_status === 'completed') {
      await client.query('ROLLBACK');
      return res.status(409).json({ message: 'Session already completed' });
    }

    // Check for a conflicting active session on the same plant
    const plantFilter = getPlantFilter(req.user);
    const conflictResult = await client.query(
      `SELECT id, csv_file_name FROM order_import_sessions
       WHERE LOWER(plant) = LOWER($1) AND scan_status = 'active' AND id != $2`,
      [plantFilter ?? session.plant, id],
    );
    if (conflictResult.rows[0]) {
      const c = conflictResult.rows[0];
      await client.query('ROLLBACK');
      return res.status(409).json({
        message: `Another session is already active for ${session.plant}`,
        conflictSessionId: c.id,
        conflictFileName: c.csv_file_name,
      });
    }

    const userCode = (req.user as any)?.userCode ?? null;

    // Mark session active (inside the same transaction)
    await client.query(
      `UPDATE order_import_sessions
       SET scan_status = 'active', scan_activated_by_code = $1, scan_activated_at = NOW()
       WHERE id = $2`,
      [userCode, id],
    );

    // Pre-populate orderScanItems only if none exist yet.
    // The lock on the session row above means only one request can reach here
    // at a time, so there is no double-insert race.
    const existingResult = await client.query(
      'SELECT id FROM order_scan_items WHERE session_id = $1 LIMIT 1',
      [id],
    );

    if (existingResult.rows.length === 0) {
      const importItemsResult = await client.query(
        'SELECT * FROM order_import_items WHERE session_id = $1',
        [id],
      );
      const importItems = importItemsResult.rows;

      if (importItems.length > 0) {
        const barcodes = importItems.map((i: any) => i.barcode).filter(Boolean);
        let productMap = new Map<string, any>();
        if (barcodes.length > 0) {
          const prodResult = await client.query(
            `SELECT barcode, items_per_pallet, val_plt, ind_plt
             FROM products WHERE barcode = ANY($1)`,
            [barcodes],
          );
          prodResult.rows.forEach((p: any) => productMap.set(p.barcode, p));
        }

        const vals: any[] = [];
        const placeholders: string[] = [];
        let pi = 1;
        for (const item of importItems) {
          const prod = item.barcode ? productMap.get(item.barcode) : null;
          // Reuse getPalletSize but with snake_case keys from pg driver
          const prodObj = prod
            ? { valPlt: prod.val_plt, indPlt: prod.ind_plt, itemsPerPallet: prod.items_per_pallet }
            : null;
          const palletSize = prodObj ? getPalletSize(prodObj, session.plant) : 0;
          vals.push(id, item.id, item.barcode, item.item_name, item.sap_code, item.quantity ?? 0, palletSize);
          placeholders.push(`($${pi},$${pi+1},$${pi+2},$${pi+3},$${pi+4},$${pi+5},$${pi+6})`);
          pi += 7;
        }

        await client.query(
          `INSERT INTO order_scan_items
             (session_id, order_import_item_id, barcode, item_name, sap_code, expected_qty, items_per_pallet)
           VALUES ${placeholders.join(',')}`,
          vals,
        );
      }
    }

    await client.query('COMMIT');
    res.json({ success: true });
  } catch (err) {
    await client.query('ROLLBACK');
    res.status(500).json({ message: err instanceof Error ? err.message : 'Activation failed' });
  } finally {
    client.release();
  }
});

// ── POST /api/order-scan/sessions/:id/deactivate ─────────────────────────────
// Releases the active lock without completing — allows another session to go active.
router.post('/order-scan/sessions/:id/deactivate', async (req: Request, res: Response) => {
  const id = parseInt(req.params.id);
  if (isNaN(id)) return res.status(400).json({ message: 'Invalid session ID' });
  try {
    await db.update(orderImportSessions)
      .set({ scanStatus: 'available' })
      .where(eq(orderImportSessions.id, id));
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ message: err instanceof Error ? err.message : 'Deactivation failed' });
  }
});

// ── POST /api/order-scan/sessions/:id/complete ───────────────────────────────
router.post('/order-scan/sessions/:id/complete', async (req: Request, res: Response) => {
  const id = parseInt(req.params.id);
  if (isNaN(id)) return res.status(400).json({ message: 'Invalid session ID' });
  try {
    await db.update(orderImportSessions)
      .set({ scanStatus: 'completed', scanCompletedAt: new Date() })
      .where(eq(orderImportSessions.id, id));
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ message: err instanceof Error ? err.message : 'Complete failed' });
  }
});

// ── GET /api/order-scan/sessions/:id/items ───────────────────────────────────
router.get('/order-scan/sessions/:id/items', async (req: Request, res: Response) => {
  const id = parseInt(req.params.id);
  if (isNaN(id)) return res.status(400).json({ message: 'Invalid session ID' });
  try {
    const items = await db.select().from(orderScanItems)
      .where(eq(orderScanItems.sessionId, id))
      .orderBy(asc(orderScanItems.id));
    res.json(items);
  } catch (err) {
    res.status(500).json({ message: err instanceof Error ? err.message : 'Failed to fetch items' });
  }
});

// ── POST /api/order-scan/sessions/:id/scan ───────────────────────────────────
// Records a scan event inside a serialised transaction.
// The server determines isExtra from the LOCKED current DB state — the client
// hint is ignored — so concurrent scans by different users never race on the
// order-vs-extra decision. UPDATE...RETURNING eliminates the stale read-after-
// write that previously caused SSE broadcasts to carry an old snapshot.
router.post('/order-scan/sessions/:id/scan', async (req: Request, res: Response) => {
  const sessionId = parseInt(req.params.id);
  if (isNaN(sessionId)) return res.status(400).json({ message: 'Invalid session ID' });

  const { barcode, pallets = 1, looseQty = 0, stv = null } = req.body as {
    barcode: string; pallets: number; looseQty: number; isExtra?: boolean; stv?: string | null;
  };
  if (!barcode) return res.status(400).json({ message: 'barcode is required' });

  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    // Verify session exists (no lock needed — session row isn't mutated here)
    const sessResult = await client.query(
      'SELECT id, plant FROM order_import_sessions WHERE id = $1',
      [sessionId],
    );
    if (!sessResult.rows[0]) {
      await client.query('ROLLBACK');
      return res.status(404).json({ message: 'Session not found' });
    }

    // Lock the scan-item row for this barcode so concurrent scans on the same
    // item are serialised and each sees the previous scan's committed qty.
    const itemResult = await client.query(
      `SELECT * FROM order_scan_items
       WHERE session_id = $1 AND barcode = $2
       FOR UPDATE`,
      [sessionId, barcode],
    );
    const scanItem = itemResult.rows[0] ?? null;

    const itemsPerPallet = Number(scanItem?.items_per_pallet ?? 0);
    const totalQty = Math.round(pallets * Math.max(1, itemsPerPallet)) + looseQty;
    const userCode = (req.user as any)?.userCode ?? null;
    const userName  = (req.user as any)?.name ?? null;

    // Server-side isExtra: barcode not in order OR item already fully received
    const isExtraActual = !scanItem
      || (Number(scanItem.total_scanned_qty ?? 0) >= Number(scanItem.expected_qty ?? 0));

    // Record the scan event
    const eventResult = await client.query(
      `INSERT INTO order_scan_events
         (session_id, scan_item_id, barcode, item_name, pallets, loose_qty, total_qty,
          items_per_pallet, is_extra, stv, scanned_by_code, scanned_by_name)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)
       RETURNING *`,
      [sessionId, scanItem?.id ?? null, barcode, scanItem?.item_name ?? null,
       pallets, looseQty, totalQty, itemsPerPallet, isExtraActual,
       stv ?? null, userCode, userName],
    );
    const event = eventResult.rows[0];

    // Update running totals — only for in-order scans, using RETURNING to get
    // the committed value in the same round-trip (no stale read-after-write).
    let updatedItem: any = null;
    if (scanItem && !isExtraActual) {
      const updateResult = await client.query(
        `UPDATE order_scan_items
         SET scanned_pallets    = COALESCE(scanned_pallets,   0) + $1,
             scanned_loose_qty  = COALESCE(scanned_loose_qty, 0) + $2,
             total_scanned_qty  = COALESCE(total_scanned_qty, 0) + $3,
             status             = CASE
               WHEN COALESCE(total_scanned_qty, 0) + $3 >= expected_qty THEN 'complete'
               WHEN COALESCE(total_scanned_qty, 0) + $3 > 0             THEN 'partial'
               ELSE 'pending'
             END,
             last_scanned_at    = NOW()
         WHERE id = $4
         RETURNING *`,
        [pallets, looseQty, totalQty, scanItem.id],
      );
      updatedItem = updateResult.rows[0];
    }

    await client.query('COMMIT');

    // Broadcast after commit so subscribers always see the committed state
    broadcastScanEvent(sessionId, {
      type: 'scan',
      item: updatedItem ? {
        id:              updatedItem.id,
        barcode:         updatedItem.barcode,
        totalScannedQty: updatedItem.total_scanned_qty,
        scannedPallets:  updatedItem.scanned_pallets,
        scannedLooseQty: updatedItem.scanned_loose_qty,
        status:          updatedItem.status,
        lastScannedAt:   updatedItem.last_scanned_at,
      } : null,
      event: {
        barcode:       event.barcode,
        itemName:      event.item_name,
        totalQty:      event.total_qty,
        isExtra:       event.is_extra,
        scannedByName: event.scanned_by_name,
      },
    });

    res.status(201).json({ event, updatedItem });
  } catch (err) {
    await client.query('ROLLBACK');
    res.status(500).json({ message: err instanceof Error ? err.message : 'Scan failed' });
  } finally {
    client.release();
  }
});

// ── GET /api/order-scan/sessions/:id/stream ──────────────────────────────────
// SSE endpoint — clients connect once and receive push updates on every scan
router.get('/order-scan/sessions/:id/stream', requireScanRole, (req: Request, res: Response) => {
  const sessionId = parseInt(req.params.id);
  if (isNaN(sessionId)) { res.status(400).json({ message: 'Invalid session ID' }); return; }

  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.setHeader('X-Accel-Buffering', 'no'); // prevent nginx from buffering the stream
  res.flushHeaders();

  // Confirm connection immediately
  res.write(': connected\n\n');

  // Register this client
  if (!sseClients.has(sessionId)) sseClients.set(sessionId, new Set());
  sseClients.get(sessionId)!.add(res);

  // Keep connection alive through proxies with a periodic heartbeat
  const heartbeat = setInterval(() => {
    try { res.write(': ping\n\n'); } catch { clearInterval(heartbeat); }
  }, 25000);

  // Cleanup on client disconnect
  req.on('close', () => {
    clearInterval(heartbeat);
    const set = sseClients.get(sessionId);
    if (set) { set.delete(res); if (set.size === 0) sseClients.delete(sessionId); }
  });
});

// ── GET /api/order-scan/sessions/:id/events ──────────────────────────────────
// Last 20 scan events for a session (for the "recent scans" panel)
router.get('/order-scan/sessions/:id/events', async (req: Request, res: Response) => {
  const id = parseInt(req.params.id);
  if (isNaN(id)) return res.status(400).json({ message: 'Invalid session ID' });
  try {
    const events = await db.select().from(orderScanEvents)
      .where(eq(orderScanEvents.sessionId, id))
      .orderBy(desc(orderScanEvents.scannedAt))
      .limit(20);
    res.json(events);
  } catch (err) {
    res.status(500).json({ message: err instanceof Error ? err.message : 'Failed to fetch events' });
  }
});

export default router;
