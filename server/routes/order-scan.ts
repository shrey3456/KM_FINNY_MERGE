import { Router, Request, Response, NextFunction } from 'express';
import { WebSocketServer, WebSocket } from 'ws';
import type { Server as HttpServer } from 'http';
import { db, pool } from '../db';
import {
  orderImportSessions, orderScanItems, orderScanEvents,
  users, plants, plantStvs,
} from '../../shared/schema';
import { eq, and, or, desc, asc, gte, sql } from 'drizzle-orm';
import { alias } from 'drizzle-orm/pg-core';
import { broadcastOrderImportUpdate, addWsAdminClient, removeWsAdminClient } from '../lib/importEvents';
import { enqueueScanEventForNotion } from '../lib/notionScanSync';
import { computeGroupReport, resolveGroupId, applySessionStock } from '../lib/orderGroupReport';
import { requirePageWrite } from '../lib/pageAccess';

// Case-insensitive plant match: LOWER(plant) = LOWER(filter)
function plantEq(filter: string) {
  return sql`LOWER(${orderImportSessions.plant}) = LOWER(${filter})`;
}

const router = Router();

// Never let a reverse proxy (IIS ARR) or browser cache live scan data — polling
// and WebSocket-triggered refetches must always reflect current state.
router.use((_req: Request, res: Response, next: NextFunction) => {
  res.set('Cache-Control', 'no-store, no-cache, must-revalidate');
  res.set('Pragma', 'no-cache');
  next();
});

// ── WebSocket registry ────────────────────────────────────────────────────────
// Keeps one Set of open WebSocket connections per session ID.
// Clients send { type: 'join', sessionId } after connecting to subscribe.
const wsClients = new Map<number, Set<WebSocket>>();

function broadcastScanEvent(sessionId: number, payload: object) {
  const clients = wsClients.get(sessionId);
  console.log(`[WS] broadcast session=${sessionId} clients=${clients?.size ?? 0}`);
  if (!clients || clients.size === 0) return;
  const frame = JSON.stringify(payload);
  clients.forEach((ws) => {
    if (ws.readyState === WebSocket.OPEN) {
      try { ws.send(frame); } catch { /* client disconnected mid-send */ }
    }
  });
}

export function initOrderScanWs(httpServer: HttpServer) {
  // Use noServer so we manually control which upgrades we handle.
  // This prevents conflicts with Vite HMR, which also listens on the same
  // HTTP server's 'upgrade' event.
  const wss = new WebSocketServer({ noServer: true });

  httpServer.on('upgrade', (request, socket, head) => {
    try {
      const url = new URL(request.url ?? '/', `http://${request.headers.host ?? 'localhost'}`);
      if (url.pathname !== '/ws/order-scan') {
        // In production there is no Vite HMR, so no other handler will claim this socket.
        // Destroy it to prevent file-descriptor leaks from unhandled upgrade requests.
        if (process.env.NODE_ENV === 'production') socket.destroy();
        return;
      }
      wss.handleUpgrade(request, socket as any, head, (ws) => {
        wss.emit('connection', ws, request);
      });
    } catch {
      socket.destroy();
    }
  });

  // Heartbeat every 20s: two-pronged keepalive for reverse-proxy environments.
  //
  // 1. Protocol-level ping (c.ping()) — prevents IIS ARR / nginx from timing out
  //    idle TCP connections. Browser responds with pong automatically.
  //    _isAlive tracking detects dead sockets; terminate() forces onclose on client.
  //
  // 2. Application-level JSON { type:'ping' } — browsers don't expose protocol
  //    pings to JS, so the client's onmessage-based dead-timer would never reset
  //    and would kill healthy idle connections every 55s. This JSON message reaches
  //    onmessage, resets lastMsgAt, and keeps the client's timer from misfiring.
  const PING_MSG = JSON.stringify({ type: 'ping' });
  const pingInterval = setInterval(() => {
    wss.clients.forEach((client) => {
      const c = client as WebSocket & { _isAlive?: boolean };
      if (c._isAlive === false) { c.terminate(); return; }
      c._isAlive = false;
      c.ping();
      if (c.readyState === WebSocket.OPEN) {
        try { c.send(PING_MSG); } catch { /* will be cleaned up next cycle */ }
      }
    });
  }, 20_000);

  wss.on('close', () => clearInterval(pingInterval));

  wss.on('connection', (ws: WebSocket & { _isAlive?: boolean }) => {
    ws._isAlive = true;
    ws.on('pong', () => { ws._isAlive = true; });

    let joinedSessionId: number | null = null;
    let joinedImport = false;

    ws.on('message', (raw) => {
      try {
        const msg = JSON.parse(raw.toString());
        if (msg.type === 'join' && typeof msg.sessionId === 'number') {
          // Leave previous session if client re-joins
          if (joinedSessionId !== null) {
            wsClients.get(joinedSessionId)?.delete(ws);
          }
          joinedSessionId = msg.sessionId as number;
          if (!wsClients.has(joinedSessionId)) wsClients.set(joinedSessionId, new Set());
          wsClients.get(joinedSessionId)!.add(ws);
          const roomSize = wsClients.get(joinedSessionId)!.size;
          console.log(`[WS] Client joined session ${joinedSessionId} — ${roomSize} device(s) connected`);
          ws.send(JSON.stringify({ type: 'joined', sessionId: joinedSessionId }));
        } else if (msg.type === 'join-import') {
          // OrderImport page subscribes to global import events
          if (!joinedImport) {
            joinedImport = true;
            addWsAdminClient(ws);
            console.log('[WS] Admin client joined import channel');
          }
          ws.send(JSON.stringify({ type: 'joined-import' }));
        }
      } catch { /* ignore malformed messages */ }
    });

    const cleanup = () => {
      if (joinedSessionId !== null) {
        const set = wsClients.get(joinedSessionId);
        if (set) { set.delete(ws); if (set.size === 0) wsClients.delete(joinedSessionId); }
      }
      if (joinedImport) {
        removeWsAdminClient(ws);
        joinedImport = false;
      }
    };
    ws.on('close', cleanup);
    ws.on('error', cleanup);
  });
}

// ── Auth helpers ──────────────────────────────────────────────────────────────

function requireScanRole(req: Request, res: Response, next: NextFunction) {
  if (!req.isAuthenticated()) return res.status(401).json({ message: 'Not authenticated' });
  next(); // any logged-in user may access scan routes; plant filtering handles the rest
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

export function getPlantFilter(user: any): string | null {
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

// Which plant names a user may view, for plant-scoped pages (Overall Stock, Scan History).
// Returns null for admin/super-admin/billing → "see ALL plants, no filter". Otherwise returns
// the user's assigned plants from the Users page (users.plants JSON array), lowercased. Falls
// back to the department-derived single plant (getPlantFilter) when no plants are assigned yet,
// so existing dispatch users keep working before anyone edits their plant list. An empty array
// (non-admin with nothing resolvable) means "see nothing" — safer than accidentally showing all.
export function getUserPlants(user: any): string[] | null {
  const role = (user?.role ?? '').toLowerCase().trim();
  if (ADMIN_ROLES.includes(role)) return null; // all plants

  let assigned: string[] = [];
  try {
    const raw = user?.plants;
    const parsed = typeof raw === 'string' ? JSON.parse(raw) : raw;
    if (Array.isArray(parsed)) assigned = parsed.map((p) => String(p).toLowerCase().trim()).filter(Boolean);
  } catch { /* fall through to department fallback */ }

  if (assigned.length > 0) return assigned;

  const fallback = getPlantFilter(user); // department/role-derived single plant
  return fallback ? [fallback.toLowerCase()] : [];
}

// Pick correct pallet size based on plant
function getPalletSize(product: any, plant: string): number {
  const p = (plant ?? '').toUpperCase();
  if (p.includes('VAL')) return Number(product.valPlt) || Number(product.itemsPerPallet) || 0;
  if (p.includes('IND')) return Number(product.indPlt) || Number(product.itemsPerPallet) || 0;
  return Number(product.itemsPerPallet) || 0;
}

// Full pallet-size fallback chain, shared by session population and the scan handler:
// plant-specific val_plt/ind_plt → generic items_per_pallet → generic pallets column →
// parse *NNN from the product name (e.g. "16GM*192 ..." → 192). Same chain the old
// classic-scan flow used, so pallet math never silently falls back to 1.
function resolveFullPalletSize(
  product: { itemsPerPallet?: number | null; valPlt?: number | null; indPlt?: number | null; pallets?: number | null; name?: string | null },
  plant: string,
): number {
  let size = getPalletSize(product, plant);
  if (size === 0) size = Number(product.pallets ?? 0);
  if (size === 0 && product.name) {
    const m = String(product.name).match(/\*(\d{1,5})/);
    if (m) { const n = parseInt(m[1], 10); if (Number.isFinite(n) && n > 1) size = n; }
  }
  return size;
}

// Marks a session active AND seeds order_scan_items from order_import_items (with
// product/pallet lookups) if they don't exist yet — all in one locked transaction.
// Shared by the activate route and the auto-activation paths (upload + completion
// progression) so every activation produces scannable items. Without the seeding,
// the scan page reads zero items and shows "Loading items…" forever.
// Returns true if this call actually activated the session, false if it was skipped
// (not found, or another session is already active for the plant). Safe to call from
// multiple concurrent contexts (upload auto-activate, complete auto-advance) for the
// same plant — the advisory lock below serializes them so only one can win.
export async function seedAndActivateSession(id: number, userCode: string | null): Promise<boolean> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    const sessResult = await client.query(
      'SELECT * FROM order_import_sessions WHERE id = $1 FOR UPDATE',
      [id],
    );
    const session = sessResult.rows[0];
    if (!session) { await client.query('ROLLBACK'); return false; }

    // Plant-scoped advisory lock — see the matching comment in /activate. Needed here too
    // because this function is the shared activation path for BOTH the upload auto-activate
    // and the complete auto-advance callers, and two of those could otherwise race for the
    // same plant the same way two manual /activate clicks could.
    await client.query('SELECT pg_advisory_xact_lock(hashtext($1))', [String(session.plant).toLowerCase()]);
    const conflict = await client.query(
      `SELECT id FROM order_import_sessions
       WHERE LOWER(plant) = LOWER($1) AND scan_status = 'active' AND is_deleted = false AND id != $2`,
      [session.plant, id],
    );
    if (conflict.rows[0]) { await client.query('ROLLBACK'); return false; }

    await client.query(
      `UPDATE order_import_sessions
       SET scan_status = 'active', scan_activated_by_code = $1, scan_activated_at = $2
       WHERE id = $3`,
      [userCode, new Date(), id],
    );

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
        const productMap = new Map<string, any>();
        if (barcodes.length > 0) {
          const prodResult = await client.query(
            `SELECT barcode, name, items_per_pallet, pallets, val_plt, ind_plt
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
          const prodObj = prod
            ? { valPlt: prod.val_plt, indPlt: prod.ind_plt, itemsPerPallet: prod.items_per_pallet, pallets: prod.pallets, name: prod.name }
            : null;
          const palletSize = prodObj ? resolveFullPalletSize(prodObj, session.plant) : 0;
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
    return true;
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}

router.use('/order-scan', requireScanRole);

// ── GET /api/order-scan/sessions/:id/ws-status  (debug) ──────────────────────
router.get('/order-scan/sessions/:id/ws-status', (req: Request, res: Response) => {
  const id = parseInt(req.params.id);
  res.json({ sessionId: id, connectedClients: wsClients.get(id)?.size ?? 0 });
});

// ── GET /api/order-scan/notification ─────────────────────────────────────────
// Returns whether there is an active scan session for the user's plant.
// Used by the sidebar badge and dashboard banner.
// Admin/billing: sees all plants (returns active count).
// Scanner users: returns their plant's active session only.
router.get('/order-scan/notification', async (req: Request, res: Response) => {
  try {
    const plantFilter = getPlantFilter(req.user);
    const importedBy  = alias(users, 'imported_by');

    const conditions: any[] = [
      eq(orderImportSessions.scanStatus, 'active'),
      eq(orderImportSessions.isDeleted, false),
    ];
    if (plantFilter) conditions.push(plantEq(plantFilter));

    const [session] = await db
      .select({
        id:          orderImportSessions.id,
        plant:       orderImportSessions.plant,
        csvFileName: orderImportSessions.csvFileName,
        rowCount:    orderImportSessions.rowCount,
        importedByName: importedBy.name,
        scanActivatedAt: orderImportSessions.scanActivatedAt,
        receivingSessionId: orderImportSessions.receivingSessionId,
        partIndex: orderImportSessions.partIndex,
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

// ── GET /api/order-scan/active-sessions ──────────────────────────────────────
// Plural counterpart to /notification: returns EVERY currently-active session the
// user can see, not just the most-recently-activated one. Admin/billing (no plant
// filter) can have simultaneously active sessions across different plants (e.g.
// Valsad and Indore scanning at once) — this lets them switch between all of them
// instead of only ever seeing whichever one is "on top". Dispatch/non-admin users
// are still plant-scoped, so this returns the same 0-or-1 sessions they already see
// via /notification — no behavior change for them.
router.get('/order-scan/active-sessions', async (req: Request, res: Response) => {
  try {
    const plantFilter = getPlantFilter(req.user);
    const importedBy  = alias(users, 'imported_by');

    const conditions: any[] = [
      eq(orderImportSessions.scanStatus, 'active'),
      eq(orderImportSessions.isDeleted, false),
    ];
    if (plantFilter) conditions.push(plantEq(plantFilter));

    const sessions = await db
      .select({
        id:          orderImportSessions.id,
        plant:       orderImportSessions.plant,
        csvFileName: orderImportSessions.csvFileName,
        rowCount:    orderImportSessions.rowCount,
        importedByName: importedBy.name,
        scanActivatedAt: orderImportSessions.scanActivatedAt,
        receivingSessionId: orderImportSessions.receivingSessionId,
        partIndex: orderImportSessions.partIndex,
      })
      .from(orderImportSessions)
      .leftJoin(importedBy, eq(orderImportSessions.importedByCode, importedBy.userCode))
      .where(and(...conditions))
      .orderBy(desc(orderImportSessions.scanActivatedAt));

    res.json(sessions);
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

    const conditions: any[] = [
      eq(orderImportSessions.scanStatus, 'active'),
      eq(orderImportSessions.isDeleted, false),
    ];
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
// Returns import sessions with scan status + names.
// Dispatch users see only their plant.
// Admin/billing: no plant filter by default; may pass ?plant= to filter by plant.
// ?date=YYYY-MM-DD filters to that day; defaults to today's sessions (last 48 h).
router.get('/order-scan/sessions', async (req: Request, res: Response) => {
  try {
    const userPlantFilter = getPlantFilter(req.user);

    // Admin/billing can filter by plant via query param; dispatch uses their own plant
    const queryPlant = req.query.plant ? String(req.query.plant).trim() : null;
    const plantFilter = userPlantFilter ?? (queryPlant || null);

    // Date filter: compare the stored timestamp's date directly (server local time),
    // consistent with how order-import.ts filters. No timezone conversion needed.
    const dateCondition = req.query.date
      ? sql`${orderImportSessions.createdAt}::date = ${String(req.query.date)}::date`
      : gte(orderImportSessions.createdAt, new Date(Date.now() - 48 * 60 * 60 * 1000));

    const statusFilter = req.query.status ? String(req.query.status).trim() : null;

    const importedBy  = alias(users, 'imported_by');
    const activatedBy = alias(users, 'activated_by');

    const sessions = await db
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
        receivingSessionId:   orderImportSessions.receivingSessionId,
        partIndex:            orderImportSessions.partIndex,
      })
      .from(orderImportSessions)
      .leftJoin(importedBy,  eq(orderImportSessions.importedByCode,      importedBy.userCode))
      .leftJoin(activatedBy, eq(orderImportSessions.scanActivatedByCode, activatedBy.userCode))
      .where(
        and(
          eq(orderImportSessions.isDeleted, false),
          // A currently-active OR available (not yet scanned/deactivated-back-to-available)
          // session must always be visible regardless of how long ago it was uploaded — the
          // recency window only applies to completed sessions, which is what makes them
          // "history". Without the 'available' exemption, deactivating an older-than-48h
          // session flipped its status back to available in the DB but it dropped out of
          // this query entirely, so it vanished from the Available tab and only remained
          // visible in History — the deactivate button looked like it did nothing.
          or(
            dateCondition,
            eq(orderImportSessions.scanStatus, 'active'),
            eq(orderImportSessions.scanStatus, 'available'),
          ),
          ...(plantFilter ? [plantEq(plantFilter)] : []),
          ...(statusFilter ? [eq(orderImportSessions.scanStatus, statusFilter)] : []),
        ),
      )
      .orderBy(desc(orderImportSessions.createdAt));

    res.json(sessions);
  } catch (err) {
    res.status(500).json({ message: err instanceof Error ? err.message : 'Failed to fetch sessions' });
  }
});

// ── POST /api/order-scan/sessions/:id/activate ───────────────────────────────
// Activates a session for scanning. Pre-populates orderScanItems from import items.
// Only one active session per plant at a time.
router.post('/order-scan/sessions/:id/activate', requirePageWrite('scan-order'), async (req: Request, res: Response) => {
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

    // Plant-scoped advisory lock — closes a real race the row lock above does NOT: two
    // DIFFERENT sessions for the SAME plant being activated at the same instant lock two
    // different rows, so neither blocks the other, and both could read the conflict-check
    // below as "nothing active yet" before either commits. This serializes all /activate
    // calls for one plant so the second one always sees the first's committed row. Held for
    // the transaction; released automatically on COMMIT/ROLLBACK.
    const plantFilter = getPlantFilter(req.user);
    const lockPlant = (plantFilter ?? session.plant).toLowerCase();
    await client.query('SELECT pg_advisory_xact_lock(hashtext($1))', [lockPlant]);

    // Check for a conflicting active session on the same plant (exclude deleted sessions)
    const conflictResult = await client.query(
      `SELECT id, csv_file_name FROM order_import_sessions
       WHERE LOWER(plant) = LOWER($1) AND scan_status = 'active'
         AND is_deleted = false AND id != $2`,
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

    // Mark session active (inside the same transaction).
    // Use JS new Date() instead of SQL NOW() so node-postgres sends local IST time,
    // matching how Drizzle's defaultNow() stores createdAt (also local-time based).
    await client.query(
      `UPDATE order_import_sessions
       SET scan_status = 'active', scan_activated_by_code = $1, scan_activated_at = $2
       WHERE id = $3`,
      [userCode, new Date(), id],
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
            `SELECT barcode, name, items_per_pallet, pallets, val_plt, ind_plt
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
            ? { valPlt: prod.val_plt, indPlt: prod.ind_plt, itemsPerPallet: prod.items_per_pallet, pallets: prod.pallets, name: prod.name }
            : null;
          const palletSize = prodObj ? resolveFullPalletSize(prodObj, session.plant) : 0;
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
    broadcastOrderImportUpdate();
  } catch (err) {
    await client.query('ROLLBACK');
    res.status(500).json({ message: err instanceof Error ? err.message : 'Activation failed' });
  } finally {
    client.release();
  }
});

// ── POST /api/order-scan/sessions/:id/deactivate ─────────────────────────────
// Releases the active lock without completing — allows another session to go active.
router.post('/order-scan/sessions/:id/deactivate', requirePageWrite('scan-order'), async (req: Request, res: Response) => {
  const id = parseInt(req.params.id);
  if (isNaN(id)) return res.status(400).json({ message: 'Invalid session ID' });
  try {
    await db.update(orderImportSessions)
      .set({ scanStatus: 'available' })
      .where(eq(orderImportSessions.id, id));
    res.json({ success: true });
    broadcastOrderImportUpdate();
  } catch (err) {
    res.status(500).json({ message: err instanceof Error ? err.message : 'Deactivation failed' });
  }
});

// ── POST /api/order-scan/sessions/:id/complete ───────────────────────────────
router.post('/order-scan/sessions/:id/complete', requirePageWrite('scan-order'), async (req: Request, res: Response) => {
  const id = parseInt(req.params.id);
  if (isNaN(id)) return res.status(400).json({ message: 'Invalid session ID' });
  try {
    // Raw pg query (not Drizzle's .update().set()) — Drizzle's timestamp column serializes
    // a JS Date via .toISOString() (UTC) before sending it, while raw pg sends the Date's
    // local (IST) wall-clock value. Every other timestamp write in this file (activate,
    // stock_applied_at) already goes through raw pg for that reason; this one must match or
    // scan_completed_at ends up ~5.5h off from scan_activated_at for the exact same instant.
    const { rows: completedRows } = await pool.query(
      `UPDATE order_import_sessions
       SET scan_status = 'completed', scan_completed_at = $1
       WHERE id = $2
       RETURNING id, plant, receiving_session_id AS "receivingSessionId", csv_file_name AS "csvFileName"`,
      [new Date(), id],
    );
    const completed = completedRows[0];

    // ── Auto-progress ─────────────────────────────────────────────────────────
    // After a CSV finishes, find the next not-yet-scanned CSV and activate it
    // automatically, so scanning continues without anyone having to pick the next
    // file. If this part belongs to a FIFO batch (receivingSessionId set), scope
    // strictly to that batch — ordered by partIndex — so an unrelated 'available'
    // session for the same plant can never jump the queue. Otherwise fall back to
    // the original plant-wide behaviour. Either way, only proceed if nothing else
    // in that scope is already active (avoid stealing an active lock).
    let nextSessionId: number | null = null;
    if (completed) {
      const scopeConditions = completed.receivingSessionId
        ? [eq(orderImportSessions.receivingSessionId, completed.receivingSessionId)]
        : [sql`LOWER(${orderImportSessions.plant}) = LOWER(${completed.plant})`];

      const activeInScope = await db.select({ id: orderImportSessions.id })
        .from(orderImportSessions)
        .where(and(
          ...scopeConditions,
          eq(orderImportSessions.scanStatus, 'active'),
          eq(orderImportSessions.isDeleted, false),
        ))
        .limit(1);

      if (activeInScope.length === 0) {
        const orderBy = completed.receivingSessionId
          ? [asc(orderImportSessions.partIndex), asc(orderImportSessions.id)]
          : [asc(orderImportSessions.createdAt), asc(orderImportSessions.id)];

        const [next] = await db.select()
          .from(orderImportSessions)
          .where(and(
            ...scopeConditions,
            eq(orderImportSessions.scanStatus, 'available'),
            eq(orderImportSessions.isDeleted, false),
          ))
          .orderBy(...orderBy)
          .limit(1);

        if (next) {
          const userCode = (req.user as any)?.userCode ?? null;
          const activatedNext = await seedAndActivateSession(next.id, userCode);
          if (activatedNext) {
            nextSessionId = next.id;
            console.log(`[order-scan] auto-activated next session ${next.id} (${next.csvFileName}) after completing ${id}`);
          } else {
            console.log(`[order-scan] auto-activate of ${next.id} lost the race (another activation won) after completing ${id}`);
          }
        } else {
          console.log(`[order-scan] no more 'available' sessions in scope after completing ${id}`);
        }
      } else {
        console.log(`[order-scan] another session already active in scope; skip auto-progress`);
      }
    }

    // ── Stock application (Option C) ─────────────────────────────────────────────
    // Add received boxes to products.in_stock on TERMINAL completion only:
    //   • standalone session → on its own completion
    //   • FIFO group → only once the LAST part completes (whole group done), so the
    //     cross-part extras/shortfalls are all final first
    // applySessionStock is idempotent per session (stock_applied_at guard + row lock),
    // so a retried /complete can never double-count. Best-effort: a failure here is
    // logged but does not fail the completion (which is already committed above).
    if (completed) {
      const stockClient = await pool.connect();
      try {
        await stockClient.query('BEGIN');
        if (!completed.receivingSessionId) {
          const n = await applySessionStock(stockClient, id);
          if (n > 0) console.log(`[order-scan] stock applied for standalone session ${id} → ${n} product(s)`);
        } else {
          const remaining = await stockClient.query(
            `SELECT 1 FROM order_import_sessions
             WHERE receiving_session_id = $1 AND is_deleted = false AND scan_status <> 'completed' LIMIT 1`,
            [completed.receivingSessionId],
          );
          if (remaining.rows.length === 0) {
            const partsRes = await stockClient.query(
              `SELECT id FROM order_import_sessions WHERE receiving_session_id = $1 AND is_deleted = false`,
              [completed.receivingSessionId],
            );
            let total = 0;
            for (const row of partsRes.rows) total += await applySessionStock(stockClient, row.id);
            console.log(`[order-scan] FIFO group ${completed.receivingSessionId} complete → stock applied to ${total} product row(s)`);
          }
        }
        await stockClient.query('COMMIT');
      } catch (e) {
        await stockClient.query('ROLLBACK');
        console.error('[order-scan] stock application failed:', e);
      } finally {
        stockClient.release();
      }
    }

    res.json({ success: true, nextSessionId });
    broadcastOrderImportUpdate();
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

    // items_per_pallet on this row is a one-time snapshot taken when the session was
    // activated (see resolveFullPalletSize / seedAndActivateSession) — if the product's
    // pallet config was blank then and got filled in afterward, the stored value stays
    // stale forever for a session that's already active. Re-resolve live here too, same
    // as the scan handler, so every screen reading this endpoint (CSV Items table,
    // Separate CSVs, Master View) shows correct pallet math without re-activating.
    const barcodes = items.map((i) => i.barcode?.toLowerCase()).filter((b): b is string => !!b);
    if (barcodes.length > 0) {
      const [sessionRow] = await db.select({ plant: orderImportSessions.plant })
        .from(orderImportSessions).where(eq(orderImportSessions.id, id));
      const plant = sessionRow?.plant ?? '';
      const prodRows = await pool.query(
        `SELECT LOWER(barcode) AS barcode, name, items_per_pallet, pallets, val_plt, ind_plt
         FROM products WHERE LOWER(barcode) = ANY($1)`,
        [barcodes],
      );
      const productMap = new Map(prodRows.rows.map((p: any) => [p.barcode, p]));
      for (const item of items) {
        const p = item.barcode ? productMap.get(item.barcode.toLowerCase()) : null;
        if (!p) continue;
        const liveIpp = resolveFullPalletSize(
          { itemsPerPallet: p.items_per_pallet, valPlt: p.val_plt, indPlt: p.ind_plt, pallets: p.pallets, name: p.name },
          plant,
        );
        if (liveIpp > 0) item.itemsPerPallet = liveIpp;
      }
    }

    res.json(items);
  } catch (err) {
    res.status(500).json({ message: err instanceof Error ? err.message : 'Failed to fetch items' });
  }
});

// ── GET /api/order-scan/sessions/:id/group-credits ───────────────────────────
// For a part that belongs to a FIFO batch: per barcode, how much of this part's
// expected qty is already covered by an earlier part's over-scan (extra), so the
// scan dashboard can show "3 already covered from Part 1" instead of dispatch
// re-scanning boxes that already physically arrived and were counted earlier.
// Read-only — computed from the same FIFO-netting used by the group report;
// order_scan_items/order_scan_events are never modified here. Empty map (not an
// error) for a session that isn't part of a batch.
router.get('/order-scan/sessions/:id/group-credits', async (req: Request, res: Response) => {
  const id = parseInt(req.params.id);
  if (isNaN(id)) return res.status(400).json({ message: 'Invalid session ID' });
  try {
    const groupId = await resolveGroupId(id);
    if (!groupId) return res.json({ credits: [], partIndex: null, totalParts: 0 });

    const report = await computeGroupReport(groupId);
    const part = report?.parts.find((p) => p.id === id);
    if (!part || !report) return res.json({ credits: [], partIndex: null, totalParts: 0 });

    const credits = part.items
      .filter((item) => item.adjustedFrom.length > 0)
      .map((item) => ({
        barcode: item.barcode,
        itemName: item.itemName,
        creditedQty: item.adjustedFrom.reduce((s, a) => s + a.qty, 0),
        sources: item.adjustedFrom.map((a) => ({ fromCsvFileName: a.fromCsvFileName, qty: a.qty })),
      }));

    res.json({ credits, partIndex: part.partIndex, totalParts: report.parts.length });
  } catch (err) {
    res.status(500).json({ message: err instanceof Error ? err.message : 'Failed to compute group credits' });
  }
});

// ── POST /api/order-scan/sessions/:id/scan ───────────────────────────────────
// Records a scan event inside a serialised transaction.
// The server determines isExtra from the LOCKED current DB state — the client
// hint is ignored — so concurrent scans by different users never race on the
// order-vs-extra decision. UPDATE...RETURNING eliminates the stale read-after-
// write that previously caused SSE broadcasts to carry an old snapshot.
router.post('/order-scan/sessions/:id/scan', requirePageWrite('scan-order'), async (req: Request, res: Response) => {
  const sessionId = parseInt(req.params.id);
  if (isNaN(sessionId)) return res.status(400).json({ message: 'Invalid session ID' });

  // `qty` (total boxes) is the authoritative field — it's what the user actually counted.
  // `pallets`/`looseQty` are accepted for backward compatibility only: if a caller doesn't
  // send `qty`, they're reconstructed via pallets*itemsPerPallet+looseQty using the
  // CLIENT's idea of itemsPerPallet, which can silently diverge from the server's live-
  // resolved value (see the itemsPerPallet resolution below) and corrupt the box count.
  const { barcode, qty, pallets = 1, looseQty = 0, stv = null } = req.body as {
    barcode: string; qty?: number; pallets?: number; looseQty?: number; isExtra?: boolean; stv?: string | null;
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

    // Always look up name AND plant-specific pallet size fresh from live inventory —
    // even when the barcode matches a CSV item. order_scan_items.items_per_pallet is only
    // a one-time snapshot taken when the session was activated (see populatePartScanItems /
    // seedAndActivateSession); if the product's pallet config (items_per_pallet / val_plt /
    // ind_plt) was blank at that moment and got filled in on the Products page afterward,
    // every scan against that CSV item would silently keep using the stale 0 forever,
    // recording 1 box = 1 "pallet". Resolving live here (same fallback chain the old
    // classic-scan flow used) means pallet math is always correct regardless of when the
    // product's config was set relative to session activation.
    // Must fetch val_plt/ind_plt too — getPalletSize picks the right one for the session's plant.
    // Fallback: parse *NNN from the product name (e.g. "16GM*192 ..." → 192) just like the old
    // flow's extractPalletSize did, for products where the DB columns are still 0.
    let resolvedItemName: string | null = scanItem?.item_name ?? null;
    let resolvedIpp = Number(scanItem?.items_per_pallet ?? 0);
    const prodResult = await client.query(
      `SELECT name, items_per_pallet, pallets, val_plt, ind_plt
       FROM products WHERE LOWER(barcode) = LOWER($1) LIMIT 1`,
      [barcode],
    );
    if (prodResult.rows[0]) {
      const p = prodResult.rows[0];
      resolvedItemName = resolvedItemName ?? p.name ?? null;
      const liveIpp = resolveFullPalletSize(
        { itemsPerPallet: p.items_per_pallet, valPlt: p.val_plt, indPlt: p.ind_plt, pallets: p.pallets, name: p.name },
        sessResult.rows[0]?.plant ?? '',
      );
      // Live inventory data always wins over the stale activation-time snapshot.
      if (liveIpp > 0) resolvedIpp = liveIpp;
    }

    const itemsPerPallet = resolvedIpp;
    const totalQty = qty != null
      ? Math.max(1, Math.round(qty))
      : Math.round(pallets * Math.max(1, itemsPerPallet)) + looseQty;
    const userCode = (req.user as any)?.userCode ?? null;
    const userName  = (req.user as any)?.name ?? null;

    // Split this scan at the expected-qty boundary instead of an all-or-nothing
    // isExtra check. A single scan that both finishes the order AND overshoots it
    // (e.g. 20 remaining, 30 boxes scanned) used to be logged entirely as
    // "regular", letting total_scanned_qty run past expected_qty with nothing
    // flagged as extra. And once an item was already complete, a later scan's
    // full qty was logged as an extra EVENT while total_scanned_qty (read by the
    // "Regular" report) was *also* bumped by that same qty — double-counting the
    // same boxes as both regular and extra in the Overall Stock Report. Only the
    // portion beyond what's still needed for the order is ever extra; the order
    // portion is capped so total_scanned_qty never exceeds expected_qty.
    const remainingForOrder = scanItem
      ? Math.max(0, Number(scanItem.expected_qty ?? 0) - Number(scanItem.total_scanned_qty ?? 0))
      : 0;
    const orderQty = Math.min(totalQty, remainingForOrder);
    const extraQty = totalQty - orderQty;
    const splitPallets = (qty: number) => ({
      pallets: itemsPerPallet > 0 ? Math.floor(qty / itemsPerPallet) : qty,
      looseQty: itemsPerPallet > 0 ? qty % itemsPerPallet : 0,
    });

    const events: any[] = [];
    let updatedItem: any = scanItem;

    if (orderQty > 0) {
      const part = splitPallets(orderQty);
      const orderEventResult = await client.query(
        `INSERT INTO order_scan_events
           (session_id, scan_item_id, barcode, item_name, pallets, loose_qty, total_qty,
            items_per_pallet, is_extra, stv, scanned_by_code, scanned_by_name)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)
         RETURNING *`,
        [sessionId, scanItem.id, barcode, resolvedItemName,
         part.pallets, part.looseQty, orderQty, itemsPerPallet, false,
         stv ?? null, userCode, userName],
      );
      events.push(orderEventResult.rows[0]);

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
        [part.pallets, part.looseQty, orderQty, scanItem.id],
      );
      updatedItem = updateResult.rows[0];
    }

    // extraQty is recorded purely as an event — it must NOT also be added to
    // order_scan_items, since that row already feeds the "Regular" report total.
    if (extraQty > 0) {
      const part = splitPallets(extraQty);
      const extraEventResult = await client.query(
        `INSERT INTO order_scan_events
           (session_id, scan_item_id, barcode, item_name, pallets, loose_qty, total_qty,
            items_per_pallet, is_extra, stv, scanned_by_code, scanned_by_name)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)
         RETURNING *`,
        [sessionId, scanItem?.id ?? null, barcode, resolvedItemName,
         part.pallets, part.looseQty, extraQty, itemsPerPallet, true,
         stv ?? null, userCode, userName],
      );
      events.push(extraEventResult.rows[0]);
    }

    await client.query('COMMIT');

    // Broadcast after commit so subscribers always see the committed state.
    // One message per split portion so recent-scans feeds show both parts.
    for (const event of events) {
      // Auto-push this scan event to Notion (no-op if not configured, queued
      // so concurrent scans don't fire overlapping Notion requests; failures
      // are left for the manual "Upload to Notion" button to retry).
      enqueueScanEventForNotion(event.id);

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
    }

    res.status(201).json({ event: events[events.length - 1] ?? null, events, updatedItem });
  } catch (err) {
    await client.query('ROLLBACK');
    res.status(500).json({ message: err instanceof Error ? err.message : 'Scan failed' });
  } finally {
    client.release();
  }
});


// ── GET /api/order-scan/sessions/:id/extras ──────────────────────────────────
// All extra scan events for a session (is_extra = true), grouped by barcode.
router.get('/order-scan/sessions/:id/extras', async (req: Request, res: Response) => {
  const id = parseInt(req.params.id);
  if (isNaN(id)) return res.status(400).json({ message: 'Invalid session ID' });
  try {
    const { rows } = await pool.query(`
      SELECT
        COALESCE(ose.barcode, '')            AS barcode,
        MAX(ose.item_name)                   AS "itemName",
        SUM(ose.total_qty)::int              AS "totalQty",
        COUNT(*)::int                        AS "scanCount",
        MAX(ose.scanned_at)                  AS "lastScannedAt",
        MAX(ose.scanned_by_name)             AS "scannedByName"
      FROM order_scan_events ose
      WHERE ose.session_id = $1 AND ose.is_extra = true AND ose.voided IS NOT TRUE
      GROUP BY COALESCE(ose.barcode, '')
      ORDER BY MAX(ose.scanned_at) DESC
    `, [id]);
    res.json(rows);
  } catch (err) {
    res.status(500).json({ message: err instanceof Error ? err.message : 'Failed to fetch extras' });
  }
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

// ── POST /api/order-scan/events/:id/void ─────────────────────────────────────
// Admin-only. Marks a single scan event as a mistake: the row stays in history
// (never deleted) but its quantity is reversed out of the linked order_scan_items
// row, mirroring exactly what the original /scan increment did, in reverse. Only
// allowed while the parent session is still active — once completed, stock has
// already been finalized from these numbers, so voiding is blocked at that point.
// This is purely additive: it doesn't touch the /scan endpoint or any other
// existing read path — everything that already worked keeps working unchanged.
router.post('/order-scan/events/:id/void', async (req: Request, res: Response) => {
  const eventId = parseInt(req.params.id);
  if (isNaN(eventId)) return res.status(400).json({ message: 'Invalid event ID' });

  const role = ((req.user as any)?.role ?? '').toLowerCase().trim();
  if (!ADMIN_ROLES.includes(role)) {
    return res.status(403).json({ message: 'Admin access required' });
  }

  const reason = typeof req.body?.reason === 'string' ? req.body.reason.trim().slice(0, 500) : null;
  const userCode = (req.user as any)?.userCode ?? null;

  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    const eventResult = await client.query(
      `SELECT * FROM order_scan_events WHERE id = $1 FOR UPDATE`,
      [eventId],
    );
    const event = eventResult.rows[0];
    if (!event) {
      await client.query('ROLLBACK');
      return res.status(404).json({ message: 'Scan event not found' });
    }
    if (event.voided) {
      await client.query('ROLLBACK');
      return res.status(400).json({ message: 'This scan is already voided' });
    }

    const sessResult = await client.query(
      `SELECT scan_status FROM order_import_sessions WHERE id = $1`,
      [event.session_id],
    );
    if (sessResult.rows[0]?.scan_status === 'completed') {
      await client.query('ROLLBACK');
      return res.status(400).json({ message: 'This part is already completed — stock has been finalized and this scan can no longer be voided.' });
    }

    let updatedItem: any = null;
    if (event.scan_item_id) {
      const itemResult = await client.query(
        `SELECT * FROM order_scan_items WHERE id = $1 FOR UPDATE`,
        [event.scan_item_id],
      );
      const item = itemResult.rows[0];
      if (item) {
        const newTotal = Math.max(0, Number(item.total_scanned_qty ?? 0) - Number(event.total_qty ?? 0));
        const updateResult = await client.query(
          `UPDATE order_scan_items
           SET scanned_pallets   = GREATEST(0, COALESCE(scanned_pallets, 0) - $1),
               scanned_loose_qty = GREATEST(0, COALESCE(scanned_loose_qty, 0) - $2),
               total_scanned_qty = $3,
               status            = CASE
                 WHEN $3 >= expected_qty AND expected_qty > 0 THEN 'complete'
                 WHEN $3 > 0                                  THEN 'partial'
                 ELSE 'pending'
               END
           WHERE id = $4
           RETURNING *`,
          [event.pallets, event.loose_qty, newTotal, item.id],
        );
        updatedItem = updateResult.rows[0];
      }
    }

    const voidResult = await client.query(
      `UPDATE order_scan_events
       SET voided = true, voided_by_code = $1, voided_at = NOW(), void_reason = $2
       WHERE id = $3
       RETURNING *`,
      [userCode, reason, eventId],
    );

    await client.query('COMMIT');
    res.json({ event: voidResult.rows[0], updatedItem });
  } catch (err) {
    await client.query('ROLLBACK');
    res.status(500).json({ message: err instanceof Error ? err.message : 'Failed to void scan' });
  } finally {
    client.release();
  }
});

export default router;
